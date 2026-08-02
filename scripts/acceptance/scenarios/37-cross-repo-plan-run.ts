/**
 * Scenario 37 — cross-repo plan-run routing and serial merge gating.
 *
 * A coordination project owns the plan and seeds while two separately
 * registered execution projects receive the child workspaces. The in-proc
 * harness uses the claude-code stub and the canned GitHub merge response, so
 * this exercises the complete HTTP/clone/dispatch/reap/coordinator path
 * without external repositories or credentials.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

const META_URL = "https://github.com/warren-acceptance/cross-repo-meta.git";
const CHILD_A_URL = "https://github.com/warren-acceptance/cross-repo-child-a.git";
const CHILD_B_URL = "https://github.com/warren-acceptance/cross-repo-child-b.git";
const PLAN_ID = "pl-acc-37";
const SEED_A = "ah-acc-37-a";
const SEED_B = "ah-acc-37-b";
const SEED_TS = "2026-05-15T00:00:00.000Z";
const DEADLINE_MS = 120_000;

interface ProjectRow {
	readonly id: string;
	readonly localPath: string;
	readonly gitUrl: string;
	readonly defaultBranch: string;
	readonly hasSeeds?: boolean;
}

interface PlanRunDetail {
	readonly planRun: { readonly state: string };
	readonly children: readonly {
		readonly seq: number;
		readonly seedId: string;
		readonly runId: string | null;
		readonly state: string;
	}[];
	readonly runs: readonly Record<string, unknown>[];
}

interface EventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

export const scenario: Scenario = {
	id: "37",
	title:
		"Cross-repo plan-run — coordination seed owns the plan while two tagged children execute in separate repos and merge serially",
	modes: ["in-proc"],
	async run(ctx) {
		const root = await mkdtemp(join(tmpdir(), "warren-acceptance-37-"));
		const metaPath = join(root, "meta");
		const childAPath = join(root, "child-a");
		const childBPath = join(root, "child-b");
		const gitConfigPath = join(root, "git-config");
		await buildFixture({
			fixturePath: metaPath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitUrl: META_URL,
			seeds: true,
		});
		await buildFixture({
			fixturePath: childAPath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitUrl: CHILD_A_URL,
			seeds: false,
		});
		await buildFixture({
			fixturePath: childBPath,
			sourceSamplePath: ctx.fixtures.sampleProjectPath,
			gitConfigPath,
			harnessGitConfigPath: join(ctx.tmp, "git-config"),
			gitUrl: CHILD_B_URL,
			seeds: false,
		});

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(root, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_STUB_SLEEP_MS: "0",
					WARREN_GH_FETCH_OVERRIDE: "merged",
					WARREN_PLAN_RUN_TICK_MS: "1000",
				},
			});
			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
			await http.expectStatus("POST", "/agents/refresh", 200);

			const meta = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: META_URL },
			});
			const childA = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: CHILD_A_URL },
			});
			const childB = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: CHILD_B_URL },
			});
			assertEqual(meta.hasSeeds, true, "coordination project has seeds");
			assertTrue(childA.id !== meta.id && childB.id !== meta.id, "child projects are distinct");

			const created = await http.expectJson<{
				planRun: { id: string };
				children: readonly unknown[];
			}>("POST", "/plan-runs", 201, {
				body: {
					project: meta.id,
					planId: PLAN_ID,
					agent: "claude-code",
					promptTemplate: "closeseed {seed_id}",
				},
			});
			assertEqual(created.children.length, 2, "two tagged child rows are created");

			const detail = await waitForPlanState(http, created.planRun.id, "succeeded");
			assertEqual(detail.children.length, 2, "plan detail retains both children");
			assertTrue(
				detail.children.every((child) => child.state === "merged"),
				"both children merge",
			);
			for (const [child, expectedProject] of [
				[detail.children[0], childA],
				[detail.children[1], childB],
			] as const) {
				if (child === undefined) throw new AcceptanceError("missing cross-repo child row");
				const run = detail.runs.find((candidate) => candidate.id === child.runId);
				assertTrue(run !== undefined, `run exists for child seq=${child.seq}`);
				assertEqual(
					run.projectId,
					expectedProject.id,
					`child seq=${child.seq} executes in tagged project`,
				);
			}

			const metaSeedBody = await readFile(join(meta.localPath, ".seeds", "issues.jsonl"), "utf8");
			const metaSeedRows = metaSeedBody
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map(
					(line) =>
						JSON.parse(line) as { id?: string; extensions?: { warren?: { lastRunId?: string } } },
				);
			for (const seedId of [SEED_A, SEED_B]) {
				const row = metaSeedRows.find((candidate) => candidate.id === seedId);
				assertTrue(
					row?.extensions?.warren?.lastRunId !== undefined,
					`${seedId} stamped in coordination repo`,
				);
			}

			const events = await fetchEvents(http, created.planRun.id);
			const dispatched = events.filter((event) => event.kind === "plan_run.dispatched");
			const merged = events.filter((event) => event.kind === "plan_run.merged");
			assertEqual(dispatched.length, 2, "two dispatch events are emitted");
			assertEqual(merged.length, 2, "two merge events are emitted");
			const secondDispatch = events.findIndex(
				(event) => event.kind === "plan_run.dispatched" && event.payload?.seq === 2,
			);
			const firstMerge = events.findIndex(
				(event) => event.kind === "plan_run.merged" && event.payload?.seq === 1,
			);
			assertTrue(
				firstMerge >= 0 && secondDispatch > firstMerge,
				"child 2 dispatch waits for child 1 merge",
			);
		} finally {
			if (handle !== undefined) await handle.stop().catch(() => undefined);
		}
	},
};

interface BuildFixtureInput {
	readonly fixturePath: string;
	readonly sourceSamplePath: string;
	readonly harnessGitConfigPath: string;
	readonly gitConfigPath: string;
	readonly gitUrl: string;
	readonly seeds: boolean;
}

async function buildFixture(input: BuildFixtureInput): Promise<void> {
	await mkdir(join(input.fixturePath, "tools"), { recursive: true });
	const burrowToml = await readFile(join(input.sourceSamplePath, "burrow.toml"), "utf8");
	await writeFile(join(input.fixturePath, "burrow.toml"), burrowToml);
	await copyFile(
		join(input.sourceSamplePath, "tools", "stub-agent.sh"),
		join(input.fixturePath, "tools", "stub-agent.sh"),
	);
	await copyFile(
		join(input.sourceSamplePath, "tools", "claude-code-stub-agent.sh"),
		join(input.fixturePath, "tools", "claude-code-stub-agent.sh"),
	);
	await writeFile(join(input.fixturePath, "README.md"), `# scenario 37 fixture ${input.gitUrl}\n`);
	if (input.seeds) {
		await mkdir(join(input.fixturePath, ".seeds"), { recursive: true });
		await writeFile(
			join(input.fixturePath, ".seeds", "config.yaml"),
			'project: "cross-repo-meta"\nversion: "1"\nmax_plan_depth: 3\n',
		);
		await writeFile(join(input.fixturePath, ".seeds", "issues.jsonl"), issuesRows());
		await writeFile(join(input.fixturePath, ".seeds", "plans.jsonl"), planRow());
	}
	const env = gitEnv();
	await runIn(input.fixturePath, ["git", "init", "--initial-branch=main"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/stub-agent.sh"], env);
	await runIn(input.fixturePath, ["chmod", "+x", "tools/claude-code-stub-agent.sh"], env);
	await runIn(input.fixturePath, ["git", "add", "."], env);
	await runIn(
		input.fixturePath,
		["git", "commit", "-m", "init: cross-repo acceptance fixture"],
		env,
	);
	const harnessConfig = existsSync(input.harnessGitConfigPath)
		? await readFile(input.harnessGitConfigPath, "utf8")
		: "";
	const lines = [
		harnessConfig.trimEnd(),
		`[url "${input.fixturePath}"]`,
		`\tinsteadOf = ${input.gitUrl}`,
		"",
	];
	await writeFile(input.gitConfigPath, `${lines.join("\n")}\n`);
}

function issuesRows(): string {
	return `${[
		JSON.stringify({
			id: SEED_A,
			title: `scenario-37 ${SEED_A}`,
			description: "child A",
			status: "open",
			type: "task",
			priority: 3,
			extensions: { repo: CHILD_A_URL },
			createdAt: SEED_TS,
			updatedAt: SEED_TS,
		}),
		JSON.stringify({
			id: SEED_B,
			title: `scenario-37 ${SEED_B}`,
			description: "child B",
			status: "open",
			type: "task",
			priority: 3,
			extensions: { repo: CHILD_B_URL },
			createdAt: SEED_TS,
			updatedAt: SEED_TS,
		}),
	].join("\n")}\n`;
}

function planRow(): string {
	return `${JSON.stringify({
		id: PLAN_ID,
		seed: "warren-acc-37",
		template: "feature",
		status: "approved",
		revision: 1,
		sections: {
			context: "cross-repo acceptance",
			approach: "tag each child",
			steps: [
				{ title: `close ${SEED_A}`, repo: CHILD_A_URL },
				{ title: `close ${SEED_B}`, repo: CHILD_B_URL },
			],
		},
		children: [SEED_A, SEED_B],
		createdAt: SEED_TS,
		updatedAt: SEED_TS,
		name: "scenario-37 cross-repo plan",
	})}\n`;
}

async function waitForPlanState(
	http: WarrenHttp,
	planRunId: string,
	target: string,
): Promise<PlanRunDetail> {
	const started = Date.now();
	let last = "unknown";
	while (Date.now() - started < DEADLINE_MS) {
		const detail = await http.expectJson<PlanRunDetail>(
			"GET",
			`/plan-runs/${encodeURIComponent(planRunId)}`,
			200,
		);
		last = detail.planRun.state;
		if (last === target) return detail;
		if (["failed", "cancelled"].includes(last))
			throw new AcceptanceError(`scenario-37 plan-run ended ${last}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new AcceptanceError(`scenario-37 plan-run did not reach ${target}; last=${last}`);
}

async function fetchEvents(http: WarrenHttp, planRunId: string): Promise<EventRow[]> {
	const rows: EventRow[] = [];
	for await (const row of http.streamNdjson(`/plan-runs/${encodeURIComponent(planRunId)}/events`))
		rows.push(row as EventRow);
	return rows;
}

interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
}

async function runIn(
	cwd: string,
	cmd: readonly string[],
	env: Record<string, string>,
): Promise<RunResult> {
	const proc = Bun.spawn({
		cmd: [...cmd],
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0)
		throw new AcceptanceError(`scenario-37 command failed: ${cmd.join(" ")}\n${stderr}\n${stdout}`);
	return { stdout, stderr };
}

function gitEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "/tmp",
		GIT_AUTHOR_NAME: "Warren Acceptance",
		GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
		GIT_COMMITTER_NAME: "Warren Acceptance",
		GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
	};
}
