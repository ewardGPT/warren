# Cross-repo plan coordination

Warren treats the project named in `POST /plan-runs` as the coordination
project. Each child seed may select its execution project with
`extensions.repo`. The value is a registered project slug or its git remote;
Warren resolves it before dispatch and runs the child in that repository's
Burrow workspace.

This keeps plan ownership, ordering, merge gates, and plan-run history in one
place while allowing each implementation step to land in the repository it
actually changes. The coordination project still owns the parent plan and
seed; the execution project owns the child run's checkout and PR.

The example role at [`docs/examples/cross-repo-planner.json`](examples/cross-repo-planner.json)
is intended for a project-local `.canopy/` tier. It is explicitly pinned to
Sapling and uses Burrow's normal sandbox path. It instructs the planner to
fill `extensions.repo` on every child and to use only registered project
slugs. The structured template adds a `repo` field to each step so the
planner does not rely on prose memory.

The contract is explicit: resolve every target before dispatch, keep the
parent plan in the coordination project, run children with Sapling in Burrow,
and preserve serial PR merge gating. An unresolved target rejects the plan;
it never falls back to the coordination checkout.
