// #192 A — 「先给我看一眼再交上去」要在界面上**第一眼就看得见**，而不是藏在页脚
// 第三个按钮里。
//
// 为什么是源码扫描而不是渲染测试：这个仓库没有 jsdom（理由写在 typography.test.ts
// 开头），而"这条路可见吗"这个问题在这里恰好能落到两个文本事实上：
//
//   1. 确认页是「不滚动的头 + 可滚动的正文 + 不滚动的页脚」的 flex 竖排；把
//      「先看一眼」这一块放进页脚，它就**不需要先滚到底**才出现。
//   2. 它和「开始」在视觉上不撞：一个是描边按钮、一个是填色按钮；危险动作的默认
//      焦点仍然落在「取消」上（产品律要的默认答案是安全的那一个）。
//
// 这两条都是"改坏就等于往源码里写一行"的事，文本扫描能挡住。真正在窗口里点一下
// 是不是也这样，源码扫描看不见，见本轮报告「没能验证什么」——本机没有 Windows
// 交互桌面，浏览器预览又到不了确认页（没有桌面桥时 App 直接进错误页）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

/** 文件里出现的第一处下标；找不到返回 -1。 */
function indexOf(source: string, needle: string): number {
  return source.indexOf(needle);
}

describe("#192 A：先看一眼这条路，第一眼就看得见", () => {
  const source = read("ConfirmSheet.tsx");

  test("确认页是可滚动的头 + 不滚动的页脚：正文滚，按钮排不滚", () => {
    // 页脚（装按钮的那一条）必须在滚动区之后、且不带头。
    expect(source).toContain("flex max-h-full");
    const scroll = indexOf(source, "flex-1 overflow-y-auto");
    const footer = indexOf(source, "<footer");
    expect(scroll).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(scroll);
    // 页脚不能自己也带 overflow-y-auto，否则"不用滚"就不成立了。
    const footerTag = source.slice(footer, source.indexOf(">", footer) + 1);
    expect(footerTag).not.toContain("overflow-y-auto");
  });

  test("「先看一眼」这一块在页脚里 —— 不是滚动区里、也不是折叠后才出现", () => {
    const scroll = indexOf(source, "flex-1 overflow-y-auto");
    const footer = indexOf(source, "<footer");
    const heading = indexOf(source, "TRY_FIRST.heading");
    const action = indexOf(source, "TRY_FIRST.action");
    // 标题和按钮都排在 <footer> 之后：随按钮排一起，永远在视野里。
    expect(heading).toBeGreaterThan(footer);
    expect(action).toBeGreaterThan(footer);
    // 也不能落在滚动区里（在 <footer> 之前就是落在可滚动的正文里）。
    expect(heading).toBeGreaterThan(scroll);
  });

  test("按钮点的是 dryRun，不是 confirmRun：这条路不会真正动手", () => {
    // 拿「先看一眼」那个按钮的开标签来核对，别把「开始」的 onClick 算进来。
    const action = indexOf(source, "TRY_FIRST.action");
    const open = source.lastIndexOf("<button", action);
    const tag = source.slice(open, source.indexOf(">", action) + 1);
    expect(tag).toContain("props.store.dryRun()");
    expect(tag).not.toContain("confirmRun");
  });

  test("和「开始」不会混：先看一眼是描边按钮，开始是填色按钮，默认焦点仍在取消", () => {
    // 「开始」按钮：填色 + 加粗，仍然是页脚里那个主按钮。
    const start = indexOf(source, "confirmRun(allowOverwrite())");
    expect(start).toBeGreaterThan(-1);
    const startOpen = source.lastIndexOf("<button", start);
    const startTag = source.slice(startOpen, source.indexOf(">", start) + 1);
    expect(startTag).toContain("bg-sky-500");
    // 危险动作的默认焦点不许破：打开时仍然落在「取消」上。
    expect(source).toContain("initialFocus: () => cancelButton");
    // 先看一眼是描边按钮（有 border），不是第二个填色的主按钮，降低误点。
    const action = indexOf(source, "TRY_FIRST.action");
    const actionOpen = source.lastIndexOf("<button", action);
    const actionTag = source.slice(actionOpen, source.indexOf(">", action) + 1);
    expect(actionTag).toContain("border");
    expect(actionTag).not.toContain("bg-sky-500");
  });

  test("说的是她的话：标题是「先给我看一眼」，并且说清「只看不动」", () => {
    const copy = read("copy.ts");
    // 她的原话直接当标题（不是「试跑」这类她不会说的词）。
    expect(copy).toMatch(/heading:\s*"[^"]*先给我看一眼/);
    // 一句平实中文说清什么不会发生：原文件不被改、也不多出文件。
    expect(copy).toMatch(/hint:\s*"[^"]*一个字都不会改/);
    expect(copy).toMatch(/hint:\s*"[^"]*也不会多出文件/);
    // 旧的「先试跑给我看」不该再留在确认页上（换成了她的话）。
    expect(source).not.toContain("先试跑给我看");
  });
});
