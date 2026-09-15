// Shared modal shell: dimmed backdrop, centered panel, click-outside to close.
import { Show } from "solid-js";
import type { JSX } from "solid-js";

export interface OverlayProps {
  open: boolean;
  /** Omit to make the overlay blocking (used by the approval gate). */
  onClose?(): void;
  children: JSX.Element;
  panelClass?: string;
}

export default function Overlay(props: OverlayProps): JSX.Element {
  return (
    <Show when={props.open}>
      <div
        class="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose?.();
        }}
      >
        <div
          class={`flex max-h-full w-full max-w-[640px] flex-col gap-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl ${props.panelClass ?? ""}`}
        >
          {props.children}
        </div>
      </div>
    </Show>
  );
}
