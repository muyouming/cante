// The conversation surface.
//
// `src/transcript.ts` turns rows into uniform 20px display lines — one chrome
// line per entry plus wrapped body/output lines — and the virtual list windows
// them. Clicking a line opens the full entry in `DetailModal`.
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { Row } from "../rows.ts";
import { LINE_HEIGHT, columnsFor, createLayoutCache, type Line } from "../transcript.ts";
import TranscriptLine from "./TranscriptLine.tsx";
import VirtualList from "./VirtualList.tsx";

const layout = createLayoutCache();

export interface TranscriptProps {
  rows: Row[];
  onOpen(row: Row): void;
}

export default function Transcript(props: TranscriptProps): JSX.Element {
  const [width, setWidth] = createSignal(720);
  let element: HTMLDivElement | undefined;

  onMount(() => {
    const node = element;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    onCleanup(() => observer.disconnect());
  });

  const lines = createMemo<Line[]>(() => {
    const columns = columnsFor(width());
    const monoColumns = Math.max(16, columnsFor(width(), true) - 2);
    return layout(props.rows, { columns, monoColumns });
  });

  return (
    <div
      ref={(node) => {
        element = node ?? undefined;
      }}
      class="relative min-h-0 w-full flex-1"
    >
      <VirtualList
        class="h-full w-full"
        count={lines().length}
        rowHeight={LINE_HEIGHT}
        stickToBottom
        renderRow={(index) => {
          const line = lines()[index];
          if (!line) return <div class="h-full w-full" />;
          const row = props.rows[line.row];
          return (
            <TranscriptLine
              line={line}
              time={row?.time}
              onOpen={() => {
                if (row) props.onOpen(row);
              }}
            />
          );
        }}
        empty={
          <div class="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            <Show when={props.rows.length === 0}>
              <span class="text-sm font-bold tracking-widest text-slate-600">CANTE</span>
              <span class="max-w-[420px] text-sm text-slate-500">
                Ask a question below, or press <span class="text-slate-300">⌘K</span> for commands.
                A leading <span class="font-mono text-slate-300">/</span> runs a skill or built-in.
              </span>
            </Show>
          </div>
        }
      />
    </div>
  );
}
