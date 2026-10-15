#!/usr/bin/env bun
/**
 * fleet-tui.ts — one live screen for every kernel host in the registry.
 *
 * Why this exists: the kernel's own TUI reads ONE daemon (`OPENRIG_URL`), and
 * `hosts.yaml` is a client-side connection registry the daemon never merges. So
 * "what is going on across the fleet" has no single view upstream. This renders
 * one: every reachable http host with its kernel health, its rigs and its seats,
 * refreshed on a timer, with the keyboard doing the navigation.
 *
 *   OPENRIG_HOME=/home/ubuntu/warren-data/kernel bun scripts/fleet-tui.ts
 *   bun scripts/fleet-tui.ts --once     # one frame, then exit (no TTY needed)
 *   bun scripts/fleet-tui.ts --rig boxdemo
 *
 * Keys:  j/↓ next host · k/↑ previous host · r refresh now · q quit
 *
 * Read-only by construction: it fetches `/healthz` and runs `rig ps --json`. It
 * never writes to a host.
 */

import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RIG = process.env.FLEET_RIG ?? `${REPO_ROOT}/vendor/openrig/packages/cli/dist/bin-wrapper.js`;
const RIG_CMD = RIG.endsWith(".js") ? ["node", RIG] : [RIG];
const REFRESH_MS = Number(process.env.FLEET_REFRESH_MS ?? 5000);

/**
 * Narrow an untrusted value to a plain record. Every field read in this file goes
 * through a guard: the registry and the daemon answers are outside data, so a
 * shape is proven before it is used, never asserted inline.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export interface Hostry {
	id: string;
	url: string;
	status: string;
	bearerFile?: string;
	health: string;
	rigs: Seat[];
	error?: string;
}

export interface Seat {
	rig: string;
	session: string;
	runtime: string;
	lifecycle: string;
	activity: string;
	work: boolean;
}

export interface FleetFrame {
	at: string;
	hosts: Hostry[];
	selected: number;
	rigFilter?: string;
}

/**
 * Read the registry. Exported because the parsing is the part worth testing: the
 * CLI prints a bare array, and an unreachable daemon must not look like an empty
 * fleet.
 */
export function parseRegistry(
	stdout: string,
): { id: string; url: string; bearerFile?: string; status: string }[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const wrapped = asRecord(parsed)?.hosts;
	const rows = Array.isArray(parsed) ? parsed : Array.isArray(wrapped) ? wrapped : [];
	const out: { id: string; url: string; bearerFile?: string; status: string }[] = [];
	for (const row of rows) {
		const rec = asRecord(row);
		if (rec === undefined) continue;
		if (rec.transport !== "http" || typeof rec.url !== "string" || typeof rec.id !== "string")
			continue;
		out.push({
			id: rec.id,
			url: rec.url,
			status: typeof rec.status === "string" ? rec.status : "unknown",
			...(typeof rec.bearer_file === "string" ? { bearerFile: rec.bearer_file } : {}),
		});
	}
	return out;
}

/** Map the seat rows from `rig ps --nodes --json` onto what the table shows. */
export function parseSeats(stdout: string): Seat[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seats: Seat[] = [];
	for (const row of parsed) {
		const rec = asRecord(row);
		if (rec === undefined) continue;
		const activity = asRecord(rec.agentActivity);
		seats.push({
			rig: String(rec.rigName ?? "?"),
			session: String(rec.canonicalSessionName ?? rec.logicalId ?? "?"),
			runtime: String(rec.runtime ?? "?"),
			lifecycle: String(rec.lifecycleState ?? rec.sessionStatus ?? "?"),
			activity: typeof activity?.state === "string" ? activity.state : "unknown",
			work: rec.hasAssignedWork === true || Number(rec.assignedWorkCount ?? 0) > 0,
		});
	}
	return seats;
}

function rig(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const run = spawnSync(RIG_CMD[0] as string, [...RIG_CMD.slice(1), ...args], {
		encoding: "utf8",
		env: process.env,
		timeout: 20_000,
	});
	return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

export function readRegistry(): { id: string; url: string; bearerFile?: string; status: string }[] {
	const res = rig(["host", "list", "--json"]);
	return res.ok ? parseRegistry(res.stdout) : [];
}

/** Every registry row, whatever its transport, for the ssh jump and its target. */
/** One line of kernel health, or the reason we could not read it. Never throws. */
export async function readHealth(url: string): Promise<string> {
	try {
		const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(4000) });
		const health = asRecord(await res.json());
		if (health === undefined) return "unreachable: healthz was not a JSON object";
		const sweep = asRecord(health.stuckSweep) ?? {};
		const loop = asRecord(health.eventLoop) ?? {};
		const state = health.status ?? "?";
		const semver = health.semver ?? "?";
		return `${state} · sweep ${sweep.lastOutcome ?? "?"} · loop ${loop.healthy === true ? "ok" : "lagging"} · ${semver}`;
	} catch (error) {
		return `unreachable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export async function collect(rigFilter?: string): Promise<Hostry[]> {
	const hosts = readRegistry();
	const out: Hostry[] = [];
	for (const host of hosts) {
		const entry: Hostry = { ...host, health: "…", rigs: [] };
		entry.health = await readHealth(host.url);
		if (entry.health.startsWith("unreachable")) {
			out.push(entry);
			continue;
		}
		const psArgs = ["ps", "--host", host.id, "--nodes", "-A", "--json"];
		if (rigFilter !== undefined) psArgs.push("--rig", rigFilter);
		const ps = rig(psArgs);
		entry.rigs = ps.ok ? parseSeats(ps.stdout) : [];
		if (!ps.ok) entry.error = ps.stderr.trim().split("\n").slice(-1)[0] ?? "ps failed";
		out.push(entry);
	}
	return out;
}

/** The detail pane for one host: identity, health, then its seats. */
function rightPane(host: Hostry | undefined): string[] {
	if (host === undefined) {
		return [
			`${DIM}no http hosts registered${RESET}`,
			`${DIM}add one: rig host add --id <id> --transport http --url <url> --bearer-file <path>${RESET}`,
		];
	}
	const lines = [
		`${BOLD}${host.id}${RESET}  ${DIM}${host.url}${RESET}`,
		`${dot(host.health)} ${host.health}`,
	];
	if (host.error !== undefined) lines.push(`${YELLOW}${host.error}${RESET}`);
	lines.push("");
	if (host.rigs.length === 0) {
		lines.push(`${DIM}no seats${RESET}`);
		return lines;
	}
	lines.push(`${DIM}RIG           SEAT                     RUNTIME   LIFECYCLE   ACTIVITY${RESET}`);
	for (const seat of host.rigs) {
		const work = seat.work ? `  ${YELLOW}work${RESET}` : "";
		lines.push(
			`${pad(seat.rig, 14)}${pad(seat.session, 26)}${pad(seat.runtime, 10)}${pad(seat.lifecycle, 11)}${seat.activity}${work}`,
		);
	}
	return lines;
}

const ESC = "\x1b[";
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE = `${ESC}?25l`;
const SHOW = `${ESC}?25h`;
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;

function dot(health: string): string {
	if (health.startsWith("ok")) return `${GREEN}●${RESET}`;
	if (health.startsWith("…")) return `${DIM}○${RESET}`;
	return `${RED}●${RESET}`;
}

// Built from the escape code itself: a literal control character in a regex
// is both unreadable and flagged by the linter.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");

/** Visible length: escape sequences take no columns. */
function visibleLength(text: string): number {
	return text.replace(ANSI, "").length;
}

/** Pad or clip to a column budget, counting only visible characters. */
function pad(text: string, width: number): string {
	if (visibleLength(text) > width) return clip(text, width);
	return text + " ".repeat(width - visibleLength(text));
}

/** Clip to a column budget without cutting an escape sequence in half. */
function clip(text: string, width: number): string {
	let out = "";
	let visible = 0;
	for (let i = 0; i < text.length; ) {
		const match = ANSI.exec(text.slice(i));
		if (match !== null && match.index === 0) {
			out += match[0];
			i += match[0].length;
			continue;
		}
		if (visible >= width) break;
		out += text[i];
		visible += 1;
		i += 1;
	}
	return out + RESET;
}

/** Render one frame as text lines. Pure so the layout is testable and reusable. */
export function frameLines(frame: FleetFrame, width: number, height: number): string[] {
	const leftWidth = Math.min(30, Math.max(22, Math.floor(width / 4)));
	const rightWidth = width - leftWidth - 3;
	const lines: string[] = [];
	const healthy = frame.hosts.filter((h) => h.health.startsWith("ok")).length;
	lines.push(
		`${BOLD}fleet${RESET} ${DIM}${frame.at}${RESET}  ${healthy}/${frame.hosts.length} kernels ok` +
			(frame.rigFilter === undefined ? "" : `  ${DIM}rig=${frame.rigFilter}${RESET}`),
	);
	lines.push(`${DIM}${"─".repeat(Math.max(0, width - 1))}${RESET}`);

	const right = rightPane(frame.hosts[frame.selected]);

	const hostRows = frame.hosts.map((host, index) => {
		const marker = index === frame.selected ? `${BOLD}▶${RESET}` : " ";
		const idWidth = Math.max(4, leftWidth - 4);
		const id = host.id.length > idWidth ? host.id.slice(0, idWidth) : host.id.padEnd(idWidth);
		return `${marker} ${dot(host.health)} ${id}`;
	});

	const body = Math.max(hostRows.length, right.length);
	for (let i = 0; i < Math.min(body, height - 4); i += 1) {
		lines.push(
			`${pad(hostRows[i] ?? "", leftWidth)} ${DIM}│${RESET} ${(right[i] ?? "").slice(0, rightWidth)}`,
		);
	}
	lines.push(`${DIM}${"─".repeat(Math.max(0, width - 1))}${RESET}`);
	lines.push(
		`${DIM}j/k move · r refresh · q quit   (per-host TUI: scripts/fleet-status.sh prints the ssh command)${RESET}`,
	);
	return lines;
}

function sshEntryFor(id: string, hosts: { id: string }[]): string | undefined {
	const direct = hosts.find((h) => h.id === `${id}-ssh` || h.id === id.replace(/-http$/, ""));
	return direct?.id;
}

export type KeyAction =
	| { kind: "quit" }
	| { kind: "refresh" }
	| { kind: "move"; to: number }
	| { kind: "ignore" };

/**
 * What one keystroke means. Pure, so the keymap is testable rather than buried
 * in the input loop.
 */
export function keyAction(key: string, selected: number, count: number): KeyAction {
	if (key === "q" || key === "\u0003") return { kind: "quit" };
	if (key === "j" || key === "\u001b[B")
		return { kind: "move", to: Math.min(Math.max(0, count - 1), selected + 1) };
	if (key === "k" || key === "\u001b[A") return { kind: "move", to: Math.max(0, selected - 1) };
	if (key === "r") return { kind: "refresh" };
	return { kind: "ignore" };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const once = argv.includes("--once");
	const rigIndex = argv.indexOf("--rig");
	const rigFilter = rigIndex === -1 ? undefined : argv[rigIndex + 1];

	let hosts = await collect(rigFilter);
	let selected = 0;
	const width = process.stdout.columns ?? 120;
	const height = process.stdout.rows ?? 40;

	if (once) {
		const text = frameLines(
			{ at: new Date().toISOString().slice(11, 19), hosts, selected, rigFilter },
			width,
			height,
		);
		process.stdout.write(`${text.join("\n")}\n`);
		return;
	}
	if (!process.stdout.isTTY) {
		process.stderr.write("fleet-tui: not a TTY; use --once for a single frame\n");
		process.exit(1);
	}

	const draw = (): void => {
		const frame = frameLines(
			{ at: new Date().toISOString().slice(11, 19), hosts, selected, rigFilter },
			width,
			height,
		);
		process.stdout.write(`${CLEAR}${frame.join("\n")}`);
	};

	const refresh = async (): Promise<void> => {
		hosts = await collect(rigFilter);
		if (selected >= hosts.length) selected = Math.max(0, hosts.length - 1);
		draw();
	};

	const cleanup = (): void => {
		// Raw mode is what makes a single keypress a keypress: without it the
		// terminal echoes the character and the stream delivers it after a newline.
		process.stdin.setRawMode?.(false);
		process.stdout.write(`${SHOW}${ALT_OFF}`);
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});

	// Raw mode alone: calling resume() would lock the stream `Bun.stdin.stream()` reads.
	process.stdin.setRawMode?.(true);
	process.stdout.write(ALT_ON + HIDE);
	draw();
	const timer = setInterval(() => void refresh(), REFRESH_MS);

	for await (const chunk of Bun.stdin.stream()) {
		const action = keyAction(new TextDecoder().decode(chunk), selected, hosts.length);
		if (action.kind === "quit") {
			// Leave from inside the loop: `break` awaits the stream's cancel, which
			// can block on a terminal that is still open.
			clearInterval(timer);
			cleanup();
			process.exit(0);
		}
		if (action.kind === "move") {
			selected = action.to;
			draw();
			continue;
		}
		if (action.kind === "refresh") {
			await refresh();
			continue;
		}
		draw();
	}
	clearInterval(timer);
	cleanup();
	// The stdin stream keeps the loop alive after a `break`; leaving is explicit.
	process.exit(0);
}

/**
 * The text to print after leaving the alt screen for the two "leave" actions:
 * either the ssh command that opens that host's own kernel TUI, or the attach
 * hint for its first seat. Never throws: a missing entry is a printed hint.
 */
export function leaveForHost(
	kind: "open" | "attach",
	host: Hostry | undefined,
	entries: { id: string; transport: string; target?: string }[],
): string {
	if (host === undefined) return "\nNo host selected.\n";
	if (kind === "attach") {
		const seat = host.rigs[0];
		return seat === undefined
			? `\nNo seat on ${host.id}.\n`
			: `\nAttach on ${host.id}:  ssh <alias>  then  tmux attach -t ${seat.session}\n`;
	}
	const ssh = sshEntryFor(host.id, entries);
	if (ssh === undefined) {
		return `\nNo ssh entry for ${host.id}. Register one: rig host add --id ${host.id}-ssh --transport ssh --target <address> --user ubuntu\n`;
	}
	return `\nOpening the kernel TUI on ${host.id}...\n`;
}

if (import.meta.main) {
	void main().catch((error: unknown) => {
		process.stdout.write(`${SHOW}${ALT_OFF}`);
		process.stderr.write(`fleet-tui: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
