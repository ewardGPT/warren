import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	KERNEL_ENTRY_ENV,
	KERNEL_RUNTIME_ENV,
	pathFinder,
	RIG_BINARY,
	resolveKernelEntry,
	VENDORED_KERNEL_ENTRY,
} from "./entry.ts";
import { KernelError } from "./paths.ts";

const REPO_ROOT = "/repo";
const VENDORED = join(REPO_ROOT, VENDORED_KERNEL_ENTRY);
const ENV = { PATH: "/usr/bin" };

const present = (...paths: string[]): ((path: string) => boolean) => {
	const set = new Set(paths);
	return (path) => set.has(path);
};

describe("resolveKernelEntry", () => {
	test("uses WARREN_KERNEL_ENTRY when set, ahead of the vendored build", () => {
		const explicit = "/opt/kernel/daemon.js";
		const resolved = resolveKernelEntry({
			env: { ...ENV, [KERNEL_ENTRY_ENV]: explicit },
			repoRoot: REPO_ROOT,
			exists: present(explicit, VENDORED),
		});
		expect(resolved.kind).toBe("env");
		expect(resolved.entry).toBe(explicit);
		expect(resolved.argv).toEqual(["node", explicit]);
		expect(resolved.source).toContain(`${KERNEL_ENTRY_ENV}=${explicit}`);
	});

	test("fails loudly when WARREN_KERNEL_ENTRY names a missing file", () => {
		expect(() =>
			resolveKernelEntry({
				env: { ...ENV, [KERNEL_ENTRY_ENV]: "/nope/daemon.js" },
				repoRoot: REPO_ROOT,
				exists: present(VENDORED),
			}),
		).toThrow(/does not exist/);
	});

	test("falls back to the vendored build entry", () => {
		const resolved = resolveKernelEntry({
			env: ENV,
			repoRoot: REPO_ROOT,
			exists: present(VENDORED),
		});
		expect(resolved.kind).toBe("vendored");
		expect(resolved.entry).toBe(VENDORED);
		expect(resolved.argv).toEqual(["node", VENDORED]);
		expect(resolved.source).toContain("vendored build");
	});

	test("runs a JS entry under the configured kernel runtime", () => {
		const resolved = resolveKernelEntry({
			env: { ...ENV, [KERNEL_RUNTIME_ENV]: "/usr/local/bin/bun" },
			repoRoot: REPO_ROOT,
			exists: present(VENDORED),
		});
		expect(resolved.argv).toEqual(["/usr/local/bin/bun", VENDORED]);
	});

	test("executes a non-JS entry as-is, with no runtime prefix", () => {
		const resolved = resolveKernelEntry({
			env: { ...ENV, [KERNEL_ENTRY_ENV]: "/usr/local/bin/rig-daemon" },
			repoRoot: REPO_ROOT,
			exists: present("/usr/local/bin/rig-daemon"),
		});
		expect(resolved.argv).toEqual(["/usr/local/bin/rig-daemon"]);
	});

	test("resolves the daemon bundled next to a rig on PATH (npm layout)", () => {
		const rig = "/usr/local/bin/rig";
		const bundled = "/opt/openrig/cli/daemon/dist/index.js";
		const resolved = resolveKernelEntry({
			env: ENV,
			repoRoot: REPO_ROOT,
			exists: present(rig, bundled),
			findOnPath: (binary) => (binary === RIG_BINARY ? rig : null),
			realpath: () => "/opt/openrig/cli/dist/bin-wrapper.js",
		});
		expect(resolved.kind).toBe("rig");
		expect(resolved.entry).toBe(bundled);
		expect(resolved.argv).toEqual(["node", bundled]);
		expect(resolved.source).toContain(rig);
	});

	test("prefers the monorepo daemon sibling over the bundled copy", () => {
		const rig = "/usr/local/bin/rig";
		const monorepo = "/opt/openrig/packages/daemon/dist/index.js";
		const bundled = "/opt/openrig/packages/cli/daemon/dist/index.js";
		const resolved = resolveKernelEntry({
			env: ENV,
			repoRoot: REPO_ROOT,
			exists: present(rig, monorepo, bundled),
			findOnPath: () => rig,
			realpath: () => "/opt/openrig/packages/cli/dist/bin-wrapper.js",
		});
		expect(resolved.entry).toBe(monorepo);
	});

	test("reports a rig install with no daemon instead of spawning nothing", () => {
		expect(() =>
			resolveKernelEntry({
				env: ENV,
				repoRoot: REPO_ROOT,
				exists: present("/usr/local/bin/rig"),
				findOnPath: () => "/usr/local/bin/rig",
				realpath: () => "/usr/local/bin/rig",
			}),
		).toThrow(/no bundled daemon/);
	});

	test("names every arm it tried when nothing resolves", () => {
		const error = (() => {
			try {
				resolveKernelEntry({ env: {}, repoRoot: REPO_ROOT, exists: () => false });
				return null;
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(error).toBeInstanceOf(KernelError);
		const wrapped = error as KernelError;
		expect(wrapped.message).toContain(KERNEL_ENTRY_ENV);
		expect(wrapped.message).toContain(VENDORED);
		expect(wrapped.detail).toContain("Install @openrig/cli");
	});

	test("pathFinder walks PATH in order and reports a miss", () => {
		const find = pathFinder({ PATH: "/a:/b::/c" }, present("/b/rig"));
		expect(find("rig")).toBe("/b/rig");
		expect(find("missing")).toBeNull();
	});
});
