import { describe, expect, it } from "bun:test";
import { type BoxCandidate, chooseBox } from "./placement.ts";

function box(id: string, live: number, extra: Partial<BoxCandidate> = {}): BoxCandidate {
	return { id, healthy: true, live, ...extra };
}

describe("chooseBox", () => {
	it("returns null when there are no candidates", () => {
		expect(chooseBox([])).toBeNull();
	});

	it("ignores an unhealthy box even when it is the least loaded", () => {
		expect(chooseBox([box("sick", 0, { healthy: false }), box("well", 5)])).toBe("well");
	});

	it("returns null when every candidate is unhealthy", () => {
		expect(
			chooseBox([box("a", 0, { healthy: false }), box("b", 1, { healthy: false })]),
		).toBeNull();
	});

	it("picks the box with the fewest live workspaces", () => {
		expect(chooseBox([box("a", 3), box("b", 1), box("c", 2)])).toBe("b");
	});

	it("breaks a total-live tie on the box id, ascending", () => {
		expect(chooseBox([box("c", 2), box("a", 2), box("b", 2)])).toBe("a");
	});

	it("breaks a total-live tie on the fewest project-live runs", () => {
		expect(chooseBox([box("a", 2, { projectLive: 2 }), box("b", 2, { projectLive: 1 })])).toBe("b");
	});

	it("treats a missing projectLive as zero for the tie-break", () => {
		expect(chooseBox([box("a", 2, { projectLive: 1 }), box("b", 2)])).toBe("b");
	});

	describe("boxLimit", () => {
		it("excludes a box whose live count reaches the limit but keeps one below it", () => {
			expect(chooseBox([box("a", 2), box("b", 1)], { boxLimit: 2 })).toBe("b");
		});

		it("returns null when every box is at the limit", () => {
			expect(chooseBox([box("a", 2), box("b", 3)], { boxLimit: 2 })).toBeNull();
		});
	});

	describe("projectLimit", () => {
		it("excludes a box whose project-live count reaches the limit", () => {
			expect(
				chooseBox([box("a", 1, { projectLive: 2 }), box("b", 4, { projectLive: 1 })], {
					projectLimit: 2,
				}),
			).toBe("b");
		});

		it("treats an absent projectLive as zero, so the box stays eligible", () => {
			expect(chooseBox([box("a", 0, { projectLive: undefined })], { projectLimit: 1 })).toBe("a");
		});
	});
});
