/**
 * Repository for `graph_runs` + `graph_run_children` (graph-engineering pilot).
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type {
	GraphRunChildPhase,
	GraphRunChildRow,
	GraphRunChildState,
	GraphRunFindingJson,
	GraphRunRow,
	GraphRunScopeJson,
	GraphRunState,
} from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

const ALLOWED_TRANSITIONS: Record<GraphRunState, readonly GraphRunState[]> = {
	pending: ["fan_out", "failed"],
	fan_out: ["verifying", "synthesizing", "succeeded", "failed"],
	verifying: ["synthesizing", "succeeded", "failed"],
	synthesizing: ["succeeded", "failed"],
	succeeded: [],
	failed: [],
};

export function assertGraphRunTransition(from: GraphRunState, to: GraphRunState): void {
	if (!ALLOWED_TRANSITIONS[from].includes(to)) {
		throw new StateTransitionError(`invalid graph_run transition: ${from} → ${to}`);
	}
}

export interface CreateGraphRunChildInput {
	readonly seq: number;
	readonly phase: GraphRunChildPhase;
	readonly filePath?: string | null;
	readonly findingJson?: GraphRunFindingJson | null;
	readonly state?: GraphRunChildState;
}

export interface CreateGraphRunInput {
	readonly id?: string;
	readonly projectId: string;
	readonly template: string;
	readonly agentName?: string;
	readonly scopeJson: GraphRunScopeJson;
	readonly verifyEnabled: boolean;
	readonly synthesizeEnabled: boolean;
	readonly maxFanOut?: number;
	readonly state?: GraphRunState;
	readonly children: readonly CreateGraphRunChildInput[];
	readonly now?: Date;
}

export interface CreateGraphRunResult {
	readonly graphRun: GraphRunRow;
	readonly children: readonly GraphRunChildRow[];
}

export interface TransitionGraphRunOptions {
	readonly failureReason?: string | null;
	readonly startedAt?: string | null;
	readonly endedAt?: string | null;
}

export interface GraphRunChildPatch {
	readonly runId?: string | null;
	readonly state?: GraphRunChildState;
	readonly findingJson?: GraphRunFindingJson | null;
}

export interface UpdateGraphRunChildInput {
	readonly id: string;
	readonly patch: GraphRunChildPatch;
}

export class GraphRunsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}

	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}

	private get graphRuns() {
		return this.adapter.schema.graphRuns;
	}

	private get graphRunChildren() {
		return this.adapter.schema.graphRunChildren;
	}

	async create(input: CreateGraphRunInput): Promise<CreateGraphRunResult> {
		if (input.children.length === 0) {
			throw new ValidationError("graph_runs.create requires at least one child");
		}
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = input.id ?? generateId("graphRun");
		const graphRunRow: GraphRunRow = {
			id,
			projectId: input.projectId,
			template: input.template,
			agentName: input.agentName ?? "sapling",
			state: input.state ?? "pending",
			scopeJson: input.scopeJson,
			verifyEnabled: input.verifyEnabled,
			synthesizeEnabled: input.synthesizeEnabled,
			maxFanOut: input.maxFanOut ?? 16,
			failureReason: null,
			createdAt: nowIso,
			startedAt: null,
			endedAt: null,
		};
		const childRows: GraphRunChildRow[] = input.children.map((c) => ({
			id: generateId("graphRunChild"),
			graphRunId: id,
			seq: c.seq,
			phase: c.phase,
			runId: null,
			state: c.state ?? "pending",
			filePath: c.filePath ?? null,
			findingJson: c.findingJson ?? null,
		}));
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			await tx.runWrite(txDb.insert(tx.schema.graphRuns).values(graphRunRow));
			for (const row of childRows) {
				await tx.runWrite(txDb.insert(tx.schema.graphRunChildren).values(row));
			}
			return { graphRun: graphRunRow, children: childRows };
		});
	}

	async insertChildren(
		graphRunId: string,
		children: readonly CreateGraphRunChildInput[],
	): Promise<readonly GraphRunChildRow[]> {
		if (children.length === 0) return [];
		const rows: GraphRunChildRow[] = children.map((c) => ({
			id: generateId("graphRunChild"),
			graphRunId,
			seq: c.seq,
			phase: c.phase,
			runId: null,
			state: c.state ?? "pending",
			filePath: c.filePath ?? null,
			findingJson: c.findingJson ?? null,
		}));
		return this.adapter.runInTransaction(async (tx) => {
			const txDb = tx.drizzle as SqliteDrizzleDb;
			for (const row of rows) {
				await tx.runWrite(txDb.insert(tx.schema.graphRunChildren).values(row));
			}
			return rows;
		});
	}

	async getById(id: string): Promise<GraphRunRow | null> {
		const row = await this.adapter.pickOne(
			this.db.select().from(this.graphRuns).where(eq(this.graphRuns.id, id)),
		);
		return row ?? null;
	}

	async require(id: string): Promise<GraphRunRow> {
		const row = await this.getById(id);
		if (!row) throw new NotFoundError(`graph_run not found: ${id}`);
		return row;
	}

	async listChildren(graphRunId: string): Promise<GraphRunChildRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.graphRunChildren)
				.where(eq(this.graphRunChildren.graphRunId, graphRunId))
				.orderBy(asc(this.graphRunChildren.seq)),
		);
	}

	async listChildrenByPhase(
		graphRunId: string,
		phase: GraphRunChildPhase,
	): Promise<GraphRunChildRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.graphRunChildren)
				.where(
					and(
						eq(this.graphRunChildren.graphRunId, graphRunId),
						eq(this.graphRunChildren.phase, phase),
					),
				)
				.orderBy(asc(this.graphRunChildren.seq)),
		);
	}

	async listActive(): Promise<GraphRunRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.graphRuns)
				.where(inArray(this.graphRuns.state, ["pending", "fan_out", "verifying", "synthesizing"]))
				.orderBy(asc(this.graphRuns.createdAt)),
		);
	}

	async transitionTo(
		id: string,
		state: GraphRunState,
		opts: TransitionGraphRunOptions = {},
	): Promise<GraphRunRow> {
		const current = await this.require(id);
		assertGraphRunTransition(current.state, state);
		const patch: Partial<GraphRunRow> = { state };
		if (opts.startedAt !== undefined) patch.startedAt = opts.startedAt;
		if (opts.endedAt !== undefined) patch.endedAt = opts.endedAt;
		if (opts.failureReason !== undefined) patch.failureReason = opts.failureReason;
		await this.adapter.runWrite(
			this.db.update(this.graphRuns).set(patch).where(eq(this.graphRuns.id, id)),
		);
		return { ...current, ...patch };
	}

	async updateChild(input: UpdateGraphRunChildInput): Promise<GraphRunChildRow> {
		const keys = ["runId", "state", "findingJson"] as const;
		if (keys.every((k) => input.patch[k] === undefined)) {
			throw new ValidationError("graph_runs.updateChild requires at least one patch field");
		}
		const current = await this.adapter.pickOne(
			this.db.select().from(this.graphRunChildren).where(eq(this.graphRunChildren.id, input.id)),
		);
		if (!current) {
			throw new NotFoundError(`graph_run_child not found: ${input.id}`);
		}
		const patch: Partial<GraphRunChildRow> = {};
		for (const k of keys) {
			if (input.patch[k] !== undefined) {
				(patch as Record<string, unknown>)[k] = input.patch[k];
			}
		}
		await this.adapter.runWrite(
			this.db
				.update(this.graphRunChildren)
				.set(patch)
				.where(eq(this.graphRunChildren.id, input.id)),
		);
		return { ...current, ...patch };
	}

	async pickPendingByPhase(
		graphRunId: string,
		phase: GraphRunChildPhase,
		limit: number,
	): Promise<GraphRunChildRow[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.graphRunChildren)
				.where(
					and(
						eq(this.graphRunChildren.graphRunId, graphRunId),
						eq(this.graphRunChildren.phase, phase),
						eq(this.graphRunChildren.state, "pending"),
					),
				)
				.orderBy(asc(this.graphRunChildren.seq))
				.limit(limit),
		);
	}
}
