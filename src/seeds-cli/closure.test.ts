import { describe, expect, test } from "bun:test";
import {
	CLOSURE_REASONS,
	type Closure,
	type ClosureFinding,
	type ClosureReason,
	CUSTODY_VERIFIED_PREFIX,
	formatClosureInput,
	isClosureReason,
	parseClosure,
	toQueueClosure,
	validateClosure,
} from "./closure.ts";

/** The error/warning codes a finding list carries, in order. */
const codes = (findings: readonly ClosureFinding[]): string[] => findings.map((f) => f.code);

/** Render a finding the way the CLI prints it (see closure.ts header). */
const render = (finding: ClosureFinding | undefined): string =>
	`${finding?.severity} ${finding?.code}: ${finding?.message}`;

const TARGET_REASONS = ["handed_off_to", "blocked_on", "escalation"] as const;
const BARE_REASONS = ["no-follow-on", "denied", "canceled"] as const;

describe("closure vocabulary", () => {
	test("CLOSURE_REASONS is the closed 7-value set, in documented order", () => {
		expect([...CLOSURE_REASONS]).toEqual([
			"no-follow-on",
			"handed_off_to",
			"blocked_on",
			"denied",
			"canceled",
			"escalation",
			"superseded",
		]);
	});

	test("isClosureReason narrows the vocabulary and nothing else", () => {
		for (const reason of CLOSURE_REASONS) expect(isClosureReason(reason)).toBe(true);
		expect(isClosureReason("done")).toBe(false);
		expect(isClosureReason("")).toBe(false);
		expect(isClosureReason(undefined)).toBe(false);
		expect(isClosureReason("Handed_off_to")).toBe(false);
	});

	test("CUSTODY_VERIFIED_PREFIX is the note token the contract parses", () => {
		expect(CUSTODY_VERIFIED_PREFIX).toBe("custody-verified:");
	});
});

describe("validateClosure — the closure reason itself", () => {
	test("no reason at all is closure_reason_required and yields no closure", () => {
		const result = validateClosure({});
		expect(codes(result.findings)).toEqual(["closure_reason_required"]);
		expect(result.findings[0]?.severity).toBe("error");
		expect(result.closure).toBeUndefined();
	});

	test("a whitespace-only reason counts as missing", () => {
		expect(codes(validateClosure({ reason: "   " }).findings)).toEqual(["closure_reason_required"]);
	});

	test("free text is not a closure reason (the strict path stays strict)", () => {
		const result = validateClosure({ reason: "done" });
		expect(codes(result.findings)).toEqual(["closure_reason_invalid"]);
		expect(result.findings[0]?.severity).toBe("error");
		expect(result.closure).toBeUndefined();
		expect(result.findings[0]?.message).toContain("no-follow-on, handed_off_to, blocked_on");
	});

	test("issueId prefixes every message so a batch close names its row", () => {
		const result = validateClosure({ issueId: "warren-1234", reason: "denied" });
		expect(result.findings).toEqual([]);
		const missing = validateClosure({ issueId: "warren-1234" }).findings[0];
		expect(missing?.message).toStartWith("warren-1234: close requires a closure reason");
	});
});

describe("validateClosure — per-reason fields", () => {
	for (const reason of TARGET_REASONS) {
		test(`${reason} requires a non-whitespace target`, () => {
			expect(codes(validateClosure({ reason }).findings)).toEqual(["closure_target_required"]);
			expect(codes(validateClosure({ reason, target: "   " }).findings)).toEqual([
				"closure_target_required",
			]);
			expect(codes(validateClosure({ reason, target: "  \t " }).findings)).toEqual([
				"closure_target_required",
			]);

			// handed_off_to names a receiver, so the custody warning rides along.
			const ok = validateClosure({ reason, target: "burrow-7b97" });
			expect(codes(ok.findings)).toEqual(reason === "handed_off_to" ? ["custody_unverified"] : []);
			expect(ok.closure).toEqual({ reason, target: "burrow-7b97" });
		});
	}

	test("a target is trimmed before it reaches the closure", () => {
		const ok = validateClosure({ reason: "blocked_on", target: "  warren-942c  " });
		expect(ok.closure).toEqual({ reason: "blocked_on", target: "warren-942c" });
	});

	test("handed_off_to does not admit a successor (the owner is the target)", () => {
		const result = validateClosure({
			reason: "handed_off_to",
			target: "burrow-7b97",
			successor: "warren-1",
		});
		expect(codes(result.findings)).toEqual(["closure_fields_not_admitted", "custody_unverified"]);
		expect(result.closure).toBeUndefined();
	});

	test("superseded requires a non-whitespace successor", () => {
		expect(codes(validateClosure({ reason: "superseded" }).findings)).toEqual([
			"closure_successor_required",
		]);
		expect(codes(validateClosure({ reason: "superseded", successor: "  " }).findings)).toEqual([
			"closure_successor_required",
		]);

		// a named successor is a receiving end, so custody is checked too.
		const ok = validateClosure({ reason: "superseded", successor: "warren-554f" });
		expect(codes(ok.findings)).toEqual(["custody_unverified"]);
		expect(ok.closure).toEqual({ reason: "superseded", successor: "warren-554f" });
	});

	test("superseded does not admit a target, and still needs its successor", () => {
		expect(codes(validateClosure({ reason: "superseded", target: "warren-1" }).findings)).toEqual([
			"closure_fields_not_admitted",
			"closure_successor_required",
		]);
		expect(
			codes(
				validateClosure({ reason: "superseded", target: "warren-1", successor: "warren-2" })
					.findings,
			),
		).toEqual(["closure_fields_not_admitted", "custody_unverified"]);
	});

	for (const reason of BARE_REASONS) {
		test(`${reason} admits neither a target nor a successor`, () => {
			const ok = validateClosure({ reason });
			expect(ok.findings).toEqual([]);
			expect(ok.closure).toEqual({ reason });

			expect(codes(validateClosure({ reason, target: "warren-1" }).findings)).toEqual([
				"closure_fields_not_admitted",
			]);
			expect(codes(validateClosure({ reason, successor: "warren-1" }).findings)).toEqual([
				"closure_fields_not_admitted",
			]);
			expect(
				codes(validateClosure({ reason, target: "warren-1", successor: "warren-2" }).findings),
			).toEqual(["closure_fields_not_admitted", "closure_fields_not_admitted"]);
			expect(validateClosure({ reason, target: "warren-1" }).closure).toBeUndefined();
		});
	}
});

describe("validateClosure — custody", () => {
	test("a handoff without evidence warns, but the closure still stands", () => {
		const result = validateClosure({ reason: "handed_off_to", target: "burrow-7b97" });
		expect(codes(result.findings)).toEqual(["custody_unverified"]);
		expect(result.findings[0]?.severity).toBe("warning");
		expect(result.closure).toEqual({ reason: "handed_off_to", target: "burrow-7b97" });
	});

	test("a matching custody-verified note silences the warning", () => {
		const result = validateClosure({
			reason: "handed_off_to",
			target: "burrow-7b97",
			custodyNote: "custody-verified: burrow-7b97 confirmed on the parent host",
		});
		expect(result.findings).toEqual([]);
		expect(result.closure).toEqual({
			reason: "handed_off_to",
			target: "burrow-7b97",
			custodyVerified: "burrow-7b97",
		});
	});

	test("a custody note naming a different target verifies nothing", () => {
		expect(
			codes(
				validateClosure({
					reason: "handed_off_to",
					target: "burrow-7b97",
					custodyNote: "custody-verified: burrow-other confirmed elsewhere",
				}).findings,
			),
		).toEqual(["custody_unverified"]);
	});

	test("the custody token is prefix-anchored, so prose mentioning it does not count", () => {
		expect(
			codes(
				validateClosure({
					reason: "handed_off_to",
					target: "burrow-7b97",
					custodyNote: "nothing here, not custody-verified: burrow-7b97 at all",
				}).findings,
			),
		).toEqual(["custody_unverified"]);
	});

	test("row notes are a fallback source for the custody note", () => {
		const result = validateClosure({
			reason: "superseded",
			successor: "warren-554f",
			notes:
				"close: see below. custody-verified: warren-554f confirmed on the parent host via OPENRIG_URL read",
		});
		expect(result.findings).toEqual([]);
		expect(result.closure?.custodyVerified).toBe("warren-554f");
	});

	test("a superseded close with no successor cannot be custody-verified", () => {
		const result = validateClosure({
			reason: "superseded",
			custodyNote: "custody-verified: warren-554f ok",
		});
		expect(codes(result.findings)).toEqual(["closure_successor_required"]);
	});

	test("reasons that name no receiving issue need no custody", () => {
		expect(validateClosure({ reason: "blocked_on", target: "warren-942c" }).findings).toEqual([]);
		expect(validateClosure({ reason: "no-follow-on" }).findings).toEqual([]);
		expect(validateClosure({ reason: "denied" }).findings).toEqual([]);
		expect(validateClosure({ reason: "canceled" }).findings).toEqual([]);
		expect(validateClosure({ reason: "escalation", target: "warren-9000" }).findings).toEqual([]);
	});
});

describe("parseClosure — historical free text", () => {
	const cases: ReadonlyArray<readonly [string, string, ClosureReason, string | undefined]> = [
		[
			"handed off (upstream prose)",
			"Moved to burrow-7b97 — the fix lives in burrow's startServer, not in warren. Tracking continues there.",
			"handed_off_to",
			"burrow-7b97",
		],
		["handed to", "handed to warren-1234", "handed_off_to", "warren-1234"],
		[
			"tracked elsewhere",
			"Architecturally a burrow issue; tracked there as burrow-7a80. Fix lands in burrow's worktree composition.",
			"handed_off_to",
			"burrow-7a80",
		],
		[
			"superseded by",
			"superseded by warren-554f: repo-cache PVC removed from base manifests in PR #719",
			"superseded",
			"warren-554f",
		],
		["obsoleted by plan", "obsoleted by plan pl-fef5 revision 2", "superseded", "pl-fef5"],
		[
			"duplicate of",
			"Duplicate of warren-d519 (upstream seeds-cli tracker filed during pl-5310 step 4).",
			"superseded",
			"warren-d519",
		],
		[
			"adopted as",
			"Adopted into pl-5310 as warren-7c3f (step 3: PlotDetail batch Dispatch all attached seeds button).",
			"superseded",
			"warren-7c3f",
		],
		[
			"folded into",
			"Folded into warren-2680 (pl-f1be step warren-670f).",
			"superseded",
			"warren-2680",
		],
		[
			"shipped as another issue",
			"Already shipped as warren-ff2a (per-seeds_issue-attachment Run button on PlotDetail).",
			"superseded",
			"warren-ff2a",
		],
		[
			"blocked on",
			"blocked on R-13 (warren-942c) shipping the Postgres backend",
			"blocked_on",
			"warren-942c",
		],
		[
			"escalated to",
			"escalated to warren-9000 after two failed attempts",
			"escalation",
			"warren-9000",
		],
		["done", "done", "no-follow-on", undefined],
		[
			"shipped",
			"Shipped via PR #235 (merged 2026-05-29): src/ci-fixer/ + pr-fixer builtin agent",
			"no-follow-on",
			undefined,
		],
		["resolved", "Resolved by prior work — fix A + D both in place.", "no-follow-on", undefined],
		[
			"landed",
			"Landed jscpd guard via .jscpd.json + check:duplicates script, wired into ci.yml.",
			"no-follow-on",
			undefined,
		],
		[
			"completion verb inside the first clause",
			"plan pl-a31c complete: seed.ts is a pure builder (warren-e238), spawn.ts threads seed.files",
			"no-follow-on",
			undefined,
		],
	];

	for (const [label, text, reason, named] of cases) {
		test(`${label}: ${text.slice(0, 48)}…`, () => {
			const result = parseClosure(text);
			expect(result.closure?.reason).toBe(reason);
			if (reason === "superseded") expect(result.closure?.successor).toBe(named);
			else expect(result.closure?.target).toBe(named);
			expect(result.closure?.note).toBe(text);
			expect(codes(result.findings)).not.toContain("closure_reason_unparsed");
		});
	}

	test("the canonical form is read back exactly, target and note included", () => {
		const result = parseClosure("handed_off_to: burrow-7b97 — waiting on review");
		expect(codes(result.findings)).toEqual(["custody_unverified"]);
		expect(result.closure).toEqual({
			reason: "handed_off_to",
			target: "burrow-7b97",
			note: "waiting on review",
		});
	});

	test("an unrecognisable reason warns and never invents a closure", () => {
		const text =
			"Operator decision: ux-whisper UI telemetry agent — dormant feature proposal, not being pursued. Closing per human triage.";
		const result = parseClosure(text);
		expect(codes(result.findings)).toEqual(["closure_reason_unparsed"]);
		expect(result.findings[0]?.severity).toBe("warning");
		expect(result.closure).toBeUndefined();
		expect(result.findings[0]?.message).toContain("dormant feature proposal");
	});

	test("an absent or blank reason is closure_reason_required, not unparsed", () => {
		expect(codes(parseClosure(undefined).findings)).toEqual(["closure_reason_required"]);
		expect(codes(parseClosure("   ").findings)).toEqual(["closure_reason_required"]);
		expect(parseClosure(undefined).closure).toBeUndefined();
	});

	test("a bare 'superseded' cannot invent the successor it owes", () => {
		const result = parseClosure("superseded");
		expect(codes(result.findings)).toEqual(["closure_reason_unparsed"]);
		expect(result.closure).toBeUndefined();
	});

	test("prose without an id-shaped target is refused rather than guessed", () => {
		expect(codes(parseClosure("Moved to the platform team eventually").findings)).toEqual([
			"closure_reason_unparsed",
		]);
	});

	test("a parsed handoff warns about custody; note evidence inside the prose settles it", () => {
		const bare = parseClosure("Moved to burrow-7b97 — the fix lives in burrow's startServer");
		expect(codes(bare.findings)).toEqual(["custody_unverified"]);
		expect(bare.closure?.target).toBe("burrow-7b97");

		const settled = parseClosure(
			"Moved to burrow-7b97. custody-verified: burrow-7b97 confirmed on the parent host",
		);
		expect(settled.findings).toEqual([]);
		expect(settled.closure?.custodyVerified).toBe("burrow-7b97");
	});

	test("a completion narrative carries no custody obligation", () => {
		expect(parseClosure("Fixed the readiness probe timeout.").findings).toEqual([]);
	});
});

describe("formatClosureInput / parseClosure round trip", () => {
	const closures: readonly Closure[] = [
		{ reason: "no-follow-on" },
		{ reason: "no-follow-on", note: "shipped in PR #9" },
		{ reason: "handed_off_to", target: "burrow-7b97" },
		{ reason: "handed_off_to", target: "burrow-7b97", note: "waiting on review" },
		{ reason: "blocked_on", target: "warren-942c", note: "waits on the Postgres backend" },
		{ reason: "escalation", target: "warren-9000" },
		{ reason: "denied", note: "receiver rejected the work" },
		{ reason: "canceled" },
		{ reason: "superseded", successor: "warren-554f" },
		{ reason: "superseded", successor: "warren-554f", note: "obsoleted by plan pl-fef5" },
	];

	for (const closure of closures) {
		test(`${closure.reason} survives format → parse`, () => {
			const text = formatClosureInput(closure);
			expect(text.startsWith(closure.reason)).toBe(true);
			const reparsed = parseClosure(text);
			expect(reparsed.closure?.reason).toBe(closure.reason);
			expect(reparsed.closure?.target).toBe(closure.target);
			expect(reparsed.closure?.successor).toBe(closure.successor);
			expect(reparsed.closure?.note).toBe(closure.note);
		});
	}

	test("a fieldless reason formats as the bare token", () => {
		expect(formatClosureInput({ reason: "canceled", note: "   " })).toBe("canceled");
	});

	test("formatClosureInput output is accepted by validateClosure as-is", () => {
		for (const closure of closures) {
			const text = formatClosureInput(closure);
			const checked = validateClosure({
				reason: closure.reason,
				...(closure.target !== undefined ? { target: closure.target } : {}),
				...(closure.successor !== undefined ? { successor: closure.successor } : {}),
			});
			expect(checked.closure).toBeDefined();
			expect(text.length).toBeGreaterThan(0);
		}
	});
});

describe("toQueueClosure", () => {
	test("target reasons map onto closure_target", () => {
		expect(toQueueClosure({ reason: "handed_off_to", target: "burrow-7b97" })).toEqual({
			closure_reason: "handed_off_to",
			closure_target: "burrow-7b97",
		});
		expect(toQueueClosure({ reason: "blocked_on", target: "warren-942c" })).toEqual({
			closure_reason: "blocked_on",
			closure_target: "warren-942c",
		});
		expect(toQueueClosure({ reason: "escalation", target: "warren-9000" })).toEqual({
			closure_reason: "escalation",
			closure_target: "warren-9000",
		});
	});

	test("a supersede successor is stored as closure_target (upstream shape)", () => {
		expect(toQueueClosure({ reason: "superseded", successor: "warren-554f" })).toEqual({
			closure_reason: "superseded",
			closure_target: "warren-554f",
		});
	});

	test("reasons that name nothing omit the key entirely", () => {
		for (const reason of BARE_REASONS) {
			const queued = toQueueClosure({ reason });
			expect(queued).toEqual({ closure_reason: reason });
			expect("closure_target" in queued).toBe(false);
		}
	});

	test("a parsed historical closure maps the same way as a validated one", () => {
		const parsed = parseClosure("Moved to burrow-7b97 — the fix lives in burrow's startServer");
		expect(parsed.closure?.target).toBe("burrow-7b97");
		expect(parsed.closure === undefined ? undefined : toQueueClosure(parsed.closure)).toEqual({
			closure_reason: "handed_off_to",
			closure_target: "burrow-7b97",
		});
	});
});

describe("findings as the CLI prints them", () => {
	test("one line per finding: `<severity> <code>: <message>`", () => {
		const findings = validateClosure({ issueId: "warren-1234", reason: "handed_off_to" }).findings;
		expect(findings.every((f) => !f.message.includes("\n"))).toBe(true);
		expect(render(findings[0])).toBe(
			"error closure_target_required: warren-1234: closure reason handed_off_to requires a non-empty target (new owner, blocker id, or escalation target); whitespace does not count",
		);
	});

	test("a forbidden field reads unambiguously", () => {
		const findings = validateClosure({
			issueId: "warren-1234",
			reason: "no-follow-on",
			target: "warren-9",
		}).findings;
		expect(render(findings[0])).toBe(
			'error closure_fields_not_admitted: warren-1234: closure reason no-follow-on does not admit target ("warren-9")',
		);
	});

	test("an unparsed historical reason points at the fix", () => {
		const findings = parseClosure("shrug, ask later").findings;
		expect(render(findings[0])).toBe(
			'warning closure_reason_unparsed: could not parse closure reason "shrug, ask later"; close with an explicit reason (no-follow-on, handed_off_to, blocked_on, denied, canceled, escalation, superseded)',
		);
	});
});
