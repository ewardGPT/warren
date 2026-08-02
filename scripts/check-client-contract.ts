#!/usr/bin/env bun
/**
 * Check that request paths issued by the UI API client exist in the server's
 * generated OpenAPI route surface (warren-4d2d).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const ROOT = resolve(import.meta.dir, "..");
const CLIENT_PATH = resolve(ROOT, "src/ui/src/api/client.ts");
const OPENAPI_PATH = resolve(ROOT, "docs/openapi.yaml");

export interface ClientRequest {
	readonly method: string;
	readonly path: string;
	readonly source: string;
}

interface OpenApiDocument {
	readonly paths?: Record<string, Record<string, unknown>>;
}

function skipBalanced(source: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let i = start; i < source.length; i += 1) {
		const char = source[i];
		if (char === '"' || char === "'" || char === "`") {
			i = skipQuoted(source, i, char) - 1;
			continue;
		}
		if (char === open) depth += 1;
		if (char === close) {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
	}
	return source.length;
}

function skipTemplate(source: string, start: number): number {
	for (let i = start + 1; i < source.length; i += 1) {
		if (source[i] === "\\") {
			i += 1;
			continue;
		}
		if (source[i] === "$" && source[i + 1] === "{") {
			i = skipBalanced(source, i + 1, "{", "}") - 1;
			continue;
		}
		if (source[i] === "`") return i + 1;
	}
	return source.length;
}

function skipQuoted(source: string, start: number, quote: string): number {
	if (quote === "`") return skipTemplate(source, start);
	let i = start + 1;
	while (i < source.length) {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === quote) return i + 1;
		i += 1;
	}
	return source.length;
}

function findCallEnd(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		const char = source[i];
		if (char === '"' || char === "'" || char === "`") {
			i = skipQuoted(source, i, char) - 1;
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return source.length;
}

function firstArgument(call: string): string {
	let depth = 0;
	for (let i = 1; i < call.length; i += 1) {
		const char = call[i];
		if (char === undefined) continue;
		if (char === '"' || char === "'" || char === "`") {
			i = skipQuoted(call, i, char) - 1;
			continue;
		}
		if ("([{<".includes(char)) depth += 1;
		if (")]} >".replace(" ", "").includes(char)) depth -= 1;
		if (char === "," && depth === 0) return call.slice(1, i).trim();
	}
	return call.slice(1, -1).trim();
}

function normalizePathExpression(expression: string): string | null {
	const trimmed = expression.trim();
	if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
		return trimmed.slice(1, -1).split("?")[0] ?? null;
	}
	if (!trimmed.startsWith("`")) return null;
	let path = trimmed.slice(1, -1);
	let normalized = "";
	for (let i = 0; i < path.length; i += 1) {
		if (path[i] !== "$" || path[i + 1] !== "{") {
			normalized += path[i];
			continue;
		}
		const end = skipBalanced(path, i + 1, "{", "}");
		const body = path.slice(i + 2, end - 1);
		if (!/query|qs|search/i.test(body)) {
			const encoded = body.match(/encodeURIComponent\((\w+)\)/);
			normalized += encoded?.[1] === undefined ? ":param" : `:${encoded[1]}`;
		}
		i = end - 1;
	}
	path = normalized;
	return path.split("?")[0] ?? null;
}

export function extractClientRequests(source: string): ClientRequest[] {
	const requests: ClientRequest[] = [];
	const callStart = /\brequest(?:<[^;()]*?>)?\s*\(/g;
	for (const match of source.matchAll(callStart)) {
		const open = (match.index ?? 0) + match[0].lastIndexOf("(");
		const end = findCallEnd(source, open);
		const call = source.slice(open, end + 1);
		const path = normalizePathExpression(firstArgument(call));
		if (path === null) continue;
		const method = call.match(/\bmethod\s*:\s*["']([A-Za-z]+)["']/)?.[1] ?? "GET";
		requests.push({ method: method.toUpperCase(), path, source: call });
	}
	return requests;
}

function segments(path: string): string[] {
	return path.split("?")[0]?.split("/").filter(Boolean) ?? [];
}

function routeMatches(clientPath: string, openApiPath: string): boolean {
	const client = segments(clientPath);
	const server = segments(openApiPath);
	return (
		client.length === server.length &&
		client.every((segment, index) => {
			const serverSegment = server[index];
			return (
				serverSegment !== undefined && (serverSegment.startsWith("{") || segment === serverSegment)
			);
		})
	);
}

export function findContractViolations(
	clientSource: string,
	openApiSource: string,
): ClientRequest[] {
	const document = load(openApiSource) as OpenApiDocument;
	const paths = document.paths ?? {};
	const requests = extractClientRequests(clientSource);
	return requests.filter(
		(request) =>
			!Object.entries(paths).some(([path, operations]) =>
				Object.keys(operations).some(
					(method) => method.toUpperCase() === request.method && routeMatches(request.path, path),
				),
			),
	);
}

export function checkClientContract(
	clientSource = readFileSync(CLIENT_PATH, "utf8"),
	openApiSource = readFileSync(OPENAPI_PATH, "utf8"),
): void {
	const violations = findContractViolations(clientSource, openApiSource);
	if (violations.length > 0) {
		throw new Error(
			violations
				.map(({ method, path }) => `UI client request has no server route: ${method} ${path}`)
				.join("\n"),
		);
	}
}

if (import.meta.main) {
	checkClientContract();
	console.log(
		`client contract ok (${extractClientRequests(readFileSync(CLIENT_PATH, "utf8")).length} requests)`,
	);
}
