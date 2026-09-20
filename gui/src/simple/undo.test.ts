// 「这次撤销到底有没有东西可恢复」的判定（P0：报告成功、其实什么都没做）。
//
// 撤销要两份东西一起才成立：`file-safety/runs/<编号>/before/` 里的备份，和运行记
// 录里的 created/modified/deleted。运行记录不在时（例如 `save_run` 写盘失败后，
// 那次运行只在内存里），Rust 的 `undo_files` 无事可做，回 `{restored:[], failed:[]}`。
// 前端原来只按「没有失败」判成功，于是屏幕上说「已经放回去了：0 个文件恢复原样。」
// —— 一个文件都没动，却报告成功。对怕弄坏东西的她，这是最坏的一种失败（产品律 3）。
//
// 这里钉四件事：
//   1. 无记录 → 不许报成功，出那句新文案；
//   2. 有记录且全部恢复 → 仍报成功（回归：不许把正常的弄坏）；
//   3. 有记录但部分失败 → 仍报部分失败；
//   4. 边界：restored 与 failed 都空（三个列表全空）→ 也算「没有可恢复的记录」。
import { describe, expect, test } from "bun:test";

import { NOTICE, UNDO_KINDS, UNDO_NOTHING_WHAT, noticeView, visibleNotice } from "./copy-notice.ts";
import { undoOutcome } from "./undo.ts";

describe("undoOutcome：按桥回的两份清单判结局", () => {
  test("无记录（两份都空）→ nothing：这就是不许报成功的那一种", () => {
    expect(undoOutcome([], [])).toEqual({ kind: "nothing" });
  });

  test("边界：记录在、但三个列表全空，等价于没有可恢复的记录", () => {
    // Rust 对 created/modified/deleted 里每一项，不是进 restored 就是进 failed；
    // 所以「两份都空」⟺「三个列表全空」。这里用空清单表达那个边界。
    const outcome = undoOutcome([], []);
    expect(outcome.kind).toBe("nothing");
    expect(outcome).not.toEqual({ kind: "ok", restored: 0 });
  });

  test("有记录且全部恢复 → ok（回归：正常的成功不许被弄坏）", () => {
    expect(undoOutcome(["/work/a.xlsx", "/work/b.xlsx"], [])).toEqual({ kind: "ok", restored: 2 });
  });

  test("有记录但部分失败 → partial（回归：部分失败不许被当成成功）", () => {
    expect(undoOutcome(["/work/a.xlsx"], ["/work/b.xlsx", "/work/c.xlsx"])).toEqual({
      kind: "partial",
      restored: 1,
      failed: 2,
    });
  });

  test("一个都没恢复、但有失败 → 仍是 partial，不是 nothing", () => {
    // 失败清单非空说明「有记录、只是没做成」，这与「根本没有记录」是两回事：
    // 前者她还能再试，后者再点多少次都一样。判定必须分开。
    const outcome = undoOutcome([], ["/work/b.xlsx"]);
    expect(outcome.kind).toBe("partial");
    expect(outcome).not.toEqual({ kind: "nothing" });
  });
});

describe("界面话术：无记录说的是新那一句，不是「已经放回去了」", () => {
  test("无记录对应的 store 原话被认成 undo-nothing，且不在成功那一类里", () => {
    const view = noticeView(UNDO_NOTHING_WHAT);
    expect(view?.kind).toBe("undo-nothing");
    // 结果卡片会显示它（UNDO_KINDS 必须收进这一类，否则她什么都看不到）。
    expect(UNDO_KINDS).toContain("undo-nothing");
    expect(visibleNotice(UNDO_NOTHING_WHAT, UNDO_KINDS)?.kind).toBe("undo-nothing");
  });

  test("这一句既不说「已经放回去了」，也不让她「再点一次」", () => {
    const view = noticeView(UNDO_NOTHING_WHAT)!;
    // 发生了什么：
    expect(view.what).toBe("这次的文件我没有留下可以放回去的记录。");
    expect(view.what).not.toContain("已经放回去了");
    expect(view.what).not.toContain("恢复原样");
    // 她可以怎么做：给的是真有的两条出路（去看现在的文件 / 请懂电脑的同事用备份）。
    expect(view.how).toContain("我做的结果");
    expect(view.how).toContain("备份");
    expect(view.how).not.toContain("再点一次");
    expect(view.how).toBe(NOTICE.undoNothingHow);
  });

  test("正常成功与部分失败的话没有跟着变（回归）", () => {
    expect(noticeView("已经放回去了：2 个文件恢复原样。")?.kind).toBe("undo-ok");
    expect(noticeView("已经放回去了：2 个文件恢复原样。")?.how).toBe(NOTICE.undoOkHow);
    expect(
      noticeView("放回去了 1 个文件；还有 2 个没能自动还原，请按提示去文件夹里看看。")?.kind,
    ).toBe("undo-partial");
    expect(noticeView("没能撤销。boom")?.kind).toBe("undo-failed");
  });
});

describe("接线：store 真的按这个判定报告，而不是按「没有失败」", () => {
  test("store.undoRun 用 undoOutcome 分流，无记录时写新那句话", async () => {
    const source = await Bun.file(`${import.meta.dir}/../store.ts`).text();
    // 判定的纯函数来自这里；组件/状态层只渲染。
    expect(source).toContain('from "./simple/undo.ts"');
    expect(source).toContain("undoOutcome(restored, failed)");
    // 无记录那一支写的就是 copy-notice.ts 里那句话，不在 store 里再抄一遍。
    expect(source).toContain("UNDO_NOTHING_WHAT");
    // 旧的「没有失败就算成功」写法必须消失：它正是这个 P0 的源头。
    expect(source).not.toContain("if (failed.length === 0)");
  });
});
