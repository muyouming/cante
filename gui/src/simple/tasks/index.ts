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
import { WECHAT_ALL_TASKS } from "./wechat.ts";
// #74 — the four curated cards the ability centre adds on top of the above.
import { SHEET_TASKS } from "./sheet.ts";
import { BY_MONTH_TASKS } from "./bymonth.ts";
import { SUMMARY_TASKS } from "./summary.ts";
import { CHECK_TASKS } from "./check.ts";
import { INVOICE_TASKS } from "./invoice.ts";
import { ADMIN_TASKS } from "./admin.ts";

export type TaskGroup = "表格" | "文件" | "微信" | "文书" | "资料";

/** What the first step has to collect before the job can start. */
export type TaskNeeds = "files" | "folder" | "none" | "text";

import { buildPrompt } from "./prompt.ts";

export {
  SAFETY_RULES,
  buildPrompt,
  filesBlock,
  folderBlock,
  safetyBlock,
  userWordsBlock,
} from "./prompt.ts";

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
  /**
   * #63 — where this job is known to get things wrong, in Chinese, one concrete
   * case per line. Shown under the plan on the confirmation page as
   * 「这个任务可能不准的地方」.
   *
   * A risk has to be checkable against the user's own file ("有合并单元格时
   * 合计可能算重"), never a generic disclaimer ("仅供参考"). The catalogue test
   * rejects empty or filler entries.
   */
  risks?: string[];
  /** The one instruction handed to the assistant. */
  prompt(files: string[], instruction: string): string;
  /** What the result card should make prominent. */
  summaryHints: string[];
}

// ---------------------------------------------------------------------------
// The run model (frozen shape — the runner and the trust layer share it)
// ---------------------------------------------------------------------------

import {
  type RunImpact,
  type RunResult,
  type RunResultFile,
  type RunState,
  type TaskRun,
} from "../run.ts";

export type { TaskError, TaskRun } from "../run.ts";
export type TaskImpact = RunImpact;
export type TaskResultFile = RunResultFile;
export type TaskResult = RunResult;
export type TaskState = RunState;
// ---------------------------------------------------------------------------
// Prompt building blocks (shared with wechat.ts — see ./prompt.ts)
//
// Every task starts from these, so the two promises we make to users — "tell me
// what you are about to do first" and "your originals are never touched" — are
// in every single instruction, not just the ones we remembered to write out.
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
export const TASKS: TaskDef[] = [
  ...EXCEL_TASKS,
  ...SHEET_TASKS,
  ...FILE_TASKS,
  ...BY_MONTH_TASKS,
  ...DOCUMENT_TASKS,
  ...SUMMARY_TASKS,
  ...CHECK_TASKS,
  ...INVOICE_TASKS,
  ...ADMIN_TASKS,
  ...WECHAT_ALL_TASKS,
];

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

/** The id `freeTask` uses, so `risksForTask` can find it without a catalogue entry. */
export const FREE_TEXT_TASK_ID = "free.text";

/** What can go wrong when the user describes the job in her own words. */
export const FREE_TEXT_RISKS: string[] = [
  "你说得越笼统（比如「把这几张表弄一下」），结果越可能和你想的不一样；我会先把我打算怎么做说给你听。",
  "结果一律另存为新文件，万一我理解错了，你原来的文件不会有任何变化。",
  "需要你核对的地方，我会写在结果最后的「需要你核对」里。",
];

/**
 * The "直接说一句话" path: what the user typed *is* the task.
 *
 * It still needs files, because in this product a sentence like "把这几张表弄一下"
 * always refers to something on disk — the pick step is where she says what.
 * Document-only wishes have their own cards under 文书.
 */
export function freeTask(instruction: string): TaskDef {
  const what = instruction.trim() || "用户还没有说清楚要做什么；先问清楚再动手。";
  return {
    id: FREE_TEXT_TASK_ID,
    title: "直接说一件事",
    example: "把这几张表弄成一张 / 把这个文件夹整理一下",
    group: "文书",
    needs: "files",
    plan: [
      "先读懂你要的是什么，把打算怎么做说给你听",
      "按你说的去做",
      "结果另存为新文件，原来的文件一动不动",
      "做完告诉你文件在哪里",
    ],
    prompt(files: string[], extra: string): string {
      return buildPrompt({
        what,
        files,
        how: [
          "先说明你打算怎么做，再动手",
          "结果另存为新文件；原来的文件只能读，不能改、不能删、不能覆盖",
        ],
        instruction: extra,
        done: "用一句中文告诉我做完了什么、结果文件在哪里、有没有需要我核对的地方",
      });
    },
    risks: [...FREE_TEXT_RISKS],
    summaryHints: ["做了什么", "结果文件在哪里"],
  };
}

/**
 * #63 — the risks to show for a run's task id. Falls back to the free-sentence
 * list, which is the only task a run can carry that has no catalogue entry.
 * An unknown/old id returns nothing rather than inventing a disclaimer.
 */
export function risksForTask(taskId: string): string[] {
  const task = taskById(taskId);
  if (task?.risks && task.risks.length > 0) return task.risks;
  if (taskId === FREE_TEXT_TASK_ID) return FREE_TEXT_RISKS;
  return [];
}

/** The groups that actually have a card, in display order. */
export function taskGroups(): TaskGroup[] {
  const order: TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];
  const present = new Set(TASKS.map((task) => task.group));
  return order.filter((group) => present.has(group));
}
