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
| `cante://state` | `{ status: Status, session: SessionInfo \| null, pending_approval: PendingApproval \| null, pending_question: PendingQuestion \| null, cante: string \| null, cwd: string }` |
| `cante://log` | `{ stream: "stderr" \| "stdout" \| "app", line: string }` |
| `cante://exit` | `{ code: number \| null }` — the daemon died |

`Status` = `"idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline"`.

`PendingApproval` = `{ turn_id: string, message: string, tools: Array<{ id, name, args }> }`.

`PendingQuestion` = `{ turn_id: string, tool_use_id: string, questions: QuestionSpec[] }` — the
`TurnPause` / `reason.Question` pause (r25): the paused turn, the tool call to echo back in
`QuestionResponse`, and the questions. Mirrors `PendingQuestion` in `src/protocol.ts`. An
`Approval` pause clears it, and the protocol clears it on `TurnResume` **and** `TurnEnd` (a
cancelled turn may end without a resume).

`cante` is the resolved daemon binary's `--version` (its first line; `null` until probed),
and `cwd` is the directory the daemon is spawned in (`set_cwd`). `State` in the `events_since`
reply above is exactly this `cante://state` payload — one object, two entry points.

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
- **No fabrication**: never synthesize protocol events — with the single,
documented exception below (the stall report).

#### A turn that goes quiet (bridge-synthesized `Error`)

When the network dies mid-turn, `pi` can stop talking without ever sending a
`TurnEnd` or an `Error`. The window then spins forever and she concludes the app
is broken. `cante-bridge` therefore watches its own turn and reports the silence
itself (issue #173); the upstream daemon does not have to grow a timeout for it.

| | |
| --- | --- |
| Who | `cante-bridge` (`src-tauri/src/bridge.rs`, `stall_watch`) |
| Armed | A prompt was written (`UserInput`), and again on `TurnStart`. Silence before the first prompt is not a stall. |
| Reset | Every event the **window** receives resets the clock. Raw lines from `pi` that translate to nothing do **not**: a real cut produced 920 s in which the window got nothing while `pi` retried the dead request internally, and that must not keep the spinner alive. An open `TurnPause` (approval sheet) is exempt: `pi` is waiting on the user, and the clock is refreshed instead of expiring. |
| Fired | When a live turn has said **nothing at all** for the silence budget. |
| Event | `Evt::Error` (`{ "Error": "…" }`) with the plain-Chinese sentence. No `TurnEnd` is emitted: the turn is neither a success nor a failure — it is unfinished. |
| After | The turn is abandoned. Late events from it are dropped (a late `agent_settled` must not close a run the window has moved on from), the next prompt starts a clean turn, and the assistant's running work is **not** aborted — killing a tool mid-write could damage a file. |
| Wording | The message starts with `连不上帮你处理的服务方`; `src/simple/copy.ts` matches that marker for the stall-specific 发生了什么 / 你可以怎么做, and `recovery.ts` routes it to 「再试一次」. Change the marker in one place only if you change the other. |
| Facts in the message | The adapter quotes only what it counted from events it forwarded: `已经做到第 N 步` = `turn_start` count, `做完了 N 个操作` = non-denied `tool_execution_end` count (a call still in flight is **not** counted). Either number may be absent when it is zero; neither is ever invented. `原来的文件都还在` is the product's own rule (results are always saved as new files), **not** a measurement — the adapter never reads files. |
| Retry semantics quoted | The message ends `会把刚才那件事重做一遍`. That is literal: 「再试一次」 starts a **fresh run** from the confirmation sheet (`TaskRunner.tsx` `plan()` → `store.startRun()`), it does **not** resume the abandoned turn (the adapter never re-attaches a half-run tool). If that ever becomes a resume, this clause and `ERRORS.stallHow` must change with it. |

`src/simple/copy.ts` splits the facts out of the sentence: `stallFacts()` parses
`已做到第 N 步` / `做完了 N 个操作` back out of the raw text and `ErrorView.tsx`
renders them as a separate 「已经做到这里」 block, so the progress and the file
rule are not buried in the “你可以怎么做” sentence. Both numbers come from the
same two counts above; no number means that line is simply not drawn.

**The silence budget is 600 s (10 minutes)**, overridable with
`CANTE_BRIDGE_STALL_SECS` (seconds; `0` disables). It is deliberately large:
slow is not disconnected.

* **Slow means a long gap, not a long card.** The slowest real card measured is
  **846 s** (Gemma-4, zero tool calls; `gui/scripts/sweep/README.md`) — but it
  streamed the whole time, so the *window* was never silent. The quantity this
  watchdog measures is the gap.
* That gap has its own measured rule: the sweep has judged “no event for 300 s”
  to mean stuck on real cards, and the 846 s card never tripped it. 600 s is
  twice that proven-safe gap.
* It also has to beat the gateway's own recovery: four 60 s reconnects is 240 s,
  less than half the budget.
* It has to beat `pi`'s own patience, or the window still freezes for a quarter
  of an hour. Measured against a real cut (below): `pi` retried the dead request
  silently at ~305 s intervals and gave up at ~925 s. 600 s reports about five
  minutes earlier, in plain Chinese, with an exit she can press.

While a turn is live and silent this is the *only* event the adapter
synthesizes; every other event is still forwarded verbatim.

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

A bridge-synthesized stall `Error` (above) is an ordinary `Error` here: status
`error`, and the window shows the failure page instead of a spinner.

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
Error
Goodbye
```

除了上面这份事件清单，夹具还演出了三个**真实守护进程会出现、界面真的读**的状态，让没有守护进程的机器（CI 就是）也能把它们跑通：

* **一批多次审批**（`FAKE_CANTE_APPROVAL_BATCH=<n>`）：一次 `TurnPause` 的 `reason.Approval.tools` 里放 n 条调用（默认 1，最多 4）。审批卡就是按「一批」设计的，所以这是必须有的一条；`fixtures/fake-cante.test.ts` 断言两条都在、`store.test.ts` 断言审批卡一次列出两条并各自翻译成中文动作。
* **审批被拒**：由 `ApprovalResponse` 里那一条自己的 `decision` 驱动——接受的那条以 `Completed` 收尾，拒绝的那条以 `Denied` 收尾，而且 `TurnResume` 之后**没有** `ToolStart`（被拒的调用从未真正开始）。这是输入驱动的，不是写死的第二条路径：同一批里可以一半接受一半拒绝。
* **中途出错**（`FAKE_CANTE_TURN_ERROR=1`）：一条 `Error`（原始报错原话）后面跟一个非 `Completed` 的 `TurnEnd`（`status.Error` 带 `kind` / `headline` / `details`），也就是出错页与失败记录读的那个形状。

「用量」这一条**没有补**：`UsageUpdate` 虽然夹具本来就在演，但 `store.ts` 的归约里根本没有它对应的分支（简单界面没有任何一处读 token 用量或上下文占用），补一条只有守卫在看的用量脚本就是死代码。真要看用量，唯一被读的是 `ContextReport`（上面「夹具没演的事件」里那一行）。

### 夹具没演的事件

| 事件 | 夹具为什么不演 | 只能在真机上验的部分 | 现在靠什么保证 |
| --- | --- | --- | --- |
| SessionUpdated | 夹具只在 StartSession 演一次会话信息，没有 UpdateSession 的脚本；换模型或改标题后守护进程重发 SessionInfo 这件事没演 | 真实守护进程是否在 UpdateSession 后真的发 SessionUpdated、字段是否齐全，只能在真机上验 | Rust 状态归约 gui/src-tauri/tests/state.rs；前端 store.test.ts 的恶意形状与随机流喂过这个形状；会话头随改动更新没有真机验证 |
| ExtensionRefreshed | 夹具的 SessionStart 里 skills 和 subagents 恒为空，也从不发刷新事件 | 真实守护进程会在会话里发它，带上真实的 skills、subagents 和 MCP 清单（2026-09 真机 excel.merge 两轮各见过 1 次）；这份清单只能来自真机 | 已定论（#107）：不接，显式忽略——简单界面不渲染刷新事件，起步只读 SessionStart 的 skills，而真实 SessionStart 的 skills 也可能为空，两端都决定不消费；理由与测试见下面「没人验的能力：逐条定论（#107）」 |
| SessionEnd | 夹具用 Goodbye 收尾，没有演会话被替换或关闭时的 SessionEnd（带 reason 和 usage） | 真实守护进程关会话时是否发 SessionEnd、usage 是否可信，只能在真机上验 | Rust 状态归约 gui/src-tauri/tests/state.rs；前端 store.test.ts 的随机流喂过这个形状 |
| ShellOutput | 夹具不执行任何 shell 命令，也没有 stdout、stderr、退出码 | 真实命令的 stdout、stderr、退出码，只能在真机上验 | 已定论（#107）：不接，显式忽略——简单界面没有终端或命令面板入口，协议里有这个事件但产品不走；理由与测试见下面「没人验的能力：逐条定论（#107）」 |
| Thinking | 夹具只演流式的 ThinkingDelta，没演一次性发整段思考的 Thinking | 真实守护进程在同一轮里既发 Thinking 也发 ThinkingDelta（2026-09 真机 excel.merge 两轮分别见过 11 和 12 次 Thinking），何时发哪种只能在真机上验 | 前端 store.ts 有分支；store.test.ts 的恶意形状与随机流覆盖了形状 |
| InfoBlockStart | 夹具只演单行 Info，没演带 header 的分组信息块（例如 MCP 预热） | 真实后台分组信息何时出现、header 写什么，只能在真机上验 | store.test.ts 的形状与随机流用例覆盖了渲染 |
| InfoBlockAppend | 夹具没演分组信息块的子行 | 真实子行何时追加、内容是什么，只能在真机上验 | store.test.ts 的形状与随机流用例覆盖了渲染 |
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

其中 `Thinking` 和 `ExtensionRefreshed` 正是夹具没演的两个。清单没漏（它们在上面已经列出），但这也说明「夹具没演」确实会在真机上出现：真实守护进程同一轮里既发 `Thinking` 又发 `ThinkingDelta`；`ExtensionRefreshed` 会带上真实的 skills、subagents 与 MCP 清单，而夹具的 `SessionStart` 里这些恒为空——真实会话起步时的 skills 也可能为空。那条刷新路径以前没人验，现在有了定论：不接（见下面「没人验的能力：逐条定论（#107）」）。

### 没人验的能力：逐条定论（#107）

上面两份清单回答的是「夹具演不出来的部分，现在靠什么保证」。但有一类条目原来的答案是「未验证：issue #107」——也就是说，夹具演不出、真机上真的会出现、而且**谁都没验**。一张没人负责的清单不算保证，所以这里对每一条给出**决定**，并写清**拿什么把决定锁住**；上面那两行（ExtensionRefreshed、ShellOutput）的保证栏也随之改成指到这里。

每个决定必须落进三类之一：**接**（简单界面确实需要，那就接上并在 store / 界面体现，加测试）；**不接，但明确**（不需要，就在代码里显式忽略、写清原因，并用测试断言「它是有意被忽略的」）；**需要单独跟踪**（现在做不完，写清为什么现在不做、什么时候该做）。本轮四条全部落在「不接，但明确」，原因都指向同一件事：**简单界面没有对应的入口，也没有对应的位置**。

它们在代码里由 `gui/src/store.ts` 的 `IGNORED_EVENTS` 显式挡下（不是被 reducer 的 `default:` 顺手吞掉），并由 `gui/src/store.test.ts` 的「有意忽略的事件（#107 的定论）」用例断言：不出行、不改状态机、不换会话。

| 能力 | 决定 | 理由 | 由什么锁住 |
| --- | --- | --- | --- |
| `ExtensionRefreshed` 的刷新路径 | 不接，但明确 | 它带的是 skills、subagents、MCP 清单（`crates/protocol-shape/src/msg.rs` 的 `ExtensionRefreshed`），而简单界面没有技能或命令入口——pro 的命令面板已删（`store.ts` 顶部注释），`src/simple/**` 与 `store.ts` 里没有任何一处读 `SessionInfo.skills`。它也不带 model / provider，刷新不了简单界面唯一会读的会话字段（`support_vision`，见 `src/simple/capabilities.ts` 的 `visionAvailable`）。真机确实会发它（2026-09 `sweep excel.merge` 两轮各 1 次），所以是「见过、决定不接」，不是「没见过」 | `store.ts` 的 `IGNORED_EVENTS`；`store.test.ts` 断言 ExtensionRefreshed 不出行、不改状态、不换会话；`fixture-parity.test.ts` 核对 `IGNORED_EVENTS` 里每个事件都在本表里有记录 |
| 起步时 skills 为空（SessionStart 的 skills 字段） | 不接，但明确 | 真实 `SessionStart` 可能给空 skills，稍后由 `ExtensionRefreshed` 补齐（#107）。但简单界面只有 `src/simple/tasks/index.ts` 的静态卡片表（`TASKS`）这一个入口，张数由该数组决定（`docs-consistency.test.ts` 盯着文档里写的数），不随 skills 变化，也没有任何地方读这份清单。所以「起步是不是空的」今天不影响任何用户可见行为。将来加了技能或命令入口，这条决定必须重开——那时「刷新补齐」就是必须接的路径 | `store.test.ts` 断言空 skills 起步加带真 skills 的刷新事件不改变任何用户可见状态；`fixture-parity.test.ts` 扫源码，断言 `src/simple/**` 与 `store.ts` 不读 `.skills` |
| `ShellOutput` | 不接，但明确 | 简单界面没有终端、也没有命令面板；`send_input` 只在 `store.ts` 的 `sendRunInstruction` 里发过一次，mode 恒为 `prompt`，所以产品永远不会触发 shell 命令，也收不到它的 stdout / stderr / 退出码。就算收到了，把命令原文渲染给用户等于把「终端 / 路径」这类黑名单词直接摆到界面上（`src/simple/copy-guard.test.ts` 的黑名单），而且没有可操作的去处 | `store.ts` 的 `IGNORED_EVENTS`；`store.test.ts` 断言 ShellOutput 不出行、不改状态 |
| `Ambient` | 不接，但明确 | 它是思考短语或输入建议，要先由前端发 `AmbientPhrase` / `AmbientSuggestion` 去问才有回包（`crates/protocol-shape/src/msg.rs` 的 `Evt::Ambient`）；`src/tauri.ts` 的 `Commands` 里没有这两个 op，简单界面也没有状态栏短语或输入提示的位置，所以它只会是没人要的回包。上面「夹具没演的事件」里 Ambient 那一行本就写着「简单界面不显示 Ambient」，这里把它升成一条有测试兜着的决定 | `store.ts` 的 `IGNORED_EVENTS`；`store.test.ts` 断言 Ambient 不出行、不改状态 |

四条的复查条件写在一起免得忘：**简单界面第一次出现「按名字调用一项技能 / 命令」的入口时**，第 1、2 条必须重开（skills 清单与它稍后刷新补齐的路径）；**出现终端或命令行入口时**，第 3 条必须重开。到那时 `gui/src/store.test.ts` 里对应的断言会先红，红的信息会把人指回这一节。

