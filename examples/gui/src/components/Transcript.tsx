// The conversation surface: a fixed-row-height virtualized transcript.
//
// VirtualList v1 is uniform-height, so every entry renders as one 96px card —
// a kind chip, a bounded body, and (for tools) a muted detail line. Full text
// lives behind a press, which opens the detail modal.
import { Focusable, Text, View } from "@pocketjs/framework/components";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import { Show } from "solid-js";

import type { Row } from "../store.ts";

export const ROW_HEIGHT = 96;

function toneText(tone: Row["tone"]): string {
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

function bodyText(kind: Row["kind"]): string {
  if (kind === "thinking") return "text-sm text-slate-400 leading-5";
  if (kind === "tool") return "text-sm text-slate-200 leading-5";
  if (kind === "error") return "text-sm text-red-300 leading-5";
  if (kind === "turn") return "text-sm text-slate-400 leading-5";
  if (kind === "info") return "text-sm text-slate-500 leading-5";
  return "text-sm text-slate-100 leading-5";
}

function cardBg(kind: Row["kind"]): string {
  if (kind === "user") return "w-full h-[96] flex-col justify-center px-4 py-2 bg-sky-950 border-b border-slate-800";
  if (kind === "tool") return "w-full h-[96] flex-col justify-center px-4 py-2 bg-slate-900 border-b border-slate-800";
  if (kind === "error") return "w-full h-[96] flex-col justify-center px-4 py-2 bg-red-950 border-b border-slate-800";
  if (kind === "turn") return "w-full h-[96] flex-col justify-center px-4 py-2 bg-slate-950 border-b border-slate-800";
  return "w-full h-[96] flex-col justify-center px-4 py-2 bg-[#0b0f14] border-b border-slate-800 focus:bg-slate-900";
}

/** Clip a row body for the fixed-height card; the modal holds the full text. */
function clip(text: string, limit = 220): string {
  const flat = text.replace(/\s+\n/g, "\n").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export interface TranscriptProps {
  rows: Row[];
  height: number;
  onOpen(row: Row): void;
  inputActive(): boolean;
}

export default function Transcript(props: TranscriptProps) {
  return (
    <View class="flex-1 w-full">
      <VirtualList
        count={props.rows.length}
        rowHeight={ROW_HEIGHT}
        height={props.height}
        stickToBottom
        inputActive={props.inputActive}
        onRowPress={(index) => {
          const row = props.rows[index];
          if (row) props.onOpen(row);
        }}
        renderRow={(index) => {
          const row = props.rows[index];
          if (!row) return <View class="w-full h-[96]" />;
          return (
            <Focusable class={cardBg(row.kind)}>
              <View class="flex-row items-center gap-2">
                <Text class={toneText(row.tone)}>{row.label.toUpperCase()}</Text>
                <Text class="text-xs text-slate-600">{row.time}</Text>
                <Show when={row.streaming}>
                  <Text class="text-xs text-sky-500">●</Text>
                </Show>
              </View>
              <Text class={bodyText(row.kind)}>{clip(row.text)}</Text>
              <Show when={row.detail}>
                <Text class="text-xs text-slate-500">{clip(row.detail, 120)}</Text>
              </Show>
            </Focusable>
          );
        }}
      />
    </View>
  );
}
