// 「这次撤销到底有没有东西可恢复」的判断（P0：报告成功、其实什么都没做）。
//
// 撤销要两份东西一起才成立：`file-safety/runs/<编号>/before/` 里的备份，和**运行记
// 录里的** created/modified/deleted。运行记录不在时（例如写盘失败后再点撤销），Rust
// 侧这三份列表全是空的，`undo_files` 无事可做，回一个 `{restored: [], failed: []}`。
// 前端原来只按「没有失败」判成功，于是屏幕上说「已经放回去了：0 个文件恢复原样。」
// —— 一个文件都没动，却报告成功。对怕弄坏东西的她，这是最坏的一种失败（产品律 3）。
//
// 关键不变量：Rust 的 `undo_files` 对 created/modified/deleted 里**每一项**，不是进
// restored 就是进 failed（files.rs）。所以「restored 和 failed 都空」⟺「三个列表都空」
// ⟺ 没有任何可恢复的记录。这个判断只依赖桥回的两个列表，是纯函数，可以单测。
//
// 判断放在这里，组件只渲染 —— 不许把判断塞进 JSX。

/** 一次撤销的三种结局：全放回去了 / 只放回去一部分 / 根本没有可恢复的记录。 */
export type UndoOutcome =
  | { kind: "ok"; restored: number }
  | { kind: "partial"; restored: number; failed: number }
  | { kind: "nothing" };

/**
 * 按桥回的 restored / failed 两份清单判断结局。
 *
 * `nothing` 是**不许报成功**的那一种：它代表这次没有任何可恢复的记录，撤销什么也
 * 没做（不是「撤回了 0 个文件」）。
 */
export function undoOutcome(
  restored: readonly string[],
  failed: readonly string[],
): UndoOutcome {
  if (failed.length > 0) {
    return { kind: "partial", restored: restored.length, failed: failed.length };
  }
  if (restored.length === 0) {
    return { kind: "nothing" };
  }
  return { kind: "ok", restored: restored.length };
}
