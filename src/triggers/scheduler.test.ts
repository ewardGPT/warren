import { describe, expect, test } from "bun:test";
import type { LoadedWarrenConfig } from "../warren-config/index.ts";
import { startScheduler } from "./tick.ts";

function emptyConfig(): LoadedWarrenConfig {
	return {
		triggers: null,
		defaults: null,
		prTemplate: null,
		sourceFile: null,
		errors: [],
		warnings: [],
	};
}

describe("startScheduler", () => {
	test("disabled handle is a no-op (never ticks)", async () => {
		const handle = startScheduler({
			tickMs: 1,
			disabled: true,
			repos: {
				projects: { listAll: () => [] } as never,
				agents: {} as never,
				graphRuns: {} as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "n/a" }),
		});

		await handle.stop();
		expect(handle.tickCount()).toBe(0);
	});

	test("single-flight: an in-flight tick blocks the next fire", async () => {
		let resolveInflight: () => void = () => {};
		const projectRow = {
			id: "prj_sf",
			gitUrl: "g",
			localPath: "/p",
			defaultBranch: "main",
			addedAt: "x",
			lastFetchedAt: null,
			lastHeadSha: null,
		};
		const logs: { msg?: string }[] = [];
		const handle = startScheduler({
			tickMs: 100_000,
			repos: {
				projects: { listAll: () => [projectRow] } as never,
				agents: {} as never,
				graphRuns: {} as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () =>
				new Promise<LoadedWarrenConfig>((resolve) => {
					resolveInflight = () => resolve(emptyConfig());
				}),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "n/a" }),
			logger: {
				info: (obj, msg) => void logs.push({ msg: msg ?? String(obj) }),
				warn: (obj, msg) => void logs.push({ msg: msg ?? String(obj) }),
				error: (obj, msg) => void logs.push({ msg: msg ?? String(obj) }),
			},
		});

		const first = handle.runOnce();
		const second = handle.runOnce();
		expect(await second).toBeNull();
		expect(logs.some((l) => l.msg === "scheduler.tick_skipped")).toBe(true);
		resolveInflight();
		await first;
		await handle.stop();
	});

	test("stop() prevents further fires and drains the in-flight one", async () => {
		const handle = startScheduler({
			tickMs: 1,
			repos: {
				projects: { listAll: () => [] } as never,
				agents: {} as never,
				graphRuns: {} as never,
				triggers: {} as never,
				runs: {} as never,
				events: {} as never,
			},
			loadWarrenConfig: async () => emptyConfig(),
			listScheduledSeeds: async () => ({ scheduled: [], errors: [] }),
			updateExtensions: async () => {},
			spawn: async () => ({ runId: "n/a" }),
		});

		await handle.runOnce();
		await handle.stop();
		expect(await handle.runOnce()).toBeNull();
	});
});
