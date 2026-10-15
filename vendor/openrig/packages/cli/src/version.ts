import { readFileSync } from "node:fs";
import { BUILD_INFO, type BuildInfo } from "./build-info.js";

type PackageJson = {
  version?: string;
};

function readPackageVersion(): string {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
  return parsed.version ?? "0.0.0";
}

/** OPR.0.4.4.11 FR-7 — a STAMPED build prints `<semver> (<shortsha>)` (plus
 *  a dirty marker when dirty); an unstamped dev run prints the semver alone
 *  exactly as before (negative AC: no fake identity). */
export function formatCliVersion(semver: string, info: BuildInfo): string {
  if (!info.commit) return semver;
  const short = info.commit.slice(0, 8);
  return info.dirty ? `${semver} (${short}, dirty)` : `${semver} (${short})`;
}

export const CLI_VERSION = formatCliVersion(readPackageVersion(), BUILD_INFO);
