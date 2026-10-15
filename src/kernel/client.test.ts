import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_KERNEL_CLIENT_TIMEOUT_MS, kernelClient } from "./client.ts";
import { KernelError } from "./paths.ts";
import type { KernelStatus } from "./status.ts";

const HOME = "/data/kernel";
const TOKEN_FILE = join(HOME, "kernel-token");

function running(overrides: Partial<KernelStatus> = {}): KernelStatus {
	return { state: "running", url: "http://127.0.0.1:7433", home: HOME, ...overrides };
}

interface FetchCall {
	readonly url: string;
	readonly method: string | undefined;
	readonly headers: Record<string, string>;
	readonly body: string | undefined;
	readonly signal: AbortSignal | null | undefined;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("kernelClient", () => {
	test("sends the bearer token on GET and returns the parsed body", async () => {
		const calls: FetchCall[] = [];
		const client = kernelClient(running(), {
			token: "deadbeef",
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					headers: (init?.headers ?? {}) as Record<string, string>,
					body: init?.body as string | undefined,
					signal: init?.signal,
				});
				return jsonResponse({ ok: true, seats: 2 });
			}) as unknown as typeof fetch,
		});
		const body = await client.get<{ ok: boolean; seats: number }>("/api/ps");
		expect(body).toEqual({ ok: true, seats: 2 });
		expect(calls[0]?.url).toBe("http://127.0.0.1:7433/api/ps");
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers.Authorization).toBe("Bearer deadbeef");
		expect(calls[0]?.body).toBeUndefined();
		// Every request is bounded: the injected signal is live, not aborted.
		expect(calls[0]?.signal?.aborted).toBe(false);
		expect(client.url).toBe("http://127.0.0.1:7433");
	});

	test("reads the token from the kernel home when none is injected", async () => {
		let authorization: string | undefined;
		const client = kernelClient(running({ url: "http://127.0.0.1:7433/" }), {
			readFile: async (path) => (path === TOKEN_FILE ? "file-token\n" : null),
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				authorization = (init?.headers as Record<string, string>).Authorization;
				return jsonResponse({ status: "ok" });
			}) as unknown as typeof fetch,
		});
		await client.get("/healthz");
		expect(authorization).toBe("Bearer file-token");
	});

	test("refuses to send an unauthenticated request", async () => {
		let called = false;
		const client = kernelClient(running(), {
			readFile: async () => null,
			fetch: (async () => {
				called = true;
				return jsonResponse({});
			}) as unknown as typeof fetch,
		});
		await expect(client.get("/api/ps")).rejects.toThrow(/token file is missing/);
		expect(called).toBe(false);
	});

	test("POST sends the JSON body with a content-type", async () => {
		const calls: FetchCall[] = [];
		const client = kernelClient(running(), {
			token: "t",
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					headers: (init?.headers ?? {}) as Record<string, string>,
					body: init?.body as string | undefined,
					signal: init?.signal,
				});
				return jsonResponse({ accepted: true }, 202);
			}) as unknown as typeof fetch,
		});
		const body = await client.post<{ accepted: boolean }>("/api/launch", { seats: 1 });
		expect(body).toEqual({ accepted: true });
		const seen = calls[0];
		expect(seen?.method).toBe("POST");
		expect(seen?.headers["content-type"]).toBe("application/json");
		expect(seen?.body).toBe(JSON.stringify({ seats: 1 }));
	});

	test("surfaces a non-2xx response as a kernel error", async () => {
		const client = kernelClient(running(), {
			token: "t",
			fetch: (async () =>
				new Response("nope", {
					status: 503,
					statusText: "Service Unavailable",
				})) as unknown as typeof fetch,
		});
		await expect(client.get("/api/ps")).rejects.toThrow(/HTTP 503/);
	});

	test("times out instead of hanging on a wedged kernel", async () => {
		let aborted = false;
		const observed: AbortSignal[] = [];
		const client = kernelClient(running(), {
			token: "t",
			timeoutMs: 25,
			// Fire the timeout immediately: the clock is a seam, not a wait.
			schedule: (fn) => {
				fn();
				return () => {};
			},
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				const signal = init?.signal ?? null;
				if (signal !== null) observed.push(signal);
				const { promise, reject } = Promise.withResolvers<Response>();
				const abort = () => {
					aborted = true;
					reject(new Error("The operation was aborted"));
				};
				// The timeout may already have fired before the call.
				if (signal?.aborted === true) abort();
				else signal?.addEventListener("abort", abort);
				return promise;
			}) as unknown as typeof fetch,
		});
		await expect(client.get("/api/ps")).rejects.toThrow(/timed out after 25ms/);
		expect(aborted).toBe(true);
		expect(observed[0]?.aborted).toBe(true);
	});

	test("defaults the timeout to a bounded value", () => {
		expect(DEFAULT_KERNEL_CLIENT_TIMEOUT_MS).toBe(5_000);
	});

	test("a missing token is a KernelError with a recovery hint", async () => {
		const client = kernelClient(running(), { readFile: async () => null });
		const error = await client.get("/api/ps").catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(KernelError);
		expect((error as KernelError).detail).toContain("kernelStart()");
	});
});
