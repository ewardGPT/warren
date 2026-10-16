/**
 * Provider/model precedence for a spawn (warren-9663). Split out of
 * `dispatch.test.ts` so neither file trips the file-size budget.
 *
 * The rule: an explicit per-run override wins; otherwise an agent the caller
 * named explicitly keeps its own frontmatter provider/model over the project's
 * `defaultProvider` / `defaultModel`; a role-based (`defaultRole`) dispatch,
 * which never names the agent, still takes the project default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import {
	makeAgentJson,
	makeBurrowClient,
	makeProvider,
	readAgentEnvelopeFrontmatter,
	setupRepos,
} from "./test-helpers.ts";

describe("spawnRun: explicit agent keeps its own provider (warren-9663)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	const bridgeAgent = async (): Promise<void> => {
		await repos.agents.upsert({
			name: "pi-bridge",
			renderedJson: makeAgentJson({
				name: "pi-bridge",
				frontmatter: { provider: "bridge", model: "deepseek-v4-flash" },
			}),
		});
	};
	const projectDefaults = {
		get: async () => ({
			triggers: null,
			defaults: { defaultProvider: "openai", defaultModel: "deepseek-chat" },
			prTemplate: null,
			sourceFile: null,
			errors: [],
			warnings: [],
		}),
		invalidate: () => undefined,
		clear: () => undefined,
		size: () => 0,
	};

	test("an explicitly named agent keeps its own provider/model over the project default", async () => {
		await bridgeAgent();
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi-bridge",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			explicitAgent: true,
			warrenConfigs: projectDefaults,
		});

		expect(result.agent.frontmatter.provider).toBe("bridge");
		expect(result.agent.frontmatter.model).toBe("deepseek-v4-flash");
		// The same envelope is frozen onto the run row / sent to burrow.
		const frozen = readAgentEnvelopeFrontmatter(calls);
		expect(frozen.provider).toBe("bridge");
		expect(frozen.model).toBe("deepseek-v4-flash");
	});

	test("a defaultRole-style dispatch (no explicit agent) still takes the project default", async () => {
		await bridgeAgent();
		const { client, calls } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi-bridge",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			warrenConfigs: projectDefaults,
		});

		expect(result.agent.frontmatter.provider).toBe("openai");
		expect(result.agent.frontmatter.model).toBe("deepseek-chat");
		expect(readAgentEnvelopeFrontmatter(calls).provider).toBe("openai");
	});

	test("an explicit providerOverride still wins over both the agent and the project default", async () => {
		await bridgeAgent();
		const { client } = makeBurrowClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "pi-bridge",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
			explicitAgent: true,
			providerOverride: "anthropic",
			warrenConfigs: projectDefaults,
		});

		expect(result.agent.frontmatter.provider).toBe("anthropic");
		// Model is not overridden, so the explicitly named agent keeps its own.
		expect(result.agent.frontmatter.model).toBe("deepseek-v4-flash");
	});
});
