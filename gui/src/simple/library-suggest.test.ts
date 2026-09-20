// 「卡片库里也能说一句话帮我挑」这半边（r26）。
//
// #224 做到了「她输入一句话 → 摆出最像的 2–3 张卡」，但只在首页。卡片库里有 32 张
// 卡和一条搜索框，她点进去还是得自己认——那正是 #224 要解决的问题。这个文件钉的
// 是**接线**，不是文案：库里的那一句必须真的走 `suggestTasks`（和首页同一个引擎，
// 不是又写一套），最像的几张必须真的走 `props.onPick`（和点整列卡片同一条路），
// 文案必须整段来自 `copy-suggest.ts`，认不出来时不摆一张编出来的卡。
//
// 判据本身（哪句话认到哪张卡）在 catalog.test.ts 里逐条断言——那边已经有一份首页
// 用的语料，这里不重复。这个仓库没有 jsdom（理由写在 typography.test.ts 开头），
// 所以这里扫源码。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LIBRARY } from "./copy-library.ts";
import { SUGGEST } from "./copy-suggest.ts";

const HERE = import.meta.dir;
const LIBRARY_SOURCE = readFileSync(join(HERE, "TaskLibrary.tsx"), "utf8");

/** 组件里某个函数/箭头常量的函数体，从声明到下一个顶格收尾的 `}` 为止。 */
function bodyOf(source: string, name: string): string {
  const constStart = source.indexOf(`const ${name} = `);
  expect(constStart, `TaskLibrary.tsx 里找不到 ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", constStart);
  return source.slice(constStart, end > constStart ? end : source.length);
}

describe("卡片库里也能「说一句话帮我挑」（r26）", () => {
  test("库里真的去认卡：走的是 suggestTasks（不是自己又写一套匹配）", () => {
    const body = bodyOf(LIBRARY_SOURCE, "suggested");
    expect(body).toContain("suggestTasks(query()");
    // 用库里真正看得见的卡片，技术同事关掉的卡不该被推出来——和首页一致。
    expect(body).toContain("visibleTasks()");
    // 一个都不像时返回空数组、不硬凑：界面据此不渲染那一块（见下面那条）。
    expect(LIBRARY_SOURCE).toContain("<Show when={suggestedCount() > 0}>");
  });

  test("挑中的卡走和整列卡片同一条路：props.onPick（不自己拼一个假入口）", () => {
    // 最像的那几张渲染用的回调，就是整列卡片用的那一个。
    const picks = LIBRARY_SOURCE.match(/onPick=\{\(picked\) => props\.onPick\(picked\)\}/g) ?? [];
    expect(picks.length).toBeGreaterThanOrEqual(3);
    // 库里没有第二个出口：除了 props.onPick，没有别的挑选回调。
    expect(LIBRARY_SOURCE).not.toMatch(/onSelect|onChoose|pickTask\s*\(/);
  });

  test("文案整段复用 copy-suggest.ts：不许另写一套「你是想做这个吗」", () => {
    expect(LIBRARY_SOURCE).toContain("import { SUGGEST } from \"./copy-suggest.ts\"");
    expect(LIBRARY_SOURCE).toContain("{SUGGEST.title}");
    expect(LIBRARY_SOURCE).toContain("{SUGGEST.hint}");
    // 首页那两句原文不该在组件里被抄成裸字符串（copy-guard 也会因为内联文案报错）。
    expect(LIBRARY_SOURCE).not.toContain(`"${SUGGEST.title}"`);
    expect(LIBRARY_SOURCE).not.toContain(`"${SUGGEST.hint}"`);
  });

  test("两个出口都还在：她还是能搜关键词，也还是能说一句整话", () => {
    // 关键词搜索原封不动（searchTasks 还在接线里）。
    expect(LIBRARY_SOURCE).toContain("searchTasks(query()");
    // 认出来的那几张和「还有 N 项相关的」用两个不同的标题，数字才各自说得通。
    expect(LIBRARY_SOURCE).toContain("LIBRARY.hitsTitle");
    expect(LIBRARY_SOURCE).toContain("LIBRARY.relatedTitle");
    expect(typeof LIBRARY.relatedTitle).toBe("function");
  });

  test("最像的几张不会在下面重复出现（扣掉之后才报「还有 N 项」）", () => {
    const body = bodyOf(LIBRARY_SOURCE, "related");
    expect(body).toContain("suggestedIds()");
    expect(body).toContain("filter");
  });

  test("一个都对不上、关键词也没有：还是那条「没找到」的路，不硬凑", () => {
    // 空态只在「没有建议、也没有关键词结果」时出现。
    expect(LIBRARY_SOURCE).toContain("<Show when={suggestedCount() === 0}>");
    expect(LIBRARY_SOURCE).toContain("{LIBRARY.emptyTitle}");
  });
});
