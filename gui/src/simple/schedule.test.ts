// #55 定时/重复任务的纯逻辑测试。
//
// 这里钉住三件事：下一次算得对（每周/每月/跨月/跨年/当天过没过/恰好等于）、
// 到点的判定不会一次补出好几次、以及说给用户听的是地道中文。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SCHEDULE } from "./copy-schedule.ts";
import {
  CATCH_UP_GRACE_MS,
  SCHEDULE_STORAGE_KEY,
  catchUpScheduleFor,
  describeCadence,
  describe as describeSchedule,
  dueSchedules,
  isCatchUp,
  newScheduleId,
  nextRunAfter,
  readSchedules,
  startOfDay,
  writeSchedules,
  type Schedule,
} from "./schedule.ts";

const HERE = import.meta.dir;
/** 首页的接线：只看它**真的渲染了哪个键**，不是只看常量存在。 */
const HOME = readFileSync(join(HERE, "Home.tsx"), "utf8");
/** 结果卡片是「以后自动做」的设置界面，本轮不许改它，但要验证它渲染的句子含前提。 */
const RESULT_CARD = readFileSync(join(HERE, "ResultCard.tsx"), "utf8");

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

describe("以后自动做的前提只能在场，不能被瞒着", () => {
  test("那句话本身是一句完整的中文，没有技术词", () => {
    expect(SCHEDULE.mustBeOpen).toContain("开着");
    expect(SCHEDULE.mustBeOpen).toContain("到点");
    expect(SCHEDULE.mustBeOpen).toMatch(/[\u4e00-\u9fa5]/);
    for (const word of ["模型", "token", "会话", "上下文", "路径"]) {
      expect(SCHEDULE.mustBeOpen).not.toContain(word);
    }
  });

  test("首页真的把它渲染出来（断言用到的键，不是只断言常量存在）", () => {
    // 首页「下次什么时候做」旁边必须真的出现这一句。
    expect(HOME).toContain("{SCHEDULE.mustBeOpen}");
  });

  test("设置界面（结果卡片）那句话也含前提：改的是它渲染的 intro", () => {
    // 设置界面渲染的是 SCHEDULE.intro（见 ResultCard 的 `{SCHEDULE.intro}`），
    // 所以前提必须真的落进 intro 里，而不是另起一个没人渲染的键。
    expect(RESULT_CARD).toContain("{SCHEDULE.intro}");
    expect(SCHEDULE.intro).toContain(SCHEDULE.mustBeOpen);
  });

  test("补上那一次的说法，首页在确认页上真的用到了它", () => {
    expect(SCHEDULE.catchUp).toContain("错过的");
    expect(HOME).toContain("SCHEDULE.catchUp");
  });
});

describe("是不是「错过以后补上的」（isCatchUp）", () => {
  test("正常到点：离钟点几十秒，不算补的", () => {
    const schedule = make({ cadence: "weekly", day: 1, hour: 9 });
    // 2026-01-05 是周一，09:00 整点；47 秒后算正常到点。
    expect(isCatchUp(schedule, at(2026, 0, 5, 9, 0) + 47_000)).toBe(false);
  });

  test("关机一周回来：离上个钟点好几天，算补的", () => {
    // 周一 09:00 该做，她周三 10:00 才开机——已经过去两天。
    const schedule = make({ cadence: "weekly", day: 1, hour: 9 });
    expect(isCatchUp(schedule, at(2026, 0, 7, 10))).toBe(true);
  });

  test("刚过宽限就算补的（边界）", () => {
    const schedule = make({ cadence: "daily", hour: 9 });
    const slot = at(2026, 0, 5, 9, 0);
    expect(isCatchUp(schedule, slot + CATCH_UP_GRACE_MS)).toBe(false);
    expect(isCatchUp(schedule, slot + CATCH_UP_GRACE_MS + 1)).toBe(true);
  });

  test("每天/每月也认得出补的那一次", () => {
    expect(isCatchUp(make({ cadence: "daily", hour: 9 }), at(2026, 0, 5, 23))).toBe(true);
    expect(isCatchUp(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 0, 12, 9))).toBe(true);
    expect(isCatchUp(make({ cadence: "monthly", day: 5, hour: 9 }), at(2026, 0, 5, 9, 0) + 5_000)).toBe(false);
  });
});

describe("关机一周回来只补一次，而且认得出是补的", () => {
  const now = at(2026, 0, 7, 10); // 周三 10:00 开机
  const schedule = make({
    cadence: "weekly",
    day: 1,
    hour: 9,
    createdAt: at(2025, 11, 15, 8),
  });

  test("dueSchedules 只补一次，不会一次涌出多次", () => {
    expect(dueSchedules([schedule], now)).toEqual([schedule]);
  });

  test("这一次被认成补上的：摆上确认页的那一刻就带这个事实", () => {
    const run = { taskId: schedule.taskId, instruction: schedule.instruction, createdAt: now };
    // runScheduled 摆上确认页时把 lastRunAt 记成同一时刻。
    const staged: Schedule = { ...schedule, lastRunAt: now };
    expect(catchUpScheduleFor([staged], run)).toEqual(staged);
  });
});

describe("确认页上这件到底是不是自动补的（catchUpScheduleFor）", () => {
  const now = at(2026, 0, 7, 10);
  const base = make({ cadence: "weekly", day: 1, hour: 9, lastRunAt: now });
  const run = { taskId: base.taskId, instruction: base.instruction, createdAt: now };

  test("正常到点：离钟点很近，返回 null（不冤枉成补的）", () => {
    const onTimeRun = { ...run, createdAt: at(2026, 0, 5, 9, 0) + 30_000 };
    const staged = { ...base, lastRunAt: onTimeRun.createdAt };
    expect(catchUpScheduleFor([staged], onTimeRun)).toBeNull();
  });

  test("她手动做同样一件事：对不上 lastRunAt，不算自动补的", () => {
    const manual = { taskId: base.taskId, instruction: base.instruction, createdAt: now };
    // 手动那次没有把 lastRunAt 记成现在。
    expect(catchUpScheduleFor([make({ cadence: "weekly", day: 1, hour: 9 })], manual)).toBeNull();
  });

  test("不是同一句话或不是同一张卡，都不算", () => {
    expect(catchUpScheduleFor([base], { ...run, instruction: "换个说法" })).toBeNull();
    expect(catchUpScheduleFor([base], { ...run, taskId: "excel.other" })).toBeNull();
  });

  test("停掉的调度不参与", () => {
    const off = make({ cadence: "weekly", day: 1, hour: 9, lastRunAt: now, enabled: false });
    expect(catchUpScheduleFor([off], run)).toBeNull();
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
