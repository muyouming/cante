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
import { createSignal, onMount, Match, Show, Switch, For, onCleanup } from "solid-js";
import type { JSX } from "solid-js";

import type { ReviewDecision } from "./protocol.ts";
import type { Row } from "./rows.ts";
import { createStore, type Store } from "./store.ts";
import { isBridgeAvailable } from "./tauri.ts";
import { APP_NAME, COMMON, TASK_FLOW } from "./simple/copy.ts";
import ErrorView from "./simple/ErrorView.tsx";
import Home from "./simple/Home.tsx";
import Wizard, { shouldShowWizard } from "./simple/Wizard.tsx";
import { freeTask, type TaskDef } from "./simple/tasks/index.ts";
import { initCapabilities } from "./simple/capabilities.ts";
import History from "./simple/History.tsx";
import PrivacyPanel from "./simple/PrivacyPanel.tsx";
import TaskRunner from "./simple/TaskRunner.tsx";
import WechatImport from "./simple/WechatImport.tsx";
import type { VirtualListApi } from "./components/VirtualList.tsx";

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
  // A browser tab can never reach the desktop host. Say so in plain Chinese
  // (#44) instead of showing a plan that could never run.
  const [failure, setFailure] = createSignal<unknown>(null);
  const [panel, setPanel] = createSignal<"history" | "privacy" | null>(null);

  // Keep the bridge alive so the task flow can talk to the daemon the moment it
  // needs to; the health probe inside the wizard is independent of this.
  onMount(() => {
    props.store.connect();
    // #75/#50 — 启动时问一次这台电脑能做什么（表格、PDF）；不阻塞渲染。
    void initCapabilities();
  });

  const enter = (next: ActiveTask): void => {
    setActive(next);
    setFailure(isBridgeAvailable() ? null : "desktop bridge unavailable");
  };
  const pick = (task: TaskDef): void => {
    enter({ task, instruction: "" });
  };
  const say = (text: string): void => {
    enter({ task: null, instruction: text });
  };
  const exit = (): void => {
    setActive(null);
    setFailure(null);
  };
  const retry = (): void => {
    setFailure(isBridgeAvailable() ? null : "desktop bridge unavailable");
  };

  return (
    <div class="relative flex h-screen w-screen flex-col overflow-hidden bg-[#0b0f14] text-slate-100">
      <header class="flex shrink-0 items-center justify-between gap-3 px-5 py-1">
        <span class="text-[20px] font-bold tracking-wide text-slate-200">{APP_NAME}</span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPanel("history")}
            class="min-h-[44px] rounded-lg px-3 text-[16px] text-slate-400 hover:text-slate-200"
          >
            {COMMON.history}
          </button>
          <button
            type="button"
            onClick={() => setPanel("privacy")}
            class="min-h-[44px] rounded-lg px-3 text-[16px] text-slate-400 hover:text-slate-200"
          >
            {COMMON.privacy}
          </button>
        </div>
      </header>

      <main class="min-h-0 flex-1">
        <Show
          when={!wizard()}
          fallback={<Wizard onDone={() => setWizard(false)} />}
        >
          <Show
            when={active()}
            fallback={<Home store={props.store} onPickTask={pick} onSubmitText={say} />}
          >
            {(current) => (
              <Show
                when={failure()}
                fallback={
                  props.renderTask
                    ? props.renderTask(current().task, current().instruction, exit)
                    : <TaskSeam active={current()} onBack={exit} />
                }
              >
                <ErrorView error={failure()} onRetry={retry} onAlternative={exit} onBack={exit} />
              </Show>
            )}
          </Show>
        </Show>
      </main>

      {/* Full-screen panels: the task history (#57) and where the data goes (#40). */}
      <Show when={panel()}>
        <div class="absolute inset-0 z-50 flex flex-col bg-[#0b0f14] px-5 py-4">
          <button
            type="button"
            onClick={() => setPanel(null)}
            class="mb-3 min-h-[44px] self-start rounded-lg pr-3 text-[16px] text-slate-400 hover:text-slate-200"
          >
            ← {COMMON.back}
          </button>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <Switch>
              <Match when={panel() === "history"}>
                <History store={props.store} />
              </Match>
              <Match when={panel() === "privacy"}>
                <PrivacyPanel store={props.store} />
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default function App(): JSX.Element {
  const store = createStore();
  return (
    <SimpleApp
      store={store}
      renderTask={(task, instruction, onExit) =>
        task?.group === "微信" ? (
          <WechatImport store={store} />
        ) : (
          <TaskRunner
            store={store}
            task={task ?? freeTask(instruction)}
            initialInstruction={instruction}
            onExit={onExit}
          />
        )
      }
    />
  );
}
