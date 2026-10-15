/**
 * Fleet-box readiness checks: can warren still PLACE work, and who is busy.
 *
 * `checks-kernel.ts` answers "is each box's coordination kernel alive". This one
 * answers the execution question — is each box's BURROW reachable, is its token
 * still valid, and how many live workspaces does it carry — which is the pair
 * that decides whether a dispatch can land at all.
 *
 * Same two-surface split as the kernel checks, for the same reason: a box is not
 * a dependency of a warren request, so `warren doctor` reports one check per box
 * with the real verdict, and `/readyz` gets ONE aggregate line that is always ok.
 *
 * When the runtime kind is not `fleet`, the fleet config is absent, or it is
 * unusable, this contributes NOTHING: an install that does not run a fleet must
 * not grow a check because the feature exists. A configured fleet that fails to
 * load is reported in `doctor` (one line, with the loader's own reason) because
 * that is an operator error worth seeing.
 */

import type { BoxHealth, FleetBoxRuntime } from "../runtime/local/fleet/index.ts";
import { buildFleetProvider, FleetConfigError, probeBoxes } from "../runtime/local/fleet/index.ts";
import { resolveRuntimeKind } from "../runtime/registry.ts";
import type { DiagnosticCheck, EnvLike } from "./checks.ts";

export interface FleetCheckDeps {
	readonly env: EnvLike;
	readonly mode: "doctor" | "readyz";
	/** Overrides the provider build (tests); takes precedence over `boxes`. */
	readonly boxes?: readonly FleetBoxRuntime[];
	readonly probeTimeoutMs?: number;
}

/** True when this process is configured to dispatch onto boxes at all. */
export function fleetConfigured(env: EnvLike): boolean {
	try {
		return resolveRuntimeKind(env) === "fleet";
	} catch {
		// An unknown WARREN_RUNTIME is the selector's error to raise loudly at
		// boot, not this check's; report nothing here.
		return false;
	}
}

export async function fleetBoxChecks(deps: FleetCheckDeps): Promise<DiagnosticCheck[]> {
	if (!fleetConfigured(deps.env)) return [];
	const loaded = loadBoxes(deps);
	if ("checks" in loaded) return loaded.checks;
	if (loaded.boxes.length === 0) return [];
	const health = await probeBoxes(
		loaded.boxes,
		deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs },
	);
	const rows = loaded.boxes.map((box) => ({ id: box.id, health: health.get(box.id) }));
	return deps.mode === "readyz" ? [readyzLine(rows)] : doctorLines(rows);
}

type BoxRow = { id: string; health: BoxHealth | undefined };

/** The boxes, or the one check that explains why there are none. */
function loadBoxes(
	deps: FleetCheckDeps,
): { boxes: readonly FleetBoxRuntime[] } | { checks: DiagnosticCheck[] } {
	if (deps.boxes !== undefined) return { boxes: deps.boxes };
	try {
		return { boxes: buildFleetProvider({ env: deps.env }).boxes };
	} catch (error) {
		if (!(error instanceof FleetConfigError)) throw error;
		// readyz stays silent: a config error is an operator problem, not an
		// availability signal for warren's own consumers.
		if (deps.mode === "readyz") return { checks: [] };
		return {
			checks: [
				{
					name: "fleet-config",
					ok: false,
					message: error.message,
					...(error.recoveryHint === undefined ? {} : { hint: error.recoveryHint }),
				},
			],
		};
	}
}

/** One aggregate line that is ALWAYS ok: a box outage is not warren's outage. */
function readyzLine(rows: readonly BoxRow[]): DiagnosticCheck {
	const down = rows.filter((row) => row.health?.healthy !== true);
	const summary =
		down.length === 0
			? `${rows.length}/${rows.length} burrow boxes reachable`
			: `${rows.length - down.length}/${rows.length} burrow boxes reachable (${down
					.map((row) => row.id)
					.join(", ")} down)`;
	return {
		name: "fleet-boxes",
		ok: true,
		message: summary,
		...(down.length === 0
			? {}
			: { hint: "a box outage never fails this endpoint; `warren doctor` reports each box" }),
	};
}

/** One real verdict per box, which is what an operator reads in `warren doctor`. */
function doctorLines(rows: readonly BoxRow[]): DiagnosticCheck[] {
	return rows.map((row) => {
		const health = row.health;
		if (health === undefined || !health.healthy) {
			return {
				name: `fleet:${row.id}`,
				ok: false,
				message: `burrow unreachable (${health?.detail ?? "not probed"})`,
				hint: "check burrow-serve.service on the box and the tailnet route to its port",
			};
		}
		return {
			name: `fleet:${row.id}`,
			ok: true,
			message: `${health.live} live workspace${health.live === 1 ? "" : "s"}`,
		};
	});
}
