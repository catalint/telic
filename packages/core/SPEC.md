# @telic/core — behavioral specification (Phase 0)

Normative spec for `src/core.ts` + `src/pattern.ts`. The type contract lives in
`src/types.ts` (authoritative for signatures). Tests are written FROM THIS FILE,
not from the implementation. Clause numbers are stable — reference them in test
descriptions (`given/when/then` style, e.g. "S3.4: second fulfill is ignored").

## S1. Declarations

1. `intent(name, config?)` is side-effect-free apart from registering the
   declaration with the runtime for `describe()`/diagnostics. SSR-safe.
2. Names must match `<scope>.<rest>` (at least one dot). The type system
   enforces the shape; the runtime does NOT throw on violations.
3. Declaring the same name twice on one runtime → diagnostic
   `duplicate-intent`; the second declaration still works (returns a handle
   bound to the same name).
4. A name whose post-dot segment starts with `set`, `update`, `toggle`, or
   `change` (case-insensitive) → diagnostic `setter-like-name` (once per name).
   Recording proceeds normally — it's a nudge, not a gate.
5. *(Removed in D30.)* The `strictPrivacy` option and its `missing-exposure`
   diagnostic were removed together with the payload-egress machinery — telic
   no longer models where a mark is allowed to travel. Clause number retained
   for stability.
6. `config.agent` is an OPTIONAL, caller-produced descriptor `{ summary?:
   string; input?: unknown }` — an already-projected shape the caller owns
   (e.g. a hand-written or `z.toJSONSchema`-derived JSON Schema for `input`).
   telic forwards it VERBATIM to `describe()` (S12.6) and projects NOTHING
   itself: it neither derives, validates, nor transforms `input` — the data
   boundary D30 places that outside telic's realm. First-declaration-wins
   (S1.3-revised / D26): a re-declaration's differing `agent` is ignored, like
   `tags`/schemas. No diagnostic; declaring or omitting `agent` is unremarkable.

## S2. begin()

1. Returns an `Attempt`. Emits a `begun` mark carrying the payload as passed to
   `begin()` — telic records it verbatim and holds no opinion about where the
   mark may travel (D30). Keeping sensitive values off the payload is the
   caller's responsibility (see PATTERNS.md AP7).
2. Payload validation: if a payload schema exists, validate synchronously via
   `schema["~standard"].validate`. On issues → diagnostic `invalid-payload`;
   the begin STILL records (record-first: observability must not break the
   app). If validate returns a Promise → diagnostic `async-schema`, skip
   validation, record.
3. Ambient parent: inside `within(a, fn)`, a `begin()` without explicit
   `opts.parent` stamps `parent: a.id`.
4. Keyed conflicts — key = `intent name + opts.key`:
   - default `onConflict` is `"concurrent"` without a key, `"dedupe"` with one;
   - `"dedupe"`: if an ACTIVE attempt exists for the key, return THE SAME
     `Attempt` handle (no new mark);
   - `"supersede"`: abandon the existing active keyed attempt
     (`{ why: "superseded", by: <newId> }`), then begin the new one;
   - `"concurrent"`: always a fresh attempt.
5. `opts.retryOf` stamps the begun mark.
6. `opts.abandonWhen` (AbortSignal): when it aborts (or is already aborted),
   the attempt abandons with `{ why: "signal" }`.
7. In `mode: "silent"`: `begin()` returns an inert handle (all methods no-op,
   `phase()` returns active-since-0, `signal` never aborts, `settled` never
   resolves); nothing is recorded.

## S3. Attempt lifecycle

1. Phases: `active` → exactly one of `fulfilled` | `rejected` | `abandoned`.
2. `fulfill(outcome?)` emits `fulfilled`; outcome validated like S2.2
   (diagnostic `invalid-outcome`, still records).
3. `reject(reason)` emits `rejected`.
4. Settling is FIRST-WRITE-WINS: any second settle call (fulfill/reject/
   abandon after terminal) is ignored, emits NO mark, and produces diagnostic
   `double-settle` with the ignored phase. Never throws.
5. `abandon(reason?)` defaults to `{ why: "user" }`.
6. `note(data)` emits `noted` while active; after settle it is ignored
   (no mark, no diagnostic — notes race benignly with settlement).
7. `link(ref)` emits `linked`; allowed while active AND after settle
   (adapters may report trailing state activity).
8. `attempt.signal`: lazily created; aborts when the attempt settles or
   abandons (abort reason = the terminal phase string). Accessing `signal`
   after settle returns an already-aborted signal.
9. `attempt.settled`: resolves with the terminal `AttemptPhase` on first
   settle; never rejects. Accessing after settle resolves immediately.
10. `wrap(fn)`: returns a function that re-enters this attempt's ambient scope
    (as `within`) for each invocation, then restores the previous stack.
11. `Symbol.dispose`: abandon-if-unsettled with `{ why: "dispose" }`; no-op if
    settled.
12. `intent.run(payload, fn)`: begins, calls `fn(attempt)` capturing sync
    throws as rejections (Promise.try semantics); on resolve `{ ok: true }` →
    fulfill (with `result.data` as outcome when a fulfilled schema exists and
    `data` is present, else void); `{ ok: false }` → reject (with
    `result.error` when present, else the result); on throw/reject → reject
    with the thrown value, then RE-THROW to the caller. Already-settled
    attempts (e.g. fn fulfilled manually) follow S3.4.

## S4. Tape

1. Marks get `seq` from a monotonic counter starting at 1 (branded `Seq`) and
   `at` from the injected clock.
2. Marks are frozen (`Object.freeze`) before emission.
3. Ring buffer: at most `limits.marks` (default 500) marks retained; oldest
   evicted first. Eviction does not affect attempt phase tracking.
4. Attempt index: ACTIVE attempts are always retained (never evicted).
   Settled attempts go to an LRU of `limits.settledAttempts` (default 100).

## S5. Subscriptions — on()

1. `on(pattern, listener, opts?)` returns an `Unsubscribe` (callable and
   disposable). Duplicate unsubscribe calls are safe.
2. Pattern semantics (see S8): exact, `scope.*`, `*`.
3. `opts.kinds` filters by mark kind.
4. `opts.replay: true`: synchronously delivers all RETAINED matching marks
   (in seq order, kinds-filtered) before `on()` returns, each with the current
   `AttemptView` for its attempt (or undefined if evicted).
5. Listener exceptions are caught → diagnostic `listener-error`; other
   listeners and taps still run. Delivery order: taps first (attach order),
   then listeners (subscribe order). A listener subscribing/unsubscribing
   during delivery takes effect from the NEXT mark.
6. The `IntentEvent.attempt` view reflects the attempt state AFTER the mark
   (e.g. a `fulfilled` mark's view has `phase: "fulfilled"`).

## S6. Memory

1. `last(pattern)`: the matching attempt with the highest begun seq (active or
   settled, retained only).
2. `has(pattern, { phase?, withinMs? })`: any retained matching attempt;
   `phase` filters terminal/active phase; `withinMs` compares against the
   attempt's LAST activity (begun or settle time) relative to `now()`.
3. `inProgress(scopePattern?)`: active attempts, oldest-begun first.
4. `attempts(pattern, { limit? })`: retained matching attempts, most recently
   begun first.
5. `marks({ pattern?, kinds?, sinceSeq? })`: retained marks in seq order;
   `sinceSeq` is exclusive.
6. `project(projection)`: folds `init()` over all retained marks immediately,
   then over each live mark; `read()` returns current state; `subscribe(fn)`
   fires after each fold; `dispose()` detaches. Reducer exceptions →
   diagnostic `listener-error` (the projection skips that mark).
7. `snapshot()`: `{ at: now(), seq: current, active: AttemptView[], recent:
   Mark[] }` — deep-copied (structuredClone or equivalent) so callers cannot
   mutate runtime state.
8. All views returned by memory are frozen.

## S7. Taps

1. `runtime.tap(tap)` attaches; returns `Unsubscribe`. If `tap.onAttach`
   exists it is called once, synchronously, with the retained tape.
2. Every subsequent mark calls `tap.onMark(mark, view)` synchronously, in
   attach order, before listeners (S5.5).
3. Tap exceptions are caught → diagnostic `tap-error` (with tap id); never
   propagate.
4. *(Removed in D30.)* Taps receive every mark; there is no longer a `local`
   exposure class to exclude. Clause number retained for stability.

## S8. Patterns (src/pattern.ts)

1. `"a.b"` matches only `"a.b"`. `"a.*"` matches every name whose first
   segment is `a` (any depth after the dot). `"*"` matches everything.
2. `compilePattern(pattern)` → `CompiledPattern`; `matchesPattern(compiled,
   name)` → boolean; `bucketOf(pattern)` → first segment, or null for `"*"`
   (listener bucketing); `scopeOf(name)` → first segment.
3. Matching is case-sensitive, no regex, O(1) per check after compile.

## S9. within / current

1. `within(attempt, fn)` pushes for the SYNCHRONOUS duration of `fn` (always
   restored via finally, exceptions propagate). Re-entrant (stack).
2. `current()` returns the AttemptView of the top of the stack, or undefined.
3. Ambient context does NOT survive `await` — documented; `wrap()` is the
   escape hatch. No AsyncContext polyfill.

## S10. Runtime & default runtime

1. `createRuntime(opts?)` — everything injectable: `now` (default Date.now),
   `id` (default crypto.randomUUID, falling back to a counter when
   crypto.randomUUID is absent), limits, mode, onDiagnostic.
2. Diagnostics NEVER throw; without `onDiagnostic` they are dropped silently
   in production-like use (no console.* in the library).
3. `ingest(marks)`: appends foreign marks to the tape (preserving their
   origin), updates/creates attempt records from them, re-seqs them locally
   (local seq order is the tape's total order), and delivers to taps/listeners.
   Marks whose `origin` is set are otherwise treated identically.
4. Module-level API (`intent`, `on`, `memory`, top-level `scope`) binds to THE
   DEFAULT RUNTIME: lazily created on first use — `mode: "silent"` when
   `typeof document === "undefined"` (a server module singleton spans
   requests; recording there would interleave users), else `mode: "record"`.
   Module-level `intent()` handles are LATE-BOUND: the declaration is stored
   in a module-level registry, and every handle method resolves the CURRENT
   default runtime at call time. Module-level `on()` subscriptions likewise
   survive a configure: they re-attach to the new runtime (replay does NOT
   re-fire). ES-module evaluation order must not matter — declaring intents
   or subscribing before `configureDefaultRuntime()` runs is the normal case,
   not an error.
5. `configureDefaultRuntime(opts)`: replaces the default runtime. All
   module-level declarations re-register onto the new runtime eagerly (so
   `describe()` is complete before any recording), and previously-obtained
   module-level handles keep working — their next call records on the NEW
   runtime. Handles from explicit `createRuntime()` runtimes are unaffected
   (they stay bound to their runtime). Called after the default runtime has
   already RECORDED (seq > 0) → diagnostic `late-configure` and the fresh
   runtime still replaces (empty tape).
7. Regression guard (the orphaned-runtime bug): module-level `intent()`
   called during module evaluation, followed by `configureDefaultRuntime()`,
   followed by `handle.begin()` — the mark MUST land on the configured
   runtime (visible to its taps, memory, and describe()). An attempt begun
   BEFORE the configure settles on the runtime that recorded its begin (the
   old one); this is the only sanctioned cross-runtime edge and is
   documented, not diagnosed.
6. `connectBrowserLifecycle(runtime, env?)`: wires auto-abandonment.
   - `env` is injectable for tests: `{ addEventListener, navigation? }`
     (structural; defaults to globalThis when present).
   - On `pagehide`: abandon ALL active attempts (`{ why: "navigation" }`).
   - On Navigation API `navigate` success (soft nav): abandon ONLY attempts
     whose `boundTo` pattern does NOT match the new URL. Attempts without
     `boundTo` are NOT abandoned by soft navigation (SPA wizards navigate
     between their own steps).
   - Returns a disconnect function. Feature-detects; never throws when the
     Navigation API is absent — but absence is NOT silent: connecting a
     runtime whose environment lacks the Navigation API fires diagnostic
     `navigation-unavailable` (once per connect), because `boundTo`
     auto-abandonment degrading silently would be an honesty violation.
     Alternative navigation sources (framework routers) plug in via the
     injectable `env` — the adapter contract is: an object whose `navigation`
     property is EventTarget-shaped with `currentEntry.url`.
   - The default runtime auto-connects lazily in the browser; explicit
     runtimes do not.
8. Duplicate-instance sentinel (the two-loaded-copies footgun). At
   runtime-creation time, and ONLY in a browser-like environment (`typeof
   document !== "undefined"`, the same gate as the default runtime, S10.4),
   `createRuntime` probes a well-known `globalThis` key (`__TELIC_CORE__`)
   carrying a per-module-copy identity token. The FIRST copy to create a
   runtime claims the key with its token; a creation that finds the key already
   held by a DIFFERENT token fires diagnostic `duplicate-instance` on the
   runtime being created — proof that two copies of `@telic/core` are loaded,
   each with its own tape/registry (the micro-frontend footgun README §5
   warns about). It fires at most once PER PROBED HOST per module copy,
   COUNTED ON DELIVERY: a detection on a runtime with no `onDiagnostic`
   consumes nothing — the probe re-runs at each later runtime creation and
   delivers to the first handler-bearing one, so the handler-less lazy default
   (S10.4) cannot silence the `configureDefaultRuntime({ onDiagnostic })` that
   follows it (S10.5 routes configure through runtime creation). It NEVER
   throws and NEVER overwrites another copy's claim (the first claimer stays
   owner). Multiple explicit `createRuntime()` calls within ONE copy find
   their own token and do NOT fire. The probe target and browser-likeness are
   injectable (a structural `{ browserLike, host }` seam, same style as
   connectBrowserLifecycle's `env`, S10.6) so tests are deterministic and
   never touch the real `globalThis`; the once-accounting is keyed on the
   host, so tests probing fresh hosts are isolated by construction.

## S12. describe() (Runtime)

1. `runtime.describe()` returns one `IntentDescriptor` per DISTINCT declared
   intent name, in first-declaration order: `{ name, tags, hasPayloadSchema }`.
   Re-declarations (S1.3) do not duplicate entries; the FIRST declaration's
   config wins for the descriptor.
2. The returned array and its entries are frozen.
3. Silent runtimes still register declarations (describe() works on the server
   — declaration is side-effect-free; only recording is silenced).
6. When `config.agent` (S1.6) was declared, the descriptor carries an `agent`
   property; when it was not, the descriptor has NO `agent` property (present
   only when declared). The value telic exposes is its OWN wrapper `{ summary,
   input }`, and that wrapper is frozen along with the descriptor entry (S12.2).
   The caller's `input` value is forwarded BY REFERENCE — telic does NOT
   deep-freeze it (it is the caller's object; freezing it would be authoring
   over data telic does not own). First-declaration's `agent` wins (S1.6). (No
   clause 4; the invokability amendment took 5.)

## S13. Taps modules (src/taps/*)

1. `taps/console.ts` — `createConsoleTap(opts?: { log?: (line: string, mark:
   Mark) => void })`: one human-readable line per mark
   (`kind intent#attemptShort …`); default log falls back to
   `globalThis.console?.debug` and no-ops when absent. Dev tool; the ONLY
   module allowed to touch console, and only as an injectable default.
2. `taps/breadcrumbs.ts` — `createBreadcrumbTap(opts: { addBreadcrumb: (b:
   BreadcrumbLike) => void })` — the vendor-neutral primary (any
   `addBreadcrumb`-shaped sink: Sentry, Rollbar telemetry, …).
   `taps/sentry.ts` remains as a preset re-export (`createSentryBreadcrumbTap`
   = alias) for discoverability; identical semantics: every mark → breadcrumb `{ category: "intent",
   message: "<kind> <intent>", level: "error" for rejected / "warning" for
   abandoned / "info" otherwise, data: { attempt, seq, plus kind-specific
   payload/outcome/reason/abandon fields }, timestamp: mark.at / 1000 }`.
   Structural injection only — no @sentry import. Also exports
   `intentContext(memory)`: `{ inProgress: AttemptView[], recent: Mark[]
   (last 10) }` for beforeSend enrichment.
3. `taps/user-timing.ts` — `createUserTimingTap(opts?: { perf?: PerfLike })`:
   begun → `perf.mark("telic:<intent>:<attemptId>", { detail })`; each
   terminal mark → `perf.measure("telic:<intent> <phase>", { start: <the
   begun mark name>, detail })`, guarded so a missing begin mark (ring-evicted
   or attached late) is a silent no-op. Defaults to `globalThis.performance`;
   inert when absent or when mark/measure throw (never propagates).
4. All taps: exceptions inside the injected sinks are caught by the CORE's
   S7.3 tap-error handling — taps themselves do not add try/catch around the
   whole onMark, only around environment probes documented above.

## S17. Analytics tap (src/taps/analytics.ts)

1. `createAnalyticsTap(opts): Tap & { recheck(): void }` with opts:
   `send(event)` (vendor-agnostic sink: `{ name: string; props?: Record<string,
   string | number | boolean> }`), `consent: () => boolean` (checked per
   mark), `whileDenied?: "drop" | "buffer"` (default "drop"; buffer is
   FIFO-capped at 50, oldest dropped), `rules: readonly AnalyticsRule[]`,
   `dedupe?: { load(): readonly string[]; save(keys: readonly string[]): void }`
   (persistence for once-keys; loaded once at construction, save called after
   each newly-recorded key).
2. `AnalyticsRule`: `{ on: IntentPattern; kind: MarkKind; when?(mark, view):
   boolean; once?: "per-intent" | "per-attempt" | "off" (default "off");
   onceKey?: string; map?(mark, view): AnalyticsEvent | undefined;
   emit?(mark, view): void }`. At least one of map/emit required. `map`'s
   event goes to `send`; `emit` is the vendor-side-effect escape hatch
   (identify calls, deduped conversion pixels) and runs under the SAME
   once/consent gating as map.
3. `once` semantics — the mechanical replacement for hand-rolled fired-once
   sets: "per-intent" fires the rule at most once EVER (key = `onceKey` when
   given, else `<on>|<kind>`); "per-attempt" at most once per attempt (key
   suffixed with the attempt id — per-attempt keys are NOT persisted via
   dedupe, only per-intent keys are). A rule whose `when` returns false does
   NOT consume its once-key.
4. Consent gating: `consent()` is evaluated per matching mark. Denied +
   "drop" → nothing. Denied + "buffer" → the RESOLVED actions (send payload /
   emit thunk) buffer; `recheck()` flushes FIFO when `consent()` is true,
   applying once-dedup at flush time (a key consumed by a live mark while
   buffered wins; the stale buffered action is discarded).
5. No `onAttach` replay — historical marks are not analytics events.
6. Rule callbacks that throw propagate to core's S7.3 tap-error handling
   (diagnostic, never a crash); the tap adds no internal try/catch beyond
   what S13.4 sanctions.

## S14. Agent surface (src/agent/surface.ts)

1. `exposeAgentSurface(runtime, opts?: { key?: string; target?: object }):
   () => void` — installs a FROZEN facade at `target[key]` (default target:
   globalThis, default key: "__INTENT_MEMORY__"); returns an uninstall fn.
2. Facade: `{ version: 1, snapshot(), marks(sinceSeq?), inProgress(),
   describe() }` — pure delegations to the runtime; everything returned is
   already frozen by core semantics. The facade adds no filtering of its own —
   it is a local reader.
3. Installing over an existing property: overwrite silently only when the
   existing value is a previous telic facade (`version` present); otherwise
   leave the property alone and return a no-op uninstaller.
4. SSR-safe: no module-scope environment access; installing onto an explicit
   `target` works in any runtime.

## S15. Mediation — handle() / dispatch() (src/mediate.ts)

The optional command half of the bus. THE INITIATIVE BOUNDARY governs everything
here: telic never owns time or transport — handlers run synchronously downstream
of a dispatch() call, never from queues, timers, retries, or transports.

1. Handler registries are PER-RUNTIME (revised per D18; supersedes the v1
   module-level-only design). Module-level `handle(name, handler)` registers
   in a module handler registry that follows the DEFAULT runtime with the same
   late-bound semantics as S10.4/S10.5 — declarations survive
   `configureDefaultRuntime` (re-applied onto the new runtime; parked-dispatch
   queues do NOT survive a configure — the old runtime's attempts belong to
   it). Explicit runtimes get their own isolated mediation world via
   `createMediator(runtime): { handle, dispatch, command }` — nothing shared
   with the module world (test isolation by construction). `handler:
   (attempt, payload) => Promise<{ ok: boolean; data?; error? }>` — settlement
   follows run() semantics (S3.12). `handle` returns an unregister fn (also
   disposable). ONE handler per name PER REGISTRY: re-registering fires
   diagnostic `handler-replaced` and last-wins (fan-out stays on()'s job).
   ONE mediator per runtime is the supported shape: a second mediator on the
   same runtime keeps its own registry but the LAST mediator's registry drives
   that runtime's `handled` probe. Do not `createMediator(currentRuntime())` —
   the default runtime is mediated by the module-level API; a shadowing
   mediator's probe lasts only until the next configure.
2. `dispatch(name, payload, opts?)` returns the `Attempt` immediately; the
   handler runs async. Begin mechanics: uses the existing module declaration's
   config when one exists, else begins undeclared (config-less) — dispatch
   NEVER fires `duplicate-intent`. The handler is invoked inside
   `within(attempt)` so its own begins are parented.
3. No handler registered → the attempt is begun and immediately rejected with
   reason `{ code: "TELIC_NO_HANDLER" }` + diagnostic `no-handler`. Dispatch
   still returns the attempt (observable failure, never a throw).
4. Handler throw → attempt rejected with the thrown value, NOT rethrown to the
   dispatcher (dispatch is decoupled; the dispatcher observes via
   `attempt.settled`, which never rejects).
5. Silent mode: dispatch returns an inert attempt and the handler is NOT
   invoked (mediation is off wherever recording is off — SSR safety).
6. New diagnostics: `handler-replaced`, `no-handler` (added to the Diagnostic
   union in types.ts).
7. Parked dispatch (the race-absorber for presence-based registration, P10b):
   `dispatch(name, payload, { ifUnhandled: "park", abandonWhen? })` — when no
   handler is registered, the attempt STAYS ACTIVE (truthful: the intent is
   pending) and the dispatch is parked in FIFO order per intent name. A later
   `handle(name, …)` drains that name's parked dispatches in order,
   synchronously downstream of the registration call (initiative boundary
   intact: no timers, no queues across time — the caller bounds the wait via
   `abandonWhen`, and navigation/unmount auto-abandon apply as usual). A
   parked attempt that abandons (signal, navigation, dispose) leaves the park
   queue. Default remains `ifUnhandled: "reject"` (S15.3). Parking in silent
   mode: inert attempt, nothing parked. The `no-handler` diagnostic does NOT
   fire for parked dispatches (parking is intentional); a drained dispatch
   executes exactly like S15.2.
8. `command(name)` — the typed stub factory (D18): returns a callable
   `(payload, opts?) => Attempt` that delegates to `dispatch(name, payload,
   opts)`. Purpose is DX, not semantics: the OWNING domain exports the stub
   from its contract subpath, call sites import the stub — jump-to-definition
   lands on the contract, the name string lives in exactly one place, and
   registry typing flows through the stub's signature. `createMediator`'s
   `command` binds to that mediator's registry; the module-level `command`
   binds to the default-runtime world.

## S12 amendment (descriptor invokability)

5. `IntentDescriptor` gains `handled: boolean` — true while a handler is
   currently registered for the name (live value at describe() call time, so
   presence-based registration is visible to agents before they dispatch).
   Revised per D18: `handled` reflects THE RUNTIME'S OWN mediation registry —
   the default runtime reports the module-world registry; an explicit runtime
   reports its own `createMediator` registry (false everywhere when it has
   none). A runtime can no longer advertise capabilities it cannot dispatch.

## S16. Flow — the saga coordinator as a value (src/flow.ts)

1. `flow(name, payload, opts, steps)` records a parent attempt (keyed per
   opts.key with dedupe semantics per S2.4) and runs `steps` SEQUENTIALLY,
   each as a child attempt parented to the flow attempt. Returns a promise of
   `{ ok: true, outcomes } | { ok: false, step, reason }` that never rejects.
2. `step(intentName, fn, opts?)` — `fn(ctx, attempt)` where `ctx` accumulates
   prior steps' outcomes by step intent name and `attempt` is the CHILD
   attempt (its id is the caller's Idempotency-Key material). fn returns
   run()-style `{ ok, data?, error? }`; child settlement follows S3.12
   mapping; fn throw = rejection.
3. Child attempts get `key` = `<flow key>:<step intent>` when the flow has a
   key. The begun mark and AttemptView now carry the optional `key` (core
   change, S2.1 amended) so resume queries are possible.
4. `skipIfFulfilled: true` on a step: before running, if memory holds a
   FULFILLED attempt of that step intent with the same key, the step is
   skipped — its recorded outcome (from the fulfilled attempt's view) is fed
   into ctx and NO new child attempt is begun. Without a flow key,
   skipIfFulfilled is inert (no identity to match on).
5. A step rejection rejects the FLOW attempt with `{ step, reason }`; remaining
   steps never begin. Steps already fulfilled stay fulfilled (compensation is
   the app's business — telic records, the caller reconciles).
6. Flow takes no initiative: no retries, no timers, no parallelism in v1.
   Resume = the caller invokes flow() again with the same key; fulfilled
   children (per S16.4) skip. Cross-reload resume requires the persistence
   tap (future phase) — without it, skip-matching is same-session only.
   Document this honestly.

## S11. Purity & environment constraints

1. No `window`/`document`/`navigation` access at module scope. Import must be
   free of ENVIRONMENT side effects (SSR + test safety) — internal,
   environment-free wiring between the library's own modules (e.g. mediate.ts
   feeding core's handled-probe) is permitted.
2. Zero runtime dependencies. No console.*, no Date.now/Math.random except as
   documented defaults resolved at runtime-creation time.
3. Everything conforms to `src/types.ts` — no `any`, no `as` (except
   `as const`), explicit return types, isolatedDeclarations-clean.

## S18. Persistence tap (src/persist.ts)

1. `connectStorage(runtime, opts): () => void` — opts: `storage: "session" |
   "local" | Pick<Storage, "getItem" | "setItem" | "removeItem">`, `key?`
   (default "telic:tape"), `enabled?: () => boolean` (storage-classification /
   consent hook, checked per write AND at restore), `maxMarks?` (default 200),
   `resume?: readonly IntentPattern[]`.
2. WRITE path: a tap persisting the rolling tail of marks (≤ maxMarks) after
   each mark, serialized via the wire format (S19). All marks are written —
   telic applies no egress filtering (D30); scoping what a storage tap persists
   is the caller's job at wiring time (`send`/pattern filters). Storage
   write failures (quota, disabled) are swallowed to a diagnostic
   (`tap-error`, tap id "persist") — persistence must never break the app.
3. RESTORE path (runs once inside connectStorage, before the tap attaches):
   parse via the wire schema (malformed/stale → dropped silently, storage
   cleared); valid marks are `ingest()`ed with `origin.restored: true`.
   Attempts that were ACTIVE in the restored tape: those matching a `resume`
   pattern are resurrected as active; all others are settled as
   `abandoned({ why: "navigation" })` at restore time.
4. Restored marks count toward memory queries exactly like live marks
   (distinguishable via `origin.restored`).
5. The uninstall fn detaches the tap and stops writes; it does not clear
   storage. `clearPersistedTape(storage, key?)` is exported for explicit
   erasure (GDPR delete paths).

## S19. Wire format (src/wire.ts)

1. Hand-rolled structural validators (ZERO deps — no zod): `parseMark(value):
   Mark | undefined` and `parseWirePayload(json: string): readonly Mark[]`
   (tolerant: skips invalid entries, returns [] on garbage). Validates kind
   discriminants, required fields per kind, primitive types; payload/outcome/
   reason/data pass through as unknown (they are already post-transform).
2. `serializeMarks(marks): string` — JSON, versioned envelope `{ v: 1, marks }`;
   parse rejects unknown versions (forward-compat: better to drop than
   misread).
3. Used by persist (S18) and future transports; core never imports wire.

## S20. TanStack Query adapter (src/adapters/tanstack-query.ts)

1. Structural peer only — NO @tanstack import in src (types defined
   structurally; @tanstack/query-core is a devDependency for tests only).
2. `linkMutationCache(runtime, cache, opts?): () => void` — subscribes to a
   MutationCache-shaped `{ subscribe(cb): () => void }`. For mutation events
   whose mutation carries `meta.attempt` (an AttemptId) OR that begin while an
   ambient attempt is current: emits `linked` marks `{ kind: "mutation",
   mutationKey, status }` on that attempt for observed status transitions.
3. RETRY SEMANTICS (the D17 question, decided): React Query's INTERNAL
   retries are execution detail, not user intent — they surface as `noted`
   marks (`{ retry: n }`) on the ONE attempt. `retryOf` chains are reserved
   for USER-initiated retries (a new begin the app records).
4. `settleFromMutation(attempt, opts?)` — returns `{ onSuccess, onError,
   onSettled }` callbacks an app spreads into mutation options: success →
   fulfill (data as outcome only when the intent declared a fulfilled
   schema), error → reject. First-write-wins as always.
5. Never wires cancellation automatically (attempt.signal → query
   cancellation is the app's explicit choice; document the one-liner).

## S21. Testing subpath (src/testing.ts)

1. RUNNER-AGNOSTIC: no bun:test / vitest / jest imports — pure functions and
   factories usable under any runner.
2. `createTestRuntime(opts?)` → `{ runtime, clock: { now, advance(ms),
   set(ms) }, nextId, diagnostics: Diagnostic[] }` — deterministic clock
   (start 1000), counter ids ("t1", "t2", …), diagnostics collected.
3. Assertion HELPERS return data, never throw assertions: `marksOf(runtime,
   pattern?)`, `attemptsOf(runtime, pattern?)`, `phaseOf(runtime, attemptId)`,
   `serializeTape(runtime)` (stable, sorted-key JSON for snapshot testing —
   seq/at/ids included since the test runtime is deterministic).
4. Ships in the published package (subpath ./testing); zero size impact on
   other entries (size gate covers it separately).

## S17 amendment (parity introspection)

7. `createAnalyticsTap` accepts `trace?: (event: { mark: Mark; ruleIndex:
   number; action: "sent" | "emitted" | "deduped" | "denied" | "buffered" |
   "flushed" | "skipped-when" }) => void` — called for every rule/mark
   decision. Zero cost when absent. This is the CI-assertable mark→rule→action
   record that makes migration parity provable without watching live sinks.

## S1 amendment (HMR)

3-revised. Re-declaring an already-declared name fires `duplicate-intent`
   ONCE PER NAME per runtime (not per re-declaration) — hot-module-reload
   re-evaluation must not train developers to ignore diagnostics. First
   declaration's config still wins (S12.1 unchanged): the handle RETURNED by a
   re-declaration is built from the FIRST declaration's config (tags, schemas),
   NOT the freshly-passed one — so `describe()` (which reads the frozen first
   meta) and the live handle can never diverge (D26). A second call with a
   different config only shapes the caller's static type; runtime behavior is
   unchanged.

## S22. Cross-tab transport — BroadcastChannel (src/transports/broadcast.ts)

1. `connectBroadcastChannel(runtime, opts?): () => void` — opts: `channel?`
   (name, default "telic"), `send?: readonly IntentPattern[]` (default all),
   `accept?: readonly IntentPattern[]` (default all), `tab?: string` (this
   tab's id for origin stamping; default from the runtime id generator),
   `channelFactory?` (structural `{ postMessage, addEventListener/onmessage,
   close }` for tests; default `new BroadcastChannel(name)` feature-detected —
   absent → inert + one `tap-error`-family diagnostic).
2. Outgoing: a tap serializing matching LOCAL marks (never marks that already
   carry a foreign `origin` — loop safety) via the wire format, stamped
   `origin.tab`. Which marks are forwarded is the caller's `send` filter — telic
   applies no egress policy of its own (D30).
3. Incoming: wire-parse (tolerant), filter by `accept`, `runtime.ingest()`.
4. Disconnect closes the channel and detaches the tap.

## S23. Cross-app transport — postMessage (src/transports/post-message.ts)

1. `connectWindow(runtime, opts): () => void` — opts: `target` (structural
   `{ postMessage(data, targetOrigin) }`), `targetOrigin: string` (REQUIRED,
   never defaulted, "*" rejected with a thrown TypeError at connect —
   construction-time author error), `accept: (origin: string) => boolean`
   (REQUIRED — mandatory allow-listing), `listen?` (structural event source
   for incoming message events; default window, feature-detected), plus
   send/accept pattern filters and `app?` origin stamp as in S22.
2. Same wire/loop-safety semantics as S22; incoming events are
   dropped unless `accept(event.origin)` passes.

## S24. Cross-tab hub — SharedWorker (src/transports/shared-worker.ts)

1. Two halves, both structurally injected and unit-testable with fake ports:
   `createTapeHub(runtime): { connect(port) }` — runs INSIDE the worker,
   owning an authoritative runtime: ingests marks arriving from any port,
   re-broadcasts them to every OTHER port, and answers `{ type: "snapshot" }`
   requests with the hub runtime's `memory.snapshot()` (the authoritative
   cross-tab answer BroadcastChannel gossip cannot give).
2. `connectSharedWorker(runtime, opts): { disconnect(): void;
   requestSnapshot(): Promise<MemorySnapshot> }` — client half; opts: `port`
   (structural MessagePort) or `workerFactory?` (default
   `new SharedWorker(url).port`, feature-detected → inert + diagnostic when
   absent), send/accept patterns, `tab?` stamp. Outgoing/incoming semantics
   as S22 (wire + loop safety).
3. No timers, no reconnection logic (initiative boundary): a dead port is the
   app's problem to reconnect.

## S25. XState adapter (src/adapters/xstate.ts)

1. Structural only — no xstate import in src (xstate ^5 is a devDependency
   for tests). Works against the v5 inspection API shape.
2. `createIntentInspector(runtime): (event) => void` — pass as
   `createActor(machine, { inspect })`; `@xstate.snapshot`/transition events
   for actors REGISTERED via bindActor produce `linked` marks
   `{ kind: "xstate", actorId, state, event }` on the bound attempt (ingest
   path, same mechanism as the TanStack adapter). Unregistered actors are
   ignored (no ambient fallback here — machine lifetimes outlive call stacks).
3. `bindActor(attempt, actorRef): () => void` — registers actor identity
   (sessionId) → attempt; returns unbind.
4. `settleFromMachine(attempt, actorRef, map): () => void` — map:
   `Record<stateValueString, { fulfill?: (context) => unknown } | { reject?:
   (context) => unknown }>`; subscribes to the actor, settles the attempt on
   entering mapped states (first-write-wins protects races); returns
   unsubscribe.
5. The `map` lookup is an OWN-property read. A machine state whose name
   collides with an `Object.prototype` key (`toString`, `constructor`,
   `__proto__`, `valueOf`, …) and is not present in `map` is treated as
   unmapped — the attempt stays active, the subscription is untouched, and
   nothing throws — upholding the adapter's "degrades to observing nothing
   rather than crashing" doctrine for any state name (D27).

## S26. Devtools overlay (src/devtools.ts)

1. `mountOverlay(runtime, opts?): () => void` — a plain-DOM panel (no
   framework) showing `inProgress()` and a tape tail (last ~50 marks),
   updating via a tap. `opts`: `container?` (default document.body,
   feature-detected → inert), `hotkey?` (default none — the HOST decides
   visibility; when set, toggles panel display).
2. TRUSTED-TYPES SAFE: built exclusively with createElement/textContent —
   the string "innerHTML" must not appear in the module.
3. Styles inline on elements (no stylesheet injection); everything namespaced
   `data-telic-devtools` so hosts can restyle or purge.
4. Intended for dev builds; costs nothing unless mounted. Unmount fn removes
   the panel and detaches the tap.

## S27. OpenTelemetry tap (src/taps/otel.ts)

1. Structural injection — NO @opentelemetry import: `createOtelTap(opts)`
   with `tracer: { startSpan(name, opts?): SpanLike }` where SpanLike =
   `{ setAttribute(k, v); addEvent(name, attrs?); setStatus(s); end(t?) }`.
2. begun → startSpan(`intent:<name>`) with attributes (telic.attempt_id,
   telic.intent, telic.key when present); noted → addEvent; fulfilled →
   setStatus OK + end; rejected → setStatus ERROR + end; abandoned →
   setStatus OK + attribute telic.abandoned=why + end. Span timestamps use
   mark.at where the SpanLike accepts one.
3. Spans for attempts whose begun mark was ring-evicted before settle: the
   terminal mark without a live span is a silent no-op (mirror of S13.3).
4. `noted` data flattens to span-event attributes ONLY when it is a PLAIN
   object whose own values are all primitives (string/number/boolean); a plain
   `{}` yields an empty event. Any non-plain object (Date, RegExp, Map, Set,
   class instance) — whose enumerable OWN values are empty, which would
   otherwise flatten to an empty attribute bag and silently drop its state —
   takes the JSON-string fallback instead, preserving the value.
