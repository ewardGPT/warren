/**
 * omp refocus hook — orientation re-injection for a long agent session.
 *
 * SELF-CONTAINED BY CONTRACT: the installed copy of this file is byte-identical
 * to this one, because a user-level omp extension module is loaded from
 * `<agentDir>/hooks/pre/*.ts` outside any package — third-party imports cannot
 * resolve there. Only node built-ins are imported; keep it that way.
 *
 * Install (idempotent): scripts/install-omp-hooks.sh
 *
 * Why it exists
 * -------------
 * An agent that has been working for hours has earned a picture of the code and
 * lost the picture of *why*. Compaction makes that worse: it is a lossy summary
 * taken at the moment the local problem is most vivid. The failure this prevents
 * is not laziness — it is a chain of locally defensible decisions that adds up to
 * something nobody asked for (the doghouse that becomes a moonbase).
 *
 * The fix is not a restart and not a bigger prompt: it is re-injecting the
 * *intent chain* — the active plan, the actionable frontier — and asking the
 * agent to answer, out loud, whether what it is doing right now still serves it.
 *
 * Design, adopted from OpenRig's refocus channel (vendor/openrig, Apache-2.0):
 *   - due state is RETAINED at a compaction boundary, never consumed there;
 *   - it is consumed only at the next actionable prompt, so the reminder lands as
 *     work resumes instead of as a stray note;
 *   - the trigger is compaction and an interval, not transcript growth (omp
 *     exposes no transcript-size signal at a turn boundary);
 *   - every failure is silent and logged: a hook must never break a session.
 *
 * Behaviour
 * ---------
 *   auto_compaction_end | session_compact -> mark refocus due, persist state
 *   before_agent_start                    -> if due (or on demand, or on the
 *                                            interval), inject the intent chain
 *   session_shutdown                      -> keep state, so the next session in
 *                                            the same directory inherits the debt
 *
 * Environment
 * -----------
 *   REFOCUS_ENABLED=0      disable entirely
 *   REFOCUS_NOW=1          force one delivery at the next prompt
 *   REFOCUS_EVERY=<n>      also deliver every n prompts (default 0 = off)
 *   REFOCUS_MAX_BYTES=<n>  cap the injected payload (default 4000)
 *   REFOCUS_DIR=<path>     state directory (default <agentDir>/refocus)
 *   REFOCUS_SD=<path>      seeds binary to consult (default `sd` on PATH)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface HookContextLike {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

interface HookApi {
	on(event: string, handler: (event: unknown, ctx: HookContextLike) => unknown): void;
	log?(message: string): void;
}

export interface RefocusState {
	pendingOn?: string;
	pendingAt?: string;
	lastDeliveredAt?: string;
	deliveries?: number;
	promptsSeen?: number;
}

export interface RefocusDecision {
	readonly due: boolean;
	readonly why: string;
}

export interface RefocusDeps {
	readonly env?: Record<string, string | undefined>;
	readonly now?: () => Date;
	readonly stateDir?: (ctx: HookContextLike) => string;
	/** Command runner seam: the only thing tests substitute. */
	readonly run?: (command: string, args: readonly string[], cwd: string) => Promise<string>;
	readonly findRoot?: (cwd: string) => string | undefined;
	readonly log?: (message: string) => void;
}

const COMPACTION_EVENTS = ["auto_compaction_end", "session_compact"] as const;

function isEnabled(value: string | undefined): boolean {
	if (value === undefined || value.length === 0) return true;
	return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stdoutOr(text: { stdout: string }): string {
	return text.stdout.trim();
}

async function defaultRun(command: string, args: readonly string[], cwd: string): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<{ stdout: string }>();
	execFile(command, [...args], { cwd, timeout: 4000, maxBuffer: 1024 * 1024 }, (_error, stdout) =>
		resolve({ stdout: stdout ?? "" }),
	);
	return stdoutOr(await promise);
}

/**
 * Whether a delivery is owed, and why. The rule the hook rests on, exported so
 * it is readable and testable without running omp.
 */
export function refocusDecision(
	event: string,
	state: RefocusState,
	env: Record<string, string | undefined>,
): RefocusDecision {
	if (["1", "true", "yes", "on"].includes((env.REFOCUS_NOW ?? "").toLowerCase()))
		return { due: true, why: "on demand" };
	if (COMPACTION_EVENTS.includes(event as (typeof COMPACTION_EVENTS)[number]))
		return { due: false, why: "a compaction boundary retains due state, it does not consume it" };
	if (event !== "before_agent_start") return { due: false, why: `no prompt boundary at ${event}` };
	if (state.pendingOn !== undefined)
		return {
			due: true,
			why: `just compacted (${state.pendingAt ?? "recently"}) — your picture is lossy`,
		};
	const every = positiveInt(env.REFOCUS_EVERY, 0);
	const seen = state.promptsSeen ?? 0;
	if (every > 0 && seen > 0 && seen % every === 0)
		return { due: true, why: `${seen} prompts since the last refocus` };
	return { due: false, why: "not due" };
}

/** The next persisted state for an event. Due state clears only on delivery. */
export function nextState(
	event: string,
	state: RefocusState,
	decision: RefocusDecision,
	now: Date,
): RefocusState {
	const stamp = now.toISOString();
	if (COMPACTION_EVENTS.includes(event as (typeof COMPACTION_EVENTS)[number]))
		return { ...state, pendingOn: event, pendingAt: stamp };
	if (event !== "before_agent_start") return state;
	const promptsSeen = (state.promptsSeen ?? 0) + 1;
	if (!decision.due) return { ...state, promptsSeen };
	const delivered: RefocusState = {
		promptsSeen,
		lastDeliveredAt: stamp,
		deliveries: (state.deliveries ?? 0) + 1,
	};
	return delivered;
}

/** Walk up from cwd to the project that owns a `.seeds` directory. */
export function findSeedsRoot(
	cwd: string,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	let current = cwd;
	for (let depth = 0; depth < 32; depth += 1) {
		if (exists(join(current, ".seeds"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

function clip(text: string, maxBytes: number): string {
	if (text.length <= maxBytes) return text;
	const half = Math.max(1, Math.floor(maxBytes / 2));
	return `${text.slice(0, half)}\n…[clipped ${text.length - maxBytes} chars]…\n${text.slice(-half)}`;
}

/**
 * Build the refocus payload from the project's own intent. A missing chain is
 * reported as a gap — this never invents a scope, and never blocks on a slow or
 * absent `sd`.
 */
export async function buildPayload(
	projectRoot: string,
	why: string,
	run: (command: string, args: readonly string[], cwd: string) => Promise<string>,
	seedsBinary: string,
	maxBytes: number,
): Promise<string> {
	const [plans, frontier] = await Promise.all([
		runSeeds(run, seedsBinary, ["plan", "ready"], projectRoot),
		runSeeds(run, seedsBinary, ["ready"], projectRoot),
	]);
	const sections: string[] = [];
	if (plans.length > 0) sections.push(`## Active plans\n${plans}`);
	if (frontier.length > 0) sections.push(`## Actionable frontier\n${frontier}`);
	const chain =
		sections.length > 0 ? sections.join("\n\n") : "(no .seeds plan or frontier found here)";
	return clip(
		[
			`REFOCUS (${why}). Answer briefly, out loud, before your next move:`,
			"",
			"1. What end-to-end outcome is this project trying to reach?",
			"2. Which acceptance criterion is the work in front of you serving?",
			"3. Is anything you are about to do not required by that criterion?",
			"",
			"The rules are not the goal. Locally defensible decisions compound into",
			"work nobody asked for; if the chain below has drifted from what you are",
			"doing, say so now instead of widening the scope.",
			"",
			chain,
		].join("\n"),
		maxBytes,
	);
}

async function runSeeds(
	run: (command: string, args: readonly string[], cwd: string) => Promise<string>,
	seedsBinary: string,
	args: readonly string[],
	cwd: string,
): Promise<string> {
	try {
		return await run(seedsBinary, args, cwd);
	} catch (error) {
		return `(sd ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)})`;
	}
}

function stateFileName(ctx: HookContextLike): string {
	const raw = ctx.sessionId ?? ctx.sessionFile ?? ctx.cwd ?? "session";
	return `${raw.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(-120)}.json`;
}

/**
 * The hook factory. omp calls this once per loaded extension module; every
 * handler below swallows its own errors.
 */
export default function refocus(pi: HookApi, deps: RefocusDeps = {}): void {
	const env = deps.env ?? (process.env as Record<string, string | undefined>);
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? ((message: string) => pi.log?.(message));

	const statePath = (ctx: HookContextLike): string => {
		const dir =
			deps.stateDir?.(ctx) ??
			env.REFOCUS_DIR ??
			join(ctx.agentDir ?? `${process.env.HOME ?? "."}/.omp/agent`, "refocus");
		return join(dir, stateFileName(ctx));
	};

	const readState = async (ctx: HookContextLike): Promise<RefocusState> => {
		try {
			return JSON.parse(await readFile(statePath(ctx), "utf8")) as RefocusState;
		} catch {
			return {}; // an unreadable state file is not a reason to skip orientation
		}
	};

	const writeState = async (ctx: HookContextLike, state: RefocusState): Promise<void> => {
		try {
			const path = statePath(ctx);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		} catch (error) {
			log(
				`refocus: could not persist state: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	for (const event of COMPACTION_EVENTS) {
		pi.on(event, async (_event: unknown, ctx: HookContextLike) => {
			const state = await readState(ctx);
			await writeState(ctx, nextState(event, state, { due: false, why: "retained" }, now()));
		});
	}

	pi.on("before_agent_start", async (_event: unknown, ctx: HookContextLike) => {
		if (!isEnabled(env.REFOCUS_ENABLED)) return undefined;
		try {
			const state = await readState(ctx);
			const decision = refocusDecision("before_agent_start", state, env);
			await writeState(ctx, nextState("before_agent_start", state, decision, now()));
			if (!decision.due) return undefined;
			const root = (deps.findRoot ?? findSeedsRoot)(ctx.cwd ?? process.cwd());
			if (root === undefined) return undefined;
			const content = await buildPayload(
				root,
				decision.why,
				deps.run ?? defaultRun,
				env.REFOCUS_SD ?? "sd",
				positiveInt(env.REFOCUS_MAX_BYTES, 4000),
			);
			return {
				message: {
					role: "user",
					customType: "omp.refocus",
					display: true,
					attribution: "agent",
					content,
				},
			};
		} catch (error) {
			log(`refocus: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	});
}
