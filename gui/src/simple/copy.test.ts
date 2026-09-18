// The error dictionary is the contract behind 大白话错误 (#44): any English a
// lower layer throws must come out as 发生了什么 + 你可以怎么做, with the raw
// text kept for 复制详情. These tests pin both the mapping and the pass-through.
import { describe, expect, test } from "bun:test";

import { ERRORS, STALL, WIZARD_HEALTH, explainError, isRetryable, stallFacts } from "./copy.ts";

describe("explainError", () => {
  test("a missing file becomes an actionable Chinese pair", () => {
    const human = explainError("Error: ENOENT: no such file or directory, open 'C:\\报表.xlsx'");
    expect(human.what).toBe(ERRORS.notFoundWhat);
    expect(human.how).toBe(ERRORS.notFoundHow);
    expect(human.detail).toContain("ENOENT");
  });

  test("permission and busy failures are distinguished", () => {
    expect(explainError("os error 13: Permission denied").what).toBe(ERRORS.permissionWhat);
    expect(explainError("EBUSY: resource busy or locked").what).toBe(ERRORS.busyWhat);
  });

  test("network and account failures", () => {
    expect(explainError("fetch failed: ECONNREFUSED").what).toBe(ERRORS.networkWhat);
    expect(explainError("401 Unauthorized: invalid api key").what).toBe(ERRORS.authWhat);
  });

  test("动手的组件真正报的那句 Connection error. 也归到「连不上网」", () => {
    // 真机验过：断网时 cante-bridge 的 headline 就是 Connection error.（没有
    // details）。字典只认 ECONNREFUSED / connection refused 时，出错页的提示框
    // 不会亮，她也就看不到「可能是网络断了」这句话。
    const human = explainError("Connection error.");
    expect(human.what).toBe(ERRORS.networkWhat);
    expect(human.how).toBe(ERRORS.networkHow);
    expect(human.detail).toBe("Connection error.");
  });

  test("那张提示框里的话不点名一个屏幕上没有的按钮", () => {
    // 出错页上那个按钮叫「再试一次」；写死「重试」她按图索骥也找不到。
    expect(ERRORS.networkHow).not.toContain("「重试」");
  });

  test("跑到一半没消息了：换成停滞专用的两句，并带上做到第几步、做完几个操作", () => {
    // #173 —— bridge.rs 在服务方长时间没消息时自己报这一句。跑失败的
    // TaskRun.error 自带 what＝兜底那句「这件事没有做完。」，所以停滞必须在那
    // 之前认出来；否则她看到的仍是一句什么都没说的通用话。
    const raw =
      "连不上帮你处理的服务方，可能网络断了。已经做到第 3 步，做完了 2 个操作，原来的文件都还在。网络好了，点「再试一次」，会把刚才那件事重做一遍。";
    const human = explainError(raw);
    expect(human.what).toBe(ERRORS.stallWhat);
    // how 只说发生什么 + 她真能做的那一步；「做到哪儿了」在单独一块里说。
    expect(human.how).toBe(ERRORS.stallHow);
    expect(human.how).toContain("重做一遍");
    expect(human.how).not.toContain("接着");
    expect(human.detail).toBe(raw);

    // 从 store 给的真实形状来也一样：what/how 是兜底两句，锚点在 detail 里。
    const fromRun = explainError({
      what: "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: raw,
    });
    expect(fromRun.what).toBe(ERRORS.stallWhat);
    expect(fromRun.how).toBe(ERRORS.stallHow);

    // 「已经做到这里」那块：两个数字都得在，而且都来自桥报过的原文。
    const facts = stallFacts(raw);
    expect(facts?.progress).toEqual([STALL.stepsLine(3), STALL.opsLine(2)]);
    // 文件那句是**规矩**（只读、另存新文件），不是一句「已核对过」的测量。
    expect(facts?.files).toContain("只读");
    expect(facts?.files).toContain("另存");
    expect(facts?.files).not.toContain("核对");

    // 从 store 的 `{detail}` 形状也能拿到同一份事实（出错页真正吃的那份）。
    expect(stallFacts(fromRun)?.progress).toEqual([STALL.stepsLine(3), STALL.opsLine(2)]);

    // 只有回话、还没跑工具时，只说步数，不编一个「0 个操作」。
    const stepsOnly = stallFacts(
      "连不上帮你处理的服务方，可能网络断了。已经做到第 3 步，原来的文件都还在。网络好了，点「再试一次」，会把刚才那件事重做一遍。",
    );
    expect(stepsOnly?.progress).toEqual([STALL.stepsLine(3)]);

    // 一个数字都没有也照样能给她「做到这里」那块（至少文件那句在）——不编数字。
    const noCount = stallFacts("连不上帮你处理的服务方，可能网络断了。");
    expect(noCount?.progress).toEqual([]);
    expect(noCount?.files).toContain("原来的文件");

    // 不是停滞时，那一块就不出现。
    expect(stallFacts("something very strange happened")).toBeNull();
    expect(explainError("something very strange happened").what).toBe(ERRORS.genericWhat);
  });

  test("the desktop-bridge message is explained for a browser preview", () => {
    expect(explainError("desktop bridge unavailable").what).toBe(ERRORS.bridgeWhat);
  });

  test("table and pdf files get their own wording", () => {
    expect(explainError("openpyxl cannot read 报表.xlsx").what).toBe(ERRORS.tableWhat);
    expect(explainError("broken pdf: EOF").what).toBe(ERRORS.pdfWhat);
  });

  test("an already-explained TaskRun.error is passed through", () => {
    const human = explainError({ what: "原来的文件不见了", how: "重新选一次", detail: "ENOENT" });
    expect(human).toEqual({ what: "原来的文件不见了", how: "重新选一次", detail: "ENOENT" });
  });

  test("unknown text falls back to the generic Chinese pair", () => {
    const human = explainError("something very strange happened");
    expect(human.what).toBe(ERRORS.genericWhat);
    expect(human.how).toBe(ERRORS.genericHow);
    expect(human.detail).toBe("something very strange happened");
  });

  test("an empty failure still has a usable message and detail", () => {
    const human = explainError(undefined);
    expect(human.what).toBe(ERRORS.genericWhat);
    expect(human.detail).toBe("");
  });

  test("known classes are marked retryable; account problems are not", () => {
    expect(isRetryable("ENOENT: no such file or directory")).toBe(true);
    expect(isRetryable("401 unauthorized")).toBe(false);
  });
});

// 出错的出路必须是**她能做的一步** ✓。
//
// 背景：这两条原来写的是「请找配置这台电脑的同事或管理员…」✗ / 「请找管理员确认这台电脑的
// 配置」✗ —— 对一个 45 岁、做行政/财务、公司里未必有"管理员"可找的人来说，这等于**没有出路** ✗。
// 现在两条都指向我们已经有的出口「复制详情」（`genericHow` 用的就是它 ✓），并说清发给谁。
describe("出错的出路对她可执行", () => {
  const cases: [string, string][] = [
    ["缺程序", WIZARD_HEALTH.engine],
    ["能力没准备好", ERRORS.modelHow],
  ];

  test("两条路都指向「复制详情」，并说清发给谁", () => {
    for (const [, text] of cases) {
      expect(text).toContain("复制详情");
    }
    expect(ERRORS.modelHow).toContain("帮你装这个软件的人");
  });

  test("不假设她有管理员，也不说含糊的「配置」", () => {
    for (const [name, text] of cases) {
      expect(text, `${name} 里又在叫人去找管理员：那对她可能不存在`).not.toContain("管理员");
      expect(text, `${name} 里用了含糊的"配置"：她不知道该做什么`).not.toContain("配置这台电脑");
    }
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

describe("#175 复制详情要够技术同事用", () => {
  test("复制出去的那段带上程序名、任务名与时间，而不只是程序原文", () => {
    const src = read("ErrorView.tsx");
    const copy = read("copy.ts");
    // 那三句是面向她的字 ✓，按仓库的规矩住在 copy 模块里（内联中文只许减少 ✓），
    // 组件只引用常量 —— 这条断言盯的是"引用关系还在、任务名还传得下来"。
    expect(copy).toContain("detailHeader");
    expect(copy).toContain("detailTask");
    expect(copy).toContain("detailWhen");
    expect(src).toContain("ERROR_VIEW.detailHeader");
    expect(src).toContain("ERROR_VIEW.detailTask");
    expect(
      src.includes("props.context?.title"),
      "复制详情里没带任务名：同事拿到只会问「这是啥」（#175 走查读到剪贴板里只有 42 字节）。",
    ).toBe(true);
  });
});
