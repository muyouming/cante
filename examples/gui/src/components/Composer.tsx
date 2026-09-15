// The composer: a single-line field that summons the system keyboard, plus
// Send / Stop. Text entry is OSK-driven on every PocketJS target today, so
// △ opens the keyboard and the field itself opens it on press as well.
import { Focusable, Text, View } from "@pocketjs/framework/components";
import { TextField } from "@pocketjs/framework/osk";
import { createSignal } from "solid-js";

export interface ComposerProps {
  busy: boolean;
  onSend(text: string): void;
  onInterrupt(): void;
  onReady(open: () => void): void;
}

export default function Composer(props: ComposerProps) {
  const [draft, setDraft] = createSignal("");

  let controller: { open(): void } | null = null;

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    props.onSend(text);
    setDraft("");
  };

  return (
    <View class="w-full flex-row items-center gap-2 px-3 py-2 bg-slate-900 border-t border-slate-800">
      <View class="flex-1">
        <TextField
          value={draft}
          onInput={(next: string) => setDraft(next)}
          onSubmit={submit}
          placeholder="Ask Cante…"
          class="w-full rounded-md bg-slate-950 border-slate-700 px-3 py-2 focus:border-sky-500 active:bg-slate-800"
          ref={(osk) => {
            controller = osk;
            props.onReady(() => controller?.open());
          }}
        />
      </View>

      <Focusable
        onPress={() => submit(draft())}
        class="h-[38] w-[74] flex-col justify-center items-center rounded-md bg-sky-600 focus:bg-sky-500 active:bg-sky-700"
      >
        <Text class="text-sm text-white font-bold">SEND</Text>
      </Focusable>

      <Focusable
        onPress={props.onInterrupt}
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
