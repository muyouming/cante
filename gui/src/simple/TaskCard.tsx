// One task card on the simple home page (#38), plus the track record (#64).
//
// Deliberately oversized: a big tap target, a plain-Chinese title and one
// example line. No icon grids, no jargon. The whole card is the button.
//
// #64 — when this computer has actually run the job before, one extra line
// says how often it worked, and (if it ever failed) a second line opens the
// newest plain-Chinese reason. With no history the card renders exactly as it
// always did: no number, no encouragement, nothing invented.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { TRUST, evidenceLine } from "./copy.ts";
import { evidenceFor, failureFor } from "./evidence.ts";
import { HintChip } from "./HintText.tsx";
import { hintsIn } from "./hints.ts";
import type { TaskDef, TaskRun } from "./tasks/index.ts";

export interface TaskCardProps {
  task: TaskDef;
  onPress(task: TaskDef): void;
  /**
   * Finished runs from this computer (`store.runs()`), newest first. Optional
   * so the card still renders — without a single number — when the caller has
   * no history to hand it.
   */
  runs?: readonly TaskRun[];
}

export default function TaskCard(props: TaskCardProps): JSX.Element {
  const [showFailure, setShowFailure] = createSignal(false);
  const evidence = () => evidenceFor(props.runs ?? [], props.task.id);
  const failure = () => failureFor(props.runs ?? [], props.task.id);
  // 标题或例子里有她可能不认识的词时，各给一个问号入口。入口放在卡片按钮**外面**
  // ——按钮里不能再套按钮（点里面会连带触发整张卡），所以它是主按钮的兄弟。
  const words = () => hintsIn(`${props.task.title}\n${props.task.example}`);

  return (
    <div class="flex w-full flex-col gap-1.5">
      <button
        type="button"
        onClick={() => props.onPress(props.task)}
        aria-label={`${props.task.title}。${props.task.example}`}
        class="flex min-h-[104px] w-full flex-col items-start justify-center gap-2 rounded-2xl border border-slate-700 bg-[#141b24] px-5 py-4 text-left transition-colors hover:border-sky-500 hover:bg-[#182231]"
      >
        <span class="text-[20px] leading-snug font-semibold text-slate-100">
          {props.task.title}
        </span>
        <span class="text-[16px] leading-relaxed text-slate-400">{props.task.example}</span>
      </button>

      <Show when={words().length > 0}>
        <div class="flex flex-wrap items-center gap-2">
          <For each={words()}>
            {(matched) => <HintChip hint={matched.hint} term={matched.term} />}
          </For>
        </div>
      </Show>

      <Show when={evidence()}>
        {(track) => (
          <div class="rounded-xl border border-slate-800 bg-[#101720] px-4 py-2">
            <p class="text-[16px] leading-relaxed text-slate-300">
              {evidenceLine(track().runs, track().ok)}
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
                    <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
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
    </div>
  );
}
