// The terminal drawer: a read-out of the shell commands the daemon ran.
//
// It is deliberately not an emulator. Every entry is one `ShellInput` round
// trip (`store.terminal()`), rendered as `$ command` + stdout + stderr with the
// exit code marked, so a failing command is visible at a glance. The one-line
// field below feeds `runShell`; CLEAR empties the read-out. Visibility is owned
// by the shell (`App.tsx`) and toggled with ⌘` or the TERM header chip, so this
// component only renders what it is given and reports CLOSE back up.
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";

export interface TerminalPaneProps {
  store: Store;
  onClose(): void;
}

/** `exit 0` is quiet, a failure is loud, and no code yet means still running. */
function exitLabel(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "running…";
  return `exit ${code}`;
}

function exitClass(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "text-slate-500";
  return code === 0 ? "text-emerald-500" : "text-red-400";
}

export default function TerminalPane(props: TerminalPaneProps): JSX.Element {
  const store = props.store;
  const [command, setCommand] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let field: HTMLInputElement | undefined;

  const run = (): void => {
    const value = command().trim();
    if (!value) return;
    setCommand("");
    void store.runShell(value);
  };

  // Follow the newest output. The daemon appends whole entries, so re-running
  // the effect on each new entry (and each new chunk of the last one) is
  // enough to keep the tail in view.
  createEffect(() => {
    store.terminal();
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  onMount(() => {
    field?.focus();
  });

  return (
    <section
      aria-label="Terminal"
      class="flex w-full shrink-0 flex-col border-t border-slate-800 bg-[#0b0f14]"
    >
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-slate-800 px-3 py-1">
        <span class="text-[10px] tracking-widest text-slate-500">TERMINAL</span>
        <div class="flex items-center gap-2">
          <span aria-hidden="true" class="text-[10px] text-slate-600">
            ⌘`
          </span>
          <button
            type="button"
            onClick={() => {
              store.clearTerminal();
              field?.focus();
            }}
            title="Clear the terminal output"
            class="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] tracking-widest text-slate-400 hover:border-sky-500 hover:text-slate-100"
          >
            CLEAR
          </button>
          <button
            type="button"
            onClick={() => props.onClose()}
            aria-label="Close terminal (⌘`)"
            title="Close terminal (⌘`)"
            class="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-[10px] tracking-widest text-slate-400 hover:border-sky-500 hover:text-slate-100"
          >
            CLOSE
          </button>
        </div>
      </div>

      <div
        ref={(node) => {
          scroller = node ?? undefined;
        }}
        class="min-h-[92px] max-h-[260px] overflow-y-auto px-3 py-2 font-mono text-xs"
      >
        <Show when={store.terminal().length === 0}>
          <p class="text-slate-600">no commands yet — type one below.</p>
        </Show>
        <For each={store.terminal()}>
          {(entry) => (
            <div class="mb-2 last:mb-0">
              <div class="flex items-baseline gap-2">
                <span aria-hidden="true" class="shrink-0 text-sky-400">
                  $
                </span>
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-all text-slate-200">
                  {entry.command}
                </span>
                <span class={`shrink-0 ${exitClass(entry.exitCode)}`}>
                  {exitLabel(entry.exitCode)}
                </span>
              </div>
              <Show when={entry.stdout}>
                <pre class="whitespace-pre-wrap break-all text-slate-400">{entry.stdout}</pre>
              </Show>
              <Show when={entry.stderr}>
                <pre class="whitespace-pre-wrap break-all text-red-300">{entry.stderr}</pre>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="flex shrink-0 items-center gap-2 border-t border-slate-800 px-3 py-2">
        <input
          ref={(node) => {
            field = node ?? undefined;
          }}
          type="text"
          value={command()}
          spellcheck={false}
          aria-label="Shell command"
          placeholder="shell command — Enter to run"
          onInput={(event) => setCommand(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              run();
            }
          }}
          class="h-[30px] min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500"
        />
        <button
          type="button"
          onClick={run}
          disabled={command().trim().length === 0}
          aria-label="Run shell command"
          class="h-[30px] w-[54px] shrink-0 rounded-md bg-slate-800 text-[11px] font-bold text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-900 disabled:text-slate-600"
        >
          RUN
        </button>
      </div>
    </section>
  );
}
