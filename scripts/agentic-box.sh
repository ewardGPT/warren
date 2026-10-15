#!/usr/bin/env bash
# Turn a Debian/Ubuntu box into an agentic box: a host that runs its own
# OpenRig coordination kernel, so seats can live there and be watched from any
# other host on the tailnet.
#
#   scripts/agentic-box.sh --dry-run          # print every change, touch nothing
#   scripts/agentic-box.sh                    # apply
#   scripts/agentic-box.sh --no-ufw --no-sshd-hardening
#
# It implements upstream OpenRig's one posture profile, `product-factory-vps`
# (vendor/openrig/packages/cli/src/commands/host.ts). `rig host doctor` checks
# exactly these items, so this script and that gate agree by construction:
#
#   nonroot-openrig-user · root-ssh-disabled · key-only-ssh ·
#   ufw-default-deny-incoming · tailnet-ingress-allowed ·
#   tailscale-minimal-trust · daemon-bind-not-public ·
#   public-daemon-port-unreachable · public-ssh-unreachable-or-accepted
#
# Two deliberate choices:
#
#   * The kernel runs as a systemd unit that execs the daemon entry DIRECTLY.
#     `rig daemon start` detaches and unrefs the child, which systemd then cannot
#     supervise — the same reason Warren's own supervisor spawns the entry.
#   * The daemon binds the tailnet address, never 0.0.0.0. The posture gate
#     checks that the public port is unreachable, and it should be: the kernel
#     holds the fleet's work queue.
#
# Idempotent: re-running changes nothing that is already correct.
set -euo pipefail

DRY_RUN=0
DO_UFW=1
DO_SSHD=1
KERNEL_USER="${KERNEL_USER:-openrig}"
KERNEL_PORT="${KERNEL_PORT:-7433}"
AUTHORIZED_FROM="${AUTHORIZED_FROM:-}"   # path to a public key to install for the kernel user
BIND="${BIND:-}"                         # empty = the daemon default: loopback + the tailnet, never public

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-ufw) DO_UFW=0; shift ;;
    --no-sshd-hardening) DO_SSHD=0; shift ;;
    --user) KERNEL_USER="$2"; shift 2 ;;
    --port) KERNEL_PORT="$2"; shift 2 ;;
    --authorized-key) AUTHORIZED_FROM="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'agentic-box: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else printf '  + %s\n' "$*"; "$@"; fi
}
sh_run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] sh -c %s\n' "$1"; else printf '  + sh -c %s\n' "$1"; sh -c "$1"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }
step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" = 0 ] && SUDO="" || SUDO="sudo"
$SUDO true 2>/dev/null || { printf 'agentic-box: needs root or passwordless sudo\n' >&2; exit 1; }

# ---------------------------------------------------------------- capabilities
step "preconditions"
if ! have apt-get; then
  printf 'agentic-box: this script targets apt-based distributions; %s has no apt-get\n' "$(hostname)" >&2
  exit 1
fi
say "host $(hostname), $(nproc) cpu, $(free -m | awk '/Mem:/{print $2}') MB ram, $(df -h / | awk 'NR==2{print $4}') free on /"
say "kernel user $KERNEL_USER, port $KERNEL_PORT, ufw=$DO_UFW, sshd hardening=$DO_SSHD"

# ------------------------------------------------------------------ base tools
step "base tools (node 22, tmux, git)"
if have node && [ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -ge 22 ] 2>/dev/null; then
  say "node $(node -v) already present"
else
  run $SUDO apt-get update -qq
  run $SUDO apt-get install -y -qq curl ca-certificates gnupg
  sh_run "curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -"
  run $SUDO apt-get install -y -qq nodejs
fi
run $SUDO apt-get install -y -qq tmux git
say "node $(node -v 2>/dev/null || echo missing), tmux $(tmux -V 2>/dev/null || echo missing)"

# --------------------------------------------------------------- kernel user
step "kernel user ($KERNEL_USER, non-root, key-only)"
if id -u "$KERNEL_USER" >/dev/null 2>&1; then
  say "user $KERNEL_USER exists (uid $(id -u "$KERNEL_USER"))"
else
  run $SUDO useradd --create-home --shell /bin/bash "$KERNEL_USER"
fi
KERNEL_HOME="$(getent passwd "$KERNEL_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$KERNEL_HOME" ] || KERNEL_HOME="/home/$KERNEL_USER"
KEY_SOURCE="${AUTHORIZED_FROM:-/home/$(id -un)/.ssh/authorized_keys}"
if [ -n "$KEY_SOURCE" ] && [ -f "$KEY_SOURCE" ]; then
  sh_run "$SUDO install -d -m 0700 -o $KERNEL_USER -g $KERNEL_USER $KERNEL_HOME/.ssh && $SUDO install -m 0600 -o $KERNEL_USER -g $KERNEL_USER $KEY_SOURCE $KERNEL_HOME/.ssh/authorized_keys"
else
  say "no key source at $KEY_SOURCE — install one by hand so ssh $KERNEL_USER@$(hostname -I | awk '{print $1}') works"
fi

# Read-only sudo so `rig host doctor` can read sshd and ufw state without root.
SUDOERS_DROPIN="/etc/sudoers.d/90-${KERNEL_USER}-posture"
sh_run "printf '%s\\n' '$KERNEL_USER ALL=(root) NOPASSWD: /usr/sbin/sshd -T, /usr/bin/ufw status' > /tmp/90-posture && $SUDO install -m 0440 -o root -g root /tmp/90-posture $SUDOERS_DROPIN && $SUDO visudo -c -f $SUDOERS_DROPIN"

# ------------------------------------------------------------------ openrig cli
step "openrig cli (rig)"
if have rig; then
  say "rig $(rig --version 2>/dev/null | head -1) already present"
else
  run $SUDO npm install -g --no-fund --no-audit @openrig/cli
fi

# ------------------------------------------------------------------ tailscale
step "tailscale (tailnet ingress is how the fleet reaches this box)"
TAILNET_IP=""
if have tailscale; then
  TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  say "tailscale present, ip ${TAILNET_IP:-unknown}"
else
  say "tailscale MISSING — install it and join the tailnet, then re-run, or the host is only reachable by ssh"
fi
if have tailscale; then
  sh_run "tailscale set --ssh=false >/dev/null 2>&1 || true"
fi

# ------------------------------------------------------------------ ufw
if [ "$DO_UFW" = 1 ]; then
  step "ufw (default deny in, allow 22, allow the tailnet)"
  if ! have ufw; then
    run $SUDO apt-get install -y -qq ufw
  fi
  # Allow ssh BEFORE the default-deny flip: this session is an ssh session.
  run $SUDO ufw allow 22/tcp
  if have tailscale; then run $SUDO ufw allow in on tailscale0; fi
  run $SUDO ufw default deny incoming
  run $SUDO ufw default allow outgoing
  sh_run "$SUDO ufw --force enable"
  sh_run "$SUDO ufw status verbose | head -12"
fi

# ------------------------------------------------------------------ sshd
if [ "$DO_SSHD" = 1 ]; then
  step "sshd hardening (root login off, password auth off)"
  EFFECTIVE="$($SUDO sshd -T 2>/dev/null | tr 'A-Z' 'a-z' || true)"
  if [ -z "$EFFECTIVE" ]; then
    say "sshd -T unreadable; skipping hardening rather than guessing"
  elif $SUDO test -s /root/.ssh/authorized_keys 2>/dev/null; then
    say "root has an authorized_keys file; leaving PermitRootLogin alone."
    say "Turning it off could cut a login this box still depends on. To finish the"
    say "posture item, confirm no one logs in as root, then set it yourself:"
    say "  printf 'PermitRootLogin no\\n' | sudo tee /etc/ssh/sshd_config.d/99-agentic-hardening.conf && sudo sshd -t && sudo systemctl reload ssh"
  elif printf '%s' "$EFFECTIVE" | grep -q '^passwordauthentication yes'; then
    say "password authentication is ON. Not changing it here: disabling it can lock out"
    say "an account that has no key. Move those accounts to keys first, then re-run."
  else
    sh_run "printf '%s\\n' 'PermitRootLogin no' 'PasswordAuthentication no' 'PubkeyAuthentication yes' > /tmp/99-agentic-hardening.conf && $SUDO install -m 0644 -o root -g root /tmp/99-agentic-hardening.conf /etc/ssh/sshd_config.d/99-agentic-hardening.conf"
    # Validate before reloading: a bad config would take sshd down.
    sh_run "$SUDO sshd -t && ($SUDO systemctl reload ssh 2>/dev/null || $SUDO systemctl reload sshd 2>/dev/null || true)"
    sh_run "$SUDO sshd -T | grep -iE '^(permitrootlogin|passwordauthentication)' || true"
  fi
fi

# ------------------------------------------------------------------ kernel unit
step "kernel service (default bind: loopback + the tailnet, never public)"
BIND_HOST="$BIND"   # empty = the daemon default (loopback + tailnet)
OPENRIG_HOME="$KERNEL_HOME/.openrig"
TOKEN_FILE="$KERNEL_HOME/kernel-token"
DAEMON_ENTRY=""
if have npm; then DAEMON_ENTRY="$(npm root -g)/@openrig/cli/daemon/dist/index.js"; fi
if [ -z "$DAEMON_ENTRY" ]; then
  say "npm is not on PATH: install the base tools first (this script does that above), then re-run"
  [ "$DRY_RUN" = 1 ] || exit 1
  DAEMON_ENTRY="<npm root -g>/@openrig/cli/daemon/dist/index.js"
fi

sh_run "$SUDO install -d -m 0700 -o $KERNEL_USER -g $KERNEL_USER $OPENRIG_HOME"
sh_run "if [ ! -s $TOKEN_FILE ]; then $SUDO head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' | $SUDO tee $TOKEN_FILE >/dev/null; fi; $SUDO chmod 600 $TOKEN_FILE; $SUDO chown $KERNEL_USER:$KERNEL_USER $TOKEN_FILE"

UNIT_PATH="/etc/systemd/system/openrig-kernel.service"
if [ "$DRY_RUN" = 1 ]; then
  say "  [dry-run] write $UNIT_PATH (ExecStart: node $DAEMON_ENTRY, OPENRIG_BIND_HOST=$BIND_HOST, OPENRIG_PORT=$KERNEL_PORT)"
else
  $SUDO tee "$UNIT_PATH" >/dev/null <<UNIT
[Unit]
Description=OpenRig coordination kernel (agentic box)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$KERNEL_USER
WorkingDirectory=$OPENRIG_HOME
Environment=OPENRIG_HOME=$OPENRIG_HOME
Environment=OPENRIG_PORT=$KERNEL_PORT
# The daemon reads its bearer from OPENRIG_AUTH_BEARER_TOKEN. Read it inside
# the shell so the value never reaches the unit file or the process table.
ExecStart=/bin/sh -c 'OPENRIG_AUTH_BEARER_TOKEN=\$(cat $TOKEN_FILE) exec $(command -v node) $DAEMON_ENTRY'
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  say "  + wrote $UNIT_PATH"
fi
sh_run "$SUDO systemctl daemon-reload"
# `enable --now` would leave an already-running unit on its old definition, so
# restart explicitly: re-running this script must apply a changed unit.
sh_run "$SUDO systemctl enable openrig-kernel.service"
sh_run "$SUDO systemctl restart openrig-kernel.service"
sh_run "$SUDO sleep 3; $SUDO systemctl is-active openrig-kernel.service || true"

# ------------------------------------------------------------------ verify
step "verify"
if [ "$DRY_RUN" = 1 ]; then
  say "  [dry-run] would read $TOKEN_FILE through sudo and curl http://127.0.0.1:$KERNEL_PORT/healthz with that bearer"
  exit 0
fi
# Read the token through sudo: it is mode 600 and owned by the kernel user, and
# /healthz answers without a bearer, so an unreadable token would otherwise look
# like a pass.
TOKEN_VALUE="$($SUDO cat "$TOKEN_FILE")"
if curl -fsS -m 5 -H "Authorization: Bearer $TOKEN_VALUE" "http://127.0.0.1:$KERNEL_PORT/healthz" 2>/dev/null | head -c 200; then
  printf '\nkernel answers on loopback:%s (and on the tailnet, by the daemon default)\n' "$KERNEL_PORT"
else
  printf '\nkernel did not answer; journal: %s\n' "$(journalctl -u openrig-kernel -n 20 --no-pager 2>/dev/null | tail -5)"
  exit 1
fi

cat <<NEXT

Next, from the box you operate from (the fleet's own kernel or CLI):

  rig host add --id $(hostname) --transport http --url http://${TAILNET_IP:-<this host's tailnet ip>}:$KERNEL_PORT --bearer-file <copy of $TOKEN_FILE>
  rig host doctor $(hostname)

The token lives at $TOKEN_FILE on this box (mode 600). Treat it as the fleet's
key to this host: with it, a caller can create and close work here.
NEXT
