// Transcript layout: rows -> display lines.
//
// PocketJS's `VirtualList` is uniform-row v1, so instead of asking it for
// variable-height cards this pass flattens every entry into 20px lines — one
// header line (kind chip + time) and one line per wrapped body/output line.
// The list then windows lines, which is what makes fenced code, diffs, and
// long tool output readable without a fixed 96px card.
//
// Everything here is pure: no framework imports, so it unit-tests on Bun.
import type { Row, RowKind, RowTone } from "./rows.ts";

/** Height of one display line, in logical px (matches `leading-5`/text-sm). */
export const LINE_HEIGHT = 20;

export type DiffKind = "add" | "del" | "hunk" | "ctx";

export interface Line {
  key: string;
  /** Index into the source rows array this line belongs to. */
  row: number;
  text: string;
  kind: RowKind;
  tone: RowTone;
  /** Header line: draws the chip + timestamp and the row's top border. */
  chrome: boolean;
  /** Render in the mono face (fenced code, tool args, tool output, diffs). */
  mono: boolean;
  diff: DiffKind | null;
  streaming: boolean;
  /** Last line of its row (draws the closing border). */
  last: boolean;
}

export interface LayoutOptions {
  columns: number;
  monoColumns: number;
  maxLinesPerRow?: number;
  maxOutputLines?: number;
}

const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_OUTPUT_LINES = 80;
const MONO_ADVANCE = 8.6;
const TEXT_ADVANCE = 6.6;

/** Columns that fit `width` logical px in the proportional or mono face. */
export function columnsFor(width: number, mono = false): number {
  const advance = mono ? MONO_ADVANCE : TEXT_ADVANCE;
  return Math.max(16, Math.floor((width - 24) / advance));
}

function wrapLogical(text: string, columns: number): string[] {
  if (text === "") return [""];
  const out: string[] = [];
  let rest = text;
  while (rest.length > columns) {
    let cut = rest.lastIndexOf(" ", columns);
    if (cut <= 0) cut = columns;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  out.push(rest);
  return out;
}

/** `+`/`-`/`@@` classification for mono lines (unified-diff shaped output). */
export function diffKind(line: string): DiffKind | null {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "ctx";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return null;
}

interface Logical {
  text: string;
  mono: boolean;
  diff: DiffKind | null;
}

/** Split a body into logical lines, honoring ``` fences. */
function logicalLines(row: Row): Logical[] {
  const alwaysMono = row.kind === "tool";
  const out: Logical[] = [];
  let fenced = false;
  for (const raw of row.text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const mono = alwaysMono || fenced;
    out.push({ text: raw, mono, diff: mono ? diffKind(raw) : null });
  }
  if (out.length === 0) out.push({ text: "", mono: alwaysMono, diff: null });
  return out;
}

/** Lay one row out into display lines, bounded by `maxLinesPerRow`. */
export function layoutRow(row: Row, rowIndex: number, options: LayoutOptions): Line[] {
  const columns = options.columns;
  const monoColumns = options.monoColumns;
  const maxLines = options.maxLinesPerRow ?? DEFAULT_MAX_LINES;
  const maxOutput = options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;

  const base = {
    row: rowIndex,
    kind: row.kind,
    tone: row.tone,
    streaming: row.streaming,
    last: false,
  } as const;

  const lines: Line[] = [
    { ...base, key: `${row.id}:head`, text: row.label.toUpperCase(), chrome: true, mono: false, diff: null },
  ];

  for (const logical of logicalLines(row)) {
    const budget = logical.mono ? monoColumns : columns;
    for (const piece of wrapLogical(logical.text, budget)) {
      lines.push({
        ...base,
        key: `${row.id}:b${lines.length}`,
        text: piece,
        chrome: false,
        mono: logical.mono,
        diff: logical.diff,
      });
    }
  }

  if (row.detail) {
    lines.push({ ...base, key: `${row.id}:out`, text: "output", chrome: false, mono: true, diff: null });
    const body = row.detail.split("\n");
    for (const raw of body.slice(0, maxOutput)) {
      for (const piece of wrapLogical(raw, monoColumns)) {
        lines.push({
          ...base,
          key: `${row.id}:o${lines.length}`,
          text: piece,
          chrome: false,
          mono: true,
          diff: diffKind(raw),
        });
      }
    }
    if (body.length > maxOutput) {
      lines.push({
        ...base,
        key: `${row.id}:otrunc`,
        text: `… ${body.length - maxOutput} more output line(s) — press for the full entry`,
        chrome: false,
        mono: false,
        diff: null,
      });
    }
  }

  if (lines.length > maxLines) {
    const clipped = lines.slice(0, Math.max(1, maxLines - 1));
    clipped.push({
      ...base,
      key: `${row.id}:trunc`,
      text: `… ${lines.length - maxLines} more line(s) — press for the full entry`,
      chrome: false,
      mono: false,
      diff: null,
    });
    clipped[clipped.length - 1]!.last = true;
    return clipped;
  }

  lines[lines.length - 1]!.last = true;
  return lines;
}

/**
 * Flatten rows into display lines, memoizing per row object. Rows are
 * immutable and only the streaming tail is replaced, so a poll batch re-lays
 * out just the entries that actually changed.
 */
export function createLayoutCache() {
  const cache = new WeakMap<Row, { columns: number; monoColumns: number; lines: Line[] }>();
  return function layout(rows: readonly Row[], options: LayoutOptions): Line[] {
    const out: Line[] = [];
    rows.forEach((row, index) => {
      let entry = cache.get(row);
      if (!entry || entry.columns !== options.columns || entry.monoColumns !== options.monoColumns) {
        entry = { columns: options.columns, monoColumns: options.monoColumns, lines: layoutRow(row, index, options) };
        cache.set(row, entry);
      }
      for (const line of entry.lines) out.push({ ...line, row: index });
    });
    return out;
  };
}
