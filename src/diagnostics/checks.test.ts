import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../projects/clone.ts";
import { captureSpawnCalls } from "./checks.test-helpers.ts";
import { checkBwrap, checkGitIdentity } from "./checks.ts";

describe("checkGitIdentity", () => {
	test("passes when both identity variables are configured", () => {
		const result = checkGitIdentity({
			WARREN_GIT_AUTHOR_NAME: "warren-run-bot",
			WARREN_GIT_AUTHOR_EMAIL: "123+warren-run-bot@users.noreply.github.com",
		});
		expect(result).toEqual({
			name: "git_identity",
			ok: true,
			message: "dedicated agent commit identity configured",
		});
	});

	test("fails clearly when the pair is missing or half-set", () => {
		expect(checkGitIdentity({}).message).toContain("are not configured");
		expect(checkGitIdentity({ WARREN_GIT_AUTHOR_NAME: "warren" }).message).toContain(
			"must be set together",
		);
	});
});

describe("checkBwrap", () => {
	test("ok when the functional sandbox probe exits 0 (warren-daef)", async () => {
		const { spawn, calls } = captureSpawnCalls({
			bwrap: { stdout: "", exitCode: 0 },
		});
		const result = await checkBwrap({ spawn, platform: "linux" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("sandbox");
		// The probe must exercise real sandbox creation the way burrow's
		// Linux spawn does (burrow SPEC §8.1): unshare the namespaces, bind
		// the host root read-only, and exec a no-op — a bare `--version`
		// passes on hosts where bwrap cannot create a user namespace.
		expect(calls[0]?.cmd).toEqual([
			"bwrap",
			"--unshare-all",
			"--share-net",
			"--ro-bind",
			"/",
			"/",
			"--die-with-parent",
			"--",
			"/bin/true",
		]);
	});

	test("fails with the namespace hint when the probe exits non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			bwrap: { stderr: "bwrap: setting up uid map: Permission denied", exitCode: 1 },
		});
		const result = await checkBwrap({ spawn, platform: "linux" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1");
		expect(result.message).toContain("uid map");
		expect(result.hint).toContain("bubblewrap");
		expect(result.hint).toContain("user namespaces");
	});

	test("fails with hint when spawn throws (binary missing)", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT bwrap");
		};
		const result = await checkBwrap({ spawn, platform: "linux" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
		expect(result.hint).toContain("bubblewrap");
	});

	test("respects bwrapBinary override", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/usr/local/bin/bwrap": { stdout: "", exitCode: 0 },
		});
		await checkBwrap({ spawn, bwrapBinary: "/usr/local/bin/bwrap", platform: "linux" });
		expect(calls[0]?.cmd?.[0]).toBe("/usr/local/bin/bwrap");
		expect(calls[0]?.cmd).toContain("--unshare-all");
	});

	test("skips gracefully on non-Linux platforms (sandbox-exec territory)", async () => {
		const { spawn, calls } = captureSpawnCalls({
			bwrap: { stdout: "", exitCode: 0 },
		});
		const result = await checkBwrap({ spawn, platform: "darwin" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("skipped");
		expect(result.message).toContain("sandbox-exec");
		expect(calls).toHaveLength(0);
	});
});
