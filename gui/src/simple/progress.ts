// #62 — what the user sees while a job is running.
//
// A spinner tells a non-technical user nothing: not what is happening, not how
// far along it is, not how much is left. Wharton's adoption study is blunt about
// it — explaining the process is what moves the "reliable / safe" ratings — so
// the running screen shows the plan as a checklist that fills in as the work
// proceeds.
//
// This module is the pure half. It turns "the plan" plus "what the event stream
// has shown us" into one state per step. No Solid, no timers, no I/O: the store
// owns those. Here we only fold evidence into a cursor that never moves
// backwards.
//
// The evidence is ranked by how much it can be trusted:
//
//   a) what the assistant says out loud ("第 2 步：…") — the most specific;
//   b) tool activity — coarse, so it only nudges the cursor one step at a time;
//   c) nothing — stay on the first step and say so, never guess.
//
// The one rule that overrides everything: under-advance. Showing "正在做第 1 步"
// for a moment too long is forgettable; showing step 4 when the job is still
// reading files makes the whole screen untrustworthy.

export type StepState = "pending" | "active" | "done";

export interface ProgressStep {
  text: string;
  state: StepState;
}

/** The shape the store hands to the running screen. */
export interface RunProgressView {
  steps: ProgressStep[];
  startedAt: number | null;
  elapsedMs: number;
}

/**
 * A tool name reduced to the one thing it says about the plan: did it read,
 * write or run? `other` means "says nothing" and never moves the cursor.
 */
export type ToolKind = "read" | "write" | "run" | "other";

/** Which step (0-based) the run is working on. Never moves backwards. */
export interface Progress {
  index: number;
}

// ---------------------------------------------------------------------------
// Step states
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function initialProgress(): Progress {
  return { index: 0 };
}

/** The checklist while the run is in flight: done / active / pending. */
export function progressSteps(plan: readonly string[], progress: Progress): ProgressStep[] {
  const total = plan.length;
  if (total === 0) return [];
  const index = clamp(progress.index, 0, total - 1);
  return plan.map((text, position) => ({
    text,
    state: position < index ? "done" : position === index ? "active" : "pending",
  }));
}

/** The checklist once the run is over: every step ticked. */
export function finishedSteps(plan: readonly string[]): ProgressStep[] {
  return plan.map((text) => ({ text, state: "done" as const }));
}

/**
 * Compose the view the running screen reads.
 *
 * `finished` wins over everything (the run is over, so every step is done), and
 * while running the clock runs; when it is not running the last measured value
 * is frozen so a finished screen cannot keep counting.
 */
export interface RunProgressInput {
  plan: readonly string[];
  cursor: Progress;
  /** The run is in the `running` state right now. */
  running: boolean;
  /** A run exists but is no longer running (done / failed / cancelled). */
  finished: boolean;
  startedAt: number | null;
  now: number;
  /** Elapsed frozen at the end of the run, used when it is not running. */
  elapsedMs: number;
}

export function progressView(input: RunProgressInput): RunProgressView {
  const { plan, cursor, running, finished, startedAt, now, elapsedMs } = input;
  const steps =
    plan.length === 0 ? [] : finished ? finishedSteps(plan) : progressSteps(plan, cursor);
  const elapsed = running && startedAt !== null ? Math.max(0, now - startedAt) : elapsedMs;
  return { steps, startedAt, elapsedMs: elapsed };
}

// ---------------------------------------------------------------------------
// (a) what the assistant says
// ---------------------------------------------------------------------------

const CN_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** Arabic digits or 一..九十九 (plans never run longer than that), else null. */
function chineseNumber(text: string): number | null {
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (text === "十") return 10;
  const composed = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (composed) {
    const tens = composed[1] ? CN_NUMERALS[composed[1]]! : 1;
    const ones = composed[2] ? CN_NUMERALS[composed[2]]! : 0;
    return tens * 10 + ones;
  }
  return CN_NUMERALS[text] ?? null;
}

const STEP_MARKER = /第\s*([0-9]+|[一二三四五六七八九十]+)\s*步|步骤\s*([0-9]+|[一二三四五六七八九十]+)/g;

/** Every step number the text names, ascending and without duplicates. */
export function explicitSteps(text: string): number[] {
  if (!text) return [];
  const found = new Set<number>();
  STEP_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null = STEP_MARKER.exec(text);
  while (match !== null) {
    const raw = match[1] ?? match[2] ?? "";
    const value = chineseNumber(raw);
    if (value !== null && value >= 1 && value <= 999) found.add(value);
    match = STEP_MARKER.exec(text);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The step the assistant is on, 1-based, or null when it named none.
 *
 * The *smallest* number wins. A message that walks through the whole plan
 * ("第 1 步… 第 2 步… 第 4 步") is reciting it, not reporting progress, and a
 * message that recaps an earlier step ("第 1 步做完了") should not drag the
 * highlight forward on the strength of a number that is already behind us.
 * Under-advancing is the safe side.
 */
export function explicitStep(text: string): number | null {
  const steps = explicitSteps(text);
  return steps.length > 0 ? steps[0]! : null;
}

// ---------------------------------------------------------------------------
// (b) what the tools did
// ---------------------------------------------------------------------------

/** Tools that only plan or delegate: they say nothing about the files. */
const IGNORED_TOOLS: readonly string[] = [
  "todo",
  "task",
  "think",
  "plan",
  "agent",
  "skill",
  "memory",
];

const RUN_TOOLS: readonly string[] = [
  "bash",
  "shell",
  "zsh",
  "powershell",
  "exec",
  "spawn",
  "command",
  "terminal",
  "console",
  "script",
  "python",
  "node",
  "bun",
  "deno",
  "make",
  "cargo",
  "npm",
  "yarn",
  "执行",
  "运行",
  "命令",
];

const WRITE_TOOLS: readonly string[] = [
  "write",
  "edit",
  "create",
  "save",
  "append",
  "insert",
  "patch",
  "apply",
  "replace",
  "mkdir",
  "move",
  "rename",
  "copy",
  "delete",
  "remove",
  "trash",
  "compress",
  "unzip",
  "export",
  "upload",
  "chmod",
  "touch",
  "写",
  "存",
  "新建",
  "改",
  "移",
  "删",
  "复制",
  "导出",
];

const READ_TOOLS: readonly string[] = [
  "read",
  "view",
  "review",
  "open",
  "load",
  "download",
  "glob",
  "grep",
  "search",
  "find",
  "list",
  "dir",
  "stat",
  "inspect",
  "fetch",
  "web",
  "pdf",
  "sheet",
  "extract",
  "parse",
  "读",
  "看",
  "查",
  "搜",
  "找",
  "列",
  "打开",
];

function has(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

/**
 * Map a tool name onto the three buckets. Unknown tools are `other` on
 * purpose: guessing from a name we do not recognise is how the screen starts
 * lying.
 */
export function toolKind(name: string): ToolKind {
  const value = String(name ?? "").toLowerCase();
  if (!value) return "other";
  if (has(value, IGNORED_TOOLS)) return "other";
  if (has(value, RUN_TOOLS)) return "run";
  if (has(value, WRITE_TOOLS)) return "write";
  if (has(value, READ_TOOLS)) return "read";
  return "other";
}

/**
 * The step a tool of this kind points at, or null when it says nothing.
 *
 * Reads live at the front, writes at the back, commands in between. The very
 * last plan step is normally "tell the user where the result is" — narration,
 * not a file operation — so a write points one step before the end. That is the
 * "advance one step less" bias, applied to the mapping itself.
 */
export function toolTarget(kind: ToolKind, total: number): number | null {
  const last = Math.max(0, total - 1);
  switch (kind) {
    case "read":
      return 0;
    case "run":
      return Math.min(1, last);
    case "write":
      return clamp(Math.max(1, total - 2), 0, last);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The monotonic reducer
// ---------------------------------------------------------------------------

function advanceTo(progress: Progress, target: number, total: number): Progress {
  const last = Math.max(0, total - 1);
  const next = clamp(target, 0, last);
  // `>` not `>=`: the cursor only ever moves forward, and an unchanged cursor
  // returns the same object so callers can skip a redraw.
  return next > progress.index ? { index: next } : progress;
}

/** Fold one *complete* assistant message in. Streaming deltas are not folded
 *  one by one — a plan that arrives in pieces would be mistaken for progress. */
export function onAssistantText(progress: Progress, text: string, total: number): Progress {
  if (total <= 0) return progress;
  const step = explicitStep(text);
  if (step === null) return progress;
  return advanceTo(progress, step - 1, total);
}

/**
 * Fold one tool call in.
 *
 * A tool name is a coarse hint, not a confession, so it can move the cursor at
 * most one step — an early temporary-file write must not teleport the user to
 * the end of the plan. A read never pulls the cursor back to the first step;
 * the monotonic rule handles that by construction.
 */
export function onTool(progress: Progress, name: string, total: number): Progress {
  if (total <= 0) return progress;
  const target = toolTarget(toolKind(name), total);
  if (target === null || target <= progress.index) return progress;
  return advanceTo(progress, Math.min(target, progress.index + 1), total);
}

// ---------------------------------------------------------------------------
// Copy (kept beside the logic so the whole running screen is reviewable here)
// ---------------------------------------------------------------------------

/** A compact "已经用了 3 分 05 秒" duration, always with a unit. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/**
 * The running screen's words. All Chinese, no jargon: no 模型 / token / 路径.
 *
 * INTEGRATION: these belong in `simple/copy.ts` next to the other surfaces;
 * they live here for now because this workstream owns only this module.
 */
export const PROGRESS_COPY = {
  title: "正在做这些事",
  hint: "按顺序一步步来，做完一步打一个勾。",
  doing: (text: string) => `正在做：${text}`,
  elapsed: (time: string) => `已经用了 ${time}`,
  promise: "原来的文件不会被改动，随时可以点下面的按钮停下来。",
  stop: "停下来",
  keepOpen: "请不要关掉窗口。",
} as const;
