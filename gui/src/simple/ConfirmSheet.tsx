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
import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { TRUST, evidenceLine } from "./copy.ts";
import { PRE_ANSWER_COPY } from "./copy-preanswer.ts";
import type { PreAnswerDecision } from "./copy-preanswer.ts";
import {
  formatAdviceNote,
  formatStartBlockNote,
  pdfCapability,
  pdfFallbackNote,
  sheetCapability,
  sheetFallbackNote,
  syncVisionForPrompt,
  visionAvailable,
  visionFallbackNote,
} from "./capabilities.ts";
import { FORMAT_COPY, hasExcelFile, hasImageFile, hasPdfFile } from "./copy-capability.ts";
import { inspectSelection } from "./format-check.ts";
import { evidenceFor, failureFor } from "./evidence.ts";
import { fileName, folderName, hasActiveRisk, planRisks } from "./run.ts";
import { risksForTask } from "./tasks/index.ts";
import {
  defaultPreAnswerIndex,
  preAnswerDecisions,
  setPreAnswers,
} from "./tasks/prompt.ts";
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
  // 「动手前先定好这几件事」——每一道题她选的是哪一条（题号 → 选项下标）。
  const [answers, setAnswers] = createSignal<Record<string, number>>({});
  let cancelButton: HTMLButtonElement | undefined;

  const run = () => props.store.currentRun();
  const risks = () => planRisks(run()?.plan ?? []);
  const risky = () => hasActiveRisk(risks());
  const files = () => run()?.files ?? [];
  const visibleFiles = () => (showAllFiles() ? files() : files().slice(0, 6));
  // #75 — 选中的是 Excel，而这台电脑还读不了。这是边界，不是错误。
  const showSheetFallback = () => hasExcelFile(files()) && !sheetCapability().available;
  // #50 — 同上，选中的是 PDF 而这台电脑还处理不了。
  const showPdfFallback = () => hasPdfFile(files()) && !pdfCapability().available;
  // #48 — 选中的是图片，而当前这个设置看不了图。这是边界，不是错误。
  const showVisionFallback = () => hasImageFile(files()) && !visionAvailable(props.store.session());
  // #48 — 会话信息可能比首屏晚到；每变一次就把「能不能看图」同步进提示词信封，
  // 这样确认时拼出的指令里一定带着这条。
  createEffect(() => {
    syncVisionForPrompt(props.store.session());
  });
  // #63 — the job's own known limits, straight from its card definition.
  const taskRisks = () => risksForTask(run()?.taskId ?? "");
  // 把「她知道、我们非要问到一半才问」的问题挪到动手之前。
  // 两张表列名对不上按哪张算、隐藏行算不算——这些她一眼就能答，真机上助手却会跑到
  // 一半停下来问。所以：默认值先选好（就是卡片本来会做的那一种），她可以不改；
  // 选了什么必须真的进指令，否则界面问了也是白问。
  const decisions = (): readonly PreAnswerDecision[] => preAnswerDecisions(run()?.taskId ?? "");
  let syncedRunId = "";
  createEffect(() => {
    const staged = run();
    if (!staged || staged.state !== "preview" || staged.id === syncedRunId) return;
    syncedRunId = staged.id;
    // 每开一张新的确认页，先把她没动过的那些按默认值同步进指令。
    const defaults: Record<string, number> = {};
    for (const decision of preAnswerDecisions(staged.taskId)) {
      defaults[decision.id] = defaultPreAnswerIndex(decision);
    }
    setAnswers(defaults);
    setPreAnswers(staged.taskId, defaults);
  });

  function choosePreAnswer(decision: PreAnswerDecision, index: number): void {
    const next = { ...answers(), [decision.id]: index };
    setAnswers(next);
    setPreAnswers(run()?.taskId ?? "", next);
  }
  // #64 — what this computer's own history says, or nothing at all.
  const track = () => evidenceFor(props.store.runs(), run()?.taskId ?? "");
  const failure = () => failureFor(props.store.runs(), run()?.taskId ?? "");
  // #88 — 选中的文件里有没有我根本读不了的格式（WPS / 苹果自己的）。
  // 这件事必须在动手前说清：原来她要等跑了一会儿才知道。
  const verdict = () => inspectSelection(files());
  const verdictNote = () => formatAdviceNote(verdict());
  // 一个都读不了时，开始按钮旁边要写清为什么现在别点。
  const startBlockNote = () => formatStartBlockNote(verdict());
  const nothingReadable = (): boolean => {
    const now = verdict();
    return now.kind === "convert-first" || now.kind === "mixed-nothing-readable";
  };
  const blockedFiles = (): string[] => {
    const now = verdict();
    return now.kind === "convert-first" || now.kind === "some-unreadable" ? now.blocked : [];
  };

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
            <h3 class="text-[20px] font-semibold text-slate-200">它打算这样做</h3>
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

            {/* 动手前先定好这几件事：默认已经选好，不改也能直接开始。 */}
            <Show when={decisions().length > 0}>
              <h3 class="mt-6 text-[20px] font-semibold text-slate-200">{PRE_ANSWER_COPY.heading}</h3>
              <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{PRE_ANSWER_COPY.hint}</p>
              <For each={decisions()}>
                {(decision) => (
                  <fieldset class="mt-4">
                    <legend class="text-base leading-relaxed text-slate-200">{decision.question}</legend>
                    <For each={decision.options}>
                      {(option, index) => (
                        <label
                          class="mt-2 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border px-4 py-2"
                          classList={{
                            "border-sky-500 bg-sky-950/40": answers()[decision.id] === index(),
                            "border-slate-700 bg-slate-800/40": answers()[decision.id] !== index(),
                          }}
                        >
                          <input
                            type="radio"
                            name={decision.id}
                            class="mt-1 h-5 w-5 accent-sky-500"
                            checked={answers()[decision.id] === index()}
                            onChange={() => choosePreAnswer(decision, index())}
                          />
                          <span>
                            <span class="block text-base text-slate-100">
                              {option.label}
                              <Show when={option.isDefault}>
                                <span class="ml-2 text-[16px] text-slate-400">{PRE_ANSWER_COPY.defaultTag}</span>
                              </Show>
                            </span>
                            <span class="mt-1 block text-[16px] leading-relaxed text-slate-400">{option.note}</span>
                          </span>
                        </label>
                      )}
                    </For>
                  </fieldset>
                )}
              </For>
            </Show>

            <Show when={taskRisks().length > 0}>
              <h3 class="mt-6 text-[20px] font-semibold text-slate-200">{TRUST.limitsTitle}</h3>
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

            <h3 class="mt-6 text-[20px] font-semibold text-slate-200">
              要处理的文件（{files().length} 个）
            </h3>
            <Show
              when={files().length > 0}
              fallback={<p class="mt-2 text-[16px] text-slate-400">这次不涉及文件，内容来自你写的话。</p>}
            >
              <ul class="mt-2 space-y-1">
                <For each={visibleFiles()}>
                  {(path) => (
                    <li class="truncate rounded-lg bg-slate-800/60 px-3 py-2 text-[16px] text-slate-200" title={fileName(path)}>
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

            <Show when={showPdfFallback()}>
              <p class="mt-3 rounded-xl border border-slate-600 bg-slate-800/50 px-3 py-2 text-[16px] leading-relaxed text-slate-100">
                {pdfFallbackNote(pdfCapability())}
              </p>
            </Show>

            <Show when={showVisionFallback()}>
              <p class="mt-3 rounded-xl border border-slate-600 bg-slate-800/50 px-3 py-2 text-[16px] leading-relaxed text-slate-100">
                {visionFallbackNote(visionAvailable(props.store.session()))}
              </p>
            </Show>

            {/* #88 — 读不了的格式先说清：全部读不了时醒目但不吓人，部分读不了时中性。 */}
            <Show when={verdictNote()}>
              {(note) => (
                <div
                  class="mt-3 rounded-xl border px-4 py-3"
                  classList={{
                    "border-amber-600 bg-amber-950/40": nothingReadable(),
                    "border-slate-600 bg-slate-800/50": !nothingReadable(),
                  }}
                >
                  <p
                    class="text-[20px] font-semibold"
                    classList={{ "text-amber-100": nothingReadable(), "text-slate-100": !nothingReadable() }}
                  >
                    {FORMAT_COPY.heading}
                  </p>
                  <p
                    class="mt-1 text-[16px] leading-relaxed"
                    classList={{ "text-amber-100/90": nothingReadable(), "text-slate-200": !nothingReadable() }}
                  >
                    {note()}
                  </p>
                  <Show when={blockedFiles().length > 0}>
                    <ul class="mt-2 space-y-1">
                      <For each={blockedFiles()}>
                        {(path) => (
                          <li class="truncate rounded-lg bg-slate-900/60 px-3 py-2 text-[16px] text-slate-200" title={fileName(path)}>
                            {fileName(path)}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              )}
            </Show>

            <h3 class="mt-6 text-[20px] font-semibold text-slate-200">会影响什么</h3>
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
            {/* #88 — 开始按钮被禁用时，理由得写在她点之前，而不是点完才知道。 */}
            <Show when={startBlockNote()}>
              {(note) => (
                <p class="mr-auto max-w-md text-[16px] leading-relaxed text-amber-200">{note()}</p>
              )}
            </Show>
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
              disabled={nothingReadable()}
              onClick={() => void props.store.confirmRun(allowOverwrite())}
              class="min-h-[52px] rounded-xl bg-sky-500 px-8 text-base font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              开始
            </button>
          </footer>
        </section>
      </div>
    </Show>
  );
}
