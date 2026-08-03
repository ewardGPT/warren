import { describe, expect, test } from "bun:test";
import type { PrCommit } from "./pr.ts";
import {
	composeBody,
	composeTitle,
	PR_BODY_FRAGMENT_NAMES,
	PR_FRAGMENT_NAMES,
	type PrFragmentContext,
	parsePrTemplate,
} from "./pr-template.ts";

const BASE_CTX: PrFragmentContext = {
	prompt: "do x",
	runId: "run_abc",
	agentName: "refactor-bot",
};

describe("parsePrTemplate", () => {
	test("returns empty overrides + no warnings on an empty file", () => {
		const parsed = parsePrTemplate("");
		expect(parsed.overrides).toEqual({});
		expect(parsed.warnings).toEqual([]);
	});

	test("parses one H2 section into a fragment override", () => {
		const parsed = parsePrTemplate("## trailer\n\nReviewed-by: @team\n");
		expect(parsed.overrides.trailer).toBe("Reviewed-by: @team");
		expect(parsed.warnings).toEqual([]);
	});

	test("supports multiple fragments and preserves order-independent semantics", () => {
		const file = [
			"# Project PR template",
			"",
			"## summary",
			"Summary override.",
			"",
			"## trailer",
			"Custom trailer line.",
			"",
		].join("\n");
		const parsed = parsePrTemplate(file);
		expect(parsed.overrides.summary).toBe("Summary override.");
		expect(parsed.overrides.trailer).toBe("Custom trailer line.");
		expect(parsed.warnings).toEqual([]);
	});

	test("normalizes fragment names (case + dashes + spaces → snake_case)", () => {
		const parsed = parsePrTemplate(
			"## Files-Changed\nstatic body\n\n## Preview Url Or Placeholder\nfragment\n",
		);
		expect(parsed.overrides.files_changed).toBe("static body");
		// preview_url_or_placeholder normalizes from "Preview Url Or Placeholder"
		expect(parsed.overrides.preview_url_or_placeholder).toBe("fragment");
	});

	test("emits an unknown_fragment warning for typos and ignores them", () => {
		const parsed = parsePrTemplate("## summery\noops\n");
		expect(parsed.overrides).toEqual({});
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.warnings[0]?.code).toBe("unknown_fragment");
		expect(parsed.warnings[0]?.message).toContain("summery");
	});

	test("emits no_fragments warning when content has no H2 headings", () => {
		const parsed = parsePrTemplate("Just a stray note with no headings.\n");
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.warnings[0]?.code).toBe("no_fragments");
	});

	test("warns when preview_url_or_placeholder override has unbalanced markers", () => {
		const parsed = parsePrTemplate(
			"## preview_url_or_placeholder\n<!-- warren:preview-start -->\nhello\n",
		);
		expect(parsed.overrides.preview_url_or_placeholder).toBeDefined();
		expect(parsed.warnings).toHaveLength(1);
		expect(parsed.warnings[0]?.code).toBe("unclosed_preview_markers");
	});

	test("does not warn when both preview markers are present", () => {
		const parsed = parsePrTemplate(
			"## preview_url_or_placeholder\n<!-- warren:preview-start -->\nhello\n<!-- warren:preview-end -->\n",
		);
		expect(parsed.warnings).toEqual([]);
	});

	test("treats whitespace-only body as a 'remove this fragment' override", () => {
		const parsed = parsePrTemplate("## prompt\n\n\n");
		expect(parsed.overrides.prompt).toBe("");
	});

	test("bodies before the first H2 are ignored", () => {
		const parsed = parsePrTemplate("Intro text\n\nthat should be skipped.\n\n## trailer\n\nKeep.");
		expect(parsed.overrides.trailer).toBe("Keep.");
	});

	test("recognizes every documented fragment name", () => {
		for (const name of PR_FRAGMENT_NAMES) {
			const parsed = parsePrTemplate(`## ${name}\noverride\n`);
			expect(parsed.warnings).toEqual([]);
			expect(parsed.overrides[name]).toBe("override");
		}
	});
});

describe("composeBody", () => {
	test("matches the legacy default output for a minimal context", () => {
		const body = composeBody(BASE_CTX);
		expect(body).toContain("## Summary");
		expect(body).toContain("Agent `refactor-bot` ran no commits.");
		expect(body).toContain("## Run");
		expect(body).toContain("**Warren run:** `run_abc`");
		expect(body).toContain("## Prompt");
		expect(body).toContain("🤖 Opened by warren run `run_abc`");
	});

	test("omits seed/preview/commits/files_changed when their data is absent", () => {
		const body = composeBody(BASE_CTX);
		expect(body).not.toContain("## Seeds");
		expect(body).not.toContain("## Preview");
		expect(body).not.toContain("## Commits");
		expect(body).not.toContain("## Files changed");
	});

	test("renders the preview placeholder fragment when previewOptedIn is true", () => {
		const body = composeBody({ ...BASE_CTX, previewOptedIn: true });
		expect(body).toContain("## Preview");
		expect(body).toContain("<!-- warren:preview-start -->");
		expect(body).toContain("Preview launching…");
		expect(body).toContain("<!-- warren:preview-end -->");
	});

	test("project override replaces a fragment wholesale", () => {
		const body = composeBody(BASE_CTX, {
			trailer: "Reviewed-by: @team\n\nPlease follow our checklist before merging.",
		});
		expect(body).toContain("Reviewed-by: @team");
		expect(body).toContain("checklist before merging");
		// Default trailer is gone
		expect(body).not.toContain("🤖 Opened by warren run");
	});

	test("project override that's whitespace-only removes the fragment", () => {
		const body = composeBody(BASE_CTX, { prompt: "   \n  " });
		expect(body).not.toContain("## Prompt");
		// Other defaults still render
		expect(body).toContain("## Run");
	});

	test("override falls through to default when not supplied", () => {
		const body = composeBody(BASE_CTX, { trailer: "custom" });
		expect(body).toContain("## Summary"); // default
		expect(body).toContain("custom"); // override
	});

	test("body fragment order matches PR_BODY_FRAGMENT_NAMES (smoke)", () => {
		// The "title" fragment must not appear in the body order list.
		expect(PR_BODY_FRAGMENT_NAMES.includes("title" as never)).toBe(false);
		// Spot-check that the registry exposes the documented body order.
		expect(PR_BODY_FRAGMENT_NAMES[0]).toBe("summary");
		expect(PR_BODY_FRAGMENT_NAMES[PR_BODY_FRAGMENT_NAMES.length - 1]).toBe("trailer");
	});

	test("clamps an oversized body to the cap by dropping commits", () => {
		// Enough wide commits to blow past GitHub's 65_536-char body cap.
		const commits: readonly PrCommit[] = Array.from({ length: 5000 }, (_, i) => ({
			sha: `deadbeef${i.toString(16).padStart(2, "0")}`,
			subject: `commit number ${i} with a long-enough subject to inflate the rendered line beyond the cap`,
		}));
		const body = composeBody({ ...BASE_CTX, commits });
		expect(body.length).toBeLessThanOrEqual(65_536);
		expect(body).toContain("and ");
		expect(body).toContain(" more");
		// The commit list header still reflects the true total.
		expect(body).toContain("## Commits (5000)");
	});

	test("oversized body that cannot fit even with zero commits is hard-sliced", () => {
		const ctx: PrFragmentContext = {
			...BASE_CTX,
			prompt: "x".repeat(80_000),
		};
		const body = composeBody(ctx);
		expect(body.length).toBeLessThanOrEqual(65_536);
	});
});

describe("composeTitle", () => {
	test("uses default precedence when no override is supplied", () => {
		const title = composeTitle(
			{
				...BASE_CTX,
				prompt: "Fix the auth bug",
				seed: { id: "warren-1234", title: "Seed-titled change" },
			},
			{},
			72,
		);
		expect(title).toBe("Seed-titled change");
	});

	test("project title override beats the default precedence chain", () => {
		const title = composeTitle(
			{
				...BASE_CTX,
				prompt: "ignored",
				seed: { id: "warren-1234", title: "Seed-titled change" },
			},
			{ title: "Custom Project Title" },
			72,
		);
		expect(title).toBe("Custom Project Title");
	});

	test("title override truncates to max length", () => {
		const long = "x".repeat(200);
		const title = composeTitle(BASE_CTX, { title: long }, 20);
		expect(title.length).toBeLessThanOrEqual(20);
		expect(title.endsWith("…")).toBe(true);
	});

	test("empty title override falls back to default chain", () => {
		const title = composeTitle({ ...BASE_CTX, prompt: "Hello world" }, { title: "   " }, 72);
		expect(title).toBe("Hello world");
	});
});
