// Reducer, run-flow and trust tests for the GUI store.
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
import { SCHEDULE_STORAGE_KEY } from "./simple/schedule.ts";

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
  clearStorage();
}

// ---------------------------------------------------------------------------
// A localStorage stand-in for the #55 schedule tests. `bun test` has no
// localStorage, so the tests install a tiny one and remove it again after each
// case; a locked-down webview behaves the same way (writes just vanish).
// ---------------------------------------------------------------------------

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
  (globalThis as unknown as { localStorage?: Storage }).localStorage = storage;
  return map;
}

function clearStorage(): void {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
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

/** Mount a store without connecting, for "restart and read back" tests. */
function mountStore(): { store: Store; dispose: () => void } {
  let store!: Store;
  let dispose!: () => void;
  createRoot((root) => {
    dispose = root;
    store = createStore();
  });
  return { store, dispose };
}

beforeEach(reset);

// ---------------------------------------------------------------------------

describe("hydration", () => {
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
});

describe("approvals and scale", () => {
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
    for (const batch of approveBatches()) expect(batch.responses.length).toBeGreaterThan(0);
    dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Round 3 store surface: terminal, capabilities, ambient, goal, density.
// ---------------------------------------------------------------------------

describe("replyToRun", () => {
  const TASK = {
    id: "excel.merge",
    title: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
  };

  /** Start a run, name step 2 so the cursor moves, and let the turn finish. */
  async function stoppedRun(store: Store): Promise<void> {
    await store.startRun(TASK, ["/work/a.xlsx", "/work/b.xlsx"], "把这两张表合成一张");
    await store.confirmRun();
    emit("event", event("AgentMessage", "第 2 步：开始合成"));
    emit("event", event("TurnEnd", { status: "Completed", steps: 2 }));
    await Bun.sleep(20);
  }

  test("does nothing when there is no run", async () => {
    const { store, dispose } = await setup();
    await store.replyToRun("金额（元）就是金额");
    expect(opCalls("send_input")).toEqual([]);
    expect(opCalls("begin_run")).toEqual([]);
    dispose();
  });

  test("blank text sends nothing", async () => {
    const { store, dispose } = await setup();
    await stoppedRun(store);
    const before = opCalls("send_input").length;
    await store.replyToRun("   \n  ");
    expect(opCalls("send_input").length).toBe(before);
    expect(store.currentRun()?.state).toBe("done");
    dispose();
  });

  test("a stopped run resumes, clears the old result, and keeps the progress cursor", async () => {
    const { store, dispose } = await setup();
    await stoppedRun(store);
    expect(store.currentRun()?.state).toBe("done");
    expect(store.currentRun()?.result).not.toBeNull();

    await store.replyToRun("金额（元）就是金额");

    const run = store.currentRun();
    expect(run?.state).toBe("running");
    expect(run?.result).toBeNull();
    expect(run?.error).toBeNull();
    // The original sentence stays clean; the reply is a separate turn.
    expect(run?.instruction).toBe("把这两张表合成一张");
    const sent = opCalls("send_input");
    expect(sent[sent.length - 1]).toEqual({ text: "金额（元）就是金额", mode: "prompt" });
    // The cursor only moves forward: step 1 was already done when it asked.
    const steps = store.progress().steps;
    expect(steps[0]?.state).toBe("done");
    expect(steps[1]?.state).toBe("active");
    dispose();
  });

  test("a running run does not send a second instruction", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这两张表合成一张");
    await store.confirmRun();
    expect(store.currentRun()?.state).toBe("running");
    const before = opCalls("send_input").length;
    await store.replyToRun("金额（元）就是金额");
    expect(opCalls("send_input").length).toBe(before);
    expect(store.currentRun()?.state).toBe("running");
    dispose();
  });
});

// ---------------------------------------------------------------------------

describe("#55 定时/重复任务", () => {
  const TASK = {
    id: "excel.merge",
    title: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
  };
  const input = {
    cadence: "weekly" as const,
    day: 1,
    hour: 9,
    taskId: TASK.id,
    taskTitle: TASK.title,
    plan: [...TASK.plan],
    files: ["/work/a.xlsx", "/work/b.xlsx"],
    instruction: "把这两张表合成一张",
  };

  test("一开始没有任何自动任务", async () => {
    const { store, dispose } = await setup();
    expect(store.schedules()).toEqual([]);
    dispose();
  });

  test("addSchedule 默认开启，并写进本地存储", async () => {
    const map = installStorage();
    const { store, dispose } = await setup();
    const schedule = store.addSchedule(input);
    expect(schedule.enabled).toBe(true);
    expect(schedule.id).toBeTruthy();
    expect(store.schedules()).toHaveLength(1);
    const raw = map.get(SCHEDULE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0].id).toBe(schedule.id);
    dispose();
  });

  test("重启后能读回来，停掉与删掉也会写回", async () => {
    installStorage();
    const first = mountStore();
    const schedule = first.store.addSchedule(input);
    first.dispose();

    // 换一个 store 当成「重启」。
    const second = mountStore();
    expect(second.store.schedules().map((item) => item.id)).toEqual([schedule.id]);

    second.store.setScheduleEnabled(schedule.id, false);
    expect(second.store.schedules()[0]!.enabled).toBe(false);
    second.dispose();

    const third = mountStore();
    expect(third.store.schedules()[0]!.enabled).toBe(false);

    third.store.removeSchedule(schedule.id);
    third.dispose();

    const fourth = mountStore();
    expect(fourth.store.schedules()).toEqual([]);
    fourth.dispose();
  });

  test("坏 JSON 不能让应用起不来，之后照样能用", async () => {
    installStorage({ [SCHEDULE_STORAGE_KEY]: "{ 这不是 json" });
    const { store, dispose } = await setup();
    expect(store.schedules()).toEqual([]);
    const schedule = store.addSchedule(input);
    expect(store.schedules().map((item) => item.id)).toEqual([schedule.id]);
    dispose();
  });

  test("没有本地存储也能加调度，只是记不住", async () => {
    const { store, dispose } = await setup();
    const schedule = store.addSchedule(input);
    expect(store.schedules().map((item) => item.id)).toEqual([schedule.id]);
    dispose();
  });

  test("runScheduled 用调度里的文件和话术，先摆到确认页而不是自己动手", async () => {
    const { store, dispose } = await setup();
    const schedule = store.addSchedule(input);
    await store.runScheduled(schedule.id);

    const run = store.currentRun();
    expect(run?.state).toBe("preview");
    expect(run?.taskId).toBe(TASK.id);
    expect(run?.taskTitle).toBe(TASK.title);
    expect(run?.plan).toEqual(TASK.plan);
    expect(run?.files).toEqual(["/work/a.xlsx", "/work/b.xlsx"]);
    expect(run?.instruction).toBe("把这两张表合成一张");
    // 没有替她按「开始」：确认流程一模一样，所以没有发出任何指令。
    expect(opCalls("send_input")).toEqual([]);
    // 记下了这次时间，同一个时间点不会再触发。
    expect(store.schedules()[0]!.lastRunAt).toBeGreaterThan(0);
    dispose();
  });

  test("停掉的调度不会被启动", async () => {
    const { store, dispose } = await setup();
    const schedule = store.addSchedule(input);
    store.setScheduleEnabled(schedule.id, false);
    await store.runScheduled(schedule.id);
    expect(store.currentRun()).toBeNull();
    expect(store.schedules()[0]!.lastRunAt).toBeUndefined();
    dispose();
  });

  test("当前有任务在跑时不重复启动", async () => {
    const { store, dispose } = await setup();
    const schedule = store.addSchedule(input);
    await store.startRun(TASK, ["/work/a.xlsx"], "手动那次");
    await store.confirmRun();
    const running = store.currentRun();
    expect(running?.state).toBe("running");

    await store.runScheduled(schedule.id);

    // 还是原来那一件，没有被顶掉；调度也没被记成「跑过了」。
    expect(store.currentRun()?.id).toBe(running?.id);
    expect(store.currentRun()?.instruction).toBe("手动那次");
    expect(store.schedules()[0]!.lastRunAt).toBeUndefined();
    dispose();
  });

  test("确认页还开着时，同一分钟不再排第二件", async () => {
    const { store, dispose } = await setup();
    const first = store.addSchedule(input);
    const second = store.addSchedule({ ...input, taskId: "file.rename", taskTitle: "把文件改名" });
    await store.runScheduled(first.id);
    const staged = store.currentRun()?.id;

    await store.runScheduled(second.id);
    expect(store.currentRun()?.id).toBe(staged);
    expect(store.currentRun()?.taskId).toBe(TASK.id);
    expect(store.schedules().find((item) => item.id === second.id)?.lastRunAt).toBeUndefined();
    expect(store.schedules().find((item) => item.id === first.id)?.lastRunAt).toBeGreaterThan(0);
    dispose();
  });
});
