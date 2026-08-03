import { describe, expect, test } from "bun:test";
import { withSeedsWriteLock } from "./lock.ts";

/** Delay helper; real timers are fine at this scale. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withSeedsWriteLock", () => {
	test("serializes concurrent mutations of the same project", async () => {
		const ledger: string[] = [];
		const inFlight = new Set<number>();

		const run = async (id: number) =>
			withSeedsWriteLock("/data/projects/p", async () => {
				expect(inFlight.size).toBe(0);
				inFlight.add(id);
				ledger.push(`start-${id}`);
				await sleep(10);
				ledger.push(`end-${id}`);
				inFlight.delete(id);
			});

		await Promise.all([run(1), run(2), run(3)]);

		expect(ledger.join(" ")).toBe("start-1 end-1 start-2 end-2 start-3 end-3");
	});

	test("releases the lock when the critical section throws", async () => {
		const first = withSeedsWriteLock("/data/projects/p", async () => {
			throw new Error("boom");
		});
		await expect(first).rejects.toThrow("boom");

		// A later caller must not be deadlocked by the failed section.
		let ran = false;
		await withSeedsWriteLock("/data/projects/p", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	test("different projects are not serialized against each other", async () => {
		const order: string[] = [];
		await Promise.all([
			withSeedsWriteLock("/data/projects/a", async () => {
				await sleep(20);
				order.push("a");
			}),
			withSeedsWriteLock("/data/projects/b", async () => {
				order.push("b");
			}),
		]);
		expect(order).toContain("b");
		expect(order).toContain("a");
	});
});
