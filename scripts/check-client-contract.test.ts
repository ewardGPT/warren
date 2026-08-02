import { describe, expect, test } from "bun:test";
import { extractClientRequests, findContractViolations } from "./check-client-contract.ts";

describe("client/server contract gate", () => {
	test("extracts methods and dynamic route segments", () => {
		const dynamicSegment = "$" + "{encodeURIComponent(id)}";
		expect(
			extractClientRequests(
				`const a = request(\`/projects/${dynamicSegment}\`, { method: "DELETE" });`,
			),
		).toEqual([{ method: "DELETE", path: "/projects/:id", source: expect.any(String) }]);
	});

	test("reports a client path absent from OpenAPI", () => {
		const violations = findContractViolations(
			'const a = request("/brainstorm", { method: "POST" });',
			"paths:\n  /projects:\n    get: {}\n",
		);
		expect(violations.map(({ path }) => path)).toEqual(["/brainstorm"]);
	});

	test("accepts dynamic paths and default GET", () => {
		const dynamicSegment = "$" + "{encodeURIComponent(id)}";
		const violations = findContractViolations(
			`const a = request(\`/projects/${dynamicSegment}\`);`,
			"paths:\n  /projects/{id}:\n    get: {}\n",
		);
		expect(violations).toEqual([]);
	});
});
