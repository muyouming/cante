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
import TaskCard from "./TaskCard.tsx";
import { TASKS, type TaskDef } from "./tasks/index.ts";

export interface HomeProps {
  /** A card was pressed: start that task's flow. */
  onPickTask(task: TaskDef): void;
  /** The free-form box was submitted: handle this sentence. */
  onSubmitText(text: string): void;
}

export default function Home(props: HomeProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [hint, setHint] = createSignal<string | null>(null);

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
    </div>
  );
}
