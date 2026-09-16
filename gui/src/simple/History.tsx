// #57 — the history screen: search it, then run the same job again.
//
// Her work repeats by the month ("上个月那张表，再给我弄一遍"), so this screen is
// an entrance to reusing work, not a ledger. The search box sits at the top and
// filters as she types; every row can be acted on — open the result, show it in
// its folder, run the same job again, or undo it.
//
// Two rules shape the code:
//
//   * every user-facing Chinese sentence lives in copy-history.ts, and the
//     matching rules live in history-search.ts, where `bun test` can pin them.
//   * the type is large on purpose: 16px minimum, 20px for titles, 44px for
//     every button. The person this screen is for is 45 and reads Excel all day.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { HISTORY } from "./copy-history.ts";
import { rerunInput, searchRuns } from "./history-search.ts";
import { fileName, formatWhen } from "./run.ts";
import type { Store, TaskRun } from "../store.ts";

export interface HistoryProps {
  store: Store;
}

function stateClass(state: TaskRun["state"]): string {
  switch (state) {
    case "done":
      return "bg-emerald-500/20 text-emerald-200";
    case "failed":
      return "bg-rose-500/20 text-rose-200";
    case "cancelled":
      return "bg-amber-500/20 text-amber-200";
    case "running":
      return "bg-sky-500/20 text-sky-200";
    default:
      return "bg-slate-600/40 text-slate-300";
  }
}

function changed(run: TaskRun): boolean {
  return run.impact.created + run.impact.modified + run.impact.deleted > 0;
}

export default function History(props: HistoryProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  let searchInput: HTMLInputElement | undefined;

  const runs = () => props.store.runs();
  const shown = () => searchRuns(runs(), query());
  const searching = () => query().trim().length > 0;

  function clearSearch(): void {
    setQuery("");
    searchInput?.focus();
  }

  async function rerun(run: TaskRun): Promise<void> {
    const input = rerunInput(run);
    await props.store.startRun(input.task, input.files, input.instruction);
  }

  return (
    <section class="mx-auto flex w-full max-w-3xl flex-col gap-4" aria-label={HISTORY.ariaSection}>
      <header>
        <h2 class="text-[24px] font-bold text-slate-50">{HISTORY.title}</h2>
        <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{HISTORY.subtitle}</p>
      </header>

      <Show when={runs().length > 0}>
        <div>
          <label for="cante-history-search" class="text-[16px] font-medium text-slate-300">
            {HISTORY.search.label}
          </label>
          <input
            id="cante-history-search"
            ref={searchInput}
            type="search"
            autocomplete="off"
            aria-label={HISTORY.search.ariaLabel}
            value={query()}
            placeholder={HISTORY.search.placeholder}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Esc empties the box first; on an empty box it just steps out.
                event.preventDefault();
                if (query()) clearSearch();
                else searchInput?.blur();
              }
              if (event.key === "Enter") event.preventDefault();
            }}
            class="mt-2 min-h-[52px] w-full rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[18px] text-slate-100 placeholder:text-slate-500"
          />
          <p class="mt-2 text-[16px] leading-relaxed text-slate-500">{HISTORY.rerunHint}</p>
        </div>
      </Show>

      <Show
        when={runs().length > 0}
        fallback={
          <div class="rounded-2xl border border-slate-700 bg-slate-900 px-5 py-8 text-center">
            <p class="text-[20px] font-semibold text-slate-200">{HISTORY.empty.title}</p>
            <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{HISTORY.empty.body}</p>
          </div>
        }
      >
        <Show
          when={shown().length > 0}
          fallback={
            <div class="rounded-2xl border border-dashed border-slate-700 bg-[#111820] px-5 py-6">
              <p class="text-[20px] font-semibold text-slate-200">{HISTORY.noResult.title}</p>
              <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{HISTORY.noResult.body}</p>
              <button
                type="button"
                onClick={clearSearch}
                aria-label={HISTORY.search.ariaClear}
                class="mt-4 min-h-[44px] rounded-xl bg-sky-600 px-5 text-[16px] font-semibold text-white hover:bg-sky-500"
              >
                {HISTORY.search.clear}
              </button>
            </div>
          }
        >
          <Show when={searching()}>
            <p class="text-[16px] text-slate-300" role="status">
              {HISTORY.hits(shown().length)}
            </p>
          </Show>

          <ul class="flex flex-col gap-3">
            <For each={shown()}>
              {(run) => {
                const resultFiles = () => run.result?.files ?? [];
                return (
                  <li class="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="min-w-0 flex-1 truncate text-[20px] font-semibold text-slate-100">
                        {run.taskTitle}
                      </p>
                      <span
                        class={`rounded-full px-3 py-1 text-[16px] font-semibold ${stateClass(run.state)}`}
                      >
                        {HISTORY.state[run.state]}
                      </span>
                      <span class="text-[16px] text-slate-400">{formatWhen(run.createdAt)}</span>
                    </div>

                    <p class="mt-2 text-[16px] leading-relaxed text-slate-300">
                      {run.files.length > 0
                        ? HISTORY.filesLine(
                            run.files.length,
                            run.files.slice(0, 3).map(fileName).join("、"),
                            run.files.length > 3,
                          )
                        : HISTORY.noFiles}
                    </p>

                    <Show
                      when={resultFiles().length > 0}
                      fallback={
                        <p class="mt-1 text-[16px] text-slate-400">{HISTORY.noResultFiles}</p>
                      }
                    >
                      <p class="mt-1 text-[16px] leading-relaxed text-emerald-200">
                        {HISTORY.resultsLine(
                          resultFiles().slice(0, 2).map((file) => fileName(file.path)).join("、"),
                          resultFiles().length,
                          resultFiles().length > 2,
                        )}
                      </p>
                    </Show>

                    <Show when={run.failed?.length}>
                      <p class="mt-1 text-[16px] leading-relaxed text-rose-200">
                        {HISTORY.failedFiles(run.failed?.length ?? 0)}
                      </p>
                    </Show>

                    <div class="mt-3 flex flex-wrap gap-2">
                      <Show when={resultFiles().length > 0}>
                        <button
                          type="button"
                          onClick={() => void props.store.openPath(resultFiles()[0]!.path)}
                          aria-label={HISTORY.actions.ariaOpenResult}
                          class="min-h-[44px] rounded-xl bg-sky-500 px-4 text-[16px] font-bold text-slate-950 hover:bg-sky-400"
                        >
                          {HISTORY.actions.openResult}
                        </button>
                        <button
                          type="button"
                          onClick={() => void props.store.revealPath(resultFiles()[0]!.path)}
                          aria-label={HISTORY.actions.ariaOpenFolder}
                          class="min-h-[44px] rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
                        >
                          {HISTORY.actions.openFolder}
                        </button>
                      </Show>
                      <button
                        type="button"
                        onClick={() => void rerun(run)}
                        aria-label={HISTORY.actions.ariaRerun}
                        class="min-h-[44px] rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
                      >
                        {HISTORY.actions.rerun}
                      </button>
                      <Show when={run.undone === true}>
                        <span class="min-h-[44px] rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-2 text-[16px] leading-[28px] text-emerald-200">
                          {HISTORY.actions.undone}
                        </span>
                      </Show>
                      <Show when={changed(run) && run.undone !== true}>
                        <button
                          type="button"
                          onClick={() => void props.store.undoRun(run.id)}
                          aria-label={HISTORY.actions.ariaUndo}
                          class="min-h-[44px] rounded-xl border-2 border-amber-500 px-4 text-[16px] font-bold text-amber-200 hover:bg-amber-950/40"
                        >
                          {HISTORY.actions.undo}
                        </button>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
