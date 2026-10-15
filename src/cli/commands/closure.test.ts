import { describe, expect, test } from "bun:test";
import type { CliContext } from "../output.ts";
import { runClosure } from "./closure.ts";

function harness(): { context: CliContext; out: () => string; err: () => string } {
	let stdout = "";
	let stderr = "";
	return {
		context: {
			env: {},
			stdio: { stdout: { write: (c) => (stdout += c) }, stderr: { write: (c) => (stderr += c) } },
			spawn: () => Promise.reject(new Error("the closure command must not spawn")),
		},
		out: () => stdout,
		err: () => stderr,
	};
}

describe("warren closure", () => {
	test("prints the canonical string for a handoff", () => {
		const h = harness();
		expect(
			runClosure(h.context, {
				reason: "handed_off_to",
				target: "burrow-7b97",
				note: "waiting on their review",
			}),
		).toBe(0);
		expect(h.out()).toContain("handed_off_to: burrow-7b97 — waiting on their review");
		expect(h.out()).toContain("sd close <id> --reason");
	});

	test("a handoff without a target is refused with the rule name", () => {
		const h = harness();
		expect(runClosure(h.context, { reason: "handed_off_to" })).toBe(1);
		expect(h.err()).toContain("closure_target_required");
		expect(h.out()).toBe("");
	});

	test("a reason outside the vocabulary is refused", () => {
		const h = harness();
		expect(runClosure(h.context, { reason: "finished-ish" })).toBe(1);
		expect(h.err()).toContain("is not a closure reason");
	});

	test("a successor-only reason formats with the successor", () => {
		const h = harness();
		expect(runClosure(h.context, { reason: "superseded", successor: "warren-554f" })).toBe(0);
		expect(h.out()).toContain("superseded: warren-554f");
	});

	test("a reason that admits no field refuses one", () => {
		const h = harness();
		expect(runClosure(h.context, { reason: "no-follow-on", target: "warren-1234" })).toBe(1);
		expect(h.err()).toContain("closure_fields_not_admitted");
	});

	test("--json carries the closure and its queue mapping", () => {
		const h = harness();
		expect(runClosure(h.context, { reason: "blocked_on", target: "warren-942c", json: true })).toBe(
			0,
		);
		const parsed = JSON.parse(h.out()) as {
			canonical: string;
			queue: { closure_reason: string; closure_target?: string };
		};
		expect(parsed.canonical).toBe("blocked_on: warren-942c");
		expect(parsed.queue).toEqual({ closure_reason: "blocked_on", closure_target: "warren-942c" });
	});
});
