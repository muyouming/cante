// 「她输入一句话之后，产品帮她挑卡」这半边（r25）。
//
// 这个仓库没有 jsdom（理由写在 typography.test.ts 的开头），所以这里扫源码，钉的
// 是**接线**而不是文案：她说的那句话必须真的走 `suggestTasks`，挑中的卡必须真的
// 走 `onPickTask`（和点卡片同一条路），一个都对不上时必须留在原地如实说、不许把
// 她的话丢掉。判据本身（哪句话认到哪张卡）在 catalog.test.ts 里逐条断言。
//
// 为什么单独一个文件而不是塞进 first-run-ui.test.ts：那是「三句例子」那一轮的
// 账，这一轮是另一件事（她说自己的话）。分开写，谁的接线断了报错就落在谁头上。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SUGGEST } from "./copy-suggest.ts";

const HERE = import.meta.dir;
const HOME = readFileSync(join(HERE, "Home.tsx"), "utf8");

/** 组件里某个函数的函数体（`function name(` 或 `const name = () =>`），到下一个顶格收尾的 `}` 为止。 */
function bodyOf(source: string, name: string): string {
  const decl = source.indexOf(`function ${name}(`);
  const arrow = source.indexOf(`const ${name} = (`);
  const start = decl >= 0 ? decl : arrow;
  expect(start, `Home.tsx 里找不到 ${name}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end > start ? end : source.length);
}

describe("她说一句话之后，先问「你是想做这个吗」（r25）", () => {
  test("提交一句话时真的去认卡：走的是 suggestTasks（不是自己又写一套）", () => {
    const body = bodyOf(HOME, "submit");
    expect(body).toContain("suggestTasks(value");
    // 用首页真正看得见的卡片，技术同事关掉的卡不该被推出来。
    expect(body).toContain("visibleTasks()");
  });

  test("挑中的卡走和点卡片同一条路：props.onPickTask（不自己拼一个假入口）", () => {
    const body = bodyOf(HOME, "pickSuggested");
    expect(body).toContain("props.onPickTask(picked)");
    // 界面里那张卡真的接了它。
    expect(HOME).toContain("onClick={() => pickSuggested(task)}");
  });

  test("一个都对不上时不硬凑：留在原地如实说，并留一条自由路", () => {
    // 空数组时渲染 SUGGEST.none（那句「我没看懂…」），而不是一张编出来的卡。
    expect(HOME).toContain("{entry().tasks.length > 0 ? SUGGEST.hint : SUGGEST.none}");
    // 「都不是」那条路还是她原话，一个字不改地交给自由路。
    const body = bodyOf(HOME, "justDoIt");
    expect(body).toContain("props.onSubmitText(value)");
    expect(HOME).toContain("{SUGGEST.justDoIt}");
  });

  test("例子原文那条老路没被改掉：仍先进卡片流程", () => {
    const body = bodyOf(HOME, "submit");
    const pick = body.indexOf("props.onPickTask(task)");
    const suggest = body.indexOf("suggestTasks(value");
    expect(pick).toBeGreaterThan(-1);
    expect(suggest).toBeGreaterThan(-1);
    // 照着例子原样说时，先走卡片；只有不是例子时才去认卡。
    expect(pick).toBeLessThan(suggest);
  });

  test("她改一个字，之前那几张「最像的」就收起来（不挂着旧建议）", () => {
    const box = HOME.slice(HOME.indexOf('id="cante-say"'));
    const onInput = box.slice(box.indexOf("onInput"), box.indexOf("class="));
    expect(onInput).toContain("setSaid(null)");
  });

  test("这一块不能替她动手：只有她点，才往下走", () => {
    // submit() 里出现的两条出口都是「她点了才走」；提交本身不直接调 onSubmitText。
    const body = bodyOf(HOME, "submit");
    expect(body).not.toContain("props.onSubmitText(value)");
  });

  test("文案全中文、零术语（不出现匹配/算法/相似度）", () => {
    const shown = Object.values(SUGGEST).join("\n");
    for (const banned of ["匹配", "算法", "相似度", "检索", "命中"]) {
      expect(shown, `「${banned}」是术语，她看不懂`).not.toContain(banned);
    }
  });
});
