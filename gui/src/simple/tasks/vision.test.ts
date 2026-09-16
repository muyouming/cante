// 照片/截图里的表格变成 Excel（#48）。
//
// 这张卡的立命之本是「宁可说不清，也不编一个数」。所以下面守住的不是排版，而是
// 三条不能退的线：
//   * 看不清的格子必须留空、必须点出来，绝不许猜；
//   * 整张图看不清、或者这个设置看不了图时，先停下车说明做不到，不编一张表；
//   * 结果另存为新的 .xlsx，原图只读。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { VISION_TASKS } from "./vision.ts";
import type { TaskDef } from "./index.ts";

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
  const found = VISION_TASKS.find((item) => item.id === id);
  expect(found).toBeDefined();
  return found!;
}

const IMAGES = ["/示例/表格照片.jpg", "/示例/表格截图.png"];

describe("看图卡的目录形状", () => {
  test("至少有一张卡，id 唯一，且就是 vision.table", () => {
    expect(VISION_TASKS.length).toBeGreaterThan(0);
    const ids = VISION_TASKS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("vision.table");
    expect(task("vision.table").id).toBe("vision.table");
  });

  test("卡片完整：表格组、要文件、4 步计划、至少 3 条风险、4 条结果提示", () => {
    for (const item of VISION_TASKS) {
      expect(item.group).toBe("表格");
      expect(item.needs).toBe("files");
      expect(item.title.length).toBeGreaterThan(3);
      expect(item.example.length).toBeGreaterThan(5);
      expect(item.plan.length).toBe(4);
      expect((item.risks ?? []).length).toBeGreaterThanOrEqual(3);
      expect(item.summaryHints.length).toBe(4);
      // 最后一步永远是在说结果另存，不碰原件。
      expect(item.plan.join("")).toMatch(/新文件|另存|不动/);
    }
  });

  test("接收的是图片：jpg/png/heic/webp 都在筛选里", () => {
    const accept = task("vision.table").accept ?? [];
    for (const ext of ["jpg", "jpeg", "png", "heic", "webp"]) {
      expect(accept).toContain(ext);
    }
    for (const ext of accept) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext).not.toContain(".");
    }
  });

  test("面向用户的文字里没有技术词", () => {
    for (const item of VISION_TASKS) {
      for (const { where, text } of userFacing(item)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });

  test("风险写得具体：手写体、遮挡、拍歪、多张拼一张、一格两种写法都在", () => {
    const risks = (task("vision.table").risks ?? []).join("");
    for (const case_ of ["手写", "公章", "拍歪", "两张表", "1,200"]) {
      expect(risks).toContain(case_);
    }
    // 不许用没有信息量的兜底话糊弄。
    for (const filler of ["仅供参考", "可能有误", "如有误差"]) {
      expect(risks).not.toContain(filler);
    }
  });
});

describe("交给助手的指令", () => {
  const prompt = task("vision.table").prompt(IMAGES, "我的补充：只抄金额和日期两列");

  test("走公共信封，文件一个不少", () => {
    expect(prompt).toContain("先说明你打算怎么做，再动手");
    expect(prompt).toContain("结果另存为新文件，不要改原文件");
    expect(prompt).toContain("【要做的事】");
    expect(prompt).toContain("【怎么做】");
    expect(prompt).toContain("【用户的原话】");
    expect(prompt).toContain("【做完告诉我】");
    expect(prompt).toContain("【需要你核对】");
    expect(prompt).toContain("我的补充：只抄金额和日期两列");
    for (const [index, path] of IMAGES.entries()) {
      expect(prompt).toContain(`${index + 1}. ${path}`);
    }
    // 缺工具时必须先停，不许硬做。
    expect(prompt).toContain("缺少读或写这种文件的工具");
  });

  test("逐格照抄", () => {
    expect(prompt).toContain("一格一格照抄");
    expect(prompt).toContain("表头、每一行、每一列都按图片里的位置来");
  });

  test("看不清就留空，不许猜——这是这张卡的底线", () => {
    expect(prompt).toContain("看不清就留空，不许猜");
    expect(prompt).toContain("都一律留空");
    expect(prompt).toContain("绝对不要自己编一个数字");
    // 还要点出来是哪一格。
    expect(prompt).toContain("第几行、第几列");
  });

  test("看不清就说不清：宁可说做不到，也不给一张可能错的表", () => {
    expect(prompt).toContain("这件事现在做不了");
    expect(prompt).toContain("宁可说清做不到，也不要给一张可能错的表");
    expect(prompt).toContain("不要硬编一张表出来");
  });

  test("结果另存为新的 .xlsx，原图只读", () => {
    expect(prompt).toContain(".xlsx");
    expect(prompt).toContain("原图只读");
    expect(prompt).toContain("原来的图片一张都不要改、不要删、不要移动");
  });

  test("结果说明要报清看了几张、哪些格子看不清、结果在哪", () => {
    const { summaryHints } = task("vision.table");
    expect(prompt).toContain("一共看了几张图片");
    expect(prompt).toContain("哪些格子看不清以及分别是第几行第几列");
    expect(prompt).toContain("结果文件的完整位置");
    expect(summaryHints).toEqual([
      "一共看了几张图片",
      "哪些格子看不清、在第几行第几列",
      "有没有整张图看不清",
      "结果文件在哪个位置",
    ]);
  });
});
