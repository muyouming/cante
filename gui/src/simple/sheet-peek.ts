// 结果核对（内容层）——「这是我要的那个吗」。
//
// verify.ts 核对的是「文件在不在、多大、能不能打开」。她真正会问的是另一件事：
// 这就是我要的那份内容吗。我们不替她下这个判断（那是自证：Wharton 的对照实验里，
// 「我查过了，内容没问题」这种话恰恰是掉信任的那种），而是把她自己能核对的三个数
// **照抄**出来：
//
//   * 第一行下面的行数（她做完「从大表里挑出想要的行」，第一件事就是数行数）；
//   * 第一行的列名（她一眼能认出「这是我要的那张表」）；
//   * 最前面几行的内容（只列头几行、照抄，不解释、不汇总、不改字）。
//
// 这三样都必须从产出文件里真读出来：走 `read_result_sheet`（Rust 的 `cante-sheets
// read`），和「复制成微信能贴的文字」是同一条路。读不出来就如实说读不出来，绝不
// 编一个数、也绝不替她断言内容对不对。
//
// 纯逻辑：真读的部分收在一个可替换的 `fetchRows` 后面，`bun test` 不需要 Tauri。

import { invoke } from "../tauri.ts";
import type { CellValue, TableRow } from "./share.ts";

/** 首屏照抄几行。只照抄，不加工。 */
export const PEEK_ROWS = 3;

/** 一张表最多照抄几列：再宽的表也只列前面这些列，免得挤成一团。 */
export const PEEK_COLUMNS = 8;

/** 从产出文件里读出来的、她自己能核对的那几样。 */
export interface SheetPeek {
  /** 数据行数：第一行（列名）下面的行数；末尾整行空的不算。 */
  rows: number;
  /** 第一行的列名，照抄（最多前 {@link PEEK_COLUMNS} 个；只去掉末尾补的空列，不改字）。 */
  columns: string[];
  /** 最前面最多 {@link PEEK_ROWS} 行，照抄（每行最多前 {@link PEEK_COLUMNS} 格）。 */
  head: string[][];
  /** 这张表一共有几列。 */
  columnCount: number;
}

export type PeekKind = "ok" | "empty" | "unknown";
export type PeekReason = "ok" | "empty" | "no-tool" | "failed";

/** 核对结论。`unknown` 时 `peek` 一定是 null：读不出来就没有数可报。 */
export interface SheetPeekResult {
  kind: PeekKind;
  reason: PeekReason;
  peek: SheetPeek | null;
}

function emptyResult(): SheetPeekResult {
  return { kind: "empty", reason: "empty", peek: null };
}

function unknownResult(reason: PeekReason): SheetPeekResult {
  return { kind: "unknown", reason, peek: null };
}

/**
 * 一个格子变成要照抄出去的文字。
 *
 * 只做显示必需的规整：换行、制表符压成空格（否则一行拆成两行），去掉两头空白。
 * 不改字、不补字、不省略——除空格以外的每一个字符都原样保留。
 */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** 一行变成文字数组；只去掉末尾补出来的空格子（Excel 的空白列），中间的空保留。 */
function rowText(row: TableRow | undefined): string[] {
  const cells = (row ?? []).map(cellText);
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * 纯计算：拿「从文件里读回来的行」得出她自己能核对的那几个数。
 *
 * `rows === null` 表示这次根本没读回来（工具不在、读失败）：说「没能读到」，
 * 绝不当成空表，也绝不报一个 0。
 *
 * 第一行按列名处理（和 `share.ts` 的「复制成微信」是同一套定义），末尾整行空的
 * 行是 Excel 常见的补白，不算数据行。
 */
export function peekSheet(rows: readonly TableRow[] | null): SheetPeekResult {
  if (rows === null) return unknownResult("failed");
  const grid = rows.map(rowText);
  while (grid.length > 1 && grid[grid.length - 1]!.length === 0) grid.pop();
  if (grid.length === 0 || grid.every((row) => row.length === 0)) return emptyResult();

  const columns = grid[0]!;
  const body = grid.slice(1);
  let columnCount = columns.length;
  for (const row of body) columnCount = Math.max(columnCount, row.length);
  return {
    kind: "ok",
    reason: "ok",
    peek: {
      rows: body.length,
      columns: columns.slice(0, PEEK_COLUMNS),
      head: body.slice(0, PEEK_ROWS).map((row) => row.slice(0, PEEK_COLUMNS)),
      columnCount,
    },
  };
}

/**
 * 把桥接的原始返回变成结论。形状不对（不是对象、没有 rows、rows 不是数组）一律
 * 按「没能读到」算，不把坏数据当成「表是空的」。
 */
export function peekFromResponse(input: unknown): SheetPeekResult {
  if (!input || typeof input !== "object") return unknownResult("failed");
  const rows = (input as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return unknownResult("failed");
  return peekSheet(rows as TableRow[]);
}

type OpInvoke = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * 生产用的读法：问 Rust 的 `read_result_sheet`（它再调 `cante-sheets read`）。
 * 桥接不在（浏览器预览）时会抛错，由 `readSheetPeek` 接住并如实说「没能读到」。
 */
export async function fetchSheetRows(path: string, tool: string): Promise<unknown> {
  const call = invoke as unknown as OpInvoke;
  return call("read_result_sheet", { tool, path });
}

/**
 * 从一个结果文件里读出她自己能核对的几个数。
 *
 * `tool` 是这台电脑上读表格的工具位置（来自能力探测）；没有工具就直接说「这台电脑
 * 还读不出」，连试都不试。任何抛错都变成「没能读到」，因为「说不清」和「假装读过」
 * 是两回事。
 */
export async function readSheetPeek(
  path: string,
  tool: string | null | undefined,
  fetchRows: (path: string, tool: string) => Promise<unknown> = fetchSheetRows,
): Promise<SheetPeekResult> {
  if (!tool) return unknownResult("no-tool");
  try {
    const raw = await fetchRows(path, tool);
    return peekFromResponse(raw);
  } catch {
    return unknownResult("failed");
  }
}
