# Design pass — cross-realm dispatch (PROPOSALS PR-2)

Status: **DESIGN MATERIAL — not decided.** This document is the design pass PR-2
requires "before any code." It argues every choice against the two boundaries in
[DESIGN.md](../../DESIGN.md) (initiative + data) and reuses existing SPEC
semantics wherever it can. Nothing here is normative until a DECISIONS entry
lands; the draft entry at the end (§8) is the material for that decision, not the
decision. Clause references are to [SPEC.md](../../SPEC.md).

---

## 1. Problem statement and the boundary-respecting frame

`dispatch(name, payload)` resolves a handler in **one runtime's** mediation
registry (S15). Records already cross realms — BroadcastChannel (S22),
postMessage (S23), SharedWorker (S24) forward *marks*, so the caller can *observe*
a `handle` in another tab/iframe/worker settling. But the **command** does not
cross: you cannot `dispatch` to a handler registered in another realm. telic does
observation across the line and stops at same-realm for invocation. That asymmetry
is PR-2's gap.

The naive fix — "remote dispatch" where telic opens a channel, delivers the call,
tracks the pending reply, and times it out — is exactly what the **initiative
boundary** forbids: telic would own transport and time. So the frame, taken
verbatim from PR-2 and load-bearing for everything below:

> **The caller owns the channel. telic contributes only correlation.**

Concretely, an `AttemptId` travels over the caller's channel; the remote runs its
own local `handle`; settlement flows back over the mark transports telic already
ships (S22–S24), stitched to the originating attempt by that id. telic never
opens, times, retries, or reconnects a channel — a dead channel is the app's
problem, exactly as S24.3 already states for SharedWorker ports.

**The reuse spine (the whole pitch).** The caller `begin()`s a *real live
attempt* for the crossing. Because it is an ordinary attempt, everything the rest
of this document needs comes for free from existing clauses:

- first-write-wins settlement (S3.4) → replayed/duplicated remote settlements are
  idempotent;
- `abandonWhen` (S2.6) → the caller bounds the wait with its own AbortSignal, no
  telic timer;
- navigation / pagehide / unmount auto-abandon (S10.6) → a crossing the user
  walks away from abandons truthfully;
- `inProgress()` never lies (S4.4, active attempts pinned) → "what is the user
  mid-way through" stays answerable while the command is in flight.

The design's job is to add the *correlation seam* and name the *one* thing that
does not already fall out of these clauses. Everything else is wiring.

---

## 2. The wire question — does the mark envelope (S19) suffice?

Two legs to a cross-realm dispatch: the **request** (caller → remote: "run your
handler for `name` with this `payload`, correlated to `X`") and the **return**
(remote → caller: the settlement). They have opposite answers, and the split is
the cleanest result in this pass.

### The return leg reuses S19 unchanged

Settlement genuinely *is* marks. When the remote handler settles, it emits
`fulfilled` / `rejected` / `abandoned` for attempt `X` — ordinary marks, already
serializable by `serializeMarks` (S19.2), already carrying `attempt: X` and an
`origin` stamp (S19.1, `MarkOrigin`). They ride the existing transport (S22–S24)
back to the caller. No new envelope, no new field. This is precisely what "flows
back over existing mark transports, stitched by id" means, and it needs nothing.

### The request leg needs its own envelope — and *must not* reuse the mark envelope

The tempting shortcut: a `begun` mark already carries `{ intent, attempt: X,
payload }` (S2.1). Forward it, and isn't that the dispatch? Add a
`replyExpected` flag and reuse the envelope?

**No — and the reason is the data boundary, not convenience.** A mark is a record
that something *happened*; `ingest()` (S10.3) is pure observation — it appends,
re-seqs, and delivers to taps/listeners, and it **never acts**. If a forwarded
`begun` could trigger a handler, then *every* cross-tab observed `begin` — every
gossiped mark from S22 — would execute a remote handler. A user starting a
checkout in tab A would fire tab B's checkout handler. That is the initiative
boundary breached through the data path: ingest would have become a dispatcher.

So the request must be a **distinct envelope**, consumed *only* by an explicitly
wired remote-dispatch **receiver**, never by `ingest()`. Observation stays
non-acting; invocation is opt-in at the receiver seam. Sketch altitude:

```ts
// return leg: the existing S19 mark envelope, untouched
{ v: 1, marks: [ /* fulfilled/rejected/abandoned for X, origin-stamped */ ] }

// request leg: a NEW, separate envelope — only a wired receiver acts on it
{ v: 1, dispatch: { intent: "cart.addItem", attempt: X, payload, ifUnhandled: "reject" } }
```

The request envelope carries exactly the four things PR-2's open question names:
payload, `AttemptId`, intent name, and the no-handler policy (`ifUnhandled`,
which subsumes the "reply-expected" flag — a `park` request expects a reply
whenever the remote eventually registers; a `reject` request expects one
promptly or not at all; see §4). It reuses the wire's `{ v: 1, … }` versioning
(S19.2) and its tolerant-reader discipline (unknown shape → dropped, never
misread).

**Answer:** the mark envelope suffices for the *return* leg and must be reused
there; the *request* leg needs a distinct envelope and must **not** be folded
into a mark, because folding it would make `ingest` side-effecting — the single
most dangerous thing this feature could do.

---

## 3. The `handled` probe across the wire

Same-realm, `describe().handled` (S12.5) reads the runtime's own registry
synchronously. Across a realm there is no synchronous registry to read. Three
ways to answer "will the remote handle this?":

**(a) Round-trip probe.** Caller sends "do you handle `name`?", awaits a reply.
The reply either arrives or it doesn't — and "it didn't arrive *yet* vs. never"
is a **timeout**, which telic would have to own. Rejected on sight: it puts a
timer telic owns on the critical path, the exact initiative-boundary violation
the whole frame exists to avoid.

**(b) Advertised manifest.** The remote forwards its `describe()` (S12.1, an
already-frozen, agent-legible catalog) on connect and on change; the caller keeps
a local mirror and consults it before dispatching. No telic timer — the caller
owns refresh cadence. Useful, but **honest-stale**: a mirror can only ever report
what the remote last advertised, and the window between a remote unregistering and
the caller learning is unavoidable. So a manifest is a *discovery hint*, never an
authority.

**(c) Optimistic dispatch with remote `NO_HANDLER`.** Don't probe. Send the
dispatch. If the remote has no handler, its *local* `dispatch` rejects with
`{ code: "TELIC_NO_HANDLER" }` (S15.3) — an ordinary `rejected` mark that flows
back and settles the caller's attempt. No probe, no timer, and the failure is
observable through the exact same channel as success.

**Pick (c) as the mechanism, offer (b) as optional discovery.** Argument against
the boundary: (c) introduces no timer telic owns. The caller's `abandonWhen`
(S2.6) — already passed to every dispatch — bounds *everything*: if the remote
answers (handled or `NO_HANDLER`), the attempt settles from that answer; if the
remote is silent (realm not loaded, channel dead), the attempt stays active until
`abandonWhen` (or navigation) abandons it. telic times nothing; the caller's
signal is the only clock.

This produces one honest, slightly surprising consequence worth stating loudly:

> With the default `ifUnhandled: "reject"`, an **absent** realm produces no
> `NO_HANDLER` — silence is not a rejection. So across the wire, "reject on
> unhandled" degrades to **abandon-on-deadline**: a present-but-unhandling realm
> rejects promptly; an absent realm is indistinguishable from a slow one and ends
> in `abandoned { why: "signal" }` when `abandonWhen` fires.

That degradation is not a bug to fix — fixing it *is* the round-trip timeout of
(a). It is the truthful shape of "we contribute correlation, not delivery." The
manifest (b) exists precisely so a caller who needs to *know* before dispatching
can consult a mirror instead of dispatching into silence — but the mirror's
staleness is the caller's to weigh, and telic keeps no ground truth.

---

## 4. Parked dispatch (S15.7) × remote

Same-realm, `ifUnhandled: "park"` keeps an attempt active until a handler
registers, then drains FIFO synchronously downstream of `handle()` (S15.7). What
does "park" mean when the handler is in another realm that may never load?

The resolution is that **park is a remote-side state; the caller-side state is
always just "an active attempt bounded by `abandonWhen`."** The request envelope
carries `ifUnhandled` to the remote, and the remote's *local* mediator does the
parking — the remote runs `dispatch(name, payload, { ifUnhandled: "park", … })`
against the injected id (§5, the settlement-only correlated run). All of S15.7's
guarantees hold *in the remote realm*: no timers, FIFO drain on the remote's
`handle()`, park-queue exit on abandon. The caller contributes only the id and
the payload; it parks nothing itself.

The caller therefore **cannot distinguish** "parked remotely, waiting for the
remote's island to mount" from "request lost on a dead channel" from "realm never
loaded" — all three look like one active attempt and one silent channel. That
indistinguishability is honest: distinguishing them needs an ack or a manifest,
i.e. telic owning delivery or a registry. It does not, so it cannot tell them
apart, and it says so (§9).

Interaction table (caller dispatches with the row's `ifUnhandled`; columns are the
remote's state):

| caller `ifUnhandled` → remote state | remote handler registered | remote realm loaded, **no** handler | remote realm **absent** / channel dead |
|---|---|---|---|
| **`reject`** (default) | remote runs, settles, terminal mark returns → caller attempt settles | remote's local dispatch rejects `TELIC_NO_HANDLER` (S15.3); `rejected` mark returns → caller attempt **rejected** | silence — no mark returns; caller attempt stays active → **abandoned** when `abandonWhen`/navigation fires (§3 degradation) |
| **`park`** | remote runs, settles, terminal mark returns → caller attempt settles | remote **parks** locally (S15.7), no diagnostic; drains when its `handle()` registers → terminal mark returns; caller attempt stays active meanwhile (truthful: pending), bounded by `abandonWhen` | silence — caller attempt stays active → **abandoned** on deadline; whatever the remote may later park is unreachable and irrelevant |

Two properties fall out and are worth stating:

- **The remote never re-parks across a configure.** S15.7/S15.1 already say
  parked queues do not survive `configureDefaultRuntime` — the old runtime's
  attempts belong to it. A remote that reconfigures drops its park queue; the
  caller's attempt, oblivious, waits on its own `abandonWhen`. Consistent with the
  existing rule, no new one.
- **`no-handler` diagnostics stay local to the realm that fired them.** A remote
  reject fires `no-handler` on the *remote* runtime (S15.3); the caller sees a
  `rejected` mark, not a diagnostic. A remote park fires no diagnostic at all
  (S15.7). Nothing new.

---

## 5. Failure modes

Each maps to an existing clause or names the one genuinely-new rule. The reuse
spine (§1) is doing the work: because the caller holds a real live attempt, most
of these are *already specified*.

### 5.0 The one thing that does NOT already fall out — settling the live handle

First, the gap the design pass exists to name. "Settlement flows back as marks"
is necessary but **not sufficient**. `ingest()` (S10.3) updates/creates attempt
**records** — the attempt index (S4.4). The live `Attempt` object the caller is
awaiting (its `.settled` promise, its `.signal`) is a *different construct*;
nothing in S10.3 resolves it. So a foreign `fulfilled X` lands on the tape, the
record shows fulfilled, and `.settled` **never resolves**. Stitching-by-id is the
mechanism PR-2 glosses, and here it is, explicit. Two candidate rules, presented
as a tradeoff because this is a draft:

**Candidate A — settle-from-ingest (a core rule).** `ingest`, on seeing a
terminal mark whose `attempt` matches a still-*active local* attempt, drives that
attempt to its terminal phase, **first-write-wins, without re-emitting**. Result:
one terminal mark (foreign-origin) on the caller tape, no echo, and the rule
generalizes beyond remote-dispatch (any ingested settlement for a live local
attempt resolves it). *Cost:* it touches the 5 KB size-gated core, and it makes
`ingest` — today purely observational — able to settle a live handle. That is a
real widening of core's contract.

**Candidate B — consume-to-settle (transport-owned).** The caller-side
remote-dispatch receiver holds the `{ AttemptId → live Attempt }` table for its
in-flight crossings, consumes the return leg as a settlement signal, and calls
`handle.fulfill(outcome)` / `handle.reject(reason)` itself. *Core untouched.*
*Cost:* the caller re-emits a **local-origin** terminal for `X` (provenance says
"settled here," not "settled at the remote" — a fidelity loss vs. Candidate A's
foreign-origin terminal), and that local terminal is eligible to re-forward
outward, so **loop-safety (S22.2, "never forward marks that already carry a
foreign origin") is what must stop the echo** — the caller's local terminal *does*
forward once to the remote, where the remote's `X` is already terminal, so it is
absorbed first-write-wins (S3.4). One extra in-flight mark, harmless.

**Lean: Candidate B.** It matches the codebase's sharpest current — "taps/
transports unreachable from a core import," "core never imports wire," the ~5 KB
core anchor (DESIGN "Risks we carry knowingly," §6 below). Every other cross-realm
concern in telic is a transport leaf; a house reviewer will rightly ask why *this*
one reaches into core when none of S22–S24 did. Candidate A is the cleaner
end-state and the better provenance, and it is logged as the considered-heavier
alternative (§7) — if a second consumer for "ingest settles a live attempt"
appears, A stops being remote-dispatch-only and earns the core change. Until then,
B keeps the boundary where the rest of the library keeps it.

Everything below assumes the live handle *does* get settled (by A or B) and shows
that the rest is pre-existing semantics.

### 5.1 Dead channel mid-flight

No settlement mark ever returns. The caller's attempt stays active. Nothing telic
owns fixes this — and nothing should: **S24.3** already rules "a dead port is the
app's problem to reconnect." The caller's `abandonWhen` (S2.6) or navigation
auto-abandon (S10.6) resolves the attempt to `abandoned`. Existing semantics; the
honest terminal state for "we never heard back."

### 5.2 Remote handler throws

The remote's local dispatch rejects the attempt with the thrown value and does
**not** rethrow (**S15.4**); it emits a `rejected` mark for `X`. That mark returns
and settles the caller's live attempt (per 5.0). The caller observes the rejection
via `.settled`, which never rejects (S3.9). Existing semantics end to end.

### 5.3 Double-settle from a replayed remote settlement

Transports gossip; BroadcastChannel can echo; the SharedWorker hub re-broadcasts
(S24.1). The same `fulfilled X` can arrive twice. **First-write-wins (S3.4)**: the
second settle is ignored, emits no mark, produces a `double-settle` diagnostic,
never throws. Idempotency of the return leg is *free* — it is the same property
that already protects manual double-settle. This is the strongest argument for the
"caller holds a real live attempt" model: replay safety is not designed, it is
inherited.

### 5.4 The same dispatch reaching two realms

Two remotes both hold a handler for `name`; the caller's channel fans the request
to both (or two hubs bridge it). Both run. Both emit a terminal for `X`. First
back wins (S3.4); the second is a `double-settle` no-op. So **settlement is
single** — but **execution was not**: two handlers actually ran, two side effects
happened.

This is the one genuinely-new semantic gap, and it must be named rather than
papered over. Same-realm, "one handler per intent per registry" (S15.1) makes
single-execution structural. Across the wire, registries are **per-realm**
(S15.1, D18) — telic cannot enforce one executor across realms it does not own.
So:

> **New rule (a limit, not a mechanism): cross-realm dispatch guarantees single
> *settlement*, not single *execution*. Fan-out routing across realms is the
> caller's responsibility. The mitigation is the one telic already ships — the
> `AttemptId` doubles as an Idempotency-Key (S3, `AttemptId` doc; the `flow()`
> story, S16), so two executions of `X` collapse to one effect at the
> idempotent server.**

telic records that both ran (two `rejected`/`fulfilled` marks for `X`, one
winning); the caller reconciles; the server dedupes on `X`. That is consistent
with the whole posture — telic correlates, the execution layer executes, the
server is authoritative (DESIGN "Why `flow` hands you the coordinator").

---

## 6. Subpath — extend `/mediate` or a new `/transports/remote-dispatch`?

Two candidate homes, decided on the size-gate and the "taps/transports unreachable
from a core import" rule (DESIGN "Risks we carry knowingly").

**Against `/mediate`.** `mediate` imports `./core`; its standalone bundle pulls
all of core in, so its budget sits at 5250 B near core's, not at a tap's
(`scripts/size-gate.ts` header). `mediate` is the *same-realm synchronous command
path* — the module whose entire identity is "handlers run in the caller's frame,
no transport." Folding serialization, a channel seam, a pending-dispatch table,
and wire-format coupling into it (a) makes every local dispatcher pay bytes for a
transport they do not use, and (b) drags transport concepts into the one module
that is supposed to have none. Wrong altitude and wrong budget.

**For `/transports/remote-dispatch`.** Remote dispatch is a transport-adjacent
concern: it serializes over a caller-provided channel and uses the wire format
(S19), exactly like S22–S24. Those transports are *leaves* — they import `wire`
(1050 B) and take the `runtime` as a parameter; they do **not** import core, and
they sit unreachable from a core import (the load-bearing size property). A new
leaf:

- gets its own size-gate budget row (peers: broadcast 1750, post-message 1750,
  shared-worker 2130) and a co-located test, per the AGENTS "New subpath
  checklist";
- imports `wire` + types only. Its **remote half** needs a mediator to run the
  local handler — but it takes that mediator *structurally injected* (like every
  transport takes its channel via `channelFactory`), so the module never *imports*
  `/mediate`; it composes an already-present one. The leaf stays a leaf;
- keeps `/mediate` at its current size and keeps transport/serialization out of
  the command path.

**Decision: a new `/transports/remote-dispatch` subpath.** It is a transport, it
is priced like one, and it is unreachable from a core import — the same shape the
codebase already chose three times for the mark transports.

---

## 7. Rejected alternatives

House style — what was considered and why not.

- **telic-owned channels.** telic opens/holds the `MessagePort` /
  `BroadcastChannel` / `Worker`, delivers the call, tracks pending replies, times
  them out. Rejected: owns transport *and* time — a double breach of the
  initiative boundary and the precise thing PR-2's frame exists to prevent. The
  caller owns the channel, always.

- **Request/response RPC à la Comlink.** An ES-Proxy marshals the call, awaits the
  return, re-throws remote errors across the boundary. Rejected: makes telic a
  transport with delivery + re-throw semantics and a telic-owned pending-reply
  table with a timeout; and it fights telic's own contract that dispatch *never
  throws* (observe via `.settled`, S15.3/S15.4). Comlink already does this well
  and **composes** — a Comlink-exposed worker method can be what a local `handle`
  calls (COMPARISON, Comlink verdict). We do not reimplement it.

- **A broker / central dispatch registry.** A SharedWorker owns a *global* handler
  registry and routes dispatches to whichever realm registered. Rejected: telic
  owning routing, delivery, and a central authority with a pending table and
  timeouts. The SharedWorker hub (S24) is deliberately authoritative for
  *snapshot/observation* and **not** for invocation — extending it to route
  commands would make it the framework-with-opinions the design forbids.

- **Round-trip `handled` probe with a timeout.** (§3a.) Rejected: "did the probe
  time out?" is a timer telic owns. Optimistic dispatch + the caller's
  `abandonWhen` bounds everything without one.

- **Remote-authoritative id / caller-observes-only.** The caller does not begin;
  the remote mints the id and begins; the caller only *observes* returning marks
  and holds a bespoke correlation handle. Rejected: it forfeits the entire reuse
  spine (§1) — no real live attempt means no free first-write-wins, no free
  `abandonWhen`, no free navigation auto-abandon, no truthful synchronous
  `inProgress()`, and it needs a hand-built abandon path. The reason is that list
  of lost clauses, not aesthetics. Caller-minted id + a real live attempt (Model
  A) is what makes §5 mostly a citation exercise.

- **settle-from-ingest as a core rule (Candidate A, §5.0).** Considered, not
  rejected — *deferred*. It is the cleaner end-state (foreign-origin provenance,
  generalizes, no echo) but touches the size-gated core for a single consumer.
  Logged here as the sanctioned upgrade path: when a second consumer for "an
  ingested settlement resolves a live local attempt" appears, Candidate A earns
  the core change; until then, transport-owned consume-to-settle (Candidate B)
  keeps the boundary where the rest of the library keeps it.

- **Overloading the mark envelope with an `invoke` flag.** (§2.) Rejected: makes
  `ingest` side-effecting — every forwarded `begun` becomes a remote execution.
  The request leg gets its own envelope, consumed only by a wired receiver.

---

## 8. DRAFT DECISIONS entry

> **DRAFT — NOT YET DECIDED.** Written in D-entry prose so the eventual decision
> can be lifted or amended in one move. Do not copy into DECISIONS.md until the
> decision is actually made.

**D-next (DRAFT — takes the next free number when decided). Cross-realm dispatch = correlation over a caller-owned channel; a
new `/transports/remote-dispatch` leaf, zero new time or transport ownership.**
PR-2 asked telic to let `dispatch` reach a handler in another realm.
Adopted frame (from PR-2, load-bearing): the caller owns the channel; telic
contributes only correlation. Shape: the caller `begin()`s a real live attempt
`X` and sends a **distinct request envelope** `{ intent, attempt: X, payload,
ifUnhandled }` over its channel; a wired remote **receiver** runs the remote's
*local* handler against the injected id (settlement-only, no re-begun); settlement
returns as **ordinary marks over the existing transports** (S22–S24, no new return
envelope), stitched to `X`. `handled` is answered by **optimistic dispatch** —
absent handler → remote `TELIC_NO_HANDLER` (S15.3) returns as a `rejected` mark;
absent *realm* → silence → `abandonWhen`/navigation abandons `X` (reject degrades
to abandon-on-deadline). An advertised **manifest** (forwarded `describe()`) is an
optional, honest-stale discovery hint, never an authority. Parked dispatch (S15.7)
is a **remote-side** state; the caller side is always "active bounded by
`abandonWhen`." Housed as a new size-gated **transport leaf**
(`/transports/remote-dispatch`), wire-only imports, mediator injected
structurally — never inside `/mediate`, never reachable from a core import.
Because the caller holds a real live attempt, first-write-wins (S3.4),
`abandonWhen` (S2.6), navigation auto-abandon (S10.6), and truthful `inProgress()`
(S4.4) are inherited, so replay-idempotency, dead-channel abandonment, and
race-safety need no new rules.
**One open sub-decision (settling the live handle):** ingest updates *records*,
not the live `Attempt` (S10.3/S4.4), so a returning terminal mark does not by
itself resolve `.settled`. Two candidates — **A) settle-from-ingest** (a core rule:
an ingested terminal for a live local attempt drives it terminal, first-write-wins,
no re-emit; cleaner, foreign-origin provenance, generalizes; **cost:** touches
core) and **B) consume-to-settle** (transport-owned: the receiver's
`{ id → attempt }` table calls `fulfill/reject`; core untouched; **cost:**
local-origin re-emitted terminal, echo stopped by loop-safety S22.2). **Leaning
B** to keep the boundary where S22–S24 keep it; A logged as the deferred upgrade
when a second consumer appears.
**One new limit, named, not a mechanism:** cross-realm dispatch guarantees single
**settlement**, not single **execution** — per-realm registries (D18) make "one
handler per intent" unenforceable across realms; the `AttemptId`-as-Idempotency-Key
(the `flow()` mitigation, S16) is what makes a double execution safe at the
server. **Rejected:** telic-owned channels; Comlink-style RPC with re-throw + a
telic pending/timeout table (composes instead); a SharedWorker broker owning a
global registry (S24 is authoritative for observation, not invocation); a
round-trip probe with a telic-owned timeout; remote-authoritative id /
caller-observes-only (forfeits the reuse spine); overloading the mark envelope
with an `invoke` flag (would make `ingest` act). SPEC (when decided): new S28
`transports/remote-dispatch`; a request-envelope addition beside S19; the chosen
live-handle-settlement rule as an S10.3 amendment (Candidate A) or an S28 receiver
clause (Candidate B); an S15 cross-reference for the single-settlement-not-
single-execution limit.

---

## 9. What this does NOT give you

Stated plainly, because the frame's honesty is the whole reason it stays on the
right side of the boundary. Cross-realm dispatch is correlation, not delivery.

- **No delivery guarantee.** telic does not ack, retry, or confirm receipt. A
  request dropped on a flaky channel is silently lost; the caller's attempt sits
  active until `abandonWhen`/navigation abandons it. If you need at-least-once
  delivery, that lives in the channel you own, not in telic.

- **No discovery / no cross-realm presence authority.** The advertised manifest
  (§3b) is a stale mirror of the remote's last `describe()`, not a live registry.
  telic cannot tell you, synchronously and truthfully, whether a handler exists in
  another realm right now — that would require owning a registry across realms it
  does not own. `describe().handled` remains a *per-runtime* truth (S12.5, D18).

- **Dead ports are the app's problem.** No reconnection, no keep-alive, no
  channel health. **S24.3** already states this for SharedWorker and it holds
  verbatim here: a dead channel is the app's to detect and rebuild; telic owns no
  timer that would notice.

- **Single settlement, not single execution.** (§5.4.) If the same dispatch
  reaches two realms, two handlers run. telic records both and settles once
  (first-write-wins); collapsing two *effects* into one is the server's
  idempotency job, keyed by the `AttemptId`. telic is not a deduplicating broker.

- **No ordering / no exactly-once on the wire.** Transports gossip and can
  duplicate; the return leg is made idempotent by first-write-wins (S3.4), not by
  telic sequencing the channel. Order across realms is whatever the caller's
  channel provides.

- **No cross-realm type safety beyond a shared augmentation.** The `IntentRegistry`
  augmentation (S12/COMPARISON) types a dispatch only where both realms compiled
  against the same declaration. Across independently-built bundles the payload is
  `unknown` at the boundary unless the contract subpath is shared at build time —
  the same single-shared-instance caveat PR-3 hardens for the recording side.

Strip any of these and you are asking telic to own time or transport. It will not
— which is exactly what lets it sit alongside Comlink, Module Federation, and a
SharedWorker hub instead of competing with them (COMPARISON verdicts).
