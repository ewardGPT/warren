import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import { makeBurrowClient, makeProvider, setupRepos } from "../spawn/test-helpers.ts";
import {
	decideForcedContinuation,
	FORCE_CONTINUE_TRIGGER,
	type ForceDecisionInput,
	finalizeRunEvidence,
	MAX_FORCED_CONTINUATIONS,
	type RunEvidenceInput,
} from "./run-evidence.ts";
import type { ScorecardReapFacts } from "./scorecard.ts";
import type { ReapExec } from "./types.ts";

const NOOP_STATE: ScorecardReapFacts = {
	noChanges: true,
	branchPushed: false,
	commitsAhead: null,
	prUrl: null,
	pushProtection: null,
	mulchUpdated: 0,
	mulchAppended: 0,
	seedsClosed: 0,
	seedsCreated: 0,
};

const EXEC: ReapExec = {
	run: async () => ({ stdout: "", stderr: "" }),
};

function decisionInput(over: Partial<ForceDecisionInput> = {}): ForceDecisionInput {
	return {
		enabled: true,
		outcome: "succeeded",
		failureReason: null,
		noChanges: true,
		costUsd: null,
		budgetCapUsd: null,
		existingForcedContinuations: 0,
		maxContinuations: MAX_FORCED_CONTINUATIONS,
		...over,
	};
}

describe("decideForcedContinuation", () => {
	test("forces on a succeeded no-op", () => {
		expect(decideForcedContinuation(decisionInput())).toEqual({
			force: true,
			reason: null,
		});
	});

	test("forces on a failed dropped commit", () => {
		const decision = decideForcedContinuation(
			decisionInput({ outcome: "failed", failureReason: "dropped_commit", noChanges: false }),
		);
		expect(decision.force).toBe(true);
	});

	test("refuses when disabled", () => {
		expect(decideForcedContinuation(decisionInput({ enabled: false })).reason).toBe("disabled");
	});

	test("refuses evidence-bearing terminals", () => {
		const withWork = decideForcedContinuation(decisionInput({ noChanges: false }));
		expect(withWork.reason).toBe("evidence_nonempty");
		const crashed = decideForcedContinuation(
			decisionInput({ outcome: "failed", failureReason: "crashed", noChanges: false }),
		);
		expect(crashed.reason).toBe("evidence_nonempty");
	});

	test("refuses when the lineage already used its chances", () => {
		const decision = decideForcedContinuation(decisionInput({ existingForcedContinuations: 1 }));
		expect(decision.reason).toBe("lineage_capped");
	});

	test("refuses when the budget is exhausted", () => {
		const decision = decideForcedContinuation(decisionInput({ costUsd: 1, budgetCapUsd: 1 }));
		expect(decision.reason).toBe("budget_exhausted");
	});
});

describe("finalizeRunEvidence", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	async function makeParentRow(over: Partial<RunRow> = {}): Promise<RunRow> {
		return repos.runs.create({
			...over,
			agentName: over.agentName ?? "refactor-bot",
			projectId: over.projectId ?? "prj_xxxxxxxxxxxx",
			prompt: "Fix the flaky reap test",
			renderedAgentJson: over.renderedAgentJson ?? {},
			trigger: "manual",
		});
	}

	function evidenceInput(parent: RunRow, over: Partial<RunEvidenceInput> = {}): RunEvidenceInput {
		return {
			repos,
			runtimeProvider: makeProvider(makeBurrowClient().client),
			outcome: "succeeded",
			failureReason: null,
			state: NOOP_STATE,
			run: parent,
			salvageRef: null,
			salvageBundlePath: null,
			providerError: false,
			events: [],
			workspacePath: null,
			baseBranch: null,
			exec: EXEC,
			emit: async () => ({}),
			log: { info: () => {}, warn: () => {} },
			forceContinuation: { enabled: true },
			...over,
		};
	}

	test("emits the scorecard and dispatches one continuation on an empty success", async () => {
		const parent = await makeParentRow();
		const emitted: string[] = [];
		await finalizeRunEvidence(
			evidenceInput(parent, { emit: async (kind) => void emitted.push(kind) }),
		);
		expect(emitted).toEqual(["run.scorecard"]);
		const children = await repos.runs.listByParentRunId(parent.id);
		expect(children).toHaveLength(1);
		const child = children[0];
		expect(child?.trigger).toBe(FORCE_CONTINUE_TRIGGER);
		expect(child?.cloneKind).toBe("continue");
		expect(child?.parentRunId).toBe(parent.id);
		expect(child?.agentName).toBe("refactor-bot");
		expect(child?.prompt).toContain("ended without verified work");
		expect(child?.prompt).toContain("Fix the flaky reap test");
	});

	test("applies the triage cap as the continuation's spend ceiling", async () => {
		const parent = await makeParentRow();
		await finalizeRunEvidence(evidenceInput(parent));
		const children = await repos.runs.listByParentRunId(parent.id);
		const rendered = (children[0]?.renderedAgentJson ?? {}) as {
			frontmatter?: Record<string, unknown>;
		};
		expect(rendered.frontmatter?.maxCostUsd).toBe(1);
	});

	test("carries the parent's explicit cap onto the continuation", async () => {
		const parent = await makeParentRow({ renderedAgentJson: { frontmatter: { maxCostUsd: 5 } } });
		await finalizeRunEvidence(evidenceInput(parent));
		const children = await repos.runs.listByParentRunId(parent.id);
		const rendered = (children[0]?.renderedAgentJson ?? {}) as {
			frontmatter?: Record<string, unknown>;
		};
		expect(rendered.frontmatter?.maxCostUsd).toBe(5);
	});

	test("spawns nothing when the switch is off", async () => {
		const parent = await makeParentRow();
		await finalizeRunEvidence(evidenceInput(parent, { forceContinuation: { enabled: false } }));
		expect(await repos.runs.listByParentRunId(parent.id)).toHaveLength(0);
	});

	test("spawns nothing when the terminal carries evidence", async () => {
		const parent = await makeParentRow();
		await finalizeRunEvidence(
			evidenceInput(parent, { state: { ...NOOP_STATE, noChanges: false } }),
		);
		expect(await repos.runs.listByParentRunId(parent.id)).toHaveLength(0);
	});

	test("spawns nothing when the parent burned its budget", async () => {
		const created = await makeParentRow({ renderedAgentJson: { frontmatter: { maxCostUsd: 1 } } });
		await repos.runs.attachStats(created.id, { costUsd: 1 });
		// attachStats returns a fresh row; re-read so the decision sees it.
		const parent = await repos.runs.require(created.id);
		await finalizeRunEvidence(evidenceInput(parent));
		expect(await repos.runs.listByParentRunId(parent.id)).toHaveLength(0);
	});

	test("never farms a second chance: forced children are capped per lineage", async () => {
		const parent = await makeParentRow();
		await finalizeRunEvidence(evidenceInput(parent));
		const child = (await repos.runs.listByParentRunId(parent.id))[0];
		expect(child).toBeDefined();
		if (child === undefined) return;
		// The forced child itself ends evidence-empty — it must not re-force.
		await finalizeRunEvidence(evidenceInput(child));
		expect(await repos.runs.listByParentRunId(parent.id)).toHaveLength(1);
		expect(await repos.runs.listByParentRunId(child.id)).toHaveLength(0);
	});

	test("swallows a failed continuation dispatch: the scorecard still lands", async () => {
		const parent = await makeParentRow({ agentName: "no-such-agent" });
		const emitted: string[] = [];
		await finalizeRunEvidence(
			evidenceInput(parent, { emit: async (kind) => void emitted.push(kind) }),
		);
		expect(emitted).toEqual(["run.scorecard"]);
	});
});
