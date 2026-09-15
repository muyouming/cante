// Left rail: who this session is, and the controls that change it.
//
// Mirrors the Codex / Claude-Desktop session panel — identity at the top,
// model and behavior switches below, environment at the bottom. Hidden below
// 900px, where the header chips carry the same switches.
import { Show } from "solid-js";
import type { JSX } from "solid-js";

import { shortId } from "../protocol.ts";
import { modelLabel, providerLabel, type Store } from "../store.ts";

export interface SessionRailProps {
  store: Store;
}

function RailButton(props: {
  label: string;
  value: string;
  /** Spoken name; defaults to label + value. */
  name?: string;
  onPress(): void;
  tone?: "default" | "accent";
  expanded?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.name ?? `${props.label}: ${props.value}`}
      aria-haspopup={props.expanded === undefined ? undefined : "dialog"}
      aria-expanded={props.expanded}
      onClick={(event) => {
        event.currentTarget.focus();
        props.onPress();
      }}
      class="flex w-full flex-col gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-2 text-left hover:border-sky-500 hover:bg-slate-800"
    >
      <span aria-hidden="true" class="text-[10px] tracking-widest text-slate-500">
        {props.label.toUpperCase()}
      </span>
      <span class={`truncate text-sm ${props.tone === "accent" ? "text-sky-300" : "text-slate-100"}`}>
        {props.value}
      </span>
    </button>
  );
}

function RailAction(props: {
  label: string;
  name?: string;
  onPress(): void;
  expanded?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.name ?? props.label}
      aria-haspopup={props.expanded === undefined ? undefined : "dialog"}
      aria-expanded={props.expanded}
      onClick={(event) => {
        event.currentTarget.focus();
        props.onPress();
      }}
      class="w-full rounded-md border border-slate-800 bg-slate-900 px-2 py-2 text-left text-sm text-slate-100 hover:border-sky-500 hover:bg-slate-800"
    >
      {props.label}
    </button>
  );
}

function connectionLabel(connection: string): string {
  if (connection === "online") return "bridge connected";
  if (connection === "offline") return "bridge offline";
  return "bridge connecting";
}

export default function SessionRail(props: SessionRailProps): JSX.Element {
  const store = props.store;

  return (
    <aside class="flex h-full w-[252px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-slate-800 bg-[#0e141b] p-3">
      <div class="flex flex-col gap-1 pb-2">
        <span class="text-lg font-bold tracking-wide text-slate-50">CANTE</span>
        <span class="text-xs text-slate-500">coding agent · graphical client</span>
      </div>

      <RailButton
        label="session"
        value={shortId(store.session()?.session_id)}
        name={`Session ${shortId(store.session()?.session_id)} — start a new session`}
        onPress={() => {
          store.clearTranscript();
          void store.startSession();
        }}
      />
      <RailButton
        label="model"
        value={modelLabel(store.session())}
        name={`Model: ${modelLabel(store.session())} — choose a model (⌘M)`}
        expanded={store.pickerOpen()}
        onPress={() => store.openPicker()}
        tone="accent"
      />
      <RailButton
        label="provider"
        value={providerLabel(store.session())}
        name={`Provider: ${providerLabel(store.session())} — choose a model (⌘M)`}
        expanded={store.pickerOpen()}
        onPress={() => store.openPicker()}
      />
      <RailButton
        label="effort"
        value={store.session()?.model?.effort ?? "—"}
        name={`Reasoning effort: ${store.session()?.model?.effort ?? "not set"} — cycle effort`}
        onPress={() => void store.cycleEffort()}
      />
      <RailButton
        label="permissions"
        value={store.session()?.permission_mode ?? "—"}
        name={`Permissions: ${store.session()?.permission_mode ?? "not set"} — cycle permissions`}
        onPress={() => void store.cyclePermission()}
      />

      <div class="flex flex-col gap-2 pt-2">
        <RailAction
          label="Commands…"
          name="Open the command palette (⌘K)"
          expanded={store.paletteOpen()}
          onPress={() => store.openPalette()}
        />
        <RailAction label="Clear view" name="Clear the transcript view" onPress={() => store.clearTranscript()} />
        <RailAction label="Compact history" onPress={() => void store.compact()} />
        <RailAction label="Context report" onPress={() => void store.requestContextReport()} />
      </div>

      <div class="flex-1" />

      <div class="flex flex-col gap-1">
        <span class="text-[10px] tracking-widest text-slate-500">WORKSPACE</span>
        <span class="break-all text-xs text-slate-300">{store.session()?.cwd || store.workspace() || "—"}</span>
      </div>

      <div class="flex flex-col gap-1 border-t border-slate-800 pt-2" role="group" aria-label="Bridge and daemon status">
        <div class="flex items-center gap-2">
          <span
            class={
              store.connection() === "online"
                ? "text-xs text-emerald-400"
                : store.connection() === "offline"
                  ? "text-xs text-red-400"
                  : "text-xs text-amber-400"
            }
          >
            <span aria-hidden="true">●</span> {connectionLabel(store.connection())}
          </span>
          <Show when={store.canteVersion()}>
            <span class="truncate text-xs text-slate-600">{store.canteVersion()}</span>
          </Show>
        </div>
        <span class="text-xs text-slate-600">daemon {store.daemonStatus()}</span>
        <Show when={store.logs().length > 0}>
          <span class="truncate text-[10px] text-slate-600" title={store.logs()[store.logs().length - 1]?.line}>
            {store.logs()[store.logs().length - 1]?.line}
          </span>
        </Show>
      </div>
    </aside>
  );
}
