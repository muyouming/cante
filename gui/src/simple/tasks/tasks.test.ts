// The task catalogue is the product surface for simple mode: one bad title or
// one missing safety line is a user-visible bug. These tests pin the shape of
// every card and, more importantly, pin the two promises every instruction must
// carry — "say what you will do first" and "never touch the originals".
//
//   bun test src
import { describe, expect, test } from "bun:test";

import {
  SAFETY_RULES,
  TASKS,
  instructionFor,
  taskById,
  taskGroups,
  type TaskDef,
  type TaskGroup,
} from "./index.ts";

const GROUPS: TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];

/** Terms a 45-year-old admin should never have to read. */
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

function everyString(task: TaskDef): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: "title", text: task.title },
    { where: "example", text: task.example },
  ];
  task.plan.forEach((step, index) => out.push({ where: `plan[${index}]`, text: step }));
  task.summaryHints.forEach((hint, index) => out.push({ where: `summaryHints[${index}]`, text: hint }));
  return out;
}

/** A run's worth of paths, one per extension the card accepts. */
function sampleFiles(task: TaskDef): string[] {
  if (task.needs === "folder") return ["/示例/文件夹"];
  if (task.needs === "none" || task.needs === "text") return [];
  const ext = task.accept?.[0] ?? "txt";
  return [`/示例/一.${ext}`, `/示例/二.${ext}`];
}

describe("catalogue shape", () => {
  test("every card is complete", () => {
    expect(TASKS.length).toBeGreaterThan(0);
    for (const task of TASKS) {
      expect(task.id).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(task.title.length).toBeGreaterThan(3);
      expect(task.example.length).toBeGreaterThan(5);
      expect(GROUPS).toContain(task.group);
      expect(["files", "folder", "none", "text"]).toContain(task.needs);
      // The confirmation page is a promise; two lines is not a plan.
      expect(task.plan.length).toBeGreaterThanOrEqual(3);
      expect(task.summaryHints.length).toBeGreaterThanOrEqual(2);
      // The last step of every plan is about the result file, never the user's.
      expect(task.plan.join("")).toMatch(/新文件|另存|不动|留着|不要动/);
    }
  });

  test("ids are unique and the declared file filters are sane", () => {
    const ids = TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of TASKS) {
      // Omitting `accept` means "any file" (batch renaming needs that).
      for (const ext of task.accept ?? []) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext).not.toContain(".");
      }
      if (task.needs === "folder") expect(task.accept).toBeUndefined();
    }
  });

  test("every issue in this workstream has its card", () => {
    // #45, #46, #47, #49, #50, #53
    for (const id of [
      "excel.merge",
      "excel.group",
      "excel.tidy",
      "excel.diff",
      "files.rename",
      "files.archive",
      "files.dupes",
      "pdf.merge",
      "pdf.split",
      "pdf.toword",
      "doc.notice",
      "doc.leave",
      "doc.report",
    ]) {
      expect(taskById(id)).toBeDefined();
    }
  });

  test("lookup and grouping are stable", () => {
    expect(taskById("excel.merge")?.title).toContain("合成");
    expect(taskById("没有这张卡")).toBeUndefined();
    const groups = taskGroups();
    expect(groups).toContain("表格");
    expect(groups).toContain("文件");
    expect(groups).toContain("文书");
  });

  test("no jargon leaks into anything the user reads", () => {
    for (const task of TASKS) {
      for (const { where, text } of everyString(task)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });
});

describe("the instruction handed to the assistant", () => {
  test("always states the plan first and protects the originals", () => {
    for (const task of TASKS) {
      const prompt = task.prompt(sampleFiles(task), "按我说的做");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain("结果另存为新文件，不要改原文件");
      expect(prompt).toContain("【要做的事】");
      expect(prompt).toContain("【怎么做】");
      expect(prompt).toContain("【用户的原话】");
      expect(prompt).toContain("【做完告诉我】");
    }
    // The shared rules are exported so a copy edit cannot silently drop one.
    expect(SAFETY_RULES.join("\n")).toContain("先说明你打算怎么做，再动手");
    expect(SAFETY_RULES.join("\n")).toContain("结果另存为新文件，不要改原文件");
  });

  test("carries every file, in order, and the user's own words", () => {
    for (const task of TASKS) {
      const files = sampleFiles(task);
      const prompt = task.prompt(files, "我的特殊要求：每月十日发工资");
      for (const [index, path] of files.entries()) {
        expect(prompt).toContain(path);
        // Folder cards print the folder plainly; file cards number the list.
        if (task.needs === "files") expect(prompt).toContain(`${index + 1}. ${path}`);
      }
      expect(prompt).toContain("我的特殊要求：每月十日发工资");
      // The user outranks the recipe.
      expect(prompt).toContain("以用户的原话为准");
    }
  });

  test("folder cards talk about a folder, not a list of files", () => {
    const folderCards = TASKS.filter((task) => task.needs === "folder");
    expect(folderCards.length).toBeGreaterThan(0);
    for (const task of folderCards) {
      const prompt = task.prompt(["/示例/文件夹"], "");
      expect(prompt).toContain("【要整理的文件夹】（只读）");
      expect(prompt).toContain("/示例/文件夹");
    }
  });

  test("cards that take no file survive an empty selection", () => {
    for (const task of TASKS.filter((card) => card.needs === "none" || card.needs === "text")) {
      const prompt = task.prompt([], "随便写一个");
      expect(prompt).toContain("没有选文件");
      expect(prompt).toContain("随便写一个");
    }
  });

  test("an empty one-liner still produces a usable instruction", () => {
    for (const task of TASKS) {
      const prompt = task.prompt(sampleFiles(task), "   ");
      expect(prompt).toContain("（用户没有补充，按上面的做法做）");
      expect(prompt.length).toBeGreaterThan(200);
    }
  });

  test("a finished run resolves back to its full instruction", () => {
    // This is the seam the trust layer uses at confirm time: the run holds the
    // user's sentence, `instructionFor` turns it into the real instruction.
    const files = sampleFiles(taskById("excel.merge")!);
    const prompt = instructionFor("excel.merge", files, "只留重复的");
    expect(prompt).toContain("只留重复的");
    expect(prompt).toContain(files[0]!);
    expect(prompt).toContain("先说明你打算怎么做，再动手");
    expect(instructionFor("没有这张卡", files, "随便")).toBeNull();
  });
});
