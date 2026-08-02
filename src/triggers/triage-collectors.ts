import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TriageCollector, TriageFinding } from "./triage-inbox.ts";

const execFileAsync = promisify(execFile);

export interface TriageCommandRunner {
	readonly run: (command: string, args: readonly string[], cwd: string) => Promise<string>;
}

export interface GithubTriageCollectorOptions {
	readonly githubToken?: string;
	readonly command?: TriageCommandRunner;
	readonly limit?: number;
}

/** Collect actionable, read-only signals from the project's GitHub repo and git history. */
export function createGithubTriageCollector(
	options: GithubTriageCollectorOptions = {},
): TriageCollector {
	const command = options.command ?? defaultCommandRunner(options.githubToken);
	const limit = options.limit ?? 20;
	return async (input) => {
		const repo = input.gitUrl === undefined ? null : parseGithubRepo(input.gitUrl);
		if (repo === null) return [];
		const findings: TriageFinding[] = [];
		await collectSafely(async () => {
			const raw = await command.run(
				"gh",
				[
					"run",
					"list",
					"--repo",
					repo,
					"--limit",
					String(limit),
					"--json",
					"databaseId,name,headBranch,status,conclusion,url,createdAt",
				],
				input.projectPath,
			);
			for (const run of parseJson<ReadonlyArray<GithubRun>>(raw)) {
				if (run.conclusion !== "failure") continue;
				findings.push({
					key: `ci:${repo}:${run.databaseId}`,
					source: "ci",
					title: `CI failed: ${run.name}`,
					detail: `Branch ${run.headBranch} reported a failed workflow run.`,
					url: run.url,
					severity: "high",
					discoveredAt: run.createdAt,
					status: "open",
				});
			}
		});
		await collectSafely(async () => {
			const raw = await command.run(
				"gh",
				[
					"issue",
					"list",
					"--repo",
					repo,
					"--state",
					"open",
					"--limit",
					String(limit),
					"--json",
					"number,title,body,url,labels,updatedAt",
				],
				input.projectPath,
			);
			for (const issue of parseJson<ReadonlyArray<GithubIssue>>(raw)) {
				findings.push({
					key: `issue:${repo}:${issue.number}`,
					source: "issue",
					title: issue.title,
					detail: issue.body?.slice(0, 500),
					url: issue.url,
					severity: issue.labels.some((label) => /critical|security/i.test(label.name))
						? "critical"
						: "medium",
					discoveredAt: issue.updatedAt,
					status: "open",
				});
			}
		});
		await collectSafely(async () => {
			const raw = await command.run(
				"git",
				["log", `-${limit}`, "--date=iso-strict", "--format=%H%x09%aI%x09%s"],
				input.projectPath,
			);
			for (const line of raw.split("\n").filter(Boolean)) {
				const [sha, authoredAt, ...subject] = line.split("\t");
				if (sha === undefined || authoredAt === undefined || subject.length === 0) continue;
				findings.push({
					key: `commit:${repo}:${sha}`,
					source: "commit",
					title: `Recent commit: ${subject.join("\t")}`,
					detail: sha,
					discoveredAt: authoredAt,
					status: "open",
				});
			}
		});
		return findings;
	};
}

function defaultCommandRunner(githubToken?: string): TriageCommandRunner {
	return {
		run: async (command, args, cwd) =>
			(
				await execFileAsync(command, [...args], {
					cwd,
					env: githubToken === undefined ? process.env : { ...process.env, GH_TOKEN: githubToken },
					maxBuffer: 2_000_000,
				})
			).stdout,
	};
}

async function collectSafely(collect: () => Promise<void>): Promise<void> {
	try {
		await collect();
	} catch {
		// A missing gh login or shallow git checkout must not erase other signals.
	}
}

function parseGithubRepo(url: string): string | null {
	const match = url.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i);
	return match === null ? null : `${match[1]}/${match[2]}`;
}

function parseJson<T>(raw: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return [] as T;
	}
}

interface GithubRun {
	readonly databaseId: number;
	readonly name: string;
	readonly headBranch: string;
	readonly conclusion: string | null;
	readonly url: string;
	readonly createdAt: string;
}
interface GithubIssue {
	readonly number: number;
	readonly title: string;
	readonly body?: string;
	readonly url: string;
	readonly labels: readonly { readonly name: string }[];
	readonly updatedAt: string;
}
