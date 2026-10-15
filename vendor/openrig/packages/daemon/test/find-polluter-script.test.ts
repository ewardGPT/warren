import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("specs/agents/shared/skills/process/systematic-debugging/find-polluter.sh");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture(files: string[], mode = "clean", prior = false) {
 const dir = mkdtempSync(join(tmpdir(), "polluter-")); roots.push(dir);
 mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "src"));
 for (const file of files) writeFileSync(join(dir, "src", file), "");
 writeFileSync(join(dir, "bin", "npm"), '#!/bin/sh\nprintf "%s\\n" "$2" >> calls\ncase "$PROBE_MODE" in\n dirty) touch pollution;;\n fail) exit 7;;\nesac\n', { mode: 0o755 });
 if (prior) mkdirSync(join(dir, "pollution"));
 if (mode === "find-fail") writeFileSync(join(dir,"bin","find"),"#!/bin/sh\nexit 3\n",{mode:0o755});
 const result = spawnSync("bash", [script, "pollution", "src/*.test.ts"], {
  cwd: dir, env: { ...process.env, PATH: join(dir, "bin")+":"+process.env.PATH, PROBE_MODE: mode }, encoding: "utf8",
 });
 const calls = existsSync(join(dir,"calls")) ? readFileSync(join(dir,"calls"),"utf8").trim().split("\n") : [];
 return { ...result, calls };
}
describe("polluter search reports observed execution", () => {
 it("does not certify an empty selection", () => { const r=fixture([]); expect(r.status).toBe(2); expect(r.stdout).toContain("no tests ran"); expect(r.calls).toEqual([]); });
 it("does not hide a discovery command failure", () => { const r=fixture(["one.test.ts"],"find-fail"); expect(r.status).toBe(2); expect(r.stdout).toContain("selection failed"); expect(r.calls).toEqual([]); });
 it("counts and executes one matching file", () => { const r=fixture(["one.test.ts"]); expect(r.status).toBe(0); expect(r.stdout).toContain("Found 1 test files"); expect(r.calls).toEqual(["./src/one.test.ts"]); });
 it("keeps spaces in filenames and counts two files", () => { const r=fixture(["one test.test.ts","two.test.ts"]); expect(r.status).toBe(0); expect(r.stdout).toContain("Found 2 test files"); expect(r.calls).toEqual(["./src/one test.test.ts","./src/two.test.ts"]); });
 it("reports the causal polluter and stops", () => { const r=fixture(["one.test.ts","two.test.ts"],"dirty"); expect(r.status).toBe(1); expect(r.stdout).toContain("FOUND POLLUTER"); expect(r.calls).toEqual(["./src/one.test.ts"]); });
 it("does not treat a failing test as a clean pass", () => { const r=fixture(["one.test.ts"],"fail"); expect(r.status).toBe(2); expect(r.stdout).toContain("1 test runs failed"); expect(r.stdout).not.toContain("all tests clean"); });
 it("refuses preexisting pollution without running tests", () => { const r=fixture(["one.test.ts"],"clean",true); expect(r.status).toBe(2); expect(r.stdout).toContain("before"); expect(r.calls).toEqual([]); });
});
