// Pure tests for the simple-mode trust layer: the snapshot diff, the impact
// arithmetic and the Chinese copy. No DOM, no bridge, no daemon — these are the
// numbers and sentences the result card and history screen will show verbatim.
import { describe, expect, test } from "bun:test";

import {
  OVERWRITE_CONSENT,
  buildResult,
  describeImpact,
  diffSnapshots,
  dryRunInstruction,
  emptyImpact,
  fallbackPlan,
  fileName,
  folderName,
  formatSize,
  formatWhen,
  hasActiveRisk,
  impactOf,
  newRunId,
  normalizeEntries,
  planRisks,
  runIsOnline,
  type SnapshotEntry,
} from "./run.ts";

function entry(
  path: string,
  size: number,
  mtimeMs: number,
  lines: number | null = null,
): SnapshotEntry {
  return { path, size, mtimeMs, lines };
}

describe("snapshot normalization", () => {
  test("reads the Rust snake_case shape and sorts by path", () => {
    const entries = normalizeEntries([
      { path: "/b.txt", size: 2, mtime_ms: 20, lines: 1 },
      { path: "/a.txt", size: 1, mtime_ms: 10 },
    ]);
    expect(entries.map((item) => item.path)).toEqual(["/a.txt", "/b.txt"]);
    expect(entries[0]).toEqual({ path: "/a.txt", size: 1, mtimeMs: 10, lines: null });
  });

  test("drops hostile entries instead of throwing", () => {
    const entries = normalizeEntries([
      null,
      { size: 5 },
      { path: "" },
      { path: "/ok.txt", size: "12", mtime_ms: "not a number", lines: "3" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.size).toBe(12);
    expect(entries[0]!.mtimeMs).toBe(-1);
    expect(entries[0]!.lines).toBeNull();
    expect(normalizeEntries("nonsense" as unknown)).toEqual([]);
  });
});

describe("diffing", () => {
  test("separates created, modified and deleted", () => {
    const before = [entry("/keep", 10, 100), entry("/edit", 10, 100), entry("/gone", 10, 100)];
    const after = [entry("/keep", 10, 100), entry("/edit", 20, 200), entry("/new", 5, 300)];
    const diff = diffSnapshots(before, after);
    expect(diff.created).toEqual(["/new"]);
    expect(diff.modified).toEqual(["/edit"]);
    expect(diff.deleted).toEqual(["/gone"]);
  });

  test("counts a same-size touch as modified (the safe direction)", () => {
    const diff = diffSnapshots([entry("/a", 10, 100)], [entry("/a", 10, 101)]);
    expect(diff.modified).toEqual(["/a"]);
  });

  test("a line-count change alone still counts", () => {
    const diff = diffSnapshots([entry("/a", 10, 100, 5)], [entry("/a", 10, 100, 4)]);
    expect(diff.modified).toEqual(["/a"]);
  });

  test("impact is the three counts plus the always-zero messages", () => {
    const diff = diffSnapshots([entry("/x", 1, 1)], [entry("/y", 1, 1)]);
    expect(impactOf(diff)).toEqual({ created: 1, modified: 0, deleted: 1, messages: 0 });
    expect(emptyImpact()).toEqual({ created: 0, modified: 0, deleted: 0, messages: 0 });
  });
});

describe("paths and sizes", () => {
  test("handles both separators", () => {
    expect(fileName("/Users/wang/报表.xlsx")).toBe("报表.xlsx");
    expect(folderName("/Users/wang/报表.xlsx")).toBe("/Users/wang");
    expect(fileName("C:\\Users\\wang\\报表.xlsx")).toBe("报表.xlsx");
    expect(folderName("C:\\Users\\wang\\报表.xlsx")).toBe("C:\\Users\\wang");
    expect(fileName("报表.xlsx")).toBe("报表.xlsx");
  });

  test("formats sizes in units a person recognises", () => {
    expect(formatSize(0)).toBe("0 字节");
    expect(formatSize(512)).toBe("512 字节");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("result copy", () => {
  test("names new files and shows line changes for edited ones", () => {
    const before = [entry("/报表.xlsx", 100, 1), entry("/名单.txt", 2000, 1, 1234)];
    const after = [entry("/报表.xlsx", 100, 1), entry("/名单.txt", 1900, 2, 1180), entry("/结果.xlsx", 50, 2)];
    const diff = diffSnapshots(before, after);
    const result = buildResult(before, after, diff);
    expect(result.files.map((file) => file.path)).toEqual(["/结果.xlsx", "/名单.txt"]);
    const edited = result.files.find((file) => file.path === "/名单.txt");
    expect(edited?.summary).toContain("1234 行 → 1180 行");
    expect(edited?.summary).toContain("减少 54 行");
    expect(result.summary).toContain("新增 1 个文件");
    expect(result.summary).toContain("修改 1 个文件");
  });

  test("a dry run says so without hiding a real change", () => {
    const before = [entry("/a.txt", 1, 1)];
    const after = [entry("/a.txt", 1, 1), entry("/new.txt", 1, 1)];
    const result = buildResult(before, after, diffSnapshots(before, after), { dryRun: true });
    expect(result.summary.startsWith("试跑完成")).toBe(true);
    expect(result.summary).toContain("新增 1 个文件");
  });

  test("no change is stated plainly", () => {
    const before = [entry("/a.txt", 1, 1)];
    const result = buildResult(before, before, diffSnapshots(before, before));
    expect(result.summary).toBe("没有改动任何文件");
    expect(result.files).toEqual([]);
  });

  test("describeImpact always mentions the four categories", () => {
    expect(describeImpact(emptyImpact())).toBe("新增 0 个文件，修改 0 个，删除 0 个，发消息 0 条");
  });
});

describe("red-line risks (#42)", () => {
  test("flags plans that delete, overwrite or mass-message", () => {
    const risks = planRisks(["把重复的行删掉", "覆盖原来的表格", "整理好以后群发通知"]);
    expect(risks.map((risk) => risk.kind)).toEqual(["delete", "overwrite", "messages"]);
    expect(hasActiveRisk(risks)).toBe(true);
  });

  test("a safe plan triggers none of them but still shows the promise", () => {
    const risks = planRisks(["读取原表", "把结果另存为新文件"]);
    expect(hasActiveRisk(risks)).toBe(false);
    for (const risk of risks) {
      expect(risk.active).toBe(false);
      expect(risk.detail.length).toBeGreaterThan(0);
    }
    expect(risks.find((risk) => risk.kind === "messages")?.detail).toContain("不会自动发消息");
  });

  test("the catalogue's own safe wording does not cry wolf", () => {
    // Verbatim lines from `simple/tasks/**`: every one mentions a red-line word
    // inside a promise not to do it, or as something merely compared/reported.
    const safe = [
      "每一格都完全一样的重复行，只留第一条，并数出去掉了几条",
      "结果另存为一个新文件，原来的表一张都不动",
      "按整行或者你指定的关键列，找出新增、删除、改动过的记录",
      "新名字已经有人用了，就自动加序号，绝不覆盖",
      "整理清单另存为新文件，不删任何东西",
      "它只整理成草稿，发送由你自己来",
    ];
    for (const line of safe) {
      expect(hasActiveRisk(planRisks([line]))).toBe(false);
    }
  });
});

describe("where the data went", () => {
  test("local-only disables the online stamp", () => {
    const storage = { getItem: () => "1" };
    expect(runIsOnline(true, storage)).toBe(false);
    expect(runIsOnline(true, { getItem: () => "0" })).toBe(true);
    expect(runIsOnline(false, { getItem: () => "0" })).toBe(false);
    expect(runIsOnline(true, null)).toBe(true);
  });
});

describe("time", () => {
  const now = new Date("2026-03-05T15:30:00").getTime();

  test("today and yesterday keep it short", () => {
    expect(formatWhen(new Date("2026-03-05T09:05:00").getTime(), now)).toBe("今天 09:05");
    expect(formatWhen(new Date("2026-03-04T22:00:00").getTime(), now)).toBe("昨天 22:00");
  });

  test("this year drops the year, older keeps it", () => {
    expect(formatWhen(new Date("2026-01-02T08:00:00").getTime(), now)).toBe("1月2日 08:00");
    expect(formatWhen(new Date("2024-12-31T23:59:00").getTime(), now)).toBe("2024年12月31日 23:59");
    expect(formatWhen(0, now)).toBe("时间不详");
  });
});

describe("run scaffolding", () => {
  test("ids are prefixed and distinct", () => {
    const a = newRunId(1000);
    const b = newRunId(1000);
    expect(a.startsWith("run_")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("a fallback plan is always four concrete steps", () => {
    const plan = fallbackPlan(["/a.xlsx", "/b.xlsx"]);
    expect(plan.length).toBe(4);
    expect(plan.join()).toContain("2 个文件");
  });

  test("the opt-in overwrite clause is explicit", () => {
    expect(OVERWRITE_CONSENT).toContain("用户已明确同意");
    expect(OVERWRITE_CONSENT).toContain("原件备份");
  });

  test("the dry-run clause forbids every write", () => {
    const text = dryRunInstruction("整理表格");
    expect(text).toContain("只试跑");
    expect(text).toContain("不要");
  });
});
