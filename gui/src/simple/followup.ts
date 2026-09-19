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
//
// Its second job is the "next step" nudge (r25): after a job finishes, offer the
// one thing she'd naturally do next. That half has a hard property — a
// suggestion is only shown when it is *genuinely doable by what we can already
// send*. So it does not trust its own wording: it runs the target card through
// `instructionFor` (the production composer `store.composedInstruction` uses)
// and drops anything that comes back empty. Sending a suggestion she cannot
// carry out would be worse than showing none (AGENTS §3.6).

import { NEXT_STEP } from "./copy-next.ts";
import { instructionFor } from "./tasks/index.ts";

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

// ---------------------------------------------------------------------------
// r25 — 做完之后的那一步
//
// 王姐只会复制粘贴和求和：她做成一件事之后，常常不知道还能做什么。把「这件事之后
// 顺手能做的那件事」摆到她面前，是产品最值钱的地方之一。
//
// 每条建议都指向目录里真有的另一张卡（不是再问它同一件事），而且只在她确实做成了
// 那件事、并且这次真的产出了文件时才出现——不然「拿刚做好的这份继续」无从谈起。
// ---------------------------------------------------------------------------

/** 一个「下一步」：点一下就走这条路。 */
export interface NextStep {
  /** 目录里那张卡的 id（真存在、生产路径真的能把卡片的规矩发出去）。 */
  taskId: string;
  /** 2–4 个字的按钮文字，一眼能看懂。 */
  label: string;
  /** 点下去实际交出去的那句话（走本机拼指令那条真路）。 */
  say: string;
  /** 起这一步要用的文件：刚做好的结果文件（这一步的前提就是「拿这份继续」）。 */
  files: string[];
}

/** 这一步要看的那次「做完了的活」。 */
export interface FinishedJob {
  /** 她刚做完哪张卡。 */
  taskId: string;
  /** 这次做出来的结果文件。 */
  resultFiles: readonly string[];
}

export interface NextRule {
  /** 她刚做完哪张卡。 */
  from: string;
  /** 下一步是哪张卡。 */
  to: string;
  /** copy-next.ts 里的那一句。 */
  step: keyof typeof NEXT_STEP.steps;
}

/**
 * 哪张卡做完之后，下一步最可能做什么。
 *
 * 只收「她十有八九会做、而且我们真能做」的那几条：合并完明细要一份能交上去的
 * 月报；照片抄成表之后格式最乱、要理一理；发票台账刚建好，先查重复；两张表对完
 * 账，把对不上的那几行单独存一份。不是功能清单，是四个最自然的下一步。
 *
 * 每一条都写成「哪张卡 → 目录里的哪张卡 → copy-next.ts 里的哪句」。加新的一步时，
 * 目标卡必须真的在目录里；测试会拿 `instructionFor` 拼出真正发出去的那段指令来核对。
 *
 * 导出它是给守卫测试用的：测试要能**逐条**核对（目标卡存在、生产路径拼得出指令），
 * 而不是只核对「能跑出结果的那几条」——后者对一条写坏了的规则是瞎的。
 */
export const NEXT_STEP_RULES: readonly NextRule[] = [
  { from: "excel.merge", to: "excel.group", step: "monthly" },
  { from: "vision.table", to: "excel.tidy", step: "tidy" },
  { from: "invoice.ledger", to: "invoice.dupes", step: "dupes" },
  { from: "check.reconcile", to: "excel.filter", step: "onlyDiff" },
];

/** 去空、去重，保持原来的先后。 */
function cleanFiles(input: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input ?? []) {
    const path = typeof raw === "string" ? raw.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * 这件事做完之后，摆在她面前的那一步（可能为空）。
 *
 * 「真能做」的判据不是我们的一句承诺，而是**生产路径真的拼得出这段指令**：目标卡
 * 不在目录里、或者 `instructionFor` 返回空，这条建议就不出现。这样加一步却忘了
 * 接线时，界面不会给她一个点下去没反应的按钮。
 *
 * 没有结果文件时返回空：这一步的前提是「拿刚做好的这份继续」，没有新东西就无从
 * 谈起（也不能退回她原来选的文件，那会拿原件重做一遍）。
 */
export function nextStepsFor(job: FinishedJob): NextStep[] {
  const files = cleanFiles(job.resultFiles);
  if (files.length === 0) return [];
  const out: NextStep[] = [];
  for (const rule of NEXT_STEP_RULES) {
    if (rule.from !== job.taskId) continue;
    const step = NEXT_STEP.steps[rule.step];
    // 走产品真实那条路：卡片的规矩必须能拼出来，拼不出来就不摆这个按钮。
    const composed = instructionFor(rule.to, files, step.say);
    if (!composed || composed.trim().length === 0) continue;
    out.push({ taskId: rule.to, label: step.label, say: step.say, files });
  }
  return out;
}
