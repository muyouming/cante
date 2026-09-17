// Reducer, run-flow and trust tests for the GUI store.
//
// The store is the seam between the Rust bridge and the UI: it folds
// `cante://event` batches into rows and turns UI intent back into contract
// commands. Both directions are asserted here against a fake bridge, so a
// shape drift on either side fails in `bun test src` instead of at runtime.
//
//   bun test gui/src
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { createRoot } from "solid-js";

import { eventName, type EventMsg } from "./protocol.ts";
import { describeApproval } from "./simple/approval.ts";
import { FOLLOW_RECOMMENDATION_NOTE } from "./simple/copy-question.ts";
import {
  DISMISSED_REPLY,
  answeredReply,
  discussReply,
  draftsFor,
  followRecommendationReply,
  toggleOption,
} from "./simple/question.ts";
import { SCHEDULE_STORAGE_KEY } from "./simple/schedule.ts";
// #140 — notice 的四个写方在界面上的说法（结果卡片 / 选文件那一步 / 出错页）。
import { PICK_KINDS, UNDO_KINDS, noticeView, visibleNotice } from "./simple/copy-notice.ts";

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
// #140 — 这几个开关只给「notice 有出口了」那组测试用：让撤销/选文件窗口的结果可控。
let undoReply: { restored?: unknown; failed?: unknown } = { restored: [], failed: [] };
let undoFails = false;
let pickerFails = false;

function emit(channel: string, payload: unknown): void {
  for (const handler of handlers.get(channel) ?? []) handler(payload);
}

function reset(): void {
  handlers.clear();
  calls.length = 0;
  healthSession = null;
  undoReply = { restored: [], failed: [] };
  undoFails = false;
  pickerFails = false;
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
      case "undo_run":
        if (undoFails) throw new Error("the file is locked");
        return { ok: true, ...undoReply };
      case "pick_files":
        if (pickerFails) throw new Error("no file dialog on this machine");
        return { paths: [] };
      case "pick_folder":
        if (pickerFails) throw new Error("no file dialog on this machine");
        return { path: null };
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

  test("tracks failures and drops what was waiting when the daemon exits", async () => {
    const { store, dispose } = await setup();
    emit("event", event("Error", "rate limited"));
    expect(store.rows().some((row) => row.kind === "error" && row.text === "rate limited")).toBe(true);
    // 退出时真正做的是把等着她的两张卡收起来（状态胶囊已随专业模式删除）。
    emit("event", event("TurnPause", { turn_id: "t1", reason: { Approval: { tools: [{ id: "tool_1", name: "Bash", args: { command: "ls" } }], message: "Allow?" } } }));
    expect(store.approval()).not.toBeNull();
    emit("exit", { code: 1 });
    expect(store.approval()).toBeNull();
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
// r25 — structured questions: `TurnPause{reason:Question}` in, `Op::QuestionResponse`
// out. The semantics asserted here are the protocol's (msg.rs): echo both ids,
// `selected` carries option labels, `note` carries free text, and the pause clears
// on TurnResume *and* on TurnEnd.
// ---------------------------------------------------------------------------

const QUESTION_PAUSE = {
  turn_id: "t1",
  reason: {
    Question: {
      tool_use_id: "toolu_1",
      questions: [
        {
          header: "金额那一列",
          question: "表里的「金额（元）」就是你说的金额吗？",
          multi_select: false,
          options: [
            { label: "就是它", description: "直接填进金额那一列" },
            { label: "不是它", description: "我会再告诉你哪一列才是" },
          ],
        },
      ],
    },
  },
};

describe("structured questions", () => {
  test("TurnPause{Question} → 状态里有问题", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    expect(store.question()?.turn_id).toBe("t1");
    expect(store.question()?.tool_use_id).toBe("toolu_1");
    expect(store.question()?.questions[0]!.options[0]!.label).toBe("就是它");
    dispose();
  });

  test("回答 → 发出正确的 QuestionResponse（turn_id / tool_use_id / selected 都对）", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    const questions = store.question()!.questions;
    const drafts = draftsFor(questions);
    drafts[0] = toggleOption(drafts[0]!, "不是它", false);
    await store.answerQuestion(answeredReply(questions, drafts));
    expect(opCalls("question_response")).toEqual([
      {
        turn_id: "t1",
        tool_use_id: "toolu_1",
        reply: { Answered: [{ selected: ["不是它"] }] },
      },
    ]);
    expect(store.question()).toBeNull();
    dispose();
  });

  test("自由文本进 note；「你看着办」翻成建议 + 她明确表态", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    const questions = store.question()!.questions;
    await store.answerQuestion(answeredReply(questions, [{ selected: [], note: "其实是第二列" }]));
    // 回答成功就清掉了暂停，再发一次才能测第二条出路。
    emit("event", event("TurnPause", QUESTION_PAUSE));
    await store.answerQuestion(followRecommendationReply(questions));
    const [free, follow] = opCalls("question_response");
    expect(free).toEqual({
      turn_id: "t1",
      tool_use_id: "toolu_1",
      reply: { Answered: [{ selected: [], note: "其实是第二列" }] },
    });
    expect(follow).toEqual({
      turn_id: "t1",
      tool_use_id: "toolu_1",
      reply: { Answered: [{ selected: ["就是它"], note: FOLLOW_RECOMMENDATION_NOTE }] },
    });
    dispose();
  });

  test("「先聊聊」发 Discuss；「先不回答」发 Dismissed", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    await store.answerQuestion(discussReply("先说说看"));
    emit("event", event("TurnPause", QUESTION_PAUSE));
    await store.answerQuestion(DISMISSED_REPLY);
    const [discuss, dismissed] = opCalls("question_response");
    expect(discuss).toEqual({
      turn_id: "t1",
      tool_use_id: "toolu_1",
      reply: { Discuss: { message: "先说说看" } },
    });
    expect(dismissed).toEqual({ turn_id: "t1", tool_use_id: "toolu_1", reply: "Dismissed" });
    dispose();
  });

  test("TurnResume 清掉提问状态", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    expect(store.question()).not.toBeNull();
    emit("event", event("TurnResume", { turn_id: "t1" }));
    expect(store.question()).toBeNull();
    dispose();
  });

  test("TurnEnd 也清掉提问状态（被取消的回合可能不发 resume）", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", QUESTION_PAUSE));
    expect(store.question()).not.toBeNull();
    emit("event", event("TurnEnd", { turn_id: "t1", status: "Completed", steps: 1 }));
    expect(store.question()).toBeNull();
    dispose();
  });

  test("读不出来的提问不弹空框", async () => {
    const { store, dispose } = await setup();
    emit("event", event("TurnPause", { turn_id: "t1", reason: { Question: { questions: [] } } }));
    expect(store.question()).toBeNull();
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

  test("确认时发出的是卡片提示词，不只是用户那句话（这条线曾经断过）", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx", "/work/b.xlsx"], "把这两张表合成一张");
    await store.confirmRun();

    const sent = opCalls("send_input") as Array<{ text: string; mode: string }>;
    const text = sent.at(-1)?.text ?? "";

    // 她说过的那句话必须还在。
    expect(text).toContain("把这两张表合成一张");
    // 卡片的规矩也必须在——这就是曾经的断点：卡片提示词从来没被发出去。
    expect(text).toContain("原来的文件一张都不要改");
    // 卡片提示词是有结构的（要做的事 / 文件 / 怎么做），不可能只有一句话那么短。
    expect(text.length).toBeGreaterThan(200);
    dispose();
  });

  test("store 暴露的 composedInstruction 就是真正发出去的那段（r20 隐私面板据此展示）", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx", "/work/b.xlsx"], "把这两张表合成一张");
    const exposed = store.composedInstruction(store.currentRun()!);
    await store.confirmRun();

    const sent = opCalls("send_input") as Array<{ text: string }>;
    // 逐字一致：面板拿这个展示，就不会和真正发出去的那份漂移。
    expect(sent.at(-1)?.text).toBe(exposed);
    // 旧任务（卡片已经不在）退回她那一句话，不凭空拼一份。
    expect(store.composedInstruction({ ...store.currentRun()!, taskId: "gone.forever" })).toBe(
      "把这两张表合成一张",
    );
    dispose();
  });

  test("试跑发出去的也是卡片提示词", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这两张表合成一张");
    await store.dryRun();

    const sent = opCalls("send_input") as Array<{ text: string }>;
    const text = sent.at(-1)?.text ?? "";
    expect(text).toContain("原来的文件一张都不要改");
    // 试跑的约束是**拼在卡片提示词之后**的，两段都要在。
    expect(text).toContain("这次只试跑");
    expect(text.indexOf("原来的文件一张都不要改")).toBeLessThan(text.indexOf("这次只试跑"));
    dispose();
  });

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

describe("失败记录：可核对的原因不能被洗掉（r17）", () => {
  const TASK = {
    id: "excel.merge",
    title: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
  };

  /** 一件活真的跑起来，再用守护进程给的失败收尾。 */
  async function runThenFail(store: Store, payload: unknown): Promise<void> {
    await store.startRun(TASK, ["/work/报表.xlsx"], "把这两张表合成一张");
    await store.confirmRun();
    emit("event", event("TurnEnd", { status: payload }));
    await Bun.sleep(25);
  }

  test("系统原话留在 cause 里，给用户看的两句仍是平实中文", async () => {
    const { store, dispose } = await setup();
    await runThenFail(store, {
      Error: { headline: "EBUSY: resource busy or locked", details: ["open 'C:\\报表.xlsx'"] },
    });

    const run = store.currentRun();
    expect(run?.state).toBe("failed");
    const error = run?.error as {
      what: string;
      how: string;
      detail: string;
      cause?: string;
    } | null;

    // 可核对的原因一份不少：标题和底下的原文都在 cause 里。
    expect(error?.cause).toContain("EBUSY: resource busy or locked");
    expect(error?.cause).toContain("报表.xlsx");
    // detail 仍是给技术同事的那一份。
    expect(error?.detail).toBe(error?.cause);
    // 给用户看的两句是平实中文，不得出现英文错误码 / 文件名后缀。
    expect(error?.what).toBe("这件事没有做完。");
    expect(error?.how).toContain("原来的文件都还在");
    expect(error?.what).not.toContain("EBUSY");
    expect(error?.how).not.toContain("EBUSY");
    expect(error?.how).not.toContain("xlsx");
    dispose();
  });

  test("试跑失败时 what 说的是试跑，cause 照样留着", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/报表.xlsx"], "把这两张表合成一张");
    await store.dryRun();
    emit(
      "event",
      event("TurnEnd", { status: { Error: { headline: "ENOENT: no such file", details: [] } } }),
    );
    await Bun.sleep(25);

    const error = store.currentRun()?.error as { what: string; cause?: string } | null;
    expect(error?.what).toBe("这次试跑没能做完。");
    expect(error?.cause).toBe("ENOENT: no such file");
    dispose();
  });

  test("守护进程直接报错那条路也一样：cause 是它给的原话", async () => {
    const { store, dispose } = await setup();
    await store.startRun(TASK, ["/work/报表.xlsx"], "把这两张表合成一张");
    await store.confirmRun();
    emit("event", event("Error", "os error 13: Permission denied"));
    await Bun.sleep(25);

    const error = store.currentRun()?.error as { what: string; cause?: string } | null;
    expect(store.currentRun()?.state).toBe("failed");
    expect(error?.cause).toContain("Permission denied");
    expect(error?.what).not.toContain("Permission");
    dispose();
  });
});

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

// ---------------------------------------------------------------------------
// r13 — 队列：一次说好几件事，一件件来。
//
// 这里钉的是那条产品律：排队**不等于**自动做完。每一件都还是要先摆到确认页，
// 她点了「开始」才动手；上一件做完了，队列只把下一件推到确认页，不会自己往下跑。
// ---------------------------------------------------------------------------

describe("r13 队列（一次说好几件事）", () => {
  const A = { id: "excel.merge", title: "把几张表合成一张", plan: ["打开这几张表", "合成一张新表"] };
  const B = { id: "file.rename", title: "把文件改名", plan: ["读出原来的名字", "换成新的名字"] };
  const C = { id: "files.tidy", title: "整理文件夹", plan: ["列出文件夹里的东西", "分门别类"] };

  const inputA = {
    taskId: A.id,
    taskTitle: A.title,
    plan: A.plan,
    files: ["/work/a.xlsx"],
    instruction: "合成一张",
  };
  const inputB = {
    taskId: B.id,
    taskTitle: B.title,
    plan: B.plan,
    files: ["/work/b.docx"],
    instruction: "改个名",
  };
  const inputC = {
    taskId: C.id,
    taskTitle: C.title,
    plan: C.plan,
    files: ["/work/c"],
    instruction: "整理一下",
  };

  /** 把手上这件正在跑的活做完（一次成功的回合）。 */
  async function finishTurn(): Promise<void> {
    emit("event", event("TurnEnd", { status: "Completed", steps: 1 }));
    await Bun.sleep(25);
  }

  /** 队里的某一件（按任务找，测试里够用）。 */
  function queuedTask(store: Store, taskId: string) {
    return store.queue().find((job) => job.taskId === taskId);
  }

  test("一开始队列是空的；排一件只是排上，不会开始做", async () => {
    const { store, dispose } = await setup();
    expect(store.queue()).toEqual([]);

    const job = store.enqueue(inputA);
    expect(job?.taskId).toBe(A.id);
    expect(store.queue().map((item) => item.state)).toEqual(["waiting"]);
    // 排上 ≠ 开始：没有摆到确认页，也没有发出任何指令。
    expect(store.currentRun()).toBeNull();
    expect(opCalls("send_input")).toEqual([]);
    dispose();
  });

  test("startNextQueued 把排在头一件摆到确认页，仍然要她点头", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);

    const staged = store.startNextQueued();
    expect(staged?.taskId).toBe(A.id);
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.currentRun()?.taskId).toBe(A.id);
    expect(store.currentRun()?.files).toEqual(["/work/a.xlsx"]);
    // 只停在确认页：一个指令都没发。
    expect(opCalls("send_input")).toEqual([]);
    expect(store.queue().map((item) => item.state)).toEqual(["running", "waiting"]);

    // 手上已经有活了，就不再摆第二件。
    expect(store.startNextQueued()).toBeNull();
    expect(store.currentRun()?.taskId).toBe(A.id);
    dispose();
  });

  test("做完一件，下一件自动摆到确认页——但绝不自作主张动手", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.startNextQueued();
    await store.confirmRun();
    expect(store.currentRun()?.state).toBe("running");

    await finishTurn();

    // 下一件到了确认页，计划和文件都是它自己的。
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.currentRun()?.taskId).toBe(B.id);
    expect(store.currentRun()?.plan).toEqual(B.plan);
    expect(store.currentRun()?.files).toEqual(["/work/b.docx"]);
    expect(queuedTask(store, A.id)?.state).toBe("done");
    expect(queuedTask(store, B.id)?.state).toBe("running");
    // 第二件的指令一个字都没发出去：它只是在等她点头。
    const sent = opCalls("send_input") as Array<{ text: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("合成一张");
    dispose();
  });

  test("结果先留给她看：下一件的确认页不许把它盖住", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.startNextQueued();
    await store.confirmRun();
    await finishTurn();

    // 刚做完、还没看过的那一件。
    expect(store.lastFinished()?.taskId).toBe(A.id);
    expect(store.lastFinished()?.state).toBe("done");

    // 「知道了」/「看下一件」只表示结果看过了：等她确认的那件不能跟着被丢掉。
    store.dismissRun();
    expect(store.lastFinished()).toBeNull();
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.currentRun()?.taskId).toBe(B.id);
    dispose();
  });

  test("跳过：队里这件拿掉，下一件顶上来；最后一件跳过就收工", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.enqueue(inputC);
    store.startNextQueued();

    const staged = store.queue().find((item) => item.state === "running")!;
    store.removeFromQueue(staged.id);
    expect(store.queue().some((item) => item.id === staged.id)).toBe(false);
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.currentRun()?.taskId).toBe(B.id);

    const second = store.queue().find((item) => item.state === "running")!;
    store.removeFromQueue(second.id);
    expect(store.currentRun()?.taskId).toBe(C.id);

    // 最后一件跳过之后，队列不会自己去找活干。
    const third = store.queue().find((item) => item.state === "running")!;
    store.removeFromQueue(third.id);
    expect(store.currentRun()).toBeNull();
    expect(store.queue()).toEqual([]);
    expect(opCalls("send_input")).toEqual([]);
    dispose();
  });

  test("正在做的时候再排一件：不打断，也不插队", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.startNextQueued();
    await store.confirmRun();
    const running = store.currentRun();
    expect(running?.state).toBe("running");

    store.enqueue(inputB);

    // 手上这件没被顶掉，也没被打断。
    expect(store.currentRun()?.id).toBe(running?.id);
    expect(store.queue().map((item) => item.state)).toEqual(["running", "waiting"]);
    expect(opCalls("interrupt")).toEqual([]);

    // 等它做完了才轮到刚排的那件。
    await finishTurn();
    expect(store.currentRun()?.taskId).toBe(B.id);
    expect(store.currentRun()?.state).toBe("preview");
    dispose();
  });

  test("重复加入同一件事只排一件；同一张卡换个说法/换批文件算两件", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    const again = store.enqueue(inputA);
    expect(store.queue()).toHaveLength(1);
    expect(again?.id).toBe(store.queue()[0]!.id);

    store.enqueue({ ...inputA, instruction: "只保留上个月" });
    store.enqueue({ ...inputA, files: ["/work/z.xlsx"] });
    expect(store.queue()).toHaveLength(3);
    dispose();
  });

  test("停掉剩下的：队列清空；停在确认页的收起来，正在做的不打断", async () => {
    const { store, dispose } = await setup();
    // (a) 还停在确认页：可以安静地收起来，她什么都没损失。
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.startNextQueued();
    store.clearQueue();
    expect(store.queue()).toEqual([]);
    expect(store.currentRun()).toBeNull();
    expect(opCalls("send_input")).toEqual([]);

    // (b) 真的在做：不打断，她自己按「停」才算数。
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.startNextQueued();
    await store.confirmRun();
    expect(store.currentRun()?.state).toBe("running");
    store.clearQueue();
    expect(store.queue()).toEqual([]);
    expect(store.currentRun()?.state).toBe("running");
    expect(opCalls("interrupt")).toEqual([]);
    dispose();
  });

  test("确认页上按「取消」：这件退回队里等着，不丢", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.startNextQueued();

    store.cancelRun();

    expect(store.currentRun()).toBeNull();
    expect(store.queue().map((item) => item.state)).toEqual(["waiting", "waiting"]);
    // 她还能在首页把它叫回来（「去做这一件」）。
    expect(store.startNextQueued()?.taskId).toBe(A.id);
    expect(store.currentRun()?.state).toBe("preview");
    dispose();
  });

  test("「先做这件」：从卡片直接进来的那件插到最前面，别人往后排", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputB);
    // 她没排队，直接从卡片开了一件。
    await store.startRun(A, ["/work/a.xlsx"], "合成一张");
    expect(store.currentRun()?.state).toBe("preview");

    store.keepStagedFirst();

    expect(store.queue().map((item) => item.taskId)).toEqual([A.id, B.id]);
    expect(store.queue().map((item) => item.state)).toEqual(["running", "waiting"]);
    // 再按一次不会插第二遍。
    store.keepStagedFirst();
    expect(store.queue().filter((item) => item.taskId === A.id)).toHaveLength(1);
    dispose();
  });

  test("做成的记成做完了，没做成/停掉的记成没做成", async () => {
    const { store, dispose } = await setup();
    store.enqueue(inputA);
    store.enqueue(inputB);
    store.enqueue(inputC);
    store.startNextQueued();
    await store.confirmRun();
    await finishTurn();
    expect(queuedTask(store, A.id)?.state).toBe("done");
    expect(store.currentRun()?.taskId).toBe(B.id);

    // 第二件失败了：下一件照样摆到确认页，不会假装它做完了。
    await store.confirmRun();
    emit("event", event("TurnEnd", { status: { Error: { headline: "没做成", details: [] } } }));
    await Bun.sleep(25);
    expect(queuedTask(store, B.id)?.state).toBe("failed");
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.currentRun()?.taskId).toBe(C.id);

    // 第三件她按了「停」：没做完就是没做完。
    await store.confirmRun();
    store.cancelRun();
    await Bun.sleep(25);
    expect(queuedTask(store, C.id)?.state).toBe("failed");
    expect(opCalls("interrupt")).toHaveLength(1);
    dispose();
  });

  test("坏数据：排不进去的东西一律拒绝，队列不崩", async () => {
    const { store, dispose } = await setup();
    type AnyInput = Parameters<Store["enqueue"]>[0];
    expect(store.enqueue(null as unknown as AnyInput)).toBeNull();
    expect(store.enqueue({} as unknown as AnyInput)).toBeNull();
    expect(store.enqueue(undefined as unknown as AnyInput)).toBeNull();
    expect(store.queue()).toEqual([]);

    store.enqueue(inputA);
    expect(store.enqueue("这不是一件活" as unknown as AnyInput)).toBeNull();
    expect(store.queue()).toHaveLength(1);
    expect(store.startNextQueued()?.taskId).toBe(A.id);
    dispose();
  });

  test("队列只在内存里：重启就没了（跨重启恢复是故意不做的）", async () => {
    installStorage();
    const first = await setup();
    first.store.enqueue(inputA);
    expect(first.store.queue()).toHaveLength(1);
    first.dispose();

    const second = mountStore();
    expect(second.store.queue()).toEqual([]);
    second.dispose();
  });
});

// ---------------------------------------------------------------------------
// #107 —— 夹具演不出、而且至今没人验的能力。
//
// 逐条决定写进了 CONTRACT.md 的「没人验的能力：逐条定论（#107）」。这一节把其中
// 「不接，但明确」的几条钉住：它们在 reducer 里被**有意**丢掉（store.ts 的
// IGNORED_EVENTS），不是悄悄没人管。真机 sweep 里 ExtensionRefreshed 真的出现过，
// 而简单界面既没有技能/命令入口、也没有终端位置，所以丢掉是对的；但「对」要能被
// 验证，否则下一个人只能靠读注释猜。
// ---------------------------------------------------------------------------
describe("有意忽略的事件（#107 的定论）", () => {
  /**
   * 往一个已经进入非默认状态的 store 里喂一个事件，断言它既不出行、也不改状态机、
   * 也不换会话——也就是「有意忽略」而不是「碰巧没反应」。
   */
  async function assertIgnored(name: string, payload: unknown): Promise<void> {
    const { store, dispose } = await setup();
    emit("event", event("TurnStart", { turn_id: "t1" }));
    const rowsBefore = store.rows().length;
    const sessionBefore = store.session();

    emit("event", event(name, payload));

    expect(store.rows().length, `${name} 不该出行`).toBe(rowsBefore);
    expect(store.session(), `${name} 不该换会话`).toBe(sessionBefore);
    assertInvariants(store);
    dispose();
  }

  test("ExtensionRefreshed：真机会发，但简单界面没有技能/命令入口", async () => {
    await assertIgnored("ExtensionRefreshed", {
      session_id: "ses_TEST",
      skills: [{ name: "simplify", description: "review the diff" }],
      subagents: [{ name: "researcher" }],
      mcp_servers: [{ name: "sheets", command: "cante-sheets", args: [], tools: [] }],
    });
  });

  test("ShellOutput：没有终端或命令行入口，命令原文不该进界面", async () => {
    await assertIgnored("ShellOutput", {
      command: "ls -la",
      stdout: "total 0\n",
      stderr: "",
      exit_code: 0,
    });
  });

  test("Ambient：没人去问，就没有位置摆这条建议", async () => {
    await assertIgnored("Ambient", {
      kind: "ThinkingPhrase",
      req_id: 1,
      text: "正在打开那几张表",
    });
  });

  test("起步时 skills 为空是允许的：刷新补齐不改变任何用户可见状态", async () => {
    // 真实守护进程可能先给一个空 skills 的 SessionStart，稍后再用
    // ExtensionRefreshed 补齐（#107）。这条锁定的是决定：简单界面根本不读 skills，
    // 所以「起步为空、后来补齐」对用户没有任何可见影响。
    const empty = { ...SESSION, skills: [] };
    const { store, dispose } = await setup([], empty);
    expect(store.session()?.skills).toEqual([]);

    emit("event", event("ExtensionRefreshed", {
      session_id: "ses_TEST",
      skills: [{ name: "simplify" }],
      subagents: [],
      mcp_servers: [],
    }));

    // 刷新事件不写回会话：简单界面认的还是那一份（空的）skills。
    expect(store.session()?.skills).toEqual([]);
    assertInvariants(store);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// 夹具驱动的关键界面状态：没有守护进程的机器（CI 就是）也要能跑。
//
// 上面那些用例把事件形状手写在测试里；这一节换成**真的把 `fixtures/fake-cante.ts`
// 跑起来**，把它吐出的 JSONL 事件原样喂进 store。这样「夹具能演什么」与「界面读它
// 读成什么样」就是同一份证据，而不是两份各自维护的假设。
// ---------------------------------------------------------------------------
describe("夹具驱动的关键界面状态（没有守护进程也能跑）", () => {
  const FAKE_CANTE = join(import.meta.dir, "../fixtures/fake-cante.ts");

  interface FakeCante {
    send(op: unknown): Promise<void>;
    /** Read frames up to and including the named event, returning all of them. */
    until(end: string): Promise<EventMsg[]>;
    close(): Promise<void>;
  }

  function startFakeCante(env: Record<string, string> = {}): FakeCante {
    const proc = Bun.spawn([process.execPath, FAKE_CANTE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const buffered: string[] = [];
    const waiters: Array<(line: string | null) => void> = [];
    let closed = false;

    void (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            if (!line.trim()) continue;
            const waiter = waiters.shift();
            if (waiter) waiter(line);
            else buffered.push(line);
          }
        }
      } finally {
        closed = true;
        for (const waiter of waiters.splice(0)) waiter(null);
      }
    })();

    async function nextLine(): Promise<string> {
      if (buffered.length > 0) return buffered.shift()!;
      if (closed) throw new Error("fake-cante closed stdout");
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fake-cante: timed out waiting for a line")), 5_000);
        waiters.push((line) => {
          clearTimeout(timer);
          if (line === null) reject(new Error("fake-cante closed stdout"));
          else resolve(line);
        });
      });
    }

    return {
      async send(op: unknown): Promise<void> {
        proc.stdin.write(JSON.stringify({ op, id: `op_FIXTURE${Math.random().toString(36).slice(2, 8)}` }) + "\n");
        await proc.stdin.flush();
      },
      async until(end: string): Promise<EventMsg[]> {
        const out: EventMsg[] = [];
        for (;;) {
          const frame = JSON.parse(await nextLine()) as EventMsg;
          out.push(frame);
          if (eventName(frame.event) === end) return out;
        }
      },
      async close(): Promise<void> {
        try {
          proc.kill();
        } catch {
          // already gone
        }
        await proc.exited;
      },
    };
  }

  function replay(store: Store, frames: EventMsg[]): void {
    for (const frame of frames) emit("event", frame);
  }

  test("一批两个工具：审批卡一次列出两条，各自翻译成中文动作", async () => {
    const { store, dispose } = await setup();
    const fake = startFakeCante({ FAKE_CANTE_APPROVAL_BATCH: "2" });
    try {
      await fake.send({ StartSession: {} });
      await fake.send({ UserInput: "整理这两份表格" });
      replay(store, await fake.until("TurnPause"));

      const approval = store.approval();
      expect(approval?.tools.map((tool) => tool.id)).toEqual(["tool_1", "tool_2"]);
      // 审批卡渲染的就是 describeApproval：两条都在，且都不是原始工具名。
      const described = describeApproval(approval!.tools);
      expect(described.map((tool) => tool.action)).toEqual(["运行一条命令", "写一个新文件"]);
      expect(store.rows().filter((row) => row.kind === "tool")).toHaveLength(2);
      assertInvariants(store);
    } finally {
      await fake.close();
      dispose();
    }
  });

  test("审批被拒：卡片收起，被拒的那条以警示色留在记录里，且没有出现过 ToolStart", async () => {
    const { store, dispose } = await setup();
    const fake = startFakeCante({ FAKE_CANTE_APPROVAL_BATCH: "2" });
    try {
      await fake.send({ StartSession: {} });
      await fake.send({ UserInput: "整理这两份表格" });
      replay(store, await fake.until("TurnPause"));
      expect(store.approval()?.tools).toHaveLength(2);

      await fake.send({
        ApprovalResponse: {
          turn_id: "turn_1",
          responses: [
            { tool_use_id: "tool_1", decision: "Deny" },
            { tool_use_id: "tool_2", decision: "Accept" },
          ],
        },
      });
      const after = await fake.until("TurnEnd");
      // 拒绝的效果：resume 之后守护进程没有再发 ToolStart（那一步从未开始）。
      expect(after.map((frame) => eventName(frame.event))).not.toContain("ToolStart");
      replay(store, after);

      expect(store.approval()).toBeNull();
      const toolRows = store.rows().filter((row) => row.kind === "tool");
      expect(toolRows.map((row) => [row.label, row.tone, row.streaming])).toEqual([
        ["Bash", "warn", false],
        ["Write", "ok", false],
      ]);
      assertInvariants(store);
    } finally {
      await fake.close();
      dispose();
    }
  });

  test("中途出错：Error 加非 Completed 的 TurnEnd 让失败记录拿到可核对的原因", async () => {
    const { store, dispose } = await setup();
    const fake = startFakeCante({ FAKE_CANTE_TURN_ERROR: "1" });
    try {
      await fake.send({ StartSession: {} });
      // 先让一件活跑起来：失败要落到运行记录上，出错页读的就是它。
      await store.startRun(
        { id: "excel.merge", title: "把两张表合成一张", plan: ["打开这两张表", "合成一张新表"] },
        ["/work/report.xlsx"],
        "把这两张表合成一张",
      );
      await store.confirmRun();

      await fake.send({ UserInput: "run the job" });
      replay(store, await fake.until("TurnEnd"));
      await Bun.sleep(30);

      expect(store.rows().some((row) => row.kind === "error" && row.text.includes("429"))).toBe(true);
      expect(store.rows().some((row) => row.kind === "turn" && row.label === "failed")).toBe(true);
      // TurnEnd 的结构化说明（headline）走到提示里，不是被吞掉。
      expect(store.notice()).toBe("rate limited");

      const run = store.currentRun();
      expect(run?.state).toBe("failed");
      const error = run?.error as { what: string; how: string; detail: string; cause?: string } | null;
      // 可核对的原因来自守护进程原话；给她看的两句仍是平实中文。
      expect(error?.cause).toContain("429");
      expect(error?.what).toBe("这件事没有做完。");
      expect(error?.what).not.toContain("429");
      expect(error?.how).toContain("原来的文件都还在");
      assertInvariants(store);
    } finally {
      await fake.close();
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// #140 — store 的 notice 原本只写不读。这一组把它四条活路径都跑一遍，断言
// 界面会拿到的就是那句中文（撤销成功与撤销失败必须是不同的话）。
// ---------------------------------------------------------------------------

describe("#140 notice 的四个写方在界面上都有话说", () => {
  test("撤销成功：notice 就是「已经放回去了：2 个文件恢复原样。」", async () => {
    undoReply = { restored: ["/work/a.xlsx", "/work/b.xlsx"], failed: [] };
    const { store, dispose } = await setup();
    try {
      await store.undoRun("run_1");
      expect(store.notice()).toBe("已经放回去了：2 个文件恢复原样。");
      const view = visibleNotice(store.notice(), UNDO_KINDS);
      expect(view?.kind).toBe("undo-ok");
      // 结果卡片上会出现的正是这一句。
      expect(view?.what).toBe("已经放回去了：2 个文件恢复原样。");
      expect(view?.how.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  test("撤销失败：notice 是「没能撤销。」，和成功那句不同（不谎称已撤回）", async () => {
    undoFails = true;
    const { store, dispose } = await setup();
    try {
      await store.undoRun("run_1");
      expect(store.notice()).toContain("没能撤销。");
      const view = visibleNotice(store.notice(), UNDO_KINDS);
      expect(view?.kind).toBe("undo-failed");
      expect(view?.what).toBe("没能撤销。");
      expect(view?.what).not.toContain("已经放回去");
      expect(view?.how).not.toBe(noticeView("已经放回去了：1 个文件恢复原样。")?.how);
    } finally {
      dispose();
    }
  });

  test("只放回去一部分：notice 说清还有几个要她自己动手", async () => {
    undoReply = { restored: ["/work/a.xlsx"], failed: ["/work/b.xlsx", "/work/c.xlsx"] };
    const { store, dispose } = await setup();
    try {
      await store.undoRun("run_1");
      expect(store.notice()).toContain("还有 2 个没能自动还原");
      const view = visibleNotice(store.notice(), UNDO_KINDS);
      expect(view?.kind).toBe("undo-partial");
      expect(view?.how.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  test("选文件窗口打不开：notice 有话说，而且告诉她还能怎么选", async () => {
    pickerFails = true;
    const { store, dispose } = await setup();
    try {
      expect(await store.pickFiles({ multiple: true })).toEqual([]);
      expect(store.notice()).toContain("打不开选择文件的窗口。");
      const view = visibleNotice(store.notice(), PICK_KINDS);
      expect(view?.kind).toBe("pick-files");
      expect(view?.what).toBe("打不开选择文件的窗口。");
      expect(view?.how).toContain("再点一次");
      expect(view?.how).toContain("拖");

      expect(await store.pickFolder()).toBeNull();
      expect(store.notice()).toContain("打不开选择文件夹的窗口。");
      expect(visibleNotice(store.notice(), PICK_KINDS)?.kind).toBe("pick-folder");
    } finally {
      dispose();
    }
  });

  test("窗口这次开起来了，上一次「打不开」的提示就退场", async () => {
    pickerFails = true;
    const { store, dispose } = await setup();
    try {
      await store.pickFiles();
      expect(store.notice()).toContain("打不开");
      pickerFails = false;
      await store.pickFiles();
      expect(store.notice()).toBeNull();
    } finally {
      dispose();
    }
  });

  test("换一件活来做，上一件留下的提示不跟过来", async () => {
    undoReply = { restored: ["/work/a.xlsx"], failed: [] };
    const { store, dispose } = await setup();
    try {
      await store.undoRun("run_1");
      expect(store.notice()).toContain("已经放回去了");
      await store.startRun(
        { id: "excel.merge", title: "把两张表合成一张", plan: ["打开这两张表"] },
        [],
        "合成一张",
      );
      expect(store.notice()).toBeNull();
    } finally {
      dispose();
    }
  });
});
