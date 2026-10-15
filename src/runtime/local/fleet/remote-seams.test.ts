import { describe, expect, it } from "bun:test";
import {
	createRemoteReapExec,
	createRemoteReapFs,
	type SshRunner,
	type SshRunOptions,
	type SshRunResult,
	shellCommand,
	shellQuote,
} from "./remote-seams.ts";

interface Call {
	readonly command: string;
	readonly args: readonly string[];
	readonly opts: SshRunOptions | undefined;
}

/** Records every call it receives and answers all of them with one result. */
function fakeSsh(result: SshRunResult, target = "warren@box-a"): { ssh: SshRunner; calls: Call[] } {
	const calls: Call[] = [];
	const ssh: SshRunner = {
		target,
		run: async (command, args, opts) => {
			calls.push({ command, args: [...args], opts });
			return result;
		},
	};
	return { ssh, calls };
}

/** Fixtures: the exit-0 / non-zero shapes every call site in this suite needs. */
const exited = (exitCode: number, stdout = "", stderr = ""): SshRunResult => ({
	stdout,
	stderr,
	exitCode,
});

describe("shellQuote", () => {
	it("wraps a plain value in single quotes", () => {
		expect(shellQuote("a b")).toBe("'a b'");
	});

	it("escapes an embedded single quote", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});
});

describe("shellCommand", () => {
	it("leaves the command bare and quotes every argument once", () => {
		expect(shellCommand("git", ["commit", "-m", "a b"])).toBe("git 'commit' '-m' 'a b'");
	});

	it("renders a command with no arguments as the bare command", () => {
		expect(shellCommand("pwd", [])).toBe("pwd");
	});
});

describe("createRemoteReapFs", () => {
	it("mkdirp runs mkdir -p over ssh", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapFs(ssh).mkdirp("/a b");
		expect(calls).toEqual([{ command: "mkdir", args: ["-p", "/a b"], opts: undefined }]);
	});

	it("mkdirp rejects with stderr in the message", async () => {
		const { ssh } = fakeSsh(exited(1, "", "permission denied"));
		await expect(createRemoteReapFs(ssh).mkdirp("/a")).rejects.toThrow(
			"mkdir -p on warren@box-a failed: permission denied",
		);
	});

	it("readFile returns stdout on exit 0", async () => {
		const { ssh, calls } = fakeSsh(exited(0, "contents"));
		expect(await createRemoteReapFs(ssh).readFile("/f")).toBe("contents");
		expect(calls).toEqual([{ command: "cat", args: ["--", "/f"], opts: undefined }]);
	});

	it("readFile returns null on a non-zero exit", async () => {
		const { ssh } = fakeSsh(exited(1, "", "No such file"));
		expect(await createRemoteReapFs(ssh).readFile("/f")).toBeNull();
	});

	it("writeFile runs tee and passes the contents as stdin", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapFs(ssh).writeFile("/f", "x'y\n");
		expect(calls).toEqual([{ command: "tee", args: ["--", "/f"], opts: { stdin: "x'y\n" } }]);
	});

	it("writeFile rejects when tee fails", async () => {
		const { ssh } = fakeSsh(exited(1, "", "denied"));
		await expect(createRemoteReapFs(ssh).writeFile("/f", "x")).rejects.toThrow(
			"tee on warren@box-a failed: denied",
		);
	});

	it("readdir splits and trims lines, dropping empties", async () => {
		const { ssh, calls } = fakeSsh(exited(0, "a\n  b  \n\nc\n"));
		expect(await createRemoteReapFs(ssh).readdir("/d")).toEqual(["a", "b", "c"]);
		expect(calls).toEqual([{ command: "ls", args: ["-1", "--", "/d"], opts: undefined }]);
	});

	it("readdir returns [] on a non-zero exit", async () => {
		const { ssh } = fakeSsh(exited(2, "", "No such directory"));
		expect(await createRemoteReapFs(ssh).readdir("/d")).toEqual([]);
	});
});

describe("createRemoteReapExec", () => {
	it("builds one bash -lc argument containing cd and exec", async () => {
		const { ssh, calls } = fakeSsh(exited(0, "out"));
		const result = await createRemoteReapExec(ssh).run("git", ["commit", "-m", "a b"], {
			cwd: "/w/x",
		});
		expect(result).toEqual({ stdout: "out", stderr: "" });
		expect(calls).toEqual([
			{
				command: "bash",
				args: ["-lc", "cd '/w/x' && exec git 'commit' '-m' 'a b'"],
				opts: undefined,
			},
		]);
	});

	it("prefixes env exports and unsets, in order, before cd", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapExec(ssh).run("true", [], {
			cwd: "/w",
			env: { A: "1", B: undefined, C: "x y" },
		});
		expect(calls[0]?.args[1]).toBe("export A='1'; unset B; export C='x y'; cd '/w' && exec true");
	});

	it("omits the env prefix when env is empty", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapExec(ssh).run("true", [], { cwd: "/w", env: {} });
		expect(calls[0]?.args[1]).toBe("cd '/w' && exec true");
	});

	it("forwards timeoutMs as the only ssh option", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapExec(ssh).run("sleep", ["1"], { cwd: "/w", timeoutMs: 5000 });
		expect(calls[0]?.opts).toEqual({ timeoutMs: 5000 });
	});

	it("passes no ssh options when timeoutMs is omitted", async () => {
		const { ssh, calls } = fakeSsh(exited(0));
		await createRemoteReapExec(ssh).run("true", [], { cwd: "/w" });
		expect(calls[0]?.opts).toBeUndefined();
	});

	it("resolves with stdout and stderr on exit 0", async () => {
		const { ssh } = fakeSsh(exited(0, "out", "warn"));
		expect(await createRemoteReapExec(ssh).run("true", [], { cwd: "/w" })).toEqual({
			stdout: "out",
			stderr: "warn",
		});
	});

	it("rejects with stderr in the message on a non-zero exit", async () => {
		const { ssh } = fakeSsh(exited(128, "", "fatal: not a git repo"));
		await expect(createRemoteReapExec(ssh).run("git", ["status"], { cwd: "/w" })).rejects.toThrow(
			"git on warren@box-a failed: fatal: not a git repo",
		);
	});

	it("falls back to the exit code when stderr is blank", async () => {
		const { ssh } = fakeSsh(exited(127, "", "  "));
		await expect(createRemoteReapExec(ssh).run("nope", [], { cwd: "/w" })).rejects.toThrow(
			"nope on warren@box-a failed: exit 127",
		);
	});
});
