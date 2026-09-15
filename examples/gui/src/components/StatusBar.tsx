// Bottom status strip: turn state, token accounting, context occupancy, and
// the last error the GUI wants the user to see.
import { Text, View } from "@pocketjs/framework/components";
import { Show } from "solid-js";

import { formatTokens, type Store } from "../store.ts";

export interface StatusBarProps {
  store: Store;
}

function statusText(status: string): string {
  switch (status) {
    case "thinking":
      return "thinking";
    case "streaming":
      return "streaming";
    case "awaiting":
      return "awaiting approval";
    case "error":
      return "error";
    case "offline":
      return "daemon offline";
    default:
      return "idle";
  }
}

function statusTone(status: string): string {
  switch (status) {
    case "thinking":
      return "text-xs text-amber-300";
    case "streaming":
      return "text-xs text-sky-300";
    case "awaiting":
      return "text-xs text-amber-400 font-bold";
    case "error":
      return "text-xs text-red-400 font-bold";
    case "offline":
      return "text-xs text-red-400";
    default:
      return "text-xs text-slate-400";
  }
}

export default function StatusBar(props: StatusBarProps) {
  const store = props.store;

  const percent = () => {
    const context = store.context();
    if (!context || !context.limit_tokens) return 0;
    return Math.max(0, Math.min(100, Math.round((context.used_tokens / context.limit_tokens) * 100)));
  };

  const barWidth = () => Math.max(1, Math.round((104 * percent()) / 100));

  return (
    <View class="w-full h-[28] flex-row items-center gap-4 px-3 bg-[#0e141b] border-t border-slate-800">
      <Text class={statusTone(store.daemonStatus())}>{statusText(store.daemonStatus())}</Text>

      <Show when={store.usage()}>
        <Text class="text-xs text-slate-500">
          in {formatTokens(store.usage()?.input_tokens ?? 0)} · out {formatTokens(store.usage()?.output_tokens ?? 0)}
        </Text>
      </Show>

      <Show when={store.context()}>
        <View class="flex-row items-center gap-2">
          <Text class="text-xs text-slate-500">ctx</Text>
          <View class="w-[104] h-[6] rounded bg-slate-800">
            <View class="h-[6] rounded bg-emerald-500" style={{ width: barWidth() }} />
          </View>
          <Text class="text-xs text-slate-400">{percent()}%</Text>
        </View>
      </Show>

      <Text class="text-xs text-slate-500">steps {store.steps()}</Text>

      <View class="flex-1" />

      <Show when={store.notice()}>
        <Text class="text-xs text-amber-400">{store.notice()}</Text>
      </Show>
    </View>
  );
}
