// Cante GUI — the shell.
//
// Two faces share one store:
//
//   * simple (default) — for people who do not work in IT: a first-run wizard,
//     big Chinese task cards, and a plain-language error view. See src/simple/.
//   * pro — the original Codex / Claude-Desktop shape: session rail, streaming
//     transcript, composer, drawers and keyboard shortcuts.
//
// The store remembers the choice in `localStorage`, so a restart lands on the
// same face. Switching is a single, understated control in either direction.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { ReviewDecision } from "./protocol.ts";
import type { Row } from "./rows.ts";
import { createStore, type Store } from "./store.ts";
import { isBridgeAvailable } from "./tauri.ts";
import { APP_NAME, COMMON, TASK_FLOW } from "./simple/copy.ts";
import Home from "./simple/Home.tsx";
import Wizard, { shouldShowWizard } from "./simple/Wizard.tsx";
import type { TaskDef } from "./simple/tasks/index.ts";
import type { VirtualListApi } from "./components/VirtualList.tsx";
import ApprovalPanel from "./components/ApprovalPanel.tsx";
import CapabilitiesPanel from "./components/CapabilitiesPanel.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import Composer from "./components/Composer.tsx";
import DetailModal from "./components/DetailModal.tsx";
import GoalBar from "./components/GoalBar.tsx";
import Header from "./components/Header.tsx";
import ModelPicker from "./components/ModelPicker.tsx";
import SessionRail from "./components/SessionRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import TerminalPane from "./components/TerminalPane.tsx";
import Transcript from "./components/Transcript.tsx";

/** The rail folds away below this width (contract: usable at 800×560). */
const COMPACT_WIDTH = 900;

// ---------------------------------------------------------------------------
// Simple mode
// ---------------------------------------------------------------------------

/** What the person asked for: a card, or a sentence typed into the box. */
interface ActiveTask {
  task: TaskDef | null;
  instruction: string;
}

export interface SimpleAppProps {
  store: Store;
  /**
   * The task-flow host. r5-tasks' `TaskRunner` is wired here by the integrator.
   * Until it lands, the built-in `TaskSeam` shows a read-only preview of the
   * chosen task's plan, so pressing a card is never a dead end.
   */
  renderTask?(task: TaskDef | null, instruction: string, onExit: () => void): JSX.Element;
}

/**
 * The mount point for the task flow. Deterministic and Chinese-only: it repeats
 * the plan the card promised and gets out of the way.
 */
function TaskSeam(props: { active: ActiveTask; onBack(): void }): JSX.Element {
  return (
    <div class="flex h-full min-h-0 items-center justify-center overflow-y-auto px-5 py-8">
      <div class="w-full max-w-xl rounded-2xl border border-slate-700 bg-[#141b24] px-6 py-7">
        <h1 class="text-[24px] leading-tight font-bold text-slate-100">
          {props.active.task?.title ?? TASK_FLOW.saidTitle}
        </h1>

        <Show when={props.active.task}>
          {(task) => (
            <>
              <p class="mt-2 text-[16px] text-slate-400">{task().example}</p>
              <h2 class="mt-5 text-[20px] font-semibold text-slate-200">{TASK_FLOW.planTitle}</h2>
              <ol class="mt-2 flex flex-col gap-2">
                <For each={task().plan}>
                  {(step, index) => (
                    <li class="flex gap-3 text-[17px] leading-relaxed text-slate-300">
                      <span class="text-slate-500">{index() + 1}.</span>
                      <span>{step}</span>
                    </li>
                  )}
                </For>
              </ol>
            </>
          )}
        </Show>

        <Show when={!props.active.task}>
          <p class="mt-3 text-[17px] leading-relaxed text-slate-300">
            {props.active.instruction}
          </p>
        </Show>

        <p class="mt-5 text-[16px] leading-relaxed text-slate-500">
          {TASK_FLOW.previewNote}
        </p>

        <button
          type="button"
          onClick={() => props.onBack()}
          class="mt-6 min-h-[52px] w-full rounded-xl border border-slate-700 px-6 text-[18px] text-slate-200 hover:border-slate-500"
        >
          {COMMON.back}
        </button>
      </div>
    </div>
  );
}

function SimpleApp(props: SimpleAppProps): JSX.Element {
  const [wizard, setWizard] = createSignal(shouldShowWizard());
  const [active, setActive] = createSignal<ActiveTask | null>(null);

  // Keep the bridge alive so the task flow can talk to the daemon the moment it
  // needs to; the health probe inside the wizard is independent of this.
  onMount(() => {
    props.store.connect();
  });

  const pick = (task: TaskDef): void => {
    setActive({ task, instruction: "" });
  };
  const say = (text: string): void => {
    setActive({ task: null, instruction: text });
  };
  const exit = (): void => {
    setActive(null);
  };

  return (
    <div class="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0f14] text-slate-100">
      <header class="flex shrink-0 items-center justify-between gap-3 px-5 py-1">
        <span class="text-[20px] font-bold tracking-wide text-slate-200">{APP_NAME}</span>
        <button
          type="button"
          onClick={() => props.store.setMode("pro")}
          class="min-h-[44px] rounded-lg px-3 text-[16px] text-slate-500 hover:text-slate-200"
        >
          {COMMON.proMode}
        </button>
      </header>

      <main class="min-h-0 flex-1">
        <Show
          when={!wizard()}
          fallback={<Wizard onDone={() => setWizard(false)} />}
        >
          <Show
            when={active()}
            fallback={<Home onPickTask={pick} onSubmitText={say} />}
          >
            {(current) =>
              props.renderTask
                ? props.renderTask(current().task, current().instruction, exit)
                : <TaskSeam active={current()} onBack={exit} />
            }
          </Show>
        </Show>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pro mode — the original shell, unchanged.
// ---------------------------------------------------------------------------

function ProApp(props: { store: Store }): JSX.Element {
  const store = props.store;
  const [width, setWidth] = createSignal(typeof window === "undefined" ? 1180 : window.innerWidth);
  const [detail, setDetail] = createSignal<Row | null>(null);
  // Drawers: capabilities on the right, the terminal along the bottom.
  const [capsOpen, setCapsOpen] = createSignal(false);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  // Whether the transcript is following the newest line; the status bar offers
  // a jump back when it is not.
  const [following, setFollowing] = createSignal(true);
  let transcript: VirtualListApi | undefined;

  const compact = (): boolean => width() < COMPACT_WIDTH;
  // A running turn: Enter in the composer steers it instead of sending a fresh
  // prompt. `awaiting` is deliberately included nowhere — the approval gate
  // owns the turn then, and it is answered, not steered.
  const turnRunning = (): boolean => {
    const status = store.daemonStatus();
    return status === "streaming" || status === "thinking";
  };
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
    if (meta && key === "o") {
      event.preventDefault();
      store.cycleDensity();
      return;
    }
    // ⌘` / Ctrl+` — the terminal drawer. `code` keeps it working on layouts
    // where the key is a dead key or sits elsewhere on the keyboard.
    if (meta && (event.code === "Backquote" || event.key === "`")) {
      event.preventDefault();
      setTerminalOpen((open) => !open);
      return;
    }
    if (meta && event.key === ".") {
      event.preventDefault();
      void store.interrupt();
      return;
    }
    // Escape closes the drawers, but an open overlay or slash palette owns it
    // first (Overlay stops propagation; the inline palette does not).
    if (
      event.key === "Escape" &&
      !store.paletteVisible() &&
      !store.paletteOpen() &&
      !store.pickerOpen()
    ) {
      if (capsOpen()) {
        setCapsOpen(false);
        return;
      }
      if (terminalOpen()) setTerminalOpen(false);
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
      <Header
        store={store}
        compact={compact()}
        capsOpen={capsOpen()}
        onToggleCaps={() => setCapsOpen((open) => !open)}
        terminalOpen={terminalOpen()}
        onToggleTerminal={() => setTerminalOpen((open) => !open)}
      />

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
            onPinnedChange={setFollowing}
            apiRef={(api) => {
              transcript = api;
            }}
          />
          <GoalBar store={store} />
          <Composer store={store} busy={turnRunning()} />
        </main>
      </div>

      <Show when={terminalOpen()}>
        <TerminalPane store={store} onClose={() => setTerminalOpen(false)} />
      </Show>

      <StatusBar
        store={store}
        following={following()}
        onJumpToLatest={() => transcript?.scrollToBottom()}
      />

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

      {/* Right-side capabilities drawer; closed until the CAPS chip is pressed. */}
      <Show when={capsOpen()}>
        <div
          class="fixed inset-0 z-30 bg-black/30"
          aria-hidden="true"
          onClick={() => setCapsOpen(false)}
        />
        <aside
          aria-label="Capabilities drawer"
          class="fixed inset-y-0 right-0 z-40 flex w-[340px] max-w-full flex-col border-l border-slate-800 bg-[#0e141b] shadow-2xl"
        >
          {/* The panel brings its own CAPABILITIES title; this strip is only
              the drawer's own chrome. */}
          <div class="flex shrink-0 items-center justify-end gap-2 border-b border-slate-800 px-3 py-2">
            <button
              type="button"
              onClick={() => setCapsOpen(false)}
              aria-label="Close capabilities"
              title="Close capabilities (Esc)"
              class="rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[10px] tracking-widest text-slate-400 hover:border-sky-500 hover:text-slate-100"
            >
              CLOSE
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <CapabilitiesPanel store={store} />
          </div>
        </aside>
      </Show>

      {/* Back to the simple face. Kept out of the header so the professional
          layout is byte-for-byte what it was. */}
      <button
        type="button"
        onClick={() => store.setMode("simple")}
        title={COMMON.simpleMode}
        class="fixed right-2 bottom-9 z-50 min-h-[44px] rounded-full border border-slate-700 bg-[#0e141b]/90 px-3 text-[16px] text-slate-400 hover:text-slate-100"
      >
        {COMMON.simpleMode}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode switch
// ---------------------------------------------------------------------------

export default function App(): JSX.Element {
  const store = createStore();
  return (
    <Show when={store.mode() === "pro"} fallback={<SimpleApp store={store} />}>
      <ProApp store={store} />
    </Show>
  );
}
