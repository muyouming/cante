// Unit tests for the pure transcript layout pass.
//
//   bun test examples/gui/src
import { describe, expect, test } from "bun:test";

import type { Row } from "./rows.ts";
import { columnsFor, createLayoutCache, diffKind, layoutRow, LINE_HEIGHT } from "./transcript.ts";

function row(partial: Partial<Row> & Pick<Row, "kind" | "text">): Row {
  return {
    id: partial.id ?? "r1",
    kind: partial.kind,
    label: partial.label ?? "agent",
    text: partial.text,
    detail: partial.detail ?? "",
    tone: partial.tone ?? "neutral",
    streaming: partial.streaming ?? false,
    time: partial.time ?? "12:00",
  };
}

const OPTIONS = { columns: 40, monoColumns: 30 };

describe("columnsFor", () => {
  test("is monotonic in width and tighter for the mono face", () => {
    expect(columnsFor(400)).toBeGreaterThan(columnsFor(200));
    expect(columnsFor(400, true)).toBeLessThan(columnsFor(400, false));
    expect(columnsFor(0)).toBeGreaterThanOrEqual(16);
  });

  test("line height matches the text-sm leading", () => {
    expect(LINE_HEIGHT).toBe(20);
  });
});

describe("diffKind", () => {
  test("classifies unified-diff line shapes", () => {
    expect(diffKind("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(diffKind("+++ b/file.ts")).toBe("ctx");
    expect(diffKind("--- a/file.ts")).toBe("ctx");
    expect(diffKind("+const a = 1;")).toBe("add");
    expect(diffKind("-const a = 2;")).toBe("del");
    expect(diffKind(" const a = 3;")).toBeNull();
  });
});

describe("layoutRow", () => {
  test("emits a chrome header first and marks the last line", () => {
    const lines = layoutRow(row({ kind: "agent", text: "hello" }), 0, OPTIONS);
    expect(lines[0]!.chrome).toBe(true);
    expect(lines[0]!.text).toBe("AGENT");
    expect(lines[1]!.text).toBe("hello");
    expect(lines[lines.length - 1]!.last).toBe(true);
    expect(lines.filter((line) => line.chrome)).toHaveLength(1);
  });

  test("renders fenced code in the mono face and drops the fences", () => {
    const lines = layoutRow(
      row({ kind: "agent", text: "try this:\n```ts\nconst a = 1;\n```\ndone" }),
      0,
      OPTIONS,
    );
    const body = lines.filter((line) => !line.chrome);
    expect(body.map((line) => line.text)).toEqual(["try this:", "const a = 1;", "done"]);
    expect(body.map((line) => line.mono)).toEqual([false, true, false]);
  });

  test("treats tool bodies as mono and colors diff lines", () => {
    const lines = layoutRow(
      row({ kind: "tool", label: "Edit", text: "@@ -1 +1 @@\n-old\n+new" }),
      0,
      OPTIONS,
    );
    const body = lines.filter((line) => !line.chrome);
    expect(body.every((line) => line.mono)).toBe(true);
    expect(body.map((line) => line.diff)).toEqual(["hunk", "del", "add"]);
  });

  test("wraps long prose at word boundaries within budget", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const lines = layoutRow(row({ kind: "agent", text }), 0, OPTIONS);
    const body = lines.filter((line) => !line.chrome).map((line) => line.text);
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(OPTIONS.columns);
    expect(body.join(" ")).toBe(text);
  });

  test("keeps an unbreakable token intact rather than dropping it", () => {
    const token = "x".repeat(120);
    const body = layoutRow(row({ kind: "tool", text: token }), 0, OPTIONS).filter((line) => !line.chrome);
    expect(body.map((line) => line.text).join("")).toBe(token);
  });

  test("appends tool output with its own header and truncation note", () => {
    const detail = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const lines = layoutRow(row({ kind: "tool", text: "ls", detail }), 0, { ...OPTIONS, maxOutputLines: 4 });
    const body = lines.filter((line) => !line.chrome).map((line) => line.text);
    expect(body[0]).toBe("ls");
    expect(body[1]).toBe("output");
    expect(body.slice(2, 6)).toEqual(["line 0", "line 1", "line 2", "line 3"]);
    expect(body).toContain("… 8 more output line(s) — press for the full entry");
  });

  test("caps a pathologically long row", () => {
    const text = Array.from({ length: 60 }, () => "y".repeat(35)).join("\n");
    const lines = layoutRow(row({ kind: "tool", text }), 0, { ...OPTIONS, maxLinesPerRow: 20 });
    expect(lines).toHaveLength(20);
    expect(lines[19]!.text).toContain("more line(s) — press for the full entry");
    expect(lines[19]!.last).toBe(true);
  });
});

describe("scale", () => {
  test("lays out a full transcript quickly and caches unchanged rows", () => {
    const rows: Row[] = Array.from({ length: 400 }, (_, index) =>
      row({
        id: `r${index}`,
        kind: (["user", "agent", "thinking", "tool", "turn"] as const)[index % 5]!,
        text: Array.from({ length: 12 }, (_, line) => `entry ${index} line ${line} with enough words to wrap`).join("\n"),
        detail: "  +added\n-removed\n@@ hunk",
      }),
    );
    const options = { columns: 120, monoColumns: 100 };
    const layout = createLayoutCache();

    const coldStart = performance.now();
    const lines = layout(rows, options);
    const cold = performance.now() - coldStart;
    expect(lines.length).toBeGreaterThan(3_000);

    // One streaming tail is a new object; everything else is cached.
    const tail: Row = { ...rows[rows.length - 1]!, id: "tail", text: "a fresh delta" };
    const next = [...rows.slice(0, -1), tail];
    const warmStart = performance.now();
    layout(next, options);
    const warm = performance.now() - warmStart;

    // Ceilings are ~50x the observed cost locally: this catches a quadratic
    // regression, it is not a benchmark.
    expect(cold).toBeLessThan(250);
    expect(warm).toBeLessThan(50);
  });
});

describe("layout cache", () => {
  test("reuses layout for unchanged rows and remaps indices", () => {
    const layout = createLayoutCache();
    const first = row({ id: "a", kind: "agent", text: "one" });
    const second = row({ id: "b", kind: "agent", text: "two" });

    const a = layout([first, second], OPTIONS);
    const b = layout([second, first], OPTIONS);
    // Same objects came back for the same rows, but `row` reflects the new order.
    expect(a[0]).toBeDefined();
    expect(b.find((line) => line.text === "one")!.row).toBe(1);
    expect(b.find((line) => line.text === "two")!.row).toBe(0);
  });

  test("re-lays out when the column budget changes", () => {
    const layout = createLayoutCache();
    const only = row({ id: "a", kind: "agent", text: "alpha beta gamma delta epsilon zeta eta theta" });
    const wide = layout([only], { columns: 80, monoColumns: 60 }).filter((line) => !line.chrome);
    const narrow = layout([only], { columns: 20, monoColumns: 16 }).filter((line) => !line.chrome);
    expect(narrow.length).toBeGreaterThan(wide.length);
  });
});
