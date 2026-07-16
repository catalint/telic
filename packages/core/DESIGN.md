# telic — design choices and their reasons

Companion to SPEC.md (which says *what* the library does). This document says
*why*, records the boundaries that keep it honest, and names the risks we are
deliberately carrying. PATTERNS.md holds the worked examples.

## The one-sentence thesis

Your app already knows what the user is trying to do — it just forgets
immediately. telic gives that knowledge one declaration, a lifecycle
(`begun → fulfilled / rejected / abandoned`), and an in-page queryable memory,
and lets four consumers share it: error reports, analytics, other frontend
domains, and AI agents.

## Posture: record-first, mediate optionally

telic records intents alongside whatever state management the app already has.
It is not a state manager, not an event-sourcing framework, and not an
execution engine. The optional mediation layer (`handle`/`dispatch`, `flow`)
was added only after the record-first core was proven in production — in that
order on purpose: recording earns trust with zero invasiveness; mediation
spends that trust where decoupling is actually needed.

## The initiative boundary (the load-bearing rule)

**telic never owns time or transport.** No retries, no queues, no schedulers,
no timers, no network calls of its own. Everything telic invokes — `run()`
functions, dispatch handlers, flow steps — executes synchronously downstream
of a call the app (or an agent the app authorized) made. Failure semantics
stay in the app's Result types.

Why this specific line: every prior art in this space that died, died from
taking initiative. Event-sourcing frameworks re-ran apps from their logs;
choreographed sagas fired steps on their own; the SAM pattern gated mutations
behind its own control loop. A layer that only ever executes inside the
caller's stack frame is structurally a function call with bookkeeping — not a
framework with opinions about when things happen. If a handler wants retries
or offline queues, it uses an execution library (TanStack Query) *inside*
itself; telic records and correlates, the execution layer executes.

## The data boundary (the initiative boundary's twin)

**telic records and honors policy; it never authors, alters, or overrides the
data it moves.** The initiative boundary says telic never *acts* on its own; this
is the same rule pointed at data. telic may omit a value, gate where it travels,
or leave a typed marker that omission happened (`"[private]"`) — but it never
transforms the *semantic content* of a value it records, except through a
caller-supplied `transform`. The only entity that alters content is the caller.

`exposure` is a caller policy telic is bound to honor and forbidden to override:
never guess it when the live record is gone (fail closed — do not default to the
most-exposing value), never relax it, never upgrade a `local` child's value into
a non-local parent by aggregation. `transform` is a purpose-neutral mapping the
caller fills — telic offers the seam, the caller decides what it does. That is why
the field is named for its mechanism, not for redaction: privacy is one thing a
caller may do with it, not a job telic performs. The identity boundary — "no raw
identities on the tape, classifications only" (PATTERNS AP7) — is likewise the
caller's to hold. telic makes no independent *security* promise, only a *fidelity*
one: it will not move your data further than you told it to, and it will not
invent a policy when it has lost yours.

Why this specific line: a layer that decides data's fate on its own becomes an
editor with opinions, exactly as a layer that decides *when* things run becomes a
framework with opinions. Both drifts end the same way — the substrate stops being
trustworthy because it started making calls its callers didn't. Where telic has a
gap in a caller's stated policy, it surfaces the gap loudly (`missing-exposure`)
rather than guessing — the same diagnostics-as-linters posture as the initiative
boundary's setter-name nudge.

## Why the lifecycle is the semantic enforcement

Redux's history is the cautionary tale this library is built against. Redux
asked for semantic actions ("model actions as events, not setters") in its
docs, its style guide, and its creators' words — and lost to `SET_LOADING_TRUE`
anyway, because (a) the API never enforced the semantics and (b) the semantic
log had no production consumer (DevTools-only), so the discipline was pure tax.

telic inverts both failures:

- **The lifecycle mechanically rejects setters.** Ask "what does `rejected`
  mean for `setLoading`? when is it `abandoned`?" — no answer means it's a
  mutation, not an intent. The outcome schemas are a design linter, not
  decoration. The `setter-like-name` diagnostic backs this at authoring time
  (and caught this library's own author with `consent.update` → renamed
  `consent.decide` on day one).
- **The semantics have paying customers from the first declaration**:
  breadcrumbs on the next error report, at-most-once analytics, queryable
  memory, and the agent surface. Discipline without a consumer erodes;
  every telic declaration is consumed in production immediately.

## Why `abandoned` is first-class

It is the one state no incumbent can express in real time: analytics derives
abandonment post-hoc in a warehouse; OTel spans just never close; session
replay records it without understanding it. `abandoned` is also where the
platform integration pays: navigation auto-abandons (Navigation API for soft
navs, pagehide for hard), unmount hooks abandon, `attempt.signal` aborts the
attempt's I/O when it abandons. And it is semantically distinct from
`rejected` in ways products care about: a user closing a WebAuthn prompt did
not *fail* — they walked away.

## Why memory is bounded and local

The tape is a ring buffer, the settled-attempt index an LRU, active attempts
pinned (so `inProgress()` cannot lie). Local-first because the differentiating
posture is *in-page queryability* — the running app, a late-mounting island, a
support copilot can ask "what is the user mid-way through right now" and get a
synchronous answer. Anything that ships context away (Sentry, analytics, OTel
export) is a tap over the same tape, not the primary.

**Memory, not truth**: if UI correctness depends on a value, it belongs in the
app's state layer. Attempts expose no `update()`; memory returns frozen
views. The moment teams render primary UI from attempt state, telic has become
a second state manager — the exact trap the design forbids.

## Why late-bound module handles

The orphaned-runtime bug (found by a browser review on integration day one):
module-scope `intent()` declarations evaluate before app bootstrap configures
the runtime, ES modules cache the handles, and a naive design records into a
replaced runtime forever — silently. Rule since: **ES-module evaluation order
must never matter.** Module-level `intent`/`on`/`scope` handles resolve the
current default runtime per call through a registry that re-registers on every
configure. Explicit `createRuntime()` handles stay bound — the late binding is
a property of the module-level convenience API only.

## Why Standard Schema instead of a Zod dependency

The deepest coupling in a schema-driven library is whose inference you marry.
Accepting `StandardSchemaV1` (Zod 3.24+/4, Valibot, ArkType) keeps zod-quality
inference while making the core truly zero-dependency (the spec interface is
vendored, types-only). Zod remains a concrete dependency only where untrusted
input needs runtime validation (`wire`, future transports).

## Why one handler per intent

`dispatch` is a command: exactly one executor owns the capability, last-wins
with a `handler-replaced` diagnostic. Fan-out is `on()`'s job — observers are
many, executors are one. Multiple executors per command is how event
choreography sneaks back into money paths wearing a command bus as a costume.

## Why `flow` hands you the coordinator instead of replacing it

For multi-domain submissions (checkout: register → address → payment → order)
the reliable architecture is a saga: explicit coordinator + durable log.
Choreography ("each domain reacts to the previous domain's event") scatters
ordering and error handling across files and is explicitly rejected for
critical paths. telic's tape *is* a client-side saga log, so `flow()`
contributes the bookkeeping a coordinator needs — child attempts, keyed
skip-on-resume, AttemptId-as-Idempotency-Key — while the app keeps the policy:
which steps, what order, what data flows. The honest limits are documented in
SPEC S16: no retries, no parallelism, resume requires the caller to re-invoke,
cross-reload resume requires the persistence tap, and the client log is never
authoritative — the server's idempotency is what makes replays safe.

## Risks we carry knowingly

| Risk | Why accepted | Mitigation |
|---|---|---|
| Adoption discipline erodes (the Redux failure) | Inherent to any semantic layer | `run()`/adapters make the right way the cheap way; day-one taps make semantics consumed; setter-name diagnostic |
| Taxonomy rot (names drift, duplicates) | Inherent to any naming scheme | scope-prefixed template-literal names, duplicate diagnostics, `describe()` makes the whole taxonomy reviewable in one call |
| Second-state-manager trap | Memory is genuinely useful, so misuse is tempting | No mutation API, frozen views, "memory not truth" doc rule |
| Dispatch indirection abuse | Stringly-typed calls where imports were clearer | Decision rule: within your own domain, call your functions; dispatch crosses domain boundaries or serves agents |
| Double-bookkeeping drift (intent says active, state says done) | Manual begin/settle pairs exist | Prefer `run()`/handlers/adapters; auto-abandon (unmount/navigation/dispose); double-settle diagnostics |
| Client tape is not durable truth | A tab can die mid-flight | AttemptIds double as Idempotency-Keys so the server stays authoritative; flow resume re-verifies via skip semantics |
| Bundle creep | Every feature wants into core | Single-file size-gated core; everything else is a sub-path; taps/transports unreachable from a core import |
| Exposure is recoverable only from `begun` marks | Once a settled attempt is LRU-evicted, its `exposure` is no longer re-derivable | The data boundary requires a lost policy to fail closed, not default to `"full"` — [#5](https://github.com/catalint/telic/issues/5) tracks the fix; today's fallback is a KNOWN leak, not a settled design |
| `flow()` can upgrade a `local` child's reach | Aggregating child outcomes into the parent's fulfilled mark is convenient for downstream steps | The parent must carry the strictest child exposure (never upgrade) — [#8](https://github.com/catalint/telic/issues/8) tracks the fix; today's aggregation is a KNOWN leak |
