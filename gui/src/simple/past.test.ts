// r10 — 她**第二次做同一件事**时，动手前先告诉她「上次也做成过，那一份还在」。
//
// 这是产品律 2「别弄坏我的东西」在确认页上的那一句：她最怕覆盖上次那份，而
// 「上次那份还在不在、叫什么名字」正是能安她心的话。这里把这条钉成五件事：
//
//   1. 同一张卡以前成功过 → 出「上次也做成过」那句，含**文件名**、不含完整位置；
//   2. 同一张卡从没成功过 → 不出那句（她第一次做，别吓她）；
//   3. 同一张卡失败过 → 原有的失败那句照旧（回归，不许被新的一句顶掉）；
//   4. 成功过又失败过 → 两句都在，且**成功那句在前**；
//   5. **别的卡**成功过 → 不算（不许张冠李戴）。
//
// 判定是纯函数（evidence.ts 的 lastSuccessFor），时间与文件名都从本机记录里来，
// 不猜。确认页那一块是源码扫描（本仓库没有 jsdom，理由见 typography.test.ts
// 开头）：`PAST.line` 必须排在失败那句之前、且确实是渲染出来的，不是死文案。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PAST } from "./copy-past.ts";
import { lastSuccessFor, failureFor } from "./evidence.ts";
import { emptyImpact, formatWhen, type RunResult, type TaskRun } from "./run.ts";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

const TASK = "excel.merge";
const OTHER = "pdf.merge";
/** 带文件夹的一整串位置：用来证明界面上只出现文件名，不出现完整位置。 */
const RESULT_PATH = "C:/Users/王姐/桌面/结果_合并.xlsx";
const WHEN_MS = 1_800_000_000_000;

function result(path: string): RunResult {
  return { files: [{ path, summary: "新增 · 12 KB" }], summary: "新增 1 个文件" };
}

function run(overrides: Partial<TaskRun> & Pick<TaskRun, "id" | "taskId" | "state">): TaskRun {
  return {
    taskTitle: "测试用",
    files: [],
    instruction: "把这两张表合成一张",
    plan: ["第一步", "第二步", "第三步"],
    impact: emptyImpact(),
    result: null,
    online: false,
    error: null,
    createdAt: 0,
    ...overrides,
  };
}

/** 确认页上「上次也做成过」那一段真正会给她的两句话。 */
function shownLines(name: string, when: string): string {
  return [PAST.line(name, when), PAST.safe].join("\n");
}

describe("lastSuccessFor：上一次做成过的那个结果文件", () => {
  test("① 同一张卡成功过一次 → 给出文件名与时间；界面那句话含文件名、不含完整位置", () => {
    const runs = [
      run({ id: "a", taskId: TASK, state: "done", createdAt: WHEN_MS, result: result(RESULT_PATH) }),
    ];
    const past = lastSuccessFor(runs, TASK);
    expect(past).not.toBeNull();
    expect(past?.name).toBe("结果_合并.xlsx");
    // 不猜时间：用的就是本机记录的 formatWhen。
    expect(past?.when).toBe(formatWhen(WHEN_MS));

    const shown = shownLines(past?.name ?? "", past?.when ?? "");
    expect(shown).toContain("上次也做成过");
    expect(shown).toContain("结果_合并.xlsx");
    expect(shown).toContain(past?.when ?? "");
    // 完整位置绝不出现在她眼前（也没有任何文件夹名 / 斜杠）。
    expect(shown).not.toContain(RESULT_PATH);
    expect(shown).not.toContain("C:/Users");
    expect(shown).not.toContain("/");
    expect(shown).not.toContain("\\");
  });

  test("② 同一张卡从没成功过 → null，界面那句一个字都不出现", () => {
    expect(lastSuccessFor([], TASK)).toBeNull();
    // 只有失败的记录不算成功过。
    const failed = [run({ id: "a", taskId: TASK, state: "failed", createdAt: WHEN_MS })];
    expect(lastSuccessFor(failed, TASK)).toBeNull();
    // 成功但没留下结果文件（例如只说不做）：没有文件可指，不许编一个。
    const empty = [run({ id: "b", taskId: TASK, state: "done", createdAt: WHEN_MS, result: null })];
    expect(lastSuccessFor(empty, TASK)).toBeNull();
    const noFiles = [
      run({ id: "c", taskId: TASK, state: "done", createdAt: WHEN_MS, result: { files: [], summary: "无" } }),
    ];
    expect(lastSuccessFor(noFiles, TASK)).toBeNull();
    // 试跑（dryRun）不动文件，不算数。
    const rehearsal = [
      run({
        id: "d",
        taskId: TASK,
        state: "done",
        dryRun: true,
        createdAt: WHEN_MS,
        result: result(RESULT_PATH),
      }),
    ];
    expect(lastSuccessFor(rehearsal, TASK)).toBeNull();
  });

  test("③ 同一张卡失败过 → 失败那句照旧（回归：新的一句没有把它顶掉）", () => {
    const runs = [
      run({
        id: "a",
        taskId: TASK,
        state: "failed",
        createdAt: WHEN_MS,
        error: { what: "这张表打不开。", how: "换一份再试。", detail: "raw" },
      }),
    ];
    // 失败那句还在，且说的还是它自己的原因。
    const failure = failureFor(runs, TASK);
    expect(failure?.what).toBe("这张表打不开。");
    expect(failure?.how).toBe("换一份再试。");
    // 没有成功过，所以「上次也做成过」不出现。
    expect(lastSuccessFor(runs, TASK)).toBeNull();
  });

  test("④ 成功过又失败过 → 两句都在，成功那句来自最新的成功那一次", () => {
    const older = run({
      id: "old",
      taskId: TASK,
      state: "done",
      createdAt: WHEN_MS - 100_000,
      result: result("C:/旧/旧结果.xlsx"),
    });
    const newerOk = run({
      id: "ok",
      taskId: TASK,
      state: "done",
      createdAt: WHEN_MS,
      result: result(RESULT_PATH),
    });
    const failed = run({
      id: "bad",
      taskId: TASK,
      state: "failed",
      createdAt: WHEN_MS + 50_000,
      error: { what: "上次没做完。", how: "可以再试。", detail: "raw" },
    });
    const runs = [older, newerOk, failed];

    const past = lastSuccessFor(runs, TASK);
    const failure = failureFor(runs, TASK);
    expect(past?.name).toBe("结果_合并.xlsx"); // 取最新那次成功，不是最旧那次
    expect(failure?.what).toBe("上次没做完。");
    // 两句各自成立 —— 失败那句没有把成功那句挤掉。
    expect(shownLines(past?.name ?? "", past?.when ?? "")).toContain("上次也做成过");
    expect(failure).not.toBeNull();
  });

  test("⑤ 别的卡成功过 → 不算（不许张冠李戴）", () => {
    const runs = [
      run({ id: "a", taskId: OTHER, state: "done", createdAt: WHEN_MS, result: result(RESULT_PATH) }),
    ];
    expect(lastSuccessFor(runs, TASK)).toBeNull();
    // 反向对照：问对的卡就能拿到。
    expect(lastSuccessFor(runs, OTHER)?.name).toBe("结果_合并.xlsx");
    // 空 taskId 也不猜。
    expect(lastSuccessFor(runs, "")).toBeNull();
  });
});

describe("接线：确认页真的把它画出来，而且成功那句排在失败那句之前", () => {
  const sheet = read("ConfirmSheet.tsx");

  test("确认页用 lastSuccessFor，且文案来自 copy-past.ts（不在组件里另写一份）", () => {
    expect(sheet).toContain("lastSuccessFor");
    expect(sheet).toContain('from "./copy-past.ts"');
    expect(sheet).toContain("PAST.line(");
    expect(sheet).toContain("PAST.safe");
  });

  test("成功那句排在失败入口之前：她先听到「上次做成了」，再看到「上次为什么没成」", () => {
    const success = sheet.indexOf("PAST.line(");
    const failure = sheet.indexOf("TRUST.failureShow");
    expect(success).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(-1);
    expect(success).toBeLessThan(failure);
  });

  test("原有的失败那一段照旧：failureFor 还在，没有被新的一块替掉", () => {
    expect(sheet).toContain("failureFor(");
    expect(sheet).toContain("TRUST.failureShow");
    expect(sheet).toContain("TRUST.failureHide");
  });
});

describe("文案：全中文零术语、只说文件名", () => {
  test("两句话都非空、没有英语、没有「路径」这类黑名单词", () => {
    // 用纯中文文件名看模板本身：这里的字母只可能来自她自己的文件名（数据），
    // 不该来自我们写的那句话。
    const lines = [PAST.line("结果合并表", "今天 14:30"), PAST.safe];
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).not.toMatch(/[A-Za-z]/);
    }
    const joined = lines.join("\n");
    expect(joined).not.toContain("路径");
    expect(joined).not.toContain("文件位置");
    // 文件名原样带进去（界面上她要认得出是哪一份）。
    expect(PAST.line("结果_合并.xlsx", "今天 14:30")).toContain("结果_合并.xlsx");
  });

  test("正面回答她最怕的那件事：这次不会盖住上次那份", () => {
    expect(PAST.safe).toContain("另存为新文件");
    expect(PAST.safe).toContain("不会盖住");
  });
});
