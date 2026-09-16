// #41 — what happened, in a form the user can act on.
//
// The rule this card exists to enforce: *the result is a new file, and the
// original is untouched*. So the card leads with the result files, each one
// showing its name, where it lives, its size / line change, and two large
// buttons: 打开文件 and 打开所在文件夹. If the run changed anything in place
// (only possible after the red overwrite checkbox), it says so and offers the
// one-click undo right next to it.
//
// A failure is never a stack trace: 发生了什么 + 你可以怎么做.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { FOLLOWUP, TRUST } from "./copy.ts";
import { SCHEDULE } from "./copy-schedule.ts";
import { checkNoteFromRows, lastAgentText } from "./evidence.ts";
import { endedWithQuestion } from "./followup.ts";
import { fileName, folderName, onlineHint, onlineLabel } from "./run.ts";
import { describe as describeSchedule, describeCadence, type Cadence, type Schedule } from "./schedule.ts";
import type { TaskRun } from "./tasks/index.ts";
import type { Store } from "../store.ts";

export interface ResultCardProps {
  store: Store;
  /** The run to render. Defaults to the store's current run (the shell's path). */
  run?: TaskRun;
}

const STATE_TITLE: Record<string, string> = {
  done: "做好了",
  failed: "这件事没有做完",
  cancelled: "已经停下",
};

export default function ResultCard(props: ResultCardProps): JSX.Element {
  const [showDetail, setShowDetail] = createSignal(false);
  const [reply, setReply] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const run = () => props.run ?? props.store.currentRun();
  const state = () => run()?.state ?? "done";
  const show = () => state() === "done" || state() === "failed" || state() === "cancelled";
  const files = () => run()?.result?.files ?? [];
  const changed = () => {
    const impact = run()?.impact;
    if (!impact) return false;
    return impact.created + impact.modified + impact.deleted > 0;
  };
  // #63 — the assistant's own 【需要你核对】 paragraph for THIS run. Absent unless
  // it actually wrote one, so the card never shows a canned warning.
  const checkNote = () => checkNoteFromRows(props.store.rows());
  // r7 — sometimes the assistant stops with a question instead of a result. The
  // turn's last words and its result-file count say whether this is one of
  // those endings, and the answer box below is where she gets to reply.
  const lastText = () => lastAgentText(props.store.rows()) ?? "";
  const producedFiles = () => run()?.result?.files.length ?? 0;
  const asking = () => show() && endedWithQuestion(lastText(), producedFiles());

  async function sendReply(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || sending()) return;
    setSending(true);
    setReply("");
    try {
      await props.store.replyToRun(trimmed);
    } finally {
      setSending(false);
    }
  }

  async function rerun(): Promise<void> {
    const current = run();
    if (!current) return;
    await props.store.startRun(
      { id: current.taskId, title: current.taskTitle, plan: current.plan },
      current.files,
      current.instruction,
    );
  }

  // #55 — 以后自动做。默认「每周一 09:00」，一眼能看懂；开启后随时能停。
  const [cadence, setCadence] = createSignal<Cadence>("weekly");
  const [weekday, setWeekday] = createSignal(1);
  const [monthDay, setMonthDay] = createSignal(5);
  const [hour, setHour] = createSignal(9);
  const scheduleForRun = (): Schedule | undefined => {
    const taskId = run()?.taskId;
    if (!taskId) return undefined;
    return props.store.schedules().find((item) => item.taskId === taskId);
  };
  const autoOn = (): boolean => scheduleForRun()?.enabled === true;
  const pickedDay = (): number => (cadence() === "monthly" ? monthDay() : weekday());
  const nextText = (): string => {
    const schedule = scheduleForRun();
    return schedule ? describeSchedule(schedule) : "";
  };

  function turnOn(): void {
    const current = run();
    if (!current) return;
    const existing = scheduleForRun();
    // 之前停掉过就清掉旧记录，按这次选的时间重新开。
    if (existing) props.store.removeSchedule(existing.id);
    props.store.addSchedule({
      cadence: cadence(),
      day: cadence() === "daily" ? 0 : pickedDay(),
      hour: hour(),
      taskId: current.taskId,
      taskTitle: current.taskTitle,
      plan: [...current.plan],
      files: [...current.files],
      instruction: current.instruction,
    });
  }

  function turnOff(): void {
    const existing = scheduleForRun();
    if (existing) props.store.setScheduleEnabled(existing.id, false);
  }

  return (
    <Show when={run() && show()}>
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <header class="flex flex-wrap items-center gap-3">
          <span
            class="flex h-10 w-10 items-center justify-center rounded-full text-xl"
            classList={{
              "bg-emerald-500/20 text-emerald-300": state() === "done",
              "bg-rose-500/20 text-rose-300": state() === "failed",
              "bg-amber-500/20 text-amber-300": state() === "cancelled",
            }}
            aria-hidden="true"
          >
            {state() === "done" ? "✓" : state() === "failed" ? "!" : "■"}
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-2xl font-bold text-slate-50">{STATE_TITLE[state()] ?? "做好了"}</h2>
            <p class="truncate text-sm text-slate-400">{run()?.taskTitle}</p>
          </div>
          <div class="flex flex-col items-end">
            <span
              class="rounded-full px-3 py-1 text-xs font-semibold"
              classList={{
                "bg-sky-500/20 text-sky-200": run()?.online === true,
                "bg-emerald-500/20 text-emerald-200": run()?.online === false,
              }}
            >
              {onlineLabel(run()?.online === true)}
            </span>
            <span class="mt-1 max-w-[16rem] text-right text-[11px] text-slate-500">
              {onlineHint(run()?.online === true)}
            </span>
          </div>
        </header>

        <Show when={run()?.dryRun}>
          <p class="rounded-2xl border border-sky-700 bg-sky-950/50 px-4 py-3 text-sm text-sky-100">
            这是一次试跑。它只说明了打算怎么做，没有改动任何文件。
          </p>
        </Show>

        <Show when={state() === "failed"}>
          <div class="rounded-2xl border-2 border-rose-600 bg-rose-950/50 px-4 py-4">
            <p class="text-base font-bold text-rose-100">{run()?.error?.what ?? "这件事没有做完。"}</p>
            <p class="mt-1 text-sm text-rose-200">{run()?.error?.how ?? "原来的文件都还在。"}</p>
            <Show when={showDetail()}>
              <p class="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/30 px-3 py-2 text-xs text-rose-200/80">
                {run()?.error?.detail}
              </p>
            </Show>
            <button
              type="button"
              onClick={() => setShowDetail((value) => !value)}
              class="mt-2 rounded-lg px-2 py-1 text-xs text-rose-200 hover:bg-rose-900/50"
            >
              {showDetail() ? "收起细节" : "看看细节"}
            </button>
          </div>
        </Show>

        <Show when={state() === "cancelled"}>
          <p class="rounded-2xl border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
            {changed()
              ? "你叫停了这件事，但已经产生了一些改动。可以用下面的「一键撤销」还原。"
              : "你叫停了这件事，没有改动任何文件。"}
          </p>
        </Show>

        <p class="text-lg text-slate-100">{run()?.result?.summary}</p>

        <Show when={checkNote()}>
          <div class="rounded-2xl border border-amber-700 bg-amber-950/40 px-4 py-3">
            <p class="text-base font-bold text-amber-100">{TRUST.checkTitle}</p>
            <p class="mt-1 whitespace-pre-wrap break-words text-[16px] leading-relaxed text-amber-100/90">
              {checkNote()}
            </p>
          </div>
        </Show>

        {/* r7 — the assistant stopped on a question. Without this box she has
            nowhere to answer, so the job dead-ends right here. */}
        <Show when={asking()}>
          <section class="rounded-2xl border-2 border-sky-600 bg-sky-950/40 px-4 py-4">
            <p class="text-base font-bold text-sky-100">{FOLLOWUP.title}</p>
            <p class="mt-1 text-[16px] leading-relaxed text-sky-100/90">{FOLLOWUP.hint}</p>
            <label class="mt-3 block text-[16px] font-medium text-slate-200" for="run-reply">
              {FOLLOWUP.inputLabel}
            </label>
            <textarea
              id="run-reply"
              rows={3}
              class="mt-2 min-h-[96px] w-full resize-y rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-[16px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              placeholder={FOLLOWUP.placeholder}
              value={reply()}
              disabled={sending()}
              onInput={(event) => setReply(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter keeps the newline for a longer answer.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendReply(reply());
                }
              }}
            />
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={reply().trim().length === 0 || sending()}
                onClick={() => void sendReply(reply())}
                class="min-h-[48px] rounded-xl bg-sky-500 px-8 text-[16px] font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {FOLLOWUP.send}
              </button>
              <span class="text-[14px] text-slate-400">{FOLLOWUP.enterHint}</span>
            </div>
            {/* The exit: she does not have to answer. One tap says "you decide". */}
            <div class="mt-4 border-t border-slate-700 pt-3">
              <button
                type="button"
                disabled={sending()}
                onClick={() => void sendReply(FOLLOWUP.letItDecideText)}
                class="min-h-[48px] rounded-xl border border-slate-600 px-6 text-[16px] font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {FOLLOWUP.letItDecide}
              </button>
              <p class="mt-1 text-[14px] text-slate-400">{FOLLOWUP.letItDecideHint}</p>
            </div>
          </section>
        </Show>

        <Show when={files().length > 0}>
          <ul class="divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-700">
            <For each={files()}>
              {(file) => (
                <li class="flex flex-col gap-3 bg-slate-800/40 px-4 py-4 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-base font-semibold text-slate-100" title={file.path}>
                      {fileName(file.path)}
                    </p>
                    <p class="truncate text-xs text-slate-500" title={folderName(file.path)}>
                      位置：{folderName(file.path)}
                    </p>
                    <p class="mt-1 text-sm text-slate-300">{file.summary}</p>
                  </div>
                  <div class="flex shrink-0 gap-3">
                    <button
                      type="button"
                      onClick={() => void props.store.openPath(file.path)}
                      class="min-h-[48px] rounded-xl bg-sky-500 px-5 text-base font-bold text-slate-950 hover:bg-sky-400"
                    >
                      打开文件
                    </button>
                    <button
                      type="button"
                      onClick={() => void props.store.revealPath(file.path)}
                      class="min-h-[48px] rounded-xl border border-slate-600 px-5 text-base font-semibold text-slate-100 hover:bg-slate-800"
                    >
                      打开所在文件夹
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={files().length === 0 && state() !== "failed"}>
          <p class="rounded-2xl border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm text-slate-300">
            这次没有生成新文件。
          </p>
        </Show>

        {/* #55 — 一次成功的任务之后，不打扰地问一句「以后要不要自动做」。
            默认关闭；开了随时能停，并且一直说明「该确认的还是会停下来问」。 */}
        <Show when={state() === "done" && run()?.taskId}>
          <section class="rounded-2xl border border-slate-700 bg-slate-800/40 px-4 py-4">
            <Show when={autoOn()}>
              <div class="flex flex-col gap-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 class="text-[20px] font-semibold text-slate-100">{SCHEDULE.on}</h3>
                    <p class="mt-1 text-[16px] text-slate-300">
                      {SCHEDULE.nextPrefix}
                      {nextText()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={turnOff}
                    class="min-h-[48px] rounded-xl border border-slate-600 px-6 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
                  >
                    {SCHEDULE.stop}
                  </button>
                </div>
                <p class="text-[16px] leading-relaxed text-slate-400">{SCHEDULE.confirmNote}</p>
              </div>
            </Show>

            <Show when={!autoOn()}>
              <div class="flex flex-col gap-3">
                <div>
                  <h3 class="text-[20px] font-semibold text-slate-100">{SCHEDULE.title}</h3>
                  <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{SCHEDULE.intro}</p>
                </div>
                <div class="flex flex-wrap items-end gap-3">
                  <label class="flex flex-col gap-1 text-[16px] text-slate-300">
                    <span>{SCHEDULE.cadenceLabel}</span>
                    <select
                      class="min-h-[44px] rounded-xl border border-slate-600 bg-slate-900 px-3 text-[16px] text-slate-100"
                      value={cadence()}
                      onChange={(event) => setCadence(event.currentTarget.value as Cadence)}
                    >
                      <option value="daily">{SCHEDULE.cadence.daily}</option>
                      <option value="weekly">{SCHEDULE.cadence.weekly}</option>
                      <option value="monthly">{SCHEDULE.cadence.monthly}</option>
                    </select>
                  </label>
                  <Show when={cadence() === "weekly"}>
                    <label class="flex flex-col gap-1 text-[16px] text-slate-300">
                      <span>{SCHEDULE.weekdayLabel}</span>
                      <select
                        class="min-h-[44px] rounded-xl border border-slate-600 bg-slate-900 px-3 text-[16px] text-slate-100"
                        value={String(weekday())}
                        onChange={(event) => setWeekday(Number(event.currentTarget.value))}
                      >
                        <For each={[...SCHEDULE.weekdays]}>
                          {(name, index) => <option value={String(index())}>{name}</option>}
                        </For>
                      </select>
                    </label>
                  </Show>
                  <Show when={cadence() === "monthly"}>
                    <label class="flex flex-col gap-1 text-[16px] text-slate-300">
                      <span>{SCHEDULE.monthDayLabel}</span>
                      <select
                        class="min-h-[44px] rounded-xl border border-slate-600 bg-slate-900 px-3 text-[16px] text-slate-100"
                        value={String(monthDay())}
                        onChange={(event) => setMonthDay(Number(event.currentTarget.value))}
                      >
                        <For each={Array.from({ length: 28 }, (_, index) => index + 1)}>
                          {(value) => <option value={String(value)}>{value}</option>}
                        </For>
                      </select>
                    </label>
                    <p class="text-[16px] text-slate-500">{SCHEDULE.monthDayHint}</p>
                  </Show>
                  <label class="flex flex-col gap-1 text-[16px] text-slate-300">
                    <span>{SCHEDULE.hourLabel}</span>
                    <select
                      class="min-h-[44px] rounded-xl border border-slate-600 bg-slate-900 px-3 text-[16px] text-slate-100"
                      value={String(hour())}
                      onChange={(event) => setHour(Number(event.currentTarget.value))}
                    >
                      <For each={Array.from({ length: 24 }, (_, index) => index)}>
                        {(value) => <option value={String(value)}>{`${String(value).padStart(2, "0")}:00`}</option>}
                      </For>
                    </select>
                  </label>
                </div>
                <p class="text-[16px] text-slate-300">
                  {SCHEDULE.nextPrefix}
                  {describeCadence(cadence(), cadence() === "daily" ? 0 : pickedDay(), hour())}
                </p>
                <div class="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={turnOn}
                    class="min-h-[48px] rounded-xl bg-sky-600 px-6 text-[16px] font-semibold text-white hover:bg-sky-500"
                  >
                    {SCHEDULE.enable[cadence()]}
                  </button>
                  <span class="text-[16px] text-slate-400">{SCHEDULE.confirmNote}</span>
                </div>
              </div>
            </Show>
          </section>
        </Show>

        <footer class="flex flex-wrap items-center justify-end gap-3">
          <Show when={changed() && run()?.undone !== true}>
            <button
              type="button"
              onClick={() => {
                const id = run()?.id;
                if (id) void props.store.undoRun(id);
              }}
              class="min-h-[52px] rounded-xl border-2 border-amber-500 px-6 text-base font-bold text-amber-200 hover:bg-amber-950/40"
            >
              一键撤销（还原成动手前）
            </button>
          </Show>
          <Show when={run()?.undone === true}>
            <span class="rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-200">
              已经撤销，文件都放回去了。
            </span>
          </Show>
          <button
            type="button"
            onClick={() => void rerun()}
            class="min-h-[52px] rounded-xl border border-slate-600 px-6 text-base font-semibold text-slate-200 hover:bg-slate-800"
          >
            再跑一次
          </button>
          <button
            type="button"
            onClick={() => props.store.dismissRun()}
            class="min-h-[52px] rounded-xl bg-slate-700 px-6 text-base font-semibold text-slate-100 hover:bg-slate-600"
          >
            知道了
          </button>
        </footer>
      </div>
    </Show>
  );
}
