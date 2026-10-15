/**
 * `warren decide` — ask the decision engine (TypeSafe Jev) one question set and
 * turn the answer into an exit code.
 *
 * The engine answers a *set* of named questions about one state snapshot in a
 * single round-trip of about a second. Every answer maps to a band, and the
 * whole decision takes the strictest band (see `foldBands`). That band is what
 * a shell gate branches on:
 *
 *   0  act   — every answer landed in `act`; the caller may proceed
 *   3  ask   — the engine is not sure, or answered a choice outside the bands
 *   4  hold  — an answer landed in `hold`; the caller must stop
 *   5  unavailable / over-budget — no answer arrived, so nothing was decided
 *
 * Nothing here is allowed to block on the network: the engine's own timeout and
 * daily cap apply, and a failure is `unavailable` rather than an exception.
 *
 * Usage:
 *   warren decide --feature merge-gate --state state.json --questions q.json
 *   warren decide --feature triage --state '{"attempts":3}' --subject run-42 --json
 *   JEV_API_KEY=... warren decide --feature probe --state '{}' --questions '{"ok":{"type":"noul","instructions":"Is this a probe?","criteria":{"true":"probe"}}}'
 */

import { readFileSync } from "node:fs";
import type { Answer, Band, Decided, Question } from "../../decide/index.ts";
import { bandFor, decide, foldBands, STUB_ENV } from "../../decide/index.ts";
import type { CliContext } from "../output.ts";

export interface DecideArgs {
	readonly feature: string;
	readonly state: string;
	readonly questions: string;
	readonly subject?: string;
	readonly json?: boolean;
	readonly stub?: boolean;
}

const BAND_EXIT: Record<Band, number> = { act: 0, ask: 3, hold: 4 };
const UNAVAILABLE_EXIT = 5;

/** Read a value that is either an inline JSON document or a path to one. */
function readJsonArgument(raw: string, what: string): unknown {
	const trimmed = raw.trim();
	let candidate = trimmed;
	if (!trimmed.startsWith("{")) {
		try {
			candidate = readFileSync(trimmed, "utf8");
		} catch (error) {
			throw new Error(
				`${what} is neither inline JSON nor a readable file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	try {
		return JSON.parse(candidate);
	} catch (error) {
		throw new Error(
			`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function isQuestions(value: unknown): value is Record<string, Question> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runDecide(context: CliContext, args: DecideArgs): Promise<number> {
	const fail = (message: string): number => {
		context.stdio.stderr.write(`decide: ${message}\n`);
		return UNAVAILABLE_EXIT;
	};

	const inputs = readInputs(args);
	if ("error" in inputs) return fail(inputs.error);

	const decision = await decide(
		{
			feature: args.feature,
			subject: args.subject,
			state: inputs.state,
			questions: inputs.questions,
		},
		// The caller's environment decides the provider, the log path and the daily
		// cap. `--stub` only flips the offline provider on top of it, so a test can
		// point the fixture somewhere private.
		{ env: args.stub === true ? { ...context.env, [STUB_ENV]: "1" } : context.env },
	);

	if (decision.outcome !== "decided") {
		context.stdio.stderr.write(`decide: ${decision.outcome} — ${decision.reason}\n`);
		return UNAVAILABLE_EXIT;
	}

	const band = foldBands(Object.values(decision.answers).map((answer) => bandFor(answer)));
	if (args.json === true)
		context.stdio.stdout.write(`${JSON.stringify({ ...decision, band }, null, "\t")}\n`);
	else renderDecision(context, decision, band);
	return BAND_EXIT[band];
}

type Inputs =
	| { state: Record<string, unknown>; questions: Record<string, Question> }
	| { error: string };

/** Read and validate `--state` and `--questions`. Anything wrong is a verdict, not a throw. */
function readInputs(args: DecideArgs): Inputs {
	let state: unknown;
	let questions: unknown;
	try {
		state = readJsonArgument(args.state, "--state");
		questions = readJsonArgument(args.questions, "--questions");
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return { error: "--state must be a JSON object" };
	}
	if (!isQuestions(questions) || Object.keys(questions).length === 0) {
		return { error: "--questions must be a JSON object with at least one named question" };
	}
	return { state: state as Record<string, unknown>, questions };
}

/** The human-readable answer: the band, then one line per question. */
function renderDecision(context: CliContext, decision: Decided, band: Band): void {
	const usage = decision.usage;
	context.stdio.stdout.write(
		`${band}  ${decision.via}  ${decision.provider}/${decision.model}  ${decision.ms}ms` +
			`${usage === undefined ? "" : `  tokens ${usage.inputTokens ?? "?"}→${usage.outputTokens ?? "?"}`}\n`,
	);
	for (const [name, answer] of Object.entries(decision.answers)) {
		context.stdio.stdout.write(`  ${name}: ${describeAnswer(answer)}\n`);
	}
}

function describeAnswer(answer: Answer): string {
	if (answer.noul !== undefined) return `noul ${answer.noul}`;
	if (answer.choice !== undefined)
		return `choice ${answer.choice}${answer.confidence === undefined ? "" : ` (${answer.confidence})`}`;
	if (answer.score !== undefined) return `score ${answer.score}`;
	return "no answer";
}
