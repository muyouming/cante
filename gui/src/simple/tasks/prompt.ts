// Shared prompt envelope for every task.
//
// Kept in its own module so the WeChat tasks (which live in wechat.ts) can use
// the same envelope as the catalogue without importing the catalogue back —
// the safety rules must not depend on who wrote the task.

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
