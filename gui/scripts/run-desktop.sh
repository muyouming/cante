#!/usr/bin/env bash
# Run the desktop app the way a person would, without putting secrets in the repo.
#
#   bash gui/scripts/run-desktop.sh              # run the release bundle
#   bash gui/scripts/run-desktop.sh --build      # rebuild the release bundle first
#   bash gui/scripts/run-desktop.sh --dev        # `tauri dev` against the sources
#
# Why this exists: cante reads provider credentials from the environment
# (`OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, …), and a
# double-click from Finder inherits no environment at all — so a gateway-backed
# build would start, open a session, and fail on the first task with an auth
# error that says nothing useful. This script exports the same variables a shell
# launch would, from a file outside the repository:
#
#   ~/.ante/cante-gateway.env     (chmod 600; `export VAR=value` lines)
#
# An API key never belongs in git, so the file is read if it exists and skipped
# if it does not (a local-model setup needs no key at all).
#
# `CANTE_BIN` is passed through unchanged, so a fixture double still works:
#   CANTE_BIN="bun $PWD/gui/fixtures/fake-cante.ts" bash gui/scripts/run-desktop.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$APP_DIR/.." && pwd)"
cd "$APP_DIR"

ENV_FILE="${CANTE_ENV_FILE:-$HOME/.ante/cante-gateway.env}"
BUNDLE="$APP_DIR/src-tauri/target/release/bundle/macos/Cante.app/Contents/MacOS/cante-gui"
MODE="release"

for arg in "$@"; do
  case "$arg" in
    --build) MODE="build" ;;
    --dev) MODE="dev" ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run-desktop: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090  # the path is the user's, not the repo's
  source "$ENV_FILE"
  echo "run-desktop: loaded $ENV_FILE"
else
  echo "run-desktop: no $ENV_FILE (fine for a local model)"
fi

# One window at a time: a stale gui keeps its own daemon and its own session.
pkill -f "Cante.app/Contents/MacOS/cante-gui" 2>/dev/null || true
pkill -f "\.ante/bin/ante serve" 2>/dev/null || true
sleep 1

if [ "$MODE" = "build" ]; then
  source "$APP_DIR/scripts/toolchain.sh"
  echo "run-desktop: building the release bundle (a few minutes)"
  (cd "$APP_DIR" && bunx tauri build --bundles app)
fi

if [ "$MODE" = "dev" ]; then
  source "$APP_DIR/scripts/toolchain.sh"
  echo "run-desktop: tauri dev"
  exec bunx tauri dev
fi

if [ ! -x "$BUNDLE" ]; then
  echo "run-desktop: no release bundle at $BUNDLE" >&2
  echo "run-desktop: build one first: bash gui/scripts/run-desktop.sh --build" >&2
  exit 2
fi

echo "run-desktop: starting $(basename "$BUNDLE")"
nohup "$BUNDLE" > /tmp/cante-desktop.log 2>&1 &
sleep 12

echo "run-desktop: log is /tmp/cante-desktop.log"
if command -v pgrep >/dev/null; then
  gui_pid="$(pgrep -f 'Cante.app/Contents/MacOS/cante-gui' | head -1 || true)"
  daemon_pid="$(pgrep -f '[.]ante/bin/ante serve' | head -1 || true)"
  echo "run-desktop: window pid=${gui_pid:-none} daemon pid=${daemon_pid:-none}"
fi
if [ -n "${OPENAI_COMPATIBLE_BASE_URL:-}" ]; then
  echo "run-desktop: model endpoint $OPENAI_COMPATIBLE_BASE_URL"
fi
