// 卡片上那几个「她可能不认识的词」——把「这是什么意思」摆到那个词旁边。
//
// 为什么要有这个文件（画像）：
//   可读性闸门（readability.test.ts）量的是**句子结构**：长短、断句、被动、名词堆。
//   可它管不了一个词她到底认不认识——「台账」「对账」「字段」写在再短的句子里，
//   不认识就是不认识。这一块补上那一格：在词后面放一个问号，点一下给她**一句话**。
//
// 三条设计决定，每一条都是为了「宁可少、不可滥」：
//
//   * 只收**她真可能不认识**的词，且这些词在产品**真的会做**的那件事里有确切的
//     意思（basis 写清是哪张卡、哪一步）。不解释我们其实不做的事；
//   * 解释**不是词典**——不解释词本身，只说「这在你这儿，就是……」。所以有一道
//     闸门：解释句里不许再出现那个词（用术语解释术语等于没说），见 checkExplanation；
//   * 不做整屏词典：词一旦离开它出现的地方（卡片标题、确认页的计划）就没有意义，
//     她也不会去查。所以答案位是**就地**的，见 HintText.tsx。
//
// 纯逻辑，无 Solid 依赖：哪些词、出现在哪、怎么切分，都在这里，有单测
// （hints.test.ts）。文案在 copy-hints.ts。
import { HINT_TEXTS } from "./copy-hints.ts";
import type { HintId } from "./copy-hints.ts";

export interface Hint {
  /** 稳定 id，文案按它取（copy-hints.ts 的 HINT_TEXTS）。 */
  id: HintId;
  /**
   * 她在界面上真会看到的写法。同一个意思的几种叫法都列上——
   * 「对账」和「对一遍」在她眼里是同一件事，指同一个答案。
   */
  terms: readonly string[];
  /**
   * 这个解释的依据：**产品真的会做**的那件事，写清出自哪张卡。
   * hints.test.ts 会拿 tasks/ 里她看得到的文字核对这个词确实在那里出现，
   * 免得我们为一句产品不做的事编解释。
   */
  basis: {
    /** 任务卡 id，例如 "invoice.ledger"。 */
    taskId: string;
    /** 这张卡在做什么，一句话。 */
    what: string;
  };
}

/**
 * 收录的词表。**只放我们最确定的几个**——不确定她认不认识的先不收（宁少勿滥）。
 *
 * 依据来自对 tasks/ 与 copy*.ts 里**面向她**的词的清点（title / example / plan /
 * risks / summaryHints），报告里有完整的次数表。
 */
export const HINTS: readonly Hint[] = [
  {
    id: "ledger",
    terms: ["台账"],
    basis: {
      taskId: "invoice.ledger",
      what: "把一堆发票 PDF 一笔一笔读成一张表，一张发票一行",
    },
  },
  {
    id: "reconcile",
    terms: ["对账", "对一遍"],
    basis: {
      taskId: "check.reconcile",
      what: "把两张表按一列配起来，对不上的分成三桶并带来源行号",
    },
  },
  {
    id: "group",
    terms: ["汇总", "分组"],
    basis: {
      taskId: "excel.group",
      what: "按她指定的类别做合计、计数和平均，一类一行",
    },
  },
  {
    id: "header",
    terms: ["表头"],
    basis: {
      taskId: "excel.tidy",
      what: "把最上面那一行理成一行列名，标题不并进列名里",
    },
  },
  {
    id: "field",
    terms: ["字段"],
    basis: {
      taskId: "invoice.ledger",
      what: "发票号码、开票日期、销方名称、价税合计这些一格一格地读，读不到就留空",
    },
  },
];

/** 文案：某个词的「这在你这儿，就是……」那一句。 */
export function explanationFor(hint: Hint): string {
  return HINT_TEXTS[hint.id];
}

export interface Hit {
  hint: Hint;
  /** 在原文里的起始下标。 */
  at: number;
  /** 命中的那个写法。 */
  term: string;
}

/** 一段不需要解释的文字。 */
export interface PlainSegment {
  kind: "plain";
  text: string;
}

/** 一个需要解释的词：渲染时可以紧跟一个问号入口。 */
export interface TermSegment {
  kind: "term";
  text: string;
  hint: Hint;
}

export type Segment = PlainSegment | TermSegment;

/**
 * 在文本里找出现的所有可解释的词。
 *
 * 同一个位置可能有多个写法命中（例如「对账」里也含「对账」自身）——按「长的优先」
 * 处理，并且不允许重叠，否则会切出半截词。
 */
export function hitsIn(text: string): Hit[] {
  const out: Hit[] = [];
  for (const hint of HINTS) {
    for (const term of hint.terms) {
      let index = text.indexOf(term);
      while (index >= 0) {
        out.push({ hint, at: index, term });
        index = text.indexOf(term, index + term.length);
      }
    }
  }
  out.sort((a, b) => a.at - b.at || b.term.length - a.term.length);
  const picked: Hit[] = [];
  let end = -1;
  for (const hit of out) {
    if (hit.at < end) continue;
    picked.push(hit);
    end = hit.at + hit.term.length;
  }
  return picked;
}

/**
 * 把一段文字切成「普通文字」与「要解释的词」两种片段，交给组件渲染。
 *
 * 关键性质（hints.test.ts 会断言）：把所有片段的 text 拼起来，与原文**一字不差**。
 * 解释是我加的一层，不能悄悄改掉她要读的那句话——不然我解释的是另一句话。
 */
export function segments(text: string): Segment[] {
  const hits = hitsIn(text);
  if (hits.length === 0) return [{ kind: "plain", text }];
  const out: Segment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.at > cursor) out.push({ kind: "plain", text: text.slice(cursor, hit.at) });
    out.push({ kind: "term", text: hit.term, hint: hit.hint });
    cursor = hit.at + hit.term.length;
  }
  if (cursor < text.length) out.push({ kind: "plain", text: text.slice(cursor) });
  return out;
}

/**
 * 解释句的闸门：这句话里**不许再出现那个词自己**。返回仍然出现的词（空数组即通过）。
 *
 * 单独抽成纯函数，是为了让「它真的能红」被直接断言：拿一句「台账就是台账」喂进来，
 * 必须报出「台账」。改废这条检查时，hints.test.ts 会先失败。
 */
export function checkExplanation(hint: Hint, explanation: string): string[] {
  return hint.terms.filter((term) => explanation.includes(term));
}

/** 某个词的一句话答案（组件用）。 */
export function answerFor(text: string): Hint | null {
  const [first] = hitsIn(text);
  return first ? first.hint : null;
}

/** 一段文字里出现过的词，每个答案只留一次；term 是**它在这段文字里**的写法。 */
export interface MatchedHint {
  hint: Hint;
  term: string;
}

export function hintsIn(text: string): MatchedHint[] {
  const seen = new Set<string>();
  const out: MatchedHint[] = [];
  for (const hit of hitsIn(text)) {
    if (seen.has(hit.hint.id)) continue;
    seen.add(hit.hint.id);
    out.push({ hint: hit.hint, term: hit.term });
  }
  return out;
}
