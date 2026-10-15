/**
 * Run-handle addressing for the fleet backend.
 *
 * `RunHandle.providerRunId` is opaque to the domain (contract.ts), so the fleet
 * provider encodes WHICH box a run went to in it. That buys two things:
 *
 *   1. Every later call (`status`, `streamEvents`, `cancel`, `finalize`,
 *      `terminate`) routes back to the same box without a network search.
 *   2. The routing survives a warren restart. An in-memory runId→box map would
 *      lose every in-flight run on redeploy, and those runs would then read as
 *      `exists:false` — i.e. lost — while they are still working on the box.
 *
 * The encoded form is `<boxId>/<inner>`: box ids are registry ids
 * (`[a-z0-9][a-z0-9-]*`, no slash), and burrow ids are ULIDs, so the first
 * slash is an unambiguous separator. Decoding is total: anything that does not
 * match the shape returns `null` rather than throwing, because a handle can
 * arrive from a row written by an older build.
 */

const BOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** `box-a/01J8Z…` — the box id, then the inner provider's own run id. */
export function encodeProviderRunId(boxId: string, innerRunId: string): string {
	if (!BOX_ID_PATTERN.test(boxId)) {
		throw new Error(`fleet: invalid box id ${JSON.stringify(boxId)}`);
	}
	return `${boxId}/${innerRunId}`;
}

export interface DecodedProviderRunId {
	readonly boxId: string;
	readonly innerRunId: string;
}

/** `null` when the id was not minted by this provider (or names a bad box id). */
export function decodeProviderRunId(providerRunId: string): DecodedProviderRunId | null {
	const slash = providerRunId.indexOf("/");
	if (slash <= 0 || slash === providerRunId.length - 1) return null;
	const boxId = providerRunId.slice(0, slash);
	if (!BOX_ID_PATTERN.test(boxId)) return null;
	return { boxId, innerRunId: providerRunId.slice(slash + 1) };
}
