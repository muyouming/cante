// Typography guard for the simple (only) interface.
//
// The product pins three hard floors for a 45-year-old, non-technical user on a
// Windows desktop: body text >= 16px, headings >= 20px, and buttons >= 44px
// tall. The 63 sub-16px classes found in the audit were not one mistake — they
// were many agents each eyeballing a font size while editing a screen. So this
// test reads the .tsx sources as text and fails the moment one comes back.
//
// WHY A TEXT SCAN, NOT A RENDER TEST
//   - Simple: no jsdom, no component fixtures, no Tailwind build in the test.
//   - Fast and portable: it reads strings, so it runs in milliseconds anywhere.
//   - It targets the exact regression: a hand-written `text-xs` / `text-sm` /
//     `text-[14px]` or a 36px button is visible in the source text, which is
//     where the mistake is actually made. A render test would only catch it
//     after the class was already resolved and could silently miss a class that
//     a variant prefix (e.g. `sm:text-sm`) hides.
//
// Files owned by other workstreams (ConfirmSheet.tsx / History.tsx) are still
// scanned on purpose: this guard must fail until every screen obeys the floor,
// and a failure that names only those two files is the expected in-progress
// state.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Tailwind CSS default font-size scale.
// Source: https://tailwindcss.com/docs/font-size (Tailwind v4 keeps the same
// named scale; the px values below are the computed defaults).
const FONT_SCALE_PX: Record<string, number> = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
  "text-2xl": 24,
  "text-3xl": 30,
};

/** The product floors: body 16px, headings 20px, tap targets 44px. */
const BODY_MIN_PX = 16;
const HEADING_MIN_PX = 20;
const BUTTON_MIN_PX = 44;

const SIMPLE_DIR = import.meta.dir;

interface Violation {
  file: string;
  line: number;
  snippet: string;
  rule: string;
}

/**
 * Buttons that are deliberately allowed to be shorter than 44px, each with a
 * written reason. Keep this list tiny and reviewed — an entry here is a
 * conscious design decision, not a missed fix. The audit found none: every
 * button in the audited screens already reaches 44px, so the list is empty on
 * purpose. If a future screen genuinely needs a smaller target, add
 * `{ file, match, reason }` and explain why in the reason string.
 */
const BUTTON_HEIGHT_ALLOWLIST: ReadonlyArray<{
  /** Path relative to gui/src/simple, e.g. "Home.tsx". */
  file: string;
  /** The exact class attribute value that is exempt. */
  match: string;
  /** Why this target may be smaller than 44px. */
  reason: string;
}> = [];

/** Every .tsx under src/simple (recursively), minus test files. */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...componentFiles(full));
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out.sort();
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The source line a match sits on, trimmed, for an actionable report. */
function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

/**
 * Read a JSX opening tag starting at `<`. Stops at the first `>` that is
 * outside quotes and outside `{...}` (so `onClick={() => ...}` and template
 * literals do not end the tag early).
 */
function openingTag(text: string, start: number): string {
  let brace = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      brace++;
    } else if (ch === "}") {
      brace = Math.max(0, brace - 1);
    } else if (ch === ">" && brace === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Pull the class attribute out of an opening tag, if it has one. */
function classExpression(tag: string): string | null {
  const marker = tag.search(/\bclass=/);
  if (marker < 0) return null;
  const i = marker + "class=".length;
  const first = tag[i];
  if (first === '"' || first === "'") {
    const end = tag.indexOf(first, i + 1);
    return end < 0 ? null : tag.slice(i + 1, end);
  }
  if (first === "{") {
    let depth = 0;
    let quote: string | null = null;
    for (let j = i; j < tag.length; j++) {
      const ch = tag[j]!;
      if (quote) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return tag.slice(i + 1, j);
      }
    }
  }
  return null;
}

/**
 * `const NAME = "..."` class strings declared in the same file. Several screens
 * keep their button classes in a constant so every button shares one size; the
 * guard has to follow that indirection instead of reporting a false positive.
 */
function classConstants(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  for (const m of text.matchAll(re)) {
    map.set(m[1]!, m[2]!.slice(1, -1));
  }
  return map;
}

/** Resolve a class expression to the class text it will actually render. */
function resolveClass(expr: string, constants: Map<string, string>): string {
  let inner = expr.trim();
  if (inner.startsWith("`") && inner.endsWith("`")) inner = inner.slice(1, -1);
  if (/^[A-Za-z_$][\w$]*$/.test(inner)) return constants.get(inner) ?? "";
  return inner.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_, name: string) => constants.get(name) ?? "");
}

/** Every font-size (in px) mentioned by a class string. */
function fontSizesIn(classes: string): { px: number; token: string }[] {
  const found: { px: number; token: string }[] = [];
  const re = /text-(xs|sm|base|lg|xl|2xl|3xl)\b|text-\[(\d*\.?\d+)(px|rem)\]/g;
  for (const m of classes.matchAll(re)) {
    if (m[1]) {
      const px = FONT_SCALE_PX[`text-${m[1]}`]!;
      found.push({ px, token: m[0] });
    } else {
      const n = Number.parseFloat(m[2]!);
      found.push({ px: m[3] === "rem" ? n * 16 : n, token: m[0] });
    }
  }
  return found;
}

/** A button is tall enough when it pins a >=44px min/max height class. */
function hasTallEnoughButton(classes: string): boolean {
  for (const m of classes.matchAll(/min-h-\[(\d*\.?\d+)px\]/g)) {
    if (Number.parseFloat(m[1]!) >= BUTTON_MIN_PX) return true;
  }
  for (const m of classes.matchAll(/\bh-\[(\d*\.?\d+)px\]/g)) {
    if (Number.parseFloat(m[1]!) >= BUTTON_MIN_PX) return true;
  }
  // Tailwind default spacing: h-11=44, h-12=48, h-14=56, h-16=64px.
  return /\bh-(11|12|14|16)\b/.test(classes);
}

function report(violations: Violation[]): string {
  if (violations.length === 0) return "";
  return violations
    .map((v) => `${v.file}:${v.line} -> ${v.snippet}  [${v.rule}]`)
    .join("\n");
}

describe("simple-mode typography floors", () => {
  const files = componentFiles(SIMPLE_DIR);

  test("the scan sees the simple-mode screens", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith("Home.tsx"))).toBe(true);
  });

  test(`正文必须 >= ${BODY_MIN_PX}px：不得出现 text-xs / text-sm / text-[<16px]`, () => {
    const violations: Violation[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const re = /text-(xs|sm)\b|text-\[(\d*\.?\d+)(px|rem)\]/g;
      for (const m of text.matchAll(re)) {
        const px = m[1]
          ? FONT_SCALE_PX[`text-${m[1]}`]!
          : m[3] === "rem"
            ? Number.parseFloat(m[2]!) * 16
            : Number.parseFloat(m[2]!);
        if (px < BODY_MIN_PX) {
          violations.push({
            file: relative(SIMPLE_DIR, file),
            line: lineOf(text, m.index),
            snippet: lineText(text, m.index),
            rule: `正文字号 ${px}px < ${BODY_MIN_PX}px`,
          });
        }
      }
    }
    expect(report(violations)).toBe("");
  });

  test(`标题必须 >= ${HEADING_MIN_PX}px：h1/h2/h3 必须带 >= ${HEADING_MIN_PX}px 的字号类`, () => {
    const violations: Violation[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const constants = classConstants(text);
      for (const m of text.matchAll(/<h[1-3][\s>/]/g)) {
        const tag = openingTag(text, m.index);
        const expr = classExpression(tag);
        const classes = expr === null ? "" : resolveClass(expr, constants);
        const sizes = fontSizesIn(classes);
        const largest = sizes.length > 0 ? Math.max(...sizes.map((s) => s.px)) : 0;
        if (largest < HEADING_MIN_PX) {
          violations.push({
            file: relative(SIMPLE_DIR, file),
            line: lineOf(text, m.index),
            snippet: lineText(text, m.index),
            rule:
              largest === 0
                ? `标题缺少显式字号类（要求 >= ${HEADING_MIN_PX}px）`
                : `标题字号 ${largest}px < ${HEADING_MIN_PX}px`,
          });
        }
      }
    }
    expect(report(violations)).toBe("");
  });

  test(`按钮必须 >= ${BUTTON_MIN_PX}px 高：每个 button 需要 min-h-[>=${BUTTON_MIN_PX}px] 或足够高的 h-*`, () => {
    const violations: Violation[] = [];
    for (const file of files) {
      const rel = relative(SIMPLE_DIR, file);
      const text = readFileSync(file, "utf8");
      const constants = classConstants(text);
      for (const m of text.matchAll(/<button[\s>/]/g)) {
        const tag = openingTag(text, m.index);
        const expr = classExpression(tag);
        const classes = expr === null ? "" : resolveClass(expr, constants);
        if (hasTallEnoughButton(classes)) continue;
        const allowed = BUTTON_HEIGHT_ALLOWLIST.some(
          (entry) => entry.file === rel && classes.includes(entry.match),
        );
        if (allowed) continue;
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          snippet: lineText(text, m.index),
          rule: `按钮缺少 >= ${BUTTON_MIN_PX}px 的高度类（min-h-[${BUTTON_MIN_PX}px] 或 h-11/h-12/h-14/h-16）`,
        });
      }
    }
    expect(report(violations)).toBe("");
  });
});
