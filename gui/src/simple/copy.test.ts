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
