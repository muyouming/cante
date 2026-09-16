// #75 — 表格能力探测的前端行为。
//
// 只测纯函数和"探测失败也绝不抛异常"这两条。真正的后端解析在 Rust 侧单测里，
// 这里只确认：可用/不可用两种情况下，给助手的那句话和给用户的那句话各自出现在
// 该出现的地方。
//
//   bun test src

import { describe, expect, mock, test } from "bun:test";

// 让探测必失败：模拟"这台电脑没有桌面程序 / 命令报错"。
mock.module("../tauri.ts", () => ({
  invoke: async () => {
    throw new Error("desktop bridge unavailable");
  },
  isBridgeAvailable: () => false,
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  BridgeUnavailable: class BridgeUnavailable extends Error {},
  CommandRejected: class CommandRejected extends Error {},
}));

const {
  initCapabilities,
  initSheetCapability,
  pdfCapability,
  pdfFallbackNote,
  pdfPromptLine,
  sheetCapability,
  sheetFallbackNote,
  sheetPromptLine,
} = await import("./capabilities.ts");

describe("sheetPromptLine", () => {
  test("不可用时是 null", () => {
    expect(sheetPromptLine({ available: false })).toBeNull();
  });

  test("可用时非空，并说明用 cante-sheets 读写表格", () => {
    const line = sheetPromptLine({ available: true, path: "/opt/cante-sheets" });
    expect(line).not.toBeNull();
    expect(line).toContain("cante-sheets");
    expect(line).toContain(".xlsx");
    // 结果必须写成 .xlsx，不能因为缺别的工具就换格式。
    expect(line).toContain("不要因为缺少别的工具就改成别的格式");
  });
});

describe("sheetFallbackNote", () => {
  test("可用时是 null", () => {
    expect(sheetFallbackNote({ available: true })).toBeNull();
  });

  test("不可用时给用户一条中性说明", () => {
    const note = sheetFallbackNote({ available: false });
    expect(note).not.toBeNull();
    expect(note).toContain("CSV");
    // 这是边界，不是错误：措辞里不出现报错口吻。
    expect(note).not.toContain("错误");
    expect(note).not.toContain("失败");
  });
});

describe("pdfPromptLine", () => {
  test("不可用时是 null", () => {
    expect(pdfPromptLine({ available: false })).toBeNull();
  });

  test("可用时非空，并说明用 cante-pdf 的四件事", () => {
    const line = pdfPromptLine({ available: true, path: "/opt/cante-pdf" });
    expect(line).not.toBeNull();
    expect(line).toContain("cante-pdf");
    expect(line).toContain("pages");
    expect(line).toContain("text");
    expect(line).toContain("merge");
    expect(line).toContain("split");
    // 扫描件没有文字层时要先停下告诉用户，不许当成没内容。
    expect(line).toContain("文字层");
    expect(line).toContain("扫描");
  });
});

describe("pdfFallbackNote", () => {
  test("可用时是 null", () => {
    expect(pdfFallbackNote({ available: true })).toBeNull();
  });

  test("不可用时给用户一条中性说明", () => {
    const note = pdfFallbackNote({ available: false });
    expect(note).not.toBeNull();
    expect(note).toContain("PDF");
    // 这是边界，不是错误：措辞里不出现报错口吻。
    expect(note).not.toContain("错误");
    expect(note).not.toContain("失败");
  });
});

describe("initCapabilities", () => {
  test("探测失败时两个工具都不可用，且不抛异常", async () => {
    await initCapabilities();
    expect(sheetCapability().available).toBe(false);
    expect(pdfCapability().available).toBe(false);
  });

  test("重复调用是幂等的", async () => {
    const first = await initCapabilities();
    const second = await initCapabilities();
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // 多次调用后缓存值保持一致。
    expect(pdfCapability()).toEqual({ available: false });
  });

  test("initSheetCapability 仍是同一个入口（旧名字保留）", () => {
    expect(initSheetCapability).toBe(initCapabilities);
  });
});
