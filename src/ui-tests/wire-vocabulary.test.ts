/**
 * Single-source-of-truth guard for the canonical wire vocabulary
 * (warren-b229 / pl-b82d step 26).
 *
 * `src/core/wire.ts` is the ONE home for the enum-shaped values that cross
 * warren's HTTP wire. The three surfaces that used to hand-copy them — the
 * drizzle column metadata, the SDK, and the browser UI — now re-export it.
 * This test asserts that at RUNTIME, by object identity: a re-exported
 * constant is the same array instance, so a future copy-paste redeclaration
 * fails here even if it happens to spell the same values today.
 *
 * The complementary static check (no redeclaration anywhere in the tree)
 * lands as `check:wire-types` in warren-d371.
 */
import { describe, expect, test } from "bun:test";
import * as sdk from "../client/types.ts";
import * as wire from "../core/wire.ts";
import * as schema from "../db/schema.ts";
import * as ui from "../ui/src/api/types.ts";

describe("canonical wire vocabulary", () => {
	test("the db schema re-exports the kernel's constants by identity", () => {
		expect(schema.RUN_STATES).toBe(wire.RUN_STATES);
		expect(schema.RUN_FAILURE_REASONS).toBe(wire.RUN_FAILURE_REASONS);
		expect(schema.RUN_MODES).toBe(wire.RUN_MODES);
		expect(schema.PLAN_RUN_CHILD_STATES).toBe(wire.PLAN_RUN_CHILD_STATES);
	});

	test("RUN_TERMINAL_STATES is one array shared by the SDK and the UI", () => {
		expect(sdk.RUN_TERMINAL_STATES).toBe(wire.RUN_TERMINAL_STATES);
		expect(ui.RUN_TERMINAL_STATES).toBe(wire.RUN_TERMINAL_STATES);
	});

	test("PLAN_RUN_TERMINAL_STATES is one array shared by the SDK and the UI", () => {
		expect(sdk.PLAN_RUN_TERMINAL_STATES).toBe(wire.PLAN_RUN_TERMINAL_STATES);
		expect(ui.PLAN_RUN_TERMINAL_STATES).toBe(wire.PLAN_RUN_TERMINAL_STATES);
	});

	test("both surfaces share the kernel's terminal-state predicates", () => {
		expect(sdk.isTerminalRunState).toBe(wire.isTerminalRunState);
		expect(ui.isTerminalRunState).toBe(wire.isTerminalRunState);
		expect(sdk.isTerminalPlanRunState).toBe(wire.isTerminalPlanRunState);
		expect(ui.isTerminalPlanRunState).toBe(wire.isTerminalPlanRunState);
		expect(ui.isActivePreviewState).toBe(wire.isActivePreviewState);
	});
});
