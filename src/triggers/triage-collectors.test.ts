import { describe, expect, test } from "bun:test";
import { createGithubTriageCollector, type TriageCommandRunner } from "./triage-collectors.ts";

function runner(outputs: Record<string, string>): TriageCommandRunner {
	return {
		run: async (_command, args) =>
			outputs[args[0] === "run" ? "ci" : args[1] === "list" ? "issue" : "commit"] ?? "",
	};
}

describe("GitHub triage collector", () => {
	test("normalizes CI, issue, and commit signals", async () => {
		const collect = createGithubTriageCollector({
			command: runner({
				ci: JSON.stringify([
					{
						databaseId: 7,
						name: "checks",
						headBranch: "main",
						conclusion: "failure",
						url: "https://github.com/acme/app/actions/runs/7",
						createdAt: "2026-08-02T00:00:00Z",
					},
				]),
				issue: JSON.stringify([
					{
						number: 4,
						title: "Security fix",
						body: "details",
						url: "https://github.com/acme/app/issues/4",
						labels: [{ name: "security" }],
						updatedAt: "2026-08-02T01:00:00Z",
					},
				]),
				commit: "abc\t2026-08-02T02:00:00Z\tfix: race\n",
			}),
		});
		const findings = await collect({
			projectId: "p1",
			projectPath: "/tmp/app",
			gitUrl: "https://github.com/acme/app.git",
			now: new Date(),
		});
		expect(findings.map((finding) => finding.source)).toEqual(["ci", "issue", "commit"]);
		expect(findings[1]?.severity).toBe("critical");
	});

	test("continues when one source is unavailable", async () => {
		const collect = createGithubTriageCollector({
			command: {
				run: async (_command, args) => {
					if (args[0] === "run") throw new Error("not authenticated");
					if (args[1] === "list") return "[]";
					return "abc\t2026-08-02T02:00:00Z\tchore: docs\n";
				},
			},
		});
		const findings = await collect({
			projectId: "p1",
			projectPath: "/tmp/app",
			gitUrl: "git@github.com:acme/app.git",
			now: new Date(),
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]?.source).toBe("commit");
	});

	test("ignores non-GitHub projects", async () => {
		const findings = await createGithubTriageCollector({ command: runner({}) })({
			projectId: "p1",
			projectPath: "/tmp/app",
			gitUrl: "https://git.example.com/acme/app.git",
			now: new Date(),
		});
		expect(findings).toEqual([]);
	});
});
