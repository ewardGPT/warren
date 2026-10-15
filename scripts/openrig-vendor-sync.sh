#!/usr/bin/env bash
# Refresh vendor/openrig from upstream, mechanically and auditable.
#
#   scripts/openrig-vendor-sync.sh              # track upstream main
#   scripts/openrig-vendor-sync.sh --to <sha>   # pin to one commit
#   scripts/openrig-vendor-sync.sh --check      # verify the recorded sha only
#
# The vendored tree is expected to be byte-identical to upstream. Local edits
# are allowed but must be listed in vendor/openrig/UPSTREAM.md (Apache-2.0
# §4(b) change notices); this script prints them before replacing anything so
# they cannot be lost silently.
#
# Requires: git, and (for the upstream suite) Node 22/24 + npm.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="${OPENRIG_UPSTREAM_URL:-https://github.com/mvschwarz/openrig.git}"
VENDOR_DIR="$REPO_ROOT/vendor/openrig"
UPSTREAM_MD="$VENDOR_DIR/UPSTREAM.md"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

die() { printf 'openrig-vendor-sync: %s\n' "$*" >&2; exit 1; }

recorded_sha() {
  sed -n 's/^| Snapshot sha | `\([0-9a-f]\{7,\}\)` |$/\1/p' "$UPSTREAM_MD" | head -n1
}

target=""
check_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) target="${2:?--to needs a commit}"; shift 2 ;;
    --check) check_only=1; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -d "$VENDOR_DIR" ] || die "no $VENDOR_DIR — nothing to sync"
[ -f "$UPSTREAM_MD" ] || die "no $UPSTREAM_MD — the provenance record is required"
current="$(recorded_sha)"
[ -n "$current" ] || die "could not read the recorded sha from UPSTREAM.md"

if [ "$check_only" = 1 ]; then
  printf 'recorded sha: %s\n' "$current"
  # The recorded file list must still match what upstream has at that sha.
  git -C "$WORK_DIR" init -q
  git -C "$WORK_DIR" remote add origin "$UPSTREAM_URL"
  git -C "$WORK_DIR" fetch -q --depth 1 origin "$current"
  diff -rq --exclude=.git "$WORK_DIR" "$VENDOR_DIR" \
    || die "vendor/openrig differs from upstream $current (see the list above)"
  printf 'ok: vendor/openrig matches upstream %s\n' "$current"
  exit 0
fi

# Local modifications are the only thing this run can destroy.
printf 'recorded sha: %s\n' "$current"
printf '%s\n' "files modified under vendor/openrig since import (tracked by git, not this script):"
git -C "$REPO_ROOT" status --porcelain -- vendor/openrig | sed 's/^/  /' || true

printf 'fetching %s ...\n' "${target:-origin main}"
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" remote add origin "$UPSTREAM_URL"
if [ -n "$target" ]; then
  git -C "$WORK_DIR" fetch -q --depth 1 origin "$target"
else
  git -C "$WORK_DIR" fetch -q --depth 1 origin main
fi
new="$(git -C "$WORK_DIR" rev-parse FETCH_HEAD)"
[ "$new" != "$current" ] || printf 'already at %s — nothing to do\n' "$new"

printf '\nupstream log %s..%s (depth 1 fetch reports the tip only):\n' "$current" "$new"
git -C "$WORK_DIR" log -1 --format='  %h %ad %s' --date=short FETCH_HEAD

printf '\nreplacing %s ...\n' "$VENDOR_DIR"
rsync -a --delete --exclude '.git' --exclude 'node_modules' "$WORK_DIR"/ "$VENDOR_DIR"/

# Keep the provenance table honest.
python3 - "$UPSTREAM_MD" "$new" "$(git -C "$WORK_DIR" log -1 --format=%ad --date=short FETCH_HEAD)" "$(git -C "$WORK_DIR" log -1 --format=%s FETCH_HEAD)" <<'PY'
import re, sys
path, sha, date, subject = sys.argv[1:5]
text = open(path).read()
text = re.sub(r'(\| Snapshot sha \| `)[0-9a-f]+(` \|)', r'\g<1>' + sha + r'\g<2>', text)
text = re.sub(r'(\| Snapshot date \| `?)[0-9-]+(`? \|)', r'\g<1>' + date + r'\g<2>', text)
text = re.sub(r'(\| Upstream commit subject \| `)(.*)(` \|)', r'\g<1>' + subject + r'\g<2>', text)
open(path, 'w').write(text)
print(f'UPSTREAM.md updated to {sha} ({date})')
PY

printf '\nupstream repository checks (own toolchain):\n'
if command -v npm >/dev/null 2>&1; then
  ( cd "$VENDOR_DIR" && npm ci --no-fund --no-audit >/dev/null 2>&1 && npm run test:repo )
else
  printf '  npm not found — skipped. Run: cd vendor/openrig && npm ci && npm run test:repo\n'
fi

printf '\nstamping build identity with the upstream commit:\n'
if [ -x "$REPO_ROOT/scripts/openrig-vendor-stamp.sh" ]; then
  "$REPO_ROOT/scripts/openrig-vendor-stamp.sh" || printf '  stamp failed — run it again after a successful build\n' >&2
fi

printf '\nnext: review `git status -- vendor/openrig`, record any local edit in UPSTREAM.md,\n'
printf 'then run our own suite: bun test\n'
