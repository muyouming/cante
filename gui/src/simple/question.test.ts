// r25 — 结构化提问纯逻辑的单测。
//
// 这些断言钉的是协议里写明的语义（crates/protocol-shape/src/msg.rs），不是我们自己
// 发明的行为：第一个选项是它的建议、绝不替她选、自由文本是"其他"、没选也没写 =
// 没回答。真机上没有可用的守护进程来演这一段（见本轮报告），所以这一层必须自己把
// 话说到位。
import { describe, expect, test } from "bun:test";

import type { QuestionSpec } from "../protocol.ts";
import { FOLLOW_RECOMMENDATION_NOTE } from "./copy-question.ts";
import {
  DISMISSED_REPLY,
  answerOf,
  answeredReply,
  discussReply,
  draftsFor,
  emptyDraft,
  followRecommendationReply,
  hasAnyAnswer,
  isRecommended,
  readPendingQuestion,
  readQuestionSpecs,
  recommendedOption,
  toggleOption,
  withNote,
} from "./question.ts";

const SPEC: QuestionSpec = {
  header: "金额那一列",
  question: "表里的「金额（元）」就是你说的金额吗？",
  multi_select: false,
  options: [
    { label: "就是它", description: "直接填进金额那一列" },
    { label: "不是它", description: "我会再告诉你哪一列才是" },
  ],
};

describe("readPendingQuestion：从暂停里读出题目", () => {
  test("完整的一条 TurnPause 载荷能读出 turn_id / tool_use_id / 题目", () => {
    const pending = readPendingQuestion({
      turn_id: "turn_1",
      reason: {
        Question: {
          tool_use_id: "toolu_1",
          questions: [
            {
              header: "金额那一列",
              question: "表里的「金额（元）」就是你说的金额吗？",
              multi_select: true,
              options: [{ label: "就是它", description: "直接填" }],
            },
          ],
        },
      },
    });
    expect(pending).not.toBeNull();
    expect(pending!.turn_id).toBe("turn_1");
    expect(pending!.tool_use_id).toBe("toolu_1");
    expect(pending!.questions).toHaveLength(1);
    expect(pending!.questions[0]!.multi_select).toBe(true);
  });

  test("缺 turn_id（回不上去）→ null", () => {
    expect(
      readPendingQuestion({
        reason: { Question: { tool_use_id: "toolu_1", questions: [{ question: "问吗", options: [] }] } },
      }),
    ).toBeNull();
  });

  test("缺 tool_use_id（协议要求原样带回）→ null", () => {
    expect(
      readPendingQuestion({
        turn_id: "turn_1",
        reason: { Question: { questions: [{ question: "问吗", options: [] }] } },
      }),
    ).toBeNull();
  });

  test("一道题都没有 → null（不弹空框）", () => {
    expect(
      readPendingQuestion({
        turn_id: "turn_1",
        reason: { Question: { tool_use_id: "toolu_1", questions: [] } },
      }),
    ).toBeNull();
    // 审批的暂停不能被当成提问。
    expect(
      readPendingQuestion({ turn_id: "turn_1", reason: { Approval: { tools: [], message: "?" } } }),
    ).toBeNull();
  });

  test("multi_select 缺省是 false；没 label 的选项丢掉；没有 description 也留着", () => {
    const specs = readQuestionSpecs([
      {
        header: "范围",
        question: "要做多宽？",
        options: [{ label: "只做这一张" }, { description: "没名字的" }, { label: "  " }],
      },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.multi_select).toBe(false);
    expect(specs[0]!.options.map((option) => option.label)).toEqual(["只做这一张"]);
    expect(specs[0]!.options[0]!.description).toBe("");
  });

  test("选项为空但题面在：题目照样留下（自由文本永远能答）", () => {
    const specs = readQuestionSpecs([{ header: "随便说", question: "", options: [] }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.question).toBe("随便说");
  });
});

describe("它的建议：协议说第一个选项就是", () => {
  test("只有第一项算建议，而且只是标注", () => {
    expect(isRecommended(0)).toBe(true);
    expect(isRecommended(1)).toBe(false);
    expect(recommendedOption(SPEC)?.label).toBe("就是它");
  });

  test("一道题一个选项都没有时没有建议", () => {
    expect(recommendedOption({ header: "", question: "?", options: [] })).toBeNull();
  });
});

describe("勾选：多选能多选，单选换一个", () => {
  test("单选：点另一个就换过去，再点同一个可以取消", () => {
    const first = toggleOption(emptyDraft(), "就是它", false);
    expect(first.selected).toEqual(["就是它"]);
    const second = toggleOption(first, "不是它", false);
    expect(second.selected).toEqual(["不是它"]);
    const cleared = toggleOption(second, "不是它", false);
    expect(cleared.selected).toEqual([]);
  });

  test("多选：点一下加上，再点一下去掉", () => {
    const one = toggleOption(emptyDraft(), "A", true);
    const two = toggleOption(one, "B", true);
    expect(two.selected).toEqual(["A", "B"]);
    const back = toggleOption(two, "A", true);
    expect(back.selected).toEqual(["B"]);
  });

  test("自由文字只是记下来，不影响选项", () => {
    const draft = withNote(toggleOption(emptyDraft(), "就是它", false), "其实是第二列");
    expect(draft.selected).toEqual(["就是它"]);
    expect(draft.note).toBe("其实是第二列");
  });
});

describe("没选也没写 = 没回答", () => {
  test("空的草稿是未回答", () => {
    expect(answerOf(emptyDraft())).toBeNull();
    expect(answerOf(undefined)).toBeNull();
    expect(answerOf({ selected: [], note: "   " })).toBeNull();
  });

  test("只选了：selected 就是答案，不带 note", () => {
    expect(answerOf({ selected: ["就是它"], note: "" })).toEqual({ selected: ["就是它"] });
  });

  test("只写了：那些字就是答案本身（selected 为空）", () => {
    expect(answerOf({ selected: [], note: " 其实是第二列 " })).toEqual({
      selected: [],
      note: "其实是第二列",
    });
  });

  test("又选又写：note 是挂在选择上的补充说明", () => {
    expect(answerOf({ selected: ["就是它"], note: "但请顺便核对一下" })).toEqual({
      selected: ["就是它"],
      note: "但请顺便核对一下",
    });
  });

  test("hasAnyAnswer：只要有答过一道题就算能发", () => {
    expect(hasAnyAnswer([emptyDraft(), emptyDraft()])).toBe(false);
    expect(hasAnyAnswer([emptyDraft(), { selected: [], note: "答一句" }])).toBe(true);
  });
});

describe("翻成协议里的 reply", () => {
  test("Answered：每题一条，按题目顺序；没回答的那条是空的", () => {
    const questions = [SPEC, { header: "第二件", question: "还有呢？", options: [] }];
    const drafts = draftsFor(questions);
    expect(drafts).toHaveLength(2);
    drafts[0] = toggleOption(drafts[0]!, "不是它", false);
    const reply = answeredReply(questions, drafts);
    expect(reply).toEqual({
      Answered: [{ selected: ["不是它"] }, { selected: [] }],
    });
  });

  test("「你看着办」= 明确表态按建议来：selected 是每题的推荐 + 一句 note", () => {
    const reply = followRecommendationReply([SPEC, { header: "第二件", question: "还有呢？", options: [] }]);
    expect(reply).toEqual({
      Answered: [
        { selected: ["就是它"], note: FOLLOW_RECOMMENDATION_NOTE },
        { selected: [] },
      ],
    });
    // 协议里没有"替她选"，所以绝不能悄悄把推荐塞成已选状态：note 必须写明这是她的表态。
    expect(FOLLOW_RECOMMENDATION_NOTE.length).toBeGreaterThan(0);
  });

  test("Discuss：带字就是那句字，没字就是空对象（message 不上线成 null）", () => {
    expect(discussReply("我想先说两句")).toEqual({ Discuss: { message: "我想先说两句" } });
    expect(discussReply("   ")).toEqual({ Discuss: {} });
  });

  test("Dismissed 就是那个裸字符串", () => {
    expect(DISMISSED_REPLY).toBe("Dismissed");
  });
});
