// The error dictionary is the contract behind 大白话错误 (#44): any English a
// lower layer throws must come out as 发生了什么 + 你可以怎么做, with the raw
// text kept for 复制详情. These tests pin both the mapping and the pass-through.
import { describe, expect, test } from "bun:test";

import { ERRORS, explainError, isRetryable } from "./copy.ts";

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
