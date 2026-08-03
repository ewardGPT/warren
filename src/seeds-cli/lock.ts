/**
 * Safe write lock for warren-side mutations to a project's `.seeds/`
 * (warren-f6b5).
 *
 * The warren control plane is one process, but several async paths mutate a
 * project clone's seeds queue concurrently: the scheduler tick's
 * `sd update` (extensions), the post-dispatch `sd update`, the reap
 * `post_reap` hook's `sd close`, and the plan-run child-close worktree
 * commit. All are read-modify-write against the same `.seeds/issues.jsonl`
 * and git index, so interleaved calls can clobber unrelated rows (one
 * writer's `id` line dropped by another's snapshot) or fight over the git
 * index while committing. The lock serializes them per project clone so
 * each mutation is atomic within this process.
 *
 * Mirrors the Promise-chain mutex used by the preview port allocator
 * (`src/preview/port-allocator.ts`): acquire chains onto the previous
 * holder's tail, so concurrent callers run strictly one-at-a-time and the
 * lock is released even when the critical section throws.
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the per-project seeds write lock. Waits for any
 * in-flight mutation of the same clone to settle before starting, and
 * releases before resolving or rejecting. Safe to call from the tick,
 * post-dispatch, reap, and plan-run close paths for one project.
 */
export async function withSeedsWriteLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
	const previous = tails.get(projectPath) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	tails.set(projectPath, tail);
	try {
		await previous;
		return await fn();
	} finally {
		release();
		if (tails.get(projectPath) === tail) {
			tails.delete(projectPath);
		}
	}
}
