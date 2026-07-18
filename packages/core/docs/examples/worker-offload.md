# Example: worker offload — dispatching to a handler in a Web Worker

Search indexing is CPU-heavy; its handler lives in a dedicated Worker, off
the main thread. The main thread dispatches to it using the same S28
machinery as the [support-widget example](./support-widget-cross-realm.md),
wired over the worker's own private postMessage line rather than
BroadcastChannel — a name-keyed channel any same-origin document could
overhear, the wrong shape for what should be a private line between exactly
one page and its own worker. Progress is ordinary `noted` marks, observed
with `on("search.*")` — no bespoke message-type enum this worker invents on
its own.

## 1. The worker (`search.worker.ts`)

```ts
import { currentRuntime } from "@telic/core"
import { handle, executeRemote } from "@telic/core/mediate"
import { connectWindow } from "@telic/core/transports/post-message"
import { receiveRemoteDispatches } from "@telic/core/transports/remote-dispatch"

handle("search.index", async (attempt, { docs }) => {
	for (const [i, doc] of docs.entries()) {
		indexOne(doc)
		attempt.note({ done: i + 1, total: docs.length })   // progress — an ordinary noted mark
	}
	return { ok: true }
})

// return leg: this worker's marks travel back over its own private line.
// Same-origin by construction (a classic Worker can't load cross-origin
// script), so targetOrigin/accept below are a formality, not a security
// boundary — there is no OTHER origin that could reach this port anyway.
connectWindow(currentRuntime(), {
	target: { postMessage: (data: unknown) => self.postMessage(data) },
	targetOrigin: self.location.origin,
	accept: () => true,
	listen: self,
	send: ["search.*"],
})

// request leg: the only thing allowed to act on request envelopes
receiveRemoteDispatches({
	listen: self,        // origin-less from this side (S28.2) — accept is optional, omitted
	execute: executeRemote,
})
```

## 2. The main thread

```ts
import { currentRuntime, on } from "@telic/core"
import { beginRemote } from "@telic/core/mediate"
import { connectWindow } from "@telic/core/transports/post-message"
import { createRemoteDispatcher } from "@telic/core/transports/remote-dispatch"

const worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" })

// return leg: hear the worker's progress + terminal marks. send: [] keeps
// the main thread's own marks off this channel — noise hygiene, not a
// correctness requirement: the begun-echo ordering (the main thread's begun
// reaching the worker before the request envelope) is absorbed by S15.10's
// observed-record adoption. See the support-widget example
// (§ "The begun-echo ordering — and why it's safe") and S28.5.
connectWindow(currentRuntime(), {
	target: { postMessage: (data: unknown) => worker.postMessage(data) },
	targetOrigin: location.origin,
	accept: () => true,
	listen: worker,
	send: [],
})

// request leg — shares the SAME channel as the return leg above; safe
// because request and mark envelopes are distinct by construction (S19.4),
// never mistaken for each other on either side
const search = createRemoteDispatcher({
	begin: beginRemote,
	send: (json) => worker.postMessage(json),
})

const attempt = search.dispatch("search.index", { docs }, {
	abandonWhen: AbortSignal.timeout(30_000),
})

on("search.*", ({ mark }) => {
	if (mark.kind === "noted") updateProgressBar(mark.data)
})

switch ((await attempt.settled).phase) {
	case "fulfilled": hideProgressBar(); break
	case "rejected":  showError("Indexing failed"); break
	case "abandoned": showError("Indexing timed out"); break
}
```

## Scrutiny: why telic and not a plain `postMessage` request-id protocol?

A hand-rolled `{ type: "index", requestId, docs }` / `{ type: "progress",
requestId, done, total }` protocol is genuinely less code for THIS one
worker. The case for telic is that it stops being bespoke the moment you have
more than one thing crossing this boundary, or more than one boundary in the
app: the same `dispatch` / `noted` / three-way settle vocabulary this example
uses is the SAME one the support-widget example uses for a completely
different realm (a cross-origin iframe) and the same one every same-realm
`dispatch()` in the app already uses. One mental model instead of N private
protocols, each with its own progress shape and its own "did it finish or
did the worker just vanish" ambiguity to re-litigate. If this worker really
is the only cross-realm boundary this app will ever have, the hand-rolled
protocol is a defensible, smaller alternative — reach for it and skip this.
