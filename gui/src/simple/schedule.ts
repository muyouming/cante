// 定时/重复任务（#55）的纯逻辑。
//
// 王姐的活是按月、按周重复的（每周一整理上周的销售表、每月 5 号把微信报名
// 整理出来）。产品要她"不用记着"，所以这里只回答几个问题：
//
//   * 下一次该在什么时候做？  -> `nextRunAfter`
//   * 到点了没有？会不会一次涌出好几次？  -> `dueSchedules`
//   * 这一回是不是"错过以后补上的"？  -> `isCatchUp` / `catchUpScheduleFor`
//   * 用中文怎么念出来？  -> `describe`
//
// 这里没有副作用，也不碰 Daemon：算时间、比大小、拼字符串，全部可以单测。
// 存储读写的容错也放在这里（坏数据不许让应用起不来），但仍不产生副作用。

export type Cadence = "daily" | "weekly" | "monthly";

export interface Schedule {
  id: string;
  cadence: Cadence;
  /** weekly: 0=周日…6=周六；monthly: 1–28（大于 28 的日子不提供，避免"31 号在 2 月不存在"这种她无法理解的意外） */
  day: number;
  /** 24 小时制的小时（整点） */
  hour: number;
  taskId: string;
  taskTitle: string;
  plan: string[];
  files: string[];
  instruction: string;
  createdAt: number;
  lastRunAt?: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** localStorage 的键名统一带前缀，方便以后迁移版本。 */
export const SCHEDULE_STORAGE_KEY = "cante:schedule:v1";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

/** monthly 只到 28 号：再往后就会碰上"这个月没有 31 号"的意外。 */
function clampMonthDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.trunc(day)));
}

function clampWeekday(day: number): number {
  if (!Number.isFinite(day)) return 0;
  return ((Math.trunc(day) % 7) + 7) % 7;
}

/** 一个时间戳所在那天的零点（本地时区）。 */
export function startOfDay(from: number): number {
  const date = new Date(from);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

let scheduleSeq = 0;

/** 一个够用、带点排序意义的调度 id（`sch_<ms>_<seq>`）。 */
export function newScheduleId(now: number = Date.now()): string {
  scheduleSeq = (scheduleSeq + 1) % 1_000_000;
  return `sch_${now.toString(36)}_${scheduleSeq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// 下一次是什么时候
// ---------------------------------------------------------------------------

/**
 * 严格晚于 `from` 的下一次触发时间（本地时区）。
 *
 * 用 `Date` 的构造函数而不是自己加毫秒：跨月、跨年、闰年、夏令时都交给
 * 运行时处理，算出来的永远是本地钟表上的那个整点。
 */
export function nextRunAfter(schedule: Schedule, from: number): number {
  const hour = clampHour(schedule.hour);
  const base = new Date(from);
  const year = base.getFullYear();
  const month = base.getMonth();
  const date = base.getDate();

  if (schedule.cadence === "daily") {
    const today = new Date(year, month, date, hour, 0, 0, 0).getTime();
    if (today > from) return today;
    return new Date(year, month, date + 1, hour, 0, 0, 0).getTime();
  }

  if (schedule.cadence === "weekly") {
    const target = clampWeekday(schedule.day);
    const candidate = new Date(year, month, date, hour, 0, 0, 0);
    const delta = (target - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + delta);
    if (candidate.getTime() > from) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 7);
    return candidate.getTime();
  }

  const day = clampMonthDay(schedule.day);
  const thisMonth = new Date(year, month, day, hour, 0, 0, 0).getTime();
  if (thisMonth > from) return thisMonth;
  return new Date(year, month + 1, day, hour, 0, 0, 0).getTime();
}

/**
 * 「到点了」的调度。
 *
 * 两条规矩：
 *   1. 看的是"最后一次做过后"的下一次；所以关机一周回来最多补一次，不会一次
 *      涌出七次（`nextRunAfter` 严格晚于 `lastRunAt`）。
 *   2. `lastRunAt` 保证同一个时间点不重复触发；没做过的用 `createdAt` 起算。
 */
export function dueSchedules(schedules: readonly Schedule[], now: number): Schedule[] {
  const due: Schedule[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const from = schedule.lastRunAt ?? schedule.createdAt;
    if (nextRunAfter(schedule, from) <= now) due.push(schedule);
  }
  return due;
}

// ---------------------------------------------------------------------------
// 这一回是不是"错过以后补上的"
// ---------------------------------------------------------------------------
//
// 到点是由程序自己盯着的：电脑或程序关着的时候，那个时间点就悄悄过去了。重新
// 打开后 `dueSchedules` 会补上——但只补一次。补上的这一次要能认出来，界面才能
// 告诉她"上次错过的，今天补上了"，而不是让她以为"今天本来就该做"。
//
// 判据只看**调度自己的钟点**，不看 `lastRunAt`（那个值在摆上确认页时刚好被
// 覆盖成"现在"，读不出过去）。正常到点是 tick 的零头里就做（一分钟上下），
// 而错过是以天计的——所以离最近的钟点超过一个宽限，就是补上的那一次。

/** 往前找钟点时最多回溯这么久（比最长的一个月还长一点）。 */
const MAX_PERIOD_MS = 40 * 24 * 60 * 60 * 1000;

/** 正常的到点发生在最近钟点之后一分钟上下；超过这个宽限就算"错过了才补"。 */
export const CATCH_UP_GRACE_MS = 15 * 60 * 1000;

/** 调度里**最近一次不晚于 `at` 的钟点**（本地时区）。没有则 null。 */
function lastSlotAtOrBefore(schedule: Schedule, at: number): number | null {
  let slot = nextRunAfter(schedule, at - MAX_PERIOD_MS);
  for (let i = 0; i < 96 && slot <= at; i += 1) {
    const next = nextRunAfter(schedule, slot);
    if (next > at) return slot;
    slot = next;
  }
  return slot <= at ? slot : null;
}

/**
 * 这一回是不是"错过以后补上的"：`runAt` 离它该做的那个钟点，超过一个宽限。
 * 正常到点为 false；关机一周回来补的那一次为 true。
 */
export function isCatchUp(
  schedule: Schedule,
  runAt: number,
  graceMs: number = CATCH_UP_GRACE_MS,
): boolean {
  const slot = lastSlotAtOrBefore(schedule, runAt);
  if (slot === null) return false;
  return runAt - slot > graceMs;
}

/** 摆到确认页的那次运行，只需要这几个字段就能和调度对上。 */
export interface ScheduledRunLike {
  taskId: string;
  instruction: string;
  createdAt: number;
}

/** 摆上确认页和写 `lastRunAt` 是连着发生的，差不了几毫秒；留一分钟足够。 */
const RUN_MATCH_TOLERANCE_MS = 60 * 1000;

/**
 * 确认页上这一件，如果是某个自动任务刚补上的，返回那个调度；否则 null。
 *
 * 和调度对上的凭据有三样：同一张卡、同一句交代，以及 `lastRunAt` 就落在这次
 * 运行的同一时刻（`runScheduled` 摆上去的瞬间记的）。所以她手动做同样一件事
 * 不会被当成"自动补上的"。
 */
export function catchUpScheduleFor(
  schedules: readonly Schedule[],
  run: ScheduledRunLike,
): Schedule | null {
  let best: Schedule | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (schedule.taskId !== run.taskId) continue;
    if (schedule.instruction !== run.instruction) continue;
    if (schedule.lastRunAt === undefined) continue;
    const delta = Math.abs(schedule.lastRunAt - run.createdAt);
    if (delta > RUN_MATCH_TOLERANCE_MS || delta >= bestDelta) continue;
    best = schedule;
    bestDelta = delta;
  }
  if (!best) return null;
  return isCatchUp(best, run.createdAt) ? best : null;
}

// ---------------------------------------------------------------------------
// 中文说法
// ---------------------------------------------------------------------------

/** 「每天 09:00」/「每周一 09:00」/「每月5号 09:00」。 */
export function describeCadence(cadence: Cadence, day: number, hour: number): string {
  const clock = `${pad2(clampHour(hour))}:00`;
  if (cadence === "daily") return `每天 ${clock}`;
  if (cadence === "weekly") return `每${WEEKDAY_NAMES[clampWeekday(day)]} ${clock}`;
  return `每月${clampMonthDay(day)}号 ${clock}`;
}

export function describe(schedule: Schedule): string {
  return describeCadence(schedule.cadence, schedule.day, schedule.hour);
}

// ---------------------------------------------------------------------------
// 存储（坏数据不许让应用起不来）
// ---------------------------------------------------------------------------

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asString(record.id);
  const taskId = asString(record.taskId);
  if (!id || !taskId) return null;
  const cadence = record.cadence;
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") return null;
  const day = typeof record.day === "number" && Number.isFinite(record.day) ? record.day : 0;
  const hour = typeof record.hour === "number" && Number.isFinite(record.hour) ? record.hour : 0;
  const createdAt = asTime(record.createdAt);
  return {
    id,
    cadence,
    day,
    hour,
    taskId,
    taskTitle: asString(record.taskTitle) ?? "",
    plan: asStringList(record.plan),
    files: asStringList(record.files),
    instruction: asString(record.instruction) ?? "",
    createdAt: createdAt ?? 0,
    ...(asTime(record.lastRunAt) !== undefined ? { lastRunAt: asTime(record.lastRunAt) } : {}),
    enabled: record.enabled !== false,
  };
}

/** 解析失败就当空：一个坏字符串不能让应用起不来。 */
export function readSchedules(storage: ReadableStorage | null = browserStorage()): Schedule[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Schedule[] = [];
    for (const item of parsed) {
      const schedule = normalizeSchedule(item);
      if (schedule) out.push(schedule);
    }
    return out;
  } catch {
    return [];
  }
}

export function writeSchedules(
  schedules: readonly Schedule[],
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(schedules));
  } catch {
    // 锁死的 webview 存不进去，这次运行里的调度照样管用，只是下次记不住。
  }
}
