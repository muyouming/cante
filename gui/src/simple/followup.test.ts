// The rule behind the result card's answer box: did this turn end waiting on
// the user? The safe direction is "show the box": a needless box costs a
// glance, a missing one leaves the user with a question she cannot answer.
import { describe, expect, test } from "bun:test";

import { endedWithQuestion } from "./followup.ts";

describe("endedWithQuestion", () => {
  test("no new file means the user has nothing to do but answer", () => {
    expect(endedWithQuestion("我已经把两张表读完了。", 0)).toBe(true);
    expect(endedWithQuestion("", 0)).toBe(true);
    expect(endedWithQuestion("   ", 0)).toBe(true);
  });

  test("a produced file with no question is a finished result, not a question", () => {
    expect(endedWithQuestion("做好了，结果在桌面。", 1)).toBe(false);
    expect(endedWithQuestion("合成完毕，新表格已经存好。", 3)).toBe(false);
  });

  test("empty text with a produced file is a result, not a question", () => {
    expect(endedWithQuestion("", 1)).toBe(false);
    expect(endedWithQuestion("   \n  ", 2)).toBe(false);
  });

  test("a full-width Chinese question mark counts, even with a produced file", () => {
    expect(endedWithQuestion("金额（元）和金额对不上，要用哪一个？", 1)).toBe(true);
  });

  test("a half-width question mark counts too", () => {
    expect(endedWithQuestion("Which column should I use?", 1)).toBe(true);
  });

  test("each consultation marker counts as a question", () => {
    const markers = ["需要你", "先问我", "核对", "确认一下", "要不要", "还是"];
    for (const marker of markers) {
      expect(endedWithQuestion(`有件事要${marker}定一下`, 2)).toBe(true);
    }
  });

  test("markers embedded in a longer sentence still count", () => {
    expect(endedWithQuestion("两张表的列名不一样，需要你核对一下再继续。", 1)).toBe(true);
    expect(endedWithQuestion("这张表要不要保留合计行，还是只留明细？", 2)).toBe(true);
  });

  test("text without any marker and with a result is not a question", () => {
    expect(endedWithQuestion("已经按你的要求做完了，文件放在桌面上。", 1)).toBe(false);
  });

  test("a question mark buried in the assistant's text is enough", () => {
    expect(endedWithQuestion("我改好了。另外，你希望按月份分表吗", 1)).toBe(false);
    expect(endedWithQuestion("我改好了。另外，你希望按月份分表吗？", 1)).toBe(true);
  });
});
