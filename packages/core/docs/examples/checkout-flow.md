# Example: checkout flow — a same-realm saga with resume

Not cross-realm — one JS heap, one runtime. This is the classic multi-step
checkout from PATTERNS P8, written end to end: declaring the intents with
schemas, running `flow()` with steps and `skipIfFulfilled`, surviving a
mid-flight reload, and feeding breadcrumbs + analytics from the exact same
declarations the flow itself runs against. It grounds this folder in
something telic has shipped since Phase 0, not only the newest feature.

## 1. Declare the intents

```ts
import { intent } from "@telic/core"
import { z } from "zod"

const checkoutRejectedReason = z.object({ step: z.string(), reason: z.unknown() })

intent("checkout.submit", {
	payload: z.object({ cartId: z.string() }),
	rejected: checkoutRejectedReason,
})

intent("identity.register", {
	payload: z.object({ email: z.string(), name: z.string() }),
	fulfilled: z.object({ userId: z.string() }),
})

intent("address.create", {
	payload: z.object({ line1: z.string(), city: z.string(), postalCode: z.string() }),
	fulfilled: z.object({ addressId: z.string() }),
})

intent("order.place", {
	payload: z.object({ addressId: z.string() }),
	fulfilled: z.object({ orderId: z.string() }),
})
```

`identity.register` and `address.create` both declare `fulfilled` schemas
because a later step consumes their recorded outcome (PATTERNS P8's note): a
step whose intent has no `fulfilled` schema contributes `undefined` to `ctx`
whether it ran fresh or was skipped on resume, so `order.place` would have
nothing to read from `ctx["address.create"]` without one.

## 2. Wire breadcrumbs, analytics, and reload-resume ONCE at boot

```ts
import { currentRuntime } from "@telic/core"
import { createBreadcrumbTap } from "@telic/core/taps/breadcrumbs"
import { createAnalyticsTap } from "@telic/core/taps/analytics"
import { connectStorage } from "@telic/core/persist"
import * as Sentry from "@sentry/browser"
import posthog from "posthog-js"

currentRuntime().tap(createBreadcrumbTap({ addBreadcrumb: Sentry.addBreadcrumb }))

currentRuntime().tap(createAnalyticsTap({
	send: (event) => posthog.capture(event.name, event.props),
	consent: () => consentStore.get("marketing") === "granted",
	rules: [
		{
			on: "checkout.submit",
			kind: "fulfilled",
			once: "per-intent",
			map: () => ({ name: "checkout_completed" }),
		},
		{
			on: "checkout.submit",
			kind: "rejected",
			map: (mark) => {
				if (mark.kind !== "rejected") return undefined
				const parsed = checkoutRejectedReason.safeParse(mark.reason)
				return parsed.success
					? { name: "checkout_failed", props: { step: parsed.data.step } }
					: undefined
			},
		},
	],
}))

// reload-resume: the rolling tape survives a reload; flow()'s skipIfFulfilled
// (below) reads it back to decide what already committed
connectStorage(currentRuntime(), {
	storage: "session",
	resume: ["checkout.submit", "identity.register", "address.create", "order.place"],
})
```

No hand-rolled `firedOnce` set for the funnel event, no separate breadcrumb
call site to keep in sync with the flow's own steps — both taps read the
SAME marks the flow already produces.

## 3. The flow

```ts
import { flow, step } from "@telic/core/flow"
import type { FlowResult } from "@telic/core/flow"

async function submitCheckout(cart: Cart): Promise<FlowResult> {
	return flow("checkout.submit", cart, { key: cart.id }, [
		step("identity.register",
			(ctx, a) => api.register(cart.user, { idempotencyKey: a.id }),
			{ skipIfFulfilled: true }),
		step("address.create",
			(ctx, a) => api.createAddress(cart.address, { idempotencyKey: a.id }),
			{ skipIfFulfilled: true }),
		step("order.place",
			(ctx, a) => api.placeOrder(ctx["address.create"], { idempotencyKey: a.id }),
			{ skipIfFulfilled: true }),
	])
}

const result = await submitCheckout(cart)
if (!result.ok) {
	// result.step names exactly which step rejected; result.reason is that step's reason
	showCheckoutError(result.step, result.reason)
}
```

Each step's child attempt id doubles as the `Idempotency-Key` header on that
step's API call — the server MUST honor it for resume to be safe (PATTERNS
P8); the client-side log informs what to skip, the server makes replaying a
step's request harmless.

## 4. Reload mid-flight — what resume actually does

Say the tab closes right after `address.create` fulfills but before
`order.place` begins. On reload, `connectStorage`'s restore path (S18.3) runs
before anything else: every mark from the persisted tape is `ingest()`ed, and
any attempt that was still ACTIVE when the tape was written — here, the
`checkout.submit` parent itself — resurrects as active only if it matches a
`resume` pattern, otherwise it settles `abandoned({ why: "navigation" })` at
restore time. It's on the `resume` list above, so it comes back active; its
two children that already fulfilled (`identity.register`, `address.create`)
come back as ordinary fulfilled records — nothing special about them, they're
just settled attempts on the restored tape.

Calling `submitCheckout(cart)` again with the SAME `cart.id` is what makes
that restored state useful: `flow()` begins (or, per S2.4's dedupe, resolves
to) the same keyed `checkout.submit` attempt, and each step's
`skipIfFulfilled` checks memory for a FULFILLED attempt of that step's intent
under the matching key (`<cart.id>:identity.register`, etc.) before running
anything. Both already-fulfilled steps are found and skipped — their
recorded outcomes feed `ctx` exactly as if they'd just run (P8's ctx-symmetry
guarantee) — and `order.place` is the one step that actually executes,
resuming precisely where the reload interrupted it. Without the persistence
tap, this skip-matching only works within one session — a real reload loses
the in-memory tape and everything re-runs from step one, honestly documented
as such (S16.6).

## Scrutiny: why telic and not XState, or just letting the server retry?

If this checkout were already modeled as a machine, XState gives you states,
persistence, and inspection for that machine, in machine vocabulary
(`askingAddress`, `payingOrder`) — a real, mature alternative, and one telic
composes with rather than replaces (the `adapters/xstate` inspector links a
machine's transitions to the attempt they serve). The gap `flow()` fills
specifically is that it's not a machine: it's the minimum coordinator that
gives child attempts idempotency-key ids and keyed skip-on-resume, without
requiring you to model the whole flow as states first. And the honest limit,
stated as precisely as this doc's opening promised: **`flow()` is bookkeeping,
not reliability.** It never retries, never queues, never runs in the
background — re-invocation on reload is the app's job (§4 above), and
server-side idempotency on every step's key is mandatory, not optional;
without it, replaying a step whose response was lost on the wire
double-charges someone, and no client-side coordinator, telic's or anyone
else's, can fix that after the fact.
