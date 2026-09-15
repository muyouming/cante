# Cante GUI — interface contract

Frozen interfaces for parallel work on the Tauri GUI. **Do not change anything in
this file without coordinating**: several workstreams are written against it at
the same time.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 (Rust) |
| Frontend | Vite + SolidJS + TypeScript |
| Styles | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Tests | `bun test` for pure TS, `cargo test` for Rust |

Why Solid rather than React: the previous GUI (reverted in #9) was Solid, and
`src/protocol.ts`, `src/transcript.ts` and `src/commands.ts` came back from that
history unchanged — they are framework-free and already tested.

## Layout and ownership

Only edit files you own. `gui/package.json`, `gui/tsconfig.json`,
`gui/vite.config.ts`, `gui/index.html`, `gui/src-tauri/Cargo.toml`,
`gui/src-tauri/tauri.conf.json` and this file are owned by the integrator.

```
gui/
  CONTRACT.md              integrator
  package.json             integrator
  index.html, vite.config.ts, tsconfig.json   integrator
  src/
    protocol.ts            DONE (ported) — wire types + accessors
    transcript.ts          DONE (ported) — pure rows -> display lines
    commands.ts            DONE (ported) — built-in + skill command model
    rows.ts                DONE (ported) — the transcript row model
    *.test.ts              DONE (ported) — bun tests
    tauri.ts               # frontend side of this contract
    store.ts               workstream B
    App.tsx, main.tsx      workstream B
    components/**          workstream B
    styles.css             workstream B
  src-tauri/
    src/main.rs            workstream A (bootstrap is integrator-provided)
    src/lib.rs             workstream A
    src/daemon.rs          workstream A
    src/protocol.rs        workstream A
    src/commands.rs        workstream A
    tests/**               workstream A
  fixtures/fake-cante.ts   DONE (ported) — scripted `cante serve` double
  scripts/**               workstream D
  README.md                workstream D
```

Docs, `README.md` at the repo root, and `.github/workflows/gui.yml` belong to
workstream C.

## Wire contract (Rust <-> frontend)

The daemon speaks Cante's `Op`/`Evt` JSON Lines protocol on stdio. Rust forwards
events **verbatim** as `serde_json::Value`; it never re-serializes a typed event
(unknown fields and future variants must survive). Typed interpretation lives in
`src/protocol.ts`.

### Commands (`invoke`)

All return `Result<T, String>`; the string is a human-readable error.

| Command | Args | Returns |
| --- | --- | --- |
| `health` | – | `{ ok: boolean, cante: string \| null, cwd: string, daemon: boolean, status: Status }` |
| `events_since` | `{ cursor: number }` | `{ cursor: number, truncated: boolean, events: EventMsg[], state: State }` |
| `start_session` | `{ model?, provider?, effort?, permission_mode?, cwd?, resume_session_id? }` | `{ ok: true }` |
| `update_session` | `{ model?, permission_mode?, title? }` | `{ ok: true }` |
| `send_input` | `{ text: string, mode: "prompt" \| "steer" \| "shell" }` | `{ ok: true }` |
| `approve` | `{ turn_id: string, responses: ToolDecision[] }` | `{ ok: true }` |
| `interrupt` | – | `{ ok: true }` |
| `compact` | `{ instructions?: string }` | `{ ok: true }` |
| `context_report` | – | `{ ok: true }` |
| `slash` | `{ name: string, args: string }` | `{ ok: true }` |
| `goal` | `{ command: "Set" \| "Clear" \| "Status", condition?: string }` | `{ ok: true }` |
| `catalog` | – | `{ providers: Array<{ id, display_name, models: Array<{ id, display_name, supported_efforts? }> }> }` |
| `set_cwd` | `{ cwd: string }` | `{ ok: true }` — directory the daemon is spawned in |
| `shutdown` | – | `{ ok: true }` |

Arg names are **camelCase on the JS side and snake_case in Rust** — annotate
commands with `#[tauri::command(rename_all = "snake_case")]` and call them from
JS with the snake_case keys shown above (Tauri passes the object through, so
the keys in the table are the ones the frontend sends).

### Events (`listen`)

| Event | Payload |
| --- | --- |
| `cante://event` | one `EventMsg`: `{ timestamp, id, event, parent }` |
| `cante://state` | `{ status: Status, session: SessionInfo \| null, pending_approval: PendingApproval \| null }` |
| `cante://log` | `{ stream: "stderr" \| "stdout" \| "app", line: string }` |
| `cante://exit` | `{ code: number \| null }` — the daemon died |

`Status` = `"idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline"`.

`PendingApproval` = `{ turn_id: string, message: string, tools: Array<{ id, name, args }> }`.

`SessionInfo` is the daemon's own object, forwarded as-is.

### Semantics Rust must implement

- **Spawn lazily**: `cante serve` starts on the first command that needs it
  (any of the op-sending commands), or when `send_input` is called before
  `start_session`. `CANTE_BIN` overrides the binary (the fixture relies on it).
- **`CANTE_BIN` is a command spec, not a path**: it may carry leading arguments
  before the daemon's own `serve`, and tokens may be double-quoted so a Windows
  path with spaces survives. `"bun <script>"` is how the tests drive the scripted
  fixture on every platform — Windows cannot execute a `#!` script directly.
- **stdin**: one JSON object per line, `{"op":…,"id":"op_<ULID>"}`.
- **stdout**: one `EventMsg` JSON object per line; reassemble across chunk
  boundaries; skip (and log) non-JSON lines.
- **Ring**: keep the last 4096 events with a monotonically increasing cursor;
  `events_since` clamps a cursor that fell off the front and reports
  `truncated`.
- **State reduction** mirrors `src/store.ts` of the reverted bridge: see
  "Status transitions" below.
- **stderr**: forward line by line as `cante://log`.
- **Exit**: emit `cante://exit`, set status `offline`, drop the child.
- **No fabrication**: never synthesize protocol events.

#### Status transitions

| Event | Status |
| --- | --- |
| `SessionStart` / `SessionUpdated` | `idle`, session replaced, approvals cleared |
| `TurnStart` | `thinking` |
| `Thinking` / `ThinkingDelta` | `thinking` (unless `awaiting`) |
| `AgentMessage` / `MessageDelta` / `ToolStart` / `ToolUpdate` / `ToolEnd` | `streaming` (unless `awaiting`) |
| `TurnPause` with `reason.Approval` | `awaiting` + `pending_approval` |
| `TurnResume` | `streaming`, approvals cleared |
| `TurnEnd` | `idle` (stays `error` if it was `error`) |
| `Error` | `error` |
| `SessionEnd` / `Goodbye` | `offline`, session cleared |

## Frontend module interfaces (already implemented — treat as fixed)

```ts
// src/protocol.ts
eventName(event: unknown): string
eventPayload<T>(event: unknown, name: string): T | null
readTurnEnd(status: TurnEndStatus | undefined): TurnEndReason
previewJson(value: unknown, limit?: number): string
toolResultText(result: unknown): string
formatTokens(count: number): string
shortId(id?: string | null, length?: number): string
type RowKind = "user" | "agent" | "thinking" | "tool" | "info" | "error" | "turn"
type RowTone = "accent" | "neutral" | "ok" | "warn" | "error" | "muted"

// src/rows.ts
interface Row { id, kind: RowKind, label, text, detail, tone: RowTone, streaming, time }

// src/transcript.ts
const LINE_HEIGHT = 20
columnsFor(width: number, mono?: boolean): number
diffKind(line: string): DiffKind | null
layoutRow(row: Row, index: number, options: LayoutOptions): Line[]
createLayoutCache(): (rows: readonly Row[], options: LayoutOptions) => Line[]

// src/commands.ts
builtinCommands(): readonly Command[]
builtinCommand(name: string): Command | undefined
skillCommands(skills: readonly SkillMetadata[]): Command[]
allCommands(skills: readonly SkillMetadata[]): Command[]
parseSlash(text: string): { name: string; args: string } | null
filterCommands(commands: readonly Command[], query: string): Command[]
```

`src/tauri.ts` (workstream B) wraps the wire contract:

```ts
invoke<K extends keyof Commands>(name: K, args?: Commands[K]["args"]): Promise<Commands[K]["result"]>
onCanteEvent(handler: (event: EventMsg) => void): Promise<UnlistenFn>
onCanteState(handler: (state: State) => void): Promise<UnlistenFn>
onCanteLog(handler: (entry: { stream: string; line: string }) => void): Promise<UnlistenFn>
```

## UI requirements (workstream B)

Codex / Claude-Desktop shape, dark theme, Tailwind:

- **Header**: product mark, session title or cwd, chips for model / provider /
  effort / permissions, and a `MENU` chip that opens the command palette.
- **Session rail** (hidden under 900 px): session id, model, provider, effort,
  permissions, `Commands…`, `Clear view`, `Compact history`, `Context report`,
  cwd, and daemon/bridge status.
- **Transcript**: virtualized list of `transcript.ts` lines (20 px rows), the
  full entry on click, fenced code in mono, diffs coloured, tool output capped.
- **Composer**: multiline input + Send / Stop, `Enter` sends, `Shift+Enter`
  newline, a leading `/` runs a command, `↑`/`↓` walk prompt history.
- **Approval panel**: per-call `Once` / `Session` / `Always` / `Deny`.
- **Model picker**: from `catalog`, current model marked.
- **Status bar**: turn status, tokens in/out, context bar, steps, last notice.

Keyboard: `Cmd/Ctrl+K` palette, `Cmd/Ctrl+M` model picker, `Esc` close overlay,
`Cmd/Ctrl+.` interrupt.

## Verification per workstream

| Workstream | Must pass |
| --- | --- |
| A (Rust) | `cargo test --manifest-path gui/src-tauri/Cargo.toml` and `cargo build` |
| B (frontend) | `bun test gui/src` and `cd gui && bunx tsc --noEmit` and `bun run build` (vite) |
| C (docs/CI) | `cd docs-site && npm run build` (both locales) |
| D (harness) | `bun test gui/fixtures` and `gui/scripts/e2e.sh` against the fixture |

On this Mac the Rust toolchain needs the helper env (the Xcode licence is not
accepted): `PATH=/tmp/bin:$PATH CC=/tmp/zigcc.sh CXX=/tmp/zigcxx.sh
AR=/tmp/zigar.sh RANLIB=/tmp/zigranlib.sh
CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/tmp/zigcc.sh cargo …`.
CI (Linux) needs none of it.
