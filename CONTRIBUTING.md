# Contributing to telic

Thanks for considering it. This repo has a few unusual conventions that make
contributions land smoothly if you know them upfront — and bounce if you don't.

## Setup

```bash
git clone git@github.com:catalint/telic.git && cd telic
bun install
bun run check     # build → typecheck → test → size, all packages
```

[Bun](https://bun.sh) is the dev toolchain (runtime for tests, workspace
manager); the published packages themselves don't require it. **Build before
typecheck matters**: workspace packages resolve each other through compiled
`dist/`, so a fresh clone typechecks red until the first build — `bun run
check` handles the ordering for you.

## The spec-first workflow (the important part)

telic's behavior is defined by **normative, clause-numbered specs** — not by
the implementation:

- `packages/core/SPEC.md` (clauses S1–S27), `packages/react/SPEC.md` (R1–R6),
  `packages/lint/SPEC.md` (L1–L4)
- **Tests are written FROM the spec** and name their clause
  (`it("S3.4: second fulfill is ignored …")`). A test that asserts behavior no
  clause defines is a spec gap — fix the spec first.
- **Behavior changes change the spec in the same PR.** If you can't write the
  clause, the design isn't ready.

Design decisions (new features, changed boundaries, rejected alternatives) get
an entry appended to `packages/core/DECISIONS.md` — append-only, newest last,
one short entry saying what was decided and what was rejected. Read D1–D24
before proposing something big; there's a fair chance it was already decided,
and re-litigating settled decisions without new evidence is the fastest way to
a closed PR. Where to read what:

| Doc | Answers |
|---|---|
| SPEC.md | what, exactly |
| DESIGN.md | why, and the boundaries (start with "the initiative boundary") |
| PATTERNS.md | how to use it well (P1–P12) and how not to (AP1–AP9) |
| APPROACHES.md | which option, when there's more than one |
| DECISIONS.md | what was already decided, and what was rejected |

## Hard rules the code follows

These are enforced by review and, where possible, by the toolchain:

- **The initiative boundary**: telic never owns time or transport. No
  retries, no queues, no timers, no network of its own. Everything it invokes
  runs synchronously downstream of a caller's call. PRs adding "just one
  setTimeout" will be declined with love.
- **Zero runtime dependencies** in `@telic/core`. Vendor integrations use
  structural typing (see any tap); libraries needed only by tests are
  devDependencies.
- **No `as` casts** (except `as const`). Branded types use the overload
  pattern (`asAttemptId` in core.ts); everything else uses narrowing.
- **Explicit return types on every function** — `isolatedDeclarations`
  requires it on exports; the codebase does it everywhere.
- **Erasable syntax only**: no enums, no namespaces, no parameter properties.
- Tabs for indentation. `.js`-extensioned relative imports (node16 emit).
- **SSR safety**: no `window`/`document`/environment access at module scope,
  ever. Environment is feature-detected at call time and injectable for tests.
- **Size budgets are load-bearing**: `bun run size` gates every subpath
  (brotli). If your change exceeds a budget, raising the budget is allowed but
  must be deliberate — say so in the PR and justify it.

## Adding things

- **A new subpath** needs: the module + co-located test, an `exports` entry,
  a size budget in `scripts/size-gate.ts`, a SPEC section, and a CHANGELOG
  line. Grep for how `taps/otel` did it — it's the smallest complete example.
- **A new package** needs a DECISIONS entry first. Note: a package's FIRST
  npm publish is manual (trusted publishing requires the package to exist);
  releases after that are tag-automated.
- **Verification must use the production path** (D24): if it publishes with
  npm, verify with npm — `bun pm pack` and `npm pack` disagree about
  `workspace:` ranges, and that disagreement once shipped a broken package.

## Releases (maintainers)

Bump versions + CHANGELOG, push a `v*` tag. The release workflow verifies
(build/typecheck/test/size + the workspace-range guard) and publishes whatever
versions are new via npm trusted publishing, green-skipping the rest.

## Questions / proposals

Open an issue. The roadmap is demand-driven by design (D23) — a well-argued
issue with a concrete use case is exactly how new work starts. If your
proposal touches a settled decision, name the D-number and bring the new
evidence.
