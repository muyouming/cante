// Shared prompt envelope for every task.
//
// Kept in its own module so the WeChat tasks (which live in wechat.ts) can use
// the same envelope as the catalogue without importing the catalogue back —
// the safety rules must not depend on who wrote the task.

// ---------------------------------------------------------------------------

/** The rules every job carries. Exported so the tests can pin the wording. */
export const SAFETY_RULES: readonly string[] = [
  "【先说明再动手】先说明你打算怎么做，再动手。",
  "【不要动原文件】结果另存为新文件，不要改原文件。原来的文件只能读，不能改、不能删、不能覆盖。",
  "【只做这一件事】不要顺手做别的改动，也不要重命名原来的文件。",
  "【看不懂就先停】遇到打不开、对不上、拿不准的地方，先停下来把情况说清楚，不要自己猜着做。",
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
    `【做完告诉我】${parts.done}`,
    "",
    CHECK_NOTE_BLOCK,
  );
  return blocks.join("\n");
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
