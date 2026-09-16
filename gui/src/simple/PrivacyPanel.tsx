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
import { For } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import {
  DEFAULT_PRIVACY,
  localOnlyHint,
  privacyAnswers,
  webSearchHint,
  type PrivacyState,
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
