// 卡片上那几个「她可能不认识的词」的一句话答案。
//
// 为什么单独一个模块：这些句子是**面向她**的文案，必须和别的 copy*.ts 一样被
// copy-guard（黑名单词）、tone（语气）、readability（句子结构）三道闸门扫到。
// 逻辑（哪些词、出现在哪、点一下开哪条）放在 hints.ts，这里只放字。
//
// 写作规矩（和产品律 3 对齐）：
//   * 每条只说「这在你这儿是做什么的」，不解释术语本身；
//   * **不许再用那个词解释它自己**（「台账就是台账」等于没说）——由 hints.test.ts
//     断言，改坏会红；
//   * 一律「这在你这儿，就是……」开头，先把她放进句子里，再讲这一步在干什么。

export const HINT_COPY = {
  /** 「？」按钮的名字，给屏幕阅读器念；点开时给它里面那一句。 */
  askLabel: (term: string): string => `「${term}」是什么意思`,
  /** 再点一下收起说明时，按钮的名字。 */
  hideLabel: (term: string): string => `收起「${term}」的说明`,
} as const;

/**
 * 每个词的一句话答案。键是 hints.ts 里的稳定 id。
 *
 * 依据不是「我觉得她不懂」，而是这张卡**真的会做什么**（见 hints.ts 的 basis，
 * hints.test.ts 会拿 tasks/ 里她看得到的文字核对这个词确实在那里）。
 */
export const HINT_TEXTS = {
  ledger: "这在你这儿，就是一张一笔一笔记清楚的表，比如把发票记进去。",
  reconcile: "这在你这儿，就是把两张表里同一笔单子找出来比一比。",
  group: "这在你这儿，就是把同一类的行并到一起，算出每类一共多少。",
  header: "这在你这儿，就是表最上面那一行，写着每一列是什么。",
  field: "这在你这儿，就是表里的一列，比如发票上的开票日期。",
} as const;

export type HintId = keyof typeof HINT_TEXTS;
