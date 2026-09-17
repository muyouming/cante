// The error dictionary is the contract behind 大白话错误 (#44): any English a
// lower layer throws must come out as 发生了什么 + 你可以怎么做, with the raw
// text kept for 复制详情. These tests pin both the mapping and the pass-through.
import { describe, expect, test } from "bun:test";

import { ERRORS, WIZARD_HEALTH, explainError, isRetryable } from "./copy.ts";

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
