/**
 * Fleet-backend errors. Same shape as `../errors.ts` (`UnknownRuntimeError`):
 * a message an operator can act on plus an optional recovery hint, thrown at
 * BOOT so a misconfigured fleet fails before a run is lost in it.
 */

export class FleetConfigError extends Error {
	readonly recoveryHint: string | undefined;

	constructor(message: string, opts: { recoveryHint?: string } = {}) {
		super(message);
		this.name = "FleetConfigError";
		this.recoveryHint = opts.recoveryHint;
	}
}

/** Raised when no healthy box can take a run. Never a silent local fallback. */
export class FleetUnavailableError extends Error {
	readonly recoveryHint: string | undefined;

	constructor(message: string, opts: { recoveryHint?: string } = {}) {
		super(message);
		this.name = "FleetUnavailableError";
		this.recoveryHint = opts.recoveryHint;
	}
}

/** A handle that does not name a box this provider knows. */
export class FleetUnknownBoxError extends Error {
	constructor(readonly boxId: string) {
		super(`fleet: no box ${JSON.stringify(boxId)} in this fleet`);
		this.name = "FleetUnknownBoxError";
	}
}
