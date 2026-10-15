/**
 * The reap half of a remote run, executed ON the box over ssh.
 *
 * A burrow workspace on a fleet box exists on that box, not on the warren host.
 * The reap pipeline (commit, push, diff, artifacts) is host-file and host-git
 * work, so a remote run needs a filesystem and a shell that both mean "the
 * box". Rather than reimplement reap, this module supplies the two seams it
 * already takes — `ReapFs` (4 methods) and `ReapExec` (1 method) — backed by
 * `ssh box <command>`.
 *
 * Why not fetch the workspace home and run reap locally? Because the point of a
 * fleet box is that the work happens there: the box holds the git credentials,
 * the git objects and the built artifacts, and a `git push` must originate from
 * the clone that has the commits. Copying a working tree back would also need a
 * second network round trip per file.
 *
 * Quoting: every argument crosses ONE shell boundary, so each is wrapped with
 * {@link shellQuote} (single quotes, embedded quotes escaped). Nothing is
 * interpolated unquoted, so a path or a ref with spaces or a `$(...)` in it
 * stays inert.
 */

import type { ReapExec, ReapFs } from "../../../runs/reap/types.ts";

export interface SshRunOptions {
	readonly timeoutMs?: number;
	/** Merged over the inherited environment at the far end. */
	readonly env?: Record<string, string | undefined>;
	/** Written to the remote command's stdin. Absent ⇒ stdin is closed. */
	readonly stdin?: string;
}

export interface SshRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * Run a command on a box. Injected so tests drive the seams without a network,
 * and so a deployment can swap ssh for another channel.
 */
export interface SshRunner {
	run(command: string, args: readonly string[], opts?: SshRunOptions): Promise<SshRunResult>;
	/** The `user@host` this runner dials — used in error messages only. */
	readonly target: string;
}

/** Single-quote a value for `sh`. `it's` becomes `'it'\''s'`. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `cmd arg1 arg2` with every argument quoted once. */
export function shellCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map((part, index) => (index === 0 ? part : shellQuote(part))).join(" ");
}

function envPrefix(env: Record<string, string | undefined> | undefined): string {
	if (env === undefined) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		// A key mapped to undefined is REMOVED at the spawn (warren-fa84), so it
		// becomes an explicit unset here rather than an empty assignment.
		parts.push(value === undefined ? `unset ${key}` : `export ${key}=${shellQuote(value)}`);
	}
	return parts.length === 0 ? "" : `${parts.join("; ")}; `;
}

function failure(what: string, target: string, result: SshRunResult): Error {
	const detail = result.stderr.trim() === "" ? `exit ${result.exitCode}` : result.stderr.trim();
	return new Error(`${what} on ${target} failed: ${detail}`);
}

/**
 * `ReapFs` over ssh. A missing file or directory is a VALUE (`null` / `[]`), not
 * an error — the same contract the local seam keeps, so reap's existence checks
 * behave identically on a box.
 */
export function createRemoteReapFs(ssh: SshRunner): ReapFs {
	const run = async (
		command: string,
		args: readonly string[],
		what: string,
		opts?: SshRunOptions,
	): Promise<SshRunResult> => {
		const result = await ssh.run(command, args, opts);
		if (result.exitCode !== 0) throw failure(what, ssh.target, result);
		return result;
	};
	return {
		mkdirp: async (path) => {
			await run("mkdir", ["-p", path], "mkdir -p");
		},
		readFile: async (path) => {
			const result = await ssh.run("cat", ["--", path]);
			if (result.exitCode !== 0) return null;
			return result.stdout;
		},
		writeFile: async (path, contents) => {
			// `tee` with the payload on stdin rather than a shell redirect: the
			// contents never become a shell word, so a file with quotes, `$(...)`
			// or newlines is written byte-for-byte.
			await run("tee", ["--", path], "tee", { stdin: contents });
		},
		readdir: async (path) => {
			const result = await ssh.run("ls", ["-1", "--", path]);
			if (result.exitCode !== 0) return [];
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "");
		},
	};
}

/**
 * `ReapExec` over ssh: run `cmd args` inside `cwd` on the box. Exit 0 resolves
 * with stdout; anything else rejects with an error whose message carries stderr,
 * which is what every reap call site expects from `execFile`.
 */
export function createRemoteReapExec(ssh: SshRunner): ReapExec {
	return {
		run: async (cmd, args, opts) => {
			const inner = `${envPrefix(opts.env)}cd ${shellQuote(opts.cwd)} && exec ${shellCommand(cmd, args)}`;
			const result = await ssh.run(
				"bash",
				["-lc", inner],
				opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs },
			);
			if (result.exitCode !== 0) {
				throw failure(cmd, ssh.target, result);
			}
			return { stdout: result.stdout, stderr: result.stderr };
		},
	};
}
