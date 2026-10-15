import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import refocus, {
	buildPayload,
	findSeedsRoot,
	nextState,
	type RefocusDeps,
	type RefocusState,
	refocusDecision,
} from "./refocus.ts";

const temps: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "refocus-test-"));
	temps.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeHook {
	fire(event: string, ctx: unknown): Promise<unknown>;
}

function install(deps: RefocusDeps): FakeHook {
	const handlers: Record<string, Handler> = {};
	refocus({ on: (event, handler) => (handlers[event] = handler as Handler), log: () => {} }, deps);
	return {
		async fire(event, ctx) {
			const handler = handlers[event];
			if (handler === undefined) throw new Error(`no handler registered for ${event}`);
			return await handler({ type: event }, ctx);
		},
	};
}

const runStub = async (_command: string, args: readonly string[]): Promise<string> =>
	args[0] === "plan"
		? "pl-1 active  Agent memory and Git operating system"
		: "ubuntu-d600  Run the completion audit";

describe("refocusDecision", () => {
	test("a compaction boundary retains due state instead of consuming it", () => {
		expect(refocusDecision("session_compact", {}, {})).toEqual({
			due: false,
			why: "a compaction boundary retains due state, it does not consume it",
		});
	});

	test("the next prompt consumes a retained compaction", () => {
		const decision = refocusDecision("before_agent_start", { pendingOn: "session_compact" }, {});
		expect(decision.due).toBe(true);
		expect(decision.why).toContain("just compacted");
	});

	test("a fresh prompt is not due", () => {
		expect(refocusDecision("before_agent_start", { promptsSeen: 1 }, {}).due).toBe(false);
	});

	test("REFOCUS_NOW forces one delivery", () => {
		expect(refocusDecision("before_agent_start", {}, { REFOCUS_NOW: "1" }).why).toBe("on demand");
	});

	test("REFOCUS_EVERY delivers on the interval, not on the first prompt", () => {
		expect(
			refocusDecision("before_agent_start", { promptsSeen: 1 }, { REFOCUS_EVERY: "3" }).due,
		).toBe(false);
		expect(
			refocusDecision("before_agent_start", { promptsSeen: 3 }, { REFOCUS_EVERY: "3" }).why,
		).toContain("3 prompts");
	});
});

describe("nextState", () => {
	const at = new Date("2026-10-15T12:00:00.000Z");

	test("compaction records when it happened and keeps the debt", () => {
		const state = nextState("auto_compaction_end", { deliveries: 2 }, { due: false, why: "" }, at);
		expect(state.pendingOn).toBe("auto_compaction_end");
		expect(state.pendingAt).toBe("2026-10-15T12:00:00.000Z");
		expect(state.deliveries).toBe(2);
	});

	test("delivery clears the debt and counts the delivery", () => {
		const state = nextState(
			"before_agent_start",
			{ pendingOn: "session_compact", pendingAt: "earlier", promptsSeen: 4, deliveries: 1 },
			{ due: true, why: "just compacted" },
			at,
		);
		expect(state.pendingOn).toBeUndefined();
		expect(state.deliveries).toBe(2);
		expect(state.promptsSeen).toBe(5);
		expect(state.lastDeliveredAt).toBe("2026-10-15T12:00:00.000Z");
	});

	test("a delivered prompt does not re-owe a refocus", () => {
		const delivered = nextState(
			"before_agent_start",
			{ pendingOn: "session_compact" },
			{ due: true, why: "x" },
			at,
		);
		expect(refocusDecision("before_agent_start", delivered, {}).due).toBe(false);
	});
});

describe("findSeedsRoot", () => {
	test("walks up to the project that owns .seeds", async () => {
		const root = await tempDir();
		await mkdir(join(root, ".seeds"), { recursive: true });
		await mkdir(join(root, "src", "deep", "nested"), { recursive: true });
		expect(findSeedsRoot(join(root, "src", "deep", "nested"))).toBe(root);
	});

	test("reports nothing when no ancestor has .seeds", async () => {
		const root = await tempDir();
		expect(findSeedsRoot(join(root, "x"))).toBeUndefined();
	});
});

describe("buildPayload", () => {
	test("carries the intent chain and the observable question", async () => {
		const payload = await buildPayload("/repo", "just compacted", runStub, "sd", 4000);
		expect(payload).toContain("REFOCUS (just compacted)");
		expect(payload).toContain("## Active plans");
		expect(payload).toContain("## Actionable frontier");
		expect(payload).toContain("Which acceptance criterion");
	});

	test("names a missing chain as a gap instead of inventing one", async () => {
		const empty = async (): Promise<string> => "";
		const payload = await buildPayload("/repo", "on demand", empty, "sd", 4000);
		expect(payload).toContain("no .seeds plan or frontier found here");
	});

	test("a failing sd is reported, never thrown", async () => {
		const failing = async (): Promise<string> => {
			throw new Error("ENOENT");
		};
		const payload = await buildPayload("/repo", "on demand", failing, "sd", 4000);
		expect(payload).toContain("failed: ENOENT");
	});

	test("clips to the byte ceiling while keeping both ends", async () => {
		const long = async (): Promise<string> => "x".repeat(5000);
		const payload = await buildPayload("/repo", "on demand", long, "sd", 600);
		expect(payload.length).toBeLessThan(900);
		expect(payload).toContain("clipped");
	});
});

describe("hook wiring", () => {
	test("compaction then prompt delivers the chain once and clears the debt", async () => {
		const dir = await tempDir();
		const project = await tempDir();
		await mkdir(join(project, ".seeds"), { recursive: true });
		const ctx = { cwd: project, agentDir: dir, sessionId: "sess-1" };
		const hook = install({ env: {}, stateDir: () => dir, run: runStub });

		expect(await hook.fire("auto_compaction_end", ctx)).toBeUndefined();
		const state = JSON.parse(await readFile(join(dir, "sess-1.json"), "utf8")) as RefocusState;
		expect(state.pendingOn).toBe("auto_compaction_end");

		const injected = (await hook.fire("before_agent_start", ctx)) as {
			message: { content: string };
		};
		expect(injected.message.content).toContain("REFOCUS (just compacted");
		expect(injected.message.content).toContain("## Actionable frontier");

		expect(await hook.fire("before_agent_start", ctx)).toBeUndefined();
	});

	test("REFOCUS_ENABLED=0 disables delivery but not bookkeeping", async () => {
		const dir = await tempDir();
		const project = await tempDir();
		await mkdir(join(project, ".seeds"), { recursive: true });
		const ctx = { cwd: project, agentDir: dir, sessionId: "sess-2" };
		const hook = install({ env: { REFOCUS_ENABLED: "0" }, stateDir: () => dir, run: runStub });
		await hook.fire("session_compact", ctx);
		expect(await hook.fire("before_agent_start", ctx)).toBeUndefined();
	});

	test("no project with .seeds means no injection and no error", async () => {
		const dir = await tempDir();
		const bare = await tempDir();
		const hook = install({
			env: { REFOCUS_NOW: "1" },
			stateDir: () => dir,
			run: runStub,
			findRoot: () => undefined,
		});
		expect(
			await hook.fire("before_agent_start", { cwd: bare, agentDir: dir, sessionId: "s" }),
		).toBeUndefined();
	});
});
