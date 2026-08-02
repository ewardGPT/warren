/**
 * Stdio + spawn seams for the CLI commands.
 *
 * Each command is a pure function of `(context, args) -> Promise<{exitCode}>`,
 * with all observable side effects flowing through the seams declared here.
 * Production callers wire `process.stdout` / `process.stderr` / `process.env`;
 * tests pass capture-buffers and synthetic env tables.
 */

import {
	defaultSpawn,
	type SpawnFn as ProjectsSpawnFn,
	type SpawnOptions,
	type SpawnResult,
} from "../projects/clone.ts";

export interface WriteSink {
	write(chunk: string): void;
}

export interface Stdio {
	readonly stdout: WriteSink;
	readonly stderr: WriteSink;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export type CliSpawn = ProjectsSpawnFn;
export type { SpawnOptions, SpawnResult };

/**
 * The shared context every CLI command receives. `now` is exposed so tests
 * can pin the clock; the commands forward it onto repos / spawnRun / reap.
 */
export interface CliContext {
	readonly env: EnvLike;
	readonly stdio: Stdio;
	readonly spawn: CliSpawn;
	readonly now?: () => Date;
}

/** A stdout-shaped sink backed by Node's writable streams (for production). */
export const PROCESS_STDIO: Stdio = {
	stdout: {
		write: (chunk) => {
			process.stdout.write(chunk);
		},
	},
	stderr: {
		write: (chunk) => {
			process.stderr.write(chunk);
		},
	},
};

/**
 * The production `Bun.spawn` adaptor, re-exported so CLI commands keep
 * importing their seams from one module.
 */
export { defaultSpawn };

/** Print one JSON object per line ('\n' terminator) to a sink. */
export function writeJsonLine(sink: WriteSink, value: unknown): void {
	sink.write(`${JSON.stringify(value)}\n`);
}

/** Format a thrown error for human stderr output. */
export function formatError(err: unknown): string {
	if (err instanceof Error) {
		const code = (err as Error & { code?: unknown }).code;
		const codeStr = typeof code === "string" ? `[${code}] ` : "";
		const hint = (err as Error & { recoveryHint?: unknown }).recoveryHint;
		const hintStr = typeof hint === "string" ? `\n  hint: ${hint}` : "";
		return `${codeStr}${err.message}${hintStr}`;
	}
	return String(err);
}
