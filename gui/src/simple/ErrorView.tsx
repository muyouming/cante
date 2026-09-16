// Plain-language failure view (#44, r14).
//
// Every failure is shown as 发生了什么 + 你可以怎么做, never as a raw English
// stack trace. The technical text is still available — behind 复制详情 — so it
// can be forwarded to someone who can read it.
//
// The exits are not the old three generic ones (重试 / 换个方法 / 复制详情): the
// list is built by `actionsFor`, which reads the failure for checkable signs
// (EBUSY, ENOENT, Permission denied, 「我拿不准」 …) and names the one next step
// that actually applies — 关掉那个窗口再试 / 重新选一次文件 / 换个位置保存.
// When nothing is recognised it falls back to the three generic exits instead of
// inventing a specific button.
//
// A button only renders when the screen can actually carry the action out
// (a caller passed the matching handler); otherwise the action shows as a plain
// step, so there are never dead buttons. All the wording lives in
// copy-recovery.ts — this file is scanned by copy-guard, so it holds no Chinese
// literals of its own.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { COMMON, ERROR_VIEW, explainError } from "./copy.ts";
import { actionsFor } from "./recovery.ts";
import type { RecoveryAction, RecoveryContext } from "./recovery.ts";

export interface ErrorViewProps {
  /** Anything thrown below: a string, an Error, or a `TaskRun.error`. */
  error: unknown;
  onRetry?(): void;
  onAlternative?(): void;
  /** Called after the detail was copied (for analytics/history, optional). */
  onCopied?(): void;
  onBack?(): void;
  /**
   * Hand a specific recovery action to the screen that owns it (re-open the file
   * picker, save somewhere else, open the folder …). When a caller has not wired
   * this yet, the action falls back to `onRetry` / `onAlternative`; if neither
   * exists the action is shown as a plain step rather than a dead button.
   */
  onAction?(action: RecoveryAction): void;
  /** What this job needed, so the generic fallback picks a fitting exit. */
  context?: RecoveryContext;
}

async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection copy */
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

const BUTTON_CLASS =
  "min-h-[52px] w-full rounded-xl bg-sky-600 px-5 text-[18px] font-semibold text-white hover:bg-sky-500";
const STEP_CLASS =
  "min-h-[52px] w-full rounded-xl border border-slate-700 bg-[#0e141b] px-5 text-left text-[18px] font-semibold text-slate-200";

export default function ErrorView(props: ErrorViewProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const human = (): ReturnType<typeof explainError> => explainError(props.error);
  const actions = (): RecoveryAction[] => actionsFor(human(), props.context);

  async function onCopy(): Promise<void> {
    const detail = human().detail || `${human().what}\n${human().how}`;
    const ok = await copyText(detail);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) props.onCopied?.();
  }

  /** The callback a button fires, or null when the screen cannot carry it out. */
  function handlerFor(item: RecoveryAction): (() => void) | null {
    if (item.kind === "copy-detail") return () => void onCopy();
    if (props.onAction) return () => props.onAction?.(item);
    switch (item.kind) {
      case "retry":
      case "close-file":
        // 关掉窗口之后的下一步就是重跑，所以这两类都走「再试一次」。
        return props.onRetry ? () => props.onRetry?.() : null;
      case "pick-files":
      case "explain-in-words":
      case "save-elsewhere":
      case "open-folder":
        return props.onAlternative ? () => props.onAlternative?.() : null;
      default:
        return null;
    }
  }

  function labelFor(item: RecoveryAction): string {
    return item.kind === "copy-detail" && copied() ? COMMON.copied : item.label;
  }

  return (
    <div class="flex h-full min-h-0 w-full items-center justify-center overflow-y-auto px-5 py-8">
      <div class="w-full max-w-xl rounded-2xl border border-amber-900/70 bg-[#1a1410] px-6 py-7">
        <h1 class="text-[24px] leading-tight font-bold text-amber-300">{ERROR_VIEW.title}</h1>

        <h2 class="mt-5 text-[20px] font-semibold text-slate-200">{ERROR_VIEW.whatTitle}</h2>
        <p class="mt-1 text-[17px] leading-relaxed text-slate-300">{human().what}</p>

        <h2 class="mt-5 text-[20px] font-semibold text-slate-200">{ERROR_VIEW.howTitle}</h2>
        <p class="mt-1 text-[17px] leading-relaxed text-slate-300">{human().how}</p>

        <ul class="mt-5 flex flex-col gap-4">
          <For each={actions()}>
            {(item) => {
              const run = handlerFor(item);
              return (
                <li class="flex flex-col">
                  <Show
                    when={run}
                    fallback={
                      <p class={STEP_CLASS}>
                        <span class="mr-2 text-slate-500">→</span>
                        {item.label}
                      </p>
                    }
                  >
                    <button type="button" onClick={() => run?.()} class={BUTTON_CLASS}>
                      {labelFor(item)}
                    </button>
                  </Show>
                  <p class="mt-1.5 text-[16px] leading-relaxed text-slate-400">{item.why}</p>
                </li>
              );
            }}
          </For>
        </ul>

        <Show when={copyFailed()}>
          <p class="mt-3 text-[16px] text-amber-400" role="alert">
            {COMMON.copyFailed}
          </p>
        </Show>

        <Show when={human().detail}>
          <details class="mt-5 rounded-xl border border-slate-800 bg-[#0e141b] px-4 py-3">
            <summary class="cursor-pointer text-[16px] text-slate-400">
              {ERROR_VIEW.detailToggle}
            </summary>
            <p class="mt-2 text-[16px] text-slate-500">{ERROR_VIEW.detailHint}</p>
            <pre class="mt-2 max-h-52 overflow-auto text-[16px] leading-relaxed break-all whitespace-pre-wrap text-slate-400">
              {human().detail}
            </pre>
          </details>
        </Show>

        <Show when={props.onBack}>
          <button
            type="button"
            onClick={() => props.onBack?.()}
            class="mt-5 min-h-[48px] w-full rounded-xl px-5 text-[17px] text-slate-400 hover:text-slate-200"
          >
            {COMMON.back}
          </button>
        </Show>
      </div>
    </div>
  );
}
