// OPR.0.4.4.11 FR-6 — the CLI's build-identity module.
//
// COMMITTED DEV STUB: unstamped runs report absent identity — never an
// invented SHA. scripts/build-package.sh computes the stamp ONCE and
// overwrites the compiled counterpart (dist/build-info.js) at package time;
// this is the CLI's own generated twin of the daemon module (arch ruling 6 —
// per-package modules, no runtime cross-package import).

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
