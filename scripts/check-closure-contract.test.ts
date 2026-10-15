import { describe, expect, test } from "bun:test";
import { auditClosures, type IssueRow, parseIssues } from "./check-closure-contract.ts";

const BASELINE = "2026-06-01T00:00:00.000Z";

function row(fields: IssueRow & { id: string }): { row: IssueRow; line: number } {
	return { row: fields, line: 1 };
}

function closed(
	id: string,
	closedAt: string,
	closeReason?: string,
): { row: IssueRow; line: number } {
	return {
		row: { id, status: "closed", closedAt, ...(closeReason === undefined ? {} : { closeReason }) },
		line: 1,
	};
}

describe("auditClosures", () => {
	test("history before the baseline is debt, never a failure", () => {
		const audit = auditClosures(
			[
				closed("a-1", "2026-05-01T00:00:00.000Z"),
				closed("a-2", "2026-05-02T00:00:00.000Z", "did the thing"),
			],
			BASELINE,
		);
		expect(audit.closed).toBe(2);
		expect(audit.legacy).toBe(2);
		expect(audit.legacyWithoutReason).toBe(1);
		expect(audit.legacyUnparsed).toBe(1);
		expect(audit.missingReason).toEqual([]);
		expect(audit.violations).toEqual([]);
	});

	test("a closure after the baseline with no reason fails", () => {
		const audit = auditClosures([closed("b-1", "2026-07-01T00:00:00.000Z")], BASELINE);
		expect(audit.missingReason).toHaveLength(1);
		expect(audit.missingReason[0]?.code).toBe("closure_reason_required");
	});

	test("a closure after the baseline in prose outside the vocabulary fails", () => {
		const audit = auditClosures(
			[closed("b-2", "2026-07-01T00:00:00.000Z", "Operator decision: this is not being pursued")],
			BASELINE,
		);
		expect(audit.missingReason).toHaveLength(1);
		expect(audit.missingReason[0]?.code).toBe("closure_reason_unparsed");
	});

	test("a closure after the baseline with a contract violation fails with the rule code", () => {
		const audit = auditClosures(
			[closed("b-3", "2026-07-01T00:00:00.000Z", "handed_off_to")],
			BASELINE,
		);
		expect(audit.violations).toHaveLength(1);
		expect(audit.violations[0]?.code).toBe("closure_target_required");
		expect(audit.missingReason).toEqual([]);
	});

	test("a closure after the baseline that follows the contract passes", () => {
		const audit = auditClosures(
			[
				closed(
					"ok-1",
					"2026-07-01T00:00:00.000Z",
					"Moved to burrow-7b97 — waiting on their review",
				),
				closed("ok-2", "2026-07-02T00:00:00.000Z", "superseded by warren-554f"),
				closed("ok-3", "2026-07-03T00:00:00.000Z", "done"),
			],
			BASELINE,
		);
		expect(audit.missingReason).toEqual([]);
		expect(audit.violations).toEqual([]);
		expect(audit.legacyUnparsed).toBe(0);
	});

	test("an unreadable closedAt counts as history, not as a new closure", () => {
		const audit = auditClosures([{ row: { id: "c-1", status: "closed" }, line: 9 }], BASELINE);
		expect(audit.legacy).toBe(1);
		expect(audit.legacyWithoutReason).toBe(1);
		expect(audit.missingReason).toEqual([]);
	});

	test("open rows are ignored", () => {
		const audit = auditClosures(
			[row({ id: "d-1", status: "open" }), row({ id: "d-2", status: "blocked" })],
			BASELINE,
		);
		expect(audit.closed).toBe(0);
	});

	test("the finding carries the line the row came from", () => {
		const audit = auditClosures(
			[{ row: { id: "e-1", status: "closed", closedAt: "2026-07-01T00:00:00.000Z" }, line: 42 }],
			BASELINE,
		);
		expect(audit.missingReason[0]?.line).toBe(42);
	});
});

describe("parseIssues", () => {
	test("keeps line numbers, skips blanks, and ignores malformed rows", () => {
		const rows = parseIssues(
			'{"id":"a","status":"closed"}\n\n{not json}\n{"id":"b","status":"open"}\n',
		);
		expect(rows.map((r) => r.line)).toEqual([1, 4]);
		expect(rows.map((r) => r.row.id)).toEqual(["a", "b"]);
	});
});
