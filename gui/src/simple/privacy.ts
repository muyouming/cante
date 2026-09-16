// Where the data goes: the plain-language privacy model for simple mode.
//
// The whole point of this module is that the answer to "where did my file go?"
// is one sentence a 45-year-old office worker can read. Every string here is
// shown verbatim in the privacy panel or a result card, so it must stay free of
// jargon (no "model", "provider", "token", "prompt", "path"…). The logic is
// pure so `bun test` can pin the copy without a browser.
//
// Two consumers:
//   - PrivacyPanel.tsx renders `privacyAnswers()` from `store.privacy()`.
//   - r5-trust's ResultCard reads `runIsOnline()` / `onlineLabel()` when it
//     stamps a finished run — the store writes `run.online` from the same
//     `PrivacyState`, so the panel and the card can never disagree.
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
    ? "整理时用到了联网，你的内容发给了帮你整理的服务方。"
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
