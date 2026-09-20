// 她点「打开文件 / 打开所在文件夹」打不开时，屏幕说的是不是**那一种**打不开。
//
// 为什么值得单独钉：这两个按钮的失败有好几种（这台电脑没有能打开它的程序、文件被别的
// 程序开着、不让打开、文件已经不在了……），每一种她该做的下一步都不同。把失败一股脑
// 说成「找不到了」或「格式不对」，她就会去重选一份本来好好的文件，或者干脆不知道怎么办。
//
// 事实（哪种失败返回哪串字）来自 gui/docs/OPEN-FILE-FAILURES.md，那里逐条记了
// `files.rs` / `copy.ts` / `tauri-plugin-opener` 的依据。这里只钉判定本身，不假装
// 能证明「她看懂了」——那句只有真人测试能给答案。

import { describe, expect, test } from "bun:test";

import { OPEN_FAILED, openFailureView } from "./copy-results.ts";
import { explainError } from "./copy.ts";

/** store.ts 里「打开文件」失败时逐字写的前缀（对齐 store 的 setNotice）。 */
const OPEN = "打不开这个文件。你可以自己找到它再双击打开。";
/** store.ts 里「打开所在文件夹」失败时逐字写的前缀。 */
const REVEAL = "打不开它所在的文件夹。";

const fileMissing = `${OPEN}这个文件找不到了：C:\\Users\\王\\Desktop\\结果.xlsx`;
const noProgram = `${OPEN}打不开 C:\\Users\\王\\Desktop\\结果.xlsx：No application is associated with the specified file for this operation. (os error 1155)`;
const busy = `${OPEN}打不开 C:\\Users\\王\\Desktop\\结果.xlsx：The process cannot access the file because it is being used by another process. (os error 32)`;
const denied = `${OPEN}打不开 C:\\Users\\王\\Desktop\\结果.xlsx：Access is denied. (os error 5)`;
const folderMissing = `${REVEAL}打不开文件夹：path doesn't exist`;
const bridge = `${OPEN}这个功能要在 Cante 桌面版里使用。`;
const unknown = `${OPEN}打不开 C:\\Users\\王\\Desktop\\结果.xlsx：Launcher "/usr/bin/open -- …" failed with ExitStatus(unix_wait_status(256))`;

describe("打不开的判定：四种失败各是各的说法", () => {
  test("文件不在了 → 说「找不到」，给「打开所在文件夹」这条出路", () => {
    expect(openFailureView(fileMissing)).toEqual(OPEN_FAILED.missing);
  });

  test("这台电脑没有能打开它的程序 → 说「没装程序」，出路是装一个（不是重选文件）", () => {
    expect(openFailureView(noProgram)).toEqual(OPEN_FAILED.noProgram);
  });

  test("文件正被别的程序开着 → 说「被占着」，出路是关掉那个窗口", () => {
    expect(openFailureView(busy)).toEqual(OPEN_FAILED.busy);
  });

  test("系统不让打开 → 说「不让你打开」，出路是换个位置/找同事", () => {
    expect(openFailureView(denied)).toEqual(OPEN_FAILED.denied);
  });

  test("文件夹不在了（打开所在文件夹那条）→ 说文件夹找不到", () => {
    expect(openFailureView(folderMissing)).toEqual(OPEN_FAILED.folderMissing);
  });

  test("打开文件夹那条失败，也不拿文件的说法套上去", () => {
    // 同一个「不让开」的错误码，落在「打开文件」和「打开所在文件夹」上说的不是一件事。
    expect(openFailureView(`${REVEAL}打不开文件夹：Access is denied. (os error 5)`)).toEqual(
      OPEN_FAILED.folderDenied,
    );
    expect(openFailureView(`${REVEAL}打不开文件夹：something odd happened`)).toEqual(
      OPEN_FAILED.folderUnknown,
    );
  });

  test("四种失败落到四个不同的说法，不是同一句万能话", () => {
    const views = [fileMissing, noProgram, busy, denied].map((text) =>
      JSON.stringify(openFailureView(text)),
    );
    expect(new Set(views).size).toBe(4);
  });

  test("每一种都给了具体的下一步（不是只说「出了点问题」）", () => {
    for (const text of [fileMissing, noProgram, busy, denied, folderMissing]) {
      const view = openFailureView(text)!;
      expect(view.what.length).toBeGreaterThan(4);
      expect(view.how.length).toBeGreaterThan(10);
      expect(view.how).not.toBe(OPEN_FAILED.unknown.how);
    }
  });
});

describe("认不出来的失败：退回通用出口，不假装知道", () => {
  test("系统原话认不出来时，给通用那一句（不是编一个原因）", () => {
    expect(openFailureView(unknown)).toEqual(OPEN_FAILED.unknown);
  });

  test("通用出口也给一条出路：自己打开所在文件夹再双击", () => {
    expect(OPEN_FAILED.unknown.how).toContain("打开所在文件夹");
  });

  test("别的提示不抢过来：撤销成功、出错那些原话原样返回 null", () => {
    expect(openFailureView("已经放回去了：2 个文件恢复原样。")).toBeNull();
    expect(openFailureView("这瓶水没开。")).toBeNull();
    expect(openFailureView("打不开选择文件的窗口。")).toBeNull();
    expect(openFailureView(null)).toBeNull();
    expect(openFailureView("")).toBeNull();
  });
});

describe("回归：既有的「找不到」那条行为不变", () => {
  test("结果文件找不到的四种说法一个都没动", async () => {
    const { RESULTS } = await import("./copy-results.ts");
    expect(RESULTS.presence.present).toBe("现在还在，能打开。");
    expect(RESULTS.presence.missing).toContain("找不到了");
    expect(RESULTS.presence.missing).toContain("打开所在文件夹");
    expect(RESULTS.presence.unreadable).toContain("占着");
    expect(RESULTS.presence.unknown).toContain("没能核对");
  });

  test("explainError 里「找不到文件」那条规则没被动过", () => {
    const found = explainError("ENOENT: no such file or directory");
    expect(found.what).toBe("电脑上找不到这个文件，它可能被移走、改名或者删掉了。");
  });
});

describe("界面接线：这句话真的被画出来", () => {
  test("结果卡片上读 store.notice()，用 openFailureView 认这两个动作的失败", async () => {
    const source = await Bun.file(`${import.meta.dir}/ResultCard.tsx`).text();
    expect(source).toContain("openFailureView(props.store.notice())");
    expect(source).toContain("view().what");
    expect(source).toContain("view().how");
  });
});
