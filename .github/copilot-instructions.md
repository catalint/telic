# Copilot instructions for telic

telic is a zero-dependency TypeScript library: a recorded intent + memory layer
for frontends (record → remember → mediate). Behavior is defined by normative,
clause-numbered specs (`packages/*/SPEC.md`); design boundaries live in
`packages/core/DESIGN.md`; prior decisions in `packages/core/DECISIONS.md`.

## When reviewing PRs, check for these project-specific rules

1. **The initiative boundary (most important):** telic must never own time or
   transport. Flag any `setTimeout`/`setInterval`, retry loops, queues,
   scheduling, reconnection logic, or network calls initiated by the library
   itself. Everything telic invokes must run synchronously downstream of a
   caller's call. Caller-owned deadlines (accepting an `AbortSignal`) are the
   sanctioned alternative.
2. **Zero runtime dependencies in `@telic/core`.** New imports from npm
   packages in `packages/core/src/**` (outside `*.test.ts`) are almost always
   wrong — vendor integrations use structural typing (see any file in
   `src/taps/`). Test-only libraries belong in `devDependencies`.
3. **No `as` casts** (only `as const` is allowed). Branded types are created
   through the existing overload-signature helpers (see `asAttemptId` in
   `core.ts`); everything else should use narrowing. Flag new `as` usage and
   `any`.
4. **Behavior changes need spec coverage.** If a PR changes observable
   behavior, look for a matching SPEC.md clause addition/amendment and tests
   whose names reference clause numbers (e.g. "S3.4: …"). Point out gaps
   gently — the maintainer often shapes clause wording during review.
5. **Privacy rules on the tape:** payloads must never carry raw identities
   (emails, phone numbers, names) — classifications only (see PATTERNS.md
   AP7). Redaction is write-time; flag anything that could put PII onto
   marks, into storage, transports, or the agent surface.
6. **SSR/environment safety:** no `window`/`document`/`navigation`/storage
   access at module scope, ever. Environment must be feature-detected at call
   time and injectable for tests.
7. **Style:** explicit return types on all functions (isolatedDeclarations),
   erasable syntax only (no enums/namespaces/parameter properties), tabs,
   `.js`-extensioned relative imports (node16 emit), `type` over `interface`
   except the sanctioned `IntentRegistry` augmentation target.
8. **Packaging:** `dependencies`/`peerDependencies` in publishable manifests
   must never contain `workspace:` ranges (npm publish does not rewrite
   them). New subpaths need an `exports` entry, a size budget in
   `scripts/size-gate.ts`, and a CHANGELOG line.
9. **Transports/security:** `postMessage` transport requires explicit origin
   allow-listing (`targetOrigin: "*"` is rejected by design); incoming
   transport data must go through `wire.ts` validation before `ingest`. The
   devtools module must stay Trusted-Types-safe (no `innerHTML` or string
   HTML sinks).

## Review tone

Match the repo's culture: scrutiny goes to claims and code, warmth goes to
people. Prefer "this could leak X because Y — consider Z" over prescriptive
demands, and note when something is a nit versus a blocker.
