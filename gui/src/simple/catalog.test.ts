// 能力中心的检索逻辑（#74）。catalog.ts 是纯函数，所以这里只测行为和顺序，
// 不碰界面：同义词能不能搜到、标题命中有没有排在前面、空搜索词是不是全部、
// 组的顺序对不对、以及「这台电脑现在做不到」的诚实边界。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { IMAGE_TYPES, availabilityHint, groupTasks, searchTasks } from "./catalog.ts";
import { LIBRARY } from "./copy-library.ts";
import { TASKS, type TaskDef, type TaskGroup } from "./tasks/index.ts";

function ids(tasks: TaskDef[]): string[] {
  return tasks.map((task) => task.id);
}

/** 造一张只用于测试的卡片，字段都有默认值，只覆盖需要的那几个。 */
function fakeTask(over: Partial<TaskDef> & { id: string }): TaskDef {
  return {
    id: over.id,
    title: over.title ?? "示例任务",
    example: over.example ?? "示例一句话",
    group: over.group ?? "资料",
    needs: over.needs ?? "files",
    accept: over.accept,
    plan: over.plan ?? ["第一件事", "第二件事", "第三件事", "结果另存为新文件"],
    risks: over.risks ?? ["一条具体、能核对的说明。"],
    prompt: over.prompt ?? (() => "示例说明"),
    summaryHints: over.summaryHints ?? ["第一项", "第二项"],
  };
}

describe("按「想做的事」搜索", () => {
  test("用户嘴里的说法能搜到对应的卡片（同义词表）", () => {
    const cases: Array<[string, string]> = [
      // 合并 / 汇总
      ["合并", "excel.merge"],
      ["合起来", "excel.merge"],
      ["并成一张", "excel.merge"],
      ["汇总", "excel.group"],
      // 去重
      ["去重", "excel.merge"],
      ["重复", "excel.merge"],
      ["重了", "excel.merge"],
      // 对账 / 比对
      ["对账", "excel.diff"],
      ["查差异", "excel.diff"],
      ["比对", "excel.diff"],
      // 筛选
      ["筛选", "excel.filter"],
      ["挑出", "excel.filter"],
      ["找出", "files.dupes"],
      // 拆分
      ["拆分", "excel.split"],
      ["拆成", "excel.split"],
      // 改名
      ["改名", "files.rename"],
      ["重命名", "files.rename"],
      // 归档 / 按月份
      ["归档", "files.archive"],
      ["整理", "excel.tidy"],
      ["分类", "files.archive"],
      ["按月份", "files.by-date"],
      // 微信
      ["微信", "wechat.table"],
      ["聊天", "wechat.table"],
      ["群", "wechat.table"],
      // PDF / 扫描件
      ["pdf", "pdf.merge"],
      ["扫描件", "pdf.toword"],
      // 总结
      ["总结", "doc.summary"],
      ["摘要", "doc.summary"],
      // 文书
      ["通知", "doc.notice"],
      ["请假", "doc.leave"],
      ["周报", "doc.report"],
    ];
    for (const [query, id] of cases) {
      expect(ids(searchTasks(query))).toContain(id);
    }
  });

  test("组名也能当搜索词", () => {
    const hits = searchTasks("文书");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((task) => task.group === "文书")).toBe(true);
    expect(ids(hits)).toContain("doc.summary");
  });

  test("排序：标题命中 > 组名/示例命中 > 计划文字命中", () => {
    // 「整理」在 excel.tidy 的标题里、在 files.archive 的示例里、
    // 在 files.dupes 的计划步骤里。
    const results = ids(searchTasks("整理"));
    const title = results.indexOf("excel.tidy");
    const example = results.indexOf("files.archive");
    const plan = results.indexOf("files.dupes");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(example).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(title).toBeLessThan(example);
    expect(example).toBeLessThan(plan);
  });

  test("同分时保持目录原顺序（常用的在前）", () => {
    // 期望值写死而不是从 TASKS 推导：这样"目录顺序变了"会被人看见并审一遍，
    // 而不是悄悄跟着变。接龙/报名两张卡（#86）排在原来的三张之后，因为它们是
    // "更专门的场景"，遇到「微信」这个词时，通用卡先出现更符合直觉。
    const results = ids(searchTasks("微信")).filter((id) => id.startsWith("wechat."));
    expect(results).toEqual([
      "wechat.table",
      "wechat.draft",
      "wechat.batch",
      "wechat.rollcall",
      "wechat.missing",
    ]);
  });

  test("空搜索词（含纯空白）返回全部，顺序不变", () => {
    const all = ids(TASKS);
    expect(ids(searchTasks(""))).toEqual(all);
    expect(ids(searchTasks("   "))).toEqual(all);
  });

  test("大小写和空格都不影响结果", () => {
    expect(ids(searchTasks("  PDF "))).toEqual(ids(searchTasks("pdf")));
    expect(ids(searchTasks("把PDF转成word"))).toContain("pdf.toword");
    expect(ids(searchTasks("把 pdf 转成 word"))).toContain("pdf.toword");
  });

  test("搜不到就老实返回空", () => {
    expect(searchTasks("怎么养一只会写代码的猫")).toEqual([]);
  });

  test("可以只在给定的卡片里搜", () => {
    const sheets = TASKS.filter((task) => task.group === "表格");
    const hits = searchTasks("表格", sheets);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((task) => task.group === "表格")).toBe(true);
    expect(searchTasks("微信", sheets)).toEqual([]);
  });
});

describe("分组", () => {
  test("组的顺序固定为 表格、文件、微信、文书、资料，且不返回空组", () => {
    const order: TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];
    const groups = groupTasks();
    const present = groups.map((section) => section.group);
    // Only non-empty groups appear, and they keep the fixed order.
    for (const group of order) {
      const hasCards = TASKS.some((task) => task.group === group);
      if (hasCards) expect(present).toContain(group);
      else expect(present).not.toContain(group);
    }
    const ranks = present.map((group) => order.indexOf(group));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const section of groups) expect(section.tasks.length).toBeGreaterThan(0);
    // 每个任务都恰好落在自己的组里。
    expect(groups.flatMap((section) => section.tasks).length).toBe(TASKS.length);
  });

  test("组里的顺序照目录的原顺序", () => {
    const tables = groupTasks().find((section) => section.group === "表格")!;
    expect(ids(tables.tasks)).toEqual(ids(TASKS.filter((task) => task.group === "表格")));
  });

  test("只给一部分卡片时，只返回这些卡片所在的组", () => {
    const writing = groupTasks(TASKS.filter((task) => task.group === "文书"));
    expect(writing.map((section) => section.group)).toEqual(["文书"]);
    for (const section of writing) {
      expect(section.tasks.every((task) => task.group === "文书")).toBe(true);
    }
  });

  test("空目录返回空数组", () => {
    expect(groupTasks([])).toEqual([]);
  });
});

describe("诚实边界：现在能不能做", () => {
  test("能看图时，没有任何任务被标成做不到", () => {
    // 这条边界现在取决于模型能力：能看图就把要图片的卡照常展示。
    for (const task of TASKS) expect(availabilityHint(task, true)).toBeNull();
  });

  test("看不了图时，只有「要读图片」的任务会被如实标注", () => {
    const photo = fakeTask({ id: "photo.table", needs: "files", accept: ["png", "jpg", "jpeg"] });
    expect(availabilityHint(photo, false)).toBe(LIBRARY.unavailableImage);
    expect(availabilityHint(photo, false)).toContain("图片");
    // 同一张卡在能看图的模型上不再被标注。
    expect(availabilityHint(photo, true)).toBeNull();

    // 其余任务在任何模型上都不该被这条规则误标。
    for (const task of TASKS) {
      const acceptsImages = (task.accept ?? []).some((ext) => IMAGE_TYPES.has(ext.toLowerCase()));
      if (acceptsImages) continue;
      expect(availabilityHint(task, false)).toBeNull();
      expect(availabilityHint(task, true)).toBeNull();
    }
  });

  test("后缀的大小写不影响判断", () => {
    expect(availabilityHint(fakeTask({ id: "photo.x", accept: ["JPG", "PNG"] }))).toBe(
      LIBRARY.unavailableImage,
    );
  });

  test("文件夹任务和不用文件的任务不会被误标", () => {
    expect(availabilityHint(fakeTask({ id: "folder.one", needs: "folder" }))).toBeNull();
    expect(availabilityHint(fakeTask({ id: "text.one", needs: "text", accept: ["png"] }))).toBeNull();
  });

  test("要选文件但没写后缀的任务照常能做", () => {
    expect(availabilityHint(fakeTask({ id: "files.any", accept: undefined }))).toBeNull();
  });

  test("查不到的历史 id 不会在这里出现（函数只认卡片本身）", () => {
    expect(availabilityHint(fakeTask({ id: "excel.merge", accept: ["xlsx", "xls", "csv"] }))).toBeNull();
  });
});
