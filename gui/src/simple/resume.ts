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
// 为什么不是「每次重开都提」：那样她会一直被同一句话烦，久了就学会无视它——
// 那是比不提醒更糟的结果。为什么不是「看过历史就永远不提」：那么下一件没做完的
// 事又会被埋起来。判据就落在「这一轮」上。
//
// 纯逻辑 + 一个可注入的存储，`bun test` 不用 DOM 就能钉住。

import type { TaskRun } from "./run.ts";

/** 「没做完」的两种状态，用她的话说（与 copy-history 的 STATE 同一套）。 */
export function isUnfinished(state: TaskRun["state"]): boolean {
  return state === "failed" || state === "cancelled";
}

/**
 * 记录里最新的一轮，如果它停在「没做完」就返回它，否则 null。
 *
 * `runs` 由 store 按时间倒序给出（`normalizeRuns`），所以 `runs[0]` 就是最近一轮。
 * 她这次重开之后还没做过任何事时，最新那轮是她上次留下的——正是要说给她的那件。
 */
export function unfinishedRun(runs: readonly TaskRun[]): TaskRun | null {
  const newest = runs[0];
  if (!newest) return null;
  return isUnfinished(newest.state) ? newest : null;
}

/**
 * 该不该说那句话：最近一轮没做完，而且那一轮她还没放过。
 *
 * `dismissedRunId` 是她摆手放过的那一轮的 id（本地记下的一条事实），没有就是 null。
 */
export function shouldOfferResume(
  runs: readonly TaskRun[],
  dismissedRunId: string | null,
): boolean {
  const run = unfinishedRun(runs);
  if (!run) return false;
  return run.id !== dismissedRunId;
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
