// Command palette.
//
// PocketJS has no physical-keyboard text path yet, so this is the d-pad-first
// way to reach everything: built-in client actions plus the session's skills
// (announced by `SessionStart`). Commands that need an argument prefill the
// composer instead of asking for typing up front.
import { Focusable, Modal, Text, View } from "@pocketjs/framework/components";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import { Show } from "solid-js";

import type { Command } from "../commands.ts";

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onRun(command: Command): void;
  onClose(): void;
}

const ROW_HEIGHT = 60;
const LIST_HEIGHT = 312;

export default function CommandPalette(props: CommandPaletteProps) {
  const commands = () => props.commands;

  return (
    <Modal
      open={props.open}
      class="absolute inset-0 z-50 flex-col items-center justify-center"
      panelClass="flex-col gap-3 w-[620] p-4 rounded-xl shadow-lg bg-slate-900 border-slate-700"
    >
      <Show when={props.open}>
        <View class="flex-row items-center justify-between">
          <View class="flex-col gap-1">
            <Text class="text-base text-slate-50 font-bold">Commands</Text>
            <Text class="text-xs text-slate-500">
              {commands().length} available — built-ins run in the client, skills go to the daemon
            </Text>
          </View>
          <Focusable
            onPress={props.onClose}
            class="h-[34] w-[84] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
          >
            <Text class="text-sm text-slate-100 font-bold">CLOSE</Text>
          </Focusable>
        </View>

        <VirtualList
          count={commands().length}
          rowHeight={ROW_HEIGHT}
          height={LIST_HEIGHT}
          inputActive={() => true}
          onRowPress={(index) => {
            const command = commands()[index];
            if (command) props.onRun(command);
          }}
          renderRow={(index) => {
            const command = commands()[index];
            if (!command) return <View class="w-full h-full" />;
            return (
              <Focusable class="w-full h-full flex-col justify-center gap-1 px-3 py-2 rounded-md bg-slate-950 border-slate-800 focus:border-sky-500 active:bg-slate-800">
                <View class="flex-row items-center justify-between">
                  <Text class="text-sm text-slate-100 font-bold">{command.title}</Text>
                  <View class="flex-row items-center gap-2">
                    <Show when={command.prefill}>
                      <Text class="text-xs text-amber-300">needs an argument</Text>
                    </Show>
                    <Text class={command.source === "skill" ? "text-xs text-emerald-400" : "text-xs text-sky-400"}>
                      {command.source === "skill" ? "SKILL" : "CLIENT"}
                    </Text>
                  </View>
                </View>
                <Text class="text-xs text-slate-500">{command.hint}</Text>
              </Focusable>
            );
          }}
        />

        <Text class="text-xs text-slate-600">
          A command that needs an argument prefills the composer — then type it and press send.
        </Text>
      </Show>
    </Modal>
  );
}
