// Is this finished turn waiting on the user, or did it hand over a result?
//
// The task prompts tell the assistant to stop and ask when it is unsure
// ("两张表列名不一致就先问我一句" — the #63 promise), which is the behaviour we
// want. The consequence is that a run can end *asking* rather than delivering:
// the assistant has a question and no file. Without a test like this the result
// card cannot tell those two endings apart, and the user is left staring at a
// question she has nowhere to answer.
//
// This module is the pure half, framework-free so `bun test` can pin the rule
// without a browser. When in doubt it errs toward showing the answer box: an
// unnecessary box costs a glance, an absent one leaves her stuck.

/**
 * Signs that the assistant is consulting the user rather than reporting a done
 * job. Kept deliberately broad — see the module note on erring toward `true`.
 */
const QUESTION_MARKERS: readonly string[] = [
  "？",
  "?",
  "需要你",
  "先问我",
  "核对",
  "确认一下",
  "要不要",
  "还是", // "A 还是 B" 里的选择，是最常见的征询
];

/**
 * Whether the turn ended in a question the user still has to answer.
 *
 * `producedFiles` is how many result files this turn actually produced:
 *
 *   * no new file at all → true. There is nothing for her to open, so the only
 *     thing left to do is reply — even when the assistant forgot to phrase a
 *     question mark.
 *   * a new file plus a question mark / consultation phrase → true.
 *   * empty text with a new file → false; the result speaks for itself.
 */
export function endedWithQuestion(lastText: string, producedFiles: number): boolean {
  if (producedFiles === 0) return true;
  const text = String(lastText ?? "").trim();
  if (!text) return false;
  return QUESTION_MARKERS.some((marker) => text.includes(marker));
}
