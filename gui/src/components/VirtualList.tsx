// Uniform-height windowed list.
//
// The transcript is a flat stream of 20px display lines, so a plain fixed-row
// virtual list is all that is needed; it keeps a 400-row / 100k-line transcript
// from ever putting more than a screenful of nodes in the DOM. `stickToBottom`
// pins the newest line unless the user scrolls up.
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  renderRow(index: number): JSX.Element;
  stickToBottom?: boolean;
  overscan?: number;
  class?: string;
  empty?: JSX.Element;
}

export default function VirtualList(props: VirtualListProps): JSX.Element {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [pinned, setPinned] = createSignal(props.stickToBottom ?? false);
  let element: HTMLDivElement | undefined;

  const overscan = () => props.overscan ?? 6;

  const onScroll = (): void => {
    if (!element) return;
    setScrollTop(element.scrollTop);
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distance <= props.rowHeight * 2);
  };

  onMount(() => {
    const node = element;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport(node.clientHeight));
    observer.observe(node);
    setViewport(node.clientHeight);
    if (props.stickToBottom) node.scrollTop = node.scrollHeight;
    onCleanup(() => observer.disconnect());
  });

  // New rows arrive at the bottom; keep them in view while pinned.
  createEffect(() => {
    const total = props.count;
    void total;
    if (!element || !pinned()) return;
    queueMicrotask(() => {
      if (element) element.scrollTop = element.scrollHeight;
    });
  });

  const first = (): number =>
    Math.max(0, Math.floor(scrollTop() / props.rowHeight) - overscan());

  const indices = (): number[] => {
    const start = first();
    const end = Math.min(props.count, start + Math.ceil((viewport() || 0) / props.rowHeight) + overscan() * 2);
    const out: number[] = [];
    for (let index = start; index < end; index += 1) out.push(index);
    return out;
  };

  return (
    <div
      ref={(node) => {
        element = node ?? undefined;
      }}
      class={`overflow-y-auto overflow-x-hidden ${props.class ?? ""}`}
      onScroll={onScroll}
    >
      <Show
        when={props.count > 0}
        fallback={<div class="h-full w-full">{props.empty}</div>}
      >
        <div class="relative w-full" style={{ height: `${props.count * props.rowHeight}px` }}>
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
