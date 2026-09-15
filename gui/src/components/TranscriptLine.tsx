// One display line from `transcript.ts`, rendered identically in the rolling
// transcript and in the full-entry detail view. Kept separate so fenced code
// (mono) and unified diffs (colored) look the same everywhere.
import { Show } from "solid-js";
import type { JSX } from "solid-js";

import type { RowTone } from "../rows.ts";
import type { Line } from "../transcript.ts";

export function chipClass(tone: RowTone): string {
  switch (tone) {
    case "accent":
      return "text-xs text-sky-300 font-bold tracking-wide";
    case "ok":
      return "text-xs text-emerald-400 font-bold tracking-wide";
    case "warn":
      return "text-xs text-amber-400 font-bold tracking-wide";
    case "error":
      return "text-xs text-red-400 font-bold tracking-wide";
    case "muted":
      return "text-xs text-slate-500 font-bold tracking-wide";
    default:
      return "text-xs text-slate-300 font-bold tracking-wide";
  }
}

export function bodyClass(line: Line): string {
  if (line.diff === "add") return "text-sm font-mono text-emerald-300";
  if (line.diff === "del") return "text-sm font-mono text-red-300";
  if (line.diff === "hunk") return "text-sm font-mono text-sky-300";
  if (line.mono) return "text-sm font-mono text-slate-300";
  switch (line.tone) {
    case "accent":
      return "text-sm text-sky-200";
    case "ok":
      return "text-sm text-emerald-200";
    case "warn":
      return "text-sm text-amber-200";
    case "error":
      return "text-sm text-red-200";
    case "muted":
      return "text-sm text-slate-400";
    default:
      return "text-sm text-slate-100";
  }
}

export function rowClass(line: Line, highlighted: boolean): string {
  if (line.chrome) {
    return highlighted
      ? "bg-slate-800 border-t border-slate-700"
      : "bg-[#0e141b] border-t border-slate-800";
  }
  if (line.diff === "add") return "bg-emerald-950";
  if (line.diff === "del") return "bg-red-950";
  if (line.diff === "hunk") return "bg-sky-950";
  if (highlighted) return "bg-slate-800";
  switch (line.kind) {
    case "user":
      return "bg-sky-950";
    case "tool":
      return "bg-slate-900";
    case "error":
      return "bg-red-950";
    case "turn":
      return "bg-slate-950";
    default:
      return "bg-[#0b0f14]";
  }
}

export interface TranscriptLineProps {
  line: Line;
  /** Timestamp shown on the chrome line. */
  time?: string;
  highlighted?: boolean;
  onOpen?(): void;
}

export default function TranscriptLine(props: TranscriptLineProps): JSX.Element {
  const line = () => props.line;
  return (
    <div
      class={`flex h-full w-full items-center gap-2 overflow-hidden px-3 ${rowClass(line(), props.highlighted ?? false)} ${props.onOpen ? "cursor-pointer" : ""}`}
      onClick={() => props.onOpen?.()}
      title={line().chrome ? undefined : line().text}
    >
      <Show
        when={line().chrome}
        fallback={
          <span class={`${bodyClass(line())} ${line().mono || line().diff ? "whitespace-pre" : "truncate"}`}>
            {line().text || " "}
          </span>
        }
      >
        <span class={`shrink-0 ${chipClass(line().tone)}`}>{line().text}</span>
        <span class="shrink-0 text-xs text-slate-600">{props.time ?? ""}</span>
        <Show when={line().streaming}>
          <span class="shrink-0 text-xs text-sky-500">●</span>
        </Show>
      </Show>
    </div>
  );
}
