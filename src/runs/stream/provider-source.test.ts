/**
 * Bounded post-terminal teardown coverage (warren-c433).
 *
 * `streamWithSignal`'s `finally` tears the provider stream down via
 * `iterator.return()` when the run-state poller aborts. `.return()` on an async
 * generator parked at an `await` (not a `yield`) can't interrupt that await — the
 * K8s pod-log pump parks on `await queue.pull()` waiting for a chunk that never
 * arrives when a pod terminates without a clean follow EOF, so an unbounded
 * teardown hangs FOREVER and the bridge never reaches reap. These tests prove the
 * teardown is bounded: a hung `return()` (and a hung `next()`) can never wedge the
 * generator past the ceiling.
 */

import { describe, expect, test } from "bun:test";
import type { NormalizedEvent } from "../../runtime/contract.ts";
import { DEFAULT_STREAM_TEARDOWN_MS, streamWithSignal } from "./provider-source.ts";
import type { StreamEventView } from "./types.ts";

function nevt(seq: number): NormalizedEvent {
	return {
		seq,
		ts: new Date(2026, 6, 21, 12, 0, seq).toISOString(),
		kind: "text",
		stream: "stdout",
		payload: { seq },
	};
}

/** Never-resolving promise — models the K8s pump parked on `queue.pull()`. */
function forever<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

interface HangingCounts {
	returnCalls: number;
}

/**
 * An inner async iterable that yields `events`, then parks forever on `next()`
 * (no more chunks, no EOF) AND whose `return()` also never resolves — the exact
 * shape that hung the warren-c433 incident.
 */
function hangingInner(
	events: NormalizedEvent[],
	counts: HangingCounts,
): AsyncIterable<NormalizedEvent> {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				next(): Promise<IteratorResult<NormalizedEvent>> {
					if (i < events.length) {
						const value = events[i++];
						if (value !== undefined) return Promise.resolve({ done: false, value });
					}
					return forever();
				},
				return(): Promise<IteratorResult<NormalizedEvent>> {
					counts.returnCalls += 1;
					return forever();
				},
			};
		},
	};
}

/** Resolve `p`, or the `timeout` sentinel if it doesn't settle in `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("streamWithSignal — bounded teardown (warren-c433)", () => {
	test("a hung iterator.return() cannot wedge the generator past the ceiling", async () => {
		const counts: HangingCounts = { returnCalls: 0 };
		const ctrl = new AbortController();
		const gen = streamWithSignal(hangingInner([nevt(1)], counts), ctrl.signal, 20);

		const first = await gen.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual(nevt(1));

		// The next pull parks forever; abort while it's parked (the poller's
		// `ctrl.abort()`), then the generator must complete within ~teardownMs even
		// though `return()` never resolves.
		const pending = gen.next();
		ctrl.abort();
		const done = await within(pending, 500);
		expect(done).not.toBe("timeout");
		expect((done as IteratorResult<NormalizedEvent>).done).toBe(true);
		expect(counts.returnCalls).toBe(1);
	});

	test("a pre-aborted signal still tears down within the ceiling", async () => {
		const counts: HangingCounts = { returnCalls: 0 };
		const ctrl = new AbortController();
		ctrl.abort();
		const gen = streamWithSignal(hangingInner([nevt(1)], counts), ctrl.signal, 20);
		const done = await within(gen.next(), 500);
		expect(done).not.toBe("timeout");
		expect((done as IteratorResult<NormalizedEvent>).done).toBe(true);
	});

	test("clean teardown still completes (no regression) and exposes a sane default", async () => {
		expect(DEFAULT_STREAM_TEARDOWN_MS).toBeGreaterThan(0);
		let returned = false;
		const inner: AsyncIterable<NormalizedEvent> = {
			[Symbol.asyncIterator]() {
				let done = false;
				return {
					next(): Promise<IteratorResult<NormalizedEvent>> {
						if (done) return Promise.resolve({ done: true, value: undefined });
						done = true;
						return Promise.resolve({ done: false, value: nevt(1) });
					},
					return(): Promise<IteratorResult<NormalizedEvent>> {
						returned = true;
						return Promise.resolve({ done: true, value: undefined });
					},
				};
			},
		};
		const ctrl = new AbortController();
		const out: StreamEventView[] = [];
		for await (const e of streamWithSignal(inner, ctrl.signal, 50)) out.push(e);
		expect(out).toEqual([nevt(1)]);
		expect(returned).toBe(true);
	});
});
