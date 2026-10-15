import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	FLEET_REGISTRY_FILENAME,
	fleetRegistryPath,
	kernelFleetChecks,
	parseFleetRegistry,
	probeFleetHost,
} from "./checks-kernel.ts";

const HOME = "/tmp/fleet-home";
const ENV = { OPENRIG_HOME: HOME };
const REGISTRY = join(HOME, FLEET_REGISTRY_FILENAME);

/**
 * The real registry shape: two http entries, two ssh entries, and a `notes`
 * value that wraps onto a continuation line — the case a line-oriented parser
 * gets wrong.
 */
const REGISTRY_TEXT = `hosts:
  - id: headroom-aws
    transport: http
    url: http://100.112.188.99:7433
    bearer_file: /home/ubuntu/.warren/tokens/headroom-aws.token
    notes: t3.xlarge, tailnet 100.112.188.99, kernel via systemd
      openrig-kernel.service
  - id: headroom-aws-ssh
    transport: ssh
    target: 3.228.22.247
    user: ubuntu
    notes: same box as headroom-aws, ssh transport so posture has a shell
  - id: nexus-gate-http
    transport: http
    url: http://100.94.199.106:7433/
    bearer_file: /home/ubuntu/.warren/tokens/nexus-gate.token
`;

const TOKEN = "secret-token-value";

function healthBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		status: "ok",
		pid: 173_114,
		semver: "0.6.10",
		eventLoop: { healthy: true, lagP99Ms: 13.1 },
		stuckSweep: { lastOutcome: "clean" },
		...overrides,
	});
}

interface StubOptions {
	readonly health?: Readonly<Record<string, string>>;
	readonly status?: Readonly<Record<string, number>>;
	readonly reject?: Readonly<Record<string, unknown>>;
	readonly registryText?: string | Error;
	readonly tokenText?: string | Error;
}

/** A deps bundle whose I/O is entirely in memory. */
function stubs(options: StubOptions = {}) {
	const logged: { obj: object; msg?: string }[] = [];
	const readFile = async (path: string): Promise<string> => {
		if (path === REGISTRY) {
			if (options.registryText instanceof Error) throw options.registryText;
			return options.registryText ?? REGISTRY_TEXT;
		}
		if (options.tokenText instanceof Error) throw options.tokenText;
		return options.tokenText ?? TOKEN;
	};
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input);
		const failure = options.reject?.[url];
		if (failure !== undefined) throw failure;
		const status = options.status?.[url] ?? 200;
		return new Response(options.health?.[url] ?? healthBody(), {
			status,
			statusText: status === 200 ? "OK" : "Internal Server Error",
		});
	}) as unknown as typeof fetch;
	return {
		readFile,
		fetch: fetchImpl,
		logged,
		deps: {
			env: ENV,
			readFile,
			fetch: fetchImpl,
			timeoutMs: 50,
			log: { warn: (obj: object, msg?: string) => logged.push({ obj, msg }) },
		},
	};
}

const HEADROOM = "http://100.112.188.99:7433";
const NEXUS = "http://100.94.199.106:7433";

describe("parseFleetRegistry", () => {
	it("keeps dialable http hosts and drops ssh ones", () => {
		const hosts = parseFleetRegistry(REGISTRY_TEXT);
		expect(hosts.map((host) => host.id)).toEqual(["headroom-aws", "nexus-gate-http"]);
		expect(hosts[0]).toEqual({
			id: "headroom-aws",
			url: HEADROOM,
			bearerFile: "/home/ubuntu/.warren/tokens/headroom-aws.token",
		});
	});

	it("strips a trailing slash so the health path never doubles", () => {
		expect(parseFleetRegistry(REGISTRY_TEXT)[1]?.url).toBe(NEXUS);
	});

	it("drops entries missing an id, a url, or the http transport", () => {
		const hosts = parseFleetRegistry(`hosts:
  - id: no-url
    transport: http
  - transport: http
    url: http://x:1
  - id: ssh-only
    transport: ssh
    url: http://y:1
  - not-a-mapping
  - id: good
    transport: http
    url: http://z:1
`);
		expect(hosts.map((host) => host.id)).toEqual(["good"]);
		expect(hosts[0]?.bearerFile).toBeNull();
	});

	it("returns nothing for a document that is not a registry", () => {
		expect(parseFleetRegistry("")).toEqual([]);
		expect(parseFleetRegistry("hosts: 42")).toEqual([]);
		expect(parseFleetRegistry("- just\n- a\n- list\n")).toEqual([]);
	});

	it("throws for malformed YAML, which the caller turns into an informational line", () => {
		expect(() => parseFleetRegistry("hosts: [\n  unclosed")).toThrow();
	});
});

describe("probeFleetHost", () => {
	it("reports the health fields this surface renders", async () => {
		const { deps } = stubs();
		const host = parseFleetRegistry(REGISTRY_TEXT)[0];
		if (host === undefined) throw new Error("fixture");
		const probe = await probeFleetHost(host, {
			fetch: deps.fetch,
			readFile: deps.readFile,
			timeoutMs: 50,
		});
		expect(probe.ok).toBe(true);
		expect(probe.health).toEqual({
			status: "ok",
			semver: "0.6.10",
			sweep: "clean",
			loopHealthy: true,
			pid: 173_114,
		});
	});

	it("survives a peer that answers a shape it does not know", async () => {
		const { deps } = stubs({
			health: { [`${HEADROOM}/healthz`]: JSON.stringify({ hello: "world" }) },
		});
		const host = parseFleetRegistry(REGISTRY_TEXT)[0];
		if (host === undefined) throw new Error("fixture");
		const probe = await probeFleetHost(host, {
			fetch: deps.fetch,
			readFile: deps.readFile,
			timeoutMs: 50,
		});
		expect(probe.ok).toBe(true);
		expect(probe.health?.status).toBe("unknown");
		expect(probe.health?.semver).toBeNull();
	});

	it("sends the bearer from the file it names", async () => {
		const seen: Record<string, string | null> = {};
		const host = parseFleetRegistry(REGISTRY_TEXT)[0];
		if (host === undefined) throw new Error("fixture");
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.authorization = new Headers(init?.headers).get("authorization");
			return new Response(healthBody(), { status: 200 });
		}) as unknown as typeof fetch;
		await probeFleetHost(host, {
			fetch: fetchImpl,
			readFile: async () => `${TOKEN}\n`,
			timeoutMs: 50,
		});
		expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
	});
});

describe("kernelFleetChecks in doctor mode", () => {
	it("reports one check per host with the health summary", async () => {
		const { deps } = stubs();
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks.map((check) => check.name)).toEqual([
			"kernel:headroom-aws",
			"kernel:nexus-gate-http",
		]);
		expect(checks[0]).toEqual({
			name: "kernel:headroom-aws",
			ok: true,
			message: `${HEADROOM} 0.6.10 · sweep clean · loop ok · pid 173114`,
		});
	});

	it("fails the host that does not answer, and names why", async () => {
		const { deps } = stubs({ reject: { [`${HEADROOM}/healthz`]: new Error("ECONNREFUSED") } });
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks[0]?.ok).toBe(false);
		expect(checks[0]?.message).toBe(`${HEADROOM} unreachable (unreachable)`);
		expect(checks[1]?.ok).toBe(true);
	});

	it("names a timeout as a timeout, not as a refusal", async () => {
		const timeout = new Error("The operation timed out");
		timeout.name = "TimeoutError";
		const { deps } = stubs({ reject: { [`${HEADROOM}/healthz`]: timeout } });
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks[0]?.message).toContain("(timeout)");
	});

	it("reports the status code of an error response", async () => {
		const { deps } = stubs({ status: { [`${HEADROOM}/healthz`]: 500 } });
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks[0]?.ok).toBe(false);
		expect(checks[0]?.message).toContain("(http-500)");
	});

	it("fails a peer that answers ok with a non-ok status body", async () => {
		const { deps } = stubs({
			health: { [`${HEADROOM}/healthz`]: healthBody({ status: "degraded" }) },
		});
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks[0]?.ok).toBe(false);
		expect(checks[0]?.message).toContain("degraded");
	});

	it("keeps the token out of every message, and the raw url only in the log", async () => {
		const { deps, logged } = stubs({ reject: { [`${HEADROOM}/healthz`]: new Error("boom") } });
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		for (const check of checks) {
			expect(check.message ?? "").not.toContain(TOKEN);
			expect(check.hint ?? "").not.toContain(TOKEN);
		}
		expect(logged).toHaveLength(1);
		expect(JSON.stringify(logged[0]?.obj)).toContain(HEADROOM);
		expect(logged[0]?.msg).toContain("boom");
	});

	it("reports an unreadable bearer as such", async () => {
		const { deps } = stubs({ tokenText: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
		const checks = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(checks[0]?.ok).toBe(false);
		expect(checks[0]?.message).toContain("(bearer-unreadable)");
	});
});

describe("kernelFleetChecks in readyz mode", () => {
	it("summarises every host in one line that is always ok", async () => {
		const { deps } = stubs();
		const checks = await kernelFleetChecks({ ...deps, mode: "readyz" });
		expect(checks).toEqual([{ name: "kernel-fleet", ok: true, message: "2/2 reachable" }]);
	});

	it("names the hosts that are down without failing readiness", async () => {
		const { deps } = stubs({ reject: { [`${NEXUS}/healthz`]: new Error("EHOSTUNREACH") } });
		const checks = await kernelFleetChecks({ ...deps, mode: "readyz" });
		expect(checks).toHaveLength(1);
		expect(checks[0]?.ok).toBe(true);
		expect(checks[0]?.message).toBe("1/2 reachable (nexus-gate-http down)");
		expect(checks[0]?.hint).toContain("never fails this endpoint");
	});

	it("keeps tailnet addresses off the readiness wire", async () => {
		const { deps } = stubs();
		const checks = await kernelFleetChecks({ ...deps, mode: "readyz" });
		for (const check of checks) {
			expect(check.message ?? "").not.toContain("http://");
			expect(check.hint ?? "").not.toContain("100.");
		}
	});
});

describe("kernelFleetChecks with no fleet", () => {
	it("explains the absence to doctor and stays silent on readyz", async () => {
		const { deps } = stubs({
			registryText: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		});
		const doctor = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(doctor).toHaveLength(1);
		expect(doctor[0]?.ok).toBe(true);
		expect(doctor[0]?.message).toContain("no registry");
		expect(doctor[0]?.hint).toContain(REGISTRY);
		expect(await kernelFleetChecks({ ...deps, mode: "readyz" })).toEqual([]);
	});

	it("reports a registry that parses but lists no http host", async () => {
		const { deps } = stubs({
			registryText: "hosts:\n  - id: only-ssh\n    transport: ssh\n    target: 1.2.3.4\n",
		});
		const doctor = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(doctor[0]?.message).toContain("lists no http hosts");
	});

	it("reports malformed yaml instead of throwing", async () => {
		const { deps } = stubs({ registryText: "hosts: [\n  unclosed" });
		const doctor = await kernelFleetChecks({ ...deps, mode: "doctor" });
		expect(doctor[0]?.ok).toBe(true);
		expect(doctor[0]?.message).toContain("does not parse");
	});
});

describe("fleetRegistryPath", () => {
	it("follows OPENRIG_HOME, else the warren data dir", () => {
		expect(fleetRegistryPath({ OPENRIG_HOME: HOME })).toBe(REGISTRY);
		expect(fleetRegistryPath({ WARREN_DATA_DIR: "/data" })).toBe(
			join("/data/kernel", FLEET_REGISTRY_FILENAME),
		);
	});
});
