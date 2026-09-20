// The fixture-parity guard: what can the scripted `cante serve` double actually
// perform, and what is therefore *not* being verified when CI goes green?
//
// We were bitten twice by the same shape of accident:
//
//   1. the card prompts never left the app (the acceptance script drove
//      `task.prompt()` while production drove `store.composedInstruction`);
//   2. Windows ships no daemon at all, but CI is green because
//      `gui/fixtures/fake-cante.ts` pretends one is there.
//
// The fixture must keep existing — it is what lets a machine without a daemon
// run the whole suite. The fix is not to delete it but to write down what it
// hides and to have a test hold that write-up to account. This file is that
// test: it reads the daemon's real event surface from `protocol-shape`, reads
// what the fixture can emit, and checks them against the catalog in
// `CONTRACT.md`. Edit the fixture (or add a daemon variant) without updating the
// catalog, and this goes red.
//
// Two different things live in the catalog on purpose:
//
//   * the events the fixture *does not script* — pure protocol shapes it could
//     fake if someone wrote the script (listed so nobody reads "not in the
//     fixture" as "already covered");
//   * the realities the fixture *cannot* establish — a daemon binary existing,
//     image bytes actually reaching the model, real model output, real file I/O.
//     These are the "only a real machine can verify this" items.
//
// Collapsing both into one "only real hardware" list would be its own lie, so
// the catalog keeps them apart and this test enforces both halves.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";

const GUI_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(GUI_ROOT, "..");
const MSG_RS = join(REPO_ROOT, "crates", "protocol-shape", "src", "msg.rs");
const PROTOCOL_RS = join(GUI_ROOT, "src-tauri", "src", "protocol.rs");
const FIXTURE_TS = join(GUI_ROOT, "fixtures", "fake-cante.ts");
const SOAK_TS = join(GUI_ROOT, "fixtures", "flood.ts");
const CONTRACT_MD = join(GUI_ROOT, "CONTRACT.md");
const STORE_TS = join(GUI_ROOT, "src", "store.ts");
const SIMPLE_DIR = join(GUI_ROOT, "src", "simple");

// 读文件时把 CRLF 折成 LF：仓库里已规定文本文件用 LF（.gitattributes），但贡献者的
// 编辑器、或某些检出配置仍可能带来 `\r`——而下面这些解析是按行做的（`split("\n")`、
// 围栏块正则），带 `\r` 就会对不上。真发生过：Windows CI 上"找不到围栏块"。
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");

/** Remove Rust line and block comments so a brace inside prose cannot be parsed. */
function stripRustComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The daemon's event surface: every top-level variant of `enum Evt` in
 * `crates/protocol-shape/src/msg.rs`, which is the wire source of truth. The
 * Rust bridge forwards events verbatim and never invents one, so this *is* the
 * set the daemon can emit.
 *
 * The scan walks the enum body by brace depth: a variant name is the first
 * identifier at depth 1 after the opening `{`, a `,`, or the `}` that closed a
 * struct variant's body. `#[…]` attributes are skipped so a future
 * `#[cfg(…)]` on a variant cannot be mistaken for a name.
 */
function daemonEvents(source: string): string[] {
  const cleaned = stripRustComments(source);
  const enumAt = cleaned.indexOf("pub enum Evt {");
  if (enumAt < 0) throw new Error("msg.rs: cannot find `pub enum Evt {`");
  let i = cleaned.indexOf("{", enumAt) + 1;
  let depth = 1;
  let expectName = true;
  const names: string[] = [];
  while (i < cleaned.length && depth > 0) {
    const ch = cleaned[i]!;
    if (ch === "{") {
      depth += 1;
      i += 1;
    } else if (ch === "}") {
      depth -= 1;
      i += 1;
      if (depth === 1) expectName = true;
    } else if (depth === 1 && ch === "#") {
      // `#[serde(…)]` / `#[cfg(…)]`: skip to the matching `]`.
      let brackets = 0;
      while (i < cleaned.length) {
        if (cleaned[i] === "[") brackets += 1;
        else if (cleaned[i] === "]") {
          brackets -= 1;
          if (brackets === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
    } else if (depth === 1 && ch === ",") {
      expectName = true;
      i += 1;
    } else if (depth === 1 && expectName && /[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < cleaned.length && /[A-Za-z0-9_]/.test(cleaned[j]!)) j += 1;
      names.push(cleaned.slice(i, j));
      expectName = false;
      i = j;
    } else {
      i += 1;
    }
  }
  if (names.length === 0) throw new Error("msg.rs: parsed zero `Evt` variants");
  return names;
}

/**
 * Event names the *guarded bridge* names in `protocol::reduce_state`. Used only
 * as a drift check: the bridge must never reduce an event the wire no longer
 * has.
 */
function reducedEvents(source: string): string[] {
  const start = source.indexOf("pub fn reduce_state");
  const end = source.indexOf("fn pending_approval");
  if (start < 0 || end < 0 || end < start) throw new Error("protocol.rs: cannot find reduce_state");
  const segment = source.slice(start, end);
  const found = new Set<string>();
  // Only names that appear in a `match` arm pattern (`"A" | "B" =>`), so
  // status strings and payload field names cannot leak in.
  for (const arm of segment.matchAll(/(?:(?:"[A-Za-z]+"\s*\|\s*)*"[A-Za-z]+"\s*=>)/g)) {
    for (const name of arm[0]!.matchAll(/"([A-Za-z]+)"/g)) found.add(name[1]!);
  }
  return [...found];
}

/**
 * Every event the fixture can put on the wire: the name after each `emit(`
 * call, whether it is a bare unit variant (`emit("Goodbye")`) or the first key
 * of the emitted object (`emit({ TurnStart: … })`). Any other `emit(` form is
 * an error rather than a silent omission, so a new emission style cannot slip
 * past the accounting.
 */
function fixtureEvents(source: string): string[] {
  const names = new Set<string>();
  const call = /(?<![A-Za-z0-9_])emit\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    let i = match.index + "emit(".length;
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (source[i] === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new Error(`fake-cante.ts: unterminated emit string at ${match.index}`);
      names.add(source.slice(i + 1, end));
      continue;
    }
    if (source[i] === "{") {
      i += 1;
      while (i < source.length && /\s/.test(source[i]!)) i += 1;
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      const name = source.slice(i, j);
      if (!name) throw new Error(`fake-cante.ts: cannot read emitted key at ${match.index}`);
      names.add(name);
      continue;
    }
    // The one non-call form is the function declaration itself.
    if (!/function\s*$/.test(source.slice(Math.max(0, match.index - 24), match.index))) {
      throw new Error(
        `fake-cante.ts: unrecognised emit form at ${match.index}: ${source.slice(match.index, match.index + 48)}`,
      );
    }
  }
  if (names.size === 0) throw new Error("fake-cante.ts: parsed zero emitted events");
  return [...names];
}

/** The contents of a ```<label> fenced block in CONTRACT.md. */
function fenced(contract: string, label: string): string {
  const match = new RegExp("```" + label + "\\r?\\n([\\s\\S]*?)```").exec(contract);
  if (!match) throw new Error(`CONTRACT.md: missing a \`\`\`${label} fenced block`);
  return match[1]!;
}

/**
 * The markdown table under a `### <heading>` line, skipping the header and the
 * `| --- |` separator row. Cells must not contain a literal `|`.
 */
function markdownTable(contract: string, heading: string, columns: number): string[][] {
  const lines = contract.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`CONTRACT.md: missing heading "${heading}"`);
  const raw: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith("|")) raw.push(line);
    else if (raw.length > 0) break;
  }
  const data = raw.slice(2); // drop the header and the separator
  if (data.length === 0) throw new Error(`CONTRACT.md: empty table under "${heading}"`);
  return data.map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== columns) {
      throw new Error(`CONTRACT.md "${heading}": expected ${columns} cells, got ${cells.length}: ${line}`);
    }
    return cells;
  });
}

const daemon = daemonEvents(read(MSG_RS));
const fixture = fixtureEvents(read(FIXTURE_TS));
const contract = read(CONTRACT_MD);

/**
 * The events `store.ts` drops on purpose: the names inside its `IGNORED_EVENTS`
 * Set literal. Parsed from source (same trick as `protocol.rs`'s `reduce_state`)
 * so the #107 catalog and the reducer cannot drift apart silently.
 */
function deliberatelyIgnored(source: string): string[] {
  const at = source.indexOf("const IGNORED_EVENTS");
  if (at < 0) throw new Error("store.ts: cannot find `const IGNORED_EVENTS`");
  const open = source.indexOf("new Set([", at);
  if (open < 0) throw new Error("store.ts: IGNORED_EVENTS is not a Set literal");
  const close = source.indexOf("])", open);
  if (close < 0) throw new Error("store.ts: unterminated IGNORED_EVENTS literal");
  const names = [...source.slice(open, close).matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]!);
  if (names.length === 0) throw new Error("store.ts: parsed zero ignored events");
  return names;
}

/** Every `.ts`/`.tsx` under a directory; test files are excluded by default. */
function sourceFiles(dir: string, options: { includeTests?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, options));
    else if (/\.(ts|tsx)$/.test(entry.name) && (options.includeTests || !entry.name.endsWith(".test.ts"))) out.push(full);
  }
  return out;
}

/** Drop TS line and block comments, so `.skills` inside prose is not a read. */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("the fixture can only perform events the daemon can actually emit", () => {
  const impossible = fixture.filter((name) => !daemon.includes(name));
  expect(impossible, `fixture emits events absent from protocol-shape: ${impossible.join(", ")}`).toEqual([]);
});

test("CONTRACT.md's performed list matches what the fixture emits", () => {
  const documented = fenced(contract, "fixture-performed")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Set comparison both ways: a fixture edit without a catalog edit is red.
  expect([...documented].sort()).toEqual([...fixture].sort());
});

test("every daemon event the fixture cannot perform is catalogued with a reason and a guard", () => {
  const rows = markdownTable(contract, "### 夹具没演的事件", 4);
  const catalogued = rows.map((row) => row[0]!);
  const unperformed = daemon.filter((name) => !fixture.includes(name));

  // The catalog is exactly the complement: nothing missing, nothing invented.
  expect([...catalogued].sort()).toEqual([...unperformed].sort());

  for (const [event, why, realOnly, where] of rows) {
    expect(why!.length, `CONTRACT.md: no reason for ${event}`).toBeGreaterThan(0);
    expect(realOnly!.length, `CONTRACT.md: no real-machine note for ${event}`).toBeGreaterThan(0);
    expect(where!.length, `CONTRACT.md: no current guard named for ${event}`).toBeGreaterThan(0);
  }
});

test("the realities the fixture cannot establish are written down and named", () => {
  const rows = markdownTable(contract, "### 夹具演不出的现实", 3);
  const keys = rows.map((row) => row[0]!);
  expect(new Set(keys).size).toBe(keys.length);

  // These are the concrete examples this task exists for. Losing one is a
  // failure, because each has actually hidden a real-machine bug before.
  for (const required of [
    "daemon-exists",
    "vision-image-sent",
    "real-model-output",
    "real-filesystem",
  ]) {
    expect(keys, `CONTRACT.md: missing the "${required}" reality`).toContain(required);
  }

  for (const [key, why, where] of rows) {
    expect(why!.length, `CONTRACT.md: no explanation for ${key}`).toBeGreaterThan(0);
    expect(where!.length, `CONTRACT.md: no guard named for ${key}`).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// 夹具唯一一个真的落盘的动作：FAKE_CANTE_MAKE_FILE=1。
//
// 它现在能证明的：一轮正常跑动的时候，磁盘上真的多出一个小的结果文件，位置就在
// 这一轮被交代的第一个文件所在的那层文件夹里（应用就是按“所选文件的文件夹”做运
// 行前后快照的，结果写去别处 ResultCard 就看不到）；这一轮仍然按脚本的协议走完；
// 进程退出前会把自己造的文件删掉。
//
// 它仍然证明不了的：文件里的字节不是模型产出的，也不是一张真的工作簿，所以应用
// 读表格那一步仍然会说读不出来；这里的 Rust 快照/diff 代码一点没被跑到。
// CONTRACT.md 的 real-filesystem 一行因此照旧留在“只能在真机上验”里。
//
// 之前用的环境变量（SEED / APPROVAL_BATCH / TURN_ERROR / TURN_QUOTA / SLOW_DELTAS）
// 都不碰磁盘，所以只有事件形状被它们演到了；结果卡片那一屏（带它全部按钮）在自动化
// 里一直够不到。这个动作就是补那一段覆盖面。
// ---------------------------------------------------------------------------
test("FAKE_CANTE_MAKE_FILE 真的造出一个结果文件，并在退出前删掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cante-fixture-"));
  const input = join(dir, "上个月的报销单.xlsx");
  writeFileSync(input, "夹具只需要这个位置存在\n", "utf8");
  const made = join(dir, "结果_上个月开销汇总.csv");
  const proc = Bun.spawn([process.execPath, FIXTURE_TS], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FAKE_CANTE_MAKE_FILE: "1" },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  async function send(op: unknown): Promise<void> {
    proc.stdin.write(JSON.stringify({ op, id: "op_FIXTURE" }) + "\n");
    await proc.stdin.flush();
  }

  /** Read frames up to and including `end`, returning every event name seen. */
  async function until(end: string): Promise<string[]> {
    const seen: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`fake-cante closed before ${end}`);
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        const event = (JSON.parse(line) as { event: unknown }).event;
        const name = typeof event === "string" ? event : (Object.keys(event as object)[0] ?? "");
        seen.push(name);
        if (name === end) return seen;
      }
    }
  }

  try {
    await send({ StartSession: {} });
    await send({
      UserInput: `【要处理的文件】（只读，一共 1 个，按这个顺序）\n1. ${input}\n\n把这张表汇总一下`,
    });
    const paused = await until("TurnPause");
    // The turn is still the normal scripted one, not a special branch.
    expect(paused).toContain("TurnStart");
    expect(paused).not.toContain("Error");
    expect(existsSync(made), "夹具没有落盘结果文件").toBe(true);
    const body = readFileSync(made, "utf8");
    expect(body).toContain("日期");
    expect(body.length).toBeGreaterThan(0);

    await send({
      ApprovalResponse: { turn_id: "turn_1", responses: [{ tool_use_id: "tool_1", decision: "Accept" }] },
    });
    const ended = await until("TurnEnd");
    expect(ended).toContain("ToolEnd");
    expect(existsSync(made), "结果文件应该在退出前一直留着").toBe(true);

    await send("Shutdown");
    await proc.exited;
    expect(existsSync(made), "夹具必须把它自己造的文件删掉").toBe(false);
  } finally {
    try {
      proc.kill();
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #107 — the capabilities the fixture cannot exercise and nobody verified.
// The decisions live in CONTRACT.md (「没人验的能力：逐条定论（#107）」); these
// tests hold the write-up and the reducer to each other.
// ---------------------------------------------------------------------------

test("CONTRACT.md's #107 decisions each name a decision, a reason and a lock", () => {
  const rows = markdownTable(contract, "### 没人验的能力：逐条定论（#107）", 4);
  const decisions = ["接", "不接，但明确", "需要单独跟踪"];
  for (const [capability, decision, why, lock] of rows) {
    expect(decisions, `CONTRACT.md: "${capability}" has no valid decision: ${decision}`).toContain(decision!);
    expect(why!.length, `CONTRACT.md: no reason for "${capability}"`).toBeGreaterThan(20);
    expect(lock!.length, `CONTRACT.md: no lock named for "${capability}"`).toBeGreaterThan(10);
  }
  const capabilities = rows.map((row) => row[0]!).join("\n");
  // The three items #107 named, plus Ambient — whose catalog row already said
  // the simple surface never shows it. Losing one is a failure: the whole point
  // of the table is that every unverified capability has an owner.
  for (const required of ["ExtensionRefreshed", "ShellOutput", "skills 为空", "Ambient"]) {
    expect(capabilities, `CONTRACT.md: the #107 table is missing "${required}"`).toContain(required);
  }
});

test("the store's deliberate ignores and the #107 table name the same events", () => {
  const ignored = deliberatelyIgnored(read(STORE_TS));
  // Direction 1: every event the store drops on purpose is a real wire event
  // and is written down in the #107 table.
  for (const name of ignored) {
    expect(daemon, `store.ts ignores "${name}", which protocol-shape does not carry`).toContain(name);
    expect(contract, `CONTRACT.md does not record why "${name}" is ignored`).toContain(name);
  }
  // Direction 2: every "不接，但明确" row that names a wire event names one the
  // store actually ignores — so a decision cannot rot into a comment, and a new
  // entry in IGNORED_EVENTS cannot appear without a written-down reason.
  const rows = markdownTable(contract, "### 没人验的能力：逐条定论（#107）", 4);
  const named = new Set<string>();
  for (const [capability, decision] of rows) {
    if (decision !== "不接，但明确") continue;
    for (const match of capability!.matchAll(/`([A-Za-z]+)`/g)) {
      if (daemon.includes(match[1]!)) named.add(match[1]!);
    }
  }
  expect([...named].sort()).toEqual([...ignored].sort());
});

test("the simple surface never reads skills (the #107 decision, held to source)", () => {
  // CONTRACT's #107 table decides the simple surface has no skill/command entry
  // point, so nothing in it consumes `SessionInfo.skills`: a session that starts
  // with none and gets refreshed later changes nothing the user sees. The day
  // someone wires a skills surface in, this goes red and points back at the
  // decision that then has to be reopened — instead of silently invalidating it.
  const files = [STORE_TS, ...sourceFiles(SIMPLE_DIR)];
  const readers = files.filter((file) => /\.skills\b/.test(stripTsComments(read(file)))).map((file) => relative(GUI_ROOT, file));
  expect(readers, `these files read .skills, but the simple surface has no skills entry point: ${readers.join(", ")}`).toEqual([]);
});

test("the bridge never reduces an event the wire no longer carries", () => {
  const reduced = reducedEvents(read(PROTOCOL_RS));
  const unknown = reduced.filter((name) => !daemon.includes(name));
  expect(unknown, `protocol.rs reduce_state names unknown events: ${unknown.join(", ")}`).toEqual([]);
  // And it really did see the event names (not just lowercase status strings).
  for (const anchor of ["SessionStart", "TurnEnd", "Error", "Goodbye"]) {
    expect(reduced).toContain(anchor);
  }
});

test("the soak fixture stays inside the GUI double's event set", () => {
  // The soak double emits through `frame(…)` with object literals rather than a
  // single `emit(…)` helper, so this is a key scan, not a full parse: it is a
  // subset alarm, and any variant it finds must be one fake-cante can perform.
  const source = read(SOAK_TS);
  const used = new Set<string>();
  for (const match of source.matchAll(/\{\s*([A-Z][A-Za-z]+)\s*:/g)) {
    if (daemon.includes(match[1]!)) used.add(match[1]!);
  }
  const outside = [...used].filter((name) => !fixture.includes(name));
  expect(outside, `flood.ts emits events fake-cante cannot: ${outside.join(", ")}`).toEqual([]);
});
