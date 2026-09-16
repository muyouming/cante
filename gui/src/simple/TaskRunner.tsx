// The four-step runner: pick → say → confirm → result.
//
// Simple mode is not a chat window, so this is deliberately not one. The user
// picks the things, says what she wants in one sentence, reads a plain-Chinese
// plan of what is about to happen, presses 开始, and then reads a result card.
// There is exactly one decision on screen at a time, every button is a full
// sentence, and nothing technical is ever named.
//
// The screen never touches files itself: selection, the run record, the
// snapshot/undo and the result card all come from the frozen store and the
// trusted components. It only arranges them.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";
import { isBridgeAvailable } from "../tauri.ts";
import { PROGRESS_COPY } from "./copy.ts";
// r13 — 排队里的事：每一件动手前还是会先停下来问她。
import { QUEUE } from "./copy-queue.ts";
import { jobFor, nextWaiting, positionOf, queueSummary, type QueuedJob } from "./queue.ts";
import { formatElapsed, type RunProgressView } from "./progress.ts";
import type { TaskDef, TaskError, TaskRun } from "./tasks/index.ts";
import ApprovalSheet from "./ApprovalSheet.tsx";
import ConfirmSheet from "./ConfirmSheet.tsx";
import ResultCard from "./ResultCard.tsx";
import ErrorView from "./ErrorView.tsx";

/**
 * The store members this screen needs, on top of the frozen `Store`.
 *
 * They are optional here so the runner still renders (with a plain message)
 * while the trust workstream is landing; after it lands they are always
 * present. The prop itself stays exactly `{ store: Store }`.
 */
export interface TaskRunnerProps {
  store: Store;
  task: TaskDef;
  /** The sentence the user typed on the home screen, if that is how they got here. */
  initialInstruction?: string;
  /** Called by 返回首页; the shell closes the runner. */
  onExit?: () => void;
}

interface TrustStore {
  pickFiles?: (opts?: { multiple?: boolean; extensions?: string[] }) => Promise<string[]>;
  pickFolder?: () => Promise<string | null>;
  currentRun?: Accessor<TaskRun | null>;
  startRun?: (task: { id: string; title: string; plan: string[] }, files: string[], instruction: string) => Promise<void>;
  confirmRun?: () => Promise<void>;
  cancelRun?: () => void;
  undoRun?: (id: string) => Promise<void>;
}

type Step = "pick" | "say" | "confirm" | "running" | "result" | "error";

const STEP_LABELS = ["选文件", "说需求", "确认", "结果"] as const;

/** The final fallback when the run failed without a readable reason. */
const UNKNOWN_ERROR: TaskError = {
  what: "这次没有做完",
  how: "原来的文件都还在，没有被改动。可以点「再试一次」，或者返回首页换一个任务。",
  detail: "",
};

/** The last path segment, on both separators (Windows uses `\`). */
function nameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function TaskRunner(props: TaskRunnerProps): JSX.Element {
  const store = props.store as Store & TrustStore;

  const [phase, setPhase] = createSignal<"pick" | "say">(
    props.task.needs === "files" || props.task.needs === "folder" ? "pick" : "say",
  );
  const [picked, setPicked] = createSignal<string[]>([]);
  const [folder, setFolder] = createSignal<string | null>(null);
  const [instruction, setInstruction] = createSignal(props.initialInstruction ?? "");
  const [busy, setBusy] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);
  const [localError, setLocalError] = createSignal<string | null>(null);

  const pickable = (): boolean => props.task.needs === "files" || props.task.needs === "folder";

  /** The files (or the one folder) this run should act on. */
  const selection = (): string[] => {
    if (props.task.needs === "folder") {
      const chosen = folder();
      return chosen ? [chosen] : [];
    }
    return picked();
  };

  const currentRun = (): TaskRun | null => (dismissed() ? null : (store.currentRun?.() ?? null));

  // r13 — 队列把下一件摆到确认页时，先把上一件的结果留给她看完。
  //
  // 不这么做的话，后一件的确认页会直接盖在结果卡片上（确认页是整屏的），
  // 她就会看不见上一件到底做成了什么、也没机会点「一键撤销」。所以：只要
  // store 里还存着一件"做完了、结果没看过"的事，就先显示它。
  const unseenResult = (): TaskRun | null => {
    const finished = store.lastFinished?.() ?? null;
    if (!finished) return null;
    const current = currentRun();
    if (current && current.id === finished.id) return null;
    if (current && current.state === "running") return null;
    return finished;
  };
  /** 屏幕上这一屏说的是哪一次：刚做完还没看的那件，或者手上这件。 */
  const shownRun = (): TaskRun | null => unseenResult() ?? currentRun();

  // 排队里有没有手里这件（按内容配对）。有，就说明它已经在最前面了。
  // 只看还没做完的那些：她从结果卡片「再跑一次」时，内容会和已做完的那件一模一样。
  const stagedJob = (): QueuedJob | null => {
    const run = currentRun();
    if (!run) return null;
    const open = store.queue().filter((item) => item.state === "waiting" || item.state === "running");
    return jobFor(open, {
      taskId: run.taskId,
      instruction: run.instruction,
      files: run.files,
    });
  };
  const queueFacts = () => queueSummary(store.queue());

  // 队列把新的一件摆到确认页时（跳过、或者上一件做完了），这一屏要跟过去：
  // 本地的 `dismissed` 不能把新摆上来的那件挡掉。
  let followedRunId: string | null = null;
  createEffect(() => {
    const run = store.currentRun?.() ?? null;
    if (!run || run.id === followedRunId) return;
    followedRunId = run.id;
    if (run.state === "preview" || run.state === "running") setDismissed(false);
  });

  // #62 — the live checklist. Falls back to an empty plan so a store without
  // the member still renders instead of throwing.
  const progress = (): RunProgressView =>
    store.progress?.() ?? { steps: [], startedAt: null, elapsedMs: 0 };

  const step = createMemo<Step>(() => {
    // 上一件的结果还没看完：先把结果给她，下一件的确认页不许盖上来。
    const unseen = unseenResult();
    if (unseen) return unseen.state === "failed" ? "error" : "result";
    const run = currentRun();
    if (run) {
      switch (run.state) {
        case "draft":
        case "preview":
          return "confirm";
        case "running":
          return "running";
        case "done":
          return "result";
        case "failed":
          return "error";
        default:
          break;
      }
    }
    return phase();
  });

  const activeStep = (): number => {
    switch (step()) {
      case "pick":
        return 0;
      case "say":
        return 1;
      case "confirm":
        return 2;
      default:
        return 3;
    }
  };

  // ---------------------------------------------------------------------
  // Step 1 — pick the files or the folder
  // ---------------------------------------------------------------------

  async function chooseFiles(): Promise<void> {
    setLocalError(null);
    if (!store.pickFiles) {
      setLocalError("这个版本还不能选文件，请换一个任务，或者更新一下程序。");
      return;
    }
    try {
      const paths = await store.pickFiles({ multiple: true, extensions: props.task.accept });
      if (paths && paths.length > 0) {
        setPicked((list) => {
          const seen = new Set(list);
          const added = paths.filter((path) => path && !seen.has(path));
          return [...list, ...added];
        });
      }
    } catch {
      setLocalError("没能打开文件选择窗口，请再试一次。");
    }
  }

  async function chooseFolder(): Promise<void> {
    setLocalError(null);
    if (!store.pickFolder) {
      setLocalError("这个版本还不能选文件夹，请换一个任务，或者更新一下程序。");
      return;
    }
    try {
      const path = await store.pickFolder();
      if (path) setFolder(path);
    } catch {
      setLocalError("没能打开文件夹选择窗口，请再试一次。");
    }
  }

  // Real drag-and-drop when the desktop host is there; the button is the
  // fallback and the hint below tells the truth either way.
  const canDrop = isBridgeAvailable();
  onMount(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      stop?.();
    });
    if (!canDrop || !pickable()) return;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "over" || payload.type === "enter") setDropping(true);
          else if (payload.type === "leave") setDropping(false);
          else if (payload.type === "drop") {
            setDropping(false);
            const paths = payload.paths.filter(Boolean);
            if (paths.length === 0) return;
            if (props.task.needs === "folder") setFolder(paths[0]!);
            else setPicked((list) => [...list, ...paths.filter((path) => !list.includes(path))]);
          }
        });
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
      } catch {
        // No desktop host: the hint says to use the button, so nothing is lost.
      }
    })();
  });

  function removePicked(path: string): void {
    setPicked((list) => list.filter((item) => item !== path));
    setLocalError(null);
  }

  // ---------------------------------------------------------------------
  // Step 2 — the one-line request, then hand it over
  // ---------------------------------------------------------------------

  async function plan(): Promise<void> {
    setLocalError(null);
    if (!instruction().trim()) {
      setLocalError("先用一句话说说你要做什么，我照着你说的做。");
      return;
    }
    if (!store.startRun) {
      setLocalError("这个版本还不能开始做，请更新一下程序。");
      return;
    }
    setBusy(true);
    setDismissed(false);
    try {
      await store.startRun(
        { id: props.task.id, title: props.task.title, plan: props.task.plan },
        selection(),
        instruction().trim(),
      );
    } catch {
      setLocalError("没能开始，请稍后再试一次。原来的文件没有被动过。");
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Step 3 — confirm, run, cancel
  // ---------------------------------------------------------------------

  async function confirm(): Promise<void> {
    setLocalError(null);
    if (!store.confirmRun) {
      setLocalError("这个版本还不能开始做，请更新一下程序。");
      return;
    }
    setBusy(true);
    try {
      await store.confirmRun();
    } catch {
      setLocalError("开始的时候出了问题，请再试一次。");
    } finally {
      setBusy(false);
    }
  }

  function cancel(): void {
    store.cancelRun?.();
    setDismissed(true);
    setLocalError(null);
    setPhase(pickable() ? "pick" : "say");
  }

  function restart(): void {
    setLocalError(null);
    setInstruction("");
    setPicked([]);
    setFolder(null);
    // 队列里还有一件停在确认页上等她：那就跟过去，不要再回到选文件那一步。
    // 如果上一件的结果正摆在屏幕上（队列顶上来的），这个按钮的意思就是"结果
    // 看过了，去下一件"。
    const staged = store.currentRun?.() ?? null;
    if (staged && (staged.state === "preview" || staged.state === "running")) {
      if (store.lastFinished?.()) store.dismissRun();
      setDismissed(false);
      return;
    }
    setDismissed(true);
    setPhase(pickable() ? "pick" : "say");
  }

  // ---------------------------------------------------------------------
  // r13 — 排队（一次说好几件事，一件件来）
  // ---------------------------------------------------------------------

  /** 手里这件在队列里排第几件（1 起）；不在里面就是 null。 */
  function queuePosition(): number | null {
    const run = currentRun();
    if (!run) return null;
    return positionOf(store.queue(), {
      taskId: run.taskId,
      instruction: run.instruction,
      files: run.files,
    });
  }

  /** 确认页上那一条要说的话：它排第几，或者"还没排进去"。 */
  function queueLine(): string {
    const position = queuePosition();
    const remaining = queueFacts().remaining;
    return position ? QUEUE.stripHere(position, remaining) : QUEUE.stripInsert(remaining);
  }

  /**
   * r13 — 先把这件记下来，回去挑下一件。
   *
   * 排上以后**不会开始做**：轮到的每一件都还是要她在确认页上点「开始」。
   * 这就是"一次说好几件事"要的那点准备。
   */
  function queueForLater(): void {
    const text = instruction().trim();
    if (!text) return;
    store.enqueue({
      taskId: props.task.id,
      taskTitle: props.task.title,
      plan: props.task.plan,
      files: selection(),
      instruction: text,
    });
    props.onExit?.();
  }

  /** 「先做这件」：手里这件插到最前面；已经排在最前面的就什么都不用变。 */
  function keepThisOne(): void {
    store.keepStagedFirst();
  }

  /**
   * 「跳过，做下一件」。
   *
   * 跳过不等于取消：队里那件直接拿掉，下一件被摆到确认页（仍然要她点头）。
   * 她是从卡片直接进来的（这件不在队里）时，只把手里这件放下，再去做队里那件。
   */
  function skipThisOne(): void {
    const job = stagedJob();
    if (job) {
      store.removeFromQueue(job.id);
      return;
    }
    store.cancelRun();
    store.startNextQueued();
  }

  async function undo(run: TaskRun): Promise<void> {
    setLocalError(null);
    if (!store.undoRun) {
      setLocalError("这个版本还不能撤销，请到原文件夹里手动恢复。");
      return;
    }
    try {
      await store.undoRun(run.id);
    } catch {
      setLocalError("撤销没有成功，结果文件还在原来的位置，没有丢。");
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const impactLine = (run: TaskRun): string => {
    const parts: string[] = [];
    if (run.impact.created > 0) parts.push(`新增 ${run.impact.created} 个文件`);
    if (run.impact.modified > 0) parts.push(`改动 ${run.impact.modified} 个`);
    if (run.impact.deleted > 0) parts.push(`移除 ${run.impact.deleted} 个`);
    if (run.impact.messages > 0) parts.push(`整理 ${run.impact.messages} 条消息`);
    return parts.length > 0 ? parts.join(" · ") : "不会动到原来的文件";
  };

  const button =
    "min-h-[44px] rounded-lg bg-sky-600 px-5 py-3 text-base font-semibold text-white shadow hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400";
  const quietButton =
    "min-h-[44px] rounded-lg border border-slate-700 px-4 py-2.5 text-[16px] text-slate-300 hover:border-slate-500 hover:text-slate-100";

  return (
    <div class="flex h-full w-full flex-col overflow-hidden bg-[#0b0f14] text-slate-100">
      <header class="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <div class="min-w-0">
          <h1 class="text-[20px] font-semibold">{currentRun()?.taskTitle ?? props.task.title}</h1>
          <p class="mt-0.5 text-[16px] text-slate-400">说一句话就行，剩下的我来做</p>
        </div>
        <Show when={props.onExit}>
          <button type="button" class={quietButton} onClick={() => props.onExit?.()}>
            返回首页
          </button>
        </Show>
      </header>

      <ol class="flex shrink-0 items-center gap-2 border-b border-slate-800 px-5 py-2 text-[16px]">
        <For each={STEP_LABELS}>
          {(label, index) => (
            <li class="flex items-center gap-2">
              <span
                class="flex h-5 w-5 items-center justify-center rounded-full"
                classList={{
                  "bg-sky-600 text-white": index() <= activeStep(),
                  "bg-slate-800 text-slate-400": index() > activeStep(),
                }}
              >
                {index() + 1}
              </span>
              <span classList={{ "text-slate-200": index() === activeStep(), "text-slate-500": index() !== activeStep() }}>
                {label}
              </span>
              <Show when={index() < STEP_LABELS.length - 1}>
                <span class="text-slate-700">—</span>
              </Show>
            </li>
          )}
        </For>
      </ol>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <Show when={localError()}>
          <div class="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-[16px] text-amber-100">
            {localError()}
          </div>
        </Show>

        {/* ---- Step 1: the files ---- */}
        <Show when={step() === "pick"}>
          <section class="mx-auto max-w-2xl">
            <Show
              when={props.task.needs === "folder"}
              fallback={
                <>
                  <button type="button" class={button} onClick={() => void chooseFiles()}>
                    选择文件
                  </button>
                  <p class="mt-2 text-[16px] text-slate-400">可以一次选多个文件</p>
                </>
              }
            >
              <button type="button" class={button} onClick={() => void chooseFolder()}>
                选择文件夹
              </button>
              <p class="mt-2 text-[16px] text-slate-400">选中要整理的那个文件夹就行</p>
            </Show>

            <div
              class="mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-[16px]"
              classList={{
                "border-sky-500 bg-sky-950/30 text-sky-100": dropping(),
                "border-slate-700 text-slate-400": !dropping(),
              }}
            >
              <Show when={canDrop} fallback={<>这里选不了的话，点上面的按钮也能选</>}>
                也可以把{props.task.needs === "folder" ? "文件夹" : "文件"}直接拖到这里
              </Show>
            </div>

            <Show when={selection().length > 0}>
              <ul class="mt-4 divide-y divide-slate-800 rounded-lg border border-slate-800">
                <For each={selection()}>
                  {(path) => (
                    <li class="flex items-center justify-between gap-3 px-3 py-2">
                      <span class="min-w-0 flex-1 truncate text-[16px] text-slate-200" title={nameOf(path)}>
                        {nameOf(path)}
                      </span>
                      <Show when={props.task.needs === "files"}>
                        <button
                          type="button"
                          class="shrink-0 min-h-[44px] text-[16px] text-slate-400 hover:text-slate-100"
                          onClick={() => removePicked(path)}
                        >
                          不要这个
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <div class="mt-6 flex items-center gap-3">
              <button
                type="button"
                class={button}
                disabled={selection().length === 0}
                onClick={() => setPhase("say")}
              >
                下一步
              </button>
              <span class="text-[16px] text-slate-500">
                {selection().length === 0 ? "先选一个" : `已经选了 ${selection().length} 个`}
              </span>
            </div>
          </section>
        </Show>

        {/* ---- Step 2: one sentence ---- */}
        <Show when={step() === "say"}>
          <section class="mx-auto max-w-2xl">
            <Show
              when={pickable()}
              fallback={
                <p class="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-[16px] text-slate-300">
                  这个任务不用选文件，直接说你要写什么就行。
                </p>
              }
            >
              <p class="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-[16px] text-slate-300">
                已经选好 {selection().length} 个，下面用一句话说说要做到什么程度。
              </p>
            </Show>

            <label class="mt-4 block text-[16px] font-medium text-slate-200" for="task-instruction">
              你要做什么
            </label>
            <textarea
              id="task-instruction"
              class="mt-2 w-full resize-none rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[16px] text-slate-100 placeholder:text-slate-500"
              rows={3}
              placeholder={props.task.example}
              value={instruction()}
              onInput={(event) => setInstruction(event.currentTarget.value)}
            />
            <div class="mt-2 flex items-center gap-3">
              <button
                type="button"
                class="min-h-[44px] text-[16px] text-sky-300 hover:text-sky-200"
                onClick={() => setInstruction(props.task.example)}
              >
                就照这个例子来
              </button>
              <span class="text-[16px] text-slate-500">只改几个字也行</span>
            </div>

            <div class="mt-6 flex items-center gap-3">
              <Show when={pickable()}>
                <button type="button" class={quietButton} onClick={() => setPhase("pick")}>
                  上一步
                </button>
              </Show>
              <button type="button" class={button} disabled={busy()} onClick={() => void plan()}>
                {busy() ? "正在准备…" : "生成计划"}
              </button>
            </div>

            {/* r13 — 她一次要办好几件（合表、查重、整理文件夹）：先把这件记下来，
                回去挑下一件。记下来的活只会在确认页上等她，不会自己动手。 */}
            <div class="mt-5 border-t border-slate-800 pt-4">
              <button
                type="button"
                class={quietButton}
                disabled={!instruction().trim()}
                onClick={() => queueForLater()}
              >
                {QUEUE.keepForLater}
              </button>
              <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{QUEUE.keepHint}</p>
            </div>
          </section>
        </Show>

        {/* ---- Step 3: confirm ---- */}
        {/* ---- Confirm ---- */}
        {/* The confirmation sheet owns the product's promises here: the plan, the
            estimated impact, the risks this task can hit, the dry run, and the red
            overwrite consent (issues #41, #42, #63). */}
        {/* `keyed` 是安全上的事，不是排版：队列会连着把不同的活摆到这一页上
            （跳过、上一件做完）。换了一件就必须重新开一张确认页，否则上一件
            勾过的"我同意直接改原来的文件"会跟到下一件上去。 */}
        <Show when={step() === "confirm" ? currentRun() : null} keyed>
          {(_staged) => (
            <section class="mx-auto max-w-2xl">
              <ConfirmSheet store={props.store} />
            </section>
          )}
        </Show>

        {/* ---- Paused for approval (#60) ---- */}
        {/* The daemon stops when it wants a tool it is unsure about. Without this
            screen the window simply looks frozen, which a non-technical user reads
            as "it broke". */}
        <ApprovalSheet store={props.store} />

        {/* ---- Running (#62) ---- */}
        {/* She is watching a job she handed over, not reading a chat log. So
            there is no spinner: the plan is a checklist that ticks itself off,
            the current step is named, and the elapsed time is real. */}
        <Show when={step() === "running"}>
          <section class="mx-auto max-w-2xl">
            <h2 class="text-[20px] font-semibold text-slate-100">{PROGRESS_COPY.title}</h2>
            <p class="mt-1 text-[16px] text-slate-400">{PROGRESS_COPY.hint}</p>

            <ol class="mt-4 space-y-2">
              <For each={progress().steps}>
                {(item, index) => (
                  <li
                    class="flex items-start gap-3 rounded-xl border px-4 py-3"
                    classList={{
                      "border-sky-500 bg-sky-950/30": item.state === "active",
                      "border-slate-800 bg-slate-900/40": item.state !== "active",
                      "opacity-55": item.state === "pending",
                    }}
                  >
                    <span
                      class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[16px] font-semibold"
                      classList={{
                        "bg-emerald-600 text-white": item.state === "done",
                        "bg-sky-600 text-white": item.state === "active",
                        "bg-slate-700 text-slate-300": item.state === "pending",
                      }}
                      aria-hidden="true"
                    >
                      {item.state === "done" ? "✓" : index() + 1}
                    </span>
                    <p
                      class="text-[16px] leading-relaxed"
                      classList={{
                        "font-semibold text-sky-100": item.state === "active",
                        "text-slate-300": item.state === "done",
                        "text-slate-500": item.state === "pending",
                      }}
                    >
                      {item.state === "active" ? PROGRESS_COPY.doing(item.text) : item.text}
                    </p>
                  </li>
                )}
              </For>
            </ol>

            <p class="mt-4 text-[16px] text-slate-200">
              {PROGRESS_COPY.elapsed(formatElapsed(progress().elapsedMs))}
              <span class="ml-2 text-slate-400">{PROGRESS_COPY.keepOpen}</span>
            </p>
            <p class="mt-2 text-[16px] text-slate-400">{PROGRESS_COPY.promise}</p>

            <div class="mt-6">
              <button
                type="button"
                class="min-h-[44px] rounded-lg border border-slate-700 px-5 text-[16px] text-slate-200 hover:border-slate-500 hover:text-slate-100"
                onClick={cancel}
              >
                {PROGRESS_COPY.stop}
              </button>
            </div>
          </section>
        </Show>

        {/* ---- Result ---- */}
        <Show when={step() === "result" ? shownRun() : null}>
          {(run) => (
            <section class="mx-auto max-w-2xl">
              <ResultCard store={props.store} run={run()} />
              {/* r13 — 队列已经把下一件摆到确认页上了：先把这次的结果看完。 */}
              <Show when={unseenResult()}>
                <div class="mt-4 rounded-2xl border border-sky-800 bg-sky-950/30 px-4 py-3">
                  <p class="text-[16px] leading-relaxed text-sky-100">{QUEUE.resultNote}</p>
                  <button
                    type="button"
                    class="mt-3 min-h-[48px] rounded-xl bg-sky-500 px-6 text-[16px] font-bold text-slate-950 hover:bg-sky-400"
                    onClick={() => store.dismissRun()}
                  >
                    {QUEUE.resultNext(queueFacts().remaining)}
                  </button>
                </div>
              </Show>
              <div class="mt-6 flex flex-wrap items-center gap-3">
                <Show when={store.undoRun}>
                  <button type="button" class={quietButton} onClick={() => void undo(run())}>
                    撤销这次操作
                  </button>
                </Show>
                <button type="button" class={button} onClick={restart}>
                  再做一个
                </button>
                <Show when={props.onExit}>
                  <button type="button" class={quietButton} onClick={() => props.onExit?.()}>
                    返回首页
                  </button>
                </Show>
              </div>
            </section>
          )}
        </Show>

        {/* ---- Failure ---- */}
        <Show when={step() === "error" ? shownRun() : null}>
          {(run) => (
            <section class="mx-auto max-w-2xl">
              <ErrorView error={run().error ?? UNKNOWN_ERROR} />
              <div class="mt-6 flex items-center gap-3">
                <button type="button" class={button} onClick={() => void plan()}>
                  再试一次
                </button>
                <button type="button" class={quietButton} onClick={restart}>
                  换一个任务
                </button>
                <Show when={props.onExit}>
                  <button type="button" class={quietButton} onClick={() => props.onExit?.()}>
                    返回首页
                  </button>
                </Show>
              </div>
            </section>
          )}
        </Show>
      </div>

      {/* r13 — 排队里的事：确认页开着的时候，这一条浮在它上面。

          为什么浮在上面：确认页（ConfirmSheet）是整屏的一张纸，盖住整个窗口，
          藏在它下面的东西她根本看不见。为什么钉在右上角：那张纸的按钮在右下角，
          底部一条横条会正好压住「开始」。右上角这块地方在纸的标题右边、头几行
          的右边，本来就是空的，压不到任何要她读的字和要她按的按钮。

          两个按钮都不动手——真的动手仍然是她在那张纸上点「开始」。后面没有排
          别的活时这一条不出现：那时没有"下一件"可跳，按钮就是个死按钮。 */}
      <Show when={step() === "confirm" && nextWaiting(store.queue()) !== null}>
        <section class="fixed top-4 right-4 z-[60] w-[21rem] max-w-[calc(100vw-2rem)] rounded-2xl border-2 border-sky-600 bg-slate-900/95 px-5 py-4 shadow-2xl">
          <h2 class="text-[20px] font-semibold text-sky-100">{QUEUE.stripTitle}</h2>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-200">{queueLine()}</p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" class={button} onClick={() => keepThisOne()}>
              {QUEUE.doThisOne}
            </button>
            <button type="button" class={quietButton} onClick={() => skipThisOne()}>
              {QUEUE.skipThisOne}
            </button>
          </div>
        </section>
      </Show>
    </div>
  );
}
