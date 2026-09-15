// Full-content view for one transcript entry.
//
// The rolling transcript clips rows at 20px lines; this modal re-lays the same
// row with an unbounded budget so nothing is lost, and reuses `TranscriptLine`
// so fenced code stays mono and diffs stay coloured.
import { Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";

import type { Row } from "../rows.ts";
import { LINE_HEIGHT, layoutRow, type Line } from "../transcript.ts";
import Overlay from "./Overlay.tsx";
import TranscriptLine from "./TranscriptLine.tsx";
import VirtualList from "./VirtualList.tsx";

export interface DetailModalProps {
  row: Row | null;
  onClose(): void;
}

// The panel is max-w-[720px] with p-4, so ~672px of usable width.
const COLUMNS = 98;
const MONO_COLUMNS = 74;

export default function DetailModal(props: DetailModalProps): JSX.Element {
  const lines = createMemo<Line[]>(() => {
    const row = props.row;
    if (!row) return [];
    return layoutRow(row, 0, {
      columns: COLUMNS,
      monoColumns: MONO_COLUMNS,
      maxLinesPerRow: 100_000,
      maxOutputLines: 100_000,
    });
  });

  return (
    <Overlay open={props.row !== null} onClose={props.onClose} panelClass="max-w-[720px]">
      <Show when={props.row}>
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="text-base font-bold text-slate-50">{props.row?.label.toUpperCase()}</span>
            <span class="text-xs text-slate-500">{props.row?.time}</span>
            <span class="text-xs text-slate-600">{props.row?.kind}</span>
          </div>
          <button
            type="button"
            onClick={() => props.onClose()}
            class="h-[34px] w-[84px] rounded-md bg-slate-800 text-sm font-bold text-slate-100 hover:bg-slate-700"
          >
            CLOSE
          </button>
        </div>

        <VirtualList
          class="h-[330px] rounded-md border border-slate-800 bg-[#0b0f14]"
          count={lines().length}
          rowHeight={LINE_HEIGHT}
          renderRow={(index) => {
            const line = lines()[index];
            if (!line) return <div class="h-full w-full" />;
            return <TranscriptLine line={line} />;
          }}
        />
      </Show>
    </Overlay>
  );
}
