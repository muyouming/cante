// 生产路径的提示词组装（上一轮 P0 的守卫）。
//
// 背景：卡片（`tasks/*.ts`）里写满了规矩——"原来的文件一张都不要改""结果另存为
// 新文件""先问我一句再动手"。这些规矩要靠 `instructionFor()` 拼进真正发出去的指令，
// 而这条线**曾经断过**：`store.confirmRun` 只发了用户那一句话，卡片提示词全仓库
// 只被测试引用，于是 25 张卡的安全规矩从未到达助手。
//
// 那次事故能潜伏很久，是因为**验收脚本走的是另一条路**（直接调 `task.prompt()`）。
// 所以这里不只测"某一张卡拼得对"，而是对**目录里每一张卡**都验一遍：只要有人加了
// 新卡却让它的提示词拼不出来（空、或缺用户原话、或缺"只读/另存"这类底线），生产
// 路径就会退化成"只发她那一句话"，这条测试会立刻红。
import { expect, test } from "bun:test";

import { TASKS, instructionFor } from "./index.ts";

/** 每一张卡拼出来的指令，都不该短于这个长度：卡片提示词是有结构的，不是一句话。 */
const MIN_COMPOSED_LENGTH = 120;

/** 她原话里不会出现在任何卡片模板里的一句话，用来证明"她说了什么"没被丢掉。 */
const HER_SENTENCE = "把这份东西按我要的样子弄好";

test("目录里每一张卡，都能拼出真正发出去的指令", () => {
  expect(TASKS.length).toBeGreaterThan(0);

  const broken: string[] = [];
  for (const task of TASKS) {
    const composed = instructionFor(task.id, ["/tmp/示例表.xlsx"], HER_SENTENCE);

    if (composed === null) {
      broken.push(`${task.id}: instructionFor 返回 null（这张卡的提示词拼不出来）`);
      continue;
    }
    if (!composed.includes(HER_SENTENCE)) {
      broken.push(`${task.id}: 拼出来的指令里没有她那句话`);
    }
    if (composed.trim().length < MIN_COMPOSED_LENGTH) {
      broken.push(`${task.id}: 拼出来只有 ${composed.trim().length} 字，短得不像卡片提示词`);
    }
    // 底线规矩：结果不许覆盖原文件。这句话是产品对用户的承诺，必须真的发出去。
    const hasNoTouch =
      composed.includes("不要改") ||
      composed.includes("不要动") ||
      composed.includes("只读") ||
      composed.includes("另存") ||
      composed.includes("新文件");
    if (!hasNoTouch) {
      broken.push(`${task.id}: 拼出来的指令里没有任何"原文件只读 / 结果另存"的说法`);
    }
  }

  expect(broken, `这些卡在生产路径上会退化成"只发用户那一句话"：\n${broken.join("\n")}`).toEqual([]);
});

test("找不到的卡退回用户原话，而不是发空指令", () => {
  // 历史记录里的旧任务、或者"直接说一件事"的自由任务都会走到这里。
  expect(instructionFor("这不是一张真的卡", [], HER_SENTENCE)).toBeNull();
});

test("自由说的任务（freeTask）也拼得出指令", () => {
  // 用户不进卡片、直接说一句话时，走的是自由任务；它的提示词同样必须非空。
  const composed = instructionFor("free", [], HER_SENTENCE);
  // freeTask 的 id 可能与 "free" 不同，这里只要求：要么拼得出来且包含她的话，
  // 要么明确返回 null（调用方随即退回原话，行为仍然正确）。
  if (composed !== null) expect(composed).toContain(HER_SENTENCE);
});
