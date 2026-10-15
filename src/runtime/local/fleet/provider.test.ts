/**
 * The fleet provider's two jobs: CHOOSE a box, and ROUTE every later call back
 * to it. Both are tested through the provider itself with fake per-box
 * providers, because what matters is the wiring: a run that lands on box B must
 * never read status from box A, and the inner provider must receive the id IT
 * minted rather than the box-encoded form the domain holds.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowClient } from "../../../burrow-client/index.ts";
import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
	WorkspaceInfo,
} from "../../contract.ts";
import type { BoxHealth, FleetBoxRuntime } from "./health.ts";
import { PlacementLog } from "./placement-log.ts";
import { FleetProvider } from "./provider.ts";

interface Recorded {
	readonly box: string;
	readonly method: string;
	readonly providerRunId: string;
}

/** A provider that answers with its own box id, so routing is visible. */
function fakeProvider(box: string, recorded: Recorded[]): RuntimeProvider {
	const note = (method: string, handle: RunHandle): void => {
		recorded.push({ box, method, providerRunId: handle.providerRunId });
	};
	const capabilities = {
		previewPorts: true,
		networkPolicy: "domain-allowlist",
		longLived: true,
		midRunSteering: true,
		enforcedResourceLimits: true,
		workspaceArchive: true,
		workspaceGc: true,
	} as const;
	return {
		capabilities,
		create: async (spec: RunSpec): Promise<RunHandle> => ({
			runId: spec.runId,
			sandboxId: `${box}-sandbox`,
			providerRunId: `${box}-inner-run`,
		}),
		streamEvents: (handle: RunHandle, _opts?: StreamOpts): AsyncIterable<NormalizedEvent> => {
			note("streamEvents", handle);
			return (async function* empty() {})();
		},
		status: async (handle: RunHandle): Promise<RunStatus> => {
			note("status", handle);
			return {
				phase: "running",
				exitCode: null,
				lastEventSeq: 0,
				lastEventTs: null,
				exists: true,
			};
		},
		sendMessage: async (handle: RunHandle, msg: OutboundMessage): Promise<Message> => {
			note("sendMessage", handle);
			return { id: "m1", runId: handle.runId, body: msg.body } as Message;
		},
		cancel: async (handle: RunHandle): Promise<void> => {
			note("cancel", handle);
		},
		workspaceInfo: async (handle: RunHandle): Promise<WorkspaceInfo> => {
			note("workspaceInfo", handle);
			return { workspacePath: `/home/${box}/ws`, branch: "b" };
		},
		finalize: async (handle: RunHandle, _intent: FinalizeIntent): Promise<FinalizeResult> => {
			note("finalize", handle);
			return {} as FinalizeResult;
		},
		terminate: async (handle: RunHandle): Promise<TeardownResult> => {
			note("terminate", handle);
			return { archived: false, deletedEvents: 0, deletedMessages: 0, deletedRuns: 0 };
		},
	};
}

function box(id: string, recorded: Recorded[]): FleetBoxRuntime {
	return {
		id,
		client: {} as BurrowClient,
		provider: fakeProvider(id, recorded),
		ssh: { target: `${id}-ssh`, run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
	};
}

function health(
	entries: readonly { id: string; live: number; healthy?: boolean }[],
): Map<string, BoxHealth> {
	const map = new Map<string, BoxHealth>();
	for (const entry of entries) {
		map.set(entry.id, {
			id: entry.id,
			healthy: entry.healthy ?? true,
			live: entry.live,
			detail: entry.healthy === false ? "down" : null,
		});
	}
	return map;
}

function spec(runId: string, projectId?: string): RunSpec {
	return {
		runId,
		originUrl: "https://example.test/repo.git",
		branch: "b",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "go",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: {},
		...(projectId !== undefined ? { projectId } : {}),
	};
}

describe("FleetProvider.create", () => {
	it("places a run on the least loaded healthy box and encodes the box in the handle", async () => {
		const recorded: Recorded[] = [];
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			materialize: async (_box, _spec) => "/box/clone",
			probe: async () =>
				health([
					{ id: "box-a", live: 3 },
					{ id: "box-b", live: 0 },
				]),
		});
		const handle = await provider.create(spec("run-1"));
		expect(handle.sandboxId).toBe("box-b-sandbox");
		expect(handle.providerRunId).toBe("box-b/box-b-inner-run");
		expect(handle.runId).toBe("run-1");
	});

	it("spreads a burst across boxes even when the probe cannot see the previous run", async () => {
		const recorded: Recorded[] = [];
		// The probe is the world as it was: both boxes report zero. Without
		// in-flight accounting every dispatch in the burst would pick box-a.
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded), box("box-c", recorded)],
			materialize: async (_box, _spec) => "/box/clone",
			probe: async () =>
				health([
					{ id: "box-a", live: 0 },
					{ id: "box-b", live: 0 },
					{ id: "box-c", live: 0 },
				]),
		});
		const boxes: RunHandle[] = [];
		for (const runId of ["run-1", "run-2", "run-3"]) {
			boxes.push(await provider.create(spec(runId)));
		}
		expect(boxes.map((handle) => handle.providerRunId.split("/")[0])).toEqual([
			"box-a",
			"box-b",
			"box-c",
		]);
	});

	it("rotates boxes across separate processes through the shared placement log", async () => {
		const recorded: Recorded[] = [];
		const logPath = join(tmpdir(), `fleet-placements-${process.pid}-${Date.now()}.jsonl`);
		// Each create below runs in its own provider, which is what separate
		// warren processes look like. A finished run leaves the box idle again,
		// so without the shared log every process would pick box-a.
		const one = async (runId: string): Promise<string> => {
			const provider = new FleetProvider({
				boxes: [box("box-a", recorded), box("box-b", recorded), box("box-c", recorded)],
				materialize: async (_box, _spec) => "/box/clone",
				placementLog: new PlacementLog({ path: logPath }),
				probe: async () =>
					health([
						{ id: "box-a", live: 0 },
						{ id: "box-b", live: 0 },
						{ id: "box-c", live: 0 },
					]),
			});
			const handle = await provider.create(spec(runId));
			return handle.providerRunId.split("/")[0] ?? "";
		};
		const placed = [await one("run-1"), await one("run-2"), await one("run-3"), await one("run-4")];
		expect(placed).toEqual(["box-a", "box-b", "box-c", "box-a"]);
	});

	it("ignores a placement that fell outside the log's window", async () => {
		const recorded: Recorded[] = [];
		const logPath = join(tmpdir(), `fleet-window-${process.pid}-${Date.now()}.jsonl`);
		let clock = 1_000;
		const log = new PlacementLog({ path: logPath, windowMs: 100, now: () => clock });
		log.record("box-a");
		clock += 10_000;
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			materialize: async (_box, _spec) => "/box/clone",
			placementLog: log,
			probe: async () =>
				health([
					{ id: "box-a", live: 0 },
					{ id: "box-b", live: 0 },
				]),
		});
		// The stale entry must not keep box-a out of rotation forever.
		const handle = await provider.create(spec("run-1"));
		expect(handle.providerRunId.split("/")[0]).toBe("box-a");
	});

	it("fails loudly when no box is healthy", async () => {
		const provider = new FleetProvider({
			boxes: [box("box-a", [])],
			probe: async () => health([{ id: "box-a", live: 0, healthy: false }]),
		});
		await expect(provider.create(spec("run-1"))).rejects.toThrow(/no box can take run run-1/);
	});

	it("skips a box that is at its configured limit", async () => {
		const recorded: Recorded[] = [];
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			placement: { boxLimit: 1 },
			probe: async () =>
				health([
					{ id: "box-a", live: 1 },
					{ id: "box-b", live: 0 },
				]),
		});
		const handle = await provider.create(spec("run-1"));
		expect(handle.providerRunId).toBe("box-b/box-b-inner-run");
	});
});

describe("FleetProvider routing", () => {
	it("sends every later call to the run's box with the id that box minted", async () => {
		const recorded: Recorded[] = [];
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			materialize: async (_box, _spec) => "/box/clone",
			probe: async () =>
				health([
					{ id: "box-a", live: 0 },
					{ id: "box-b", live: 9 },
				]),
		});
		const handle = await provider.create(spec("run-1"));
		expect(handle.providerRunId).toBe("box-a/box-a-inner-run");

		await provider.status(handle);
		await provider.workspaceInfo(handle);
		await provider.cancel(handle);
		await provider.terminate(handle);

		expect(recorded.map((entry) => `${entry.box}:${entry.method}`)).toEqual([
			"box-a:status",
			"box-a:workspaceInfo",
			"box-a:cancel",
			"box-a:terminate",
		]);
		// The inner provider must never see the encoded form.
		for (const entry of recorded) expect(entry.providerRunId).toBe("box-a-inner-run");
	});

	it("refuses a handle that names a box it does not have", async () => {
		const provider = new FleetProvider({
			boxes: [box("box-a", [])],
			probe: async () => health([{ id: "box-a", live: 0 }]),
		});
		const alien: RunHandle = {
			runId: "run-1",
			sandboxId: "s",
			providerRunId: "box-gone/inner",
		};
		await expect(provider.status(alien)).rejects.toThrow(/box-gone/);
	});

	it("refuses a handle that was not minted here", async () => {
		const provider = new FleetProvider({
			boxes: [box("box-a", [])],
			probe: async () => health([{ id: "box-a", live: 0 }]),
		});
		await expect(
			provider.status({ runId: "r", sandboxId: "s", providerRunId: "no-separator" }),
		).rejects.toThrow(/no-separator/);
	});
});

describe("FleetProvider accounting", () => {
	it("counts this project's runs per box so the next one spreads out", async () => {
		const recorded: Recorded[] = [];
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			placement: { projectLimit: 1 },
			probe: async () =>
				health([
					{ id: "box-a", live: 0 },
					{ id: "box-b", live: 0 },
				]),
		});
		const first = await provider.create(spec("run-1", "proj-1"));
		const second = await provider.create(spec("run-2", "proj-1"));
		// Same project, projectLimit 1, equal load: the second run must take the
		// other box even though the first box is still the tie-break winner.
		expect(first.providerRunId).toBe("box-a/box-a-inner-run");
		expect(second.providerRunId).toBe("box-b/box-b-inner-run");
	});

	it("frees the project's slot when the run terminates", async () => {
		const recorded: Recorded[] = [];
		const provider = new FleetProvider({
			boxes: [box("box-a", recorded), box("box-b", recorded)],
			placement: { projectLimit: 1 },
			probe: async () =>
				health([
					{ id: "box-a", live: 0 },
					{ id: "box-b", live: 0 },
				]),
		});
		const first = await provider.create(spec("run-1", "proj-1"));
		await provider.terminate(first);
		const second = await provider.create(spec("run-2", "proj-1"));
		expect(second.providerRunId).toBe("box-a/box-a-inner-run");
	});
});

describe("FleetProvider identity", () => {
	it("reports the boxes it was built with", () => {
		const provider = new FleetProvider({
			boxes: [box("zeta", []), box("alpha", [])],
			probe: async () => health([]),
		});
		expect(provider.boxIds).toEqual(["zeta", "alpha"]);
	});
});
