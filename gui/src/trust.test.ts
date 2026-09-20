// Store-level tests for the file-and-trust flow (#41–#43): the confirmation
// gate, the before/after snapshot diff that fills `impact`, the run log and
// undo. The Tauri bridge is faked the same way `store.test.ts` fakes it, so a
// shape drift in either direction fails here instead of at runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";

import type { EventMsg } from "./protocol.ts";
import { evidenceFor } from "./simple/evidence.ts";

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
const calls: Array<{ name: string; args: unknown }> = [];
let beforeEntries: unknown[] = [];
let afterEntries: unknown[] = [];
// 当某个用例把它指到一个**真实临时目录**时，桥的 begin_run / snapshot_paths
// 会去真扫这个目录（见 scanReal），于是 store 的前后对比算的是**磁盘上的字节**，
// 而不是某个变量里预先写好的数组。
let realDir: string | null = null;
// 真实快照会把要动的文件**复制**到应用自己的私有目录（桥那一层的契约）。
// 指一个真目录时，这个桩会真的去复制：于是"原件没被改"与"备的是副本不是搬走"
// 都能在真实字节上核。
let realBackupDir: string | null = null;
let runRecords: unknown[] = [];
let undoReply: { restored: string[]; failed: string[] } = { restored: [], failed: [] };
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
  beforeEntries = [];
  afterEntries = [];
  realDir = null;
  realBackupDir = null;
  runRecords = [];
  undoReply = { restored: [], failed: [] };
  hydration = {
    cursor: 0,
    truncated: false,
    events: [],
    state: { status: "idle", session: null, pending_approval: null },
  };
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
        return { providers: [] };
      case "begin_run":
        // 真目录在的时候，答案来自一次真实磁盘扫描：store 的前后对比就建立在
        // 真文件的字节上（size / mtime / 行数）。同时按桥的契约把要动的文件
        // **复制**进私有备份目录（真是复制，不是搬走）。
        if (realDir) {
          const entries = scanReal(realDir);
          if (realBackupDir) copyAll(realDir, realBackupDir);
          return { entries, roots: [realDir], unbacked: [], truncated: false };
        }
        return { entries: beforeEntries, roots: ["/work"], unbacked: [], truncated: false };
      case "snapshot_paths":
        if (realDir) return { entries: scanReal(realDir), roots: [realDir], truncated: false };
        return { entries: afterEntries, roots: ["/work"], truncated: false };
      case "run_log":
        return { runs: runRecords };
      case "save_run": {
        const saved = (args as { run?: unknown } | undefined)?.run;
        if (saved) runRecords = [saved, ...runRecords.filter((item) => (item as { id?: string }).id !== (saved as { id?: string }).id)];
        return { ok: true };
      }
      case "pick_files":
        return { paths: ["/work/一.xlsx", "/work/二.xlsx"] };
      case "pick_folder":
        return { path: "/work/资料" };
      case "undo_run":
        return { ok: true, ...undoReply };
      default:
        return { ok: true };
    }
  },
  onCanteEvent: async (handler: Handler) => register("event", handler),
  onCanteState: async (handler: Handler) => register("state", handler),
  onCanteLog: async (handler: Handler) => register("log", handler),
  onCanteExit: async (handler: Handler) => register("exit", handler),
}));

// A distinct module instance for this file, so a second `bun test` file cannot
// hand this store the *other* file's Tauri mock (module mocks are process-wide).
// The specifier is held in a variable so TypeScript does not try to resolve the
// cache-busting query string.
const trustStoreSpecifier = "./store.ts?trust";
const { createStore } = (await import(trustStoreSpecifier)) as typeof import("./store.ts");
type Store = ReturnType<typeof createStore>;

async function setup() {
  hydration = {
    cursor: 0,
    truncated: false,
    events: [],
    state: { status: "idle", session: null, pending_approval: null },
  };
  let store!: Store;
  let dispose!: () => void;
  createRoot((root) => {
    dispose = root;
    store = createStore();
  });
  store.connect();
  await Bun.sleep(15);
  return { store, dispose };
}

// ---- 真实文件系统上的指纹与扫描 --------------------------------------------

/**
 * A byte-level fingerprint of a whole directory tree: every entry as a line
 * (`d <path>` for a directory; `f <path> <size> <sha256>` for a file), sorted.
 * Two fingerprints are equal only when the tree has the exact same shape and
 * every file is byte-for-byte identical. This is the assertion the dry-run
 * promise rests on — nothing here compares one variable to another.
 */
function treeFingerprint(root: string): string[] {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stats = statSync(join(root, childRel));
      if (stats.isDirectory()) {
        lines.push(`d ${childRel}`);
        walk(childRel);
      } else {
        const hash = createHash("sha256").update(readFileSync(join(root, childRel))).digest("hex");
        lines.push(`f ${childRel} ${stats.size} ${hash}`);
      }
    }
  };
  walk("");
  return lines.sort();
}

// The same text extensions the Rust scanner counts lines for (files.rs).
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "html", "htm",
  "yaml", "yml", "ini", "toml", "srt", "vtt", "rs", "ts", "tsx", "js", "jsx", "py", "css", "sql",
]);

/**
 * A stand-in for the Rust `begin_run` / `snapshot_paths` scan, reading real
 * files. It is deliberately small and faithful enough for the diff's inputs
 * (path / size / mtime / line count); it is **not** the product's scanner, so
 * anything that depends on the scanner's exact behavior belongs in
 * `src-tauri/tests/files.rs`. Its only job here is to feed the store facts from
 * disk instead of from a hand-written array.
 */
function scanReal(root: string): Array<{ path: string; size: number; mtime_ms: number; lines: number | null }> {
  const out: Array<{ path: string; size: number; mtime_ms: number; lines: number | null }> = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stats = statSync(join(root, childRel));
      if (stats.isDirectory()) {
        walk(childRel);
        continue;
      }
      out.push({
        path: `${root}/${childRel}`.replaceAll("\\", "/"),
        size: stats.size,
        mtime_ms: Math.floor(stats.mtimeMs),
        lines: countTextLines(join(root, childRel), childRel),
      });
    }
  };
  walk("");
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function countTextLines(abs: string, rel: string): number | null {
  const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!TEXT_EXTS.has(ext)) return null;
  const bytes = readFileSync(abs);
  if (bytes.length === 0) return 0;
  let newlines = 0;
  for (const byte of bytes) if (byte === 0x0a) newlines += 1;
  return bytes[bytes.length - 1] === 0x0a ? newlines : newlines + 1;
}

/** Copy every regular file under `root` into `dest`, recreating subfolders. */
function copyAll(root: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const walk = (rel: string): void => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const stats = statSync(join(root, childRel));
      if (stats.isDirectory()) {
        mkdirSync(join(dest, childRel), { recursive: true });
        walk(childRel);
      } else {
        writeFileSync(join(dest, childRel), readFileSync(join(root, childRel)));
      }
    }
  };
  walk("");
}

function event(name: string, payload: unknown): EventMsg {
  return { timestamp: "2026-01-01T00:00:00Z", id: `evt_${Math.random().toString(36).slice(2)}`, event: { [name]: payload } };
}

const TASK = { id: "excel.merge", title: "把几张表合成一张", plan: ["打开这几张表", "合成一张新表"] };

beforeEach(reset);

describe("pickers and opening files", () => {
  test("pickFiles returns the chosen paths and passes the filter through", async () => {
    const { store } = await setup();
    const picked = await store.pickFiles({ multiple: true, extensions: ["xlsx"] });
    expect(picked).toEqual(["/work/一.xlsx", "/work/二.xlsx"]);
    expect(opCalls("pick_files")).toEqual([{ multiple: true, extensions: ["xlsx"] }]);
  });

  test("pickFolder returns the folder or null on cancel", async () => {
    const { store } = await setup();
    expect(await store.pickFolder()).toBe("/work/资料");
  });

  test("openPath and revealPath reach the system opener", async () => {
    const { store } = await setup();
    await store.openPath("/work/结果.xlsx");
    await store.revealPath("/work/结果.xlsx");
    expect(opCalls("open_path")).toEqual([{ path: "/work/结果.xlsx" }]);
    expect(opCalls("reveal_path")).toEqual([{ path: "/work/结果.xlsx" }]);
  });
});

describe("confirmation gate", () => {
  test("startRun only stages a preview; nothing is sent", async () => {
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这些表合起来");
    const run = store.currentRun();
    expect(run?.state).toBe("preview");
    expect(run?.taskTitle).toBe("把几张表合成一张");
    expect(run?.plan).toEqual(TASK.plan);
    expect(run?.impact).toEqual({ created: 0, modified: 0, deleted: 0, messages: 0 });
    expect(opCalls("begin_run")).toEqual([]);
    expect(opCalls("send_input")).toEqual([]);
  });

  test("cancelRun drops a preview without touching anything", async () => {
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这些表合起来");
    store.cancelRun();
    expect(store.currentRun()).toBeNull();
    expect(opCalls("send_input")).toEqual([]);
  });

  test("confirmRun snapshots first, then sends the instruction", async () => {
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这些表合起来");
    beforeEntries = [{ path: "/work/a.xlsx", size: 10, mtime_ms: 100, lines: 5 }];
    await store.confirmRun();
    expect(store.currentRun()?.state).toBe("running");
    const begin = opCalls("begin_run")[0] as { id: string; paths: string[] };
    expect(begin.paths).toEqual(["/work/a.xlsx"]);
    expect(typeof begin.id).toBe("string");
    // 发出去的必须是**卡片提示词 + 她那一句话**：卡片里的安全规矩（原文件只读、
    // 结果另存）全在提示词里，而这条线曾经断过——只发她那一句话，规矩到不了助手。
    const sent = opCalls("send_input")[0] as { text: string; mode: string };
    expect(sent.mode).toBe("prompt");
    expect(sent.text).toContain("把这些表合起来");
    expect(sent.text).toContain("原来的文件一张都不要改");
    expect(sent.text.length).toBeGreaterThan(200);
  });

  test("the red overwrite checkbox is the only way consent is appended", async () => {
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这些表合起来");
    await store.confirmRun(true);
    const sent = opCalls("send_input")[0] as { text: string };
    expect(sent.text).toContain("用户已明确同意");
    expect(store.currentRun()?.overwrite).toBe(true);
  });

  test("dryRun sends the look-but-do-not-touch instruction", async () => {
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这些表合起来");
    await store.dryRun();
    const sent = opCalls("send_input")[0] as { text: string };
    // #192 A：从点「先给我看一眼」到真正发出去的字节，这条链要能一眼核完。
    // 发出去的那段必须把四种写动作一个个封死，而且**不许**出现覆盖同意——
    // 那是唯一允许改原文件的开关，试跑这条路不该带上它。
    for (const verb of ["新建", "修改", "删除", "移动"]) {
      expect(sent.text).toContain(verb);
    }
    expect(sent.text).toContain("只试跑");
    expect(sent.text).not.toContain("用户已明确同意");
    expect(store.currentRun()?.dryRun).toBe(true);
    // 落盘的动作只有「动手前拍一份快照」和「把那句话说出去」两类；试跑不会
    // 触发任何写文件/撤销/覆盖的命令。
    const names = calls.map((call) => call.name);
    expect(names).not.toContain("undo_run");
    expect(names).not.toContain("open_path");
    expect(names).not.toContain("reveal_path");
    expect(names.filter((name) => name === "send_input")).toHaveLength(1);
    // 拍快照只是把要动的文件复制进应用自己的私有备份目录，原文件只读不改。
    expect(names).toContain("begin_run");
  });

  test("先看一眼跑完：原文件一字未动 —— 真目录、真字节，不是拿变量比变量", async () => {
    // #192 A 的核心事实。「先给我看一眼」这条路的全部意义就是：跑完以后原文件
    // 一个字都没变、也没多出文件、没少文件。
    //
    // 旧写法把 `afterEntries = beforeEntries` 直接写死，然后断言 impact 是 0——
    // 那验的是桩行为和 dryRun 标志，**不是文件真没动**。这里改成：先在一个真实
    // 临时目录里放真实文件，记下整棵树的逐文件 sha256 指纹；走完 store 的
    // 「确认页 → 试跑 → 回合结束」，再读一次磁盘，断言指纹逐字节一致。
    const dir = mkdtempSync(join(tmpdir(), "cante-trust-"));
    const backup = mkdtempSync(join(tmpdir(), "cante-trust-backup-"));
    try {
      writeFileSync(join(dir, "一.xlsx"), "区域,金额\n华东,1200\n");
      writeFileSync(join(dir, "二.xlsx"), "备注\n原件不要改\n");
      mkdirSync(join(dir, "资料"));
      writeFileSync(join(dir, "资料", "说明.txt"), "这是原件的说明\n");
      realDir = dir;
      realBackupDir = backup;

      const before = treeFingerprint(dir);
      // 指纹本身不是空的：空目录会让上面那句断言变成一句空话。
      expect(before.filter((line) => line.startsWith("f ")).length).toBe(3);

      const { store } = await setup();
      await store.startRun(TASK, [join(dir, "一.xlsx"), join(dir, "二.xlsx")], "把这些表合起来");
      await store.dryRun();
      emit("event", event("TurnEnd", { status: "Completed", steps: 2 }));
      await Bun.sleep(20);

      const run = store.currentRun();
      expect(run?.state).toBe("done");
      expect(run?.dryRun).toBe(true);
      // 真检查：跑完后再读一次磁盘，和跑之前**逐文件、逐字节**比。
      const after = treeFingerprint(dir);
      expect(after).toEqual(before);
      // 快照备的是**副本**：私有备份目录里确实出现了一份逐字节相同的拷贝。
      // 指纹用的是相对路径，所以两份应该完全相等。如果桥那一层把"复制"写成
      // "搬走"，这里就会红（原件指纹也会先红）。
      expect(treeFingerprint(backup)).toEqual(before);
      // 没有新增 / 修改 / 删除：原来那两个文件就长这样。
      expect(run?.impact).toEqual({ created: 0, modified: 0, deleted: 0, messages: 0 });
      // 结果里一个"产出文件"都没有。
      expect(run?.result?.files).toEqual([]);
      expect(run?.result?.summary).toContain("没有改动任何文件");
      // 记到磁盘上的那份也一样：undo 里没有任何要回滚的东西。
      // r9 之后开始做时也会先落一次盘，所以这里要看**最后那次**（结束那次），
      // 否则断言的是开始那条 running（它的 undo 本来就空，会形同虚设）。
      const saved = opCalls("save_run").at(-1) as { run: { state: string; undo: { created: string[]; modified: string[]; deleted: string[] } } };
      expect(saved.run.state).toBe("done");
      expect(saved.run.undo.created).toEqual([]);
      expect(saved.run.undo.modified).toEqual([]);
      expect(saved.run.undo.deleted).toEqual([]);
      // 试跑不算"真做过这件事"：结果卡上「在这台电脑上做过 N 次」只数真跑，
      // 否则一次只看不动的试跑会虚报成成功记录。
      expect(evidenceFor(store.runs(), TASK.id)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
    }
  });

  test("这条真检查不是空的：原文件改一个字节，指纹就变（否则上面那句断言形同虚设）", () => {
    // 反面对照。如果指纹函数永远返回同一个值，上面那条「一字未动」的断言就
    // 抓不到任何东西。这里故意改一个字节 + 增删文件，证明它能红。
    const dir = mkdtempSync(join(tmpdir(), "cante-trust-sense-"));
    try {
      const file = join(dir, "一.txt");
      writeFileSync(file, "原件\n");
      const before = treeFingerprint(dir);
      writeFileSync(file, "原件!\n");
      expect(treeFingerprint(dir)).not.toEqual(before);
      // 内容相同、只是 mtime 变了的"触碰"，字节指纹如实说"没变"（指纹只认内容
      // 与目录形状，这正是"原文件一字未动"要问的问题）。
      const same = treeFingerprint(dir);
      writeFileSync(file, "原件!\n");
      expect(treeFingerprint(dir)).toEqual(same);
      // 多出一个文件、少掉一个文件，都要能被看见。
      writeFileSync(join(dir, "新.txt"), "new\n");
      expect(treeFingerprint(dir)).not.toEqual(same);
      rmSync(join(dir, "新.txt"));
      expect(treeFingerprint(dir)).toEqual(same);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finish, impact and undo", () => {
  test("a completed turn diffs the snapshots and stores the run", async () => {
    beforeEntries = [
      { path: "/work/a.xlsx", size: 100, mtime_ms: 100, lines: 20 },
      { path: "/work/b.xlsx", size: 100, mtime_ms: 100, lines: 20 },
    ];
    afterEntries = [
      { path: "/work/a.xlsx", size: 100, mtime_ms: 100, lines: 20 },
      { path: "/work/b.xlsx", size: 80, mtime_ms: 200, lines: 18 },
      { path: "/work/新表.xlsx", size: 50, mtime_ms: 200, lines: 10 },
    ];

    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx", "/work/b.xlsx"], "合并");
    await store.confirmRun();
    emit("event", event("TurnEnd", { status: "Completed", steps: 3 }));
    await Bun.sleep(20);

    const run = store.currentRun();
    expect(run?.state).toBe("done");
    expect(run?.impact).toEqual({ created: 1, modified: 1, deleted: 0, messages: 0 });
    expect(run?.result?.files.map((file) => file.path)).toEqual(["/work/新表.xlsx", "/work/b.xlsx"]);
    expect(run?.result?.summary).toContain("新增 1 个文件");

    // The record persisted to disk carries the undo metadata.
    // r9 之后开始做时也会先落一次盘，所以要看**最后那次**（结束那次）；断言它的
    // state 是 done，才能证明「带 undo 元数据的正是结束那条」，而不是开始那条空壳。
    const saved = opCalls("save_run").at(-1) as { run: { id: string; state: string; undo: { created: string[]; roots: string[] } } };
    expect(saved.run.state).toBe("done");
    expect(saved.run.id).toBe(run?.id ?? "");
    expect(saved.run.undo.created).toEqual(["/work/新表.xlsx"]);
    expect(saved.run.undo.roots).toEqual(["/work"]);
    // And it is in the in-memory history immediately.
    expect(store.runs().some((item) => item.id === run?.id)).toBe(true);
  });

  test("a failed turn keeps the Chinese error and no result when nothing changed", async () => {
    beforeEntries = [{ path: "/work/a.xlsx", size: 10, mtime_ms: 100, lines: 5 }];
    afterEntries = beforeEntries;
    const { store } = await setup();
    await store.startRun(TASK, ["/work/a.xlsx"], "合并");
    await store.confirmRun();
    emit("event", event("TurnEnd", { status: { Error: { headline: "表打不开", details: ["坏掉了"] } } }));
    await Bun.sleep(20);
    const run = store.currentRun();
    expect(run?.state).toBe("failed");
    expect(run?.error?.what.length).toBeGreaterThan(0);
    expect(run?.error?.how).toContain("原来的文件都还在");
    expect(run?.result).toBeNull();
  });

  test("undoRun reports what came back", async () => {
    undoReply = { restored: ["/work/新表.xlsx"], failed: [] };
    runRecords = [{ id: "run_x", taskId: "excel.merge", taskTitle: "合并", createdAt: 1, impact: { created: 1, modified: 0, deleted: 0, messages: 0 } }];
    const { store } = await setup();
    await store.refreshRuns();
    expect(store.runs().length).toBe(1);
    await store.undoRun("run_x");
    expect(opCalls("undo_run")).toEqual([{ id: "run_x" }]);
    expect(store.notice()).toContain("已经放回去了");
  });

  test("refreshRuns keeps newest first and ignores malformed records", async () => {
    runRecords = [
      { id: "old", createdAt: 1, taskTitle: "旧" },
      { id: "", createdAt: 2 },
      { id: "new", createdAt: 9, taskTitle: "新" },
    ];
    const { store } = await setup();
    await store.refreshRuns();
    expect(store.runs().map((run) => run.id)).toEqual(["new", "old"]);
  });
});
