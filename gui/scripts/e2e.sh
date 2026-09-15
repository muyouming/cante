#!/usr/bin/env bash
# Headless gate for the GUI: the exact commands CI runs, in order. Stops at the
# first failure, exits non-zero there, and prints a one-line summary. Works from
# any cwd; on Linux CI toolchain.sh is a no-op.
#
#   bash gui/scripts/e2e.sh
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"

# shellcheck source=./toolchain.sh
source "$here/toolchain.sh"

cd "$gui_root"

total=6
current=0

step() {
  local name="$1"
  shift
  current=$((current + 1))
  printf '\n==> [%d/%d] %s\n' "$current" "$total" "$name"
  if ! "$@"; then
    printf 'e2e: FAIL at step %d/%d (%s)\n' "$current" "$total" "$name" >&2
    exit 1
  fi
}

step "bun install" bun install
step "bun test src" bun test src
step "bunx tsc --noEmit" bunx tsc --noEmit
step "bun run build:web" bun run build:web
step "bun test fixtures" bun test fixtures
step "cargo test (src-tauri)" cargo test --manifest-path src-tauri/Cargo.toml

printf '\ne2e: OK (%d/%d steps passed)\n' "$current" "$total"
