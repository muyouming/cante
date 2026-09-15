// Approval gate — the GUI's counterpart to the TUI approval prompt.
//
// A paused turn arrives as `TurnPause { reason: Approval { tools, message } }`.
// Each requested call gets its own decision (Once / Session / Always / Deny),
// and nothing resumes until the batch is answered.
import { Focusable, Modal, Text, View } from "@pocketjs/framework/components";
import { VirtualList } from "@pocketjs/framework/virtual-list";
import { Show, createEffect, createSignal } from "solid-js";

import { DECISION_LABELS, previewJson, type PendingApproval, type ReviewDecision } from "../protocol.ts";

export interface ApprovalModalProps {
  approval: PendingApproval | null;
  onRespond(decisions: ReviewDecision[]): void;
}

const CYCLE: readonly ReviewDecision[] = ["Accept", "AcceptForSession", "AcceptAlways", "Deny"];
const ROW_HEIGHT = 72;
const LIST_HEIGHT = 216;

function nextDecision(current: ReviewDecision): ReviewDecision {
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length]!;
}

function decisionTone(decision: ReviewDecision): string {
  if (decision === "Deny") return "text-xs text-red-400 font-bold";
  if (decision === "AcceptAlways") return "text-xs text-amber-300 font-bold";
  return "text-xs text-emerald-400 font-bold";
}

export default function ApprovalModal(props: ApprovalModalProps) {
  const [decisions, setDecisions] = createSignal<ReviewDecision[]>([]);

  createEffect(() => {
    const pending = props.approval;
    setDecisions(pending ? pending.tools.map(() => "Accept" as ReviewDecision) : []);
  });

  const open = () => props.approval !== null;
  const tools = () => props.approval?.tools ?? [];

  const cycle = (index: number) => {
    setDecisions((list) => list.map((decision, at) => (at === index ? nextDecision(decision) : decision)));
  };

  const submit = () => {
    const list = decisions();
    props.onRespond(list.length > 0 ? list : tools().map(() => "Accept" as ReviewDecision));
  };

  const denyAll = () => {
    props.onRespond(tools().map(() => "Deny" as ReviewDecision));
  };

  return (
    <Modal
      open={open}
      class="absolute inset-0 z-50 flex-col items-center justify-center"
      panelClass="flex-col gap-3 w-[560] p-4 rounded-xl shadow-lg bg-slate-900 border-slate-700"
    >
      <Show when={props.approval}>
        <View class="flex-col gap-1">
          <Text class="text-base text-slate-50 font-bold">Approval required</Text>
          <Text class="text-sm text-slate-400">
            {props.approval?.message || "Cante wants to run the following tool calls."}
          </Text>
        </View>

        <VirtualList
          count={tools().length}
          rowHeight={ROW_HEIGHT}
          height={LIST_HEIGHT}
          inputActive={() => true}
          onRowPress={(index) => cycle(index)}
          renderRow={(index) => {
            const tool = tools()[index];
            const decision = decisions()[index] ?? "Accept";
            if (!tool) return <View class="w-full h-[72]" />;
            return (
              <Focusable class="w-full h-[72] flex-col justify-center gap-1 px-3 py-2 rounded-md bg-slate-950 border-slate-800 focus:border-sky-500 active:bg-slate-800">
                <View class="flex-row items-center justify-between">
                  <Text class="text-sm text-sky-300 font-bold">{tool.name}</Text>
                  <Text class={decisionTone(decision)}>{DECISION_LABELS[decision].toUpperCase()}</Text>
                </View>
                <Text class="text-xs font-mono text-slate-400">{previewJson(tool.args, 120)}</Text>
              </Focusable>
            );
          }}
        />

        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-xs text-slate-500">Press a row to cycle Once · Session · Always · Deny</Text>
          <View class="flex-row items-center gap-2">
            <Focusable
              onPress={denyAll}
              class="h-[36] w-[96] flex-col justify-center items-center rounded-md bg-slate-800 focus:bg-slate-700 active:bg-slate-600"
            >
              <Text class="text-sm text-slate-100 font-bold">DENY ALL</Text>
            </Focusable>
            <Focusable
              onPress={submit}
              class="h-[36] w-[112] flex-col justify-center items-center rounded-md bg-emerald-600 focus:bg-emerald-500 active:bg-emerald-700"
            >
              <Text class="text-sm text-white font-bold">APPROVE</Text>
            </Focusable>
          </View>
        </View>
      </Show>
    </Modal>
  );
}
