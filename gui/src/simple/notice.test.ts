// #140 — store 的 notice 终于有出口了，这个文件守住那条线。
//
// 背景：store.ts 的 notice 有四个活写方（撤销成功 / 撤销失败 / 出错 / 选文件窗口
// 打不开），但读方只剩两条测试断言。也就是说，这四条路径上我们承诺「会告诉她」，
// 话却从来没说出口。
//
// 这里做三件事：
//   1. 逐条断言四条路径各自说的是哪句中文（撤销成功和撤销失败必须是不同的话）；
//   2. 断言每一屏只说自己那一类（结果卡片不显示选文件的话，出错页不显示撤销的话）；
//   3. 读组件源码，断言 Notice 真的被画在结果卡片 / 选文件那一步 / 出错页上。
//
// 为什么第 3 条是读源码而不是渲染：`bun test` 里没有 DOM，整个仓库的界面红线
// （copy-guard / typography / wechat）也一直是读源码。真正的话和分类在第 1、2 条
// 里被逐字断言，第 3 条只钉「它确实接在了这个组件上」。
import { describe, expect, test } from "bun:test";

import { ERROR_KINDS, NOTICE, PICK_KINDS, UNDO_KINDS, noticeView, visibleNotice } from "./copy-notice.ts";

describe("noticeView：store 的四条活路径各自说什么", () => {
  test("撤销成功：照原话说放回去了几个", () => {
    const view = noticeView("已经放回去了：2 个文件恢复原样。");
    expect(view?.kind).toBe("undo-ok");
    // 界面上出现的就是这句：撤销成功时说「已经放回去了：2 个文件恢复原样。」
    expect(view?.what).toBe("已经放回去了：2 个文件恢复原样。");
    expect(view?.how).toBe(NOTICE.undoOkHow);
  });

  test("撤销失败说的是另一句：绝不谎称已经撤回", () => {
    const ok = noticeView("已经放回去了：2 个文件恢复原样。");
    const failed = noticeView("没能撤销。no such file or directory");
    expect(failed?.kind).toBe("undo-failed");
    // 界面上出现的就是这句：撤销失败时说「没能撤销。」
    expect(failed?.what).toBe("没能撤销。");
    expect(failed?.what).not.toBe(ok?.what);
    expect(failed?.how).not.toBe(ok?.how);
    expect(failed?.what).not.toContain("已经放回去");
    // 程序的英文原话不许进界面（它只属于出错页的「技术详情」）。
    expect(failed?.what).not.toContain("no such file");
    expect(failed?.how).not.toContain("no such file");
  });

  test("只放回去一部分：说清还有几个要她自己动手", () => {
    const view = noticeView("放回去了 1 个文件；还有 2 个没能自动还原，请按提示去文件夹里看看。");
    expect(view?.kind).toBe("undo-partial");
    expect(view?.what).toContain("还有 2 个");
    expect(view?.how.length).toBeGreaterThan(0);
  });

  test("选文件窗口打不开：说她要怎么选，而不是「发生错误」", () => {
    const files = noticeView("打不开选择文件的窗口。这个功能要在 Cante 桌面版里使用。");
    expect(files?.kind).toBe("pick-files");
    expect(files?.what).toBe("打不开选择文件的窗口。");
    expect(files?.how).toContain("再点一次");
    expect(files?.how).toContain("拖");
    expect(files?.what).not.toContain("错误");

    const folder = noticeView("打不开选择文件夹的窗口。");
    expect(folder?.kind).toBe("pick-folder");
    expect(folder?.how).toContain("再点一次");
    expect(folder?.how).toContain("拖");
  });

  test("出错：能认出来的原话翻成中文；认不出来的不硬编", () => {
    const busy = noticeView("EBUSY: resource busy or locked");
    expect(busy?.kind).toBe("error");
    expect(busy?.what).toContain("占用");
    expect(busy?.how.length).toBeGreaterThan(0);
    // 认不出来的（例如一句英文状态）返回 null：出错页自己会说「出了点问题」，
    // 不在这里重复，也不把原话端给她看。
    expect(noticeView("rate limited")).toBeNull();
    expect(noticeView(null)).toBeNull();
    expect(noticeView("")).toBeNull();
  });
});

describe("visibleNotice：每一屏只说自己那一类", () => {
  test("结果卡片只显示撤销那一类，不显示选文件的话", () => {
    expect(visibleNotice("已经放回去了：1 个文件恢复原样。", UNDO_KINDS)?.kind).toBe("undo-ok");
    expect(visibleNotice("打不开选择文件的窗口。", UNDO_KINDS)).toBeNull();
  });

  test("选文件那一步只显示选文件的话", () => {
    expect(visibleNotice("打不开选择文件夹的窗口。", PICK_KINDS)?.kind).toBe("pick-folder");
    expect(visibleNotice("已经放回去了：1 个文件恢复原样。", PICK_KINDS)).toBeNull();
  });

  test("屏幕上已经说过的那句不再重复", () => {
    const busy = noticeView("EBUSY: resource busy or locked");
    expect(busy).not.toBeNull();
    expect(visibleNotice("EBUSY: resource busy or locked", ERROR_KINDS, [busy!.what])).toBeNull();
    expect(visibleNotice("EBUSY: resource busy or locked", ERROR_KINDS, ["别的句子"])?.kind).toBe("error");
  });
});

describe("界面接线：这句话真的被画出来", () => {
  test("Notice.tsx 把 what 和 how 画进页面", async () => {
    const source = await Bun.file(`${import.meta.dir}/Notice.tsx`).text();
    expect(source).toContain("visibleNotice");
    expect(source).toContain("item().what");
    expect(source).toContain("item().how");
  });

  test("撤销那三句挂在结果卡片上，读的就是 store.notice()", async () => {
    const source = await Bun.file(`${import.meta.dir}/ResultCard.tsx`).text();
    expect(source).toContain("import Notice from \"./Notice.tsx\"");
    expect(source).toContain("props.store.notice()");
    expect(source).toContain("UNDO_KINDS");
  });

  test("选文件窗口打不开那句挂在选文件那一步", async () => {
    const source = await Bun.file(`${import.meta.dir}/TaskRunner.tsx`).text();
    expect(source).toContain("import Notice from \"./Notice.tsx\"");
    expect(source).toContain("PICK_KINDS");
    expect(source).toContain("store.notice()");
  });

  test("出错那条挂在出错页（ErrorView 收到 store 的 notice）", async () => {
    const source = await Bun.file(`${import.meta.dir}/ErrorView.tsx`).text();
    expect(source).toContain("import Notice from \"./Notice.tsx\"");
    expect(source).toContain("props.notice");
    expect(source).toContain("ERROR_KINDS");
  });

  test("TaskRunner 把 notice 交给 ErrorView，而不是自己再画一遍", async () => {
    const source = await Bun.file(`${import.meta.dir}/TaskRunner.tsx`).text();
    expect(source).toMatch(/<ErrorView[\s\S]{0,200}notice=\{store\.notice\(\)\}/);
  });
});
