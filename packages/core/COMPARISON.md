# telic vs. the alternatives — P7 (dispatch across boundaries) in context

This doc compares telic's mediation layer (`handle`/`dispatch`/`command` — PATTERNS
[P7](PATTERNS.md), SPEC [S15](SPEC.md)) against the libraries that solve nearby
problems. It is the code-level companion to the shorter takes in the root README's
"Isn't this just X?" section.

**Bias, stated up front:** where telic and an incumbent are a genuine wash, this doc
recommends the incumbent. telic is a narrow tool — it earns its keep on exactly two
things (a recorded lifecycle with a first-class `abandoned`, and a machine-legible
agent surface), in exactly one place (the browser). If you don't need both, one of the
libraries below is very likely the better choice, and each section says so.

## What P7 actually is

`handle("cart.addItem", …)` registers **exactly one** executor for a named capability.
`dispatch("cart.addItem", { sku })` (or a typed `command()` stub) invokes it — from
another domain, or an AI agent — **without importing the owner**. The crossing is
recorded as an attempt with a lifecycle (`begun → fulfilled | rejected | abandoned`)
that four consumers share: error breadcrumbs, analytics, other frontend domains, and
agents.

The *mechanism* — call one handler by name across a module boundary — is **not novel**.
It is the command-bus / mediator pattern, mature since MediatR (~2014). What is
uncommon is the *combination* the sections below isolate.

## How to read the verdicts — the axes that matter

| Axis | Why it separates telic from the pack |
|---|---|
| **Single-executor vs fan-out** | `dispatch` → one handler (last-wins). Fan-out is `on()`'s job. Comparing `dispatch` to an event emitter compares the wrong halves. |
| **Lifecycle with first-class `abandoned`** | Command buses model request→response. None express "the user walked away" (≠ failure) in real time. |
| **Initiative boundary** | telic never owns time or transport — handlers run synchronously in the caller's frame. No retries/queues/timers/pipeline. |
| **Type safety across the boundary** | Global `IntentRegistry` augmentation + `command()` stubs vs class-as-message / generics / bare strings. |
| **Agent-legible surface** | `describe()` + `inProgress()` + `window.__INTENT_MEMORY__` — an enumerable capability catalog and "what is the user mid-way through". Genuinely rare. |
| **Target runtime** | telic is browser-first. Most true analogs are server-side. |

The canonical telic shape every "after" below is a variation of:

```ts
// contract.ts — the cart domain owns the string + the types, in ONE place
import { command } from "@telic/core/mediate"
import type { IntentTypes } from "@telic/core"
declare module "@telic/core" {
	interface IntentRegistry {
		"cart.addItem": IntentTypes<{ sku: string }, { lineId: string }>
	}
}
export const addToCart = command("cart.addItem")   // typed stub

// cart.handlers.ts — the cart domain registers the ONE executor
import { handle } from "@telic/core/mediate"
handle("cart.addItem", async (attempt, item) => addItem(item, { idempotencyKey: attempt.id }))

// anywhere else — another domain, or an AI agent — invokes without importing cart:
import { addToCart } from "@org/cart/contract"
const attempt = addToCart({ sku })
const phase = await attempt.settled   // "fulfilled" | "rejected" | "abandoned" — never throws
```

---

## MediatR (.NET) — the canonical mediator

The reference implementation of the pattern P7 ports. [github.com/jbogard/MediatR](https://github.com/jbogard/MediatR)

**Before** — request, single handler, `Send` (from the MediatR wiki):

```csharp
public class Ping : IRequest<string> { }

public class PingHandler : IRequestHandler<Ping, string>
{
	public Task<string> Handle(Ping request, CancellationToken ct) => Task.FromResult("Pong");
}

var response = await mediator.Send(new Ping());   // resolves the one handler via DI
```

**After** — the same single-executor dispatch, telic:

```ts
declare module "@telic/core" {
	interface IntentRegistry { "diagnostics.ping": IntentTypes<void, string> }
}
handle("diagnostics.ping", async () => ({ ok: true, data: "Pong" }))

const attempt = dispatch("diagnostics.ping")
const phase = await attempt.settled   // observe terminal phase; the "Pong" is on the fulfilled mark
```

**Verdict — MediatR, if you're on .NET.** The two are the same idea: one handler per
request, invoked by the caller without importing it. MediatR is more mature, has a real
pipeline (`IPipelineBehavior` for validation/logging/retry), and is native to the server
where the pattern belongs. telic differs on three deliberate lines, none of which matter
on a .NET backend: it models `abandoned` (MediatR has only request→response +
`CancellationToken`), it *refuses* the pipeline (the initiative boundary — cross-cutting
work is a tap or the caller's, never telic's), and it exposes the capability set to
agents. If you're writing C# server code, use MediatR. telic is for the browser, where
MediatR doesn't go and the lifecycle/agent surface pays.

> Prior art for P7's **discipline** ("imports within them", [AP4](PATTERNS.md)) lives
> in MediatR's own community: Arialdo Martini's
> ["You probably don't need MediatR"](https://arialdomartini.github.io/mediatr) debate,
> and the observation that Bogard's own DDD examples carry no MediatR reference *inside*
> the domain. AP4 is that argument, aimed at the browser.

---

## NestJS CQRS (`@nestjs/cqrs`) — the closest live analog

The nearest thing to P7 in the TypeScript world. [docs.nestjs.com/recipes/cqrs](https://docs.nestjs.com/recipes/cqrs)

**Before** — command, single handler, `commandBus.execute`:

```ts
export class KillDragonCommand extends Command<{ actionId: string }> {
	constructor(public readonly heroId: string, public readonly dragonId: string) { super() }
}

@CommandHandler(KillDragonCommand)
export class KillDragonHandler implements ICommandHandler<KillDragonCommand> {
	constructor(private repo: HeroesRepository) {}
	async execute(command: KillDragonCommand) { /* … */ return { actionId: crypto.randomUUID() } }
}

return this.commandBus.execute(new KillDragonCommand(heroId, dragonId))
```

**After** — telic:

```ts
declare module "@telic/core" {
	interface IntentRegistry {
		"combat.killDragon": IntentTypes<{ heroId: string; dragonId: string }, { actionId: string }>
	}
}
handle("combat.killDragon", async (attempt, { heroId, dragonId }) =>
	repo.killDragon(heroId, dragonId, { idempotencyKey: attempt.id }))

const attempt = dispatch("combat.killDragon", { heroId, dragonId })
```

**Verdict — a near-tie; NestJS CQRS wins on the server, telic on the client.** Both are
single-executor command buses (NestJS: one `@CommandHandler` per command; per the
[Telerik write-up](https://www.telerik.com/blogs/building-nestjs-applications-following-the-cqrs-model),
duplicate command handlers are last-wins, exactly telic's `handler-replaced`). The real
differences:

- **Boundary crossing.** NestJS resolves the handler through the Nest DI container +
  decorator metadata at bootstrap. telic resolves through a runtime name registry that
  registers/unregisters with **UI presence** (a handler exists only while its island is
  mounted; "no handler" is a *truthful* state — [P10](PATTERNS.md)), and absorbs
  mount-order races with **parked dispatch**. A DI composition root assumes the handler
  always exists; a code-split browser can't.
- **Typing.** NestJS uses class-as-message + `@CommandHandler` decorator + `ICommandHandler`.
  telic uses a string name + Standard Schema payload + `IntentRegistry` augmentation, so
  the same name is callable by an **agent** with a JSON payload — a class instance is not.
- **Lifecycle + reach.** NestJS commands are request→response; its `@Saga()` reactively
  turns events into commands (RxJS). telic models `abandoned` directly and coordinates
  multi-domain sagas with an explicit `flow()` coordinator, not choreography ([AP3](PATTERNS.md)).

If you already run NestJS on the server, its CommandBus is the right tool there. In the
browser telic is the closer fit — CQRS on the client without a DI container, plus the
lifecycle and agent surface.

---

## ts-bus — a typed event bus (the `on()` analog, not `dispatch`)

Included because it's the library people reach for first — but it's the counterpart to
telic's `on()`, not its `dispatch`. [github.com/ryardley/ts-bus](https://github.com/ryardley/ts-bus)

**Before** — define, subscribe (fan-out), publish:

```ts
import { EventBus, createEventDefinition } from "ts-bus"
export const someEvent = createEventDefinition<{ url: string }>()("SOME_EVENT")

const bus = new EventBus()
bus.subscribe(someEvent, (event) => { /* any number of subscribers */ })
bus.publish(someEvent({ url: "https://github.com" }))
```

**After** — the honest mapping is to `on()`, not `dispatch`:

```ts
declare module "@telic/core" {
	interface IntentRegistry { "nav.open": IntentTypes<{ url: string }> }
}
// telic's fan-out side — plus a tape behind it, so late subscribers hear the past:
on("nav.open", (event) => { /* … */ }, { replay: true })
```

**Verdict — ts-bus (or `mitt`/`nanoevents`), if all you need is pub/sub.** It's tiny,
zero-ceremony, and does one thing well. Reach for telic's `on()` over it only when you
need what a bus structurally can't give: **a tape behind the bus** (a subscriber that
mounts late still hears what already happened — decisive in islands/micro-frontends where
mount order is undefined), and **lifecycle on every signal**, not just a payload. And note
the category error to avoid: ts-bus is fan-out (it decorates EventEmitter2 — every
subscriber gets the event, no return value collected). telic's `dispatch` is
single-executor. They are not the same layer.

---

## Comlink — RPC across a worker/iframe boundary

The closest thing to "invoke a capability you didn't import" — but across a *thread*,
not a module. [github.com/GoogleChromeLabs/comlink](https://github.com/GoogleChromeLabs/comlink)

**Before** — expose in the worker, wrap on the main thread, call as if local:

```js
// worker.js
const api = { async addItem(sku) { /* … */ return { lineId } } }
Comlink.expose(api)

// main.js
const api = Comlink.wrap(new Worker("worker.js"))
const { lineId } = await api.addItem("SKU-1")   // ES Proxy → postMessage → worker
```

**After** — telic dispatches across a *domain* boundary in the **same realm**:

```ts
handle("cart.addItem", async (attempt, { sku }) => addItem(sku, { idempotencyKey: attempt.id }))
const attempt = dispatch("cart.addItem", { sku: "SKU-1" })
```

**Verdict — Comlink, when the boundary is a worker or iframe.** Comlink is a genuinely
different boundary: it marshals calls over `postMessage` with an ES Proxy, crossing a
thread/process line telic's `dispatch` does not cross (telic resolves a handler in one
runtime's registry). Its typing is structural (`Remote<T>`), errors re-throw across the
boundary, and it has real teardown (`releaseProxy`, `finalizer`). Where telic differs is
orthogonal to the boundary: it *records* every crossing with a lifecycle and exposes the
capability to agents; Comlink is a transport that leaves no trace. They compose — a
Comlink-exposed worker method can be what a telic `handle()` calls. The open question of
telic *dispatching across* a worker/remote boundary (rather than only forwarding marks
across it) is tracked in [PROPOSALS.md](PROPOSALS.md).

---

## single-spa — micro-frontend cross-app communication

The framework that popularized in-browser micro-frontends. Notably, it ships **no**
command bus of its own. [single-spa.js.org/docs/faq](https://single-spa.js.org/docs/faq/)

**Before** — single-spa's own two recommended options:

```js
// (A) their PRIMARY recommendation: a direct ES import of another MFE's published package
import { userHasAccess } from "@org-name/auth"
const canInvoice = userHasAccess("invoicing")

// (B) or custom browser events (fan-out, stringly-typed, untyped `detail`)
window.dispatchEvent(new CustomEvent("user-login", { detail: user }))
window.addEventListener("user-login", (e) => { /* … */ })
```

**After** — a telic command channel between MFEs in one realm:

```ts
// auth MFE owns + registers (only while mounted → "no handler" is truthful)
handle("auth.hasAccess", async (_a, { permission }) => ({ ok: true, data: currentUser.can(permission) }))

// invoicing MFE invokes without importing auth — and it's typed + recorded:
const attempt = dispatch("auth.hasAccess", { permission: "invoicing" })
```

**Verdict — a real edge for telic on the command channel, with one caveat that tilts
back.** single-spa's *primary* recommendation is a direct static import across MFEs
(explicit coupling — exactly the reverse-dependency P7 is meant to dissolve), and its
decoupled option is untyped custom events with no lifecycle and no memory. telic's
`dispatch`/`handle` + `on(…, { replay: true })` is a strictly better cross-MFE channel:
typed, single-executor, recorded, and replay-backed so a late-mounting MFE hears the past.
**The caveat:** this only holds if every MFE shares **one** telic runtime instance.
Independently-built bundles duplicating `@telic/core` create two tapes that each hear half
the app — a real footgun the README flags and [PROPOSALS.md](PROPOSALS.md) proposes to
harden. If you can't guarantee a single shared instance, single-spa's custom events (which
ride the shared `window`) are the safer default.

---

## Module Federation — loading separately-deployed remotes

Often mentioned alongside micro-frontends, but it solves a different problem: **loading**
a remote, not **dispatching** to it. [webpack.js.org/concepts/module-federation](https://webpack.js.org/concepts/module-federation/)

**Before** — expose a module, resolve it at runtime by name+URL:

```js
// remote:  exposes: { "./Button": "./src/Button" }
// host:    remotes: { app1: "app1@http://localhost:3001/remoteEntry.js" }
const factory = await app1.get("./Button")   // dynamic, no static import
const Button = factory()
```

**After** — MF loads the chunk; telic dispatches into what it registered:

```ts
// the federated remote's chunk, when it evaluates, registers its handler:
handle("cart.addItem", async (attempt, { sku }) => addItem(sku, { idempotencyKey: attempt.id }))
// the host (or an agent) dispatches — parked until the remote's chunk has loaded + registered:
const attempt = dispatch("cart.addItem", { sku }, { ifUnhandled: "park", abandonWhen: AbortSignal.timeout(3000) })
```

**Verdict — not a competitor; a collaborator.** Module Federation owns *load transport*
(async chunk fetch + shared-scope handshake) and returns you one factory — it is
single-callee, untyped (`get(request: string)`), and models only a *load* lifecycle. It
ships no cross-remote command mechanism; teams build event buses on top of it. That's the
gap telic fills: MF brings the remote's code onto the page, telic's `dispatch`/`handle`
(with **parked dispatch** absorbing the load-then-register race) invokes and records it.
Use both. And the same single-instance caveat applies — declare `@telic/core` as a
`shared: { singleton: true }` dependency (see [PROPOSALS.md](PROPOSALS.md)).

---

## Redux (+ Redux Toolkit) — `dispatch(action)`

The direct ancestor, and the most common source of the "isn't this just dispatch?"
question. [redux.js.org](https://redux.js.org/tutorials/essentials/part-1-overview-concepts)

**Before** — action, reducer, `store.dispatch`:

```ts
const store = configureStore({ reducer: counterReducer })
store.dispatch({ type: "counter/increment" })   // fan-out to every reducer; each opts in by type
store.getState()   // { value: 1 }
```

**After** — telic records the *intent*, not the state transition:

```ts
declare module "@telic/core" {
	interface IntentRegistry { "cart.checkout": IntentTypes<{ cartId: string }, { orderId: string }> }
}
handle("cart.checkout", async (attempt, { cartId }) => placeOrder(cartId, { idempotencyKey: attempt.id }))
const attempt = dispatch("cart.checkout", { cartId })
```

**Verdict — Redux, for state; telic, for the intent behind it — and they coexist.** They
share a word and almost nothing else. Redux's `dispatch` fans an action out to every
reducer (broadcast, each opts in by `type` string) and the store *is* the executor,
synchronously producing new state; there is no lifecycle on the dispatch itself. telic's
`dispatch` invokes **one** handler, owns no state ([AP2](PATTERNS.md): "memory, not
truth" — if UI correctness depends on a value, it belongs in Redux, not telic), and
records a lifecycle. Tellingly, Redux Toolkit's `createAsyncThunk` re-derived
`pending/fulfilled/rejected` — the ecosystem rebuilt telic's lifecycle, minus `abandoned`.
Keep Redux/RTK/Zustand for state. Add telic when you want the *user goal* behind the state
change to be legible to error reports, analytics, and agents.

---

## DI containers (tsyringe / InversifyJS / awilix) — the "invoke without importing" half, typed

The strongest challenger to P7's *mechanism*: dependency injection lets domain A invoke
domain B's capability without importing B's class — and does it with **full static types**,
which a string-keyed dispatch throws away. [tsyringe](https://github.com/microsoft/tsyringe) ·
[InversifyJS](https://inversify.io) · [awilix](https://github.com/jeffijoe/awilix)

**Before** — tsyringe; the consumer depends on an *interface* + a token, never on the impl:

```ts
@injectable()
class Client {
	constructor(@inject("SuperService") private service: SuperService) {}
	// this.service.doWork() is fully typed — jump-to-definition lands on SuperService
}

// composition root — the ONE place that names the implementation:
container.register("SuperService", { useClass: TestService })
const client = container.resolve(Client)
```

(InversifyJS is the same shape, heavier — `container.bind<Weapon>('Weapon').to(Katana)` +
decorators + `reflect-metadata`. awilix drops decorators for a `cradle` proxy, but then the
type is tied to the concrete class, not an enforced interface.)

**After** — telic; the consumer depends on a typed stub, and the crossing is *recorded*:

```ts
const attempt = addToCart({ sku })      // typed via IntentRegistry — but a string name underneath
const phase = await attempt.settled     // ...and unlike a DI call, this crossing has a lifecycle
```

**Verdict — DI wins for decoupled wiring; telic wins only when the crossing must be seen or
agent-called.** This is the section where the incumbent is, for its own job, the better tool —
and telic's own docs agree. [AP4](PATTERNS.md) rejects in-domain dispatch precisely because it
is "stringly-typed indirection, broken jump-to-definition, a runtime registry standing in for
the module system" — and that is *exactly* the critique of a command bus versus DI. tsyringe
and InversifyJS keep the module system and the static types while decoupling; telic's dispatch
does not. If all you need is a decoupled, typed cross-domain call, **use a DI container.**

telic adds two things DI cannot, and both follow from the same root: DI decouples the *wiring*
and then gets out of the way, so the call itself is invisible.

- **Per-invocation lifecycle.** DI's only hooks (`beforeResolution`/`afterResolution` in
  tsyringe, `applyMiddleware` in InversifyJS) fire around *construction*. Once you hold the
  injected reference, every `service.doWork()` is a bare, unobserved function call. telic
  records each crossing as an attempt with `begun → fulfilled | rejected | abandoned`.
- **Agent-discoverable capabilities.** Every container exposes presence checks only —
  `isRegistered` (tsyringe), `isBound`/`getAll` (Inversify), `registrations` (awilix). None
  expose a typed argument/return *schema* an agent could use to discover and invoke a
  capability. telic's `describe()` is that catalog (and [PROPOSALS.md PR-1](PROPOSALS.md)
  proposes carrying the payload shape so an agent can build a valid dispatch).

The honest resolution is that **they compose**: use DI to wire dependencies with types intact,
and register a telic `handle()` only at the boundary that must be recorded or reached by an
agent — resolving that handler's own dependencies via tsyringe/inversify inside its body. DI
for the wiring, telic for the observed, agent-legible boundary.



## Vercel `composition-patterns` (agent skill) — the intra-tree neighbor

Not a command bus at all, but worth placing: Vercel ships an installable AI-agent skill
([vercel-labs/agent-skills → `composition-patterns`](https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns))
teaching coding agents how to structure React component APIs: avoid boolean props
(explicit variant components instead), build compound components over a shared context,
and — its stated core principle — *"lift state, compose internals, make state
dependency-injectable"*: a Provider owns the state implementation, UI consumes a generic
`{ state, actions, meta }` context interface and never knows whether state comes from
`useState`, Zustand, or a server sync.

**Before** — the skill's canonical shape (provider-injected state, context-composed UI):

```tsx
<ForwardMessageProvider>   {/* the ONLY place that knows how state is managed */}
	<Composer.Frame>
		<Composer.Input />
		<Composer.Submit />
	</Composer.Frame>
	<ForwardButton />        {/* outside the Frame, inside the provider — still reaches submit */}
</ForwardMessageProvider>
```

**After** — not a replacement; the composition point. The provider's `actions` are bare,
unrecorded function calls — a telic intent slots in as an action's *implementation*:

```ts
// inside ForwardMessageProvider — the skill keeps owning composition & state:
const submit = (draft: Draft): Promise<void> =>
	forwardMessage.run(draft, async (attempt) => sendForward(draft, { signal: attempt.signal }))
```

**Verdict — different layer; adopt both, and their disciplines rhyme.** The skill governs
composition *within* one component tree: its own sharpest line is that "the provider
boundary is what matters, not visual nesting" — components communicate through context as
far as a shared provider reaches. telic starts exactly where the provider ends: two trees
that share *no* provider (separately-owned MFEs, a late island, an AI agent) can't use
context at all, and that's the boundary `dispatch`/`on()` serve. On the skill's turf —
component API design — telic has nothing to say and the skill should win outright. Two
echoes worth noticing, though: its `architecture-avoid-boolean-props` rule ("each boolean
doubles possible states — make variants explicit") is the same design-linter move as
telic's `setter-like-name` diagnostic (a setter has no answerable `rejected`/`abandoned` —
make the intent explicit); and its `state-decouple-implementation` rule (swap
`useState`/Zustand/server-sync behind one interface) is telic's structural-injection
doctrine (S13/S20/S25 adapters) applied to state. Same instinct, different altitude. The
`actions` slot of its `{ state, actions, meta }` interface is where the two compose: an
action that crosses a real boundary is exactly the thing worth declaring as an intent.

---

## The distilled selling points (what P7 has that the field doesn't)

Collected from every section above — the things no single incumbent combines:

1. **First-class `abandoned`.** The one state no command bus, RPC layer, DI container, or
   event bus models: the user walked away, which is *not* a failure. Analytics derives it
   post-hoc in a warehouse; telic has it in real time.
2. **A recorded lifecycle on every cross-boundary call, shared by four consumers** —
   error breadcrumbs, analytics, other domains, agents — from the first declaration. The
   incumbents give you the call; telic gives you the call *and its history*.
3. **The initiative boundary.** telic never owns time or transport — no retries, queues,
   timers, or pipeline. Handlers run in the caller's frame. (MediatR owns a pipeline;
   Redux's store is the executor; MF owns load transport. telic owns none of it — which is
   what lets it sit *alongside* TanStack Query, XState, or a worker without fighting them.)
4. **A machine-legible agent surface** — `describe()` (an enumerable capability catalog),
   `inProgress()` ("what is the user mid-way through *right now*"), and
   `window.__INTENT_MEMORY__`. This is the sharpest single differentiator: none of the
   analogs can tell a copilot what the user was trying to do.
5. **Truthful handler availability + parked dispatch.** Presence-based registration makes
   "no handler" an honest, observable state (the capability isn't on this page), and
   parked dispatch absorbs the mount-order/load races that DI composition roots and static
   command buses assume away.
6. **String-name + schema dispatch is the shape an agent can actually call.** DI's typed
   injection and MediatR's class-as-message are exactly what a runtime agent *cannot*
   hold; a name + JSON payload is what it can.
7. **Record-first, mediate optionally.** You get the observability without adopting the
   command bus at all; `handle`/`dispatch` is opt-in, and only at real boundaries.
8. **Replay-backed subscriptions.** `on(…, { replay: true })` is a bus with a tape — late
   islands hear the past. A plain event bus forgets.

## When NOT to use telic (leaning to the incumbent, as promised)

| If your problem is… | Use… |
|---|---|
| In-process command dispatch on a .NET or Node server | MediatR / NestJS CQRS |
| Calling into a Web Worker / iframe | Comlink |
| Loading separately-deployed remote bundles | Module Federation |
| Managing application state | Redux / RTK / Zustand (telic is memory, not truth) |
| In-app pub/sub with no lifecycle need | mitt / nanoevents / ts-bus |
| Reliable server writes with retries/offline | TanStack Query (+ the telic adapter to correlate) |

telic is the right tool only when the crossing needs to be **recorded with a lifecycle**
*and* **legible to an agent**, in the **browser**. Strip any of those three and one of the
above is the better pick.
