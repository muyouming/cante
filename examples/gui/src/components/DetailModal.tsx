// Full-content view for one transcript entry.
//
// Fixed-height transcript rows clip; this modal shows the whole thing. The text
// is pre-wrapped into display lines and handed to a VirtualList, which keeps
// long tool output scrollable with the same gesture/d-pad model as the chat.
import { Focusable, Modal, Text, View } from "@pocketjs/framework/components";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import { Show, createMemo } from "solid-js";

import type { Row } from "../store.ts";

export interface DetailModalProps {
  row: Row | null;
  onClose(): void;
}

const LINE_HEIGHT = 20;
const LIST_HEIGHT = 330;
const COLUMNS = 84;

function wrap(text: string, columns = COLUMNS): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      out.push(" ");
      continue;
    }
    let rest = paragraph;
    while (rest.length > columns) {
      let cut = rest.lastIndexOf(" ", columns);
      if (cut <= 0) cut = columns;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

function toneClass(tone: Row["tone"]): string {
  switch (tone) {
    case "accent":
      return "text-sm text-sky-300 leading-5";
    case "ok":
      return "text-sm text-emerald-300 leading-5";
    case "warn":
      return "text-sm text-amber-300 leading-5";
    case "error":
      return "text-sm text-red-300 leading-5";
    case "muted":
      return "text-sm text-slate-400 leading-5";
    default:
      return "text-sm text-slate-100 leading-5";
  }
}

export default function DetailModal(props: DetailModalProps) {
  const lines = createMemo<string[]>(() => {
    const row = props.row;
    if (!row) return [];
    const body = wrap(row.text);
    const detail = row.detail ? ["", "— output —", ...wrap(row.detail)] : [];
    return [...body, ...detail];
  });

  return (
    <Modal
      open={props.row !== null}
      class="absolute inset-0 z-50 flex-col items-center justify-center"
      panelClass="flex-col gap-3 w-[720] p-4 rounded-xl shadow-lg bg-slate-900 border-slate-700"
    >
      <Show when={props.row}>
        <View class="flex-row items-center justify-between">
          <View class="flex-row items-center gap-2">
            <Text class="text-base text-slate-50 font-bold">{props.row?.label.toUpperCase()}</Text>
            <Text class="text-xs text-slate-500">{props.row?.time}</Text>
          </View>
          <Focusable
            onPress={props.onClose}
            class="h-[34] w-[84] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
          >
            <Text class="text-sm text-slate-100 font-bold">CLOSE</Text>
          </Focusable>
        </View>

        <VirtualList
          count={lines().length}
          rowHeight={LINE_HEIGHT}
          height={LIST_HEIGHT}
          inputActive={() => true}
          renderRow={(index) => {
            const line = lines()[index];
            if (line === undefined) return <View class="w-full h-[20]" />;
            return (
              <View class="w-full h-[20] flex-row items-center px-1">
                <Text class={toneClass(props.row?.tone ?? "neutral")}>{line || " "}</Text>
              </View>
            );
          }}
        />
      </Show>
    </Modal>
  );
}
