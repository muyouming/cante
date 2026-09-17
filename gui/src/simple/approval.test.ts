// #60 — the approval translation.
//
// The gate is the only place a tool name reaches the user, so the mapping is
// worth pinning: if `Bash` ever renders as `Bash`, a non-technical user is being
// asked to judge a word she does not know.
import { describe, expect, test } from "bun:test";

import { describeApproval, describeTool } from "./approval.ts";

describe("one call, in the user's language", () => {
  test("known tools become plain Chinese verbs", () => {
    expect(describeTool({ id: "1", name: "Bash", args: { command: "ls" } }).action).toBe("运行一条命令");
    expect(describeTool({ id: "2", name: "Edit", args: {} }).action).toBe("修改文件");
    expect(describeTool({ id: "3", name: "Write", args: {} }).action).toBe("写一个新文件");
    expect(describeTool({ id: "4", name: "WebSearch", args: {} }).action).toBe("上网查资料");
  });

  test("an unknown tool still reads as an action, never as a bare name", () => {
    const described = describeTool({ id: "1", name: "Frobnicate", args: {} });
    expect(described.action).toBe("做一步操作");
    // The name is preserved for the technical detail, not as the headline.
    expect(described.action).not.toContain("Frobnicate");
  });

  test("tool names are matched case-insensitively", () => {
    expect(describeTool({ id: "1", name: "bash", args: {} }).action).toBe("运行一条命令");
    expect(describeTool({ id: "2", name: "BASH", args: {} }).action).toBe("运行一条命令");
  });

  test("the files it will touch are named, not pathed", () => {
    const described = describeTool({
      id: "1",
      name: "Edit",
      args: { file_path: "/Users/wang/Desktop/客户名单.xlsx" },
    });
    expect(described.files).toEqual(["客户名单.xlsx"]);
  });

  test("a Windows path is named the same way", () => {
    const described = describeTool({ id: "1", name: "Write", args: { file_path: "C:\\Users\\wang\\表 1.xlsx" } });
    expect(described.files).toEqual(["表 1.xlsx"]);
  });

  test("lists of files are collected and de-duplicated", () => {
    const described = describeTool({
      id: "1",
      name: "Bash",
      args: {
        file_path: "/tmp/a.xlsx",
        file_paths: ["/tmp/b.xlsx", "/tmp/a.xlsx"],
        files: ["/tmp/c.xlsx"],
      },
    });
    expect(described.files).toEqual(["a.xlsx", "b.xlsx", "c.xlsx"]);
  });

  test("hostile args never throw and never invent files", () => {
    for (const args of [null, undefined, 42, "rm -rf /", ["a"], { file_path: 7 }, { file_paths: "x" }]) {
      const described = describeTool({ id: "1", name: "Bash", args });
      expect(described.action).toBe("运行一条命令");
      expect(Array.isArray(described.files)).toBe(true);
      expect(described.files).toEqual([]);
    }
  });

  test("the technical detail keeps the raw args but stays bounded", () => {
    const long = describeTool({ id: "1", name: "Bash", args: { command: "x".repeat(1000) } });
    expect(long.detail.length).toBeLessThanOrEqual(400);
    expect(long.detail.endsWith("…")).toBe(true);
    expect(describeTool({ id: "1", name: "Bash", args: { command: "ls" } }).detail).toBe('{"command":"ls"}');
  });

  test("a circular argument is reported instead of crashing the screen", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const described = describeTool({ id: "1", name: "Bash", args: circular });
    expect(described.detail).toBe("(无法显示)");
  });
});

describe("a batch of calls", () => {
  test("is described in the order the daemon asked", () => {
    const described = describeApproval([
      { id: "a", name: "Read", args: { file_path: "/tmp/1.xlsx" } },
      { id: "b", name: "Edit", args: { file_path: "/tmp/2.xlsx" } },
    ]);
    expect(described.map((item) => item.action)).toEqual(["读取文件", "修改文件"]);
    expect(described.map((item) => item.files[0])).toEqual(["1.xlsx", "2.xlsx"]);
  });

  test("an empty batch describes nothing (the screen has its own copy for it)", () => {
    expect(describeApproval([])).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

describe("#175 审批卡里不许夹她看不懂的英文", () => {
  test("助手那句原话只在「详情」里，正文只有中文事实", () => {
    const src = read("ApprovalSheet.tsx");
    const raw = src.indexOf("{message()}");
    const deny = src.indexOf("APPROVAL.deny");
    expect(raw, "审批卡里找不到那句原话的渲染").toBeGreaterThan(-1);
    expect(
      raw > deny,
      "那句原话渲染在按钮之前 —— 它会出现在「要不要允许它继续」的正中间（#175 抓到的 Allow? ✗）。",
    ).toBe(true);
    expect(src).toContain("APPROVAL.rawLabel");
  });
});
