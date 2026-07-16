# Changelog

## Unreleased

**BREAKING — payload-privacy / egress machinery removed (the data boundary, D28/D30):**

- **Breaking (core):** removed `IntentConfig.exposure` (the `full`/`local`/`private` reach class) and its `"[private]"` payload mask, `IntentConfig.redact`, the `strictPrivacy` runtime option, and the `missing-exposure` diagnostic — along with every egress filter they drove (snapshot exclusion, persistence's local-skip, and the broadcast / post-message / shared-worker local & private gates). telic core now records a mark and holds no opinion about where it travels: taps, persistence, and transports forward every mark, and scoping is the caller's `send`/pattern filter at wiring time. The `exposure` wire field is gone; the wire reader is tolerant, so a stale `exposure` on an old mark is ignored (no migration). Keeping sensitive values off the payload is the caller's job (PATTERNS AP7).
- **Docs:** DESIGN gains "The data boundary" — the twin of the initiative boundary: telic records what it is given and holds no egress opinion; the identity boundary (no raw identities on the tape) is the caller's. Rationale in DECISIONS D28/D30.

Whole-monorepo review pass — confirmed fixes (all behind the same `bun run check` gate; SPEC clauses + DECISIONS entries added in the same change):

- **Fix (core — HIGH):** a runtime-level `intent()` re-declaration returned a handle built from the SECOND config while `describe()` still reported the first, so the live handle and `describe()` could diverge. The returned handle now uses the first declaration's config, matching the module-level path; first-config-wins is a behavior invariant, not just a descriptor one (D26, SPEC S1 amendment).
- **Fix (core, crash — HIGH):** `settleFromMachine` (xstate adapter) indexed its settle-map with a raw machine state name; a state named `toString`/`constructor`/`__proto__` resolved an inherited `Object.prototype` member, bypassed the undefined guard, crashed, and stranded the attempt. The lookup is now own-property-guarded; unmapped states of any name are a no-op (D27, SPEC S25.5).
- **Fix (core, otel tap):** a non-plain-object note (Date, RegExp, Map, class instance) flattened to an empty span-event attribute bag, dropping its data; such values now take the JSON fallback. A plain `{}` still flattens to an empty event (SPEC S27.4).
- **Hardening (core, flow):** the `flow()` outcome accumulator is prototype-free, so a step named `__proto__`/`constructor` is an ordinary key rather than a prototype mutation (D27).
- **Fix (lint, crash — HIGH):** `scope-ownership` indexed the scopes object with a raw intent scope name; a name colliding with an `Object.prototype` key crashed the CLI uncaught, breaking the L1.2 exit-code contract. The lookup is own-property-guarded and the scopes accumulator is prototype-free (SPEC L2.3).
- **Fix (lint, false positive):** an all-type-only inline telic import (`import { type X }`) wrongly marked a file eligible for extraction, producing false-positive findings on files with zero runtime telic bindings. Eligibility now requires a runtime binding (SPEC L3.1).
- **Fix (lint, glob):** a `./`-prefixed positional glob silently matched zero files (green CI on a path that scanned nothing); leading and interior `.` segments are now normalized away (SPEC L3.4).

## 0.3.3 — 2026-07-16

- **AI-agent legibility**: `AI-GUIDE.md` now ships in the package (condensed correct-usage
  rules for coding agents + a paste-block for host agent configs); repo gains `llms.txt`
  and `AGENTS.md`. No code changes.

## 0.3.2 / react 0.1.1 / lint 0.1.1 — 2026-07-16

- **Fix (react, breaking-for-nobody-it-worked-for):** @telic/react 0.1.0 shipped with a literal `workspace:^` peer range — unresolvable outside this repo. 0.1.1 declares `@telic/core: ^0.3.0`; 0.1.0 is deprecated. The release pipeline now refuses to publish any manifest containing a workspace: range.
- Metadata: full author info, richer core description/keywords, `main`/`types` fallbacks for legacy resolution on core, `engines.node >= 20` on the lint CLI, `packageManager` pin at the workspace root.

## 0.3.1 — 2026-07-16

- Docs: README rewritten to surface all three layers — mediation and `flow()` now have
  first-class examples (the checkout example uses the real `flow()` API), plus a
  what's-in-the-box subpath map. The npm package page now shows the full README.

## 0.3.0 — 2026-07-16

- **Cross-tab & cross-app transports**: `transports/broadcast` (BroadcastChannel gossip), `transports/post-message` (iframe/micro-frontend bridging with mandatory origin allow-listing), and `transports/shared-worker` (authoritative cross-tab hub with snapshot requests). Forward-only, loop-safe, exposure-respecting.
- **XState adapter** (`adapters/xstate`): `bindActor` + `createIntentInspector` provenance links, `settleFromMachine` — structural source, verified against real XState v5.
- **Devtools overlay** (`devtools`): plain-DOM, Trusted-Types-safe, framework-free.
- **OpenTelemetry tap** (`taps/otel`): attempts as spans via structural tracer injection.
- **@telic/lint 0.1.0** (new package): taxonomy governance CLI — setter-like names, cross-file duplicate intents, scope ownership, dead-contract detection. TypeScript compiler API via the host's install (peer >= 5.5).
- **PostHog recipe** (`docs/recipes/posthog.md`) with trace-hook-based CI parity assertions; **P12** contract-subpath conventions for compiled monorepos; **P11/AP9** server-correlation contract.

## 0.2.0 — 2026-07-16

- **@telic/react 0.1.0** (new package): `useIntent`, `useHandle`, `useMemorySeq`/`useInProgress`/`useLastAttempt`, `<TelicProvider>` — with StrictMode double-mount and HMR semantics specified (SPEC R1–R6) and contract-tested, built on the doctrine that mounts are not intents.
- **Persistence tap** (`@telic/core/persist`): storage-backed tape with exposure-aware filtering, resume patterns for cross-reload attempt resurrection, `clearPersistedTape` for erasure paths.
- **Wire format** (`@telic/core/wire`): zero-dependency structural validators for the versioned mark envelope.
- **Testing subpath** (`@telic/core/testing`): runner-agnostic `createTestRuntime` (deterministic clock/ids/diagnostics), tape helpers, stable snapshot serializer.
- **TanStack Query adapter** (`@telic/core/adapters/tanstack-query`): mutation provenance links + `settleFromMutation`; internal retries are `noted` on one attempt, `retryOf` reserved for user-initiated retries.
- **node16/nodenext type support**: extensioned ESM emit — arethetypeswrong fully green across all resolution modes.
- **Analytics tap `trace` hook**: per-rule/mark decision record (sent/emitted/deduped/denied/buffered/flushed) for CI-assertable migration parity.
- `duplicate-intent` now fires once per name per runtime (HMR re-evaluation no longer spams diagnostics).
- TypeScript 7 (native compiler) toolchain; size budgets extended to all 13 subpaths.

All notable changes to `@telic/core` are recorded here. The project follows
[semantic versioning](https://semver.org) from 0.1.0 onward.

## 0.1.0

First public release — extracted from the production codebase it was proven in.

- Record-first intent lifecycle: `intent()` → `begin` → `fulfilled` / `rejected` /
  `abandoned`, with `run()` sugar and first-write-wins settling that never throws.
- In-page queryable session memory: `last`, `has`, `inProgress`, `attempts`, `marks`,
  `project`, and `snapshot`, plus pattern subscriptions via `on(pattern, fn, { replay })`.
- Late-bound module-level runtime (`intent`/`on`/`scope`/`memory` resolve the current default
  runtime per call), with `createRuntime()` for isolated/multi-runtime embedders.
- Platform wiring: `attempt.signal` aborts on settle/abandon, `abandonWhen`, supersession,
  Navigation-API auto-abandon with a `pagehide` fallback, and `URLPattern` route scoping.
- Taps (each a sub-path import): `taps/console`, `taps/breadcrumbs` (with `taps/sentry` as a
  preset alias), `taps/user-timing`, and `taps/analytics` (at-most-once rules + consent gate).
- Optional mediation layer: `mediate` (`handle`/`dispatch`, one handler per intent, dispatch
  never throws) and `flow` (saga coordinator with keyed resume and AttemptId-as-Idempotency-Key).
- Agent read surface (`agent`): `describe()`/`snapshot()` for embedded copilots and WebMCP.
- Zero runtime dependencies: payloads accept any Standard Schema V1 implementation; the spec
  interface is vendored types-only.
- Typed cross-domain composition via the augmentable `IntentRegistry` — the one sanctioned
  declaration-merge — verified across the compiled `.d.ts` on TypeScript 5.5 through latest.
- Dev diagnostics: `setter-like-name`, `duplicate-intent`, `duplicate-runtime`,
  `missing-exposure`, and `navigation-unavailable`.
- ESM build (`tsc`) emitting JavaScript, `.d.ts`, and source maps; a brotli size gate guards
  every published sub-path.

## 0.0.1

Name-reservation stub for `@telic/core` — no runtime code.
