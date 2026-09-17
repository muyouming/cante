// Simple-mode home: big task cards grouped by what they are for, plus one
// free-form box for “直接说一句话” (#38).
//
// r24 — 对一个从没用过这类工具的人，「我该怎么开口」才是门槛：三句她说得出口的
// 例子就摆在那个框下面，点一下填进去，改几个字就是她的第一次尝试；第一次做成
// 之后，同一件事「多说一个条件」的那一句也会出现在这里（见 copy-first-run.ts）。
//
// This file is only the entry point. A card press hands the chosen `TaskDef`
// to the task flow (r5-tasks' TaskRunner, wired in App.tsx); a free-form
// sentence hands the text over the same seam. Home never talks to the daemon
// itself, so it stays renderable before anything is configured.
import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { HOME, TASK_GROUPS, taskGroupRank } from "./copy.ts";
// r24 — 「第一句话该怎么说」：三句例子两边（向导最后一步、首页输入框旁）共用。
import {
  FIRST_RUN,
  SAY_EXAMPLES,
  exampleClick,
  exampleForSentence,
  firstWinHintFor,
  firstWinRun,
  nextTimeSuggestion,
  takeSentence,
} from "./copy-first-run.ts";
import { ADMIN, adminDefaultText, adminDisabledText, adminNetworkText } from "./copy-admin.ts";
import {
  adminConfig,
  disabledTaskNames,
  initAdminConfig,
  visibleTasks,
} from "./admin-config.ts";
import { SCHEDULE } from "./copy-schedule.ts";
// r13 — 排好的活（一次说好几件事）：首页要看得见，也要随时能停。
import { QUEUE } from "./copy-queue.ts";
import { describeQueue, nextWaiting, queueSummary } from "./queue.ts";
import { LIBRARY } from "./copy-library.ts";
import { describe as describeSchedule } from "./schedule.ts";
// r17 — 结果文件散在原文件旁边，「上次那张表在哪」需要在首页有个答案。
import { RESULTS } from "./copy-results.ts";
import { resultCount } from "./results.ts";
import ResultsPanel from "./ResultsPanel.tsx";
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
  // 点了一条例子之后，光标要落进框里（她接着改几个字就是自己的事了）。
  let input: HTMLInputElement | undefined;
  // F4 — 框里已经有她自己打的字时，先问她一句（这一句就是那条例子），她说换才换。
  const [pendingExample, setPendingExample] = createSignal<string | null>(null);
  // #58 — 「技术同事设了什么」默认收起，只有她主动点开才展开。
  const [adminOpen, setAdminOpen] = createSignal(false);
  // #74 — the ability centre is a local overlay; the shell does not need to know.
  const [libraryOpen, setLibraryOpen] = createSignal(false);
  // r17 — 同上：这是首页自己开的一层「我做的结果」。
  const [resultsOpen, setResultsOpen] = createSignal(false);
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

  // r13 — 排好的活。首页上要能看见三件事：还有几件、手上这件在等什么、
  // 下一件是什么。看的就是这份账，和界面上的说法来自同一个纯逻辑。
  const queued = () => props.store.queue();
  const queueFacts = () => queueSummary(queued());
  /** 已经摆在她面前的那件（在确认页上，或者正在做）。 */
  const stagedRun = () => {
    const run = props.store.currentRun();
    return run && (run.state === "preview" || run.state === "running") ? run : null;
  };
  /** 停在她面前的那件就是排队里的：那就不用再拿另一条「到点了」重复说一遍。 */
  const stagedFromQueue = () => queued().some((job) => job.state === "running");
  /** 「还有 2 件：正在等你确认……，下一件是……」——跟着数据变的那一句。 */
  const queueLine = () => {
    const run = stagedRun();
    return describeQueue(
      queueFacts(),
      run ? (run.state === "running" ? "doing" : "confirm") : undefined,
    );
  };
  const canOpenQueued = (): boolean => stagedRun() !== null || nextWaiting(queued()) !== null;
  const openNextQueued = (): void => {
    const run = stagedRun();
    if (run) {
      // 它已经在确认页上等着了：把她直接带到那一页，不做第二件事。
      props.onPickTask(taskById(run.taskId) ?? freeTask(run.instruction));
      return;
    }
    // 队列不自己往下走：这一步是她说「好，做下一件」才往前走的。
    const job = props.store.startNextQueued();
    if (job) props.onPickTask(taskById(job.taskId) ?? freeTask(job.instruction));
  };

  // #58 — 启动时读一次技术同事设好的配置。读到了就重画：被关掉的任务卡要消失。
  onMount(() => {
    void initAdminConfig();
    // r24 — 她在向导最后一步点的那一句，被带到这里（取走即清，只填这一次）。
    const seed = takeSentence();
    if (seed) setText(seed);
  });

  /**
   * r24 / F4 — 点一条例子：这一句进框，光标也进框。
   *
   * 例子只是起点，不是模板：框里的字随她改，所以她点完得能直接往下接着打。
   * 框里已经有她自己打的字时，先问一句（见 copy-first-run.ts 的 exampleClick）：
   * 她那半句不是垃圾，静默清掉是数据丢失。
   */
  function pickExample(sentence: string): void {
    setHint(null);
    const action = exampleClick(text(), sentence);
    if (action.kind === "confirm") {
      // 她打的字一个字不动：只把这一句挂起来，等她点头。
      setPendingExample(action.text);
      return;
    }
    setPendingExample(null);
    setText(action.text);
    input?.focus();
  }

  /** 她说「换」：这时才替掉她原来的字——是她点的，不是我们替她清的。 */
  function useExample(): void {
    const sentence = pendingExample();
    if (!sentence) return;
    setText(sentence);
    setPendingExample(null);
    input?.focus();
  }

  /** 她说「不换」：她打的字留着，我们一个字都不动。 */
  function keepMyWords(): void {
    setPendingExample(null);
    input?.focus();
  }

  // r24 — 她第一次做成的那件事；以及同一件事「多说一个条件」的那一句。
  // 结果卡片归别的 workstream，而这里是她做完之后一定回到的那一屏。
  const firstWin = () => firstWinRun(props.store.runs());
  const nextTime = (): string | null => {
    const run = firstWin();
    return run ? nextTimeSuggestion(run) : null;
  };

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
    // r24 — 她提交的这一句正好是某条例子的原文时，那不是「自由发挥」：这件事卡片
    // 里本来就有，走卡片流程才走得通（微信接龙要的是贴进去的文字，走「直接说一句
    // 话」会卡在选文件那一步）。改过一个字就还是按她自己想的说，不替她认。
    const example = exampleForSentence(value);
    const task = example ? taskById(example.taskId) : undefined;
    if (task) {
      props.onPickTask(task);
      return;
    }
    props.onSubmitText(value);
  };

  return (
    <div class="flex h-full min-h-0 w-full flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-6 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <h1 class="text-[26px] leading-tight font-bold text-slate-100">{HOME.greeting}</h1>
          <p class="mt-2 text-[16px] text-slate-400">{HOME.intro}</p>

          {/* r24 — 她刚做成第一件事。同一件事原来还能说得更细，这句话就摆在这里，
              点一下同样能填进下面的框：第一次成功之后最该学的就是这一句。 */}
          <Show when={nextTime()}>
            {(sentence) => (
              <section class="mt-5 rounded-2xl border-2 border-emerald-700 bg-emerald-950/30 px-5 py-4">
                <h2 class="text-[20px] font-semibold text-emerald-100">
                  {FIRST_RUN.firstWinTitle}
                </h2>
                <button
                  type="button"
                  onClick={() => pickExample(sentence())}
                  class="mt-3 min-h-[48px] w-full rounded-xl border border-emerald-700 bg-[#111820] px-4 py-2 text-left text-[17px] leading-snug text-emerald-50 hover:border-emerald-400"
                >
                  {sentence()}
                </button>
                <p class="mt-2 text-[16px] leading-relaxed text-slate-300">
                  {firstWinHintFor(firstWin())}
                </p>
              </section>
            )}
          </Show>

          {/* #55 — 到点的自动任务在等她确认；它不会自己动手，得让她找得到入口。 */}
          <Show when={pendingRun() && !stagedFromQueue()}>
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

          {/* r13 — 排好的活：还有几件、手上这件在等什么、下一件是什么，以及随时能
              停掉剩下的。（停掉剩下的不等于打断正在做的那件。） */}
          <Show when={queued().length > 0}>
            <section class="mt-5 rounded-2xl border-2 border-sky-700 bg-sky-950/40 px-5 py-4">
              <h2 class="text-[20px] font-semibold text-sky-100">{QUEUE.homeTitle}</h2>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-200">{queueLine()}</p>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{QUEUE.homeConfirmNote}</p>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <Show when={canOpenQueued()}>
                  <button
                    type="button"
                    onClick={openNextQueued}
                    class="min-h-[48px] rounded-xl bg-sky-500 px-6 text-[16px] font-bold text-slate-950 hover:bg-sky-400"
                  >
                    {QUEUE.homeOpen}
                  </button>
                </Show>
                <button
                  type="button"
                  onClick={() => props.store.clearQueue()}
                  class="min-h-[44px] rounded-xl border border-slate-600 px-6 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
                >
                  {QUEUE.homeStop}
                </button>
              </div>
              <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{QUEUE.homeStopNote}</p>
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

          {/* r17 — 结果文件按规矩留在原文件旁边，所以她需要一个地方把做过的东西
              找回来：文件名、来自哪件事、什么时候做的、现在还在不在。 */}
          <div class="mt-6 flex flex-col gap-3 rounded-2xl border border-emerald-800 bg-emerald-950/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 class="text-[20px] font-semibold text-slate-100">{RESULTS.entryTitle}</h2>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{RESULTS.entryBody}</p>
            </div>
            <button
              type="button"
              onClick={() => setResultsOpen(true)}
              class="min-h-[52px] shrink-0 rounded-xl bg-emerald-600 px-6 text-[18px] font-semibold text-white hover:bg-emerald-500"
            >
              {RESULTS.entryButton(resultCount(store().runs()))}
            </button>
          </div>

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
              ref={input}
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
          {/* F4 — 框里有她自己打的字时，点例子不能静默把它清掉：就在这里问一句，
              她说换才换（换不换都是她点的）。 */}
          <Show when={pendingExample()}>
            <div class="rounded-xl border border-amber-600 bg-amber-950/30 px-4 py-3">
              <p class="text-[16px] leading-relaxed text-amber-100">{FIRST_RUN.exampleAsk}</p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={useExample}
                  class="min-h-[44px] rounded-xl bg-sky-600 px-5 text-[16px] font-semibold text-white hover:bg-sky-500"
                >
                  {FIRST_RUN.exampleUse}
                </button>
                <button
                  type="button"
                  onClick={keepMyWords}
                  class="min-h-[44px] rounded-xl border border-slate-600 px-5 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
                >
                  {FIRST_RUN.exampleKeep}
                </button>
              </div>
            </div>
          </Show>
          {/* r24 — 「该怎么说」才是第一次用的人真正的门槛：三句人话就摆在输入框
              下面，点一下就跑进框里。它们是唯一的口子，不是一份功能清单。 */}
          <p class="text-[16px] leading-relaxed text-slate-300">{FIRST_RUN.homeTitle}</p>
          <div class="flex flex-wrap gap-2">
            <For each={SAY_EXAMPLES}>
              {(example) => (
                <button
                  type="button"
                  onClick={() => pickExample(example.sentence)}
                  class="min-h-[44px] rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[16px] text-slate-200 hover:border-sky-500"
                >
                  {example.sentence}
                </button>
              )}
            </For>
          </div>
        </form>
      </div>

      {/* r17 — 全屏的「我做的结果」。打开文件/文件夹都走 store，面板自己不碰桥接。 */}
      <Show when={resultsOpen()}>
        <ResultsPanel store={store()} onClose={() => setResultsOpen(false)} />
      </Show>

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
