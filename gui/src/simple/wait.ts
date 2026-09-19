// 「还要多久」的纯逻辑：从真机耗时样本里算出一个常见范围，并决定该说哪一句话。
//
// 为什么要有这个模块：慢的时候她不知道还要等多久。但产品**不许**承诺一个猜出来的
// 时间（Wharton 的实证：空口保证会掉信任）。所以这里的做法是——
//
//   1. 把过去几次真机跑下来的耗时当作**样本**（不是预算、不是承诺）；
//   2. 从样本里量出**中位数与九成位**（`summarize`），换算成一个常见范围（`bandFor`）；
//   3. 还在这个范围里：照实说「这类事一般要 … 到 …」，并点明这是看来的；
//      超过这个范围（也就是超过九成位）：改口说「这次比一般情况久」。
//
// 一条硬规矩贯穿全文：**观测到的** 与 **保证的** 必须分得开。范围只向下取整、
// 向上取整到人好读的刻度（`LADDER`），绝不把样本说得比它实际更漂亮。
//
// 样本来自：
//   * `SWEEP-0.2.1.md` / `SWEEP-0.2.1-full.md` —— 逐卡普查里记的每张卡耗时；
//   * `WINDOWS-ACCEPTANCE-*.md` —— 真机点卡片跑「从大表里挑出想要的行」时，
//     「干活（含审批/提问）」那一段的耗时。
// 有多少用多少，样本数写在 `WAIT_SAMPLES` 旁边、也写在测试里；不编。
//
// 纯逻辑：无 Solid、无计时器、无 I/O。文案在 `copy-wait.ts`。
import { WAIT } from "./copy-wait.ts";

/** 一张卡、一次运行的真实耗时（秒）与它的出处。 */
export interface WaitObservation {
  /** 产品分组（表格 / 文件 / 微信 / 文书 / 资料）。 */
  group: string;
  /** 卡 id，方便回报告里核对。 */
  card: string;
  seconds: number;
  /** 记这条耗时的文件，报告里要能指回去。 */
  source: string;
}

/**
 * 全部真机样本。**不要**在别处再抄一份：这是唯一的一份，改了就一起改。
 *
 * SWEEP-0.2.1.md 的「耗时」列是那一轮每张卡的实测；SWEEP-0.2.1-full.md 每张卡
 * 跑了两次，这里取报告表格里那条（第一次样本）。两份报告不重复计同一张卡。
 * Windows 那七条是 excel.filter 在真机上「干活」那一段的毫秒读数。
 */
export const WAIT_SAMPLES: readonly WaitObservation[] = [
  // —— SWEEP-0.2.1.md（20 张卡 / 26 次，逐卡耗时）
  { group: "表格", card: "excel.merge", seconds: 51, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.merge[列名一致]", seconds: 80, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.group", seconds: 83, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.tidy", seconds: 145, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.diff", seconds: 27, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.filter", seconds: 26, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.split", seconds: 28, source: "SWEEP-0.2.1.md" },
  { group: "表格", card: "excel.split[指定分隔符]", seconds: 74, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "files.rename", seconds: 22, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "files.archive", seconds: 23, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "files.dupes", seconds: 43, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "files.by-date", seconds: 43, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "pdf.merge", seconds: 21, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "pdf.split", seconds: 14, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "pdf.toword[扫描版]", seconds: 14, source: "SWEEP-0.2.1.md" },
  { group: "文件", card: "pdf.toword[文字版]", seconds: 36, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.notice[原话]", seconds: 38, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.notice[信息齐全]", seconds: 28, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.leave[原话]", seconds: 34, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.leave[信息齐全]", seconds: 24, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.report[原话]", seconds: 11, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.report[信息齐全]", seconds: 3, source: "SWEEP-0.2.1.md" },
  { group: "文书", card: "doc.summary", seconds: 33, source: "SWEEP-0.2.1.md" },
  { group: "微信", card: "wechat.table", seconds: 17, source: "SWEEP-0.2.1.md" },
  { group: "微信", card: "wechat.draft", seconds: 19, source: "SWEEP-0.2.1.md" },
  { group: "微信", card: "wechat.batch", seconds: 63, source: "SWEEP-0.2.1.md" },
  // —— SWEEP-0.2.1-full.md（32 张卡 / 38 条，每卡两次样本里的第一次）
  { group: "表格", card: "excel.merge", seconds: 72, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.merge[列名一致]", seconds: 61, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.group", seconds: 105, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.tidy", seconds: 105, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.diff", seconds: 34, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.filter", seconds: 21, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.split", seconds: 65, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "excel.split[指定分隔符]", seconds: 54, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "files.rename", seconds: 38, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "files.archive", seconds: 25, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "files.dupes", seconds: 41, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "pdf.merge", seconds: 16, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "pdf.split", seconds: 12, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "pdf.toword[扫描版]", seconds: 25, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "pdf.toword[文字版]", seconds: 44, source: "SWEEP-0.2.1-full.md" },
  { group: "文件", card: "files.by-date", seconds: 48, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.notice[原话]", seconds: 24, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.notice[信息齐全]", seconds: 37, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.leave[原话]", seconds: 38, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.leave[信息齐全]", seconds: 103, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.report[原话]", seconds: 17, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.report[信息齐全]", seconds: 27, source: "SWEEP-0.2.1-full.md" },
  { group: "文书", card: "doc.summary", seconds: 39, source: "SWEEP-0.2.1-full.md" },
  { group: "微信", card: "wechat.table", seconds: 18, source: "SWEEP-0.2.1-full.md" },
  { group: "微信", card: "wechat.draft", seconds: 17, source: "SWEEP-0.2.1-full.md" },
  { group: "微信", card: "wechat.batch", seconds: 17, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "check.totals", seconds: 42, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "check.reconcile", seconds: 13, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "invoice.ledger", seconds: 18, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "invoice.dupes", seconds: 31, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "invoice.crosscheck", seconds: 12, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "admin.byperson", seconds: 18, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "admin.changes", seconds: 11, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "admin.expiry", seconds: 77, source: "SWEEP-0.2.1-full.md" },
  { group: "表格", card: "vision.table", seconds: 24, source: "SWEEP-0.2.1-full.md" },
  { group: "资料", card: "research.brief", seconds: 341, source: "SWEEP-0.2.1-full.md" },
  { group: "微信", card: "wechat.rollcall[贴进来]", seconds: 35, source: "SWEEP-0.2.1-full.md" },
  { group: "微信", card: "wechat.missing", seconds: 17, source: "SWEEP-0.2.1-full.md" },
  // —— WINDOWS-ACCEPTANCE-*.md：真机点卡片跑 excel.filter 的「干活（含审批/提问）」phase
  { group: "表格", card: "excel.filter", seconds: 30, source: "WINDOWS-ACCEPTANCE-10.md" },
  { group: "表格", card: "excel.filter", seconds: 27, source: "WINDOWS-ACCEPTANCE-14.md" },
  { group: "表格", card: "excel.filter", seconds: 43, source: "WINDOWS-ACCEPTANCE-14.md" },
  { group: "表格", card: "excel.filter", seconds: 14, source: "WINDOWS-ACCEPTANCE-15.md" },
  { group: "表格", card: "excel.filter", seconds: 14, source: "WINDOWS-ACCEPTANCE-15.md" },
  { group: "表格", card: "excel.filter", seconds: 25, source: "WINDOWS-ACCEPTANCE-8.md" },
  { group: "表格", card: "excel.filter", seconds: 29, source: "WINDOWS-ACCEPTANCE-7.md" },
];

/**
 * 耗时分类：产品的两个大类。
 *
 * 「表格类」是打开、比对、写回表格的活；「文字类」是读写文件、文书、微信。
 * 两类耗时差得很明显（表格要开表、写表，比纯写字慢一倍上下），所以分开量。
 *
 * 资料类（research.brief，实测 341 秒，**只有 1 个样本**）并进文字类：1 条样本
 * 撑不起一个「一般要多久」的范围（那又会变成一句空口的话），所以让它走文字类，
 * 超过上界后界面照实改口说「比一般情况久」——那句对它是真的，也没有编新数字。
 */
export type WaitClass = "表格" | "文字";

export function waitClassOf(group: string | undefined): WaitClass {
  return group === "表格" ? "表格" : "文字";
}

/** 从样本里量出来的四个数，单位秒。 */
export interface WaitSummary {
  count: number;
  min: number;
  median: number;
  p90: number;
  max: number;
}

/** 最近邻取位：第 p 百分位（p 为 50 时即中位数）。样本为空时返回 NaN。 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)]!;
}

/** 把一组样本归纳成中位数 / 九成位 / 最慢，供界面和报告核对。 */
export function summarize(seconds: readonly number[]): WaitSummary {
  const sorted = [...seconds].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/**
 * 人好读的刻度。范围只往这个刻度上落，不出现「87 秒」这种像是量出来的精确数；
 * 这才是「常见范围」该有的粗粒度，也避免她把它读成倒计时。
 */
const LADDER: readonly number[] = [15, 20, 30, 45, 60, 90, 120, 180, 300, 600];

function snapDown(seconds: number): number {
  let out = LADDER[0]!;
  for (const step of LADDER) if (step <= seconds) out = step;
  return out;
}

function snapUp(seconds: number): number {
  for (const step of LADDER) if (step >= seconds) return step;
  return LADDER[LADDER.length - 1]!;
}

/** 一个常见范围（秒），边界都落在 `LADDER` 上。 */
export interface WaitBand {
  klass: WaitClass;
  loSeconds: number;
  hiSeconds: number;
  /** 量这个范围用的样本摘要，测试与报告拿它对账。 */
  summary: WaitSummary;
}

/**
 * 某一类的常见范围：下界取四分之一位向下、上界取九成位向上。
 *
 * 为什么下界用四分之一位而不是中位数：她看到「一般要四十多秒」却三十秒就好了，
 * 会觉得我们在拖；下界宁肯取小一点。为什么上界必须 ≥ 九成位：「比一般情况久」
 * 那句话只有在真的超过九成位之后才允许出现，否则就成了新的空口保证。
 */
export function bandFor(klass: WaitClass): WaitBand {
  const seconds = WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === klass).map(
    (item) => item.seconds,
  );
  const summary = summarize(seconds);
  const sorted = [...seconds].sort((a, b) => a - b);
  return {
    klass,
    loSeconds: snapDown(percentile(sorted, 25)),
    hiSeconds: snapUp(summary.p90),
    summary,
  };
}

/** 全部样本（两类合起来）的范围，用在拿不到分组时的兜底。 */
export function overallBand(): WaitBand {
  const summary = summarize(WAIT_SAMPLES.map((item) => item.seconds));
  const seconds = [...WAIT_SAMPLES.map((item) => item.seconds)].sort((a, b) => a - b);
  return {
    klass: "文字",
    loSeconds: snapDown(percentile(seconds, 25)),
    hiSeconds: snapUp(summary.p90),
    summary,
  };
}

/** 界面要说哪一句：还在常见范围里，还是已经比一般情况久。 */
export type WaitPhase = "usual" | "longer";

/**
 * 超过常见范围的上界（也就是超过九成位）才改口。
 *
 * 边界取「大于」而不是「大于等于」：正好等于上界仍在「常见」里，早一秒改口
 * 又会把一个常见的结果说成异常。
 */
export function waitPhase(elapsedMs: number, band: WaitBand): WaitPhase {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return elapsed > band.hiSeconds * 1000 ? "longer" : "usual";
}

/**
 * 说给她听的这一段。`line` 是主句，`caveat` 是出处那一句（只在「常见」时说，
 * 因为「比一般情况久」本来就在承认没有数字能保证）。
 */
export interface WaitView {
  phase: WaitPhase;
  band: WaitBand;
  line: string;
  caveat: string;
}

/** 秒数 -> 她读得懂的说法。只接受刻度上的整值（界面的范围都来自 `LADDER`）。 */
export function formatWaitSpan(seconds: number): string {
  switch (seconds) {
    case 15:
      return "十五秒";
    case 20:
      return "二十秒";
    case 30:
      return "半分钟";
    case 45:
      return "四十五秒";
    case 60:
      return "一分钟";
    case 90:
      return "一分半";
    case 120:
      return "两分钟";
    case 180:
      return "三分钟";
    case 300:
      return "五分钟";
    case 600:
      return "十分钟";
    default:
      return `${Math.round(seconds)} 秒`;
  }
}

/**
 * 组装界面上那一句。`group` 是产品分组；拿不到就按整体样本兜底。
 *
 * 注意这里**不**给「还剩多少」——只给「这类事常见多久」和「这次是否偏久」。
 * 倒计时会让落空更明显，产品律 3 要的是诚实的解释，不是好看的数字。
 */
export function waitView(group: string | undefined, elapsedMs: number): WaitView {
  const band = group === undefined ? overallBand() : bandFor(waitClassOf(group));
  const phase = waitPhase(elapsedMs, band);
  if (phase === "longer") return { phase, band, line: WAIT.longer, caveat: "" };
  return {
    phase,
    band,
    line: WAIT.usual(formatWaitSpan(band.loSeconds), formatWaitSpan(band.hiSeconds)),
    caveat: WAIT.observed,
  };
}
