import { describe, expect, test } from "bun:test";
import { classifyPushProtection } from "./push-protection.ts";

describe("classifyPushProtection", () => {
	test("extracts GitHub's unblock URL and scanning locations", () => {
		const detail = classifyPushProtection(`remote: error: GH013: Repository rule violations found
remote: - Push cannot contain secrets
remote: locations:
remote: - commit: abc123
remote: - path: fixtures/example.ts:12
remote: To unblock, visit https://github.com/acme/demo/security/secret-scanning/unblock-secret/abc`);
		expect(detail).toEqual({
			unblockUrl: "https://github.com/acme/demo/security/secret-scanning/unblock-secret/abc",
			locations: ["- commit: abc123", "- path: fixtures/example.ts:12"],
			message: expect.stringContaining("GH013"),
		});
	});

	test("does not classify an ordinary rejected push", () => {
		expect(classifyPushProtection("remote: non-fast-forward")).toBeNull();
	});
});
