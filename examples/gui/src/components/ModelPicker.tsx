// Provider / model picker, driven by `cante catalog` through the bridge.
//
// One flat list keeps the uniform-row VirtualList honest: the provider name is
// a chip on each row rather than a section header.
import { Focusable, Modal, Text, View } from "@pocketjs/framework/components";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import { Show, createMemo } from "solid-js";

import type { CatalogProvider } from "../store.ts";

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

const ROW_HEIGHT = 60;
const LIST_HEIGHT = 300;

export default function ModelPicker(props: ModelPickerProps) {
  const entries = createMemo<Entry[]>(() => {
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

  return (
    <Modal
      open={props.open}
      class="absolute inset-0 z-50 flex-col items-center justify-center"
      panelClass="flex-col gap-3 w-[620] p-4 rounded-xl shadow-lg bg-slate-900 border-slate-700"
    >
      <Show when={props.open}>
        <View class="flex-row items-center justify-between">
          <View class="flex-col gap-1">
            <Text class="text-base text-slate-50 font-bold">Model</Text>
            <Text class="text-xs text-slate-500">
              {entries().length > 0 ? `${entries().length} models from cante catalog` : "catalog unavailable"}
            </Text>
          </View>
          <View class="flex-row items-center gap-2">
            <Focusable
              onPress={props.onReload}
              class="h-[34] w-[84] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
            >
              <Text class="text-sm text-slate-100 font-bold">RELOAD</Text>
            </Focusable>
            <Focusable
              onPress={props.onClose}
              class="h-[34] w-[84] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
            >
              <Text class="text-sm text-slate-100 font-bold">CLOSE</Text>
            </Focusable>
          </View>
        </View>

        <Show when={entries().length > 0} fallback={<Text class="text-sm text-slate-400">Start the bridge and press RELOAD.</Text>}>
          <VirtualList
            count={entries().length}
            rowHeight={ROW_HEIGHT}
            height={LIST_HEIGHT}
            inputActive={() => true}
            onRowPress={(index) => {
              const entry = entries()[index];
              if (entry && !props.busy) props.onPick(entry.provider, entry.model);
            }}
            renderRow={(index) => {
              const entry = entries()[index];
              if (!entry) return <View class="w-full h-[60]" />;
              return (
                <Focusable
                  class={
                    entry.current
                      ? "w-full h-[60] flex-col justify-center gap-1 px-3 py-2 rounded-md bg-sky-950 border-sky-700 focus:border-sky-400 active:bg-slate-800"
                      : "w-full h-[60] flex-col justify-center gap-1 px-3 py-2 rounded-md bg-slate-950 border-slate-800 focus:border-sky-500 active:bg-slate-800"
                  }
                >
                  <View class="flex-row items-center justify-between">
                    <Text class="text-sm text-slate-100">{entry.modelLabel}</Text>
                    <Show when={entry.current}>
                      <Text class="text-xs text-sky-400 font-bold">CURRENT</Text>
                    </Show>
                  </View>
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs text-slate-500">{entry.providerLabel}</Text>
                    <Text class="text-xs text-slate-600">{entry.efforts}</Text>
                  </View>
                </Focusable>
              );
            }}
          />
        </Show>
      </Show>
    </Modal>
  );
}
