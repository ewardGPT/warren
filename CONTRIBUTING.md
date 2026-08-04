# Contributing to Warren

Thanks for your interest in contributing to Warren! This guide covers everything you need to get started. [`docs/README.md`](docs/README.md) indexes every other operator and contributor document.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/warren.git
   cd warren
   ```
3. **Install** dependencies:
   ```bash
   bun install
   ```
4. **Run** the CLI straight from the checkout — warren is not published to npm, so there is no global install:
   ```bash
   bun run src/cli/main.ts --help
   ```
5. **Create a branch** for your work:
   ```bash
   git checkout -b fix/description-of-change
   ```

Use descriptive branch names with a category prefix:

- `fix/` -- Bug fixes
- `feat/` -- New features
- `docs/` -- Documentation changes
- `refactor/` -- Code refactoring
- `test/` -- Test additions or fixes

## Local Dev Loop

Run the server and the UI together from two terminals. Start the Warren
API server with the CLI `serve` command in one terminal:

```bash
bun run src/cli/main.ts serve --no-auth
```

`--no-auth` disables HTTP auth for loopback development. The server binds
to port `8080` by default. Override the port inline with
`WARREN_BIND_PORT` when you need a different one:

```bash
WARREN_BIND_PORT=4321 bun run src/cli/main.ts serve --no-auth
```

Then start the Vite dev server for the UI in a second terminal:

```bash
cd src/ui && bun run dev
```

The UI proxies `/api` to the running server, so you can edit server or
UI code and hot-reload without redeploying. Keep the two processes up
while you iterate, and run the full gate manifest (`bun run check:all`)
before pushing.

## Build & Test Commands

```bash
bun test                                   # Run all tests
bun test src/foo.test.ts                   # Run a single test file
bun run check:all                          # All quality gates CI enforces
```

`bun run check:all` is the full gate manifest CI runs on every PR. It
runs lint (with the per-layer rules), typecheck, the full test suite,
and the wire / version-sync / prose / seed / file-size / bundle-size /
coverage guards, then regenerates docs and fails if they appear dirty.

`biome check .` alone is not the gate. `scripts/check-all.ts` is
canonical, and each stage can run on its own to iterate faster:

- `check:lint`, `check:type`, `check:wire-types`, `check:layers`
- `check:seeds`, `check:prose`, `check:version-sync`, `check:ci-parity`
- `check:file-sizes`, `check:bundle-size`, `check:coverage`

Always run the full `bun run check:all` before submitting a PR.

## TypeScript Conventions

Warren is a strict TypeScript project that runs directly on Bun (no build step).

### Strict Mode

- `noUncheckedIndexedAccess` is enabled -- always handle possible `undefined` from indexing
- No `any` -- use `unknown` and narrow, or define proper types

### Dependencies

- Minimal runtime deps: only what is truly needed
- Use Bun built-in APIs where possible: `bun:sqlite` for persistence, `Bun.spawn` for subprocesses, `Bun.file` / `Bun.write` for file I/O, `Bun.serve` for HTTP

### Formatting

- **Tab indentation** (enforced by Biome)
- **100 character line width** (enforced by Biome)
- Biome handles import organization automatically

### File Organization

- Types live with the domain that owns them: `src/core/` for ids and the error hierarchy, `src/server/types.ts` for the HTTP wire shapes, and `src/runs/`, `src/projects/`, `src/registry/` for their own
- Each CLI command gets its own file in `src/cli/commands/`
- Import with `.ts` extensions

### The wire vocabulary (single source of truth)

`src/core/wire.ts` is the canonical home for every enum-shaped value that
crosses the HTTP wire — run, plan-run, and preview lifecycle states, the
failure-cause discriminator, run mode, clone kind, event stream, agent
source, and the steering-inbox classes. Define each value there and
re-export it outward:

- `src/db/schema/columns.ts` re-exports the whole module
- `src/client/types.ts` and `src/client/types.plan-runs.ts` re-export the names they need
- `src/ui/src/api/types.ts` re-exports the same names and declares none of them

Do **not** hand-maintain a second copy in the SDK or the UI. A second
copy drifts. The `check:wire-types` and `check:layers` guards, both part
of `bun run lint`, enforce the rule and are described in `AGENTS.md`.

## Testing Conventions

- **No mocks for storage or filesystem.** Tests use real filesystems and real SQLite.
- Create temp directories with `mkdtemp` for file I/O tests
- Use `:memory:` or temp file databases for SQLite tests
- Stub external boundaries (burrow HTTP API, agent runtimes) at the boundary, but run the layers above on real code paths
- Clean up in `afterEach`
- Colocate tests with source files: `src/foo.test.ts` alongside `src/foo.ts`

Example test structure:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "bun:test";

describe("my-feature", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "warren-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  it("does the thing", async () => {
    // Write real files, run real code, assert real results
  });
});
```

## Adding a New Command

1. Create `src/cli/commands/<name>.ts`, exporting a pure `run<Name>` function
2. Import it in `src/cli/main.ts` and add its `case` to the subcommand dispatch
3. Add tests in `src/cli/commands/<name>.test.ts`
4. Add a row to the `## CLI` table in `README.md`

## Commit Message Style

Use concise, descriptive commit messages:

```
fix: close stream on client disconnect
feat: add scheduled run support
docs: document warren.toml schema
```

Prefix with `fix:`, `feat:`, or `docs:` when the category is clear. Plain descriptive messages are also fine.

## Pull Request Expectations

- **One concern per PR.** Keep changes focused -- a bug fix, a feature, a refactor. Not all three.
- **Tests required.** New features and bug fixes should include tests. See the testing conventions above.
- **Passing CI.** All PRs must pass the full `bun run check:all` gate manifest before merge.
- **Description.** Briefly explain what the PR does and why. Link to any relevant issues.

## Reporting Issues

Use [GitHub Issues](https://github.com/jayminwest/warren/issues) for bug reports and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

Issue templates apply the baseline `type/*`, `priority/*`, and
`status/needs-triage` labels automatically. The full label taxonomy --
namespaced `priority/*`, `type/*`, `area/*`, `status/*`, and `effort/*`
groups -- is documented in [`docs/labels.md`](docs/labels.md) and
defined canonically in [`.github/labels.yml`](.github/labels.yml). The
[`sync-labels`](.github/workflows/sync-labels.yml) workflow keeps the
GitHub repository's labels in sync with the source file.

### Good First Issues

New contributors should look for the `good first issue` discovery label,
which marks issues scoped small enough to pick up without deep context.
Start by filtering the issue tracker for `is:issue is:open label:"good first issue"`.

Workflow for picking one up:

1. Read the linked issue and follow its reproduction or acceptance steps
2. If the summary is ambiguous or the scope looks larger than expected,
   leave a comment before starting rather than guessing
3. Implement, then run `bun run check:all` locally until it is green —
   the full gate manifest is the source of truth
4. Open a PR against `main`, reference the issue number (`Closes #N`),
   and note in the description whether any part of the fix felt
   underspecified

Maintainers bump the `good first issue` label off once work starts, so
claim the issue in a comment when you begin to avoid two people taking
the same one.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
