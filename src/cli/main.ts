#!/usr/bin/env bun
/**
 * `warren` / `wr` CLI entry.
 *
 * Five subcommands, all dispatching into pure functions in `./commands/`.
 * The dispatch is intentionally thin: commander handles argv parsing and
 * help text, then each command function takes a `CliContext` (env +
 * stdio + spawn) plus parsed args and returns an `exitCode`. That shape
 * keeps the per-command logic unit-testable without spinning up a real
 * subprocess.
 */

import { Command } from "commander";
import { openDatabase } from "../db/client.ts";
import { parseDatabaseUrl } from "../db/url.ts";
import { VERSION } from "../index.ts";
import { loadProjectsConfigFromEnv } from "../projects/config.ts";
import { resolvePublicAllowlist } from "../projects/public-allowlist.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { resolveLocalRunBackend } from "../runtime/local/diagnostics/burrow.ts";
import { loadTriggerSchedulerConfigFromEnv } from "../triggers/config.ts";
import { runAddProject } from "./commands/add-project.ts";
import { runBestOf } from "./commands/best-of.ts";
import { runConfigMigrate } from "./commands/config-migrate.ts";
import { runMigrateToPostgres } from "./commands/db.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { registerPlanCommands } from "./commands/plan-group.ts";
import { runRun } from "./commands/run.ts";
import { runSeedDrain } from "./commands/seed-drain.ts";
import { runServe } from "./commands/serve.ts";
import { withCliDb } from "./context.ts";
import { type CliContext, defaultSpawn, formatError, PROCESS_STDIO } from "./output.ts";

/** Parse an optional integer millisecond option; undefined or blank → undefined. */
function parseMs(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

interface SeedDrainCliOptions {
	agent: string;
	project?: string;
	prompt?: string;
	provider?: string;
	model?: string;
	timeoutMs?: string;
	pollMs?: string;
}

/**
 * `warren seed-drain` body: boot the DB + run backend, run the lane, and
 * return its exit code. A module-level helper keeps the commander action's
 * cognitive complexity inside the project ceiling.
 */
async function runSeedDrainCommand(
	context: CliContext,
	seedId: string,
	opts: SeedDrainCliOptions,
): Promise<number> {
	return await withCliDb({ env: context.env }, async ({ repos }) => {
		await seedBuiltinAgents(repos.agents, undefined, context.now);
		const backend = resolveLocalRunBackend(context.env);
		const timeoutMs = parseMs(opts.timeoutMs);
		const pollMs = parseMs(opts.pollMs);
		try {
			const result = await runSeedDrain(
				context,
				{
					repos,
					runtimeProvider: backend.runtimeProvider,
					seedsCli: {
						sdBinary: loadTriggerSchedulerConfigFromEnv(context.env).sdBinary,
						spawn: defaultSpawn,
					},
					...(context.env.GITHUB_TOKEN !== undefined
						? { githubToken: context.env.GITHUB_TOKEN }
						: {}),
				},
				{
					seedId,
					agent: opts.agent,
					...(opts.project !== undefined ? { project: opts.project } : {}),
					...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
					...(opts.provider !== undefined ? { provider: opts.provider } : {}),
					...(opts.model !== undefined ? { model: opts.model } : {}),
					...(timeoutMs !== undefined ? { timeoutMs } : {}),
					...(pollMs !== undefined ? { pollMs } : {}),
				},
			);
			return result.exitCode;
		} finally {
			await backend.close();
		}
	});
}

export function buildProgram(context: CliContext): Command {
	const program = new Command();
	program
		.name("warren")
		.description("Control plane and UI for cloud-based custom agents")
		.version(VERSION)
		.exitOverride((err) => {
			// Let commander handle --help / --version exits, but never let it
			// kill the process from inside a test harness. Re-throwing here
			// surfaces the error to the caller.
			throw err;
		});

	program
		.command("add-project")
		.description("clone a GitHub repo into the projects root and persist it")
		.argument("<git-url>", "GitHub URL (https or git@)")
		.option("--default-branch <name>", "override the auto-detected default branch")
		.action(async (gitUrl: string, opts: { defaultBranch?: string }) => {
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const projectsConfig = loadProjectsConfigFromEnv(context.env);
				// warren-0883: the CLI used to bypass the public-instance
				// allowlist that `POST /projects` enforces. Resolve it here
				// (public mode with a missing/empty list throws, exactly like
				// server boot) and forward it into `addProject`, the single
				// enforcement site both surfaces share. The CLI cannot import
				// the server's `resolveAuthKind` (check:layers), so it reads
				// the selector directly.
				const publicAllowlist = resolvePublicAllowlist(
					context.env.WARREN_AUTH?.trim() === "public",
					context.env,
				);
				const result = await runAddProject(
					context,
					{
						projects: repos.projects,
						projectsConfig,
						...(publicAllowlist !== undefined ? { publicAllowlist } : {}),
					},
					{
						gitUrl,
						...(opts.defaultBranch !== undefined ? { defaultBranch: opts.defaultBranch } : {}),
					},
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("run")
		.description("spawn a one-shot run, tail events as NDJSON, and exit")
		.argument("<agent>", "registered agent name")
		.argument("<project>", "project id (prj_xxx)")
		.requiredOption("-p, --prompt <text>", "prompt text the agent receives")
		.option("--trigger <label>", "run trigger label", "cli")
		.option("--provider <name>", "per-run override of agent frontmatter.provider")
		.option("--model <name>", "per-run override of agent frontmatter.model")
		.action(
			async (
				agent: string,
				project: string,
				opts: {
					prompt: string;
					trigger?: string;
					provider?: string;
					model?: string;
				},
			) => {
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					// Seed built-ins so `warren run claude-code <prj> -p ...` works
					// against a fresh DB without first registering the agent from
					// a canopy library (warren-d3e9). Idempotent against existing
					// rows.
					await seedBuiltinAgents(repos.agents, undefined, context.now);
					// warren-11cc: resolve the run backend once (honoring WARREN_RUNTIME).
					// The local backend lazily builds a single burrow client + preview
					// seam; under k8s no burrow client is constructed. Direct burrow
					// access is confined to `resolveLocalRunBackend`
					// (src/runtime/local/diagnostics/burrow.ts).
					const backend = resolveLocalRunBackend(context.env);
					try {
						const result = await runRun(
							context,
							{
								repos,
								runtimeProvider: backend.runtimeProvider,
								...(backend.previewSidecars !== undefined
									? { previewSidecars: backend.previewSidecars }
									: {}),
							},
							{
								agent,
								project,
								prompt: opts.prompt,
								...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
								...(opts.provider !== undefined ? { providerOverride: opts.provider } : {}),
								...(opts.model !== undefined ? { modelOverride: opts.model } : {}),
							},
						);
						return result.exitCode;
					} finally {
						await backend.close();
					}
				});
				process.exit(exitCode);
			},
		);

	program
		.command("best-of")
		.description("contest N competing replicates of one prompt, ranked by verified scorecards")
		.argument("<agent>", "registered agent name")
		.argument("<project>", "project id (prj_xxx)")
		.requiredOption("-p, --prompt <text>", "prompt text every replicate receives")
		.option("-r, --replicates <n>", "number of competing replicates (2..5)", "2")
		.option("--seed <id>", "seed id attached to every replicate")
		.option("--tiers <list>", "comma-separated model overrides, cycled per replicate")
		.action(
			async (
				agent: string,
				project: string,
				opts: {
					prompt: string;
					replicates?: string;
					seed?: string;
					tiers?: string;
				},
			) => {
				const replicates = Number(opts.replicates);
				if (!Number.isInteger(replicates) || replicates < 2 || replicates > 5) {
					context.stdio.stderr.write("warren: --replicates must be an integer from 2 to 5\n");
					process.exit(2);
				}
				const tiers = opts.tiers
					?.split(",")
					.map((tier) => tier.trim())
					.filter((tier) => tier !== "");
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					await seedBuiltinAgents(repos.agents, undefined, context.now);
					const backend = resolveLocalRunBackend(context.env);
					try {
						const result = await runBestOf(
							context,
							{ repos, runtimeProvider: backend.runtimeProvider },
							{
								agent,
								project,
								prompt: opts.prompt,
								...(opts.seed !== undefined ? { seedId: opts.seed } : {}),
								replicates,
								...(tiers !== undefined && tiers.length > 0 ? { tiers } : {}),
							},
						);
						return result.exitCode;
					} finally {
						await backend.close();
					}
				});
				process.exit(exitCode);
			},
		);

	program
		.command("seed-drain")
		.description("dispatch a run for one seed, wait for its PR, and close the seed on merge")
		.argument("<seed-id>", "seed id to drain (resolved to its home project)")
		.requiredOption("--agent <name>", "registered agent name to dispatch")
		.option("--project <id>", "home project id (default: resolve the seed across projects)")
		.option("-p, --prompt <text>", "prompt template; {seed_id} and {seed_body} are substituted")
		.option("--provider <name>", "per-run override of agent frontmatter.provider")
		.option("--model <name>", "per-run override of agent frontmatter.model")
		.option("--timeout-ms <n>", "wait budget in milliseconds; 0 disables the bound")
		.option("--poll-ms <n>", "poll cadence in milliseconds")
		.action(async (seedId: string, opts: SeedDrainCliOptions) => {
			process.exit(await runSeedDrainCommand(context, seedId, opts));
		});

	program
		.command("init")
		.description("scaffold a .warren/ directory (triggers.yaml + config.yaml) in a project repo")
		.option("--project <id>", "target a registered project by id (writes into its warren clone)")
		.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())")
		.option("--default-role <name>", "pin defaults.defaultRole to this registered agent")
		.action(async (opts: { project?: string; cwd?: string; defaultRole?: string }) => {
			if (opts.project !== undefined && opts.cwd !== undefined) {
				context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
				process.exit(2);
			}
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				// Must await (warren-e376): --default-role validation reads the
				// registry immediately after; an un-awaited seed lets the read
				// race ahead on a fresh DB and reject built-in names like
				// claude-code as "unknown agent" (acceptance scenario 17).
				await seedBuiltinAgents(repos.agents, undefined, context.now);
				const args =
					opts.project !== undefined
						? {
								mode: "project" as const,
								projectId: opts.project,
								...(opts.defaultRole !== undefined ? { defaultRole: opts.defaultRole } : {}),
							}
						: {
								mode: "cwd" as const,
								cwd: opts.cwd ?? process.cwd(),
								...(opts.defaultRole !== undefined ? { defaultRole: opts.defaultRole } : {}),
							};
				const result = await runInit(
					context,
					{ projects: repos.projects, agents: repos.agents },
					args,
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	// `config` is a subcommand group rather than a flat top-level so future
	// .warren/ admin tools (validate, dump, edit) can land alongside without
	// inflating warren's first-page help. Today it has one child:
	// `migrate` (warren-5840 — defaults.json → config.yaml + preview.yaml).
	const configGroup = program.command("config").description(".warren/ admin tools");
	configGroup
		.command("migrate")
		.description(
			"convert legacy .warren/defaults.json into the warren-5840 YAML layout (config.yaml + preview.yaml)",
		)
		.option("--project <id>", "target a registered project by id (writes into its warren clone)")
		.option("--cwd <path>", "target a directory on disk (defaults to process.cwd())")
		.action(async (opts: { project?: string; cwd?: string }) => {
			if (opts.project !== undefined && opts.cwd !== undefined) {
				context.stdio.stderr.write("warren: --project and --cwd are mutually exclusive\n");
				process.exit(2);
			}
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const args =
					opts.project !== undefined
						? { mode: "project" as const, projectId: opts.project }
						: { mode: "cwd" as const, cwd: opts.cwd ?? process.cwd() };
				const result = await runConfigMigrate(context, { projects: repos.projects }, args);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	program
		.command("doctor")
		.description("check warren's environment: env vars, burrow socket")
		.option("--no-auth", "skip the WARREN_API_TOKEN check (loopback dev mode)")
		.option("--verbose", "print raw probe/driver output (withheld from check messages) to stderr")
		.action(async (opts: { auth?: boolean; verbose?: boolean }) => {
			// commander turns `--no-auth` into `opts.auth === false`.
			// Open the DB so the warren_config check can walk every
			// registered project. A missing DB file is fine — withCliDb's
			// openDatabase creates one on first use; an empty projects
			// table produces an informational `ok: true`.
			const exitCode = await withCliDb({ env: context.env }, async ({ db, repos }) => {
				const projects = (await repos.projects.listAll()).map((p) => ({
					id: p.id,
					localPath: p.localPath,
				}));
				const result = await runDoctor(
					context,
					{ projects, db },
					{ noAuth: opts.auth === false, verbose: opts.verbose === true },
				);
				return result.exitCode;
			});
			process.exit(exitCode);
		});

	// `db` is a subcommand group rather than a flat top-level so future
	// db-admin tools (dump, restore, prune) can land alongside without
	// inflating warren's first-page help. Today it has one child:
	// `migrate-to-postgres` (R-13, pl-f17e step 8, warren-14ac).
	const dbGroup = program.command("db").description("database admin tools");
	dbGroup
		.command("migrate-to-postgres")
		.description("one-shot copy of a SQLite warren.db into a Postgres database")
		.requiredOption(
			"--from <sqlite>",
			"source SQLite path or URL (bare path, sqlite://, file://, :memory:)",
		)
		.requiredOption("--to <pg-url>", "target Postgres URL (postgres:// or postgresql://)")
		.action(async (opts: { from: string; to: string }) => {
			const fromParsed = parseDatabaseUrl(opts.from);
			if (fromParsed.dialect !== "sqlite") {
				context.stdio.stderr.write(
					`warren: --from must be a SQLite source (got dialect=${fromParsed.dialect})\n`,
				);
				process.exit(2);
			}
			const toParsed = parseDatabaseUrl(opts.to);
			if (toParsed.dialect !== "postgres") {
				context.stdio.stderr.write(
					`warren: --to must be a Postgres URL (got dialect=${toParsed.dialect})\n`,
				);
				process.exit(2);
			}
			// Source: open read-only-style. We don't run sqlite migrations
			// against an existing operator warren.db — the schema is
			// already at the journal head, and skipping migrations keeps
			// the tool from touching the source's mtime.
			const source = await openDatabase({ url: opts.from, skipMigrations: true });
			if (source.dialect !== "sqlite") {
				// Belt-and-suspenders: parseDatabaseUrl already enforced this.
				await source.close().catch(() => undefined);
				throw new Error(`expected sqlite source, got ${source.dialect}`);
			}
			// Target: open with migrations so a freshly-provisioned pg
			// database (empty schema) lands at the right journal head
			// before we copy rows into it.
			const target = await openDatabase({ url: opts.to });
			if (target.dialect !== "postgres") {
				await source.close().catch(() => undefined);
				await target.close().catch(() => undefined);
				throw new Error(`expected postgres target, got ${target.dialect}`);
			}
			try {
				const result = await runMigrateToPostgres(context, { source, target });
				process.exit(result.exitCode);
			} finally {
				await source.close().catch(() => undefined);
				await target.close().catch(() => undefined);
			}
		});

	// `plan` is a thin HTTP-client subcommand group (warren-ec6a, pl-55df) —
	// the first command family that talks to a remote warren via
	// WarrenClient.fromEnv rather than opening a local DB with withCliDb.
	registerPlanCommands(program, context);

	program
		.command("serve")
		.description("start the HTTP server (default in docker entrypoint)")
		.option("--no-auth", "boot without bearer-token auth (loopback only)")
		.action(async (opts: { auth?: boolean }) => {
			const result = await runServe(context, {}, { noAuth: opts.auth === false });
			process.exit(result.exitCode);
		});

	return program;
}

if (import.meta.main) {
	const context: CliContext = {
		env: process.env,
		stdio: PROCESS_STDIO,
		spawn: defaultSpawn,
	};
	const program = buildProgram(context);
	program.parseAsync(process.argv).catch((err) => {
		// Commander throws for unknown commands / missing required args;
		// it has already printed a usage hint to stderr.
		const code = (err as { exitCode?: unknown }).exitCode;
		if (typeof code === "number") {
			process.exit(code);
		}
		process.stderr.write(`warren: ${formatError(err)}\n`);
		process.exit(1);
	});
}
