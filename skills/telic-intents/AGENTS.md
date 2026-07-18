# telic Intent Patterns — Compiled Rules

This document is mainly for agents and LLMs to follow when maintaining,
generating, or refactoring frontend codebases that use `@telic/core`. It is a
distillation of [PATTERNS.md](../../packages/core/PATTERNS.md), which is the
source of truth — when the two disagree, PATTERNS.md wins and this file has
drifted (the repo's conventions gate checks the references below stay real).

---

## 1. Intent Modeling (HIGH)

### model-lifecycle-litmus-test

Ask of every candidate intent: *what does `rejected` mean for it? when would
it be `abandoned`?* No answer means you are naming a state mutation, not a
user intent — do not declare it. Source: PATTERNS P1, AP1; diagnostic
`setter-like-name`.

```ts
// ❌ names a mutation — the tape becomes a SET_LOADING action log
intent("ui.setModalOpen", { payload: z.object({ open: z.boolean() }) })

// ✅ names a goal: rejection = card declined, abandonment = user walked away
const checkout = intent("checkout.submit", { payload, rejected })
```

Correction when the test fails: find the goal the mutation serves
(`checkout.submit`, `support.openChat`) — or accept it is not an intent and
don't record it.

### model-abandoned-is-not-rejected

A user closing a prompt or walking away did not *fail*. Settle `abandon()`
and `reject()` differently — funnels, support tooling, and copilots need the
distinction, and it is the one state incumbent tools cannot express in real
time. Source: PATTERNS P4.

```ts
// ✅ the WebAuthn shape
catch (err) {
	if (isUserCancelled(err)) attempt.abandon({ why: "user", detail: "cancelled" })
	else attempt.reject({ code: classify(err) })
}
```

### model-classifications-not-identities

telic records payloads verbatim and forwards them everywhere (breadcrumbs,
storage, transports, agents) — there is no downstream scrubbing seam. Design
payloads to carry classifications, never identities or secrets. Source:
PATTERNS AP7.

```ts
// ❌ raw PII onto the tape, hoping a tap filters it
login.begin({ email: user.email })

// ✅ the classification, not the identity
login.begin({ method: "email" })
```

---

## 2. Recording (HIGH)

### record-run-over-manual-pairs

Prefer `intent.run(payload, fn)`: it cannot forget to settle, sync throws
become rejections, and unmount abandons. Manual `begin()`/`fulfill()` pairs
are legal only when the lifecycle genuinely spans multiple functions. Source:
PATTERNS P2.

```ts
// ✅ settlement by construction
await renewDomain.run({ domainId }, () => api.renewDomain(domainId))
```

### record-memory-is-not-truth

Never render primary UI from attempt state — memory is bounded and evictable,
and using it as truth turns telic into a second state manager (the design's
named trap). Nudges, devtools, and copilot hints MAY read memory; that is
what it is for. Source: PATTERNS AP2.

```ts
// ❌ memory as truth
const disabled = memory.has("checkout.submit", { phase: "active" })

// ✅ the button's state lives in component/store state; the attempt records
```

### record-cancellation-from-identity

One `key` + `onConflict` + `attempt.signal` express supersede-and-abort;
never hand-roll AbortController choreography beside telic. Source: PATTERNS P3.

```ts
// ✅ superseding the previous search aborts its fetch
const attempt = search.begin({ q }, { key: "search", onConflict: "supersede" })
const res = await fetch(url, { signal: attempt.signal })
```

### record-attempts-are-page-scoped

An attempt begun on one page cannot be settled after a hard navigation — it
auto-abandons, correctly. Each page owns a full lifecycle, unless the
persistence tap with `resume` patterns is wired. Begin-then-redirect is fine
only when abandonment is the true semantic (OAuth). Source: PATTERNS AP6.

### record-bind-to-whole-territory

`boundTo` abandons attempts whose URL pattern no longer matches on soft
navigation. Scope it to the flow's whole territory (`/wizard/*`) or omit it —
never to a single step of a wizard that navigates between its own steps.
Source: PATTERNS AP8.

---

## 3. Mediation (MEDIUM)

### mediate-dispatch-only-across-boundaries

Within your own domain, call your own functions — dispatch there is
stringly-typed indirection with broken jump-to-definition. `dispatch` exists
for crossing domain boundaries (separately-owned modules, micro-frontends)
and for agents. Without recording or an agent surface in the picture, a DI
container gets the same decoupling, typed. Source: PATTERNS P7, AP4.

```ts
// ❌ same domain, same module — a plain import was clearer and typed deeper
dispatch("billing.calculateTotal", cart)

// ✅ a real boundary: domain A invokes what domain B owns, without importing B
const attempt = dispatch("cart.addItem", { sku })
```

### mediate-one-handler-no-state

Exactly one executor per capability (re-registration is last-wins with
diagnostic `handler-replaced`; fan-out belongs to `on()`). Handlers call the
domain's real store or API and return outcomes — a handler that accumulates
state has hidden domain state inside the mediation layer where nothing can
render or persist it. Source: PATTERNS AP5.

```ts
// ❌ the handler is now a store
let cartItems = []
handle("cart.addItem", async (a, p) => { cartItems.push(p); return { ok: true } })
```

### mediate-presence-is-honesty

Treat handler availability as an honesty problem, not a loading problem.
Page-independent capabilities: register from a statically-imported, thin
command module (commands eager, UI lazy — a command layer too fat to load
eagerly has UI leaked into it). UI-coupled capabilities: register on mount,
unregister on unmount, so "no handler" is a truthful fact dispatchers and
agents can learn. Absorb hydration races with parked dispatch
(`ifUnhandled: "park"` + a caller-owned `abandonWhen` deadline). Never fake
availability with a dynamic import inside a handler body. Source: PATTERNS P10.

### mediate-contract-subpaths

Cross-package invocation goes through a types-only contract subpath
(`@acme/checkout/intents`): it declares the domain's intents, augments
`IntentRegistry`, and exports `command()` stubs — consumers import the
contract, never the implementation. Exactly one file may declare a scope's
registry entries; enforce with `@telic/lint`'s `scope-ownership` rule, since
TypeScript declaration merging will not detect ownership collisions. Source:
PATTERNS P12.

---

## 4. Flows & Reactions (MEDIUM)

### flow-coordinator-never-choreography

A money path gets one explicit coordinator — `flow()`, a state machine, or a
plain async function — never a chain of `on()` reactions where no single
place answers "what happens next". `on()` serves the periphery (headers,
toasts, analytics) reacting to a flow, never driving it. Source: PATTERNS P8,
AP3.

```ts
// ❌ checkout "decoupled" into implicit event chains
on("identity.register", (e) => { if (e.mark.kind === "fulfilled") address.begin(…) })

// ✅ order and data flow stay in one place; telic contributes the saga log
await flow("checkout.submit", cart, { key: cart.id }, [
	step("identity.register", (ctx, a) => api.register(cart.user, { idempotencyKey: a.id })),
	step("order.place", (ctx, a) => api.placeOrder(ctx["address.create"], { idempotencyKey: a.id })),
])
```

The server must honor the idempotency keys — the client log informs resume;
the server makes replays safe.

### react-replay-for-late-subscribers

Use `on(pattern, fn, { replay: true })` when mount order is undefined
(islands, micro-frontends) and the subscriber needs history. Skip replay when
mount already resolves fresh state — it would double-trigger work. Source:
PATTERNS P5.

### analytics-declare-once

Declare funnels as rules over intents with `once: "per-intent"` /
`"per-attempt"` — the mechanical replacement for hand-maintained fired-event
sets persisted across reloads. Identity stitching and vendor dedup ids stay
in the rule's `map`/`when`; the tap kills dispatch boilerplate, not vendor
semantics. Source: PATTERNS P6.

---

## 5. Environment (MEDIUM)

### env-server-joins-never-records

telic does not run on the server, on purpose — semantic tracing there belongs
to OpenTelemetry, durable sagas to workflow engines, and a server-module
singleton would interleave concurrent users' tapes (SSR mode is silent for
this reason). The server *joins* the client's intent timeline instead: the
attempt id already travels as the Idempotency-Key header; stamp it into the
server's existing observability. Source: PATTERNS P11, AP9.

```ts
// ✅ ~3 lines of middleware, no telic import
const attemptId = req.headers["idempotency-key"]
if (attemptId) trace.getActiveSpan()?.setAttribute("telic.attempt_id", attemptId)
```

### env-one-shared-instance

Every island/MFE must resolve the SAME loaded copy of `@telic/core` — two
copies mean two tapes and two mediation registries that each hear half the
app. Declare it a shared singleton (Module Federation
`shared: { "@telic/core": { singleton: true } }`; import-map externals for
single-spa) and wire `onDiagnostic` for diagnostic `duplicate-instance`, the
runtime tripwire that fires when a second copy boots. The build config is the fix;
the diagnostic is the alarm. Source: recipe
[micro-frontends.md](../../packages/core/docs/recipes/micro-frontends.md).

### env-agent-surface-is-read-only

Expose behavioral state to agents through the frozen read surface —
`describe()` answers "what can be intended here" (including caller-declared
`agent.input` payload shapes), `inProgress()` answers "what is the user
mid-way through". Agents *invoke* through `dispatch`; the surface itself
never mutates. Everything on the tape is visible here, so
`model-classifications-not-identities` is a precondition, not a suggestion.
Source: PATTERNS P9.

