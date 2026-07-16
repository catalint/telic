# @telic/react

React adapter for [`@telic/core`](../core) — stable intent handles, presence-based mediation handles, and `useSyncExternalStore` memory hooks.

```sh
bun add @telic/react @telic/core react
```

## Mounts are not intents

This adapter exposes **no hook that begins an attempt on mount**. A mount is not a user goal — mount-time begins are exactly what makes StrictMode's dev double-invocation corrupt tapes. Recording happens in event handlers and app logic, via the stable callbacks the hooks return. If you find yourself wanting `useEffect(() => intent.begin(), [])`, the thing you are recording is a lifecycle, not an intent.

## Hooks

| Hook | What it does |
|---|---|
| `useIntent(intent, opts?)` | Identity-stable `{ begin, run }` delegating to the intent handle. Attempts begun through it that are still active on unmount abandon `{ why: "unmount" }` (opt out with `abandonOnUnmount: false`). |
| `useHandle(name, handler)` | Registers THE mediation handler for `name` while mounted (effect-registered; cleanup unregisters). Handler identity changes re-register — latest closure wins, no spurious `handler-replaced`. |
| `useMemorySeq(pattern?)` | Re-renders on matching marks; returns the bound runtime's seq (a primitive — uSES-safe). |
| `useInProgress(pattern?)` | Active attempts, memoized — recomputes only when the seq changed. |
| `useLastAttempt(pattern)` | Most recently begun matching attempt, memoized the same way. |
| `<TelicProvider runtime={…}>` | Binds all hooks in the subtree to an explicit runtime (tests/embedding). Without it, hooks follow the module-level default runtime. |
| `mediatorFor(runtime)` | The shared per-runtime `Mediator` the provider uses — dispatch through it to reach `useHandle` handlers registered under that provider. |

Memory hooks are **secondary surfaces** (spinners, "still working…" affordances, debug panels) — memory is not truth, and no hook exposes a way to write.

## StrictMode

Safe by construction, and covered by contract tests: the dev double-mount (mount → cleanup → mount) records no marks and abandons nothing (`useIntent` — no attempts exist until a handler fires), and ends with exactly one live registration (`useHandle` — parked dispatches drained by the first registration are not re-executed by the second).

## SSR

All hooks render inert values on the server (the default runtime is silent there; seq 0, empty memory, no registrations — effects don't run). Nothing in the package touches `window`, and there is no react-dom dependency: it works under react-dom and react-native renderers.

## Spec

The normative behavioral spec is [SPEC.md](./SPEC.md) (R1–R6); tests are written from it. Core semantics live in `@telic/core`'s SPEC.md.
