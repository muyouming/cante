// The privacy panel: where the data goes, in plain language.
//
// Answers the only three questions this audience actually asks — what happens
// on this computer, what needs the network, and who receives the content — then
// offers the one switch that changes the answer ("只在本机处理"). A second
// switch mirrors the same state so "联网搜索" is visibly off, not merely
// implied.
//
// The store members are read through a safe accessor so the panel still renders
// (and a click cannot throw) before the store workstream lands `privacy()`, and
// the frozen prop shape stays exactly `{ store: Store }`.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import { SENT } from "./copy-privacy-audit.ts";
import type { TaskRun } from "./run.ts";
import {
  DEFAULT_PRIVACY,
  latestSentRun,
  localOnlyHint,
  privacyAnswers,
  sentContentView,
  webSearchHint,
  type PrivacyState,
  type SentContentView,
} from "./privacy.ts";

export interface PrivacyPanelProps {
  store: Store;
}

function Switch(props: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}): JSX.Element {
  return (
    <div class="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-[#0e141b] px-3 py-2">
      <div class="flex min-w-0 flex-col">
        <span class="text-[16px] text-slate-200">{props.label}</span>
        <span class="text-[16px] leading-6 text-slate-500">{props.hint}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        class={`shrink-0 min-h-[44px] rounded-full border px-3 text-[16px] font-bold ${
          props.checked
            ? "border-emerald-600 bg-emerald-900/40 text-emerald-200"
            : "border-slate-700 bg-slate-900 text-slate-400"
        } ${props.disabled ? "cursor-not-allowed opacity-60" : "hover:border-slate-500"}`}
        onClick={() => props.onChange(!props.checked)}
      >
        {props.checked ? "已开" : "已关"}
      </button>
    </div>
  );
}

/**
 * 这一节要看的「最近一次任务」：手上这件（如果已经发出去）+ 刚做完那件 + 历史，
 * 取最新的一条。还没开始的不算——`latestSentRun` 会把停在确认页的滤掉。
 */
function latestRun(store: Store): TaskRun | null {
  const list: TaskRun[] = [];
  const push = (run: TaskRun | null | undefined): void => {
    if (run && !list.some((item) => item.id === run.id)) list.push(run);
  };
  push(store.currentRun?.());
  push(store.lastFinished?.());
  for (const run of store.runs?.() ?? []) push(run);
  return latestSentRun(list);
}

export interface SentContentSectionProps {
  store: Store;
  /**
   * 结果卡片上显示的那一次；不传就取最近一次真正发出去的任务。
   *
   * 为什么 ResultCard 要传：卡片可能正在给她看「刚做完、还没看过」的那一件
   * （`lastFinished`），而全局「最近一次」可能已经排到了下一件。卡片上问
   * 「刚才发了什么」，要答的必须是卡片上这一件。
   */
  run?: TaskRun | null;
}

/**
 * 「这次发出去了什么」。默认折叠：先给一句摘要，点开才是原文，免得一屏大字吓到她。
 *
 * 这里显示的文字**逐字**取自 `store.composedInstruction(run)`，也就是真正发出去的
 * 那一段；**不读任何本地文件内容**——展示的是「发出去的文字」，不是「文件里有什么」。
 * ResultCard 也 import 这个组件，因为她刚做完一件事时最想问的就是「刚才发了什么」。
 */
export function SentContentSection(props: SentContentSectionProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const run = (): TaskRun | null => (props.run === undefined ? latestRun(props.store) : props.run);
  const view = (): SentContentView => {
    const current = run();
    return sentContentView(
      current
        ? { text: props.store.composedInstruction?.(current) ?? null, online: current.online }
        : null,
    );
  };
  return (
    <section
      class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0e141b] p-3"
      aria-label={SENT.title}
    >
      <span class="text-[20px] font-bold text-slate-300">{SENT.title}</span>
      <p class="text-[16px] leading-6 text-slate-400">{SENT.filesStay}</p>
      <Show
        when={view().state === "sent"}
        fallback={<p class="text-[16px] leading-6 text-slate-200">{view().message}</p>}
      >
        <p class="text-[16px] leading-6 text-slate-400">{SENT.textGoes}</p>
        <p class="text-[16px] leading-6 text-slate-400">{SENT.textIsLocal}</p>
        <p class="text-[16px] leading-6 text-slate-200">{view().summary}</p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          class="min-h-[44px] self-start rounded-lg border border-slate-600 px-4 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
        >
          {open() ? SENT.hideFull : SENT.showFull}
        </button>
        <Show when={open()}>
          <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-[#0b0f14] px-3 py-2 text-[16px] leading-relaxed text-slate-200">
            {view().text}
          </pre>
        </Show>
      </Show>
    </section>
  );
}

export default function PrivacyPanel(props: PrivacyPanelProps): JSX.Element {
  const state = (): PrivacyState => props.store.privacy?.() ?? DEFAULT_PRIVACY;
  const setLocalOnly = (value: boolean): void => {
    void props.store.setLocalOnly?.(value);
  };

  return (
    <section
      class="flex flex-col gap-3 rounded-lg border border-slate-800 bg-[#0b0f14] p-4"
      aria-label="你的内容去哪了"
    >
      <span class="text-[16px] font-bold tracking-widest text-slate-500">你的内容去哪了</span>

      <div class="flex flex-col gap-2">
        <For each={privacyAnswers(state())}>
          {(item) => (
            <div class="flex flex-col gap-0.5">
              <span class="text-[16px] font-bold text-slate-300">{item.question}</span>
              <span class="text-[16px] leading-6 text-slate-400">{item.answer}</span>
            </div>
          )}
        </For>
      </div>

      <SentContentSection store={props.store} />

      <div class="flex flex-col gap-2">
        <Switch
          label="只在本机处理"
          hint={localOnlyHint(state().localOnly)}
          checked={state().localOnly}
          onChange={setLocalOnly}
        />
        <Switch
          label="联网搜索"
          hint={webSearchHint(state().localOnly)}
          checked={!state().localOnly}
          disabled={state().localOnly}
          onChange={(checked) => setLocalOnly(!checked)}
        />
      </div>
    </section>
  );
}

/**
 * The home-screen strip. `r5-shell` mounts this next to the task grid so the
 * current answer to "does this leave my computer?" is visible without opening
 * the panel.
 */
export function PrivacySummary(props: PrivacyPanelProps): JSX.Element {
  const state = (): PrivacyState => props.store.privacy?.() ?? DEFAULT_PRIVACY;
  const who = (): string => {
    if (state().localOnly) return "内容不会离开这台电脑";
    if (state().provider) return `联网时发给：${state().provider}`;
    return "联网时内容会发给帮你整理的服务方";
  };
  return (
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-800 bg-[#0e141b] px-3 py-2 text-[16px] text-slate-400"
      role="status"
      aria-label="数据去向"
    >
      <span class={state().localOnly ? "font-bold text-emerald-300" : "text-slate-300"}>
        只在本机处理：{state().localOnly ? "已打开" : "已关闭"}
      </span>
      <span class="text-slate-600">·</span>
      <span>{who()}</span>
    </div>
  );
}
