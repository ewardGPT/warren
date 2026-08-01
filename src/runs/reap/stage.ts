import { join } from "node:path";
import {
	gitRepoContextScrubEnv,
	warrenCommitIdentityArgs,
	warrenCommitIdentityEnv,
} from "../../bot-identity.ts";
import type { EventRow } from "../../db/schema.ts";
import type { ReapExec, ReapFs } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Seeds commit-through-reap (warren-7ecc)                                   */
/* ----------------------------------------------------------------------- */

/**
 * Seeds-tracker files committed by warren on the agent's behalf. The
 * SPEC for `.seeds/` (../seeds/SPEC.md) pins a flat layout of two
 * jsonl carriers — `issues.jsonl` (the issue queue) and `plans.jsonl`
 * (sd plan submit output, the planner's primary write). `config.yaml`
 * and `templates.jsonl` are committed by the human at `sd init` time
 * and don't get rewritten by agent activity, so excluding them keeps
 * the warren-authored commit narrow.
 */
const SEEDS_COMMITTABLE_FILES: readonly string[] = ["issues.jsonl", "plans.jsonl"];

interface StageSeedsForCommitInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly fs: ReapFs;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<EventRow>;
}

/**
 * Replicate `.seeds/issues.jsonl` + `.seeds/plans.jsonl` from the
 * project clone into the burrow workspace, stage `.seeds/`, and author
 * a `chore(warren): seeds state` commit when there's a real delta the
 * agent never committed. Returns true when a warren-identity commit
 * landed.
 *
 * Agents with narrowly-scoped write contracts (planner, see
 * src/registry/builtins/planner.ts) are forbidden from running
 * `git commit`. The planner's `sd plan submit` writes
 * `.seeds/issues.jsonl` + `.seeds/plans.jsonl` inside the workspace;
 * without this step the push exits zero, lands no work, and reap fires
 * `reap.empty_push`. The project clone is the union point: by this
 * step `mirrorSeeds` has already merged closed-status rows and
 * newly-created rows from the workspace back into the project's
 * `issues.jsonl`. Copying the union back into the workspace gives
 * `git push` a single canonical view to ship to origin.
 *
 * A project-level `.gitignore` of `.seeds/` is a deliberate opt-out of
 * committing seeds state. `git add` on an ignored path exits non-zero, so
 * the add below is preceded by a `git check-ignore` probe: when the
 * carriers are ignored this returns `false` (a clean no-op — no commit,
 * no `reap_failed`), while a REAL staging failure (permissions, a corrupt
 * index, …) still rejects and surfaces via finalize's `seeds_commit`
 * `reap_failed`.
 */
export async function stageSeedsForCommit(input: StageSeedsForCommitInput): Promise<boolean> {
	const { workspacePath, projectPath, fs, exec, emit } = input;
	const projectSeedsDir = join(projectPath, ".seeds");
	const workspaceSeedsDir = join(workspacePath, ".seeds");

	let copied = 0;
	for (const name of SEEDS_COMMITTABLE_FILES) {
		const contents = await fs.readFile(join(projectSeedsDir, name));
		if (contents === null) continue;
		if (copied === 0) await fs.mkdirp(workspaceSeedsDir);
		await fs.writeFile(join(workspaceSeedsDir, name), contents);
		copied += 1;
	}
	if (copied === 0) return false;

	const seedsPathspecs = SEEDS_COMMITTABLE_FILES.map((name) => join(".seeds", name));

	// warren-23dd: scrub repo-context GIT_* on every git call here so a
	// leaked GIT_DIR / GIT_INDEX_FILE can't divert the calls out of
	// `workspacePath` (mirrors clone-apply.ts). `check-ignore --quiet`
	// exits 0 when the path is gitignored — a deliberate opt-out — so we
	// return cleanly (no commit, no reap_failed); a non-ignored tree falls
	// through to the real `git add`, where a genuine staging failure still
	// rejects and surfaces via finalize's `seeds_commit` reap_failed.
	let ignored: boolean;
	try {
		await exec.run("git", ["check-ignore", "--quiet", "--", ...seedsPathspecs], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		ignored = true;
	} catch {
		ignored = false;
	}
	if (ignored) return false;

	await exec.run("git", ["add", "--", ...seedsPathspecs], {
		cwd: workspacePath,
		timeoutMs: 10_000,
		env: gitRepoContextScrubEnv(),
	});
	let hasStagedDelta: boolean;
	try {
		await exec.run("git", ["diff", "--cached", "--quiet", "--", ...seedsPathspecs], {
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: gitRepoContextScrubEnv(),
		});
		hasStagedDelta = false;
	} catch {
		hasStagedDelta = true;
	}
	if (!hasStagedDelta) return false;

	await exec.run(
		"git",
		[
			...warrenCommitIdentityArgs(),
			"commit",
			// warren-27d3: skip project git hooks for warren's bookkeeping commit.
			"--no-verify",
			// warren-be12 (#420): path-limit the commit to the two seeds
			// carriers via `--only` so pre-staged unrelated files are not
			// swept into the warren bookkeeping commit.
			"--only",
			"-m",
			"chore(warren): seeds state",
			"--",
			...seedsPathspecs,
		],
		// warren-035c: pin the bot identity in env too so an inherited
		// GIT_AUTHOR_*/GIT_COMMITTER_* can't out-rank the `-c user.*` config.
		// warren-23dd: scrub the inherited repo-context GIT_* so the commit
		// can't escape `workspacePath`; identity wins over the scrub.
		{
			cwd: workspacePath,
			timeoutMs: 10_000,
			env: { ...gitRepoContextScrubEnv(), ...warrenCommitIdentityEnv() },
		},
	);
	await emit("reap.seeds_committed", {
		message: "chore(warren): seeds state",
		filesStaged: copied,
	});
	return true;
}
