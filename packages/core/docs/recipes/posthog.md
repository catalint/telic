# Recipe: PostHog

A complete wiring of `createAnalyticsTap` (SPEC S17) to
[PostHog](https://posthog.com): the `send` sink, the consent source, identity
stitching, dedupe persistence, and a CI-assertable proof that a migration off
hand-rolled `posthog.capture()` calls preserves the same events. Every
signature below matches `packages/core/src/taps/analytics.ts` — nothing here
is aspirational. Uses `posthog-js`; swap for `posthog-node` server-side, the
tap itself has no vendor import either way.

## 1. `send` → `posthog.capture`

`send` is `(event: AnalyticsEvent) => void`, where `AnalyticsEvent = { name:
string; props?: Record<string, string | number | boolean> }` — that's
PostHog's own `capture(event, properties)` shape, so the sink is a direct
pass-through. Rules declare the funnel; `map` produces the event.

```ts
import posthog from "posthog-js"
import { currentRuntime } from "@telic/core"
import { createAnalyticsTap } from "@telic/core/taps/analytics"

currentRuntime().tap(
	createAnalyticsTap({
		send: (event) => posthog.capture(event.name, event.props),
		consent: hasMarketingConsent, // §2
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
					// mark isn't narrowed by rule.kind — check before reading `.reason`.
					if (mark.kind !== "rejected") return undefined
					return { name: "checkout_failed", props: { reason: String(mark.reason) } }
				},
			},
		],
	}),
)
```

`currentRuntime()` is the same accessor `@telic/react`'s `<TelicProvider>`
uses internally to reach the late-bound default runtime — call it once at
boot, after any `configureDefaultRuntime()`.

## 2. `consent` → PostHog opt-in status, or your own store

Two legitimate sources, shown both so the tradeoff is explicit:

```ts
// (a) — ask PostHog what IT thinks you told it
consent: () => posthog.has_opted_in_capturing(),

// (b) — ask the app's own consent store (recommended: source of truth)
consent: () => consentStore.get("marketing") === "granted",
```

**Recommend (b).** `posthog.has_opted_in_capturing()` only reflects whatever
your code last passed to `posthog.opt_in_capturing()` /
`opt_out_capturing()` — it's a mirror of a decision, stored in PostHog's own
cookie/localStorage key, not the decision itself. If your cookie banner
already writes to a consent store for other purposes (other vendors, a
GDPR audit trail), that store is the actual record; asking PostHog to grade
its own homework is one more place the two can drift. Wire it as: the app's
store is what `consent()` reads, and the SAME store's change handler calls
`posthog.opt_in_capturing()` / `opt_out_capturing()` so PostHog's own
client-side features (autocapture, session replay) honor the identical
decision. `consent()` is evaluated per matching mark (S17.4) — keep it cheap;
a store read, not a network call.

## 3. Identity stitching — `posthog.identify` in a rule's `emit`

Put `posthog.identify` on the intent that actually proves identity (a
successful login), as an `emit` — the vendor side-effect escape hatch, gated
under the same once/consent rules as `map` (S17.2):

```ts
{
	on: "auth.login",
	kind: "fulfilled",
	emit: () => {
		// AP7: identity comes from app context AT THE CALL SITE — NEVER
		// from mark.payload / mark.outcome. auth.login's payload might
		// carry { method: "pin" }; it must never carry an email or user
		// id in the first place — redaction is write-time and
		// per-intent, and identify() has no business reading back
		// something the tape was designed to keep off it.
		const user = getCurrentUser()
		if (user !== undefined) posthog.identify(user.id, { plan: user.plan })
	},
},
```

No `once` here, deliberately: settling is first-write-wins (S3.4), so a
`fulfilled` mark already happens at most once per attempt — this rule already
fires exactly once per login without any dedup key. Reaching for `once:
"per-intent"` would be a bug, not an optimization: it fires the rule at most
once EVER on this runtime (S17.3), so the SECOND person logging in on a
shared device would silently never get identified.

## 4. `dedupe` persisted to `localStorage`

`AnalyticsDedupe` is two functions — `load(): readonly string[]` and
`save(keys): void` — so a `localStorage`-backed adapter is small:

```ts
import type { AnalyticsDedupe } from "@telic/core/taps/analytics"

const DEDUPE_KEY = "telic:analytics-once"

const localStorageDedupe: AnalyticsDedupe = {
	load: () => {
		try {
			const raw = localStorage.getItem(DEDUPE_KEY)
			return raw === null ? [] : (JSON.parse(raw) as readonly string[])
		} catch {
			return [] // corrupt or blocked storage — dedupe just starts cold
		}
	},
	save: (keys) => {
		try {
			localStorage.setItem(DEDUPE_KEY, JSON.stringify(keys))
		} catch {
			// quota / disabled storage — degrades to session-only, never throws
		}
	},
}
```

Pass it as `dedupe`, and every `once: "per-intent"` key survives a reload.
`once: "per-attempt"` keys are deliberately NOT persisted (S17.3) — they're
scoped to one in-memory attempt and there is nothing to resume.

**The persist-tap alternative.** `@telic/core/persist`'s `connectStorage`
(S18) is a tap too, but it solves a different problem: it persists the
rolling TAPE of marks for cross-reload attempt resume, not a list of
fired-once keys. If a persistence tap is already wired for resumable flows,
resist pointing `dedupe` at the same storage key — the two read incompatible
shapes (a wire-format mark envelope vs. a bare string array) and sharing a
key is a parse error waiting to happen the day one of them changes its
format. Give `dedupe` its own key (`telic:analytics-once` above, distinct
from persist's default `telic:tape`); Web Storage is cheap enough that
sharing buys nothing.

## 5. Migration parity — proving the switch with `trace`

The situation this section exists for: a `posthog.capture()` call site
already ships, and the rewrite to a `createAnalyticsTap` rule needs to be
provable equivalent BEFORE the old call site is deleted — without sitting in
front of a PostHog dashboard watching live events for every PR. The S17.7
`trace` hook is built for exactly that: it fires once per rule/mark decision
(`sent` / `emitted` / `deduped` / `denied` / `buffered` / `flushed` /
`skipped-when`), independent of whether `send`/`emit` actually ran anything
real.

```ts
import { describe, expect, it } from "bun:test"
import { createTestRuntime } from "@telic/core/testing"
import { createAnalyticsTap, type AnalyticsTraceEvent } from "@telic/core/taps/analytics"

describe("PostHog migration parity: checkout.submit", () => {
	it("fires checkout_completed once per checkout, deduping repeats", () => {
		const { runtime } = createTestRuntime()
		const trace: AnalyticsTraceEvent[] = []

		runtime.tap(
			createAnalyticsTap({
				send: () => {}, // sink is not under test — trace records the DECISION
				consent: () => true,
				trace: (event) => trace.push(event),
				rules: [
					{
						on: "checkout.submit",
						kind: "fulfilled",
						once: "per-intent",
						map: () => ({ name: "checkout_completed" }),
					},
				],
			}),
		)

		runtime.intent("checkout.submit").begin().fulfill()
		runtime.intent("checkout.submit").begin().fulfill() // re-submit, same funnel

		// The recorded expectation: the exact mark→rule→action sequence the
		// hand-rolled posthog.capture() call site was written to produce.
		expect(trace.map((event) => `${event.action}#${event.ruleIndex}`)).toEqual([
			"sent#0",
			"deduped#0",
		])
	})
})
```

`createTestRuntime` (S21) is runner-agnostic — this reads as `bun:test`
because that's this repo's runner, but nothing about it depends on Bun; the
same test compiles under Vitest or Jest unchanged.

The migration recipe, mechanically: for every existing `posthog.capture()`
call site, (1) write the equivalent rule, (2) write ONE trace-asserting test
that records the sequence you expect from the OLD code's actual call
pattern — copied from what ships today, not guessed — and (3) check it in
before deleting the hand-rolled call. That test is now a parity gate: any
future change to the rule set that alters the sequence fails CI before it
reaches production, the same discipline D16 required of the first real
migration onto this tap.

**Honest limitation, stated exactly:** this proves events-REQUESTED, not
sinks-REACHED. `trace` fires the instant the tap decides to call
`send`/`emit` — it says nothing about whether `posthog.capture()` actually
reached PostHog's ingestion endpoint (a network failure, an ad-blocker, a
`beforeSend`-style hook eating the event client-side). Ship the parity-gated
migration, then do ONE staging pass watching PostHog's Live Events view for
the events the trace suite predicts. That is the only way to close the gap
between "the tap decided to fire" and "PostHog received it" — no amount of
additional unit testing substitutes for it.
