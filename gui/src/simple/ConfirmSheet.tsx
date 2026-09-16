// #42 — the page shown *before* anything happens.
//
// The promise to the user is "nothing runs until you have seen, in Chinese,
// exactly what is about to happen". So this sheet renders the task's fixed
// `plan` (never a model's paraphrase), the exact file list, the four kinds of
// impact, and a loud red warning whenever the plan touches one of the three
// red-line actions: deleting, overwriting, or mass-messaging.
//
// The safe choice is the default: the focus ring starts on 取消, and the
// overwrite checkbox is off and marked "不推荐".
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { TRUST, evidenceLine } from "./copy.ts";
import { sheetCapability, sheetFallbackNote } from "./capabilities.ts";
import { hasExcelFile } from "./copy-capability.ts";
import { evidenceFor, failureFor } from "./evidence.ts";
import { fileName, folderName, hasActiveRisk, planRisks } from "./run.ts";
import { risksForTask } from "./tasks/index.ts";
import type { Store } from "../store.ts";

export interface ConfirmSheetProps {
  store: Store;
}

const RISK_ICON: Record<string, string> = {
  delete: "🗑",
  overwrite: "✏️",
  messages: "✉️",
};

export default function ConfirmSheet(props: ConfirmSheetProps): JSX.Element {
  const [allowOverwrite, setAllowOverwrite] = createSignal(false);
  const [showAllFiles, setShowAllFiles] = createSignal(false);
  const [showFailure, setShowFailure] = createSignal(false);
  let cancelButton: HTMLButtonElement | undefined;

  const run = () => props.store.currentRun();
  const risks = () => planRisks(run()?.plan ?? []);
  const risky = () => hasActiveRisk(risks());
  const files = () => run()?.files ?? [];
  const visibleFiles = () => (showAllFiles() ? files() : files().slice(0, 6));
  // #75 — 选中的是 Excel，而这台电脑还读不了。这是边界，不是错误。
  const showSheetFallback = () => hasExcelFile(files()) && !sheetCapability().available;
  // #63 — the job's own known limits, straight from its card definition.
  const taskRisks = () => risksForTask(run()?.taskId ?? "");
  // #64 — what this computer's own history says, or nothing at all.
  const track = () => evidenceFor(props.store.runs(), run()?.taskId ?? "");
  const failure = () => failureFor(props.store.runs(), run()?.taskId ?? "");

  function focusCancel(element: HTMLButtonElement): void {
    cancelButton = element;
    queueMicrotask(() => {
      // Only steal focus if nothing else claimed it (e.g. a dialog opened).
      if (document.activeElement === document.body) element.focus();
    });
  }

  return (
    <Show when={run()?.state === "preview"}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.store.cancelRun();
        }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-label="动手前的确认"
          class="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-700 bg-slate-900 shadow-2xl"
        >
          <header class="border-b border-slate-800 px-6 py-5">
            <p class="text-[16px] text-slate-400">动手前，先给你看一眼</p>
            <h2 class="mt-1 text-2xl font-bold text-slate-50">{run()?.taskTitle}</h2>
          </header>

          <div class="flex-1 overflow-y-auto px-6 py-5">
            <h3 class="text-base font-semibold text-slate-200">它打算这样做</h3>
            <ol class="mt-2 space-y-2">
              <For each={run()?.plan ?? []}>
                {(step, index) => (
                  <li class="flex gap-3 text-base leading-relaxed text-slate-200">
                    <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[16px] text-slate-300">
                      {index() + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                )}
              </For>
            </ol>

            <Show when={taskRisks().length > 0}>
              <h3 class="mt-6 text-base font-semibold text-slate-200">{TRUST.limitsTitle}</h3>
              <ul class="mt-2 space-y-1.5">
                <For each={taskRisks()}>
                  {(risk) => (
                    <li class="flex gap-2 text-[16px] leading-relaxed text-amber-100/90">
                      <span aria-hidden="true" class="text-amber-400">•</span>
                      <span>{risk}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={track()}>
              {(record) => (
                <div class="mt-4 rounded-2xl border border-emerald-800 bg-emerald-950/30 px-4 py-3">
                  <p class="text-[16px] leading-relaxed text-emerald-100">
                    {evidenceLine(record().runs, record().ok)}
                  </p>
                  <Show when={failure()}>
                    {(bad) => (
                      <>
                        <button
                          type="button"
                          onClick={() => setShowFailure((open) => !open)}
                          aria-expanded={showFailure()}
                          class="mt-1 min-h-[44px] rounded-lg px-2 text-[16px] text-sky-300 hover:bg-slate-800"
                        >
                          {showFailure() ? TRUST.failureHide : TRUST.failureShow}
                        </button>
                        <Show when={showFailure()}>
                          <p class="mt-1 text-[16px] leading-relaxed text-slate-300">
                            {bad().when}：{bad().what}
                            {bad().how}
                          </p>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            <h3 class="mt-6 text-base font-semibold text-slate-200">
              要处理的文件（{files().length} 个）
            </h3>
            <Show
              when={files().length > 0}
              fallback={<p class="mt-2 text-[16px] text-slate-400">这次不涉及文件，内容来自你写的话。</p>}
            >
              <ul class="mt-2 space-y-1">
                <For each={visibleFiles()}>
                  {(path) => (
                    <li class="truncate rounded-lg bg-slate-800/60 px-3 py-2 text-[16px] text-slate-200" title={path}>
                      {fileName(path)}
                      <span class="ml-2 text-[16px] text-slate-500">在 {folderName(path)}</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={files().length > visibleFiles().length}>
                <button
                  type="button"
                  onClick={() => setShowAllFiles(true)}
                  class="mt-2 min-h-[44px] rounded-lg px-2 text-[16px] text-sky-300 hover:bg-slate-800"
                >
                  还有 {files().length - visibleFiles().length} 个，全部展开
                </button>
              </Show>
            </Show>

            <Show when={showSheetFallback()}>
              <p class="mt-3 rounded-xl border border-sky-800 bg-sky-950/40 px-3 py-2 text-[16px] leading-relaxed text-sky-100">
                {sheetFallbackNote(sheetCapability())}
              </p>
            </Show>

            <h3 class="mt-6 text-base font-semibold text-slate-200">会影响什么</h3>
            <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <For each={risks()}>
                {(risk) => (
                  <div
                    class="rounded-xl border px-3 py-2"
                    classList={{
                      "border-rose-500/70 bg-rose-950/50": risk.active,
                      "border-slate-700 bg-slate-800/40": !risk.active,
                    }}
                  >
                    <p class="flex items-center gap-1 text-[16px] text-slate-400">
                      <span aria-hidden="true">{RISK_ICON[risk.kind]}</span>
                      {risk.label}
                    </p>
                    <p
                      class="mt-1 text-[16px] font-semibold"
                      classList={{ "text-rose-200": risk.active, "text-emerald-300": !risk.active }}
                    >
                      {risk.active ? "要留意" : "不会发生"}
                    </p>
                  </div>
                )}
              </For>
            </div>
            <p class="mt-2 text-[16px] text-slate-400">
              发消息一律是 0 条：这个功能不会自动发消息，只会整理成草稿。
            </p>

            <Show when={risky()}>
              <div class="mt-4 rounded-2xl border-2 border-rose-500 bg-rose-950/60 px-4 py-3">
                <p class="text-base font-bold text-rose-100">注意：这次会动到你的原文件</p>
                <p class="mt-1 text-[16px] text-rose-200">
                  上面标红的动作会改动原文件。虽然能撤销，但请先确认你不需要保留原件。
                </p>
              </div>
            </Show>

            <label class="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-700 bg-slate-800/40 px-4 py-3">
              <input
                type="checkbox"
                class="mt-1 h-5 w-5 accent-rose-500"
                checked={allowOverwrite()}
                onChange={(event) => setAllowOverwrite(event.currentTarget.checked)}
              />
              <span>
                <span class="block text-base text-slate-200">我同意直接改原来的文件（不推荐）</span>
                <span class="mt-1 block text-[16px] text-slate-400">
                  默认是不勾选的：结果会另存为新文件，原件一个字都不会变。
                </span>
              </span>
            </label>
            <Show when={allowOverwrite()}>
              <div class="mt-2 rounded-2xl border-2 border-rose-500 bg-rose-950/60 px-4 py-3 text-[16px] text-rose-100">
                你已经允许覆盖原文件。原件会被换掉；万不得已要还原，用「一键撤销」。
              </div>
            </Show>
          </div>

          <footer class="flex flex-wrap items-center justify-end gap-3 border-t border-slate-800 bg-slate-900 px-6 py-4">
            <button
              type="button"
              ref={focusCancel}
              onClick={() => props.store.cancelRun()}
              class="min-h-[52px] rounded-xl border border-slate-600 px-6 text-base font-semibold text-slate-200 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void props.store.dryRun()}
              class="min-h-[52px] rounded-xl border border-sky-600 px-6 text-base font-semibold text-sky-200 hover:bg-sky-950/60"
            >
              先试跑给我看（只看不动）
            </button>
            <button
              type="button"
              onClick={() => void props.store.confirmRun(allowOverwrite())}
              class="min-h-[52px] rounded-xl bg-sky-500 px-8 text-base font-bold text-slate-950 hover:bg-sky-400"
            >
              开始
            </button>
          </footer>
        </section>
      </div>
    </Show>
  );
}
