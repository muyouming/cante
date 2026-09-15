#!/usr/bin/env bash
# Run a PocketJS command for this app.
#
# PocketJS's CLI only works inside a PocketJS checkout — it walks up from the
# cwd looking for the package.json named `@pocketjs/framework`. So this script
# materializes a checkout (the published `@pocketjs/framework` tarball *is* the
# checkout), symlinks this app into `<checkout>/apps/cante-gui`, and delegates.
#
#   scripts/pocket.sh check                 # manifest + capability + typecheck (web-app)
#   POCKET_TARGET=psp scripts/pocket.sh check
#   POCKET_TARGET=macos-app scripts/pocket.sh check
#   scripts/pocket.sh build                 # bundle for the target
#   scripts/pocket.sh dev                   # browser dev host (needs the wasm core)
#
# Environment:
#   POCKETJS_ROOT      use an existing checkout instead of .pocketjs/
#   POCKETJS_VERSION   framework version to fetch (default 0.11.0)
#   POCKET_TARGET      target id for check/build (default web-app)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
CHECKOUT="${POCKETJS_ROOT:-$REPO_ROOT/.pocketjs}"
POCKETJS_VERSION="${POCKETJS_VERSION:-0.11.0}"
POCKET_TARGET="${POCKET_TARGET:-web-app}"
APP_LINK="$CHECKOUT/apps/cante-gui"

ensure_checkout() {
  if [ -f "$CHECKOUT/package.json" ] && grep -q '"@pocketjs/framework"' "$CHECKOUT/package.json"; then
    return
  fi
  echo "==> fetching PocketJS $POCKETJS_VERSION into $CHECKOUT"
  rm -rf "$CHECKOUT"
  mkdir -p "$CHECKOUT"
  local tarball
  tarball="$(cd "$CHECKOUT" && npm pack "@pocketjs/framework@$POCKETJS_VERSION" --silent)"
  tar xzf "$CHECKOUT/$tarball" -C "$CHECKOUT" --strip-components=1
  rm -f "$CHECKOUT/$tarball"
}

ensure_deps() {
  if [ ! -d "$CHECKOUT/node_modules" ]; then
    echo "==> bun install (checkout)"
    (cd "$CHECKOUT" && bun install)
  fi
  if [ ! -d "$APP_DIR/node_modules" ]; then
    echo "==> bun install (app)"
    (cd "$APP_DIR" && bun install)
  fi
}

link_app() {
  mkdir -p "$CHECKOUT/apps"
  [ -e "$APP_LINK" ] || ln -s "$APP_DIR" "$APP_LINK"
}

cmd="${1:-check}"
shift || true

ensure_checkout
ensure_deps
link_app

case "$cmd" in
  check)
    (cd "$CHECKOUT" && bun tools/pocket.ts check --target "$POCKET_TARGET" \
      --manifest "$APP_LINK/pocket.json" --project-root "$APP_LINK" "$@")
    ;;
  build)
    (cd "$CHECKOUT" && bun tools/pocket.ts build --target "$POCKET_TARGET" \
      --manifest "$APP_LINK/pocket.json" --project-root "$APP_LINK" -- "$@")
    ;;
  dev)
    (cd "$CHECKOUT" && bun tools/dev.ts "$@" cante-gui-main)
    ;;
  *)
    echo "unknown command: $cmd (use check|build|dev)" >&2
    exit 2
    ;;
esac
