// 能力中心（#74）：一个按「你想做什么」来搜的全屏浮层。
//
// 为什么不是插件市场：
//
//   王姐分不清一个第三方插件安不安全，把它摆在货架上，等于让她自己承担判断
//   风险的责任。所以这里只放我们自己挑过、自己写清楚的任务：每一项都告诉她
//   「需要什么」「会动到什么」「现在能不能做」。规模不靠数量，靠搜得到。
//
// 这个文件只管展示和搜索。真正的过滤/分组/边界判断都在 catalog.ts（纯逻辑，
// 有单测），所有中文文案在 copy-library.ts。
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import { visibleTasks } from "./admin-config.ts";
import { availabilityHint, groupTasks, searchTasks } from "./catalog.ts";
import { LIBRARY } from "./copy-library.ts";
import type { TaskDef } from "./tasks/index.ts";

export interface TaskLibraryProps {
  /**
   * 冻结的接口：能力中心和应用共用同一个 store。这一层只负责“找任务”，
   * 不读它的内容，但保留这个入口，挑中卡片后交给的任务流程需要它。
   */
  store: Store;
  onPick: (task: TaskDef) => void;
  onClose: () => void;
}

/** 一张结果卡片。主区域是一个大按钮；风险可以展开，所以单独放在按钮外面。 */
function ResultCard(props: { task: TaskDef; onPick(task: TaskDef): void }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const risks = () => props.task.risks ?? [];
  const visibleRisks = () => (expanded() ? risks() : risks().slice(0, 1));
  const hint = () => availabilityHint(props.task);
  const needsText = () => LIBRARY.needs[props.task.needs];

  return (
    <div class="flex flex-col rounded-2xl border border-slate-700 bg-[#141b24] transition-colors hover:border-sky-600">
      <button
        type="button"
        onClick={() => props.onPick(props.task)}
        class="flex min-h-[44px] w-full flex-col items-start gap-2 rounded-2xl px-5 py-4 text-left"
      >
        <span class="text-[20px] leading-snug font-semibold text-slate-100">{props.task.title}</span>
        <span class="text-[16px] leading-relaxed text-slate-400">{props.task.example}</span>
        <span class="text-[16px] leading-relaxed text-slate-300">
          {LIBRARY.needsLabel}：{needsText()}
        </span>
      </button>

      {/* 诚实的边界：不是错误，所以用中性的蓝灰提示，不用红色。 */}
      <Show when={hint()}>
        {(text) => (
          <p class="mx-5 mb-3 rounded-xl border border-sky-800 bg-sky-950/40 px-3 py-2 text-[16px] leading-relaxed text-sky-100">
            {text()}
          </p>
        )}
      </Show>

      <Show when={risks().length > 0}>
        <div class="border-t border-slate-800 px-5 py-3">
          <p class="text-[16px] font-medium text-amber-200/90">{LIBRARY.risksLabel}</p>
          <ul class="mt-1 space-y-1">
            <For each={visibleRisks()}>
              {(risk) => (
                <li class="flex gap-2 text-[16px] leading-relaxed text-amber-100/80">
                  <span aria-hidden="true" class="text-amber-400">•</span>
                  <span>{risk}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={risks().length > 1}>
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded()}
              class="mt-1 min-h-[44px] rounded-lg px-2 text-[16px] text-sky-300 hover:bg-slate-800"
            >
              {expanded() ? LIBRARY.risksLess : LIBRARY.risksMore(risks().length - 1)}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export default function TaskLibrary(props: TaskLibraryProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  // 打开就落在搜索框上：这个页面的全部意义就是「用一句话找」。
  onMount(() => {
    queueMicrotask(() => searchInput?.focus());
  });

  const searching = () => query().trim().length > 0;
  // #58 — 技术同事关掉的任务在这里也不出现，和首页保持一致。
  const hits = createMemo(() => searchTasks(query(), visibleTasks()));
  const sections = createMemo(() => groupTasks(visibleTasks()));

  return (
    <div
      class="fixed inset-0 z-50 flex flex-col bg-[#0b0f14]"
      role="dialog"
      aria-modal="true"
      aria-label={LIBRARY.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <header class="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-5 pt-5 pb-4 sm:px-8">
        <div>
          <h2 class="text-[26px] leading-tight font-bold text-slate-100">{LIBRARY.title}</h2>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{LIBRARY.entryBody}</p>
        </div>
        <button
          type="button"
          onClick={() => props.onClose()}
          class="min-h-[44px] shrink-0 rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
        >
          {LIBRARY.close}
        </button>
      </header>

      <div class="shrink-0 px-5 pt-4 pb-3 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <label for="cante-library-search" class="text-[16px] font-medium text-slate-300">
            {LIBRARY.searchLabel}
          </label>
          <input
            id="cante-library-search"
            ref={searchInput}
            type="search"
            autocomplete="off"
            value={query()}
            placeholder={LIBRARY.searchPlaceholder}
            onInput={(event) => setQuery(event.currentTarget.value)}
            class="mt-2 min-h-[52px] w-full rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[18px] text-slate-100 placeholder:text-slate-500"
          />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <Show
            when={searching()}
            fallback={
              <For each={sections()}>
                {(section) => (
                  <section class="mt-5">
                    <h3 class="text-[20px] font-semibold text-slate-200">{section.group}</h3>
                    <div class="mt-3 flex flex-col gap-3">
                      <For each={section.tasks}>
                        {(task) => <ResultCard task={task} onPick={(picked) => props.onPick(picked)} />}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            }
          >
            <Show
              when={hits().length > 0}
              fallback={
                <div class="mt-6 rounded-2xl border border-dashed border-slate-700 bg-[#111820] px-5 py-6">
                  <h3 class="text-[20px] font-semibold text-slate-200">{LIBRARY.emptyTitle}</h3>
                  <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{LIBRARY.emptyBody}</p>
                  <div class="mt-4 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        searchInput?.focus();
                        searchInput?.select();
                      }}
                      class="min-h-[52px] flex-1 rounded-xl bg-sky-600 px-5 text-[18px] font-semibold text-white hover:bg-sky-500"
                    >
                      {LIBRARY.emptyRetry}
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onClose()}
                      class="min-h-[52px] flex-1 rounded-xl border border-slate-600 px-5 text-[18px] font-semibold text-slate-100 hover:border-slate-400"
                    >
                      {LIBRARY.emptyHome}
                    </button>
                  </div>
                </div>
              }
            >
              <h3 class="mt-5 text-[20px] font-semibold text-slate-200">
                {LIBRARY.hitsTitle(hits().length)}
              </h3>
              <div class="mt-3 flex flex-col gap-3">
                <For each={hits()}>
                  {(task) => <ResultCard task={task} onPick={(picked) => props.onPick(picked)} />}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
