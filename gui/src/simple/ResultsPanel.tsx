// r17 — 「我做的结果」面板：她做过的结果文件都在这儿，最近的在最上面。
//
// 结果文件不搬家（规矩是留在原文件旁边），所以这里只做一件事：把散在桌面、微信
// 下载和各种文件夹里的结果汇总成一份能搜的清单，并且如实标出它现在还在不在。
//
// 三件事分别归三个地方，互不越界：
//   * 排序、搜索、四种现状的判断在 results.ts（纯逻辑，有单测）；
//   * 面向用户的中文在 copy-results.ts；
//   * 这个文件只负责渲染，以及从本机问一次 file_facts。
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import { RESULTS } from "./copy-results.ts";
import { useFocusLayer } from "./FocusLayer.tsx";
import { canOpen, collectResults, resultPaths, searchResults, type ResultEntry } from "./results.ts";
import { formatSize, formatWhen } from "./run.ts";
import { fetchFileFacts, normalizeFacts, type FileFact } from "./verify.ts";

export interface ResultsPanelProps {
  store: Store;
  onClose(): void;
}

/** 一行结果文件的现状，用颜色分清楚：还在是绿的，不在是红的，说不清是中性的。 */
function presenceClass(entry: ResultEntry): string {
  switch (entry.presence) {
    case "present":
      return "text-emerald-200";
    case "missing":
      return "text-rose-200";
    case "unreadable":
      return "text-amber-200";
    default:
      return "text-slate-300";
  }
}

export default function ResultsPanel(props: ResultsPanelProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  // null 表示「这次没能核对」——不是「文件都不在」，两者在界面上说得很不一样。
  const [facts, setFacts] = createSignal<FileFact[] | null>(null);
  let searchInput: HTMLInputElement | undefined;
  let closeButton: HTMLButtonElement | undefined;

  const entries = createMemo(() => collectResults(props.store.runs(), facts()));
  const shown = createMemo(() => searchResults(entries(), query()));
  const searching = () => query().trim().length > 0;

  // 打开就落在搜索框上：这个面板的意义就是「用一句话把上次那张表找回来」；一个结果
  // 都还没有的时候落在「关掉」上（那时屏幕上只有它）。焦点进得来、Tab 在这一层里
  // 循环、Esc 关掉——三件事都在 FocusLayer 里做（别的浮层走同一条路）。
  const layer = useFocusLayer({
    open: () => true,
    initialFocus: () => searchInput ?? closeButton,
    onEscape: () => props.onClose(),
  });

  // 问本机一次：这些结果文件现在还在不在。问不到就保持 null，绝不假装它们还在。
  createEffect(() => {
    const paths = resultPaths(props.store.runs());
    if (paths.length === 0) {
      setFacts(null);
      return;
    }
    let alive = true;
    void fetchFileFacts(paths)
      .then((raw) => {
        if (alive) setFacts(normalizeFacts(raw));
      })
      .catch(() => {
        // 桥接不在（比如浏览器预览）：如实说「没能核对」。
        if (alive) setFacts(null);
      });
    return () => {
      alive = false;
    };
  });

  function clearSearch(): void {
    setQuery("");
    searchInput?.focus();
  }

  return (
    <div
      ref={layer}
      class="fixed inset-0 z-50 flex flex-col bg-[#0b0f14]"
      role="dialog"
      aria-modal="true"
      aria-label={RESULTS.ariaSection}
    >
      <header class="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-5 pt-5 pb-4 sm:px-8">
        <div>
          <h2 class="text-[26px] leading-tight font-bold text-slate-100">{RESULTS.title}</h2>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{RESULTS.subtitle}</p>
        </div>
        <button
          type="button"
          ref={(element: HTMLButtonElement) => (closeButton = element)}
          onClick={() => props.onClose()}
          class="min-h-[44px] shrink-0 rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
        >
          {RESULTS.close}
        </button>
      </header>

      <Show when={entries().length > 0}>
        <div class="shrink-0 px-5 pt-4 pb-3 sm:px-8">
          <div class="mx-auto w-full max-w-3xl">
            <label for="cante-results-search" class="text-[16px] font-medium text-slate-300">
              {RESULTS.search.label}
            </label>
            <input
              id="cante-results-search"
              ref={searchInput}
              type="search"
              autocomplete="off"
              aria-label={RESULTS.search.ariaLabel}
              value={query()}
              placeholder={RESULTS.search.placeholder}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 先清掉搜索词，空了再关掉面板；这里的 Esc 到此为止（否则关掉
                  // 面板和清搜索会一起发生）。
                  event.preventDefault();
                  event.stopPropagation();
                  if (query()) clearSearch();
                  else props.onClose();
                }
                if (event.key === "Enter") event.preventDefault();
              }}
              class="mt-2 min-h-[52px] w-full rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[18px] text-slate-100 placeholder:text-slate-500"
            />
          </div>
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <Show
            when={entries().length > 0}
            fallback={
              <div class="mt-5 rounded-2xl border border-slate-700 bg-slate-900 px-5 py-8 text-center">
                <p class="text-[20px] font-semibold text-slate-200">{RESULTS.empty.title}</p>
                <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{RESULTS.empty.body}</p>
              </div>
            }
          >
            <Show
              when={shown().length > 0}
              fallback={
                <div class="mt-5 rounded-2xl border border-dashed border-slate-700 bg-[#111820] px-5 py-6">
                  <p class="text-[20px] font-semibold text-slate-200">{RESULTS.noResult.title}</p>
                  <p class="mt-2 text-[16px] leading-relaxed text-slate-400">
                    {RESULTS.noResult.body}
                  </p>
                  <button
                    type="button"
                    onClick={clearSearch}
                    class="mt-4 min-h-[44px] rounded-xl bg-sky-600 px-5 text-[16px] font-semibold text-white hover:bg-sky-500"
                  >
                    {RESULTS.search.clear}
                  </button>
                </div>
              }
            >
              <Show when={searching()}>
                <p class="mt-5 text-[16px] text-slate-300" role="status">
                  {RESULTS.hits(shown().length)}
                </p>
              </Show>

              <ul class="mt-4 flex flex-col gap-3">
                <For each={shown()}>
                  {(entry) => (
                    <li class="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                      <p class="truncate text-[20px] font-semibold text-slate-100" title={entry.name}>
                        {entry.name}
                      </p>
                      <p
                        class="mt-1 truncate text-[16px] leading-relaxed text-slate-400"
                        title={entry.instruction}
                      >
                        {RESULTS.from(entry.title, entry.instruction)}
                      </p>
                      <p class="mt-1 text-[16px] text-slate-500">
                        {RESULTS.when(formatWhen(entry.createdAt))}
                        <Show when={entry.presence === "present" || entry.presence === "unreadable"}>
                          <Show when={entry.size !== null}>
                            {" · "}
                            {RESULTS.size(formatSize(entry.size ?? 0))}
                          </Show>
                        </Show>
                      </p>

                      {/* 现在还在不在：本机说什么就说什么，核对没做成也照实说。 */}
                      <p class={`mt-2 text-[16px] leading-relaxed ${presenceClass(entry)}`}>
                        {RESULTS.presence[entry.presence]}
                      </p>
                      <Show when={!canOpen(entry)}>
                        <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
                          {RESULTS.actions.goneDisabled}
                        </p>
                      </Show>

                      <div class="mt-3 flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={!canOpen(entry)}
                          onClick={() => void props.store.openPath(entry.path)}
                          aria-label={RESULTS.actions.ariaOpen(entry.name)}
                          class="min-h-[48px] rounded-xl bg-sky-500 px-5 text-[16px] font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                        >
                          {RESULTS.actions.open}
                        </button>
                        <button
                          type="button"
                          onClick={() => void props.store.revealPath(entry.path)}
                          aria-label={RESULTS.actions.ariaOpenFolder(entry.name)}
                          class="min-h-[48px] rounded-xl border border-slate-600 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
                        >
                          {RESULTS.actions.openFolder}
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
