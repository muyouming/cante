// First-run wizard (#39): at most three steps, all Chinese, big buttons, and
// nothing to type — no paths, no keys.
//
// Readiness comes from `invoke("health")`. “管理员配置存在时直接跳过” is a
// browser-side check (`shouldShowWizard`): a machine an administrator has
// already provisioned carries a marker, and the wizard never appears. See the
// report for the exact keys.
import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { WIZARD, WIZARD_HEALTH } from "./copy.ts";
import { adminConfigured, initAdminConfig } from "./admin-config.ts";
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

  const stepIndex = (): number => STEPS.indexOf(step());
  const ready = (): boolean =>
    !bridgeMissing() && !failed() && health()?.ok === true && !!health()?.cante;

  const problem = (): string => {
    if (bridgeMissing()) return WIZARD_HEALTH.bridge;
    const result = health();
    if (result && (!result.ok || !result.cante)) return WIZARD_HEALTH.engine;
    return WIZARD_HEALTH.unknown;
  };

  async function runCheck(): Promise<void> {
    setChecking(true);
    setFailed(false);
    setBridgeMissing(false);
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

  function finish(): void {
    markWizardDone();
    props.onDone();
  }

  onMount(() => {
    // A provisioned machine should never see the wizard; App already checks,
    // but a late marker (config written between render and mount) is honoured.
    if (isProvisioned()) props.onDone();
    // #58 — 同上，管理员配置文件是异步读到的：读到 present 就立刻让位给首页。
    void initAdminConfig().then(() => {
      if (adminConfigured()) props.onDone();
    });
  });

  return (
    <div class="flex h-full min-h-0 w-full items-center justify-center overflow-y-auto px-5 py-8">
      <div class="w-full max-w-xl">
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
              <p class="mt-4 text-[20px] font-semibold text-amber-400">{WIZARD.notReadyTitle}</p>
              <p class="mt-2 text-[17px] leading-relaxed text-slate-300">
                {problem()}
                <Show when={bridgeMissing()}> {WIZARD.notReadyBody}</Show>
              </p>
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
            <h1 class="text-[24px] leading-tight font-bold text-slate-100">{WIZARD.doneTitle}</h1>
            <p class="mt-3 text-[17px] leading-relaxed text-slate-300">{WIZARD.doneBody}</p>
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
