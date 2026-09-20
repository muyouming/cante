// 把结果表变成「微信里能贴的纯文字」，外加一句告诉她这堆字长什么样的说明。
//
// 为什么需要它：她的结果常常是一张表，而对面的人在微信上。到这一步为止，结果
// 卡片能给的只有「打开文件」——剩下要她自己到 Excel 里框选单元格、复制、切到
// 微信、粘贴。这恰好是没人教过她的那一步。于是这里只做一件事：把表格内容变成
// 一段纯文字，她按一个键复制，自己到微信里粘贴。
//
// 纯逻辑、不碰剪贴板、不碰磁盘，所以 `bun test` 能把排版的算术钉住：中文按两个
// 宽度算、长格截断加「…」、列多时改成「名称：值」、行多时分段、空值写成空。
// 组件只负责把这里的结果送进剪贴板。

// 「一批结果一次复制」的话（开头总起、每份的小标题）放在 copy-batch.ts，和别的
// 面向用户中文一样。这里只放拼段与判断，所以 bun test 能把「几份、怎么隔开」钉住。
import { BATCH } from "./copy-batch.ts";

/** 单元格能出现的值：read 命令给的是字符串，但空值一律要写成空。 */
export type CellValue = string | number | boolean | null | undefined;
export type TableRow = readonly CellValue[];

export interface ChatTextOptions {
  /** 一行的目标宽度，按半角算（一个汉字算 2）。默认 {@link CHAT_MAX_WIDTH}。 */
  maxWidth?: number;
  /** 一段最多放多少行数据；超过就另起一段、重报表头。 */
  rowsPerSegment?: number;
}

/** 一行的默认目标宽度。手机上微信一屏大概就这么宽。 */
export const CHAT_MAX_WIDTH = 34;

/** 一段数据的默认行数。太长的一条消息在微信里会被折叠，分段更好发。 */
export const CHAT_ROWS_PER_SEGMENT = 20;

/** 列数不超过这个值时按列对齐；再多就改成「名称：值」。 */
export const ALIGNED_COLUMN_LIMIT = 4;

/** 相邻两列之间留的空格数。 */
const COLUMN_GAP = 2;

/** 一列再挤也要留的最小宽度（够放两三个汉字）。 */
const MIN_COLUMN_WIDTH = 4;

const ELLIPSIS = "…";

// ---------------------------------------------------------------------------
// 基本量
// ---------------------------------------------------------------------------

/** 把一个单元格变成要写出去的文字。空值写成空，绝不写成 undefined。 */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  // 数字与布尔：String(1200) 是 "1200"，不会出现 "1200.0" 这种毛病。
  return String(value).replace(/\s+/g, " ").trim();
}

/** 表格里整行整列都空时用的空行。 */
interface Grid {
  /** 表头，永远存在（原表第一行）。 */
  header: string[];
  /** 表头之后的数据行。 */
  body: string[][];
  /** 整张表一共几列。 */
  columns: number;
}

/**
 * 规整输入：每个格子变成干净的文字，去掉末尾整行全空的行（Excel 常有）。
 *
 * 表头一定保留：即使只有表头、一行数据都没有，`header` 也是原来那行。
 */
function normalize(rows: readonly TableRow[]): Grid {
  const grid = (rows ?? []).map((row) => (row ?? []).map(cellText));
  while (grid.length > 1 && grid[grid.length - 1]!.every((cell) => cell === "")) {
    grid.pop();
  }
  if (grid.length === 0) return { header: [], body: [], columns: 0 };
  const header = grid[0]!;
  const body = grid.slice(1);
  let columns = header.length;
  for (const row of body) columns = Math.max(columns, row.length);
  return { header, body, columns };
}

/**
 * 一个字符占几个半角宽度。CJK、全角标点、韩文、常见 emoji 算 2，其余算 1。
 *
 * 只为了排版：微信字体不是等宽的，真正贴出去后列不会像素级对齐，但按两个宽度
 * 算能让汉字列和数字列大致落在同一竖线上，比不排好得多。
 */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 一段文字的显示宽度，按半角算。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    width += codePoint === undefined ? 1 : charWidth(codePoint);
  }
  return width;
}

/** 把文字截到给定宽度；截断时在末尾补一个「…」。 */
function fitCell(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const room = width - displayWidth(ELLIPSIS);
  if (room <= 0) return ELLIPSIS;
  let out = "";
  let used = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const step = codePoint === undefined ? 1 : charWidth(codePoint);
    if (used + step > room) break;
    out += character;
    used += step;
  }
  return `${out}${ELLIPSIS}`;
}

/** 在右边补空格，把文字撑到给定宽度。 */
function padTo(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

// ---------------------------------------------------------------------------
// 排版一：列少 → 对齐的表格
// ---------------------------------------------------------------------------

/**
 * 每列要多宽。先按内容取自然宽度，总宽超了就一列一列地削最宽的那列，
 * 直到装得下或者每列都到了下限。
 */
function columnWidths(grid: Grid, maxWidth: number): number[] {
  const natural: number[] = [];
  for (let column = 0; column < grid.columns; column += 1) {
    let widest = displayWidth(grid.header[column] ?? "");
    for (const row of grid.body) widest = Math.max(widest, displayWidth(row[column] ?? ""));
    natural.push(Math.max(widest, 1));
  }
  const budget = Math.max(
    grid.columns * MIN_COLUMN_WIDTH,
    maxWidth - COLUMN_GAP * (grid.columns - 1),
  );
  const total = (): number => natural.reduce((sum, width) => sum + width, 0);
  while (total() > budget) {
    let widest = -1;
    for (let column = 0; column < natural.length; column += 1) {
      if (natural[column]! <= MIN_COLUMN_WIDTH) continue;
      if (widest === -1 || natural[column]! > natural[widest]!) widest = column;
    }
    if (widest === -1) break;
    natural[widest] = natural[widest]! - 1;
  }
  return natural;
}

function renderAlignedRow(row: readonly string[], widths: readonly number[]): string {
  const cells: string[] = [];
  for (let column = 0; column < widths.length; column += 1) {
    const filled = fitCell(row[column] ?? "", widths[column]!);
    // 最后一列不补空格，粘出去才没有一排看不见的尾巴。
    cells.push(column === widths.length - 1 ? filled : padTo(filled, widths[column]!));
  }
  return cells.join(" ".repeat(COLUMN_GAP)).replace(/\s+$/, "");
}

function alignedText(grid: Grid, maxWidth: number, rowsPerSegment: number): string {
  const widths = columnWidths(grid, maxWidth);
  const header = renderAlignedRow(grid.header, widths);
  if (grid.body.length === 0) return header;
  const segments: string[] = [];
  for (let start = 0; start < grid.body.length; start += rowsPerSegment) {
    const lines = [header];
    for (const row of grid.body.slice(start, start + rowsPerSegment)) {
      lines.push(renderAlignedRow(row, widths));
    }
    segments.push(lines.join("\n"));
  }
  // 空行分段：她一眼看得出这里可以另发一条。
  return segments.join("\n\n");
}

// ---------------------------------------------------------------------------
// 排版二：列多 → 「字段名：值」逐行
// ---------------------------------------------------------------------------

function fieldRecord(header: readonly string[], row: readonly string[]): string {
  const lines: string[] = [];
  const count = Math.max(header.length, row.length);
  for (let column = 0; column < count; column += 1) {
    const value = row[column] ?? "";
    if (value === "") continue; // 空字段不占一行，免得八行里有五行是空的
    const label = header[column] && header[column] !== "" ? header[column]! : `第 ${column + 1} 列`;
    lines.push(`${label}：${value}`);
  }
  return lines.join("\n");
}

function fieldText(grid: Grid, rowsPerSegment: number): string {
  if (grid.body.length === 0) {
    const names = grid.header.filter((name) => name !== "");
    return names.join("、");
  }
  const segments: string[] = [];
  for (let start = 0; start < grid.body.length; start += rowsPerSegment) {
    const records: string[] = [];
    for (const row of grid.body.slice(start, start + rowsPerSegment)) {
      const record = fieldRecord(grid.header, row);
      if (record !== "") records.push(record);
    }
    if (records.length > 0) segments.push(records.join("\n\n"));
  }
  return segments.join("\n\n");
}

// ---------------------------------------------------------------------------
// 对外的两个函数
// ---------------------------------------------------------------------------

/**
 * 把一张表变成微信里能贴的纯文字。
 *
 * 规则（都有测试钉着）：
 * * 第一行当表头，永远保留；
 * * 列数 ≤ 4：按列对齐，中文按两个宽度算，超宽的长格截断并补「…」；
 * * 列数 > 4：改成「字段名：值」，一条记录一段，空的字段不占行；
 * * 单元格里的换行、制表符一律压成空格，粘出去不会串行；
 * * 空值写成空，永远不会看到 undefined；
 * * 数据行超过 `rowsPerSegment` 就分段，每段重新带上表头，段与段之间空一行。
 *
 * 没有任何一行时返回空字符串——调用方据此说「这个表里没有内容」。
 */
export function tableToChatText(
  rows: readonly TableRow[],
  options: ChatTextOptions = {},
): string {
  const maxWidth = positive(options.maxWidth, CHAT_MAX_WIDTH);
  const rowsPerSegment = positive(options.rowsPerSegment, CHAT_ROWS_PER_SEGMENT);
  const grid = normalize(rows);
  if (grid.columns === 0) return "";
  if (grid.columns > ALIGNED_COLUMN_LIMIT) return fieldText(grid, rowsPerSegment);
  return alignedText(grid, maxWidth, rowsPerSegment);
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * 给用户看的一句说明：这表几行几列、贴进微信大概长什么样。
 *
 * `text` 就是 {@link tableToChatText} 的结果；空文字时说明「没内容可贴」，
 * 不假装已经准备好了。
 */
export function chatTextSummary(name: string, rows: readonly TableRow[], text: string): string {
  const label = name.trim() === "" ? "这张表" : `「${name.trim()}」`;
  const grid = normalize(rows);
  if (grid.columns === 0 || text.trim() === "") {
    return `${label}里没有可以贴进微信的内容。`;
  }
  const dataRows = grid.body.length;
  const look =
    grid.columns > ALIGNED_COLUMN_LIMIT
      ? "贴到微信里是「名称：内容」一行一项的样子"
      : "贴到微信里是上下对齐的一行一条，表头在最上面";
  const segments = Math.max(1, Math.ceil(dataRows / CHAT_ROWS_PER_SEGMENT));
  const split = segments > 1 ? `，内容偏长，建议分成 ${segments} 条发` : "";
  return `${label}一共 ${dataRows} 行、${grid.columns} 列。${look}${split}。`;
}

/** 会被当成表格的结果文件。只看扩展名，够用而且不会误报。 */
const TABLE_EXTENSIONS = [".xlsx", ".xls", ".csv"] as const;

/** 这个结果文件能不能按表格读出来、复制成文字。 */
export function isTablePath(path: string): boolean {
  const lowered = path.toLowerCase();
  return TABLE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

// ---------------------------------------------------------------------------
// 一批结果：一次交出去
// ---------------------------------------------------------------------------

/**
 * 批量要交出去的一份结果。
 *
 * **只给名字，不给完整位置**：这段文字是贴进微信给同事看的，她电脑上从哪个文件夹
 * 拿来的对同事没用，还可能把她本机的目录结构带出去。所以类型层面就不留位置这一项。
 */
export interface BatchEntry {
  /** 这份结果的名字（文件名，不含文件夹）。 */
  name: string;
  /** 表格内容；读不出来/不是表格时给空数组。 */
  rows: readonly TableRow[];
}

/** 拼好的批量文字，以及这次到底放进去了几份。 */
export interface BatchText {
  /** 能贴进微信的那段文字；一份都没放进去时是空字符串。 */
  text: string;
  /** 真正放进去的份数（有内容、也拼出来了的）。 */
  included: number;
  /** 放不进去的份数（空表、读不出来）：如实交代，不假装全都进去了。 */
  skipped: number;
}

/**
 * 把一批结果拼成**一段**能贴进微信的文字。
 *
 * 形状（都有测试钉着）：
 * * 第一行是总起，说清一共几份；
 * * 每份一段，先是「第 N 份「名字」」，接着沿用 {@link tableToChatText} 的段落形状；
 * * 段与段之间空一行——一眼能分辨是一份一份，而不是五份拼成一坨；
 * * 空表和读不出来的那份**不占段**，只计入 `skipped`，如实告诉她有几份没放进去。
 *
 * 一份都没拼出来时 `text` 是空字符串，调用方据此说「没有能复制的内容」，不硬凑。
 */
export function batchChatText(
  entries: readonly BatchEntry[],
  options: ChatTextOptions = {},
): BatchText {
  const blocks: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const body = tableToChatText(entry.rows, options);
    if (body.trim() === "") {
      skipped += 1;
      continue;
    }
    blocks.push(`${BATCH.section(blocks.length + 1, entry.name)}\n${body}`);
  }
  if (blocks.length === 0) return { text: "", included: 0, skipped };
  return {
    text: `${BATCH.heading(blocks.length)}\n\n${blocks.join("\n\n")}`,
    included: blocks.length,
    skipped,
  };
}

/**
 * 面板上要不要给「一次复制成微信」这个出口。
 *
 * 只有真有一份结果时才给：一份都没有时她已经有一条出路（卡片库），再挂一个点了
 * 没反应的按钮只是空话。
 */
export function canShareBatch(count: number): boolean {
  return Number.isFinite(count) && count >= 1;
}
