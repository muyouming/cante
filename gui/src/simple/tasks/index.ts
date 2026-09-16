// The task catalogue the simple home page renders.
//
// PLACEHOLDER (r5-shell): r5-tasks owns this file and ships the real catalogue
// (Excel / file / WeChat / document tasks). Every export below is the frozen
// round-5 contract, so `Home.tsx` compiles and renders the moment the real list
// lands. An empty catalogue is a valid first run: the home page shows its
// “任务清单正在准备中” state and keeps the free-form input usable.

export type TaskGroup = "表格" | "文件" | "微信" | "文书" | "资料";

export type TaskNeeds = "files" | "folder" | "none" | "text";

export interface TaskDef {
  /** Stable id, e.g. "excel.merge". */
  id: string;
  /** Chinese title, e.g. 「把几张表合成一张」. */
  title: string;
  /** One-line example of what the task is for. */
  example: string;
  /** Home-page section this card belongs to. */
  group: TaskGroup;
  /** What the task needs from the person before it can start. */
  needs: TaskNeeds;
  /** Accepted file extensions, e.g. ["xlsx", "xls", "csv"]. */
  accept?: string[];
  /** Deterministic Chinese steps shown on the confirmation page. */
  plan: string[];
  /** Chinese instruction sent to the agent. */
  prompt(files: string[], instruction: string): string;
  /** What the result card should highlight, e.g. 「行数变化」. */
  summaryHints: string[];
}

export const TASKS: TaskDef[] = [];
