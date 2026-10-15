#!/usr/bin/env bash
# Install Warren's omp hook modules into the user-level harness directory.
#
#   scripts/install-omp-hooks.sh            # install / refresh
#   scripts/install-omp-hooks.sh --dry-run  # show what would change
#   scripts/install-omp-hooks.sh --uninstall
#
# omp discovers extension modules at <agentDir>/hooks/pre/*.ts, where agentDir
# defaults to ~/.omp/agent. A module loaded from there cannot resolve package
# imports, so every file under src/omp-hooks/ is written to be self-contained and
# is copied byte for byte — no build step, no codegen, nothing to drift.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src/omp-hooks"
DEST_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}/hooks/pre"

dry_run=0
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'install-omp-hooks: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ -d "$SRC_DIR" ] || { printf 'install-omp-hooks: no %s\n' "$SRC_DIR" >&2; exit 1; }
printf 'source: %s\ndest:   %s\n\n' "$SRC_DIR" "$DEST_DIR"

if [ "$uninstall" = 1 ]; then
  for path in "$SRC_DIR"/*.ts; do
    case "$path" in *.test.ts) continue ;; esac
    name="$(basename "$path")"
    [ -f "$DEST_DIR/$name" ] || continue
    if [ "$dry_run" = 1 ]; then printf 'would remove %s\n' "$DEST_DIR/$name"; else rm -f "$DEST_DIR/$name"; printf 'removed %s\n' "$DEST_DIR/$name"; fi
  done
  exit 0
fi

if [ "$dry_run" = 0 ]; then mkdir -p "$DEST_DIR"; fi

installed=0
for path in "$SRC_DIR"/*.ts; do
  case "$path" in *.test.ts) continue ;; esac
  name="$(basename "$path")"
  if [ "$dry_run" = 1 ]; then
    printf 'would install %s -> %s\n' "$path" "$DEST_DIR/$name"
  else
    install -m 644 "$path" "$DEST_DIR/$name"
    printf 'installed %s -> %s\n' "$path" "$DEST_DIR/$name"
  fi
  installed=$((installed + 1))
done

# A hook that imports a package silently fails to load in the harness, so the
# contract is checked here rather than discovered later.
if [ "$dry_run" = 0 ]; then
  for path in "$SRC_DIR"/*.ts; do
    case "$path" in *.test.ts) continue ;; esac
    if grep -nP '^import .* from "(?!node:|\./)' "$path"; then
      printf '\nWARNING: %s imports a package, which cannot resolve in the harness.\n' "$path" >&2
    fi
  done
fi

printf '\n%d module(s) handled. Restart the harness for discovery.\n' "$installed"
