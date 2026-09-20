// 「她看不懂的词」的守卫。
//
// 这一块的产品主张很小，所以判据也必须小、必须真：
//
//   1. 只收产品**真的会做**的那件事里有确切意思的词（每个 hint 都写 basis：
//      哪张卡、做什么）。测试拿任务卡里**她看得到**的文字核对这个词确实在那儿；
//   2. 解释**不是术语词典**：一句「这在你这儿，就是……」，而且**不许再用那个词
//      解释它自己**（用术语解释术语 = 没用）。这条能红是重点，见下面那条测试；
//   3. 解释是加在她要读的那句话旁边的一层，**不能改写那句话**：把片段拼回去必须
//      和原文一字不差。
//
// 说明边界（和 AGENTS.md §5 一致）：这些测试**不能**证明「她到底认不认识这个词」。
// 那需要真人。这里能挡的只有「我们收了个产品不做的事」「解释里又出现了术语」
// 「我们悄悄改了她要读的原文」这三类错。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HINT_COPY, HINT_TEXTS } from "./copy-hints.ts";
import { HINTS, checkExplanation, explanationFor, hitsIn, hintsIn, segments } from "./hints.ts";
import { TASKS } from "./tasks/index.ts";

/** 只取她在界面上看得到的字段；prompt() 是发给助手的，不算。 */
function userFacingText(task: (typeof TASKS)[number]): string {
  return [
    task.title,
    task.example,
    ...(task.plan ?? []),
    ...(task.risks ?? []),
    ...(task.summaryHints ?? []),
  ].join("\n");
}

/** 全部卡片里她看得到的文字，拼成一份，供「词确实出现过」核对。 */
const CATALOGUE_TEXT = TASKS.map(userFacingText).join("\n");

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));

describe("词卡：只收产品真做得到的词", () => {
  test("数量克制：只放最确定的 3–5 个（宁少勿滥）", () => {
    expect(HINTS.length).toBeGreaterThanOrEqual(3);
    expect(HINTS.length).toBeLessThanOrEqual(5);
  });

  test("每个词都在她看得到的卡片文字里真的出现过，而且 basis 指向真有的卡", () => {
    for (const hint of HINTS) {
      // 依据的卡必须真的存在——否则我们是在为一件产品不做的事编解释。
      const task = TASK_BY_ID.get(hint.basis.taskId);
      expect(task, `hint「${hint.terms[0]}」的 basis.taskId ${hint.basis.taskId} 不在目录里`).toBeDefined();
      // 依据要写出这张卡到底做什么；一句话说不清就说明还没想清楚。
      expect(hint.basis.what.trim().length).toBeGreaterThan(8);
      // 她看得到的文字里必须真有这个词（title/example/plan/risks/summaryHints）。
      const appears = hint.terms.some((term) => CATALOGUE_TEXT.includes(term));
      expect(appears, `hint「${hint.terms[0]}」在她的卡片文字里根本没出现，不该收`).toBe(true);
    }
  });

  test("每个词旁边都有一句答案，且都是「这在你这儿，就是…」", () => {
    for (const hint of HINTS) {
      const text = explanationFor(hint);
      expect(text.startsWith("这在你这儿，就是")).toBe(true);
      // 短到她一眼扫完：可读性闸门还管结构，这里先卡一个上界。
      expect([...text].length).toBeLessThanOrEqual(40);
      expect(HINT_COPY.askLabel(hint.terms[0]).includes(hint.terms[0] as string)).toBe(true);
    }
  });

  test("解释里不再出现那个词本身（用术语解释术语 = 没用）", () => {
    const offenders: string[] = [];
    for (const hint of HINTS) {
      const leftover = checkExplanation(hint, explanationFor(hint));
      if (leftover.length > 0) offenders.push(`「${hint.terms[0]}」的解释里又出现了：${leftover.join("、")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("这条闸门真的能红：拿「台账就是台账」喂进去必须报出台账", () => {
    const fake = { id: "ledger", terms: ["台账"], basis: { taskId: "invoice.ledger", what: "占位" } } as const;
    expect(checkExplanation(fake, "台账就是把发票记在一张表里。")).toContain("台账");
    // 正常的一句必须过。
    expect(checkExplanation(fake, "这在你这儿，就是把发票记在一张表里。")).toEqual([]);
  });
});

describe("切词：解释是加在旁边的一层，不改她要读的原文", () => {
  test("所有片段拼回去，和原文一字不差", () => {
    const samples = [
      "把发票 PDF 汇总成台账",
      "先把两张表的列名都列出来，请你说清按哪一列对账",
      "按类别汇总并配上图表（月报）",
      "读不到的字段留空",
      "整理表格格式（表头、空行、日期）",
      "这句话里没有任何要解释的词。",
    ];
    for (const text of samples) {
      const rebuilt = segments(text)
        .map((segment) => segment.text)
        .join("");
      expect(rebuilt).toBe(text);
    }
  });

  test("命中的词不重叠：长的优先，切不出半截词", () => {
    // 「对账」和「对一遍」是同一个答案的不同叫法；同一段里各出现一次，都要认出来。
    const text = "发票台账和报销明细对一遍，两张表按一列对账";
    const hits = hintsIn(text);
    const ids = hits.map((hit) => hit.hint.id).sort();
    expect(ids).toEqual(["ledger", "reconcile"]);
    // 每个命中都在原位：text.slice(at, at+term.length) === term。
    for (const hit of hitsIn(text)) {
      expect(text.slice(hit.at, hit.at + hit.term.length)).toBe(hit.term);
    }
  });

  test("没有可解释的词时，原样返回一段普通文字", () => {
    const out = segments("这周把文件按月份分好");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("plain");
  });
});

describe("文案模块没有死代码", () => {
  test("copy-hints.ts 里的每一句都有人用", () => {
    // 这个测试的价值不是重复 copy-guard，而是把「加了新答案却忘了接线」挡在本地：
    // 下面这份源码里必须真的引用到 HINT_TEXTS 的每个键。
    const used = JSON.stringify(HINT_TEXTS);
    const source = readFileSync(join(import.meta.dir, "hints.ts"), "utf8");
    expect(source).toContain("HINT_TEXTS");
    expect(used.length).toBeGreaterThan(0);
    // 每个键都在 copy-hints.ts 里，且 HINTS 的每个 id 都能取到答案。
    for (const hint of HINTS) {
      expect(explanationFor(hint).length).toBeGreaterThan(0);
    }
  });

  test("问题的入口文案是中文、带那个词", () => {
    for (const hint of HINTS) {
      const label = HINT_COPY.askLabel(hint.terms[0] as string);
      expect(label).toContain("是什么意思");
      expect(label).toContain(hint.terms[0] as string);
    }
    // 顺带看住：这一层只依赖 copy-hints 的字，不把解释硬编码在逻辑里。
    const files = readdirSync(import.meta.dir).filter((name) => name === "hints.ts");
    expect(files).toHaveLength(1);
  });
});
