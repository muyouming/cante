// The active goal, pinned to one line above the composer.
//
// A goal is a standing instruction the daemon keeps working toward until its
// condition holds. The bar is mounted unconditionally and hides itself when no
// goal is set, so it costs one `Show` when idle. The tail shows the latest
// daemon note about the goal (confirmation, status, or a "kept working" line);
// `Clear` asks the daemon to end the loop.
//
// The store members are read through a local typed view (all optional) so the
// bar renders without throwing before the store workstream lands `goal()`, and
// the frozen prop shape stays exactly `{ store: Store }`.
import { Show, onMount } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";

export interface GoalBarProps {
  store: Store;
}

export interface GoalState {
  condition: string | null;
  note: string | null;
}

const NO_GOAL: GoalState = { condition: null, note: null };

type GoalStore = Store & {
  goal?: Accessor<GoalState>;
  clearGoal?: () => Promise<void>;
  requestGoalStatus?: () => Promise<void>;
};

export default function GoalBar(props: GoalBarProps): JSX.Element {
  const store = props.store as GoalStore;
  const goal = (): GoalState => store.goal?.() ?? NO_GOAL;

  // A goal can outlive a webview reload (and the daemon survives reconnects):
  // ask for the current condition once so a pre-existing goal is not invisible
  // until the next note happens to arrive.
  onMount(() => {
    void store.requestGoalStatus?.();
  });

  return (
    <Show when={goal().condition}>
      <div
        class="flex h-[28px] w-full shrink-0 items-center gap-2 border-t border-slate-800 bg-[#0e141b] px-3"
        role="status"
        aria-label="Active goal"
      >
        <span class="shrink-0 text-[10px] font-bold tracking-widest text-amber-300">GOAL</span>
        <span class="min-w-0 flex-1 truncate text-xs text-slate-200" title={goal().condition ?? ""}>
          {goal().condition}
        </span>
        <Show when={goal().note}>
          <span
            class="hidden min-w-0 max-w-[45%] truncate text-[10px] text-slate-500 sm:inline"
            title={goal().note ?? ""}
          >
            {goal().note}
          </span>
        </Show>
        <button
          type="button"
          class="shrink-0 rounded border border-slate-700 bg-slate-900 px-2 py-[1px] text-[10px] font-bold tracking-wide text-slate-200 hover:border-amber-500 hover:bg-slate-800"
          aria-label={`Clear the active goal: ${goal().condition ?? ""}`}
          onClick={(event) => {
            event.currentTarget.focus();
            void store.clearGoal?.();
          }}
        >
          CLEAR
        </button>
      </div>
    </Show>
  );
}
