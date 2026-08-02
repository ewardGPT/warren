import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../projects/clone.ts";
import { checkCrossRepoPlanTargets } from "./checks-cross-repo.ts";

function deps(spawn: SpawnFn) {
	return { sdBinary: "sd", spawn };
}

function spawnFor(repo: string): SpawnFn {
	return async (cmd) => {
		if (cmd[1] === "plan" && cmd[2] === "list") {
			return {
				stdout: JSON.stringify({
					plans: [{ id: "pl-open", status: "approved", children: ["seed-1"] }],
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		if (cmd[1] === "plan" && cmd[2] === "show") {
			return {
				stdout: JSON.stringify({
					plan: { id: "pl-open", status: "approved", children: ["seed-1"] },
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		return {
			stdout: JSON.stringify({ issue: { id: "seed-1", status: "open", extensions: { repo } } }),
			stderr: "",
			exitCode: 0,
		};
	};
}

const projects = [
	{ id: "meta", localPath: "/meta", gitUrl: "https://github.com/x/meta.git", hasSeeds: true },
	{ id: "child", localPath: "/child", gitUrl: "https://github.com/x/child.git", hasSeeds: true },
];

describe("checkCrossRepoPlanTargets", () => {
	test("passes when every open child target resolves", async () => {
		const result = await checkCrossRepoPlanTargets({
			projects,
			seedsCli: deps(spawnFor("x/child")),
		});
		expect(result).toMatchObject({ name: "cross_repo_plan_targets", ok: true });
	});

	test("reports unresolved targets", async () => {
		const result = await checkCrossRepoPlanTargets({
			projects,
			seedsCli: deps(spawnFor("x/missing")),
		});
		expect(result.ok).toBe(false);
		expect(result.name).toBe("cross_repo_plan_targets");
		expect(result.message).toContain("x/missing");
	});

	test("degrades informationally when the seeds CLI is not wired", async () => {
		const result = await checkCrossRepoPlanTargets({ projects });
		expect(result).toMatchObject({ name: "cross_repo_plan_targets", ok: true });
	});
});
