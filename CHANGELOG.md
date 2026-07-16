# Changelog

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
