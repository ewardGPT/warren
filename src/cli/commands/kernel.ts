/**
 * `warren kernel <status|start|stop|doctor>` — supervision of the vendored
 * OpenRig daemon, the coordination kernel absorbed in ubuntu-cf02.
 *
 * The kernel is a Node process, not a Bun one: `better-sqlite3` crashes Bun
 * 1.3.14 with a NAPI fatal, and the kernel's whole domain layer is built on that
 * driver. Warren spawns the entry directly rather than shelling out to
 * `rig daemon start`, which detaches and would leave Warren unable to own the
 * process or validate its PID. See src/kernel/paths.ts for the isolation rules:
 * a private HOME as well as a private OPENRIG_HOME, because a kernel boot writes
 * into `~/.claude/skills`, `~/.agents/skills` and `~/.codex/config.toml`.
 *
 * Exit codes: 0 healthy or done, 1 unhealthy or failed, 3 not running.
 * `kernelReport` is pure so the mapping is testable without a process.
 */

import {
	type KernelDeps,
	type KernelStatus,
	kernelClient,
	kernelStart,
	kernelStatus,
	kernelStop,
} from "../../kernel/index.ts";
import type { CliContext } from "../output.ts";

export type KernelAction = "status" | "start" | "stop" | "doctor";

export interface KernelArgs {
	readonly action: KernelAction;
	readonly json?: boolean;
}

export interface KernelReport {
	readonly lines: string[];
	readonly exitCode: number;
}

/**
 * Turn one kernel state into the lines to print and the code to exit with.
 *
 * `doctor` is the strict action: anything short of `running` is a problem.
 * `status` and `stop` report `stopped` as an answer rather than a failure, which
 * is what an operator asking "is it up?" wants to see.
 */
export function kernelReport(action: KernelAction, status: KernelStatus): KernelReport {
	const facts = [
		`state ${status.state}`,
		status.pid === undefined ? undefined : `pid ${status.pid}`,
		status.version === undefined ? undefined : `version ${status.version}`,
		status.entry === undefined ? undefined : `entry ${status.entry}`,
		status.detail === undefined ? undefined : status.detail,
	].filter((part): part is string => part !== undefined);
	const lines = [`kernel: ${facts.join(", ")}`, `  url ${status.url}`, `  home ${status.home}`];

	if (status.state === "running") {
		// A port that answers is not the same as a kernel that is well; `doctor`
		// reads /healthz, which carries the stuck sweep and the event loop.
		return { lines, exitCode: 0 };
	}
	if (status.state === "stopped") {
		if (action === "status") return { lines, exitCode: 3 };
		if (action === "stop") return { lines, exitCode: 0 };
		return { lines, exitCode: 1 };
	}
	return { lines, exitCode: 1 };
}

export async function runKernel(
	context: CliContext,
	args: KernelArgs,
	deps?: KernelDeps,
): Promise<number> {
	const call = async (): Promise<KernelStatus> => {
		if (args.action === "start") return await kernelStart(context.env, deps);
		if (args.action === "stop") return await kernelStop(context.env, deps);
		return await kernelStatus(context.env, deps);
	};

	let status: KernelStatus;
	try {
		status = await call();
	} catch (error) {
		context.stdio.stderr.write(
			`kernel: ${args.action} failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}

	const report = kernelReport(args.action, status);
	if (args.json === true) {
		context.stdio.stdout.write(`${JSON.stringify(status, null, "\t")}\n`);
	} else {
		for (const line of report.lines) context.stdio.stdout.write(`${line}\n`);
	}

	if (args.action !== "doctor" || status.state !== "running") return report.exitCode;

	try {
		const healthz = await kernelClient(status).get<{
			status?: string;
			stuckSweep?: { lastOutcome?: string };
		}>("/healthz");
		context.stdio.stdout.write(
			`  healthz ${healthz.status ?? "unknown"}` +
				(healthz.stuckSweep?.lastOutcome === undefined
					? ""
					: `, stuck sweep ${healthz.stuckSweep.lastOutcome}`) +
				"\n",
		);
		return healthz.status === "ok" ? 0 : 1;
	} catch (error) {
		context.stdio.stderr.write(
			`kernel: healthz unreadable: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
