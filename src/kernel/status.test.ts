import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { KernelExit, SpawnProcessInput } from "./spawn.ts";
import { type KernelDeps, kernelStart, kernelStatus, kernelStop } from "./status.ts";

const ENTRY = "/opt/openrig/daemon/dist/index.js";
const HOME = "/tmp/warren-kernel-test";
const PID_FILE = join(HOME, "kernel.pid");
const TOKEN_FILE = join(HOME, "kernel-token");
const LOG_FILE = join(HOME, "kernel.log");
const URL = "http://127.0.0.1:7433";
const CHILD_PID = 4242;

const ENV = { PATH: "/usr/bin", OPENRIG_HOME: HOME, WARREN_KERNEL_ENTRY: ENTRY };

type HealthResponse =
	| { kind: "ok"; body?: Record<string, unknown> }
	| { kind: "refused"; error: string }
	| { kind: "http"; status: number };

interface ExitGate {
	readonly promise: Promise<KernelExit>;
	resolve(exit: KernelExit): void;
}

interface HarnessState {
	readonly files: Map<string, string>;
	readonly writes: { path: string; mode: number }[];
	readonly signals: { pid: number; signal: string }[];
	readonly spawns: SpawnProcessInput[];
	readonly sleeps: number[];
	/** PIDs the fake signal seam treats as alive. */
	readonly alive: Set<number>;
	/** Command lines the fake `readCmdline` seam reports. */
	readonly cmdlines: Map<number, string>;
	/** Probe script: the last entry repeats once it is the only one left. */
	readonly health: HealthResponse[];
	probes: number;
	clock: number;
	/** Drop the recorded PID from `alive` as soon as SIGTERM arrives. */
	exitOnSigterm: boolean;
}

interface Harness {
	readonly deps: KernelDeps;
	readonly state: HarnessState;
	/** Resolve the spawned child's exit whenever the test needs to kill it. */
	readonly exit: ExitGate;
}

const REFUSED = "connect ECONNREFUSED 127.0.0.1:7433";

function harness(): Harness {
	const state: HarnessState = {
		files: new Map(),
		writes: [],
		signals: [],
		spawns: [],
		sleeps: [],
		alive: new Set(),
		cmdlines: new Map(),
		health: [],
		probes: 0,
		clock: 1_000_000,
		exitOnSigterm: false,
	};
	const exitResolvers = Promise.withResolvers<KernelExit>();
	const exit: ExitGate = { promise: exitResolvers.promise, resolve: exitResolvers.resolve };
	const deps: KernelDeps = {
		fs: {
			readFile: async (path) => state.files.get(path) ?? null,
			writeFile: async (path, content, mode) => {
				state.files.set(path, content);
				state.writes.push({ path, mode });
			},
			mkdir: async () => {},
			chmod: async () => {},
			remove: async (path) => {
				state.files.delete(path);
			},
			exists: (path) => path === ENTRY,
			realpath: (path) => path,
			openAppend: () => 7,
			close: () => {},
			readTail: (path) => state.files.get(path) ?? "",
		},
		spawn: (input) => {
			state.spawns.push(input);
			return { pid: CHILD_PID, kill: () => {}, exited: exit.promise };
		},
		signal: (pid, signal) => {
			state.signals.push({ pid, signal: String(signal) });
			if (signal === 0 && !state.alive.has(pid)) throw new Error(`ESRCH: no such process ${pid}`);
			if (signal === "SIGTERM" && state.exitOnSigterm) state.alive.delete(pid);
		},
		readCmdline: async (pid) => state.cmdlines.get(pid) ?? null,
		now: () => state.clock,
		sleep: async (ms) => {
			state.sleeps.push(ms);
			state.clock += ms;
		},
		schedule: () => () => {},
		randomBytes: (size) => new Uint8Array(size).fill(0xcd),
		fetch: async (input) => {
			state.probes += 1;
			const url = String(input);
			if (!url.endsWith("/healthz")) throw new Error(`unexpected kernel request: ${url}`);
			const response: HealthResponse | undefined =
				state.health.length > 1 ? state.health.shift() : state.health[0];
			if (response === undefined || response.kind === "refused") {
				throw new Error(response?.kind === "refused" ? response.error : REFUSED);
			}
			if (response.kind === "http") return new Response("nope", { status: response.status });
			return new Response(
				JSON.stringify(response.body ?? { status: "ok", pid: CHILD_PID, semver: "0.6.10" }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	};
	return { deps, state, exit };
}

/** Record a live child: pid record + liveness + a matching command line. */
function recordChild(state: HarnessState, pid: number, startedAt?: string): void {
	state.files.set(
		PID_FILE,
		JSON.stringify({
			pid,
			entry: ENTRY,
			startedAt: startedAt ?? new Date(state.clock).toISOString(),
		}),
	);
	state.alive.add(pid);
	state.cmdlines.set(pid, `node ${ENTRY}`);
}

describe("kernelStatus", () => {
	test("reports running with the daemon's own version and commit", async () => {
		const { deps, state } = harness();
		state.health.push({
			kind: "ok",
			body: { status: "ok", pid: CHILD_PID, semver: "0.6.10", commit: "3001cc43" },
		});
		recordChild(state, CHILD_PID, "2026-10-15T11:00:00.000Z");

		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("running");
		expect(status.pid).toBe(CHILD_PID);
		expect(status.version).toBe("0.6.10");
		expect(status.commit).toBe("3001cc43");
		expect(status.since).toBe("2026-10-15T11:00:00.000Z");
		expect(status.url).toBe(URL);
		expect(status.home).toBe(HOME);
		expect(status.entry).toContain(ENTRY);
		expect(state.probes).toBe(1);
	});

	test("reports stopped when nothing answers and no child was recorded", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.pid).toBeUndefined();
		expect(status.detail).toContain("ECONNREFUSED");
	});

	test("distinguishes a booting child from a wedged one by the record's age", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		recordChild(state, 555);

		const booting = await kernelStatus(ENV, deps);
		expect(booting.state).toBe("starting");
		expect(booting.pid).toBe(555);
		expect(booting.detail).toContain("has not answered yet");

		// Past the readiness window the same child is wedged, not booting.
		state.clock += 30_000;
		const wedged = await kernelStatus(ENV, deps);
		expect(wedged.state).toBe("unhealthy");
		expect(wedged.detail).toContain("is alive but /healthz is not answering");
	});

	test("treats a recycled PID as a stale record and never keeps it", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		state.files.set(PID_FILE, JSON.stringify({ pid: 777, entry: ENTRY, startedAt: "then" }));
		state.alive.add(777);
		state.cmdlines.set(777, "/usr/bin/some-other-daemon --serve");

		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("is not the kernel entry");
		expect(state.files.has(PID_FILE)).toBe(false);
		// Liveness only: nothing was signalled.
		expect(state.signals.filter((call) => call.signal !== "0")).toEqual([]);
	});

	test("clears a record whose child is gone", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		state.files.set(PID_FILE, JSON.stringify({ pid: 888, entry: ENTRY, startedAt: "then" }));

		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("888 is gone");
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("keeps an unverifiable child as unhealthy rather than dropping it", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		state.files.set(PID_FILE, JSON.stringify({ pid: 999, entry: ENTRY, startedAt: "then" }));
		state.alive.add(999);
		// No cmdline for 999 → unreadable, so ownership cannot be proven.

		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("unhealthy");
		expect(status.detail).toContain("command line is unreadable");
		expect(state.files.has(PID_FILE)).toBe(true);
	});

	test("falls back to an HTTP failure as the detail", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "http", status: 500 });
		const status = await kernelStatus(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("HTTP 500");
	});
});

describe("kernelStart", () => {
	test("starts the child, polls until healthy, and reports the daemon's version", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED }, { kind: "ok" });

		const status = await kernelStart(ENV, deps);
		expect(status.state).toBe("running");
		expect(status.pid).toBe(CHILD_PID);
		expect(status.version).toBe("0.6.10");
		expect(status.entry).toContain(ENTRY);

		const spawn = state.spawns[0];
		expect(spawn?.argv).toEqual(["node", ENTRY]);
		expect(spawn?.cwd).toBe(HOME);
		expect(spawn?.env.OPENRIG_HOME).toBe(HOME);
		expect(spawn?.env.HOME).toBe(join(HOME, "home"));
		expect(spawn?.env.OPENRIG_AUTH_BEARER_TOKEN).toMatch(/^[0-9a-f]{64}$/);
		expect(spawn?.env.OPENRIG_AUTH_BEARER_TOKEN).toBe("cd".repeat(32));

		const tokenWrite = state.writes.find((write) => write.path === TOKEN_FILE);
		expect(tokenWrite?.mode).toBe(0o600);
		expect(state.files.get(TOKEN_FILE)).toBe(`${"cd".repeat(32)}\n`);
		expect(state.files.get(PID_FILE)).toBe(
			`${JSON.stringify({
				pid: CHILD_PID,
				entry: ENTRY,
				startedAt: new Date(1_000_000).toISOString(),
			})}\n`,
		);
		// The pre-flight status probe consumed the refusal, so readiness answered
		// on the loop's first probe — no sleep was needed.
		expect(state.sleeps).toEqual([]);
	});

	test("returns unhealthy with the last probe error when readiness times out", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });

		const status = await kernelStart(ENV, deps);
		expect(status.state).toBe("unhealthy");
		expect(status.pid).toBe(CHILD_PID);
		expect(status.detail).toContain("did not answer /healthz within 20000ms");
		expect(status.detail).toContain("ECONNREFUSED");
		// The child is alive: its record stays for a later status/stop.
		expect(state.files.has(PID_FILE)).toBe(true);
		// Bounded: 20s / 250ms, then it gives up.
		expect(state.sleeps).toHaveLength(80);
	});

	test("honours injected readiness bounds", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		const status = await kernelStart(ENV, deps, {
			readinessTimeoutMs: 500,
			readinessIntervalMs: 100,
		});
		expect(status.state).toBe("unhealthy");
		expect(status.detail).toContain("within 500ms");
		expect(state.sleeps).toEqual([100, 100, 100, 100, 100]);
	});

	test("reports failed with the exit code and the log tail when the child dies", async () => {
		const { deps, state, exit } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		state.files.set(LOG_FILE, "EADDRINUSE: port 7433 in use\n");

		const started = kernelStart(ENV, deps);
		// The child dies while readiness is still polling.
		exit.resolve({ code: 3, signal: null });
		const status = await started;

		expect(status.state).toBe("failed");
		expect(status.pid).toBe(CHILD_PID);
		expect(status.detail).toContain("code 3");
		expect(status.detail).toContain("EADDRINUSE: port 7433 in use");
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("reports failed when no entry can be resolved, without spawning", async () => {
		const { deps, state } = harness();
		const status = await kernelStart({}, { ...deps, fs: { ...deps.fs, exists: () => false } });
		expect(status.state).toBe("failed");
		expect(status.detail).toContain("WARREN_KERNEL_ENTRY");
		expect(state.spawns).toEqual([]);
	});

	test("never starts a second child on a kernel that already answers", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "ok" });
		const status = await kernelStart(ENV, deps);
		expect(status.state).toBe("running");
		expect(state.spawns).toEqual([]);
	});

	test("reuses an existing token instead of minting a new one", async () => {
		const { deps, state } = harness();
		state.files.set(TOKEN_FILE, "existing-token\n");
		state.health.push({ kind: "refused", error: REFUSED }, { kind: "ok" });

		const status = await kernelStart(ENV, deps);
		expect(status.state).toBe("running");
		expect(state.spawns[0]?.env.OPENRIG_AUTH_BEARER_TOKEN).toBe("existing-token");
		expect(state.files.get(TOKEN_FILE)).toBe("existing-token\n");
		// The only write is the pid record: the token file was left alone.
		expect(state.writes.map((write) => write.path)).toEqual([PID_FILE]);
	});
});

describe("kernelStop", () => {
	test("escalates SIGTERM to SIGKILL after the grace window", async () => {
		const { deps, state } = harness();
		recordChild(state, 1234);

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("escalated to SIGKILL");

		const delivered = state.signals.filter((call) => call.signal !== "0");
		expect(delivered).toEqual([
			{ pid: 1234, signal: "SIGTERM" },
			{ pid: 1234, signal: "SIGKILL" },
		]);
		// 10s grace at 200ms polls, then the post-SIGKILL wait.
		expect(state.sleeps.filter((ms) => ms === 200).length).toBe(60);
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("stops on SIGTERM alone when the child exits", async () => {
		const { deps, state } = harness();
		recordChild(state, 4321);
		state.exitOnSigterm = true;

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("exited on SIGTERM");
		expect(state.signals.filter((call) => call.signal !== "0")).toEqual([
			{ pid: 4321, signal: "SIGTERM" },
		]);
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("refuses to signal a PID whose command line is not the kernel entry", async () => {
		const { deps, state } = harness();
		state.files.set(PID_FILE, JSON.stringify({ pid: 2468, entry: ENTRY, startedAt: "then" }));
		state.alive.add(2468);
		state.cmdlines.set(2468, "/usr/bin/postgres -D /var/lib/postgresql");
		state.health.push({ kind: "refused", error: REFUSED });

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("refused to signal pid 2468");
		expect(state.signals.filter((call) => call.signal !== "0")).toEqual([]);
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("never signals a PID whose command line cannot be read", async () => {
		const { deps, state } = harness();
		state.files.set(PID_FILE, JSON.stringify({ pid: 1357, entry: ENTRY, startedAt: "then" }));
		state.alive.add(1357);

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("unhealthy");
		expect(status.detail).toContain("command line is unreadable");
		expect(state.signals.filter((call) => call.signal !== "0")).toEqual([]);
		expect(state.files.has(PID_FILE)).toBe(true);
	});

	test("clears a record whose child already exited", async () => {
		const { deps, state } = harness();
		state.files.set(PID_FILE, JSON.stringify({ pid: 8642, entry: ENTRY, startedAt: "then" }));

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("had already exited");
		expect(state.files.has(PID_FILE)).toBe(false);
	});

	test("is a no-op when no kernel was started", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "refused", error: REFUSED });
		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("stopped");
		expect(status.detail).toContain("ECONNREFUSED");
		expect(state.signals).toEqual([]);
	});

	test("says so when something answers that warren does not own", async () => {
		const { deps, state } = harness();
		state.health.push({ kind: "ok", body: { status: "ok", pid: 111 } });

		const status = await kernelStop(ENV, deps);
		expect(status.state).toBe("unhealthy");
		expect(status.pid).toBe(111);
		expect(status.detail).toContain("cannot prove it owns");
		expect(state.signals).toEqual([]);
	});
});
