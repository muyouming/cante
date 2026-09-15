// Cante GUI — the shell.
//
// Codex / Claude-Desktop shape: a session rail on the left, a streaming
// transcript in the middle, a composer pinned to the bottom, and a status strip
// under it. One store fed by the Tauri bridge drives every panel; keyboard
// shortcuts live here.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { ReviewDecision } from "./protocol.ts";
import type { Row } from "./rows.ts";
import { createStore } from "./store.ts";
import { isBridgeAvailable } from "./tauri.ts";
import ApprovalPanel from "./components/ApprovalPanel.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import Composer from "./components/Composer.tsx";
import DetailModal from "./components/DetailModal.tsx";
import Header from "./components/Header.tsx";
import ModelPicker from "./components/ModelPicker.tsx";
import SessionRail from "./components/SessionRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import Transcript from "./components/Transcript.tsx";

/** The rail folds away below this width (contract: usable at 800×560). */
const COMPACT_WIDTH = 900;

export default function App(): JSX.Element {
  const store = createStore();
  const [width, setWidth] = createSignal(typeof window === "undefined" ? 1180 : window.innerWidth);
  const [detail, setDetail] = createSignal<Row | null>(null);

  const compact = (): boolean => width() < COMPACT_WIDTH;
  // The webview is the desktop app when the Tauri host is present; a plain
  // browser tab can never reach the daemon, and says so instead.
  const bridge = isBridgeAvailable();

  const onKeyDown = (event: KeyboardEvent): void => {
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (meta && key === "k") {
      event.preventDefault();
      if (store.paletteOpen()) store.closePalette();
      else store.openPalette();
      return;
    }
    if (meta && key === "m") {
      event.preventDefault();
      if (store.pickerOpen()) store.closePicker();
      else store.openPicker();
      return;
    }
    if (meta && event.key === ".") {
      event.preventDefault();
      void store.interrupt();
      return;
    }
    // Overlays own Escape: they restore focus to their opener on close. The
    // approval gate is deliberately not dismissible.
  };

  onMount(() => {
    const onResize = (): void => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);
    store.connect();
    void store.loadCatalog();
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <div class="relative flex h-screen w-screen flex-col overflow-hidden bg-[#0b0f14] text-slate-100">
      <Header store={store} compact={compact()} />

      <Show when={store.connection() === "offline"}>
        <div
          class="flex w-full shrink-0 items-center border-b border-amber-900 bg-amber-950 px-4 py-2"
          role="alert"
        >
          <span class="text-sm text-amber-200">
            {bridge
              ? "Daemon offline — the cante daemon is not responding; the GUI reconnects on its own."
              : "Desktop bridge unavailable — this is the browser preview; open the Cante desktop app to talk to the daemon."}
          </span>
        </div>
      </Show>

      <div class="flex min-h-0 w-full flex-1">
        <Show when={!compact()}>
          <SessionRail store={store} />
        </Show>

        <main class="flex min-h-0 min-w-0 flex-1 flex-col">
          <Transcript
            rows={store.rows()}
            onOpen={setDetail}
            connection={store.connection()}
            hasSession={store.session() !== null}
            bridge={bridge}
          />
          <Composer
            store={store}
            busy={store.daemonStatus() === "streaming" || store.daemonStatus() === "thinking"}
          />
        </main>
      </div>

      <StatusBar store={store} />

      <ApprovalPanel
        approval={store.approval()}
        onRespond={(decisions: ReviewDecision[]) => void store.respond(decisions)}
      />

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
    </div>
  );
}
