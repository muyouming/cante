// r5 — 首页那句「上次有件事没做完」的判据。
//
// 这里钉住三件事，每一件都能单独改坏并让测试变红：
//   1. 出现条件：**只有**最近一轮停在「没做完」时才出现（做完了/正在做都不出现）；
//   2. 消失条件：她放过的那一轮不再提，换了一轮才再说；
//   3. 不自动继续：首页那一段接线里没有 startRun / confirmRun / enqueue 之类的调用，
//      两个按钮都只做「打开历史」或「记下放过这一轮」。
//
// 用真实事实（runs() 里最新的一轮 + 她放过的那一轮 id），不新造状态机。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RESUME_DISMISSED_KEY,
  isUnfinished,
  readDismissedRunId,
  rememberDismissedRunId,
  shouldOfferResume,
  unfinishedRun,
  type ResumeStore,
} from "./resume.ts";
import type { TaskRun } from "./run.ts";

function run(id: string, state: TaskRun["state"]): TaskRun {
  return {
    id,
    taskId: "excel.merge",
    taskTitle: "把两张表合成一张",
    files: [],
    instruction: "",
    state,
    plan: [],
    impact: { created: 0, modified: 0, deleted: 0, messages: 0 },
    result: null,
    online: false,
    error: null,
    createdAt: 0,
  };
}

/** 一个只活在内存里的存储，用来核对读写的那条事实。 */
function memoryStore(): ResumeStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
}

describe("「没做完」是哪两种状态", () => {
  test("没做完 = 做失败了或她中途停了；做完/正在做/还没开始都不算", () => {
    expect(isUnfinished("failed")).toBe(true);
    expect(isUnfinished("cancelled")).toBe(true);
    expect(isUnfinished("done")).toBe(false);
    expect(isUnfinished("running")).toBe(false);
    expect(isUnfinished("preview")).toBe(false);
    expect(isUnfinished("draft")).toBe(false);
  });
});

describe("只有最近一轮没做完，才该提这一句", () => {
  test("最近一轮没做完：返回那一轮（做失败和她中途停的都算）", () => {
    expect(unfinishedRun([run("a", "failed")])?.id).toBe("a");
    expect(unfinishedRun([run("a", "cancelled")])?.id).toBe("a");
  });

  test("最近一轮做完了：不提（哪怕更早的一轮没做完）", () => {
    // 这正是「别有常驻横幅」：最近一件已经做完，那句提示就该消失。
    expect(unfinishedRun([run("new", "done"), run("old", "failed")])).toBeNull();
    expect(shouldOfferResume([run("new", "done"), run("old", "failed")], null)).toBe(false);
  });

  test("一次都没做过：不提", () => {
    expect(unfinishedRun([])).toBeNull();
    expect(shouldOfferResume([], null)).toBe(false);
  });

  test("最近一轮没做完、她还没放过：提", () => {
    expect(shouldOfferResume([run("a", "failed")], null)).toBe(true);
  });

  test("那一轮她已经放过：同一轮不再提", () => {
    expect(shouldOfferResume([run("a", "failed")], "a")).toBe(false);
  });

  test("换了一轮没做完（id 不同）：再说一次", () => {
    expect(shouldOfferResume([run("b", "failed"), run("a", "failed")], "a")).toBe(true);
  });
});

describe("「这一轮她看过了」只记一条事实", () => {
  test("没记过 → null；记下之后读回来是她放过的那一轮", () => {
    const store = memoryStore();
    expect(readDismissedRunId(store)).toBeNull();
    rememberDismissedRunId("run_x", store);
    expect(readDismissedRunId(store)).toBe("run_x");
    expect(store.dump()[RESUME_DISMISSED_KEY]).toBe("run_x");
  });

  test("空 id 或没存储都不写、不报错", () => {
    const store = memoryStore();
    rememberDismissedRunId("", store);
    expect(readDismissedRunId(store)).toBeNull();
    expect(() => rememberDismissedRunId("run_x", null)).not.toThrow();
    expect(readDismissedRunId(null)).toBeNull();
  });

  test("存储里是空白/空串时，当作没记过", () => {
    const store = memoryStore();
    store.setItem(RESUME_DISMISSED_KEY, "   ");
    expect(readDismissedRunId(store)).toBeNull();
  });
});

describe("这条提示不自动继续", () => {
  const HOME = readFileSync(join(import.meta.dir, "Home.tsx"), "utf8");

  test("首页那段提示的开关就是 shouldOfferResume（不是另写一个条件）", () => {
    // 只单测 shouldOfferResume 不够：生产路径要是换了判据，单测照样绿（AGENTS §3.1 的坑）。
    expect(HOME).toContain("shouldOfferResume(props.store.runs(), dismissedRunId())");
    expect(HOME).toContain("<Show when={offerResume()}>");
  });

  test("首页接线里没有开始/确认/排队这些动作", () => {
    for (const call of ["startRun(", "confirmRun(", "dryRun(", "enqueue(", "sendRunInstruction("]) {
      expect({ call, present: HOME.includes(call) }).toEqual({ call, present: false });
    }
  });

  test("两个按钮只做两件事：打开「我做过的事」，或记下放过这一轮", () => {
    expect(HOME).toContain("onClick={openResumeHistory}");
    expect(HOME).toContain("onClick={dismissResume}");
    expect(HOME).toContain("rememberDismissedRunId");
    expect(HOME).toContain("<History store={store()} />");
  });
});
