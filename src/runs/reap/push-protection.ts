/** Diagnostics for a GitHub push-protection rejection. */
export interface PushProtectionDetail {
	readonly unblockUrl: string | null;
	readonly locations: readonly string[];
	readonly message: string;
}

const UNBLOCK_URL =
	/https:\/\/github\.com\/[^\s)]+\/security\/secret-scanning\/unblock-secret\/[^\s)]+/i;

/**
 * Recognise GitHub secret/push-protection output without treating every remote
 * push failure as a policy rejection. The raw error remains in `errors`; this
 * is only the structured operator-facing projection.
 */
export function classifyPushProtection(error: string | undefined): PushProtectionDetail | null {
	if (error === undefined) return null;
	const normalized = error.replace(/^\s*remote:\s?/gim, "");
	const isPolicy =
		/GH013|push protection|secret scanning|push cannot contain secrets|unblock-secret/i.test(
			normalized,
		);
	if (!isPolicy) return null;
	const unblockUrl = normalized.match(UNBLOCK_URL)?.[0] ?? null;
	const locations = normalized
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[-*]\s*(?:commit|path|line|location|secret)\s*:/i.test(line));
	return { unblockUrl, locations, message: normalized.trim() };
}
