import { describe, expect, it } from "bun:test";
import { fleetConfigPath, loadFleetEndpoints, parseBurrowUrl, parseFleetConfig } from "./config.ts";
import { FleetConfigError } from "./errors.ts";

describe("parseBurrowUrl", () => {
	it("parses an http url with an explicit port", () => {
		expect(parseBurrowUrl("http://100.112.188.99:7455")).toEqual({
			kind: "tcp",
			hostname: "100.112.188.99",
			port: 7455,
		});
	});

	it("defaults the port to 80 when the url omits one", () => {
		expect(parseBurrowUrl("http://box.example")).toEqual({
			kind: "tcp",
			hostname: "box.example",
			port: 80,
		});
	});

	it("rejects a non-http scheme", () => {
		expect(() => parseBurrowUrl("https://box.example:1234")).toThrow(FleetConfigError);
	});

	it("rejects a value that is not a URL", () => {
		expect(() => parseBurrowUrl("not a url")).toThrow(FleetConfigError);
	});

	it("rejects a port of zero", () => {
		expect(() => parseBurrowUrl("http://box.example:0")).toThrow(FleetConfigError);
	});
});

const GOOD = `boxes:
  - id: box-a
    url: http://h:1234
    token_file: /t/a
  - id: box-b
    url: http://h2
    token_file: /t/b
`;

describe("parseFleetConfig", () => {
	it("parses every valid row, in order", () => {
		const parsed = parseFleetConfig(GOOD);
		expect(parsed.boxes).toEqual([
			{ id: "box-a", url: "http://h:1234", tokenFile: "/t/a" },
			{ id: "box-b", url: "http://h2", tokenFile: "/t/b" },
		]);
		expect(parsed.invalid).toEqual([]);
	});

	it("rejects a row missing token_file, naming the row and the reason", () => {
		const parsed = parseFleetConfig("boxes:\n  - id: box-a\n    url: http://h\n");
		expect(parsed.boxes).toEqual([]);
		expect(parsed.invalid).toEqual([{ id: "box-a", reason: "needs id, url and token_file" }]);
	});

	it("rejects a duplicate id but keeps the first row", () => {
		const parsed = parseFleetConfig(`boxes:
  - id: box-a
    url: http://h
    token_file: /t/a
  - id: box-a
    url: http://h2
    token_file: /t/b
`);
		expect(parsed.boxes.map((entry) => entry.id)).toEqual(["box-a"]);
		expect(parsed.invalid).toEqual([{ id: "box-a", reason: "duplicate id" }]);
	});

	it("rejects a bad box id", () => {
		const parsed = parseFleetConfig(`boxes:
  - id: Box-A
    url: http://h
    token_file: /t/a
`);
		expect(parsed.boxes).toEqual([]);
		expect(parsed.invalid).toEqual([{ id: "Box-A", reason: "id must match [a-z0-9][a-z0-9-]*" }]);
	});

	it("rejects a bad url with the reason from parseBurrowUrl", () => {
		const parsed = parseFleetConfig(`boxes:
  - id: box-a
    url: https://h
    token_file: /t/a
`);
		expect(parsed.boxes).toEqual([]);
		expect(parsed.invalid).toHaveLength(1);
		expect(parsed.invalid[0]?.id).toBe("box-a");
		expect(parsed.invalid[0]?.reason).toMatch(/only http/);
	});

	it("throws on a document that is not valid YAML", () => {
		expect(() => parseFleetConfig("boxes: [")).toThrow(FleetConfigError);
	});

	it("throws when the document is not a mapping", () => {
		expect(() => parseFleetConfig("- a\n- b")).toThrow(FleetConfigError);
	});
});

const CFG_PATH = "/cfg/fleet.yaml";
const ENV = { WARREN_FLEET_CONFIG: CFG_PATH };
const TWO_BOXES = `boxes:
  - id: box-a
    url: http://h:1234
    token_file: /t/a
  - id: box-b
    url: http://h2
    token_file: /t/b
`;

function reader(files: Readonly<Record<string, string | Error>>) {
	return (path: string): string => {
		const value = files[path];
		if (value === undefined) throw new Error(`ENOENT: ${path}`);
		if (value instanceof Error) throw value;
		return value;
	};
}

describe("loadFleetEndpoints", () => {
	it("resolves each surviving box to a transport and a trimmed token", () => {
		const loaded = loadFleetEndpoints({
			env: ENV,
			readFile: reader({ [CFG_PATH]: TWO_BOXES, "/t/a": "tok-a\n", "/t/b": "  tok-b  " }),
		});
		expect(loaded.endpoints).toEqual([
			{ id: "box-a", transport: { kind: "tcp", hostname: "h", port: 1234 }, token: "tok-a" },
			{ id: "box-b", transport: { kind: "tcp", hostname: "h2", port: 80 }, token: "tok-b" },
		]);
		expect(loaded.invalid).toEqual([]);
	});

	it("reports an unreadable token file and keeps the other boxes", () => {
		const loaded = loadFleetEndpoints({
			env: ENV,
			readFile: reader({
				[CFG_PATH]: TWO_BOXES,
				"/t/a": new Error("EACCES: permission denied"),
				"/t/b": "tok-b",
			}),
		});
		expect(loaded.endpoints.map((entry) => entry.id)).toEqual(["box-b"]);
		expect(loaded.invalid).toEqual([
			{ id: "box-a", reason: "token_file unreadable: EACCES: permission denied" },
		]);
	});

	it("reports an empty token file and keeps the other boxes", () => {
		const loaded = loadFleetEndpoints({
			env: ENV,
			readFile: reader({ [CFG_PATH]: TWO_BOXES, "/t/a": "   \n", "/t/b": "tok-b" }),
		});
		expect(loaded.endpoints.map((entry) => entry.id)).toEqual(["box-b"]);
		expect(loaded.invalid).toEqual([{ id: "box-a", reason: "token_file is empty" }]);
	});

	it("carries parse-level invalid rows through to the result", () => {
		const text = `boxes:
  - id: box-a
    url: http://h
    token_file: /t/a
  - id: box-b
    url: https://h2
    token_file: /t/b
`;
		const loaded = loadFleetEndpoints({
			env: ENV,
			readFile: reader({ [CFG_PATH]: text, "/t/a": "tok-a" }),
		});
		expect(loaded.endpoints.map((entry) => entry.id)).toEqual(["box-a"]);
		expect(loaded.invalid).toHaveLength(1);
		expect(loaded.invalid[0]?.id).toBe("box-b");
	});

	it("throws when the config file itself is unreadable", () => {
		expect(() =>
			loadFleetEndpoints({
				env: ENV,
				readFile: () => {
					throw new Error("ENOENT: no such file");
				},
			}),
		).toThrow(FleetConfigError);
	});

	it("throws when no box survives", () => {
		expect(() =>
			loadFleetEndpoints({
				env: ENV,
				readFile: reader({ [CFG_PATH]: TWO_BOXES, "/t/a": "", "/t/b": "  " }),
			}),
		).toThrow(FleetConfigError);
	});
});

describe("fleetConfigPath", () => {
	it("uses WARREN_FLEET_CONFIG when it is set", () => {
		expect(fleetConfigPath({ WARREN_FLEET_CONFIG: "/x/fleet.yaml" })).toBe("/x/fleet.yaml");
	});

	it("falls back to <kernel home>/fleet.yaml from OPENRIG_HOME", () => {
		expect(fleetConfigPath({ OPENRIG_HOME: "/opt/openrig" })).toBe("/opt/openrig/fleet.yaml");
	});

	it("falls back to <WARREN_DATA_DIR>/kernel/fleet.yaml", () => {
		expect(fleetConfigPath({ WARREN_DATA_DIR: "/var/warren" })).toBe(
			"/var/warren/kernel/fleet.yaml",
		);
	});

	it("ignores an empty override", () => {
		expect(fleetConfigPath({ WARREN_FLEET_CONFIG: "", OPENRIG_HOME: "/opt/openrig" })).toBe(
			"/opt/openrig/fleet.yaml",
		);
	});
});
