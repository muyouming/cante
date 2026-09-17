// 键盘可达性的守卫（r20）。
//
// 为什么又是「扫源码 + 跑纯函数」，而不是渲染测试：这个仓库里没有 jsdom（理由写在
// typography.test.ts 的开头），而这套约束里能自动验的部分恰好都落在文本和纯函数上：
//
//   * 「Tab 走一步」是个纯函数（FocusLayer.stepIndex），直接跑；
//   * 「浮层有没有接管键盘」「必须回答的浮层有没有被 Esc 放走」「焦点环有没有被
//     outline-none 掐掉」都能从源码上判定，而且改坏它们的方式就是往源码里写一行。
//
// 真实的 Tab 顺序没法在这里验（渲染顺序、滚动、可见性都要真的浏览器）。那一段由
// gui/scripts/dom-smoke.sh 里的探针在无头 Chrome 里真的开一次浮层、真的按 Tab、
// 把结果写回 DOM 来核对。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stepIndex } from "./FocusLayer.tsx";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

/** 简单模式里的所有界面组件。 */
const components = (): string[] => readdirSync(HERE).filter((name) => name.endsWith(".tsx"));

/**
 * 现在开着键盘焦点层的浮层（每一层都会调 useFocusLayer，根元素挂 ref={layer}）。
 * 历史 / 隐私那两个整屏面板由 App.tsx 的外壳托管，不在这个名单里（见本轮报告）。
 */
const LAYERS = ["ConfirmSheet.tsx", "ApprovalSheet.tsx", "TaskLibrary.tsx", "ResultsPanel.tsx"];

/**
 * 必须回答、故意不让 Esc 关掉的两处。原因写在 FocusLayer.tsx 的文件头，源码里也
 * 各留了一句 MUST-ANSWER 的注释——后人不该把「Esc 没反应」当成漏掉的 bug 再"修"。
 */
const MUST_ANSWER = ["ConfirmSheet.tsx", "ApprovalSheet.tsx"];

describe("键盘焦点层：Tab 走一步的逻辑", () => {
  test("往前走，走到头绕回第一个", () => {
    expect(stepIndex(3, 0, false)).toBe(1);
    expect(stepIndex(3, 1, false)).toBe(2);
    expect(stepIndex(3, 2, false)).toBe(0);
  });

  test("往回走，走到头绕回最后一个", () => {
    expect(stepIndex(3, 0, true)).toBe(2);
    expect(stepIndex(3, 2, true)).toBe(1);
  });

  test("焦点不在层里（点到背板之后）：往前走进第一个，往回走进最后一个", () => {
    expect(stepIndex(3, -1, false)).toBe(0);
    expect(stepIndex(3, -1, true)).toBe(2);
  });

  test("一层里一个能按的都没有：不动", () => {
    expect(stepIndex(0, -1, false)).toBe(-1);
    expect(stepIndex(0, 0, true)).toBe(-1);
  });
});

describe("简单模式的浮层都得接管键盘", () => {
  test("每个浮层都走同一条路：useFocusLayer + 根元素 ref={layer}", () => {
    const missing = LAYERS.filter(
      (name) => !read(name).includes("useFocusLayer(") || !read(name).includes("ref={layer}"),
    );
    expect(missing).toEqual([]);
  });

  test("必须回答的两处：不响应 Esc，并且写明这是故意的", () => {
    for (const name of MUST_ANSWER) {
      const source = read(name);
      // (a) 代码里写明原因，别让后人以为是漏了。
      expect({ file: name, marked: source.includes("MUST-ANSWER") }).toEqual({
        file: name,
        marked: true,
      });
      // (b) 没有把 Esc 接到任何处理上：既没有 Escape 键判断，也没给 onEscape。
      expect({ file: name, escapeKey: /["'`]Escape["'`]/.test(source) }).toEqual({
        file: name,
        escapeKey: false,
      });
      expect({ file: name, onEscape: /onEscape\s*:/.test(source) }).toEqual({
        file: name,
        onEscape: false,
      });
    }
  });

  test("能关掉的浮层必须显式说明 Esc 干什么", () => {
    for (const name of ["TaskLibrary.tsx", "ResultsPanel.tsx"]) {
      expect({ file: name, onEscape: /onEscape\s*:/.test(read(name)) }).toEqual({
        file: name,
        onEscape: true,
      });
    }
  });

  test("和浮层同时开着的那一条（排好的活）也算一层，否则它的按钮按不到", () => {
    expect(read("TaskRunner.tsx")).toContain("markFocusLayer");
  });
});

describe("焦点必须看得见", () => {
  test("全局的焦点环还在（深色底上一圈亮蓝，键盘走到哪儿都看得见）", () => {
    const css = readFileSync(join(HERE, "..", "styles.css"), "utf8");
    expect(/:focus-visible\s*\{[^}]*outline:\s*2px\s+solid/.test(css)).toBe(true);
  });

  test("没有组件把它掐掉：界面组件里不许出现 outline-none / outline-hidden / outline-0", () => {
    const offenders = components().filter((name) =>
      /outline-none|outline-hidden|outline-0\b/.test(read(name)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("Tab 顺序按屏幕上看到的顺序，不许用正数 tabindex 硬掰", () => {
  test("没有正向 tabindex（tabindex=-1 只给程序移动焦点用，允许）", () => {
    const offenders = components().filter((name) =>
      /tabindex\s*=\s*\{?\s*["']?[1-9]/i.test(read(name)),
    );
    expect(offenders).toEqual([]);
  });
});
