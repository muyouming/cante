// #63 / #64 — the two trust surfaces that must never overstate.
//
//   * The track record ("做过 4 次，成了 4 次") may only come from real runs on
//     this computer: no history → no line, dry runs and in-flight runs don't
//     count, and the newest failure keeps its plain-Chinese reason.
//   * The 【需要你核对】 paragraph is the assistant's own admission for *this*
//     run. Absent means absent — the result card shows nothing rather than a
//     canned warning.
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { TRUST, evidenceLine } from "./copy.ts";
import {
  CHECK_MARKER,
  checkNoteFromRows,
  evidenceFor,
  extractCheckNote,
  failureFor,
  lastAgentText,
} from "./evidence.ts";
import { emptyImpact, type TaskRun } from "./run.ts";
import { FREE_TEXT_RISKS, TASKS, freeTask, risksForTask } from "./tasks/index.ts";

function run(overrides: Partial<TaskRun> & Pick<TaskRun, "id" | "taskId" | "state">): TaskRun {
  return {
    taskTitle: "测试用",
    files: [],
    instruction: "把这几张表合成一张",
    plan: ["第一步", "第二步", "第三步"],
    impact: emptyImpact(),
    result: null,
    online: false,
    error: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("evidenceFor (#64)", () => {
  test("no history means no number at all", () => {
    expect(evidenceFor([], "excel.merge")).toBeNull();
    // History from other jobs does not count either.
    expect(evidenceFor([run({ id: "a", taskId: "excel.tidy", state: "done" })], "excel.merge")).toBeNull();
  });

  test("counts finished runs of this job only, and how many were done", () => {
    const runs = [
      run({ id: "a", taskId: "excel.merge", state: "done" }),
      run({ id: "b", taskId: "excel.merge", state: "failed" }),
      run({ id: "c", taskId: "excel.merge", state: "done" }),
      run({ id: "d", taskId: "excel.merge", state: "cancelled" }),
      run({ id: "e", taskId: "excel.tidy", state: "done" }),
    ];
    expect(evidenceFor(runs, "excel.merge")).toEqual({ runs: 4, ok: 2 });
  });

  test("in-flight runs and rehearsals are not evidence", () => {
    const runs = [
      run({ id: "a", taskId: "pdf.merge", state: "running" }),
      run({ id: "b", taskId: "pdf.merge", state: "preview" }),
      run({ id: "c", taskId: "pdf.merge", state: "done", dryRun: true }),
    ];
    expect(evidenceFor(runs, "pdf.merge")).toBeNull();
  });
});

describe("failureFor (#64)", () => {
  test("no failure → nothing to open", () => {
    const runs = [run({ id: "a", taskId: "excel.merge", state: "done" })];
    expect(failureFor(runs, "excel.merge")).toBeNull();
  });

  test("keeps the newest failure's own plain-Chinese reason", () => {
    const runs = [
      run({
        id: "old",
        taskId: "pdf.toword",
        state: "failed",
        createdAt: 1_700_000_000_000,
        error: { what: "旧的原因", how: "旧的出路", detail: "raw" },
      }),
      run({
        id: "new",
        taskId: "pdf.toword",
        state: "failed",
        createdAt: 1_800_000_000_000,
        error: { what: "这份 PDF 打不开。", how: "请对方重新发一份。", detail: "raw" },
      }),
    ];
    const failure = failureFor(runs, "pdf.toword");
    expect(failure?.what).toBe("这份 PDF 打不开。");
    expect(failure?.how).toBe("请对方重新发一份。");
    expect(failure?.when).toContain("年"); // far-past date is printed in full
  });

  test("a run the user cancelled herself is not a failure", () => {
    const runs = [run({ id: "a", taskId: "pdf.split", state: "cancelled" })];
    expect(failureFor(runs, "pdf.split")).toBeNull();
  });
});

describe("evidenceLine (#64)", () => {
  test("the success count is never rounded up in words", () => {
    expect(evidenceLine(3, 3)).toBe("在这台电脑上做过 3 次，每次都做成了。");
    expect(evidenceLine(4, 3)).toBe("在这台电脑上做过 4 次，其中 3 次做成了。");
    expect(evidenceLine(2, 0)).toBe("在这台电脑上做过 2 次，都还没做成。");
    expect(evidenceLine(0, 0)).toBe("");
  });
});

describe("extractCheckNote (#63)", () => {
  test("reads the paragraph the assistant was told to end with", () => {
    const text = "做好了，结果在「结果_合并.xlsx」。\n\n【需要你核对】\n有 3 行日期认不准，标黄了。";
    expect(extractCheckNote(text)).toBe("有 3 行日期认不准，标黄了。");
  });

  test("the last marker wins when there is more than one", () => {
    const text = "【需要你核对】第一版\n中间又聊了几句\n【需要你核对】第二版，只有这条算数";
    expect(extractCheckNote(text)).toBe("第二版，只有这条算数");
  });

  test("a trailing 【…】 section ends the note", () => {
    const text = "【需要你核对】有两行标黄\n【下一步】要不要再跑一次";
    expect(extractCheckNote(text)).toBe("有两行标黄");
  });

  test("an inline bracket inside the note is not treated as a new section", () => {
    const text = "【需要你核对】结果里有一列叫【金额（元）】的，我没对上，请你改一下";
    expect(extractCheckNote(text)).toBe("结果里有一列叫【金额（元）】的，我没对上，请你改一下");
  });

  test("no paragraph (or an empty one) → nothing shown", () => {
    expect(extractCheckNote("做好了。")).toBeNull();
    expect(extractCheckNote(`${CHECK_MARKER}   `)).toBeNull();
    expect(extractCheckNote("")).toBeNull();
  });
});

describe("checkNoteFromRows (#63)", () => {
  test("takes the last assistant message, ignores user and tool rows", () => {
    const rows = [
      { kind: "user", text: "把这几张表合成一张" },
      { kind: "agent", text: "【需要你核对】旧的一条" },
      { kind: "tool", text: "ok" },
      { kind: "agent", text: "做好了。\n【需要你核对】合并没有问题，但有两行重复没去掉。" },
    ];
    expect(checkNoteFromRows(rows)).toBe("合并没有问题，但有两行重复没去掉。");
  });

  test("no assistant message → nothing", () => {
    expect(checkNoteFromRows([{ kind: "user", text: "在吗" }])).toBeNull();
    expect(lastAgentText([])).toBeNull();
  });
});

describe("risksForTask (#63)", () => {
  test("every catalogue card carries its own risks", () => {
    for (const task of TASKS) {
      const risks = risksForTask(task.id);
      expect(risks.length).toBeGreaterThan(0);
      expect(risks).toBe(task.risks as string[]);
    }
  });

  test("the free-sentence path has its own list", () => {
    expect(risksForTask("free.text")).toBe(FREE_TEXT_RISKS);
    expect(freeTask("随便做点什么").risks?.length).toBe(FREE_TEXT_RISKS.length);
  });

  test("an unknown/old task id invents nothing", () => {
    expect(risksForTask("gone.forever")).toEqual([]);
    expect(risksForTask("")).toEqual([]);
  });

  test("no card falls back to a meaningless disclaimer", () => {
    for (const task of TASKS) {
      for (const risk of task.risks ?? []) {
        expect(risk).not.toContain("仅供参考");
        expect(risk).not.toContain("AI");
      }
    }
    expect(TRUST.limitsTitle).toBe("这个任务可能不准的地方");
  });
});
