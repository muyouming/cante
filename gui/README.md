# Cante GUI

A desktop client for [Cante](../../README.md): a Tauri 2 shell (Rust) around a
Vite + SolidJS + TypeScript frontend, styled with Tailwind v4. The Rust side
spawns `cante serve` and forwards its `Op`/`Evt` JSON Lines stream to the
frontend.

The product surface is **simple mode** (`src/simple/`): task cards, four steps
(pick → say → confirm → result), plain Chinese, no jargon. There is no second
"professional" interface — it was removed on purpose, and `ROADMAP.md` records
why. Marketing copy, priorities and the persona live there too.

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
exchange plus one pending approval, so the window opens on a populated run)
and runs `bun run dev`. Set `FAKE_CANTE_SEED=0` for an empty one. The app
starts its own session, so no external POST is needed.

## Package

```sh
bun run build          # .app + .dmg on macOS, .msi + NSIS .exe on Windows
bun run build:app      # macOS: the .app only, no disk image
```

`tauri build` runs the web build first, compiles the shell in release mode and
bundles it. The bundles are **unsigned**: Gatekeeper warns on first launch and
Windows SmartScreen asks for confirmation until the project has signing
identities — confirm once (right-click → Open; More info → Run anyway), and take
installers only from a `gui-v*` release or a build of your own.

The metadata in `tauri.conf.json` is what an installer needs: the copyright, the
repository's Apache-2.0 `LICENSE` (`licenseFile`), a macOS 11.0 minimum, a
**per-user** NSIS install (`nsis.installMode: "currentUser"` into
`%LOCALAPPDATA%\Cante`, no elevation; the `.msi` is per-machine) and WebView2
fetched with Microsoft's bootstrapper (`webviewInstallMode`) when missing.

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
dump the rendered DOM, and checks the simple shell is really there: the app
name, the 历史 and 隐私 entries, the three wizard steps, and the no-touch
promise ("原文件我不会乱动"). It is not part of the CI gate
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

## Windows UI smoke test (real WebView2, Edge WebDriver)

`scripts/dom-smoke.sh` renders the shell in Chrome on macOS — the fastest way to
catch "the frontend painted nothing". It is not the runtime the product ships
into. `e2e-windows/` closes that gap: it builds the app, starts `tauri-driver`
and drives the **real window** (WebView2) with Microsoft's Edge WebDriver.

It runs on Windows only, because only Windows and Linux have a native WebDriver
for the webview; macOS has none. So it is a step in the Windows job of
`.github/workflows/gui.yml`, deliberately **not** part of `scripts/e2e.sh`: that
script is also the local macOS gate and has to keep running on a Mac.

Run it locally on Windows (Node 18+ is used to drive WebDriver):

```sh
cd gui
bun install
cargo install tauri-driver --locked
bash e2e-windows/install-msedgedriver.sh     # the driver matching your WebView2
bunx tauri build --debug --no-bundle
bun run e2e:windows
```

One Windows trap, because it cost a red CI run: WebView2 runtime 150+ ignores the
`WEBVIEW2_*` environment variables when the host process is **elevated**, and
`msedgedriver` passes the remote debugging port through exactly that variable.
An elevated shell therefore gets `session not created: DevToolsActivePort file
doesn't exist` after a 60-second wait. A normal developer shell is not elevated
and needs nothing extra; the CI runner *is*, so that step re-launches the script
at medium integrity with [gsudo](https://github.com/gerardog/gsudo) — the recipe
the wry maintainers publish for GitHub Actions in
[tauri-apps/wry#1782](https://github.com/tauri-apps/wry/issues/1782).

What it asserts — the same first-run strings `dom-smoke.sh` pins, so the two
gates cannot drift apart: the app name, the 历史 and 隐私 entries, the three
wizard steps (欢迎 / 检查电脑 / 开始使用) and the no-touch promise
「原文件我不会乱动」. Then, on a machine provisioned through
`CANTE_ADMIN_CONFIG` (the documented enterprise path in
`src-tauri/src/admin_config.rs`), it presses a real task card, types one
sentence, presses 生成计划 and asserts the confirmation sheet («它打算这样做»).
It stops there on purpose: the next step in the product opens a **native** file
dialog, which WebDriver cannot drive, and faking it would test a different app.

Where the results are: the rendered text of every screen is printed into the CI
log, and `e2e-windows/artifacts/` gets `<screen>.txt`, `<screen>.html` and
`<screen>.png`. CI uploads that directory as the `windows-ui-smoke` artifact on
every run (7 days), so a red build arrives with a screenshot and the page text —
enough to tell "it never rendered" from "the wording changed".

msedgedriver must match the machine's WebView2 runtime, and GitHub's
`windows-latest` image upgrades both with the image, so
`e2e-windows/install-msedgedriver.sh` resolves the version at run time (the
WebView2 runtime's registry `pv`, then Edge's, then the exact build or
`LATEST_RELEASE_<major>`) and prints what it picked. Nothing here pins a
version: a mismatch does not error, it makes the WebDriver session hang.
