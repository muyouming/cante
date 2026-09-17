// 「教她第一句话怎么说」里能单测的那一半：三句例子的内容与覆盖、第一次做成之后
// 那句变体、向导点的那一句怎么交到首页。
//
// 全是纯函数，bun test 直接跑（这个仓库没有 jsdom，理由写在 typography.test.ts 的
// 开头）。组件里那些接线由 first-run-ui.test.ts 扫源码钉住，真的点一下会怎样用无头
// 浏览器核对过（见本轮报告）。
import { describe, expect, test } from "bun:test";

import {
  FIRST_RUN,
  FIRST_RUN_SENTENCE_KEY,
  FREE_TEXT_RUN_ID,
  SAY_EXAMPLES,
  beginFirstRun,
  exampleClick,
  exampleForSentence,
  firstWinHintFor,
  firstWinRun,
  nextTimeSuggestion,
  rememberSentence,
  spokenTitle,
  takeSentence,
  type FinishedRun,
  type SentenceStore,
} from "./copy-first-run.ts";
import { FREE_TEXT_TASK_ID, freeTask, taskById } from "./tasks/index.ts";

// ---------------------------------------------------------------------------
// 三句例子：覆盖三种难度，而且都是她说得出口的一句话
// ---------------------------------------------------------------------------

describe("三句例子", () => {
  test("三种难度都在：一句话就够的、要给条件的、她可能想不到的", () => {
    expect(SAY_EXAMPLES.length).toBe(3);
    const levels = SAY_EXAMPLES.map((item) => item.level);
    expect(new Set(levels).size).toBe(3);
    expect(levels.some((level) => level.includes("一句话"))).toBe(true);
    expect(levels.some((level) => level.includes("条件"))).toBe(true);
    expect(levels.some((level) => level.includes("没想"))).toBe(true);
  });

  test("是一句话，不是一段功能说明", () => {
    for (const item of SAY_EXAMPLES) {
      expect(item.level.trim().length).toBeGreaterThan(3);
      expect(item.sentence.length).toBeGreaterThan(8);
      // 上限是「一句话」这个承诺：写长了就变成一段需求，她照说不出口。
      expect(item.sentence.length).toBeLessThanOrEqual(30);
      expect(item.level.length).toBeLessThanOrEqual(10);
    }
  });

  test("每句都有一版「同一件事 + 一个条件」（第一次做成之后给她看的就是它）", () => {
    for (const item of SAY_EXAMPLES) {
      expect(item.finer.startsWith(item.sentence)).toBe(true);
      expect(item.finer.length).toBeGreaterThan(item.sentence.length);
    }
    expect(new Set(SAY_EXAMPLES.map((item) => item.finer)).size).toBe(SAY_EXAMPLES.length);
  });

  test("例子说的是目录里真有的那件事（卡片改名了这里就红）", () => {
    for (const item of SAY_EXAMPLES) {
      expect(taskById(item.taskId)).toBeDefined();
      expect(item.taskId).not.toBe(FREE_TEXT_TASK_ID);
    }
  });

  test("直接说一句话那条路的身份没漂（这里抄了一份，所以要盯着）", () => {
    expect(FREE_TEXT_RUN_ID).toBe(FREE_TEXT_TASK_ID);
  });
});

// ---------------------------------------------------------------------------
// 照着例子原样说的一句：走卡片那条路
//
// F2：第三句例子（微信接龙）是要「贴进去的文字」，而「直接说一句话」那条路得到的
// 是 freeTask（needs: "files"），她会卡在「先选一个」那一步。照原文提交时得进卡片。
// ---------------------------------------------------------------------------

describe("照着例子原样提交", () => {
  test("每一句例子都认得出来，两头的空格不算改字", () => {
    for (const item of SAY_EXAMPLES) {
      expect(exampleForSentence(item.sentence)?.taskId).toBe(item.taskId);
      expect(exampleForSentence(`  ${item.sentence}  `)?.taskId).toBe(item.taskId);
    }
  });

  test("改过字就不是例子了：还是按她自己想的说", () => {
    expect(exampleForSentence(`${SAY_EXAMPLES[2]!.sentence}，谢谢`)).toBeNull();
    expect(exampleForSentence("帮我整理一下")).toBeNull();
    expect(exampleForSentence("   ")).toBeNull();
  });

  test("微信接龙那句提交后进的是卡片，不会落到选文件页", () => {
    const example = exampleForSentence(SAY_EXAMPLES[2]!.sentence);
    expect(example).not.toBeNull();
    const task = taskById(example!.taskId);
    expect(task).toBeDefined();
    // 对照：自由说那条路拿到的是 freeTask，它要文件——第三句例子卡住就是因为这个。
    expect(freeTask("随便一句").needs).toBe("files");
    // 卡片要的是「贴进去的文字」，所以不再卡在「先选一个」。
    expect(task!.needs).toBe("text");
    expect(task!.group).toBe("微信");
  });
});

// ---------------------------------------------------------------------------
// F4（#139）：点例子不能把她已经打好的字静默清掉
// ---------------------------------------------------------------------------

describe("点例子时，框里已经有的字怎么办", () => {
  const sentence = SAY_EXAMPLES[0]!.sentence;

  test("输入框为空时点例子：直接填进去（最常见的那条路，保持顺手）", () => {
    expect(exampleClick("", sentence)).toEqual({ kind: "fill", text: sentence });
    expect(exampleClick("   ", sentence)).toEqual({ kind: "fill", text: sentence });
  });

  test("框里正好就是这一句：也算直接填，不用再问一遍", () => {
    expect(exampleClick(sentence, sentence)).toEqual({ kind: "fill", text: sentence });
    expect(exampleClick(`  ${sentence}  `, sentence)).toEqual({ kind: "fill", text: sentence });
  });

  test("输入框非空时点例子：不会丢掉她已经打好的字（只挂一句，等她点头）", () => {
    const half = "帮我把上个月的表格";
    // 她打了半句就点例子：决定必须不是 fill —— 界面不会拿例子盖掉她那半句
    expect(exampleClick(half, sentence)).toEqual({ kind: "confirm", text: sentence });
    // 而且 confirm 里带的是那条例子，不是她那半句被改过的样子
    expect(exampleClick(half, sentence).text).toBe(sentence);
  });
});

// ---------------------------------------------------------------------------
// 第一次做成之后的提示：按哪条路说
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 向导最后一步的三件事
// ---------------------------------------------------------------------------

describe("向导最后一步的三条承诺", () => {
  test("正好三条，每条都是对她说的完整一句", () => {
    expect(FIRST_RUN.promises).toHaveLength(3);
    for (const promise of FIRST_RUN.promises) {
      expect(promise.lead.trim().endsWith("：")).toBe(true);
      expect(promise.body.trim().length).toBeGreaterThan(12);
      expect(promise.body.trim().endsWith("。")).toBe(true);
    }
  });

  test("三条分别是：两条路都行 / 动手前先问你 / 原来的东西不乱动", () => {
    const text = FIRST_RUN.promises.map((promise) => promise.lead + promise.body).join("");
    // ① 点卡片和说一句话，两条路都要说
    expect(text).toContain("卡片");
    expect(text).toContain("一句话");
    // ② 「动手前会先让你确认」是承诺，第一次就该知道
    expect(text).toContain("点头");
    // ③ 原来那些文件不会被乱动
    expect(text).toContain("原来的文件");
    expect(text).toContain("另存");
  });
});

// ---------------------------------------------------------------------------
// 第一次做成之后那一句
// ---------------------------------------------------------------------------

function makeRun(over: Partial<FinishedRun> = {}): FinishedRun {
  return {
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张（自动去掉重复行）",
    instruction: "",
    state: "done",
    ...over,
  };
}

describe("第一次做成之后那一句", () => {
  test("正好是例子里的那件事：给她「再多说一个条件」的那一版", () => {
    expect(nextTimeSuggestion(makeRun())).toBe(SAY_EXAMPLES[1]!.finer);
    expect(nextTimeSuggestion(makeRun({ taskId: "files.by-date" }))).toBe(SAY_EXAMPLES[0]!.finer);
  });

  test("她自己说的一句话：用她的原话加上一个条件，不换成卡名", () => {
    const said = nextTimeSuggestion(
      makeRun({ taskId: FREE_TEXT_TASK_ID, instruction: "  把这两张表弄成一张。 " }),
    );
    expect(said?.startsWith("把这两张表弄成一张，")).toBe(true);
    expect(said).not.toContain("直接说一件事");
    expect(said?.endsWith("。")).toBe(false);
  });

  test("别的卡片：卡名去掉括号里那一段，再加一个条件", () => {
    const said = nextTimeSuggestion(
      makeRun({ taskId: "files.by-type", taskTitle: "按文件类型分到不同文件夹（原来的留着）" }),
    );
    expect(said?.startsWith("按文件类型分到不同文件夹，")).toBe(true);
    expect(said).not.toContain("（");
  });

  test("说不出就不说：空话、太长的话一律 null（首页那一行干脆不出现）", () => {
    expect(nextTimeSuggestion(makeRun({ taskId: FREE_TEXT_TASK_ID, instruction: "   " }))).toBeNull();
    expect(
      nextTimeSuggestion(makeRun({ taskId: FREE_TEXT_TASK_ID, instruction: "把".repeat(200) })),
    ).toBeNull();
    expect(nextTimeSuggestion(makeRun({ taskId: "x", taskTitle: "（只有括号）" }))).toBeNull();
  });
});

describe("第一次做成之后的提示，按哪条路说", () => {
  test("她自己说的一句话：可以说「刚才那句话」", () => {
    expect(firstWinHintFor(makeRun({ taskId: FREE_TEXT_TASK_ID }))).toContain("刚才那句话");
  });

  test("点卡片做成的：没有「刚才那句话」，就不能那样说", () => {
    const hint = firstWinHintFor(makeRun({ taskId: "excel.merge" }));
    expect(hint).not.toContain("刚才那句话");
    expect(hint.length).toBeGreaterThan(12);
    expect(hint.endsWith("。")).toBe(true);
  });

  test("两种说法不一样，而且都答应得做到", () => {
    const free = firstWinHintFor(makeRun({ taskId: FREE_TEXT_TASK_ID }));
    const card = firstWinHintFor(makeRun({ taskId: "excel.merge" }));
    expect(free).not.toBe(card);
    for (const hint of [free, card]) expect(hint).toContain("填进下面的框里");
  });
});

test("卡名里括号那一段是给眼睛看的，不是给人说的", () => {
  expect(spokenTitle("把几张表合成一张（自动去掉重复行）")).toBe("把几张表合成一张");
  expect(spokenTitle("按类别汇总并配上图表（月报）")).toBe("按类别汇总并配上图表");
  expect(spokenTitle("  按规则改成新名字  ")).toBe("按规则改成新名字");
  expect(spokenTitle("")).toBe("");
});

describe("什么时候才出现", () => {
  const done = (id: string): FinishedRun => makeRun({ taskTitle: id });
  const failed = (id: string): FinishedRun => makeRun({ taskTitle: id, state: "failed" });

  test("只成功过这一件：就是它", () => {
    expect(firstWinRun([done("a")])?.taskTitle).toBe("a");
  });

  test("最新一件没成：不出现（她还在收拾这一件）", () => {
    expect(firstWinRun([failed("b"), done("a")])).toBeNull();
  });

  test("已经成功过两件：不再唠叨", () => {
    expect(firstWinRun([done("b"), done("a")])).toBeNull();
  });

  test("一件都没有 / 还没做完：不出现", () => {
    expect(firstWinRun([])).toBeNull();
    expect(firstWinRun([makeRun({ state: "running" })])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 向导点的那一句，交到首页的框里
// ---------------------------------------------------------------------------

function fakeStore(initial: Record<string, string> = {}): SentenceStore & {
  items: Record<string, string>;
} {
  const items = { ...initial };
  return {
    items,
    getItem: (key) => (key in items ? items[key]! : null),
    setItem: (key, value) => {
      items[key] = value;
    },
    removeItem: (key) => {
      delete items[key];
    },
  };
}

describe("向导点的那一句，交到首页", () => {
  test("记住 → 取走 → 再取就没有了（只填一次）", () => {
    const store = fakeStore();
    rememberSentence("  把这个文件夹里的文件按月份分好  ", store);
    expect(store.items[FIRST_RUN_SENTENCE_KEY]).toContain("把这个文件夹里的文件按月份分好");
    expect(takeSentence(store)).toBe("把这个文件夹里的文件按月份分好");
    expect(takeSentence(store)).toBeNull();
  });

  // F5（#139）— 她在向导最后一步点了例子、没点「开始使用」就退出了。那一次记下
  // 的那句话她并没有要；下一次打开，即使她什么都没点，首页的框也必须是空的。
  test("上一轮暂存了句子、这一轮没选任何东西：首页取不到，框是空的", () => {
    const store = fakeStore();
    // 上一次打开写下的（趟号是上一次的）
    rememberSentence(SAY_EXAMPLES[0]!.sentence, store, "上一趟");
    // 这一次打开，向导一开始先清一次
    beginFirstRun(store);
    // 首页来取：没有 → 框就空着
    expect(takeSentence(store)).toBeNull();
    expect(store.items[FIRST_RUN_SENTENCE_KEY]).toBeUndefined();
  });

  test("就算向导这一趟根本没出现（上一次已经做完），上一趟那句也不算数", () => {
    const store = fakeStore();
    rememberSentence(SAY_EXAMPLES[1]!.sentence, store, "上一趟");
    // 没有向导来清，首页直接来取
    expect(takeSentence(store)).toBeNull();
    // 取的时候顺手清掉，别一直躺在那里
    expect(store.items[FIRST_RUN_SENTENCE_KEY]).toBeUndefined();
  });

  test("旧版本留下的裸字符串（没有趟号）同样不认", () => {
    const store = fakeStore({ [FIRST_RUN_SENTENCE_KEY]: "上一趟留下的那句话" });
    expect(takeSentence(store)).toBeNull();
  });

  test("没记过 / 空句子：返回 null，不报错", () => {
    const store = fakeStore();
    expect(takeSentence(store)).toBeNull();
    rememberSentence("   ", store);
    expect(takeSentence(store)).toBeNull();
  });

  test("存储不可用（浏览器预览里被关掉）：当没暂存，不抛错", () => {
    expect(() => rememberSentence("随便一句", null)).not.toThrow();
    expect(takeSentence(null)).toBeNull();
  });

  test("存储自己抛错（写满 / 被禁）：也不能把向导卡住", () => {
    const broken: SentenceStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => rememberSentence("一句话", broken)).not.toThrow();
    expect(takeSentence(broken)).toBeNull();
  });
});
