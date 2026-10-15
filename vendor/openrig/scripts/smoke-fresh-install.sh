#!/usr/bin/env bash
# OPR.0.4.1.30 — fresh-install / packaging smoke-test (empirical companion to the static
# packaging-deps-mirror gate). Proves a fresh install of the PUBLISHED cli can actually start the
# daemon — i.e. every runtime dependency the vendored daemon requires is resolvable from the
# install, not just present via monorepo hoisting. This is the gate that catches the 0.4.0
# @hono/node-ws break (fresh `npm install -g` -> `rig daemon start` failed on a missing dep).
#
# Run this in a CLEAN environment: a Tart VM (vm-e2e fresh-install lane) or a container
# (containerized-e2e). It isolates OPENRIG_HOME + the daemon port + the DB so it never touches a
# host daemon, but a truly pristine machine is the faithful audience. Intended home:
# release-durability-close (run before any publish/host-upgrade).
#
# Exit 0 = a fresh install starts a healthy daemon. Non-zero = a packaging/runtime-dep gap.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
DAEMON_PKG="$REPO_ROOT/packages/daemon/package.json"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openrig-fresh-install.XXXXXX")"
PORT="${OPENRIG_SMOKE_PORT:-17555}"
DAEMON_PID=""

cleanup() {
  # Stop the isolated daemon (best-effort) and remove the scratch dir. Never touches a host daemon —
  # this one ran under an isolated OPENRIG_HOME + DB + port.
  if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    "${RIG_BIN:-}" daemon stop >/dev/null 2>&1 || kill "${DAEMON_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK}" "${CLI_DIR}"/*.tgz 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL — $*" >&2; exit 1; }

echo "[1/5] Building + packing the publishable cli (vendors the daemon)..."
bash "$REPO_ROOT/scripts/build-package.sh" >/dev/null
TARBALL="$(cd "$CLI_DIR" && npm pack 2>/dev/null | tail -1)"
[ -f "$CLI_DIR/$TARBALL" ] || fail "npm pack did not produce a tarball"

echo "[2/5] Installing the tarball into a CLEAN isolated prefix (no dev/monorepo node_modules)..."
mkdir -p "$WORK/install"
( cd "$WORK/install" && npm init -y >/dev/null 2>&1 && npm install "$CLI_DIR/$TARBALL" --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
CLI_INSTALL="$WORK/install/node_modules/@openrig/cli"
[ -d "$CLI_INSTALL" ] || fail "cli did not install into the clean prefix"

echo "[3/5] Asserting every daemon runtime dep resolves from the fresh install..."
# The vendored daemon resolves its deps from the install's node_modules. Each must be present.
node -e '
  const fs = require("fs");
  const path = require("path");
  const daemonDeps = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies || {});
  const from = process.argv[2];
  const missing = daemonDeps.filter((d) => {
    try { require.resolve(d, { paths: [from] }); return false; } catch { return true; }
  });
  if (missing.length) { console.error("UNRESOLVED runtime deps on fresh install: " + missing.join(", ")); process.exit(1); }
  console.log("    all " + daemonDeps.length + " daemon runtime deps resolve (incl. @hono/node-ws)");
' "$DAEMON_PKG" "$CLI_INSTALL" || fail "a daemon runtime dep is missing from the fresh install (packaging gap)"

echo "[4/5] Starting the daemon from the fresh install (isolated home/db/port :$PORT)..."
export OPENRIG_HOME="$WORK/home"
export RIG_BIN="$CLI_INSTALL/dist/bin-wrapper.js"
mkdir -p "$OPENRIG_HOME"
node "$RIG_BIN" daemon start --port "$PORT" --db "$WORK/state.db" >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

echo "[5/5] Polling health (bounded) ..."
HEALTHY=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then HEALTHY=1; break; fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then break; fi
  sleep 1
done
[ -n "$HEALTHY" ] || { echo "--- daemon.log ---"; cat "$WORK/daemon.log" >&2 || true; fail "daemon did not become healthy (fresh-install start failed)"; }

node "$RIG_BIN" daemon stop >/dev/null 2>&1 || kill "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
echo "SMOKE PASS — fresh install starts a healthy daemon; all runtime deps resolved."
