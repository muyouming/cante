// 她点了「停下来」之后那三句的依据。
//
// 这里只做一件事：把**已有的事实**翻成三个数（这次新做出来几个文件、原来的文件动
// 了几个）。事实只有一个来源——`run.impact`，也就是运行前后对同一批文件夹各做一次
// 快照、再 diff 出来的结果（Rust 侧 `files.rs` 的 before/after 快照，纯逻辑在
// run.ts 的 diffSnapshots）。不新造状态，也不猜：拿不到就按「没有」说。
//
// 文件到底在不在，不在这里再问一次磁盘——结果卡片下面那一段（verify.ts）本来就会拿
// 这次产出的文件再问本机一次，两边说的是同一件事，不重复问。
import type { TaskRun } from "./run.ts";

export interface StoppedView {
  /** 这次真的新做出来的文件个数（快照里 created）。 */
  produced: number;
  /** 原来的文件被动过的个数（快照里 modified + deleted）。 */
  touched: number;
}

/** 从一轮已经停下的记录里，算出要对她说的那三句的依据。 */
export function stoppedView(run: Pick<TaskRun, "impact">): StoppedView {
  const impact = run.impact;
  return {
    produced: Math.max(0, impact?.created ?? 0),
    touched: Math.max(0, (impact?.modified ?? 0) + (impact?.deleted ?? 0)),
  };
}
