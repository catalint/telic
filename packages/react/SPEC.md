# @telic/react — behavioral specification

Normative spec for the React adapter. Tests are written FROM this file.
Core semantics (SPEC.md in packages/core) are assumed; this file only
specifies what React changes. React >= 18 peer; ships ESM like core.

## R1. Doctrine: mounts are not intents

The adapter exposes NO hook that begins an attempt on mount. A mount is not a
user goal (SPEC S1's setter test applied to lifecycles); mount-time begins are
what makes StrictMode double-invocation corrupt tapes. Recording happens in
event handlers and app logic via stable callbacks the hooks return.

## R2. useIntent(intent) → stable handle

1. Returns `{ begin, run }` — identity-stable across renders (safe in dep
   arrays), delegating to the intent handle.
2. Attempts begun through it are tracked by the hook instance: on UNMOUNT,
   still-active tracked attempts abandon `{ why: "unmount" }` (opt-out:
   `useIntent(intent, { abandonOnUnmount: false })`).
3. StrictMode contract: the dev double-mount (mount → cleanup → mount)
   abandons nothing (no attempts exist yet at first cleanup — begins only
   happen in handlers, per R1) and registers nothing twice. This MUST be
   covered by a StrictMode test.

## R3. useHandle(name, handler) — presence-based registration

1. Registers via mediation `handle()` in an effect; unregister is the effect
   cleanup. Handler identity changes re-register (latest closure wins) without
   firing `handler-replaced` spuriously — the hook unregisters BEFORE
   re-registering.
2. StrictMode contract (test-mandated): mount → cleanup → mount ends with
   EXACTLY ONE live registration; parked dispatches drained by the first
   registration are not re-executed by the second (drain-once is core
   behavior; the test proves the composition).

## R4. Memory subscriptions — useSyncExternalStore only

1. `useMemorySeq(pattern?)` — re-renders on matching marks; snapshot = the
   runtime's seq (a primitive: uSES-safe, no referential churn).
2. `useInProgress(pattern?)` and `useLastAttempt(pattern)` — built on
   useMemorySeq + memoized reads (recompute only when seq changed).
3. AP2 stands (memory is not truth): docs on every hook say secondary
   surfaces only. No hook exposes a way to write.

## R5. Runtime binding

Hooks bind to the default runtime by default; `<TelicProvider runtime={…}>`
overrides via context (explicit runtimes for tests/embedding — pairs with
createTestRuntime from @telic/core/testing).

## R6. Environment

1. SSR-safe: all hooks no-op/inert-value on the server (default runtime is
   silent there; hooks must not touch window themselves).
2. No react-dom dependency; works under react-dom and react-native renderers
   (no DOM APIs in the package).
