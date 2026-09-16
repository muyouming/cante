// Simple-mode home: big task cards grouped by what they are for, plus one
// free-form box for “直接说一句话” (#38).
//
// This file is only the entry point. A card press hands the chosen `TaskDef`
// to the task flow (r5-tasks' TaskRunner, wired in App.tsx); a free-form
// sentence hands the text over the same seam. Home never talks to the daemon
// itself, so it stays renderable before anything is configured.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { HOME, TASK_GROUPS, taskGroupRank } from "./copy.ts";
import { LIBRARY } from "./copy-library.ts";
import TaskCard from "./TaskCard.tsx";
import TaskLibrary from "./TaskLibrary.tsx";
import type { Store } from "../store.ts";
import { TASKS, type TaskDef } from "./tasks/index.ts";

export interface HomeProps {
  /** A card was pressed: start that task's flow. */
  onPickTask(task: TaskDef): void;
  /** The free-form box was submitted: handle this sentence. */
  onSubmitText(text: string): void;
  /** The app's shared store (#74): the ability centre reads its session. */
  store: Store;
}

export default function Home(props: HomeProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [hint, setHint] = createSignal<string | null>(null);
  // #74 — the ability centre is a local overlay; the shell does not need to know.
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  // The shell's store, required: a fallback here would be a second store, and a
  // store opens its own connection to the daemon.
  const store = (): Store => props.store;

  // Group the catalogue once; unknown groups fall to the end rather than
  // disappearing, so a task with a new group is never silently lost.
  const sections = (): Array<{ key: string; label: string; hint: string; tasks: TaskDef[] }> => {
    const byGroup = new Map<string, TaskDef[]>();
    for (const task of TASKS) {
      const list = byGroup.get(task.group) ?? [];
      list.push(task);
      byGroup.set(task.group, list);
    }
    const known = TASK_GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      hint: group.hint,
      tasks: byGroup.get(group.key) ?? [],
    }));
    const extras = [...byGroup.keys()]
      .filter((key) => taskGroupRank(key) === TASK_GROUPS.length)
      .map((key) => ({ key, label: key, hint: "", tasks: byGroup.get(key) ?? [] }));
    return [...known, ...extras].filter((section) => section.tasks.length > 0);
  };

  const submit = (): void => {
    const value = text().trim();
    if (!value) {
      setHint(HOME.inputEmpty);
      return;
    }
    setHint(null);
    setText("");
    props.onSubmitText(value);
  };

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-6 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <h1 class="text-[26px] leading-tight font-bold text-slate-100">{HOME.greeting}</h1>
          <p class="mt-2 text-[16px] text-slate-400">{HOME.intro}</p>

          {/* #74 — 除了下面几张常用卡片，还能按「想做的事」去整个任务库搜。 */}
          <div class="mt-6 flex flex-col gap-3 rounded-2xl border border-sky-800 bg-sky-950/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 class="text-[20px] font-semibold text-slate-100">{LIBRARY.entryHint}</h2>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{LIBRARY.entryBody}</p>
            </div>
            <button
              type="button"
              onClick={() => setLibraryOpen(true)}
              class="min-h-[52px] shrink-0 rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
            >
              {LIBRARY.entryButton(TASKS.length)}
            </button>
          </div>

          <Show when={sections().length === 0}>
            <div class="mt-6 rounded-2xl border border-dashed border-slate-700 bg-[#111820] px-5 py-6">
              <h2 class="text-[20px] font-semibold text-slate-200">{HOME.emptyTitle}</h2>
              <p class="mt-2 text-[16px] text-slate-400">{HOME.emptyBody}</p>
            </div>
          </Show>

          <For each={sections()}>
            {(section) => (
              <section class="mt-7">
                <div class="flex items-baseline gap-3">
                  <h2 class="text-[20px] font-semibold text-slate-200">{section.label}</h2>
                  <span class="text-[16px] text-slate-500">{section.hint}</span>
                </div>
                <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <For each={section.tasks}>
                    {(task) => <TaskCard task={task} onPress={(picked) => props.onPickTask(picked)} />}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </div>

      <div class="shrink-0 border-t border-slate-800 bg-[#0e141b] px-5 py-3 sm:px-8">
        <form
          class="mx-auto flex w-full max-w-3xl flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label for="cante-say" class="text-[16px] font-medium text-slate-300">
            {HOME.inputLabel}
          </label>
          <div class="flex items-stretch gap-2">
            <input
              id="cante-say"
              type="text"
              autocomplete="off"
              value={text()}
              placeholder={HOME.inputPlaceholder}
              onInput={(event) => {
                setText(event.currentTarget.value);
                if (hint()) setHint(null);
              }}
              class="min-h-[52px] min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[18px] text-slate-100 placeholder:text-slate-500"
            />
            <button
              type="submit"
              class="min-h-[52px] shrink-0 rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
            >
              {HOME.inputSend}
            </button>
          </div>
          <Show when={hint()}>
            <p class="text-[16px] text-amber-400" role="alert">
              {hint()}
            </p>
          </Show>
        </form>
      </div>

      {/* #74 — 全屏的任务库。挑中一张卡片就关掉它，交给原来的任务流程。 */}
      <Show when={libraryOpen()}>
        <TaskLibrary
          store={store()}
          onPick={(task) => {
            setLibraryOpen(false);
            props.onPickTask(task);
          }}
          onClose={() => setLibraryOpen(false)}
        />
      </Show>
    </div>
  );
}
