import { describe, expect, test } from "bun:test";
import { loadNotificationEndpoints } from "./config.ts";

describe("loadNotificationEndpoints", () => {
	test("loads enabled and disabled operator endpoints", () => {
		expect(
			loadNotificationEndpoints({
				WARREN_NOTIFICATION_ENDPOINTS_JSON: JSON.stringify([
					{ id: "kota", url: "https://kota.test/hooks", secret: "secret" },
					{ id: "off", url: "http://localhost/hook", secret: "other", enabled: false },
				]),
			}),
		).toEqual([
			{ id: "kota", url: "https://kota.test/hooks", secret: "secret", enabled: true },
			{ id: "off", url: "http://localhost/hook", secret: "other", enabled: false },
		]);
	});

	test("rejects malformed and non-http endpoints", () => {
		expect(() => loadNotificationEndpoints({ WARREN_NOTIFICATION_ENDPOINTS_JSON: "{}" })).toThrow(
			"array",
		);
		expect(() =>
			loadNotificationEndpoints({ WARREN_NOTIFICATION_ENDPOINTS_JSON: '[{"id":"x"}]' }),
		).toThrow("url");
		expect(() =>
			loadNotificationEndpoints({
				WARREN_NOTIFICATION_ENDPOINTS_JSON: '[{"id":"x","url":"file:///tmp","secret":"s"}]',
			}),
		).toThrow("http");
	});
});
