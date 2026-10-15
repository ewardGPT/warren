import { describe, expect, it } from "bun:test";
import { decodeProviderRunId, encodeProviderRunId } from "./handle.ts";

describe("encodeProviderRunId", () => {
	it("joins the box id and inner run id with a single slash", () => {
		expect(encodeProviderRunId("box-a", "01J8ZQ")).toBe("box-a/01J8ZQ");
	});

	it("accepts single-character and digit-leading box ids", () => {
		expect(encodeProviderRunId("a", "inner")).toBe("a/inner");
		expect(encodeProviderRunId("3box", "inner")).toBe("3box/inner");
	});

	it("throws for a box id that decode would reject", () => {
		for (const bad of ["", "Box", "-box", "box_a", "box/a", "box.a", "box a"]) {
			expect(() => encodeProviderRunId(bad, "inner")).toThrow();
		}
	});
});

describe("decodeProviderRunId", () => {
	it("round-trips an encoded id", () => {
		expect(decodeProviderRunId(encodeProviderRunId("box-a", "01J8ZQ"))).toEqual({
			boxId: "box-a",
			innerRunId: "01J8ZQ",
		});
	});

	it("splits on the FIRST slash, leaving later slashes in the inner id", () => {
		expect(decodeProviderRunId("box-a/inner/part")).toEqual({
			boxId: "box-a",
			innerRunId: "inner/part",
		});
	});

	it("returns null when there is no slash", () => {
		expect(decodeProviderRunId("01J8ZQ")).toBeNull();
	});

	it("returns null when the slash is first or last", () => {
		expect(decodeProviderRunId("/inner")).toBeNull();
		expect(decodeProviderRunId("box-a/")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(decodeProviderRunId("")).toBeNull();
	});

	it("returns null when the box id fails the pattern", () => {
		expect(decodeProviderRunId("Box/inner")).toBeNull();
		expect(decodeProviderRunId("-box/inner")).toBeNull();
		expect(decodeProviderRunId("box_a/inner")).toBeNull();
	});
});
