#!/usr/bin/env bash
# agentic-box-burrow.sh — put burrow's HTTP API on every agentic box, so warren
# can place sandboxed runs on that box over the tailnet instead of only locally.
#
#   scripts/agentic-box-burrow.sh --dry-run        # print every change, touch nothing
#   scripts/agentic-box-burrow.sh                  # provision all three boxes
#   scripts/agentic-box-burrow.sh --box mt5-wine   # just one (repeatable)
#
# Per box, as user ubuntu (passwordless sudo):
#
#   bwrap            apt-get install bubblewrap when missing — burrow's sandbox
#                    primitive, and the one thing `burrow doctor` fails without.
#   burrow-cli       bun add -g @os-eco/burrow-cli@0.3.15, then the nested-zod
#                    workaround (below), then `burrow doctor` must pass.
#   token            openssl rand -hex 32 -> ~/.config/burrow/burrow.env, mode 600.
#                    A bind that is not loopback is refused without it.
#   unit             /etc/systemd/system/burrow-serve.service, ExecStart pinned to
#                    THIS box's tailnet address: the API holds the box's work
#                    queue, so it must never be reachable from the public side.
#
# On the workstation it then saves each token to ~/.warren/tokens/burrow-<id>.token
# (mode 600) and writes the fleet file warren reads:
# ~/warren-data/kernel/fleet.yaml.
#
# The nested-zod workaround (why it exists): burrow-cli 0.3.15 imports zod 4
# (`z.registry`), but only one zod can sit at the global root — and that root's
# zod is v3, because the other global CLIs need it (omp -> puppeteer-core ->
# chromium-bidi wants ^3.24.1; the hoisted drizzle-orm wants ^3.20.2). So burrow
# gets a zod 4 nested INSIDE its own package dir and the root keeps zod 3. Left
# alone, the CLI dies at import with `TypeError: z.registry is not a function`.
#
# The subtlety: `bun add -g @os-eco/burrow-cli` does not know that rule — it
# hoists burrow's zod 4 straight over the global zod 3. So the script records the
# root zod BEFORE installing and puts that version back afterwards (bun keeps a
# direct pin at the root, so it stays put). Both versions then live at once, each
# where its consumer resolves it.
#
# Idempotent: re-running changes nothing that is already correct. The token is
# generated once and reused; the unit is rewritten (deterministic) and the
# service restarted so a changed unit actually takes effect.
#
# Human-readable progress goes to stderr; only machine-readable `KEY=value` lines
# go to stdout, which is how the token crosses back without ever being printed.
set -euo pipefail

DRY_RUN=0
PORT="${PORT:-7455}"
BURROW_CLI_VERSION="0.3.15"
# The zod 3 the fleet's global toolchain is pinned to. `bun add -g burrow-cli`
# hoists burrow's zod 4 over it; the script puts this back at the global root.
ZOD3_VERSION="${ZOD3_VERSION:-3.25.76}"
TOKEN_DIR="${TOKEN_DIR:-$HOME/.warren/tokens}"
FLEET_YAML="${FLEET_YAML:-$HOME/warren-data/kernel/fleet.yaml}"
SSH_OPTS=(-o ConnectTimeout=15 -o BatchMode=yes)

# id | ssh target | tailnet ip (the ip is re-read on the box; this is the default
# and the value fleet.yaml records)
BOXES=(
  "headroom-aws|headroom-aws|100.112.188.99"
  "nexus-gate|nexus-gate|100.94.199.106"
  "mt5-wine|mt5-wine|100.111.105.36"
)

WANTED=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --box) WANTED+=("$2"); shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'agentic-box-burrow: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*" >&2; }

# The programme that runs on the box, verbatim. `bash -s -- <bind-ip> <port>`
# feeds it: stdin is the script, "$@" is the parameters.
remote_program() {
  cat <<'REMOTE'
set -euo pipefail
BIND_IP="$1"
PORT="$2"
BURROW_CLI_VERSION="$3"
ZOD3_VERSION="$4"
say() { printf '  %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*" >&2; }
fail() { printf 'agentic-box-burrow: FAIL: %s\n' "$*" >&2; exit 1; }
# burrow's bin is `#!/usr/bin/env bun`, and a non-interactive ssh shell does not
# have ~/.bun/bin on PATH.
export PATH="$HOME/.bun/bin:$PATH"

[ "$(id -un)" = ubuntu ] || fail "expected user ubuntu, got $(id -un)"
sudo -n true 2>/dev/null || fail "user ubuntu needs passwordless sudo"

step "bubblewrap (burrow's sandbox primitive)"
if command -v bwrap >/dev/null 2>&1; then
  say "already installed: $(bwrap --version)"
else
  sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap
fi
command -v bwrap >/dev/null 2>&1 || fail "bwrap still missing after install"
say "bwrap: $(bwrap --version)"

step "apparmor: let bwrap create a user namespace"
# Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, so bwrap
# cannot build a sandbox and every run dies with `bwrap: setting up uid map:
# Permission denied`. A profile scoped to bwrap grants the namespace to bwrap
# alone; the alternative, relaxing the sysctl, would grant it to every process.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
PROFILE
  sudo apparmor_parser -r /etc/apparmor.d/bwrap
  say "installed /etc/apparmor.d/bwrap"
else
  say "unprivileged user namespaces are not restricted here"
fi
# Prove the sandbox builds before anything is placed on it.
if bwrap --unshare-all --uid 1000 --gid 1000 --dev-bind / / true 2>/tmp/bwrap-probe.err; then
  say "sandbox probe: ok"
else
  fail "sandbox probe failed: $(cat /tmp/bwrap-probe.err)"
fi

step "burrow cli $BURROW_CLI_VERSION"
BUN="$HOME/.bun/bin/bun"
GLOBAL_NM="$HOME/.bun/install/global/node_modules"
PKG_DIR="$GLOBAL_NM/@os-eco/burrow-cli"
global_zod_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$GLOBAL_NM/zod/package.json" 2>/dev/null | head -1 || true; }
nested_zod_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PKG_DIR/node_modules/zod/package.json" 2>/dev/null | head -1 || true; }
[ -x "$BUN" ] || fail "no bun at $BUN"
# Record the zod the box already hoists at the global root, BEFORE bun touches it.
before_zod="$(global_zod_version)"
installed_ver="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PKG_DIR/package.json" 2>/dev/null | head -1 || true)"
if [ "$installed_ver" = "$BURROW_CLI_VERSION" ]; then
  say "burrow-cli $installed_ver already installed"
else
  say "installing (installed: ${installed_ver:-none})"
  "$BUN" add -g "@os-eco/burrow-cli@$BURROW_CLI_VERSION" >&2
fi
[ -d "$PKG_DIR" ] || fail "burrow-cli package dir missing after install"

# burrow-cli wants zod ^4.4.3, so `bun add -g` hoists zod 4 over the global root
# and evicts the zod 3 the box's other globals need (omp -> puppeteer-core ->
# chromium-bidi wants ^3.24.1; the hoisted drizzle-orm wants ^3.20.2). Put the v3
# back at the root: burrow resolves the zod 4 nested in its own package dir, so
# both versions live at once. This is the one place the global zod may be
# touched, and only to restore the version that was there.
after_zod="$(global_zod_version)"
after_major="${after_zod%%.*}"
if [ -n "$after_major" ] && [ "$after_major" -ge 4 ]; then
  restore="$ZOD3_VERSION"
  before_major="${before_zod%%.*}"
  if [ -n "$before_major" ] && [ "$before_major" -lt 4 ] 2>/dev/null; then restore="$before_zod"; fi
  say "bun hoisted zod $after_zod over the global zod; restoring $restore at the root"
  "$BUN" add -g "zod@$restore" >&2
  [ "$(global_zod_version)" = "$restore" ] || fail "could not restore the global zod to $restore"
else
  say "global zod is ${after_zod:-absent} (left alone)"
fi

# Nested zod: only the copy INSIDE the package dir, never the hoisted global v3.
zod_ver="$(nested_zod_version)"
zod_major="${zod_ver%%.*}"
if [ -n "$zod_major" ] && [ "$zod_major" -ge 4 ]; then
  say "nested zod $zod_ver present"
else
  say "installing nested zod 4 inside $PKG_DIR (found: ${zod_ver:-none})"
  ( cd "$PKG_DIR" && "$BUN" add zod@^4.4.3 >&2 )
fi
BURROW="$HOME/.bun/bin/burrow"
[ -x "$BURROW" ] || fail "no burrow at $BURROW"
"$BURROW" --version >/dev/null || fail "burrow cannot start (import error?)"
say "burrow $("$BURROW" --version 2>/dev/null || true)"

# The layering this box must end on, or the next `bun add -g` will hoist zod 4
# again and quietly take omp's browser deps down with it.
final_zod="$(global_zod_version)"
final_nested="$(nested_zod_version)"
[ "${final_zod%%.*}" -lt 4 ] 2>/dev/null || fail "global zod is $final_zod, expected v3"
[ "${final_nested%%.*}" -ge 4 ] 2>/dev/null || fail "nested zod is $final_nested, expected v4"
say "zod: global $final_zod, nested $final_nested"

step "burrow doctor"
doctor_out="$("$BURROW" doctor 2>&1 || true)"
printf '%s\n' "$doctor_out" | sed 's/^/    /' >&2
printf '%s\n' "$doctor_out" | grep -q 'All checks passed' || fail "burrow doctor did not pass"
doctor_last="$(printf '%s\n' "$doctor_out" | grep -v '^[[:space:]]*$' | tail -1)"

step "api token ($HOME/.config/burrow/burrow.env)"
ENV_DIR="$HOME/.config/burrow"
ENV_FILE="$ENV_DIR/burrow.env"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [ -s "$ENV_FILE" ] && grep -qE '^BURROW_API_TOKEN=[0-9a-f]{64}$' "$ENV_FILE"; then
  say "reusing the token already in $ENV_FILE"
else
  umask 077
  printf 'BURROW_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  say "generated a new token"
fi
chmod 600 "$ENV_FILE"
say "token file mode $(stat -c '%a' "$ENV_FILE")"
TOKEN="$(sed -n 's/^BURROW_API_TOKEN=//p' "$ENV_FILE" | head -1)"
[ "${#TOKEN}" = 64 ] || fail "token in $ENV_FILE is malformed"

step "systemd unit (bind $BIND_IP:$PORT)"
UNIT=/etc/systemd/system/burrow-serve.service
sudo tee "$UNIT" >/dev/null <<UNIT_EOF
[Unit]
Description=burrow HTTP API (sandboxed agent runs over the tailnet)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
Environment=PATH=/home/ubuntu/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/home/ubuntu/.config/burrow/burrow.env
ExecStart=/home/ubuntu/.bun/bin/burrow serve --bind-host $BIND_IP --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT_EOF
say "wrote $UNIT"

step "service"
sudo systemctl daemon-reload
sudo systemctl enable burrow-serve.service >/dev/null
# restart, not `enable --now`: an already-running unit would keep its old
# definition, and re-running this script must apply a changed unit or token.
sudo systemctl restart burrow-serve.service
sleep 3
active="$(systemctl is-active burrow-serve.service || true)"
say "systemctl is-active: $active"
[ "$active" = "active" ] || { sudo journalctl -u burrow-serve.service -n 20 --no-pager >&2 || true; fail "burrow-serve is $active"; }

listen="$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ')"
say "listening: ${listen:-nothing on port $PORT}"
printf '%s\n' "$listen" | grep -q "$BIND_IP:$PORT" || fail "not listening on $BIND_IP:$PORT"

printf 'BURROW_DOCTOR=%s\n' "$doctor_last"
printf 'BURROW_ACTIVE=%s\n' "$active"
printf 'BURROW_LISTEN=%s\n' "$listen"
printf 'BURROW_GLOBAL_ZOD=%s\n' "$final_zod"
printf 'BURROW_NESTED_ZOD=%s\n' "$final_nested"
printf 'BURROW_TOKEN=%s\n' "$TOKEN"
REMOTE
}

selected() {
  [ "${#WANTED[@]}" -eq 0 ] && return 0
  local id="$1" w
  for w in "${WANTED[@]}"; do [ "$w" = "$id" ] && return 0; done
  return 1
}

step "agentic boxes: burrow serve (port $PORT)"
say "dry-run=$DRY_RUN, boxes: ${WANTED[*]:-all}"

[ "$DRY_RUN" = 1 ] || mkdir -p "$TOKEN_DIR"

for entry in "${BOXES[@]}"; do
  IFS='|' read -r id ssh_target declared_ip <<<"$entry"
  selected "$id" || continue

  step "$id ($ssh_target, tailnet $declared_ip)"
  if [ "$DRY_RUN" = 1 ]; then
    say "  (would read the live tailnet address with: ssh $ssh_target tailscale ip -4)"
    ip="$declared_ip"
  else
    ip="$(ssh "${SSH_OPTS[@]}" "$ssh_target" 'tailscale ip -4 | head -1' 2>/dev/null | tr -d '\r' || true)"
    [ -n "$ip" ] || { say "  no tailnet address yet; falling back to $declared_ip"; ip="$declared_ip"; }
    [ "$ip" = "$declared_ip" ] || say "  tailnet address is $ip, not the recorded $declared_ip"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] ssh %s bash -s -- %s %s %s %s <<REMOTE\n' "$ssh_target" "$ip" "$PORT" "$BURROW_CLI_VERSION" "$ZOD3_VERSION" >&2
    remote_program | sed 's/^/  | /' >&2
    printf '  [dry-run] %s <<EOF (mode 600, token read back over ssh, never printed)\n' "$TOKEN_DIR/burrow-$id.token" >&2
    continue
  fi

  out="$(remote_program | ssh "${SSH_OPTS[@]}" "$ssh_target" bash -s -- "$ip" "$PORT" "$BURROW_CLI_VERSION" "$ZOD3_VERSION")"
  val() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  token="$(val BURROW_TOKEN)"
  [ "${#token}" = 64 ] || { say "  no token came back from $id"; exit 1; }

  # Save it without ever printing it.
  umask 077
  printf '%s' "$token" > "$TOKEN_DIR/burrow-$id.token"
  chmod 600 "$TOKEN_DIR/burrow-$id.token"
  say "  saved $TOKEN_DIR/burrow-$id.token (mode $(stat -c '%a' "$TOKEN_DIR/burrow-$id.token"))"
  say "  zod: global $(val BURROW_GLOBAL_ZOD), nested $(val BURROW_NESTED_ZOD)"

  step "$id: verify from the workstation over the tailnet"
  code() {
    printf '  %s -> %s\n' "$2" \
      "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Authorization: Bearer $token" "$1")" >&2
  }
  # burrow 0.3.15 has no /readyz route; /healthz (auth-exempt) is its readiness
  # probe and /burrows is the minimal authenticated call. All three are probed so
  # the report shows exactly what answers.
  code "http://$ip:$PORT/readyz" "/readyz"
  code "http://$ip:$PORT/healthz" "/healthz"
  code "http://$ip:$PORT/burrows" "/burrows (authenticated)"

  # The gate is the live, authenticated API — /readyz is informational because
  # this burrow build does not serve it.
  hcode="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$ip:$PORT/healthz")"
  bcode="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Authorization: Bearer $token" "http://$ip:$PORT/burrows")"
  if [ "$hcode" != "200" ] || [ "$bcode" != "200" ]; then
    say "  $id failed the tailnet check (healthz=$hcode burrows=$bcode)"
    exit 1
  fi
  printf 'BURROW_%s_OK=healthz:%s burrows:%s\n' "$id" "$hcode" "$bcode" >&2
done

step "fleet file ($FLEET_YAML)"
fleet_body() {
  printf 'boxes:\n'
  local entry id ssh_target ip
  for entry in "${BOXES[@]}"; do
    IFS='|' read -r id ssh_target ip <<<"$entry"
    printf -- '- id: %s\n  url: http://%s:%s\n  token_file: %s/burrow-%s.token\n' \
      "$id" "$ip" "$PORT" "$TOKEN_DIR" "$id"
  done
}
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] write %s:\n' "$FLEET_YAML" >&2
  fleet_body | sed 's/^/  | /' >&2
else
  mkdir -p "$(dirname "$FLEET_YAML")"
  fleet_body > "$FLEET_YAML"
  say "  wrote $FLEET_YAML"
  say ""
  sed 's/^/  /' "$FLEET_YAML" >&2
fi

step "done"
say "tokens: $TOKEN_DIR/burrow-{headroom-aws,nexus-gate,mt5-wine}.token (mode 600)"
say "fleet:  $FLEET_YAML"
