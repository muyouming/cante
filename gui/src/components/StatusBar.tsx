// Bottom status strip: turn state, token accounting, context occupancy, steps,
// and the last notice the GUI wants the user to see. When the transcript is
// scrolled away from the tail it also carries the jump-back affordance, so the
// way back is visible even after the pill scrolls out of sight.
import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { formatTokens, type Store } from "../store.ts";

export interface StatusBarProps {
  store: Store;
  /** False while the transcript is scrolled up; omit to hide the affordance. */
  following?: boolean;
  onJumpToLatest?(): void;
}

function statusText(status: string): string {
  switch (status) {
    case "thinking":
      return "thinking";
    case "streaming":
      return "streaming";
    case "awaiting":
      return "awaiting approval";
    case "error":
      return "error";
    case "offline":
      return "daemon offline";
    default:
      return "idle";
  }
}

function statusTone(status: string): string {
  switch (status) {
    case "thinking":
      return "text-xs text-amber-300";
    case "streaming":
      return "text-xs text-sky-300";
    case "awaiting":
      return "text-xs font-bold text-amber-400";
    case "error":
      return "text-xs font-bold text-red-400";
    case "offline":
      return "text-xs text-red-400";
    default:
      return "text-xs text-slate-400";
  }
}

export default function StatusBar(props: StatusBarProps): JSX.Element {
  const store = props.store;

  const percent = (): number => {
    const context = store.context();
    if (!context || !context.limit_tokens) return 0;
    return Math.max(0, Math.min(100, Math.round((context.used_tokens / context.limit_tokens) * 100)));
  };

  return (
    <footer class="flex h-[28px] w-full shrink-0 items-center gap-4 border-t border-slate-800 bg-[#0e141b] px-3" aria-label="Session status">
      <span class={statusTone(store.daemonStatus())} aria-label={`Turn status: ${statusText(store.daemonStatus())}`}>
        {statusText(store.daemonStatus())}
      </span>

      <Show when={store.usage()}>
        <span class="text-xs text-slate-500">
          in {formatTokens(store.usage()?.input_tokens ?? 0)} · out {formatTokens(store.usage()?.output_tokens ?? 0)}
        </span>
      </Show>

      <Show when={store.context()}>
        <span class="flex items-center gap-2">
          <span class="text-xs text-slate-500">ctx</span>
          <span class="h-[6px] w-[104px] overflow-hidden rounded bg-slate-800">
            <span class="block h-[6px] rounded bg-emerald-500" style={{ width: `${Math.max(1, percent())}%` }} />
          </span>
          <span class="text-xs text-slate-400">{percent()}%</span>
        </span>
      </Show>

      <span class="text-xs text-slate-500">steps {store.steps()}</span>

      <Show when={props.following === false}>
        <button
          type="button"
          class="flex items-center gap-1 rounded border border-sky-800 bg-sky-950 px-2 py-[1px] text-xs text-sky-200 hover:bg-sky-900"
          onClick={() => props.onJumpToLatest?.()}
          aria-label="Scrolled back — jump to the latest output"
        >
          <span aria-hidden="true">↓</span>
          latest
        </button>
      </Show>

      <span class="flex-1" />

      {/* Always mounted so the live region exists before the first notice. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        class="max-w-[60%] truncate text-xs text-amber-400"
        title={store.notice() ?? ""}
      >
        {store.notice() ?? ""}
      </span>
    </footer>
  );
}
