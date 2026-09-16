// r13 队列的纯逻辑测试：下一件是谁、还剩几件、中文怎么念。
//
// 这些都是 `simple/queue.ts` 里的函数：不碰 Daemon、不存盘、不知道 store 存在。
// 所以这里的每一条都是直接钉住"账"本身——包括坏数据：一个 null、一条缺任务
// 的记录混进队列里时，别的记录照样要能用，函数也不许抛错。
import { describe, expect, test } from "bun:test";

import {
  activeJob,
  appendJob,
  describeQueue,
  isJob,
  jobFor,
  makeJob,
  newQueueId,
  nextWaiting,
  positionOf,
  prependJob,
  queueSummary,
  sameJob,
  withJobState,
  withoutJob,
  type QueuedJob,
} from "./queue.ts";

const RUN_A = { taskId: "excel.merge", instruction: "合成一张", files: ["/work/a.xlsx"] };
const RUN_B = { taskId: "file.rename", instruction: "改个名", files: ["/work/b.docx"] };

/** 造一条排队记录；测试里只关心状态和身份。 */
function job(over: Partial<QueuedJob> = {}): QueuedJob {
  const base: QueuedJob = {
    id: "q_test",
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
    files: ["/work/a.xlsx"],
    instruction: "合成一张",
    state: "waiting",
    createdAt: 1_700_000_000_000,
  };
  return { ...base, ...over };
}

describe("makeJob：外面的数据变成排队里的一条", () => {
  test("卡片、文件、她那句话都留得住", () => {
    const made = makeJob(
      {
        taskId: "excel.merge",
        taskTitle: "把几张表合成一张",
        plan: ["打开这几张表", "合成一张新表"],
        files: ["/work/a.xlsx", "/work/b.xlsx"],
        instruction: "合成一张",
      },
      1_700_000_000_000,
    );
    expect(made).not.toBeNull();
    expect(made!.taskId).toBe("excel.merge");
    expect(made!.taskTitle).toBe("把几张表合成一张");
    expect(made!.plan).toEqual(["打开这几张表", "合成一张新表"]);
    expect(made!.files).toEqual(["/work/a.xlsx", "/work/b.xlsx"]);
    expect(made!.instruction).toBe("合成一张");
    // 刚排上的当然是"还没轮到"。
    expect(made!.state).toBe("waiting");
    expect(made!.createdAt).toBe(1_700_000_000_000);
  });

  test("坏数据一律拒绝，而且不抛错", () => {
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "excel.merge",
      [],
      {},
      { taskId: "" },
      { taskId: 7, instruction: "合成一张" },
      { instruction: "合成一张" },
    ];
    for (const input of junk) {
      expect(makeJob(input)).toBeNull();
    }
  });

  test("缺了的字段按空的来，但任务 id 必须在", () => {
    const made = makeJob({ taskId: "excel.merge" });
    expect(made).not.toBeNull();
    expect(made!.taskTitle).toBe("excel.merge");
    expect(made!.plan).toEqual([]);
    expect(made!.files).toEqual([]);
    expect(made!.instruction).toBe("");
  });

  test("字段类型不对就当成没有，不许塞进非字符串的东西", () => {
    const made = makeJob({
      taskId: "excel.merge",
      taskTitle: 42,
      plan: ["一步一步来", null, 5],
      files: "/work/a.xlsx",
      instruction: { text: "合成一张" },
    });
    expect(made!.taskTitle).toBe("excel.merge");
    expect(made!.plan).toEqual(["一步一步来"]);
    expect(made!.files).toEqual([]);
    expect(made!.instruction).toBe("");
  });

  test("同一毫秒里连着排两件，id 也不会撞", () => {
    const first = makeJob({ taskId: "a" }, 1_700_000_000_000)!;
    const second = makeJob({ taskId: "b" }, 1_700_000_000_000)!;
    expect(first.id).not.toBe(second.id);
    expect(newQueueId(1_700_000_000_000)).not.toBe(newQueueId(1_700_000_000_000));
  });
});

describe("账：下一件是谁、还剩几件", () => {
  test("等着的第一件就是下一件，正在做的那件不算", () => {
    const jobs = [
      job({ id: "q1", state: "done" }),
      job({ id: "q2", state: "running" }),
      job({ id: "q3", state: "waiting", taskTitle: "查重" }),
      job({ id: "q4", state: "waiting", taskTitle: "整理文件夹" }),
    ];
    expect(nextWaiting(jobs)?.id).toBe("q3");
    expect(activeJob(jobs)?.id).toBe("q2");
    expect(queueSummary(jobs)).toEqual({
      remaining: 3,
      waiting: 2,
      finished: 1,
      current: jobs[1]!,
      next: jobs[2]!,
    });
  });

  test("空队列、全是做完的、混进坏数据都不崩", () => {
    expect(queueSummary([])).toEqual({
      remaining: 0,
      waiting: 0,
      finished: 0,
      current: null,
      next: null,
    });
    expect(nextWaiting([])).toBeNull();
    expect(activeJob([])).toBeNull();

    const doneOnly = [job({ id: "q1", state: "done" }), job({ id: "q2", state: "failed" })];
    expect(queueSummary(doneOnly).remaining).toBe(0);
    expect(queueSummary(doneOnly).finished).toBe(2);

    const hostile = [null, 7, "x", {}, { id: "no-task", state: "waiting" }, job({ id: "q9" })];
    expect(nextWaiting(hostile)?.id).toBe("q9");
    expect(queueSummary(hostile as QueuedJob[]).remaining).toBe(1);
  });

  test("改状态、拿掉一条，坏条目顺手丢掉", () => {
    const jobs = [job({ id: "q1" }), job({ id: "q2" })];
    const marked = withJobState(jobs, "q2", "done");
    expect(marked.map((item) => item.state)).toEqual(["waiting", "done"]);
    // 原来的数组不动。
    expect(jobs[1]!.state).toBe("waiting");
    expect(withoutJob(jobs, "q1").map((item) => item.id)).toEqual(["q2"]);
    expect(withJobState([null as unknown as QueuedJob, job({ id: "q3" })], "q3", "running")).toEqual([
      { ...job({ id: "q3" }), state: "running" },
    ]);
    expect(withoutJob([null as unknown as QueuedJob, job({ id: "q3" })], "q3")).toEqual([]);
  });

  test("排到队尾、插到最前面：坏条目顺手丢掉", () => {
    const junk = [null as unknown as QueuedJob, job({ id: "q1" })];
    const appended = appendJob(junk, job({ id: "q2" }));
    expect(appended.map((item) => item.id)).toEqual(["q1", "q2"]);
    const prepended = prependJob(junk, job({ id: "q0" }));
    expect(prepended.map((item) => item.id)).toEqual(["q0", "q1"]);
    // 原来的数组不动。
    expect(junk.map((item) => (item as QueuedJob | null)?.id ?? null)).toEqual([null, "q1"]);
  });

  test("两件是不是同一件事：同一个任务、同一句话、同一批文件", () => {
    expect(sameJob(job(), job({ id: "q_other" }))).toBe(true);
    expect(sameJob(job(), job({ instruction: "另一句话" }))).toBe(false);
    expect(sameJob(job(), job({ files: ["/work/c.xlsx"] }))).toBe(false);
    expect(sameJob(job(), job({ files: [] }))).toBe(false);
    expect(sameJob(job(), job({ taskId: "file.rename" }))).toBe(false);
  });

  test("手里这件和哪一条配对、排第几", () => {
    const jobs = [job({ id: "q1", state: "running" }), job({ id: "q2", state: "waiting", taskId: "file.rename", instruction: "改个名", files: ["/work/b.docx"] })];
    expect(jobFor(jobs, RUN_A)?.id).toBe("q1");
    expect(jobFor(jobs, RUN_B)?.id).toBe("q2");
    expect(jobFor(jobs, { taskId: "nope", instruction: "", files: [] })).toBeNull();
    expect(jobFor(jobs, null)).toBeNull();
    expect(positionOf(jobs, RUN_A)).toBe(1);
    expect(positionOf(jobs, RUN_B)).toBe(2);
    expect(positionOf(jobs, { taskId: "nope", instruction: "", files: [] })).toBeNull();
    // 已经做完的那件不算在"排第几"里。
    const withDone = [job({ id: "q0", state: "done" }), ...jobs];
    expect(positionOf(withDone, RUN_A)).toBe(1);
  });

  test("结构检查：缺 id 或缺任务的不算一条", () => {
    expect(isJob(job())).toBe(true);
    expect(isJob({ ...job(), state: "whatever" })).toBe(false);
    expect(isJob({ ...job(), id: "" })).toBe(false);
    expect(isJob(null)).toBe(false);
    expect(isJob({ id: "q1", taskId: "a", state: "waiting" })).toBe(true);
  });
});

describe("中文说法", () => {
  test("手里这件在等确认：几件、等什么、下一件是什么", () => {
    const jobs = [
      job({ id: "q1", state: "running", taskTitle: "把几张表合成一张" }),
      job({ id: "q2", taskTitle: "把重复的人名挑出来" }),
      job({ id: "q3", taskTitle: "整理文件夹" }),
    ];
    expect(describeQueue(queueSummary(jobs), "confirm")).toBe(
      "还有 3 件：正在等你确认「把几张表合成一张」，下一件是「把重复的人名挑出来」。",
    );
    // 已经动手了就说"正在做"。
    expect(describeQueue(queueSummary(jobs), "doing")).toBe(
      "还有 3 件：正在做「把几张表合成一张」，下一件是「把重复的人名挑出来」。",
    );
    // 没给状态时按更保守的那一种说：还没开始，绝不写成"正在做"。
    expect(describeQueue(queueSummary(jobs))).toContain("正在等你确认");
  });

  test("手上这件就是最后一件、以及还没开始做的时候", () => {
    const only = [job({ id: "q1", state: "running", taskTitle: "把几张表合成一张" })];
    expect(describeQueue(queueSummary(only), "confirm")).toBe("还有 1 件：正在等你确认「把几张表合成一张」。");

    // 还没轮到头一件：手上没有活，说"第一件是……"。
    const idle = [job({ id: "q1", taskTitle: "查重" }), job({ id: "q2", taskTitle: "整理文件夹" })];
    expect(describeQueue(queueSummary(idle))).toBe("还有 2 件：第一件是「查重」。");
  });

  test("空队列和全做完的队列", () => {
    expect(describeQueue(queueSummary([]))).toBe("还没有排别的事。");
    const done = [job({ id: "q1", state: "done" }), job({ id: "q2", state: "failed" })];
    expect(describeQueue(queueSummary(done))).toBe("排好的 2 件事都做完了。");
  });

  test("排好的第一件就是手里这件时，下一件跟着它一起念出来", () => {
    const jobs = [job({ id: "q1", state: "running", taskTitle: "合表" }), job({ id: "q2", taskTitle: "查重" })];
    const line = describeQueue(queueSummary(jobs), "doing");
    expect(line.indexOf("正在做")).toBeLessThan(line.indexOf("下一件"));
    expect(line.endsWith("。")).toBe(true);
  });
});
