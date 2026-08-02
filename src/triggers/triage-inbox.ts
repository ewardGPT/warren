import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TriageSource = "ci" | "issue" | "commit";
export type TriageFindingStatus = "open" | "triaged" | "archived";

export interface TriageFinding {
	readonly key: string;
	readonly source: TriageSource;
	readonly title: string;
	readonly detail?: string;
	readonly url?: string;
	readonly severity?: "critical" | "high" | "medium" | "low";
	readonly discoveredAt: string;
	readonly status: TriageFindingStatus;
}

export interface TriageInboxState {
	readonly version: 1;
	readonly updatedAt: string;
	readonly findings: readonly TriageFinding[];
	readonly archivedEmptyRuns: readonly { readonly runId: string; readonly archivedAt: string }[];
}

export interface TriageInboxFs {
	readonly readFile: (path: string) => Promise<string | null>;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
}

export interface TriageMergeResult {
	readonly state: TriageInboxState;
	readonly added: number;
	readonly updated: number;
	readonly archivedEmpty: boolean;
}

export interface TriageCollectorInput {
	readonly projectId: string;
	readonly projectPath: string;
	readonly now: Date;
}

export type TriageCollector = (input: TriageCollectorInput) => Promise<readonly TriageFinding[]>;

export interface TriagePassInput extends TriageCollectorInput {
	readonly collect: TriageCollector;
	readonly fs?: TriageInboxFs;
}

export const DEFAULT_TRIAGE_INBOX_PATH = ".warren/triage-inbox.json";

/** Merge one collector pass without reviving findings an operator triaged. */
export function mergeTriageFindings(
	current: TriageInboxState,
	incoming: readonly TriageFinding[],
	input: { readonly now: Date; readonly runId: string },
): TriageMergeResult {
	const byKey = new Map(current.findings.map((finding) => [finding.key, finding]));
	let added = 0;
	let updated = 0;
	for (const finding of incoming) {
		const prior = byKey.get(finding.key);
		if (prior === undefined) {
			byKey.set(finding.key, { ...finding, status: "open" });
			added += 1;
			continue;
		}
		if (prior.status === "triaged" || prior.status === "archived") continue;
		byKey.set(finding.key, { ...prior, ...finding, status: "open" });
		updated += 1;
	}
	const archivedEmpty = incoming.length === 0;
	return {
		state: {
			version: 1,
			updatedAt: input.now.toISOString(),
			findings: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
			archivedEmptyRuns: archivedEmpty
				? [
						...current.archivedEmptyRuns,
						{ runId: input.runId, archivedAt: input.now.toISOString() },
					].slice(-100)
				: current.archivedEmptyRuns,
		},
		added,
		updated,
		archivedEmpty,
	};
}

export function emptyTriageInbox(now = new Date()): TriageInboxState {
	return { version: 1, updatedAt: now.toISOString(), findings: [], archivedEmptyRuns: [] };
}

export async function loadTriageInbox(
	path: string = DEFAULT_TRIAGE_INBOX_PATH,
	fs: TriageInboxFs = defaultTriageInboxFs,
): Promise<TriageInboxState> {
	const raw = await fs.readFile(path);
	if (raw === null) return emptyTriageInbox();
	try {
		const parsed = JSON.parse(raw) as Partial<TriageInboxState>;
		if (
			parsed.version !== 1 ||
			!Array.isArray(parsed.findings) ||
			!Array.isArray(parsed.archivedEmptyRuns)
		) {
			return emptyTriageInbox();
		}
		return parsed as TriageInboxState;
	} catch {
		return emptyTriageInbox();
	}
}

export async function saveTriageInbox(
	state: TriageInboxState,
	path: string = DEFAULT_TRIAGE_INBOX_PATH,
	fs: TriageInboxFs = defaultTriageInboxFs,
): Promise<void> {
	await fs.writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Run one collector pass and persist its merge for a project. */
export async function runTriageInboxPass(input: TriagePassInput): Promise<TriageMergeResult> {
	const fs = input.fs ?? defaultTriageInboxFs;
	const path = join(input.projectPath, DEFAULT_TRIAGE_INBOX_PATH);
	const current = await loadTriageInbox(path, fs);
	const incoming = await input.collect(input);
	const result = mergeTriageFindings(current, incoming, {
		now: input.now,
		runId: `triage-${input.projectId}-${input.now.getTime()}`,
	});
	await saveTriageInbox(result.state, path, fs);
	return result;
}

const defaultTriageInboxFs: TriageInboxFs = {
	readFile: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) return null;
			throw error;
		}
	},
	writeFile: async (path, contents) => {
		await writeFile(path, contents, "utf8");
	},
};

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
	);
}
