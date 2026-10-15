/**
 * Closure contract for Seeds work — the "hot potato" rule, adopted from
 * OpenRig's `hot-potato-enforcer`
 * (`vendor/openrig/packages/daemon/src/domain/hot-potato-enforcer.ts`, see
 * also `vendor/openrig/docs/as-built/architecture/coordination-primitive.md`
 * §3 for the queue-side version of this contract).
 *
 * The problem this fixes: `sd close <id>` records `Issue.closeReason` as an
 * unbounded prose blob (or nothing at all), so a baton dropped mid-handoff is
 * indistinguishable from a completed task. In this repo's `.seeds/issues.jsonl`
 * 407 of the closed seeds carry a `closeReason` at all, and every one of them
 * is prose ("Moved to burrow-7b97 …", "obsoleted by plan pl-fef5 revision 2",
 * "done"). Nothing here can be enforced by a schema, so the closure *reason*
 * becomes a small, closed vocabulary and the prose survives only as `note`.
 *
 * This module is the pure half of the contract: no filesystem, no database, no
 * shell-out to `sd`. It validates a closure, and it reads the historical prose
 * back into the same shape (`parseClosure`) so adoption does not require
 * rewriting history.
 *
 * ## The rule set
 *
 * `Closure = { reason, target?, successor?, note?, custodyVerified? }`.
 * `target` is the new owner / blocker id / escalation target; `successor` is
 * the replacing issue id.
 *
 * | reason          | target     | successor  | meaning                          |
 * | --------------- | ---------- | ---------- | -------------------------------- |
 * | `handed_off_to` | required   | not adm.   | work continues with a new owner   |
 * | `blocked_on`    | required   | not adm.   | parked pending another issue      |
 * | `escalation`    | required   | not adm.   | kicked up a tier                  |
 * | `superseded`    | not adm.   | required   | replaced by a successor issue     |
 * | `no-follow-on`  | forbidden  | forbidden  | terminal completion, nothing owed |
 * | `denied`        | forbidden  | forbidden  | receiver rejected the work        |
 * | `canceled`      | forbidden  | forbidden  | withdrawn, no onward owner        |
 *
 * "required" → a missing *or whitespace-only* field is `closure_target_required`
 * / `closure_successor_required`. "forbidden"/"not adm." → a present field is
 * `closure_fields_not_admitted`. A close with no reason at all is
 * `closure_reason_required`; a reason outside the vocabulary is
 * `closure_reason_invalid`. `validateClosure` returns a `closure` only when it
 * emitted no error findings — an invalid close has no closure to persist.
 *
 * ## Custody
 *
 * A closure that moves work on (`handed_off_to`) or names a replacement
 * (`superseded`) is only as trustworthy as the receiving end. Custody holds
 * when either (a) the successor exists in the seeds data, or (b) a note
 * recorded with the closure names it: `custody-verified: <target> <how>`.
 *
 * (a) is the job of the caller, which holds the parsed `.seeds/` rows; this
 * validator cannot see them. (b) is parsed here, prefix-anchored on the note
 * segment and *exact* on the target — a note naming a different target
 * verifies nothing (upstream `CUSTODY_VERIFIED_PREFIX` behaviour). Without
 * either, the finding is `custody_unverified`, a **warning, not an error**:
 * the successor may still arrive, so this must not block a close.
 *
 * `validateClosure` reads the custody note from `custodyNote` (the note written
 * with the closure) and falls back to `notes` (the row's accumulated notes, so
 * a custody note recorded earlier still counts). `closure.custodyVerified`
 * echoes the target that was actually verified.
 *
 * ## The historical free-text shapes `parseClosure` recognises
 *
 * Tiers are tried in order; the first tier that yields a *valid* closure wins.
 * `<id>` is `[a-z][a-z0-9]*-[a-z0-9]{4,}` (suffix ≥ 4 chars, so `seeds-cli`,
 * `ci-postgres` and `burrow-cli` do not read as ids) matched case-sensitively.
 *
 * | tier | pattern (case-insensitive, tier 1 matches anywhere)              | maps to                   |
 * | ---- | --------------------------------------------------------------- | ------------------------- |
 * | 0    | `^<reason>$` alone, or `^<reason>(: \| — \| - ) <field> — <note>` —   | that reason, fields as-is |
 * |      | the form `formatClosureInput` prints                             |                           |
 * | 1    | `(superseded\|obsoleted\|replaced) (by\|with) …<id>…`             | `superseded` / successor  |
 * | 1    | `adopted into <plan> as …<id>…`                                 | `superseded` / successor  |
 * | 1    | `adopted into [plan] …<id>…`                                     | `superseded` / successor  |
 * | 1    | `folded into …<id>…`                                            | `superseded` / successor  |
 * | 1    | `duplicate of …<id>…`                                           | `superseded` / successor  |
 * | 1    | `[already] shipped as …<id>…`                                   | `superseded` / successor  |
 * | 1    | `(moved\|handed\|transferred\|tossed) (to\|off to\|over to) …<id>…` | `handed_off_to` / target |
 * | 1    | `tracked (there\|in <path>) as …<id>…`                            | `handed_off_to` / target  |
 * | 1    | `blocked on …<id>…`                                             | `blocked_on` / target     |
 * | 1    | `escalat(ed\|ion) (to\|:) …<id>…`                                | `escalation` / target     |
 * | 1    | leading `denied\|rejected\|declined`                             | `denied`                  |
 * | 1    | leading `canceled\|cancelled\|withdrawn\|abandoned`              | `canceled`                |
 * | 1    | leading `no-follow-on` / `no follow on`                          | `no-follow-on`            |
 * | 2    | leading completion word (`done`, `fixed`, `shipped`, `closed`,   | `no-follow-on`            |
 * |      | `resolved`, `landed`, `merged`, `implemented`, `verified`,       |                           |
 * |      | `obsolete`, `added`, `removed`, `deleted`, `dropped`, `pr #<n>`) |                           |
 * | 2    | a completion verb anywhere in the first clause (`… shipped …`)   | `no-follow-on`            |
 * | —    | anything else                                                    | `closure_reason_unparsed` |
 *
 * The tier-1 patterns take the *first* id-shaped token in the clause, which is
 * how `blocked on R-13 (warren-942c)` resolves to target `warren-942c`. Parsed
 * closures keep the original prose in `note`, so nothing is lost; a shape that
 * cannot be recognised yields the warning `closure_reason_unparsed`, and an
 * empty/absent reason yields the error `closure_reason_required`.
 *
 * A parse never fabricates a required field: `"superseded"` on its own is
 * unrecognised (a successor is missing), so it warns rather than closing with a
 * contract-violating pair.
 */

export const CLOSURE_REASONS = [
	"no-follow-on",
	"handed_off_to",
	"blocked_on",
	"denied",
	"canceled",
	"escalation",
	"superseded",
] as const;

export type ClosureReason = (typeof CLOSURE_REASONS)[number];

export type Closure = {
	reason: ClosureReason;
	target?: string;
	successor?: string;
	note?: string;
	custodyVerified?: string;
};

export type ClosureFinding = { code: string; severity: "error" | "warning"; message: string };

/** Note prefix that records custodial evidence: `custody-verified: <target> <how>`. */
export const CUSTODY_VERIFIED_PREFIX = "custody-verified:";

const REASON_LIST = CLOSURE_REASONS.join(", ");

/** `[a-z][a-z0-9]*-[a-z0-9]{4,}` — a seeds-style issue/plan id. */
const ID_SOURCE = "[a-z][a-z0-9]*-[a-z0-9]{4,}";
const ID_RE = new RegExp(ID_SOURCE);

/** Which of `target` / `successor` a reason admits (and, for the first two, requires). */
const ADMITTED_FIELDS: Record<
	ClosureReason,
	{ readonly target: boolean; readonly successor: boolean }
> = {
	"no-follow-on": { target: false, successor: false },
	handed_off_to: { target: true, successor: false },
	blocked_on: { target: true, successor: false },
	denied: { target: false, successor: false },
	canceled: { target: false, successor: false },
	escalation: { target: true, successor: false },
	superseded: { target: false, successor: true },
};

export function isClosureReason(value: unknown): value is ClosureReason {
	return typeof value === "string" && (CLOSURE_REASONS as readonly string[]).includes(value);
}

export function validateClosure(input: {
	reason?: string;
	target?: string;
	successor?: string;
	custodyNote?: string;
	issueId?: string;
	notes?: string;
}): { findings: ClosureFinding[]; closure?: Closure } {
	const findings: ClosureFinding[] = [];
	const label = input.issueId?.trim();
	const say = (message: string): string =>
		label === undefined || label === "" ? message : `${label}: ${message}`;

	const reason = input.reason?.trim() ?? "";
	if (reason === "") {
		findings.push(
			error(
				"closure_reason_required",
				say(`close requires a closure reason; use one of: ${REASON_LIST}`),
			),
		);
		return { findings };
	}
	if (!isClosureReason(reason)) {
		findings.push(
			error(
				"closure_reason_invalid",
				say(`closure reason "${reason}" is not valid; use one of: ${REASON_LIST}`),
			),
		);
		return { findings };
	}

	const target = normaliseField(input.target);
	const successor = normaliseField(input.successor);
	findings.push(...admissionFindings(reason, target, successor, say));

	const subject =
		reason === "handed_off_to" ? target : reason === "superseded" ? successor : undefined;
	const noteText = input.custodyNote ?? input.notes ?? "";
	const verified = subject === undefined ? undefined : custodyVerifiedTarget(noteText, subject);
	if (subject !== undefined && verified === undefined) {
		findings.push(
			warning(
				"custody_unverified",
				say(
					`closure names ${subject} but custody is unverified; record a "${CUSTODY_VERIFIED_PREFIX} ${subject} <how>" note, or confirm ${subject} exists in .seeds/issues.jsonl`,
				),
			),
		);
	}

	if (findings.some((finding) => finding.severity === "error")) return { findings };

	const closure: Closure = {
		reason,
		...(target !== undefined ? { target } : {}),
		...(successor !== undefined ? { successor } : {}),
		...(verified !== undefined ? { custodyVerified: verified } : {}),
	};
	return { findings, closure };
}

export function parseClosure(reasonText: string | undefined): {
	closure?: Closure;
	findings: ClosureFinding[];
} {
	const text = reasonText?.trim() ?? "";
	if (text === "") {
		return {
			findings: [
				error(
					"closure_reason_required",
					`close requires a closure reason; use one of: ${REASON_LIST}`,
				),
			],
		};
	}

	const recognised = recognise(text);
	if (recognised === undefined) {
		return {
			findings: [
				warning(
					"closure_reason_unparsed",
					`could not parse closure reason "${text}"; close with an explicit reason (${REASON_LIST})`,
				),
			],
		};
	}

	const checked = validateClosure({
		reason: recognised.reason,
		...(recognised.target !== undefined ? { target: recognised.target } : {}),
		...(recognised.successor !== undefined ? { successor: recognised.successor } : {}),
		custodyNote: text,
	});
	if (checked.closure === undefined) return { findings: checked.findings };

	const closure: Closure =
		recognised.note === undefined ? checked.closure : { ...checked.closure, note: recognised.note };
	return { findings: checked.findings, closure };
}

export function toQueueClosure(c: Closure): { closure_reason: string; closure_target?: string } {
	const target = c.target ?? c.successor;
	return target === undefined
		? { closure_reason: c.reason }
		: { closure_reason: c.reason, closure_target: target };
}

export function formatClosureInput(c: Closure): string {
	const named = c.reason === "superseded" ? c.successor : c.target;
	const head = named === undefined ? c.reason : `${c.reason}: ${named}`;
	const note = c.note?.trim() ?? "";
	return note === "" ? head : `${head} — ${note}`;
}

/* ----------------------------------------------------------------------- */
/* internals                                                               */
/* ----------------------------------------------------------------------- */

type Recognised = {
	readonly reason: ClosureReason;
	readonly target?: string;
	readonly successor?: string;
	readonly note?: string;
};

function error(code: string, message: string): ClosureFinding {
	return { code, severity: "error", message };
}

function warning(code: string, message: string): ClosureFinding {
	return { code, severity: "warning", message };
}

function normaliseField(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The field obligations of one reason: a field the reason forbids must be
 * absent, and a field it requires must be present and non-blank (a
 * whitespace-only `target` is a missing target, not an owner named " ").
 */
function admissionFindings(
	reason: ClosureReason,
	target: string | undefined,
	successor: string | undefined,
	say: (message: string) => string,
): ClosureFinding[] {
	const findings: ClosureFinding[] = [];
	const admits = ADMITTED_FIELDS[reason];
	if (target !== undefined && !admits.target) {
		findings.push(
			error(
				"closure_fields_not_admitted",
				say(`closure reason ${reason} does not admit target ("${target}")`),
			),
		);
	}
	if (successor !== undefined && !admits.successor) {
		findings.push(
			error(
				"closure_fields_not_admitted",
				say(`closure reason ${reason} does not admit successor ("${successor}")`),
			),
		);
	}
	const required = requiredField(reason);
	if (required === "target" && target === undefined) {
		findings.push(
			error(
				"closure_target_required",
				say(
					`closure reason ${reason} requires a non-empty target (new owner, blocker id, or escalation target); whitespace does not count`,
				),
			),
		);
	}
	if (required === "successor" && successor === undefined) {
		findings.push(
			error(
				"closure_successor_required",
				say(
					`closure reason ${reason} requires the replacing issue id as successor; whitespace does not count`,
				),
			),
		);
	}
	return findings;
}

/** The first id-shaped token in `text`, or `undefined`. */
function firstId(text: string): string | undefined {
	return ID_RE.exec(text)?.[0];
}

function stripSeparator(text: string): string {
	return text
		.trim()
		.replace(/^[\s:;,–—-]+/, "")
		.trim();
}

/**
 * Custody evidence in a note blob: a segment starting with
 * {@link CUSTODY_VERIFIED_PREFIX} whose first token is exactly `subject`.
 */
function custodyVerifiedTarget(notes: string, subject: string): string | undefined {
	for (const segment of notes.split(/\n|\.\s|;\s/)) {
		const trimmed = segment.trim();
		if (!trimmed.toLowerCase().startsWith(CUSTODY_VERIFIED_PREFIX)) continue;
		const named = trimmed.slice(CUSTODY_VERIFIED_PREFIX.length).trim().split(/\s+/)[0];
		if (named === subject) return subject;
	}
	return undefined;
}

const BARE_REASON_RE = new RegExp(`^(${CLOSURE_REASONS.join("|")})$`, "i");

const CANONICAL_RE = new RegExp(`^(${CLOSURE_REASONS.join("|")})\\s*(?::|—|–|-)\\s*(.+)$`, "i");

const SUPERSEDE_DIRECTIVES: readonly RegExp[] = [
	/\b(?:superseded|obsoleted|replaced)\s+(?:by|with)\s+([^\n.;]+)/i,
	/\badopted\s+into\s+\S+\s+as\s+([^\n.;]+)/i,
	/\badopted\s+into\s+(?:plan\s+)?([^\n.;]+)/i,
	/\bfolded\s+into\s+([^\n.;]+)/i,
	/\bduplicate\s+of\s+([^\n.;]+)/i,
	/\b(?:already\s+)?shipped\s+as\s+([^\n.;]+)/i,
];

const HANDOFF_DIRECTIVES: readonly RegExp[] = [
	/\b(?:moved|handed|transferred|tossed)\s+(?:to|off\s+to|over\s+to)\s+([^\n.;]+)/i,
	/\btracked\s+(?:there|in\s+\S+)\s+as\s+([^\n.;]+)/i,
];

const BLOCKED_DIRECTIVES: readonly RegExp[] = [/\bblocked\s+on\s+([^\n.;]+)/i];

const ESCALATION_DIRECTIVES: readonly RegExp[] = [/\bescalat\w*\s+(?:to|:)\s*([^\n.;]+)/i];

const ANCHORED_REASONS: readonly (readonly [RegExp, ClosureReason])[] = [
	[/^\s*(?:denied|rejected|declined)\b/i, "denied"],
	[/^\s*(?:canceled|cancelled|withdrawn|withdrew|abandoned)\b/i, "canceled"],
	[/^\s*no[- ]follow[- ]?on\b/i, "no-follow-on"],
];

const COMPLETION_LEAD_RE =
	/^\s*(?:done|fixed|shipped|closed|resolved|completed|complete|landed|implemented|merged|verified|validated|added|removed|deleted|dropped|released|obsolete|repointed|parked|pr\s*#\d+)\b/i;

const COMPLETION_VERB_RE =
	/\b(?:landed|merged|shipped|implement(?:s|ed)|complete[ds]?|verified|fixed|resolved|finished)\b/i;

function requiredField(reason: ClosureReason): "target" | "successor" | undefined {
	if (reason === "superseded") return "successor";
	return ADMITTED_FIELDS[reason].target ? "target" : undefined;
}

/** Tier 0a: the reason token alone, for the reasons that carry no field. */
function fromBareReason(text: string): Recognised | undefined {
	const match = BARE_REASON_RE.exec(text);
	if (match === null) return undefined;
	const reason = (match[1] ?? "").toLowerCase();
	if (!isClosureReason(reason) || requiredField(reason) !== undefined) return undefined;
	return { reason };
}

/** Tier 0b: the canonical `"<reason>: <field> — <note>"` form this module prints. */
function fromCanonical(text: string): Recognised | undefined {
	const match = CANONICAL_RE.exec(text);
	if (match === null) return undefined;
	const reason = (match[1] ?? "").toLowerCase();
	if (!isClosureReason(reason)) return undefined;
	const rest = stripSeparator(match[2] ?? "");
	const field = requiredField(reason);
	if (field === undefined) return rest === "" ? { reason } : { reason, note: rest };
	const named = firstId(rest) ?? (/^\S+$/.test(rest) ? rest : undefined);
	if (named === undefined) return undefined;
	const note = stripSeparator(rest.slice(rest.indexOf(named) + named.length));
	const head: Recognised =
		field === "target" ? { reason, target: named } : { reason, successor: named };
	return note === "" ? head : { ...head, note };
}

/** Tier 1: a directive sentence naming the receiving issue, matched anywhere. */
function fromDirectives(
	text: string,
	patterns: readonly RegExp[],
	reason: ClosureReason,
	field: "target" | "successor",
): Recognised | undefined {
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		if (match === null) continue;
		const named = firstId(match[1] ?? "");
		if (named === undefined) continue;
		const base: Recognised =
			field === "target" ? { reason, target: named } : { reason, successor: named };
		return { ...base, note: text };
	}
	return undefined;
}

/** Tier 1: a reason whose whole sentence is the reason (no field to carry). */
function fromAnchoredReason(text: string): Recognised | undefined {
	for (const [pattern, reason] of ANCHORED_REASONS) {
		if (pattern.test(text)) return { reason, note: text };
	}
	return undefined;
}

/** Tier 2: a completion narrative — terminal by construction, nothing handed on. */
function fromCompletion(text: string): Recognised | undefined {
	const head = text.split(/\n|\.\s/)[0] ?? "";
	if (COMPLETION_LEAD_RE.test(text) || COMPLETION_VERB_RE.test(head)) {
		return { reason: "no-follow-on", note: text };
	}
	return undefined;
}

function recognise(text: string): Recognised | undefined {
	return (
		fromBareReason(text) ??
		fromCanonical(text) ??
		fromDirectives(text, SUPERSEDE_DIRECTIVES, "superseded", "successor") ??
		fromDirectives(text, HANDOFF_DIRECTIVES, "handed_off_to", "target") ??
		fromDirectives(text, BLOCKED_DIRECTIVES, "blocked_on", "target") ??
		fromDirectives(text, ESCALATION_DIRECTIVES, "escalation", "target") ??
		fromAnchoredReason(text) ??
		fromCompletion(text)
	);
}
