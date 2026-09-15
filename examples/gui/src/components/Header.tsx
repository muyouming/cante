// Top bar: identity on the left, live session switches on the right.
import { Focusable, Text, View } from "@pocketjs/framework/components";
import { Show } from "solid-js";

import { modelLabel, providerLabel, type Store } from "../store.ts";
import { shortId } from "../protocol.ts";

export interface HeaderProps {
  store: Store;
  compact: boolean;
}

function Chip(props: { label: string; value: string; onPress(): void }) {
  return (
    <Focusable
      onPress={props.onPress}
      class="flex-row items-center gap-2 px-2 py-1 rounded-md bg-slate-900 border-slate-800 focus:border-sky-500 active:bg-slate-800"
    >
      <Text class="text-xs text-slate-500 tracking-wide">{props.label.toUpperCase()}</Text>
      <Text class="text-xs text-slate-100">{props.value}</Text>
    </Focusable>
  );
}

export default function Header(props: HeaderProps) {
  const store = props.store;

  return (
    <View class="w-full h-[46] flex-row items-center justify-between px-3 bg-[#0e141b] border-b border-slate-800">
      <View class="flex-row items-center gap-3">
        <Text class="text-sm text-slate-100 font-bold tracking-wide">CANTE</Text>
        <Show when={!props.compact}>
          <Text class="text-xs text-slate-500">{store.session()?.title || store.session()?.cwd || "no session"}</Text>
        </Show>
        <Show when={props.compact}>
          <Text class="text-xs text-slate-500">{shortId(store.session()?.session_id, 6)}</Text>
        </Show>
      </View>

      <View class="flex-row items-center gap-2">
        <Chip label="model" value={modelLabel(store.session())} onPress={() => store.openPicker()} />
        <Show when={!props.compact}>
          <Chip label="provider" value={providerLabel(store.session())} onPress={() => store.openPicker()} />
        </Show>
        <Chip label="effort" value={store.session()?.model?.effort ?? "—"} onPress={() => void store.cycleEffort()} />
        <Chip
          label="perm"
          value={store.session()?.permission_mode ?? "—"}
          onPress={() => void store.cyclePermission()}
        />
        <Chip label="menu" value="⌘" onPress={() => store.openPalette()} />
      </View>
    </View>
  );
}
