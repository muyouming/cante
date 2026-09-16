// 任务卡的共享类型。
//
// 为什么单独一个文件：任务卡模块（excel.ts、wechat.ts…）都需要 `TaskDef` 与
// `buildPrompt`。原先它们从 `./index.ts` 取——而 `index.ts` 又 import 这些卡来拼
// `TASKS`，于是形成**循环导入**：谁先被加载决定成败。全套测试一起跑时侥幸能过，
// 单独跑某一张卡的测试就会炸（`Cannot access 'X' before initialization`）。
//
// 所以类型下沉到这里、构建函数留在 `./prompt.ts`，让每一张卡都只依赖**叶子模块**：
// 叶子不回头依赖 barrel，顺序就无关紧要了。`index.ts` 仍然把这些类型再导出一次，
// 外面的调用方不需要改。
import type {
  RunImpact,
  RunResult,
  RunResultFile,
  RunState,
  TaskRun,
} from "../run.ts";

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

export type { TaskError, TaskRun } from "../run.ts";
export type TaskImpact = RunImpact;
export type TaskResultFile = RunResultFile;
export type TaskResult = RunResult;
export type TaskState = RunState;
