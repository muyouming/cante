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
import { PDF_COPY, SHEET_COPY } from "./copy-capability.ts";
import { setPdfHelper, setSheetHelper } from "./tasks/prompt.ts";

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
 * 它干活。落款特别强调：结果一律写成 .xlsx，不要因为缺别的工具就换格式。
 */
export function sheetPromptLine(cap: ToolCapability): string | null {
  if (!cap.available) return null;
  const where = cap.path ? `（位置：${cap.path}）` : "";
  return [
    `这台电脑可以用 cante-sheets 读写表格文件${where}，包括 .xlsx。`,
    "看一个文件里有哪些表：cante-sheets sheets 文件路径。",
    "读一张表并输出成 CSV：cante-sheets read 文件路径；要指定表名就加 --sheet 表名。",
    "写结果：先把内容存成 CSV，再运行 cante-sheets write 结果.xlsx 数据.csv；要指定表名就加 --sheet 表名。",
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
