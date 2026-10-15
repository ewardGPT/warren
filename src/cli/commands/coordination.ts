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
import { CLOSURE_REASONS } from "../../seeds-cli/closure.ts";
import type { CliContext } from "../output.ts";
import { runClosure } from "./closure.ts";
import { runDecide } from "./decide.ts";
import { runFleet } from "./fleet.ts";
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
		.description("place one run on a box (the smoke test for the lane)")
		.requiredOption("--repo <url>", "git origin the run works on")
		.requiredOption("--prompt <text>", "the brief handed to the agent")
		.option("--runtime <id>", "agent runtime id (default pi)")
		.option("--provider <name>", "agent provider override (default the runtime's own)")
		.option("--model <name>", "agent model override (default the runtime's own)")
		.option("--branch <name>", "branch to work on")
		.option("--base <name>", "base branch (default main)")
		.option("--wait", "poll until the run reaches a terminal phase")
		.action(
			async (opts: {
				repo: string;
				prompt: string;
				runtime?: string;
				provider?: string;
				model?: string;
				branch?: string;
				base?: string;
				wait?: boolean;
			}) => {
				const report = await runFleet(
					{
						action: "dispatch",
						repo: opts.repo,
						prompt: opts.prompt,
						...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
						...(opts.provider !== undefined ? { provider: opts.provider } : {}),
						...(opts.model !== undefined ? { model: opts.model } : {}),
						...(opts.branch !== undefined ? { branch: opts.branch } : {}),
						...(opts.base !== undefined ? { baseBranch: opts.base } : {}),
						wait: opts.wait === true,
					},
					context,
				);
				for (const line of report.lines) console.log(line);
				process.exit(report.exitCode);
			},
		);

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
