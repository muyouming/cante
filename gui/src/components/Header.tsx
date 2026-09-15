// Top bar: identity on the left, live session switches on the right.
//
// Every chip is a button: model/provider open the picker, effort and
// permissions cycle, and MENU opens the command palette (same as ⌘K).
import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { shortId } from "../protocol.ts";
import { modelLabel, providerLabel, type Store } from "../store.ts";

export interface HeaderProps {
  store: Store;
  compact: boolean;
}

function Chip(props: { label: string; value: string; title?: string; onPress(): void }): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      onClick={() => props.onPress()}
      class="flex shrink-0 items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 hover:border-sky-500 hover:bg-slate-800"
    >
      <span class="text-[10px] tracking-widest text-slate-500">{props.label.toUpperCase()}</span>
      <span class="max-w-[160px] truncate text-xs text-slate-100">{props.value}</span>
    </button>
  );
}

export default function Header(props: HeaderProps): JSX.Element {
  const store = props.store;

  return (
    <header class="flex h-[46px] w-full shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-[#0e141b] px-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="text-sm font-bold tracking-wide text-slate-100">CANTE</span>
        <Show when={!props.compact}>
          <span class="truncate text-xs text-slate-500">
            {store.session()?.title || store.session()?.cwd || "no session"}
          </span>
        </Show>
        <Show when={props.compact}>
          <span class="text-xs text-slate-500">{shortId(store.session()?.session_id, 6)}</span>
        </Show>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <Chip label="model" value={modelLabel(store.session())} title="Choose model (⌘M)" onPress={() => store.openPicker()} />
        <Show when={!props.compact}>
          <Chip label="provider" value={providerLabel(store.session())} title="Choose provider" onPress={() => store.openPicker()} />
        </Show>
        <Chip label="effort" value={store.session()?.model?.effort ?? "—"} title="Cycle reasoning effort" onPress={() => void store.cycleEffort()} />
        <Chip label="perm" value={store.session()?.permission_mode ?? "—"} title="Cycle permissions" onPress={() => void store.cyclePermission()} />
        <Chip label="menu" value="⌘" title="Command palette (⌘K)" onPress={() => store.openPalette()} />
      </div>
    </header>
  );
}
