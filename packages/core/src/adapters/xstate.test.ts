import { describe, expect, it } from "bun:test";
import { assign, createActor, createMachine } from "xstate";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type { Diagnostic, Mark, ProvenanceRef, Runtime } from "../types.js";
import { createRuntime } from "../core.js";
import { bindActor, createIntentInspector, settleFromMachine } from "./xstate.js";

// ---------------------------------------------------------------------------
// Test infrastructure — REAL xstate ^5 machines drive every scenario; the
// inspection-event and snapshot shapes are never faked. Duplicated per file by
// design (mirrors adapters/tanstack-query.test.ts).
// ---------------------------------------------------------------------------

type MakeRuntimeResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
};

function makeRuntime(): MakeRuntimeResult {
	const clock = { t: 1000 };
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => clock.t,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
	});
	return { rt, clock, diagnostics };
}

/** Hand-rolled synchronous pass-through Standard Schema (no zod) — gives an intent a non-void `fulfilled` type. */
function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value) => ({ value }),
		},
	};
}

/** Reads `context.result` defensively — machine context is `unknown` at the adapter boundary. */
function readResult(context: unknown): string {
	if (context !== null && typeof context === "object" && "result" in context) {
		const value = context.result;
		if (typeof value === "string") return value;
	}
	return "";
}

type XStateRef = Extract<ProvenanceRef, { readonly kind: "xstate" }>;

function isXStateRef(ref: ProvenanceRef): ref is XStateRef {
	return ref.kind === "xstate";
}

function xstateRefs(marks: readonly Mark[]): XStateRef[] {
	const refs: XStateRef[] = [];
	for (const mark of marks) {
		if (mark.kind === "linked" && isXStateRef(mark.ref)) refs.push(mark.ref);
	}
	return refs;
}

function linkedMarks(rt: Runtime, attemptId?: string): Mark[] {
	const marks = rt.memory.marks({ kinds: ["linked"] });
	return attemptId === undefined ? [...marks] : marks.filter((mark) => mark.attempt === attemptId);
}

/** A toggle machine reaching a final "done" state — drives the inspector transition sequence. */
function toggleMachine() {
	return createMachine({
		id: "toggle",
		initial: "inactive",
		states: {
			inactive: { on: { TOGGLE: "active" } },
			active: { on: { TOGGLE: "inactive", FINISH: "done" } },
			done: { type: "final" },
		},
	});
}

/** A load machine that fulfils or rejects with a context-derived value on its final states. */
function loadMachine() {
	return createMachine({
		id: "load",
		initial: "loading",
		context: { result: "" },
		states: {
			loading: { on: { OK: "success", FAIL: "failure" } },
			success: { type: "final", entry: assign({ result: () => "done-payload" }) },
			failure: { type: "final", entry: assign({ result: () => "boom" }) },
		},
	});
}

// ---------------------------------------------------------------------------
// S25.2/S25.3: createIntentInspector + bindActor
// ---------------------------------------------------------------------------

describe("S25.2: createIntentInspector + bindActor", () => {
	it("given a bound actor, when it transitions, then linked xstate marks record the state/event sequence on the bound attempt", () => {
		const { rt, clock } = makeRuntime();
		const inspect = createIntentInspector(rt, { now: () => clock.t });
		const actor = createActor(toggleMachine(), { inspect });

		const attempt = rt.intent("ui.toggle").begin();
		const unbind = bindActor(attempt, actor);

		actor.start();
		actor.send({ type: "TOGGLE" });
		actor.send({ type: "FINISH" });

		const refs = xstateRefs(linkedMarks(rt, attempt.id));
		expect(refs.map((ref) => ref.state)).toEqual(["inactive", "active", "done"]);
		expect(refs.map((ref) => ref.event)).toEqual(["xstate.init", "TOGGLE", "FINISH"]);
		for (const ref of refs) expect(ref.actorId).toBe(actor.sessionId);

		const first = linkedMarks(rt, attempt.id)[0];
		expect(first?.at).toBe(1000);
		expect(first?.intent).toBe("ui.toggle");

		unbind();
	});

	it("given unbind() ran, when the actor keeps transitioning, then no further marks are emitted", () => {
		const { rt } = makeRuntime();
		const inspect = createIntentInspector(rt);
		const actor = createActor(toggleMachine(), { inspect });

		const attempt = rt.intent("ui.toggleUnbind").begin();
		const unbind = bindActor(attempt, actor);

		actor.start(); // -> inactive (init)
		actor.send({ type: "TOGGLE" }); // -> active
		expect(xstateRefs(linkedMarks(rt, attempt.id)).map((ref) => ref.state)).toEqual([
			"inactive",
			"active",
		]);

		unbind();
		actor.send({ type: "TOGGLE" }); // -> inactive, but no longer bound

		expect(xstateRefs(linkedMarks(rt, attempt.id)).length).toBe(2);
	});

	it("given two actors bound to two attempts, when both transition, then each attempt's marks reflect only its own actor (registry never cross-links)", () => {
		const { rt } = makeRuntime();
		const inspect = createIntentInspector(rt);
		const actorA = createActor(toggleMachine(), { inspect });
		const actorB = createActor(toggleMachine(), { inspect });
		// Distinct session ids are the invariant the sessionId-keyed registry rests on.
		expect(actorA.sessionId).not.toBe(actorB.sessionId);

		const attemptA = rt.intent("ui.a").begin();
		const attemptB = rt.intent("ui.b").begin();
		const unbindA = bindActor(attemptA, actorA);
		const unbindB = bindActor(attemptB, actorB);

		actorA.start(); // A: inactive
		actorB.start(); // B: inactive
		actorA.send({ type: "TOGGLE" }); // A: active (B stays at inactive, untouched)

		expect(xstateRefs(linkedMarks(rt, attemptA.id)).map((ref) => ref.state)).toEqual([
			"inactive",
			"active",
		]);
		expect(xstateRefs(linkedMarks(rt, attemptB.id)).map((ref) => ref.state)).toEqual(["inactive"]);

		unbindA();
		unbindB();
	});

	it("given an actor that was never bound, when it runs, then nothing is linked (no ambient fallback, S25.2)", () => {
		const { rt } = makeRuntime();
		const inspect = createIntentInspector(rt);
		const actor = createActor(toggleMachine(), { inspect });

		// An ambient attempt is active — the xstate adapter must still ignore it.
		const ambient = rt.intent("ui.ambient").begin();
		rt.within(ambient, () => {
			actor.start();
			actor.send({ type: "TOGGLE" });
		});

		expect(rt.memory.marks({ kinds: ["linked"] }).length).toBe(0);
		ambient.abandon();
	});

	it("given garbage inspection events, when fed to the inspector, then it is tolerant and never throws or emits", () => {
		const { rt } = makeRuntime();
		const inspect = createIntentInspector(rt);

		expect(() => inspect(null)).not.toThrow();
		expect(() => inspect(undefined)).not.toThrow();
		expect(() => inspect("garbage")).not.toThrow();
		expect(() => inspect({ type: "@xstate.event" })).not.toThrow();
		expect(() => inspect({ type: "@xstate.snapshot" })).not.toThrow();
		expect(() =>
			inspect({ type: "@xstate.snapshot", actorRef: {}, snapshot: {} }),
		).not.toThrow();
		expect(rt.memory.marks().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S25.4: settleFromMachine
// ---------------------------------------------------------------------------

describe("S25.4: settleFromMachine", () => {
	it("given a fulfil mapping on a final state, when the machine reaches it, then the attempt fulfills with the context-derived outcome", () => {
		const { rt, clock } = makeRuntime();
		const actor = createActor(loadMachine());
		actor.start();

		const attempt = rt.intent("data.load", { fulfilled: passthroughSchema() }).begin();
		const unsub = settleFromMachine(attempt, actor, {
			success: { fulfill: (context) => readResult(context) },
			failure: { reject: (context) => new Error(readResult(context)) },
		});

		actor.send({ type: "OK" });

		expect(attempt.phase()).toEqual({
			phase: "fulfilled",
			at: clock.t,
			outcome: "done-payload",
		});

		unsub();
	});

	it("given a reject mapping on a final state, when the machine reaches it, then the attempt rejects with the context-derived reason", () => {
		const { rt, clock } = makeRuntime();
		const actor = createActor(loadMachine());
		actor.start();

		const attempt = rt.intent("data.loadFails").begin();
		const unsub = settleFromMachine(attempt, actor, {
			success: { fulfill: (context) => readResult(context) },
			failure: { reject: (context) => new Error(readResult(context)) },
		});

		actor.send({ type: "FAIL" });

		const phase = attempt.phase();
		expect(phase.phase).toBe("rejected");
		if (phase.phase === "rejected") {
			expect(phase.reason).toBeInstanceOf(Error);
			expect(phase.reason instanceof Error ? phase.reason.message : "").toBe("boom");
			expect(phase.at).toBe(clock.t);
		}

		unsub();
	});

	it("given a void intent and a fulfil fn returning undefined, when the state is entered, then the attempt fulfills with no outcome (void knob)", () => {
		const { rt, clock } = makeRuntime();
		const actor = createActor(loadMachine());
		actor.start();

		const attempt = rt.intent("data.loadVoid").begin();
		const unsub = settleFromMachine(attempt, actor, {
			success: { fulfill: () => undefined },
		});

		actor.send({ type: "OK" });

		expect(attempt.phase()).toEqual({ phase: "fulfilled", at: clock.t, outcome: undefined });

		unsub();
	});

	it("given an actor already sitting in a mapped final state, when subscribed, then it settles immediately via the getSnapshot probe (v5 subscribe does not re-emit)", () => {
		const { rt } = makeRuntime();
		const actor = createActor(loadMachine());
		actor.start();
		actor.send({ type: "OK" }); // reaches final "success" BEFORE settleFromMachine

		const attempt = rt.intent("data.loadLate", { fulfilled: passthroughSchema() }).begin();
		settleFromMachine(attempt, actor, {
			success: { fulfill: (context) => readResult(context) },
		});

		expect(attempt.phase()).toEqual({
			phase: "fulfilled",
			at: 1000,
			outcome: "done-payload",
		});
	});

	it("given re-entry of a mapped state, when it happens after settling, then it is a benign no-op (first-write-wins, no double-settle diagnostic)", () => {
		const { rt, diagnostics } = makeRuntime();
		const machine = createMachine({
			id: "blink",
			initial: "off",
			states: {
				off: { on: { GO: "on" } },
				on: { on: { GO: "off" } },
			},
		});
		const actor = createActor(machine);
		actor.start();

		const attempt = rt.intent("ui.blink").begin();
		const unsub = settleFromMachine(attempt, actor, {
			on: { fulfill: () => undefined },
		});

		actor.send({ type: "GO" }); // -> on -> fulfill
		actor.send({ type: "GO" }); // -> off
		actor.send({ type: "GO" }); // -> on again, but already unsubscribed

		expect(attempt.phase().phase).toBe("fulfilled");
		expect(diagnostics.some((diagnostic) => diagnostic.code === "double-settle")).toBe(false);

		unsub();
	});

	it("given the returned unsubscribe ran before the mapped state, when the machine later reaches it, then the attempt stays active", () => {
		const { rt } = makeRuntime();
		const actor = createActor(loadMachine());
		actor.start();

		const attempt = rt.intent("data.loadCancelled").begin();
		const unsub = settleFromMachine(attempt, actor, {
			success: { fulfill: (context) => readResult(context) },
		});
		unsub();

		actor.send({ type: "OK" });

		expect(attempt.phase().phase).toBe("active");
		attempt.abandon();
	});
});

// ---------------------------------------------------------------------------
// S25: inspector + settleFromMachine wired together against ONE real actor
// ---------------------------------------------------------------------------

describe("S25: createIntentInspector + settleFromMachine together", () => {
	it("given both wired to one actor, when it runs to a final state, then linked marks trace the path AND the attempt fulfills", () => {
		const { rt, clock } = makeRuntime();
		const inspect = createIntentInspector(rt, { now: () => clock.t });
		const actor = createActor(loadMachine(), { inspect });

		const attempt = rt.intent("data.loadTraced", { fulfilled: passthroughSchema() }).begin();
		const unbind = bindActor(attempt, actor);
		const unsub = settleFromMachine(attempt, actor, {
			success: { fulfill: (context) => readResult(context) },
		});

		actor.start();
		actor.send({ type: "OK" });

		const states = xstateRefs(linkedMarks(rt, attempt.id)).map((ref) => ref.state);
		expect(states).toEqual(["loading", "success"]);
		expect(attempt.phase()).toEqual({
			phase: "fulfilled",
			at: clock.t,
			outcome: "done-payload",
		});

		unsub();
		unbind();
	});
});
