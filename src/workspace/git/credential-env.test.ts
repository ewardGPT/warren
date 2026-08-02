import { describe, expect, test } from "bun:test";
import { githubCredentialGitEnv } from "./credential-env.ts";

describe("githubCredentialGitEnv", () => {
	test("renders the x-access-token insteadOf rule as GIT_CONFIG_* vars", () => {
		expect(githubCredentialGitEnv("tok")).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://x-access-token:tok@github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		});
	});

	test("undefined token → empty overrides (public repos clone anonymously)", () => {
		expect(githubCredentialGitEnv(undefined)).toEqual({});
	});

	test("empty token → empty overrides", () => {
		expect(githubCredentialGitEnv("")).toEqual({});
	});
});
