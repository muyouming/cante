// The composer: one field bound to the store's draft, plus Send / Stop.
//
// Text entry is OSK-driven on every PocketJS target today, so the field opens
// the keyboard on press and △ opens it directly. Triggers recall prompt
// history; a leading `/` is parsed as a command by the store.
import { Focusable, Text, View } from "@pocketjs/framework/components";
import { TextField } from "@pocketjs/framework/osk";

import type { Store } from "../store.ts";

export interface ComposerProps {
  store: Store;
  busy: boolean;
  onReady(open: () => void): void;
}

export default function Composer(props: ComposerProps) {
  const store = props.store;
  let controller: { open(): void } | null = null;

  return (
    <View class="w-full flex-row items-center gap-2 px-3 py-2 bg-slate-900 border-t border-slate-800">
      <View class="flex-1">
        <TextField
          value={store.draft}
          onInput={(next: string) => store.setDraft(next)}
          onSubmit={(value: string) => {
            void store.submit(value);
          }}
          placeholder="Ask Cante…  (/  for commands)"
          class="w-full rounded-md bg-slate-950 border-slate-700 px-3 py-2 focus:border-sky-500 active:bg-slate-800"
          ref={(osk) => {
            controller = osk;
            props.onReady(() => controller?.open());
          }}
        />
      </View>

      <Focusable
        onPress={() => {
          void store.submit();
        }}
        class="h-[38] w-[74] flex-col justify-center items-center rounded-md bg-sky-600 focus:bg-sky-500 active:bg-sky-700"
      >
        <Text class="text-sm text-white font-bold">SEND</Text>
      </Focusable>

      <Focusable
        onPress={() => {
          void store.interrupt();
        }}
        class={
          props.busy
            ? "h-[38] w-[74] flex-col justify-center items-center rounded-md bg-red-600 focus:bg-red-500 active:bg-red-700"
            : "h-[38] w-[74] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
        }
      >
        <Text class="text-sm text-slate-100 font-bold">STOP</Text>
      </Focusable>
    </View>
  );
}
