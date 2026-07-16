/**
 * XState adapter (SPEC S25). Structural peer only — no `xstate` import here
 * (S25.1); `xstate` ^5 is a devDependency for this file's tests only. Every
 * shape read off an inspection event or a snapshot is validated defensively at
 * runtime, so a future xstate internal-shape change degrades to "adapter
 * observes nothing" rather than a crash.
 *
 * ADAPTERS LINK, THEY NEVER DECLARE (APPROACHES.md): nothing here calls
 * intent()/begin() — it only annotates an attempt the app already began and
 * explicitly `bindActor`-ed. Unregistered actors are ignored: machine
 * lifetimes outlive call stacks, so there is NO ambient `within()` fallback
 * here (S25.2), unlike the TanStack adapter.
 *
 * The v5 inspection API shape this works against (derived from real xstate
 * 5.32, see xstate.test.ts): `createActor(machine, { inspect })` emits
 * `{ type: "@xstate.snapshot", actorRef: { sessionId }, event: { type },
 * snapshot: { status, value, context } }` (plus `@xstate.actor`,
 * `@xstate.event`, `@xstate.microstep`). Only `@xstate.snapshot` — the settled
 * post-transition snapshot, one per event — produces a linked mark; microsteps
 * are skipped to avoid double-emit.
 */
import type { Attempt, AttemptId, FulfillArgs, IntentName, Mark, ProvenanceRef, Runtime } from "../types.js";

// ---------------------------------------------------------------------------
// Structural xstate contracts (matched without importing xstate)
// ---------------------------------------------------------------------------

/** An attempt identity — the id + intent needed to stamp a mark. Satisfied by both `Attempt` and `AttemptView`. */
export type BoundAttempt = {
	readonly id: AttemptId;
	readonly intent: IntentName;
};

/** Structural xstate v5 ActorRef identity — only `sessionId` is needed to bind. */
export type ActorIdentity = {
	readonly sessionId: string;
};

/** Structural subscribable actor — what `settleFromMachine` reads off a real xstate actor. */
export type SubscribableActor = {
	readonly sessionId: string;
	subscribe(observer: (snapshot: unknown) => void): { unsubscribe(): void };
	getSnapshot(): unknown;
};

/**
 * How a machine state maps onto a settlement (S25.4). Each mapped state
 * fulfils XOR rejects; the callback derives the value from the actor's
 * context. See `settleFromMachine` for the void-outcome contract.
 */
export type MachineStateSettler =
	| { readonly fulfill: (context: unknown) => unknown }
	| { readonly reject: (context: unknown) => unknown };

/** Keyed by the stringified state value (S25.4). */
export type MachineSettleMap = Record<string, MachineStateSettler>;

export type InspectorOptions = {
	/**
	 * Injectable clock for the `linked` mark timestamp — `runtime.ingest()`
	 * re-seqs marks but does NOT overwrite `at`, so this must agree with the
	 * runtime's own clock. Pass the SAME `now` given to `createRuntime` for
	 * deterministic tests. Default: `Date.now`.
	 */
	readonly now?: () => number;
};

// ---------------------------------------------------------------------------
// Shared registry: bindActor writes it, createIntentInspector reads it.
// Module-level because bindActor receives neither runtime nor inspector, yet
// the inspector must resolve a sessionId back to its attempt. xstate session
// ids are process-globally unique, so a shared Map never cross-links actors.
// ---------------------------------------------------------------------------

const boundAttempts = new Map<string, BoundAttempt>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Stringifies a snapshot state value: strings pass through; nested/parallel objects become stable JSON (S25.2 "stringified state value"). */
function stringifyStateValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Reads the triggering event's `type` off an inspection event; "" when unreadable. */
function parseEventType(value: unknown): string {
	if (isRecord(value) && typeof value.type === "string") return value.type;
	return "";
}

type ParsedSnapshotEvent = {
	readonly sessionId: string;
	readonly state: string;
	readonly event: string;
};

/** Reads only the `@xstate.snapshot` fields this adapter needs; anything else (or malformed) → undefined. */
function parseSnapshotEvent(value: unknown): ParsedSnapshotEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "@xstate.snapshot") return undefined;
	const actorRef = value.actorRef;
	if (!isRecord(actorRef)) return undefined;
	const sessionId = actorRef.sessionId;
	if (typeof sessionId !== "string") return undefined;
	const snapshot = value.snapshot;
	if (!isRecord(snapshot)) return undefined;
	return {
		sessionId,
		state: stringifyStateValue(snapshot.value),
		event: parseEventType(value.event),
	};
}

// ---------------------------------------------------------------------------
// S25.2: createIntentInspector
// ---------------------------------------------------------------------------

/**
 * S25.2: builds the `inspect` function for `createActor(machine, { inspect })`.
 * For actors REGISTERED via `bindActor`, every `@xstate.snapshot` produces a
 * `linked` mark `{ kind: "xstate", actorId, state, event }` on the bound
 * attempt via the ingest path (same mechanism as the TanStack adapter's
 * `emitLinked`). Snapshots for UNregistered actors are ignored — there is no
 * ambient fallback (S25.2). Defensive throughout: a garbage event is a no-op.
 */
export function createIntentInspector(
	runtime: Runtime,
	opts?: InspectorOptions,
): (event: unknown) => void {
	const now = opts?.now ?? Date.now;
	return (event: unknown): void => {
		const parsed = parseSnapshotEvent(event);
		if (parsed === undefined) return;
		const bound = boundAttempts.get(parsed.sessionId);
		if (bound === undefined) return;
		const ref: ProvenanceRef = {
			kind: "xstate",
			actorId: parsed.sessionId,
			state: parsed.state,
			event: parsed.event,
		};
		const mark: Mark = {
			kind: "linked",
			seq: runtime.seq(),
			at: now(),
			intent: bound.intent,
			attempt: bound.id,
			ref,
		};
		runtime.ingest([mark]);
	};
}

// ---------------------------------------------------------------------------
// S25.3: bindActor
// ---------------------------------------------------------------------------

/**
 * S25.3: registers `actorRef.sessionId → attempt` so the inspector attributes
 * that actor's snapshots to `attempt`. Returns an unbind that removes the
 * mapping (only if still ours — a rebind of the same session id wins, and its
 * own unbind stays authoritative).
 */
export function bindActor(attempt: BoundAttempt, actorRef: ActorIdentity): () => void {
	const sessionId = actorRef.sessionId;
	const entry: BoundAttempt = { id: attempt.id, intent: attempt.intent };
	boundAttempts.set(sessionId, entry);
	return (): void => {
		if (boundAttempts.get(sessionId) === entry) boundAttempts.delete(sessionId);
	};
}

// ---------------------------------------------------------------------------
// S25.4: settleFromMachine
// ---------------------------------------------------------------------------

/**
 * Bridges a runtime-decided argument list to `Attempt.fulfill`'s compile-time
 * -only `FulfillArgs<F>` tuple — a sanctioned overload (mirrors core.ts's
 * `asTyped` and the TanStack adapter's `asFulfillArgs`), not a real cast.
 */
function asFulfillArgs<F>(args: readonly unknown[]): FulfillArgs<F>;
function asFulfillArgs(args: readonly unknown[]): readonly unknown[] {
	return args;
}

/** Bridges the map's `unknown` rejection value to `Attempt.reject`'s `R` — same sanctioned-overload rationale as `asFulfillArgs`. */
function asRejectReason<R>(value: unknown): R;
function asRejectReason(value: unknown): unknown {
	return value;
}

type ParsedSnapshot = {
	readonly state: string;
	readonly context: unknown;
};

function parseSnapshot(value: unknown): ParsedSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (!("value" in value)) return undefined;
	return { state: stringifyStateValue(value.value), context: value.context };
}

/**
 * S25.4: subscribes to `actorRef` and settles `attempt` the first time the
 * actor enters a state present in `map` (first-write-wins protects races and
 * benign re-entries — a local `done` flag + auto-unsubscribe). Returns
 * unsubscribe.
 *
 * OUTCOME / VOID CONTRACT (the settle knob): a fulfil entry's `fulfill(context)`
 * return value becomes the attempt's outcome — EXCEPT `undefined`, which
 * fulfils with no outcome (correct for void intents). This is the data-driven
 * equivalent of the TanStack adapter's `hasFulfilledSchema` flag: because a
 * Standard Schema's declared-ness is not introspectable at runtime, the map fn
 * IS the declaration — return a value for a typed `fulfilled`, return
 * `undefined` for a void intent. A reject entry's `reject(context)` return
 * value is always passed through as the rejection reason.
 *
 * xstate v5's `subscribe` does NOT re-emit the current snapshot on subscribe,
 * so an actor already sitting in a mapped state (e.g. a machine that ran to a
 * final state before this call) is handled by an explicit `getSnapshot()`
 * probe. The `subscription` is forward-declared so a structurally-conforming
 * actor that DOES emit synchronously never hits a temporal-dead-zone crash.
 */
export function settleFromMachine<P, F, R>(
	attempt: Attempt<P, F, R>,
	actorRef: SubscribableActor,
	map: MachineSettleMap,
): () => void {
	let done = false;
	let subscription: { unsubscribe(): void } | undefined;

	const observe = (snapshot: unknown): void => {
		if (done) return;
		const parsed = parseSnapshot(snapshot);
		if (parsed === undefined) return;
		const settler = map[parsed.state];
		if (settler === undefined) return;
		done = true;
		if ("fulfill" in settler) {
			const outcome = settler.fulfill(parsed.context);
			attempt.fulfill(...asFulfillArgs<F>(outcome === undefined ? [] : [outcome]));
		} else {
			attempt.reject(asRejectReason<R>(settler.reject(parsed.context)));
		}
		subscription?.unsubscribe();
	};

	subscription = actorRef.subscribe(observe);
	if (!done) observe(actorRef.getSnapshot());
	if (done) subscription.unsubscribe();

	return (): void => {
		subscription?.unsubscribe();
	};
}
