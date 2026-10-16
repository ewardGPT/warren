/**
 * `warren plan …` command group (ubuntu-6ab8).
 *
 * Extracted from `main.ts` so the program builder stays under the per-file
 * size budget, mirroring the sibling `*-wiring.ts` precedent. The `plan`
 * commands are thin HTTP consumers, so this module owns the commander wiring
 * and nothing else; `main.ts` still owns every DB-backed command.
 */

import type { Command } from "commander";
import { WarrenClient } from "../../client/index.ts";
import { PLAN_RUN_STATES, type PlanRunState } from "../../core/wire.ts";
import type { CliContext } from "../output.ts";
import type { PlanRunOutput } from "../plan-run-renderer.ts";
import { runPlanCancel, runPlanRun } from "./plan-run.ts";
import { runPlanList, runPlanStatus } from "./plan-status.ts";

/** Coerce a `--output` flag value to a {@link PlanRunOutput}, defaulting `ndjson`. */
export function parsePlanRunOutput(value: string | undefined): PlanRunOutput {
	return value === "pretty" ? "pretty" : "ndjson";
}

/** Parse a `--state` flag value against the canonical plan-run state list. */
function parsePlanRunState(value: string | undefined): PlanRunState | undefined {
	if (value === undefined) return undefined;
	return (PLAN_RUN_STATES as readonly string[]).includes(value)
		? (value as PlanRunState)
		: undefined;
}

/** A plan-run reader command: one id, one output mode, one exit code. */
interface PlanRunReaderSpec {
	readonly name: string;
	readonly description: string;
	readonly run: (
		planRunId: string,
		client: WarrenClient,
		output: PlanRunOutput,
	) => Promise<{ readonly exitCode: number }>;
}

/**
 * Register a `plan <name> <plan-run-id>` command. Both `cancel` and `status`
 * are the same shape — read one id, call the command function, exit with its
 * code — so the wiring lives here once (check:dups).
 */
function addPlanRunReader(planGroup: Command, context: CliContext, spec: PlanRunReaderSpec): void {
	planGroup
		.command(spec.name)
		.description(spec.description)
		.argument("<plan-run-id>", "plan-run id")
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(async (planRunId: string, opts: { output?: string }) => {
			const client = WarrenClient.fromEnv(context.env);
			const result = await spec.run(planRunId, client, parsePlanRunOutput(opts.output));
			process.exit(result.exitCode);
		});
}

export function registerPlanCommands(program: Command, context: CliContext): void {
	const planGroup = program.command("plan").description("dispatch and steer cloud plan-runs");

	planGroup
		.command("run")
		.description("dispatch a serial plan-run against a remote warren and tail events as NDJSON")
		.argument("<plan-id>", "seeds plan id (pl_xxx)")
		.requiredOption("--project <id>", "project id (prj_xxx)")
		.requiredOption("--agent <name>", "registered agent name")
		.option("--prompt-template <text>", "per-child prompt template override")
		.option("--ref <git-ref>", "git ref to clone child workspaces from")
		.option("--provider <name>", "per-run override of agent frontmatter.provider")
		.option("--model <name>", "per-run override of agent frontmatter.model")
		.option("--no-follow", "dispatch and exit without tailing events")
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(
			async (
				planId: string,
				opts: {
					project: string;
					agent: string;
					promptTemplate?: string;
					ref?: string;
					provider?: string;
					model?: string;
					follow: boolean;
					output?: string;
				},
			) => {
				const client = WarrenClient.fromEnv(context.env);
				const result = await runPlanRun(
					context,
					{ client },
					{
						planId,
						project: opts.project,
						agent: opts.agent,
						follow: opts.follow,
						output: parsePlanRunOutput(opts.output),
						...(opts.promptTemplate !== undefined ? { promptTemplate: opts.promptTemplate } : {}),
						...(opts.ref !== undefined ? { ref: opts.ref } : {}),
						...(opts.provider !== undefined ? { provider: opts.provider } : {}),
						...(opts.model !== undefined ? { model: opts.model } : {}),
					},
				);
				process.exit(result.exitCode);
			},
		);

	addPlanRunReader(planGroup, context, {
		name: "cancel",
		description: "cancel a remote plan-run and its in-flight child run",
		run: (id, client, output) => runPlanCancel(context, { client }, { planRunId: id, output }),
	});

	addPlanRunReader(planGroup, context, {
		name: "status",
		description: "render a plan-run's child-state table with per-child cost + duration",
		run: (id, client, output) => runPlanStatus(context, { client }, { planRunId: id, output }),
	});

	planGroup
		.command("list")
		.description("list plan-runs, optionally filtered by project / state")
		.option("--project <id>", "only plan-runs for this project (prj_xxx)")
		.option(
			"--state <state>",
			"only plan-runs in this state (queued|running|succeeded|failed|cancelled)",
		)
		.option("--output <mode>", "output mode: ndjson (default) or pretty", "ndjson")
		.action(async (opts: { project?: string; state?: string; output?: string }) => {
			const client = WarrenClient.fromEnv(context.env);
			const state = parsePlanRunState(opts.state);
			const result = await runPlanList(
				context,
				{ client },
				{
					output: parsePlanRunOutput(opts.output),
					...(opts.project !== undefined ? { project: opts.project } : {}),
					...(state !== undefined ? { state } : {}),
				},
			);
			process.exit(result.exitCode);
		});
}
