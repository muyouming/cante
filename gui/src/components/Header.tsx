// Top bar: identity on the left, live session switches on the right.
//
// Every chip is a button: model/provider open the picker, effort,
// permissions and density cycle, CAPS opens the capabilities drawer, TERM the
// terminal drawer, and MENU opens the command palette (same as ⌘K). Chips that
// open an overlay or a drawer carry `aria-haspopup` / `aria-expanded` so a
// screen reader can tell whether the palette, the picker or a drawer is
// currently open.
import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { shortId } from "../protocol.ts";
import { modelLabel, providerLabel, type Store } from "../store.ts";

export interface HeaderProps {
  store: Store;
  compact: boolean;
  /** The right-side capabilities drawer (closed until the chip is pressed). */
  capsOpen: boolean;
  onToggleCaps(): void;
  /** The bottom terminal drawer (closed until ⌘` or the chip is pressed). */
  terminalOpen: boolean;
  onToggleTerminal(): void;
}

function Chip(props: {
  label: string;
  value: string;
  /** Spoken name; defaults to the visible label + value text. */
  name?: string;
  title?: string;
  expanded?: boolean;
  onPress(): void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.name ?? `${props.label}: ${props.value}`}
      aria-haspopup={props.expanded === undefined ? undefined : "dialog"}
      aria-expanded={props.expanded}
      onClick={(event) => {
        // macOS webviews do not focus a button on click, so do it explicitly —
        // the overlay returns focus here when it closes.
        event.currentTarget.focus();
        props.onPress();
      }}
      class="flex shrink-0 items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 hover:border-sky-500 hover:bg-slate-800"
    >
      <span aria-hidden="true" class="text-[10px] tracking-widest text-slate-500">
        {props.label.toUpperCase()}
      </span>
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
        <Chip
          label="model"
          value={modelLabel(store.session())}
          name={`Model: ${modelLabel(store.session())} — choose a model (⌘M)`}
          title="Choose model (⌘M)"
          expanded={store.pickerOpen()}
          onPress={() => store.openPicker()}
        />
        <Show when={!props.compact}>
          <Chip
            label="provider"
            value={providerLabel(store.session())}
            name={`Provider: ${providerLabel(store.session())} — choose a model (⌘M)`}
            title="Choose provider"
            expanded={store.pickerOpen()}
            onPress={() => store.openPicker()}
          />
        </Show>
        <Chip
          label="effort"
          value={store.session()?.model?.effort ?? "—"}
          name={`Reasoning effort: ${store.session()?.model?.effort ?? "not set"} — cycle effort`}
          title="Cycle reasoning effort"
          onPress={() => void store.cycleEffort()}
        />
        <Chip
          label="perm"
          value={store.session()?.permission_mode ?? "—"}
          name={`Permissions: ${store.session()?.permission_mode ?? "not set"} — cycle permissions`}
          title="Cycle permissions"
          onPress={() => void store.cyclePermission()}
        />
        <Chip
          label="density"
          value={store.viewDensity()}
          name={`View density: ${store.viewDensity()} — cycle density (⌘O)`}
          title="Cycle view density (⌘O)"
          onPress={() => store.cycleDensity()}
        />
        <Chip
          label="caps"
          value={props.capsOpen ? "open" : "closed"}
          name={`Capabilities drawer: ${props.capsOpen ? "open" : "closed"}`}
          title="MCP servers, skills and subagents"
          expanded={props.capsOpen}
          onPress={() => props.onToggleCaps()}
        />
        <Chip
          label="term"
          value="⌘`"
          name={`Terminal drawer: ${props.terminalOpen ? "open" : "closed"}`}
          title="Toggle the terminal drawer (⌘`)"
          expanded={props.terminalOpen}
          onPress={() => props.onToggleTerminal()}
        />
        <Chip
          label="menu"
          value="⌘"
          name="Command palette (⌘K)"
          title="Command palette (⌘K)"
          expanded={store.paletteOpen()}
          onPress={() => store.openPalette()}
        />
      </div>
    </header>
  );
}
