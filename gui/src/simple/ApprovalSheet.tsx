// #60 — the pause, in plain Chinese.
//
// When cante stops to ask, this is the whole decision: what it wants to do,
// which of the user's files that involves, and three buttons where the safe
// answer is the one already in focus. The raw call is still available, one
// click away, for the colleague who gets asked to help.
//
// There is no dismiss: answering is the only way out of a pause. Esc does
// nothing, and neither does clicking outside, so the turn can never be left in
// a state where the window looks frozen — which is exactly what happened before
// this screen existed.
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { ReviewDecision } from "../protocol.ts";
import type { Store } from "../store.ts";
import { describeApproval } from "./approval.ts";
import { APPROVAL } from "./copy.ts";

export interface ApprovalSheetProps {
  store: Store;
}

const primary = "min-h-[52px] rounded-lg px-5 text-[17px] font-bold";
const secondary = "min-h-[52px] rounded-lg px-5 text-[17px] font-semibold";

export default function ApprovalSheet(props: ApprovalSheetProps): JSX.Element {
  const [showDetail, setShowDetail] = createSignal(false);

  const tools = () => props.store.approval()?.tools ?? [];
  const described = () => describeApproval(tools());
  const message = () => props.store.approval()?.message ?? "";

  const answer = (decision: ReviewDecision): void => {
    const list = tools();
    if (list.length === 0) return;
    void props.store.respond(list.map(() => decision));
  };

  return (
    <Show when={props.store.approval()}>
      <section
        class="mx-auto mt-6 max-w-2xl rounded-2xl border-2 border-amber-600 bg-[#1b1508] px-6 py-6"
        aria-label={APPROVAL.title}
      >
        <h2 class="text-[22px] font-bold text-amber-100">{APPROVAL.title}</h2>
        <p class="mt-2 text-[17px] leading-relaxed text-amber-200">{APPROVAL.lead(tools().length)}</p>

        <Show when={message()}>
          <p class="mt-2 text-[16px] leading-relaxed text-amber-200/80">{message()}</p>
        </Show>

        <Show
          when={described().length > 0}
          fallback={<p class="mt-4 text-[16px] text-amber-200">{APPROVAL.nothingToShow}</p>}
        >
          <ul class="mt-4 flex flex-col gap-3">
            <For each={described()}>
              {(tool) => (
                <li class="rounded-lg border border-amber-800 bg-[#241c0b] px-4 py-3">
                  <p class="text-[18px] font-semibold text-amber-50">{tool.action}</p>
                  <Show when={tool.files.length > 0}>
                    <p class="mt-1 text-[16px] text-amber-200/80">
                      {APPROVAL.touched}
                      {tool.files.join("、")}
                    </p>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="mt-5 flex flex-wrap items-center gap-3">
          {/* The safe answer holds the focus, so Enter without thinking is safe. */}
          <button
            type="button"
            autofocus
            class={`${primary} border border-slate-500 bg-slate-800 text-slate-100 hover:bg-slate-700`}
            onClick={() => answer("Deny")}
          >
            {APPROVAL.deny}
          </button>
          <button
            type="button"
            class={`${secondary} bg-emerald-700 text-white hover:bg-emerald-600`}
            onClick={() => answer("Accept")}
          >
            {APPROVAL.allowOnce}
          </button>
          <button
            type="button"
            class={`${secondary} border border-emerald-700 bg-transparent text-emerald-200 hover:bg-emerald-900`}
            onClick={() => answer("AcceptAlways")}
          >
            {APPROVAL.allowAlways}
          </button>
        </div>

        <p class="mt-3 text-[16px] leading-relaxed text-amber-200/80">{APPROVAL.denyHint}</p>

        <Show when={described().length > 0}>
          <button
            type="button"
            class="mt-4 min-h-[44px] text-[16px] text-amber-300/80 underline hover:text-amber-100"
            onClick={() => setShowDetail((open) => !open)}
          >
            {APPROVAL.detailToggle}
          </button>
          <Show when={showDetail()}>
            <ul class="mt-2 flex flex-col gap-2">
              <For each={tools()}>
                {(tool) => (
                  <li class="rounded border border-amber-900 bg-[#120e06] px-3 py-2 text-[15px] text-amber-200/80">
                    <span class="font-mono">{tool.name}</span>
                    <span class="ml-2 font-mono break-all">
                      {described()[tools().indexOf(tool)]?.detail ?? ""}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
