// Plain-language failure view (#44).
//
// Every failure is shown as 发生了什么 + 你可以怎么做, never as a raw English
// stack trace. The technical text is still available — behind 复制详情 — so it
// can be forwarded to someone who can read it.
import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { COMMON, ERROR_VIEW, explainError } from "./copy.ts";

export interface ErrorViewProps {
  /** Anything thrown below: a string, an Error, or a `TaskRun.error`. */
  error: unknown;
  onRetry?(): void;
  onAlternative?(): void;
  /** Called after the detail was copied (for analytics/history, optional). */
  onCopied?(): void;
  onBack?(): void;
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

export default function ErrorView(props: ErrorViewProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const human = (): ReturnType<typeof explainError> => explainError(props.error);

  async function onCopy(): Promise<void> {
    const detail = human().detail || `${human().what}\n${human().how}`;
    const ok = await copyText(detail);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) props.onCopied?.();
  }

  return (
    <div class="flex h-full min-h-0 w-full items-center justify-center overflow-y-auto px-5 py-8">
      <div class="w-full max-w-xl rounded-2xl border border-amber-900/70 bg-[#1a1410] px-6 py-7">
        <h1 class="text-[24px] leading-tight font-bold text-amber-300">{ERROR_VIEW.title}</h1>

        <h2 class="mt-5 text-[20px] font-semibold text-slate-200">{ERROR_VIEW.whatTitle}</h2>
        <p class="mt-1 text-[17px] leading-relaxed text-slate-300">{human().what}</p>

        <h2 class="mt-5 text-[20px] font-semibold text-slate-200">{ERROR_VIEW.howTitle}</h2>
        <p class="mt-1 text-[17px] leading-relaxed text-slate-300">{human().how}</p>

        <div class="mt-6 flex flex-col gap-3 sm:flex-row">
          <Show when={props.onRetry}>
            <button
              type="button"
              onClick={() => props.onRetry?.()}
              class="min-h-[52px] flex-1 rounded-xl bg-sky-600 px-5 text-[18px] font-semibold text-white hover:bg-sky-500"
            >
              {COMMON.retry}
            </button>
          </Show>
          <Show when={props.onAlternative}>
            <button
              type="button"
              onClick={() => props.onAlternative?.()}
              class="min-h-[52px] flex-1 rounded-xl border border-slate-600 px-5 text-[18px] font-semibold text-slate-100 hover:border-slate-400"
            >
              {COMMON.alternative}
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void onCopy()}
            class="min-h-[52px] flex-1 rounded-xl border border-slate-700 px-5 text-[18px] font-semibold text-slate-300 hover:border-slate-500"
          >
            {copied() ? COMMON.copied : COMMON.copyDetail}
          </button>
        </div>

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
