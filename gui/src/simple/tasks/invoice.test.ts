// 发票族的三张卡片（#83）。
//
// 这三张卡的服务对象是财务：电子发票 PDF 抄成台账、按号码自查重复、台账和报销
// 明细对账。三条底线必须一直留在指令里，所以单独守住：
//   * 字段只能照原文搬，拿不到的留空，绝不用别的发票补（不许编）；
//   * 扫描件/乱码先停下来说明，不把噪声当结果；
//   * 查重只标不删，对账只列三桶、不替用户下「漏报销」的结论。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { INVOICE_TASKS } from "./invoice.ts";
import type { TaskDef } from "./types.ts";

/** 王姐不该在卡片上读到的词。 */
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

function userFacing(task: TaskDef): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: "title", text: task.title },
    { where: "example", text: task.example },
  ];
  task.plan.forEach((step, index) => out.push({ where: `plan[${index}]`, text: step }));
  (task.risks ?? []).forEach((risk, index) => out.push({ where: `risks[${index}]`, text: risk }));
  task.summaryHints.forEach((hint, index) => out.push({ where: `summaryHints[${index}]`, text: hint }));
  return out;
}

function task(id: string): TaskDef {
  const found = INVOICE_TASKS.find((item) => item.id === id);
  expect(found).toBeDefined();
  return found!;
}

const PDFS = ["/示例/发票一.pdf", "/示例/发票二.pdf"];
const SHEETS = ["/示例/台账.xlsx", "/示例/明细.xlsx"];

describe("发票族的目录形状", () => {
  test("三张卡片都在，id 和顺序固定", () => {
    expect(INVOICE_TASKS.map((item) => item.id)).toEqual([
      "invoice.ledger",
      "invoice.dupes",
      "invoice.crosscheck",
    ]);
  });

  test("每张卡都完整：表格组、要文件、4 步计划、3-4 条风险、4 条结果提示", () => {
    for (const item of INVOICE_TASKS) {
      expect(item.group).toBe("表格");
      expect(item.needs).toBe("files");
      expect(item.title.length).toBeGreaterThan(3);
      expect(item.example.length).toBeGreaterThan(5);
      expect(item.plan.length).toBe(4);
      expect((item.risks ?? []).length).toBeGreaterThanOrEqual(3);
      expect((item.risks ?? []).length).toBeLessThanOrEqual(4);
      expect(item.summaryHints.length).toBe(4);
      // 最后一步永远是在说结果另存，不碰原件。
      expect(item.plan.join("")).toMatch(/新文件|另存|不动|不删/);
    }
  });

  test("发票汇总从 PDF 取数，查重和对账读表格", () => {
    expect(task("invoice.ledger").accept).toContain("pdf");
    for (const id of ["invoice.dupes", "invoice.crosscheck"]) {
      expect(task(id).accept).toContain("xlsx");
      expect(task(id).accept).toContain("csv");
    }
  });

  test("面向用户的文字里没有技术词", () => {
    for (const item of INVOICE_TASKS) {
      for (const { where, text } of userFacing(item)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });

  test("每张卡的说明都走公共信封，文件一个不少", () => {
    for (const item of INVOICE_TASKS) {
      const files = item.id === "invoice.ledger" ? PDFS : SHEETS;
      const prompt = item.prompt(files, "我的特殊要求：按开票日期从早到晚排");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain("结果另存为新文件，不要改原文件");
      expect(prompt).toContain("【要做的事】");
      expect(prompt).toContain("【怎么做】");
      expect(prompt).toContain("【用户的原话】");
      expect(prompt).toContain("【做完告诉我】");
      expect(prompt).toContain("【需要你核对】");
      expect(prompt).toContain("我的特殊要求：按开票日期从早到晚排");
      for (const [index, path] of files.entries()) {
        expect(prompt).toContain(`${index + 1}. ${path}`);
      }
      // 缺工具时必须先停，不许硬做。
      expect(prompt).toContain("缺少读或写这种文件的工具");
    }
  });
});

describe("发票 PDF 汇总成台账", () => {
  const prompt = task("invoice.ledger").prompt(PDFS, "");

  test("四个字段齐全，表头固定且顺序固定", () => {
    expect(prompt).toContain("发票号码、开票日期、销方名称、价税合计");
    expect(prompt).toContain("表头固定成这四列，顺序不要变");
    expect(prompt).toContain("一张发票一行");
  });

  test("拿不到的字段留空，不许编", () => {
    expect(prompt).toContain("读不出来的字段就留空");
    expect(prompt).toContain("不要猜、不要照别的发票编一个");
    // 只照原文搬，不做税务判断。
    expect(prompt).toContain("不要做税额、价税分离这类税务上的判断");
  });

  test("扫描件/乱码先停下来说明，不把噪声当结果", () => {
    expect(prompt).toContain("没有文字层");
    expect(prompt).toContain("乱码");
    expect(prompt).toContain("先停下来告诉我");
    expect(prompt).toContain("不要把它当成一份正常发票");
  });

  test("一份 PDF 里多张发票时要说清楚可能只抽到第一张", () => {
    expect(prompt).toContain("一页两张");
    expect(prompt).toContain("只抽到第一张时要说清楚");
  });

  test("结果写成新的 .xlsx，原 PDF 只读", () => {
    expect(prompt).toContain("结果另存为一个新文件（.xlsx）");
    expect(prompt).toContain("原来的 PDF 一份都不要改、不要删、不要移动");
  });

  test("结果说明要报清读了几份、哪几份读不了、有没有缺字段", () => {
    const { summaryHints } = task("invoice.ledger");
    expect(prompt).toContain("一共读了几份发票、成功整理了几行");
    expect(prompt).toContain("哪几份读不了以及为什么");
    expect(prompt).toContain("有没有字段缺失");
    expect(summaryHints).toContain("有没有哪些字段是空的");
    expect(summaryHints).toContain("哪几份读不了、为什么");
  });
});

describe("发票查重", () => {
  const prompt = task("invoice.dupes").prompt(SHEETS, "");

  test("先确认号码列叫什么，不确认不动手", () => {
    expect(prompt).toContain("先问一句确认，再动手");
    expect(prompt).toContain("哪一列最像发票号码");
    // 风险里也把「列名可能不叫发票号码」写成可核对的一条。
    expect((task("invoice.dupes").risks ?? []).join("")).toContain("票据号码");
  });

  test("空格/全角差异按同一张处理，但要说出来", () => {
    expect(prompt).toContain("空格、全角半角、短横线差异");
    expect(prompt).toContain("先统一了再比");
    expect(prompt).toContain("写明你统一过哪些写法");
  });

  test("输出重复的行、来自哪个文件、金额是否一致", () => {
    expect(prompt).toContain("出现在哪几行");
    expect(prompt).toContain("分别来自哪张表或哪个文件");
    expect(prompt).toContain("金额是否一致");
  });

  test("只标出来，不删行", () => {
    expect(prompt).toContain("只标出来，不要删行");
    expect((task("invoice.dupes").risks ?? []).join("")).toContain("由你决定");
  });
});

describe("发票台账与报销明细核对", () => {
  const prompt = task("invoice.crosscheck").prompt(SHEETS, "");

  test("固定三桶：只在台账里 / 只在明细里 / 金额对不上", () => {
    expect(prompt).toContain("只在台账里的、只在明细里的、两张都有但金额不一样的");
  });

  test("靠哪一列配对上，先问用户确认", () => {
    expect(prompt).toContain("先问用户确认靠哪一列对上");
    expect(prompt).toContain("发票号码，还是金额加日期");
    expect(prompt).toContain("没确认就先停在这里");
  });

  test("每桶都给来源行号，两边的原文照抄", () => {
    expect(prompt).toContain("来源行号");
    expect(prompt).toContain("在台账里是第几行、在明细里是第几行");
  });

  test("列名不同是可能的原因，不直接判漏报销", () => {
    expect(prompt).toContain("不要下「漏报销」「重复报销」这种结论");
  });
});
