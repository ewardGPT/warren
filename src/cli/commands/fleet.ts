/**
 * `warren fleet <status|dispatch|pump>` — the operator surface for the remote
 * execution lane (ubuntu-cf02).
 *
 * `status` answers "can warren place work, and who is busy" without making
 * anything happen: it probes every configured box's burrow and prints its state
 * and load.
 *
 * `dispatch` and `pump` place work through warren's OWN lifecycle, not beside
 * it. Both call `spawnRun`, so a placed run gets a warren row and is reaped
 * like any other run, and a pumped run also carries its seed link.
 * `dispatch --wait` runs the whole lifecycle in-process — spawn, stream,
 * reap — which is the way to smoke the lane after a change without a server.
 *
 * All three read the same fleet config the runtime backend reads, so what this
 * prints is exactly what a run would use — no second code path to drift.
 *
 * Exit codes: 0 ok, 1 failure (no box, dispatch failed, run failed), 3 no box is
 * reachable. A missing or unusable fleet config is a plain failure with the
 * loader's recovery hint, not a stack trace.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import { type SpawnRunResult, spawnRun } from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { FleetBoxRuntime } from "../../runtime/local/fleet/index.ts";
import {
	buildFleetProvider,
	FleetConfigError,
	fleetPlacementFromEnv,
	probeBoxes,
} from "../../runtime/local/fleet/index.ts";
import type { SeedsCliDeps } from "../../seeds-cli/extensions.ts";
import { claimReadySeed, listReadySeeds, type ReadySeed } from "../../seeds-cli/ready.ts";
import type { CliContext } from "../output.ts";
import { runRun } from "./run.ts";

export type FleetAction = "status" | "dispatch" | "pump";

export interface FleetArgs {
	readonly action: FleetAction;
	/** dispatch: the git origin to work on. It must be a registered project. */
	readonly repo?: string;
	readonly prompt?: string;
	readonly runtime?: string;
	/** dispatch: agent provider override (pi's `--provider` vocabulary). */
	readonly provider?: string;
	/** dispatch: agent model override (pi's `--model` value). */
	readonly model?: string;
	/** dispatch: drive the whole lifecycle here, instead of leaving reap to a server. */
	readonly wait?: boolean;
	/** pump: how many seeds to take. Defaults to one per configured box. */
	readonly limit?: number;
	/** pump: claim lease in minutes. */
	readonly leaseMinutes?: number;
	/** pump: list what would be claimed, and write nothing. */
	readonly dryRun?: boolean;
	/** pump: the project whose seeds ledger holds the work. Defaults to cwd. */
	readonly project?: string;
	/** pump: only claim this issue type. Defaults to `task`. */
	readonly type?: string;
	readonly json?: boolean;
}

export interface FleetReport {
	readonly lines: readonly string[];
	readonly exitCode: number;
}

/** Wiring for tests: a provider plus the boxes it holds. */
export interface FleetCliDeps {
	/**
	 * The fleet provider: the boxes `status` probes, and the runtime seam the
	 * domain dispatches through. Tests stub both.
	 */
	readonly provider?: RuntimeProvider & { readonly boxes: readonly FleetBoxRuntime[] };
	readonly env?: Record<string, string | undefined>;
	/** pump: the seeds ledger read/claim seam. Defaults to the sd facade. */
	readonly seeds?: {
		listReady(
			projectPath: string,
			options: { limit?: number; type?: string },
		): Promise<readonly ReadySeed[]>;
		claim(
			projectPath: string,
			options: { leaseMinutes?: number; type?: string },
		): Promise<ReadySeed | null>;
	};
	/** pump: the project to read seeds from. Defaults to the process cwd. */
	readonly projectPath?: string;
	/**
	 * The warren database seam. `dispatch` and `pump` place work through the
	 * domain, which needs the registered projects and the run rows. `status`
	 * needs neither, so it runs without one.
	 */
	readonly repos?: Repos;
	/** Place-only seam (`dispatch` without `--wait`, and `pump`). Defaults to the live `spawnRun`. */
	readonly spawn?: typeof spawnRun;
	/** Lifecycle seam for `dispatch --wait`. Defaults to the live `runRun`. */
	readonly run?: typeof runRun;
}

export async function runFleet(
	args: FleetArgs,
	context: CliContext,
	deps: FleetCliDeps = {},
): Promise<FleetReport> {
	const env = deps.env ?? (context.env as Record<string, string | undefined>);
	let provider: NonNullable<FleetCliDeps["provider"]>;
	try {
		provider = deps.provider ?? buildFleetProvider({ env, placement: fleetPlacementFromEnv(env) });
	} catch (error) {
		if (error instanceof FleetConfigError) {
			return {
				lines: [error.message, ...(error.recoveryHint === undefined ? [] : [error.recoveryHint])],
				exitCode: 1,
			};
		}
		throw error;
	}
	if (provider.boxes.length === 0) {
		return { lines: ["fleet: no boxes configured"], exitCode: 1 };
	}
	if (args.action === "status") return await statusReport(provider.boxes, args);
	if (args.action === "pump") return await pumpReport(provider, args, deps, context);
	return await dispatchReport(provider, args, deps, context);
}

async function statusReport(
	boxes: readonly FleetBoxRuntime[],
	args: FleetArgs,
): Promise<FleetReport> {
	const health = await probeBoxes(boxes);
	const rows = boxes.map((box) => {
		const entry = health.get(box.id);
		return {
			id: box.id,
			url: describeUrl(box),
			healthy: entry?.healthy ?? false,
			live: entry?.live ?? 0,
			detail: entry === undefined ? "not probed" : entry.detail,
		};
	});
	const up = rows.filter((row) => row.healthy).length;
	if (args.json === true) {
		return { lines: [JSON.stringify({ boxes: rows, healthy: up })], exitCode: up === 0 ? 3 : 0 };
	}
	const lines = [`fleet: ${up}/${rows.length} boxes reachable`];
	for (const row of rows) {
		const state = row.healthy ? "ok" : `down (${row.detail})`;
		lines.push(
			`${row.healthy ? " " : "!"} ${row.id.padEnd(16)} ${state} · ${row.live} live · ${row.url}`,
		);
	}
	return { lines, exitCode: up === 0 ? 3 : 0 };
}

/**
 * The project a `--repo` URL names.
 *
 * A placed run gets a warren row, and a row belongs to a project, so the URL
 * has to be one warren already knows. `add-project` stores the URL as typed,
 * which makes an exact miss common — the fallback compares the normalized
 * forms (trailing slash, `.git`, case) before giving up.
 */
async function resolveProject(repos: Repos, repo: string): Promise<ProjectRow | null> {
	const exact = await repos.projects.findByGitUrl(repo);
	if (exact !== null) return exact;
	const wanted = normalizeRepo(repo);
	for (const row of await repos.projects.listAll()) {
		if (normalizeRepo(row.gitUrl) === wanted) return row;
	}
	return null;
}

function normalizeRepo(url: string): string {
	return url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.toLowerCase();
}

/**
 * The line that keeps a placed run findable. Reap is server-side, so a run
 * placed without `--wait` is finalized by whatever server runs next — and that
 * server resolves its own runtime, which has to be the fleet kind.
 */
function reapHint(env: Record<string, string | undefined>): string {
	return env.WARREN_RUNTIME === "fleet"
		? "  reap is the server's: a warren server finalizes it on its next watchdog tick"
		: "  reap needs a server started with WARREN_RUNTIME=fleet, and this shell does not set it";
}

/**
 * `fleet pump`: claim ready seeds and place a run for each, so the boxes fill
 * without an operator naming one seed at a time.
 *
 * The seeds lease is the dedupe. A claimed seed is no longer ready, so a second
 * pump cannot take it, and two pumps racing split the queue. Placement then
 * spreads the runs: the provider's in-flight ledger counts each create, so a
 * single pump puts one run on each box before it reuses one.
 *
 * A pumped run walks the domain spawn, so its row records the seed it came
 * from. A pump does not wait on that run: waiting would serialize a queue whose
 * whole point is filling every box at once. Reap therefore belongs to a running
 * server, and the report says so.
 */
async function pumpReport(
	provider: NonNullable<FleetCliDeps["provider"]>,
	args: FleetArgs,
	deps: FleetCliDeps,
	context: CliContext,
): Promise<FleetReport> {
	if (args.repo === undefined) return { lines: ["fleet pump needs --repo"], exitCode: 1 };
	const seeds = deps.seeds ?? defaultSeeds();
	// Two different projects: the path holding `.seeds/`, and the warren project
	// the placed runs belong to.
	const ledger = deps.projectPath ?? args.project ?? process.cwd();
	const limit = args.limit ?? provider.boxes.length;
	// Task by default: `sd ready --claim` takes the highest-priority ready
	// issue, so an unfiltered pump would claim an epic and hand an agent a plan.
	const type = args.type ?? "task";

	if (args.dryRun === true) return await dryRunReport(seeds, ledger, limit, type);

	const resolved = await requireProject(deps, args.repo);
	if ("exitCode" in resolved) return resolved;
	const pump: PumpContext = {
		provider,
		seeds,
		repos: resolved.repos,
		project: resolved.project,
		agent: args.runtime ?? "pi",
		spawn: deps.spawn ?? spawnRun,
		args,
		type,
	};
	const placed = await placeAll(pump, ledger, limit);
	if (placed.count > 0) {
		placed.lines.push(reapHint(deps.env ?? (context.env as Record<string, string | undefined>)));
	}
	return { lines: placed.lines, exitCode: placed.count > 0 ? 0 : 1 };
}

/** `--dry-run`: what the pump would claim, with nothing written. */
async function dryRunReport(
	seeds: NonNullable<FleetCliDeps["seeds"]>,
	ledger: string,
	limit: number,
	type: string,
): Promise<FleetReport> {
	const ready = await seeds.listReady(ledger, { limit, type });
	const lines = [`pump: dry run, ${ready.length} ready seed(s), nothing claimed or dispatched`];
	for (const seed of ready) lines.push(`  ${seed.id} ${seed.title}`);
	return { lines, exitCode: 0 };
}

/** Claim up to `limit` seeds, placing a run for each. Stops at an empty queue. */
async function placeAll(
	pump: PumpContext,
	ledger: string,
	limit: number,
): Promise<{ readonly lines: string[]; readonly count: number }> {
	const lines: string[] = [];
	let placed = 0;
	for (let taken = 0; taken < limit; taken += 1) {
		const step = await placeOne(pump, ledger);
		if (step === null) {
			lines.push(`pump: nothing else is ready, ${placed} placed`);
			break;
		}
		lines.push(step.line);
		if (step.placed) placed += 1;
	}
	return { lines, count: placed };
}

interface PumpStep {
	readonly line: string;
	readonly placed: boolean;
}

/** Everything one pump placement needs, resolved once for the whole seed run. */
interface PumpContext {
	readonly provider: NonNullable<FleetCliDeps["provider"]>;
	readonly seeds: NonNullable<FleetCliDeps["seeds"]>;
	readonly repos: Repos;
	readonly project: ProjectRow;
	readonly agent: string;
	readonly spawn: typeof spawnRun;
	readonly args: FleetArgs;
	readonly type: string;
}

/**
 * The registered project a `--repo` URL names, plus the database it came from.
 * Both placing verbs share this, so an operator learns the same fix from
 * either one: the URL has to be one warren already tracks.
 */
async function requireProject(
	deps: FleetCliDeps,
	repo: string,
): Promise<ResolvedProject | FleetReport> {
	if (deps.repos === undefined) {
		return {
			lines: ["fleet: no warren database in reach — place runs through the CLI"],
			exitCode: 1,
		};
	}
	const project = await resolveProject(deps.repos, repo);
	if (project === null) {
		return {
			lines: [
				`fleet: ${repo} is not a registered project`,
				`  register it first: warren add-project ${repo}`,
			],
			exitCode: 1,
		};
	}
	return { repos: deps.repos, project };
}

/** A project row and the database handle a placed run is written through. */
interface ResolvedProject {
	readonly repos: Repos;
	readonly project: ProjectRow;
}

/**
 * Claim one seed and place a run for it. `null` means nothing was ready, which
 * ends the pump. A placement failure still returns a line, because the claim
 * stands and its lease runs down: naming the seed is what lets an operator
 * release it by hand.
 */
async function placeOne(pump: PumpContext, ledger: string): Promise<PumpStep | null> {
	const seed = await pump.seeds.claim(ledger, {
		type: pump.type,
		...(pump.args.leaseMinutes === undefined ? {} : { leaseMinutes: pump.args.leaseMinutes }),
	});
	if (seed === null) return null;
	const prompt = `Work seed ${seed.id}: ${seed.title}\n\nRead the seed with \`sd show ${seed.id}\` and complete it.`;
	try {
		const placed = await pump.spawn({
			repos: pump.repos,
			runtimeProvider: pump.provider,
			agentName: pump.agent,
			projectId: pump.project.id,
			prompt,
			trigger: "cli",
			seedId: seed.id,
			...(pump.args.provider === undefined ? {} : { providerOverride: pump.args.provider }),
			...(pump.args.model === undefined ? {} : { modelOverride: pump.args.model }),
		});
		return { line: `${seed.id} -> ${boxOf(placed)} (${placed.run.id})`, placed: true };
	} catch (error) {
		return { line: `${seed.id} claimed but not placed: ${describe(error)}`, placed: false };
	}
}

/** The box a placed run landed on — the fleet handle encodes it as `<box>/<inner>`. */
function boxOf(placed: SpawnRunResult): string {
	return placed.burrowRun.id.split("/")[0] ?? "?";
}

/** The real seeds seam: the `sd` facade, read from the operator's PATH. */
function defaultSeeds(): NonNullable<FleetCliDeps["seeds"]> {
	const deps: SeedsCliDeps = { sdBinary: "sd", spawn: defaultSpawn };
	return {
		listReady: (projectPath, options) => listReadySeeds(deps, projectPath, options),
		claim: (projectPath, options) => claimReadySeed(deps, projectPath, options),
	};
}

async function dispatchReport(
	provider: NonNullable<FleetCliDeps["provider"]>,
	args: FleetArgs,
	deps: FleetCliDeps,
	context: CliContext,
): Promise<FleetReport> {
	if (args.repo === undefined || args.prompt === undefined) {
		return { lines: ["fleet dispatch needs --repo and --prompt"], exitCode: 1 };
	}
	const resolved = await requireProject(deps, args.repo);
	if ("exitCode" in resolved) return resolved;
	const run: AgentRun = {
		repos: resolved.repos,
		projectId: resolved.project.id,
		agent: args.runtime ?? "pi",
		prompt: args.prompt,
		...(args.provider === undefined ? {} : { providerOverride: args.provider }),
		...(args.model === undefined ? {} : { modelOverride: args.model }),
	};
	if (args.wait === true) return await runLifecycle(provider, deps, context, run);
	return await placeOnce(provider, deps, context, run);
}

/** What both verbs hand the domain: the same shape `spawnRun` takes. */
interface AgentRun {
	readonly repos: Repos;
	readonly projectId: string;
	readonly agent: string;
	readonly prompt: string;
	readonly providerOverride?: string;
	readonly modelOverride?: string;
}

/**
 * `dispatch --wait`: the whole lifecycle in-process — spawn, stream, reap. That
 * needs no server, and the run writes its own NDJSON as `warren run` does.
 */
async function runLifecycle(
	provider: NonNullable<FleetCliDeps["provider"]>,
	deps: FleetCliDeps,
	context: CliContext,
	run: AgentRun,
): Promise<FleetReport> {
	const lifecycle = deps.run ?? runRun;
	const result = await lifecycle(
		context,
		{ repos: run.repos, runtimeProvider: provider },
		{
			agent: run.agent,
			project: run.projectId,
			prompt: run.prompt,
			...(run.providerOverride === undefined ? {} : { providerOverride: run.providerOverride }),
			...(run.modelOverride === undefined ? {} : { modelOverride: run.modelOverride }),
		},
	);
	return {
		lines: [`fleet dispatch: ${result.runId ?? "(nothing spawned)"} ${result.state ?? "unknown"}`],
		exitCode: result.exitCode,
	};
}

/** `dispatch` without `--wait`: place the run, and leave the reap to a server. */
async function placeOnce(
	provider: NonNullable<FleetCliDeps["provider"]>,
	deps: FleetCliDeps,
	context: CliContext,
	run: AgentRun,
): Promise<FleetReport> {
	const spawn = deps.spawn ?? spawnRun;
	try {
		const placed = await spawn({
			repos: run.repos,
			runtimeProvider: provider,
			agentName: run.agent,
			projectId: run.projectId,
			prompt: run.prompt,
			trigger: "cli",
			...(run.providerOverride === undefined ? {} : { providerOverride: run.providerOverride }),
			...(run.modelOverride === undefined ? {} : { modelOverride: run.modelOverride }),
		});
		return {
			lines: [
				`dispatched ${placed.run.id} on ${boxOf(placed)}`,
				`  sandbox ${placed.burrow.id}`,
				reapHint(deps.env ?? (context.env as Record<string, string | undefined>)),
			],
			exitCode: 0,
		};
	} catch (error) {
		return { lines: [`fleet dispatch failed: ${describe(error)}`], exitCode: 1 };
	}
}

/** `http://host:port` for the box, rendered from its burrow transport. */
function describeUrl(box: FleetBoxRuntime): string {
	const transport = box.client.config.transport;
	return transport.kind === "tcp" ? `http://${transport.hostname}:${transport.port}` : "unix";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
