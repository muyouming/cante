// 表格读写能力的前端封装（issue #75）。
//
// 真机跑旗舰任务时，助手把文件读得很干净，却在"另存为 .xlsx"这一步停下说环境里
// 没有写 xlsx 的东西。问题不在助手，而在这台电脑确实缺工具，而且它事先不知道。
//
// 这个模块只做三件事：
//   * 启动时问一次后端"这台电脑能不能读写表格"，把结果缓存下来（幂等、永不抛）；
//   * 可用时给指令信封加一段中文说明，告诉助手用 cante-sheets 怎么读怎么写；
//   * 不可用时给确认页一段中性说明，让用户知道这是边界，不是错误。
import { invoke } from "../tauri.ts";
import { SHEET_COPY } from "./copy-capability.ts";
import { setSheetHelper } from "./tasks/prompt.ts";

export interface SheetCapability {
  available: boolean;
  path?: string | null;
  why?: string | null;
}

/** 后端 `sheet_capability` 命令的原始返回。 */
interface RawCapability {
  available?: boolean;
  path?: string | null;
  why?: string | null;
}

/** 还没探测到、或者探测失败时的保守默认值。 */
const UNAVAILABLE: SheetCapability = { available: false };

let cached: SheetCapability = UNAVAILABLE;
let pending: Promise<SheetCapability> | null = null;

function normalize(raw: RawCapability | null | undefined): SheetCapability {
  if (!raw || !raw.available) return UNAVAILABLE;
  return {
    available: true,
    path: raw.path ?? null,
    why: raw.why ?? null,
  };
}

/**
 * 启动时探测一次表格能力，并把结果写进提示词信封。
 *
 * 幂等：重复调用返回同一个 Promise，不会再问一次后端。
 * 永不抛异常：连不上后端、命令报错，一律按"不可用"处理。
 */
export async function initSheetCapability(): Promise<SheetCapability> {
  if (pending) return pending;
  pending = (async () => {
    try {
      // tauri.ts 的 invoke 用了逐命令的联合类型；这里补一条该模块尚未声明的命令。
      const ask = invoke as unknown as (name: string) => Promise<RawCapability>;
      cached = normalize(await ask("sheet_capability"));
    } catch {
      cached = UNAVAILABLE;
    }
    setSheetHelper(sheetPromptLine(cached));
    return cached;
  })();
  return pending;
}

/** 同步读缓存值；没探测过或探测失败就是不可用。 */
export function sheetCapability(): SheetCapability {
  return cached;
}

/**
 * 可用时给助手看的一段中文说明，否则 null。
 *
 * 这是指令信封的内容，允许出现 `cante-sheets`、`.xlsx`、命令写法——助手要照着
 * 它干活。落款特别强调：结果一律写成 .xlsx，不要因为缺别的工具就换格式。
 */
export function sheetPromptLine(cap: SheetCapability): string | null {
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
 * 不可用时给用户看的一句中性说明，否则 null。
 *
 * 这是边界不是错误，所以措辞里没有"失败""错误"，确认页也用中性颜色显示。
 */
export function sheetFallbackNote(cap: SheetCapability): string | null {
  if (cap.available) return null;
  return SHEET_COPY.fallbackNote;
}
