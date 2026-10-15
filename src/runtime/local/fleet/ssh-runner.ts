/**
 * The real {@link SshRunner}: `ssh <target> <command> <args…>` via
 * `node:child_process`, with stdin support for `tee` and a hard timeout.
 *
 * `ssh` hands its trailing argv to the REMOTE LOGIN SHELL, which re-parses it —
 * so every argument after the command is single-quoted here. Callers therefore
 * pass raw values (a path with a space stays one argument), and a caller that
 * wants a shell on the far end passes the whole script as one argument, which is
 * exactly how `createRemoteReapExec` builds `bash -lc <script>`.
 *
 * BatchMode is deliberate: a run's reap half must never block on a password
 * prompt. A box that cannot be reached key-only fails fast with ssh's own code,
 * and that failure lands in the run's terminal detail instead of a hang.
 */

import { spawn } from "node:child_process";
import {
	type SshRunner,
	type SshRunOptions,
	type SshRunResult,
	shellQuote,
} from "./remote-seams.ts";

export const DEFAULT_SSH_TIMEOUT_MS = 120_000;

export interface SshRunnerOptions {
	/** `user@host` — what `ssh` dials. */
	readonly target: string;
	/** ssh binary, for a deployment that ships its own. */
	readonly sshBinary?: string;
	/** Default per-call timeout when a call passes none. */
	readonly timeoutMs?: number;
}

export function createSshRunner(options: SshRunnerOptions): SshRunner {
	const binary = options.sshBinary ?? "ssh";
	const defaultTimeout = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
	return {
		target: options.target,
		run: (command, args, opts) =>
			spawnSsh(binary, options.target, command, args, opts, defaultTimeout),
	};
}

async function spawnSsh(
	binary: string,
	target: string,
	command: string,
	args: readonly string[],
	opts: SshRunOptions | undefined,
	defaultTimeoutMs: number,
): Promise<SshRunResult> {
	const argv = [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		target,
		command,
		...args.map((arg) => shellQuote(arg)),
	];
	const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
	return await new Promise<SshRunResult>((resolve, reject) => {
		const child = spawn(binary, argv, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`ssh ${target} ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
		if (opts?.stdin !== undefined) child.stdin.write(opts.stdin);
		child.stdin.end();
	});
}
