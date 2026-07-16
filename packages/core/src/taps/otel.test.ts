import { describe, expect, it } from "bun:test";
import type { AttemptId, Diagnostic, Runtime } from "../core.js";
import { createRuntime } from "../core.js";
import type { SpanLike, TracerLike } from "./otel.js";
import { createOtelTap } from "./otel.js";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; the tap runs against a REAL runtime).
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

type SpanCall =
	| { readonly type: "setAttribute"; readonly key: string; readonly value: string | number | boolean }
	| {
			readonly type: "addEvent";
			readonly name: string;
			readonly attributes: Record<string, string | number | boolean> | undefined;
	  }
	| { readonly type: "setStatus"; readonly status: { readonly code: 0 | 1 | 2; readonly message?: string } }
	| { readonly type: "end"; readonly endTime: number | undefined };

type FakeSpan = SpanLike & {
	readonly name: string;
	readonly calls: SpanCall[];
};

function makeFakeTracer(): { tracer: TracerLike; spans: FakeSpan[] } {
	const spans: FakeSpan[] = [];
	const tracer: TracerLike = {
		startSpan(name): SpanLike {
			const calls: SpanCall[] = [];
			const span: FakeSpan = {
				name,
				calls,
				setAttribute(key, value): void {
					calls.push({ type: "setAttribute", key, value });
				},
				addEvent(eventName, attributes): void {
					calls.push({ type: "addEvent", name: eventName, attributes });
				},
				setStatus(status): void {
					calls.push({ type: "setStatus", status });
				},
				end(endTime): void {
					calls.push({ type: "end", endTime });
				},
			};
			spans.push(span);
			return span;
		},
	};
	return { tracer, spans };
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

function callsOfType<K extends SpanCall["type"]>(
	span: FakeSpan,
	type: K,
): readonly Extract<SpanCall, { readonly type: K }>[] {
	return span.calls.filter((call): call is Extract<SpanCall, { readonly type: K }> => call.type === type);
}

function tapErrors(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.code === "tap-error");
}

// ---------------------------------------------------------------------------
// S27: OpenTelemetry tap
// ---------------------------------------------------------------------------

describe("S27: OpenTelemetry tap", () => {
	it("S27.2: given a full attempt lifecycle, when tapped, then the span opens with begin attributes, records noted events (flat + json fallback), and ends OK on fulfil", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		const attempt = rt.intent("cart.checkout").begin();
		expect(spans).toHaveLength(1);
		const span = only(spans);
		expect(span.name).toBe("intent:cart.checkout");
		expect(callsOfType(span, "setAttribute")).toEqual([
			{ type: "setAttribute", key: "telic.attempt_id", value: idStr(attempt.id) },
			{ type: "setAttribute", key: "telic.intent", value: "cart.checkout" },
		]);

		attempt.note({ step: 1, ok: true });
		attempt.note({ nested: { deep: true } });
		attempt.fulfill();

		expect(callsOfType(span, "addEvent")).toEqual([
			{ type: "addEvent", name: "noted", attributes: { step: 1, ok: true } },
			{
				type: "addEvent",
				name: "noted",
				attributes: { json: JSON.stringify({ nested: { deep: true } }) },
			},
		]);
		expect(callsOfType(span, "setStatus")).toEqual([{ type: "setStatus", status: { code: 1 } }]);
		expect(callsOfType(span, "end")).toEqual([{ type: "end", endTime: 1000 }]);
	});

	it("S27.2: given a rejected mark, when tapped, then the span gets ERROR status and ends", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		const attempt = rt.intent("op.risky").begin();
		attempt.reject("boom");

		const span = only(spans);
		expect(callsOfType(span, "setStatus")).toEqual([{ type: "setStatus", status: { code: 2 } }]);
		expect(callsOfType(span, "end")).toEqual([{ type: "end", endTime: 1000 }]);
	});

	it("S27.2: given an abandoned mark, when tapped, then the span gets OK status plus a telic.abandoned attribute and ends", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		const attempt = rt.intent("upload.file").begin();
		attempt.abandon({ why: "unmount" });

		const span = only(spans);
		expect(callsOfType(span, "setStatus")).toEqual([{ type: "setStatus", status: { code: 1 } }]);
		expect(callsOfType(span, "setAttribute")).toContainEqual({
			type: "setAttribute",
			key: "telic.abandoned",
			value: "unmount",
		});
		expect(callsOfType(span, "end")).toEqual([{ type: "end", endTime: 1000 }]);
	});

	it("S27.2: given a keyed begin, when tapped, then the span carries a telic.key attribute", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		rt.intent("upload.file").begin(undefined, { key: "upload-42" });

		const span = only(spans);
		expect(callsOfType(span, "setAttribute")).toContainEqual({
			type: "setAttribute",
			key: "telic.key",
			value: "upload-42",
		});
	});

	it("S27.2: given an unkeyed begin, when tapped, then no telic.key attribute is set", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		rt.intent("cart.checkout").begin();

		const span = only(spans);
		expect(callsOfType(span, "setAttribute").some((call) => call.key === "telic.key")).toBe(false);
	});

	it("S27.3: given a terminal mark for an attempt with no live span (tap attached after begin), when tapped, then it is a silent no-op", () => {
		const { rt, diagnostics } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();

		const attempt = rt.intent("op.compute").begin();
		rt.tap(createOtelTap({ tracer })); // attached late — misses the begun mark
		expect(spans).toHaveLength(0);

		expect(() => attempt.fulfill()).not.toThrow();
		expect(spans).toHaveLength(0);
		expect(tapErrors(diagnostics)).toHaveLength(0);
	});

	it("S27.3: given a noted mark for an attempt with no live span, when tapped, then it is a silent no-op", () => {
		const { rt, diagnostics } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();

		const attempt = rt.intent("op.compute").begin();
		rt.tap(createOtelTap({ tracer })); // attached late — misses the begun mark

		expect(() => attempt.note({ x: 1 })).not.toThrow();
		expect(spans).toHaveLength(0);
		expect(tapErrors(diagnostics)).toHaveLength(0);
	});

	it("S27: given two concurrent attempts, when tapped, then two spans are opened and each terminal mark ends the correctly correlated span", () => {
		const { rt } = makeRuntime();
		const { tracer, spans } = makeFakeTracer();
		rt.tap(createOtelTap({ tracer }));

		const first = rt.intent("cart.checkout").begin();
		const second = rt.intent("upload.file").begin();
		expect(spans).toHaveLength(2);
		const [spanA, spanB] = [at(spans, 0), at(spans, 1)];

		expect(callsOfType(spanA, "setAttribute")).toContainEqual({
			type: "setAttribute",
			key: "telic.attempt_id",
			value: idStr(first.id),
		});
		expect(callsOfType(spanB, "setAttribute")).toContainEqual({
			type: "setAttribute",
			key: "telic.attempt_id",
			value: idStr(second.id),
		});

		// End the second attempt first to prove correlation isn't order-dependent.
		second.fulfill();
		first.reject("nope");

		expect(callsOfType(spanA, "setStatus")).toEqual([{ type: "setStatus", status: { code: 2 } }]);
		expect(callsOfType(spanA, "end")).toHaveLength(1);
		expect(callsOfType(spanB, "setStatus")).toEqual([{ type: "setStatus", status: { code: 1 } }]);
		expect(callsOfType(spanB, "end")).toHaveLength(1);
	});
});
