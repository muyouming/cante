#!/usr/bin/env bash
# gui/scripts/toolchain.sh — build-environment helper. Source it, don't run it:
#
#   source "$(dirname "$0")/toolchain.sh"
#
# On a normal machine (Linux CI included) this is a no-op: it probes whether the
# system `cc` can link a trivial program and returns immediately when it can.
#
# On a macOS box that has not accepted the Xcode licence, /usr/bin/cc and
# /usr/bin/ar refuse to link and tauri-macros' Swift bridge needs swiftc. When
# the zig-based wrappers exist (/tmp/zigcc.sh, /tmp/zigcxx.sh, /tmp/zigar.sh,
# /tmp/zigranlib.sh) and the PATH shims in /tmp/bin exist, this exports the
# compiler/linker variables cargo and cc-rs read and prepends the shims to PATH.
# Otherwise it prints the one-line fix and leaves the environment untouched.
#
# The paths are overridable so the same script works if the helpers move:
#   CANTE_ZIG_BIN_DIR (default /tmp), CANTE_ZIG_SHIM_DIR (default /tmp/bin)

cante_toolchain_setup() {
  # Idempotent: sourcing twice (or after a caller already configured the
  # toolchain) must not stack PATH entries or clobber explicit overrides.
  if [ -n "${CANTE_TOOLCHAIN_READY:-}" ]; then
    return 0
  fi
  if [ -n "${CC:-}" ] && [ -n "${CXX:-}" ] && [ -n "${AR:-}" ]; then
    CANTE_TOOLCHAIN_READY=1
    return 0
  fi

  # The Xcode-licence failure is macOS-only. Everywhere else (CI) do nothing.
  [ "$(uname -s 2>/dev/null || echo unknown)" = "Darwin" ] || return 0

  if _cante_cc_links; then
    return 0
  fi

  local zig_bin="${CANTE_ZIG_BIN_DIR:-/tmp}"
  local shim_bin="${CANTE_ZIG_SHIM_DIR:-/tmp/bin}"
  local missing=""
  local f
  for f in zigcc.sh zigcxx.sh zigar.sh zigranlib.sh; do
    [ -x "$zig_bin/$f" ] || missing="${missing:+$missing }$zig_bin/$f"
  done
  if [ ! -d "$shim_bin" ]; then
    missing="${missing:+$missing }$shim_bin"
  fi

  if [ -n "$missing" ]; then
    printf 'gui toolchain: %s cannot link; run `sudo xcodebuild -license accept` (or install zig) — missing zig helpers: %s\n' \
      "${CC:-cc}" "$missing" >&2
    # Return success: the caller decides whether a step actually needs a
    # compiler. `set -e` callers must still reach their own failure summary.
    return 0
  fi

  export CC="$zig_bin/zigcc.sh"
  export CXX="$zig_bin/zigcxx.sh"
  export AR="$zig_bin/zigar.sh"
  export RANLIB="$zig_bin/zigranlib.sh"
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$zig_bin/zigcc.sh"
  case ":$PATH:" in
    *":$shim_bin:"*) ;;
    *) export PATH="$shim_bin:$PATH" ;;
  esac
  export CANTE_TOOLCHAIN_READY=1
  printf 'gui toolchain: Xcode licence not accepted; using zig helpers (CC=%s, swiftc shim on PATH)\n' "$CC" >&2
  return 0
}

# True when the system C compiler can compile *and link* a trivial program.
_cante_cc_links() {
  local tmp cc_bin
  tmp="$(mktemp -d 2>/dev/null)" || return 1
  cc_bin="$(command -v cc 2>/dev/null || echo /usr/bin/cc)"
  printf 'int main(void){return 0;}\n' > "$tmp/probe.c"
  if "$cc_bin" "$tmp/probe.c" -o "$tmp/probe" >/dev/null 2>&1 && [ -x "$tmp/probe" ]; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  printf 'toolchain.sh: exports only affect the current shell — use `source %s`\n' "${BASH_SOURCE[0]}" >&2
fi
cante_toolchain_setup
