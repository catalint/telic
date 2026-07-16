import { describe, expect, it } from "bun:test";
import type { AttemptId, Diagnostic, Runtime } from "../core";
import { createRuntime } from "../core";
import type { PerfLike } from "./user-timing";
import { createUserTimingTap } from "./user-timing";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; taps run against a REAL runtime).
// ---------------------------------------------------------------------------

function makeRuntime(): { rt: Runtime; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => 1000,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	return { rt, diagnostics };
}

type MarkCapture = { readonly name: string; readonly detail: unknown };
type MeasureCapture = {
	readonly name: string;
	readonly start: string | undefined;
	readonly detail: unknown;
};

function makeFakePerf(): {
	perf: PerfLike;
	marks: MarkCapture[];
	measures: MeasureCapture[];
} {
	const marks: MarkCapture[] = [];
	const measures: MeasureCapture[] = [];
	const perf: PerfLike = {
		mark(name, options): void {
			marks.push({ name, detail: options?.detail });
		},
		measure(name, options): void {
			measures.push({ name, start: options?.start, detail: options?.detail });
		},
	};
	return { perf, marks, measures };
}

function idStr(id: AttemptId): string {
	return id;
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

function only<T>(items: readonly T[]): T {
	if (items.length !== 1) throw new Error(`expected exactly one element, got ${items.length}`);
	return at(items, 0);
}

function tapErrors(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.code === "tap-error");
}

// ---------------------------------------------------------------------------
// S13.3: User Timing tap
// ---------------------------------------------------------------------------

describe("S13.3: user timing tap", () => {
	it("S13.3: given a begun mark, when tapped, then perf.mark records telic:<intent>:<attemptId> with the mark as detail", () => {
		const { rt } = makeRuntime();
		const { perf, marks, measures } = makeFakePerf();
		rt.tap(createUserTimingTap({ perf }));
		const attempt = rt.intent("cart.checkout").begin();
		expect(marks.length).toBe(1);
		expect(at(marks, 0).name).toBe(`telic:cart.checkout:${idStr(attempt.id)}`);
		expect(at(marks, 0).detail).toEqual(only(rt.memory.marks()));
		expect(measures.length).toBe(0);
	});

	it("S13.3: given a fulfilled mark, when tapped, then perf.measure spans from the begin mark name", () => {
		const { rt } = makeRuntime();
		const { perf, marks, measures } = makeFakePerf();
		rt.tap(createUserTimingTap({ perf }));
		const attempt = rt.intent("cart.checkout").begin();
		attempt.fulfill();
		expect(at(marks, 0).name).toBe(`telic:cart.checkout:${idStr(attempt.id)}`);
		expect(measures.length).toBe(1);
		expect(at(measures, 0).name).toBe("telic:cart.checkout fulfilled");
		expect(at(measures, 0).start).toBe(`telic:cart.checkout:${idStr(attempt.id)}`);
	});

	it("S13.3: given a rejected mark, when tapped, then perf.measure carries the rejected phase", () => {
		const { rt } = makeRuntime();
		const { perf, measures } = makeFakePerf();
		rt.tap(createUserTimingTap({ perf }));
		const attempt = rt.intent("op.risky").begin();
		attempt.reject("boom");
		expect(at(measures, 0).name).toBe("telic:op.risky rejected");
		expect(at(measures, 0).start).toBe(`telic:op.risky:${idStr(attempt.id)}`);
	});

	it("S13.3: given an abandoned mark, when tapped, then perf.measure carries the abandoned phase", () => {
		const { rt } = makeRuntime();
		const { perf, measures } = makeFakePerf();
		rt.tap(createUserTimingTap({ perf }));
		const attempt = rt.intent("upload.file").begin();
		attempt.abandon();
		expect(at(measures, 0).name).toBe("telic:upload.file abandoned");
		expect(at(measures, 0).start).toBe(`telic:upload.file:${idStr(attempt.id)}`);
	});

	it("S13.3: given noted and linked marks, when tapped, then no perf.mark or perf.measure is emitted for them", () => {
		const { rt } = makeRuntime();
		const { perf, marks, measures } = makeFakePerf();
		rt.tap(createUserTimingTap({ perf }));
		const attempt = rt.intent("wizard.step").begin();
		attempt.note({ step: 1 });
		attempt.link({ kind: "manual", label: "panel" });
		expect(marks.length).toBe(1);
		expect(measures.length).toBe(0);
	});

	it("S13.3: given perf.measure throws (missing start mark), when a terminal mark occurs, then it is swallowed with no tap-error diagnostic", () => {
		const { rt, diagnostics } = makeRuntime();
		const markNames: string[] = [];
		const throwingPerf: PerfLike = {
			mark(name): void {
				markNames.push(name);
			},
			measure(): void {
				throw new Error("no start mark");
			},
		};
		rt.tap(createUserTimingTap({ perf: throwingPerf }));
		const attempt = rt.intent("op.compute").begin();
		expect(() => attempt.fulfill()).not.toThrow();
		expect(markNames.length).toBe(1);
		expect(tapErrors(diagnostics)).toHaveLength(0);
	});

	it("S13.3: given globalThis.performance is absent, when the tap is created and marks occur, then it is inert and never throws", () => {
		const globalRef: { performance: unknown } = globalThis;
		const original = globalThis.performance;
		globalRef.performance = undefined;
		try {
			const { rt, diagnostics } = makeRuntime();
			rt.tap(createUserTimingTap());
			const attempt = rt.intent("op.compute").begin();
			expect(() => attempt.fulfill()).not.toThrow();
			expect(tapErrors(diagnostics)).toHaveLength(0);
		} finally {
			globalRef.performance = original;
		}
	});
});
