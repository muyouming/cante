// r17 — 「我做的结果」纯逻辑测试。
//
// 面板上唯一不能含糊的三件事都在这里钉住：
//   * 顺序——最近做的那件排最上面（她记的是「上周那张表」，不是文件名）；
//   * 搜索——按文件名/卡片名/她说过的话都能找到，全角半角一视同仁；
//   * 现状——本机说在就是在，说不在了就说不在了，没核对到就说没核对到。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { canOpen, collectResults, resultCount, resultPaths, searchResults } from "./results.ts";
import { emptyImpact, type RunResultFile, type TaskRun } from "./run.ts";
import type { FileFact } from "./verify.ts";

function run(overrides: Partial<TaskRun> & Pick<TaskRun, "id" | "state">): TaskRun {
  return {
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张",
    files: [],
    instruction: "",
    plan: ["第一步"],
    impact: emptyImpact(),
    result: null,
    online: false,
    error: null,
    createdAt: 0,
    ...overrides,
  };
}

function result(...files: Array<string | RunResultFile>): TaskRun["result"] {
  return {
    files: files.map((file) => (typeof file === "string" ? { path: file, summary: "新增" } : file)),
    summary: "新增 1 个文件",
  };
}

function fact(path: string, overrides: Partial<FileFact> = {}): FileFact {
  return { path, exists: true, size: 1024, modifiedMs: 0, readable: true, ...overrides };
}

describe("collectResults：清单和顺序", () => {
  test("最近做的排最上面，不受输入顺序影响", () => {
    const runs = [
      run({ id: "old", state: "done", createdAt: 100, result: result("C:/桌面/旧表.xlsx") }),
      run({ id: "new", state: "done", createdAt: 900, result: result("C:/桌面/新表.xlsx") }),
      run({ id: "mid", state: "done", createdAt: 500, result: result("C:/桌面/中间.xlsx") }),
    ];
    expect(collectResults(runs, null).map((entry) => entry.name)).toEqual([
      "新表.xlsx",
      "中间.xlsx",
      "旧表.xlsx",
    ]);
  });

  test("同一次做出来的几个文件保持原来的顺序", () => {
    const runs = [
      run({
        id: "a",
        state: "done",
        createdAt: 100,
        result: result("C:/桌面/汇总.xlsx", "C:/桌面/明细.xlsx"),
      }),
    ];
    expect(collectResults(runs, null).map((entry) => entry.name)).toEqual([
      "汇总.xlsx",
      "明细.xlsx",
    ]);
  });

  test("没生成文件的记录不上榜；没做完但留下了文件的照实列出来", () => {
    const runs = [
      run({ id: "empty", state: "done", createdAt: 300, result: null }),
      run({ id: "failed", state: "failed", createdAt: 200, result: result("C:/桌面/半成品.xlsx") }),
      run({ id: "zero", state: "done", createdAt: 100, result: { files: [], summary: "没有改动" } }),
    ];
    const entries = collectResults(runs, null);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("半成品.xlsx");
    expect(entries[0]!.state).toBe("failed");
  });

  test("每一条带着来自哪张卡、她说的那句话、什么时候做的", () => {
    const entries = collectResults(
      [
        run({
          id: "a",
          state: "done",
          createdAt: 1_700_000_000_000,
          taskTitle: "微信报名名单",
          instruction: "只留今年的",
          result: result("C:/桌面/名单.xlsx"),
        }),
      ],
      null,
    );
    const entry = entries[0]!;
    expect(entry.title).toBe("微信报名名单");
    expect(entry.instruction).toBe("只留今年的");
    expect(entry.createdAt).toBe(1_700_000_000_000);
    expect(entry.folder).toBe("C:/桌面");
    expect(entry.key).toBe("a|C:/桌面/名单.xlsx");
  });

  test("Windows 的反斜杠位置也能拆出文件名和文件夹", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:\\Users\\<用户名>\\Desktop\\报表.xlsx") })],
      null,
    );
    expect(entries[0]!.name).toBe("报表.xlsx");
    expect(entries[0]!.folder).toBe("C:\\Users\\<用户名>\\Desktop");
  });
});

describe("collectResults：现在还在不在", () => {
  test("本机说在、能打开 → present，并带上大小", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") })],
      [fact("C:/桌面/报表.xlsx", { size: 2048 })],
    );
    expect(entries[0]!.presence).toBe("present");
    expect(entries[0]!.size).toBe(2048);
    expect(canOpen(entries[0]!)).toBe(true);
  });

  test("本机说不在了 → missing，不假装它还在，也不让她去点开", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") })],
      [fact("C:/桌面/报表.xlsx", { exists: false, size: null, readable: false })],
    );
    expect(entries[0]!.presence).toBe("missing");
    expect(canOpen(entries[0]!)).toBe(false);
  });

  test("文件在、却打不开 → unreadable（和「不在了」不是一回事）", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") })],
      [fact("C:/桌面/报表.xlsx", { readable: false })],
    );
    expect(entries[0]!.presence).toBe("unreadable");
    expect(canOpen(entries[0]!)).toBe(true);
  });

  test("没问成本机（null）→ unknown，绝不假装核对过", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") })],
      null,
    );
    expect(entries[0]!.presence).toBe("unknown");
    expect(entries[0]!.size).toBeNull();
  });

  test("本机的回答里根本没提这个文件 → 也算没能核对，不当成不在", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") })],
      [fact("C:/桌面/别的.xlsx")],
    );
    expect(entries[0]!.presence).toBe("unknown");
  });

  test("一次做出来的几个文件可以一个在、一个不在", () => {
    const entries = collectResults(
      [run({ id: "a", state: "done", result: result("C:/桌面/在.xlsx", "C:/桌面/不在.xlsx") })],
      [
        fact("C:/桌面/在.xlsx"),
        fact("C:/桌面/不在.xlsx", { exists: false, size: null, readable: false }),
      ],
    );
    expect(entries.map((entry) => entry.presence)).toEqual(["present", "missing"]);
  });
});

describe("searchResults：按文件名/卡片名找", () => {
  const entries = collectResults(
    [
      run({
        id: "a",
        state: "done",
        createdAt: 300,
        taskTitle: "把几张表合成一张",
        instruction: "只留今年的客户",
        result: result("C:/桌面/销售汇总.xlsx"),
      }),
      run({
        id: "b",
        state: "done",
        createdAt: 200,
        taskTitle: "微信报名名单",
        instruction: "",
        result: result("C:/桌面/报名名单.xlsx"),
      }),
    ],
    null,
  );

  test("命中文件名", () => {
    expect(searchResults(entries, "汇总").map((entry) => entry.name)).toEqual(["销售汇总.xlsx"]);
  });

  test("命中卡片名", () => {
    expect(searchResults(entries, "报名").map((entry) => entry.name)).toEqual(["报名名单.xlsx"]);
  });

  test("命中她当时说的那句话", () => {
    expect(searchResults(entries, "今年").map((entry) => entry.name)).toEqual(["销售汇总.xlsx"]);
  });

  test("全角数字/字母/标点折成半角再比，中文不被切开", () => {
    const withFullWidth = collectResults(
      [run({ id: "c", state: "done", result: result("C:/桌面/客户（AＢＣ）.xlsx") })],
      null,
    );
    expect(searchResults(withFullWidth, "abc")).toHaveLength(1);
    expect(searchResults(withFullWidth, "客户(abc)")).toHaveLength(1);
    expect(searchResults(withFullWidth, "客户 abc")).toHaveLength(0);
  });

  test("空搜索词返回全部，保持原顺序", () => {
    expect(searchResults(entries, "   ").map((entry) => entry.runId)).toEqual(["a", "b"]);
  });

  test("没命中返回空数组，让界面去给出路", () => {
    expect(searchResults(entries, "不存在的表")).toEqual([]);
  });

  test("搜索不改动传进来的清单", () => {
    const before = entries.map((entry) => entry.key);
    searchResults(entries, "名单");
    expect(entries.map((entry) => entry.key)).toEqual(before);
  });
});

describe("resultPaths / resultCount：首页入口要的数字", () => {
  test("位置去重，但件数按「哪一次做的」算", () => {
    const runs = [
      run({ id: "a", state: "done", result: result("C:/桌面/报表.xlsx") }),
      run({ id: "b", state: "done", result: result("C:/桌面/报表.xlsx") }),
      run({ id: "c", state: "done", result: null }),
    ];
    expect(resultPaths(runs)).toEqual(["C:/桌面/报表.xlsx"]);
    expect(resultCount(runs)).toBe(2);
  });

  test("一件都没做过时是空的，首页不会问本机", () => {
    expect(resultPaths([])).toEqual([]);
    expect(resultCount([run({ id: "a", state: "done" })])).toBe(0);
  });

  test("空位置和重复位置都被丢掉", () => {
    const runs = [
      run({
        id: "a",
        state: "done",
        result: result("", "C:/桌面/报表.xlsx", "C:/桌面/报表.xlsx"),
      }),
    ];
    expect(resultPaths(runs)).toEqual(["C:/桌面/报表.xlsx"]);
    // 清单、件数和首页那个数字必须是同一本账。
    expect(resultCount(runs)).toBe(1);
    expect(collectResults(runs, null)).toHaveLength(1);
  });
});
