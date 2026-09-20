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
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { TRUST, TRY_FIRST, evidenceLine } from "./copy.ts";
import HintText from "./HintText.tsx";
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
// P0 — 确认页上「不用这个」：去掉一份文件是**只改输入、不动她的文件**。
import { CONFIRM_FILES, PASTES_CONTENT_GROUP } from "./copy-files.ts";
// P1 — 「手里这个文件可以做的事」：选完文件之后，按文件类型把最可能要做的那几件
// 摆出来。短句来自 copy-pick.ts，判断来自 pick.ts（纯逻辑、可单测）。
import { PICK_FROM_FILE } from "./copy-pick.ts";
import { suggestFromFiles, type PickSuggestion } from "./pick.ts";
import { visibleTasks } from "./admin-config.ts";
import { useFocusLayer } from "./FocusLayer.tsx";
import { inspectSelection, nothingReadable as nothingReadableVerdict } from "./format-check.ts";
import { evidenceFor, failureFor } from "./evidence.ts";
import { fileName, folderName, hasActiveRisk, planRisks } from "./run.ts";
import { FREE_TEXT_TASK_ID, risksForTask, taskById } from "./tasks/index.ts";
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
  // P0 — 这次在确认页上去掉过哪几份（只是不再当输入）。留着让她反悔：能加回来。
  const [removed, setRemoved] = createSignal<string[]>([]);
  // 「动手前先定好这几件事」——每一道题她选的是哪一条（题号 → 选项下标）。
  const [answers, setAnswers] = createSignal<Record<string, number>>({});
  let cancelButton: HTMLButtonElement | undefined;

  const run = () => props.store.currentRun();
  const risks = () => planRisks(run()?.plan ?? []);
  const risky = () => hasActiveRisk(risks());
  const files = () => run()?.files ?? [];
  const visibleFiles = () => (showAllFiles() ? files() : files().slice(0, 6));
  // 这件事要不要她选的文件。卡片不在（旧记录）时退回自由任务：它也要文件。
  const def = () => taskById(run()?.taskId ?? "");
  const needsFiles = (): boolean => {
    const card = def();
    if (card) return card.needs === "files" || card.needs === "folder";
    return (run()?.taskId ?? "") === FREE_TEXT_TASK_ID;
  };
  const needsFolder = (): boolean => def()?.needs === "folder";
  // 去掉过、现在确实不在这批输入里的那几份（她又用「再选一个」放回来的就不算）。
  const removedNow = (): string[] => removed().filter((path) => !files().includes(path));
  // 她把需要文件的这件事去到了一份不剩：这时才开始跑不了，得说清为什么 + 给条出路。
  //
  // 两个条件缺一不可：
  //   * `removedNow().length > 0`：只拦**她自己去掉**造成的空。微信那几张 needs "files"
  //     的卡可以一份文件都不选、内容整段贴在话里（`WechatImport` 的粘贴入口），
  //     只按「文件为空」去拦会把那条合法的粘贴路一起堵死；
  //   * `!pastesContent()`：微信族的文件是**加法不是门槛**（卡片自己的注释），即使她
  //     把选的文件都去掉了，贴进来的那段话仍然是输入——所以那一族不拦。
  const pastesContent = (): boolean => def()?.group === PASTES_CONTENT_GROUP;
  const removedAllFiles = (): boolean =>
    needsFiles() && !pastesContent() && files().length === 0 && removedNow().length > 0;
  // P1 — 「这个文件可以做的事」。只给**真要文件的**这件事看（文件夹那类给的是
  // 一个文件夹、微信那族的文件是加法不是门槛），而且要有文件在手。
  // 建议按**文件类型**给（xlsx / pdf / 图片各不同），每一句都指向一张真卡；
  // 认不出的类型返回空列表，界面照 PICK_FROM_FILE.noIdea 给通用出路，不硬凑。
  const ideasApply = (): boolean =>
    needsFiles() && !needsFolder() && !pastesContent() && files().length > 0;
  const rawFileIdeas = createMemo<PickSuggestion[]>(() =>
    ideasApply() ? suggestFromFiles(files(), visibleTasks()) : [],
  );
  // 她已经在这张卡上了：把这一条去掉。点它等于原地重开一次，白点一下还把她刚在
  // 上面定好的那几件事清掉（`startRun` 会重建这次）。去掉后一条不剩就整块不出现；
  // 但**认不出的类型**（本来就没有建议）仍要出现，好把通用出路说给她。
  const fileIdeas = createMemo<PickSuggestion[]>(() =>
    rawFileIdeas().filter((item) => item.task.id !== run()?.taskId),
  );
  const showFileIdeas = (): boolean =>
    ideasApply() && (rawFileIdeas().length === 0 || fileIdeas().length > 0);
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
    // 每开一张新的确认页，上一件去掉过哪几份不该跟过来。
    setRemoved([]);
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

  // P0 — 「不用这个」：只把这一份从这次的输入里去掉（`run.files`），不删她的文件。
  // 去掉后 `composedInstruction` 拼出的【要处理的文件】里就没有它了。
  function removeFile(path: string): void {
    props.store.removeRunFile(path);
    setRemoved((list) => (list.includes(path) ? list : [...list, path]));
  }

  /** 「加回来」：把刚去掉的那一份放回这次的输入；已有的不会重复。 */
  function restoreFile(path: string): void {
    props.store.addRunFile(path);
    setRemoved((list) => list.filter((item) => item !== path));
  }

  /**
   * P1 — 点一句「这个文件可以做的事」= 把这次换乘那张卡。
   *
   * 复用现有卡：换的就是目录里那张卡（`item.task`），文件和她刚说的话都带过去，
   * 只把计划换成那张卡的固定计划——**不新造任务，也不会绕开确认页直接动手**。
   * 她的话如果没打（理论上不会），就用这一句建议本身当原话。
   */
  async function useIdea(item: PickSuggestion): Promise<void> {
    const current = run();
    if (!current) return;
    try {
      await props.store.startRun(
        { id: item.task.id, title: item.task.title, plan: item.task.plan },
        current.files,
        current.instruction.trim() || item.sentence,
      );
    } catch {
      // 换不了就维持原来那张卡：她没丢东西，也不重复报警。
    }
  }

  /** 「再选一个」：重新打开选文件的窗口（文件夹类任务打开文件夹那一个）。 */
  async function pickAgain(): Promise<void> {
    try {
      if (needsFolder()) {
        const path = await props.store.pickFolder();
        if (path) props.store.addRunFile(path);
        return;
      }
      const paths = await props.store.pickFiles({ multiple: true, extensions: def()?.accept });
      for (const path of paths ?? []) props.store.addRunFile(path);
    } catch {
      // 窗口没打开：她已经看到 store 的提示，这里不重复第二遍。
    }
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
  // P0 — 需要文件的卡被去掉到一份不剩时，同样在开始按钮旁说清为什么。
  const blockNote = (): string | null => (removedAllFiles() ? CONFIRM_FILES.cannotStart : startBlockNote());
  // 上面那条判断只有一份（format-check.ts），选文件处用的是同一个函数。
  const nothingReadable = (): boolean => nothingReadableVerdict(verdict());
  const blockedFiles = (): string[] => {
    const now = verdict();
    return now.kind === "ok" ? [] : now.blocked;
  };

  // MUST-ANSWER：这张纸不响应 Esc（也不响应点背板）。原因写在 FocusLayer.tsx 的
  // 文件头：这是破坏性动作之前唯一的门，「取消」就在屏幕上、而且打开时就落在它上面
  // ——顺手按 Esc 让整页消失，她就没法确定那件事到底开始了没有。
  const layer = useFocusLayer({
    open: () => run()?.state === "preview",
    // 打开时焦点在「取消」上：产品律要的默认答案是安全的那一个。
    initialFocus: () => cancelButton,
  });

  return (
    <Show when={run()?.state === "preview"}>
      <div ref={layer} class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
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
                    <span>
                      <HintText text={step} />
                    </span>
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
              fallback={
                // 她把需要文件的这件事去到了一份不剩（刚去掉最后一个）：说清为什么
                // 现在不能开始 + 一条出路。只是「不拿它当输入」，她的文件一份没动。
                <Show
                  when={removedAllFiles()}
                  fallback={<p class="mt-2 text-[16px] text-slate-400">这次不涉及文件，内容来自你写的话。</p>}
                >
                  <div class="mt-2 rounded-xl border border-amber-600 bg-amber-950/40 px-4 py-3">
                    <p class="text-[20px] font-semibold text-amber-100">{CONFIRM_FILES.emptyHeading}</p>
                    <p class="mt-1 text-[16px] leading-relaxed text-amber-100/90">{CONFIRM_FILES.emptyBody}</p>
                    <p class="mt-1 text-[16px] leading-relaxed text-slate-200">{CONFIRM_FILES.emptyPickHint}</p>
                    <button
                      type="button"
                      onClick={() => void pickAgain()}
                      class="mt-2 min-h-[44px] rounded-lg border border-sky-500 px-4 text-[16px] font-semibold text-sky-100 hover:bg-sky-900/60"
                    >
                      {CONFIRM_FILES.pickAgain}
                    </button>
                  </div>
                </Show>
              }
            >
              <ul class="mt-2 space-y-1">
                <For each={visibleFiles()}>
                  {(path) => (
                    <li class="flex items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2">
                      <span class="min-w-0 flex-1 truncate text-[16px] text-slate-200" title={fileName(path)}>
                        {fileName(path)}
                        <span class="ml-2 text-[16px] text-slate-500">{CONFIRM_FILES.fileInFolder(folderName(path))}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={CONFIRM_FILES.removeLabel(fileName(path))}
                        onClick={() => removeFile(path)}
                        class="shrink-0 min-h-[44px] rounded-lg px-2 text-[16px] text-slate-300 hover:bg-slate-700 hover:text-slate-100"
                      >
                        {CONFIRM_FILES.removeOne}
                      </button>
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

            {/* 去掉过东西：列出来 + 一个「加回来」，去掉是能反悔的。 */}
            <Show when={removedNow().length > 0}>
              <div class="mt-3 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                <p class="text-[16px] font-semibold text-slate-200">{CONFIRM_FILES.removedHeading}</p>
                <ul class="mt-2 space-y-1">
                  <For each={removedNow()}>
                    {(path) => (
                      <li class="flex items-center gap-2">
                        <span class="min-w-0 flex-1 truncate text-[16px] text-slate-300" title={fileName(path)}>
                          {fileName(path)}
                          <span class="ml-2 text-[16px] text-slate-500">{CONFIRM_FILES.fileInFolder(folderName(path))}</span>
                        </span>
                        <button
                          type="button"
                          aria-label={CONFIRM_FILES.undoLabel(fileName(path))}
                          onClick={() => restoreFile(path)}
                          class="shrink-0 min-h-[44px] rounded-lg px-2 text-[16px] text-sky-300 hover:bg-slate-700"
                        >
                          {CONFIRM_FILES.undoRemove}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>

            {/* P1 — 手里这个文件可以做的事：按类型给几条人话，点一句就换成那张卡。
                最多 5 条（pick.ts 保证），认不出类型时给通用出路，不假装知道。 */}
            <Show when={showFileIdeas()}>
              <div class="mt-6 rounded-2xl border border-slate-700 bg-slate-800/40 px-4 py-4">
                <h3 class="text-[20px] font-semibold text-slate-200">{PICK_FROM_FILE.heading}</h3>
                <Show
                  when={fileIdeas().length > 0}
                  fallback={
                    <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{PICK_FROM_FILE.noIdea}</p>
                  }
                >
                  <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{PICK_FROM_FILE.hint}</p>
                  <ul class="mt-3 flex flex-col gap-2">
                    <For each={fileIdeas()}>
                      {(item) => (
                        <li>
                          <button
                            type="button"
                            onClick={() => void useIdea(item)}
                            class="min-h-[44px] w-full rounded-xl border border-sky-600 bg-sky-950/30 px-4 text-left text-base text-sky-100 hover:bg-sky-900/60"
                          >
                            {item.sentence}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
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

          {/* #192 A — 「先给我看一眼」单独成一条路：固定在按钮排上方（footer 在滚动区
              之外，一打开就看得见，不用先滚到底），用她的话说清「只看不动」。
              它故意是描边按钮、不是填色按钮，和「开始」不会混：危险动作的默认焦点
              仍然落在「取消」上（initialFocus 就是它），这条不会抢。 */}
          <footer class="border-t border-slate-800 bg-slate-900 px-6 py-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-700 bg-sky-950/40 px-4 py-3">
              <div class="min-w-0">
                <p class="text-base font-semibold text-sky-100">{TRY_FIRST.heading}</p>
                <p class="mt-1 text-[16px] leading-relaxed text-sky-200/90">{TRY_FIRST.hint}</p>
              </div>
              <button
                type="button"
                disabled={removedAllFiles()}
                onClick={() => void props.store.dryRun()}
                class="min-h-[52px] shrink-0 rounded-xl border border-sky-500 px-6 text-base font-semibold text-sky-100 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
              >
                {TRY_FIRST.action}
              </button>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-3">
              {/* #88 / P0 — 开始按钮被禁用时，理由得写在她点之前，而不是点完才知道。 */}
              <Show when={blockNote()}>
                {(note) => (
                  <p class="mr-auto max-w-md text-[16px] leading-relaxed text-amber-200">{note()}</p>
                )}
              </Show>
              <button
                type="button"
                ref={(element: HTMLButtonElement) => (cancelButton = element)}
                onClick={() => props.store.cancelRun()}
                class="min-h-[52px] rounded-xl border border-slate-600 px-6 text-base font-semibold text-slate-200 hover:bg-slate-800"
              >
                取消
              </button>
              <button
                type="button"
                disabled={nothingReadable() || removedAllFiles()}
                onClick={() => void props.store.confirmRun(allowOverwrite())}
                class="min-h-[52px] rounded-xl bg-sky-500 px-8 text-base font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                开始
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Show>
  );
}
