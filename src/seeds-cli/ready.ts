/**
 * Ready-issue reader and claimer, for the fleet pump.
 *
 * `sd ready --claim` is the dedupe primitive a pump needs: it picks the
 * highest-priority ready issue, records a lease on it, and returns it. A
 * claimed issue stops being "ready", so a second pump cannot take it. Two
 * pumps racing therefore split the queue instead of duplicating work.
 *
 * `listReadySeeds` is the read-only half, which a dry run uses so nothing is
 * claimed or dispatched.
 *
 * Shares the `SeedsCliDeps` + `SpawnFn` injection and `SeedsCliError` wrapping
 * of the rest of the facade, so tests reuse the same stubs.
 */

import { formatError } from "../core/errors.ts";
import { SeedsCliError } from "./errors.ts";
import type { SeedsCliDeps } from "./extensions.ts";
import { type SeedsListEnvelope, SeedsListEnvelopeSchema } from "./schema.ts";
import { DEFAULT_SD_TIMEOUT_MS, truncate } from "./util.ts";

export interface ReadySeed {
	readonly id: string;
	/** The seed's title, or its id when the ledger carries no title. */
	readonly title: string;
}

export interface ReadyOptions {
	/** Cap on the read-only listing. */
	readonly limit?: number;
	/** Claim lease in minutes. The seeds default applies when omitted. */
	readonly leaseMinutes?: number;
	/**
	 * Only consider this issue type. `sd ready --claim` takes the
	 * highest-priority ready issue, so without a filter a pump can claim an
	 * epic and send an agent to "work" a plan.
	 */
	readonly type?: string;
}

/** Ready issues, highest priority first. Read-only: claims nothing. */
export async function listReadySeeds(
	deps: SeedsCliDeps,
	projectPath: string,
	options: ReadyOptions = {},
): Promise<ReadySeed[]> {
	const args = [deps.sdBinary, "ready", "--json"];
	if (options.type !== undefined) args.push("--type", options.type);
	if (options.limit !== undefined) args.push("--limit", String(options.limit));
	return toReadySeeds(await runReady(deps, projectPath, args));
}

/**
 * Claim one ready issue, or `null` when none is ready. This WRITES to the
 * ledger: the returned issue carries a lease until it is closed or expires.
 */
export async function claimReadySeed(
	deps: SeedsCliDeps,
	projectPath: string,
	options: ReadyOptions = {},
): Promise<ReadySeed | null> {
	const args = [deps.sdBinary, "ready", "--claim", "--json"];
	if (options.type !== undefined) args.push("--type", options.type);
	if (options.leaseMinutes !== undefined) args.push("--lease", String(options.leaseMinutes));
	const seeds = toReadySeeds(await runReady(deps, projectPath, args));
	return seeds[0] ?? null;
}

async function runReady(
	deps: SeedsCliDeps,
	projectPath: string,
	args: string[],
): Promise<SeedsListEnvelope> {
	const result = await deps.spawn(args, {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`${args[1]} exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			{ recoveryHint: `run \`${deps.sdBinary} doctor\` in ${projectPath} to diagnose` },
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`${args[1]} returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}
	const envelope = SeedsListEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`${args[1]} response did not match expected envelope: ${envelope.error.issues
				.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return envelope.data;
}

function toReadySeeds(envelope: SeedsListEnvelope): ReadySeed[] {
	return envelope.issues.map((issue) => ({ id: issue.id, title: issue.title ?? issue.id }));
}
