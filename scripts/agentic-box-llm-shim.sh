#!/usr/bin/env bash
# Install the loopback model-gateway shim on an agentic box.
#
# WHY THIS EXISTS
#   The box gateway (bifrost) requires two custom request headers:
#     x-bf-vk:                     the virtual key
#     x-bf-eh-x-opencode-session:  a per-request session id
#   A burrow sandbox can only receive auth through the env names its agent
#   runtime declares. burrow's pi runtime declares ANTHROPIC_BASE_URL,
#   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and the per-provider key pair
#   OPENAI_API_KEY/OPENAI_BASE_URL. None of those can carry a custom header,
#   so a sandboxed pi (omp) cannot talk to the gateway directly.
#
#   This shim listens on loopback only, injects the two headers, and forwards
#   to the box's real gateway. A sandboxed agent then authenticates with plain
#   OPENAI_API_KEY/OPENAI_BASE_URL. No secret lands in a workspace, and burrow
#   itself is untouched.
#
# USAGE
#   scripts/agentic-box-llm-shim.sh [--dry-run] [--upstream <url>] [--ssh-user ubuntu] <host> [<host>...]
#
#   <host> is an ssh target (an ssh-config alias or an address). The upstream
#   default is chosen per box: headroom-aws serves the gateway on 8085, and the
#   other boxes reach it over the local tunnel on 18086.
#
# IDEMPOTENT: re-running replaces the shim and the unit, then restarts it.

set -euo pipefail

DRY_RUN=0
UPSTREAM=""
SSH_USER="ubuntu"
HOSTS=()

while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--upstream)
		UPSTREAM="$2"
		shift 2
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
	echo "usage: $0 [--dry-run] [--upstream <url>] <host> [<host>...]" >&2
	exit 2
fi

# The shim itself. Written to the box, not run here.
read -r -d '' SHIM_SOURCE <<'SHIM' || true
// Loopback model-gateway shim for sandboxed agents (see scripts/agentic-box-llm-shim.sh).
//
// The gateway needs custom headers that an agent's env-only auth cannot carry.
// This process adds them and forwards. It binds loopback only and keeps no state.
//
// Env:
//   LLM_UPSTREAM  base URL of the real gateway (default http://127.0.0.1:18086)
//   LLM_PORT      listen port (default 18087)
//   LLM_VK_FILE   file holding VK_OPENCODE (default /home/ubuntu/bifrost/.env)

import { readFileSync } from "node:fs";

const UPSTREAM = process.env.LLM_UPSTREAM ?? "http://127.0.0.1:18086";
const PORT = Number(process.env.LLM_PORT ?? "18087");
const VK_FILE = process.env.LLM_VK_FILE ?? "/home/ubuntu/bifrost/.env";

function readVk(): string {
	const text = readFileSync(VK_FILE, "utf8");
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		if (line.slice(0, eq).trim() !== "VK_OPENCODE") continue;
		return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
	}
	throw new Error(`VK_OPENCODE not found in ${VK_FILE}`);
}

// Read once at boot and re-read on a 401, so a rotated key needs no restart.
let vk = readVk();

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const target = `${UPSTREAM}${url.pathname}${url.search}`;
		const headers = new Headers(req.headers);
		headers.set("x-bf-vk", vk);
		headers.set("x-bf-eh-x-opencode-session", crypto.randomUUID());
		headers.delete("host");
		headers.delete("content-length");
		const init: RequestInit & { duplex?: string } = {
			method: req.method,
			headers,
			redirect: "manual",
		};
		if (req.method !== "GET" && req.method !== "HEAD") {
			init.body = req.body;
			init.duplex = "half";
		}
		let res = await fetch(target, init as RequestInit);
		if (res.status === 401) {
			try {
				vk = readVk();
				headers.set("x-bf-vk", vk);
				res = await fetch(target, init as RequestInit);
			} catch {
				// keep the original 401
			}
		}
		return new Response(res.body, { status: res.status, headers: res.headers });
	},
});

console.log(`llm-shim listening on http://127.0.0.1:${server.port} -> ${UPSTREAM}`);
SHIM

UNIT='[Unit]
Description=Loopback model-gateway shim for sandboxed agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
WorkingDirectory=/home/%s
Environment=LLM_UPSTREAM=%s
Environment=LLM_PORT=18087
ExecStart=/home/%s/.bun/bin/bun run /home/%s/llm-shim.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
'

run_remote() {
	local host="$1"
	shift
	ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_USER}@${host}" "$@"
}

for host in "${HOSTS[@]}"; do
	up="$UPSTREAM"
	if [ -z "$up" ]; then
		# headroom-aws serves the gateway itself; every other box reaches it
		# through the on-box tunnel that forwards 18086 -> headroom's 8085.
		case "$host" in
			*headroom* | *100.112.188.99*) up="http://127.0.0.1:8085" ;;
			*) up="http://127.0.0.1:18086" ;;
		esac
	fi

	echo "== $host (upstream $up)"

	if [ "$DRY_RUN" -eq 1 ]; then
		echo "   would write /home/$SSH_USER/llm-shim.ts"
		echo "   would write unit llm-shim.service (LLM_UPSTREAM=$up)"
		echo "   would enable --now llm-shim, then verify GET /v1/models through the shim"
		continue
	fi

	printf '%s' "$SHIM_SOURCE" | run_remote "$host" "cat > /home/$SSH_USER/llm-shim.ts"
	printf "$UNIT" "$SSH_USER" "$SSH_USER" "$up" "$SSH_USER" "$SSH_USER" |
		run_remote "$host" "sudo tee /etc/systemd/system/llm-shim.service >/dev/null"
	run_remote "$host" "sudo systemctl daemon-reload && sudo systemctl enable --now llm-shim >/dev/null 2>&1; sudo systemctl restart llm-shim"

	sleep 1
	code=$(run_remote "$host" "curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:18087/v1/models" || echo "000")
	echo "   llm-shim /v1/models -> $code"
	if [ "$code" != "200" ]; then
		run_remote "$host" "sudo journalctl -u llm-shim -n 8 --no-pager" || true
	fi
done

echo "done. Now let burrow forward the OpenAI pair to the sandbox:"
echo "  OPENAI_BASE_URL=http://127.0.0.1:18087/v1 and OPENAI_API_KEY=<any non-empty value>"
echo "  in /home/<user>/.config/burrow/burrow.env, then restart burrow-serve."
