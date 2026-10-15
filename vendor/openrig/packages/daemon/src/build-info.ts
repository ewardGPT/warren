// OPR.0.4.4.11 FR-6 — the daemon's build-identity module.
//
// This COMMITTED file is the honest DEV STUB: a source/dev run has no stamp
// and reports its identity fields as absent — never an invented SHA (FR-7
// negative AC). scripts/build-package.sh computes the stamp ONCE at package
// time (arch ruling 6) and overwrites the COMPILED counterpart
// (dist/build-info.js) in each package with the real values; no runtime
// cross-package import — the CLI carries its own generated twin.

export interface BuildInfo {
  semver: string | null;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
}

export const BUILD_INFO: BuildInfo = {
  semver: null,
  commit: null,
  dirty: null,
  builtAt: null,
};

/** The additive /healthz fields: the four stamp keys when stamped, an EMPTY
 *  object when dev — existing consumers (including exact-body probes against
 *  dev daemons) see no change. */
export function stampFields(info: BuildInfo = BUILD_INFO): Record<string, unknown> {
  if (!info.commit) return {};
  return { semver: info.semver, commit: info.commit, dirty: info.dirty, builtAt: info.builtAt };
}
