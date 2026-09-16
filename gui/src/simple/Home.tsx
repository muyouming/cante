// Simple-mode home: big task cards grouped by what they are for, plus one
// free-form box for “直接说一句话” (#38).
//
// This file is only the entry point. A card press hands the chosen `TaskDef`
// to the task flow (r5-tasks' TaskRunner, wired in App.tsx); a free-form
// sentence hands the text over the same seam. Home never talks to the daemon
// itself, so it stays renderable before anything is configured.
import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { HOME, TASK_GROUPS, taskGroupRank } from "./copy.ts";
import { ADMIN, adminDefaultText, adminDisabledText, adminNetworkText } from "./copy-admin.ts";
import {
  adminConfig,
  disabledTaskNames,
  initAdminConfig,
  visibleTasks,
} from "./admin-config.ts";
import { SCHEDULE } from "./copy-schedule.ts";
import { LIBRARY } from "./copy-library.ts";
import { describe as describeSchedule } from "./schedule.ts";
import TaskCard from "./TaskCard.tsx";
import TaskLibrary from "./TaskLibrary.tsx";
import type { Store } from "../store.ts";
import { freeTask, taskById, type TaskDef } from "./tasks/index.ts";

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
  // #58 — 「技术同事设了什么」默认收起，只有她主动点开才展开。
  const [adminOpen, setAdminOpen] = createSignal(false);
  // #74 — the ability centre is a local overlay; the shell does not need to know.
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  // The shell's store, required: a fallback here would be a second store, and a
  // store opens its own connection to the daemon.
  const store = (): Store => props.store;
  // #55 — 已经开启的自动任务。没有就不占地方。
  const activeSchedules = () => props.store.schedules().filter((item) => item.enabled);
  // #55 — 到点的自动任务会先停在确认页。如果她正在首页，这里得给个入口把它叫出来，
  // 否则那件活就卡在后台没人看得见（也不会去做——它本来就要等她点头）。
  const pendingRun = () => {
    const run = props.store.currentRun();
    return run?.state === "preview" ? run : null;
  };
  const openPending = (): void => {
    const run = pendingRun();
    if (!run) return;
    props.onPickTask(taskById(run.taskId) ?? freeTask(run.instruction));
  };

  // #58 — 启动时读一次技术同事设好的配置。读到了就重画：被关掉的任务卡要消失。
  onMount(() => {
    void initAdminConfig();
  });

  // Group the catalogue once; unknown groups fall to the end rather than
  // disappearing, so a task with a new group is never silently lost. (#58 —
  // tasks the administrator turned off are simply absent, not greyed out.)
  const sections = (): Array<{ key: string; label: string; hint: string; tasks: TaskDef[] }> => {
    const byGroup = new Map<string, TaskDef[]>();
    for (const task of visibleTasks()) {
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

          {/* #55 — 到点的自动任务在等她确认；它不会自己动手，得让她找得到入口。 */}
          <Show when={pendingRun()}>
            <section class="mt-5 rounded-2xl border-2 border-sky-600 bg-sky-950/40 px-5 py-4">
              <h2 class="text-[20px] font-semibold text-sky-100">{SCHEDULE.pendingTitle}</h2>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-300">{SCHEDULE.pendingBody}</p>
              <button
                type="button"
                onClick={openPending}
                class="mt-3 min-h-[48px] rounded-xl bg-sky-500 px-6 text-[16px] font-bold text-slate-950 hover:bg-sky-400"
              >
                {SCHEDULE.pendingOpen}
              </button>
            </section>
          </Show>

          {/* #55 — 她不用记着哪天做；这里告诉她下次什么时候做、做什么，随时能停。 */}
          <Show when={activeSchedules().length > 0}>
            <section class="mt-6 rounded-2xl border border-emerald-800 bg-emerald-950/20 px-5 py-4">
              <h2 class="text-[20px] font-semibold text-slate-100">{SCHEDULE.homeTitle}</h2>
              <ul class="mt-3 space-y-3">
                <For each={activeSchedules()}>
                  {(schedule) => (
                    <li class="flex flex-wrap items-center justify-between gap-3">
                      <p class="min-w-0 text-[16px] text-slate-200">
                        {SCHEDULE.homeNext(describeSchedule(schedule), schedule.taskTitle)}
                      </p>
                      <button
                        type="button"
                        onClick={() => props.store.setScheduleEnabled(schedule.id, false)}
                        class="min-h-[44px] shrink-0 rounded-xl border border-slate-600 px-6 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
                      >
                        {SCHEDULE.homeStop}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
              <p class="mt-3 text-[16px] leading-relaxed text-slate-400">{SCHEDULE.confirmNote}</p>
            </section>
          </Show>

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
              {LIBRARY.entryButton(visibleTasks().length)}
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

          {/* #58 — 这台电脑被技术同事统一设过时，在首页底部如实说明，且能展开看具体内容。 */}
          <Show when={adminConfig().present}>
            <section class="mt-7 rounded-2xl border border-slate-700 bg-[#111820] px-5 py-4">
              <p class="text-[16px] leading-relaxed text-slate-300">{ADMIN.notice}</p>
              <button
                type="button"
                onClick={() => setAdminOpen((open) => !open)}
                aria-expanded={adminOpen()}
                class="mt-3 min-h-[44px] rounded-xl border border-slate-600 px-5 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
              >
                {adminOpen() ? ADMIN.hideDetail : ADMIN.showDetail}
              </button>
              <Show when={adminOpen()}>
                <dl class="mt-3 flex flex-col gap-2">
                  <div class="flex flex-wrap items-baseline gap-x-3">
                    <dt class="text-[16px] font-medium text-slate-400">{ADMIN.defaultLabel}</dt>
                    <dd class="text-[16px] text-slate-200">
                      {adminDefaultText(adminConfig().default_provider, adminConfig().default_model)}
                    </dd>
                  </div>
                  <div class="flex flex-wrap items-baseline gap-x-3">
                    <dt class="text-[16px] font-medium text-slate-400">{ADMIN.networkLabel}</dt>
                    <dd class="text-[16px] text-slate-200">
                      {adminNetworkText(adminConfig().allow_network)}
                    </dd>
                  </div>
                  <div class="flex flex-wrap items-baseline gap-x-3">
                    <dt class="text-[16px] font-medium text-slate-400">{ADMIN.disabledLabel}</dt>
                    <dd class="text-[16px] text-slate-200">{adminDisabledText(disabledTaskNames())}</dd>
                  </div>
                </dl>
              </Show>
            </section>
          </Show>
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
