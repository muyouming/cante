// Left rail: who this session is, and the controls that change it.
//
// Mirrors the Codex / Claude-Desktop session panel — identity at the top,
// model and behavior switches below, environment at the bottom.
import { Focusable, Text, View } from "@pocketjs/framework/components";
import { Show } from "solid-js";

import { EFFORTS, PERMISSION_MODES, modelLabel, providerLabel, type Store } from "../store.ts";
import { shortId } from "../protocol.ts";

export interface SessionRailProps {
  store: Store;
  onPickModel(): void;
  onNewSession(): void;
}

function RailButton(props: { label: string; value: string; onPress(): void; tone?: "default" | "accent" }) {
  return (
    <Focusable
      onPress={props.onPress}
      class="w-full flex-col gap-1 px-2 py-2 rounded-md bg-slate-900 border-slate-800 focus:border-sky-500 active:bg-slate-800"
    >
      <Text class="text-xs text-slate-500 tracking-wide">{props.label.toUpperCase()}</Text>
      <Text class={props.tone === "accent" ? "text-sm text-sky-300" : "text-sm text-slate-100"}>{props.value}</Text>
    </Focusable>
  );
}

export default function SessionRail(props: SessionRailProps) {
  const store = props.store;

  const cycleEffort = () => {
    const current = store.session()?.model?.effort ?? "Medium";
    const index = EFFORTS.indexOf(current);
    const next = EFFORTS[(index + 1) % EFFORTS.length]!;
    void store.setEffort(next);
  };

  const cyclePermission = () => {
    const current = store.session()?.permission_mode ?? "Strict";
    const index = PERMISSION_MODES.indexOf(current);
    const next = PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length]!;
    void store.setPermissionMode(next);
  };

  return (
    <View class="w-[252] h-full flex-col gap-2 p-3 bg-[#0e141b] border-r border-slate-800">
      <View class="flex-col gap-1 pb-2">
        <Text class="text-lg text-slate-50 font-bold tracking-wide">CANTE</Text>
        <Text class="text-xs text-slate-500">coding agent · graphical client</Text>
      </View>

      <RailButton label="session" value={shortId(store.session()?.session_id)} onPress={props.onNewSession} />
      <RailButton label="model" value={modelLabel(store.session())} onPress={props.onPickModel} tone="accent" />
      <RailButton label="provider" value={providerLabel(store.session())} onPress={props.onPickModel} />
      <RailButton label="effort" value={store.session()?.model?.effort ?? "—"} onPress={cycleEffort} />
      <RailButton label="permissions" value={store.session()?.permission_mode ?? "—"} onPress={cyclePermission} />

      <View class="flex-col gap-2 pt-2">
        <Focusable
          onPress={() => {
            store.clearTranscript();
          }}
          class="w-full flex-col px-2 py-2 rounded-md bg-slate-900 border-slate-800 focus:border-sky-500 active:bg-slate-800"
        >
          <Text class="text-sm text-slate-100">Clear view</Text>
        </Focusable>
        <Focusable
          onPress={() => {
            void store.compact();
          }}
          class="w-full flex-col px-2 py-2 rounded-md bg-slate-900 border-slate-800 focus:border-sky-500 active:bg-slate-800"
        >
          <Text class="text-sm text-slate-100">Compact history</Text>
        </Focusable>
        <Focusable
          onPress={() => {
            void store.requestContextReport();
          }}
          class="w-full flex-col px-2 py-2 rounded-md bg-slate-900 border-slate-800 focus:border-sky-500 active:bg-slate-800"
        >
          <Text class="text-sm text-slate-100">Context report</Text>
        </Focusable>
      </View>

      <View class="flex-1" />

      <View class="flex-col gap-1">
        <Text class="text-xs text-slate-500 tracking-wide">WORKSPACE</Text>
        <Text class="text-xs text-slate-300">{store.session()?.cwd ?? "—"}</Text>
      </View>

      <View class="flex-col gap-1 pt-2 border-t border-slate-800">
        <View class="flex-row items-center gap-2">
          <Text class={store.connection() === "online" ? "text-xs text-emerald-400" : store.connection() === "offline" ? "text-xs text-red-400" : "text-xs text-amber-400"}>
            {store.connection() === "online" ? "● bridge" : store.connection() === "offline" ? "● offline" : "● connecting"}
          </Text>
          <Show when={store.canteVersion()}>
            <Text class="text-xs text-slate-600">{store.canteVersion()}</Text>
          </Show>
        </View>
        <Text class="text-xs text-slate-600">{store.bridgeUrl()}</Text>
      </View>
    </View>
  );
}
