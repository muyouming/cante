// The conversation surface.
//
// PocketJS's VirtualList is uniform-row, so the transcript is rendered as a
// stream of 20px lines produced by `src/transcript.ts`: a header line per entry
// (kind chip + time) followed by wrapped body/output lines. Fenced code and
// unified diffs get the mono face and diff colors; long entries are capped and
// open in full from the detail modal.
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList, type VirtualListHandle } from "@pocketjs/framework/virtual-list";
import { Show, createMemo, createSignal } from "solid-js";

import type { Row } from "../rows.ts";
import { LINE_HEIGHT, columnsFor, createLayoutCache, type Line } from "../transcript.ts";

export interface TranscriptProps {
  rows: Row[];
  /** Content width in logical px (the list's own width). */
  width: number;
  height: number;
  onOpen(row: Row): void;
  inputActive(): boolean;
}

const layout = createLayoutCache();

function chipClass(tone: Line["tone"]): string {
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

function bodyText(line: Line): string {
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

function lineClass(line: Line, focused: boolean): string {
  if (line.chrome) {
    return focused
      ? "w-full h-full flex-row items-center gap-2 px-3 bg-slate-800 border-t border-slate-700"
      : "w-full h-full flex-row items-center gap-2 px-3 bg-[#0e141b] border-t border-slate-800";
  }
  if (line.diff === "add") return "w-full h-full flex-row items-center px-3 bg-emerald-950";
  if (line.diff === "del") return "w-full h-full flex-row items-center px-3 bg-red-950";
  if (line.diff === "hunk") return "w-full h-full flex-row items-center px-3 bg-sky-950";
  if (focused) return "w-full h-full flex-row items-center px-3 bg-slate-800";
  switch (line.kind) {
    case "user":
      return "w-full h-full flex-row items-center px-3 bg-sky-950";
    case "tool":
      return "w-full h-full flex-row items-center px-3 bg-slate-900";
    case "error":
      return "w-full h-full flex-row items-center px-3 bg-red-950";
    case "turn":
      return "w-full h-full flex-row items-center px-3 bg-slate-950";
    default:
      return "w-full h-full flex-row items-center px-3 bg-[#0b0f14]";
  }
}

export default function Transcript(props: TranscriptProps) {
  const [focusedLine, setFocusedLine] = createSignal<number | null>(null);
  let handle: VirtualListHandle | undefined;

  const lines = createMemo<Line[]>(() => {
    const columns = columnsFor(props.width);
    const monoColumns = columnsFor(props.width, true) - 2;
    return layout(props.rows, { columns, monoColumns });
  });

  // VirtualList owns focus; mirror its index so the focused line reads as such.
  onFrame(() => {
    const index = handle?.focusedIndex() ?? null;
    if (index !== focusedLine()) setFocusedLine(index);
  });

  return (
    <View class="flex-1 w-full">
      <VirtualList
        ref={(value) => {
          handle = value;
        }}
        count={lines().length}
        rowHeight={LINE_HEIGHT}
        height={props.height}
        stickToBottom
        inputActive={props.inputActive}
        onRowPress={(index) => {
          const line = lines()[index];
          const row = line ? props.rows[line.row] : undefined;
          if (row) props.onOpen(row);
        }}
        renderRow={(index) => {
          const line = lines()[index];
          if (!line) return <View class="w-full h-full" />;
          return (
            <View class={lineClass(line, focusedLine() === index)}>
              <Show
                when={line.chrome}
                fallback={<Text class={bodyText(line)}>{line.text || " "}</Text>}
              >
                <Text class={chipClass(line.tone)}>{line.text}</Text>
                <Text class="text-xs text-slate-600">{props.rows[line.row]?.time ?? ""}</Text>
                <Show when={line.streaming}>
                  <Text class="text-xs text-sky-500">●</Text>
                </Show>
              </Show>
            </View>
          );
        }}
      />
    </View>
  );
}
