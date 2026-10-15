/**
 * `src/cli/commands/coordination.ts` — the command group that talks to the
 * absorbed coordination layer: the vendored OpenRig kernel, the decision engine
 * and the closure contract.
 *
 * Kept out of `main.ts` so the entry point stays a map of the product rather
 * than a wall of option parsing, and so each command's argument surface is
 * testable through its own module.
 */

import type { Command } from "commander";
import { seedBuiltinAgents } from "../../registry/builtins/index.ts";
import { CLOSURE_REASONS } from "../../seeds-cli/closure.ts";
import { withCliDb } from "../context.ts";
import type { CliContext } from "../output.ts";
import { runClosure } from "./closure.ts";
import { runDecide } from "./decide.ts";
import { type FleetArgs, runFleet } from "./fleet.ts";
import { type KernelAction, runKernel } from "./kernel.ts";

/**
 * Register `decide`, the `kernel` group and `closure`.
 *
 * The kernel group is a group rather than four flat verbs: it is one process
 * with four lifecycle verbs, and more (logs, a deeper doctor) land beside them
 * without inflating the first-page help.
 */
export function registerCoordinationCommands(program: Command, context: CliContext): void {
	program
		.command("decide")
		.description("ask the decision engine (TypeSafe Jev) and exit on the band it returns")
		.requiredOption(
			"--feature <name>",
			"which decision this is; drives the timeout, the cap and the log",
		)
		.requiredOption("--state <json|file>", "the state to judge: inline JSON or a path to it")
		.requiredOption("--questions <json|file>", "named questions: inline JSON or a path to it")
		.option("--subject <id>", "what the decision is about (run id, seed id, packet id)")
		.option("--json", "print the whole decision as JSON")
		.option("--stub", "answer from the offline fixture instead of a provider")
		.action(
			async (opts: {
				feature: string;
				state: string;
				questions: string;
				subject?: string;
				json?: boolean;
				stub?: boolean;
			}) => {
				process.exit(
					await runDecide(context, {
						feature: opts.feature,
						state: opts.state,
						questions: opts.questions,
						subject: opts.subject,
						json: opts.json === true,
						stub: opts.stub === true,
					}),
				);
			},
		);

	// `kernel` is a subcommand group: the absorbed OpenRig daemon is one
	// process with four lifecycle verbs, and more (logs, doctor details) will
	// land beside them without inflating warren's first-page help.
	const kernelGroup = program
		.command("kernel")
		.description("supervise the coordination kernel (the vendored OpenRig daemon)");
	for (const action of ["status", "start", "stop", "doctor"] as const) {
		kernelGroup
			.command(action)
			.description(
				action === "doctor"
					? "status plus the kernel's own /healthz verdict"
					: `${action} the kernel process`,
			)
			.option("--json", "print the raw kernel status as JSON")
			.action(async (opts: { json?: boolean }) => {
				process.exit(
					await runKernel(context, { action: action as KernelAction, json: opts.json === true }),
				);
			});
	}

	// `fleet` is the remote execution lane: which boxes exist, whether they
	// answer, and a way to place one run to smoke the path end to end.
	const fleetGroup = program
		.command("fleet")
		.description("remote execution boxes: their state, and dispatching a run to one");
	fleetGroup
		.command("status")
		.description("probe every configured box's burrow and print its state and load")
		.option("--json", "print the box table as JSON")
		.action(async (opts: { json?: boolean }) => {
			const report = await runFleet({ action: "status", json: opts.json === true }, context);
			for (const line of report.lines) console.log(line);
			process.exit(report.exitCode);
		});
	fleetGroup
		.command("dispatch")
		.description("place one run on a box through warren's lifecycle (row, and reap)")
		.requiredOption("--repo <url>", "git origin to work on (a registered project)")
		.requiredOption("--prompt <text>", "the brief handed to the agent")
		.option("--runtime <id>", "agent runtime id (default pi)")
		.option("--provider <name>", "agent provider override (default the runtime's own)")
		.option("--model <name>", "agent model override (default the runtime's own)")
		.option("--wait", "spawn, stream and reap here, so no server is needed")
		.action(
			async (opts: {
				repo: string;
				prompt: string;
				runtime?: string;
				provider?: string;
				model?: string;
				wait?: boolean;
			}) => {
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					await seedBuiltinAgents(repos.agents, undefined, context.now);
					const report = await runFleet(
						{
							action: "dispatch",
							repo: opts.repo,
							prompt: opts.prompt,
							...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
							...(opts.provider !== undefined ? { provider: opts.provider } : {}),
							...(opts.model !== undefined ? { model: opts.model } : {}),
							wait: opts.wait === true,
						},
						context,
						{ repos },
					);
					for (const line of report.lines) console.log(line);
					return report.exitCode;
				});
				process.exit(exitCode);
			},
		);

	fleetGroup
		.command("pump")
		.description("claim ready seeds and place a run for each through the lifecycle")
		.requiredOption("--repo <url>", "git origin the runs work on (a registered project)")
		.option("--limit <n>", "how many seeds to take (default one per box)")
		.option("--lease <minutes>", "claim lease, so a stalled run's seed returns to the queue")
		.option("--project <path>", "project holding the seeds ledger (default cwd)")
		.option("--type <type>", "only claim this issue type (default task)")
		.option("--dry-run", "list what would be claimed, and write nothing")
		.option("--runtime <id>", "agent runtime id (default pi)")
		.option("--provider <name>", "agent provider override (default the runtime's own)")
		.option("--model <name>", "agent model override (default the runtime's own)")
		.action(
			async (opts: {
				repo: string;
				limit?: string;
				lease?: string;
				project?: string;
				type?: string;
				dryRun?: boolean;
				runtime?: string;
				provider?: string;
				model?: string;
			}) => {
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					await seedBuiltinAgents(repos.agents, undefined, context.now);
					const report = await runFleet(toPumpArgs(opts), context, { repos });
					for (const line of report.lines) console.log(line);
					return report.exitCode;
				});
				process.exit(exitCode);
			},
		);

	/** `fleet pump` options → the args `runFleet` takes. Extracted to keep the action simple. */
	function toPumpArgs(opts: {
		repo: string;
		limit?: string;
		lease?: string;
		project?: string;
		type?: string;
		dryRun?: boolean;
		runtime?: string;
		provider?: string;
		model?: string;
	}): FleetArgs {
		// A draft keyed by FleetArgs field names, so the two tables below stay the
		// only place a new option has to be added.
		const draft: Record<string, string | number | boolean> = { action: "pump", repo: opts.repo };
		const counted: Record<string, string | undefined> = {
			limit: opts.limit,
			leaseMinutes: opts.lease,
		};
		for (const [key, raw] of Object.entries(counted)) {
			if (raw !== undefined) draft[key] = Number.parseInt(raw, 10);
		}
		const named: Record<string, string | undefined> = {
			project: opts.project,
			type: opts.type,
			runtime: opts.runtime,
			provider: opts.provider,
			model: opts.model,
		};
		for (const [key, value] of Object.entries(named)) {
			if (value !== undefined) draft[key] = value;
		}
		if (opts.dryRun === true) draft.dryRun = true;
		// Every key above is a FleetArgs key, so the cast only tells the compiler
		// what the tables already guarantee.
		return draft as unknown as FleetArgs;
	}

	program
		.command("closure")
		.description("validate a closure reason and print the canonical string for `sd close --reason`")
		.argument("<reason>", `one of: ${CLOSURE_REASONS.join(", ")}`)
		.option("--target <id>", "new owner, blocker id, or escalation target")
		.option("--successor <id>", "the issue that replaces this one")
		.option("--note <text>", "what actually happened, in prose")
		.option("--json", "print the closure and its queue mapping as JSON")
		.action(
			(
				reason: string,
				opts: { target?: string; successor?: string; note?: string; json?: boolean },
			) => {
				process.exit(
					runClosure(context, {
						reason,
						target: opts.target,
						successor: opts.successor,
						note: opts.note,
						json: opts.json === true,
					}),
				);
			},
		);
}
