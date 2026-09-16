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

import { fileName, folderName, onlineHint, onlineLabel } from "./run.ts";
import type { Store } from "../store.ts";

export interface ResultCardProps {
  store: Store;
}

const STATE_TITLE: Record<string, string> = {
  done: "做好了",
  failed: "这件事没有做完",
  cancelled: "已经停下",
};

export default function ResultCard(props: ResultCardProps): JSX.Element {
  const [showDetail, setShowDetail] = createSignal(false);
  const run = () => props.store.currentRun();
  const state = () => run()?.state ?? "done";
  const show = () => state() === "done" || state() === "failed" || state() === "cancelled";
  const files = () => run()?.result?.files ?? [];
  const changed = () => {
    const impact = run()?.impact;
    if (!impact) return false;
    return impact.created + impact.modified + impact.deleted > 0;
  };

  async function rerun(): Promise<void> {
    const current = run();
    if (!current) return;
    await props.store.startRun(
      { id: current.taskId, title: current.taskTitle, plan: current.plan },
      current.files,
      current.instruction,
    );
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
