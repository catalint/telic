/**
 * @telic/mediate — the optional command half of the bus (SPEC S15).
 *
 * THE INITIATIVE BOUNDARY governs everything here: handlers run synchronously
 * downstream of a dispatch() call — never from queues, timers, retries, or
 * transports. Handler registries are PER-RUNTIME (D18): the module-level
 * handle/dispatch/command follow the DEFAULT runtime late-bound; explicit
 * runtimes get an isolated world via createMediator(runtime).
 */

import type { RuntimeMediationSeam } from "./core";
import {
	currentRuntime,
	mediationSeamOf,
	registerDefaultRuntimeAdopter,
	resolveModuleIntent,
} from "./core";
import type {
	Attempt,
	CommandStub,
	DispatchOptions,
	Intent,
	IntentName,
	MediationHandler,
	MediationResult,
	Mediator,
	PayloadFor,
	Runtime,
	Unsubscribe,
} from "./types";

export type {
	CommandStub,
	DispatchOptions,
	MediationHandler,
	MediationResult,
	Mediator,
} from "./types";

type ParkedDispatch = {
	readonly attempt: Attempt<unknown, unknown, unknown>;
	readonly payload: unknown;
};

/**
 * One mediation world = one handler registry + one set of FIFO park queues
 * (S15.1). The module world's runtime is late-bound (currentRuntime per
 * call); a createMediator world is pinned to its runtime.
 */
type MediationWorld = {
	readonly runtime: () => Runtime;
	readonly seam: () => RuntimeMediationSeam;
	readonly resolveIntent: (name: IntentName) => Intent<unknown, unknown, unknown>;
	readonly handlers: Map<IntentName, MediationHandler>;
	readonly parked: Map<IntentName, ParkedDispatch[]>;
};

function toUnsubscribe(fn: () => void): Unsubscribe {
	return Object.assign(fn, { [Symbol.dispose]: fn });
}

/** S3.12 outcome mapping: data becomes the outcome only when a fulfilled schema exists. */
function settleWithRunSemantics(
	world: MediationWorld,
	name: IntentName,
	attempt: Attempt<unknown, unknown, unknown>,
	result: MediationResult,
): void {
	if (result.ok) {
		attempt.fulfill(
			world.seam().hasFulfilledSchema(name) && "data" in result ? result.data : undefined,
		);
		return;
	}
	attempt.reject("error" in result ? result.error : result);
}

/** Runs a handler against an EXISTING attempt (drained park): within-parented, S3.12 settlement, throws never propagate. */
function executeDispatch(
	world: MediationWorld,
	name: IntentName,
	handler: MediationHandler,
	attempt: Attempt<unknown, unknown, unknown>,
	payload: unknown,
): void {
	const runtime = world.runtime();
	void (async (): Promise<void> => {
		let result: MediationResult;
		try {
			result = await runtime.within(attempt, () => handler(attempt, payload));
		} catch (thrown) {
			attempt.reject(thrown);
			return;
		}
		settleWithRunSemantics(world, name, attempt, result);
	})();
}

function enqueueParked(
	world: MediationWorld,
	name: IntentName,
	attempt: Attempt<unknown, unknown, unknown>,
	payload: unknown,
): void {
	let queue = world.parked.get(name);
	if (queue === undefined) {
		queue = [];
		world.parked.set(name, queue);
	}
	const entry: ParkedDispatch = { attempt, payload };
	queue.push(entry);
	// Attempts that settle while parked (abandonWhen, navigation, dispose)
	// leave the queue (S15.7); drain double-checks the phase regardless.
	void attempt.settled.then((): void => {
		const current = world.parked.get(name);
		if (current === undefined) return;
		const index = current.indexOf(entry);
		if (index >= 0) current.splice(index, 1);
	});
}

/** Drains a name's parked dispatches in FIFO order, synchronously downstream of handle() (S15.7). */
function drainParked(world: MediationWorld, name: IntentName, handler: MediationHandler): void {
	const queue = world.parked.get(name);
	if (queue === undefined) return;
	world.parked.delete(name);
	for (const parked of queue) {
		// Abandoned parked attempts are never executed (S15.7).
		if (parked.attempt.phase().phase !== "active") continue;
		executeDispatch(world, name, handler, parked.attempt, parked.payload);
	}
}

function handleOn(world: MediationWorld, name: IntentName, handler: MediationHandler): Unsubscribe {
	if (world.handlers.has(name)) {
		world.seam().emitDiagnostic({ code: "handler-replaced", intent: name });
	}
	world.handlers.set(name, handler);
	drainParked(world, name, handler);
	return toUnsubscribe((): void => {
		if (world.handlers.get(name) === handler) world.handlers.delete(name);
	});
}

function dispatchOn(
	world: MediationWorld,
	name: IntentName,
	payload: unknown,
	opts: DispatchOptions | undefined,
): Attempt<unknown, unknown, unknown> {
	const runtime = world.runtime();
	const intentHandle = world.resolveIntent(name);
	if (runtime.mode === "silent") {
		// Mediation is off wherever recording is off (S15.5): inert attempt,
		// handler NOT invoked, nothing parked (S15.7).
		return intentHandle.begin(payload, opts);
	}
	const handler = world.handlers.get(name);
	if (handler === undefined) {
		const attempt = intentHandle.begin(payload, opts);
		if (opts?.ifUnhandled === "park") {
			// Parking is intentional: the attempt truthfully stays ACTIVE, no
			// no-handler diagnostic (S15.7). A begin already settled by an
			// aborted abandonWhen signal never parks.
			if (attempt.phase().phase === "active") enqueueParked(world, name, attempt, payload);
			return attempt;
		}
		// Observable failure, never a throw (S15.3).
		world.seam().emitDiagnostic({ code: "no-handler", intent: name });
		attempt.reject({ code: "TELIC_NO_HANDLER" });
		return attempt;
	}
	let dispatched: Attempt<unknown, unknown, unknown> | undefined;
	void intentHandle
		.run(
			payload,
			(attempt): Promise<MediationResult> => {
				dispatched = attempt;
				// within(attempt): the handler's sync-prefix begins are parented (S15.2).
				return runtime.within(attempt, () => handler(attempt, payload));
			},
			opts,
		)
		.catch((): void => {
			// A handler throw already rejected the attempt (S3.12); it never
			// reaches the dispatcher (S15.4).
		});
	if (dispatched !== undefined) return dispatched;
	// Unreachable: run() invokes its fn synchronously (Promise.try semantics, S3.12).
	throw new Error("telic mediate: run() did not invoke its fn synchronously");
}

// ---------------------------------------------------------------------------
// Module world — follows the DEFAULT runtime late-bound (S15.1)
// ---------------------------------------------------------------------------

const moduleWorld: MediationWorld = {
	runtime: currentRuntime,
	seam: (): RuntimeMediationSeam => mediationSeamOf(currentRuntime()),
	resolveIntent: resolveModuleIntent,
	handlers: new Map(),
	parked: new Map(),
};

// Module handlers follow every adopted default runtime (probe re-applies);
// parked queues belong to the runtime that parked them and never carry over.
registerDefaultRuntimeAdopter((runtime: Runtime): void => {
	moduleWorld.parked.clear();
	mediationSeamOf(runtime).setHandledProbe((name: IntentName): boolean =>
		moduleWorld.handlers.has(name),
	);
});

/**
 * Registers THE handler for an intent name in the module-level (default
 * runtime) world (S15.1). Re-registering replaces it (last-wins) with a
 * `handler-replaced` diagnostic. Drains any parked dispatches for the name in
 * FIFO order, synchronously downstream of this call (S15.7). Returns an
 * unregister fn (also disposable) that removes the handler only while it is
 * still the registered one.
 */
export function handle(name: IntentName, handler: MediationHandler): Unsubscribe {
	return handleOn(moduleWorld, name, handler);
}

/**
 * Dispatches an intent to its registered handler (S15.2). Returns the Attempt
 * immediately; the handler settles it asynchronously with run() semantics.
 * Nothing here ever throws to the dispatcher — observe via `attempt.settled`
 * (S15.3/S15.4).
 */
export function dispatch<N extends IntentName>(
	name: N,
	payload?: PayloadFor<N>,
	opts?: DispatchOptions,
): Attempt<unknown, unknown, unknown> {
	return dispatchOn(moduleWorld, name, payload, opts);
}

/**
 * Typed dispatch stub factory (S15.8): the owning domain exports
 * `command("scope.verbObject")` from its contract subpath; call sites import
 * the stub — the name string lives in exactly one place and jump-to-definition
 * lands on the contract. Delegates to the module-level dispatch late-bound.
 */
export function command<N extends IntentName>(name: N): CommandStub<N> {
	return (payload?: PayloadFor<N>, opts?: DispatchOptions): Attempt<unknown, unknown, unknown> =>
		dispatchOn(moduleWorld, name, payload, opts);
}

// ---------------------------------------------------------------------------
// createMediator — isolated per-runtime mediation world (S15.1)
// ---------------------------------------------------------------------------

/**
 * Creates an isolated mediation world for one explicit runtime: its own
 * handler registry and park queues, nothing shared with the module world
 * (test isolation by construction, S15.1). Installs the runtime's `handled`
 * probe (S12.5) — its describe() reflects exactly this mediator's registry.
 */
export function createMediator(runtime: Runtime): Mediator {
	const seam = mediationSeamOf(runtime);
	const world: MediationWorld = {
		runtime: (): Runtime => runtime,
		seam: (): RuntimeMediationSeam => seam,
		resolveIntent: seam.resolveIntent,
		handlers: new Map(),
		parked: new Map(),
	};
	seam.setHandledProbe((name: IntentName): boolean => world.handlers.has(name));
	const mediator: Mediator = {
		handle: (name: IntentName, handler: MediationHandler): Unsubscribe =>
			handleOn(world, name, handler),
		dispatch: <N extends IntentName>(
			name: N,
			payload?: PayloadFor<N>,
			opts?: DispatchOptions,
		): Attempt<unknown, unknown, unknown> => dispatchOn(world, name, payload, opts),
		command:
			<N extends IntentName>(name: N): CommandStub<N> =>
			(payload?: PayloadFor<N>, opts?: DispatchOptions): Attempt<unknown, unknown, unknown> =>
				dispatchOn(world, name, payload, opts),
	};
	return mediator;
}
