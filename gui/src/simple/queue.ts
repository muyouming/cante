// r13 队列的纯逻辑：一次说好几件事，一件件做。
//
// 王姐的节奏是一次要办好几件（合表、查重、整理文件夹），每件都要重新选文件、
// 重新说一句话。排队让这份准备只做一遍：把几件排好，一件件来。
//
// 排队**不等于**会自动做完：每一件仍然是先摆到确认页，她点了「开始」才动手
// （产品律：动手前先问人）。所以这里没有"连跑到底"这种东西，只有队列的账：
//
//   * 下一件是谁、手里这件是队里的第几件   -> nextWaiting / positionOf / jobFor
//   * 还剩几件、用中文怎么念出来           -> queueSummary / describeQueue
//   * 外面的数据怎么变成排队里的一条       -> makeJob（坏数据一律拒绝，绝不抛错）
//
// 它不碰 Daemon、不存盘、不认识 store，所以 `bun test` 能直接钉住这些账。
// 面向用户的固定文案（按钮、标题）在 `copy-queue.ts`；这里的句子是跟着数据
// 变的（几件、哪一件），同样是给王姐看的中文，一律不许出现术语。

export type QueuedState = "waiting" | "running" | "done" | "failed";

export interface QueuedJob {
  id: string;
  taskId: string;
  taskTitle: string;
  plan: string[];
  files: string[];
  instruction: string;
  state: QueuedState;
  createdAt: number;
}

/** 排一件活需要的东西：卡片、文件、她那句话。 */
export interface QueueInput {
  taskId: string;
  taskTitle?: string;
  plan?: readonly string[] | null;
  files?: readonly string[] | null;
  instruction?: string | null;
}

export interface QueueSummary {
  /** 还没做完的：等她确认的 + 手里正在做的。 */
  remaining: number;
  /** 排好还没轮到的。 */
  waiting: number;
  /** 做完的和没做成的。 */
  finished: number;
  /** 手里这件（在确认页上，或者正在做）。 */
  current: QueuedJob | null;
  /** 下一件（第一个还在等的）。 */
  next: QueuedJob | null;
}

const STATES: readonly QueuedState[] = ["waiting", "running", "done", "failed"];

// ---------------------------------------------------------------------------
// 容错：队列是内存里的账，坏数据不许让应用崩
// ---------------------------------------------------------------------------

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

function isState(value: unknown): value is QueuedState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

/** 一条排队记录的结构检查：缺 id、缺任务、状态不认识，一律不算数。 */
export function isJob(value: unknown): value is QueuedJob {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.taskId === "string" &&
    record.taskId.length > 0 &&
    isState(record.state)
  );
}

/** 只留下认得出来的那些：一个 null 混进来，别的照样能用。 */
function safeJobs(jobs: readonly unknown[] | null | undefined): QueuedJob[] {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter(isJob);
}

let seq = 0;

/** 一条排队记录的 id（`q_<ms>_<seq>`），同一毫秒里连续排也不会撞。 */
export function newQueueId(now: number = Date.now()): string {
  seq = (seq + 1) % 1_000_000;
  return `q_${now.toString(36)}_${seq.toString(36)}`;
}

/**
 * 把外面给的这件活变成排队里的一条。
 *
 * 只有 `taskId` 是必须的：没有它，这件事做不成也说不出是哪件。其余字段缺了
 * 就按空的来（卡片标题退回 id，文件没有就是没有），但**不抛错**——她点按钮
 * 不该因为一个字段变成错误页。
 */
export function makeJob(input: unknown, now: number = Date.now()): QueuedJob | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const taskId = asText(record.taskId);
  if (!taskId) return null;
  const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  return {
    id: newQueueId(at),
    taskId,
    taskTitle: asText(record.taskTitle) || taskId,
    plan: asTextList(record.plan),
    files: asTextList(record.files),
    instruction: asText(record.instruction),
    state: "waiting",
    createdAt: at,
  };
}

// ---------------------------------------------------------------------------
// 账：下一件是谁、还剩几件
// ---------------------------------------------------------------------------

/** 手里这件（在确认页上或正在做的那一件）。 */
export function activeJob(jobs: readonly unknown[]): QueuedJob | null {
  return safeJobs(jobs).find((job) => job.state === "running") ?? null;
}

/** 排在最前面的、还没轮到的那一件。 */
export function nextWaiting(jobs: readonly unknown[]): QueuedJob | null {
  return safeJobs(jobs).find((job) => job.state === "waiting") ?? null;
}

/** 排到队尾；混在里面的坏条目顺手丢掉。 */
export function appendJob(jobs: readonly unknown[], job: QueuedJob): QueuedJob[] {
  return [...safeJobs(jobs), job];
}

/** 插到最前面（「先做这件」）；坏条目同样顺手丢掉。 */
export function prependJob(jobs: readonly unknown[], job: QueuedJob): QueuedJob[] {
  return [job, ...safeJobs(jobs)];
}

/** 改一条的状态；坏条目顺手丢掉。 */
export function withJobState(
  jobs: readonly unknown[],
  id: string,
  state: QueuedState,
): QueuedJob[] {
  return safeJobs(jobs).map((job) => (job.id === id ? { ...job, state } : job));
}

/** 拿掉一条；坏条目顺手丢掉。 */
export function withoutJob(jobs: readonly unknown[], id: string): QueuedJob[] {
  return safeJobs(jobs).filter((job) => job.id !== id);
}

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((path, index) => path === b[index]);
}

/** 两件是不是同一件事：同一个任务、同一句话、同一批文件。 */
export function sameJob(a: QueuedJob, b: QueuedJob): boolean {
  return a.taskId === b.taskId && a.instruction === b.instruction && sameFiles(a.files, b.files);
}

/** 一件活（任务 + 她那句话 + 文件）用来和排队里的记录配对。 */
export interface JobLike {
  taskId: string;
  instruction: string;
  files: readonly string[];
}

function matches(job: QueuedJob, run: JobLike): boolean {
  return (
    job.taskId === run.taskId &&
    job.instruction === run.instruction &&
    sameFiles(job.files, run.files ?? [])
  );
}

/** 手里这件活对应队里的哪一条（按内容配对），不在队里就是 null。 */
export function jobFor(
  jobs: readonly unknown[],
  run: JobLike | null | undefined,
): QueuedJob | null {
  if (!run) return null;
  return safeJobs(jobs).find((job) => matches(job, run)) ?? null;
}

/** 手里这件是"还没做完的那些"里的第几件（1 起）；不在里面就是 null。 */
export function positionOf(
  jobs: readonly unknown[],
  run: JobLike | null | undefined,
): number | null {
  if (!run) return null;
  const open = safeJobs(jobs).filter((job) => job.state === "waiting" || job.state === "running");
  const index = open.findIndex((job) => matches(job, run));
  return index < 0 ? null : index + 1;
}

export function queueSummary(jobs: readonly unknown[]): QueueSummary {
  const list = safeJobs(jobs);
  const current = list.find((job) => job.state === "running") ?? null;
  const next = list.find((job) => job.state === "waiting") ?? null;
  const waiting = list.filter((job) => job.state === "waiting").length;
  const finished = list.filter((job) => job.state === "done" || job.state === "failed").length;
  return { remaining: waiting + (current ? 1 : 0), waiting, finished, current, next };
}

// ---------------------------------------------------------------------------
// 中文说法
// ---------------------------------------------------------------------------

/**
 * 首页那一行：还有几件、手里这件在等什么、下一件是什么。
 *
 * `current` 说的是手里这件现在的样子：`confirm` = 停在确认页等她点头，
 * `doing` = 已经动手了。不给就按"等她确认"来说——那是更常见的那一种，
 * 也是更保守的一种说法（绝不把"还没开始"说成"正在做"）。
 */
export function describeQueue(summary: QueueSummary, current?: "confirm" | "doing"): string {
  const { remaining, finished, current: active, next } = summary;
  if (remaining === 0) {
    if (finished > 0) return `排好的 ${finished} 件事都做完了。`;
    return "还没有排别的事。";
  }
  if (!active) {
    return `还有 ${remaining} 件：第一件是「${next?.taskTitle ?? ""}」。`;
  }
  const head =
    current === "doing"
      ? `还有 ${remaining} 件：正在做「${active.taskTitle}」`
      : `还有 ${remaining} 件：正在等你确认「${active.taskTitle}」`;
  const tail = next ? `，下一件是「${next.taskTitle}」` : "";
  return `${head}${tail}。`;
}
