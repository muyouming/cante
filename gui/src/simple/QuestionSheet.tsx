// r25 — 结构化提问的界面：把协议里的题目渲染成中文大按钮。
//
// 为什么值得单独一屏：我们的任务提示词让助手"拿不准就先问一句"，真机上它确实
// 会停下来问。以前协议不支持"回答那个暂停"，我们只能把她打的那句话当成一轮新
// 提示词发出去——能跑，但不是一等公民（丢了暂停语义，也没法"跳过"或"先聊聊"）。
// 上游把它做成了协议的一部分，而她**点一下按钮**远比打一句话省事。
//
// 语义全部照协议（crates/protocol-shape/src/msg.rs），一条都没有自己发明：
//   * 每道题的**第一个选项是它的建议**——界面上如实标出「它的建议」，但**绝不
//     替她选**：没有任何选项是预先选中的，按钮必须她自己点；
//   * `multi_select` 为真时能多选；
//   * 自由文本（"都不是？你自己说"）是协议明确留给客户端加的，不是协议字段；
//   * 「先聊聊」发 `Discuss`，「先不回答」发 `Dismissed`——跳过是正当出路；
//   * 这个暂停可以和别的工具并行（`ToolStart`/`ToolEnd` 可能同时到），所以这屏
//     只叠在运行页上，不依赖回合结束。
import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import { QUESTION } from "./copy-question.ts";
import { useFocusLayer } from "./FocusLayer.tsx";
import {
  DISMISSED_REPLY,
  answeredReply,
  discussReply,
  draftsFor,
  followRecommendationReply,
  hasAnyAnswer,
  isRecommended,
  toggleOption,
  withNote,
  type QuestionDraft,
} from "./question.ts";

export interface QuestionSheetProps {
  store: Store;
}

const primary = "min-h-[52px] rounded-xl bg-sky-500 px-6 text-[17px] font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400";
const secondary = "min-h-[52px] rounded-xl border border-sky-700 px-6 text-[17px] font-semibold text-sky-100 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-50";

export default function QuestionSheet(props: QuestionSheetProps): JSX.Element {
  const [drafts, setDrafts] = createSignal<QuestionDraft[]>([]);

  // 新的提问一到就换一份干净的草稿：上一次的勾选绝不能跟到这一次上。
  createEffect(() => {
    setDrafts(draftsFor(props.store.question()?.questions ?? []));
  });

  // 这屏能关掉：Esc = 「先不回答」，和屏幕上的那个按钮是同一个动作。给 Esc 一个
  // 明确去向，而不是让它按下去什么都不发生（那才是"漏了键盘"）。
  const layer = useFocusLayer({
    open: () => props.store.question() !== null,
    onEscape: () => skip(),
  });

  const questions = () => props.store.question()?.questions ?? [];
  const draftAt = (index: number): QuestionDraft => drafts()[index] ?? { selected: [], note: "" };
  const isSelected = (index: number, label: string): boolean =>
    draftAt(index).selected.includes(label);

  function patch(index: number, next: QuestionDraft): void {
    setDrafts((previous) => previous.map((draft, at) => (at === index ? next : draft)));
  }

  function toggle(index: number, label: string, multiSelect: boolean): void {
    patch(index, toggleOption(draftAt(index), label, multiSelect));
  }

  function noteOf(index: number, text: string): void {
    patch(index, withNote(draftAt(index), text));
  }

  /** 「先聊聊」把她写下的字带上；一个字都没写就让助手问她想聊什么。 */
  function discuss(): void {
    const written = drafts()
      .map((draft) => draft.note.trim())
      .filter((text) => text.length > 0)
      .join("；");
    void props.store.answerQuestion(discussReply(written));
  }

  function skip(): void {
    void props.store.answerQuestion(DISMISSED_REPLY);
  }

  function submit(): void {
    void props.store.answerQuestion(answeredReply(questions(), drafts()));
  }

  /**
   * 「你看着办」的结构化写法。协议里没有"替她选"这个动作，所以这里发的是
   * **她的明确表态**：把每道题的建议（第一个选项）当作她选的那一项，`note` 写清
   * 是"你按建议来"（见 question.ts 的 followRecommendationReply）。
   */
  function followRecommendation(): void {
    void props.store.answerQuestion(followRecommendationReply(questions()));
  }

  return (
    <Show when={props.store.question()}>
      <section
        ref={layer}
        role="alertdialog"
        aria-modal="true"
        aria-label={QUESTION.title}
        class="mx-auto mt-6 max-w-2xl rounded-2xl border-2 border-sky-600 bg-[#08182b] px-6 py-6"
      >
        <h2 class="text-[22px] font-bold text-sky-100">{QUESTION.title}</h2>
        <p class="mt-2 text-[17px] leading-relaxed text-sky-200">{QUESTION.hint}</p>

        <For each={questions()}>
          {(spec, index) => (
            <div
              role="group"
              aria-label={spec.question}
              class="mt-5 rounded-xl border border-sky-900 bg-[#0a1e33] px-4 py-4"
            >
              <Show when={spec.header}>
                <p class="text-[16px] font-semibold tracking-wide text-sky-300">{spec.header}</p>
              </Show>
              <p class="mt-1 text-[18px] font-semibold text-sky-50">{spec.question}</p>
              <Show when={spec.multi_select}>
                <p class="mt-1 text-[16px] text-sky-300">{QUESTION.multiHint}</p>
              </Show>

              <Show when={spec.options.length > 0}>
                <div class="mt-3 flex flex-col gap-2">
                  <For each={spec.options}>
                    {(option, optionIndex) => (
                      <button
                        type="button"
                        aria-pressed={isSelected(index(), option.label)}
                        onClick={() => toggle(index(), option.label, spec.multi_select === true)}
                        class="min-h-[52px] w-full rounded-xl border px-4 py-2 text-left"
                        classList={{
                          "border-sky-400 bg-sky-900/60": isSelected(index(), option.label),
                          "border-sky-800 bg-[#061321] hover:bg-[#0c2540]": !isSelected(
                            index(),
                            option.label,
                          ),
                        }}
                      >
                        <span class="block text-[17px] font-semibold text-sky-50">
                          {option.label}
                          <Show when={isRecommended(optionIndex())}>
                            <span class="ml-2 rounded-full bg-sky-500/20 px-2 py-0.5 text-[16px] font-medium text-sky-200">
                              {QUESTION.recommended}
                            </span>
                          </Show>
                        </span>
                        <Show when={option.description}>
                          <span class="mt-1 block text-[16px] leading-relaxed text-slate-300">
                            {option.description}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={isRecommended(0)}>
                  <p class="mt-2 text-[16px] leading-relaxed text-slate-400">
                    {QUESTION.recommendedHint}
                  </p>
                </Show>
              </Show>

              {/* 协议把"其他"这件事留给客户端：她想说的，永远有地方写。 */}
              <label
                class="mt-3 block text-[16px] font-medium text-sky-100"
                for={`question-other-${index()}`}
              >
                {QUESTION.otherLabel}
              </label>
              <textarea
                id={`question-other-${index()}`}
                rows={2}
                class="mt-2 min-h-[64px] w-full resize-y rounded-xl border border-sky-800 bg-[#061321] px-3 py-2 text-[16px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-sky-500"
                placeholder={QUESTION.otherPlaceholder}
                value={draftAt(index()).note}
                onInput={(event) => noteOf(index(), event.currentTarget.value)}
              />
            </div>
          )}
        </For>

        <div class="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" class={primary} disabled={!hasAnyAnswer(drafts())} onClick={submit}>
            {QUESTION.submit}
          </button>
          <button type="button" class={secondary} onClick={followRecommendation}>
            {QUESTION.followRecommendation}
          </button>
        </div>
        <p class="mt-2 text-[16px] leading-relaxed text-slate-400">
          {hasAnyAnswer(drafts()) ? QUESTION.buttonsFirst : QUESTION.submitNeedAnswer}
        </p>

        <div class="mt-4 border-t border-sky-900 pt-3">
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class={secondary} onClick={discuss}>
              {QUESTION.discuss}
            </button>
            <button type="button" class={secondary} onClick={skip}>
              {QUESTION.skip}
            </button>
          </div>
          <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{QUESTION.discussHint}</p>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{QUESTION.skipHint}</p>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
            {QUESTION.followRecommendationHint}
          </p>
        </div>
      </section>
    </Show>
  );
}
