// #75 — 表格能力探测的前端行为。
//
// 只测纯函数和"探测失败也绝不抛异常"这两条。真正的后端解析在 Rust 侧单测里，
// 这里只确认：可用/不可用两种情况下，给助手的那句话和给用户的那句话各自出现在
// 该出现的地方。
//
//   bun test src

import { describe, expect, mock, test } from "bun:test";

import { FORMAT_COPY } from "./copy-capability.ts";
import { inspectSelection } from "./format-check.ts";

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
  formatAdviceNote,
  formatStartBlockNote,
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

  test("可用时写清 #95 契约：结果必须新文件名、不覆盖、一次一张表", () => {
    const line = sheetPromptLine({ available: true, path: "/opt/cante-sheets" }) ?? "";
    // 结果文件必须是还不存在的新名字。
    expect(line).toContain("还不存在");
    expect(line).toContain("新文件名");
    // 已存在就拒绝，不覆盖，并给出路（换一个新名字）。
    expect(line).toContain("不会覆盖");
    expect(line).toContain("换一个新名字");
    // 一次只写一张表：不追加、不改已有文件。
    expect(line).toContain("只写出一张表");
    expect(line).toContain("不会往已有文件里追加表");
    // 表名规则也要说清。
    expect(line).toContain("不能超过 31 个字");
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

// #88 — 读不了的格式（WPS / 苹果自己的），要跑之前就说清。

describe("sheetPromptLine 里的 WPS / 苹果格式规矩（#88）", () => {
  test("告诉助手这些格式读不了，而且要说清 + 跳过 + 把能读的做完", () => {
    const line = sheetPromptLine({ available: true, path: "/opt/cante-sheets" }) ?? "";
    // 六种格式一个不少。
    for (const extension of [".et", ".ett", ".wps", ".dps", ".pages", ".numbers"]) {
      expect(line).toContain(extension);
    }
    expect(line).toContain("WPS");
    // 不许硬试、不许把整件事停下。
    expect(line).toContain("不要反复重试");
    // 要跳过后继续做能读的，并写清跳过了哪几份。
    expect(line).toContain("跳过");
    expect(line).toContain("其余能读的文件做完");
    expect(line).toContain("跳过了哪几份");
    // 给用户的出路是另存为 Excel / Word。
    expect(line).toContain("另存为");
  });
});

describe("formatAdviceNote / formatStartBlockNote（#88）", () => {
  test("ok 时两句都不说（没得说就不打扰她）", () => {
    expect(formatAdviceNote({ kind: "ok" })).toBeNull();
    expect(formatStartBlockNote({ kind: "ok" })).toBeNull();
  });

  test("convert-first：给那句另存为，并禁用开始（按钮旁边解释为什么）", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et"]);
    expect(formatAdviceNote(verdict)).toBe(FORMAT_COPY.wpsConvertAdvice);
    expect(formatStartBlockNote(verdict)).toBe(FORMAT_COPY.startBlocked);
  });

  test("some-unreadable：说要跳过，但**不禁用**开始（其余的照做）", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/三月.xlsx"]);
    expect(formatAdviceNote(verdict)).toBe(FORMAT_COPY.skipSomeAdvice);
    expect(formatStartBlockNote(verdict)).toBeNull();
  });

  test("mixed-nothing-readable：也给禁用理由（一个都读不了）", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/简报.pages"]);
    expect(formatAdviceNote(verdict)).toBe(FORMAT_COPY.mixedConvertAdvice);
    expect(formatStartBlockNote(verdict)).toBe(FORMAT_COPY.startBlocked);
  });

  test("和「缺工具」是两件事，句子不重复", () => {
    const missingTool = sheetFallbackNote({ available: false }) ?? "";
    expect(FORMAT_COPY.wpsConvertAdvice).not.toBe(missingTool);
    // 缺工具那句说的是另存成 CSV，格式这句说的是在 WPS 里另存为 xlsx。
    expect(FORMAT_COPY.wpsConvertAdvice).not.toContain("装一次表格工具");
  });
});
