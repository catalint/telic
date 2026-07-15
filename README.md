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

## Design principles

- **Record-first, non-invasive** — works next to any state management (or none);
  an optional layer adds cross-domain subscription
- **Lifecycle over events** — `abandoned` is a first-class terminal state, in-page and
  per-user, not a warehouse report next week
- **Typed end to end** — Zod-schema'd payloads and outcomes; no string soup
- **Wired to the platform** — abandoning an intent aborts its `fetch` (`attempt.signal`);
  navigation auto-abandons via the Navigation API; modern browsers only (Baseline)
- **Tiny, zero-dep core** — everything else (Sentry/analytics/User-Timing taps,
  XState/TanStack Query adapters, cross-tab transports, devtools) is a sub-path import
- **Never takes initiative** — retries, offline queues, and scheduling belong to your
  execution layer; telic records, correlates, remembers, and only ever runs code
  inside your own call stack

## Status

Early design phase. The concept has been through a prior-art review (OpenTelemetry,
TanStack Query mutations, XState, tracking plans, RUM/session replay, event buses,
CopilotKit/WebMCP — none occupy this composition) and a platform-API audit. The core is
being proven inside a production app before the public API is committed. Expect the API
above to change.
