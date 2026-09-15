# Cante GUI

A desktop client for [Cante](../../README.md): a Tauri 2 shell (Rust) around a
Vite + SolidJS + TypeScript frontend, styled with Tailwind v4. The Rust side
spawns `cante serve` and forwards its `Op`/`Evt` JSON Lines stream to the
frontend, which renders the session rail, streaming transcript, tool cards,
approval prompts and command palette.

## Prerequisites

- **Bun** ≥ 1.2 — installs deps, runs the tests and the Vite dev server.
- **Rust** (stable, via [rustup](https://rustup.rs)) with the host linker.
- **Platform deps** for Tauri 2 (WebKit2GTK on Linux; Xcode Command Line Tools
  on macOS).

### macOS: Xcode licence

If `/usr/bin/cc` refuses to link with *"You have not agreed to the Xcode license
agreements"*, either accept it once:

```sh
sudo xcodebuild -license accept
```

or use the zig-based shims this machine already has (`/tmp/zigcc.sh`,
`/tmp/bin/xcrun`, …). `scripts/toolchain.sh` detects both cases and is sourced
by `dev.sh` and `e2e.sh`; source it yourself before a bare cargo command:

```sh
cd gui && source scripts/toolchain.sh && cargo test --manifest-path src-tauri/Cargo.toml
```

On a normal machine and on Linux CI it is a no-op.

On Windows the same commands work from PowerShell: the shell is a normal Tauri
app there, WebView2 renders the frontend (Windows 11 ships it; the bundler
installs it when missing), and `cante.exe` resolves from `PATH`. Rust needs the
MSVC toolchain, which `rustup` installs by default on Windows.

## Run

```sh
cd gui
bun install
bun run dev          # tauri dev against your installed `cante`
```

Other scripts: `bun run dev:web` (Vite only), `bun run build` (bundled app),
`bun run build:web` (frontend only).

`bun run dev` is the way in. A debug build points the window at `devUrl`
(Vite on 1420), so running `cargo run` on its own opens a **blank** window with
no frontend and no commands — that is Tauri's dev behaviour, not a broken shell.
For a window that serves the built assets, `bun run build` and open the bundle.

## Run against the fixture

No `cante` install needed — `fixtures/fake-cante.ts` is an executable scripted
`cante serve` double that speaks the real wire protocol.

```sh
cd gui
bash scripts/dev.sh
```

It sets `CANTE_BIN` to the fixture, seeds `FAKE_CANTE_SEED=1` (a finished
exchange plus one pending approval, so the window opens on a populated
transcript) and runs `bun run dev`. Set `FAKE_CANTE_SEED=0` for an empty
transcript. The app starts its own session, so no external POST is needed.

## Package

```sh
bun run build          # .app + .dmg on macOS, .msi + NSIS .exe on Windows
bun run build:app      # macOS: the .app only, no disk image
```

`tauri build` runs the web build first, compiles the shell in release mode and
bundles it. The bundles are **unsigned**: Gatekeeper warns on first launch and
Windows SmartScreen asks for confirmation until the project has signing
identities.

`bun run build:app` exists because the `.dmg` step drives Finder through
AppleScript to lay out the disk-image window. A terminal without Automation
permission (a sandboxed agent, a locked screen) cannot do that, so the disk
image fails while the app bundles fine. CI has the permission and produces both.
The macOS and Windows bundles are attached to a release by
`.github/workflows/gui-release.yml` (tag `gui-v*`, or run it by hand).

## Test and verify

```sh
cd gui
bun test src                              # frontend unit tests
bun test fixtures                         # the fixture, driven over real pipes
bunx tsc --noEmit                         # typecheck
bun run build:web                         # production frontend build
cargo test --manifest-path src-tauri/Cargo.toml   # Rust bridge (source toolchain.sh on macOS)

bash scripts/e2e.sh                       # the whole gate, fail-fast
bash scripts/dom-smoke.sh                 # render the shell in Chrome, read it back as text
```

`scripts/e2e.sh` runs all of the above in order, stops at the first failure and
prints a one-line summary; it is the same gate CI runs.

The Rust tests drive the fixture through `CANTE_BIN="bun <script>"`, because
Windows cannot execute a `#!` script directly — the spec may carry leading
arguments, and it is what makes the same test suite pass on `windows-latest`,
where CI runs this gate alongside the Linux one. There is no way to cross-check
the Windows target from macOS: `tauri-build`'s resource step needs a Windows
host, so CI is the only Windows environment the project verifies.

Two things the gate deliberately does not cover, both needing a real window:
window geometry (persisted by `tauri-plugin-window-state`) and the rendered
pixels (see `dom-smoke.sh` for a text-level substitute).

`scripts/dom-smoke.sh` is the developer/agent aid for the one thing a terminal
cannot assert on: the window. It builds the web assets, serves them, has Chrome
dump the rendered DOM, and checks that the header, chips, composer, status bar
and the browser-preview fallback are all present. It is not part of the CI gate
(CI has no Chrome) and takes about a second.

## Protocol contract

- `CONTRACT.md` — the frozen Rust ↔ frontend interface (commands, events,
  status transitions, module signatures).
- `../crates/protocol-shape/src/msg.rs` — source of truth for the `Op`/`Evt`
  wire shapes.
- [protocol-reference](https://docs.antigma.ai/reference/protocol-reference) —
  the rendered protocol reference.

## Troubleshooting

Symptom → cause → fix for the traps above — the browser-preview and stale-dev-server
banner, the blank `cargo run` window, `cante` not found and the `CANTE_BIN` command
spec, a daemon that exits mid-session, an empty model picker, the macOS Xcode
licence and `.dmg` steps, unsigned bundles, and what the fixture does and does
not simulate — lives in the guide:
[Desktop GUI → Troubleshooting](https://docs.antigma.ai/usage/gui#troubleshooting).
