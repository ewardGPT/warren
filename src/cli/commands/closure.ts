/**
 * `warren closure <reason>` — the writer half of the closure contract.
 *
 * `sd close` stores a free-text reason, and the constraint that makes a closure
 * useful lives in src/seeds-cli/closure.ts: a small vocabulary, an owner for
 * work that continues, and a successor for work that is replaced. This command
 * turns a reason plus flags into the canonical string, so the value written into
 * `.seeds/issues.jsonl` is already structured.
 *
 * Exit codes:
 *   0  the closure follows the contract, and the string was printed
 *   1  the closure contradicts the contract (the findings name each rule)
 *
 * The guard that reads these closures back is scripts/check-closure-contract.ts,
 * chained into `bun run lint`.
 */

import {
	CLOSURE_REASONS,
	type Closure,
	formatClosureInput,
	isClosureReason,
	toQueueClosure,
	validateClosure,
} from "../../seeds-cli/closure.ts";
import type { CliContext } from "../output.ts";

export interface ClosureArgs {
	readonly reason: string;
	readonly target?: string;
	readonly successor?: string;
	readonly note?: string;
	readonly json?: boolean;
}

function write(context: CliContext, text: string): void {
	context.stdio.stdout.write(text);
}

function fail(context: CliContext, text: string): void {
	context.stdio.stderr.write(text);
}

export function runClosure(context: CliContext, args: ClosureArgs): number {
	const reason = args.reason.trim();
	if (!isClosureReason(reason)) {
		fail(
			context,
			`closure: "${reason}" is not a closure reason.\n` +
				`  use one of: ${CLOSURE_REASONS.join(", ")}\n`,
		);
		return 1;
	}

	const { findings, closure } = validateClosure({
		reason,
		target: args.target,
		successor: args.successor,
		notes: args.note,
	});
	const errors = findings.filter((finding) => finding.severity === "error");
	if (closure === undefined || errors.length > 0) {
		fail(context, `closure: this closure does not follow the contract:\n`);
		for (const finding of errors) fail(context, `  ${finding.code}: ${finding.message}\n`);
		return 1;
	}

	const noted: Closure = args.note === undefined ? closure : { ...closure, note: args.note };
	const canonical = formatClosureInput(noted);
	for (const finding of findings) {
		if (finding.severity === "warning")
			fail(context, `closure: ${finding.code}: ${finding.message}\n`);
	}

	if (args.json === true) {
		write(
			context,
			`${JSON.stringify({ closure: noted, canonical, queue: toQueueClosure(noted) }, null, "\t")}\n`,
		);
		return 0;
	}

	write(context, `${canonical}\n`);
	write(context, `\nsd close <id> --reason ${JSON.stringify(canonical)}\n`);
	return 0;
}
