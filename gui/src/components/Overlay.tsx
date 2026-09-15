// Shared modal shell: dimmed backdrop, centered dialog panel.
//
// Accessibility: the panel is a real modal dialog (`role="dialog"`,
// `aria-modal`), Tab is trapped inside it while it is open, and closing (Esc
// or a trigger) returns focus to the control that opened it. The approval gate
// opts out of Esc with `dismissible={false}` — answering it is the only way
// out, so it must not be dismissed by an accidental keypress.
import { Show, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

export interface OverlayProps {
  open: boolean;
  /** Omit to make the overlay blocking (used by the approval gate). */
  onClose?(): void;
  /** Accessible name announced when the dialog opens. */
  label?: string;
  /**
   * Esc closes the dialog (default true). Set false for a blocking gate such
   * as the approval prompt, where dismissing would strand the daemon.
   */
  dismissible?: boolean;
  children: JSX.Element;
  panelClass?: string;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Every element inside `root` that can currently take focus. */
function focusable(root: HTMLElement | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.getClientRects().length > 0,
  );
}

/** Mounted only while the overlay is open, so focus bookkeeping is per-dialog. */
function Dialog(props: OverlayProps): JSX.Element {
  let panel: HTMLDivElement | undefined;
  let restore: HTMLElement | null = null;

  onMount(() => {
    const active = document.activeElement;
    // The control that opened this dialog: what focus returns to on close.
    restore = active instanceof HTMLElement && active !== document.body ? active : null;
    queueMicrotask(() => {
      // A child (e.g. the palette filter) may have focused itself already;
      // never steal that initial focus.
      if (panel && panel.contains(document.activeElement)) return;
      const first = focusable(panel)[0];
      (first ?? panel)?.focus();
    });

    // If an assistive tool (or a stray script) moves focus outside the panel,
    // pull it back so the dialog stays modal.
    const keepFocus = (event: FocusEvent): void => {
      if (!panel || !(event.target instanceof Node)) return;
      if (!panel.contains(event.target)) (focusable(panel)[0] ?? panel)?.focus();
    };
    document.addEventListener("focusin", keepFocus);

    onCleanup(() => {
      document.removeEventListener("focusin", keepFocus);
      if (restore?.isConnected) restore.focus();
    });
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (props.dismissible !== false && props.onClose) {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel?.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    const inside = panel ? panel.contains(active) : false;
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose?.();
      }}
    >
      <div
        ref={(node) => {
          panel = node ?? undefined;
        }}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabindex={-1}
        onKeyDown={onKeyDown}
        class={`flex max-h-full w-full max-w-[640px] flex-col gap-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl ${props.panelClass ?? ""}`}
      >
        {props.children}
      </div>
    </div>
  );
}

export default function Overlay(props: OverlayProps): JSX.Element {
  return (
    <Show when={props.open}>
      <Dialog {...props} />
    </Show>
  );
}
