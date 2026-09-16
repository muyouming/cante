// File-safety logic for simple mode: snapshots, diffs and plain-Chinese copy.
//
// Simple mode cannot promise "your originals are safe" unless it can *see*
// what a job did. The Rust side (`src-tauri/src/files.rs`) takes a metadata
// snapshot of the folders a job involves — relative path, size, modification
// time, and a line count for text files — before and after the job. This module
// is the pure half: diff the two snapshots, count the impact, and turn all of
// it into sentences a non-technical user can read.
//
// Everything here is framework-free and side-effect-free so `bun test` can pin
// the arithmetic and the wording without a browser or a daemon.

/** One file as the Rust snapshot reports it (normalized to camelCase). */
export interface SnapshotEntry {
  path: string;
  size: number;
  mtimeMs: number;
  lines: number | null;
}

/** The raw snake_case shape `snapshot_paths` / `begin_run` return. */
interface WireEntry {
  path?: unknown;
  size?: unknown;
  mtime_ms?: unknown;
  lines?: unknown;
}

export interface SnapshotDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

export interface RunImpact {
  created: number;
  modified: number;
  deleted: number;
  messages: number;
}

export interface RunResultFile {
  path: string;
  summary: string;
}

export interface RunResult {
  files: RunResultFile[];
  summary: string;
}

/** The three things #42 insists get a red warning when a plan touches them. */
export type RiskKind = "delete" | "overwrite" | "messages";

export interface PlanRisk {
  kind: RiskKind;
  label: string;
  /** Shown whether or not the plan triggers it, so the user learns the rule. */
  detail: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot normalization and diffing
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** Tolerate a hostile/short wire entry: keep only a usable path. */
export function normalizeEntries(input: unknown): SnapshotEntry[] {
  if (!Array.isArray(input)) return [];
  const entries: SnapshotEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as WireEntry;
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) continue;
    const lines = entry.lines;
    entries.push({
      path,
      size: Math.max(0, finiteNumber(entry.size, 0)),
      mtimeMs: finiteNumber(entry.mtime_ms, -1),
      lines: typeof lines === "number" && Number.isFinite(lines) ? lines : null,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function changed(before: SnapshotEntry, after: SnapshotEntry): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.lines !== after.lines;
}

/**
 * Before/after comparison. A file counts as changed when its size, modification
 * time or line count moved; counting a mere touch as changed is the safe
 * direction — undo then restores a file that was already identical.
 */
export function diffSnapshots(before: SnapshotEntry[], after: SnapshotEntry[]): SnapshotDiff {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const now = new Map(after.map((entry) => [entry.path, entry]));
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, entry] of now) {
    const previous = old.get(path);
    if (!previous) created.push(path);
    else if (changed(previous, entry)) modified.push(path);
  }
  for (const path of old.keys()) {
    if (!now.has(path)) deleted.push(path);
  }
  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

export function emptyImpact(): RunImpact {
  return { created: 0, modified: 0, deleted: 0, messages: 0 };
}

/** #41 — messages are always 0: this product never sends on the user's behalf. */
export function impactOf(diff: SnapshotDiff): RunImpact {
  return {
    created: diff.created.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
    messages: 0,
  };
}

// ---------------------------------------------------------------------------
// Paths and sizes
// ---------------------------------------------------------------------------

/** Both separators: the daemon may hand back a Windows path. */
export function fileName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

export function folderName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 字节";
  if (bytes < 1024) return `${Math.round(bytes)} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function lineChange(before: SnapshotEntry | undefined, after: SnapshotEntry): string | null {
  if (after.lines === null) return null;
  if (!before || before.lines === null || before.lines === undefined) {
    return `${after.lines} 行`;
  }
  if (before.lines === after.lines) return `${after.lines} 行（行数不变）`;
  const delta = after.lines - before.lines;
  const direction = delta > 0 ? `增加 ${delta} 行` : `减少 ${-delta} 行`;
  return `${before.lines} 行 → ${after.lines} 行（${direction}）`;
}

// ---------------------------------------------------------------------------
// Result copy
// ---------------------------------------------------------------------------

/** One short sentence for the impact row on the confirmation sheet. */
export function describeImpact(impact: RunImpact): string {
  return [
    `新增 ${impact.created} 个文件`,
    `修改 ${impact.modified} 个`,
    `删除 ${impact.deleted} 个`,
    `发消息 ${impact.messages} 条`,
  ].join("，");
}

const UNSET = "没有改动任何文件";

/**
 * Turn a diff into the result card's data. Only created and modified files are
 * listed as results; a deletion is not a "result", it is a problem, and it is
 * reported in the summary instead.
 */
export function buildResult(
  before: SnapshotEntry[],
  after: SnapshotEntry[],
  diff: SnapshotDiff,
  options: { dryRun?: boolean } = {},
): RunResult {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const now = new Map(after.map((entry) => [entry.path, entry]));
  const files: RunResultFile[] = [];

  for (const path of diff.created) {
    const entry = now.get(path);
    files.push({ path, summary: `新增 · ${formatSize(entry?.size ?? 0)}` });
  }
  for (const path of diff.modified) {
    const entry = now.get(path);
    const previous = old.get(path);
    const parts: string[] = [];
    if (previous) parts.push(`${formatSize(previous.size)} → ${formatSize(entry?.size ?? 0)}`);
    const lines = entry ? lineChange(previous, entry) : null;
    if (lines) parts.push(lines);
    files.push({ path, summary: parts.length > 0 ? parts.join(" · ") : "已更新" });
  }

  const parts: string[] = [];
  if (diff.created.length > 0) parts.push(`新增 ${diff.created.length} 个文件`);
  if (diff.modified.length > 0) parts.push(`修改 ${diff.modified.length} 个文件`);
  if (diff.deleted.length > 0) parts.push(`减少了 ${diff.deleted.length} 个文件`);
  let summary = parts.length > 0 ? parts.join("，") : UNSET;
  if (options.dryRun) summary = `试跑完成，${summary}`;
  return { files, summary };
}

// ---------------------------------------------------------------------------
// #42 — risks, so the confirmation sheet can put them in red
// ---------------------------------------------------------------------------

const RISK_RULES: ReadonlyArray<{ kind: RiskKind; label: string; detail: string; needles: string[] }> = [
  {
    kind: "delete",
    label: "删除文件",
    detail: "这次不会删除你的任何文件。",
    needles: ["删除", "删掉", "移除", "清空", "清理掉"],
  },
  {
    kind: "overwrite",
    label: "覆盖原文件",
    detail: "结果一律另存为新文件，原文件只读不改。",
    needles: ["覆盖", "替换原", "原位修改", "就地修改", "改写原"],
  },
  {
    kind: "messages",
    label: "批量发消息",
    detail: "不会自动发消息，只整理成草稿，发送由你自己来。",
    needles: ["发送", "群发", "发消息", "自动回复"],
  },
];

/**
 * Lines that mention a risky word but are actually promises *not* to do it, or
 * that merely compare/report on it. The task catalogue's own plans use exactly
 * these phrasings (“绝不覆盖”, “找出新增、删除、改动过的记录”, “只整理成草稿”),
 * and crying wolf on a safe plan would train the user to ignore the red banner.
 */
const SAFE_MARKERS: readonly string[] = [
  "不动",
  "不变",
  "不删",
  "不覆盖",
  "绝不",
  "不会",
  "不要",
  "不再",
  "不自动",
  "没有",
  "保留",
  "原样",
  "只留",
  "另存",
  "留着",
  "找出",
  "列出",
  "数出",
  "对比",
  "比较",
  "分门别类",
  "草稿",
  "由你",
  "你自己",
];

function riskyLine(line: string, needles: readonly string[]): boolean {
  if (!needles.some((needle) => line.includes(needle))) return false;
  return !SAFE_MARKERS.some((marker) => line.includes(marker));
}

/** Whether a plan mentions one of the three red-line actions. */
export function planRisks(plan: readonly string[]): PlanRisk[] {
  return RISK_RULES.map((rule) => ({
    kind: rule.kind,
    label: rule.label,
    detail: rule.detail,
    active: plan.some((line) => riskyLine(line, rule.needles)),
  }));
}

/** True when at least one red-line action is active (used for the loud banner). */
export function hasActiveRisk(risks: readonly PlanRisk[]): boolean {
  return risks.some((risk) => risk.active);
}

/**
 * #41 — appending this to the instruction is the *only* way an overwrite is
 * allowed, and the caller only does it after the user ticks the red checkbox.
 */
export const OVERWRITE_CONSENT =
  "\n\n【用户已明确同意】可以覆盖上面列出的原文件。覆盖前先把原件另存一份到同目录的「原件备份」文件夹里，万一要还原还能找到。";

/** Dry-run instruction: look and explain, never touch. */
export function dryRunInstruction(instruction: string): string {
  return `${instruction}\n\n【这次只试跑】只用文字说明你打算怎么做，新建、修改、删除、移动任何文件都不要做。这一步只看不动。`;
}

// ---------------------------------------------------------------------------
// Where the data went
// ---------------------------------------------------------------------------

export function onlineLabel(online: boolean): string {
  return online ? "本次联网" : "本次未联网";
}

export function onlineHint(online: boolean): string {
  return online
    ? "整理时用到了联网，内容发给了帮你整理的服务方。"
    : "这次全部在你自己的电脑上完成，内容没有发出去。";
}

/** Local-only switch key shared with the privacy panel (kept as a string so
 *  this module stays independent of `privacy.ts`). */
export const LOCAL_ONLY_KEY = "cante.localOnly";

/** Whether a run that starts now may reach the network. */
export function runIsOnline(
  online: boolean,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): boolean {
  if (!online) return false;
  if (!storage) return true;
  try {
    return storage.getItem(LOCAL_ONLY_KEY) !== "1";
  } catch {
    return true;
  }
}

function safeStorage(): Pick<Storage, "getItem"> | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** A short Chinese timestamp: 今天 14:30 / 昨天 09:05 / 9月3日 14:30. */
export function formatWhen(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间不详";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 2000) return "时间不详";
  const nowDate = new Date(now);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay(date, nowDate)) return `今天 ${clock}`;
  if (sameDay(date, new Date(now - 86_400_000))) return `昨天 ${clock}`;
  if (date.getFullYear() === nowDate.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------
let idCounter = 0;

/** A sortable, collision-resistant-enough run id (`run_<ms>_<seq>`). */
export function newRunId(now: number = Date.now()): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `run_${now.toString(36)}_${idCounter.toString(36)}`;
}

/** The plan shown when a task forgot to supply one — never an empty box. */
export function fallbackPlan(files: readonly string[]): string[] {
  const what = files.length > 0 ? `你要处理的 ${files.length} 个文件` : "你交代的内容";
  return [
    `只做你交代的这件事：${what}。`,
    "先说明打算怎么做，再动手。",
    "结果另存为新文件，原来的文件只读不改。",
    "做完告诉你结果文件放在哪里。",
  ];
}
