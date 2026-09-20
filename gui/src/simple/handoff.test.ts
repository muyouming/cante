// 「把这个文件发给别人」的纯逻辑测试。
//
// 这一块补的是结果侧的另一个出口：原来只有「复制成微信能贴的文字」（送的是**文字**），
// 现在还要告诉她**这个表格文件本身**怎么发。四条断言，全部来自任务里的硬要求：
//
//   1. 有结果文件 → 出引导，而且**不含完整路径**（只有文件名 + 位置的键）；
//   2. 没结果文件（试跑 / 失败 / 停下 / 空）→ **不出**，免得把半成品当成品交；
//   3. 文案里**绝不出现「已发送 / 发送成功 / 已发给」**——这是微信红线，用断言钉死；
//   4. 与「复制成文字」那条**不冲突**：两条能同时出现，且各自说清自己的用途。
//
// 判断与文案都是纯的，不需要浏览器；文案在 copy-handoff.ts（引导）与 copy-print.ts
// （位置），这个文件只负责核对它们和 handoff.ts 的判断对得上。

import { describe, expect, test } from "bun:test";

import { HANDOFF } from "./copy-handoff.ts";
import { LOCATION } from "./copy-print.ts";
import { SHARE } from "./copy-share.ts";
import { handoffFor } from "./handoff.ts";
import { isTablePath } from "./share.ts";
import { emptyImpact, type TaskRun } from "./run.ts";

function run(overrides: Partial<TaskRun> & Pick<TaskRun, "id" | "state">): TaskRun {
  return {
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张",
    files: [],
    instruction: "",
    plan: ["第一步"],
    impact: emptyImpact(),
    result: null,
    online: false,
    error: null,
    createdAt: 0,
    ...overrides,
  };
}

function withFiles(paths: string[], overrides: Partial<TaskRun> = {}): TaskRun {
  return run({
    id: "r1",
    state: "done",
    result: {
      files: paths.map((path) => ({ path, summary: "新增" })),
      summary: `新增 ${paths.length} 个文件`,
    },
    ...overrides,
  });
}

/** 把引导会给她看的每一句话都摊开（含按文件名/位置取出来的那几句）。 */
function allHandoffText(plan: ReturnType<typeof handoffFor>): string[] {
  if (!plan) return [];
  const texts: string[] = [HANDOFF.heading, HANDOFF.intro, HANDOFF.howOpen, HANDOFF.howDrag, HANDOFF.howWechat, HANDOFF.notSent];
  for (const file of plan.files) {
    texts.push(HANDOFF.what(file.name));
    texts.push(LOCATION[file.place]);
  }
  return texts;
}

describe("有结果文件：出引导，且只给名字不给人机器位置", () => {
  test("真做完、有结果文件 → 出引导，文件名与位置键都对上", () => {
    const plan = handoffFor(withFiles(["C:\\Users\\用户名\\桌面\\汇总表.xlsx"]));
    expect(plan).not.toBeNull();
    expect(plan!.files.map((file) => file.name)).toEqual(["汇总表.xlsx"]);
    // 位置是认出来的键（桌面），不是一串机器路径。
    expect(plan!.files[0]!.place).toBe("desktop");
    // 步骤说全了：让文件露出来 → 拖进微信（或微信的「发送文件」）。
    expect(plan!.steps).toEqual(["howOpen", "howDrag", "howWechat"]);
  });

  test("多个结果文件都列出来，顺序不变，各自带自己的位置", () => {
    const plan = handoffFor(
      withFiles([
        "C:\\Users\\用户名\\桌面\\汇总.xlsx",
        "D:\\资料\\明细.xlsx",
        "/home/user/Downloads/名单.csv",
      ]),
    );
    expect(plan!.files.map((file) => file.name)).toEqual(["汇总.xlsx", "明细.xlsx", "名单.csv"]);
    expect(plan!.files.map((file) => file.place)).toEqual(["desktop", "other", "downloads"]);
  });

  test("引导里没有任何完整路径：没有分隔符、没有盘符、没有家目录写法", () => {
    const plan = handoffFor(
      withFiles(["C:\\Users\\用户名\\桌面\\汇总表.xlsx", "/Users/用户名/Downloads/明细.csv"]),
    );
    // 文件名只有名字本身。
    for (const file of plan!.files) {
      expect(file.name).not.toContain("/");
      expect(file.name).not.toContain("\\");
      expect(/^[A-Za-z]:/.test(file.name)).toBe(false);
    }
    // 她真的会看到的每一句话都不带机器位置。
    for (const text of allHandoffText(plan)) {
      expect(text).not.toContain("/");
      expect(text).not.toContain("\\");
      expect(text).not.toContain("C:");
      expect(/^[A-Za-z]:[\\/]/.test(text)).toBe(false);
    }
  });

  test("位置句用的是已有的那几句（复用 copy-print 的 LOCATION），不是新造的", () => {
    const plan = handoffFor(withFiles(["C:\\Users\\用户名\\桌面\\汇总表.xlsx"]));
    expect(allHandoffText(plan)).toContain(LOCATION.desktop);
  });
});

describe("没结果文件：不出引导", () => {
  test("试跑（dryRun）不出——它本来就没产出", () => {
    const plan = handoffFor(
      withFiles(["C:\\Users\\用户名\\桌面\\汇总表.xlsx"], { dryRun: true }),
    );
    expect(plan).toBeNull();
  });

  test("失败不出——留下的是半成品，不该教她发出去", () => {
    expect(handoffFor(withFiles(["C:\\Users\\用户名\\桌面\\半成品.xlsx"], { state: "failed" }))).toBeNull();
  });

  test("停下（cancelled）不出", () => {
    expect(handoffFor(withFiles(["C:\\Users\\用户名\\桌面\\做了一半.xlsx"], { state: "cancelled" }))).toBeNull();
  });

  test("做完了但没有任何结果文件 → 空列表不出", () => {
    expect(handoffFor(run({ id: "r2", state: "done" }))).toBeNull();
    expect(handoffFor(withFiles([]))).toBeNull();
  });

  test("空路径不算一个结果文件", () => {
    expect(handoffFor(withFiles([""]))).toBeNull();
  });

  test("没有这次运行（null / undefined）也不出", () => {
    expect(handoffFor(null)).toBeNull();
    expect(handoffFor(undefined)).toBeNull();
  });
});

describe("微信红线：文案里绝不出现「已发送」这类话", () => {
  const FORBIDDEN = /已发送|发送成功|已发给|已经发送|已经发出去|发送完毕|发送完成/;

  test("引导的每一句都不含「已发送 / 发送成功 / 已发给」", () => {
    const plan = handoffFor(withFiles(["C:\\Users\\用户名\\桌面\\汇总表.xlsx"]));
    for (const text of allHandoffText(plan)) {
      expect(FORBIDDEN.test(text)).toBe(false);
    }
  });

  test("文案常量自己（不经过判断）也不含", () => {
    for (const text of Object.values(HANDOFF)) {
      const line = typeof text === "function" ? text("示例.xlsx") : text;
      expect(FORBIDDEN.test(line)).toBe(false);
    }
  });

  test("反过来，它必须说清「我不替你发送」——红线要主动说，不是不说", () => {
    expect(HANDOFF.notSent).toContain("不会替你发送");
    // 发不发由她定：这句话要在，不能只有「我不会发」而没有「你来定」。
    expect(HANDOFF.notSent).toContain("你自己");
  });
});

describe("和「复制成文字」那条不冲突：两条各说各的用途", () => {
  test("一个表格结果能同时满足两条：复制文字 && 引导发文件", () => {
    const path = "C:\\Users\\用户名\\桌面\\汇总表.xlsx";
    expect(isTablePath(path)).toBe(true);
    expect(handoffFor(withFiles([path]))).not.toBeNull();
  });

  test("两条各有各的用途：一条说「文字」，一条说「文件本身」", () => {
    // 复制那条：讲的是把内容变成能粘的文字。
    expect(SHARE.hint).toContain("文字");
    expect(SHARE.hint).toContain("粘贴");
    // 发文件那条：讲的是把文件本身拖过去，对方打开还是表格。
    expect(HANDOFF.howDrag).toContain("文件");
    expect(HANDOFF.intro).toContain("文件本身");
    // 两句话不该是同一句（各自说清自己的用途）。
    expect(SHARE.hint).not.toBe(HANDOFF.howDrag);
  });

  test("两条对「发送」的口径一致：都说不替她发送", () => {
    expect(SHARE.hint).toContain("不会替你发送");
    expect(HANDOFF.notSent).toContain("不会替你发送");
  });
});
