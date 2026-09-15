// The composer: one multiline field bound to the store's draft, plus Send/Stop.
//
// Enter sends, Shift+Enter inserts a newline, ↑/↓ walk the prompt history (the
// in-progress draft is restored at the end). A leading `/` opens the live
// command palette above the field: the store owns the query, the highlight,
// completion, and dismissal, so the palette behaviour is unit-tested without a
// DOM and this component only wires the keys and the rows.
import { Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
import { CommandList } from "./CommandPalette.tsx";

export interface ComposerProps {
  store: Store;
  busy: boolean;
}

const MAX_ROWS = 6;
const LINE = 20;
const SLASH_LIST_ID = "cante-slash-command-list";

export default function Composer(props: ComposerProps): JSX.Element {
  const store = props.store;
  const [height, setHeight] = createSignal(40);
  let field: HTMLTextAreaElement | undefined;

  const resize = (): void => {
    if (!field) return;
    field.style.height = "auto";
    const next = Math.min(field.scrollHeight, LINE * MAX_ROWS + 16);
    field.style.height = `${next}px`;
    setHeight(next);
  };

  onMount(() => {
    resize();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (store.paletteVisible()) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        store.movePalette(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        store.movePalette(-1);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        store.completePalette();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        store.dismissPalette();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // No match means the daemon may still own the name; send it as typed.
        if (store.paletteMatches().length > 0) void store.runPalette();
        else void store.submit();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void store.submit();
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey) {
      const atStart = field ? field.selectionStart === 0 : true;
      if (atStart) {
        event.preventDefault();
        store.historyPrev();
      }
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey) {
      const atEnd = field ? field.selectionStart === field.value.length : true;
      if (atEnd) {
        event.preventDefault();
        store.historyNext();
      }
    }
  };

  return (
    <div class="w-full shrink-0 border-t border-slate-800 bg-[#0e141b]">
      <Show when={store.paletteVisible()}>
        <div class="border-b border-slate-800 px-3 py-2">
          <CommandList
            commands={store.paletteMatches()}
            selected={store.paletteIndex()}
            onSelect={(index) => store.selectPalette(index)}
            onRun={(command) => {
              void store.runPaletteCommand(command);
              field?.focus();
            }}
            listId={SLASH_LIST_ID}
          />
        </div>
      </Show>

      <div class="flex w-full items-end gap-2 px-3 py-2">
        <textarea
          ref={(node) => {
            field = node ?? undefined;
          }}
          rows={1}
          value={store.draft()}
          style={{ height: `${height()}px` }}
          spellcheck={false}
          aria-label="Message Cante"
          aria-autocomplete="list"
          aria-expanded={store.paletteVisible()}
          aria-controls={SLASH_LIST_ID}
          aria-activedescendant={
            store.paletteVisible() && store.paletteMatches().length > 0
              ? `${SLASH_LIST_ID}-${store.paletteIndex()}`
              : undefined
          }
          placeholder="Ask Cante…  (/  for commands)"
          onInput={(event) => {
            store.setDraft(event.currentTarget.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          class="min-h-[38px] flex-1 resize-none rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500"
        />

        <button
          type="button"
          onClick={() => void store.submit()}
          disabled={store.draft().trim().length === 0}
          aria-label="Send message"
          class="h-[38px] w-[74px] shrink-0 rounded-md bg-sky-600 text-sm font-bold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
        >
          SEND
        </button>

        <button
          type="button"
          onClick={() => void store.interrupt()}
          title="Interrupt (⌘.)"
          aria-label={props.busy ? "Stop the running turn (⌘.)" : "Interrupt (⌘.)"}
          class={`h-[38px] w-[74px] shrink-0 rounded-md text-sm font-bold text-slate-100 ${props.busy ? "bg-red-600 hover:bg-red-500" : "bg-slate-800 hover:bg-slate-700"}`}
        >
          STOP
        </button>
      </div>
    </div>
  );
}
