// Shared prompt envelope for every task.
//
// Kept in its own module so the WeChat tasks (which live in wechat.ts) can use
// the same envelope as the catalogue without importing the catalogue back —
// the safety rules must not depend on who wrote the task.

import type { PreAnswerDecision } from "../copy-preanswer.ts";
import { PRE_ANSWER_DECISIONS } from "../copy-preanswer.ts";

// ---------------------------------------------------------------------------

/** The rules every job carries. Exported so the tests can pin the wording. */
export const SAFETY_RULES: readonly string[] = [
  "【说中文】给用户看的所有说明、总结和「需要你核对」都用中文写，不要用英文。",
  "【先说明再动手】先说明你打算怎么做，再动手。",
  "【不要动原文件】结果另存为新文件，不要改原文件。原来的文件只能读，不能改、不能删、不能覆盖。",
  "【只做这一件事】不要顺手做别的改动，也不要重命名原来的文件。",
  "【看不懂就先停】遇到打不开、对不上、拿不准的地方，先停下来把情况说清楚，不要自己猜着做。",
  "【缺工具先说】如果这台电脑缺少读或写这种文件的工具（比如打不开 .xlsx），先停下来告诉我，并给我两个选择：把文件另存成能读的格式，或者让我同意你装一个工具。不要硬做，也不要假装成功。",
  "【只用这台电脑真有的工具】只用在你这台电脑上确实装了、确实能用的工具和命令；不确定有没有，就别用，改用任何电脑都能做的通用办法——例如做不出 Word 文件时，就把文字直接写出来，并告诉我怎么粘贴到 Word。没有真的做出那个文件，就如实说没做出来，绝不要假装已经转好了。",
];

// ---------------------------------------------------------------------------
// 「她事先说过」（#把已知的追问挪到动手之前）
//
// 真机普查里，助手每 4 次运行就有 1 次停下来问用户，问的都是同一类判断：列名对不上
// 按哪张算、这一行算不算合计。这些判断她动手前就能答，所以确认页替她问了，答案必须
// **真的跟着指令发出去**——只显示在界面上、没进这一节，等于她又白等一次（和当年
// 「卡片提示词从未发出」是同一个坑，只是换了一层）。
//
// 状态放在模块里、由确认页写入，形状和 setSheetHelper / setVisionHelper 一致：
// 拼指令（`instructionFor` → `buildPrompt`）时不需要谁再传一遍她的选择。默认是空的，
// 也就是「全部用默认选项」——她一个字不改，发出去的也是默认那一句。
// ---------------------------------------------------------------------------

/** 指令信封里这一节的标题。测试盯着它，别改着玩。 */
export const PRE_ANSWER_HEADING = "【她事先说过】";

/**
 * 标题下面那句：说清这一节是**事先的回答**，不是新问题。
 *
 * 最后半句是故意留的：`【看不懂就先停】` 那条规矩没有被这一节取消，只是这几件事
 * 不用再回来问。
 */
export const PRE_ANSWER_LEAD =
  "下面这几件事她在动手前已经定好了：照她定的做，不要再为这几件事停下来问她；其它看不懂的地方仍然先停下来把情况说清楚。";

/**
 * 哪张卡有哪几道题。
 *
 * 键是卡片 id，用的是卡片自己报上来的那个（`buildPrompt` 的 `preAnswers`）；
 * 文案在 copy-preanswer.ts 里。id 与文案分开住的原因很实际：卡片 id 里带着英文缩写
 * （表格对比那张就叫 excel.diff），而 copy 模块里出现那种词会被文案守卫拦下来——
 * 那条守卫是对的（那是给助手和我们自己看的词，不该让王姐看到），所以映射放在这边。
 *
 * 这里没有条目的卡片：确认页不显示这一节，指令里也不会出现【她事先说过】。
 */
const PRE_ANSWERS: Readonly<Record<string, readonly PreAnswerDecision[]>> = {
  "excel.merge": [PRE_ANSWER_DECISIONS.mergeColumns, PRE_ANSWER_DECISIONS.mergeSpaces],
  "excel.diff": [PRE_ANSWER_DECISIONS.compareKey],
  "excel.tidy": [PRE_ANSWER_DECISIONS.tidyHeader],
  "excel.group": [PRE_ANSWER_DECISIONS.groupHiddenRows],
};

/** 这张卡登记的问题集；没登记就返回空数组（确认页据此决定显不显示这一节）。 */
export function preAnswerDecisions(taskId: string): readonly PreAnswerDecision[] {
  return PRE_ANSWERS[taskId] ?? [];
}

/** 登记过的卡片 id（界面、测试都用它，别另抄一份清单）。 */
export function preAnswerTaskIds(): string[] {
  return Object.keys(PRE_ANSWERS);
}

/** 这张卡要不要显示「动手前先定好这几件事」。 */
export function hasPreAnswers(taskId: string): boolean {
  return preAnswerDecisions(taskId).length > 0;
}

/** 默认选项的下标：数据里标着 isDefault 的那一条（没有标记就退回第一条）。 */
export function defaultPreAnswerIndex(decision: PreAnswerDecision): number {
  const index = decision.options.findIndex((option) => option.isDefault);
  return index >= 0 ? index : 0;
}

/** 她这一次选的：决定 id → 选项下标。空对象 = 全部用默认值。 */
let chosenAnswers: Record<string, number> = {};

/**
 * 记下她在这张卡上选了什么。只收这张卡登记过的决定，别的卡的选择进不来——
 * 万一界面上的状态和正在拼的指令不是同一件事，也不会把别卡的问题塞进指令。
 */
export function setPreAnswers(taskId: string, answers: Record<string, number>): void {
  const allowed = new Set(preAnswerDecisions(taskId).map((decision) => decision.id));
  const next: Record<string, number> = {};
  for (const [id, index] of Object.entries(answers)) {
    if (allowed.has(id) && Number.isInteger(index) && index >= 0) next[id] = index;
  }
  chosenAnswers = next;
}

/** 清空选择（回到全部默认）。测试用，也留给「换一件来做」时收尾。 */
export function clearPreAnswers(): void {
  chosenAnswers = {};
}

/** 某一道题她最后选的是哪一项：选过就用她选的，没选过/越界就用默认。 */
export function chosenPreAnswerIndex(decision: PreAnswerDecision): number {
  const picked = chosenAnswers[decision.id];
  if (typeof picked === "number" && picked < decision.options.length) return picked;
  return defaultPreAnswerIndex(decision);
}

/**
 * 【她事先说过】这一节；这张卡没有登记问题时返回 null（信封形状一字不变）。
 *
 * 每一行都是选项里写好的 envelope，不在这里现编句子：选项的说明和真正发出去的话
 * 是同一份数据，界面上写了什么，助手就收到什么。
 */
export function preAnswerBlock(taskId: string): string | null {
  const decisions = preAnswerDecisions(taskId);
  if (decisions.length === 0) return null;
  const lines = decisions.map((decision) => {
    const option = decision.options[chosenPreAnswerIndex(decision)] ?? decision.options[0];
    return `- ${option?.envelope ?? ""}`;
  });
  return [PRE_ANSWER_HEADING, PRE_ANSWER_LEAD, ...lines].join("\n");
}

/** "【要处理的文件】（只读）" plus a numbered list. */
export function filesBlock(files: string[]): string {
  if (files.length === 0) {
    return "【要处理的文件】\n这次没有选文件，内容全部来自用户的原话。\n";
  }
  const lines = [`【要处理的文件】（只读，一共 ${files.length} 个，按这个顺序）`];
  files.forEach((path, index) => lines.push(`${index + 1}. ${path}`));
  return `${lines.join("\n")}\n`;
}

/** The folder variant, used by the tidy-up jobs. */
export function folderBlock(folder: string): string {
  return [
    "【要整理的文件夹】（只读）",
    folder,
    "这个文件夹里的东西不是都要动：按下面的做法只处理说到的那些，其它的原样留着。",
    "",
  ].join("\n");
}

/** The user's own words, which always outrank our wording. */
export function userWordsBlock(instruction: string): string {
  const said = instruction.trim() || "（用户没有补充，按上面的做法做）";
  return [
    "【用户的原话】",
    said,
    "",
    "如果用户的原话和上面的做法有冲突，以用户的原话为准；拿不准就先问一句。",
    "",
  ].join("\n");
}

/**
 * The shared rule list, optionally with one task-specific exception. The
 * exception never removes a rule — it only adds one.
 */
export function safetyBlock(extra?: string): string {
  const rules = extra ? [...SAFETY_RULES, `【这个任务的补充】${extra}`] : [...SAFETY_RULES];
  return `${rules.map((rule) => `- ${rule}`).join("\n")}\n`;
}

/** Assemble one prompt from its parts, in a fixed order. */
export function buildPrompt(parts: {
  what: string;
  files?: string[];
  folder?: string;
  /**
   * 这张卡在 copy-preanswer.ts 里登记的「她事先说过」问题集（键就是卡片 id）。
   * 不填就不出这一节：没有对应判断的卡片不该凭空多出几个问题。
   */
  preAnswers?: string;
  how: string[];
  extraRule?: string;
  instruction: string;
  done: string;
}): string {
  const blocks: string[] = [`【要做的事】${parts.what}`, ""];
  if (parts.folder) blocks.push(folderBlock(parts.folder));
  else blocks.push(filesBlock(parts.files ?? []));
  blocks.push(
    "【怎么做】",
    ...parts.how.map((step, index) => `${index + 1}. ${step}`),
    "",
    "【必须守住的规矩】",
    safetyBlock(parts.extraRule).trimEnd(),
    "",
    userWordsBlock(parts.instruction).trimEnd(),
    "",
  );
  // 她在确认页上定好的那几件事。放在她自己那句话的紧后面：那一段的结尾写着
  // 「拿不准就先问一句」，而这一节正是对其中几个问题的事先回答，两段要挨着读。
  const preAnswered = preAnswerBlock(parts.preAnswers ?? "");
  if (preAnswered) blocks.push(preAnswered, "");
  // #75 — 这台电脑有没有表格读写工具。默认没有这一节，提示词形状保持不变。
  if (sheetHelper) {
    blocks.push("【这台电脑怎么读写表格】", sheetHelper, "");
  }
  // #50 — 同上，这台电脑能不能处理 PDF。默认也是 null。
  if (pdfHelper) {
    blocks.push("【这台电脑怎么处理 PDF】", pdfHelper, "");
  }
  // #48 — 这个会话背后的助手能不能看图。和上面两条不同：可用、不可用都要写。
  if (visionHelper) {
    blocks.push("【这台电脑能不能看图】", visionHelper, "");
  }
  blocks.push(`【做完告诉我】${parts.done}`, "", CHECK_NOTE_BLOCK);
  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// 表格读写能力（#75）
// ---------------------------------------------------------------------------

/**
 * 能力探测只做一次，结果写到这里；默认是 null，所以现有的提示词一字不变。
 * 由 `simple/capabilities.ts` 在启动时设置。
 */
let sheetHelper: string | null = null;

/** 设置（或清空）这台电脑读写表格的说明。 */
export function setSheetHelper(line: string | null): void {
  sheetHelper = line;
}

// ---------------------------------------------------------------------------
// PDF 处理能力（#50）
// ---------------------------------------------------------------------------

/**
 * PDF 能力探测只做一次，结果写到这里；默认是 null，所以现有的提示词一字不变。
 * 由 `simple/capabilities.ts` 在启动时设置。
 */
let pdfHelper: string | null = null;

/** 设置（或清空）这台电脑处理 PDF 的说明。 */
export function setPdfHelper(line: string | null): void {
  pdfHelper = line;
}

// ---------------------------------------------------------------------------
// 看图能力（#48）
// ---------------------------------------------------------------------------

/**
 * 这个会话能不能看图。默认是 null，所以没探测过时提示词的形状保持不变。
 * 由 `simple/capabilities.ts` 在拿到会话信息时设置。
 *
 * 和表格/PDF 不同：看不了图时也要把这件事写进信封，助手才知道用户塞来照片时该
 * 先停下车说明，而不是凭空编一张表。
 */
let visionHelper: string | null = null;

/** 设置（或清空）这个会话能不能看图的说明。 */
export function setVisionHelper(line: string | null): void {
  visionHelper = line;
}

/**
 * #63 — the last block of every instruction. The result card reads back the
 * `【需要你核对】` paragraph and shows it verbatim, so this is the one place the
 * assistant is allowed to admit that something in *this* run is uncertain.
 *
 * It is deliberately strict: only what actually happened this time, no generic
 * hedging, and "nothing to check" is a perfectly good answer. A fabricated
 * warning shown next to a real result would be worse than none.
 */
export const CHECK_NOTE_BLOCK = [
  "【最后再加一段】做完以后，在回复的最后单独用一段「【需要你核对】」开头，只写这一次真实发生、我也需要核对的情况，例如：哪一行拿不准、哪个文件没处理、哪个数字可能不对、哪一步跳过了。",
  "这一次确实没有，就写「没有发现需要核对的地方」。",
  "不要写「仅供参考」「可能有误差」这类没有信息量的话，也不要为了凑字数编一条出来。",
].join("\n");
