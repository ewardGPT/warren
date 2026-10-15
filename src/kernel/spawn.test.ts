import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelEntry } from "./entry.ts";
import { KernelError, type KernelPaths, kernelPaths } from "./paths.ts";
import {
	createKernelFs,
	ensureKernelToken,
	KERNEL_DIR_MODE,
	KERNEL_FILE_MODE,
	KERNEL_LOG_TAIL_BYTES,
	type KernelProcessDeps,
	kernelChildEnv,
	readLogTail,
	readPidRecord,
	type SpawnProcessInput,
	spawnKernel,
	writePidRecord,
} from "./spawn.ts";

const ENTRY_PATH = "/opt/kernel/daemon/dist/index.js";
const ENTRY: KernelEntry = {
	kind: "env",
	entry: ENTRY_PATH,
	argv: ["node", ENTRY_PATH],
	source: `WARREN_KERNEL_ENTRY=${ENTRY_PATH}`,
};

interface Seams {
	readonly deps: KernelProcessDeps;
	readonly spawned: SpawnProcessInput[];
	readonly closed: number[];
	readonly randomCalls: number[];
}

/** Real filesystem under a scratch dir, fake process seams. */
function seams(overrides: Partial<KernelProcessDeps> = {}): Seams {
	const spawned: SpawnProcessInput[] = [];
	const closed: number[] = [];
	const randomCalls: number[] = [];
	const deps: KernelProcessDeps = {
		fs: createKernelFs(),
		spawn: (input) => {
			spawned.push(input);
			return { pid: 4242, kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }) };
		},
		signal: () => {},
		readCmdline: async () => null,
		now: () => 1_767_000_000_000,
		sleep: async () => {},
		schedule: () => () => {},
		randomBytes: (size) => {
			randomCalls.push(size);
			return new Uint8Array(size).fill(0xab);
		},
		...overrides,
	};
	const wrapped: KernelProcessDeps = {
		...deps,
		fs: {
			...deps.fs,
			close: (fd) => {
				closed.push(fd);
				deps.fs.close(fd);
			},
		},
	};
	return { deps: wrapped, spawned, closed, randomCalls };
}

function scratchHome(): { root: string; paths: KernelPaths; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), "warren-kernel-test-"));
	const env = { OPENRIG_HOME: join(root, "kh"), OPENRIG_PORT: "7555" };
	const paths = kernelPaths(env);
	return { root, paths, env };
}

describe("ensureKernelToken", () => {
	test("generates a 32-byte hex token once, 0600, and reuses it", async () => {
		const { root, paths, env } = scratchHome();
		try {
			const s = seams();
			const first = await ensureKernelToken(paths, s.deps);
			expect(first).toMatch(/^[0-9a-f]{64}$/);
			expect(first).toBe("ab".repeat(32));
			expect(s.randomCalls).toEqual([32]);
			expect(readFileSync(paths.tokenFile, "utf8")).toBe(`${first}\n`);
			expect(statSync(paths.tokenFile).mode & 0o777).toBe(KERNEL_FILE_MODE);
			// The kernel home itself is owner-only.
			expect(statSync(kernelPaths(env).home).mode & 0o777).toBe(KERNEL_DIR_MODE);

			const second = await ensureKernelToken(paths, s.deps);
			expect(second).toBe(first);
			// Reused, not regenerated.
			expect(s.randomCalls).toEqual([32]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("re-asserts 0600 on a token left world-readable", async () => {
		const { root, paths } = scratchHome();
		try {
			const s = seams();
			await ensureKernelToken(paths, s.deps);
			chmodSync(paths.tokenFile, 0o644);
			await ensureKernelToken(paths, s.deps);
			expect(statSync(paths.tokenFile).mode & 0o777).toBe(KERNEL_FILE_MODE);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("kernelChildEnv", () => {
	test("pins the isolated home/HOME/endpoint/token and drops legacy RIGGED_*", () => {
		const { paths } = scratchHome();
		const env = kernelChildEnv({
			paths,
			entry: ENTRY,
			token: "token-from-file",
			deps: seams().deps,
			env: {
				PATH: "/usr/bin",
				HOME: "/home/operator",
				OPENRIG_HOME: "/home/operator/.openrig",
				OPENRIG_AUTH_BEARER_TOKEN: "stale",
				RIGGED_HOME: "/legacy/home",
				RIGGED_DB: "/legacy/db.sqlite",
				SOMETHING_UNSET: undefined,
			},
		});
		expect(env.OPENRIG_HOME).toBe(paths.home);
		expect(env.HOME).toBe(paths.privateHome);
		expect(env.OPENRIG_BIND_HOST).toBe("127.0.0.1");
		expect(env.OPENRIG_PORT).toBe("7555");
		expect(env.OPENRIG_AUTH_BEARER_TOKEN).toBe("token-from-file");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.RIGGED_HOME).toBeUndefined();
		expect(env.RIGGED_DB).toBeUndefined();
		expect("SOMETHING_UNSET" in env).toBe(false);
	});
});

describe("spawnKernel", () => {
	test("spawns the entry with the log fd, then records the PID", async () => {
		const { root, paths } = scratchHome();
		try {
			const s = seams();
			const child = await spawnKernel({
				paths,
				entry: ENTRY,
				token: "t0ken",
				env: { PATH: "/usr/bin" },
				deps: s.deps,
			});
			expect(child.pid).toBe(4242);
			expect(s.spawned).toHaveLength(1);
			const input = s.spawned[0];
			expect(input?.argv).toEqual(["node", ENTRY_PATH]);
			expect(input?.cwd).toBe(paths.home);
			expect(input?.env.OPENRIG_HOME).toBe(paths.home);
			expect(input?.env.OPENRIG_AUTH_BEARER_TOKEN).toBe("t0ken");
			// The fd is the caller's to open and close; the child inherits the file.
			expect(s.closed).toHaveLength(1);
			expect(s.closed[0]).toBe(input?.logFd);
			expect(statSync(paths.logFile).mode & 0o777).toBe(KERNEL_FILE_MODE);
			expect(statSync(paths.privateHome).mode & 0o777).toBe(KERNEL_DIR_MODE);

			const record = await readPidRecord(paths, s.deps);
			expect(record).toEqual({
				pid: 4242,
				entry: ENTRY_PATH,
				startedAt: new Date(1_767_000_000_000).toISOString(),
			});
			expect(statSync(paths.pidFile).mode & 0o777).toBe(KERNEL_FILE_MODE);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses a child with no PID", async () => {
		const { root, paths } = scratchHome();
		try {
			const s = seams({
				spawn: () => ({
					pid: undefined,
					kill: () => {},
					exited: Promise.resolve({ code: 0, signal: null }),
				}),
			});
			await expect(
				spawnKernel({ paths, entry: ENTRY, token: "t", env: {}, deps: s.deps }),
			).rejects.toThrow(KernelError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pid records", () => {
	test("round-trips, and treats garbage as absent", async () => {
		const { root, paths } = scratchHome();
		try {
			const s = seams();
			await s.deps.fs.mkdir(paths.home, KERNEL_DIR_MODE);
			expect(await readPidRecord(paths, s.deps)).toBeNull();

			await writePidRecord(paths, { pid: 99, entry: ENTRY_PATH, startedAt: "when" }, s.deps);
			expect(await readPidRecord(paths, s.deps)).toEqual({
				pid: 99,
				entry: ENTRY_PATH,
				startedAt: "when",
			});

			await s.deps.fs.writeFile(paths.pidFile, "not json", KERNEL_FILE_MODE);
			expect(await readPidRecord(paths, s.deps)).toBeNull();

			await s.deps.fs.writeFile(
				paths.pidFile,
				JSON.stringify({ pid: -1, entry: ENTRY_PATH }),
				0o600,
			);
			expect(await readPidRecord(paths, s.deps)).toBeNull();

			await s.deps.fs.writeFile(paths.pidFile, JSON.stringify({ pid: 5 }), 0o600);
			expect(await readPidRecord(paths, s.deps)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("readLogTail", () => {
	test("reads the tail of the kernel log for a failed start", async () => {
		const { root, paths } = scratchHome();
		try {
			const s = seams();
			await s.deps.fs.mkdir(paths.home, KERNEL_DIR_MODE);
			const filler = "x".repeat(KERNEL_LOG_TAIL_BYTES + 500);
			await s.deps.fs.writeFile(paths.logFile, `${filler}\nEADDRINUSE: port 7433\n`, 0o600);
			const tail = readLogTail(paths, s.deps);
			expect(tail).toEndWith("EADDRINUSE: port 7433");
			expect(tail.length).toBeLessThanOrEqual(KERNEL_LOG_TAIL_BYTES);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is empty when there is no log yet", () => {
		const { root, paths } = scratchHome();
		try {
			expect(readLogTail(paths, seams().deps)).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
