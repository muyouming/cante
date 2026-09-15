# Cante GUI

A graphical client for Cante, built with [PocketJS](https://pocketjs.dev) — a
portable app runtime that compiles Solid components to a native UI tree (no
browser engine, no runtime CSS). The layout follows the Codex / Claude Desktop
shape: a session rail, a streaming transcript with tool cards and inline
approvals, a composer, and a token/context status strip.

```
┌──────────────────────────────────────────────────────────────────────┐
│ CANTE   ~/dev/project            model  provider  effort  perm        │  header
├────────────┬─────────────────────────────────────────────────────────┤
│ SESSION    │ YOU                          12:04                      │
│ ses_01J…   │ add retry to the upload client                          │
│            │ CANTE                        12:04                      │
│ MODEL      │ I'll patch the upload path.                             │
│ Sonnet 5   │ THINKING                     12:04  ●                   │
│            │ reading the client and its tests…                       │
│ PROVIDER   │ TOOL Edit                    12:05                      │
│ Anthropic  │ @@ -1,4 +1,6 @@                                         │
│            │ -  let retries = 0;                                     │
│ EFFORT     │ +  let retries = 0;                                     │
│ High       │ +  const backoff = (n) => 2 ** n;                       │
│            │ APPROVAL REQUIRED            12:05                      │
│ PERMISSIONS│ ┌ Bash  once ┐ ┌ Write  session ┐                        │
│ Strict     │ ── APPROVE ──────────────────────────── DENY ALL ──     │
│            │ Ask Cante…                          ┌SEND┐ ┌STOP┐        │  composer
│ WORKSPACE  │                                                         │
│ ~/dev/…    │                                                         │
│ ● bridge   │                                                         │
├────────────┴─────────────────────────────────────────────────────────┤
│ idle   in 12.4k · out 1.2k   ctx ▓▓▓▓░░░░ 38%   steps 4               │  status
└──────────────────────────────────────────────────────────────────────┘
```

## Rendering

`VirtualList` is uniform-row, so the transcript is laid out as a stream of
20 px **lines** (`src/transcript.ts`): one header line per entry (kind chip +
time) followed by wrapped body lines. That buys, with no measurement pass:

- **fenced code** in agent messages renders in the mono face, fences stripped;
- **unified diffs** in tool output are colored (`+` green, `-` red, `@@` blue);
- **tool output** gets its own `output` header and is capped at 80 lines;
- a 400-line cap per entry, with the remainder summarized and the full text one
  press away in the detail modal.

Layout is memoized per row object, so a poll batch re-lays out only the entries
that changed (normally just the streaming tail).

## Why there is a bridge

PocketJS gives a guest a **bounded, whole-response HTTP client** — `fetch`,
max 256 KiB, no sockets, no streaming, no WebSocket. Cante's daemon speaks
`Op`/`Evt` JSON Lines over stdio, a Unix socket, or a WebSocket. Something has
to hold the pipe, so this example ships both halves:

```
cante (stdio JSONL)  ⇄  bridge (Bun, loopback HTTP)  ⇄  GUI (PocketJS fetch)
```

`bridge/cante-bridge.ts` spawns `cante serve`, forwards `Op`s, keeps a bounded
ring of `Evt`s, and answers `GET /events?cursor=N` with a **cursor-addressed
long-poll**: small, delta-coalesced batches that always fit the guest's
response ceiling. The GUI polls, applies each batch to one reducer, and
advances its cursor. Zero events means the request parks until something
arrives (or 20 s), so an idle turn costs nothing.

The bridge never fabricates protocol events and adds no policy of its own: it
is a transport, and every decision still belongs to Cante.

## Quickstart

Three terminals, or one with `&`:

```sh
# 1. bridge (loopback only; starts `cante serve` on first /session)
bun examples/gui/bridge/cante-bridge.ts

# 2. the app, in the browser dev host (needs a PocketJS checkout; see below)
cd examples/gui && ./scripts/pocket.sh dev
```

The bridge defaults to `http://127.0.0.1:4317` and the `cante` binary on
`PATH`. Override either:

```sh
CANTE_BIN=/usr/local/bin/cante CANTE_GUI_PORT=4317 bun examples/gui/bridge/cante-bridge.ts
```

If the binary is missing or the daemon dies, the GUI shows a red *bridge
offline* bar and keeps re-probing; nothing needs restarting once the bridge
comes back.

## Building and checking the app

PocketJS only builds inside a PocketJS checkout — its CLI walks up from the cwd
looking for the `@pocketjs/framework` package. `scripts/pocket.sh` fetches the
published framework tarball (which *is* a checkout), symlinks this app into
`<checkout>/apps/cante-gui`, and delegates:

```sh
cd examples/gui
./scripts/pocket.sh check                      # manifest + capabilities + typecheck
POCKET_TARGET=psp ./scripts/pocket.sh check    # ... against the PSP profile
POCKET_TARGET=macos-app ./scripts/pocket.sh check
./scripts/pocket.sh build                      # bundle for the target
```

The manifest declares a **fixed 480×272** variant (PSP/Vita) and a **dynamic
1100×720** default (desktop/browser), so the same source runs on a handheld and
in a window; the rail collapses below 900 px.

Environment: `POCKETJS_ROOT` (use an existing checkout), `POCKETJS_VERSION`
(default `0.11.0`), `POCKET_TARGET` (default `web-app`).

## Controls

| Input | Action |
| --- | --- |
| Press a transcript row | Open the full entry (bodies are clipped in the list) |
| Press a tool card in the approval panel | Cycle `Once → Session → Always → Deny` |
| `TRIANGLE` | Summon the system keyboard for the composer |
| `SQUARE` | Interrupt the running turn |
| `SELECT` | Toggle the model picker |
| d-pad / arrows | Move focus; the transcript follows the focused row |
| tap / click | Same activation path as `CIRCLE` on every control |

The rail's *model*, *provider*, *effort* and *permissions* rows are controls:
pressing them opens the picker or cycles the value. Effort and permission
changes ride `UpdateSession`, so they apply to the next turn without dropping
the conversation; picking a provider/model starts a new session (matching
`cante`'s own semantics).

## Bridge API

| Route | Body / query | Effect |
| --- | --- | --- |
| `GET /healthz` | — | bridge version, `cante --version`, cwd, daemon state |
| `GET /catalog` | — | `cante catalog` (cached 60 s) for the model picker |
| `GET /events` | `cursor`, `timeout_ms` | long-poll `{cursor, truncated, events[], state}` |
| `POST /session` | `{model?, provider?, effort?, permission_mode?, cwd?, resume_session_id?}` | `StartSession` / `ResumeSession` |
| `POST /update` | `{model?, permission_mode?, title?}` | `UpdateSession` |
| `POST /input` | `{text, mode: prompt\|steer\|shell}` | `UserInput` / `Steer` / `ShellInput` |
| `POST /approval` | `{turn_id, responses[]}` | `ApprovalResponse` |
| `POST /interrupt` | — | `Interrupt` |
| `POST /slash` | `{name, args}` | `SlashCommand` |
| `POST /compact` | `{instructions?}` | `Compact` |
| `POST /context` | — | `ContextReport` |
| `POST /shutdown` | — | `Shutdown`, then stops the daemon |

Everything binds to loopback. Cante's protocol has no authentication, so the
bridge refuses nothing but also reaches nothing: keep it on `127.0.0.1`.

## Tests

```sh
bun test examples/gui/bridge examples/gui/src   # 24 tests: bridge + layout
bunx tsc --noEmit -p examples/gui/tsconfig.bridge.json
```

The bridge integration cases drive a scripted `cante serve` double over real
pipes (`bridge/fixtures/fake-cante.ts`), so line framing, the event ring,
long-poll wakeups, approval state, and the HTTP surface are exercised end to
end without a Cante install. The layout suite is pure: wrapping budgets, fence
detection, diff classification, truncation, and the per-row cache.

## Layout

```
examples/gui/
  pocket.json               # PocketJS manifest: capabilities + viewports
  main.tsx                  # mount(() => <App />)
  app.tsx                   # shell: rail + transcript + composer + status
  src/
    protocol.ts             # Op/Evt wire types (mirrors crates/protocol-shape)
    bridge.ts               # bounded-fetch HTTP client for the bridge
    rows.ts                 # the transcript row model (framework-free)
    transcript.ts           # pure rows -> display-lines layout + cache
    transcript.test.ts      # layout unit tests
    store.ts                # signals + the event reducer + the poll loop
    components/             # Transcript, Composer, SessionRail, modals, …
  bridge/
    cante-bridge.ts         # the loopback HTTP ⇄ stdio daemon
    cante-bridge.test.ts    # unit + end-to-end tests
    fixtures/fake-cante.ts  # scripted `cante serve` double
  scripts/pocket.sh         # materialize a checkout and run PocketJS commands
```

## Known limits

- **Text entry is the system keyboard.** PocketJS's `TextField` summons a
  framework-drawn OSK on every target today; there is no host text-input path
  in the `web-app` / `macos-app` profiles yet. `input.text`/`input.ime` are
  declared under `enhances` so the app lights up automatically when a host
  grows them.
- **Wrapping is estimated, not measured.** PocketJS exposes no text metrics,
  so the layout pass wraps at an average advance (6.6 px proportional, 8.6 px
  mono). A line that runs long clips in the list; pressing it opens the full
  entry.
- **Desktop/web bundling** is not in the CLI's backend table yet (`pocket
  build --target web-app` compiles the bundle, then finds no backend). `pocket
  dev` and `pocket check` are the supported paths; PSP and Vita are the fully
  wired targets.
- **No streaming transport**: deltas arrive per poll batch, so a very chatty
  turn renders in ~1 batch per round trip rather than per token. Coalescing
  keeps that to a few updates per second.
