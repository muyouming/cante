// Cante GUI — the shell.
//
// Layout follows the Codex / Claude-Desktop shape: a session rail on the left,
// a streaming transcript in the middle, a composer pinned to the bottom, and a
// status strip under it. Everything is PocketJS primitives (`View`/`Text` +
// build-time Tailwind), driven by one Solid store fed from the local bridge.
import { getOps } from "@pocketjs/framework";
import { Screen, Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { Show, createSignal, onMount } from "solid-js";

import type { ReviewDecision } from "./src/protocol.ts";
import { createStore, type Row } from "./src/store.ts";
import ApprovalModal from "./src/components/ApprovalModal.tsx";
import CommandPalette from "./src/components/CommandPalette.tsx";
import Composer from "./src/components/Composer.tsx";
import DetailModal from "./src/components/DetailModal.tsx";
import Header from "./src/components/Header.tsx";
import ModelPicker from "./src/components/ModelPicker.tsx";
import SessionRail from "./src/components/SessionRail.tsx";
import StatusBar from "./src/components/StatusBar.tsx";
import Transcript from "./src/components/Transcript.tsx";

/** Chrome above + below the transcript, in logical px. */
const HEADER_H = 46;
const COMPOSER_H = 56;
const STATUS_H = 28;
const RAIL_W = 252;
const DEFAULT_SIZE = { w: 1100, h: 720 };

/** Desktop hosts publish their logical size on `ui.__viewport`; console hosts
 *  omit it, and the manifest's fixed viewport already sized the realm. */
function readViewport(): { w: number; h: number } | null {
  const ops = getOps() as unknown as { __viewport?: { w: number; h: number } };
  const viewport = ops.__viewport;
  return viewport && typeof viewport.w === "number" && typeof viewport.h === "number"
    ? { w: viewport.w, h: viewport.h }
    : null;
}

export default function App() {
  const store = createStore();
  const [size, setSize] = createSignal(DEFAULT_SIZE);
  const [detail, setDetail] = createSignal<Row | null>(null);

  let openKeyboard: (() => void) | null = null;
  let autoStarted = false;

  const compact = () => size().w < 900;
  const transcriptHeight = () => Math.max(140, size().h - HEADER_H - COMPOSER_H - STATUS_H);
  const transcriptWidth = () => Math.max(240, size().w - (compact() ? 0 : RAIL_W));

  const syncViewport = () => {
    const viewport = readViewport();
    if (viewport && (viewport.w !== size().w || viewport.h !== size().h)) {
      setSize({ w: viewport.w, h: viewport.h });
    }
  };

  onFrame(() => {
    syncViewport();
    // First contact with a reachable bridge: open a session with host defaults.
    if (!autoStarted && store.connection() === "online" && store.session() === null) {
      autoStarted = true;
      void store.startSession();
    }
  });

  onButtonPress(BTN.TRIANGLE, () => {
    openKeyboard?.();
  });
  onButtonPress(BTN.SQUARE, () => {
    void store.interrupt();
  });
  onButtonPress(BTN.SELECT, () => {
    if (store.paletteOpen()) store.closePalette();
    else store.openPalette();
  });
  onButtonPress(BTN.START, () => {
    if (store.pickerOpen()) store.closePicker();
    else store.openPicker();
  });
  onButtonPress(BTN.LTRIGGER, () => {
    store.historyPrev();
  });
  onButtonPress(BTN.RTRIGGER, () => {
    store.historyNext();
  });

  onMount(() => {
    syncViewport();
    store.connect();
    void store.loadCatalog();
  });

  return (
    <Screen class="relative w-full h-full flex-col overflow-hidden bg-[#0b0f14]">
      <Header store={store} compact={compact()} />

      <Show when={store.connection() === "offline"}>
        <View class="w-full flex-col px-4 py-2 bg-amber-950 border-b border-amber-900">
          <Text class="text-sm text-amber-200">
            Bridge offline — start `bun examples/gui/bridge/cante-bridge.ts`; the GUI reconnects on its own.
          </Text>
        </View>
      </Show>

      <View class="flex-1 flex-row w-full">
        <Show when={!compact()}>
          <SessionRail store={store} />
        </Show>

        <View class="flex-1 flex-col h-full">
          <Transcript
            rows={store.rows()}
            width={transcriptWidth()}
            height={transcriptHeight()}
            onOpen={setDetail}
            inputActive={() => true}
          />
          <Composer
            store={store}
            busy={store.daemonStatus() === "streaming" || store.daemonStatus() === "thinking"}
            onReady={(open: () => void) => {
              openKeyboard = open;
            }}
          />
        </View>
      </View>

      <StatusBar store={store} />

      <ApprovalModal approval={store.approval()} onRespond={(decisions: ReviewDecision[]) => void store.respond(decisions)} />

      <CommandPalette
        open={store.paletteOpen()}
        commands={store.commands()}
        onClose={() => store.closePalette()}
        onRun={(command) => void store.runCommand(command)}
      />

      <ModelPicker
        open={store.pickerOpen()}
        catalog={store.catalog()}
        currentProvider={store.session()?.provider?.id ?? ""}
        currentModel={store.session()?.model?.id ?? ""}
        busy={store.daemonStatus() === "streaming"}
        onClose={() => store.closePicker()}
        onReload={() => void store.loadCatalog()}
        onPick={(provider: string, model: string) => {
          void store.setModel(provider, model);
          store.closePicker();
        }}
      />

      <DetailModal row={detail()} onClose={() => setDetail(null)} />
    </Screen>
  );
}
