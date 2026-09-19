// 独立评审（2026-09-20）抓到的 #204 回归：BUSY 规则被**放宽**过头了。
//
// 背景：#204 修的是一个真 P0 —— `403 Forbidden: blocked by corporate proxy` 里
// 含 `locked by`，被当成「文件被 Excel 占着」。修法是「英文只认 lock 开头的词」。
// 但改出来的规则把 `blocked` 写成了 `\blocked\b`：正则里 `\b` 是**词边界**，
// 所以 `\blocked\b` 实际匹配的是**字面量 `locked`**，而**不是** `blocked`。
//
// 后果有两个，都不在 #204 自己那两条回归用例的覆盖范围内：
//   1. 它想匹配的 `blocked`（英文原文里的 blocked by …）现在**匹配不到**；
//   2. 它匹配的 `locked` 是个光秃秃的子串——**任何**含 `locked` 的非文件错误
//      （账号被锁、密钥库被锁、数据库锁）都会被判成「文件被那个窗口占着」，
//      屏幕上让她去关一个根本不存在的 Excel/WPS 窗口。这正是 #197 点名的那类错。
//
// ⚠️ 这个文件在当前 HEAD（b0b3a7d）上是**故意红**的：它就是那份「能红的测试」，
// 用来把上面的 bug 钉成可复现的判据。**正确的修法是把 `\blocked\b` 这个分支整个删掉**
// （注释自己说的「只认 lock 开头的词」——`file is locked` / `locked for writing`
// 已经覆盖了真被锁的情况；那个分支本来就是凭空多出来的）。改完本文件应当全绿。
// **不要**改成 `\bblocked\b`：那会重新匹配 `blocked by corporate proxy`，
// 把 #204 修掉的 P0 又带回来（实测：`\bblocked\b.test("...blocked by corporate proxy") === true`）。
// 评审不动产品代码（见报告交付约定），所以这条红保留在评审分支上。
import { describe, expect, test } from "bun:test";

import { actionsFor } from "./recovery.ts";
import type { RecoveryAction, RecoveryError } from "./recovery.ts";

function err(cause: string): RecoveryError {
  return { what: "", how: "", detail: "", cause };
}

function kinds(actions: readonly RecoveryAction[]): string[] {
  return actions.map((item) => item.kind);
}

describe("评审发现：#204 把 BUSY 规则放宽到了非文件错误（\\blocked\\b 其实匹配 locked）", () => {
  // 非文件的 locked：账号 / 密钥 / 数据库。她按了「关掉那个窗口再试」也关不掉
  // 一个不存在的窗口，只会更困惑。期望：不许出现 close-file。
  test("账号/密钥/数据库被锁，不许说成「文件被占用」", () => {
    for (const text of [
      "Your account has been locked after too many failed sign-in attempts",
      "The keyring is locked; unlock it to continue",
      "database is locked: could not write session state",
      "HTTP 423 Locked",
    ]) {
      expect(kinds(actionsFor(err(text))), text).not.toContain("close-file");
    }
  });

  // 反面对照：真正的文件名占用（locked for writing / file is locked / EBUSY /
  // 另一个程序正在使用）仍然必须判成 close-file。收紧规则不许把这条弄丢。
  test("真是文件被锁：仍然判成「关掉那个窗口」", () => {
    for (const text of [
      "EBUSY: resource busy or locked, open 'C:\\报表.xlsx'",
      "The file is locked by another process",
      "另一个程序正在使用此文件",
      "C:\\报表.xlsx is locked for writing",
    ]) {
      expect(kinds(actionsFor(err(text)))[0], text).toBe("close-file");
    }
  });

  // 反向守卫：英文原文里真写 `blocked` 的**非文件**场景（公司策略拦截），
  // 也不该被判成文件占用。#204 的注释说自己只认 lock 开头的词——那就把
  // 「blocked 不再触发 BUSY」这件事也钉住；`\blocked\b` 恰好做不到。
  test("英文 blocked（非文件语境）不许触发 close-file", () => {
    expect(kinds(actionsFor(err("access blocked by the security policy")))).not.toContain("close-file");
  });
});
