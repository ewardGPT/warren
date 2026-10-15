#!/usr/bin/env bash
# Build the vendored kernel and stamp its identity.
#
#   scripts/openrig-vendor-build.sh            # install, build, stamp, verify
#   scripts/openrig-vendor-build.sh --check    # verify a build already exists
#
# The vendored tree ships SOURCE ONLY, exactly as upstream ships it: their build
# output is gitignored, and so is ours. A fresh clone therefore has no kernel to
# supervise until this runs once. Warren's supervisor falls back to a `rig` on
# PATH when the vendored build is absent (see src/kernel/entry.ts), but the
# vendored build is the one we own, so build it.
#
# Requires Node 22/24 and npm. `better-sqlite3` is a native addon: it cannot load
# in Bun (a NAPI fatal), which is why the kernel runs as a Node child process.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$REPO_ROOT/vendor/openrig"
DAEMON_ENTRY="$VENDOR/packages/daemon/dist/index.js"

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

if [ "$check_only" = 1 ]; then
  [ -f "$DAEMON_ENTRY" ] || { printf 'not built: %s is missing\n' "${DAEMON_ENTRY#"$REPO_ROOT"/}" >&2; exit 1; }
  "$REPO_ROOT/scripts/openrig-vendor-stamp.sh" --check
  printf 'vendored kernel build present and stamped\n'
  exit 0
fi

command -v node >/dev/null 2>&1 || { printf 'openrig-vendor-build: node is required\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'openrig-vendor-build: npm is required\n' >&2; exit 1; }
printf 'node %s, npm %s\n' "$(node --version)" "$(npm --version)"

if [ ! -d "$VENDOR/node_modules" ]; then
  printf '\ninstalling the vendored workspace (npm ci) ...\n'
  ( cd "$VENDOR" && npm ci --no-fund --no-audit )
else
  printf '\nvendored node_modules present — skipping npm ci\n'
fi

printf '\nbuilding ...\n'
( cd "$VENDOR" && npm run build )

printf '\nstamping the build identity with the upstream commit ...\n'
"$REPO_ROOT/scripts/openrig-vendor-stamp.sh"

printf '\nverifying ...\n'
"$REPO_ROOT/scripts/openrig-vendor-build.sh" --check
printf '\nnext: `warren kernel start` (or `bun run src/cli/main.ts kernel start`)\n'
