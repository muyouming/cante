// r30 — 「我做的结果」按时间分组的纯逻辑测试。
//
// 她记的是「我那天做的月报」，所以分组用的是**本机时间**：今天、这周（从本周一算
// 起）、更早。边界订在最容易被改错的那几个点上：
//   * 今天的头一小时和最后一小时都算今天；
//   * 本周一 00:00 之前一分钟算「更早」，之后算「这周」；
//   * 周日属于它前面那个周一开头的这一周（不是新一周）；
//   * 时间读不出来的（0 / 缺值）算「更早」，不假装是今天做的；
//   * 组内顺序沿用传进来的顺序（最近做的在前），而且不改动传进来的数组。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { bucketOf, groupResults, type ResultBucket } from "./results-when.ts";
import type { ResultEntry } from "./results.ts";

/** 本机时间的一个时间点，用它来写测试就不受时区影响。 */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function entry(createdAt: number, name = "结果.xlsx"): ResultEntry {
  return {
    key: `run|${name}`,
    runId: "run",
    path: `C:/桌面/${name}`,
    name,
    folder: "C:/桌面",
    title: "把几张表合成一张",
    instruction: "",
    createdAt,
    state: "done",
    presence: "present",
    size: 1024,
  };
}

describe("bucketOf：今天 / 这周 / 更早的边界", () => {
  // 2026-09-16 是星期三；本周一 = 2026-09-14，上周日 = 2026-09-13。
  const wednesdayNoon = local(2026, 9, 16, 12, 0);

  test("今天做的：从今天 00:00 到 23:59 都算今天", () => {
    expect(bucketOf(local(2026, 9, 16, 0, 0), wednesdayNoon)).toBe("today");
    expect(bucketOf(local(2026, 9, 16, 12, 0), wednesdayNoon)).toBe("today");
    expect(bucketOf(local(2026, 9, 16, 23, 59), wednesdayNoon)).toBe("today");
  });

  test("这周做的：本周一 00:00（含）到昨天，都算这周", () => {
    expect(bucketOf(local(2026, 9, 14, 0, 0), wednesdayNoon)).toBe("week");
    expect(bucketOf(local(2026, 9, 15, 9, 30), wednesdayNoon)).toBe("week");
  });

  test("更早做的：上周日 23:59 已经不算这周", () => {
    expect(bucketOf(local(2026, 9, 13, 23, 59), wednesdayNoon)).toBe("earlier");
    expect(bucketOf(local(2026, 9, 7, 12, 0), wednesdayNoon)).toBe("earlier");
  });

  test("周日属于它前面那个周一开头的这一周（不是新一周）", () => {
    // 现在是 2026-09-20 星期日；本周一 = 2026-09-14，所以上周一 09-07 是「更早」。
    const sunday = local(2026, 9, 20, 10, 0);
    expect(bucketOf(local(2026, 9, 14, 0, 0), sunday)).toBe("week");
    expect(bucketOf(local(2026, 9, 13, 23, 59), sunday)).toBe("earlier");
  });

  test("周一一早：前一分钟还是更早，整点就翻到这周（而且今天）", () => {
    const monday = local(2026, 9, 14, 8, 0);
    expect(bucketOf(local(2026, 9, 14, 0, 0), monday)).toBe("today");
    expect(bucketOf(local(2026, 9, 13, 23, 59), monday)).toBe("earlier");
  });

  test("跨年：这一周可以从去年跨到今年（本周一 = 去年 12 月 28 日）", () => {
    const now = local(2027, 1, 1, 12, 0); // 星期五；本周一 = 2026-12-28（星期一）
    expect(bucketOf(local(2026, 12, 28, 0, 0), now)).toBe("week");
    expect(bucketOf(local(2026, 12, 31, 12, 0), now)).toBe("week");
    // 上周日（12-27）已经落在上一周，算更早。
    expect(bucketOf(local(2026, 12, 27, 23, 59), now)).toBe("earlier");
    expect(bucketOf(local(2027, 1, 1, 9, 0), now)).toBe("today");
  });

  test("时间读不出来（0 / 缺值 / 非数字）→ 更早，不假装是今天", () => {
    expect(bucketOf(0, wednesdayNoon)).toBe("earlier");
    expect(bucketOf(-1, wednesdayNoon)).toBe("earlier");
    expect(bucketOf(Number.NaN, wednesdayNoon)).toBe("earlier");
    expect(bucketOf(Number.POSITIVE_INFINITY, wednesdayNoon)).toBe("earlier");
  });
});

describe("groupResults：分组、顺序、不全用", () => {
  const now = local(2026, 9, 16, 12, 0);

  test("按今天 / 这周 / 更早排，空组不出现", () => {
    const groups = groupResults(
      [
        entry(local(2026, 9, 16, 9, 0), "今天.xlsx"),
        entry(local(2026, 9, 15, 9, 0), "这周.xlsx"),
        entry(local(2026, 9, 1, 9, 0), "更早.xlsx"),
      ],
      now,
    );
    expect(groups.map((group) => group.bucket)).toEqual(["today", "week", "earlier"]);
    expect(groups.map((group) => group.entries[0]!.name)).toEqual([
      "今天.xlsx",
      "这周.xlsx",
      "更早.xlsx",
    ]);
  });

  test("只有一组的，就只给一组（不显示空的「更早做的」标题）", () => {
    const groups = groupResults([entry(local(2026, 9, 16, 9, 0))], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bucket).toBe("today");
  });

  test("组内保持传进来的顺序（最近做的在前），不按时间重排", () => {
    const groups = groupResults(
      [
        entry(local(2026, 9, 16, 11, 0), "晚.xlsx"),
        entry(local(2026, 9, 16, 8, 0), "早.xlsx"),
      ],
      now,
    );
    expect(groups[0]!.entries.map((item) => item.name)).toEqual(["晚.xlsx", "早.xlsx"]);
  });

  test("不改动传进来的清单，也不改里面的条目", () => {
    const input = [
      entry(local(2026, 9, 16, 9, 0), "今天.xlsx"),
      entry(local(2026, 9, 1, 9, 0), "更早.xlsx"),
    ];
    const before = input.map((item) => item.key);
    groupResults(input, now);
    expect(input.map((item) => item.key)).toEqual(before);
  });

  test("空清单给空数组", () => {
    expect(groupResults([], now)).toEqual([]);
  });

  test("三组都有人时，每一组只装属于它的那些", () => {
    const groups = groupResults(
      [
        entry(local(2026, 9, 16, 9, 0), "今天A.xlsx"),
        entry(local(2026, 9, 16, 8, 0), "今天B.xlsx"),
        entry(local(2026, 9, 14, 9, 0), "本周.xlsx"),
        entry(local(2026, 8, 1, 9, 0), "很早.xlsx"),
      ],
      now,
    );
    const sizes: Record<ResultBucket, number> = { today: 0, week: 0, earlier: 0 };
    for (const group of groups) sizes[group.bucket] = group.entries.length;
    expect(sizes).toEqual({ today: 2, week: 1, earlier: 1 });
  });
});
