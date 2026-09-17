// 结构化提问的纯逻辑（r25）。
//
// 上游把「拿不准先问一句」做成了协议的一部分：助手通过一次工具调用停下来，
// 协议发来 `TurnPause{reason:Question}`，带着若干道题和每道题的选项；客户端用
// `Op::QuestionResponse` 回答。这个模块只做**不需要 Solid、不需要 DOM** 的那一半：
// 把协议载荷读成能渲染的题目、把她在界面上的勾选翻成 `QuestionResponse` 的
// `reply`，并把「没选也没写 = 没回答」这条规矩钉住（msg.rs 的注释）。
//
// 三条来自协议、不是我们发明的语义：
//   * 每道题的**第一个选项是它的建议**，但**绝不替她选**；
//   * 一道题可以多选（`multi_select`）；
//   * 自由文本（"其他"）由客户端自己加，协议里永远没有这一项。
import {
  type PendingQuestion,
  type QuestionAnswer,
  type QuestionOption,
  type QuestionReply,
  type QuestionSpec,
} from "../protocol.ts";
import { FOLLOW_RECOMMENDATION_NOTE } from "./copy-question.ts";

/** 界面上一道题此刻的样子（还没发出去）。 */
export interface QuestionDraft {
  /** 选中的选项 label，按她点的先后。 */
  selected: string[];
  /** 自由写的那些字（"其他"输入框）；空串 = 没写。 */
  note: string;
}

/** 没回答过的一道题：什么都没选、什么都没写。 */
export function emptyDraft(): QuestionDraft {
  return { selected: [], note: "" };
}

/** 每道题的初始草稿。 */
export function draftsFor(questions: QuestionSpec[]): QuestionDraft[] {
  return questions.map(() => emptyDraft());
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

/** 把协议里的一份选项表读成能渲染的样子；没 label 的丢掉。 */
function readOptions(value: unknown): QuestionOption[] {
  const out: QuestionOption[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const label = str(record.label).trim();
    if (!label) continue;
    const preview = str(record.preview);
    out.push({
      label,
      description: str(record.description),
      ...(preview ? { preview } : {}),
    });
  }
  return out;
}

/**
 * 把协议里的一份题目表读成能渲染的样子。
 *
 * 一道题只要还有题面、还能用自由文本回答，就值得留下——选项为空不是丢掉它的
 * 理由（协议明确说"其他"是客户端加的）。题面和 header 都空的条目才丢。
 */
export function readQuestionSpecs(value: unknown): QuestionSpec[] {
  const out: QuestionSpec[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const header = str(record.header).trim();
    const question = str(record.question).trim();
    if (!header && !question) continue;
    out.push({
      header,
      question: question || header,
      multi_select: bool(record.multi_select),
      options: readOptions(record.options),
    });
  }
  return out;
}

/**
 * 从一条 `TurnPause` 载荷里读出待回答的提问。
 *
 * 读不出可回答的东西就返回 null（不弹一个空的提问框）：缺 `turn_id`（回复没法
 * 对上号）、缺 `tool_use_id`（协议要求原样带回）、或者一道题都没有。
 */
export function readPendingQuestion(payload: unknown): PendingQuestion | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const turnId = str(record.turn_id);
  if (!turnId) return null;
  const reason = record.reason;
  if (!reason || typeof reason !== "object") return null;
  const ask = (reason as Record<string, unknown>).Question;
  if (!ask || typeof ask !== "object") return null;
  const askRecord = ask as Record<string, unknown>;
  const toolUseId = str(askRecord.tool_use_id);
  if (!toolUseId) return null;
  const questions = readQuestionSpecs(askRecord.questions);
  if (questions.length === 0) return null;
  return { turn_id: turnId, tool_use_id: toolUseId, questions };
}

/** 第 index 项是不是它的建议：协议规定第一个选项就是。 */
export function isRecommended(index: number): boolean {
  return index === 0;
}

/** 它的建议；一道题一个选项都没有时是 null。 */
export function recommendedOption(spec: QuestionSpec): QuestionOption | null {
  return spec.options[0] ?? null;
}

/** 点一下某个选项：多选来回切，单选换一个（再点一下可以取消，免得点错没救）。 */
export function toggleOption(draft: QuestionDraft, label: string, multiSelect: boolean): QuestionDraft {
  if (multiSelect) {
    const selected = draft.selected.includes(label)
      ? draft.selected.filter((item) => item !== label)
      : [...draft.selected, label];
    return { ...draft, selected };
  }
  const only = draft.selected.length === 1 && draft.selected[0] === label;
  return { ...draft, selected: only ? [] : [label] };
}

/** 记下她自由写的那些字。 */
export function withNote(draft: QuestionDraft, note: string): QuestionDraft {
  return { ...draft, note };
}

/**
 * 一道题的答案。**什么都没选也没写 = 没回答**（返回 null）——协议原话是
 * "An entry with nothing selected and no note leaves that question unanswered"。
 * 只写了字没选项时，那些字就是答案本身。
 */
export function answerOf(draft: QuestionDraft | undefined): QuestionAnswer | null {
  if (!draft) return null;
  const selected = draft.selected.filter((label) => label.trim().length > 0);
  const note = draft.note.trim();
  if (selected.length === 0 && !note) return null;
  return { selected, ...(note ? { note } : {}) };
}

/** 至少有一道题真的回答了；用来决定主按钮能不能按。 */
export function hasAnyAnswer(drafts: QuestionDraft[]): boolean {
  return drafts.some((draft) => answerOf(draft) !== null);
}

/**
 * 把界面上的草稿翻成 `QuestionResponse` 的 `Answered`：**每题一条，按题目顺序**，
 * 没回答的那条就是"空"（既没选也没写）。
 */
export function answeredReply(questions: QuestionSpec[], drafts: QuestionDraft[]): QuestionReply {
  return {
    Answered: questions.map((_, index) => answerOf(drafts[index]) ?? { selected: [] }),
  };
}

/**
 * 「你看着办」的结构化写法。
 *
 * 协议里**没有**"替用户选"这个动作，所以不能替她选。这里做的是把每一题的
 * 建议（第一个选项）**当作她明确表态**发出去：`selected` 就是那条建议，`note`
 * 写清这是她让按建议来的。没有选项的题就留空。
 */
export function followRecommendationReply(questions: QuestionSpec[]): QuestionReply {
  return {
    Answered: questions.map((spec) => {
      const recommendation = recommendedOption(spec);
      return recommendation
        ? { selected: [recommendation.label], note: FOLLOW_RECOMMENDATION_NOTE }
        : { selected: [] };
    }),
  };
}

/** 「先聊聊」：想先说两句再选。写了字就带上，没写就让助手问她想聊什么。 */
export function discussReply(text: string): QuestionReply {
  const message = text.trim();
  return { Discuss: message ? { message } : {} };
}

/** 「这件先不回答」。协议里的 `Dismissed`。 */
export const DISMISSED_REPLY: QuestionReply = "Dismissed";
