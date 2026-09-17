// First-run wizard (#39): at most three steps, all Chinese, big buttons, and
// nothing to type — no paths, no keys.
//
// r24 — 最后一步不只是「开始使用」：她第一次用这类工具，最该知道的三件事（两条
// 路都行 / 动手前先问你 / 原来的东西不乱动）和第一句话可以怎么说的三句例子都在
// 那里；点中哪一句，进去首页的框里就已经填好了（见 copy-first-run.ts）。
//
// Readiness comes from `invoke("health")`. “管理员配置存在时直接跳过” is a
// browser-side check (`shouldShowWizard`): a machine an administrator has
// already provisioned carries a marker, and the wizard never appears. See the
// report for the exact keys.
import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { COMMON, WIZARD, WIZARD_HEALTH } from "./copy.ts";
import {
  FIRST_RUN,
  SAY_EXAMPLES,
  beginFirstRun,
  rememberSentence,
  type SayExample,
} from "./copy-first-run.ts";
import { adminConfigured, initAdminConfig } from "./admin-config.ts";
import { copyDaemonDetails, daemonNotice, probeDaemon } from "./daemon.ts";
import type { DaemonCapability } from "./daemon.ts";
import { invoke, isBridgeAvailable, type Health } from "../tauri.ts";

/** Set once the person has finished the wizard. */
export const WIZARD_DONE_KEY = "cante:wizard:done";
/**
 * Admin/provisioned marker. An administrator (or a packaging script) can set
 * either the localStorage key or `window.__CANTE_PROVISIONED__`; when present
 * the wizard is skipped entirely.
 */
export const WIZARD_PROVISIONED_KEY = "cante:provisioned";

function readFlag(key: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, "1");
  } catch {
    /* a locked-down webview can refuse storage; the wizard just shows again */
  }
}

/** True when this machine was provisioned by an administrator. */
export function isProvisioned(): boolean {
  if (readFlag(WIZARD_PROVISIONED_KEY)) return true;
  try {
    if (
      typeof window !== "undefined" &&
      (window as { __CANTE_PROVISIONED__?: unknown }).__CANTE_PROVISIONED__ === true
    ) {
      return true;
    }
  } catch {
    /* no window (tests / SSR) */
  }
  return false;
}

/** True when the first-run wizard should be shown at all. */
export function shouldShowWizard(): boolean {
  // #58 — 技术同事统一设过这台电脑时，向导不该出现（配置是异步读到的，所以
  // Wizard 挂载后还会再确认一次并立刻让位给首页）。
  return !readFlag(WIZARD_DONE_KEY) && !isProvisioned() && !adminConfigured();
}

/** Remember that the wizard was finished, so it does not come back. */
export function markWizardDone(): void {
  writeFlag(WIZARD_DONE_KEY);
}

export interface WizardProps {
  /** The person finished (or chose to skip) the wizard. */
  onDone(): void;
}

type Step = "welcome" | "check" | "done";

const STEPS: readonly Step[] = ["welcome", "check", "done"];

export default function Wizard(props: WizardProps): JSX.Element {
  const [step, setStep] = createSignal<Step>("welcome");
  const [checking, setChecking] = createSignal(false);
  const [health, setHealth] = createSignal<Health | null>(null);
  const [bridgeMissing, setBridgeMissing] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  // #103 — 这台电脑有没有那个真正干活的组件。null 是「没问出答案」（探测失败 /
  // 浏览器预览），不是「缺组件」；只有明确的「不在」才显示那一节。
  const [daemon, setDaemon] = createSignal<DaemonCapability | null>(null);
  const [daemonCopied, setDaemonCopied] = createSignal(false);
  const [daemonCopyFailed, setDaemonCopyFailed] = createSignal(false);
  // r24 — 她在最后一步点的那句例子（点了就暂存给首页的输入框）。
  const [picked, setPicked] = createSignal<string | null>(null);

  const stepIndex = (): number => STEPS.indexOf(step());
  const ready = (): boolean =>
    !bridgeMissing() && !failed() && health()?.ok === true && !!health()?.cante;

  const notice = (): ReturnType<typeof daemonNotice> => daemonNotice(daemon());

  const problem = (): string => {
    if (bridgeMissing()) return WIZARD_HEALTH.bridge;
    const result = health();
    if (result && (!result.ok || !result.cante)) return notice()?.what ?? WIZARD_HEALTH.engine;
    return WIZARD_HEALTH.unknown;
  };

  async function onCopyDaemon(): Promise<void> {
    const ok = await copyDaemonDetails(daemon());
    setDaemonCopied(ok);
    setDaemonCopyFailed(!ok);
  }

  async function runCheck(): Promise<void> {
    setChecking(true);
    setFailed(false);
    setBridgeMissing(false);
    setDaemon(null);
    setDaemonCopied(false);
    setDaemonCopyFailed(false);
    if (!isBridgeAvailable()) {
      // Plain browser preview: there is no desktop host to reach.
      setHealth(null);
      setBridgeMissing(true);
      setChecking(false);
      return;
    }
    try {
      const result = await invoke("health");
      setHealth(result);
      if (result.ok && result.cante) markWizardDone();
      // 能力探测单独走一条，它只回答「组件在不在」；问不到就当没答案。
      setDaemon(await probeDaemon());
    } catch {
      setHealth(null);
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }

  function goCheck(): void {
    setStep("check");
    void runCheck();
  }

  /**
   * r24 — 最后一步点一条例子：记下这一句，并暂存起来给首页的输入框。
   *
   * 这一步不结束向导（她还要点「开始使用」），所以点一下必须看得见地选中；
   * 首页那边一打开就把它取走填进框里——「点一句，进去就填好了」不是空话。
   */
  function pickExample(example: SayExample): void {
    setPicked(example.sentence);
    rememberSentence(example.sentence);
  }

  function finish(): void {
    markWizardDone();
    props.onDone();
  }

  onMount(() => {
    // F5（#139）— 向导一开始就清一次暂存：上一次打开时她可能在此点了例子、却
    // 没点「开始使用」就退出了，那句话她并没有要，不能留到这一趟。
    beginFirstRun();
    // A provisioned machine should never see the wizard; App already checks,
    // but a late marker (config written between render and mount) is honoured.
    if (isProvisioned()) props.onDone();
    // #58 — 同上，管理员配置文件是异步读到的：读到 present 就立刻让位给首页。
    void initAdminConfig().then(() => {
      if (adminConfigured()) props.onDone();
    });
  });

  return (
    // F1 — 这里的 items-center + 内容比窗口高时会把顶部裁掉且滚不回去（最大窗口
    // 下标题整段消失）。所以外层只 justify-center，让内层用 m-auto 居中：
    // margin:auto 在溢出时归零，顶部不会被裁。
    <div class="flex h-full min-h-0 w-full justify-center overflow-y-auto px-5 py-8">
      <div class="m-auto w-full max-w-xl">
        <ol class="flex items-center justify-center gap-2" aria-label={WIZARD.progressLabel}>
          <For each={WIZARD.stepLabels}>
            {(label, index) => (
              <li class="flex items-center gap-2">
                <span
                  class="flex h-7 w-7 items-center justify-center rounded-full text-[16px] font-semibold"
                  classList={{
                    "bg-sky-600 text-white": index() <= stepIndex(),
                    "bg-slate-800 text-slate-400": index() > stepIndex(),
                  }}
                  aria-current={index() === stepIndex() ? "step" : undefined}
                >
                  {index() + 1}
                </span>
                <span class="text-[16px] text-slate-400">{label}</span>
                <Show when={index() < WIZARD.stepLabels.length - 1}>
                  <span class="h-px w-6 bg-slate-700" aria-hidden="true" />
                </Show>
              </li>
            )}
          </For>
        </ol>

        <div class="mt-7 rounded-2xl border border-slate-700 bg-[#141b24] px-6 py-7">
          <Show when={step() === "welcome"}>
            <h1 class="text-[26px] leading-tight font-bold text-slate-100">{WIZARD.welcomeTitle}</h1>
            <p class="mt-3 text-[17px] leading-relaxed text-slate-300">{WIZARD.welcomeBody}</p>
            <button
              type="button"
              onClick={goCheck}
              class="mt-6 min-h-[52px] w-full rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
            >
              {WIZARD.welcomeButton}
            </button>
          </Show>

          <Show when={step() === "check"}>
            <h1 class="text-[24px] leading-tight font-bold text-slate-100">{WIZARD.checkTitle}</h1>

            <Show when={checking()}>
              <p class="mt-4 text-[17px] text-slate-300" role="status">
                {WIZARD.checking}
              </p>
            </Show>

            <Show when={!checking() && ready()}>
              <p class="mt-4 text-[20px] font-semibold text-emerald-400">{WIZARD.readyTitle}</p>
              <p class="mt-2 text-[17px] leading-relaxed text-slate-300">{WIZARD.readyBody}</p>
              <button
                type="button"
                onClick={() => setStep("done")}
                class="mt-6 min-h-[52px] w-full rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
              >
                {WIZARD.readyButton}
              </button>
            </Show>

            <Show when={!checking() && !ready()}>
              <Show
                when={notice()}
                fallback={
                  <>
                    <p class="mt-4 text-[20px] font-semibold text-amber-400">
                      {WIZARD.notReadyTitle}
                    </p>
                    <p class="mt-2 text-[17px] leading-relaxed text-slate-300">
                      {problem()}
                      <Show when={bridgeMissing()}> {WIZARD.notReadyBody}</Show>
                    </p>
                    {/* #175 走查：这一支原来只有两行字，而上面那句写着「点「复制详情」…」
                        —— 屏幕上却没有这个按钮。这一支正是 Windows 上「文件在、起不来」
                        （杀软拦、缺运行库）会走到的形态，所以这里补上同一个动作，
                        而不是把那句承诺改弱。 */}
                    <button
                      type="button"
                      onClick={() => void onCopyDaemon()}
                      class="mt-4 min-h-[48px] w-full rounded-xl border border-slate-700 px-6 text-[17px] text-slate-200 hover:border-slate-500"
                    >
                      {daemonCopied() ? COMMON.copied : WIZARD.copyDetailLabel}
                    </button>
                    <Show when={daemonCopyFailed()}>
                      <p class="mt-2 text-[16px] text-amber-400" role="alert">
                        {WIZARD.copyDetailFailed}
                      </p>
                    </Show>
                  </>
                }
              >
                {(section) => (
                  <>
                    <p class="mt-4 text-[20px] font-semibold text-amber-400">{section().title}</p>
                    <p class="mt-2 text-[17px] leading-relaxed text-slate-300">{section().what}</p>
                    <p class="mt-2 text-[17px] leading-relaxed text-slate-300">{section().body}</p>
                    <p class="mt-2 text-[17px] leading-relaxed text-slate-300">
                      {section().action}
                    </p>
                    <button
                      type="button"
                      onClick={() => void onCopyDaemon()}
                      class="mt-4 min-h-[48px] w-full rounded-xl border border-slate-700 px-6 text-[17px] text-slate-200 hover:border-slate-500"
                    >
                      {daemonCopied() ? COMMON.copied : section().copyLabel}
                    </button>
                    <Show when={daemonCopyFailed()}>
                      <p class="mt-2 text-[16px] text-amber-400" role="alert">
                        {section().copyFailed}
                      </p>
                    </Show>
                  </>
                )}
              </Show>
              <button
                type="button"
                onClick={() => void runCheck()}
                class="mt-6 min-h-[52px] w-full rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
              >
                {WIZARD.recheckButton}
              </button>
              <button
                type="button"
                onClick={() => setStep("done")}
                class="mt-3 min-h-[48px] w-full rounded-xl border border-slate-700 px-6 text-[17px] text-slate-300 hover:border-slate-500"
              >
                {WIZARD.skipButton}
              </button>
            </Show>
          </Show>

          <Show when={step() === "done"}>
            {/* r24 — 最后一步不再只说「开始使用」：她第一次用这类工具，最需要知道
                的三件事就在这里（两条路都行 / 动手前先问你 / 原来的东西不乱动），
                加上三句照着改就能用的人话。 */}
            <h1 class="text-[24px] leading-tight font-bold text-slate-100">
              {FIRST_RUN.promisesTitle}
            </h1>
            <ul class="mt-3 space-y-2">
              <For each={FIRST_RUN.promises}>
                {(promise) => (
                  <li class="text-[17px] leading-relaxed text-slate-300">
                    <span class="font-semibold text-slate-100">{promise.lead}</span>
                    {promise.body}
                  </li>
                )}
              </For>
            </ul>

            {/* F6 — 这行是小标题，就得是标题字号：typography 的闸门只扫 h1/h2/h3。 */}
            <h2 class="mt-6 text-[20px] font-semibold text-slate-100">
              {FIRST_RUN.wizardExamplesTitle}
            </h2>
            <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
              {FIRST_RUN.wizardExamplesHint}
            </p>
            <ul class="mt-3 space-y-2">
              <For each={SAY_EXAMPLES}>
                {(example) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => pickExample(example)}
                      aria-pressed={picked() === example.sentence}
                      class="min-h-[52px] w-full rounded-xl border px-4 py-2 text-left"
                      classList={{
                        "border-sky-500 bg-sky-950/40": picked() === example.sentence,
                        "border-slate-700 hover:border-slate-500": picked() !== example.sentence,
                      }}
                    >
                      <span class="block text-[16px] text-slate-400">{example.level}</span>
                      <span class="block text-[17px] leading-snug text-slate-100">
                        {example.sentence}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>

            <button
              type="button"
              onClick={finish}
              class="mt-6 min-h-[52px] w-full rounded-xl bg-sky-600 px-6 text-[18px] font-semibold text-white hover:bg-sky-500"
            >
              {WIZARD.doneButton}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
