import { describe, expect, test } from "bun:test";
import { KernelError, kernelDataDir, kernelPaths } from "./paths.ts";

describe("kernelPaths", () => {
	test("isolates kernel state and HOME by default", () => {
		const paths = kernelPaths({});
		expect(paths.home).toBe("/data/kernel");
		expect(paths.privateHome).toBe("/data/kernel/home");
		expect(paths.tokenFile).toBe("/data/kernel/kernel-token");
		expect(paths.logFile).toBe("/data/kernel/kernel.log");
		expect(paths.pidFile).toBe("/data/kernel/kernel.pid");
		expect(paths.url).toBe("http://127.0.0.1:7433");
		expect(paths.host).toBe("127.0.0.1");
		expect(paths.port).toBe(7433);
		// Never the operator's own OpenRig install.
		expect(paths.home).not.toContain(".openrig");
	});

	test("derives the kernel home from the warren data dir", () => {
		expect(kernelPaths({ WARREN_DATA_DIR: "/var/lib/warren" }).home).toBe("/var/lib/warren/kernel");
		expect(kernelDataDir({ WARREN_DATA_DIR: "/srv/x" })).toBe("/srv/x");
		// An empty value means "not configured" everywhere in warren.
		expect(kernelDataDir({ WARREN_DATA_DIR: "" })).toBe("/data");
		expect(kernelPaths({ WARREN_DATA_DIR: "" }).home).toBe("/data/kernel");
	});

	test("an explicit OPENRIG_HOME wins over the data dir", () => {
		const paths = kernelPaths({ OPENRIG_HOME: "/tmp/kh", WARREN_DATA_DIR: "/data" });
		expect(paths.home).toBe("/tmp/kh");
		expect(paths.privateHome).toBe("/tmp/kh/home");
		expect(paths.tokenFile).toBe("/tmp/kh/kernel-token");
	});

	test("honours the bind env, dialing loopback for a non-dialable bind", () => {
		const wildcard = kernelPaths({ OPENRIG_BIND_HOST: "0.0.0.0", OPENRIG_PORT: "7555" });
		expect(wildcard.url).toBe("http://127.0.0.1:7555");
		// The child still binds what the operator asked for.
		expect(wildcard.host).toBe("0.0.0.0");
		expect(wildcard.port).toBe(7555);
		expect(kernelPaths({ OPENRIG_BIND_HOST: "::1" }).url).toBe("http://[::1]:7433");
		expect(kernelPaths({ OPENRIG_BIND_HOST: "10.0.0.5", OPENRIG_PORT: "9000" }).url).toBe(
			"http://10.0.0.5:9000",
		);
	});

	test("rejects a nonsense port instead of guessing", () => {
		expect(() => kernelPaths({ OPENRIG_PORT: "http" })).toThrow(KernelError);
		expect(() => kernelPaths({ OPENRIG_PORT: "7433x" })).toThrow(/OPENRIG_PORT must be an integer/);
		expect(() => kernelPaths({ OPENRIG_PORT: "0" })).toThrow(KernelError);
	});
});
