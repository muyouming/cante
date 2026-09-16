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
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";
import { isBridgeAvailable } from "../tauri.ts";
import { PROGRESS_COPY, formatElapsed, type RunProgressView } from "./progress.ts";
import type { TaskDef, TaskError, TaskRun } from "./tasks/index.ts";
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

  // #62 — the live checklist. Falls back to an empty plan so a store without
  // the member still renders instead of throwing.
  const progress = (): RunProgressView =>
    store.progress?.() ?? { steps: [], startedAt: null, elapsedMs: 0 };

  const step = createMemo<Step>(() => {
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
    setDismissed(true);
    setLocalError(null);
    setInstruction("");
    setPicked([]);
    setFolder(null);
    setPhase(pickable() ? "pick" : "say");
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
    "rounded-lg bg-sky-600 px-5 py-3 text-base font-semibold text-white shadow hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400";
  const quietButton =
    "rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100";

  return (
    <div class="flex h-full w-full flex-col overflow-hidden bg-[#0b0f14] text-slate-100">
      <header class="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <div class="min-w-0">
          <h1 class="truncate text-lg font-semibold">{props.task.title}</h1>
          <p class="mt-0.5 text-xs text-slate-400">说一句话就行，剩下的我来做</p>
        </div>
        <Show when={props.onExit}>
          <button type="button" class={quietButton} onClick={() => props.onExit?.()}>
            返回首页
          </button>
        </Show>
      </header>

      <ol class="flex shrink-0 items-center gap-2 border-b border-slate-800 px-5 py-2 text-xs">
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
          <div class="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
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
                  <p class="mt-2 text-xs text-slate-400">可以一次选多个文件</p>
                </>
              }
            >
              <button type="button" class={button} onClick={() => void chooseFolder()}>
                选择文件夹
              </button>
              <p class="mt-2 text-xs text-slate-400">选中要整理的那个文件夹就行</p>
            </Show>

            <div
              class="mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-sm"
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
                      <span class="min-w-0 flex-1 truncate text-sm text-slate-200" title={path}>
                        {nameOf(path)}
                      </span>
                      <Show when={props.task.needs === "files"}>
                        <button
                          type="button"
                          class="shrink-0 text-xs text-slate-400 hover:text-slate-100"
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
              <span class="text-xs text-slate-500">
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
                <p class="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
                  这个任务不用选文件，直接说你要写什么就行。
                </p>
              }
            >
              <p class="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-300">
                已经选好 {selection().length} 个，下面用一句话说说要做到什么程度。
              </p>
            </Show>

            <label class="mt-4 block text-sm font-medium text-slate-200" for="task-instruction">
              你要做什么
            </label>
            <textarea
              id="task-instruction"
              class="mt-2 w-full resize-none rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
              rows={3}
              placeholder={props.task.example}
              value={instruction()}
              onInput={(event) => setInstruction(event.currentTarget.value)}
            />
            <div class="mt-2 flex items-center gap-3">
              <button
                type="button"
                class="text-xs text-sky-300 hover:text-sky-200"
                onClick={() => setInstruction(props.task.example)}
              >
                就照这个例子来
              </button>
              <span class="text-xs text-slate-500">只改几个字也行</span>
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
          </section>
        </Show>

        {/* ---- Step 3: confirm ---- */}
        {/* ---- Confirm ---- */}
        {/* The confirmation sheet owns the product's promises here: the plan, the
            estimated impact, the risks this task can hit, the dry run, and the red
            overwrite consent (issues #41, #42, #63). */}
        <Show when={step() === "confirm"}>
          <section class="mx-auto max-w-2xl">
            <ConfirmSheet store={props.store} />
          </section>
        </Show>

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
                      class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold"
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
        <Show when={step() === "result" ? currentRun() : null}>
          {(run) => (
            <section class="mx-auto max-w-2xl">
              <ResultCard store={props.store} run={run()} />
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
        <Show when={step() === "error" ? currentRun() : null}>
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
    </div>
  );
}
