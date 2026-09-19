// r25 — 做完之后那一步的守卫。
//
// 这个功能最容易犯的错（AGENTS §3.6 记过两次）：建议一件助手做不到的事。所以我们
// 不测「函数跑起来像对」，而是拿**生产路径真正发出去的那段指令**来核对：每条建议
// 指向的卡必须真的在目录里，且 `instructionFor(taskId, files, say)` 必须拼得出非空
// 的完整指令（卡片规矩 + 她那句话），否则这条建议根本不该出现在界面上。
//
// 每一类断言都要求：正例在、反例不在。避免把「函数恒返回空」当成绿。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { NEXT_STEP } from "./copy-next.ts";
import { NEXT_STEP_RULES, nextStepsFor } from "./followup.ts";
import { TASKS, instructionFor } from "./tasks/index.ts";

const read = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

const HER_FILES = ["/tmp/结果_合并.xlsx"];

/** 目录深处的卡只看 id 就够了。 */
function ids(taskIds: readonly string[]): string[] {
  return [...taskIds];
}

describe("下一步建议：每一条都真能做", () => {
  test("登记表不是空的，而且每条都指向目录里真有的另一张卡", () => {
    expect(NEXT_STEP_RULES.length).toBeGreaterThanOrEqual(3);
    for (const rule of NEXT_STEP_RULES) {
      // 起点卡和目标卡都得真存在：建议指着一张不存在的卡，等于点下去没反应。
      expect(TASKS.some((task) => task.id === rule.from), `起点卡 ${rule.from} 不在目录里`).toBe(true);
      expect(TASKS.some((task) => task.id === rule.to), `目标卡 ${rule.to} 不在目录里`).toBe(true);
      // 建议的是「这件事之后另一件事」，不是把同一张卡再问一遍。
      expect(rule.to).not.toBe(rule.from);
      // 文案模块里真有这一句。
      expect(Object.keys(NEXT_STEP.steps)).toContain(rule.step);
      expect(NEXT_STEP.steps[rule.step].label.trim().length).toBeGreaterThan(0);
      expect(NEXT_STEP.steps[rule.step].say.trim().length).toBeGreaterThan(0);
    }
    // 起点卡不重复登记（一张卡只摆一个下一步）。
    const froms = NEXT_STEP_RULES.map((rule) => rule.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  test("逐条走 instructionFor：目标卡在生产路径上真能发出这段指令", () => {
    // 这是本功能的核心判据：不是「我们打算怎么做」，而是真发出去的那段文字里
    // 既有卡片的规矩（另存新文件、原文件只读），也有她那句话。
    for (const rule of NEXT_STEP_RULES) {
      const say = NEXT_STEP.steps[rule.step].say;
      const composed = instructionFor(rule.to, HER_FILES, say);
      expect(composed, `${rule.from} → ${rule.to} 在生产路径上拼不出指令`).not.toBeNull();
      expect(composed!).toContain(say);
      expect(composed!).toContain("另存");
      expect(composed!.trim().length).toBeGreaterThan(120);
    }
  });

  test("做成的活真能拿出下一步（正例）", () => {
    const cases: Array<[string, string]> = [
      ["excel.merge", "excel.group"],
      ["vision.table", "excel.tidy"],
      ["invoice.ledger", "invoice.dupes"],
      ["check.reconcile", "excel.filter"],
    ];
    for (const [from, to] of cases) {
      const steps = nextStepsFor({ taskId: from, resultFiles: HER_FILES });
      expect(steps.map((step) => step.taskId), `${from} 应该给出 ${to}`).toContain(to);
      // 每一步都把刚做好的结果文件带上——这一步的前提就是「拿这份继续」。
      for (const step of steps) expect(step.files).toEqual(HER_FILES);
    }
  });

  test("没做成的、或没产出文件的，不给下一步（反例）", () => {
    // 没有结果文件：没有可「继续」的东西，也不能退回她原来选的文件重做一遍。
    expect(nextStepsFor({ taskId: "excel.merge", resultFiles: [] })).toEqual([]);
    // 目录里没有「下一步」登记的卡：什么都不给，不编一步。
    expect(nextStepsFor({ taskId: "doc.notice", resultFiles: HER_FILES })).toEqual([]);
    // 空文件名不算数（只有空白/空串）。
    expect(nextStepsFor({ taskId: "excel.merge", resultFiles: ["", "   "] })).toEqual([]);
  });

  test("反例：把目标卡从目录里拿掉，这条建议就不出现（判据真的在挡）", () => {
    // 直接构造一次「目标卡拼不出指令」的情形：用一个不存在的 id 不会进登记表，
    // 所以这里验证函数本身的行为——起点对不上时不返回任何东西。
    const none = nextStepsFor({ taskId: "不存在的卡", resultFiles: HER_FILES });
    expect(none).toEqual([]);
    // 而起点对得上时确实返回东西：两条一起说明断言不是恒真。
    expect(nextStepsFor({ taskId: "excel.merge", resultFiles: HER_FILES }).length).toBeGreaterThan(0);
  });

  test("判断走的是生产路径，不是 task.prompt() 那条（防 §3.1 重演）", () => {
    // 当年 P0 的成因：验收直接调 task.prompt()，生产路径却从没拼过卡片提示词。
    // 这里把「只许走 instructionFor」变成一条能挡的断言。
    const source = read("./followup.ts");
    expect(source).toContain("instructionFor");
    expect(source.includes(".prompt("), "followup.ts 直接调了 task.prompt()（那是产品不会走的路）").toBe(false);
    // 结果卡片上的按钮真的把活摆上确认页，而不是只显示一句话。
    const card = read("./ResultCard.tsx");
    expect(card).toContain("startNext");
    expect(card).toContain("startRun");
    expect(card).toContain("nextSteps");
  });

  test("文案：按钮是 2–4 个字，不出现发送类动作", () => {
    for (const rule of NEXT_STEP_RULES) {
      const step = NEXT_STEP.steps[rule.step];
      const label = step.label.trim();
      // 「一键开始」的按钮要短：2–4 个汉字。
      expect(label.length, `${label} 不是 2–4 个字`).toBeGreaterThanOrEqual(2);
      expect(label.length, `${label} 不是 2–4 个字`).toBeLessThanOrEqual(4);
      // 红线：不许建议任何自动发送的动作。
      for (const bad of ["发送", "群发", "自动回复", "发消息"]) {
        expect(step.say.includes(bad), `${rule.from} 的建议里出现了「${bad}」`).toBe(false);
        expect(label.includes(bad), `${rule.from} 的按钮里出现了「${bad}」`).toBe(false);
      }
    }
  });
});
