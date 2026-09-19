// r3 — 「三句例子该不该一开始就摊开」这条判据的单测。
//
// 它只有一个输入：store 里完成过的轮次（`store.runs()`，真正的运行记录）。这里钉住
// 两种情形，免得哪天有人把条件写反——写反的后果是**第一次用的人**看不到那三句例子
// （第一屏的门槛被藏起来），或者**用过的人**永远收不起来（小屏底部一直吃掉一半高
// 度）。两种都是产品律里说的「看起来做了」。
import { describe, expect, test } from "bun:test";

import { examplesStartOpen } from "./first-use.ts";

describe("三句例子一开始展不展开", () => {
  test("从来没做过任务：展开（第一屏体验不变）", () => {
    expect(examplesStartOpen([])).toBe(true);
  });

  test("做过至少一轮：收起（用过之后它们就是噪音）", () => {
    // 做了、做失败了、她中途停了，结束时都会在记录里留一笔，所以只看「有没有」。
    expect(examplesStartOpen([{ state: "done" }])).toBe(false);
    expect(examplesStartOpen([{ state: "failed" }, { state: "done" }])).toBe(false);
    expect(examplesStartOpen([{ state: "cancelled" }])).toBe(false);
  });
});
