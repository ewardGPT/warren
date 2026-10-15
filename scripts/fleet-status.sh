#!/usr/bin/env bash
# fleet-status.sh — one screen for every kernel host the fleet knows.
#
#   scripts/fleet-status.sh            # one pass
#   scripts/fleet-status.sh --watch    # refresh every 10s (Ctrl-C to stop)
#   scripts/fleet-status.sh --rig boxdemo   # only rigs with this name
#
# Why a script and not the TUI: the kernel's TUI reads one daemon at a time
# (OPENRIG_URL), so fleet-wide means either an ssh per box or this loop. This
# reads the host registry once and asks each reachable host what it is running,
# which is enough to answer "what is going on" without opening five terminals.
#
# Needs the fleet kernel's home so `rig host list` resolves the registry:
#   OPENRIG_HOME=/home/ubuntu/warren-data/kernel scripts/fleet-status.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENRIG_HOME="${OPENRIG_HOME:-$HOME/.openrig}"
export OPENRIG_HOME

# Prefer the vendored build: it is the one the fleet kernel runs.
RIG="${RIG:-}"
if [ -z "$RIG" ] && [ -f "$REPO_ROOT/vendor/openrig/packages/cli/dist/bin-wrapper.js" ]; then
  RIG="node $REPO_ROOT/vendor/openrig/packages/cli/dist/bin-wrapper.js"
fi
if [ -z "$RIG" ]; then
  command -v rig >/dev/null 2>&1 || { printf 'fleet-status: no rig build found and no rig on PATH\n' >&2; exit 1; }
  RIG="rig"
fi

WATCH=0
RIG_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --rig) RIG_FILTER="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'fleet-status: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

render() {
  printf '\n\033[1mfleet — %s\033[0m  (registry %s)\n' "$(date -u +%H:%M:%SZ)" "$OPENRIG_HOME/hosts.yaml"
  printf '%s\n' "───────────────────────────────────────────────────────────────────────────────"

  local json
  json="$($RIG host list --json 2>/dev/null || echo '[]')"
  # http entries are the workable ones: an ssh entry is a posture view, not a daemon.
  local hosts
  hosts="$(printf '%s' "$json" | python3 -c '
import json,sys
try: rows = json.load(sys.stdin)
except Exception: rows = []
rows = rows if isinstance(rows, list) else rows.get("hosts", [])
for r in rows:
    if r.get("transport") == "http":
        print(r.get("id",""), r.get("url",""), r.get("status",""))
' 2>/dev/null || true)"

  if [ -z "$hosts" ]; then
    printf 'no http hosts registered — add one with: rig host add --id <id> --transport http --url <url> --bearer-file <path>\n'
    return
  fi

  while read -r id url status; do
    [ -n "$id" ] || continue
    local detail
    detail="$($RIG ps --host "$id" --nodes -A 2>/dev/null | tail -n +2 | grep -v '^$' || true)"
    local health
    health="$(curl -fsS -m 5 "${url}/healthz" 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
sweep = (d.get("stuckSweep") or {}).get("lastOutcome")
loop = (d.get("eventLoop") or {}).get("healthy")
print("%s | sweep %s | loop %s | %s" % (d.get("status"), sweep, "ok" if loop else "lagging", d.get("semver")))
' 2>/dev/null || echo 'healthz unreachable')"

    printf '\n\033[1m%-18s\033[0m %-34s %s\n' "$id" "$url" "$health"
    if [ -n "$detail" ]; then
      printf '%s\n' "$detail" | sed 's/^/  /'
    else
      printf '  (no rigs)\n'
    fi
  done <<< "$hosts"
  printf '\n%s\n' "ssh entries are posture-only; run 'rig host doctor <id> --posture product-factory-vps' for those."
  printf '%s\n\n' "TUI on one host:  ssh -t <ssh-alias> 'sudo -u openrig -H env OPENRIG_HOME=/home/openrig/.openrig rig tui'"
}

if [ "$WATCH" = 1 ]; then
  # `clear` needs a TERM; do not let a missing one kill the loop under `set -e`.
  while true; do clear 2>/dev/null || true; render; sleep 10; done
else
  render
fi
