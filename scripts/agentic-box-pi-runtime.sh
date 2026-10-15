#!/usr/bin/env bash
# Give a burrow sandbox a usable `pi` (omp) runtime on an agentic box.
#
# TWO PROBLEMS THIS SOLVES
#   1. Visibility. burrow mounts exactly one host path per agent runtime: the
#      file `Bun.which("pi")` resolves to. A sibling binary is invisible, so a
#      wrapper that execs `~/.bun/bin/omp` dies with:
#        exec: /home/ubuntu/.bun/bin/omp: not found
#      bwrap always mounts /usr, /etc, /lib, /lib64, /bin, /sbin and /opt, so
#      this script puts the runtime there instead: bun as /usr/local/bin/bun,
#      and the omp bundle as /usr/local/lib/pi-agent.
#   2. Config. Inside the sandbox HOME is the run's worktree, and omp reads its
#      model catalog from `$HOME/.omp/agent/models.yml`. Without one, every run
#      dies with `Model "<provider>/<id>" not found`. The installed wrapper
#      builds a throwaway HOME holding a catalog that points at the box's
#      loopback gateway shim (scripts/agentic-box-llm-shim.sh).
#
#   The wrapper does not rewrite arguments. Callers choose the route through the
#   agent's frontmatter:
#     warren fleet dispatch ... --provider headroom-bifrost --model deepseek-v4-flash
#
# USAGE
#   scripts/agentic-box-pi-runtime.sh [--dry-run] [--ssh-user ubuntu] <host> [<host>...]
#
# IDEMPOTENT: re-running replaces the runtime copy and the wrapper.

set -euo pipefail

DRY_RUN=0
SSH_USER="ubuntu"
HOSTS=()

while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--ssh-user)
		SSH_USER="$2"
		shift 2
		;;
	-*) echo "unknown flag: $1" >&2; exit 2 ;;
	*)
		HOSTS+=("$1")
		shift
		;;
	esac
done

if [ "${#HOSTS[@]}" -eq 0 ]; then
	echo "usage: $0 [--dry-run] <host> [<host>...]" >&2
	exit 2
fi

# Runs on the box with `bash -s`. Kept in one string so the quoting survives ssh.
read -r -d '' REMOTE_SETUP <<'EOS' || true
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

omp_path=$(command -v omp)
bun_path=$(readlink -f "$(command -v bun)")
pkg_dir=$(dirname "$(dirname "$(readlink -f "$omp_path")")")
[ -d "$pkg_dir/dist" ] || { echo "package dir not found for $omp_path" >&2; exit 1; }
omp_version=$(grep -m1 '"version"' "$pkg_dir/package.json" | cut -d'"' -f4)

# 1. The runtime, under /usr so bwrap's system mounts carry it into the sandbox.
#    A plain copy is not enough: the bundle loses its platform support outside
#    its install tree, so install it properly into /usr/local instead.
#    bun goes to /usr/bin, which is on the PATH the sandbox composes.
sudo mkdir -p /usr/bin
sudo cp -f "$bun_path" /usr/bin/bun
sudo chmod 755 /usr/bin/bun
sudo env HOME=/root BUN_INSTALL=/usr/local PATH=/usr/bin:/bin \
	/usr/bin/bun add -g "@oh-my-pi/pi-coding-agent@$omp_version" >/dev/null 2>&1 ||
	{ echo "failed to install omp $omp_version under /usr/local" >&2; exit 1; }

# 2. The `pi` wrapper. burrow mounts this single file, and it execs the copy
#    under /usr, so nothing else has to be visible.
cat > "$HOME/.bun/bin/pi.wrapper" <<'WRAP'
#!/usr/bin/bash
# burrow spawns this as `pi`. Build a writable HOME with a model catalog that
# points at the box's loopback gateway shim, drop the pi flags omp does not
# accept, then hand over to the real omp under /usr.
# See scripts/agentic-box-pi-runtime.sh.
set -e
home=${TMPDIR:-/tmp}/pi-home-$$
mkdir -p "$home/.omp/agent"
cat > "$home/.omp/agent/models.yml" <<'YML'
providers:
  headroom-bifrost:
    baseUrl: http://127.0.0.1:18087/openai/v1
    api: openai-completions
    apiKey: llm-shim
    models:
      - id: deepseek-v4-flash
        name: Box gateway (loopback shim)
        reasoning: true
        contextWindow: 1310720
        maxTokens: 393216
YML
export HOME="$home"
# omp is a pi fork with its own flag set. burrow's pi runtime always passes
# `--offline`, which omp rejects with `unknown flag` and exit 2, so drop it.
# Every other flag burrow passes (--mode rpc, --session-dir, --no-extensions,
# --provider, --model) parses on both.
args=()
for arg in "$@"; do
	if [[ "$arg" == "--offline" ]]; then continue; fi
	args+=("$arg")
done
exec /usr/local/bin/omp "${args[@]}"
WRAP
chmod 755 "$HOME/.bun/bin/pi.wrapper"
# `pi` is a symlink to omp today; writing through it would clobber the real
# binary, so move the wrapper over it instead.
mv -f "$HOME/.bun/bin/pi.wrapper" "$HOME/.bun/bin/pi"

# 3. Prove it the way burrow calls it: clean env, fake HOME, absolute wrapper path.
cd /tmp
env -i HOME=/tmp/pi-probe PATH=/usr/local/bin:/usr/bin:/bin timeout 120 \
	"$HOME/.bun/bin/pi" -p 'Reply with the single word: ok' \
	--provider headroom-bifrost --model deepseek-v4-flash 2>&1 | tail -2
EOS

for host in "${HOSTS[@]}"; do
	echo "== $host"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "   would copy bun -> /usr/local/bin/bun and the omp bundle -> /usr/local/lib/pi-agent"
		echo "   would install /home/$SSH_USER/.bun/bin/pi as a config-bootstrapping wrapper"
		echo "   would probe it with a fake HOME and the frontmatter flags"
		continue
	fi
	printf '%s' "$REMOTE_SETUP" |
		ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_USER}@${host}" "bash -s" 2>&1 | sed 's/^/   /'
done
