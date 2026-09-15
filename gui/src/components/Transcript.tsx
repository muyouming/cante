// The conversation surface.
//
// `src/transcript.ts` turns rows into uniform 20px display lines — one chrome
// line per entry plus wrapped body/output lines — and the virtual list windows
// them. Clicking a line opens the full entry in `DetailModal`.
//
// The list owns the scroll position; this component only renders the
// "Jump to latest" pill while the reader is scrolled away from the tail, and
// hands the list an anchor so a re-wrap (window resize) keeps their place.
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import type { Row } from "../rows.ts";
import type { Connection } from "../store.ts";
import { LINE_HEIGHT, columnsFor, createLayoutCache, type Line } from "../transcript.ts";
import TranscriptLine from "./TranscriptLine.tsx";
import VirtualList, {
  firstLineOfRow,
  type VirtualListAnchor,
  type VirtualListApi,
} from "./VirtualList.tsx";

const layout = createLayoutCache();

/**
 * The pill exists only when there is something to jump back to: never while
 * pinned, and never on an empty transcript.
 */
export function jumpToLatestVisible(pinned: boolean, count: number): boolean {
  return !pinned && count > 0;
}

export interface TranscriptProps {
  rows: Row[];
  onOpen(row: Row): void;
  /** Tauri bridge reachability, so the empty state can name the real cause. */
  connection: Connection;
  /** False when no session has been opened yet. */
  hasSession: boolean;
  /** False in the plain-browser preview. */
  bridge: boolean;
  /** Reports whether the view is following the newest line. */
  onPinnedChange?(pinned: boolean): void;
  /** Scroll handle, so the status bar can offer the same jump. */
  apiRef?(api: VirtualListApi): void;
}

/** The copy shown when there is nothing to read, keyed on why that is. */
function emptyText(props: TranscriptProps): { title: string; body: JSX.Element } {
  if (!props.bridge) {
    return {
      title: "Browser preview",
      body: (
        <>
          This is the browser preview — desktop bridge unavailable, so the daemon cannot be
          reached. Open the Cante desktop app to talk to your session.
        </>
      ),
    };
  }
  if (props.connection === "offline") {
    return {
      title: "Daemon offline",
      body: (
        <>
          The cante daemon is not responding. The GUI reconnects on its own; check the status and the
          last log line in the session rail.
        </>
      ),
    };
  }
  if (!props.hasSession) {
    return {
      title: "No session yet",
      body: <>The GUI is starting a session. If this stays empty, check the bridge status in the session rail.</>,
    };
  }
  return {
    title: "CANTE",
    body: (
      <>
        Ask a question below, or press <span class="text-slate-300">⌘K</span> for commands. A leading{" "}
        <span class="font-mono text-slate-300">/</span> runs a skill or built-in.
      </>
    ),
  };
}

export default function Transcript(props: TranscriptProps): JSX.Element {
  const [width, setWidth] = createSignal(720);
  const [pinned, setPinned] = createSignal(true);
  let element: HTMLDivElement | undefined;
  let list: VirtualListApi | undefined;

  onMount(() => {
    const node = element;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    onCleanup(() => observer.disconnect());
  });

  const lines = createMemo<Line[]>(() => {
    const columns = columnsFor(width());
    const monoColumns = Math.max(16, columnsFor(width(), true) - 2);
    return layout(props.rows, { columns, monoColumns });
  });

  // The list asks for the row index at a display line and back again; both are
  // derived from the freshly laid-out lines, so a re-wrap resolves the anchor
  // to its new line index on the same frame.
  const anchor: VirtualListAnchor = {
    keyAt: (index) => {
      const lines0 = lines();
      if (lines0.length === 0) return "";
      const clamped = Math.min(Math.max(0, index), lines0.length - 1);
      return String(lines0[clamped]!.row);
    },
    indexOf: (key) => {
      const row = Number(key);
      if (!Number.isFinite(row)) return null;
      const lines0 = lines();
      return firstLineOfRow(lines0.length, (index) => lines0[index]?.row ?? -1, row);
    },
  };

  return (
    <div
      ref={(node) => {
        element = node ?? undefined;
      }}
      class="relative min-h-0 w-full flex-1"
    >
      <VirtualList
        class="h-full w-full"
        count={lines().length}
        rowHeight={LINE_HEIGHT}
        stickToBottom
        anchor={anchor}
        onPinnedChange={(next) => {
          setPinned(next);
          props.onPinnedChange?.(next);
        }}
        apiRef={(api) => {
          list = api;
          props.apiRef?.(api);
        }}
        renderRow={(index) => {
          const line = lines()[index];
          if (!line) return <div class="h-full w-full" />;
          const row = props.rows[line.row];
          return (
            <TranscriptLine
              line={line}
              time={row?.time}
              onOpen={() => {
                if (row) props.onOpen(row);
              }}
            />
          );
        }}
        empty={
          <div class="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            <span class="text-sm font-bold tracking-widest text-slate-600">{emptyText(props).title}</span>
            <span class="max-w-[420px] text-sm text-slate-500">{emptyText(props).body}</span>
          </div>
        }
      />

      <Show when={jumpToLatestVisible(pinned(), lines().length)}>
        <button
          type="button"
          class="jump-pill absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-sky-700 bg-sky-900/95 px-3 py-1 text-xs font-medium text-sky-100 shadow-lg transition-colors duration-150 hover:bg-sky-800 motion-reduce:transition-none"
          onClick={() => list?.scrollToBottom()}
          aria-label="Jump to the latest output and follow the session again"
        >
          <span aria-hidden="true">↓</span>
          Jump to latest
        </button>
      </Show>
    </div>
  );
}
