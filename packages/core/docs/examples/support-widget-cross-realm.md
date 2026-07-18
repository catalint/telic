# Example: cross-realm dispatch — a support widget invokes the host's cart

`support.example.com` ships a chat widget, iframed into `shop.example.com`.
Two separately-deployed apps on different origins — neither can import the
other's code. The widget wants to invoke `cart.addItem`, whose handler lives
in the host's cart island. This is SPEC S28
(`@telic/core/transports/remote-dispatch`) end to end: the request leg is a
distinct wire envelope (S19.4) that only a wired receiver ever acts on; the
return leg is ordinary settlement marks over the postMessage transport (S23)
the two origins likely already run for plain observability, resolved on the
widget's live `Attempt` by the ingest completion invariant (S10 amendment,
clause 9).

Signatures below are copied verbatim from SPEC S28/S15.9 — nothing here is
invented. As of this writing `@telic/core/transports/remote-dispatch` is
landing alongside the spec, so treat this example as the contract it's
written against, not proof of a shipped release.

## 1. The host (shop.example.com) — owns the capability, wires the receiver

```ts
import { currentRuntime, intent } from "@telic/core"
import { handle, executeRemote } from "@telic/core/mediate"
import { connectWindow } from "@telic/core/transports/post-message"
import { receiveRemoteDispatches } from "@telic/core/transports/remote-dispatch"
import { z } from "zod"

const widgetOrigin = "https://support.example.com"

// declared for payload validation + describe() — the widget invokes this
// same name as a bare string; it never imports this declaration (§5 below)
intent("cart.addItem", {
	payload: z.object({ sku: z.string() }),
	rejected: z.object({ code: z.string() }),
})

// the cart island's own mount effect (PATTERNS P10b) — may register AFTER
// the widget has already dispatched; parked dispatch (§4) absorbs that race
useEffect(() => handle("cart.addItem", async (attempt, { sku }) => {
	await addItem(sku, { idempotencyKey: attempt.id })   // attempt.id IS the widget's id — §5
	return { ok: true }
}), [])

// return leg: settlement + progress marks reach the widget over the SAME
// transport the two origins would run for plain cross-app observability (S23)
connectWindow(currentRuntime(), {
	target: widgetFrame.contentWindow,
	targetOrigin: widgetOrigin,
	accept: (origin) => origin === widgetOrigin,
	send: ["cart.*"],
})

// request leg: the ONLY thing allowed to act on request envelopes (design
// doc §2) — a gossiped `begun` mark can never reach this far; ingest() never invokes anything
receiveRemoteDispatches({
	listen: window,
	accept: (event) => event.origin === widgetOrigin,
	execute: executeRemote,
})
```

## 2. The widget (support.example.com) — invokes; never imports the host

```ts
import { currentRuntime } from "@telic/core"
import { beginRemote } from "@telic/core/mediate"
import { connectWindow } from "@telic/core/transports/post-message"
import { createRemoteDispatcher } from "@telic/core/transports/remote-dispatch"

const hostOrigin = "https://shop.example.com"

// return leg: hear the host's marks — plain observability wiring, useful
// even for a widget that never dispatches anything. send: [] keeps the
// widget's own marks off this channel — a noise choice, not a correctness
// requirement (S28.5; see the note right after this block).
connectWindow(currentRuntime(), {
	target: window.parent,
	targetOrigin: hostOrigin,
	accept: (origin) => origin === hostOrigin,
	send: [],
})

// request leg: telic never holds the socket — `send` is the widget's own postMessage
const remote = createRemoteDispatcher({
	begin: beginRemote,
	send: (json) => window.parent.postMessage(json, hostOrigin),
})

// …in the chat UI: "add the recommended item to my cart"
const attempt = remote.dispatch("cart.addItem", { sku: "SKU-42" }, {
	ifUnhandled: "park",                      // the host's cart island may still be mounting
	abandonWhen: AbortSignal.timeout(4000),   // the caller's clock — telic owns none
})

switch ((await attempt.settled).phase) {
	case "fulfilled": showToast("Added to your cart"); break
	case "rejected":  showToast("The shop declined that item"); break
	case "abandoned": showToast("Cart isn't reachable right now"); break
}
```

A domain that wants this to read less stringly-typed can still export a
`command()`-style stub wrapping `remote.dispatch` from a contract subpath
(P12 applies unchanged) — S28 doesn't require the bare string, it's just
what the minimal version looks like.

### The begun-echo ordering — and why it's safe (but worth filtering anyway)

There is a deterministic ordering here worth understanding. `remote.dispatch(...)`
calls `begin` (→ `beginRemote`) FIRST, which emits an ordinary `begun` mark for
the new attempt (S2.1); taps run synchronously on every mark (S7.2), so a
widget-side `connectWindow` that forwards local marks posts that `begun` to the
host BEFORE `dispatch` serializes and sends the S19.4 request envelope.
`postMessage` preserves order, so the host receives the `begun` first and
ingests it — an attempt record for the caller's id exists on the host before
the request arrives.

The contract absorbs this by design: S15.10's adoption is three-way, and a
record known **only from observation** (an ingested foreign `begun` —
origin-stamped, never executed here) does not block adoption. `executeRemote`
adopts that observed record — keeping its observed payload, a fidelity bonus —
and the handler runs normally. Only an id already *executed* here or already
settled is a replay no-op. Observing a begin can never prevent executing its
request (S15.9's begun-echo rule; the end-to-end ordering is pinned by an
S28.3 test).

So why `send: []` anyway? Noise and bandwidth: without it, every widget-side
mark gossips to the host — including the `begun` the host will also learn
about from the request itself. Filtering the caller's outbound marks on the
return-leg channel is good hygiene (S28.5 says exactly this: a noise choice,
never a correctness requirement). Drop the filter and everything still works.

## 3. What each branch of the `switch` actually means

- **`fulfilled`** — the host's handler ran, `addItem` succeeded, the item is
  genuinely in the cart.
- **`rejected`** — the host *answered*. Either the handler itself rejected
  for a business reason (out of stock), or, per S15.9, the host had no
  handler registered at all and its own local dispatch produced
  `{ code: "TELIC_NO_HANDLER" }` — both arrive at the widget as the exact
  same shape: an ordinary `rejected` mark. The widget cannot and does not
  need to tell them apart to render an honest message.
- **`abandoned`** — nobody answered before `abandonWhen` fired. This could be
  a cart island that's still mounting, a channel that never delivered, or a
  host that isn't even loaded in that tab. The widget cannot distinguish
  these (design doc §4) — which is exactly why the toast says "not reachable
  right now" instead of guessing a specific cause it has no way to confirm.

## 4. Parked dispatch — absorbing the mount-order race

`ifUnhandled: "park"` is a REMOTE-side state (design doc §4): the widget's
own attempt is always just "active, bounded by `abandonWhen`," regardless of
whether the host rejects or parks. What changes is what the HOST does when
its own local dispatch — running inside `executeRemote` — finds no handler
yet: reject immediately (the default), or hold the correlation in its FIFO
park queue (S15.7) until the cart island's `handle()` call drains it. Paired
with the island's own mount-effect registration above (P10b), a widget
dispatch that fires moments before the cart island finishes mounting still
gets served — served, not lost — as long as it lands inside the
`abandonWhen` deadline. If the cart island never mounts at all, parking
changes nothing observable to the widget: silence is still silence, and
`abandonWhen` still fires (§3's `abandoned` case).

## 5. The idempotency-key note

`attempt.id` is minted exactly once — on the widget, by `beginRemote` — as a
real, live `AttemptId`, not a wire-only correlation token. The host's
`executeRemote` *adopts* that exact id (S15.10, `adoptAttempt`) rather than
minting its own, so the `attempt` argument the host's `handle()` callback
receives carries the SAME id the widget is awaiting. `AttemptId`'s own
contract states the payoff plainly: it "doubles as an Idempotency-Key for the
network calls an attempt causes" — so `addItem(sku, { idempotencyKey:
attempt.id })` above sends the widget-originated id straight to the host's
real backend as the Idempotency-Key header. That's what collapses the
double-execution scenario named next into a single effect, without the two
browser realms ever agreeing on anything beyond the id itself.

## 6. What this does NOT guarantee

- **No delivery guarantee.** telic does not ack, retry, or confirm receipt. A
  request dropped on a flaky postMessage channel is silently lost; the
  widget's attempt sits active until `abandonWhen` abandons it. (design doc
  §9)
- **Silence is not rejection.** With the default `ifUnhandled: "reject"`, an
  *absent* host produces no `TELIC_NO_HANDLER` — there's no local dispatch to
  produce it. Silence degrades straight to `abandoned` on deadline; only a
  host that's actually loaded and actually missing the handler answers with
  a prompt `rejected`. (design doc §3)
- **Single settlement, not single execution.** (design doc §5.4/§9.) If the
  request somehow reaches two realms — two iframes, a duplicated receiver —
  both handlers run, both emit a terminal for the same `attempt.id`, and
  first-write-wins (S3.4) settles the widget once; the second arrival is a
  silent `double-settle` diagnostic. telic records that both ran; it does
  not stop the second execution. The `attempt.id`-as-Idempotency-Key from §5
  is the mitigation, not a fix — collapsing two executions into one effect
  is the SERVER's job, keyed on that id.

## Scrutiny: why telic and not a hand-rolled `MessagePort` RPC (or Comlink)?

A hand-rolled request/response protocol over `postMessage` — or Comlink's
ES-Proxy RPC — genuinely gives you something this doesn't: a real return
value, a re-thrown remote error, request/response semantics an engineer can
read as a normal async function call. telic deliberately does none of that —
dispatch never throws to the caller, by contract (S15.3/S15.4), and there is
no return value beyond the settled phase. What you get instead is that this
crossing is not a bespoke protocol only this widget-host pair understands: it's
an ordinary attempt, on both tapes, with the same `begun → fulfilled /
rejected / abandoned` vocabulary as every other intent in either app —
visible to `memory.inProgress()`, breadcrumbs, analytics, and a support
copilot on either side, for free, because it's the same declaration
mechanism as everything else. If all you need is "call this function in
another realm and get its return value," Comlink already does that well and
composes with telic rather than competing — a Comlink-exposed method can be
exactly what a local `handle()` calls.
