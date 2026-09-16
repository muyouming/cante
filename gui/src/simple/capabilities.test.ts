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

const { initSheetCapability, sheetCapability, sheetFallbackNote, sheetPromptLine } = await import(
  "./capabilities.ts"
);

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

describe("initSheetCapability", () => {
  test("探测失败时返回不可用，且不抛异常", async () => {
    const cap = await initSheetCapability();
    expect(cap.available).toBe(false);
    expect(sheetCapability().available).toBe(false);
  });

  test("重复调用是幂等的", async () => {
    const first = await initSheetCapability();
    const second = await initSheetCapability();
    expect(second).toEqual(first);
  });
});
