/**
 * HTTP client for the kernel daemon's own API.
 *
 * Same bearer token the child was handed as `OPENRIG_AUTH_BEARER_TOKEN`, read
 * back from the 0600 `KernelPaths.tokenFile` — so a caller in a later process
 * (a CLI verb, a healer pass) gets the same authority the daemon expects
 * without the token ever riding an env var of its own. Every request carries
 * `Authorization: Bearer <token>`, and every request is bounded by a timeout
 * so a wedged kernel rejects instead of hanging the caller.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KERNEL_TOKEN_FILENAME, KernelError } from "./paths.ts";
import type { KernelStatus } from "./status.ts";

export const DEFAULT_KERNEL_CLIENT_TIMEOUT_MS = 5_000;

export interface KernelClientDeps {
	readonly fetch?: typeof fetch;
	/** Token-file reader; `null` when unreadable. */
	readonly readFile?: (path: string) => Promise<string | null>;
	/** Inject the token directly (tests / callers that already hold it). */
	readonly token?: string;
	readonly timeoutMs?: number;
	/** Run the abort callback after `ms`, returning a canceller. */
	readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface KernelClient {
	get<T>(path: string): Promise<T>;
	post<T>(path: string, body: unknown): Promise<T>;
	/** Base URL, without a trailing slash. */
	readonly url: string;
}

/**
 * Build a client for a resolved kernel status. The token is resolved per
 * request (files rotate, and a caller may construct the client before the
 * kernel's first start has written the file) and a missing token is a hard
 * error — an unauthenticated request to a token-guarded route is a 401 the
 * caller cannot act on, so say why up front instead.
 */
export function kernelClient(status: KernelStatus, deps: KernelClientDeps = {}): KernelClient {
	const url = status.url.replace(/\/+$/, "");
	const fetchFn = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_KERNEL_CLIENT_TIMEOUT_MS;
	const schedule =
		deps.schedule ??
		((fn: () => void, ms: number) => {
			const handle = setTimeout(fn, ms);
			return () => clearTimeout(handle);
		});
	const readToken =
		deps.readFile ??
		(async (path: string) => {
			try {
				return await readFile(path, "utf8");
			} catch {
				return null;
			}
		});

	async function token(): Promise<string> {
		if (deps.token !== undefined && deps.token !== "") return deps.token;
		const path = join(status.home, KERNEL_TOKEN_FILENAME);
		const content = (await readToken(path))?.trim();
		if (content === undefined || content === "") {
			throw new KernelError(
				`kernel token file is missing or empty: ${path}`,
				"The token is written by kernelStart(); run the kernel first, or pass a token explicitly",
			);
		}
		return content;
	}

	async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		const bearer = await token();
		const controller = new AbortController();
		let timedOut = false;
		const cancel = schedule(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		try {
			const response = await fetchFn(
				`${url}${path}`,
				buildInit(method, bearer, body, controller.signal),
			);
			if (!response.ok) {
				throw new KernelError(
					`kernel ${method} ${path} failed: HTTP ${response.status} ${response.statusText}`.trim(),
				);
			}
			return (await response.json()) as T;
		} catch (error) {
			throw requestFailure(error, { method, path, timedOut, timeoutMs });
		} finally {
			cancel();
		}
	}

	return {
		url,
		get: <T>(path: string) => request<T>("GET", path),
		post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
	};
}

/** The request init: a bearer header always, a JSON body only when there is one. */
function buildInit(
	method: string,
	bearer: string,
	body: unknown,
	signal: AbortSignal,
): RequestInit {
	const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
	const init: RequestInit = { method, headers, signal };
	if (body !== undefined) {
		headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	return init;
}

/**
 * One failure, described once: a deadline we set is a timeout rather than a
 * transport error, a `KernelError` already carries its own message, and anything
 * else is wrapped so no raw fetch error escapes this module.
 */
function requestFailure(
	error: unknown,
	where: { method: string; path: string; timedOut: boolean; timeoutMs: number },
): KernelError {
	if (where.timedOut) {
		return new KernelError(
			`kernel ${where.method} ${where.path} timed out after ${where.timeoutMs}ms`,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (error instanceof KernelError) return error;
	return new KernelError(
		`kernel ${where.method} ${where.path} failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}
