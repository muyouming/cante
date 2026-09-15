// Provider / model picker, driven by `cante catalog`.
//
// One flat, filterable list: the provider name is a chip on each row and the
// current model is marked. Picking one starts a session on that model.
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { CatalogProvider } from "../store.ts";
import Overlay from "./Overlay.tsx";

export interface ModelPickerProps {
  open: boolean;
  catalog: CatalogProvider[];
  currentProvider: string;
  currentModel: string;
  busy: boolean;
  onClose(): void;
  onPick(provider: string, model: string): void;
  onReload(): void;
}

interface Entry {
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  efforts: string;
  current: boolean;
}

export default function ModelPicker(props: ModelPickerProps): JSX.Element {
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

  const all = createMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const provider of props.catalog) {
      for (const model of provider.models) {
        out.push({
          provider: provider.id,
          providerLabel: provider.display_name || provider.id,
          model: model.id,
          modelLabel: model.display_name || model.id,
          efforts: model.efforts.length > 0 ? model.efforts.join("·") : "—",
          current: provider.id === props.currentProvider && model.id === props.currentModel,
        });
      }
    }
    return out;
  });

  const entries = createMemo<Entry[]>(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return all();
    return all().filter(
      (entry) =>
        entry.modelLabel.toLowerCase().includes(needle) ||
        entry.model.toLowerCase().includes(needle) ||
        entry.providerLabel.toLowerCase().includes(needle),
    );
  });

  const pick = (entry: Entry | undefined): void => {
    if (!entry || props.busy) return;
    props.onPick(entry.provider, entry.model);
  };

  return (
    <Overlay open={props.open} onClose={props.onClose} panelClass="max-w-[620px]">
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col gap-1">
          <span class="text-base font-bold text-slate-50">Model</span>
          <span class="text-xs text-slate-500">
            {all().length > 0 ? `${all().length} models from cante catalog` : "catalog unavailable"}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={() => props.onReload()}
            class="h-[34px] w-[84px] rounded-md bg-slate-800 text-sm font-bold text-slate-100 hover:bg-slate-700"
          >
            RELOAD
          </button>
          <button
            type="button"
            onClick={() => props.onClose()}
            class="h-[34px] w-[84px] rounded-md bg-slate-800 text-sm font-bold text-slate-100 hover:bg-slate-700"
          >
            CLOSE
          </button>
        </div>
      </div>

      <input
        ref={(node) => {
          field = node ?? undefined;
        }}
        value={query()}
        spellcheck={false}
        placeholder="Filter models…"
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((index) => Math.min(entries().length - 1, index + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) => Math.max(0, index - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(entries()[selected()]);
          }
        }}
        class="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
      />

      <Show
        when={entries().length > 0}
        fallback={<span class="py-6 text-center text-sm text-slate-400">No models — press RELOAD.</span>}
      >
        <div class="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
          <For each={entries()}>
            {(entry, index) => (
              <button
                type="button"
                onClick={() => pick(entry)}
                onMouseEnter={() => setSelected(index())}
                class={`flex flex-col gap-1 rounded-md border px-3 py-2 text-left ${
                  entry.current
                    ? "border-sky-700 bg-sky-950"
                    : index() === selected()
                      ? "border-sky-500 bg-slate-800"
                      : "border-slate-800 bg-slate-950 hover:border-sky-500 hover:bg-slate-800"
                }`}
              >
                <span class="flex items-center justify-between">
                  <span class="truncate text-sm text-slate-100">{entry.modelLabel}</span>
                  <Show when={entry.current}>
                    <span class="shrink-0 text-xs font-bold text-sky-400">CURRENT</span>
                  </Show>
                </span>
                <span class="flex items-center justify-between">
                  <span class="truncate text-xs text-slate-500">{entry.providerLabel}</span>
                  <span class="shrink-0 text-xs text-slate-600">{entry.efforts}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.busy}>
        <span class="text-xs text-amber-400">a turn is running — stop it before switching models</span>
      </Show>
    </Overlay>
  );
}
