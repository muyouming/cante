// Command palette (⌘K / MENU).
//
// Built-in client actions plus the session's skills (`SessionStart` announces
// them). Commands that need an argument prefill the composer instead of asking
// for typing up front; clients run immediately; everything else is a daemon
// `SlashCommand`. The field is a combobox over the result list so a screen
// reader follows the highlighted row as the arrow keys move it.
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { filterCommands, type Command } from "../commands.ts";
import Overlay from "./Overlay.tsx";

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onRun(command: Command): void;
  onClose(): void;
}

const LIST_ID = "cante-command-list";

export default function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let field: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.open) {
      setQuery("");
      setSelected(0);
      queueMicrotask(() => field?.focus());
    }
  });

  const matches = createMemo<Command[]>(() => filterCommands(props.commands, query()));

  const run = (command: Command | undefined): void => {
    if (command) props.onRun(command);
  };

  return (
    <Overlay open={props.open} onClose={props.onClose} label="Command palette" panelClass="max-w-[620px]">
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-bold text-slate-50">Commands</h2>
          <span class="text-xs text-slate-500">
            {props.commands.length} available — built-ins run in the client, skills go to the daemon
          </span>
        </div>
        <button
          type="button"
          onClick={() => props.onClose()}
          class="h-[34px] w-[84px] rounded-md bg-slate-800 text-sm font-bold text-slate-100 hover:bg-slate-700"
        >
          CLOSE
        </button>
      </div>

      <input
        ref={(node) => {
          field = node ?? undefined;
        }}
        value={query()}
        spellcheck={false}
        role="combobox"
        aria-label="Filter commands"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={LIST_ID}
        aria-activedescendant={matches().length > 0 ? `${LIST_ID}-${selected()}` : undefined}
        placeholder="Filter commands…"
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((index) => Math.min(matches().length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            run(matches()[selected()]);
          }
        }}
        class="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500"
      />

      <Show
        when={matches().length > 0}
        fallback={<span class="py-6 text-center text-sm text-slate-400">No matching commands.</span>}
      >
        <div id={LIST_ID} role="listbox" aria-label="Matching commands" class="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
          <For each={matches()}>
            {(command, index) => (
              <button
                type="button"
                id={`${LIST_ID}-${index()}`}
                role="option"
                aria-selected={index() === selected()}
                onClick={() => run(command)}
                onMouseEnter={() => setSelected(index())}
                class={`flex flex-col gap-1 rounded-md border px-3 py-2 text-left ${
                  index() === selected()
                    ? "border-sky-500 bg-slate-800"
                    : "border-slate-800 bg-slate-950 hover:border-sky-500 hover:bg-slate-800"
                }`}
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-bold text-slate-100">{command.title}</span>
                  <span class="flex shrink-0 items-center gap-2">
                    <Show when={command.prefill}>
                      <span class="text-xs text-amber-300">needs an argument</span>
                    </Show>
                    <span class={command.source === "skill" ? "text-xs text-emerald-400" : "text-xs text-sky-400"}>
                      {command.source === "skill" ? "SKILL" : "CLIENT"}
                    </span>
                  </span>
                </span>
                <span class="truncate text-xs text-slate-500">{command.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <span class="text-xs text-slate-600">
        A command that needs an argument prefills the composer — then type it and press send.
      </span>
    </Overlay>
  );
}
