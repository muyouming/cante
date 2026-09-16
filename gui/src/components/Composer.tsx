// The composer: one multiline field bound to the store's draft, plus Send/Stop.
//
// Enter sends, Shift+Enter inserts a newline, ↑/↓ walk the prompt history (the
// in-progress draft is restored at the end). A leading `/` opens the live
// command palette above the field: the store owns the query, the highlight,
// completion, and dismissal, so the palette behaviour is unit-tested without a
// DOM and this component only wires the keys and the rows.
//
// While a turn is running, Enter *steers* instead of sending: the correction is
// queued into the live turn (`store.steer`) rather than interrupting it, and the
// field empties immediately so the user sees their line land in the transcript.
//
// Ambient ghost text is rendered as a separate dimmed element behind the field
// — never as the field's value — and only while the draft is empty. Typing
// asks the daemon for a fresh phrase at most once per `SUGGEST_MS`.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
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
/** Typing asks for a phrase at most this often (the trailing draft wins). */
const SUGGEST_MS = 600;

export default function Composer(props: ComposerProps): JSX.Element {
  const store = props.store;
  const [height, setHeight] = createSignal(40);
  let field: HTMLTextAreaElement | undefined;
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;

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

  onCleanup(() => {
    if (suggestTimer !== undefined) clearTimeout(suggestTimer);
  });

  /** Throttled: one request per window, carrying the newest draft. */
  const requestPhrase = (): void => {
    if (suggestTimer !== undefined) return;
    suggestTimer = setTimeout(() => {
      suggestTimer = undefined;
      const latest = store.draft();
      if (latest.trim().length === 0) return;
      void store.requestAmbientPhrase(latest);
    }, SUGGEST_MS);
  };

  /**
   * Enter (and SEND). Mid-turn this is a steering message: the daemon folds it
   * into the running turn, so the same key corrects Cante instead of stopping
   * it. The draft is cleared here because steering is fire-and-forget — the
   * field must not keep text the daemon has already taken.
   */
  const sendDraft = (): void => {
    const value = store.draft().trim();
    if (!value) return;
    if (props.busy) {
      store.setDraft("");
      void store.steer(value);
      return;
    }
    void store.submit();
  };

  /** Shown only over an empty field: a suggestion, not the field's value. */
  const ghost = (): string | null => {
    if (store.draft().length > 0) return null;
    return store.ambient()?.suggestion ?? null;
  };

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
        // No match means the daemon may still own the name, or (mid-turn) the
        // text is a correction: send it as typed either way.
        if (store.paletteMatches().length > 0) void store.runPalette();
        else sendDraft();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
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
        <div class="relative min-w-0 flex-1">
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
            title={props.busy ? "Enter steers the running turn" : "Enter sends"}
            placeholder={
              ghost()
                ? ""
                : props.busy
                  ? "Steer the running turn…  (Shift+Enter for a newline)"
                  : "Ask Cante…  (/  for commands)"
            }
            onInput={(event) => {
              store.setDraft(event.currentTarget.value);
              resize();
              requestPhrase();
            }}
            onKeyDown={onKeyDown}
            class="block w-full min-h-[38px] resize-none rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500"
          />
          {/* Decorative: the suggestion is not editable and never the field's value. */}
          <Show when={ghost()}>
            <div
              aria-hidden="true"
              class="pointer-events-none absolute inset-x-3 top-2 truncate text-sm text-slate-600"
            >
              {ghost()}
            </div>
          </Show>
        </div>

        <button
          type="button"
          onClick={sendDraft}
          disabled={store.draft().trim().length === 0}
          aria-label={props.busy ? "Steer the running turn" : "Send message"}
          title={props.busy ? "Steer the running turn (Enter)" : "Send (Enter)"}
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
