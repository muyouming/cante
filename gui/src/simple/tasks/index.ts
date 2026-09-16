// The task catalogue behind simple mode.
//
// One `TaskDef` is one card on the home screen, and one job a non-technical user
// can hand over in a single sentence. Everything the interface shows is here and
// in the three sibling modules; nothing in this file talks to the daemon.
//
// Three things are deliberate:
//
//   * `plan` is fixed text, not a model output. The confirmation step must show
//     the same thing every time — that is what "confirm before acting" means.
//   * `prompt` is the whole instruction sent to the assistant. It is written in
//     plain Chinese by us, so the safety rules do not depend on the model
//     remembering them.
//   * the cards carry no jargon: no model, no token, no path, no diff.
import { EXCEL_TASKS } from "./excel.ts";
import { FILE_TASKS } from "./files.ts";
import { DOCUMENT_TASKS } from "./document.ts";

export type TaskGroup = "表格" | "文件" | "微信" | "文书" | "资料";

/** What the first step has to collect before the job can start. */
export type TaskNeeds = "files" | "folder" | "none" | "text";

export interface TaskDef {
  /** Stable id, e.g. "excel.merge". History and undo key off this. */
  id: string;
  /** Chinese card title. */
  title: string;
  /** One sentence used as the input's placeholder. */
  example: string;
  group: TaskGroup;
  needs: TaskNeeds;
  /** File extensions the picker offers, e.g. ["xlsx", "xls", "csv"]. */
  accept?: string[];
  /** What is about to happen, in Chinese, one step per line. */
  plan: string[];
  /** The one instruction handed to the assistant. */
  prompt(files: string[], instruction: string): string;
  /** What the result card should make prominent. */
  summaryHints: string[];
}

// ---------------------------------------------------------------------------
// The run model (frozen shape — the runner and the trust layer share it)
// ---------------------------------------------------------------------------

export interface TaskImpact {
  created: number;
  modified: number;
  deleted: number;
  messages: number;
}

export interface TaskResultFile {
  path: string;
  summary: string;
}

export interface TaskResult {
  files: TaskResultFile[];
  summary: string;
}

export interface TaskError {
  /** 发生了什么 */
  what: string;
  /** 你可以怎么做 */
  how: string;
  detail: string;
}

export type TaskState = "draft" | "preview" | "running" | "done" | "failed" | "cancelled";

export interface TaskRun {
  id: string;
  taskId: string;
  taskTitle: string;
  files: string[];
  instruction: string;
  state: TaskState;
  plan: string[];
  impact: TaskImpact;
  result: TaskResult | null;
  online: boolean;
  error: TaskError | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Prompt building blocks
//
// Every task starts from these, so the two promises we make to users — "tell me
// what you are about to do first" and "your originals are never touched" — are
// in every single instruction, not just the ones we remembered to write out.
// ---------------------------------------------------------------------------

/** The rules every job carries. Exported so the tests can pin the wording. */
export const SAFETY_RULES: readonly string[] = [
  "【先说明再动手】先说明你打算怎么做，再动手。",
  "【不要动原文件】结果另存为新文件，不要改原文件。原来的文件只能读，不能改、不能删、不能覆盖。",
  "【只做这一件事】不要顺手做别的改动，也不要重命名原来的文件。",
  "【看不懂就先停】遇到打不开、对不上、拿不准的地方，先停下来把情况说清楚，不要自己猜着做。",
];

/** "【要处理的文件】（只读）" plus a numbered list. */
export function filesBlock(files: string[]): string {
  if (files.length === 0) {
    return "【要处理的文件】\n这次没有选文件，内容全部来自用户的原话。\n";
  }
  const lines = [`【要处理的文件】（只读，一共 ${files.length} 个，按这个顺序）`];
  files.forEach((path, index) => lines.push(`${index + 1}. ${path}`));
  return `${lines.join("\n")}\n`;
}

/** The folder variant, used by the tidy-up jobs. */
export function folderBlock(folder: string): string {
  return [
    "【要整理的文件夹】（只读）",
    folder,
    "这个文件夹里的东西不是都要动：按下面的做法只处理说到的那些，其它的原样留着。",
    "",
  ].join("\n");
}

/** The user's own words, which always outrank our wording. */
export function userWordsBlock(instruction: string): string {
  const said = instruction.trim() || "（用户没有补充，按上面的做法做）";
  return [
    "【用户的原话】",
    said,
    "",
    "如果用户的原话和上面的做法有冲突，以用户的原话为准；拿不准就先问一句。",
    "",
  ].join("\n");
}

/**
 * The shared rule list, optionally with one task-specific exception. The
 * exception never removes a rule — it only adds one.
 */
export function safetyBlock(extra?: string): string {
  const rules = extra ? [...SAFETY_RULES, `【这个任务的补充】${extra}`] : [...SAFETY_RULES];
  return `${rules.map((rule) => `- ${rule}`).join("\n")}\n`;
}

/** Assemble one prompt from its parts, in a fixed order. */
export function buildPrompt(parts: {
  what: string;
  files?: string[];
  folder?: string;
  how: string[];
  extraRule?: string;
  instruction: string;
  done: string;
}): string {
  const blocks: string[] = [`【要做的事】${parts.what}`, ""];
  if (parts.folder) blocks.push(folderBlock(parts.folder));
  else blocks.push(filesBlock(parts.files ?? []));
  blocks.push(
    "【怎么做】",
    ...parts.how.map((step, index) => `${index + 1}. ${step}`),
    "",
    "【必须守住的规矩】",
    safetyBlock(parts.extraRule).trimEnd(),
    "",
    userWordsBlock(parts.instruction).trimEnd(),
    "",
    `【做完告诉我】${parts.done}`,
  );
  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every card on the home screen, in display order.
 *
 * INTEGRATION: `wechat.ts` (the WeChat jobs, #51/#52) is owned by the privacy
 * workstream. When that file lands, append its exported list here —
 * `[...EXCEL_TASKS, ...FILE_TASKS, ...DOCUMENT_TASKS, ...WECHAT_TASKS]` — so
 * the home screen and history pick the WeChat cards up automatically.
 */
export const TASKS: TaskDef[] = [...EXCEL_TASKS, ...FILE_TASKS, ...DOCUMENT_TASKS];

/** Look up one card by id (history, retry, and the runner all need it). */
export function taskById(id: string): TaskDef | undefined {
  return TASKS.find((task) => task.id === id);
}

/**
 * The complete instruction a run should carry.
 *
 * The runner hands the run only the user's own sentence (that is what the
 * confirmation page and the history show). This turns a finished run back into
 * the full instruction — plan first, originals untouched — at the moment it is
 * actually sent. Returns null when the card is gone (an old history entry).
 */
export function instructionFor(taskId: string, files: string[], instruction: string): string | null {
  return taskById(taskId)?.prompt(files, instruction) ?? null;
}

/** The groups that actually have a card, in display order. */
export function taskGroups(): TaskGroup[] {
  const order: TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];
  const present = new Set(TASKS.map((task) => task.group));
  return order.filter((group) => present.has(group));
}
