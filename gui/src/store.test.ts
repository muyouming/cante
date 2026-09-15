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
