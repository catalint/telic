# Changelog

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
