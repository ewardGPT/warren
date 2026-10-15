/**
 * The fleet's box list: which remote burrow endpoints warren may dispatch runs
 * to, and the bearer each one needs.
 *
 * The file is warren-owned (`fleet.yaml`) rather than the kernel's `hosts.yaml`,
 * because the two registries answer different questions. `hosts.yaml` is the
 * kernel CLI's connection list — it carries ssh entries for posture and http
 * entries for the daemon, and the CLI rewrites it. This list is only "where can
 * a run execute", one entry per box, and warren is its only writer. Reading the
 * kernel's file here would couple run placement to a file another tool edits.
 *
 * Default location: `<kernel home>/fleet.yaml`, so a checkout that already has
 * `OPENRIG_HOME` set needs no new variable. `WARREN_FLEET_CONFIG` overrides it.
 *
 * Shape (every entry validated, a bad one is REPORTED not swallowed):
 *
 *   boxes:
 *     - id: headroom-aws
 *       url: http://100.112.188.99:7455
 *       token_file: /home/ubuntu/.warren/tokens/burrow-headroom-aws.token
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "@os-eco/burrow-cli";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { kernelPaths } from "../../../kernel/paths.ts";
import type { EnvLike } from "../../../runs/spawn/callback-env.ts";
import { FleetConfigError } from "./errors.ts";

export const FLEET_CONFIG_FILENAME = "fleet.yaml";

/** One box: where it answers, and which secret unlocks it. */
export interface FleetBox {
	readonly id: string;
	readonly url: string;
	readonly tokenFile: string;
}

/** A box resolved for use: transport + the token read off disk. */
export interface FleetEndpoint {
	readonly id: string;
	readonly transport: Transport;
	readonly token: string;
}

export interface ParsedFleetConfig {
	readonly boxes: readonly FleetBox[];
	/** Rows the shape rejected, with the reason — logged, never silent. */
	readonly invalid: readonly { readonly id: string; readonly reason: string }[];
}

export type ReadTextFn = (path: string) => string;

export interface LoadFleetDeps {
	readonly env: EnvLike;
	/** Defaults to `readFileSync`. Injected by tests. */
	readonly readFile?: ReadTextFn;
}

export interface LoadedFleet {
	readonly endpoints: readonly FleetEndpoint[];
	readonly invalid: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Read the config and resolve each box to a transport + token. Synchronous on
 * purpose: this runs once at BOOT (`resolveRuntimeProvider` is documented as the
 * single boot composition point), and a fleet that cannot be read must fail
 * there rather than drift into a state where every dispatch dies.
 *
 * A box whose token file is missing or empty is reported as invalid:
 * dispatching to it would fail later with a 401, and boot is the useful moment
 * to say so. Only when NO box survives does this throw.
 */
export function loadFleetEndpoints(deps: LoadFleetDeps): LoadedFleet {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const path = fleetConfigPath(deps.env);
	let text: string;
	try {
		text = readFile(path);
	} catch (error) {
		throw new FleetConfigError(`no fleet config at ${path} (${describe(error)})`, {
			recoveryHint: `write ${path} with one box per entry, or set WARREN_FLEET_CONFIG`,
		});
	}
	const { boxes, invalid } = parseFleetConfig(text);
	const endpoints: FleetEndpoint[] = [];
	const rejected = [...invalid];
	for (const box of boxes) {
		let token: string;
		try {
			token = readFile(box.tokenFile).trim();
		} catch (error) {
			rejected.push({ id: box.id, reason: `token_file unreadable: ${describe(error)}` });
			continue;
		}
		if (token === "") {
			rejected.push({ id: box.id, reason: "token_file is empty" });
			continue;
		}
		endpoints.push({ id: box.id, transport: parseBurrowUrl(box.url), token });
	}
	if (endpoints.length === 0) {
		throw new FleetConfigError(`${path} lists no usable box`, {
			recoveryHint: `every entry needs an id, an http url and a readable token_file; rejected: ${rejected
				.map((row) => `${row.id} (${row.reason})`)
				.join(", ")}`,
		});
	}
	return { endpoints, invalid: rejected };
}

const BoxSchema = z.object({
	id: z.string().min(1),
	url: z.string().min(1),
	token_file: z.string().min(1),
});
const ConfigSchema = z.object({ boxes: z.array(z.unknown()).optional() });

/** `<kernel home>/fleet.yaml`, overridable with `WARREN_FLEET_CONFIG`. */
export function fleetConfigPath(env: EnvLike): string {
	const override = env.WARREN_FLEET_CONFIG;
	if (override !== undefined && override !== "") return override;
	return join(kernelPaths(env).home, FLEET_CONFIG_FILENAME);
}

/** `http://host:port` → a TCP transport. Anything else is rejected with a reason. */
export function parseBurrowUrl(url: string): Transport {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new FleetConfigError(`not a URL: ${url}`);
	}
	if (parsed.protocol !== "http:") {
		throw new FleetConfigError(`only http:// endpoints are supported (got ${parsed.protocol}//)`);
	}
	const port = parsed.port === "" ? 80 : Number.parseInt(parsed.port, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new FleetConfigError(`bad port in ${url}`);
	}
	return { kind: "tcp", hostname: parsed.hostname, port };
}

/**
 * Parse the document. Total: a malformed document, a missing `boxes` list or a
 * bad row yields an `invalid` entry rather than a throw, so one typo cannot
 * take the whole fleet offline — but it is never silently ignored either.
 */
export function parseFleetConfig(text: string): ParsedFleetConfig {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new FleetConfigError(`fleet config is not valid YAML: ${describe(error)}`);
	}
	const document = ConfigSchema.safeParse(parsed);
	if (!document.success) {
		throw new FleetConfigError("fleet config must be a mapping with a `boxes` list");
	}
	const boxes: FleetBox[] = [];
	const invalid: { id: string; reason: string }[] = [];
	const seen = new Set<string>();
	for (const row of document.data.boxes ?? []) {
		const entry = BoxSchema.safeParse(row);
		if (!entry.success) {
			invalid.push({ id: describeRow(row), reason: "needs id, url and token_file" });
			continue;
		}
		const { id, url, token_file: tokenFile } = entry.data;
		if (!BOX_ID_PATTERN.test(id)) {
			invalid.push({ id, reason: "id must match [a-z0-9][a-z0-9-]*" });
			continue;
		}
		if (seen.has(id)) {
			invalid.push({ id, reason: "duplicate id" });
			continue;
		}
		try {
			parseBurrowUrl(url);
		} catch (error) {
			invalid.push({ id, reason: describe(error) });
			continue;
		}
		seen.add(id);
		boxes.push({ id, url, tokenFile });
	}
	return { boxes, invalid };
}

export interface LoadedFleet {
	readonly endpoints: readonly FleetEndpoint[];
	readonly invalid: readonly { readonly id: string; readonly reason: string }[];
}

/** Box ids are registry ids: lowercase, dashes, no slash (the handle separator). */
const BOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function describeRow(row: unknown): string {
	if (typeof row === "object" && row !== null && "id" in row) {
		const id = (row as { id?: unknown }).id;
		if (typeof id === "string") return id;
	}
	return "<unnamed>";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
