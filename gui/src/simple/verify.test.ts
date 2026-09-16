// 结果核对（信任层）的测试：本机说在 / 说不在 / 说不清，三句话各自对应一种事实。
//
// 最要紧的一组是「它说有文件、实际找不到」——用户最怕的就是这个，所以必须有测试
// 钉住；另一组是「核对失败时不许假装核对过」。这里不用 DOM、不连桥接：取事实的
// 函数是参数，测试传假的。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { VERIFY } from "./copy-verify.ts";
import {
  evaluateFacts,
  normalizeFacts,
  verifyResultFiles,
  type FileFact,
} from "./verify.ts";

/** 一条「本机事实」，字段和 Rust 侧一致（camelCase，经 normalizeFacts 之后）。 */
function fact(path: string, overrides: Partial<FileFact> = {}): FileFact {
  return { path, exists: true, size: 1024, modifiedMs: 1_700_000_000_000, readable: true, ...overrides };
}

/** 桥接原始形状（snake_case），用来验证解析层。 */
function wire(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path, exists: true, size: 2048, modified_ms: 1_700_000_000_000, readable: true, ...overrides };
}

describe("normalizeFacts", () => {
  test("reads the Rust snake_case shape", () => {
    const facts = normalizeFacts([wire("/work/结果.xlsx", { size: 4096 })]);
    expect(facts).toEqual([
      { path: "/work/结果.xlsx", exists: true, size: 4096, modifiedMs: 1_700_000_000_000, readable: true },
    ]);
  });

  test("a response that is not a list is unusable, not 'no files'", () => {
    expect(normalizeFacts("nonsense")).toBeNull();
    expect(normalizeFacts(null)).toBeNull();
    expect(normalizeFacts({ fact: [] })).toBeNull();
  });

  test("hostile entries are dropped instead of throwing", () => {
    const facts = normalizeFacts([
      null,
      { exists: true },
      { path: "" },
      { path: "/ok.txt", exists: "yes", size: "big", readable: 1 },
    ]);
    expect(facts).toHaveLength(1);
    expect(facts![0]).toEqual({
      path: "/ok.txt",
      // `exists`/`readable` are booleans or nothing: a truthy string is not proof.
      exists: false,
      size: null,
      modifiedMs: null,
      readable: false,
    });
  });
});

describe("evaluateFacts", () => {
  test("all files present and readable → ok, with the total size", () => {
    const report = evaluateFacts(["/work/a.xlsx", "/work/b.xlsx"], [
      fact("/work/a.xlsx", { size: 1024 }),
      fact("/work/b.xlsx", { size: 1024 }),
    ]);
    expect(report.kind).toBe("ok");
    expect(report.message).toBe(VERIFY.ok);
    expect(report.sizeText).toBe("2.0 KB");
    expect(report.missing).toEqual([]);
    expect(report.files.map((file) => file.exists)).toEqual([true, true]);
  });

  test("claims a file that is not there → missing, and it is named", () => {
    const report = evaluateFacts(["/work/在.xlsx", "/work/找不到.xlsx"], [
      fact("/work/在.xlsx"),
      fact("/work/找不到.xlsx", { exists: false, size: null, modifiedMs: null, readable: false }),
    ]);
    expect(report.kind).toBe("missing");
    expect(report.reason).toBe("absent");
    expect(report.message).toBe(VERIFY.missing);
    expect(report.missing).toEqual(["/work/找不到.xlsx"]);
    expect(report.sizeText).toBeNull();
    expect(report.detail).toContain("找不到");
    expect(report.detail).toContain("/work/找不到.xlsx");
  });

  test("a file that is there but cannot be opened is not a success", () => {
    const report = evaluateFacts(["/work/锁着的.xlsx"], [
      fact("/work/锁着的.xlsx", { readable: false }),
    ]);
    expect(report.kind).toBe("missing");
    expect(report.reason).toBe("unreadable");
    expect(report.message).toBe(VERIFY.unreadable);
    expect(report.missing).toEqual([]);
  });

  test("a folder is a fact, and it is not an openable result file", () => {
    const report = evaluateFacts(["/work/文件夹"], [
      fact("/work/文件夹", { size: null, readable: false }),
    ]);
    expect(report.kind).toBe("missing");
    expect(report.reason).toBe("unreadable");
  });

  test("an incomplete answer is 'could not check', never a guessed 'missing'", () => {
    // Only one of the two claimed files has a fact: the check did not finish.
    const report = evaluateFacts(["/work/a.xlsx", "/work/b.xlsx"], [fact("/work/a.xlsx")]);
    expect(report.kind).toBe("unknown");
    expect(report.message).toBe(VERIFY.unknown);
  });

  test("facts === null means the check failed: say so, do not pretend", () => {
    const report = evaluateFacts(["/work/a.xlsx"], null);
    expect(report.kind).toBe("unknown");
    expect(report.message).toBe(VERIFY.unknown);
    expect(report.sizeText).toBeNull();
    expect(report.missing).toEqual([]);
  });

  test("no claimed files → nothing to check", () => {
    const report = evaluateFacts([], []);
    expect(report.kind).toBe("none");
    expect(report.message).toBe("");
    expect(report.files).toEqual([]);
  });

  test("blank and duplicate paths are ignored, not reported as missing", () => {
    const report = evaluateFacts(["", "  ", "/work/a.xlsx", "/work/a.xlsx"], [fact("/work/a.xlsx")]);
    expect(report.kind).toBe("ok");
    expect(report.files).toHaveLength(1);
  });
});

describe("verifyResultFiles", () => {
  test("ok path: fetches facts and reports the size", async () => {
    const seen: string[][] = [];
    const report = await verifyResultFiles(["/work/结果.xlsx"], async (paths) => {
      seen.push(paths);
      return [wire("/work/结果.xlsx", { size: 3 * 1024 * 1024 })];
    });
    expect(seen).toEqual([["/work/结果.xlsx"]]);
    expect(report.kind).toBe("ok");
    expect(report.sizeText).toBe("3.0 MB");
  });

  test("a thrown error becomes 'could not check', not a fake answer", async () => {
    const report = await verifyResultFiles(["/work/结果.xlsx"], async () => {
      throw new Error("bridge unavailable");
    });
    expect(report.kind).toBe("unknown");
    expect(report.message).toBe(VERIFY.unknown);
    expect(report.files[0]).toEqual({ path: "/work/结果.xlsx", exists: false, readable: false, size: null });
  });

  test("a non-list response is also 'could not check'", async () => {
    const report = await verifyResultFiles(["/work/结果.xlsx"], async () => "oops");
    expect(report.kind).toBe("unknown");
  });

  test("no claimed files → the fetcher is never called", async () => {
    let called = 0;
    const report = await verifyResultFiles([], async () => {
      called += 1;
      return [];
    });
    expect(called).toBe(0);
    expect(report.kind).toBe("none");
  });

  test("the missing case carries a copyable detail and an exit", async () => {
    const report = await verifyResultFiles(["/work/找不到.xlsx"], async () => [
      wire("/work/找不到.xlsx", { exists: false, size: null, modified_ms: null, readable: false }),
    ]);
    expect(report.kind).toBe("missing");
    expect(report.detail).toContain(VERIFY.detailIntro);
    expect(report.detail).toContain("/work/找不到.xlsx");
    // 出路的字都在文案模块里，界面直接引用。
    expect(VERIFY.retry.length).toBeGreaterThan(0);
    expect(VERIFY.openFolder.length).toBeGreaterThan(0);
    expect(VERIFY.copyDetail.length).toBeGreaterThan(0);
  });
});
