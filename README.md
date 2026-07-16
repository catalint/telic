# telic

**A recorded intent + memory layer for frontends.**

> A *telic* action is one with an intrinsic endpoint — exactly what a user intent is.

Your app already knows what the user is trying to do — it just forgets immediately.
The click handler knows it's a checkout; the analytics call knows it's a signup; the error
handler knows something was mid-flight. Each one knows for a millisecond, in a different
file, in a vocabulary the others can't read.

`telic` gives that knowledge one declaration, a lifecycle, and a memory: declare an intent
once, record `begin → fulfilled / rejected / abandoned` alongside whatever state management
you already use, and the same record feeds your error reports, your funnel, your other
frontend domains, and any AI agent that needs to know what the user was doing.

**It never owns time or transport** — no retries, no queues, no schedulers, no
network of its own. Recording is the core; an optional mediation layer
(`handle`/`dispatch`, `flow`) adds cross-domain invocation and saga bookkeeping,
but everything telic invokes runs synchronously downstream of a call you made.

## Install

```bash
npm install @telic/core
# or
bun add @telic/core
```

Zero runtime dependencies. Payload schemas use [Standard Schema](https://standardschema.dev)
— Zod 3.24+/4, Valibot, ArkType, or a hand-rolled validator all work; nothing is bundled in.
ESM-only, modern browsers (Baseline); consume it through a bundler.

## Quickstart

```ts
import { intent, on, memory } from "@telic/core"
import { z } from "zod"

const checkout = intent("checkout.submit", {
  payload: z.object({ cartId: z.string() }),
  rejected: z.object({ code: z.string() }),
})

// record alongside your existing code — telic doesn't run anything
const attempt = checkout.begin({ cartId }, { key: cartId, onConflict: "dedupe" })
const result = await submitOrder(cart, { signal: attempt.signal })
result.ok ? attempt.fulfill() : attempt.reject({ code: result.error.code })

// another domain reacts — in real time, for THIS user, including the recent past
on("checkout.submit", ({ mark }) => {
  if (mark.kind === "abandoned") showRecoveryNudge()
}, { replay: true })

// and anything — an island, a devtools panel, an AI copilot — can ask:
memory.inProgress()   // → what is the user mid-way through right now?
```

One declaration simultaneously yields:

- **Legible error reports** — breadcrumbs that read *"checkout begun → payment rejected
  card_declined → abandoned"* instead of a wall of fetch logs
- **At-most-once funnel events** — analytics destinations become projections of the
  intent log, with dedup and consent gating built in
- **Cross-domain interop with memory** — a component that mounts late still hears what
  happened before it (`replay`), without coupling to any other domain's internals
- **A machine-legible answer to "what is the user doing?"** — for embedded copilots,
  AI test explorers, and agent standards like WebMCP, which expose what an agent *can do*
  but not what the user *was doing*

## What it does & why it's helpful

Each example below carries a **Scrutiny** note — what it genuinely buys over the obvious
alternative, and where the honest limits are. (These were written to be attacked; if an
example only works in a demo, it says so.)

### 1. Three lines to a legible crash report

```ts
const login = intent("auth.login", { payload: z.object({ method: z.enum(["pin", "passkey"]) }) })

const attempt = login.begin({ method: "pin" })
// ...
attempt.fulfill()   // or attempt.reject({ code: "PIN_EXPIRED" })
```

Every mark becomes a Sentry breadcrumb (via the tap wired once at boot). The next crash
report reads *"login begun (pin) → rejected PIN_EXPIRED → login begun (pin) → crash"*
instead of a wall of fetch breadcrumbs.

**Scrutiny:** calling `Sentry.addBreadcrumb` yourself is the same line count. The honest
value is not fewer lines — it's that this *same* declaration simultaneously feeds memory,
analytics, and the agent surface, is typed against a schema, and can't drift into
breadcrumb-vocabulary-vs-analytics-vocabulary skew. If you only ever want breadcrumbs,
use Sentry directly.

### 2. Abandonment your code can react to — not a report next week

```ts
on("checkout.submit", ({ mark }) => {
  if (mark.kind === "abandoned") showRecoveryNudge()   // fires NOW, for THIS user
})
```

Attempts auto-abandon on navigation (Navigation API) and unmount (hook opt-out available).
Funnel tools will tell you next week that 40% abandon at step 3; this tells your running
code that *this user* abandoned step 3 twelve seconds ago, in time to do something.

**Scrutiny:** analytics funnels DO measure abandonment — post-hoc, aggregate,
warehouse-side. The differentiated claim is strictly the real-time, per-user, in-page part.
Also honest: an `unload` listener plus a flag can hand-roll one instance of this; the library
earns its keep when abandonment must be *consistent* across many intents and consumable by
code that didn't create the attempt.

### 3. The checkout saga: reload mid-flight, resume where it broke

```ts
const submit = checkout.begin(cart, { key: cart.id, onConflict: "dedupe" })
// child attempts per domain; each AttemptId doubles as the Idempotency-Key header
for (const step of stepsFor(cart)) {
  if (memory.has(step.intent, { phase: "fulfilled" })) continue  // already done pre-reload
  await step.run()
}
```

After a mid-flight reload, memory (with the persistence tap) answers: registration
fulfilled, address fulfilled, payment rejected — resume at payment, skip the rest. The
`key` dedup makes double-submit unrepresentable across islands and re-renders.

**Scrutiny — the biggest bullshit risk in this README, so precisely:** the tape does not
resume anything. Resume requires (a) an orchestrator written to consult memory and re-run,
and (b) **server-side idempotency** — without it, replaying a step whose response was lost
double-charges someone, and no client library can fix that. What the tape contributes is the
durable what-happened record, the correlation ids that make server idempotency cheap to
adopt, and dedup. TanStack Query's mutation persistence solves an overlapping problem for
single mutations; use it for execution — the tape links to it, it doesn't replace it.
Also: double-submit *within one button* is solved by `disabled` in one line; keyed dedup
earns its keep across surfaces and across the reload boundary only.

### 4. Declare the funnel once; destinations become projections

```ts
createAnalyticsTap({
  send: trackEvent, consent: hasMarketingConsent,
  rules: [
    { on: "onboarding.verify", kind: "fulfilled", once: "per-intent",
      map: () => ({ name: "SignupComplete" }) },
  ],
})
```

At-most-once semantics (`once`) are mechanical — no hand-maintained `firedOnce` sets
persisted across reloads.

**Scrutiny:** this subsumed a real hand-rolled implementation in the app this library was
extracted from (a 45-line state-watching switch with a manually persisted dedup set), so the
pain is not hypothetical. Honest limits: identity stitching (`identifyUser`) and
vendor-specific dedup ids still need app code in `map`/`when` — the tap kills the dispatch
and dedup boilerplate, not the vendor semantics.

### 5. A domain that mounted late still hears the past

```ts
// island hydrated 3 seconds after the user logged in:
on("auth.login", ({ mark }) => refreshUser(), { replay: true })  // fires immediately
```

Event buses can't do this — a late subscriber misses everything. In islands/micro-frontend
architectures where hydration order is undefined, replay is the difference between a
communication layer that works and one that races.

**Scrutiny:** this only works if every island shares ONE runtime instance — a bundler that
duplicates the module (two copies in two chunks, version skew in a monorepo, module
federation) silently creates two tapes that each hear half the app. This is a real footgun,
not an edge case; the library ships a dev-mode duplicate-instance detector (window sentinel)
and documents the requirement prominently.

### 6. Machine-legible "what is the user doing"

```ts
window.__INTENT_MEMORY__.inProgress()
// → [{ intent: "checkout.submit", phase: "active", since: 1626354000000, ... }]
```

A support copilot, an AI test explorer, or a WebMCP-exposed tool can read where the user is
and what already failed — behavioral history no DOM snapshot or present-state export
contains.

**Scrutiny:** value is contingent on a consumer existing. Today the only *proven* consumer
is an AI test-explorer tier (it gained an oracle: "intent begun but never settled" = probable
UI dead-end). Embedded-copilot and WebMCP pairings are plausible and cheap but unproven —
which is exactly why this is a tap on the read surface, not a core dependency.

## Isn't this just X?

### …TanStack Query mutations?

Closest neighbor we found, and if your only problem is *reliable server writes*, use it —
mutations have a lifecycle (`idle/pending/paused/success/error`), a subscribable
`MutationCache`, and offline persistence with `resumePausedMutations()`. But a mutation is a
*network operation*, not a user goal: a checkout intent spans five mutations, and nothing in
the cache represents the five as one thing the user was trying to do. Mutation keys are
optional and op-shaped, the cache is garbage-collected working state (not session memory),
there is no `abandoned` (paused means "no network", not "user walked away"), and there are no
analytics/breadcrumb taps, no redaction, no agent surface. `telic` doesn't compete with the
execution layer — the `adapters/tanstack-query` adapter links every mutation to its causing
attempt via `MutationCache.subscribe`, and `telic` itself never executes or retries anything.

### …OpenTelemetry?

Structurally, an attempt tree and a span tree are near-isomorphic — begin/end, parent/child,
ok/error status. The difference is posture: OTel is an export pipeline. Spans leave the page
for a collector, to be read later by an engineer with a Grafana tab; there is no in-page
query API, no way for the running app to subscribe, and span status has no "user gave up".
`telic` keeps the context where the code runs: `memory.inProgress()` is answerable by the
app, an island, or an embedded agent, synchronously, right now. If you have an OTel backend,
the optional `taps/otel` exports attempts as spans — same data, both postures.

### …performance.mark / User Timing?

Genuinely close for the *recording* half — native named marks with `detail` payloads,
queryable via `performance.getEntriesByName`, and RUM vendors ingest them automatically.
What's missing is meaning: a measure is a duration pair with no outcome — nothing can be
rejected or abandoned, nothing is typed, nothing is redacted, and the buffer semantics are
tuned for timing, not memory. So `telic` doesn't compete here either — the `taps/user-timing`
tap mirrors every attempt into `performance.mark`/`measure`, which gives you the DevTools
Performance panel and your RUM vendor's custom-metrics pipeline for free.

### …XState?

If you've modeled a flow as a machine, XState gives you states, persistence, and inspection —
for that flow, in machine vocabulary. But machine states are process-shaped (`askingOtp`,
`payingCheckout`), not goal-shaped; inspection is a devtool, not a product surface; and
nothing spans machines, domains, or the parts of your app that (reasonably) aren't machines.
`telic` composes with it: the `adapters/xstate` inspector links every transition to the
attempt it serves — the machine models *how* the flow proceeds, the tape records *what the
user was trying to do*. Adapters link; they never auto-declare intents from state names.

### …Avo / RudderTyper / a tracking plan?

Typed, declare-once event taxonomies validate half our thesis — but a tracking plan is a
contract about what you *send away*. Events are fire-and-forget points with no lifecycle,
destinations are remote SaaS, and nothing on the page can read the plan back. `telic` is a
tracking plan your app itself can read: declare the intent once, and the analytics tap emits
your funnel events (with at-most-once semantics and consent gating) as *one of several*
projections — while the same declaration also feeds breadcrumbs, memory, and agents.

### …PostHog / Amplitude funnels? (they DO show abandonment)

True — funnel analysis derives abandonment. But it derives it post-hoc, in aggregate, in the
warehouse, for an analyst: "40% drop off at step 3, last week." No analytics product can tell
*your running code* that *this user* abandoned step 3 twelve seconds ago — in time to react,
offer help, or hand context to a support copilot. `abandoned` in `telic` is a real-time,
per-user, in-page state, not a report. (We initially claimed "no analytics SDK can express
abandonment" — that was wrong, and the corrected claim above is the honest, still-decisive
one.)

### …Datadog RUM / LogRocket / session replay?

RUM's `addAction(name, context)` records semantic point-events, and frustration signals
(rage clicks, dead clicks, error clicks) are the industry's confession: everyone wants the
"user intent is failing" signal so badly that vendors *infer it from click heuristics*,
because nothing on the page declares intent. Replay records everything and understands
nothing. Both ship to a vendor and answer questions tomorrow; neither gives the page a
memory it can query today.

### …an event bus?

A bus transports; it doesn't remember. A late-mounting subscriber misses everything that
happened before it — fatal in islands/micro-frontend architectures where mount order is
undefined. `on(pattern, fn, { replay: true })` is a bus with a tape behind it: subscribers
hear the past, and every signal carries lifecycle, not just a payload.

### …Redux actions done right?

Redux's original vision — actions as semantic events, "read the log and know what happened" —
is the direct ancestor of this library, and it lost to practice: `SET_LOADING_TRUE` won
because the API never enforced semantics and the semantic log had no production consumer
(DevTools-only). `telic` inverts both failures: the lifecycle mechanically rejects setters
(what would `rejected` mean for `setLoading`? — if you can't answer, it's not an intent), and
the semantics have four paying customers from the first declaration: breadcrumbs, analytics,
memory, agents. (Notably, Redux Toolkit's own `createAsyncThunk` later converged on
`pending/fulfilled/rejected` — the ecosystem re-derived our lifecycle, minus `abandoned`.)

### …CopilotKit / WebMCP?

Complementary, by design. `useCopilotReadable` exposes *present state* to an embedded
copilot; `useCopilotAction` and WebMCP expose *affordances* — what an agent can do. Neither
exposes behavioral *history with lifecycle*: "tried checkout twice, second attempt rejected
with card_declined, abandoned 40s ago." That's the third leg agents need, and `telic`'s agent
surface provides it — pipe `memory.snapshot()` into a `useCopilotReadable` in one line, or
serve it beside your WebMCP tools so agents see both what they *can do* and what the user
*was doing*.

## Documentation

The design is documented in full and travels with the package (in `packages/core/`):

| Doc | Question it answers |
|---|---|
| [SPEC.md](packages/core/SPEC.md) | **What** — the normative, clause-numbered contract the implementation and tests both cross-check against |
| [DESIGN.md](packages/core/DESIGN.md) | **Why** — boundaries, risks, and the initiative boundary (never owns time or transport) |
| [PATTERNS.md](packages/core/PATTERNS.md) | **How** — patterns (P1–P10) and anti-patterns (AP1–AP8) for using it well |
| [APPROACHES.md](packages/core/APPROACHES.md) | **Which** — a per-axis decision guide when there's more than one reasonable option |
| [DECISIONS.md](packages/core/DECISIONS.md) | **When / what changed** — the append-only log of design decisions and what was rejected |

## Status

**0.1.0 — the first public release.** telic was designed spec-first and proven inside a
production SaaS before extraction, then hardened by an external adoption review from
a second production monorepo (which set much of the roadmap below). The API is committed under
semver from here; see [CHANGELOG.md](CHANGELOG.md). The emitted type declarations are checked
against TypeScript 5.5 through the latest release on every commit, including cross-domain
`IntentRegistry` augmentation across the compiled declaration boundary.

## Roadmap

- **React adapter** — hooks that *specify* StrictMode double-mount and HMR re-declaration
  semantics, not just paper over them.
- **Persistence tap** — durable memory across a reload or checkout redirect (the next major
  feature; the unlock for the resume-mid-flight example above).
- **TanStack Query adapter** — links mutations to their causing attempt, with a clear answer
  to the internal-retry question (telic never owns execution reliability).
- **PostHog recipe + analytics-tap parity introspection** — inspect which rules fired and
  which sinks were reached, so a funnel migration can prove parity.
- **Taxonomy lint tooling** — enforce goal-shaped intent names (the setter-name diagnostic)
  at author time.
- **Runner-agnostic `/testing` subpath** — helpers to assert intent lifecycles under any test
  runner.
- **Cross-tab transports** — BroadcastChannel as the zero-setup default, a SharedWorker hub
  for an authoritative cross-tab tape.

## License

[MIT](LICENSE) © Catalin Tanasescu
