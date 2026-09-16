// #62 — tests for the "每一步都看得见" running progress.
//
// The screen's whole value is that it never lies about where the job is, so the
// tests below pin the two invariants that make that true:
//
//   * the cursor is monotonic — it never moves backwards; and
//   * a tool *guess* never skips a step, so an early temporary-file write
//     cannot teleport the user to the end of the plan.
//
// Everything here is pure: no Solid, no timers, no bridge.
import { describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";

import {
  explicitStep,
  explicitSteps,
  finishedSteps,
  formatElapsed,
  initialProgress,
  onAssistantText,
  onTool,
  progressSteps,
  progressView,
  toolKind,
  toolTarget,
  type Progress,
} from "./progress.ts";

/** A task's fixed plan, the way the confirmation sheet shows it. */
const PLAN = ["先逐张打开确认列名", "把所有行拼在一起", "另存为一个新文件", "告诉你结果在哪"];

describe("tool names -> read / write / run", () => {
  test("the three buckets", () => {
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("Glob")).toBe("read");
    expect(toolKind("Grep")).toBe("read");
    expect(toolKind("WebSearch")).toBe("read");

    expect(toolKind("Write")).toBe("write");
    expect(toolKind("Edit")).toBe("write");
    expect(toolKind("str_replace")).toBe("write");
    expect(toolKind("Delete")).toBe("write");

    expect(toolKind("Bash")).toBe("run");
    expect(toolKind("shell")).toBe("run");
    expect(toolKind("python")).toBe("run");
  });

  test("planning and unknown tools say nothing", () => {
    // A todo list is written at the very start; treating it as a file write
    // would move the highlight before any work happened.
    expect(toolKind("TodoWrite")).toBe("other");
    expect(toolKind("Task")).toBe("other");
    expect(toolKind("frobnicate")).toBe("other");
    expect(toolKind("")).toBe("other");
  });

  test("positions: reads at the front, writes at the back", () => {
    expect(toolTarget("read", 4)).toBe(0);
    expect(toolTarget("run", 4)).toBe(1);
    // One step before the end: the last plan step is "tell the user where the
    // result is", which is narration, not a file operation.
    expect(toolTarget("write", 4)).toBe(2);
    expect(toolTarget("other", 4)).toBeNull();
  });
});

describe("what the assistant says", () => {
  test("digits and Chinese numerals both count", () => {
    expect(explicitStep("现在做第 2 步：合并")).toBe(2);
    expect(explicitStep("步骤3：另存")).toBe(3);
    expect(explicitStep("接下来是第三步")).toBe(3);
    expect(explicitStep("没有编号")).toBeNull();
  });

  test("reciting the whole plan only confirms the first step", () => {
    const text = "我打算这么做：第 1 步读取，第 2 步合并，第 3 步另存，第 4 步告诉你。";
    expect(explicitSteps(text)).toEqual([1, 2, 3, 4]);
    expect(explicitStep(text)).toBe(1);
  });
});

describe("checklist states", () => {
  test("before anything moves, the first step is active", () => {
    expect(progressSteps(PLAN, initialProgress()).map((step) => step.state)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  test("everything before the cursor is done", () => {
    const steps = progressSteps(PLAN, { index: 2 });
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "active", "pending"]);
    expect(steps[2]!.text).toBe("另存为一个新文件");
  });

  test("a finished run ticks every step", () => {
    expect(finishedSteps(PLAN).map((step) => step.state)).toEqual(["done", "done", "done", "done"]);
  });
});

describe("the cursor never jumps and never goes back (#62)", () => {
  test("a single write moves one step, not to the end", () => {
    const cursor = onTool(initialProgress(), "Write", PLAN.length);
    // One write is a hint, not a confession. Jumping straight to the last step
    // would be the "user cannot follow where I am" failure the issue warns about.
    expect(cursor.index).toBe(1);
  });

  test("a late read never drags the highlight backwards", () => {
    let cursor: Progress = { index: 2 };
    cursor = onTool(cursor, "Read", PLAN.length);
    expect(cursor.index).toBe(2);
    cursor = onTool(cursor, "Glob", PLAN.length);
    expect(cursor.index).toBe(2);
  });

  test("an explicit marker jumps forward, but never backwards", () => {
    let cursor = onAssistantText(initialProgress(), "现在做第 3 步", PLAN.length);
    expect(cursor.index).toBe(2);
    cursor = onAssistantText(cursor, "回到第 1 步再看一眼", PLAN.length);
    expect(cursor.index).toBe(2);
  });

  test("a marker past the end clamps to the last step", () => {
    expect(onAssistantText(initialProgress(), "第 99 步", PLAN.length).index).toBe(PLAN.length - 1);
  });

  test("tool guesses never skip a step", () => {
    const names = ["Read", "Bash", "Write", "Edit", "Write", "todo_write", "Write"];
    let cursor = initialProgress();
    for (const name of names) {
      const next = onTool(cursor, name, PLAN.length);
      expect(next.index).toBeGreaterThanOrEqual(cursor.index);
      expect(next.index - cursor.index).toBeLessThanOrEqual(1);
      expect(next.index).toBeLessThan(PLAN.length);
      cursor = next;
    }
    // Repeated writes walk to the save step and stop there: the final "tell you
    // where" step is narration, so only an explicit marker (or the run
    // finishing) puts the highlight on it.
    expect(cursor.index).toBe(PLAN.length - 2);
  });

  test("no sequence of signals can move the cursor backwards or out of range", () => {
    const signals: Array<(cursor: Progress) => Progress> = [
      (cursor) => onTool(cursor, "Read", PLAN.length),
      (cursor) => onTool(cursor, "Bash", PLAN.length),
      (cursor) => onTool(cursor, "Write", PLAN.length),
      (cursor) => onTool(cursor, "Edit", PLAN.length),
      (cursor) => onTool(cursor, "TodoWrite", PLAN.length),
      (cursor) => onTool(cursor, "frobnicate", PLAN.length),
      (cursor) => onAssistantText(cursor, "第 1 步做完了", PLAN.length),
      (cursor) => onAssistantText(cursor, "现在做第 2 步", PLAN.length),
      (cursor) => onAssistantText(cursor, "第 4 步", PLAN.length),
    ];
    // A tiny deterministic PRNG keeps the failure reproducible.
    let seed = 12_345;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let cursor = initialProgress();
    for (let i = 0; i < 5_000; i += 1) {
      const before = cursor.index;
      cursor = signals[Math.floor(rand() * signals.length)]!(cursor);
      expect(cursor.index).toBeGreaterThanOrEqual(before);
      expect(cursor.index).toBeLessThan(PLAN.length);
    }
  });
});

describe("the view the running screen reads", () => {
  test("while running, the clock runs and the steps are live", () => {
    const view = progressView({
      plan: PLAN,
      cursor: { index: 1 },
      running: true,
      finished: false,
      startedAt: 1_000,
      now: 4_000,
      elapsedMs: 0,
    });
    expect(view.elapsedMs).toBe(3_000);
    expect(view.startedAt).toBe(1_000);
    expect(view.steps.map((step) => step.state)).toEqual(["done", "active", "pending", "pending"]);
  });

  test("once the run ends, every step is done and the clock is frozen", () => {
    const view = progressView({
      plan: PLAN,
      cursor: { index: 1 },
      running: false,
      finished: true,
      startedAt: 1_000,
      now: 90_000,
      elapsedMs: 5_000,
    });
    expect(view.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done"]);
    expect(view.elapsedMs).toBe(5_000);
  });

  test("no run and no plan is an empty, quiet view", () => {
    expect(
      progressView({
        plan: [],
        cursor: initialProgress(),
        running: false,
        finished: false,
        startedAt: null,
        now: 0,
        elapsedMs: 0,
      }),
    ).toEqual({ steps: [], startedAt: null, elapsedMs: 0 });
  });
});

describe("elapsed copy", () => {
  test("seconds, minutes and hours all carry a unit", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(1_200)).toBe("1 秒");
    expect(formatElapsed(65_000)).toBe("1 分 05 秒");
    expect(formatElapsed(3 * 3_600_000 + 2 * 60_000)).toBe("3 小时 02 分");
  });
});

// ---------------------------------------------------------------------------
// The store owns the clock and the cursor; `progress.ts` owns the logic. The
// wiring is thin, but it is what the running screen actually reads, so it gets
// one real test with a faked bridge.
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;
const eventHandlers = new Set<Handler>();

mock.module("../tauri.ts", () => ({
  BridgeUnavailable: class BridgeUnavailable extends Error {},
  CommandRejected: class CommandRejected extends Error {},
  errorText: (error: unknown) => (error instanceof Error ? error.message : "error"),
  isBridgeAvailable: () => true,
  invoke: async (name: string) => {
    switch (name) {
      case "health":
        return { ok: true, cante: "cante test", cwd: "/tmp/workspace", daemon: true, status: "idle" };
      case "events_since":
        return {
          cursor: 0,
          truncated: false,
          events: [],
          state: { status: "idle", session: null, pending_approval: null },
        };
      case "catalog":
        return { providers: [] };
      case "begin_run":
        return { entries: [], roots: [], unbacked: [] };
      case "snapshot_paths":
        return { entries: [] };
      case "run_log":
        return { runs: [] };
      default:
        return { ok: true };
    }
  },
  onCanteEvent: async (handler: Handler) => {
    eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  },
  onCanteState: async () => () => {},
  onCanteLog: async () => () => {},
  onCanteExit: async () => () => {},
}));

// A distinct module instance (see trust.test.ts): module mocks are
// process-wide, so the query string keeps this file's store to itself.
const storeSpecifier = "../store.ts?progress";
const { createStore } = (await import(storeSpecifier)) as typeof import("../store.ts");

function emitEvent(name: string, payload: unknown): void {
  const message = {
    timestamp: "2026-01-01T00:00:00Z",
    id: `evt_${Math.random().toString(36).slice(2)}`,
    event: { [name]: payload },
  };
  for (const handler of eventHandlers) handler(message);
}

describe("the store wires the checklist to the run", () => {
  test("empty, then running with a live clock, then all done", async () => {
    let store!: ReturnType<typeof createStore>;
    let dispose!: () => void;
    createRoot((root) => {
      dispose = root;
      store = createStore();
    });
    store.connect();
    await Bun.sleep(15);

    expect(store.progress()).toEqual({ steps: [], startedAt: null, elapsedMs: 0 });

    await store.startRun(
      { id: "excel.merge", title: "合并表格", plan: PLAN.slice(0, 3) },
      ["/work/一.xlsx"],
      "合并",
    );
    expect(store.currentRun()?.state).toBe("preview");
    expect(store.progress().startedAt).toBeNull();
    expect(store.progress().steps.map((step) => step.state)).toEqual([
      "active",
      "pending",
      "pending",
    ]);

    await store.confirmRun();
    expect(store.currentRun()?.state).toBe("running");
    expect(store.progress().startedAt).not.toBeNull();
    expect(store.progress().elapsedMs).toBeGreaterThanOrEqual(0);

    // A finished assistant message that names the third step advances the list
    // straight to it — the model is the authoritative signal.
    emitEvent("AgentMessage", "现在做第 3 步：另存为新文件");
    expect(store.progress().steps.map((step) => step.state)).toEqual(["done", "done", "active"]);

    store.cancelRun();
    await Bun.sleep(20);
    expect(store.currentRun()?.state).toBe("cancelled");
    expect(store.progress().steps.map((step) => step.state)).toEqual(["done", "done", "done"]);
    dispose();
  });
});
