// 每张卡真正发出去的指令有多大 —— 估算，不是计费口径。
//
// 为什么要量它：真机普查量到一张正常的卡要 30–60 秒、7–8 次模型往返、约 7000 输出
// token，而**上下文每一轮都要重发一遍**。也就是说这笔账是「指令大小 × 往返次数」，
// 输入侧到底多大，之前从没人量过。改提示词前后各跑一次，就知道自己动了多少。
//
//   cd gui && bun scripts/measure-prompts.ts
//
// 三条刻意的选择：
//
//   * 测的是**生产路径**：`instructionFor(taskId, files, 她的话)`——也就是
//     `store.composedInstruction` 用的那条线。绝不直接调 `task.prompt()`：那条线
//     曾经让一个 P0（卡片提示词从未发出）潜伏很久。
//   * 文件路径用**占位路径**（`C:\用户\桌面\2024年部门预算汇总表.xlsx`），不是本机
//     真实路径：报告要能贴出去，不能带真用户名；长度也刻意贴近真机。
//   * 工具段（表格 / PDF / 看图）单独量一遍：它们在真机上装了自带工具时**每张卡都带**，
//     是信封里最大的一块；文字取自 `simple/capabilities.ts`，不在这里抄第二份。
//
// 退出码固定 0（除非测量本身炸了）。发现没登记过的块标题只警告，不红——它是给人看的
// 温度计，不是门禁。
import {
  TASKS,
  instructionFor,
} from "../src/simple/tasks/index.ts";
import {
  setPdfHelper,
  setSheetHelper,
  setVisionHelper,
} from "../src/simple/tasks/prompt.ts";
import {
  pdfPromptLine,
  sheetPromptLine,
  visionPromptLine,
} from "../src/simple/capabilities.ts";

// ---------------------------------------------------------------------------
// 固定输入：她的一句话、她选的文件
// ---------------------------------------------------------------------------

/** 固定成一句话，卡片之间才可比。 */
const HER_SENTENCE = "把这份东西按我要的样子弄好";

/**
 * 占位路径（不是本机真实路径）：报告要能贴出去，不能带本机用户名。
 * 长度刻意贴近真机的一个中文桌面文件（26 字符），免得把「每个文件一行」的成本低估。
 */
const SAMPLE_FILE = "C:\\用户\\桌面\\2024年部门预算汇总表.xlsx";
const SAMPLE_FILES = [SAMPLE_FILE];

/** 真机事件日志里量到的往返次数（scripts/sweep/README.md 的实测表）。 */
const ROUNDS_MIN = 7;
const ROUNDS_MAX = 8;

// ---------------------------------------------------------------------------
// 估算 token
// ---------------------------------------------------------------------------

/** 中日韩文字与全角标点：这类字符在主流分词器里基本一字符一个 token。 */
const CJK =
  /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/**
 * 估算 token 数。
 *
 * 方法：中日韩字符（含全角标点）按 1 token/字，其余**非空白**字符按 1 token/4 字符
 * （新行、缩进这种空白在 BPE 里会被并进相邻 token，这里忽略不计）。
 *
 * 误差来源，写清楚是因为它**不是**计费口径：
 *   * 不同服务方（以及同一家的不同版本）对中文的分法不一样，偏差可以到 ±20%；
 *   * 我们把空白算成 0，偏乐观；
 *   * 信封之外的输入这里一个字都没算——宿主自己的系统提示、工具说明书、历史轮次
 *     都在计费口径里，而它们不在这个仓库里（见 README 的诚实边界）。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

const codePoints = (text: string): number => [...text].length;

// ---------------------------------------------------------------------------
// 按段落拆开
// ---------------------------------------------------------------------------

/**
 * 每一段的标题。`buildPrompt` 写死了这些块，卡片的 `prompt()` 不能自造标题——
 * 所以这张表同时也是「信封有没有被人偷偷改形状」的探针。
 */
const SEGMENT_BY_HEADER: Record<string, Segment> = {
  "【要做的事】": "card-what",
  "【要处理的文件】": "files",
  "【要整理的文件夹】": "files",
  "【怎么做】": "card-how",
  "【必须守住的规矩】": "rules",
  "【用户的原话】": "user",
  "【这台电脑怎么读写表格】": "tool-sheets",
  "【这台电脑怎么处理 PDF】": "tool-pdf",
  "【这台电脑能不能看图】": "tool-vision",
  "【做完告诉我】": "card-done",
  "【最后再加一段】": "check-note",
};

type Segment =
  | "card-what"
  | "files"
  | "card-how"
  | "rules"
  | "user"
  | "tool-sheets"
  | "tool-pdf"
  | "tool-vision"
  | "card-done"
  | "check-note"
  // 规矩段里那一行由卡片自己加进来的补充规矩（`buildPrompt` 的 extraRule）。
  | "card-extra-rule"
  | "other";

/** 表格里按这个顺序排，顺序即「谁大谁小」的阅读顺序。 */
const SEGMENT_ORDER: Segment[] = [
  "card-what",
  "card-how",
  "card-done",
  "card-extra-rule",
  "files",
  "rules",
  "user",
  "tool-sheets",
  "tool-pdf",
  "tool-vision",
  "check-note",
  "other",
];

/** 给报告用的中文标签；表头要短。 */
const SEGMENT_LABEL: Record<Segment, string> = {
  "card-what": "卡片·要做的事",
  "card-how": "卡片·怎么做",
  "card-done": "卡片·做完告诉我",
  "card-extra-rule": "卡片·补充规矩",
  files: "文件清单",
  rules: "公共安全规则",
  user: "她的话",
  "tool-sheets": "工具·表格",
  "tool-pdf": "工具·PDF",
  "tool-vision": "工具·看图",
  "check-note": "核对段",
  other: "其它",
};

/** 报告里合并展示的几大块（卡片正文 = 四段卡片自己的话）。 */
const GROUPS: { label: string; segments: Segment[] }[] = [
  { label: "卡片正文", segments: ["card-what", "card-how", "card-done", "card-extra-rule"] },
  { label: "文件清单", segments: ["files"] },
  { label: "公共安全规则", segments: ["rules"] },
  { label: "她的话", segments: ["user"] },
  { label: "工具段（表格+PDF+看图）", segments: ["tool-sheets", "tool-pdf", "tool-vision"] },
  { label: "核对段", segments: ["check-note"] },
  { label: "其它", segments: ["other"] },
];

/**
 * 把一段拼好的指令按块标题切成「哪一块说了什么」。
 *
 * 规矩段里的补充规矩单独拎出来：它由**卡片**提供（每张卡都可能不一样），
 * 和七条公共规矩不是一回事，混在一起会看不到公共部分到底多大。
 */
function segmentLines(composed: string): { bySegment: Map<Segment, string>; unknownHeaders: string[] } {
  const bySegment = new Map<Segment, string>();
  const unknownHeaders: string[] = [];
  // 第一个块标题之前不该有东西（只有块之间的空行）；真有正文就归到「其它」，别偷丢掉。
  let current: Segment = "other";
  for (const line of composed.split("\n")) {
    const header = /^【[^】]{0,40}】/.exec(line)?.[0];
    if (header) {
      const known = SEGMENT_BY_HEADER[header];
      if (known) current = known;
      else {
        current = "other";
        if (!unknownHeaders.includes(header)) unknownHeaders.push(header);
      }
    }
    // 补充规矩是规矩段里的一行（前缀「- 」），不是自己的块。
    const target =
      current === "rules" && line.startsWith("- 【这个任务的补充】") ? "card-extra-rule" : current;
    bySegment.set(target, `${bySegment.get(target) ?? ""}${line}\n`);
  }
  return { bySegment, unknownHeaders };
}

interface Parts {
  segments: Record<Segment, string>;
  total: string;
  unknownHeaders: string[];
}

function splitParts(composed: string): Parts {
  const { bySegment, unknownHeaders } = segmentLines(composed);
  const segments = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, ""])) as Record<
    Segment,
    string
  >;
  for (const [segment, text] of bySegment) segments[segment] += text;
  return { segments, total: composed, unknownHeaders };
}

// ---------------------------------------------------------------------------
// 测量
// ---------------------------------------------------------------------------

type Mode = "none" | "full";

function setCapabilities(mode: Mode): void {
  setSheetHelper(mode === "full" ? sheetPromptLine({ available: true }) : null);
  setPdfHelper(mode === "full" ? pdfPromptLine({ available: true }) : null);
  setVisionHelper(mode === "full" ? visionPromptLine(true) : null);
}

interface Row {
  id: string;
  title: string;
  parts: Record<Mode, Parts>;
  chars: Record<Mode, number>;
  tokens: Record<Mode, number>;
}

function measure(): Row[] {
  const rows: Row[] = [];
  for (const task of TASKS) {
    const parts = {} as Record<Mode, Parts>;
    const chars = {} as Record<Mode, number>;
    const tokens = {} as Record<Mode, number>;
    for (const mode of ["none", "full"] as const) {
      setCapabilities(mode);
      const composed = instructionFor(task.id, SAMPLE_FILES, HER_SENTENCE);
      if (composed === null) {
        // 生产路径拼不出指令 = 那张卡会退化成「只发她那一句话」。这里必须喊出来。
        throw new Error(`${task.id}: instructionFor 返回 null（生产路径拼不出这张卡）`);
      }
      parts[mode] = splitParts(composed);
      chars[mode] = codePoints(composed);
      tokens[mode] = estimateTokens(composed);
    }
    rows.push({ id: task.id, title: task.title, parts, chars, tokens });
  }
  setCapabilities("none");
  return rows;
}

function sumSegments(rows: Row[], mode: Mode, segments: Segment[]): number {
  let total = 0;
  for (const row of rows) {
    for (const segment of segments) total += codePoints(row.parts[mode].segments[segment]);
  }
  return total;
}

/** 同样几段的估算 token 合计（逐段估再相加，别拿拼好的长串去估）。 */
function sumTokens(rows: Row[], mode: Mode, segments: Segment[]): number {
  let total = 0;
  for (const row of rows) {
    for (const segment of segments) {
      total += estimateTokens(row.parts[mode].segments[segment]);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

/** 中日韩字符在终端里占两格。表格对齐靠它。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += CJK.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

function padLeft(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? " ".repeat(missing) + text : text;
}

function truncate(text: string, width: number): string {
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > width) return `${out}…`;
    out += ch;
  }
  return out;
}

const number = (value: number): string => value.toLocaleString("zh-CN");

function printTable(rows: Row[]): void {
  const header = [
    pad("卡片 id", 24),
    pad("标题", 12),
    padLeft("无工具段", 12),
    padLeft("带工具段", 12),
    padLeft("卡片正文", 9),
    padLeft("清单", 6),
    padLeft("规矩", 6),
    padLeft("她的话", 7),
    padLeft("工具段", 7),
    padLeft("核对", 6),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(displayWidth(header)));
  for (const row of rows) {
    const cell = (mode: Mode, segments: Segment[]): string =>
      number(sumSegments([row], mode, segments));
    console.log(
      [
        pad(truncate(row.id, 23), 24),
        pad(truncate(row.title, 10), 12),
        padLeft(`${number(row.chars.none)}/${number(row.tokens.none)}`, 12),
        padLeft(`${number(row.chars.full)}/${number(row.tokens.full)}`, 12),
        padLeft(cell("full", ["card-what", "card-how", "card-done", "card-extra-rule"]), 9),
        padLeft(cell("full", ["files"]), 6),
        padLeft(cell("full", ["rules"]), 6),
        padLeft(cell("full", ["user"]), 7),
        padLeft(cell("full", ["tool-sheets", "tool-pdf", "tool-vision"]), 7),
        padLeft(cell("full", ["check-note"]), 6),
      ].join(" "),
    );
  }
  console.log(
    "（无工具段 / 带工具段 两列都是「字符数/估算 token 数」；右侧六列是带工具段时的字符数拆分）",
  );
}

function printGroupTotals(rows: Row[], mode: Mode): void {
  const grand = sumSegments(rows, mode, SEGMENT_ORDER);
  const averageChars = Math.round(grand / rows.length);
  const averageTokens = Math.round(
    rows.reduce((sum, row) => sum + row.tokens[mode], 0) / rows.length,
  );
  console.log(
    `\n每张卡平均（${mode === "full" ? "带工具段" : "无工具段"}）：` +
      `${number(averageChars)} 字符 / 约 ${number(averageTokens)} token`,
  );
  for (const group of GROUPS) {
    const chars = sumSegments(rows, mode, group.segments);
    if (chars === 0) continue;
    const perCard = Math.round(chars / rows.length);
    const perCardTokens = Math.round(sumTokens(rows, mode, group.segments) / rows.length);
    const share = ((chars / grand) * 100).toFixed(1);
    console.log(
      `  ${pad(group.label, 26)} 平均 ${padLeft(number(perCard), 5)} 字符` +
        `  约 ${padLeft(number(perCardTokens), 5)} token` +
        `  占 ${padLeft(`${share}%`, 6)}`,
    );
  }
  // 单独看一眼各段（不合并），「最大的一段」要看这一层。
  const perSegment = SEGMENT_ORDER.filter((s) => s !== "other")
    .map((segment) => ({ segment, chars: sumSegments(rows, mode, [segment]) }))
    .filter((entry) => entry.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  if (mode === "full") {
    console.log("  按单段排（平均每张卡）：");
    for (const entry of perSegment.slice(0, 5)) {
      console.log(
        `    ${pad(SEGMENT_LABEL[entry.segment], 22)} ${padLeft(
          number(Math.round(entry.chars / rows.length)),
          5,
        )} 字符`,
      );
    }
  }
}

function printExtremes(rows: Row[]): void {
  const sorted = [...rows].sort((a, b) => a.chars.full - b.chars.full);
  const median = sorted[Math.floor(sorted.length / 2)];
  const smallest = sorted[0];
  const largest = sorted[sorted.length - 1];
  const label = (row: Row): string =>
    `${row.id}（${row.title}）${number(row.chars.full)} 字符 / 约 ${number(row.tokens.full)} token`;
  console.log(`\n最小：${label(smallest)}`);
  console.log(`中位：${label(median)}`);
  console.log(`最大：${label(largest)}`);
  const largestSegment = SEGMENT_ORDER.filter((s) => s !== "other")
    .map((segment) => ({
      segment,
      average: sumSegments(rows, "full", [segment]) / rows.length,
    }))
    .sort((a, b) => b.average - a.average)[0];
  console.log(
    `最大的那一段（平均每张卡）：${SEGMENT_LABEL[largestSegment.segment]}，` +
      `约 ${number(Math.round(largestSegment.average))} 字符`,
  );
}

function printRoundsAccount(rows: Row[]): void {
  const averageTokens = rows.reduce((sum, row) => sum + row.tokens.full, 0) / rows.length;
  console.log("\n账：上下文每轮都要重发一遍");
  for (const rounds of [ROUNDS_MIN, ROUNDS_MAX]) {
    const inputTokens = Math.round(averageTokens * rounds);
    console.log(
      `  ${rounds} 次往返 × 平均 ${number(Math.round(averageTokens))} token` +
        ` = 约 ${number(inputTokens)} 输入 token（每张卡，只算我们写的这段指令）`,
    );
  }
  console.log(
    `  真机实测同一张卡的模型**输出**约 7000 token（scripts/sweep/README.md 的实测表），` +
      `所以输入侧这段指令的量级和输出在同一个数量级上。`,
  );
  console.log(
    "  注意：这里只算「我们写的那段指令」。宿主自己的系统提示、工具说明书、历史轮次\n" +
      "  也在计费口径里，但不在这个仓库里 —— 真实输入只会更大，不会更小。",
  );
}

/** 多选几个文件会加多少：每多一个文件，文件清单多一行绝对路径。 */
function printFileSensitivity(): void {
  setCapabilities("full");
  const taskId = "check.totals";
  const perFile = codePoints(SAMPLE_FILE) + 4; // 序号 + 「. 」 + 换行
  const measureOne = (count: number): number => {
    const files = Array.from({ length: count }, (_, index) =>
      index === 0 ? SAMPLE_FILE : SAMPLE_FILE.replace(/\.xlsx$/, `-${index + 1}.xlsx`),
    );
    const composed = instructionFor(taskId, files, HER_SENTENCE);
    return composed === null ? 0 : codePoints(composed);
  };
  const one = measureOne(1);
  const three = measureOne(3);
  const ten = measureOne(10);
  console.log(
    `\n多选文件（${taskId}，带工具段）：1 个 ${number(one)} 字符，3 个 ${number(three)}，` +
      `10 个 ${number(ten)} —— 每多一个文件约 +${perFile} 字符（就是那一行绝对路径）。`,
  );
  setCapabilities("none");
}

/**
 * 两句话里最长的一段共同文字。重复句扫描与跨段重叠扫描都用它。
 * 字串都很短（一句几十字），直接 O(n²) 比。
 */
function longestCommonPiece(a: string, b: string): { length: number; phrase: string } {
  let length = 0;
  let phrase = "";
  for (let x = 0; x < a.length; x += 1) {
    for (let y = 0; y < b.length; y += 1) {
      let k = 0;
      while (a[x + k] !== undefined && a[x + k] === b[y + k]) k += 1;
      if (k > length) {
        length = k;
        phrase = a.slice(x, x + k);
      }
    }
  }
  return { length, phrase };
}

/**
 * 句子级跨段重叠扫描：同一段指令里，两个不同块之间重复出现 ≥16 字的片段。
 *
 * 整行重复那一层（下面那个函数）太粗——同一句话被拆成两行就看不见了。所以这里
 * 按句号/分号切句，再找最长公共片段。小于 16 字的重叠基本是「同一个术语」这种
 * 正常复用，不算重复。
 */
function printCrossSegmentOverlap(rows: Row[]): void {
  const MIN = 16;
  const hits: { id: string; pair: string; phrase: string }[] = [];
  for (const row of rows) {
    const { bySegment } = segmentLines(row.parts.full.total);
    const segments = [...bySegment.keys()].filter((s) => s !== "other");
    const sentences = (text: string): string[] =>
      text
        .split(/[。；\n]+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => codePoints(sentence) >= MIN);
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        for (const a of sentences(bySegment.get(segments[i]) ?? "")) {
          for (const b of sentences(bySegment.get(segments[j]) ?? "")) {
            const { length, phrase } = longestCommonPiece(a, b);
            if (length >= MIN) {
              hits.push({
                id: row.id,
                pair: `${SEGMENT_LABEL[segments[i]]} ↔ ${SEGMENT_LABEL[segments[j]]}`,
                phrase,
              });
            }
          }
        }
      }
    }
  }
  const unique = new Map<string, { pair: string; phrase: string; ids: Set<string> }>();
  for (const hit of hits) {
    const key = `${hit.pair}|${hit.phrase}`;
    const entry = unique.get(key) ?? { pair: hit.pair, phrase: hit.phrase, ids: new Set<string>() };
    entry.ids.add(hit.id);
    unique.set(key, entry);
  }
  console.log(`\n句子级跨段重叠扫描（同一段指令里两个块之间 ≥${MIN} 字的共同片段）`);
  if (unique.size === 0) {
    console.log("  没有。");
  }
  for (const [, entry] of unique) {
    console.log(
      `  ${pad(entry.pair, 34)} ${padLeft(`${entry.ids.size} 张卡`, 6)}  「${truncate(
        entry.phrase,
        50,
      )}」`,
    );
  }
  console.log(
    "  说明：命中只有上面这几处，全是「同一个术语在几个块里各出现一次」（比如规矩里的「工具」" +
      "和卡片步骤里的「工具」），没有一处是整句话被写了两遍。",
  );
}

/**
 * 工具段能不能按卡片裁掉：把「卡片自己提没提这件事」和「这张卡收得到这种文件吗」
 * 摆在一起。这一节只量、不改——它决定的是产品决策，不是脚本能定的。
 */
function printToolRelevance(): void {
  setCapabilities("none");
  console.log("\n工具段裁剪可行性（只量不改）");
  const rowsWithOwnText: { id: string; mentionsPdf: boolean; acceptsPdf: boolean }[] = [];
  for (const task of TASKS) {
    const composed = instructionFor(task.id, SAMPLE_FILES, HER_SENTENCE) ?? "";
    rowsWithOwnText.push({
      id: task.id,
      mentionsPdf: /pdf/i.test(composed),
      acceptsPdf: (task.accept ?? []).some((ext) => ext.toLowerCase() === "pdf"),
    });
  }
  setCapabilities("full");
  const acceptsPdf = rowsWithOwnText.filter((row) => row.acceptsPdf);
  const acceptsPdfWithoutMention = acceptsPdf.filter((row) => !row.mentionsPdf);
  const noFilterCards = TASKS.filter(
    (task) => task.needs === "files" && (task.accept ?? []).length === 0,
  ).map((task) => task.id);
  const folderCards = TASKS.filter((task) => task.needs === "folder").map((task) => task.id);
  console.log(
    `  收得到 PDF 的卡（accept 里有 pdf）：${acceptsPdf.length} 张 → ${
      acceptsPdf.map((row) => row.id).join("、")
    }`,
  );
  console.log(
    `  其中自己正文里没提 PDF 的：${acceptsPdfWithoutMention.length} 张` +
      (acceptsPdfWithoutMention.length > 0
        ? ` → ${acceptsPdfWithoutMention.map((row) => row.id).join("、")}`
        : ""),
  );
  console.log(`  选择器不过滤（accept 是空的，什么文件都可能交进来）：${noFilterCards.join("、")}`);
  console.log(
    `  收整个文件夹的卡（文件夹里可能有 PDF，accept 看不出）：${folderCards.join("、")}`,
  );
  console.log(
    "  结论：按「正文提没提」裁不安全 —— 上面第二、三、四行那几种卡都可能真的拿着一份 PDF 做事，" +
      "而它们的正文里不会出现 PDF 字样。按 accept 裁才安全，但那要把 accept 带进 buildPrompt" +
      "（卡片模块的改动，不在本轮的改动范围）。所以这一刀没动，数字留在这里给下一步决策。",
  );
  setCapabilities("none");
}

/**
 * 重复句扫描：同一段指令里出现两遍的整行（≥10 字）。
 *
 * 「把三处重复的同一句话合并成一处」是一类安全的瘦身，所以先量出来有没有这种句子；
 * 有就指名道姓列出来，没有就明说没有（结论也是结论）。
 */
function printDuplicateLines(rows: Row[]): void {
  console.log("\n重复句扫描（同一段指令里出现两遍以上的整行，≥10 字）");
  let duplicated = 0;
  for (const row of rows) {
    const counts = new Map<string, number>();
    for (const line of row.parts.full.total.split("\n")) {
      const trimmed = line.trim();
      if (codePoints(trimmed) >= 10) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    const repeats = [...counts].filter(([, count]) => count > 1);
    if (repeats.length > 0) {
      duplicated += repeats.length;
      for (const [line, count] of repeats) {
        console.log(`  [${row.id}] ×${count} ${truncate(line, 60)}`);
      }
    }
  }
  console.log(
    duplicated === 0
      ? `  没有：${rows.length} 张卡里没有一行是重复的（≥10 字）。所以没有「合并重复句」这类改动可做。`
      : `  命中 ${duplicated} 处。`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log("Cante 每张卡真正发出去的指令有多大（估算，不是计费口径）");
console.log(`测量路径：instructionFor(taskId, files, "${HER_SENTENCE}")`);
console.log(`固定文件：${SAMPLE_FILE}（1 个，占位路径，不是本机真实路径）`);
console.log(
  "估算方法：中日韩字符 × 1 + 其它非空白字符 ÷ 4；误差来源见本文件头部与 gui/README.md\n",
);

const rows = measure();
const totalNone = rows.reduce((sum, row) => sum + row.chars.none, 0);
console.log(
  `卡片数量：${rows.length} 张；总字符：无工具段 ${number(totalNone)}，` +
    `带工具段 ${number(rows.reduce((sum, row) => sum + row.chars.full, 0))}\n`,
);

printTable(rows);
printGroupTotals(rows, "none");
printGroupTotals(rows, "full");
printExtremes(rows);
printRoundsAccount(rows);
printFileSensitivity();
printDuplicateLines(rows);
printCrossSegmentOverlap(rows);
printToolRelevance();

const unknown = new Set(rows.flatMap((row) => row.parts.full.unknownHeaders));
console.log("\n块形状检查");
if (unknown.size === 0) {
  console.log("  所有块标题都在 SEGMENT_BY_HEADER 里登记过（没有漂移）。");
} else {
  console.log(`  警告：出现没登记过的块标题，它们的字被算进「其它」：${[...unknown].join(" ")}`);
}
console.log("\n诚实边界：token 数是启发式估算（中文 1 字≈1 token），不同服务方的分法不同，");
console.log("偏差可以有 ±20%；它能不能当计费口径用，见 gui/README.md 的「How big is the");
console.log("instruction we send」一节。");
