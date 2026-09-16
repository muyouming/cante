// 这台电脑的能力探测前端封装（#75 表格，#50 PDF）。
//
// 真机跑旗舰任务时，助手把文件读得很干净，却在最后一两步停下说环境里没有能写
// xlsx（或能读 PDF）的东西。问题不在助手，而在这台电脑确实缺工具，而且它事先
// 不知道。
//
// 这个模块只做三件事：
//   * 启动时问一次后端"这台电脑能做什么"，把结果缓存下来（一次探测、幂等、永不抛）；
//   * 可用时给指令信封各加一段中文说明，告诉助手该用哪个命令行工具、怎么用；
//   * 不可用时给确认页一段中性说明，让用户知道这是边界，不是错误。
import { invoke } from "../tauri.ts";
import type { SessionInfo } from "../protocol.ts";
import { PDF_COPY, SHEET_COPY, VISION_COPY } from "./copy-capability.ts";
import { setPdfHelper, setSheetHelper, setVisionHelper } from "./tasks/prompt.ts";

export interface ToolCapability {
  available: boolean;
  path?: string | null;
  why?: string | null;
}

/** 兼容旧名字：表格能力就是一条普通的能力记录。 */
export type SheetCapability = ToolCapability;

/** 后端 `tool_capabilities` 命令的原始返回。 */
interface RawCapabilities {
  sheets?: ToolCapability | null;
  pdf?: ToolCapability | null;
}

/** 还没探测到、或者探测失败时的保守默认值。 */
const UNAVAILABLE: ToolCapability = { available: false };

let sheetsCached: ToolCapability = UNAVAILABLE;
let pdfCached: ToolCapability = UNAVAILABLE;
let pending: Promise<void> | null = null;

function normalize(raw: ToolCapability | null | undefined): ToolCapability {
  if (!raw || !raw.available) return UNAVAILABLE;
  return {
    available: true,
    path: raw.path ?? null,
    why: raw.why ?? null,
  };
}

/**
 * 启动时探测一次这台电脑的能力，并把结果写进提示词信封。
 *
 * 幂等：重复调用返回同一个 Promise，不会再问一次后端。
 * 永不抛异常：连不上后端、命令报错，一律按"不可用"处理。
 */
export async function initCapabilities(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      // tauri.ts 的 invoke 用了逐命令的联合类型；这里补一条该模块尚未声明的命令。
      const ask = invoke as unknown as (name: string) => Promise<RawCapabilities>;
      const raw = await ask("tool_capabilities");
      sheetsCached = normalize(raw?.sheets);
      pdfCached = normalize(raw?.pdf);
    } catch {
      sheetsCached = UNAVAILABLE;
      pdfCached = UNAVAILABLE;
    }
    setSheetHelper(sheetPromptLine(sheetsCached));
    setPdfHelper(pdfPromptLine(pdfCached));
  })();
  return pending;
}

/**
 * 旧名字，保留给现有调用方。等价于 {@link initCapabilities}。
 */
export const initSheetCapability = initCapabilities;

/** 同步读缓存的表格能力；没探测过或探测失败就是不可用。 */
export function sheetCapability(): ToolCapability {
  return sheetsCached;
}

/** 同步读缓存的 PDF 能力；没探测过或探测失败就是不可用。 */
export function pdfCapability(): ToolCapability {
  return pdfCached;
}

/**
 * 表格可用时给助手看的一段中文说明，否则 null。
 *
 * 这是指令信封的内容，允许出现 `cante-sheets`、`.xlsx`、命令写法——助手要照着
 * 它干活。两处重点是硬契约：
 *   * 结果文件必须是**新文件名**。那个名字已经有文件时，cante-sheets 会拒绝、
 *     不会覆盖，并说清是哪一个文件；这时不要反复重试同一个名字，要换一个。
 *   * 一次 write 只写出一张表，新文件里也只有这一张表；它不会往已有文件里追加，
 *     也不会动已有文件。（issue #95）
 * 最后一句仍然强调：结果一律写成 .xlsx，不要因为缺别的工具就换格式。
 */
export function sheetPromptLine(cap: ToolCapability): string | null {
  if (!cap.available) return null;
  const where = cap.path ? `（位置：${cap.path}）` : "";
  return [
    `这台电脑可以用 cante-sheets 读写表格文件${where}，包括 .xlsx。`,
    "看一个文件里有哪些表：cante-sheets sheets 文件路径。",
    "读一张表并输出成 CSV：cante-sheets read 文件路径；要指定表名就加 --sheet 表名。",
    "写结果：先把内容存成 CSV，再运行 cante-sheets write 结果.xlsx 数据.csv；要指定表名就加 --sheet 表名。",
    "写结果时，结果.xlsx 必须是一个**还不存在**的新文件名。如果那个名字已经有文件，cante-sheets 会拒绝、不会覆盖，并告诉你是哪一个文件。这时候不要反复重试同一个名字：换一个新名字（例如在名字后面加「-新」「-2」）再写；如果旧文件确实该改名，也要先请用户自己改。",
    "一次 cante-sheets write 只写出一张表，写出的新文件里也只有这一张表；它不会往已有文件里追加表，也不会改动已有文件。要合成两张表就给两个不同名字的新文件，或者把内容并到同一张表里再写。",
    "表名要用中文或普通文字：不能是空的，不能超过 31 个字，也不能带 \\ / ? * [ ] : 这些符号。",
    "结果文件要用它写成 .xlsx，不要因为缺少别的工具就改成别的格式。",
  ].join("\n");
}

/**
 * PDF 可用时给助手看的一段中文说明，否则 null。
 *
 * 同样是指令信封的内容，允许出现 `cante-pdf`、`--pages` 这类写法。最后一句是
 * 重点：扫描件没有文字层时会直接报出来，助手要先停下告诉用户，不许拿空白交差。
 */
export function pdfPromptLine(cap: ToolCapability): string | null {
  if (!cap.available) return null;
  const where = cap.path ? `（位置：${cap.path}）` : "";
  return [
    `这台电脑可以用 cante-pdf 处理 PDF 文件${where}：pages 看页数、text 抽文字、merge 合并、split 拆分。`,
    "看一份 PDF 有多少页：cante-pdf pages 文件路径。",
    "抽出文字：cante-pdf text 文件路径；只要某几页就加 --pages 1-5。",
    "按顺序合并：cante-pdf merge 结果.pdf 第一份.pdf 第二份.pdf。",
    "抽出一段另存：cante-pdf split 文件路径 --pages 1-5 --out 结果.pdf。",
    "如果这份 PDF 没有文字层（扫描或拍照的），cante-pdf 会明确报出来。这时候先停下来告诉我需要先做文字识别，不要当成里面没有内容。",
    "还有一种情况：cante-pdf text 会用退出码 3 并打印「警告：…文字很可能是乱码」，说明这份 PDF 的字体没有自带文字对照表（打印或导出的中文 PDF 常见）。这时候不要拿抽出来的文字下结论——先告诉用户这份大概是扫描件或字体缺文字信息，请他核对原件。",
  ].join("\n");
}

/**
 * 表格不可用时给用户看的一句中性说明，否则 null。
 *
 * 这是边界不是错误，所以措辞里没有"失败""错误"，确认页也用中性颜色显示。
 */
export function sheetFallbackNote(cap: ToolCapability): string | null {
  if (cap.available) return null;
  return SHEET_COPY.fallbackNote;
}

/** PDF 不可用时给用户看的一句中性说明，否则 null。 */
export function pdfFallbackNote(cap: ToolCapability): string | null {
  if (cap.available) return null;
  return PDF_COPY.fallbackNote;
}

// ---------------------------------------------------------------------------
// 看图能力（#48）
//
// 和表格/PDF 不一样：这条不看这台电脑装了什么，而看当前会话用的那个设置能不能
// 看懂照片。信息就写在会话的模型信息里（`ModelSpec.support_vision`），由守护进程
// 在 `SessionStart` 时声明。这里只负责把它读出来、翻成两句人话：一句给助手（提示词
// 信封），一句给她（确认页的边界说明）。
// ---------------------------------------------------------------------------

/**
 * 这个会话背后的助手能不能看图。
 *
 * 读不到（字段缺省、还没开会话）一律当「看不了」——这是保守的方向：看不了时我
 * 们会先告诉她，而不是让助手对着照片硬编一张表。
 */
export function visionAvailable(session: SessionInfo | null | undefined): boolean {
  return session?.model?.support_vision === true;
}

/**
 * 把「能不能看图」同步进提示词信封，并返回当前结论。
 *
 * 确认页显示时会调用（会话信息可能比首屏晚到，所以跟着会话变化重复调用也无妨）。
 * 可用不可用都写进信封：看不了图时，助手也要知道这件事，才会在用户塞来照片时先
 * 停下来说明，而不是凭空编一张表。
 */
export function syncVisionForPrompt(session: SessionInfo | null | undefined): boolean {
  const available = visionAvailable(session);
  setVisionHelper(visionPromptLine(available));
  return available;
}

/**
 * 给助手看的一段中文说明：这个会话能不能看图。可用、不可用都返回非 null。
 *
 * 允许出现「图片」「照片」「截图」这些词——这是发给助手的内容，不是给用户看的。
 * 关键的一句是最后那句：看不了就如实说做不到，不要编一张表出来。
 */
export function visionPromptLine(available: boolean): string {
  if (available) {
    return [
      "这个会话背后的助手可以直接看图片：照片和截图（jpg、png、heic、webp 等）都能看。",
      "遇到图片里的表格，就按上面的做法逐格照抄；看不清的格子一律留空并指出来，绝对不要猜一个数。",
    ].join("\n");
  }
  return [
    "这个会话背后的助手看不了图片：照片和截图里的内容它看不到。",
    "如果用户给了图片，先停下来如实说明看不了，并请他把表里的内容用文字写下来、或者换一个能看图的设置。不要凭空编一张表出来，也不要假装看懂了。",
  ].join("\n");
}

/**
 * 看不了图时给用户看的一句中性说明，否则 null。
 *
 * 这是边界不是错误，所以措辞里没有「失败」「错误」，确认页也用中性颜色显示。
 */
export function visionFallbackNote(available: boolean): string | null {
  return available ? null : VISION_COPY.fallbackNote;
}
