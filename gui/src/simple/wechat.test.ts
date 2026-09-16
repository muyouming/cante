// WeChat red-line tests (#51, #52).
//
// The WeChat slice must promise exactly two things and never more: read a file
// the user chose, and write a new file. These tests assert the task prompts
// carry that instruction, and scan the screen's source so a future edit cannot
// quietly add a send affordance.
import { describe, expect, test } from "bun:test";

import {
  DRAFT_SEND_NOTICE,
  WECHAT_SAFETY_NOTICE,
} from "./privacy.ts";
import { WECHAT_ACCEPT, WECHAT_TASKS, wechatTableTask } from "./tasks/wechat.ts";

const FORBIDDEN = ["模型", "token", "prompt", "会话", "上下文", "权限", "diff", "worktree", "路径", "API"];

function assertPlain(text: string): void {
  for (const word of FORBIDDEN) {
    expect(text).not.toContain(word);
  }
}

describe("the WeChat catalogue", () => {
  test("offers the table, the single draft and the batch draft", () => {
    expect(WECHAT_TASKS.map((task) => task.id)).toEqual([
      "wechat.table",
      "wechat.draft",
      "wechat.batch",
    ]);
  });

  test("every task reads files and never asks for a folder or text", () => {
    for (const task of WECHAT_TASKS) {
      expect(task.group).toBe("微信");
      expect(task.needs).toBe("files");
      expect(task.accept).toContain("txt");
      expect(task.title.trim().length).toBeGreaterThan(0);
      expect(task.example.trim().length).toBeGreaterThan(0);
      expect(task.plan.length).toBeGreaterThan(0);
      expect(task.summaryHints.length).toBeGreaterThan(0);
      assertPlain(task.title);
      assertPlain(task.example);
      for (const step of task.plan) assertPlain(step);
    }
  });

  test("the file picker accepts the exported chat formats", () => {
    expect(WECHAT_ACCEPT).toContain("txt");
    expect(WECHAT_ACCEPT).toContain("csv");
  });
});

describe("the prompts hold the line", () => {
  test("all three tell the model to organise only and never send", () => {
    for (const task of WECHAT_TASKS) {
      const prompt = task.prompt(["/tmp/chat.txt"], "");
      expect(prompt).toContain(WECHAT_SAFETY_NOTICE);
      expect(prompt).toContain("只做整理");
      expect(prompt).toContain("不要发送任何消息");
      expect(prompt).toContain("不要登录微信");
      expect(prompt).toContain("/tmp/chat.txt");
    }
  });

  test("the draft tasks also state that the user sends by hand", () => {
    for (const task of WECHAT_TASKS.filter((item) => item.id !== "wechat.table")) {
      expect(task.prompt(["/tmp/chat.txt"], "")).toContain(DRAFT_SEND_NOTICE);
    }
  });

  test("the table keeps the original words for checking", () => {
    const prompt = wechatTableTask.prompt(["/tmp/chat.txt"], "只看要紧的");
    expect(prompt).toContain("原话");
    expect(prompt).toContain("只看要紧的");
  });

  test("an empty file list still produces a readable instruction", () => {
    expect(wechatTableTask.prompt([], "")).toContain("（没有选择文件）");
  });
});

describe("the screen cannot send", () => {
  test("no WeChat screen or task mentions a send-for-you action", async () => {
    for (const name of ["WechatImport.tsx", "tasks/wechat.ts"]) {
      const source = await Bun.file(`${import.meta.dir}/${name}`).text();
      expect(source).not.toContain("自动发送");
    }
  });

  test("the screen renders both required notices from the shared constants", async () => {
    const source = await Bun.file(`${import.meta.dir}/WechatImport.tsx`).text();
    expect(source).toContain("WECHAT_SAFETY_NOTICE");
    expect(source).toContain("DRAFT_SEND_NOTICE");
  });
});
