// #75 — 表格能力探测的前端行为。
//
// 只测纯函数和"探测失败也绝不抛异常"这两条。真正的后端解析在 Rust 侧单测里，
// 这里只确认：可用/不可用两种情况下，给助手的那句话和给用户的那句话各自出现在
// 该出现的地方。
//
//   bun test src

import { describe, expect, mock, test } from "bun:test";

import type { SessionInfo } from "../protocol.ts";
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
  syncVisionForPrompt,
  visionAvailable,
  visionFallbackNote,
  visionPromptLine,
} = await import("./capabilities.ts");

const { hasImageFile } = await import("./copy-capability.ts");
const { buildPrompt } = await import("./tasks/prompt.ts");

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

// ---------------------------------------------------------------------------
// #48 — 看图能力：读会话的视觉标记，可用不可用都要给助手和用户一句话。
// ---------------------------------------------------------------------------

/** 造一个只关心 `support_vision` 的会话。 */
function session(supportVision: boolean | undefined | null): SessionInfo {
  return { model: { id: "示例", support_vision: supportVision } } as unknown as SessionInfo;
}

describe("visionAvailable", () => {
  test("会话明确说能看图时才是 true", () => {
    expect(visionAvailable(session(true))).toBe(true);
  });

  test("字段缺省、是 false，或者根本没会话，都当看不了（保守）", () => {
    expect(visionAvailable(session(false))).toBe(false);
    expect(visionAvailable(session(undefined))).toBe(false);
    expect(visionAvailable(session(null))).toBe(false);
    expect(visionAvailable(null)).toBe(false);
    expect(visionAvailable(undefined)).toBe(false);
  });
});

describe("visionPromptLine", () => {
  test("可用时告诉助手它可以看图", () => {
    const line = visionPromptLine(true);
    expect(line).toContain("可以直接看图片");
    expect(line).toContain("看不清的格子一律留空");
  });

  test("不可用时也有一条，说清看不了、别编表", () => {
    const line = visionPromptLine(false);
    expect(line).toContain("看不了图片");
    expect(line).toContain("不要凭空编一张表出来");
    expect(line).toContain("如实说明");
  });
});

describe("visionFallbackNote", () => {
  test("可用时是 null", () => {
    expect(visionFallbackNote(true)).toBeNull();
  });

  test("不可用时给用户一条中性说明，并给两条出路", () => {
    const note = visionFallbackNote(false);
    expect(note).not.toBeNull();
    expect(note).toContain("看不了图片");
    expect(note).toContain("用文字");
    expect(note).toContain("能看图的设置");
    // 这是边界，不是错误：措辞里不出现报错口吻。
    expect(note).not.toContain("错误");
    expect(note).not.toContain("失败");
  });
});

describe("syncVisionForPrompt", () => {
  test("把结论同步进提示词信封：能看图时信封里有对应一节", () => {
    expect(syncVisionForPrompt(session(true))).toBe(true);
    const prompt = buildPrompt({ what: "做一件事", how: ["照做"], instruction: "", done: "说一声" });
    expect(prompt).toContain("【这台电脑能不能看图】");
    expect(prompt).toContain("可以直接看图片");
  });

  test("看不了图时也写进信封，提醒助手先停下来说明", () => {
    expect(syncVisionForPrompt(session(false))).toBe(false);
    const prompt = buildPrompt({ what: "做一件事", how: ["照做"], instruction: "", done: "说一声" });
    expect(prompt).toContain("【这台电脑能不能看图】");
    expect(prompt).toContain("看不了图片");
  });
});

describe("hasImageFile", () => {
  test("只看扩展名，认得出照片和截图", () => {
    expect(hasImageFile(["/示例/a.JPG"])).toBe(true);
    expect(hasImageFile(["/示例/a.png"])).toBe(true);
    expect(hasImageFile(["/示例/a.heic"])).toBe(true);
    expect(hasImageFile(["/示例/a.webp"])).toBe(true);
    expect(hasImageFile(["/示例/a.xlsx", "/示例/b.pdf"])).toBe(false);
    expect(hasImageFile([])).toBe(false);
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
