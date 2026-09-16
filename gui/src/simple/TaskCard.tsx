// One task card on the simple home page (#38).
//
// Deliberately oversized: a big tap target, a plain-Chinese title and one
// example line. No icon grids, no jargon. The whole card is the button.
import type { JSX } from "solid-js";

import type { TaskDef } from "./tasks/index.ts";

export interface TaskCardProps {
  task: TaskDef;
  onPress(task: TaskDef): void;
}

export default function TaskCard(props: TaskCardProps): JSX.Element {
  return (
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
  );
}
