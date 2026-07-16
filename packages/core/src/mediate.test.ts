import { describe, expect, it } from "bun:test";
import type { AgentSurface } from "./agent/surface";
import { exposeAgentSurface } from "./agent/surface";
import type { Diagnostic, Mark, Runtime } from "./core";
import { configureDefaultRuntime, createRuntime, currentRuntime, intent, memory } from "./core";
import { command, createMediator, dispatch, handle } from "./mediate";
import type { StandardSchemaV1 } from "./standard-schema";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; duplicated per file by design)
//
// The default runtime, module intent registry, and handler registry are
// module-scope state: each test establishes known state via
// configureDefaultRuntime and uses unique intent scopes.
// ---------------------------------------------------------------------------

type ConfigureDefaultResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
};

/** Replaces the DEFAULT runtime with a fully-injected recording one. */
function configureRecordingDefault(): ConfigureDefaultResult {
	const clock = { t: 1000 };
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	configureDefaultRuntime({
		mode: "record",
		now: () => clock.t,
		id: () => {
			counter += 1;
			return `m${counter}`;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
	});
	return { rt: currentRuntime(), clock, diagnostics };
}

/** Hand-rolled synchronous pass-through Standard Schema (no zod). */
function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value) => ({ value }),
		},
	};
}

function tapMarks(rt: Runtime): Mark[] {
	const seen: Mark[] = [];
	rt.tap({
		id: "mediate-test-tap",
		onMark: (mark) => {
			seen.push(mark);
		},
	});
	return seen;
}

function only<T>(items: readonly T[]): T {
	if (items.length !== 1) throw new Error(`expected exactly one element, got ${items.length}`);
	const item = items[0];
	if (item === undefined) throw new Error("no element at index 0");
	return item;
}

describe("S15: mediation — handle() / dispatch()", () => {
	it("S15.1/S15.2: given a registered handler, when dispatched, then the attempt returns active immediately, run() semantics settle it, and taps see begun+fulfilled", async () => {
		const { rt, diagnostics } = configureRecordingDefault();
		const seen = tapMarks(rt);
		intent("m151.addItem", { fulfilled: passthroughSchema() });
		const received: unknown[] = [];
		handle("m151.addItem", async (_attempt, payload) => {
			received.push(payload);
			return { ok: true, data: { total: 3 } };
		});
		const attempt = dispatch("m151.addItem", { sku: "x" });
		// Returned immediately: the handler has not settled it yet.
		expect(attempt.phase().phase).toBe("active");
		const settledPhase = await attempt.settled;
		expect(settledPhase.phase).toBe("fulfilled");
		if (settledPhase.phase === "fulfilled") expect(settledPhase.outcome).toEqual({ total: 3 });
		expect(received).toEqual([{ sku: "x" }]);
		expect(seen.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		// Dispatch used the existing module declaration — no duplicate-intent (S15.2).
		expect(diagnostics.some((diagnostic) => diagnostic.code === "duplicate-intent")).toBe(false);
	});

	it("S15.4: given a throwing handler, when dispatched, then the attempt rejects with the thrown value, settled resolves (never rejects), and dispatch does not throw", async () => {
		configureRecordingDefault();
		const boom = new Error("boom");
		handle("m154.explode", async () => {
			throw boom;
		});
		const attempt = dispatch("m154.explode");
		const settledPhase = await attempt.settled;
		expect(settledPhase.phase).toBe("rejected");
		if (settledPhase.phase === "rejected") expect(settledPhase.reason).toBe(boom);
	});

	it("S15.3: given no registered handler, when dispatched, then the attempt is begun and rejected {code:TELIC_NO_HANDLER} with a no-handler diagnostic", () => {
		const { rt, diagnostics } = configureRecordingDefault();
		const seen = tapMarks(rt);
		const attempt = dispatch("m153.orphan", { a: 1 });
		const phase = attempt.phase();
		expect(phase.phase).toBe("rejected");
		if (phase.phase === "rejected") expect(phase.reason).toEqual({ code: "TELIC_NO_HANDLER" });
		expect(seen.map((mark) => mark.kind)).toEqual(["begun", "rejected"]);
		const noHandlerDiags = diagnostics.filter(
			(diagnostic) => diagnostic.code === "no-handler" && diagnostic.intent === "m153.orphan",
		);
		expect(noHandlerDiags.length).toBe(1);
	});

	it("S15.1: given a re-registered handler, then handler-replaced fires, the LAST handler wins, and unregister (also disposable) removes it", async () => {
		const { diagnostics } = configureRecordingDefault();
		const calls: string[] = [];
		handle("m151b.command", async () => {
			calls.push("first");
			return { ok: true };
		});
		const unregisterSecond = handle("m151b.command", async () => {
			calls.push("second");
			return { ok: true };
		});
		const replacedDiags = diagnostics.filter(
			(diagnostic) =>
				diagnostic.code === "handler-replaced" && diagnostic.intent === "m151b.command",
		);
		expect(replacedDiags.length).toBe(1);
		await dispatch("m151b.command").settled;
		expect(calls).toEqual(["second"]);
		expect(typeof unregisterSecond[Symbol.dispose]).toBe("function");
		unregisterSecond();
		const orphan = dispatch("m151b.command");
		expect(orphan.phase().phase).toBe("rejected");
		expect(calls).toEqual(["second"]);
	});

	it("S15.5: given mode silent, when dispatched, then the attempt is inert, the handler is NOT invoked, and nothing records", async () => {
		configureDefaultRuntime({ mode: "silent" });
		let invoked = false;
		handle("m155.ssrCommand", async () => {
			invoked = true;
			return { ok: true };
		});
		const attempt = dispatch("m155.ssrCommand", { secret: true });
		expect(attempt.phase()).toEqual({ phase: "active", since: 0 });
		// Give any (buggy) async invocation a microtask to surface.
		await Promise.resolve();
		expect(invoked).toBe(false);
		expect(memory.marks().length).toBe(0);
	});

	it("S15.2: given a handler that begins in its sync prefix, then the begin is parented to the dispatched attempt (within)", async () => {
		configureRecordingDefault();
		const child = intent("m152.child");
		handle("m152.parent", async () => {
			child.begin();
			return { ok: true };
		});
		const attempt = dispatch("m152.parent");
		await attempt.settled;
		const childMarks = memory.marks({ pattern: "m152.child", kinds: ["begun"] });
		const childBegun = only(childMarks);
		if (childBegun.kind === "begun") expect(childBegun.parent).toBe(attempt.id);
		else throw new Error("expected a begun mark");
	});

	it("S15.7: given two parked dispatches, when a handler registers, then both drain in FIFO order and settle correctly, with no no-handler diagnostic", async () => {
		const { diagnostics } = configureRecordingDefault();
		intent("m157.job", { fulfilled: passthroughSchema() });
		const first = dispatch("m157.job", { n: 1 }, { ifUnhandled: "park" });
		const second = dispatch("m157.job", { n: 2 }, { ifUnhandled: "park" });
		// Parked: truthfully ACTIVE, not rejected; parking is intentional.
		expect(first.phase().phase).toBe("active");
		expect(second.phase().phase).toBe("active");
		expect(diagnostics.some((diagnostic) => diagnostic.code === "no-handler")).toBe(false);
		const invocationOrder: unknown[] = [];
		handle("m157.job", async (_attempt, payload) => {
			invocationOrder.push(payload);
			return { ok: true, data: payload };
		});
		// Drain runs synchronously downstream of registration: FIFO sync prefixes.
		expect(invocationOrder).toEqual([{ n: 1 }, { n: 2 }]);
		const firstPhase = await first.settled;
		expect(firstPhase.phase).toBe("fulfilled");
		if (firstPhase.phase === "fulfilled") expect(firstPhase.outcome).toEqual({ n: 1 });
		const secondPhase = await second.settled;
		expect(secondPhase.phase).toBe("fulfilled");
		if (secondPhase.phase === "fulfilled") expect(secondPhase.outcome).toEqual({ n: 2 });
		// The park kept ONE attempt per dispatch: no extra begun marks on drain.
		expect(memory.marks({ pattern: "m157.job", kinds: ["begun"] }).length).toBe(2);
	});

	it("S15.7: given a parked attempt abandoned via abandonWhen before handle(), then it is NOT executed on drain and stays abandoned {why:signal}", () => {
		configureRecordingDefault();
		const controller = new AbortController();
		const parked = dispatch(
			"m157b.job",
			{ x: 1 },
			{ ifUnhandled: "park", abandonWhen: controller.signal },
		);
		controller.abort();
		const phase = parked.phase();
		expect(phase.phase).toBe("abandoned");
		if (phase.phase === "abandoned") expect(phase.abandon).toEqual({ why: "signal" });
		let invoked = false;
		handle("m157b.job", async () => {
			invoked = true;
			return { ok: true };
		});
		expect(invoked).toBe(false);
	});

	it("S15.7: given mode silent, when dispatched with park, then the attempt is inert, nothing is parked, and a later handler never drains it", async () => {
		configureDefaultRuntime({ mode: "silent" });
		const inert = dispatch("m157c.job", { s: 1 }, { ifUnhandled: "park" });
		expect(inert.phase()).toEqual({ phase: "active", since: 0 });
		configureRecordingDefault();
		let invoked = false;
		handle("m157c.job", async () => {
			invoked = true;
			return { ok: true };
		});
		await Promise.resolve();
		expect(invoked).toBe(false);
		expect(memory.marks({ pattern: "m157c.job" }).length).toBe(0);
	});

	it("S12.5: given a declared intent, then describe().handled flips true after handle() and back to false after unregister — including through the agent surface", () => {
		const { rt } = configureRecordingDefault();
		intent("m125.command");
		const target: Record<string, AgentSurface | undefined> = {};
		exposeAgentSurface(rt, { target });
		const handledOf = (descriptors: readonly { name: string; handled: boolean }[]): boolean =>
			descriptors.some((descriptor) => descriptor.name === "m125.command" && descriptor.handled);
		expect(handledOf(rt.describe())).toBe(false);
		const unregister = handle("m125.command", async () => ({ ok: true }));
		expect(handledOf(rt.describe())).toBe(true);
		// The agent surface delegates describe() verbatim: handled passes through live (S14.2).
		const facade = target.__INTENT_MEMORY__;
		expect(facade !== undefined && handledOf(facade.describe())).toBe(true);
		unregister();
		expect(handledOf(rt.describe())).toBe(false);
		expect(facade !== undefined && handledOf(facade.describe())).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// S15.1 (D18): per-runtime mediation worlds + S15.8 command stubs
// ---------------------------------------------------------------------------

type MakeRuntimeResult = {
	rt: Runtime;
	diagnostics: Diagnostic[];
};

/** Fresh explicit runtime, fully injected — mediator isolation tests. */
function makeRuntime(): MakeRuntimeResult {
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => 1000,
		id: () => {
			counter += 1;
			return `x${counter}`;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
	});
	return { rt, diagnostics };
}

function handledFor(rt: Runtime, name: string): boolean {
	return rt.describe().some((descriptor) => descriptor.name === name && descriptor.handled);
}

describe("S15.1 (D18): per-runtime mediation", () => {
	it("S15.1: given a module-level handler registered BEFORE a configure, when dispatched after, then the handler follows the default runtime and settles on the NEW tape", async () => {
		configureRecordingDefault();
		handle("m158a.command", async (_attempt, payload) => ({ ok: true, data: payload }));
		const { rt } = configureRecordingDefault();
		const seen = tapMarks(rt);
		const attempt = dispatch("m158a.command", { v: 1 });
		const settledPhase = await attempt.settled;
		expect(settledPhase.phase).toBe("fulfilled");
		expect(seen.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		// The new default runtime's describe() reflects the module registry (S12.5).
		expect(handledFor(rt, "m158a.command")).toBe(true);
	});

	it("S15.1/S15.7: given a parked dispatch, when the default runtime is replaced, then the park queue does NOT carry over and a later handle() never executes it", async () => {
		configureRecordingDefault();
		const parked = dispatch("m158b.command", { v: 1 }, { ifUnhandled: "park" });
		expect(parked.phase().phase).toBe("active");
		const { rt } = configureRecordingDefault();
		const seen = tapMarks(rt);
		let invoked = false;
		handle("m158b.command", async () => {
			invoked = true;
			return { ok: true };
		});
		await Promise.resolve();
		expect(invoked).toBe(false);
		// The old runtime's parked attempt stays its own business (still active).
		expect(parked.phase().phase).toBe("active");
		expect(seen.length).toBe(0);
	});

	it("S15.1: given two explicit runtimes with their own mediators, then registries and tapes are fully isolated and the module world is untouched", async () => {
		configureRecordingDefault();
		const worldA = makeRuntime();
		const worldB = makeRuntime();
		const mediatorA = createMediator(worldA.rt);
		const mediatorB = createMediator(worldB.rt);
		worldA.rt.intent("med.iso", { fulfilled: passthroughSchema() });
		const seenA = tapMarks(worldA.rt);
		const seenB = tapMarks(worldB.rt);
		mediatorA.handle("med.iso", async (_attempt, payload) => ({ ok: true, data: payload }));
		const attemptA = mediatorA.dispatch("med.iso", { from: "A" });
		const phaseA = await attemptA.settled;
		expect(phaseA.phase).toBe("fulfilled");
		if (phaseA.phase === "fulfilled") expect(phaseA.outcome).toEqual({ from: "A" });
		// Dispatch resolved the runtime's OWN declaration — no duplicate-intent (S15.2).
		expect(worldA.diagnostics.some((d) => d.code === "duplicate-intent")).toBe(false);
		expect(seenA.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		// B's mediator shares nothing: the same name is unhandled there.
		const attemptB = mediatorB.dispatch("med.iso", { from: "B" });
		const phaseB = attemptB.phase();
		expect(phaseB.phase).toBe("rejected");
		if (phaseB.phase === "rejected") expect(phaseB.reason).toEqual({ code: "TELIC_NO_HANDLER" });
		expect(worldB.diagnostics.some((d) => d.code === "no-handler")).toBe(true);
		expect(seenB.map((mark) => mark.kind)).toEqual(["begun", "rejected"]);
		// The module world is untouched: same name unhandled there, marks land on the default runtime.
		const moduleAttempt = dispatch("med.iso");
		expect(moduleAttempt.phase().phase).toBe("rejected");
		expect(seenA.length).toBe(2);
		expect(seenB.length).toBe(2);
	});

	it("S12.5 (D18): handled is per-runtime — a mediator's runtime reflects its own registry, a bare runtime reports false, incl. through the agent surface", () => {
		configureRecordingDefault();
		const withMediator = makeRuntime();
		const bare = makeRuntime();
		withMediator.rt.intent("med.capability");
		bare.rt.intent("med.capability");
		const mediator = createMediator(withMediator.rt);
		// A module-world handler for the SAME name must not leak into explicit runtimes.
		const unregisterModule = handle("med.capability", async () => ({ ok: true }));
		expect(handledFor(withMediator.rt, "med.capability")).toBe(false);
		expect(handledFor(bare.rt, "med.capability")).toBe(false);
		const unregister = mediator.handle("med.capability", async () => ({ ok: true }));
		expect(handledFor(withMediator.rt, "med.capability")).toBe(true);
		expect(handledFor(bare.rt, "med.capability")).toBe(false);
		const target: Record<string, AgentSurface | undefined> = {};
		exposeAgentSurface(withMediator.rt, { target });
		const facade = target.__INTENT_MEMORY__;
		expect(facade?.describe().some((d) => d.name === "med.capability" && d.handled)).toBe(true);
		unregister();
		expect(handledFor(withMediator.rt, "med.capability")).toBe(false);
		expect(facade?.describe().some((d) => d.name === "med.capability" && d.handled)).toBe(false);
		unregisterModule();
	});

	it("S15.8: given command() stubs, then they delegate identically to dispatch for both the module world and a mediator", async () => {
		const { rt, diagnostics } = configureRecordingDefault();
		const seen = tapMarks(rt);
		const submitOrder = command("m158c.submitOrder");
		// Unhandled: exactly dispatch's S15.3 behavior.
		const rejectedAttempt = submitOrder({ id: 1 });
		const rejectedPhase = rejectedAttempt.phase();
		expect(rejectedPhase.phase).toBe("rejected");
		if (rejectedPhase.phase === "rejected") {
			expect(rejectedPhase.reason).toEqual({ code: "TELIC_NO_HANDLER" });
		}
		expect(diagnostics.filter((d) => d.code === "no-handler").length).toBe(1);
		// Handled: exactly dispatch's S15.2 behavior.
		handle("m158c.submitOrder", async (_attempt, payload) => ({ ok: true, data: payload }));
		const fulfilledAttempt = submitOrder({ id: 2 });
		await fulfilledAttempt.settled;
		expect(seen.map((mark) => mark.kind)).toEqual(["begun", "rejected", "begun", "fulfilled"]);
		// Mediator variant binds to ITS registry and tape.
		const explicit = makeRuntime();
		const mediator = createMediator(explicit.rt);
		const seenExplicit = tapMarks(explicit.rt);
		const localCommand = mediator.command("m158c.local");
		expect(localCommand().phase().phase).toBe("rejected");
		mediator.handle("m158c.local", async () => ({ ok: true }));
		const localFulfilled = localCommand();
		await localFulfilled.settled;
		expect(seenExplicit.map((mark) => mark.kind)).toEqual([
			"begun",
			"rejected",
			"begun",
			"fulfilled",
		]);
	});
});
