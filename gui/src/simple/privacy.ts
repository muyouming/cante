// Where the data goes: the plain-language privacy model for simple mode.
//
// The whole point of this module is that the answer to "where did my file go?"
// is one sentence a 45-year-old office worker can read. Every string here is
// shown verbatim in the privacy panel or a result card, so it must stay free of
// jargon (no "model", "provider", "token", "prompt", "path"…). The logic is
// pure so `bun test` can pin the copy without a browser.
//
// Consumers:
//   - PrivacyPanel.tsx renders `privacyAnswers()` from `store.privacy()`.
//   - r5-trust's ResultCard reads `runIsOnline()` / `onlineLabel()` when it
//     stamps a finished run — the store writes `run.online` from the same
//     `PrivacyState`, so the panel and the card can never disagree.
//   - r20's「这次发出去了什么」renders `sentContentView()` from `sentTextFor(run,
//     store.composedInstruction(run))` — the same text the store actually sends
//     (including the dry-run / overwrite suffix), so what she reads is exactly
//     what went out — never a second, drifting copy.
import { EGRESS, SENT } from "./copy-privacy-audit.ts";
// 只取两个后缀常量（覆盖同意 / 试跑）与那个 run 类型；run.ts 是叶子模块，没有反向依赖，
// 所以这一条不会成环（run.ts 里那条「保持独立于 privacy.ts」的注释仍然成立）。
import { OVERWRITE_CONSENT, dryRunInstruction } from "./run.ts";

export interface PrivacyState {
  /** The machine is allowed to reach the network for the next task. */
  online: boolean;
  /** The name of whoever receives content when online; `null` when nothing
   *  leaves the machine (or before the first task names a receiver). */
  provider: string | null;
  /** The user turned on "只在本机处理". */
  localOnly: boolean;
}

export const DEFAULT_PRIVACY: PrivacyState = { online: true, provider: null, localOnly: false };

/** Where the switch is remembered between launches. */
export const LOCAL_ONLY_KEY = "cante.localOnly";

export interface PrivacyAnswer {
  question: string;
  answer: string;
}

/** A run may only reach the network when the machine is online *and* the user
 *  has not asked for local-only. One definition, shared by the panel, the
 *  result card and the store's `privacy()` accessor. */
export function runIsOnline(state: Pick<PrivacyState, "online" | "localOnly">): boolean {
  return state.online && !state.localOnly;
}

/** The short stamp on a result card. */
export function onlineLabel(online: boolean): string {
  return online ? "本次联网" : "本次未联网";
}

/** The one-line explanation under the stamp. */
export function onlineHint(online: boolean): string {
  return online
    ? "整理时用到了联网，内容发给了帮你整理的服务方。"
    : "这次全部在你自己的电脑上完成，内容没有发出去。";
}

/** The three questions, answered for the current switch state. */
export function privacyAnswers(state: PrivacyState): PrivacyAnswer[] {
  const local = state.localOnly || !state.online;
  const who = local
    ? "什么都没发出去。你打开了「只在本机处理」。"
    : state.provider
      ? `发给你选用的联网服务方：${state.provider}。`
      : "发给帮你整理内容的联网服务方（还没开始任务，开始后这里会写出它的名字）。";
  return [
    {
      question: "哪些事在这台电脑上完成？",
      answer:
        "打开你的文件、看懂里面的内容、写出新文件、自动留一份备份、一键撤销——都在你这台电脑上完成。",
    },
    {
      question: "哪些事需要联网？",
      answer: local
        ? "不需要。联网搜索已经跟着「只在本机处理」一起关上了。"
        : "「看懂内容、想好怎么写」这一步需要联网。把下面的「联网搜索」关掉，就等于打开「只在本机处理」。",
    },
    { question: "联网时内容发给谁？", answer: who },
  ];
}

/** One-line state under the "只在本机处理" switch. */
export function localOnlyHint(localOnly: boolean): string {
  return localOnly
    ? "已打开：你的文件内容不会离开这台电脑。"
    : "已关闭：整理内容时会联网。";
}

/** One-line state under the "联网搜索" switch. */
export function webSearchHint(localOnly: boolean): string {
  return localOnly
    ? "已关闭（跟着「只在本机处理」一起关）"
    : "已开：需要时会联网，关掉它就等于只在本机处理";
}

/**
 * 确认页上「这次内容去哪了」那一句：面板那三句（文件不走 / 发出去的是这段文字 /
 * 它在这台电脑上拼出来）在动手前那一屏的缩略版。
 *
 * 为什么需要它：确认页原来说了要做什么、会动哪些文件，却对「内容去哪了」一个字没提，
 * 而产品律要求每个露出口都如实说明谁来处理。文案放 `copy-privacy-audit.ts` 的
 * `EGRESS`，与面板共用同一批事实（online / provider）。
 *
 * `online` 用这次运行自己的值（`run.online`，她按「开始」时真正会发生的那一个），
 * 不是面板那一刻的全局开关；provider 用面板报出的服务方名字。
 */
export function egressLine(state: { online: boolean; provider: string | null }): string {
  if (!state.online) return EGRESS.local + EGRESS.filesStay;
  const where = state.provider ? EGRESS.onlineNamed(state.provider) : EGRESS.online;
  return where + EGRESS.filesStay;
}

// ---------------------------------------------------------------------------
// r20 — 「这次发出去了什么」：把真正发出去的那段文字摊开给她看。
//
// 关键约束，改这一节前先读：
//   * 展示的文字**只能**来自 store.composedInstruction(run)（也就是
//     `instructionFor(taskId, files, instruction)` 的结果）。这里绝不重新拼
//     一份指令——两份一定会漂移，而她看到的就是她要信的。
//   * 这里也**绝不读取任何本地文件内容**：我们展示的是「发出去的那段文字」，
//     不是「文件里有什么」。文件留在本机，由任务自己在需要时处理，不归这一节管。
// ---------------------------------------------------------------------------

/** 最近一次任务，缩成这一节需要的最小信息。 */
export interface SentRunFacts {
  /** 那次真正发出去的文字，逐字来自 composedInstruction（必要时加上后缀）；没有任务时是 null。 */
  text: string | null;
  /** 那次允不允许联网（run.online）。 */
  online: boolean;
}

/**
 * 「这次真正发出去的那段文字」——面板要展示的就是它，一个字都不能少。
 *
 * 为什么不能直接用 `composedInstruction` 的结果：store 有两条路会在它后面**再接一段**
 * （见 `store.confirmRun` / `store.dryRun`）——
 *
 *   * 覆盖同意（#41）：`composed + OVERWRITE_CONSENT`
 *   * 试跑（#42）：`dryRunInstruction(composed)`
 *
 * 面板若只展示 `composedInstruction`，这两条路上就会**少报**真正发出去的字节 ——
 * 而这一节的全部意义就是「发出去的就是下面这段文字」。所以这里把 store 的规矩原样重述
 * 一遍（后缀字面量从 `run.ts` 取，不另写一份），做成纯函数。
 *
 * 它和 store 是**两份独立实现**，靠 `privacy-bytes.test.ts` 拿真 store 发出的字节钉住：
 * 两边谁改了规矩、忘了改另一处，那个文件立刻红。
 */
export function sentTextFor(
  run: { dryRun?: boolean; overwrite?: boolean },
  composed: string,
): string {
  // 试跑与覆盖同意互斥（确认页上是两个不同的按钮），不会叠加；真出现两者都有的旧记录，
  // 按试跑优先 —— 试跑那条路永远不会顺手覆盖文件。
  if (run.dryRun) return dryRunInstruction(composed);
  if (run.overwrite) return composed + OVERWRITE_CONSENT;
  return composed;
}

/** 折叠 / 展开要用的三态，以及每种状态该说的话。 */
export interface SentContentView {
  state: "none" | "offline" | "sent";
  /** 原文；只有 sent 时非空。 */
  text: string;
  /** 折叠时的一句摘要；只有 sent 时有内容。 */
  summary: string;
  /** 没有原文时的如实说明；none / offline 各一句。 */
  message: string;
}

/** 每段内容在信封里用的固定开头（见 tasks/prompt.ts 的 buildPrompt）。这里只用来
 *  **描述**「这段文字里有什么」，不参与拼装——拼装永远是 composedInstruction 的事。 */
const SENT_MARKERS: ReadonlyArray<{ label: string; markers: readonly string[] }> = [
  { label: SENT.partLabel.what, markers: ["【要做的事】"] },
  { label: SENT.partLabel.where, markers: ["【要处理的文件】", "【要整理的文件夹】"] },
  { label: SENT.partLabel.how, markers: ["【怎么做】"] },
  { label: SENT.partLabel.words, markers: ["【用户的原话】"] },
];

/** 这段文字里都有哪几类内容，按固定顺序。用来写摘要，不改变原文一个字。 */
export function sentTextParts(text: string): string[] {
  return SENT_MARKERS.filter((part) => part.markers.some((marker) => text.includes(marker))).map(
    (part) => part.label,
  );
}

/**
 * 把「有没有任务、联没联网」变成一个可以直接渲染的三态。三条路都要如实：
 *
 *   * 没有做过任务 -> none
 *   * 做过，但那次只在本地处理 -> offline（什么都没发出去）
 *   * 做过且联了网 -> sent（原文 + 摘要）
 */
export function sentContentView(facts: SentRunFacts | null): SentContentView {
  if (!facts || facts.text === null) {
    return { state: "none", text: "", summary: "", message: SENT.none };
  }
  if (!facts.online) {
    return { state: "offline", text: "", summary: "", message: SENT.offline };
  }
  const text = facts.text;
  return {
    state: "sent",
    text,
    summary: SENT.summary(text.length, sentTextParts(text)),
    message: "",
  };
}

/**
 * 最近一次真正交给助手的任务（还没开始的不算）。
 *
 * `preview` / `draft` 还停在确认页上，一个字都没发出去；把它们算进来会让这一节
 * 对着「将要发的」说「已经发的」，那就不是如实了。历史里的旧任务（卡片已经不在）
 * 同样照收——它的 instruction 本身就是当时发出去的那段文字。
 */
export function latestSentRun<T extends { state: string; createdAt: number }>(
  runs: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const run of runs) {
    if (run.state === "preview" || run.state === "draft") continue;
    if (!newest || run.createdAt > newest.createdAt) newest = run;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The two red lines, written once so the UI and the task prompts cannot drift.
// ---------------------------------------------------------------------------

/** #51: the notice that must sit in a prominent place on the WeChat screen. */
export const WECHAT_SAFETY_NOTICE = "本功能不会发送任何消息、不会登录你的微信。";

/** #52: the半自动 red line — the user sends, never the product. */
export const DRAFT_SEND_NOTICE = "发送动作始终由你完成。";

/** The reassuring second line of the WeChat flow. Careful: this copy must not
 *  claim the product can send, even to deny it — see the red-line test. */
export const WECHAT_READONLY_HINT =
  "它只读你导出的聊天记录，把内容整理成表格或草稿，不会碰你的微信账号。";

// ---------------------------------------------------------------------------
// Persistence — localStorage is absent in `bun test` and can throw in a locked
// webview, so both helpers take the storage they should use and never throw.
// ---------------------------------------------------------------------------

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readLocalOnly(storage: ReadableStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(LOCAL_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistLocalOnly(
  value: boolean,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_ONLY_KEY, value ? "1" : "0");
  } catch {
    // A locked-down webview cannot persist; the switch still works this run.
  }
}
