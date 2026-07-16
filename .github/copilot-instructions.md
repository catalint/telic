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
   (emails, phone numbers, names) — classifications only (see PATTERNS.md AP7).
   The identity boundary is the CALLER's, not telic's (see DESIGN "The data
   boundary"): telic records payloads verbatim and forwards them everywhere — it
   has no `exposure`/reach class or payload scrubbing (removed in D30), so
   keeping PII off the payload is the only line of defense. Flag anything that
   could put PII onto marks, into storage, transports, or the agent surface.
6. **SSR/environment safety:** no `window`/`document`/`navigation`/storage
   access at module scope, ever. Environment must be feature-detected at call
   time and injectable for tests.
7. **Style:** explicit return types on all functions (isolatedDeclarations),
   erasable syntax only (no enums/namespaces/parameter properties), tabs,
   `.js`-extensioned relative imports (node16 emit), `type` over `interface`
   except the sanctioned `IntentRegistry` augmentation target.
8. **Packaging:** `dependencies`/`peerDependencies`/`optionalDependencies` in
   publishable manifests must never contain `workspace:` ranges (npm publish
   does not rewrite them). New subpaths need an `exports` entry, a size budget
   in `scripts/size-gate.ts`, and a CHANGELOG line.
9. **Transports/security:** `postMessage` transport requires explicit origin
   allow-listing (`targetOrigin: "*"` is rejected by design); incoming
   transport data must go through `wire.ts` validation before `ingest`. The
   devtools module must stay Trusted-Types-safe (no `innerHTML` or string
   HTML sinks).

## Already automated — don't re-litigate

`bun run conventions` (in CI + the release ladder) mechanically enforces the
cleanly-greppable rules: the initiative boundary, `.js`-extensioned relative
imports, zero-dep core, no module-scope browser globals, and `exports`↔size-
budget parity. You don't need to re-flag those by hand — spend the review on the
semantic classes below, which a grep can't catch without false positives.

## Bug classes this codebase has actually shipped — watch for regressions

These are the recurring shapes a real review pass surfaced. Each is a genuine
past defect; treat a new instance as a likely bug, not a nit.

1. **Prototype-key lookups (D27).** A dynamic read on a plain object keyed by an
   UNTRUSTED string — an intent name, a machine state name, a config scope name
   — resolves an inherited `Object.prototype` member (`toString`, `constructor`,
   `__proto__`, `valueOf`) instead of `undefined`, bypassing the undefined guard
   and either crashing (`.map`/`.reject` on a function) or polluting a prototype.
   Flag any `obj[dynamicKey]` / `obj?.[dynamicKey]` where `obj` is a plain object
   literal or `Record` and the key is caller/model-controlled: require
   `Object.hasOwn(obj, key) ? obj[key] : undefined`, or build the map as
   `Object.create(null)` / a `Map`. (Fixed sites: `adapters/xstate`, `lint/rules`,
   `flow`.)
2. **Dedup/once ordering and unboundedness (taps).** Record/consume a dedup or
   once-key BEFORE the side effect that can throw — otherwise a throwing sink
   re-fires the rule (double-count). A flush path (e.g. `recheck`) must be atomic:
   never empty a buffer before firing, or a mid-flush throw drops the remainder.
   Any per-attempt dedup set must be bounded (attempt ids never recycle).
3. **CI-unstable output.** Diagnostic/CLI message BODIES must not embed absolute
   filesystem paths — only the relativized `file` field is checkout-stable.
4. **Keyed/parked idempotency.** A keyed dispatch that dedupes to a single
   attempt must run its handler at most once — park queues must dedupe by attempt
   identity, not enqueue one entry per call.

## Review tone

Match the repo's culture: scrutiny goes to claims and code, warmth goes to
people. Prefer "this could leak X because Y — consider Z" over prescriptive
demands, and note when something is a nit versus a blocker.
