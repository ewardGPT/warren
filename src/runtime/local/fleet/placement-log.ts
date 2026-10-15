/**
 * A shared record of which box took the last runs, so separate warren processes
 * rotate boxes instead of stacking on one.
 *
 * WHY A FILE
 *   Load is read from the box's health probe, and a finished run leaves no
 *   residue: the burrow is destroyed, so the box reports zero live workspaces
 *   again. Two dispatches from two warren processes therefore both see "every
 *   box idle" and both pick the same box, because the id tie-break is stable.
 *   The in-flight ledger cannot help, since it lives in one process.
 *
 *   This log is append-only JSON Lines, so a write is a single small append and
 *   needs no lock. A torn or unreadable log costs at most one placement
 *   decision, never a dispatch: every failure here is swallowed.
 *
 * Entries older than the window are ignored, so a box used yesterday is not
 * penalised today. The file is compacted once it grows past a threshold.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export interface PlacementLogOptions {
	/** Where the entries live. */
	readonly path: string;
	/** How long a placement counts as recent. Default 15 minutes. */
	readonly windowMs?: number;
	/** Compact the file once it holds more than this many lines. Default 500. */
	readonly compactAfter?: number;
	/** Clock, for tests. */
	readonly now?: () => number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_COMPACT_AFTER = 500;

interface Entry {
	readonly box: string;
	readonly ts: number;
}

export class PlacementLog {
	private readonly path: string;
	private readonly windowMs: number;
	private readonly compactAfter: number;
	private readonly now: () => number;

	constructor(options: PlacementLogOptions) {
		this.path = options.path;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.compactAfter = options.compactAfter ?? DEFAULT_COMPACT_AFTER;
		this.now = options.now ?? Date.now;
	}

	/** Record that `boxId` just took a run. Never throws. */
	record(boxId: string): void {
		try {
			appendFileSync(this.path, `${JSON.stringify({ box: boxId, ts: this.now() })}\n`, {
				mode: 0o600,
			});
			this.compactIfLarge();
		} catch {
			// A placement must not fail because its log is unwritable.
		}
	}

	/**
	 * The newest placement time per box, within the window. A box with no entry
	 * in the window is absent, which placement reads as "never used".
	 */
	lastPlaced(): Map<string, number> {
		const out = new Map<string, number>();
		const cutoff = this.now() - this.windowMs;
		for (const entry of this.read()) {
			if (entry.ts < cutoff) continue;
			const seen = out.get(entry.box);
			if (seen === undefined || entry.ts > seen) out.set(entry.box, entry.ts);
		}
		return out;
	}

	private read(): Entry[] {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch {
			return [];
		}
		const entries: Entry[] = [];
		for (const line of text.split("\n")) {
			if (line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			const box = (parsed as { box?: unknown }).box;
			const ts = (parsed as { ts?: unknown }).ts;
			if (typeof box !== "string" || typeof ts !== "number") continue;
			entries.push({ box, ts });
		}
		return entries;
	}

	/** Keep only the entries inside the window once the file grows too long. */
	private compactIfLarge(): void {
		const entries = this.read();
		if (entries.length <= this.compactAfter) return;
		const cutoff = this.now() - this.windowMs;
		const kept = entries.filter((entry) => entry.ts >= cutoff);
		try {
			writeFileSync(this.path, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
				mode: 0o600,
			});
		} catch {
			// Compaction is best effort.
		}
	}
}
