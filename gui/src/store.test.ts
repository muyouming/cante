// Reducer + command-surface tests for the GUI store.
//
// The store is the seam between the Rust bridge and the UI: it folds
// `cante://event` batches into rows and turns UI intent back into contract
// commands. Both directions are asserted here against a fake bridge, so a
// shape drift on either side fails in `bun test src` instead of at runtime.
//
//   bun test gui/src
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";

import type { EventMsg } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Fake bridge — must be installed before store.ts is imported.
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const calls: Array<{ name: string; args: unknown }> = [];
let hydration: {
  cursor: number;
  truncated: boolean;
  events: EventMsg[];
  state: { status: string; session: unknown; pending_approval: unknown };
} = {
  cursor: 0,
  truncated: false,
  events: [],
  state: { status: "idle", session: null, pending_approval: null },
};
let healthSession: unknown = null;

function emit(channel: string, payload: unknown): void {
  for (const handler of handlers.get(channel) ?? []) handler(payload);
}

function reset(): void {
  handlers.clear();
  calls.length = 0;
  healthSession = null;
  hydration = { cursor: 0, truncated: false, events: [], state: { status: "idle", session: null, pending_approval: null } };
}

function record(name: string, args: unknown): void {
  calls.push({ name, args });
}

function opCalls(name: string): Array<unknown> {
  return calls.filter((call) => call.name === name).map((call) => call.args);
}

mock.module("./tauri.ts", () => ({
  BridgeUnavailable: class BridgeUnavailable extends Error {},
  CommandRejected: class CommandRejected extends Error {},
  errorText: (error: unknown) =>
    typeof error === "string" ? error : error instanceof Error ? error.message : "unknown error",
  isBridgeAvailable: () => true,
  invoke: async (name: string, args?: unknown) => {
    record(name, args);
    switch (name) {
      case "health":
        return { ok: true, cante: "cante 0.0.test", cwd: "/tmp/workspace", daemon: true, status: "idle" };
      case "events_since":
        return hydration;
      case "catalog":
        return { providers: [{ id: "anthropic", display_name: "Anthropic", models: [{ id: "sonnet", display_name: "Sonnet" }] }] };
      default:
        return { ok: true };
    }
  },
  onCanteEvent: async (handler: Handler) => register("event", handler),
  onCanteState: async (handler: Handler) => register("state", handler),
  onCanteLog: async (handler: Handler) => register("log", handler),
  onCanteExit: async (handler: Handler) => register("exit", handler),
}));

function register(channel: string, handler: Handler): () => void {
  const set = handlers.get(channel) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(channel, set);
  return () => set.delete(handler);
}

const { createStore } = await import("./store.ts");
type Store = ReturnType<typeof createStore>;

const SESSION = {
  session_id: "ses_TEST",
  model: { id: "claude-sonnet-5", display_name: "Sonnet 5", effort: "High" },
  provider: { id: "anthropic", display_name: "Anthropic" },
  cwd: "/tmp/workspace",
  permission_mode: "Strict",
  skills: [{ name: "simplify", description: "review the diff" }],
};

async function setup(hydrationEvents: EventMsg[] = [], session: unknown = SESSION) {
  hydration = { cursor: hydrationEvents.length, truncated: false, events: hydrationEvents, state: { status: "idle", session, pending_approval: null } };
  healthSession = session;
  let store!: Store;
  let dispose!: () => void;
  createRoot((root) => {
    dispose = root;
    store = createStore();
  });
  store.connect();
  await Bun.sleep(10);
  return { store, dispose };
}

function event(name: string, payload: unknown): EventMsg {
  return { timestamp: "2026-01-01T00:00:00Z", id: `evt_${Math.random().toString(36).slice(2)}`, event: { [name]: payload } };
}

beforeEach(reset);

// ---------------------------------------------------------------------------

describe("hydration and connection", () => {
  test("replays the Rust ring into rows", async () => {
    const { store, dispose } = await setup([
      event("UserInput", "add retries"),
      event("TurnStart", { turn_id: "t1" }),
      event("MessageDelta", "adding "),
      event("MessageDelta", "retries"),
      event("ToolStart", { id: "tool_1", name: "Edit", args: { file_path: "src/upload.ts" } }),
      event("ToolEnd", { tool_use_id: "tool_1", tool_name: "Edit", status: "Completed", result_json: { content: "@@ -1 +1 @@\n-old\n+new" } }),
      event("TurnEnd", { turn_id: "t1", status: "Completed", steps: 2 }),
    ]);
    const kinds = store.rows().map((row) => row.kind);
    expect(kinds).toEqual(["user", "agent", "tool", "turn"]);
    expect(store.rows()[1]!.text).toBe("adding retries");
    expect(store.rows()[2]!.detail).toContain("+new");
    expect(store.connection()).toBe("online");
    dispose();
  });

  test("auto-opens a session when the host has none", async () => {
    const { store, dispose } = await setup([], null);
    expect(opCalls("start_session")).toHaveLength(1);
    // #60: the session opens with cante's `Auto` policy, so a non-technical user
    // is not asked a permission question per tool call. Her gate is the
    // confirmation sheet before the run, and the approval sheet if cante still
    // stops — never a silent hang.
    expect(opCalls("start_session")[0]).toEqual({ permission_mode: "Auto" });
    expect(store.workspace()).toBe("/tmp/workspace");
    dispose();
  });

  test("does not auto-open when a session already exists", async () => {
    const { store, dispose } = await setup([event("SessionStart", SESSION)]);
    expect(opCalls("start_session")).toHaveLength(0);
    expect(store.session()?.session_id).toBe("ses_TEST");
    dispose();
  });
});

describe("the reducer", () => {
  test("folds deltas into the open agent row and closes it on AgentMessage", async () => {
    const { store, dispose } = await setup();
    emit("event", event("MessageDelta", "hello "));
    emit("event", event("MessageDelta", "world"));
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]!.text).toBe("hello world");
    expect(store.rows()[0]!.streaming).toBe(true);
    emit("event", event("AgentMessage", "hello world"));
    expect(store.rows()[0]!.streaming).toBe(false);
    expect(store.rows()).toHaveLength(1);
    dispose();
  });

  test("keys tool rows by tool_use_id", async () => {
    const { store, dispose } = await setup();
    emit("event", event("ToolStart", { id: "a", name: "Bash", args: { command: "ls" } }));
    emit("event", event("ToolStart", { id: "b", name: "Read", args: { file_path: "x" } }));
    emit("event", event("ToolUpdate", { tool_use_id: "b", seq: 1, message: "reading" }));
    emit("event", event("ToolEnd", { tool_use_id: "a", status: "Failed", result_json: { content: "boom" } }));
    const rows = store.rows();
    expect(rows.map((row) => row.label)).toEqual(["Bash", "Read"]);
    expect(rows[0]!.streaming).toBe(false);
    expect(rows[0]!.tone).toBe("error");
    expect(rows[1]!.streaming).toBe(true);
    expect(rows[1]!.detail).toContain("reading");
    dispose();
  });

  test("ignores duplicate event ids (live push + ring replay)", async () => {
    const { store, dispose } = await setup();
    const duplicate: EventMsg = { timestamp: "t", id: "evt_fixed", event: { Info: "once" } };
    emit("event", duplicate);
    emit("event", duplicate);
    expect(store.rows().filter((row) => row.kind === "info")).toHaveLength(1);
    dispose();
  });

  test("opens the approval on TurnPause and clears it on resume", async () => {
    const { store, dispose } = await setup();
    emit("state", { status: "thinking", session: SESSION, pending_approval: null });
    emit(
      "event",
      event("TurnPause", {
        turn_id: "t1",
        reason: { Approval: { tools: [{ id: "tool_1", name: "Bash", args: { command: "rm -rf /" } }], message: "Allow?" } },
      }),
    );
    expect(store.approval()?.turn_id).toBe("t1");
    expect(store.approval()?.tools[0]!.name).toBe("Bash");
    emit("event", event("TurnResume", { turn_id: "t1" }));
    expect(store.approval()).toBeNull();
    dispose();
  });

  test("tracks failures and marks the daemon offline on exit", async () => {
    const { store, dispose } = await setup();
    emit("event", event("Error", "rate limited"));
    expect(store.daemonStatus()).toBe("error");
    expect(store.rows().some((row) => row.kind === "error" && row.text === "rate limited")).toBe(true);
    emit("exit", { code: 1 });
    expect(store.daemonStatus()).toBe("offline");
    dispose();
  });

  test("keeps usage and context from UsageUpdate", async () => {
    const { store, dispose } = await setup();
    emit("event", event("UsageUpdate", { usage: { input_tokens: 1200, output_tokens: 34 }, context: { used_tokens: 1234, limit_tokens: 200_000 } }));
    expect(store.usage()?.input_tokens).toBe(1200);
    expect(store.context()?.limit_tokens).toBe(200_000);
    dispose();
  });
});

describe("the command surface", () => {
  test("a plain prompt sends UserInput and lands in history", async () => {
    const { store, dispose } = await setup();
    store.setDraft("add retries");
    await store.submit();
    expect(opCalls("send_input")).toEqual([{ text: "add retries", mode: "prompt" }]);
    expect(store.draft()).toBe("");
    expect(store.history()).toEqual(["add retries"]);
    dispose();
  });

  test("slash commands reach the contract's own commands", async () => {
    const { store, dispose } = await setup();
    await store.submit("/compact");
    await store.submit("/goal ship the parser");
    await store.submit("/goal-clear");
    await store.submit("/permissions");
    expect(opCalls("compact")).toHaveLength(1);
    expect(opCalls("goal")).toEqual([{ command: "Set", condition: "ship the parser" }, { command: "Clear" }]);
    expect(opCalls("update_session")).toHaveLength(1);
    dispose();
  });

  test("an argument-taking command prefills instead of guessing", async () => {
    const { store, dispose } = await setup();
    await store.submit("/goal");
    expect(opCalls("goal")).toHaveLength(0);
    expect(store.draft()).toBe("/goal ");
    dispose();
  });

  test("an unknown slash command goes to the daemon as SlashCommand", async () => {
    const { store, dispose } = await setup();
    await store.submit("/simplify the diff");
    expect(opCalls("slash")).toEqual([{ name: "simplify", args: "the diff" }]);
    dispose();
  });

  test("approvals are answered with tool_use_id and the picked decisions", async () => {
    const { store, dispose } = await setup();
    emit(
      "event",
      event("TurnPause", {
        turn_id: "t1",
        reason: {
          Approval: {
            tools: [
              { id: "a", name: "Bash", args: {} },
              { id: "b", name: "Write", args: {} },
            ],
            message: "Allow?",
          },
        },
      }),
    );
    await store.respond(["AcceptAlways", "Deny"]);
    expect(opCalls("approve")).toEqual([
      {
        turn_id: "t1",
        responses: [
          { tool_use_id: "a", decision: "AcceptAlways" },
          { tool_use_id: "b", decision: "Deny" },
        ],
      },
    ]);
    expect(store.approval()).toBeNull();
    dispose();
  });

  test("effort, model and permissions ride update_session / start_session", async () => {
    const { store, dispose } = await setup();
    await store.setEffort("Max");
    expect(opCalls("update_session")).toEqual([{ model: { id: "claude-sonnet-5", effort: "Max" } }]);
    await store.setPermissionMode("Auto");
    expect(opCalls("update_session")[1]).toEqual({ permission_mode: "Auto" });
    await store.setModel("anthropic", "opus");
    expect(opCalls("start_session")).toEqual([{ provider: "anthropic", model: "opus", effort: "High", permission_mode: "Strict" }]);
    dispose();
  });

  test("history walks back and forward without losing the draft", async () => {
    const { store, dispose } = await setup();
    await store.submit("first");
    await store.submit("second");
    store.setDraft("in progress");
    store.historyPrev();
    expect(store.draft()).toBe("second");
    store.historyPrev();
    expect(store.draft()).toBe("first");
    store.historyNext();
    store.historyNext();
    expect(store.draft()).toBe("in progress");
    dispose();
  });

  test("clearTranscript drops the view but keeps the session", async () => {
    const { store, dispose } = await setup([event("UserInput", "hi"), event("MessageDelta", "there")]);
    expect(store.rows().length).toBeGreaterThan(0);
    store.clearTranscript();
    expect(store.rows()).toHaveLength(0);
    expect(store.session()?.session_id).toBe("ses_TEST");
    dispose();
  });

  test("a long session stays bounded and cheap", async () => {
    const { store, dispose } = await setup();
    const started = performance.now();

    // 4000 deltas in one turn: the open row grows, the transcript does not.
    for (let i = 0; i < 4000; i++) emit("event", event("MessageDelta", `chunk ${i} `));
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]!.text.length).toBeLessThanOrEqual(8_000);

    // 300 tool calls: rows are capped, so the oldest entries fall off the top.
    for (let i = 0; i < 300; i++) {
      emit("event", event("ToolStart", { id: `t${i}`, name: "Bash", args: { command: `echo ${i}` } }));
      emit("event", event("ToolEnd", { tool_use_id: `t${i}`, status: "Completed", result_json: { content: `out ${i}` } }));
    }
    expect(store.rows().length).toBeLessThanOrEqual(400);
    expect(store.rows().every((row) => row.text.length <= 8_000)).toBe(true);

    // 2000 info rows: still capped.
    for (let i = 0; i < 2000; i++) emit("event", event("Info", `line ${i}`));
    expect(store.rows().length).toBeLessThanOrEqual(400);
    expect(store.rows()[store.rows().length - 1]!.text).toBe("line 1999");

    // Generous ceiling: this is a guard against a quadratic regression, not a
    // benchmark (locally the whole loop is a few milliseconds).
    expect(performance.now() - started).toBeLessThan(2_000);
    dispose();
  });

  test("catalog loads into the picker's model list", async () => {
    const { store, dispose } = await setup();
    await store.loadCatalog();
    expect(store.catalog()[0]!.id).toBe("anthropic");
    expect(store.catalog()[0]!.models[0]!.id).toBe("sonnet");
    dispose();
  });
});

describe("the slash palette", () => {
  test("typing / opens it and every keystroke refilters the commands", async () => {
    const { store, dispose } = await setup();
    expect(store.paletteVisible()).toBe(false);
    expect(store.paletteMatches()).toHaveLength(0);

    store.setDraft("/");
    expect(store.paletteVisible()).toBe(true);
    expect(store.paletteQuery()).toBe("");
    expect(store.paletteMatches()).toHaveLength(store.commands().length);

    store.setDraft("/comp");
    expect(store.paletteQuery()).toBe("comp");
    expect(store.paletteMatches().map((command) => command.name)).toEqual(["compact"]);

    // The session's skill is filterable too.
    store.setDraft("/simpl");
    expect(store.paletteMatches().map((command) => command.name)).toEqual(["simplify"]);
    dispose();
  });

  test("a prefix that matches nothing stays visible with an empty list", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/zzz");
    expect(store.paletteVisible()).toBe(true);
    expect(store.paletteQuery()).toBe("zzz");
    expect(store.paletteMatches()).toHaveLength(0);
    dispose();
  });

  test("plain text and a name followed by a space leave the palette closed", async () => {
    const { store, dispose } = await setup();
    store.setDraft("hello");
    expect(store.paletteVisible()).toBe(false);
    expect(store.paletteQuery()).toBe("");
    store.setDraft("/goal ship");
    expect(store.paletteVisible()).toBe(false);
    expect(store.paletteMatches()).toHaveLength(0);
    dispose();
  });

  test("arrow keys move the highlight and clamp at both ends", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/");
    const last = store.paletteMatches().length - 1;
    expect(store.paletteIndex()).toBe(0);

    store.movePalette(1);
    expect(store.paletteIndex()).toBe(1);
    store.movePalette(-1);
    expect(store.paletteIndex()).toBe(0);
    store.movePalette(-1);
    expect(store.paletteIndex()).toBe(0);
    store.movePalette(999);
    expect(store.paletteIndex()).toBe(last);

    store.selectPalette(3);
    expect(store.paletteIndex()).toBe(3);
    store.selectPalette(-4);
    expect(store.paletteIndex()).toBe(0);
    store.selectPalette(999);
    expect(store.paletteIndex()).toBe(last);
    dispose();
  });

  test("the highlight clamps when the filter shrinks", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/");
    store.movePalette(5);
    expect(store.paletteIndex()).toBe(5);

    store.setDraft("/comp");
    expect(store.paletteMatches()).toHaveLength(1);
    expect(store.paletteIndex()).toBe(0);
    dispose();
  });

  test("Tab completes the highlighted name without running it", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/comp");
    store.completePalette();
    expect(store.draft()).toBe("/compact ");
    expect(opCalls("compact")).toHaveLength(0);
    // The trailing space ends the name, so the palette folds away.
    expect(store.paletteVisible()).toBe(false);

    store.setDraft("/simpl");
    store.completePalette();
    expect(store.draft()).toBe("/simplify ");
    expect(opCalls("slash")).toHaveLength(0);
    dispose();
  });

  test("Enter runs the highlighted command, falling back to the first", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/goal");
    expect(store.paletteMatches().map((command) => command.name)).toEqual(["goal", "goal-clear"]);

    store.movePalette(1);
    expect(store.paletteMatches()[store.paletteIndex()]!.name).toBe("goal-clear");
    await store.runPalette();
    expect(opCalls("goal")).toEqual([{ command: "Clear" }]);
    // Running consumes the draft.
    expect(store.draft()).toBe("");

    // With nothing moved, Enter falls back to the first match (goal prefills).
    store.setDraft("/goal");
    await store.runPalette();
    expect(opCalls("goal")).toHaveLength(1);
    expect(store.draft()).toBe("/goal ");
    dispose();
  });

  test("built-ins run in the client and skills go to the daemon", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/comp");
    await store.runPalette();
    expect(opCalls("compact")).toHaveLength(1);

    store.setDraft("/simpl");
    await store.runPalette();
    expect(opCalls("slash")).toEqual([{ name: "simplify", args: "" }]);
    dispose();
  });

  test("clicking a row runs that command even when it is not the highlight", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/");
    const context = store.paletteMatches().find((command) => command.name === "context")!;
    expect(store.paletteMatches()[store.paletteIndex()]!.name).not.toBe("context");

    await store.runPaletteCommand(context);
    expect(opCalls("context_report")).toHaveLength(1);
    expect(store.draft()).toBe("");
    expect(store.paletteVisible()).toBe(false);
    dispose();
  });

  test("an argument-taking command prefills instead of running", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/goal");
    await store.runPalette();
    expect(opCalls("goal")).toHaveLength(0);
    expect(store.draft()).toBe("/goal ");
    dispose();
  });

  test("Esc dismisses the palette but keeps the draft until the next keystroke", async () => {
    const { store, dispose } = await setup();
    store.setDraft("/comp");
    store.dismissPalette();
    expect(store.paletteVisible()).toBe(false);
    expect(store.draft()).toBe("/comp");

    store.setDraft("/compa");
    expect(store.paletteVisible()).toBe(true);
    expect(store.paletteMatches().map((command) => command.name)).toEqual(["compact"]);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Adversarial streams — a real daemon (or a future protocol version) can send
// anything. These tests assert the invariants that must hold for *every* batch,
// not a snapshot of today's rendering.
// ---------------------------------------------------------------------------

/** An event envelope with a caller-controlled id (for dedupe assertions). */
function raw(event: unknown, id?: string): EventMsg {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    id: id ?? `evt_${Math.random().toString(36).slice(2)}`,
    event,
  };
}

/**
 * The store-level invariants. Every adversarial batch must leave the store in a
 * state that satisfies all of them; a thrown exception fails the test outright.
 */
function assertInvariants(store: Store): void {
  const rows = store.rows();
  expect(rows.length).toBeLessThanOrEqual(400);
  let previousSeq = -1;
  for (const row of rows) {
    expect(typeof row.text).toBe("string");
    expect(row.text.length).toBeLessThanOrEqual(8_000);
    expect(typeof row.detail).toBe("string");
    expect(row.detail.length).toBeLessThanOrEqual(8_000);
    expect(typeof row.label).toBe("string");
    expect(row.label.length).toBeLessThanOrEqual(8_000);
    // Row ids encode the global insertion counter; the newest entry must be
    // last and trimming may only drop from the front.
    const seq = Number(/^[a-z]+(\d+)$/.exec(row.id)?.[1] ?? NaN);
    expect(Number.isFinite(seq)).toBe(true);
    expect(seq).toBeGreaterThan(previousSeq);
    previousSeq = seq;
  }
}

/** The response batches of every `approve` op recorded so far. */
function approveBatches(): Array<{ turn_id: string; responses: Array<{ tool_use_id: string }> }> {
  return opCalls("approve") as Array<{ turn_id: string; responses: Array<{ tool_use_id: string }> }>;
}

/** Deterministic PRNG so a failing random stream can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("adversarial: wire shapes", () => {
  test("unknown and unit variants arrive as bare strings", async () => {
    const { store, dispose } = await setup();
    const hostile: EventMsg[] = [
      raw("Goodbye"),
      raw("CompactStart"),
      raw("SomeFutureEvent"),
      raw({ FutureVariant: { nested: true } }),
      raw(null),
      raw(42),
      raw([]),
      raw(["ToolStart", {}]),
      raw(undefined),
      { timestamp: "t", id: "evt_empty_event", event: undefined },
      null as unknown as EventMsg,
      "not an envelope" as unknown as EventMsg,
    ];
    for (const message of hostile) emit("event", message);
    assertInvariants(store);
    // The bare unit variant still drives the status machine.
    expect(store.daemonStatus()).toBe("offline");
    expect(store.rows().some((row) => row.label === "compact")).toBe(true);
    dispose();
  });

  test("malformed payloads never throw and never corrupt rows", async () => {
    const { store, dispose } = await setup();
    const malformed: EventMsg[] = [
      event("ToolEnd", { tool_use_id: "ghost", status: "Completed", result_json: { content: "x" } }),
      event("ToolUpdate", { tool_use_id: "ghost", message: "before start" }),
      event("TurnPause", {}),
      event("TurnPause", { turn_id: "t1" }),
      event("TurnPause", { turn_id: "t1", reason: { Approval: {} } }),
      event("TurnPause", { turn_id: "t1", reason: { Approval: { tools: null, message: 7 } } }),
      event("TurnPause", { turn_id: "t1", reason: { Approval: { tools: [null, 5, { name: "x" }, { id: "ok", name: "Bash", args: "ls" }] } } }),
      event("TurnEnd", { turn_id: "t1", status: "Completed", steps: 1 }),
      event("TurnEnd", { turn_id: "t1", status: "Completed", steps: 2 }),
      event("MessageDelta", "after turn"),
      event("ThinkingDelta", "late thought"),
      event("Error", ""),
      event("UserInput", ""),
      event("Info", ""),
      event("TurnEnd", { status: null }),
      event("TurnEnd", { status: { Error: { headline: "boom", details: "not-an-array" } } }),
      event("TurnEnd", { status: { Interrupted: { reason: { nested: true } } } }),
      event("TurnEnd", { status: { Error: { headline: 42, details: [7, "deep"] } } }),
      event("ToolStart", { id: "s1", name: "Bash", args: "a string, not an object" }),
      event("ToolEnd", { tool_use_id: "s1", status: 5, result_json: null }),
      event("ContextReport", "garbage"),
      event("UsageUpdate", "garbage"),
    ];
    for (const message of malformed) emit("event", message);
    assertInvariants(store);
    dispose();
  });

  test("an approval is always answerable with a non-empty response batch", async () => {
    const { store, dispose } = await setup();
    // Malformed pauses must not create an unanswerable (empty) approval.
    emit("event", event("TurnPause", { reason: { Approval: { tools: [] } } }));
    emit("event", event("TurnPause", { turn_id: "", reason: { Approval: { tools: [{ id: "a", name: "Bash", args: {} }] } } }));
    assertInvariants(store);
    expect(store.approval()).toBeNull();

    // A well-formed pause with junk entries keeps only answerable tools.
    emit("event", event("TurnPause", {
      turn_id: "t9",
      reason: { Approval: { tools: [null, { id: "a", name: "Bash", args: {} }, { name: "no-id" }], message: "allow?" } },
    }));
    expect(store.approval()).not.toBeNull();
    await store.respond(["Accept"]);
    assertInvariants(store);
    const batches = approveBatches();
    expect(batches.length).toBe(1);
    expect(batches[0]!.responses.length).toBeGreaterThan(0);
    expect(batches[0]!.responses.every((response) => response.tool_use_id)).toBe(true);
    expect(store.approval()).toBeNull();
    dispose();
  });

  test("a malformed cante://state approval cannot wedge the panel", async () => {
    const { store, dispose } = await setup();
    emit("state", {
      status: "awaiting",
      session: SESSION,
      pending_approval: { turn_id: "t1", message: "x", tools: [null, 5, { name: "no-id" }] },
    });
    await store.respond(["Deny"]);
    assertInvariants(store);
    for (const batch of approveBatches()) {
      expect(batch.responses.length).toBeGreaterThan(0);
    }
    dispose();
  });

  test("event-id dedupe holds for identical envelopes", async () => {
    const { store, dispose } = await setup();
    const fixed = raw({ Info: "once" }, "evt_same");
    emit("event", fixed);
    const count = store.rows().length;
    emit("event", fixed);
    emit("event", { ...fixed, id: "evt_same" });
    expect(store.rows().length).toBe(count);
    assertInvariants(store);
    dispose();
  });

  test("prompt history stays bounded", async () => {
    const { store, dispose } = await setup();
    for (let i = 0; i < 120; i++) await store.submit(`prompt ${i}`);
    expect(store.history().length).toBeLessThanOrEqual(50);
    expect(store.history()[store.history().length - 1]).toBe("prompt 119");
    assertInvariants(store);
    dispose();
  });
});

describe("adversarial: hostile sizes", () => {
  test("10 MB payloads are clamped at the row boundary", async () => {
    const { store, dispose } = await setup();
    const big = "x".repeat(10_000_000);
    emit("event", event("UserInput", big));
    emit("event", event("MessageDelta", big));
    emit("event", event("AgentMessage", big));
    emit("event", event("Thinking", big));
    emit("event", event("Info", big));
    emit("event", event("Error", big));
    emit("event", event("ToolStart", { id: "big", name: "Bash", args: big }));
    emit("event", event("ToolEnd", { tool_use_id: "big", status: "Completed", result_json: big }));
    emit("event", event("ToolStart", { id: "big2", name: big, args: {} }));
    emit("event", event("ToolEnd", { tool_use_id: "big2", status: "Failed", result_json: { error: big } }));
    emit("event", event("TurnEnd", { status: "Completed", steps: big }));
    emit("event", event("TurnEnd", { status: { Interrupted: { reason: big } } }));
    emit("event", event("TurnEnd", { status: { Error: { headline: big, details: [big] } } }));
    assertInvariants(store);
    dispose();
  }, 30_000);

  test("a deeply nested tool result cannot overflow the stack", async () => {
    const { store, dispose } = await setup();
    emit("event", event("ToolStart", { id: "deep", name: "Bash", args: {} }));
    let nested: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) nested = { result: nested };
    emit("event", event("ToolEnd", { tool_use_id: "deep", status: "Completed", result_json: nested }));
    assertInvariants(store);
    dispose();
  }, 30_000);

  test("50k events in one hydration batch stay bounded", async () => {
    const events: EventMsg[] = [];
    for (let i = 0; i < 50_000; i++) {
      const pick = i % 7;
      if (pick === 0) events.push(event("Info", `line ${i}`));
      else if (pick === 1) events.push(event("MessageDelta", `chunk ${i}`));
      else if (pick === 2) events.push(event("ToolStart", { id: `t${i}`, name: "Bash", args: { i } }));
      else if (pick === 3) events.push(event("ToolEnd", { tool_use_id: `t${i - 2}`, status: "Completed", result_json: { content: `out ${i}` } }));
      else if (pick === 4) events.push(event("ThinkingDelta", `hmm ${i}`));
      else if (pick === 5) events.push(event("TurnStart", { turn_id: `turn${i}` }));
      else events.push(event("UsageUpdate", { usage: { input_tokens: i, output_tokens: 1 } }));
    }
    const { store, dispose } = await setup(events);
    assertInvariants(store);
    expect(store.rows().length).toBeLessThanOrEqual(400);
    dispose();
  }, 60_000);
});

describe("adversarial: randomised stream", () => {
  test("a seeded random stream keeps every invariant after every batch", async () => {
    const { store, dispose } = await setup();
    const random = mulberry32(0xc0ffee);
    let idSeq = 0;
    const nextId = () => `evt_r${++idSeq}`;
    const make = (name: string, payload: unknown) => raw({ [name]: payload }, nextId());
    const builders: Array<() => EventMsg> = [
      () => make("UserInput", `ask ${idSeq}`),
      () => make("MessageDelta", `delta ${idSeq}`),
      () => make("MessageDelta", 7),
      () => make("AgentMessage", `full ${idSeq}`),
      () => make("Thinking", `think ${idSeq}`),
      () => make("ThinkingDelta", `t ${idSeq}`),
      () => make("ToolStart", { id: `tool_${idSeq}`, name: "Bash", args: { command: "ls" } }),
      () => make("ToolStart", { id: `tool_${idSeq}`, name: "Read", args: "not an object" }),
      () => make("ToolStart", { name: "NoId", args: null }),
      () => make("ToolUpdate", { tool_use_id: `tool_${idSeq}`, seq: 1, message: "progress" }),
      () => make("ToolUpdate", { tool_use_id: "ghost", seq: 2, message: "orphan" }),
      () => make("ToolEnd", { tool_use_id: `tool_${idSeq}`, status: "Completed", result_json: { content: "ok" } }),
      () => make("ToolEnd", { tool_use_id: "ghost", status: "Failed", result_json: null }),
      () => make("TurnStart", { turn_id: `t${idSeq}` }),
      () => make("TurnPause", { turn_id: `t${idSeq}` }),
      () => make("TurnPause", { reason: { Approval: { tools: [], message: "empty" } } }),
      () => make("TurnPause", { turn_id: `t${idSeq}`, reason: { Approval: { tools: [{ id: `a${idSeq}`, name: "Bash", args: {} }], message: "allow?" } } }),
      () => make("TurnResume", { turn_id: `t${idSeq}` }),
      () => make("TurnEnd", { turn_id: `t${idSeq}`, status: "Completed", steps: 3 }),
      () => make("TurnEnd", { status: null }),
      () => make("TurnEnd", { status: { Error: { headline: "nope", details: ["a", "b"] } } }),
      () => make("TurnEnd", { status: { Interrupted: { reason: { nested: true } } } }),
      () => make("Error", random() < 0.5 ? "" : "rate limited"),
      () => make("Info", `note ${idSeq}`),
      () => make("InfoBlockStart", { id: `b${idSeq}`, header: "warming up", loading: true }),
      () => make("InfoBlockAppend", { id: `b${idSeq}`, detail: "step" }),
      () => make("CompactStart", null),
      () => make("CompactEnd", { summary: random() < 0.5 ? null : "short" }),
      () => make("ContextReport", { used_tokens: 10, limit_tokens: 100, messages_tokens: 5 }),
      () => make("ContextReport", "garbage"),
      () => make("UsageUpdate", { usage: { input_tokens: 1, output_tokens: 2 }, context: { used_tokens: 3, limit_tokens: 4 } }),
      () => make("UsageUpdate", "garbage"),
      () => make("SessionStart", SESSION),
      () => make("SessionUpdated", SESSION),
      () => make("SessionEnd", { session_id: "ses_TEST", reason: "Replaced", usage: { input_tokens: 1, output_tokens: 1 } }),
      () => raw("Goodbye", nextId()),
      () => raw("FutureVariant", nextId()),
    ];

    const batches = 200;
    for (let batch = 0; batch < batches; batch++) {
      const size = 1 + Math.floor(random() * 40);
      for (let i = 0; i < size; i++) {
        const builder = builders[Math.floor(random() * builders.length)]!;
        emit("event", builder());
      }
      assertInvariants(store);
      // Whenever the daemon is waiting on us, the prompt must be answerable.
      if (store.approval()) {
        const pendingTools = store.approval()!.tools;
        expect(pendingTools.length).toBeGreaterThan(0);
        expect(pendingTools.every((tool) => Boolean(tool?.id))).toBe(true);
        await store.respond(["Accept"]);
        const batchesSoFar = approveBatches();
        expect(batchesSoFar[batchesSoFar.length - 1]!.responses.length).toBeGreaterThan(0);
      }
    }
    expect(store.rows().length).toBeLessThanOrEqual(400);
    expect(store.history().length).toBeLessThanOrEqual(50);
    for (const batch of approveBatches()) expect(batch.responses.length).toBeGreaterThan(0);
    dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Round 3 store surface: terminal, capabilities, ambient, goal, density.
// ---------------------------------------------------------------------------

describe("density and terminal", () => {
  test("cycleDensity walks normal -> verbose -> summary -> normal", async () => {
    const { store, dispose } = await setup();
    expect(store.viewDensity()).toBe("normal");
    store.cycleDensity();
    expect(store.viewDensity()).toBe("verbose");
    store.cycleDensity();
    expect(store.viewDensity()).toBe("summary");
    store.cycleDensity();
    expect(store.viewDensity()).toBe("normal");
    dispose();
  });

  test("steer rejects empty text without invoking", async () => {
    const { store, dispose } = await setup();
    await store.steer("   ");
    await store.steer("\n\t");
    expect(opCalls("steer")).toHaveLength(0);
    await store.steer("  focus on the parser ");
    expect(opCalls("steer")).toEqual([{ text: "focus on the parser" }]);
    dispose();
  });

  test("runShell sends shell_input and ShellOutput fills terminal newest-last", async () => {
    const { store, dispose } = await setup();
    await store.runShell("  git status ");
    expect(opCalls("shell_input")).toEqual([{ command: "git status" }]);
    emit("event", event("ShellOutput", { command: "git status", stdout: "clean", stderr: "", exit_code: 0 }));
    expect(store.terminal()).toHaveLength(1);
    const entry = store.terminal()[0]!;
    expect(entry.command).toBe("git status");
    expect(entry.stdout).toBe("clean");
    expect(entry.stderr).toBe("");
    expect(entry.exitCode).toBe(0);
    expect(entry.id).toBeTruthy();
    dispose();
  });

  test("a ShellOutput without an exit code keeps exitCode null", async () => {
    const { store, dispose } = await setup();
    emit("event", event("ShellOutput", { command: "sleep 1", stdout: "", stderr: "killed", exit_code: null }));
    expect(store.terminal()[0]!.exitCode).toBeNull();
    expect(store.terminal()[0]!.stderr).toBe("killed");
    dispose();
  });

  test("the terminal keeps only the newest 50 entries and clears on demand", async () => {
    const { store, dispose } = await setup();
    for (let i = 0; i < 60; i++) {
      emit("event", event("ShellOutput", { command: `cmd ${i}`, stdout: `out ${i}`, stderr: "", exit_code: i }));
    }
    const entries = store.terminal();
    expect(entries).toHaveLength(50);
    expect(entries[0]!.command).toBe("cmd 10");
    expect(entries[49]!.command).toBe("cmd 59");
    store.clearTerminal();
    expect(store.terminal()).toHaveLength(0);
    dispose();
  });
});

describe("capabilities", () => {
  test("ExtensionRefreshed fills the panel without a click, with several MCP servers", async () => {
    const { store, dispose } = await setup();
    expect(store.capabilities().skills).toHaveLength(0);
    emit("event", event("ExtensionRefreshed", {
      session_id: "ses_TEST",
      skills: [{ name: "commit", description: "Create a git commit" }],
      subagents: [{ name: "explore", description: "Explore the codebase" }],
      mcp_servers: [
        { name: "filesystem", command: "npx", args: [], tools: [{ name: "read" }, { name: "write" }] },
        { name: "github", command: "npx", args: [], tools: [] },
        { name: "broken", command: "npx", args: [] },
      ],
    }));
    expect(store.capabilities().skills).toEqual([{ name: "commit", description: "Create a git commit" }]);
    expect(store.capabilities().subagents).toEqual([{ name: "explore", description: "Explore the codebase" }]);
    expect(store.capabilities().mcpServers).toEqual([
      { name: "filesystem", tools: 2 },
      { name: "github", tools: 0 },
      { name: "broken", tools: 0 },
    ]);
    dispose();
  });

  test("the session-start ExtensionRefreshed lands during hydration too", async () => {
    const refresh = event("ExtensionRefreshed", {
      session_id: "ses_TEST",
      skills: [{ name: "simplify", description: "review the diff" }],
      subagents: [],
      mcp_servers: [{ name: "fs", tools: [{ name: "a" }] }],
    });
    const { store, dispose } = await setup([refresh]);
    expect(store.capabilities().skills[0]!.name).toBe("simplify");
    expect(store.capabilities().mcpServers).toEqual([{ name: "fs", tools: 1 }]);
    dispose();
  });
});

describe("ambient", () => {
  test("phrases drop stale req_ids and accept the newest", async () => {
    const { store, dispose } = await setup();
    await store.requestAmbientPhrase("refactor the parser");
    expect(opCalls("ambient_phrase")).toEqual([{ draft: "refactor the parser", request_id: 1 }]);
    emit("event", event("Ambient", { kind: "ThinkingPhrase", req_id: 1, text: "pondering" }));
    expect(store.ambient().phrase).toBe("pondering");
    // An older reply must not overwrite the current phrase.
    emit("event", event("Ambient", { kind: "ThinkingPhrase", req_id: 0, text: "stale" }));
    expect(store.ambient().phrase).toBe("pondering");
    // A newer request supersedes the old one; its stale reply is dropped.
    await store.requestAmbientPhrase("write the tests");
    expect(opCalls("ambient_phrase")[1]).toEqual({ draft: "write the tests", request_id: 2 });
    emit("event", event("Ambient", { kind: "ThinkingPhrase", req_id: 1, text: "old" }));
    expect(store.ambient().phrase).toBe("pondering");
    emit("event", event("Ambient", { kind: "ThinkingPhrase", req_id: 2, text: "testing" }));
    expect(store.ambient().phrase).toBe("testing");
    dispose();
  });

  test("TurnEnd requests one suggestion from the last exchange", async () => {
    const { store, dispose } = await setup();
    await store.submit("fix the parser bug");
    emit("event", event("AgentMessage", "Fixed — the cause was a stale cache."));
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    expect(opCalls("ambient_suggestion")).toEqual([
      {
        recent_user: "fix the parser bug",
        recent_agent: "Fixed — the cause was a stale cache.",
        request_id: 1,
      },
    ]);
    // A second TurnEnd while the first is outstanding does not fan out.
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    expect(opCalls("ambient_suggestion")).toHaveLength(1);
    emit("event", event("Ambient", { kind: "PromptSuggestion", req_id: 1, text: "run the tests" }));
    expect(store.ambient().suggestion).toBe("run the tests");
    dispose();
  });

  test("no suggestion is requested without a completed exchange", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnEnd", { status: "Completed", steps: 0 }));
    emit("event", event("UserInput", "only a prompt"));
    emit("event", event("TurnEnd", { status: "Completed", steps: 0 }));
    expect(opCalls("ambient_suggestion")).toHaveLength(0);
    dispose();
  });

  test("a suggestion reply that outlives its turn is dropped", async () => {
    const { store, dispose } = await setup();
    await store.submit("first");
    emit("event", event("AgentMessage", "answer"));
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    emit("event", event("TurnStart", { turn_id: "t2" }));
    emit("event", event("Ambient", { kind: "PromptSuggestion", req_id: 1, text: "too late" }));
    expect(store.ambient().suggestion).toBeNull();
    dispose();
  });

  test("a newer turn frees the slot so the next TurnEnd can ask again", async () => {
    const { store, dispose } = await setup();
    await store.submit("first");
    emit("event", event("AgentMessage", "answer"));
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    expect(opCalls("ambient_suggestion")).toHaveLength(1);
    emit("event", event("TurnStart", { turn_id: "t2" }));
    emit("event", event("AgentMessage", "second answer"));
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    expect(opCalls("ambient_suggestion")).toHaveLength(2);
    expect(opCalls("ambient_suggestion")[1]).toEqual({
      recent_user: "first",
      recent_agent: "second answer",
      request_id: 2,
    });
    dispose();
  });
});

describe("goal", () => {
  test("setGoal / clearGoal / requestGoalStatus send the goal ops", async () => {
    const { store, dispose } = await setup();
    await store.setGoal(" ship the parser ");
    expect(opCalls("goal")).toEqual([{ command: "Set", condition: "ship the parser" }]);
    expect(store.goal().condition).toBe("ship the parser");
    await store.requestGoalStatus();
    expect(opCalls("goal")[1]).toEqual({ command: "Status" });
    await store.clearGoal();
    expect(opCalls("goal")[2]).toEqual({ command: "Clear" });
    expect(store.goal().condition).toBeNull();
    dispose();
  });

  test("goal Info text lands in note", async () => {
    const { store, dispose } = await setup();
    emit("event", event("Info", "🎯 Goal set: ship the parser"));
    expect(store.goal().note).toBe("🎯 Goal set: ship the parser");
    // An unrelated Info row is not a goal note.
    emit("event", event("Info", "warming up"));
    expect(store.goal().note).toBe("🎯 Goal set: ship the parser");
    dispose();
  });

  test("the goal slash commands update the tracked condition", async () => {
    const { store, dispose } = await setup();
    await store.submit("/goal ship it");
    expect(store.goal().condition).toBe("ship it");
    await store.submit("/goal-clear");
    expect(store.goal().condition).toBeNull();
    expect(opCalls("goal")).toEqual([{ command: "Set", condition: "ship it" }, { command: "Clear" }]);
    dispose();
  });
});
