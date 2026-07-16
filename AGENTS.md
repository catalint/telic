# Working on the telic repo (agent guide)

Bun workspace monorepo: `packages/core` (@telic/core), `packages/react`,
`packages/lint`. TypeScript 7, ESM-only, tabs.

## Commands

```bash
bun install
bun run check        # build → typecheck → test → size — run this before claiming done
bun run test         # all packages; per package: cd packages/core && bun test src/
cd packages/core && bun run size   # brotli budgets per subpath — a gate, not a report
```

**Gotcha: build before typecheck.** Packages resolve each other through
compiled `dist/` (gitignored) — a fresh clone typechecks red until the first
build. `bun run check` orders this correctly.

## Non-negotiable conventions (CI and review enforce these)

- **Behavior is defined by `packages/*/SPEC.md`** (clause-numbered,
  normative). Changing behavior = changing the spec in the same PR. Tests
  reference clauses in their names: `it("S3.4: second fulfill is ignored…")`.
  Tests are written FROM the spec, not from the implementation.
- **Design changes append an entry to `packages/core/DECISIONS.md`**
  (append-only, newest last). Read it before proposing — D1–D24 record what
  was already decided and rejected.
- **The initiative boundary**: telic never owns time or transport. No
  setTimeout/intervals/retries/queues/reconnects/network initiated by the
  library. Caller-owned AbortSignals are the sanctioned deadline mechanism.
- **Zero runtime deps in core.** Vendor shapes are structural types (see any
  `src/taps/*` file). Test-only libs go in devDependencies.
- **No `as` casts** (only `as const`). Branded types via the overload-
  signature helpers (`asAttemptId` in core.ts). No `any`.
- Explicit return types everywhere (isolatedDeclarations); erasable syntax
  only (no enums/namespaces/parameter properties); `.js`-extensioned relative
  imports; no env/global access at module scope (SSR safety); `type` over
  `interface` except the `IntentRegistry` augmentation target.
- **New subpath checklist**: module + co-located test, `exports` entry in
  package.json, budget in `scripts/size-gate.ts`, SPEC section, CHANGELOG
  line. Smallest complete example to copy: `taps/otel`.
- **Publishing manifests must never contain `workspace:` ranges** in
  dependencies/peerDependencies (npm publish doesn't rewrite them; the
  release workflow blocks it).

## Releases

Bump versions + CHANGELOG, push a `v*` tag → the release workflow verifies
and publishes via npm trusted publishing. A NEW package's first publish is
manual. Verification must use the production path (npm, not bun pm pack —
they disagree about workspace: ranges; see DECISIONS D24).
