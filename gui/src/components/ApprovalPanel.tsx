// Approval gate — the GUI's counterpart to the TUI approval prompt.
//
// A paused turn arrives as `TurnPause { reason: Approval { tools, message } }`
// (and is mirrored by `cante://state`). Each requested call gets its own
// Once / Session / Always / Deny choice, and nothing resumes until the batch is
// answered — so this overlay is deliberately blocking (no Esc, no backdrop
// dismiss), but it still traps focus and announces itself as a modal dialog.
import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { DECISION_LABELS, previewJson, type PendingApproval, type ReviewDecision } from "../protocol.ts";
import Overlay from "./Overlay.tsx";

export interface ApprovalPanelProps {
  approval: PendingApproval | null;
  onRespond(decisions: ReviewDecision[]): void;
}

const DECISIONS: readonly ReviewDecision[] = ["Accept", "AcceptForSession", "AcceptAlways", "Deny"];

function decisionClass(decision: ReviewDecision, selected: boolean): string {
  const base = "rounded px-2 py-1 text-[11px] font-bold tracking-wide border";
  if (!selected) return `${base} border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600 hover:text-slate-200`;
  if (decision === "Deny") return `${base} border-red-700 bg-red-950 text-red-300`;
  if (decision === "AcceptAlways") return `${base} border-amber-700 bg-amber-950 text-amber-300`;
  return `${base} border-emerald-700 bg-emerald-950 text-emerald-300`;
}

export default function ApprovalPanel(props: ApprovalPanelProps): JSX.Element {
  const [decisions, setDecisions] = createSignal<ReviewDecision[]>([]);

  createEffect(() => {
    const pending = props.approval;
    setDecisions(pending ? pending.tools.map(() => "Accept" as ReviewDecision) : []);
  });

  const tools = (): PendingApproval["tools"] => props.approval?.tools ?? [];

  const choose = (index: number, decision: ReviewDecision): void => {
    setDecisions((list) => list.map((current, at) => (at === index ? decision : current)));
  };

  const submit = (): void => {
    const list = decisions();
    props.onRespond(list.length > 0 ? list : tools().map(() => "Accept" as ReviewDecision));
  };

  const denyAll = (): void => {
    props.onRespond(tools().map(() => "Deny" as ReviewDecision));
  };

  return (
    <Overlay
      open={props.approval !== null}
      label="Approval required"
      dismissible={false}
      panelClass="max-w-[620px]"
    >
      <Show when={props.approval}>
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-bold text-slate-50">Approval required</h2>
          <span class="text-sm text-slate-400">
            {props.approval?.message || "Cante wants to run the following tool calls."}
          </span>
        </div>

        <div class="flex max-h-[320px] flex-col gap-2 overflow-y-auto">
          <For each={tools()}>
            {(tool, index) => (
              <div class="flex flex-col gap-2 rounded-md border border-slate-800 bg-slate-950 px-3 py-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-bold text-sky-300">{tool.name}</span>
                  <span class="shrink-0 font-mono text-[10px] text-slate-600">{tool.id}</span>
                </div>
                <span class="truncate font-mono text-xs text-slate-400" title={previewJson(tool.args, 400)}>
                  {previewJson(tool.args, 160)}
                </span>
                <div
                  class="flex flex-wrap gap-1"
                  role="group"
                  aria-label={`Decision for ${tool.name}`}
                >
                  <For each={DECISIONS}>
                    {(decision) => (
                      <button
                        type="button"
                        onClick={() => choose(index(), decision)}
                        aria-pressed={(decisions()[index()] ?? "Accept") === decision}
                        class={decisionClass(decision, (decisions()[index()] ?? "Accept") === decision)}
                      >
                        {DECISION_LABELS[decision].toUpperCase()}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-500">
            {tools().length} call{tools().length === 1 ? "" : "s"} · default is Once
          </span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onClick={denyAll}
              class="h-[36px] w-[96px] rounded-md bg-slate-800 text-sm font-bold text-slate-100 hover:bg-slate-700"
            >
              DENY ALL
            </button>
            <button
              type="button"
              onClick={submit}
              class="h-[36px] w-[112px] rounded-md bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-500"
            >
              APPROVE
            </button>
          </div>
        </div>
      </Show>
    </Overlay>
  );
}
