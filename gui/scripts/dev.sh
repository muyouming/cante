#!/usr/bin/env bash
# Run the GUI against the scripted `cante serve` double instead of a real
# `cante` install. Seeds a session so the window opens on a populated
# transcript parked on an approval. Works from any cwd.
#
#   bash gui/scripts/dev.sh
#   FAKE_CANTE_SEED=0 bash gui/scripts/dev.sh   # empty transcript instead
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"

# shellcheck source=./toolchain.sh
source "$here/toolchain.sh"

cd "$gui_root"

# Absolute so it resolves no matter what cwd Tauri hands the app. The fixture
# is executable and carries a `#!/usr/bin/env bun` shebang.
export CANTE_BIN="${CANTE_BIN:-$gui_root/fixtures/fake-cante.ts}"
# Seed a finished exchange plus a pending approval, so the window is populated
# without the developer sending anything (the app asks for the session itself).
export FAKE_CANTE_SEED="${FAKE_CANTE_SEED:-1}"

printf 'dev: CANTE_BIN=%s FAKE_CANTE_SEED=%s\n' "$CANTE_BIN" "$FAKE_CANTE_SEED"
exec bun run dev "$@"
