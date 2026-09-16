// 「帮我检查」两张卡片的回归测试（#84 核对族）。
//
// 这两张卡和别的任务不一样：它们不产出新内容，只把账核一遍。所以这里除了
// 常规的形状检查，重点钉住三件用户看得见的事——
//   1) 合计卡必须分清「我检查了什么」和「我拿不准什么」，并且把差额算出来，
//      不许直接下「错了」的结论；
//   2) 对账卡必须先问用户按哪一列对，结论固定三桶且每条带来源行号；
//   3) 对账卡不许把「对不上」说成「对方少给了钱」。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { CHECK_TASKS } from "./check.ts";
import type { TaskDef } from "./types.ts";

/** 王姐不该在界面上看到的词（和 tasks.test.ts 同一份红线）。 */
const JARGON = [
  "模型",
  "令牌",
  "会话",
  "上下文",
  "权限",
  "路径",
  "工具调用",
  "提示词",
  "token",
  "provider",
  "prompt",
  "diff",
  "worktree",
  "json",
  "api",
  "agent",
];

function byId(id: string): TaskDef {
  const task = CHECK_TASKS.find((item) => item.id === id);
  if (!task) throw new Error(`缺少卡片：${id}`);
  return task;
}

/** 卡片里所有用户会读到的文字。 */
function everyString(task: TaskDef): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: "title", text: task.title },
    { where: "example", text: task.example },
  ];
  task.plan.forEach((step, index) => out.push({ where: `plan[${index}]`, text: step }));
  (task.risks ?? []).forEach((risk, index) => out.push({ where: `risks[${index}]`, text: risk }));
  task.summaryHints.forEach((hint, index) => out.push({ where: `summaryHints[${index}]`, text: hint }));
  return out;
}

describe("核对族的形状", () => {
  test("正好两张卡，都在表格组、都要选文件", () => {
    expect(CHECK_TASKS.map((task) => task.id)).toEqual(["check.totals", "check.reconcile"]);
    for (const task of CHECK_TASKS) {
      expect(task.group).toBe("表格");
      expect(task.needs).toBe("files");
      expect(task.accept).toContain("xlsx");
      expect(task.accept).toContain("xls");
      expect(task.accept).toContain("csv");
    }
  });

  test("卡片编号是稳定的形态", () => {
    for (const task of CHECK_TASKS) {
      expect(task.id).toMatch(/^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*$/);
    }
  });

  test("每张卡都写全了：plan 四步、risks 三到四条、summaryHints 四条", () => {
    for (const task of CHECK_TASKS) {
      expect(task.title.length).toBeGreaterThan(3);
      expect(task.example.length).toBeGreaterThan(5);
      expect(task.plan.length).toBe(4);
      expect(task.risks?.length).toBeGreaterThanOrEqual(3);
      expect(task.risks?.length).toBeLessThanOrEqual(4);
      expect(task.summaryHints.length).toBe(4);
      // 最后一步永远是说结果怎么放、原表不动。
      expect(task.plan.join("")).toMatch(/另存/);
      expect(task.plan.join("")).toMatch(/不动|不要动/);
    }
  });

  test("风险条目具体到能对着自己的文件核，不是一句免责声明", () => {
    const FILLER = ["仅供参考", "可能有误", "如有误差", "不保证", "不一定完全准确"];
    for (const task of CHECK_TASKS) {
      for (const risk of task.risks ?? []) {
        expect(risk.length).toBeGreaterThan(10);
        for (const word of FILLER) expect(risk).not.toContain(word);
      }
    }
  });

  test("用户读到的中文里没有技术词", () => {
    for (const task of CHECK_TASKS) {
      for (const { where, text } of everyString(task)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });

  test("示例是财务真会说的那句话", () => {
    const spoken = ["对账", "核对", "对不上", "查一下", "合计", "小计"];
    for (const task of CHECK_TASKS) {
      expect(spoken.some((word) => task.example.includes(word))).toBe(true);
    }
  });
});

describe("合计卡：只核不改，分清检查了什么和拿不准什么", () => {
  const task = byId("check.totals");
  const prompt = task.prompt(["/示例/流水.xlsx", "/示例/明细.csv"], "第 2 张表也要对");

  test("读表用自带工具，没有这个工具就先停下来说", () => {
    // 提示词是给助手看的信封，允许出现工具名。
    expect(prompt).toContain("cante-sheets");
    expect(prompt).toContain("如果这台电脑没有这个工具");
    // 公共信封里那条通用规矩也还在。
    expect(prompt).toContain("缺少读或写这种文件的工具");
  });

  test("合计、小计、差额都说到", () => {
    expect(prompt).toContain("合计");
    expect(prompt).toContain("小计");
    expect(prompt).toContain("差额");
    expect(prompt).toContain("明细加起来");
  });

  test("产出必须分成「我检查了什么」和「我拿不准什么」两段", () => {
    expect(prompt).toContain("我检查了什么");
    expect(prompt).toContain("我拿不准什么");
  });

  test("顺带报重复行、空行和异常数字，并带上行号和原值", () => {
    expect(prompt).toContain("重复行");
    expect(prompt).toContain("空行");
    expect(prompt).toContain("异常");
    expect(prompt).toContain("第几行");
    expect(prompt).toContain("原值");
  });

  test("把差额算出来让人判断，不许直接下「错了」的结论", () => {
    expect(prompt).toContain("四舍五入");
    expect(prompt).toContain("不要直接下「错了」的结论");
  });

  test("绝不改原表", () => {
    expect(prompt).toContain("原来的文件一个字都不要改");
    expect(prompt).toContain("不要删");
    expect(prompt).toContain("不要移动");
  });
});

describe("对账卡：先问哪一列，三桶结论，每条带行号", () => {
  const task = byId("check.reconcile");
  const prompt = task.prompt(["/示例/银行.csv", "/示例/台账.xlsx"], "用单号对");

  test("对账靠哪一列必须先问用户确认", () => {
    expect(prompt).toContain("列名");
    expect(prompt).toContain("必须先问我确认");
    expect(prompt).toContain("不要自己挑一列就开始");
  });

  test("结论固定三桶", () => {
    expect(prompt).toContain("只在第一张表");
    expect(prompt).toContain("只在第二张表");
    expect(prompt).toContain("对不上");
  });

  test("每一条都带来源行号，金额这类列两边原值并排", () => {
    expect(prompt).toContain("来源行号");
    expect(prompt).toContain("第几行");
    expect(prompt).toContain("原值");
  });

  test("重复值要先说明再对", () => {
    expect(prompt).toContain("重复值");
    expect(prompt).toContain("先告诉我再对");
    expect(prompt).toContain("不要硬凑成一条");
  });

  test("空格和全角半角差异不能直接当成「只在一边」", () => {
    expect(prompt).toContain("空格");
    expect(prompt).toContain("全角");
    expect(prompt).toContain("半角");
  });

  test("不许把「对不上」说成「对方少给了钱」", () => {
    expect(prompt).toContain("少给了钱");
    expect(prompt).toContain("不要替我把「对不上」说成「对方少给了钱」");
  });

  test("绝不改两张原表", () => {
    expect(prompt).toContain("原来的两张表一个字都不要改");
    expect(prompt).toContain("不要删");
    expect(prompt).toContain("不要移动");
  });

  test("两张表里各有哪些列要列出来", () => {
    expect(prompt).toContain("各有哪些列名");
  });
});

describe("两张卡共用公共信封的承诺", () => {
  test("先说明再动手、原文件不动、最后要一段需要核对", () => {
    for (const task of CHECK_TASKS) {
      const prompt = task.prompt(["/示例/一.xlsx", "/示例/二.xlsx"], "按我说的做");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain("结果另存为新文件，不要改原文件");
      expect(prompt).toContain("【需要你核对】");
      expect(prompt).toContain("以用户的原话为准");
    }
  });

  test("文件清单按顺序带全，用户原话也在", () => {
    for (const task of CHECK_TASKS) {
      const files = ["/示例/一.xlsx", "/示例/二.xlsx"];
      const prompt = task.prompt(files, "我的特殊要求：月底前要");
      for (const [index, path] of files.entries()) {
        expect(prompt).toContain(path);
        expect(prompt).toContain(`${index + 1}. ${path}`);
      }
      expect(prompt).toContain("我的特殊要求：月底前要");
    }
  });

  test("没选文件也能生成一份能用的说明", () => {
    for (const task of CHECK_TASKS) {
      const prompt = task.prompt([], "   ");
      expect(prompt).toContain("没有选文件");
      expect(prompt).toContain("（用户没有补充，按上面的做法做）");
      expect(prompt.length).toBeGreaterThan(200);
    }
  });
});
