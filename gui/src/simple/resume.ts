// r5 — 重开应用时，主动提一句「上次有件事没做完」。
//
// 她要看到上次停在哪儿，现在**不用**自己去点「历史」：首页会先说一句。但这件事
// 有个更容易做错的地方——**不许有任何自动继续**。提示只负责把她带到那件记录前，
// 动手仍然要她点确认。
//
// 出现条件只用**已有的事实**：
//   * `runs()` 里最新的一轮（store 按时间倒序，`runs[0]`）停在「没做完」——
//     也就是 `failed`（copy-history 说「没做完」）或 `cancelled`（「已停止」）。
//     做完了、正在做、还没开始，都不算，一句都不出现。
//   * 这一轮的 id 不是她已经摆手放过的那一轮。她关掉/点开之后把**这一轮**的 id
//     记下来（`cante:resume:v1`），同一轮就不再提；换了一轮（有新的一件没做完）
//     才会再说。这是**一条事实**（哪一轮她已经处理过），不是一套提示状态机。
//
// r9 — 第三种情形：「半途停了」。她**正在做**的时候把应用关掉，守护进程的输入被
// 直接丢掉（`Drop for Daemon`），不会走 `finishRun`。现在开始做的那一刻就落一次盘
// （`store.ts` 的 `persistRunStart`，`state: "running"`），所以重开后磁盘上会留下
// 这样一条。判据是**两条已有的事实**，不是猜：
//   * 记录的状态是 `running`；
//   * 而这一轮的 id **不是**这次内存里真正在跑的那一轮（`liveRunId`）——刚重开时
//     内存里什么都没有，`liveRunId` 就是 null。
// 绝不写「时间差不超过 X 分钟」那种猜测：那是拿一个魔法数字冒充事实。
//
// 为什么不是「每次重开都提」：那样她会一直被同一句话烦，久了就学会无视它——
// 那是比不提醒更糟的结果。为什么不是「看过历史就永远不提」：那么下一件没做完的
// 事又会被埋起来。判据就落在「这一轮」上。
//
// 纯逻辑 + 一个可注入的存储，`bun test` 不用 DOM 就能钉住。

import type { TaskRun } from "./run.ts";

/** 「没做完」的两种结束状态，用她的话说（与 copy-history 的 STATE 同一套）。 */
export function isUnfinished(state: TaskRun["state"]): boolean {
  return state === "failed" || state === "cancelled";
}

/**
 * 「半途停了」：记录停在 `running`，但这次内存里没有那件活。
 *
 * 两条事实缺一不可：状态是 `running`，且这一轮的 id 不是 `liveRunId`（当前
 * `currentRun()` 的 id；刚重开时它是 null）。正在跑的那一轮 id 和 `liveRunId`
 * 相等，**不会**落进来——否则她正在做的这件事会一直被当成「半路停下」。
 */
export function isInterrupted(run: TaskRun, liveRunId: string | null): boolean {
  return run.state === "running" && run.id !== liveRunId;
}

/** 这一轮算不算「没做完」：结束状态（失败/她停的）**或**半途停了。 */
function notFinished(run: TaskRun, liveRunId: string | null): boolean {
  return isUnfinished(run.state) || isInterrupted(run, liveRunId);
}

/**
 * 记录里最新的一轮，如果它停在「没做完」就返回它，否则 null。
 *
 * `runs` 由 store 按时间倒序给出（`normalizeRuns`），所以 `runs[0]` 就是最近一轮。
 * 她这次重开之后还没做过任何事时，最新那轮是她上次留下的——正是要说给她的那件。
 *
 * `liveRunId` 是**这次**真正在跑的那一轮的 id（没有就传 null）。不传就等于「内存里
 * 一轮活都没有」，也就是刚重开时的样子。
 */
export function unfinishedRun(
  runs: readonly TaskRun[],
  liveRunId: string | null = null,
): TaskRun | null {
  const newest = runs[0];
  if (!newest) return null;
  return notFinished(newest, liveRunId) ? newest : null;
}

/**
 * 该不该说那句话、以及该说哪一种：最近一轮没做完，而且那一轮她还没放过。
 *
 * `dismissedRunId` 是她摆手放过的那一轮的 id（本地记下的一条事实），没有就是 null。
 * `liveRunId` 同 `unfinishedRun`：这次真正在跑的那一轮，用来把「正在做」和
 * 「半途停了」分开。`kind` 决定界面上用哪一句文案（`unfinished` 用原来的，
 * `interrupted` 用「半路停下了」那一句）。
 *
 * `shouldOfferResume` 与它同源（前者就是「后者不为 null」），所以判据只有这一份。
 */
export type ResumeKind = "interrupted" | "unfinished";

export function resumeOffer(
  runs: readonly TaskRun[],
  dismissedRunId: string | null,
  liveRunId: string | null = null,
): { run: TaskRun; kind: ResumeKind } | null {
  const run = unfinishedRun(runs, liveRunId);
  if (!run || run.id === dismissedRunId) return null;
  return { run, kind: isInterrupted(run, liveRunId) ? "interrupted" : "unfinished" };
}

/**
 * 该不该说那句话：同 `resumeOffer`，只要一个「说 / 不说」。
 *
 * `liveRunId` 同 `unfinishedRun`：这次真正在跑的那一轮，用来把「正在做」和
 * 「半途停了」分开。
 */
export function shouldOfferResume(
  runs: readonly TaskRun[],
  dismissedRunId: string | null,
  liveRunId: string | null = null,
): boolean {
  return resumeOffer(runs, dismissedRunId, liveRunId) !== null;
}

// ---------------------------------------------------------------------------
// 「这一轮她看过了」——只记一条事实
// ---------------------------------------------------------------------------

/** localStorage 的键名统一带前缀，方便以后迁移版本。 */
export const RESUME_DISMISSED_KEY = "cante:resume:v1";

/** 只用到这两件事，测试里可以塞一个假的进来。 */
export type ResumeStore = Pick<Storage, "getItem" | "setItem">;

function browserStore(): ResumeStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    /* 有些环境把存储关掉了；那就当没记过，重开时最多再提一次，不报错 */
    return null;
  }
}

/** 她已经放过的那一轮的 id；没记过（或读不出来）返回 null。 */
export function readDismissedRunId(target: ResumeStore | null = browserStore()): string | null {
  if (!target) return null;
  try {
    const raw = target.getItem(RESUME_DISMISSED_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** 记下「这一轮她看过了」。存不下就算了：不是出错，只是下次可能再提一次。 */
export function rememberDismissedRunId(
  runId: string,
  target: ResumeStore | null = browserStore(),
): void {
  if (!target || !runId) return;
  try {
    target.setItem(RESUME_DISMISSED_KEY, runId);
  } catch {
    /* 存储满了或被禁止写入：当作没记下 */
  }
}
