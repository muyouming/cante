# cante-acp

[Agent Client Protocol](https://agentclientprotocol.com) agent for
[Cante](https://github.com/muyouming/cante). ACP clients such as Zed and the
JetBrains IDEs launch it over stdio; it drives an installed `cante` binary.

Status: work in progress. It answers `initialize`, runs sessions
(`session/new`, `session/set_mode`, `session/cancel`), each on its own
`cante serve --stdio` child, and runs prompts: text, `@`-mentioned files,
embedded selections, and images reach Cante, and the reply streams back as
message and thought chunks. A prompt sent while a turn is running steers that
turn. Tool calls show up as they run, with their kind, the file they touch,
a diff for Edit and Write, progress lines, and their result. When Cante
needs approval for a call, the client gets a permission request with Allow,
Always allow in this session, and Reject; cancelling the turn denies it. Cante's
permission modes (strict, auto, yolo) appear as the session's modes,
starting from the user's settings.

Not yet:

- Reopening a session. A client that tries to restore an earlier thread (Zed
  does this for a project's last thread on relaunch) is told that loading
  sessions is not supported; open a new thread instead.
- Questions from the model. Cante's AskUser tool is left out of the session,
  so the model decides on its own instead of asking you to choose.
- MCP servers and additional directories passed by the client are ignored.

## Build from source & Run

Build and install `cante-acp`:

```bash
cargo install --path cante-acp
```

Once installed, it can be invoked via `cante` or directly:

```bash
cante acp   # dispatches to cante-acp with CANTE pointing at that cante binary
# or
cante-acp
```

Launched directly, `cante-acp` uses `--executable <PATH>`, else `cante` on `PATH`.
An install whose daemon is still named `ante` is found too — `ANTE` works as a
legacy spelling of `CANTE`, and the bare name `ante` is a fallback when no
`cante` is on `PATH`.

Zed, in `settings.json`:

```json
{ "agent_servers": { "cante": { "type": "custom", "command": "cante", "args": ["acp"] } } }
```

## Requirements

`cante` 0.2.1 or newer, checked with `cante --version` when the client sends
`initialize`. A daemon installed under the legacy name `ante` answers with
`ante 0.2.1`, which is accepted. Set `CANTE_ACP_SKIP_VERSION_CHECK=1` to skip
the check (development builds of `cante` report `0.1.0`).

Logs go to stderr at `info`; set `RUST_LOG` to change the level.
