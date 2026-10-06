import { describe, expect, test } from "bun:test";
import {
	buildMulchPriorBlock,
	formatPriorBlock,
	MULCH_PRIOR_MAX_CHARS,
	type MulchFailurePrior,
	parseFailurePriors,
	seedTextFromIssues,
	selectFailurePriors,
	tokenizeSeedText,
} from "./mulch-priors.ts";

const REAP_FAILURE: MulchFailurePrior = {
	id: "mx-0001",
	description: "Push protection rejected the reap push; GH013 blocked the branch.",
	resolution: "Classify GH013 as push_rejected_policy and surface the location lines.",
	dirAnchors: ["src/runs/reap"],
	recordedAt: "2026-08-04T00:00:00.000Z",
};

const GENERIC_FAILURE: MulchFailurePrior = {
	id: "mx-0002",
	description: "Sapling dispatch crashed before work began.",
	resolution: "Do not retry the same unhealthy provider blindly.",
	dirAnchors: [],
	recordedAt: "2026-08-04T01:00:00.000Z",
};

describe("tokenizeSeedText", () => {
	test("splits path tokens into segments and drops stopwords", () => {
		const tokens = tokenizeSeedText("Fix the failure in src/runs/reap for push-protection");
		expect(tokens.has("src")).toBe(true);
		expect(tokens.has("reap")).toBe(true);
		expect(tokens.has("push")).toBe(true);
		expect(tokens.has("protection")).toBe(true);
		expect(tokens.has("runs")).toBe(false);
		expect(tokens.has("failure")).toBe(false);
		expect(tokens.has("fix")).toBe(false);
		expect(tokens.has("the")).toBe(false);
	});
});

describe("seedTextFromIssues", () => {
	test("returns title, description, and labels for the seed", () => {
		const body = [
			JSON.stringify({
				id: "warren-1a2b",
				title: "Fix reap push handling",
				description: "GH013 handling for the reap stage",
				labels: ["reap", "git"],
			}),
			JSON.stringify({ id: "warren-9c9c", title: "Other seed" }),
		].join("\n");
		const text = seedTextFromIssues(body, "warren-1a2b");
		expect(text).toContain("Fix reap push handling");
		expect(text).toContain("GH013 handling");
		expect(text).toContain("reap");
	});

	test("later lines win and malformed lines are skipped", () => {
		const body = [
			JSON.stringify({ id: "warren-1a2b", title: "old title" }),
			"{not json",
			JSON.stringify({ id: "warren-1a2b", title: "new title" }),
		].join("\n");
		expect(seedTextFromIssues(body, "warren-1a2b")).toBe("new title");
	});

	test("returns null when the id is absent", () => {
		const body = JSON.stringify({ id: "warren-0000", title: "unrelated" });
		expect(seedTextFromIssues(body, "warren-1a2b")).toBeNull();
	});
});

describe("parseFailurePriors", () => {
	test("keeps failure records with a resolution and skips the rest", () => {
		const body = [
			JSON.stringify({
				type: "failure",
				id: "mx-1",
				description: "push rejected",
				resolution: "classify the policy rejection",
				dir_anchors: ["src/runs/reap"],
			}),
			JSON.stringify({ type: "decision", id: "mx-2", title: "t", rationale: "r" }),
			JSON.stringify({
				type: "failure",
				id: "mx-3",
				description: "d",
				resolution: "r",
				status: "archived",
			}),
			JSON.stringify({ type: "failure", id: "mx-4", description: "no resolution" }),
			"{broken",
		].join("\n");
		const priors = parseFailurePriors([body]);
		expect(priors.map((prior) => prior.id)).toEqual(["mx-1"]);
		expect(priors[0]?.dirAnchors).toEqual(["src/runs/reap"]);
	});

	test("deduplicates ids across files", () => {
		const line = JSON.stringify({
			type: "failure",
			id: "mx-1",
			description: "d",
			resolution: "r",
		});
		expect(parseFailurePriors([line, line])).toHaveLength(1);
	});
});

describe("selectFailurePriors", () => {
	test("anchor matches outrank token overlap", () => {
		const seed = "Handle push protection in src/runs/reap";
		const selected = selectFailurePriors(seed, [GENERIC_FAILURE, REAP_FAILURE]);
		expect(selected.map((prior) => prior.id)).toEqual(["mx-0001"]);
	});

	test("drops records below the relevance floor", () => {
		const seed = "Increase the logo resolution on the marketing page";
		expect(selectFailurePriors(seed, [REAP_FAILURE, GENERIC_FAILURE])).toEqual([]);
	});

	test("honors the limit and breaks ties by newest recorded_at, then id", () => {
		const base: MulchFailurePrior = {
			id: "mx-aaaa",
			description: "src/runs/reap push protection",
			resolution: "classify the rejection",
			dirAnchors: ["src/runs/reap"],
			recordedAt: "2026-08-01T00:00:00.000Z",
		};
		const newer = { ...base, id: "mx-zzzz", recordedAt: "2026-08-02T00:00:00.000Z" };
		const sameTimeLowerId = { ...base, id: "mx-bbbb" };
		const seed = "fix src/runs/reap";
		expect(
			selectFailurePriors(seed, [base, newer, sameTimeLowerId]).map((prior) => prior.id),
		).toEqual(["mx-zzzz", "mx-aaaa", "mx-bbbb"]);
		expect(selectFailurePriors(seed, [base, newer, sameTimeLowerId], 2)).toHaveLength(2);
	});
});

describe("formatPriorBlock", () => {
	test("renders the header and one entry per record", () => {
		const block = formatPriorBlock([REAP_FAILURE]);
		expect(block).toContain("## Known failure priors for this project");
		expect(block).toContain("[mx-0001]");
		expect(block).toContain("Fix: Classify GH013 as push_rejected_policy");
	});

	test("returns an empty string with no records", () => {
		expect(formatPriorBlock([])).toBe("");
	});

	test("stays inside the character cap", () => {
		const priors: MulchFailurePrior[] = Array.from({ length: 40 }, (_, index) => ({
			id: `mx-${index.toString(16).padStart(4, "0")}`,
			description: "x".repeat(400),
			resolution: "y".repeat(400),
			dirAnchors: [],
			recordedAt: "",
		}));
		const block = formatPriorBlock(priors);
		expect(block.length).toBeLessThanOrEqual(MULCH_PRIOR_MAX_CHARS);
		expect(block.split("\n- ").length).toBeLessThan(40);
	});
});

describe("buildMulchPriorBlock", () => {
	const CLONE = "/tmp/mulch-priors-clone";

	test("returns the empty result when the corpus directory is missing", async () => {
		const result = await buildMulchPriorBlock({
			projectPath: CLONE,
			prompt: "fix src/runs/reap",
			readdirFn: async () => {
				throw new Error("ENOENT");
			},
		});
		expect(result).toEqual({ block: "", count: 0 });
	});

	test("selects records that match the operator prompt", async () => {
		const files: Record<string, string> = {
			[`${CLONE}/.mulch/expertise/patterns.jsonl`]: `${JSON.stringify({
				type: "failure",
				id: "mx-0001",
				description: REAP_FAILURE.description,
				resolution: REAP_FAILURE.resolution,
				dir_anchors: REAP_FAILURE.dirAnchors,
			})}\n`,
		};
		const result = await buildMulchPriorBlock({
			projectPath: CLONE,
			prompt: "Handle push protection in src/runs/reap",
			readFileFn: async (path) => {
				const body = files[path];
				if (body === undefined) throw new Error(`ENOENT ${path}`);
				return body;
			},
			readdirFn: async () => ["patterns.jsonl"],
		});
		expect(result.count).toBe(1);
		expect(result.block).toContain("[mx-0001]");
	});

	test("prefers the seed record's text over the operator prompt", async () => {
		const files: Record<string, string> = {
			[`${CLONE}/.seeds/issues.jsonl`]: `${JSON.stringify({
				id: "warren-1a2b",
				title: "Fix reap push rejection",
				description: "GH013 blocks the push in src/runs/reap",
			})}\n`,
			[`${CLONE}/.mulch/expertise/patterns.jsonl`]: `${JSON.stringify({
				type: "failure",
				id: "mx-0001",
				description: REAP_FAILURE.description,
				resolution: REAP_FAILURE.resolution,
				dir_anchors: REAP_FAILURE.dirAnchors,
			})}\n`,
		};
		const result = await buildMulchPriorBlock({
			projectPath: CLONE,
			prompt: "Work on the seed",
			seedId: "warren-1a2b",
			readFileFn: async (path) => files[path] ?? "",
			readdirFn: async () => ["patterns.jsonl"],
		});
		expect(result.count).toBe(1);
		expect(result.block).toContain("[mx-0001]");
	});

	test("falls back to the prompt when the seed file is unreadable", async () => {
		const result = await buildMulchPriorBlock({
			projectPath: CLONE,
			prompt: "Handle push protection in src/runs/reap",
			seedId: "warren-1a2b",
			readFileFn: async (path) => {
				if (path.endsWith(".seeds/issues.jsonl")) throw new Error("ENOENT");
				return `${JSON.stringify({
					type: "failure",
					id: "mx-0001",
					description: REAP_FAILURE.description,
					resolution: REAP_FAILURE.resolution,
					dir_anchors: REAP_FAILURE.dirAnchors,
				})}\n`;
			},
			readdirFn: async () => ["patterns.jsonl"],
		});
		expect(result.count).toBe(1);
	});
});
