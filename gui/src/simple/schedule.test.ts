// #55 定时/重复任务的纯逻辑测试。
//
// 这里钉住三件事：下一次算得对（每周/每月/跨月/跨年/当天过没过/恰好等于）、
// 到点的判定不会一次补出好几次、以及说给用户听的是地道中文。
import { describe, expect, test } from "bun:test";

import {
  SCHEDULE_STORAGE_KEY,
  describeCadence,
  describe as describeSchedule,
  dueSchedules,
  newScheduleId,
  nextRunAfter,
  readSchedules,
  startOfDay,
  writeSchedules,
  type Schedule,
} from "./schedule.ts";

/** `month` 用 0–11，和 `Date` 的构造函数一致。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

function make(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch_test",
    cadence: "weekly",
    day: 1,
    hour: 9,
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
    files: ["/work/a.xlsx"],
    instruction: "把这两张表合成一张",
    createdAt: at(2026, 0, 1, 8),
    enabled: true,
    ...overrides,
  };
}

function parts(timestamp: number): { year: number; month: number; day: number; hour: number } {
  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
    hour: date.getHours(),
  };
}

describe("nextRunAfter —— 每天", () => {
  test("今天还没到点就是今天", () => {
    const next = nextRunAfter(make({ cadence: "daily", hour: 9 }), at(2026, 0, 1, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 1, hour: 9 });
  });

  test("今天已过点就顺延到明天", () => {
    const next = nextRunAfter(make({ cadence: "daily", hour: 9 }), at(2026, 0, 1, 10));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 2, hour: 9 });
  });

  test("恰好等于 from 时严格往后，不重复触发", () => {
    const next = nextRunAfter(make({ cadence: "daily", hour: 9 }), at(2026, 0, 1, 9));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 2, hour: 9 });
  });
});

describe("nextRunAfter —— 每周", () => {
  // 2026-01-01 是周四。
  test("本周指定的那天还没到，就是本周", () => {
    const next = nextRunAfter(make({ cadence: "weekly", day: 1, hour: 9 }), at(2026, 0, 1, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 5, hour: 9 });
  });

  test("就是今天、但还没到点，就是今天", () => {
    const next = nextRunAfter(make({ cadence: "weekly", day: 4, hour: 9 }), at(2026, 0, 1, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 1, hour: 9 });
  });

  test("就是今天、已经过点，就是下周同一天", () => {
    const next = nextRunAfter(make({ cadence: "weekly", day: 4, hour: 9 }), at(2026, 0, 1, 10));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 8, hour: 9 });
  });

  test("恰好等于 from 时严格往后", () => {
    const next = nextRunAfter(make({ cadence: "weekly", day: 4, hour: 9 }), at(2026, 0, 1, 9));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 8, hour: 9 });
  });

  test("跨月的周一算到下一月", () => {
    // 2026-01-28 是周三，下一个周一在 2 月 2 日。
    const next = nextRunAfter(make({ cadence: "weekly", day: 1, hour: 9 }), at(2026, 0, 28, 12));
    expect(parts(next)).toEqual({ year: 2026, month: 1, day: 2, hour: 9 });
  });

  test("跨年的周日算到下一年", () => {
    // 2026-12-31 是周四，下一个周日在 2027-01-03。
    const next = nextRunAfter(make({ cadence: "weekly", day: 0, hour: 9 }), at(2026, 11, 31, 12));
    expect(parts(next)).toEqual({ year: 2027, month: 0, day: 3, hour: 9 });
  });
});

describe("nextRunAfter —— 每月", () => {
  test("这个月还没到就是本月", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 0, 3, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 0, day: 5, hour: 9 });
  });

  test("这个月已经过点就顺延到下月", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 0, 6, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 1, day: 5, hour: 9 });
  });

  test("恰好等于 from 时严格往后", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 0, 5, 9));
    expect(parts(next)).toEqual({ year: 2026, month: 1, day: 5, hour: 9 });
  });

  test("跨年算到下一年的同一天", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 11, 10, 8));
    expect(parts(next)).toEqual({ year: 2027, month: 0, day: 5, hour: 9 });
  });

  test("闰年 2 月的 28 号照常存在", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 28, hour: 9 }), at(2028, 1, 1, 8));
    expect(parts(next)).toEqual({ year: 2028, month: 1, day: 28, hour: 9 });
  });

  test("大于 28 的日子被夹到 28，避免不存在的日期", () => {
    const next = nextRunAfter(make({ cadence: "monthly", day: 31, hour: 9 }), at(2026, 1, 1, 8));
    expect(parts(next)).toEqual({ year: 2026, month: 1, day: 28, hour: 9 });
  });
});

describe("dueSchedules", () => {
  const now = at(2026, 0, 12, 10);

  test("没开启的不会跑", () => {
    const schedule = make({ enabled: false, createdAt: at(2026, 0, 1, 8) });
    expect(dueSchedules([schedule], now)).toEqual([]);
  });

  test("到点了就返回它", () => {
    // 2026-01-05 是周一，早于 now。
    const schedule = make({ day: 1, hour: 9, createdAt: at(2026, 0, 1, 8) });
    expect(dueSchedules([schedule], now)).toEqual([schedule]);
  });

  test("还没到的不返回", () => {
    // createdAt 就是 now：下一次周一在 1/19，还没到。
    const later = make({ day: 1, hour: 9, createdAt: now });
    expect(dueSchedules([later], now)).toEqual([]);
    // 更早创建的同一个调度，下一次周一 1/12 09:00 已过，算到点。
    const schedule = make({ day: 1, hour: 9, createdAt: at(2026, 0, 6, 8) });
    expect(dueSchedules([schedule], now)).toHaveLength(1);
  });

  test("关机一周回来最多补一次", () => {
    // 三周前就该跑了，但只返回一次，不会一次涌出三次。
    const schedule = make({ day: 1, hour: 9, createdAt: at(2025, 11, 15, 8) });
    expect(dueSchedules([schedule], now)).toEqual([schedule]);
  });

  test("lastRunAt 去重：刚做过就不再触发", () => {
    const schedule = make({
      day: 1,
      hour: 9,
      createdAt: at(2025, 11, 15, 8),
      lastRunAt: now,
    });
    expect(dueSchedules([schedule], now)).toEqual([]);
  });

  test("lastRunAt 早于 now 且跨过了一个触发点，仍然算到点", () => {
    const schedule = make({
      day: 1,
      hour: 9,
      createdAt: at(2025, 11, 15, 8),
      lastRunAt: at(2026, 0, 5, 9, 30),
    });
    // 上次是 1/5 09:30 跑的，下一次是 1/12 09:00，早于 now。
    expect(dueSchedules([schedule], now)).toEqual([schedule]);
  });

  test("只挑到点的那些", () => {
    const due = make({ id: "due", day: 1, hour: 9, createdAt: at(2026, 0, 1, 8) });
    const notYet = make({ id: "later", day: 1, hour: 9, createdAt: at(2026, 0, 12, 11) });
    const off = make({ id: "off", day: 1, hour: 9, enabled: false, createdAt: at(2026, 0, 1, 8) });
    expect(dueSchedules([due, notYet, off], now).map((item) => item.id)).toEqual(["due"]);
  });
});

describe("describe —— 中文说法", () => {
  test("每天 / 每周 / 每月 都念得通", () => {
    expect(describeCadence("daily", 0, 9)).toBe("每天 09:00");
    expect(describeCadence("weekly", 1, 9)).toBe("每周一 09:00");
    expect(describeCadence("weekly", 0, 9)).toBe("每周日 09:00");
    expect(describeCadence("weekly", 6, 18)).toBe("每周六 18:00");
    expect(describeCadence("monthly", 5, 9)).toBe("每月5号 09:00");
  });

  test("describe(schedule) 读的就是它自己的设定", () => {
    expect(describeSchedule(make({ cadence: "weekly", day: 1, hour: 9 }))).toBe("每周一 09:00");
    expect(describeSchedule(make({ cadence: "daily", day: 0, hour: 8 }))).toBe("每天 08:00");
    expect(describeSchedule(make({ cadence: "monthly", day: 5, hour: 9 }))).toBe("每月5号 09:00");
  });

  test("全中文，且不含禁用的术语", () => {
    const forbidden = ["模型", "provider", "token", "prompt", "会话", "上下文", "权限", "路径", "API"];
    for (const text of [
      describeCadence("daily", 0, 9),
      describeCadence("weekly", 3, 9),
      describeCadence("monthly", 28, 21),
    ]) {
      // 只允许中文、数字和冒号空格。
      expect(text).toMatch(/^[\u4e00-\u9fa5\d号: ]+$/);
      for (const word of forbidden) expect(text).not.toContain(word);
    }
  });
});

describe("存储", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      map,
    };
  }

  test("写进去再读回来还是原来那些", () => {
    const storage = fakeStorage();
    const schedules = [make({ id: "sch_a" }), make({ id: "sch_b", enabled: false })];
    writeSchedules(schedules, storage);
    expect(readSchedules(storage)).toEqual(schedules);
  });

  test("坏 JSON 当空，不抛错", () => {
    const storage = fakeStorage({ [SCHEDULE_STORAGE_KEY]: "{ 这不是 json" });
    expect(readSchedules(storage)).toEqual([]);
  });

  test("不是数组、条目缺字段都当空/跳过", () => {
    expect(readSchedules(fakeStorage({ [SCHEDULE_STORAGE_KEY]: JSON.stringify({ id: "x" }) }))).toEqual([]);
    const mixed = fakeStorage({
      [SCHEDULE_STORAGE_KEY]: JSON.stringify([
        null,
        { id: "only-id" },
        { ...make({ id: "ok" }), cadence: "hourly" },
        make({ id: "good" }),
      ]),
    });
    expect(readSchedules(mixed).map((item) => item.id)).toEqual(["good"]);
  });

  test("没有存储时不抛错", () => {
    expect(readSchedules(null)).toEqual([]);
    expect(() => writeSchedules([make()], null)).not.toThrow();
  });
});

describe("小工具", () => {
  test("startOfDay 抹掉钟点，保留本地日期", () => {
    const start = startOfDay(at(2026, 0, 5, 13, 45));
    expect(parts(start)).toEqual({ year: 2026, month: 0, day: 5, hour: 0 });
  });

  test("newScheduleId 不重样", () => {
    const ids = new Set([newScheduleId(), newScheduleId(), newScheduleId()]);
    expect(ids.size).toBe(3);
  });
});
