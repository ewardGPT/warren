import { describe, expect, test } from "bun:test";
import {
	emptyTriageInbox,
	loadTriageInbox,
	mergeTriageFindings,
	runTriageInboxPass,
	saveTriageInbox,
} from "./triage-inbox.ts";

const finding = (key: string, title = "failure") => ({
	key,
	source: "ci" as const,
	title,
	discoveredAt: "2026-08-02T00:00:00Z",
	status: "open" as const,
});

describe("triage inbox", () => {
	test("deduplicates findings and preserves operator triage", () => {
		const first = mergeTriageFindings(emptyTriageInbox(), [finding("a")], {
			now: new Date("2026-08-02T01:00:00Z"),
			runId: "run-1",
		});
		const firstFinding = first.state.findings[0];
		if (firstFinding === undefined) throw new Error("expected first finding");
		const triaged = {
			...first.state,
			findings: [{ ...firstFinding, status: "triaged" as const }],
		};
		const second = mergeTriageFindings(triaged, [finding("a", "changed"), finding("b")], {
			now: new Date("2026-08-02T02:00:00Z"),
			runId: "run-2",
		});
		expect(second.added).toBe(1);
		expect(second.state.findings).toEqual([{ ...firstFinding, status: "triaged" }, finding("b")]);
	});

	test("archives an empty collector run", () => {
		const result = mergeTriageFindings(emptyTriageInbox(), [], {
			now: new Date("2026-08-02T01:00:00Z"),
			runId: "run-empty",
		});
		expect(result.archivedEmpty).toBe(true);
		expect(result.state.archivedEmptyRuns).toEqual([
			{ runId: "run-empty", archivedAt: "2026-08-02T01:00:00.000Z" },
		]);
	});

	test("loads valid state, falls back on malformed state, and saves JSON", async () => {
		let stored: string | null = JSON.stringify({
			version: 1,
			updatedAt: "now",
			findings: [finding("saved")],
			archivedEmptyRuns: [],
		});
		const fs = {
			readFile: async () => stored,
			writeFile: async (_path: string, contents: string) => {
				stored = contents;
			},
		};
		const loaded = await loadTriageInbox("inbox.json", fs);
		expect(loaded.findings[0]?.key).toBe("saved");
		await saveTriageInbox(loaded, "inbox.json", fs);
		expect(stored).toContain('"version": 1');
		stored = "not-json";
		expect((await loadTriageInbox("inbox.json", fs)).findings).toEqual([]);
	});

	test("runs an injected collector and persists the project inbox", async () => {
		const files = new Map<string, string>();
		const fs = {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, contents: string) => {
				files.set(path, contents);
			},
		};
		const result = await runTriageInboxPass({
			projectId: "project-1",
			projectPath: "/tmp/project-1",
			now: new Date("2026-08-02T03:00:00Z"),
			collect: async () => [finding("ci-1")],
			fs,
		});
		expect(result.added).toBe(1);
		expect(files.has("/tmp/project-1/.warren/triage-inbox.json")).toBe(true);
	});
});
