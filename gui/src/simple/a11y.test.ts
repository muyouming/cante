// Accessibility-name guard for the simple (only) interface.
//
// The keyboard work (r20) made every control *reachable*: overlays capture Tab,
// Esc closes what it is allowed to close, the focus ring starts on the safe
// answer. This guard covers the other half — whether a control can be *read
// out*: a button with only an icon, an input with no label, a clickable div.
// That matters to a screen reader, to Windows Narrator, and equally to anyone
// who uses the high-contrast theme or a magnifier.
//
// WHY A TEXT SCAN, NOT A RENDER TEST
//   - Same reasoning as typography.test.ts: no jsdom, no component fixtures, no
//     Tailwind build, milliseconds anywhere, and the failure points at the line
//     where the mistake is actually made.
//   - It reads the JSX opening tags, so it checks the attributes and children a
//     screen reader would compute its name from.
//
// WHAT A TEXT SCAN CANNOT SEE (the honest boundary)
//   - It cannot resolve a `{...}` child. `<button>{APPROVAL.deny}</button>` is
//     text on screen and the guard accepts it. An expression that is obviously an
//     icon is rejected by its shape (`{ICON.close}`, `{props.glyph}`, `{"×"}` —
//     see looksLikeAnIcon), but everything in between is *trusted*, not verified:
//     only a render pass or a real screen reader can settle what a name built
//     from an expression finally reads out.
//   - It says nothing about reading *order*, verbosity, or whether the Chinese
//     wording makes sense out loud. Verifying that needs Narrator / NVDA / VoiceOver
//     on the real window, with a person listening.
//   - It cannot see contrast, focus visibility, or live-region timing.
// These limits are written down instead of papered over: a green run means
// "every control has something a screen reader can name it by", not "the
// interface is usable with a screen reader".
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SIMPLE_DIR = import.meta.dir;

/** Any letter (CJK included) or digit. A label made only of symbols has no name. */
const WORDY = /[\p{L}\p{N}]/u;

interface Violation {
  file: string;
  line: number;
  snippet: string;
  rule: string;
  fix: string;
}

/**
 * Controls deliberately left without a computed name, each with a written
 * reason. Keep this list empty unless there is a real reason a screen reader
 * should not name the control — "it renders fine" is not one.
 */
const NAME_ALLOWLIST: ReadonlyArray<{
  /** Path relative to gui/src/simple, e.g. "Home.tsx". */
  file: string;
  /** A substring of the offending opening tag that identifies it. */
  match: string;
  /** Why this control may go unnamed. */
  reason: string;
}> = [];

/** Every .tsx under src/simple (recursively), minus test files. */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
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
 * Skip a `{...}` group starting at `text[start] === "{"`; returns the index
 * just past the closing brace. Quote-aware, so braces inside strings (and
 * template literals with `${}`) do not end it early.
 */
function skipGroup(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * End of an opening tag: the first `>` outside quotes and outside `{...}`.
 *
 * The brace handling is what keeps a nested attribute value from ending the tag
 * early — `<Show fallback={<button onClick={...}>x</button>}>` is one tag here,
 * and (see `attributes`) the inner button's onClick is not mistaken for the
 * Show's own.
 */
function openingTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      i = skipGroup(text, i) - 1;
      continue;
    }
    if (ch === ">") return i;
  }
  return text.length;
}

interface Attribute {
  name: string;
  /** Literal text of the value, or the raw `{...}` source (braces included). */
  value: string;
}

/**
 * Attributes of one opening tag, read only at brace depth zero.
 *
 * That depth rule is the whole point: an attribute of a *nested* element (a
 * `<button onClick=...>` sitting inside `fallback={...}`) lives at depth > 0
 * and must not be attributed to the outer element.
 */
function attributes(tag: string): Attribute[] {
  const out: Attribute[] = [];
  let i = 1;
  while (i < tag.length && /[A-Za-z0-9_.:-]/.test(tag[i]!)) i++;
  while (i < tag.length) {
    const ch = tag[i]!;
    if (ch === ">") break;
    if (ch === "/" && tag[i + 1] === ">") break;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "{") {
      i = skipGroup(tag, i); // spread, e.g. {...props}
      continue;
    }
    const nameStart = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i]!)) i++;
    const name = tag.slice(nameStart, i);
    while (i < tag.length && /\s/.test(tag[i]!)) i++;
    if (tag[i] !== "=") {
      out.push({ name, value: "" });
      continue;
    }
    i++;
    while (i < tag.length && /\s/.test(tag[i]!)) i++;
    if (tag[i] === '"' || tag[i] === "'") {
      const quote = tag[i]!;
      i++;
      const valueStart = i;
      while (i < tag.length && tag[i] !== quote) i++;
      out.push({ name, value: tag.slice(valueStart, i) });
      i++;
    } else if (tag[i] === "{") {
      const end = skipGroup(tag, i);
      out.push({ name, value: tag.slice(i, end) });
      i = end;
    } else {
      const valueStart = i;
      while (i < tag.length && !/[\s>]/.test(tag[i]!)) i++;
      out.push({ name, value: tag.slice(valueStart, i) });
    }
  }
  return out;
}

function has(list: readonly Attribute[], ...names: string[]): boolean {
  return names.every((name) => list.some((attr) => attr.name === name));
}

function value(list: readonly Attribute[], name: string): string | undefined {
  return list.find((attr) => attr.name === name)?.value;
}

interface Children {
  /** Text a sighted user can read, tags and `{...}` children removed. */
  literal: string;
  /** The source of every `{...}` child, at any nesting depth. */
  expressions: string[];
}

/** Text and expression children of an element, from `<tag>` to `</tag>`. */
function childrenOf(inner: string): Children {
  let literal = "";
  const expressions: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "<") {
      i = openingTagEnd(inner, i);
    } else if (ch === "{") {
      const end = skipGroup(inner, i);
      expressions.push(inner.slice(i + 1, end - 1).trim());
      i = end - 1;
    } else {
      literal += ch;
    }
  }
  return { literal: literal.replace(/\s+/g, " ").trim(), expressions };
}

/**
 * Could this `{...}` child be an icon rather than a name?
 *
 * Two shapes are worth flagging: a string literal with no letter or digit
 * (`{"×"}`), and an identifier that names an icon (`{ICON.close}`,
 * `{props.glyph}`). Anything else — a copy constant, a ternary over copy, a
 * template with words in it — is trusted as a name. That trust is the honest
 * limit of a text scan: it cannot read the value at the end of `APPROVAL.deny`.
 */
const ICON_LIKE = /\b(icon|glyph|symbol|emoji|svg)\b/i;
function looksLikeAnIcon(expression: string): boolean {
  const trimmed = expression.trim();
  const literal = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  if (literal) return !WORDY.test(literal[2] ?? "");
  return ICON_LIKE.test(trimmed);
}

/** Every `<label for=...>` value in a file, literal or raw `{...}` expression. */
function labelTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<label(?=[\s>])/g)) {
    const end = openingTagEnd(text, m.index);
    const forValue = value(attributes(text.slice(m.index, end + 1)), "for");
    if (forValue !== undefined) out.push(forValue);
  }
  return out;
}

/** Ranges of `<label>…</label>` bodies, for the "input nested in a label" case. */
function labelRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/<label(?=[\s>])/g)) {
    const close = text.indexOf("</label>", m.index);
    if (close >= 0) out.push([m.index, close]);
  }
  return out;
}

/** Elements that are interactive on their own; onClick on one of these is fine. */
const NATIVELY_INTERACTIVE = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "option",
  "summary",
]);

/** Roles a `role="button"` stand-in is allowed to use. */
function isKeyboardStandIn(list: readonly Attribute[]): boolean {
  return value(list, "role") === "button" && has(list, "tabindex", "onKeyDown");
}

function report(violations: readonly Violation[]): string {
  if (violations.length === 0) return "";
  return violations
    .map((v) => `${v.file}:${v.line}\n    ${v.snippet}\n    [${v.rule}] → ${v.fix}`)
    .join("\n");
}

/** Files and their sources, read once. */
const SCANNED: ReadonlyArray<{ file: string; rel: string; text: string }> = componentFiles(SIMPLE_DIR).map(
  (file) => ({ file, rel: relative(SIMPLE_DIR, file), text: readFileSync(file, "utf8") }),
);

/** Walk every opening tag in every component, with its file context. */
function eachTag(
  visit: (ctx: {
    rel: string;
    text: string;
    name: string;
    tag: string;
    attrs: Attribute[];
    index: number;
  }) => void,
): void {
  for (const { rel, text } of SCANNED) {
    // `<` followed by a name, with whitespace or `/` or `>` after it, so
    // `a < b` and generic arguments do not look like tags.
    for (const m of text.matchAll(/<([A-Za-z][\w.$:-]*)(?=[\s/>])/g)) {
      const end = openingTagEnd(text, m.index);
      const tag = text.slice(m.index, end + 1);
      visit({ rel, text, name: m[1]!.toLowerCase(), tag, attrs: attributes(tag), index: m.index });
    }
  }
}

describe("simple-mode accessible names", () => {
  test("the scan sees the simple-mode screens", () => {
    expect(SCANNED.length).toBeGreaterThan(0);
    expect(SCANNED.some((s) => s.rel === "Home.tsx")).toBe(true);
    // A guard that silently stopped reading attributes (a broken parser, say)
    // would "pass" every rule below. This is the smoke alarm for that.
    let ariaAttributes = 0;
    let buttons = 0;
    let fields = 0;
    eachTag(({ name, attrs }) => {
      if (name === "button") buttons++;
      if (name === "input" || name === "textarea" || name === "select") fields++;
      if (attrs.some((attr) => attr.name.startsWith("aria-"))) ariaAttributes++;
    });
    expect(buttons).toBeGreaterThan(50);
    expect(fields).toBeGreaterThan(5);
    expect(ariaAttributes).toBeGreaterThan(10);
  });

  test("每个 button 都要能被念出名字：文字、aria-label 或 aria-labelledby", () => {
    const violations: Violation[] = [];
    for (const { rel, text } of SCANNED) {
      for (const m of text.matchAll(/<button(?=[\s/>])/g)) {
        const end = openingTagEnd(text, m.index);
        const tag = text.slice(m.index, end + 1);
        const attrs = attributes(tag);
        if (has(attrs, "aria-label") || has(attrs, "aria-labelledby")) continue;
        const selfClosing = /\/>$/.test(tag.trimEnd());
        const close = selfClosing ? m.index : text.indexOf("</button>", end);
        const children = childrenOf(selfClosing ? "" : text.slice(end + 1, close < 0 ? text.length : close));
        const named =
          WORDY.test(children.literal) || children.expressions.some((expr) => !looksLikeAnIcon(expr));
        const allowed = NAME_ALLOWLIST.some((entry) => entry.file === rel && tag.includes(entry.match));
        if (named || allowed) continue;
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          snippet: lineText(text, m.index),
          rule:
            children.literal.length === 0 && children.expressions.length === 0
              ? "按钮里没有能念的文字，也没有名字"
              : children.literal.length > 0
                ? `按钮里只有符号「${children.literal}」`
                : `按钮里只有一个像是图标的表达式（${children.expressions[0]}）`,
          fix: '加一个中文 aria-label，例如 aria-label="关闭"',
        });
      }
    }
    expect(report(violations)).toBe("");
  });

  test("每个输入框都要有能关联的名字：label for、aria-label 或 aria-labelledby", () => {
    const violations: Violation[] = [];
    for (const { rel, text } of SCANNED) {
      const targets = labelTargets(text);
      const ranges = labelRanges(text);
      for (const m of text.matchAll(/<(input|textarea|select)(?=[\s/>])/g)) {
        const end = openingTagEnd(text, m.index);
        const tag = text.slice(m.index, end + 1);
        const attrs = attributes(tag);
        if (has(attrs, "aria-label") || has(attrs, "aria-labelledby") || has(attrs, "title")) continue;
        if (ranges.some(([from, to]) => m.index > from && m.index < to)) continue; // wrapped in a <label>
        const id = value(attrs, "id");
        if (id !== undefined && targets.includes(id)) continue;
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          snippet: lineText(text, m.index),
          rule: `<${m[1]}> 没有可关联的 label${id === undefined ? "（连 id 都没有）" : `（id=${id} 没有对应的 label for）`}`,
          fix: '加 aria-label="…"（中文），或补上 id 并在 <label for="…"> 里指到它',
        });
      }
    }
    expect(report(violations)).toBe("");
  });

  test("能点的东西要是 button：div/span 上的 onClick 必须带 role=button 与键盘处理", () => {
    const violations: Violation[] = [];
    eachTag(({ rel, text, name, tag, attrs, index }) => {
      if (NATIVELY_INTERACTIVE.has(name)) return;
      if (!has(attrs, "onClick")) return;
      if (isKeyboardStandIn(attrs)) return;
      const allowed = NAME_ALLOWLIST.some((entry) => entry.file === rel && tag.includes(entry.match));
      if (allowed) return;
      violations.push({
        file: rel,
        line: lineOf(text, index),
        snippet: lineText(text, index),
        rule: `<${name}> 上有 onClick，但它不是 button，键盘与屏幕阅读器都默认它不可用`,
        fix: '改成 <button type="button">；实在改不了就补 role="button"、tabindex="0" 与 onKeyDown（次选）',
      });
    });
    expect(report(violations)).toBe("");
  });

  test("aria 属性不能说谎：状态类属性要真有对应角色和取值", () => {
    const violations: Violation[] = [];
    const CHECKED_ROLES = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];
    eachTag(({ rel, text, name, tag, attrs, index }) => {
      const role = value(attrs, "role") ?? "";
      const push = (rule: string, fix: string): void =>
        void violations.push({ file: rel, line: lineOf(text, index), snippet: lineText(text, index), rule, fix });

      if (has(attrs, "aria-modal") && !["dialog", "alertdialog"].includes(role)) {
        push("aria-modal 只在 dialog / alertdialog 上成立", `补 role="dialog"（或 "alertdialog"），或去掉 aria-modal`);
      }
      if (has(attrs, "aria-checked") && !CHECKED_ROLES.includes(role)) {
        push("aria-checked 需要 checkbox / radio / switch 这类角色", `加 role="switch"（或 "checkbox"/"radio"），否则屏幕阅读器念不出开/关`);
      }
      for (const attr of ["aria-expanded", "aria-pressed", "aria-checked"] as const) {
        const raw = value(attrs, attr);
        if (raw === undefined) continue;
        if (raw.trim().length === 0 || /^\{\s*\}$/.test(raw.trim())) {
          push(`${attr} 是空的`, `给它一个真实取值（例如 ${attr}={open()}），否则等于没写`);
        }
      }
      if (["radio", "switch", "checkbox"].includes(role) && !has(attrs, "aria-checked")) {
        push(`role="${role}" 没有 aria-checked`, `补 aria-checked={…}，否则屏幕阅读器不知道它现在是哪一种状态`);
      }
      if (has(attrs, "aria-hidden") && value(attrs, "aria-hidden") === "true") {
        const selfClosing = /\/>$/.test(tag.trimEnd());
        const close = selfClosing ? index : text.indexOf(`</${name}>`, index + tag.length);
        const inner = selfClosing ? "" : text.slice(index + tag.length, close < 0 ? text.length : close);
        if (/<(button|input|select|textarea|a)(?=[\s/>])/.test(inner)) {
          push("aria-hidden=\"true\" 的元素里还有能聚焦的控件", "把那部分挪到 aria-hidden 之外，否则键盘能进、屏幕阅读器却读不到");
        }
      }
    });
    expect(report(violations)).toBe("");
  });

  test("白名单是审过的：每条都写了原因（尽量为空）", () => {
    for (const entry of NAME_ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(8);
    }
  });
});
