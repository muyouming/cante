#!/usr/bin/env bun
// Test double for a daemon that closes stdout and then *stays alive*.
//
// `cante serve` should not do this, but a wedged or wrapper-spawned process can:
// the bridge's stdout reader hits EOF and finalizes the exit. That used to
// `wait()` on the child **while holding the daemon mutex**, so every later
// command blocked forever. `src-tauri/tests/exit_does_not_block.rs` drives this.
//
// The fd is closed directly: `process.stdout.end()` does not propagate to the
// pipe in Bun, so it would never produce the EOF this double exists for.
export {};

import { closeSync } from "node:fs";

closeSync(1);
process.stdin.resume();
setInterval(() => {}, 1_000);
