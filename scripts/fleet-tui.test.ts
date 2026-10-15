import { describe, expect, test } from "bun:test";
import { type FleetFrame, frameLines, parseRegistry, parseSeats } from "./fleet-tui.ts";

describe("parseRegistry", () => {
	test("keeps http hosts and drops ssh entries and junk", () => {
		const rows = parseRegistry(
			JSON.stringify([
				{
					id: "a",
					transport: "http",
					url: "http://10.0.0.1:7433",
					status: "reachable",
					bearer_file: "/t/a",
				},
				{ id: "a-ssh", transport: "ssh", target: "10.0.0.1" },
				{ id: "b", transport: "http", status: "reachable" },
				"nonsense",
			]),
		);
		expect(rows).toEqual([
			{ id: "a", url: "http://10.0.0.1:7433", status: "reachable", bearerFile: "/t/a" },
		]);
	});

	test("an unreadable registry is an empty fleet, never a throw", () => {
		expect(parseRegistry("not json")).toEqual([]);
	});
});

describe("parseSeats", () => {
	test("reads the seat fields the table shows", () => {
		const seats = parseSeats(
			JSON.stringify([
				{
					rigName: "boxdemo",
					canonicalSessionName: "ops-shell@boxdemo",
					runtime: "terminal",
					lifecycleState: "running",
					agentActivity: { state: "unknown" },
					assignedWorkCount: 0,
				},
			]),
		);
		expect(seats).toEqual([
			{
				rig: "boxdemo",
				session: "ops-shell@boxdemo",
				runtime: "terminal",
				lifecycle: "running",
				activity: "unknown",
				work: false,
			},
		]);
	});

	test("a seat with assigned work is marked", () => {
		const seats = parseSeats(JSON.stringify([{ rigName: "r", hasAssignedWork: true }]));
		expect(seats[0]?.work).toBe(true);
	});

	test("a broken payload yields no seats", () => {
		expect(parseSeats("[]")).toEqual([]);
		expect(parseSeats("{")).toEqual([]);
	});
});

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
const strip = (text: string): string => text.replace(ANSI, "");

describe("frameLines", () => {
	const frame: FleetFrame = {
		at: "12:00:00",
		selected: 0,
		hosts: [
			{
				id: "headroom-aws",
				url: "http://10.0.0.1:7433",
				status: "reachable",
				health: "ok · sweep clean · loop ok · 0.6.10",
				rigs: [
					{
						rig: "boxdemo",
						session: "ops-shell@boxdemo",
						runtime: "terminal",
						lifecycle: "running",
						activity: "unknown",
						work: false,
					},
				],
			},
			{
				id: "mt5-wine-http",
				url: "http://10.0.0.2:7433",
				status: "reachable",
				health: "unreachable: timeout",
				rigs: [],
			},
		],
	};

	test("shows every host, the selected host's health and its seats", () => {
		const text = strip(frameLines(frame, 120, 40).join("\n"));
		expect(text).toContain("headroom-aws");
		expect(text).toContain("mt5-wine-http");
		expect(text).toContain("1/2 kernels ok");
		expect(text).toContain("ops-shell@boxdemo");
		expect(text).toContain("http://10.0.0.1:7433");
	});

	test("a host with no seats says so instead of showing a stale row", () => {
		const text = strip(frameLines({ ...frame, selected: 1 }, 120, 40).join("\n"));
		expect(text).toContain("no seats");
		expect(text).not.toContain("ops-shell@boxdemo");
	});

	test("an empty registry explains how to add a host", () => {
		const text = strip(frameLines({ at: "12:00:00", hosts: [], selected: 0 }, 120, 40).join("\n"));
		expect(text).toContain("no http hosts registered");
		expect(text).toContain("rig host add");
	});

	test("marks the selected host so the keyboard has a cursor", () => {
		const text = strip(frameLines(frame, 120, 40).join("\n"));
		expect(text).toContain("▶ ● headroom-aws");
		// With the second host selected the marker moves and the first row loses it.
		const moved = strip(frameLines({ ...frame, selected: 1 }, 120, 40).join("\n"));
		expect(moved).toContain("▶ ● mt5-wine-http");
		expect(moved).toContain("  ● headroom-aws");
	});
});
