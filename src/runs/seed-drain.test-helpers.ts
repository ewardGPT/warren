/**
 * Shared stubs for the seed-drain tests (ubuntu-6ab8).
 *
 * Kept beside the suite so both files inject the same fake `Repos` and
 * `SeedsCliDeps` and neither grows past the per-file size budget.
 */

import type { Repos } from "../db/repos/index.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";

export interface ProjectStub {
	id: string;
	localPath: string;
	defaultBranch: string;
	hasSeeds: boolean;
	gitUrl: string;
}

/** The slice of `Repos` the lane touches. */
export function reposStub(projects: ProjectStub[]): Pick<Repos, "projects" | "runs"> {
	const byId = new Map(projects.map((p) => [p.id, p]));
	return {
		projects: {
			listAll: async () => projects,
			get: async (id: string) => byId.get(id) ?? null,
			require: async (id: string) => {
				const found = byId.get(id);
				if (found === undefined) throw new Error(`project not found: ${id}`);
				return found;
			},
		},
		runs: {
			get: async () => null,
		},
	} as unknown as Pick<Repos, "projects" | "runs">;
}

/** A `SeedsCliDeps` that answers from a fixed seed table keyed by project path. */
export function seedsStub(
	table: Record<
		string,
		{ status: string; title?: string; description?: string; blockedBy?: string[] }
	>,
	statuses: Record<string, string> = {},
): SeedsCliDeps {
	return {
		sdBinary: "sd",
		spawn: async (cmd) => {
			const args = cmd.join(" ");
			// `sd show <id> --json`
			const showMatch = /^sd show (\S+) --json$/.exec(args);
			if (showMatch !== null) {
				const seedId = showMatch[1] as string;
				const seed = table[seedId];
				if (seed === undefined) {
					return { stdout: "", stderr: `Issue not found: ${seedId}`, exitCode: 1 };
				}
				return {
					stdout: JSON.stringify({ success: true, issue: { id: seedId, ...seed } }),
					stderr: "",
					exitCode: 0,
				};
			}
			// `sd list --format json`
			if (args === "sd list --format json") {
				return {
					stdout: JSON.stringify({
						success: true,
						issues: Object.entries(statuses).map(([id, status]) => ({ id, status })),
					}),
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "", stderr: `unexpected sd call: ${args}`, exitCode: 1 };
		},
	};
}

export const HAPPY_PROJECT: ProjectStub = {
	id: "prj_seeddrain1",
	gitUrl: "https://github.com/x/y.git",
	localPath: "/data/projects/x/y",
	defaultBranch: "main",
	hasSeeds: true,
};
