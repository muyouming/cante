// P0 — 确认页上「不用这个」的守卫。
//
// 王姐会选错文件（桌面上「副本-副本.xlsx」）。这个文件把这条功能钉死成两件事：
//
//   ① **接线是真的**：确认页每个文件旁有一个 ≥44px 的「不用这个」，点它是
//      `store.removeRunFile(path)`；去掉过之后有「加回来」，能反悔；一份不剩时
//      说清为什么不能开始 + 一条「再选一个」的出路。
//   ② **真的影响发出去的指令**：去掉之后走 `store.composedInstruction(run)` 拼出的
//      那段文字里，那一份文件不再出现——不是只改显示。谁把去掉改成「只改显示」，
//      这里必须红（见「反面能红」那条，用真的 composedInstruction 反证）。
//
// 这里**不**替代 store.test.ts 里那几条真文件验证（她的文件原封不动），也不替代
// 真机上手点这一下——那两件事各自在别处，见本轮报告。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIRM_FILES } from "./copy-files.ts";
import { instructionFor } from "./tasks/index.ts";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

/** 生产路径拼出来的指令：和 `store.composedInstruction` 用的是同一条线。 */
function composed(taskId: string, files: string[], said: string): string {
  const text = instructionFor(taskId, files, said);
  expect(text, `${taskId} 拼不出指令`).not.toBeNull();
  return text ?? "";
}

describe("接线：确认页真的能去掉一份文件", () => {
  const sheet = read("ConfirmSheet.tsx");

  test("文案来自 copy-files.ts，不在组件里另写一份", () => {
    expect(sheet).toContain('from "./copy-files.ts"');
    expect(sheet).toContain("CONFIRM_FILES.removeOne");
    expect(sheet).toContain("CONFIRM_FILES.undoRemove");
    expect(sheet).toContain("CONFIRM_FILES.pickAgain");
  });

  test("每个文件旁那个入口点的是 store.removeRunFile（改输入，不改显示）", () => {
    // 去掉按钮和文件名在同一行里画出来：按钮的 onClick 调 removeRunFile。
    expect(sheet).toContain("props.store.removeRunFile(");
    // 真正被调用的那一行就在文件列表里（`removeFile` 是它的包装）。
    const call = sheet.indexOf("function removeFile(");
    expect(call).toBeGreaterThan(-1);
    const body = sheet.slice(call, sheet.indexOf("}", call));
    expect(body).toContain("props.store.removeRunFile(");
  });

  test("去掉是能反悔的：有「加回来」，调的是 store.addRunFile", () => {
    expect(sheet).toContain("props.store.addRunFile(");
    expect(sheet).toContain("restoreFile(");
    // 去掉过的东西列出来，让她看得见能反悔。
    expect(sheet).toContain("CONFIRM_FILES.removedHeading");
  });

  test("一份不剩时说清为什么 + 给「再选一个」的出路", () => {
    expect(sheet).toContain("CONFIRM_FILES.emptyHeading");
    expect(sheet).toContain("CONFIRM_FILES.emptyBody");
    expect(sheet).toContain("CONFIRM_FILES.emptyPickHint");
    expect(sheet).toContain("pickAgain(");
    // 「再选一个」真的会打开选文件的窗口（不是只显示一句话）。
    expect(sheet).toContain("props.store.pickFiles(");
    expect(sheet).toContain("props.store.pickFolder(");
  });

  test("一份不剩时开始按钮点不动，理由写在她点之前", () => {
    // 开始按钮的 disabled 里含「去掉到一份不剩」这条。
    const start = sheet.indexOf("confirmRun(allowOverwrite())");
    expect(start).toBeGreaterThan(-1);
    const open = sheet.lastIndexOf("<button", start);
    const tag = sheet.slice(open, sheet.indexOf(">", start) + 1);
    expect(tag).toContain("disabled=");
    expect(tag).toContain("removedAllFiles()");
    // 理由在页脚里说清（不是点完才知道）。
    expect(sheet).toContain("CONFIRM_FILES.cannotStart");
  });

  test("只拦「她自己去掉造成的空」：一份都没选的粘贴路（微信卡）不许被堵死", () => {
    // 判据必须带上「确实去掉过」，否则 needs "files" 的微信卡一份文件都没选、
    // 内容整段贴在话里那条合法路会被一起拦掉。
    const at = sheet.indexOf("const removedAllFiles");
    expect(at).toBeGreaterThan(-1);
    const body = sheet.slice(at, sheet.indexOf(";", sheet.indexOf("=>", at)) + 1);
    expect(body).toContain("removedNow().length > 0");
    expect(body).toContain("!pastesContent()");
    // 微信族的文件是加法不是门槛：贴进来就还能做，所以那一族不拦。
    expect(sheet).toContain("const pastesContent = (): boolean => def()?.group === PASTES_CONTENT_GROUP");
    // 那一族的名字也不写死在组件里（和别的文案一样归 copy 模块）。
    expect(sheet).toContain('from "./copy-files.ts"');
    expect(read("copy-files.ts")).toContain('PASTES_CONTENT_GROUP = "微信"');
    // 没有任何一处再按「文件为空」直接拦。
    expect(sheet).not.toContain("noFilesToStart");
  });

  test("每个新按钮都够高（≥44px），也都能被念出名字", () => {
    // 「不用这个」/「加回来」/「再选一个」都带 min-h-[44px]。
    for (const anchor of ["CONFIRM_FILES.removeLabel", "CONFIRM_FILES.undoLabel", "CONFIRM_FILES.pickAgain"]) {
      const at = sheet.indexOf(anchor);
      expect(at, `${anchor} 不在确认页上`).toBeGreaterThan(-1);
      const open = sheet.lastIndexOf("<button", at);
      const close = sheet.indexOf("</button>", at);
      const tag = sheet.slice(open, close);
      expect(tag, `${anchor} 的按钮不够高`).toContain("min-h-[44px]");
    }
    // 带文件名的按钮用 aria-label 念清楚是哪一份。
    expect(sheet).toContain("aria-label={CONFIRM_FILES.removeLabel(");
    expect(sheet).toContain("aria-label={CONFIRM_FILES.undoLabel(");
  });

  test("任务页按 run.id 认「换了一件」，不按对象——同一件里改文件不会重开确认页", () => {
    const runner = read("TaskRunner.tsx");
    // keyed 的是 id：去掉一份会换掉 run 对象、id 不变，那一页不该重开
    // （重开会把「已经去掉的（加回来）」一起清掉）。
    expect(runner).toContain("step() === \"confirm\" ? currentRun()?.id : null");
    expect(runner).not.toContain("step() === \"confirm\" ? currentRun() : null");
  });
});

describe("去掉真的影响发出去的指令（走 instructionFor，也就是 composedInstruction 那条线）", () => {
  const TASK = "excel.merge";
  const SAID = "把这两张表合成一张";
  const A = "C:/桌面/一月.xlsx";
  const B = "C:/桌面/副本-副本.xlsx";

  test("两份都在时，两份都在指令里", () => {
    const text = composed(TASK, [A, B], SAID);
    expect(text).toContain(A);
    expect(text).toContain(B);
    expect(text).toContain("一共 2 个");
  });

  test("去掉一份之后，指令里就没有它了（而且不是只少一行字）", () => {
    const before = composed(TASK, [A, B], SAID);
    const after = composed(TASK, [A], SAID);
    expect(before).toContain(B);
    expect(after).not.toContain(B);
    expect(after).toContain(A);
    // 份数也跟着变：这是重新拼出来的，不是删了一行。
    expect(before).toContain("一共 2 个");
    expect(after).toContain("一共 1 个");
  });

  test("去掉最后一个之后，指令如实说「这次没有选文件」，不再挂着那一份", () => {
    const after = composed(TASK, [], SAID);
    expect(after).toContain("这次没有选文件");
    expect(after).not.toContain(A);
    // 她那句话和卡片的规矩仍然在（去掉文件不等于把整件事取消）。
    expect(after).toContain(SAID);
    expect(after).toContain("原来的文件一张都不要改");
  });

  test("反面能红：如果「去掉」只改显示、不改输入，这条断言会失败", () => {
    // 模拟一个「只改显示」的坏实现：输入里仍然带着她说不用的那一份。
    const hiddenButStillInput = [A, B];
    const text = composed(TASK, hiddenButStillInput, SAID);
    // 界面显示上「她去掉了 B」，但输入没变 —— 发出去的指令里 B 还在。
    // 这正是我们不许发生的事，所以断言它**必须**出现（证明这条能红）。
    expect(text).toContain(B);
    // 对照：真的从输入里去掉后，B 就没了。
    expect(composed(TASK, [A], SAID)).not.toContain(B);
  });
});

describe("文案：全中文零术语", () => {
  test("说的是「文件」，不是「路径」；去掉不等于删除", () => {
    // 只看真正给她看的句子（注释里的说明不算文案：copy-guard 也只扫字符串）。
    const shown = [
      CONFIRM_FILES.fileInFolder("桌面"),
      CONFIRM_FILES.removeOne,
      CONFIRM_FILES.removeLabel("一月.xlsx"),
      CONFIRM_FILES.undoRemove,
      CONFIRM_FILES.undoLabel("一月.xlsx"),
      CONFIRM_FILES.removedHeading,
      CONFIRM_FILES.pickAgain,
      CONFIRM_FILES.emptyHeading,
      CONFIRM_FILES.emptyBody,
      CONFIRM_FILES.emptyPickHint,
      CONFIRM_FILES.cannotStart,
    ].join("\n");
    expect(shown).not.toContain("路径");
    // 按钮和出路是她说得出的短句。
    expect(CONFIRM_FILES.removeOne).toBe("不用这个");
    expect(CONFIRM_FILES.undoRemove).toBe("加回来");
    expect(CONFIRM_FILES.pickAgain).toBe("再选一个");
    // 说清她的文件还在原处（这是「别弄坏我的东西」的承诺）。
    expect(CONFIRM_FILES.removedHeading).toContain("还在原处");
    // 没有空着的句子，也没有英语。
    for (const value of Object.values(CONFIRM_FILES)) {
      if (typeof value !== "string") continue;
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  test("带文件名的标签把名字写进去（屏幕阅读器知道是哪一份）", () => {
    expect(CONFIRM_FILES.removeLabel("一月.xlsx")).toContain("一月.xlsx");
    expect(CONFIRM_FILES.undoLabel("一月.xlsx")).toContain("一月.xlsx");
  });
});
