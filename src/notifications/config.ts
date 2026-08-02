import type { NotificationEndpoint } from "./delivery.ts";

/** Parse operator-only endpoint configuration without exposing secrets in API types. */
export function loadNotificationEndpoints(
	env: Readonly<Record<string, string | undefined>>,
): readonly NotificationEndpoint[] {
	const raw = env.WARREN_NOTIFICATION_ENDPOINTS_JSON;
	if (raw === undefined || raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("WARREN_NOTIFICATION_ENDPOINTS_JSON must be valid JSON");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("WARREN_NOTIFICATION_ENDPOINTS_JSON must be an array");
	}
	return parsed.map((value, index) => parseEndpoint(value, index));
}

function parseEndpoint(value: unknown, index: number): NotificationEndpoint {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`notification endpoint ${index} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const id = requiredString(record.id, `notification endpoint ${index}.id`);
	const url = requiredString(record.url, `notification endpoint ${index}.url`);
	const secret = requiredString(record.secret, `notification endpoint ${index}.secret`);
	if (!/^https?:\/\//.test(url)) {
		throw new Error(`notification endpoint ${index}.url must use http or https`);
	}
	return {
		id,
		url,
		secret,
		enabled: record.enabled === undefined ? true : record.enabled === true,
	};
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(`${label} must be non-empty`);
	return value;
}
