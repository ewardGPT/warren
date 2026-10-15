/**
 * Per-box project materialization: the fleet backend's answer to "the workspace
 * must exist ON THE BOX".
 *
 * FACT THIS MODULE EXISTS FOR. burrow does not clone a repository. It cuts a git
 * WORKTREE off a clone that already lives on the host, and the provider must
 * name that clone (`RunSpec.hostClonePathHint`). Locally the domain passes its
 * own project root, which is correct because the host IS the host. On a fleet
 * box that path means nothing, so the fleet provider materializes a box-side
 * clone first and hands BURROW the box path. This keeps the contract's promise
 * that the provider owns workspace materialization (burrow: internal, K8s: init
 * container, fleet: ssh + git) without touching any other backend.
 *
 * Layout: `<root>/<projectKey>` on the box, where the key is derived from the
 * origin URL so two projects can never collide in one directory, and a re-run of
 * the same project reuses the clone (fetch, never re-clone).
 *
 * Clone-once, fetch-after. A fetch failure does NOT fail the run when a usable
 * clone already exists: the base branch may be a little stale, and refusing to
 * work is worse than working from a stale base. The first clone is the
 * load-bearing case and a failure there is fatal, because there is nothing to
 * cut a worktree from.
 *
 * Credentials are the box's own. A private origin needs the box to hold a key or
 * a token for it; warren does not forward the operator's git credentials, and
 * this module does not try to.
 */

import { createHash } from "node:crypto";
import type { SshRunner } from "./remote-seams.ts";

export const DEFAULT_BOX_PROJECT_ROOT = "/home/ubuntu/.warren/projects";
export const BOX_PROJECT_ROOT_ENV = "WARREN_FLEET_PROJECT_ROOT";

export function boxProjectRoot(env: Record<string, string | undefined>): string {
	const root = env[BOX_PROJECT_ROOT_ENV];
	return root !== undefined && root !== "" ? root.replace(/\/+$/, "") : DEFAULT_BOX_PROJECT_ROOT;
}

/**
 * A stable, filesystem-safe directory name for an origin URL. The basename keeps
 * it readable; the digest makes two different origins with the same basename
 * distinct, which is the collision that would otherwise mix two projects'
 * histories in one clone.
 */
export function projectKey(originUrl: string): string {
	const trimmed = originUrl.replace(/\/+$/, "");
	const last = trimmed.split(/[/:]/).pop() ?? "project";
	const base = last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
	const digest = createHash("sha256").update(originUrl).digest("hex").slice(0, 8);
	return `${base === "" ? "project" : base}-${digest}`;
}

export interface MaterializeDeps {
	readonly ssh: SshRunner;
	readonly env: Record<string, string | undefined>;
	readonly log?: { warn(obj: object, msg?: string): void };
}

export interface MaterializeRequest {
	readonly originUrl: string;
	readonly baseBranch: string;
}

/**
 * Ensure `originUrl` is cloned on the box at its project key, and return the BOX
 * path to hand burrow. Idempotent: the second call for a project fetches and
 * returns the same path.
 */
export async function ensureProjectClone(
	deps: MaterializeDeps,
	request: MaterializeRequest,
): Promise<string> {
	const path = `${boxProjectRoot(deps.env)}/${projectKey(request.originUrl)}`;
	const present = await hasClone(deps.ssh, path);
	if (!present) {
		const cloned = await deps.ssh.run("git", ["clone", "--quiet", request.originUrl, path]);
		if (cloned.exitCode !== 0) {
			throw new Error(
				`fleet: could not clone ${request.originUrl} on ${deps.ssh.target}: ${
					cloned.stderr.trim() || `exit ${cloned.exitCode}`
				}`,
			);
		}
		return path;
	}
	// Best-effort refresh: a stale base is a smaller problem than a dead run.
	const fetched = await deps.ssh.run("git", ["-C", path, "fetch", "--prune", "--quiet", "origin"], {
		timeoutMs: 60_000,
	});
	if (fetched.exitCode !== 0) {
		deps.log?.warn(
			{ origin: request.originUrl, target: deps.ssh.target },
			`fleet: fetch failed, using the existing clone: ${fetched.stderr.trim()}`,
		);
	}
	return path;
}

/** A directory with a `.git` entry: the cheapest honest "already cloned" test. */
async function hasClone(ssh: SshRunner, path: string): Promise<boolean> {
	const result = await ssh.run("git", ["-C", path, "rev-parse", "--git-dir"]);
	return result.exitCode === 0;
}
