// 「例子点一下真的填进输入框」这半边。
//
// 这个仓库没有 jsdom（理由写在 typography.test.ts 的开头），所以这里扫源码。扫的是
// 接线，不是文案：例子必须渲染成按钮、点下去必须经过同一个把句子写进输入框的地方、
// 两个界面用的是同一批例子且没有各写一份。真的点一下会怎样，用无头浏览器核过（见
// 本轮报告）；这个文件负责让接线一断就红，而不是靠人记得。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

const HOME = read("Home.tsx");
const WIZARD = read("Wizard.tsx");

/** 组件里某个函数的函数体（到下一个顶格收尾的 `}` 为止），用来断言它做了什么。 */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  return source.slice(start, end > start ? end : source.length);
}

describe("首页：三句例子点一下就填进输入框", () => {
  test("例子渲染成按钮，点的还是它自己那一句（不是另写一份文案）", () => {
    expect(HOME).toContain("<For each={SAY_EXAMPLES}>");
    expect(HOME).toContain("onClick={() => pickExample(example.sentence)}");
  });

  test("输入框为空时点例子：真的把句子写进输入框的值，而且光标也进框", () => {
    const body = bodyOf(HOME, "pickExample");
    // 决定走纯函数（exampleClick 的单测钤的是具体内容），界面照它做
    expect(body).toContain("exampleClick(text(), sentence)");
    expect(body).toContain('action.kind === "confirm"');
    // 空框那一支：fill → setText(action.text)，框里显示的就是这个 text
    expect(body).toContain("setText(action.text)");
    expect(body).toContain("input?.focus()");
    // 框里显示的就是这个 text，所以 setText 之后她真的看得见
    expect(HOME).toContain("value={text()}");
    expect(HOME).toContain("ref={input}");
  });

  // F4（#139）— 她先打了半句再点例子：不能无条件拿例子盖掉她那半句（无撤销、无确认）。
  test("输入框非空时点例子：不静默清掉，先问一句（她那半句一个字不动）", () => {
    const body = bodyOf(HOME, "pickExample");
    // 非空那一支只把例子挂起来，等她点头
    expect(body).toContain("setPendingExample(action.text)");
    // 旧写法是 setText(sentence)：那会无条件盖掉她已经打的字
    expect(body).not.toContain("setText(sentence)");
    // 确认与拒绝两条路都在，而且只有她说「换」才动输入框
    expect(HOME).toContain("onClick={useExample}");
    expect(HOME).toContain("onClick={keepMyWords}");
    expect(bodyOf(HOME, "useExample")).toContain("setText(sentence)");
    expect(bodyOf(HOME, "keepMyWords")).not.toContain("setText");
    // 问的那一句与两个按钮都在同一个 form 里（就在她打字的地方边上）
    const formStart = HOME.indexOf("<form");
    const formEnd = HOME.indexOf("</form>", formStart);
    const ask = HOME.indexOf("{FIRST_RUN.exampleAsk}");
    expect(ask).toBeGreaterThan(formStart);
    expect(ask).toBeLessThan(formEnd);
  });

  test("例子和输入框在同一个框里（她开口的地方，不是要翻页去找的地方）", () => {
    const formStart = HOME.indexOf("<form");
    const formEnd = HOME.indexOf("</form>", formStart);
    const box = HOME.indexOf('id="cante-say"');
    const examples = HOME.indexOf("<For each={SAY_EXAMPLES}>");
    expect(formStart).toBeGreaterThan(-1);
    expect(formEnd).toBeGreaterThan(formStart);
    for (const place of [box, examples]) {
      expect(place).toBeGreaterThan(formStart);
      expect(place).toBeLessThan(formEnd);
    }
  });

  test("第一次做成之后那句变体也点得动（不另开一条路）", () => {
    expect(HOME).toContain("firstWinRun(props.store.runs())");
    expect(HOME).toContain("nextTimeSuggestion(run)");
    expect(HOME).toContain("onClick={() => pickExample(sentence())}");
  });

  test("向导里点的那一句会被带过来填好（取走即清，只填一次）", () => {
    expect(HOME).toContain("const seed = takeSentence();");
    expect(HOME).toContain("if (seed) setText(seed);");
  });

  // F2 — 她照着例子原样提交时，不能走自由说那条路：第三句例子（微信接龙）要的是
  // 贴进去的文字，而自由说拿到的是 freeTask（needs: "files"），会卡在「先选一个」。
  test("照着例子原样提交：先进那条卡片，改过字才按自由说走", () => {
    expect(HOME).toContain("exampleForSentence(value)");
    expect(HOME).toContain("props.onPickTask(task)");
    expect(HOME).toContain("props.onSubmitText(value)");
    expect(HOME.indexOf("props.onPickTask(task)")).toBeLessThan(
      HOME.indexOf("props.onSubmitText(value)"),
    );
  });

  // F3 — 点卡片做成的场景根本没有「刚才那句话」，不能套用自由说那一句。
  test("第一次做成之后的提示按哪条路说（卡片不搬「刚才那句话」）", () => {
    expect(HOME).toContain("firstWinHintFor(firstWin())");
    expect(HOME).not.toContain("FIRST_RUN.firstWinHint");
  });
});

describe("向导最后一步：三件事 + 三句能点的话", () => {
  test("三条承诺都渲染出来了", () => {
    expect(WIZARD).toContain("<For each={FIRST_RUN.promises}>");
  });

  test("三句例子在最后一步里，而且最后一步就是最后一步", () => {
    const done = WIZARD.indexOf('step() === "done"');
    const examples = WIZARD.indexOf("<For each={SAY_EXAMPLES}>");
    expect(done).toBeGreaterThan(-1);
    expect(examples).toBeGreaterThan(done);
    expect(WIZARD.indexOf('step() === "done"', done + 1)).toBe(-1);
  });

  test("点一句会记下来交给首页，而且她看得出自己点中了哪一句", () => {
    const body = bodyOf(WIZARD, "pickExample");
    expect(body).toContain("setPicked(example.sentence)");
    expect(body).toContain("rememberSentence(example.sentence)");
    expect(WIZARD).toContain("aria-pressed={picked() === example.sentence}");
  });

  // F5（#139）— 上一次打开时她在这点了例子却没点「开始使用」，那句话不能留到下一趟。
  test("向导一开始（mount）就把上一次留下的暂存清掉", () => {
    expect(WIZARD).toContain("beginFirstRun();");
    const mount = WIZARD.indexOf("onMount(() => {");
    const clear = WIZARD.indexOf("beginFirstRun();");
    const provision = WIZARD.indexOf("if (isProvisioned()) props.onDone();");
    expect(mount).toBeGreaterThan(-1);
    // 就在 mount 里、在其它分支前面：向导一露面就先清
    expect(clear).toBeGreaterThan(mount);
    expect(clear).toBeLessThan(provision);
  });

  test("这一步不替她结束向导：还是她点「开始使用」才进去", () => {
    expect(WIZARD).toContain("onClick={finish}");
    expect(WIZARD).toContain("{WIZARD.doneButton}");
    expect(bodyOf(WIZARD, "pickExample")).not.toContain("finish");
  });
});

describe("两处界面说的是同一批例子", () => {
  test("两边都从 copy-first-run.ts 取例子", () => {
    expect(HOME).toContain('from "./copy-first-run.ts"');
    expect(WIZARD).toContain('from "./copy-first-run.ts"');
  });

  test("例子的句子只在文案模块里写一次，组件里没有抄一份", () => {
    for (const source of [HOME, WIZARD]) {
      expect(source).not.toContain("把这个文件夹里的文件按月份分好");
      expect(source).not.toContain("帮我把微信里那些接龙整理成一张表");
    }
  });
});
