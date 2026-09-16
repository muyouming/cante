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

## 夹具的覆盖面（守卫：gui/src/fixture-parity.test.ts）

`fixtures/fake-cante.ts` 是一份脚本化的 `cante serve` 替身：没有守护进程的机器靠它把整套测试跑起来，Windows CI 也是靠它才全绿。代价是它把一些**现实**藏了起来——我们已经被同一类事故咬过两次（卡片提示词从未发出；Windows 原生根本没有守护进程）。这一节把「它到底能演什么、演不了什么、演不了的部分靠什么保证」写下来，`gui/src/fixture-parity.test.ts` 是它的守卫：改了夹具或改了这里的清单而两边对不上，测试就红。

三种东西故意分开写，不混成一句笼统的「只能在真机上验」：

1. 夹具**能演出**的事件（下面第一份清单，由测试从夹具源码里核对）；
2. 夹具**没演**的事件（多数是纯协议形状，本可以演，只是没人写脚本——列出来是为了不让人把「夹具没演」误读成「已经覆盖」）；
3. 夹具**结构上无法**演出的现实（这些才是真正「只能在真机上验」的部分）。

### 夹具能演出的事件

```fixture-performed
SessionStart
UserInput
TurnStart
ThinkingDelta
MessageDelta
AgentMessage
ToolStart
ToolUpdate
TurnPause
TurnResume
ToolEnd
UsageUpdate
TurnEnd
Info
Goodbye
```

### 夹具没演的事件

| 事件 | 夹具为什么不演 | 只能在真机上验的部分 | 现在靠什么保证 |
| --- | --- | --- | --- |
| SessionUpdated | 夹具只在 StartSession 演一次会话信息，没有 UpdateSession 的脚本；换模型或改标题后守护进程重发 SessionInfo 这件事没演 | 真实守护进程是否在 UpdateSession 后真的发 SessionUpdated、字段是否齐全，只能在真机上验 | Rust 状态归约 gui/src-tauri/tests/state.rs；前端 store.test.ts 的恶意形状与随机流喂过这个形状；会话头随改动更新没有真机验证 |
| ExtensionRefreshed | 夹具的 SessionStart 里 skills 和 subagents 恒为空，也从不发刷新事件 | 真实守护进程会在会话里发它，带上真实的 skills、subagents 和 MCP 清单（2026-09 真机 excel.merge 两轮各见过 1 次）；这份清单只能来自真机 | 未验证：issue #107（简单界面不渲染刷新事件，起步只读 SessionStart 的 skills——真实 SessionStart 的 skills 也可能是空的，两者都没人验） |
| SessionEnd | 夹具用 Goodbye 收尾，没有演会话被替换或关闭时的 SessionEnd（带 reason 和 usage） | 真实守护进程关会话时是否发 SessionEnd、usage 是否可信，只能在真机上验 | Rust 状态归约 gui/src-tauri/tests/state.rs；前端 store.test.ts 的随机流喂过这个形状 |
| ShellOutput | 夹具不执行任何 shell 命令，也没有 stdout、stderr、退出码 | 真实命令的 stdout、stderr、退出码，只能在真机上验 | 未验证：issue #107（简单界面没有终端或命令面板入口；协议里有这个事件但产品不走） |
| Thinking | 夹具只演流式的 ThinkingDelta，没演一次性发整段思考的 Thinking | 真实守护进程在同一轮里既发 Thinking 也发 ThinkingDelta（2026-09 真机 excel.merge 两轮分别见过 11 和 12 次 Thinking），何时发哪种只能在真机上验 | 前端 store.ts 有分支；store.test.ts 的恶意形状与随机流覆盖了形状 |
| InfoBlockStart | 夹具只演单行 Info，没演带 header 的分组信息块（例如 MCP 预热） | 真实后台分组信息何时出现、header 写什么，只能在真机上验 | store.test.ts 的形状与随机流用例覆盖了渲染 |
| InfoBlockAppend | 夹具没演分组信息块的子行 | 真实子行何时追加、内容是什么，只能在真机上验 | store.test.ts 的形状与随机流用例覆盖了渲染 |
| Error | 夹具从不失败，也不会发 Error | 真实的网络、鉴权或网关错误何时以 Error 到达，只能在真机上验 | Rust 状态归约 state.rs；store.test.ts 覆盖了渲染与失败归因；真机错误在 sweep 报告里出现过 |
| CompactStart | 夹具不压缩历史，也从不发压缩开始事件 | 真实上下文占用到阈值后是否触发压缩，只能在真机上验 | store.test.ts 覆盖了渲染形状 |
| CompactEnd | 夹具不压缩历史，也从不发压缩结束事件 | 压缩摘要来自真实模型，只能在真机上验 | store.test.ts 覆盖了渲染形状（summary 有和无两种） |
| ContextReport | 夹具不回答 ContextReport（要真会话才有分类占用） | 真实会话的分类 token 占用，只能在真机上验 | store.test.ts 覆盖了渲染形状 |
| Ambient | 夹具不发 Ambient（思考短语或输入建议） | 真实便宜模型产出的建议文本，只能在真机上验 | Rust ops.rs 覆盖了发出对应 op；简单界面不显示 Ambient，前端没有覆盖 |

### 夹具演不出的现实

| 现实 | 为什么夹具挡不住 | 现在靠什么保证 |
| --- | --- | --- |
| daemon-exists | 夹具的 CANTE_BIN 永远指向一个能跑的脚本，这台电脑上没有守护进程这件事它演不出来 | gui/src-tauri/tests/missing_binary.rs 在 CI 双平台覆盖「找不到二进制时健康检查仍能回答」；Windows 原生没有守护进程的产品级交代见 issue #103 |
| vision-image-sent | 夹具的 SessionStart 不带 support_vision，也根本没有图片字节，它无法证明图片真的随请求送出去了 | issue #48；目前只有本机 mlx-serve 视觉模型那次真机验证过图真的到了，没有自动化 |
| real-model-output | 夹具把 AgentMessage、ToolStart、TurnPause、CompactEnd 的文本都写死了 | 真机普查 gui/scripts/task-sweep.sh（需要模型端点，CI 不跑）会把真实产出读回来核对 |
| real-filesystem | 夹具的 ToolEnd.result_json 是写死的字符串，没有任何文件被真的读写 | 真机普查用 cante-sheets 和 cante-pdf 把产出读回来核对（需要真机）；产品自己的文件事实有 Rust files.rs 测试 |
| real-context | 夹具把 UsageUpdate 的 token 数字写死，也从不压缩 | 真机才有的上下文占用与压缩；前端只测了写死数字的渲染 |

### 真机对照（2026-09）

`bash gui/scripts/task-sweep.sh excel.merge`（真实守护进程 + 真实模型）跑完后，`gui/scripts/sweep/work/runs/*/sweep-events.jsonl` 里实际出现的事件种类是：`AgentMessage`、`ExtensionRefreshed`、`MessageDelta`、`Thinking`、`ThinkingDelta`、`ToolEnd`、`ToolStart`、`TurnEnd`、`TurnPause`、`TurnResume`、`TurnStart`、`UsageUpdate`、`UserInput`。

其中 `Thinking` 和 `ExtensionRefreshed` 正是夹具没演的两个。清单没漏（它们在上面已经列出），但这也说明「夹具没演」确实会在真机上出现：真实守护进程同一轮里既发 `Thinking` 又发 `ThinkingDelta`；`ExtensionRefreshed` 会带上真实的 skills、subagents 与 MCP 清单，而夹具的 `SessionStart` 里这些恒为空——真实会话起步时的 skills 也可能为空，那条刷新路径至今没人验。

