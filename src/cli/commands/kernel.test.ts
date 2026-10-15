import { describe, expect, test } from "bun:test";
import type { KernelStatus } from "../../kernel/index.ts";
import { kernelReport } from "./kernel.ts";

const status = (overrides: Partial<KernelStatus>): KernelStatus => ({
	state: "running",
	url: "http://127.0.0.1:7433",
	home: "/tmp/kernel",
	...overrides,
});

describe("kernelReport", () => {
	test("a running kernel is healthy for every action", () => {
		for (const action of ["status", "start", "stop", "doctor"] as const) {
			expect(kernelReport(action, status({ pid: 42, version: "0.6.10" })).exitCode).toBe(0);
		}
		expect(kernelReport("status", status({ pid: 42, version: "0.6.10" })).lines[0]).toBe(
			"kernel: state running, pid 42, version 0.6.10",
		);
	});

	test("a stopped kernel is an answer for status and a success for stop", () => {
		expect(kernelReport("status", status({ state: "stopped" })).exitCode).toBe(3);
		expect(kernelReport("stop", status({ state: "stopped" })).exitCode).toBe(0);
		expect(kernelReport("start", status({ state: "stopped" })).exitCode).toBe(1);
		expect(kernelReport("doctor", status({ state: "stopped" })).exitCode).toBe(1);
	});

	test("unhealthy and failed are never success", () => {
		for (const state of ["unhealthy", "failed", "starting"] as const) {
			expect(kernelReport("status", status({ state })).exitCode).toBe(1);
		}
	});

	test("the detail is carried into the line, so a failure explains itself", () => {
		const report = kernelReport(
			"start",
			status({ state: "failed", detail: "child exited on 137" }),
		);
		expect(report.lines[0]).toContain("child exited on 137");
		expect(report.lines[1]).toContain("url http://127.0.0.1:7433");
		expect(report.lines[2]).toContain("home /tmp/kernel");
	});
});
