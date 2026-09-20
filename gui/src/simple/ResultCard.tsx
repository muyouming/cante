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
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { FOLLOWUP, TRUST } from "./copy.ts";
// r20 — 结果卡片上的入口：她刚做完一件事，最想问的就是「刚才发出去了什么」。
import { SENT } from "./copy-privacy-audit.ts";
// 入口点开的就是隐私面板里同一节（同一个组件，不另做一份）。
import { SentContentSection } from "./PrivacyPanel.tsx";
// r17 — 结果卡片上补一句：这些文件以后在首页也能找回来。
import { RESULTS } from "./copy-results.ts";
// 两轮各自的文案模块都要（核对 + 复制成微信能贴的文字）。
import { VERIFY } from "./copy-verify.ts";
import { SHARE, shareReadFailed } from "./copy-share.ts";
// 内容层核对：她真正会问的是「这是我要的那个吗」——把行数、列名、首屏几行
// 从产出文件里照抄出来（不是替她下「内容没问题」的判断）。
import { SHEET_PEEK } from "./copy-sheet-peek.ts";
import { readSheetPeek, type SheetPeekResult } from "./sheet-peek.ts";
// 她做完之后的下一步通常是打印或发出去：这里给她「文件在哪 + 怎么打印」。
import { LOCATION, PRINT } from "./copy-print.ts";
// r11 — 结果**文件本身**的出口：怎么把这张表交给别人（只引导，绝不替她发送）。
import { HANDOFF } from "./copy-handoff.ts";
import { handoffFor, type HandoffStep } from "./handoff.ts";
import { placeOf } from "./location.ts";
import { SCHEDULE } from "./copy-schedule.ts";
import { checkNoteFromRows, lastAgentText } from "./evidence.ts";
import { endedWithQuestion, nextStepsFor, type NextStep } from "./followup.ts";
// r25 — 做完之后那一步的文案（按钮文字很短，2–4 个字）。
import { NEXT_STEP } from "./copy-next.ts";
import { fileName, onlineHint, onlineLabel, type RunResultFile } from "./run.ts";
import { CHAT_MAX_WIDTH, chatTextSummary, isTablePath, tableToChatText, type TableRow } from "./share.ts";
import { sheetCapability } from "./capabilities.ts";
import { describe as describeSchedule, describeCadence, type Cadence, type Schedule } from "./schedule.ts";
import { taskById, type TaskRun } from "./tasks/index.ts";
import { verifyResultFiles, type Verification } from "./verify.ts";
// 「她点了停下来」之后那三句：做到一半的产出、原文件、下一步（r26）。
import { STOPPED } from "./copy-stop.ts";
import { stoppedView } from "./stop.ts";
import type { Store } from "../store.ts";
import { errorText, invoke } from "../tauri.ts";
// #140 — store 的「撤销」结果在这里说：成功 / 只放回去一部分 / 一个都没放回去。
import Notice from "./Notice.tsx";
import { UNDO_KINDS, noticeView } from "./copy-notice.ts";

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

/**
 * 「怎么发」每一步的句子。步骤键由 handoff.ts 给出，句子在这里从 copy 模块取——
 * 判断与文案各在一处，界面只负责按顺序把句子摆出来。
 */
const HANDOFF_STEP: Record<HandoffStep, string> = {
  howOpen: HANDOFF.howOpen,
  howDrag: HANDOFF.howDrag,
  howWechat: HANDOFF.howWechat,
};

/**
 * 把一段文字放进剪贴板。先走系统剪贴板；在不让用的环境里退回选中复制。
 *
 * 复制不是发送：这里只把文字放到她的剪贴板，她自己决定发不发。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回下面的选中复制 */
  }
  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export default function ResultCard(props: ResultCardProps): JSX.Element {
  const [showDetail, setShowDetail] = createSignal(false);
  // 默认折叠：先让她看到结果，想追问「刚才发了什么」时再打开。
  const [showSent, setShowSent] = createSignal(false);
  const [reply, setReply] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const run = () => props.run ?? props.store.currentRun();
  const state = () => run()?.state ?? "done";
  const show = () => state() === "done" || state() === "failed" || state() === "cancelled";
  const files = () => run()?.result?.files ?? [];
  // r11 — 这次的结果**文件**能不能交给她自己发出去。试跑 / 失败 / 停下 / 没产出都不出，
  // 免得把半成品当成能交出去的东西。判断是纯的（handoff.ts），这里只拿结果。
  const handoff = createMemo(() => handoffFor(run()));
  const changed = () => {
    const impact = run()?.impact;
    if (!impact) return false;
    return impact.created + impact.modified + impact.deleted > 0;
  };
  // #63 — the assistant's own 【需要你核对】 paragraph for THIS run. Absent unless
  // it actually wrote one, so the card never shows a canned warning.
  const checkNote = () => checkNoteFromRows(props.store.rows());
  // r26 — 停下来之后要说的三个数，全部来自 run.impact（快照 diff），不猜。
  const stopped = () => stoppedView({ impact: run()?.impact ?? { created: 0, modified: 0, deleted: 0, messages: 0 } });
  // r7 — sometimes the assistant stops with a question instead of a result. The
  // turn's last words and its result-file count say whether this is one of
  // those endings, and the answer box below is where she gets to reply.
  //
  // r26 — 但**她主动点「停下来」**这一种不算：那一轮是她叫停的，不是助手在等她
  // 回话（助手真要问，那一轮会停在问题上，不会以「停下」结束）。给一个「它有一件
  // 事想问你」的框会让她以为自己漏看了什么，所以这里按状态排除掉。
  const lastText = () => lastAgentText(props.store.rows()) ?? "";
  const producedFiles = () => run()?.result?.files.length ?? 0;
  const asking = () =>
    show() && state() !== "cancelled" && endedWithQuestion(lastText(), producedFiles());
  // r25 — 她刚做成一件事，下一步十有八九要做的那件事。只在真做完、而且这次真产出了
  // 文件时才出现（这一步的前提就是「拿刚做好的这份继续」）；它正在问她话时不出现——
  // 那时她要做的是回话，不是再开一件事。目标是目录里真有的卡，真能一键开始。
  const nextSteps = createMemo<NextStep[]>(() => {
    const current = run();
    if (!current || state() !== "done" || asking() || current.undone === true) return [];
    return nextStepsFor({
      taskId: current.taskId,
      resultFiles: files().map((file) => file.path),
    });
  });

  async function startNext(step: NextStep): Promise<void> {
    const target = taskById(step.taskId);
    if (!target) return;
    await props.store.startRun(
      { id: target.id, title: target.title, plan: target.plan },
      step.files,
      step.say,
    );
  }
  // #140 — 刚撤销完的那句话由上面的 Notice 来说；这条状态标签只在她没有那句话时
  // 挂着（例如程序重开、从记录里读回「已撤销」，那时没有提示可显示）。
  const undoNoticeShown = (): boolean => {
    const view = noticeView(props.store.notice());
    return view !== null && UNDO_KINDS.includes(view.kind);
  };

  // 信任层：运行结束后，拿它声称产出的文件再问本机一次（verify.ts）。结论分三种：
  // 都在能打开 / 它说有却找不到 / 没能核对。核对没做成时绝不假装核对过。
  const [verification, setVerification] = createSignal<Verification | null>(null);
  const [copyNote, setCopyNote] = createSignal("");
  let verifyKey = "";
  createEffect(() => {
    const current = run();
    const claimed = files().map((file) => file.path);
    // 撤销之后结果文件已经被移走，那时再喊「找不到」只会吓人。
    if (!show() || claimed.length === 0 || current?.undone === true) {
      verifyKey = "";
      setVerification(null);
      return;
    }
    const key = `${current?.id ?? ""}|${claimed.join("\n")}`;
    if (key === verifyKey) return;
    verifyKey = key;
    setVerification(null);
    void verifyResultFiles(claimed).then((report) => {
      // 迟到的回答：画面已经换成另一次运行的话，就不要贴旧结论。
      if (verifyKey === key) setVerification(report);
    });
  });

  async function copyVerifyDetail(): Promise<void> {
    const text = verification()?.detail ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote(VERIFY.copied);
    } catch {
      setCopyNote(VERIFY.copyFailed);
    }
  }

  // 内容层核对：她真正会问的是「这是我要的那个吗」。我们不替她回答，而是把
  // 产出文件里她自己能核对的三个数照抄出来：第一行下面的行数、第一行的列名、
  // 最前面几行。走的是和「复制成微信」同一条真读路径（read_result_sheet →
  // cante-sheets read）；读不出来就如实说读不出来，绝不报一个 0。
  //
  // 只对第一个表格类结果读一次：一张表的结果最常见，也是为了不让她一按就触发
  // 一堆读盘。
  const [peek, setPeek] = createSignal<{ path: string; result: SheetPeekResult } | null>(null);
  let peekKey = "";
  createEffect(() => {
    const current = run();
    const target = files().find((file) => isTablePath(file.path));
    if (!show() || !target || current?.undone === true) {
      peekKey = "";
      setPeek(null);
      return;
    }
    const key = `${current?.id ?? ""}|${target.path}`;
    if (key === peekKey) return;
    peekKey = key;
    setPeek(null);
    const cap = sheetCapability();
    void readSheetPeek(target.path, cap.available ? cap.path : null).then((result) => {
      // 迟到的回答：画面已经换成另一次运行的话，就不要贴旧结论。
      if (peekKey === key) setPeek({ path: target.path, result });
    });
  });

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

  // 把表格类结果复制成微信里能贴的文字。
  //
  // 走的是产品真实路径：工具位置从前端探测到的表格能力里拿，内容由后端用
  // `cante-sheets read` 读回来（见 commands.rs 的 read_result_sheet）。读不出来
  // 时给一句能操作的说明，不静默失败，也不假装复制成功。
  const [share, setShare] = createSignal<{ path: string; summary: string; note: string } | null>(
    null,
  );
  const [sharing, setSharing] = createSignal("");

  async function copyForChat(file: RunResultFile): Promise<void> {
    const cap = sheetCapability();
    if (!cap.available || !cap.path) {
      setShare({ path: file.path, summary: "", note: SHARE.toolUnavailable });
      return;
    }
    if (sharing() !== "") return;
    setSharing(file.path);
    setShare(null);
    try {
      const read = invoke as unknown as (
        name: string,
        args?: Record<string, unknown>,
      ) => Promise<{ rows?: TableRow[] }>;
      const response = await read("read_result_sheet", { tool: cap.path, path: file.path });
      const rows = response?.rows ?? [];
      const text = tableToChatText(rows, { maxWidth: CHAT_MAX_WIDTH });
      if (text.trim() === "") {
        setShare({ path: file.path, summary: "", note: SHARE.empty });
        return;
      }
      const copied = await copyText(text);
      setShare({
        path: file.path,
        summary: chatTextSummary(fileName(file.path), rows, text),
        note: copied ? SHARE.copied : SHARE.copyFailed,
      });
    } catch (error) {
      setShare({ path: file.path, summary: "", note: shareReadFailed(errorText(error)) });
    } finally {
      setSharing("");
    }
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
            <p class="text-[16px] text-slate-400">{run()?.taskTitle}</p>
          </div>
          <div class="flex flex-col items-end">
            <span
              class="rounded-full px-3 py-1 text-[16px] font-semibold"
              classList={{
                "bg-sky-500/20 text-sky-200": run()?.online === true,
                "bg-emerald-500/20 text-emerald-200": run()?.online === false,
              }}
            >
              {onlineLabel(run()?.online === true)}
            </span>
            <span class="mt-1 max-w-[16rem] text-right text-[16px] text-slate-500">
              {onlineHint(run()?.online === true)}
            </span>
          </div>
        </header>

        {/* r20 — 她刚做完一件事时的追问入口：点开就是隐私面板里「这次发出去了什么」
            那一节。只展示发出去的文字，不读本地文件内容。 */}
        <div class="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowSent((value) => !value)}
            class="min-h-[44px] self-start rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
          >
            {showSent() ? SENT.entryHide : SENT.entryShow}
          </button>
          <Show when={showSent()}>
            <SentContentSection store={props.store} run={run()} />
          </Show>
        </div>

        <Show when={run()?.dryRun}>
          <p class="rounded-2xl border border-sky-700 bg-sky-950/50 px-4 py-3 text-[16px] text-sky-100">
            这是一次试跑。它只说明了打算怎么做，没有改动任何文件。
          </p>
        </Show>

        <Show when={state() === "failed"}>
          <div class="rounded-2xl border-2 border-rose-600 bg-rose-950/50 px-4 py-4">
            <p class="text-base font-bold text-rose-100">{run()?.error?.what ?? "这件事没有做完。"}</p>
            <p class="mt-1 text-[16px] text-rose-200">{run()?.error?.how ?? "原来的文件都还在。"}</p>
            <Show when={showDetail()}>
              <p class="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/30 px-3 py-2 text-[16px] text-rose-200/80">
                {run()?.error?.detail}
              </p>
            </Show>
            <button
              type="button"
              onClick={() => setShowDetail((value) => !value)}
              class="mt-2 min-h-[44px] rounded-lg px-2 text-[16px] text-rose-200 hover:bg-rose-900/50"
            >
              {showDetail() ? "收起细节" : "看看细节"}
            </button>
          </div>
        </Show>

        <Show when={state() === "cancelled"}>
          {/* r26 — 她点了「停下来」，这里把三件事按顺序说完整：做到一半的产出在哪、
              原来的文件动没动、下一步怎么办。三句的依据都是 run.impact（运行前后
              各一次快照 diff 出来的事实），不新造状态。 */}
          <div class="rounded-2xl border border-amber-700 bg-amber-950/40 px-4 py-3">
            <p class="text-[16px] leading-relaxed text-amber-100">
              {STOPPED.partial(stopped().produced)}
            </p>
            <p class="mt-1 text-[16px] leading-relaxed text-amber-100">
              {stopped().touched > 0
                ? STOPPED.originalsTouched(stopped().touched)
                : STOPPED.originalsSafe}
            </p>
            <p class="mt-1 text-[16px] leading-relaxed text-amber-100/90">{STOPPED.nextStep}</p>
          </div>
        </Show>

        {/* r26 — 停下的时候上面那三句已经把「新做出几个、原名件动没动」说完了，
            再跟一句笼统的 result.summary（「没有改动任何文件」）只会重复一遍。 */}
        <Show when={state() !== "cancelled"}>
          <p class="text-lg text-slate-100">{run()?.result?.summary}</p>
        </Show>

        {/* 信任层：把「它说做好了」落到本机事实上。三种情况三种说法，找不到时
            给出出路（再让它做一次 / 打开文件夹 / 复制详情）。 */}
        <Show when={verification() !== null && verification()!.kind !== "none"}>
          <div
            class="rounded-2xl border px-4 py-3"
            classList={{
              "border-emerald-700 bg-emerald-950/40": verification()!.kind === "ok",
              "border-rose-600 bg-rose-950/40": verification()!.kind === "missing",
              "border-slate-600 bg-slate-800/40": verification()!.kind === "unknown",
            }}
          >
            <h3
              class="text-[20px] font-bold"
              classList={{
                "text-emerald-100": verification()!.kind === "ok",
                "text-rose-100": verification()!.kind === "missing",
                "text-slate-100": verification()!.kind === "unknown",
              }}
            >
              {VERIFY.title}
            </h3>
            <p
              class="mt-1 text-[16px] leading-relaxed"
              classList={{
                "text-emerald-100": verification()!.kind === "ok",
                "text-rose-100": verification()!.kind === "missing",
                "text-slate-200": verification()!.kind === "unknown",
              }}
            >
              {verification()!.message}
              <Show when={verification()!.sizeText}>
                {" "}
                {VERIFY.okSize(verification()!.sizeText!)}
              </Show>
            </p>
            <Show when={verification()!.kind === "missing"}>
              <p class="mt-1 text-[16px] leading-relaxed text-rose-100/90">{VERIFY.missingHint}</p>
            </Show>
            <Show when={verification()!.kind === "unknown"}>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-300">{VERIFY.unknownHint}</p>
            </Show>
            <Show when={verification()!.kind === "missing" || verification()!.kind === "unknown"}>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void rerun()}
                  class="min-h-[48px] rounded-xl border border-slate-500 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
                >
                  {VERIFY.retry}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const target = verification()!.files[0]?.path;
                    if (target) void props.store.revealPath(target);
                  }}
                  class="min-h-[48px] rounded-xl border border-slate-500 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
                >
                  {VERIFY.openFolder}
                </button>
                <button
                  type="button"
                  onClick={() => void copyVerifyDetail()}
                  class="min-h-[48px] rounded-xl border border-slate-500 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
                >
                  {VERIFY.copyDetail}
                </button>
                <Show when={copyNote()}>
                  <span class="text-[16px] text-slate-300">{copyNote()}</span>
                </Show>
              </div>
            </Show>
          </div>
        </Show>

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
              class="mt-2 min-h-[96px] w-full resize-y rounded-xl border border-slate-600 bg-slate-900/70 px-3 py-2 text-[16px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-sky-500"
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
              <span class="text-[16px] text-slate-400">{FOLLOWUP.enterHint}</span>
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
              <p class="mt-1 text-[16px] text-slate-400">{FOLLOWUP.letItDecideHint}</p>
            </div>
          </section>
        </Show>

        <Show when={files().length > 0}>
          <ul class="divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-700">
            <For each={files()}>
              {(file) => (
                <li class="flex flex-col flex-wrap gap-3 bg-slate-800/40 px-4 py-4 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-base font-semibold text-slate-100" title={fileName(file.path)}>
                      {fileName(file.path)}
                    </p>
                    <p class="text-[16px] text-slate-500">{LOCATION[placeOf(file.path)]}</p>
                    <p class="mt-1 text-[16px] text-slate-300">{file.summary}</p>
                  </div>
                  <div class="flex shrink-0 flex-wrap gap-3">
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
                  {/* r17 — 告诉她这些结果以后还能从哪儿找回来，一次说完，不多嘴。 */}
                  <p class="w-full text-[16px] leading-relaxed text-slate-400 sm:basis-full">
                    {RESULTS.keepHint}
                  </p>
                  {/* 打印：她不一定会想到「先打开再按 Ctrl+P」，说一句就够了。 */}
                  <p class="w-full text-[16px] leading-relaxed text-slate-400 sm:basis-full">
                    {PRINT.hint}
                  </p>
                  {/* 表格类结果可以变成微信里能贴的文字。只是复制，不是发送。 */}
                  <Show when={isTablePath(file.path)}>
                    <div class="flex w-full flex-col gap-2 sm:basis-full">
                      <button
                        type="button"
                        disabled={sharing() === file.path}
                        onClick={() => void copyForChat(file)}
                        class="min-h-[48px] w-full rounded-xl border-2 border-sky-600 px-5 text-base font-bold text-sky-100 hover:bg-sky-950/40 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                      >
                        {SHARE.copyButton}
                      </button>
                      <p class="text-[16px] leading-relaxed text-slate-400">{SHARE.hint}</p>
                      <Show when={share()?.path === file.path}>
                        <div
                          class="rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2"
                          role="status"
                        >
                          <Show when={share()?.summary}>
                            <p class="text-[16px] leading-relaxed text-slate-200">{share()?.summary}</p>
                          </Show>
                          <p class="mt-1 text-[16px] leading-relaxed text-slate-300">{share()?.note}</p>
                        </div>
                      </Show>

                      {/* 她自己能核对的那几个数：行数、列名、首屏几行。全部照抄，
                          不汇总、不解释、不写「内容没问题」那种自证的话。 */}
                      <Show when={peek()?.path === file.path}>
                        <section class="rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-3">
                          <h3 class="text-[20px] font-bold text-slate-100">{SHEET_PEEK.title}</h3>
                          <Show when={peek()!.result.kind === "ok"}>
                            <p class="mt-1 text-[16px] leading-relaxed text-slate-200">
                              {SHEET_PEEK.rows(peek()!.result.peek!.rows)}
                            </p>
                            <p class="mt-2 text-[16px] leading-relaxed text-slate-300">
                              {SHEET_PEEK.columnsLabel(
                                peek()!.result.peek!.columns.length,
                                peek()!.result.peek!.columnCount,
                              )}
                            </p>
                            <p class="mt-1 whitespace-pre-wrap break-words text-[16px] leading-relaxed text-slate-100">
                              {peek()!.result.peek!.columns.join(" ｜ ")}
                            </p>
                            <Show
                              when={peek()!.result.peek!.rows > 0}
                              fallback={
                                <p class="mt-2 text-[16px] leading-relaxed text-slate-300">
                                  {SHEET_PEEK.onlyColumns}
                                </p>
                              }
                            >
                              <p class="mt-2 text-[16px] leading-relaxed text-slate-300">
                                {peek()!.result.peek!.rows > peek()!.result.peek!.head.length
                                  ? SHEET_PEEK.headMore(peek()!.result.peek!.head.length)
                                  : SHEET_PEEK.headAll}
                              </p>
                              <Show
                                when={
                                  peek()!.result.peek!.columnCount >
                                  peek()!.result.peek!.columns.length
                                }
                              >
                                <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
                                  {SHEET_PEEK.narrowed(peek()!.result.peek!.columns.length)}
                                </p>
                              </Show>
                              <ul class="mt-2 flex flex-col gap-1">
                                <For each={peek()!.result.peek!.head}>
                                  {(row) => (
                                    <li class="whitespace-pre-wrap break-words rounded-lg bg-black/20 px-3 py-2 text-[16px] leading-relaxed text-slate-100">
                                      {row.join(" ｜ ")}
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                          </Show>
                          <Show when={peek()!.result.kind === "empty"}>
                            <p class="mt-1 text-[16px] leading-relaxed text-slate-300">
                              {SHEET_PEEK.empty}
                            </p>
                          </Show>
                          <Show when={peek()!.result.kind === "unknown"}>
                            <p class="mt-1 text-[16px] leading-relaxed text-slate-300">
                              {peek()!.result.reason === "no-tool"
                                ? SHEET_PEEK.noTool
                                : SHEET_PEEK.unknown}
                            </p>
                          </Show>
                        </section>
                      </Show>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* r11 — 结果文件本身的出口。和上面「复制成微信能贴的文字」并列，但说的是两件事：
            那条送的是**文字**（贴进聊天框），这条说的是把**文件本身**发出去（对方打开还是
            表格）。只给引导——文件是哪个、在哪儿、怎么拖进微信；微信那边绝不自动发送。 */}
        <Show when={handoff()}>{(plan) => (
          <section class="rounded-2xl border-2 border-emerald-700 bg-emerald-950/30 px-4 py-4">
            <h3 class="text-[20px] font-bold text-emerald-100">{HANDOFF.heading}</h3>
            <p class="mt-1 text-[16px] leading-relaxed text-emerald-100/90">{HANDOFF.intro}</p>
            <ul class="mt-3 flex flex-col gap-1">
              <For each={plan().files}>
                {(file) => (
                  <li class="text-[16px] leading-relaxed text-slate-200">
                    <span class="font-semibold text-slate-100">{HANDOFF.what(file.name)}</span>
                    <span class="ml-2 text-slate-400">{LOCATION[file.place]}</span>
                  </li>
                )}
              </For>
            </ul>
            <For each={plan().steps}>
              {(step) => (
                <p class="mt-1 text-[16px] leading-relaxed text-slate-200">{HANDOFF_STEP[step]}</p>
              )}
            </For>
            <p class="mt-3 text-[16px] leading-relaxed text-amber-200">{HANDOFF.notSent}</p>
          </section>
        )}</Show>

        <Show when={files().length === 0 && state() !== "failed" && state() !== "cancelled"}>
          <p class="rounded-2xl border border-slate-700 bg-slate-800/40 px-4 py-3 text-[16px] text-slate-300">
            这次没有生成新文件。
          </p>
        </Show>

        {/* r25 — 做完之后的那一步。她刚做成一件事，最自然的下一个动作就摆在这儿，
            点一下接着做（用刚做好的这份结果）。不是只显示一句话：按钮真的会把目录里
            那张卡摆到确认页上。绝不建议任何自动发送的动作。 */}
        <Show when={nextSteps().length > 0}>
          <section class="rounded-2xl border-2 border-sky-700 bg-sky-950/30 px-4 py-4">
            <h3 class="text-[20px] font-semibold text-sky-100">{NEXT_STEP.heading}</h3>
            <p class="mt-1 text-[16px] leading-relaxed text-sky-200/90">{NEXT_STEP.hint}</p>
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <For each={nextSteps()}>
                {(step) => (
                  <button
                    type="button"
                    onClick={() => void startNext(step)}
                    class="min-h-[52px] rounded-xl bg-sky-500 px-6 text-[18px] font-bold text-slate-950 hover:bg-sky-400"
                  >
                    {step.label}
                  </button>
                )}
              </For>
            </div>
          </section>
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

        {/* #140 — 撤销的结果就在这里说：三种结果三句话，撤销失败时绝不说「已撤回」。 */}
        <Notice text={props.store.notice()} kinds={UNDO_KINDS} />

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
          <Show when={run()?.undone === true && !undoNoticeShown()}>
            <span class="rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-2 text-[16px] text-emerald-200">
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
