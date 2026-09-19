// 「我做的结果」按时间分组（纯逻辑，有单测）。
//
// 她要找的是「我那天做的月报」——时间 + 哪张卡。搜索要她先想起文件名里有什么，
// 所以面板再给一条不用回忆的路：把结果按「今天做的 / 这周做的 / 更早做的」分开。
//
// 三条边界：
//   * 用的是本机时间（她看日历就是本机时间），不是协调世界时；
//   * 「这周」从本机时间的星期一开始（中国习惯的一周头一天）；星期天属于这一周；
//   * 这里只分组、不排序：进来的清单已经从新到旧（collectResults 定的），组内保持原样。

import type { ResultEntry } from "./results.ts";

/** 一份结果落在哪一组。只有三种，非此即彼。 */
export type ResultBucket = "today" | "week" | "earlier";

/** 一组结果：同一时间段的（可能为空的时候调用方不会看到，见 groupResults）。 */
export interface ResultGroup {
  bucket: ResultBucket;
  entries: ResultEntry[];
}

/** 本地日历上是不是同一天。 */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 「这一周」的起止（本机时间）：从本机时间本周一 00:00 到下周一同一个时刻。
 * 用日历日期算，不加减毫秒——有的地方有夏令时，一天不总是 24 小时。
 */
function weekBounds(now: number): { start: number; end: number } {
  const date = new Date(now);
  // getDay(): 0=周日 … 6=周六；换算成「离本周一过了几天」（周一=0 … 周日=6）。
  const sinceMonday = (date.getDay() + 6) % 7;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - sinceMonday);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * 一份结果该放进哪一组。
 *
 *   * 今天做的   —— 本机日历上就是今天；
 *   * 这周做的   —— 本机日历上属于本周（周一 00:00 起，到下周一开始前）；
 *   * 更早做的   —— 本周之前的，以及时间读不出来的（0、缺值）。时间读不出来时
 *                   宁可放进「更早」，也不假装它是今天做的。
 */
export function bucketOf(timestamp: number, now: number = Date.now()): ResultBucket {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "earlier";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "earlier";
  if (sameLocalDay(date, new Date(now))) return "today";
  const { start, end } = weekBounds(now);
  const time = date.getTime();
  if (time >= start && time < end) return "week";
  return "earlier";
}

/** 分组固定按这个顺序摆在面板上：今天、这周、更早。空的不出现。 */
const BUCKET_ORDER: readonly ResultBucket[] = ["today", "week", "earlier"];

/**
 * 把一份已经从新到旧的清单分成「今天 / 这周 / 更早」三组。
 *
 * 只把非空的组返回（没有更早的就不显示「更早做的」那个标题）。组里的顺序沿用
 * 传进来的顺序——最近做的在最上面这条语义不在这里改。不修改传进来的数组。
 */
export function groupResults(
  entries: readonly ResultEntry[],
  now: number = Date.now(),
): ResultGroup[] {
  const byBucket = new Map<ResultBucket, ResultEntry[]>();
  for (const entry of entries) {
    const bucket = bucketOf(entry.createdAt, now);
    const list = byBucket.get(bucket);
    if (list) list.push(entry);
    else byBucket.set(bucket, [entry]);
  }
  const groups: ResultGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = byBucket.get(bucket);
    if (list && list.length > 0) groups.push({ bucket, entries: list });
  }
  return groups;
}
