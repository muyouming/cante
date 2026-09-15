// Uniform-height windowed list with explicit scroll anchoring.
//
// The transcript is a flat stream of 20px display lines, so a plain fixed-row
// virtual list is all that is needed; it keeps a 400-row / 100k-line transcript
// from ever putting more than a screenful of nodes in the DOM. The window maths
// is pure and exported so `transcript.window.test.ts` can pin its shape (slice
// size, clamping, anchor lookup) without a DOM or a wall-clock number.
//
// Two behaviours are deliberate and easy to get wrong:
//
//  * `stickToBottom` follows the newest line while the reader is pinned and
//    leaves them alone once they scroll up; the parent renders the
//    "jump to latest" affordance off `onPinnedChange`.
//  * While unpinned, the line at the top of the viewport is remembered by a
//    caller-supplied key (`anchor`) and put back after the content re-lays out.
//    A width change re-wraps every line, so keeping raw `scrollTop` pixels
//    would silently drift the reader to a different entry. Browser scroll
//    anchoring is switched off (`.virtual-scroll`) because it fights that
//    restore.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

export interface WindowGeometry {
  /** Total display lines available. */
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewport: number;
  overscan: number;
}

/** Extra lines mounted on each side so a fast scroll does not show blanks. */
export const DEFAULT_OVERSCAN = 6;

/** Index of the first line the window mounts (clamped to the list). */
export function windowStart(geometry: WindowGeometry): number {
  const { count, rowHeight, scrollTop, overscan } = geometry;
  if (count <= 0 || rowHeight <= 0) return 0;
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight) - Math.max(0, overscan);
  return Math.min(Math.max(0, first), count - 1);
}

/** Exclusive index just past the last line the window mounts. */
export function windowEnd(geometry: WindowGeometry): number {
  const { count, rowHeight, scrollTop, viewport, overscan } = geometry;
  if (count <= 0 || rowHeight <= 0) return 0;
  const last = Math.ceil(Math.max(0, scrollTop + viewport) / rowHeight) + Math.max(0, overscan);
  return Math.min(count, last);
}

/**
 * Number of mounted lines. Bounded by the viewport plus the overscan — never by
 * `count` — which is the whole point of the list.
 */
export function windowSize(geometry: WindowGeometry): number {
  return Math.max(0, windowEnd(geometry) - windowStart(geometry));
}

/** The indices the window mounts, in order. */
export function windowIndices(geometry: WindowGeometry): number[] {
  const start = windowStart(geometry);
  const end = windowEnd(geometry);
  const out: number[] = [];
  for (let index = start; index < end; index += 1) out.push(index);
  return out;
}

/** Keep a pixel scroll offset inside the scrollable range. */
export function clampScrollTop(
  scrollTop: number,
  count: number,
  rowHeight: number,
  viewport: number,
): number {
  const max = Math.max(0, count * rowHeight - Math.max(0, viewport));
  return Math.min(Math.max(0, scrollTop), max);
}

/** Slack below which the list counts as pinned to the newest line. */
export function pinnedSlack(rowHeight: number): number {
  return Math.max(4, Math.floor(rowHeight / 2));
}

/** Whether `scrollTop` still counts as "at the bottom, following the tail". */
export function atBottom(
  scrollTop: number,
  scrollHeight: number,
  viewport: number,
  rowHeight: number,
): boolean {
  return scrollHeight - scrollTop - viewport <= pinnedSlack(rowHeight);
}

/**
 * Index of the first line belonging to `row`, or `null` when that row is not in
 * the window's line list. `rowAt` must be non-decreasing (the transcript emits
 * the lines of a row consecutively), which makes this a binary search: a resize
 * while scrolled up costs O(log n), not O(n).
 */
export function firstLineOfRow(
  count: number,
  rowAt: (index: number) => number,
  row: number,
): number | null {
  let lo = 0;
  let hi = Math.max(0, count);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rowAt(mid) < row) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= count) return null;
  return rowAt(lo) === row ? lo : null;
}

/**
 * `true` when the platform asks for reduced motion. `media` is injectable so
 * the decision is testable without a DOM.
 */
export function prefersReducedMotion(media?: { matches: boolean }): boolean {
  if (media) return media.matches;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Scroll behaviour for a jump to the tail: never animated under reduced motion. */
export function scrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

/** Scroll handle handed to the parent, which renders the jump-to-latest pill. */
export interface VirtualListApi {
  /** Scroll to the newest line and re-pin. */
  scrollToBottom(): void;
  pinned(): boolean;
}

/**
 * Identifies the reading position across re-layouts. `keyAt` names the line at
 * a display index and `indexOf` finds it again after the lines have re-wrapped.
 */
export interface VirtualListAnchor {
  keyAt(index: number): string;
  indexOf(key: string): number | null;
}

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  renderRow(index: number): JSX.Element;
  stickToBottom?: boolean;
  overscan?: number;
  class?: string;
  empty?: JSX.Element;
  /** Reading-position keeper; omit to keep pixel offsets on re-layout. */
  anchor?: VirtualListAnchor;
  /** Fired when the list pins to (or unpins from) the tail. */
  onPinnedChange?(pinned: boolean): void;
  /** Receives the imperative handle once the scroller is mounted. */
  apiRef?(api: VirtualListApi): void;
}

export default function VirtualList(props: VirtualListProps): JSX.Element {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [pinned, setPinned] = createSignal(props.stickToBottom ?? false);
  let element: HTMLDivElement | undefined;
  let contentObserver: ResizeObserver | undefined;
  let anchorKey: string | null = null;
  let jumping = false;
  let jumpTimer: ReturnType<typeof setTimeout> | undefined;

  const overscan = (): number => Math.max(0, props.overscan ?? DEFAULT_OVERSCAN);

  const geometry = (): WindowGeometry => ({
    count: props.count,
    rowHeight: props.rowHeight,
    scrollTop: scrollTop(),
    viewport: viewport(),
    overscan: overscan(),
  });

  const scrollElement = (top: number, behavior: ScrollBehavior): void => {
    const node = element;
    if (!node) return;
    if (typeof node.scrollTo === "function") {
      try {
        node.scrollTo({ top, behavior });
        return;
      } catch {
        // Older WebKit ignores ScrollToOptions; fall through to the assignment.
      }
    }
    node.scrollTop = top;
  };

  /** Follow the tail. `behavior` is "auto" for streaming, "smooth" for a jump. */
  const pinToBottom = (behavior: ScrollBehavior = "auto"): void => {
    const node = element;
    if (!node) return;
    const top = Math.max(0, node.scrollHeight - node.clientHeight);
    setScrollTop(top);
    anchorKey = null;
    setPinned(true);
    if (behavior === "smooth") {
      jumping = true;
      if (jumpTimer !== undefined) clearTimeout(jumpTimer);
      // A smooth scroll that never lands (interrupted by the user) must not
      // latch the scroller into "still jumping" forever.
      jumpTimer = setTimeout(() => {
        jumping = false;
      }, 500);
    }
    scrollElement(top, behavior);
  };

  /** Name the line currently at the top of the viewport. */
  const rememberAnchor = (): void => {
    const node = element;
    if (!node || !props.anchor || props.count <= 0) {
      anchorKey = null;
      return;
    }
    const index = Math.min(Math.max(0, Math.floor(node.scrollTop / props.rowHeight)), props.count - 1);
    anchorKey = props.anchor.keyAt(index);
  };

  /**
   * Put the remembered line back at the top of the viewport after the layout
   * re-wrapped (width change) or grew (streaming above the reader).
   */
  const restoreAnchor = (): void => {
    const node = element;
    if (!node || pinned() || anchorKey === null || !props.anchor) return;
    const index = props.anchor.indexOf(anchorKey);
    if (index === null) {
      anchorKey = null;
      return;
    }
    const top = clampScrollTop(
      index * props.rowHeight,
      props.count,
      props.rowHeight,
      node.clientHeight,
    );
    if (Math.abs(top - node.scrollTop) < 0.5) return;
    setScrollTop(top);
    node.scrollTop = top;
  };

  const onScroll = (): void => {
    const node = element;
    if (!node) return;
    setScrollTop(node.scrollTop);
    const bottom = atBottom(node.scrollTop, node.scrollHeight, node.clientHeight, props.rowHeight);
    if (jumping) {
      // An in-flight jump-to-latest passes through unpinned positions; do not
      // let it flicker the pill back on.
      if (bottom) {
        jumping = false;
        if (jumpTimer !== undefined) clearTimeout(jumpTimer);
        anchorKey = null;
        setPinned(true);
      }
      return;
    }
    setPinned(bottom);
    if (bottom) anchorKey = null;
    else rememberAnchor();
  };

  onMount(() => {
    const node = element;
    if (!node) return;

    const viewportObserver = new ResizeObserver(() => {
      setViewport(node.clientHeight);
      if (pinned()) pinToBottom("auto");
      else restoreAnchor();
    });
    viewportObserver.observe(node);
    setViewport(node.clientHeight);

    if (props.stickToBottom) pinToBottom("auto");
    else rememberAnchor();

    props.apiRef?.({
      scrollToBottom: () => pinToBottom(scrollBehavior(prefersReducedMotion())),
      pinned,
    });

    onCleanup(() => {
      viewportObserver.disconnect();
      contentObserver?.disconnect();
      if (jumpTimer !== undefined) clearTimeout(jumpTimer);
    });
  });

  createEffect(() => {
    props.onPinnedChange?.(pinned());
  });

  const indices = (): number[] => windowIndices(geometry());

  return (
    <div
      ref={(node) => {
        element = node ?? undefined;
      }}
      class={`virtual-scroll overflow-y-auto overflow-x-hidden ${props.class ?? ""}`}
      onScroll={onScroll}
    >
      <Show when={props.count > 0} fallback={<div class="h-full w-full">{props.empty}</div>}>
        <div
          ref={(node) => {
            // The content node only exists while there are lines; observe it
            // from the ref so the first appended batch also pins the tail.
            contentObserver?.disconnect();
            contentObserver = undefined;
            if (!node) return;
            contentObserver = new ResizeObserver(() => {
              if (pinned()) pinToBottom("auto");
              else restoreAnchor();
            });
            contentObserver.observe(node);
          }}
          class="relative w-full"
          style={{ height: `${props.count * props.rowHeight}px` }}
        >
          <For each={indices()}>
            {(index) => (
              <div
                class="absolute left-0 right-0"
                style={{ top: `${index * props.rowHeight}px`, height: `${props.rowHeight}px` }}
              >
                {props.renderRow(index)}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
