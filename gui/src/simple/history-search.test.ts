// #57 — pure tests for 历史搜索 + 再跑一次。
//
// These pin the three things the history screen trusts: normalize folds 全角 to
// 半角 without touching Chinese, searchRuns looks in the four places she can
// remember (标题 / 她说过的话 / 选过的文件名 / 结果文件名) and never reorders,
// and rerunInput keeps old records runnable even after their card is gone.
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { normalize, rerunInput, searchRuns } from "./history-search.ts";
import { emptyImpact, type TaskRun } from "./run.ts";
import { FREE_TEXT_TASK_ID, TASKS, freeTask } from "./tasks/index.ts";

function run(overrides: Partial<TaskRun> & Pick<TaskRun, "id" | "taskId" | "state">): TaskRun {
  return {
    taskTitle: "把几张表合成一张",
    files: [],
    instruction: "",
    plan: ["第一步", "第二步", "第三步"],
    impact: emptyImpact(),
    result: null,
    online: false,
    error: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("normalize", () => {
  test("全角数字、字母和常用标点都折成半角", () => {
    expect(normalize("ＡＢＣ１２３")).toBe("abc123");
    expect(normalize("（客户），名单：３")).toBe("(客户),名单:3");
    expect(normalize("１月")).toBe("1月");
  });

  test("大写折成小写", () => {
    expect(normalize("Excel 报表ABC")).toBe("excel 报表abc");
  });

  test("连续空白压成一个空格，首尾空白去掉（含全角空格）", () => {
    expect(normalize("  客户    名单  ")).toBe("客户 名单");
    expect(normalize("\u3000报表\u3000")).toBe("报表");
    expect(normalize("客户\u3000名单")).toBe("客户 名单");
  });

  test("中文本身不被切开，也不会被插进空白", () => {
    expect(normalize("上个月的客户名单")).toBe("上个月的客户名单");
    expect(normalize("微信 报名")).toBe("微信 报名");
  });

  test("空字符串是安全的", () => {
    expect(normalize("")).toBe("");
    expect(normalize("   ")).toBe("");
  });
});

describe("searchRuns", () => {
  test("命中任务标题", () => {
    const runs = [run({ id: "a", taskId: "excel.merge", state: "done" })];
    expect(searchRuns(runs, "合成")).toEqual(runs);
  });

  test("命中用户自己说过的话", () => {
    const runs = [
      run({
        id: "a",
        taskId: FREE_TEXT_TASK_ID,
        state: "done",
        taskTitle: "直接说一件事",
        instruction: "把上个月那张表再弄一遍",
      }),
    ];
    expect(searchRuns(runs, "上个月那张表")).toEqual(runs);
  });

  test("命中选过的中文文件名，而不是整个文件夹路径", () => {
    const runs = [
      run({
        id: "a",
        taskId: "excel.merge",
        state: "done",
        files: ["C:\\Users\\王姐\\Desktop\\报名表.xlsx"],
      }),
    ];
    expect(searchRuns(runs, "报名")).toEqual(runs);
  });

  test("命中结果文件名", () => {
    const runs = [
      run({
        id: "a",
        taskId: "excel.merge",
        state: "done",
        result: {
          files: [{ path: "C:\\结果\\汇总名单.xlsx", summary: "新增" }],
          summary: "新增 1 个文件",
        },
      }),
    ];
    expect(searchRuns(runs, "汇总名单")).toEqual(runs);
  });

  test("全角搜索词能搜到半角内容，大小写不影响", () => {
    const runs = [run({ id: "a", taskId: "excel.merge", state: "done", taskTitle: "1月报表 ABC" })];
    expect(searchRuns(runs, "１月")).toEqual(runs);
    expect(searchRuns(runs, "abc")).toEqual(runs);
  });

  test("空搜索词返回全部，并且保持原有顺序", () => {
    const newest = run({ id: "new", taskId: "excel.merge", state: "done", createdAt: 2 });
    const oldest = run({ id: "old", taskId: "excel.merge", state: "done", createdAt: 1 });
    const runs = [newest, oldest];
    expect(searchRuns(runs, "").map((item) => item.id)).toEqual(["new", "old"]);
    expect(searchRuns(runs, "   ").map((item) => item.id)).toEqual(["new", "old"]);
  });

  test("搜不到就是空数组", () => {
    const runs = [run({ id: "a", taskId: "excel.merge", state: "done" })];
    expect(searchRuns(runs, "完全不存在的词")).toEqual([]);
  });

  test("多条命中时还是最近的在前", () => {
    const newest = run({
      id: "new",
      taskId: "excel.merge",
      state: "done",
      createdAt: 2,
      taskTitle: "客户名单汇总",
    });
    const oldest = run({
      id: "old",
      taskId: "excel.merge",
      state: "done",
      createdAt: 1,
      taskTitle: "客户名单去重",
    });
    expect(searchRuns([newest, oldest], "客户名单").map((item) => item.id)).toEqual([
      "new",
      "old",
    ]);
  });

  test("只返回命中的那几条", () => {
    const hit = run({ id: "hit", taskId: "excel.merge", state: "done", taskTitle: "微信报名名单" });
    const miss = run({ id: "miss", taskId: "excel.merge", state: "done", taskTitle: "报销单汇总" });
    expect(searchRuns([hit, miss], "微信").map((item) => item.id)).toEqual(["hit"]);
  });
});

describe("rerunInput", () => {
  test("认识的卡片用今天的任务定义，原文不动", () => {
    const definition = TASKS[0]!;
    const old = run({
      id: "a",
      taskId: definition.id,
      state: "done",
      taskTitle: "旧版本里的名字",
      files: ["C:\\表\\一.xlsx", "C:\\表\\二.xlsx"],
      instruction: "只留重复的",
    });
    const input = rerunInput(old);
    expect(input.task.id).toBe(definition.id);
    expect(input.task.title).toBe(definition.title);
    expect(input.task.plan).toEqual(definition.plan);
    expect(input.files).toEqual(old.files);
    expect(input.instruction).toBe("只留重复的");
  });

  test("不认识的卡片退回自由任务，并带上原来的标题和话", () => {
    const old = run({
      id: "a",
      taskId: "旧版本.已经删掉的卡",
      state: "done",
      taskTitle: "把这几张表弄一下",
      files: ["C:\\表\\一.xlsx"],
      instruction: "按月份分开，各存一份",
    });
    const input = rerunInput(old);
    expect(input.task.id).toBe(FREE_TEXT_TASK_ID);
    expect(input.task.title).toBe("把这几张表弄一下");
    expect(input.task.plan).toEqual(freeTask(old.instruction).plan);
    expect(input.files).toEqual(old.files);
    expect(input.instruction).toBe("按月份分开，各存一份");
  });

  test("自由说出来的记录本来就没有卡片，同样能再跑", () => {
    const old = run({
      id: "a",
      taskId: FREE_TEXT_TASK_ID,
      state: "done",
      taskTitle: "直接说一件事",
      instruction: "把桌面上的表格按月份分好",
    });
    const input = rerunInput(old);
    expect(input.task.id).toBe(FREE_TEXT_TASK_ID);
    expect(input.task.title).toBe("直接说一件事");
    expect(input.instruction).toBe("把桌面上的表格按月份分好");
  });

  test("旧记录没有标题时，用自由任务自己的名字，不留空", () => {
    const old = run({ id: "a", taskId: "不清楚的旧卡", state: "done", taskTitle: "  " });
    const input = rerunInput(old);
    expect(input.task.title).toBe(freeTask(old.instruction).title);
  });
});
