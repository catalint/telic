# telic — usage guide for AI coding agents

You are working in a codebase that uses `@telic/core` (and possibly
`@telic/react`). This file is the condensed correct-usage contract. Full
normative behavior: `SPEC.md` (clauses S1–S27) in this same directory;
patterns/anti-patterns: `PATTERNS.md`. All of these ship in the npm package —
they are in `node_modules/@telic/core/` right now.

## What telic is (30 seconds)

A record-first intent layer: declare typed user intents once, record their
lifecycle (`begun → fulfilled / rejected / abandoned`) beside the app's
existing state management. The tape is queryable in-page memory; taps fan
marks out to Sentry/analytics/OTel; an optional mediation layer adds
cross-domain invocation. **telic records — it never executes, retries,
schedules, or owns state.**

## The five rules that prevent 90% of misuse

1. **Name goals, not mutations.** Before declaring an intent, apply the
   lifecycle test: *what does `rejected` mean for it? when would a user
   `abandon` it?* No answer → it's a state mutation, not an intent — don't
   record it. `checkout.submit` ✔; `ui.setModalOpen` ✘ (the runtime will emit
   a `setter-like-name` diagnostic for set/update/toggle/change names).
2. **No identities on the tape.** Payloads and outcomes carry
   classifications, never PII: `{ method: "email" }` ✔; `{ email:
   "x@y.com" }` ✘. Everything on the tape flows to breadcrumbs, storage,
   transports, and the agent surface. Identity side effects (e.g.
   `identify()` calls) read app context at the call site instead.
3. **Memory is not truth.** Never derive primary UI state from
   `memory.*`/attempt phases — that's the app's state layer's job. Memory is
   for secondary, degradable surfaces: nudges, devtools, breadcrumb context,
   copilot answers.
4. **Within your own domain, call your own functions.** `dispatch()`/
   `command()` exist for real boundaries (separately-owned modules,
   micro-frontends, agent invocation) — using them as a fancy function call
   inside one domain is an anti-pattern (AP4). Reactions to another domain's
   activity use `on(pattern, listener)`, never choreography that drives a
   money path.
5. **Prefer `run()` (or handlers/adapters) over manual begin/settle pairs.**
   `intent.run(payload, fn)` settles from the fn's `{ ok }` result and can't
   leak an unsettled attempt. If you must pair manually, remember settling is
   first-write-wins and never throws.

## Common tasks, correct shapes

```ts
// declare (module scope is fine — handles are late-bound to the runtime)
import { intent, on, memory } from "@telic/core";
const renew = intent("billing.renewDomain", {
	payload: schema,            // any Standard Schema (zod/valibot/arktype)
	rejected: reasonSchema,     // rejection = expected failure, maps to your Result errors
});

// record around one async operation
await renew.run({ domainId }, () => api.renewDomain(domainId));

// record with cancellation wired to meaning
const attempt = search.begin({ q }, { key: "search", onConflict: "supersede" });
fetch(url, { signal: attempt.signal });   // superseded/abandoned ⇒ fetch aborts

// double-submit protection
checkout.begin(cart, { key: cart.id, onConflict: "dedupe" });

// react to another domain (late mount still hears history)
on("auth.login", refresh, { kinds: ["fulfilled"], replay: true });

// multi-domain saga (order/policy yours; bookkeeping telic's)
import { flow, step } from "@telic/core/flow";
await flow("checkout.submit", cart, { key: cart.id }, [
	step("identity.register", (ctx, a) => api.register(u, { idempotencyKey: a.id }), { skipIfFulfilled: true }),
	step("order.place",       (ctx, a) => api.place(ctx["identity.register"], { idempotencyKey: a.id })),
]);   // NOTE: resume requires server-side idempotency; flow never retries
```

React: use `@telic/react` hooks — `useIntent` returns stable `{ begin, run }`
callbacks; **never begin an attempt in a mount effect** (mounts are not
intents; StrictMode will double-invoke you). `useHandle` for presence-based
capability registration.

## Things that look like bugs but are the design

- SSR/tests record nothing by default (the default runtime is silent without
  a DOM) — configure or inject a runtime (`createTestRuntime` from
  `@telic/core/testing`) in tests.
- A second `fulfill()` after `reject()` is silently ignored (first-write-wins)
  with a `double-settle` diagnostic — not an error.
- Soft navigation only auto-abandons attempts whose `boundTo` pattern the new
  URL violates; unbound attempts survive SPA navigation on purpose.
- `dispatch` on a name with no handler rejects with `TELIC_NO_HANDLER`-coded
  reason unless parked — "no handler" is a truthful state when registration
  is presence-based.

## Paste-block for the host project's agent config

If this project has a CLAUDE.md/AGENTS.md/.cursorrules, adding this keeps
agents honest:

```
telic rules: intents name user GOALS (lifecycle test: what would rejected/
abandoned mean?) — never state mutations. No PII in payloads/outcomes. Never
drive primary UI from telic memory. dispatch/command only across real domain
boundaries; use on() for reactions. Prefer intent.run() over manual
begin/fulfill pairs. telic never retries/schedules — deadlines are
caller-owned AbortSignals. Docs: node_modules/@telic/core/{AI-GUIDE,SPEC,PATTERNS}.md
```
