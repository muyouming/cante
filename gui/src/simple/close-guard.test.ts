// 「她正在做的时候点右上角关掉」这一步的守卫。
//
// 判定全在 close-guard.ts 的纯函数里，所以这里直接跑它，不需要 DOM（这个仓库没有
// jsdom，理由写在 typography.test.ts 的开头）。要钉住的就是任务里那三条：
//
//   1. 手里有活（running / preview 等她点头）→ 要求确认；
//   2. 手里没活（done / failed / cancelled / 根本没有那一件）→ **不拦**；
//   3. 她选「关掉」→ 真的放行，**不是**再弹一次。
//
// 顺带钉住那句安全答案：请求关闭时只可能落到「问她」或「放行」，绝不会无声无息地
// 什么都不做（idle 只属于她点「继续做」那一下）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLOSE } from "./copy-close.ts";
import { closeOutcome, isWorking, needsCloseConfirm } from "./close-guard.ts";
import type { RunState, TaskRun } from "./run.ts";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

/** 只关心 state 的替身即可——判定逻辑除了 state 不看别的。 */
function run(state: RunState): TaskRun {
  return { state } as TaskRun;
}

describe("close-guard：手里有没有活", () => {
  test("正在做的两种状态算「有活」：真的在跑、或停在确认页等她点头", () => {
    expect(isWorking("running")).toBe(true);
    expect(isWorking("preview")).toBe(true);
  });

  test("其余状态都不算「有活」", () => {
    for (const state of ["draft", "done", "failed", "cancelled"] as const) {
      expect({ state, working: isWorking(state) }).toEqual({ state, working: false });
    }
    expect(isWorking(null)).toBe(false);
    expect(isWorking(undefined)).toBe(false);
  });
});

describe("close-guard：三条断言", () => {
  test("1. 手里有活 → 要求确认（running 与 preview 都要问）", () => {
    expect(needsCloseConfirm(run("running"))).toBe(true);
    expect(needsCloseConfirm(run("preview"))).toBe(true);
    expect(closeOutcome(run("running"), "request")).toBe("asking");
    expect(closeOutcome(run("preview"), "request")).toBe("asking");
  });

  test("2. 手里没活 → 不拦，直接放行（done / failed / cancelled / 没有那一件）", () => {
    for (const state of ["done", "failed", "cancelled", "draft"] as const) {
      expect({ state, confirm: needsCloseConfirm(run(state)) }).toEqual({ state, confirm: false });
      expect({ state, outcome: closeOutcome(run(state), "request") }).toEqual({
        state,
        outcome: "closing",
      });
    }
    expect(needsCloseConfirm(null)).toBe(false);
    expect(closeOutcome(null, "request")).toBe("closing");
    expect(closeOutcome(undefined, "request")).toBe("closing");
  });

  test("3. 她选「关掉」→ 真的放行，不再问第二遍", () => {
    // 就算手里还有活，她点了「关掉」也必须放行——不许再弹一次。
    expect(closeOutcome(run("running"), "leave")).toBe("closing");
    expect(closeOutcome(run("preview"), "leave")).toBe("closing");
    expect(closeOutcome(null, "leave")).toBe("closing");
  });

  test("安全答案：她点「继续做」只把浮层收掉，什么也不关", () => {
    expect(closeOutcome(run("running"), "keep")).toBe("idle");
    expect(closeOutcome(run("preview"), "keep")).toBe("idle");
    expect(closeOutcome(null, "keep")).toBe("idle");
  });

  test("请求关闭永远有结果：不是 asking 就是 closing，绝不会 idle（不会无声无息）", () => {
    for (const state of ["running", "preview", "done", "failed", "cancelled", "draft"] as const) {
      expect(["asking", "closing"]).toContain(closeOutcome(run(state), "request"));
    }
    expect(["asking", "closing"]).toContain(closeOutcome(null, "request"));
  });
});

describe("close-guard：浮层与键盘接线（源码扫描）", () => {
  test("浮层复用现有的 FocusLayer：接管 Tab", () => {
    expect(read("close-guard.ts")).toContain("useFocusLayer(");
  });

  test("Esc 与审批卡 / 确认页一致：故意不响应（MUST-ANSWER），并写明是故意的", () => {
    const source = read("close-guard.ts");
    // 代码里写明原因，别让后人以为是漏了。
    expect(source).toContain("MUST-ANSWER");
    // 没有把 Esc 接到任何处理上：既没有 Escape 键判断，也没给 onEscape。
    expect(/["'`]Escape["'`]/.test(source)).toBe(false);
    expect(/onEscape\s*:/.test(source)).toBe(false);
  });

  test("默认焦点在安全答案「继续做」上", () => {
    // initialFocus 指向「继续做」那颗按钮（keep）。
    expect(read("close-guard.ts")).toContain("initialFocus: () => keep");
  });

  test("真正关窗口由 Rust 执行：网页侧只让出/通知，不自己关", () => {
    const source = read("close-guard.ts");
    expect(source).toContain("CLOSE_CONFIRMED");
    // 网页侧的默认销毁路径必须被显式阻止（这个应用没有 allow-destroy）。
    expect(source).toContain("event.preventDefault()");
  });
});

describe("close-guard 的文案：全中文零术语，说清会停下来", () => {
  test("说清「没做完」与「关掉就停下来」，并给出两个选择", () => {
    expect(CLOSE.title).toContain("没做完");
    expect(CLOSE.body).toContain("停下来");
    expect(CLOSE.keep).toBe("继续做");
    expect(CLOSE.leave).toBe("关掉");
  });

  test("不出现路径 / 会话 / 进程这类词（copy-guard 也会在整体扫描里再挡一次）", () => {
    const all = `${CLOSE.title}${CLOSE.body}${CLOSE.keep}${CLOSE.leave}`;
    for (const word of ["路径", "会话", "进程", "模型", "终端", "缓存"]) {
      expect({ word, hit: all.includes(word) }).toEqual({ word, hit: false });
    }
  });
});
