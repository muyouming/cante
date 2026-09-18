// 「她看到的那段文字」===「真正发出去的字节」——这条契约的机器挡板。
//
// 隐私面板对她承诺：「发出去的就是下面这段文字」（见 copy-privacy-audit.ts 的
// textGoes）。这句话只有在**面板展示的那串字符**和 **store 真正交给发送口的那串字符**
// 完全相同时才成立。真机上验过正常那条路（面板 DOM 的 textContent == app→bridge 管道里
// 的 UserInput == bridge→pi 的 prompt，三份 sha256 相同）；这个文件把同一条契约变成
// 每次 `bun test` 都会跑的东西，其中包含真机驱动没走过的两条变体：
//
//   * 普通确认        发出去的 = composedInstruction
//   * 试跑（#42）     发出去的 = composedInstruction + 试跑那一段
//   * 覆盖同意（#41） 发出去的 = composedInstruction + 同意覆盖那一段
//
// 后两条曾经是缺口：面板只展示 composedInstruction，而实际多发了一段 —— 面板会**少报**
// 真正发出去的字节。这里拿 `sentTextFor()`（面板用的那个函数）去对 `send_input` 真实
// 收到的文本，三态都必须逐字一致。`store.ts` 的拼装一旦改动，这个文件就红。
//
// 为什么单独一个文件：它要装一份 Tauri 假桥才能在进程里跑真 store，与 trust.test.ts 一样
// 通过查询串拿一份独立的模块实例，免得别处的 mock 串进来。
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "solid-js";

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const calls: Array<{ name: string; args: unknown }> = [];

function emit(channel: string, payload: unknown): void {
  for (const handler of handlers.get(channel) ?? []) handler(payload);
}

function record(name: string, args: unknown): void {
  calls.push({ name, args });
}

function opCalls(name: string): Array<unknown> {
  return calls.filter((call) => call.name === name).map((call) => call.args);
}

function register(channel: string, handler: Handler): () => void {
  const set = handlers.get(channel) ?? new Set<Handler>();
  set.add(handler);
  handlers.set(channel, set);
  return () => set.delete(handler);
}

function reset(): void {
  handlers.clear();
  calls.length = 0;
}

mock.module("../tauri.ts", () => ({
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
        return { cursor: 0, truncated: false, events: [], state: { status: "idle", session: null, pending_approval: null } };
      case "catalog":
        return { providers: [] };
      case "begin_run":
        return { entries: [], roots: ["/work"], unbacked: [], truncated: false };
      case "snapshot_paths":
        return { entries: [], roots: ["/work"], truncated: false };
      case "run_log":
        return { runs: [] };
      default:
        return { ok: true };
    }
  },
  onCanteEvent: async (handler: Handler) => register("event", handler),
  onCanteState: async (handler: Handler) => register("state", handler),
  onCanteLog: async (handler: Handler) => register("log", handler),
  onCanteExit: async (handler: Handler) => register("exit", handler),
}));

// A distinct module instance, so a second `bun test` file cannot hand this store
// the other file's Tauri mock (module mocks are process-wide).
const bytesStoreSpecifier = "../store.ts?privacy-bytes";
const { createStore } = (await import(bytesStoreSpecifier)) as typeof import("../store.ts");
type Store = ReturnType<typeof createStore>;

const { sentTextFor } = await import("./privacy.ts");

const TASK = { id: "excel.merge", title: "把几张表合成一张", plan: ["打开这几张表", "合成一张新表"] };
const FILES = ["/work/一.xlsx", "/work/二.xlsx"];
const SENTENCE = "把这两张表合成一张";

function mount(): { store: Store; dispose: () => void } {
  let store!: Store;
  let dispose!: () => void;
  createRoot((root) => {
    dispose = root;
    store = createStore();
  });
  return { store, dispose };
}

/** 面板会展示的那段文字（走 store 的 composedInstruction + run.ts 的两个后缀常量）。 */
function displayed(run: NonNullable<ReturnType<Store["currentRun"]>>, store: Store): string {
  return sentTextFor(run, store.composedInstruction(run));
}

/** 真正发出去的那段文字 —— 从假桥记录的 `send_input` 里读，不是我们另算的。 */
function actuallySent(): string {
  const sent = opCalls("send_input") as Array<{ text?: unknown }>;
  const last = sent.at(-1);
  return typeof last?.text === "string" ? last.text : "";
}

beforeEach(reset);

describe("面板展示的文字 === 真正发出去的字节", () => {
  test("普通确认：面板显示的就是发出去的那一份，逐字节一致", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, FILES, SENTENCE);
    const run = store.currentRun()!;
    const shown = displayed(run, store);
    await store.confirmRun();
    expect(actuallySent()).toBe(shown);
    dispose();
  });

  test("试跑（#42）：追加的那一段也算「发出去的」，面板不能少报", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, FILES, SENTENCE);
    await store.dryRun();
    const run = store.currentRun()!;
    // 真机没走过这条路：面板曾经只展示 composedInstruction，而实际多发了「试跑」那一段。
    expect(actuallySent()).toBe(displayed(run, store));
    expect(actuallySent()).toContain("这次只试跑");
    dispose();
  });

  test("覆盖同意（#41）：同意那一段也算「发出去的」，面板不能少报", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, FILES, SENTENCE);
    await store.confirmRun(true);
    const run = store.currentRun()!;
    expect(actuallySent()).toBe(displayed(run, store));
    expect(actuallySent()).toContain("用户已明确同意");
    dispose();
  });

  test("面板那段永远以真正发出去的那一段开头（base 不会被另拼一份顶替）", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, FILES, SENTENCE);
    const run = store.currentRun()!;
    const composed = store.composedInstruction(run);
    await store.confirmRun(true);
    // 真正发出去的 = composed + 追加段；面板展示的必须同源，不能是另写一份。
    expect(actuallySent().startsWith(composed)).toBe(true);
    expect(displayed(run, store).startsWith(composed)).toBe(true);
    dispose();
  });
});
