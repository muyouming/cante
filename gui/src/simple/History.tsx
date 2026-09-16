// #57 — the history screen, the simplest version that answers three questions:
// what did I hand over, what did it touch, and where are the results?
//
// Every row can be acted on: open the result, show it in its folder, run the
// same job again, or undo it. Newest first, with a plain sentence when there is
// nothing yet — an empty box would make the user think the app is broken.
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

import { fileName, folderName, formatWhen } from "./run.ts";
import type { Store, TaskRun } from "../store.ts";

export interface HistoryProps {
  store: Store;
}

const STATE_LABEL: Record<TaskRun["state"], string> = {
  draft: "还没开始",
  preview: "等你确认",
  running: "正在做",
  done: "已完成",
  failed: "没做完",
  cancelled: "已停止",
};

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
  const runs = () => props.store.runs();

  async function rerun(run: TaskRun): Promise<void> {
    await props.store.startRun(
      { id: run.taskId, title: run.taskTitle, plan: run.plan },
      run.files,
      run.instruction,
    );
  }

  return (
    <section class="mx-auto flex w-full max-w-3xl flex-col gap-4" aria-label="我做过的事">
      <header>
        <h2 class="text-2xl font-bold text-slate-50">我做过的事</h2>
        <p class="mt-1 text-sm text-slate-400">按时间倒序，最近的在最上面。可以打开结果，也可以撤销。</p>
      </header>

      <Show
        when={runs().length > 0}
        fallback={
          <p class="rounded-2xl border border-slate-700 bg-slate-900 px-5 py-8 text-center text-base text-slate-400">
            还没有做过任何事情。回到首页，挑一件事交给我。
          </p>
        }
      >
        <ul class="flex flex-col gap-3">
          <For each={runs()}>
            {(run) => (
              <li class="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="min-w-0 flex-1 truncate text-lg font-semibold text-slate-100">
                    {run.taskTitle}
                  </p>
                  <span class={`rounded-full px-3 py-1 text-xs font-semibold ${stateClass(run.state)}`}>
                    {STATE_LABEL[run.state] ?? run.state}
                  </span>
                  <span class="text-xs text-slate-500">{formatWhen(run.createdAt)}</span>
                </div>

                <p class="mt-2 text-sm text-slate-300">
                  {run.files.length > 0
                    ? `处理了 ${run.files.length} 个文件：${run.files.slice(0, 3).map(fileName).join("、")}${
                        run.files.length > 3 ? ` 等` : ""
                      }`
                    : "没有选文件，内容来自你说的话"}
                </p>

                <Show
                  when={(run.result?.files.length ?? 0) > 0}
                  fallback={<p class="mt-1 text-sm text-slate-500">没有生成新文件</p>}
                >
                  <p class="mt-1 text-sm text-emerald-200">
                    结果：{run.result!.files.slice(0, 2).map((file) => fileName(file.path)).join("、")}
                    {run.result!.files.length > 2 ? ` 等 ${run.result!.files.length} 个` : ""}
                  </p>
                </Show>

                <Show when={run.failed?.length}>
                  <p class="mt-1 text-sm text-rose-200">
                    有 {run.failed?.length} 个文件没能自动还原，请按提示去文件夹里看看。
                  </p>
                </Show>

                <div class="mt-3 flex flex-wrap gap-2">
                  <Show when={(run.result?.files.length ?? 0) > 0}>
                    <button
                      type="button"
                      onClick={() => void props.store.openPath(run.result!.files[0]!.path)}
                      class="min-h-[44px] rounded-xl bg-sky-500 px-4 text-sm font-bold text-slate-950 hover:bg-sky-400"
                    >
                      打开结果
                    </button>
                    <button
                      type="button"
                      onClick={() => void props.store.revealPath(run.result!.files[0]!.path)}
                      class="min-h-[44px] rounded-xl border border-slate-600 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-800"
                    >
                      打开所在文件夹
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={() => void rerun(run)}
                    class="min-h-[44px] rounded-xl border border-slate-600 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                  >
                    再跑一次
                  </button>
                  <Show when={run.undone === true}>
                    <span class="rounded-xl border border-emerald-700 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-200">
                      已撤销
                    </span>
                  </Show>
                  <Show when={changed(run) && run.undone !== true}>
                    <button
                      type="button"
                      onClick={() => void props.store.undoRun(run.id)}
                      class="min-h-[44px] rounded-xl border-2 border-amber-500 px-4 text-sm font-bold text-amber-200 hover:bg-amber-950/40"
                    >
                      一键撤销
                    </button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
