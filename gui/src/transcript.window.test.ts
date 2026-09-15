// Window maths guard for the virtualized transcript.
//
// The transcript can be thousands of rows / tens of thousands of 20px display
// lines, and the list must never mount more than a screenful of them. These
// tests pin the *shape* of the window — slice size, clamping, anchor lookup —
// rather than any wall-clock number, so they cannot flake on a loaded machine
// and still catch a regression that makes the window scale with the transcript.
//
//   cd gui && bun test src
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OVERSCAN,
  atBottom,
  clampScrollTop,
  firstLineOfRow,
  prefersReducedMotion,
  scrollBehavior,
  windowEnd,
  windowIndices,
  windowSize,
  windowStart,
  type WindowGeometry,
} from "./components/VirtualList.tsx";
import { jumpToLatestVisible } from "./components/Transcript.tsx";
import { LINE_HEIGHT } from "./transcript.ts";

/** 5000 transcript rows is the size the layout has to stay cheap at. */
const ROWS = 5000;
const ROW = LINE_HEIGHT;
const OVERSCAN = DEFAULT_OVERSCAN;

/**
 * Transcript viewport heights: the window is 560 and 760 logical px tall, minus
 * the header, composer and status strip (~200px) — the exact number does not
 * matter, the bound below is derived from whatever is passed in.
 */
const VIEWPORTS = [360, 560];

function geometry(overrides: Partial<WindowGeometry> = {}): WindowGeometry {
  return { count: ROWS, rowHeight: ROW, scrollTop: 0, viewport: 360, overscan: OVERSCAN, ...overrides };
}

/**
 * The largest window the settled geometry can produce: a screenful of lines,
 * one extra line for a partial row at the top edge, and both overscans.
 */
function windowBound(viewport: number): number {
  return Math.ceil(viewport / ROW) + 2 * OVERSCAN + 1;
}

function maxScroll(count: number, viewport: number): number {
  return clampScrollTop(Number.POSITIVE_INFINITY, count, ROW, viewport);
}

/** `linesPerRow` display lines for each of `rows` rows, as the layout emits them. */
function rowAtFor(rows: number, linesPerRow: number): (index: number) => number {
  return (index) => Math.floor(index / linesPerRow);
}

describe("5000-row window", () => {
  test("mounts a screenful, never the whole transcript", () => {
    const count = ROWS * 3; // rows with a few wrapped lines each
    expect(count).toBe(15_000);
    for (const viewport of VIEWPORTS) {
      const mid = geometry({ count, scrollTop: 20_000, viewport });
      // Row-aligned viewport and offset: exactly a screenful plus both overscans.
      expect(viewport % ROW).toBe(0);
      expect(windowSize(mid)).toBe(viewport / ROW + 2 * OVERSCAN);
      expect(windowSize(mid)).toBeLessThan(count);
    }
  });

  test("clamps at both ends without dropping a visible line", () => {
    const count = ROWS;
    for (const viewport of VIEWPORTS) {
      const top = geometry({ count, scrollTop: 0, viewport });
      expect(windowStart(top)).toBe(0);
      expect(windowEnd(top)).toBe(Math.ceil(viewport / ROW) + OVERSCAN);

      const bottom = geometry({ count, scrollTop: maxScroll(count, viewport), viewport });
      expect(windowEnd(bottom)).toBe(count);
      expect(windowIndices(bottom).at(-1)).toBe(count - 1);
    }
  });

  test("the slice size never grows with the transcript", () => {
    const viewport = 560;
    const small = geometry({ count: ROWS, scrollTop: 20_000, viewport });
    const huge = geometry({ count: ROWS * 100, scrollTop: 20_000, viewport });
    expect(windowSize(huge)).toBe(windowSize(small));
    expect(windowIndices(huge)).toHaveLength(windowIndices(small).length);
  });

  test("stays inside its bound at every scroll offset (and both window sizes)", () => {
    const count = ROWS * 3;
    for (const viewport of VIEWPORTS) {
      const max = maxScroll(count, viewport);
      for (let scrollTop = 0; scrollTop <= max; scrollTop += 137) {
        const indices = windowIndices(geometry({ count, scrollTop, viewport }));
        expect(indices.length).toBeLessThanOrEqual(windowBound(viewport));
        expect(indices.length).toBeGreaterThan(1);
        expect(indices[0]).toBeGreaterThanOrEqual(0);
        expect(indices.at(-1)!).toBeLessThan(count);
        // Contiguous and ordered: the window is a slice, not a scattered set.
        expect(indices[1]! - indices[0]!).toBe(1);
        expect(indices.at(-1)! - indices[0]!).toBe(indices.length - 1);
      }
    }
  });

  test("empty and pre-measurement geometry renders nothing", () => {
    expect(windowIndices(geometry({ count: 0, viewport: 0 }))).toEqual([]);
    expect(windowIndices(geometry({ count: ROWS, viewport: 0 })).length).toBeLessThanOrEqual(
      OVERSCAN * 2 + 1,
    );
  });
});

describe("anchor lookup", () => {
  test("finds the first line of a row by binary search", () => {
    const count = ROWS * 3;
    const rowAt = rowAtFor(ROWS, 3);
    expect(firstLineOfRow(count, rowAt, 0)).toBe(0);
    expect(firstLineOfRow(count, rowAt, 1234)).toBe(3702);
    expect(firstLineOfRow(count, rowAt, ROWS - 1)).toBe(count - 3);
  });

  test("costs O(log n) probes, not a scan", () => {
    const count = ROWS;
    const rowAt = rowAtFor(ROWS, 1);
    let probes = 0;
    const counted = (index: number): number => {
      probes += 1;
      return rowAt(index);
    };
    expect(firstLineOfRow(count, counted, 4321)).toBe(4321);
    expect(probes).toBeLessThanOrEqual(Math.ceil(Math.log2(count)) + 1);
  });

  test("returns null when the row is gone or the list is empty", () => {
    // Row 2 is missing: the layout skipped it after a re-wrap.
    const sparse = (index: number): number => (index < 6 ? Math.floor(index / 3) : index - 1);
    expect(firstLineOfRow(40, sparse, 2)).toBeNull();
    expect(firstLineOfRow(0, () => 0, 0)).toBeNull();
    expect(firstLineOfRow(10, rowAtFor(5, 2), 99)).toBeNull();
  });

  test("a width re-wrap keeps the reader on the same row (pixels would not)", () => {
    const rows = 2000;
    const viewport = 360;
    const wide = rowAtFor(rows, 1); // 2000 lines before the resize
    const narrow = rowAtFor(rows, 3); // 6000 lines after it
    const before = geometry({ count: rows, scrollTop: 900 * ROW, viewport });
    expect(windowStart(before)).toBe(900 - OVERSCAN);

    // What the browser would do on its own: keep the pixel offset, so the
    // reader silently lands on a different entry.
    const naiveRow = narrow(Math.floor(before.scrollTop / ROW));
    expect(naiveRow).toBe(300);

    // What the list does: resolve the remembered row in the new layout.
    const anchored = firstLineOfRow(rows * 3, narrow, wide(900));
    expect(anchored).toBe(2700);
    expect(clampScrollTop(anchored! * ROW, rows * 3, ROW, viewport)).toBe(2700 * ROW);
  });

  test("a restore near the end is clamped so the tail stays visible", () => {
    const rows = 200;
    const viewport = 360;
    const count = rows * 3;
    const last = firstLineOfRow(count, rowAtFor(rows, 3), rows - 1)!;
    const top = clampScrollTop(last * ROW, count, ROW, viewport);
    expect(top).toBe(maxScroll(count, viewport));
    expect(Math.floor(top / ROW) + Math.ceil(viewport / ROW)).toBe(count);
  });
});

describe("pinning", () => {
  test("only the last few pixels count as following the tail", () => {
    const scrollHeight = 10_000;
    const viewport = 360;
    expect(atBottom(scrollHeight - viewport, scrollHeight, viewport, ROW)).toBe(true);
    expect(atBottom(scrollHeight - viewport - 4, scrollHeight, viewport, ROW)).toBe(true);
    expect(atBottom(scrollHeight - viewport - 60, scrollHeight, viewport, ROW)).toBe(false);
    // Shorter than the viewport: nothing to scroll, so it is pinned.
    expect(atBottom(0, 100, viewport, ROW)).toBe(true);
  });

  test("clampScrollTop keeps offsets inside the scrollable range", () => {
    expect(clampScrollTop(-50, ROWS, ROW, 360)).toBe(0);
    expect(clampScrollTop(1e9, ROWS, ROW, 360)).toBe(ROWS * ROW - 360);
    expect(clampScrollTop(0, 0, ROW, 360)).toBe(0);
  });

  test("the jump-to-latest pill is hidden while pinned and on an empty list", () => {
    expect(jumpToLatestVisible(true, 5000)).toBe(false);
    expect(jumpToLatestVisible(false, 5000)).toBe(true);
    expect(jumpToLatestVisible(false, 0)).toBe(false);
  });

  test("reduced motion turns the jump into an unanimated scroll", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
    expect(scrollBehavior(prefersReducedMotion({ matches: true }))).toBe("auto");
    expect(scrollBehavior(prefersReducedMotion({ matches: false }))).toBe("smooth");
  });
});
