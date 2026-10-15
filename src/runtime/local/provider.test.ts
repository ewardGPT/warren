import { describe, expect, test } from "bun:test";
import type { BurrowClient } from "../../burrow-client/index.ts";
import { LOCAL_PROVIDER_CAPABILITIES, LocalProvider, type LocalProviderDeps } from "./provider.ts";

/**
 * Hermetic deps for the capability assertions below: the factory throws if a
 * method ever touches the pool. Every method now has a real body — the live
 * paths are covered per-method (`create.test.ts`, `stream.test.ts`,
 * `status.test.ts`, `send-message.test.ts`, `cancel.test.ts`,
 * `teardown.test.ts`, `finalize.test.ts`).
 */
const deps: LocalProviderDeps = {
	burrowClient: (): BurrowClient => {
		throw new Error("burrowClient factory must not be called by a LocalProvider stub");
	},
};

describe("LocalProvider", () => {
	test("advertises the full burrow capability set", () => {
		const provider = new LocalProvider(deps);
		expect(provider.capabilities).toBe(LOCAL_PROVIDER_CAPABILITIES);
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		});
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(LOCAL_PROVIDER_CAPABILITIES)).toBe(true);
	});

	// ubuntu-c929: reap's salvage and the scorecard's diff run outside
	// `finalize`, so reap asks the provider which machine owns the workspace.
	// Answering undefined keeps the host's own seams in charge.
	test("exposes the workspace seams it was built with, and nothing when it has none", () => {
		const exec = {
			run: async () => ({ stdout: "", stderr: "" }),
		};
		const fs = {
			readFile: async () => "",
			writeFile: async () => undefined,
			exists: async () => false,
			mkdir: async () => undefined,
			readDir: async () => [],
			rm: async () => undefined,
		} as unknown as NonNullable<LocalProviderDeps["fs"]>;
		const withSeams = new LocalProvider({ ...deps, fs, exec });
		expect(withSeams.workspaceSeams()).toEqual({ fs, exec });
		// Only what exists is reported: a half-wired provider must not shadow the
		// host's seam with an undefined one.
		expect(new LocalProvider({ ...deps, exec }).workspaceSeams()).toEqual({ exec });
		expect(new LocalProvider(deps).workspaceSeams()).toBeUndefined();
	});
});
