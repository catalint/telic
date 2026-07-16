# telic — choosing your approach

Every axis where the library offers more than one way to do something, with
honest pros/cons and a default. SPEC.md defines exact semantics; DESIGN.md the
reasoning; PATTERNS.md worked examples. Features marked **(planned)** are
designed but not yet shipped — everything else exists today.

**The short version:** start record-only with `run()`, add `on()` observers
where other domains need to react, reach for `dispatch`/`flow` only at real
domain boundaries, and let everything else be the default.

---

## 1. How a lifecycle gets recorded

| Approach | Pros | Cons | Choose when |
|---|---|---|---|
| **`run()`** — wrap the Result-returning operation | Settlement by construction (ok→fulfilled, err→rejected, throw→rejected+rethrow); can't forget to settle; least code | One operation per attempt; awkward when the lifecycle spans multiple functions or user interactions | **Default.** Any intent that maps to one async operation |
| **Manual `begin()` / `fulfill()` / `reject()` / `abandon()`** | Full control; lifecycles spanning handlers, steps, time; access to `note()`/`link()` mid-flight | Drift risk — forgotten settles create zombies (mitigated by auto-abandon on unmount/navigation and `double-settle` diagnostics, but the risk is yours) | Multi-interaction lifecycles (wizards, modals), or when fulfill/reject sites live in different callbacks |
| **`handle()` + `dispatch()`** — lifecycle via the mediation layer | Lifecycle complete by construction; the intent is also invokable cross-domain and by agents | Requires the mediation layer's discipline (one handler, registration availability — §3); indirection where a direct call may be clearer | The capability is genuinely dispatched across a boundary (§2) — never *just* to get recording |
| **Adapters (XState, TanStack Query)** *(planned)* | Lifecycle derived from machinery you already trust; zero drift; provenance links for free | Couples recording fidelity to the adapter's mapping; you still name the intents yourself (adapters link, never auto-declare) | The flow is already a machine / the operation is already a mutation |

## 2. How domains interact (the coupling ladder)

Climb only as far as you need; each rung trades clarity for decoupling.

| Rung | Mechanism | Pros | Cons | Choose when |
|---|---|---|---|---|
| 1 | **Direct import** (no telic involved in the call) | Typed end-to-end, jump-to-definition, zero indirection | Compile-time coupling | **Default inside a domain.** Your own code calls your own functions |
| 2 | **`on()` observation** | Reactions without the observed domain knowing; `replay` fixes mount-order races | One-way, after-the-fact; observers can't influence the flow (by design) | Periphery: headers, toasts, analytics, nudges reacting to another domain's intents |
| 3 | **`dispatch()` command** | Invoke a capability without importing its module; agents can call it; typed via the registry | Stringly-typed at the call site; availability becomes a topology question (§3); one more indirection to debug | Real domain boundaries: separately-owned modules, micro-frontends, agent invocation |
| 4 | **`flow()`** | Multi-domain saga with recorded children, keyed resume, idempotency-key material — coordinator stays explicit | Sequential only (v1); resume needs keys + fulfilled schemas; cross-reload resume needs the persistence tap *(planned)* | Multi-step submissions crossing 2+ domains (checkout-shaped problems) |

Anti-rungs: choreographing a money path over `on()` (AP3) and dispatching
within your own domain (AP4).

## 3. Where handlers live (availability in a code-split world)

| Approach | Pros | Cons | Choose when |
|---|---|---|---|
| **Commands eager, UI lazy** — thin handler modules statically imported at bootstrap | Handler always present; no races; pure static imports; keeps command layers honest (fat = UI leaked in) | Commands load for pages that never use them (cheap if truly thin) | **Default.** Page-independent capabilities: auth, consent, account ops |
| **Presence-based** — islands/components register on mount, unregister on unmount | Availability truthfully mirrors the page; agents see live `describe().handled`; zero eager cost | "No handler" now depends on hydration timing → pair with parking for races | UI-coupled capabilities: cart, editors, anything meaningless without its surface |
| **Parked dispatch** — `ifUnhandled: "park"` + caller-owned `abandonWhen` deadline | Absorbs hydration-order races without library timers; parked attempts are truthfully `active` and auto-abandon on navigation | A deadline is on you (an unbounded park lives until navigation); FIFO drain means order, not priority | The bridge for presence-based registration; NOT a substitute for eager registration of always-on capabilities |
| ~~Dynamic import inside the handler~~ | — | Hides an availability fact behind a loading trick | Never (see P10) |

## 4. Subscription history: `replay` or not

| | Pros | Cons | Choose when |
|---|---|---|---|
| **`replay: true`** | Late-mounting subscribers hear the past; mount-order becomes irrelevant | Historical marks re-fire your listener — double-triggers work that mount already did | The listener's work is NOT already done by mount-time initialization |
| **No replay (default)** | No double-fires | Subscriber is blind to anything before it mounted | Mount already resolves fresh state (e.g. a session hook that reads storage on mount) |

## 5. Concurrent attempts of the same intent

| `onConflict` | Semantics | Choose when |
|---|---|---|
| **`"concurrent"`** (default, no key) | Every begin is a fresh attempt | Independent instances: three file uploads |
| **`"dedupe"`** (default with a key) | A live keyed attempt is returned as-is — double-submit becomes unrepresentable | Submissions: checkout, forms, anything a double-click could duplicate |
| **`"supersede"`** | New begin abandons the previous keyed attempt (and aborts its `signal` → in-flight fetch cancels) | Latest-wins operations: search-as-you-type, filter changes |

## 6. Runtime scoping

| | Pros | Cons | Choose when |
|---|---|---|---|
| **Module-level default runtime** (`intent`/`on`/`memory` from the package root) | One shared tape across every chunk; late-bound (ES-module evaluation order can never orphan handles); SSR-silent automatically | One world per page — fine for apps, wrong for libraries embedding telic privately | **Default for applications** |
| **Explicit `createRuntime()`** | Isolated tape; injectable clock/id (deterministic tests); embeddable | Handles bound to that runtime forever; no late binding; you wire your own taps/lifecycle | Tests (always), and libraries/hosts embedding a private intent world |

## 7. Typing the taxonomy

| | Pros | Cons | Choose when |
|---|---|---|---|
| **Progressive (no registry)** | Zero setup; unregistered names legal, typed `unknown` | Cross-domain `on()`/`memory` payloads are `unknown` | Prototyping; single-domain use where local inference (from `intent()` schemas) is enough |
| **`IntentRegistry` augmentation** | Fully typed cross-domain `on()`/`dispatch`/`memory`, wildcard unions included; each domain contributes its own entries | Declaration-merging (the one sanctioned merge); global — one type-world per app | **Default for multi-domain apps** |
| **`createRuntime<R>()` generic** | Typed without global augmentation; several typed worlds coexist | Types don't flow to the module-level API | Embedders using explicit runtimes |

## 8. Memory durability

| | Pros | Cons | Choose when |
|---|---|---|---|
| **In-memory (default)** | Zero setup; nothing sensitive ever touches storage | Reload wipes the tape — `flow` resume is same-session only | Default; anything whose payloads are sensitive (pair with `exposure: "local"`/`"private"`) |
| **Persistence tap** *(planned)* | Cross-reload memory; resumable flows after a crash/reload; `origin.restored` marks distinguish restored context | Storage classification/consent duties; redaction hygiene becomes load-bearing | Long flows worth resuming across reloads — the checkout case |

## 9. Consumption surfaces (not either/or — these stack)

| Surface | What it's for | Caution |
|---|---|---|
| **Taps** (Sentry, analytics, User-Timing, console) | Push every mark into an external system as it happens | Taps run synchronously — keep them cheap; heavy work self-defers |
| **Memory queries** (`last`/`has`/`inProgress`/`attempts`) | The running app asking about behavior ("already tried X?") | Secondary, degradable surfaces only — never primary UI correctness (AP2) |
| **Projections** (`project`) | Continuously-folded derived state (counters, funnels, devtools models) | Reducers must be cheap and total; a throwing reducer skips that mark |
| **Agent surface** (`window.__INTENT_MEMORY__`) | Machine-legible read access for copilots, test explorers, WebMCP pairings | Read-only by design; everything on it is post-redaction — keep `redact`/`exposure` honest upstream |
