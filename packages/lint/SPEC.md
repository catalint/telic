# @telic/lint — behavioral specification

A small CLI that lifts telic's runtime diagnostics to authoring time — the
taxonomy governance tool (core DECISIONS D17, DESIGN risk #2). Runner- and
framework-agnostic; analyzes TypeScript/TSX sources statically.

## L1. CLI

1. `telic-lint <globs...>` (bin name `telic-lint`). No globs → default
   `**/*.{ts,tsx}` from cwd, honoring .gitignore-style excludes for
   node_modules/dist always.
2. Exit 0 = clean; exit 1 = findings; exit 2 = usage/config error.
3. `--json` emits machine-readable findings `[{ rule, file, line, name,
   message }]`; default output is human table, one line per finding.
4. Config discovered at `telic.config.json` upward from cwd (`--config`
   overrides). All config optional; zero-config runs rules 1–2 only.

## L2. Rules

1. **setter-like-name** — any `intent("scope.x", …)` / `command("scope.x")` /
   `handle("scope.x", …)` literal whose post-dot segment starts with
   set/update/toggle/change (case-insensitive). Mirrors core S1.4.
2. **duplicate-intent-name** — the same intent name string DECLARED via
   `intent(...)` in more than one file (same-file re-declaration is core's
   runtime job; cross-file duplication is the static-only catch). One finding
   per extra file.
3. **scope-ownership** (config: `"scopes": { "checkout": ["packages/checkout/**"] }`)
   — an `intent()`/`handle()`/`command()` literal whose scope (first segment)
   is configured but whose file matches none of that scope's globs; AND any
   scope in use that is absent from config when `"requireScopeOwnership":
   true` (a new scope must be a reviewable act). Scope resolution is an
   OWN-property lookup on the configured scopes: a scope name that collides
   with an `Object.prototype` key (`__proto__`, `constructor`, `toString`,
   …) is an ordinary scope name — never resolved from the prototype, never
   a crash (upholds the L1.2 exit-code contract).
4. **dead-contract** — a `command("name")` with no `handle("name", …)`
   anywhere in the scanned set (finding: severity warning — the handler may
   be presence-based/lazy, so the message says so), and a `handle("name")`
   with neither `command("name")` nor `dispatch("name"` anywhere (unused
   capability). Enable via config `"deadContract": true` (off by default —
   it assumes whole-program scanning).

## L3. Mechanics

1. Detection is TS-syntax-aware (the TypeScript compiler API), not regex:
   only call expressions named intent/command/handle/dispatch with a string
   literal (or no-substitution template) first argument count. Aliased
   imports of these functions from any module path count; locally-defined
   functions with those names in files that never import from a telic module
   are SKIPPED (no false positives on unrelated `handle` functions —
   the file must import from a specifier containing "telic" for its calls
   to be eligible). A telic import confers eligibility only when it
   introduces a RUNTIME binding: a default import, a namespace import, or
   at least one non-type-only named element. A whole-clause type-only
   import (`import type { … }`) or an all-inline type-only import
   (`import { type X }`) confers none.
2. `typescript` is a peerDependency (>= 5.5) — the tool uses the host's
   compiler; zero bundled TS.
3. Deterministic output ordering (file, then line) for CI diffing.
4. Glob matching normalizes a leading `./` and interior `.` path segments
   away, in both patterns and scanned paths — `./src/**` matches
   identically to `src/**`.

## L4. Package

name @telic/lint, bin telic-lint, ESM, same strictness flags as core, tests
under bun with fixture files (co-located `fixtures/` directory).
