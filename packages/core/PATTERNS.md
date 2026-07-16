# telic — patterns and anti-patterns

Worked examples of using the library well, and the misuses the design warns
against — each anti-pattern with the failure it causes and the correction.
DESIGN.md holds the reasoning; SPEC.md the exact semantics.

## Patterns

### P1. The lifecycle litmus test (before you declare anything)

Ask of every candidate intent: *what does `rejected` mean for it? when would
it be `abandoned`?* If there is no answer, you are naming a state mutation,
not a user intent.

```ts
// ✅ passes the test: rejection = card declined, abandonment = user walked away
const checkout = intent("checkout.submit", { payload, rejected })

// ❌ fails the test: what is a rejected setLoading? (see AP1)
```

### P2. `run()` over manual pairs — settlement by construction

```ts
// ✅ can't forget to settle; sync throws become rejections; unmount abandons
await renewDomain.run({ domainId }, () => api.renewDomain(domainId))

// ⚠️ legal but drift-prone — only when the lifecycle spans multiple functions:
const attempt = renewDomain.begin({ domainId })
…
attempt.fulfill({ expiresAt })
```

### P3. Cancellation wired to meaning

```ts
const attempt = search.begin({ q }, { key: "search", onConflict: "supersede" })
const res = await fetch(url, { signal: attempt.signal })
```

Superseding the previous search aborts its fetch; navigating away abandons the
attempt and aborts it too. One identity (`key`) + one signal, no hand-rolled
AbortController choreography.

### P4. Abandoned ≠ rejected (the WebAuthn example)

```ts
try {
	const cred = await navigator.credentials.get(opts)
	attempt.fulfill()
} catch (err) {
	if (isUserCancelled(err)) attempt.abandon({ why: "user", detail: "cancelled" })
	else attempt.reject({ code: classify(err) })
}
```

A user closing the passkey prompt did not fail — funnels, support tooling, and
copilots need the difference.

### P5. Late subscribers hear the past (`replay`)

```ts
// island hydrated seconds after login fulfilled elsewhere:
on("auth.login", refreshUser, { kinds: ["fulfilled"], replay: true })
```

Use `replay` when mount order is undefined (islands, micro-frontends) and the
subscriber needs history. Skip it when mount already resolves fresh state —
replay would double-trigger work (that is why the session hook does NOT use it).

### P6. Declare-once analytics with mechanical at-most-once

Declare the funnel as rules over intents; `once: "per-intent"` replaces
hand-maintained fired-event sets persisted across reloads. Identity stitching
and vendor dedup ids stay in `map`/`when` — the tap kills dispatch and dedup
boilerplate, not vendor semantics.

### P7. Dispatch across boundaries, imports within them

```ts
// domain B owns the capability:
handle("cart.addItem", async (attempt, payload) => addItem(payload))

// domain A (or an AI agent) invokes without importing B:
const attempt = dispatch("cart.addItem", { sku })
const outcome = await attempt.settled
```

Decision rule: **within your own domain, call your own functions; `dispatch`
exists for crossing domain boundaries and for agents.** (See AP4.)

### P8. The flow pattern — coordinator + saga log, never choreography

```ts
const result = await flow("checkout.submit", cart, { key: cart.id }, [
	step("identity.register", (ctx, a) => api.register(cart.user, { idempotencyKey: a.id })),
	step("address.create",    (ctx, a) => api.createAddress(cart.address, { idempotencyKey: a.id }), { skipIfFulfilled: true }),
	step("order.place",       (ctx, a) => api.placeOrder(ctx["address.create"], { idempotencyKey: a.id })),
])
```

Order and data flow are yours; telic contributes child attempts, keyed
skip-on-resume, and attempt-ids as idempotency keys. NOTE: `ctx` feeds from
each step's RECORDED outcome (so a fresh run and a skip-on-resume feed ctx
identically) — a step whose intent declares no `fulfilled` schema records a
void outcome and contributes `undefined` to ctx. If later steps consume a
step's data, declare a `fulfilled` schema on that step's intent. The server MUST honor
those idempotency keys — the client log informs resume, the server makes
replays safe. Compensation after a mid-flow rejection is app logic; the tape
tells you exactly which steps committed.

### P9. Machine-legible state for agents

`window.__INTENT_MEMORY__.inProgress()` answers "what is the user mid-way
through"; `describe()` answers "what can be intended here". Pair with WebMCP
tools (what an agent can *do*) for the full picture. The surface is a read-only
local reader — everything on the tape is visible here, so keep sensitive values
off the payload upstream (AP7).

### P10. Handler availability in a code-split world

Module-level `handle()` only runs when its module evaluates — and code-split
chunks evaluate lazily or never. Treat handler availability as an HONESTY
problem, not a loading problem. Two patterns, chosen by the capability's
nature:

**(a) Page-independent capabilities → commands eager, UI lazy.** What makes
domain chunks heavy is UI, not commands. Keep the command layer thin
(validate → call API → return Result) and register it from a statically-
imported module in the bootstrap graph:

```ts
// cart.handlers.ts — statically imports cart.api.ts (thin: fetch + Result)
import { addItem } from "./cart.api"
handle("cart.addItem", (attempt, payload) => addItem(payload, { idempotencyKey: attempt.id }))
```

If a command layer is too fat to load eagerly, UI logic has usually leaked
into it — the constraint is a design linter. (Redux relearned this with lazy
reducers in the `injectReducer` era: the registry must be cheap enough that
splitting it is never worth it.)

**(b) UI-coupled capabilities → presence-based registration.** When a
capability only makes sense with its UI on the page, register on mount and
unregister on unmount (the `handle()` unregister fn is the effect cleanup):

```ts
useEffect(() => handle("cart.addItem", cartHandler), [])
```

Then "no handler" is a TRUTHFUL statement — the capability isn't on this
page — which is exactly what dispatchers and agents should learn.
Hydration-order races (dispatch fires moments before the owning island
mounts) are what parked dispatch is for: `ifUnhandled: "park"` with a
caller-owned `abandonWhen` deadline, drained when `handle()` registers.

When neither pattern applies, `TELIC_NO_HANDLER` rejection is the floor —
loud, recorded, never a hang. Do NOT reach for a dynamic import inside the
handler body to fake availability of a chunk the page didn't load; that hides
an availability fact behind a loading trick.

## Anti-patterns

### AP1. Setter intents (the Redux failure, re-run)

```ts
// ❌ names a mutation, not a goal — memory fills with noise, taps emit garbage
intent("ui.setModalOpen", { payload: z.object({ open: z.boolean() }) })
intent("orders.updateCount", …)
```

Failure: the tape becomes as illegible as a `SET_LOADING` action log; every
consumer degrades at once. The `setter-like-name` diagnostic flags these; the
correction is to find the goal the mutation serves (`checkout.submit`,
`support.openChat`) — or to accept it is not an intent and not record it.

### AP2. Rendering primary UI from attempt state

```ts
// ❌ memory as truth
const disabled = memory.has("checkout.submit", { phase: "active" })
return <Button disabled={disabled} />
```

Failure: UI correctness now depends on an observability layer with bounded,
evictable memory — and telic has become a second state manager. Correction:
the button's disabled state lives in component/store state; the attempt
*records* the submission. (Nudges, devtools, copilot hints — secondary,
degradable surfaces — MAY read memory; that is what it is for.)

### AP3. Choreographing a money path over `on()`

```ts
// ❌ the checkout "decoupled" into implicit event chains
on("identity.register", (e) => { if (e.mark.kind === "fulfilled") address.begin(…) })
on("address.create",    (e) => { if (e.mark.kind === "fulfilled") payment.begin(…) })
```

Failure: no single place answers "what happens next"; ordering and error
handling scatter; partial failures strand users. Correction: one explicit
coordinator (P8's `flow`, an XState machine, or a plain async function).
`on()` is for the *periphery* — headers, toasts, analytics reacting to the
flow — never for driving it.

### AP4. Dispatch as a fashion statement

```ts
// ❌ same domain, same module — a plain import was clearer and typed deeper
dispatch("billing.calculateTotal", cart)
```

Failure: stringly-typed indirection, broken jump-to-definition, a runtime
registry standing in for the module system. Correction: P7's decision rule.

### AP5. Handlers that own state

```ts
// ❌ the handler is now a store
let cartItems = []
handle("cart.addItem", async (a, p) => { cartItems.push(p); return { ok: true } })
```

Failure: domain state hides inside the mediation layer where nothing else can
render or persist it. Correction: handlers *call* the domain's real store or
API and return outcomes; they never hold anything.

### AP6. Cross-page attempts without persistence

```ts
// ❌ begun on /login, "fulfilled" on /verify — the reload destroyed the attempt
const attempt = login.begin(…); location.href = "/verify"
```

Failure: the attempt auto-abandons at navigation (correctly), and the fulfill
on the next page settles nothing. Correction: each page owns a full lifecycle
(what the auth islands do), or wait for the persistence tap and resumable
attempts. Exception that is NOT a bug: begin-then-redirect where abandonment
is the *true semantic* (OAuth redirect — the outcome genuinely resolves
elsewhere).

### AP7. Putting secrets on the tape and trusting something downstream to scrub them

```ts
// ❌ raw PII into the payload, hoping a tap filters it
login.begin({ email: user.email })
```

Failure: telic records the payload verbatim and forwards it everywhere — there is
no scrubbing seam to lean on. The honest fix is upstream: design payloads to
carry classifications, not identities (`{ method: "email" }`, not the address).
The identity boundary is yours, not telic's (see DESIGN, "The data boundary") —
everything downstream (breadcrumbs, storage, agents, transports) inherits
whatever you let onto the tape.

### AP8. Blanket abandon-on-navigation for in-app flows

```ts
// ❌ boundTo on a wizard whose own steps are soft navigations
begin(p, { boundTo: new URLPattern({ pathname: "/wizard/step-1" }) })
```

Failure: the wizard abandons itself on every step change. Correction: scope
`boundTo` to the flow's whole territory (`/wizard/*`) or omit it — soft
navigation only abandons `boundTo`-violating attempts by design, precisely so
SPA wizards survive their own navigation.

### P11. Server correlation — a contract, not a port

telic does not run on the server, on purpose. Every pillar that differentiates
it in the browser already has a mature server-side owner: semantic tracing
belongs to OpenTelemetry (request-scoped context, W3C propagation, the APM
ecosystem); durable sagas belong to workflow engines (Temporal, Inngest,
queue flows) — which succeed precisely by OWNING time and transport, the
opposite of telic's initiative boundary. `abandoned` barely exists
server-side; requests complete or error, nothing walks away. And a server
module singleton spans concurrent users — recording there would interleave
strangers' tapes (which is why SSR mode is silent).

What the server CAN do — cheaply and uniquely — is JOIN the client's intent
timeline. The attempt id already travels on the wire as the Idempotency-Key
(P3/P8). A ~30-line middleware stamps it into whatever observability the
server already has:

```ts
// e.g. Express/Hono/Fastify middleware — no telic import, just the header
const attemptId = req.headers["idempotency-key"];
if (attemptId) {
	// OTel: joins the trace to the client's intent identity
	trace.getActiveSpan()?.setAttribute("telic.attempt_id", attemptId);
	propagation.getActiveBaggage(); // or: add attempt_id to baggage for downstream services
	// structured logs: every log line for this request carries the attempt id
	logger = logger.child({ attemptId });
}
```

Result: one identifier connects "user began checkout" (client tape) → "server
processed payment, retried twice, 800 ms" (OTel/APM) → "attempt rejected
card_declined" (client tape). No other tool offers that join, because no
other tool has a client-side attempt identity to join ON.

**Dev-mode variant — server marks flowing back into the tape:** a server can
return correlation breadcrumbs in a response header (JSON array of
`noted`-shaped entries carrying the attempt id); a small client fetch-wrapper
parses the header, builds marks via the wire format, and `runtime.ingest()`s
them with `origin: { app: "api" }` — the server's steps appear inline in the
client timeline, devtools, and the agent surface. Keep it dev-only (header
size; the server must apply the same
identities-never-on-the-tape rule as AP7).

### AP9. Porting telic to the server

```ts
// ❌ a Node runtime recording "server intents" into a process-wide tape
const runtime = createRuntime(); // one tape, every concurrent user
```

Failure: interleaved users, a worse OpenTelemetry, and — if flow() is used
for server sagas — a worse Temporal with no retries by design. Correction:
P11's contract. The server contributes correlation; its memory lives where it
already lives (traces, logs, the database).

### P12. Contract subpaths in compiled monorepos

A domain that wants to be `dispatch()`-invokable across a package boundary
(P7) has a typing problem plain JS doesn't: the caller only has the OTHER
package's COMPILED `.d.ts`, never its source — declaration merging
(`IntentRegistry`) and `command()` stubs have to survive that boundary, or
every cross-package caller falls back to an untyped string.

The convention (D18): each domain ships a TYPES-ONLY subpath —
`@acme/checkout/intents`, never `@acme/checkout` itself — that does exactly
three things: declares the domain's intents, augments `IntentRegistry`, and
exports `command()` stubs for the capabilities other domains may invoke.
Consumers import the contract; they never import the implementation.

```ts
// packages/checkout/src/intents.ts — the ONLY file allowed to augment "checkout.*"
import type { IntentTypes } from "@telic/core"
import { command } from "@telic/core/mediate"

declare module "@telic/core" {
	interface IntentRegistry {
		"checkout.submit": IntentTypes<{ cartId: string }, { orderId: string }, { code: string }>
	}
}

export const submitCheckout = command("checkout.submit")
```

```ts
// packages/support/src/widget.ts — a DIFFERENT domain, invoking across the boundary
import { submitCheckout } from "@acme/checkout/intents"

const attempt = submitCheckout({ cartId })
```

`support` gets a typed, jump-to-definition-able stub whose payload/outcome/
rejection types flow from the SAME declaration `checkout` runs against — no
hand-written `dispatch("checkout.submit", …)` string anywhere outside the
owning domain.

**Ownership: exactly one file per scope.** The contract file for a scope
(`checkout.*`) is the ONLY place that may declare `IntentRegistry` entries
under it. Two domains augmenting the same scope is a silent last-write-wins
merge TypeScript will not warn about — declaration merging combines
structurally, it doesn't detect ownership conflicts. `@telic/lint`'s
`scope-ownership` rule is the enforcement, not convention alone: configure
`"scopes": { "checkout": ["packages/checkout/**"] }`, and any `intent()` /
`handle()` / `command()` literal under `checkout.*` declared outside that
glob fails CI before it can collide.

**The mechanism is verified, not assumed.** Declaration merging across a
monorepo's SOURCE files is unsurprising; the property this pattern actually
depends on is that it still works once `@acme/checkout` is `tsc`-compiled to
`.d.ts` and consumed as an ordinary package dependency — bundlers and older
TS versions have a real history of mishandling cross-package augmentation.
Don't take that on faith: a CI consumer-matrix (a throwaway package that
installs the built tarball and imports the contract subpath under several
supported TS versions) is what actually proves the augmentation flows
through the compiled boundary — the same mechanism telic's own
`IntentRegistry` is checked against on every commit (DECISIONS D18/D19).

**Honest caveats.** The contract subpath is types-only by convention, not by
enforcement — nothing stops someone from re-exporting implementation from it
except review discipline; no lint rule catches that specific leak yet.
`command()` stubs are DX sugar over `dispatch()` (S15.8), not a typing
capability `dispatch()` lacks on its own — they just make the string name
disappear from call sites. The runtime behavior underneath, including a
`TELIC_NO_HANDLER` rejection when nothing has registered yet, is identical
either way.
