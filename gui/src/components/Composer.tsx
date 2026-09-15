// The composer: one multiline field bound to the store's draft, plus Send/Stop.
//
// Enter sends, Shift+Enter inserts a newline, ↑/↓ walk the prompt history (the
// in-progress draft is restored at the end), and a leading `/` shows the
// matching commands inline before the text is parsed by the store.
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { filterCommands } from "../commands.ts";
import type { Store } from "../store.ts";

export interface ComposerProps {
  store: Store;
  busy: boolean;
}

const MAX_ROWS = 6;
const LINE = 20;

export default function Composer(props: ComposerProps): JSX.Element {
  const store = props.store;
  const [height, setHeight] = createSignal(40);
  let field: HTMLTextAreaElement | undefined;

  const slashQuery = createMemo<string | null>(() => {
    const value = store.draft();
    if (!value.startsWith("/")) return null;
    const body = value.slice(1);
    if (/\s/.test(body)) return null;
    return body;
  });

  const suggestions = createMemo(() => {
    const query = slashQuery();
    if (query === null) return [];
    return filterCommands(store.commands(), query).slice(0, 6);
  });

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
      <Show when={suggestions().length > 0}>
        <div class="flex flex-wrap gap-1 border-b border-slate-800 px-3 py-1.5">
          <For each={suggestions()}>
            {(command) => (
              <button
                type="button"
                title={command.hint}
                aria-label={`Run /${command.name} — ${command.title}`}
                onClick={() => {
                  void store.runCommand(command);
                  field?.focus();
                }}
                class="flex items-center gap-1 rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200 hover:border-sky-500 hover:bg-slate-800"
              >
                <span class="font-mono text-sky-300">/{command.name}</span>
                <span class="text-slate-500">{command.title}</span>
              </button>
            )}
          </For>
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
