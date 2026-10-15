import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "../output.ts";
import { runDecide } from "./decide.ts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A fresh temp directory, removed in `afterEach`. Every harness the CLI is
 * driven through has to point `WARREN_DECISION_LOG` at one: the run would
 * otherwise append stub rows to the operator's own
 * `$HOME/.warren/decisions.jsonl`, which is the calibration input `jev_tune`
 * reads back.
 */
async function privateDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A harness whose `decide` writes its audit row to a private temp log. */
async function isolatedHarness(env: Record<string, string | undefined> = {}): Promise<{
	context: CliContext;
	out: () => string;
	err: () => string;
}> {
	const dir = await privateDir("decide-cli-");
	return harness({ WARREN_DECISION_LOG: join(dir, "decisions.jsonl"), ...env });
}

function harness(env: Record<string, string | undefined> = {}): {
	context: CliContext;
	out: () => string;
	err: () => string;
} {
	let stdout = "";
	let stderr = "";
	return {
		context: {
			env,
			stdio: { stdout: { write: (c) => (stdout += c) }, stderr: { write: (c) => (stderr += c) } },
			spawn: () => Promise.reject(new Error("decide must not spawn")),
		},
		out: () => stdout,
		err: () => stderr,
	};
}

const QUESTIONS = '{"merge_ok":{"type":"noul","instructions":"May this merge?"}}';

describe("warren decide (offline provider)", () => {
	test("the fixture's 0.81 lands in `ask`: below the act bar, so exit 3", async () => {
		const h = await isolatedHarness();
		const code = await runDecide(h.context, {
			feature: "merge-gate",
			state: '{"checksGreen":true}',
			questions: QUESTIONS,
			stub: true,
		});
		expect(code).toBe(3);
		expect(h.out()).toContain("ask");
		expect(h.out()).toContain("merge_ok: noul 0.81");
	});

	test("--json prints the whole decision with the folded band", async () => {
		const h = await isolatedHarness();
		const code = await runDecide(h.context, {
			feature: "merge-gate",
			state: "{}",
			questions: QUESTIONS,
			stub: true,
			json: true,
		});
		expect(code).toBe(3);
		const parsed = JSON.parse(h.out()) as { outcome: string; band: string; via: string };
		expect(parsed.outcome).toBe("decided");
		expect(parsed.band).toBe("ask");
		expect(parsed.via).toBe("stub");
	});

	test("a `hold` answer exits 4 and a missing provider exits 5", async () => {
		const dir = await privateDir("decide-test-");
		const fixture = join(dir, "hold.json");
		await writeFile(
			fixture,
			JSON.stringify({ model: "fake", defaults: { noul: { noul: 0.02 } }, usage: {} }),
		);
		const h = await isolatedHarness({ WARREN_JEV_STUB_FIXTURE: fixture });
		expect(
			await runDecide(h.context, { feature: "g", state: "{}", questions: QUESTIONS, stub: true }),
		).toBe(4);

		const actFixture = join(dir, "act.json");
		await writeFile(
			actFixture,
			JSON.stringify({ model: "fake", defaults: { noul: { noul: 0.96 } }, usage: {} }),
		);
		const act = await isolatedHarness({ WARREN_JEV_STUB_FIXTURE: actFixture });
		expect(
			await runDecide(act.context, { feature: "g", state: "{}", questions: QUESTIONS, stub: true }),
		).toBe(0);

		const offline = await isolatedHarness({ JEV_PROVIDER: "typesafe" });
		expect(
			await runDecide(offline.context, { feature: "g", state: "{}", questions: QUESTIONS }),
		).toBe(5);
		expect(offline.err()).toContain("decide:");
	});

	test("bad input is refused before any call", async () => {
		const h = harness();
		expect(
			await runDecide(h.context, { feature: "g", state: "not json", questions: QUESTIONS }),
		).toBe(5);
		expect(h.err()).toContain("--state is neither inline JSON nor a readable file");
		const malformed = harness();
		expect(
			await runDecide(malformed.context, { feature: "g", state: "{oops", questions: QUESTIONS }),
		).toBe(5);
		expect(malformed.err()).toContain("--state is not valid JSON");
		const empty = harness();
		expect(await runDecide(empty.context, { feature: "g", state: "{}", questions: "{}" })).toBe(5);
		expect(empty.err()).toContain("at least one named question");
	});
});
