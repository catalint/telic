import { describe, expect, it } from "bun:test";
import type { Diagnostic, Mark, Runtime } from "./core";
import { configureDefaultRuntime, currentRuntime, intent, memory } from "./core";
import type { FlowContext } from "./flow";
import { flow, step } from "./flow";
import type { StandardSchemaV1 } from "./standard-schema";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; duplicated per file by design)
//
// The default runtime and module intent registry are module-scope state: each
// test establishes known state via configureDefaultRuntime and uses unique
// intent scopes.
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
			return `f${counter}`;
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
		id: "flow-test-tap",
		onMark: (mark) => {
			seen.push(mark);
		},
	});
	return seen;
}

function begunOf(marks: readonly Mark[], intentName: string): Extract<Mark, { kind: "begun" }> {
	for (const mark of marks) {
		if (mark.kind === "begun" && mark.intent === intentName) return mark;
	}
	throw new Error(`no begun mark for ${intentName}`);
}

describe("S16: flow — the saga coordinator as a value", () => {
	it("S16.1/S16.2/S16.3: given sequential steps, when the flow runs, then children are parented+keyed, ctx accumulates outcomes, and the flow fulfills with them", async () => {
		const { rt } = configureRecordingDefault();
		const seen = tapMarks(rt);
		intent("f161.register", { fulfilled: passthroughSchema() });
		intent("f161.order", { fulfilled: passthroughSchema() });
		const ctxSeen: FlowContext[] = [];
		const result = await flow("f161.checkout", { cartId: "c1" }, { key: "c1" }, [
			step("f161.register", async () => ({ ok: true, data: { userId: "u1" } })),
			step("f161.order", async (ctx) => {
				ctxSeen.push(ctx);
				return { ok: true, data: { orderFor: ctx["f161.register"] } };
			}),
		]);
		expect(result).toEqual({
			ok: true,
			outcomes: {
				"f161.register": { userId: "u1" },
				"f161.order": { orderFor: { userId: "u1" } },
			},
		});
		// Sequential tape: flow begun, then each child's full lifecycle in order, then flow fulfilled.
		expect(seen.map((mark) => `${mark.kind}:${mark.intent}`)).toEqual([
			"begun:f161.checkout",
			"begun:f161.register",
			"fulfilled:f161.register",
			"begun:f161.order",
			"fulfilled:f161.order",
			"fulfilled:f161.checkout",
		]);
		// ctx for the second step held the first step's recorded outcome (S16.2).
		expect(ctxSeen).toEqual([{ "f161.register": { userId: "u1" } }]);
		// Keys: flow carries its own; children get `<flowKey>:<stepIntent>` (S16.3).
		const flowBegun = begunOf(seen, "f161.checkout");
		expect(flowBegun.key).toBe("c1");
		const registerBegun = begunOf(seen, "f161.register");
		expect(registerBegun.key).toBe("c1:f161.register");
		expect(registerBegun.parent).toBe(flowBegun.attempt);
		const orderBegun = begunOf(seen, "f161.order");
		expect(orderBegun.key).toBe("c1:f161.order");
		expect(orderBegun.parent).toBe(flowBegun.attempt);
		// The AttemptView carries the key too (S16.3 — resume queries).
		expect(memory.last("f161.register")?.key).toBe("c1:f161.register");
	});

	it("S16.5: given a mid-flow step rejection, then the flow rejects {step, reason}, remaining steps never begin, and fulfilled steps stay fulfilled", async () => {
		configureRecordingDefault();
		let shipRan = false;
		const result = await flow("f165.checkout", undefined, { key: "k165" }, [
			step("f165.reserve", async () => ({ ok: true })),
			step("f165.pay", async () => ({ ok: false, error: { code: "DECLINED" } })),
			step("f165.ship", async () => {
				shipRan = true;
				return { ok: true };
			}),
		]);
		expect(result).toEqual({ ok: false, step: "f165.pay", reason: { code: "DECLINED" } });
		expect(shipRan).toBe(false);
		expect(memory.marks({ pattern: "f165.ship" }).length).toBe(0);
		expect(memory.last("f165.reserve")?.phase).toBe("fulfilled");
		const flowView = memory.last("f165.checkout");
		expect(flowView?.phase).toBe("rejected");
		if (flowView?.phase === "rejected") {
			expect(flowView.reason).toEqual({ step: "f165.pay", reason: { code: "DECLINED" } });
		}
	});

	it("S16.5: given a throwing step fn, then the child and the flow reject with the thrown value and the returned promise resolves (never rejects)", async () => {
		configureRecordingDefault();
		const boom = new Error("kaput");
		const result = await flow("f165b.flow", undefined, undefined, [
			step("f165b.explode", async () => {
				throw boom;
			}),
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.step).toBe("f165b.explode");
			expect(result.reason).toBe(boom);
		}
		const childView = memory.last("f165b.explode");
		expect(childView?.phase).toBe("rejected");
		if (childView?.phase === "rejected") expect(childView.reason).toBe(boom);
	});

	it("S16.4: given a re-run with the same key, then a skipIfFulfilled step is skipped, its recorded outcome feeds ctx, and NO new child begins", async () => {
		configureRecordingDefault();
		intent("f164.address", { fulfilled: passthroughSchema() });
		intent("f164.pay", { fulfilled: passthroughSchema() });
		let payCalls = 0;
		const makeSteps = (): Parameters<typeof flow>[3] => [
			step("f164.address", async () => ({ ok: true, data: { addressId: "a1" } }), {
				skipIfFulfilled: true,
			}),
			step("f164.pay", async (ctx) => {
				payCalls += 1;
				if (payCalls === 1) return { ok: false, error: "declined" };
				return { ok: true, data: { paidFor: ctx["f164.address"] } };
			}),
		];
		const first = await flow("f164.checkout", undefined, { key: "K" }, makeSteps());
		expect(first).toEqual({ ok: false, step: "f164.pay", reason: "declined" });
		expect(memory.marks({ pattern: "f164.address", kinds: ["begun"] }).length).toBe(1);
		const second = await flow("f164.checkout", undefined, { key: "K" }, makeSteps());
		expect(second).toEqual({
			ok: true,
			outcomes: {
				"f164.address": { addressId: "a1" },
				"f164.pay": { paidFor: { addressId: "a1" } },
			},
		});
		// The fulfilled step was skipped on resume: still exactly one child attempt.
		expect(memory.marks({ pattern: "f164.address", kinds: ["begun"] }).length).toBe(1);
	});

	it("S16.4: given no flow key, then skipIfFulfilled is inert and the step runs every time", async () => {
		configureRecordingDefault();
		let runs = 0;
		const makeSteps = (): Parameters<typeof flow>[3] => [
			step(
				"f164b.once",
				async () => {
					runs += 1;
					return { ok: true };
				},
				{ skipIfFulfilled: true },
			),
		];
		await flow("f164b.flow", undefined, undefined, makeSteps());
		await flow("f164b.flow", undefined, undefined, makeSteps());
		expect(runs).toBe(2);
		expect(memory.marks({ pattern: "f164b.once", kinds: ["begun"] }).length).toBe(2);
	});
});
