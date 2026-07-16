import { describe, expect, it } from "bun:test";
import type { Mark } from "./types.js";
import { parseMark, parseWirePayload, serializeMarks } from "./wire.js";

// ---------------------------------------------------------------------------
// Test infrastructure — wire parsers take/return plain values; no runtime.
// ---------------------------------------------------------------------------

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

/** JSON round-trip → drops brands (Seq/AttemptId/IntentName) so `toEqual` accepts plain literals. */
function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

const BEGUN = {
	kind: "begun",
	seq: 1,
	at: 1000,
	intent: "cart.checkout",
	attempt: "a1",
	payload: { items: 2 },
} as const;

describe("S19.1 parseMark — required fields per kind", () => {
	it("S19.1: parses a valid begun mark into a real branded Mark", () => {
		const mark = parseMark(BEGUN);
		expect(plain(mark)).toEqual(BEGUN);
		expect(Object.isFrozen(mark)).toBe(true);
	});

	it("S19.1: parses noted/fulfilled/rejected/linked", () => {
		expect(
			plain(
				parseMark({
					kind: "noted",
					seq: 2,
					at: 1,
					intent: "a.b",
					attempt: "x",
					data: 42,
				}),
			),
		).toEqual({
			kind: "noted",
			seq: 2,
			at: 1,
			intent: "a.b",
			attempt: "x",
			data: 42,
		});
		expect(
			plain(
				parseMark({
					kind: "fulfilled",
					seq: 3,
					at: 1,
					intent: "a.b",
					attempt: "x",
					outcome: "ok",
				}),
			),
		).toEqual({
			kind: "fulfilled",
			seq: 3,
			at: 1,
			intent: "a.b",
			attempt: "x",
			outcome: "ok",
		});
		expect(
			plain(
				parseMark({
					kind: "rejected",
					seq: 4,
					at: 1,
					intent: "a.b",
					attempt: "x",
					reason: "no",
				}),
			),
		).toEqual({
			kind: "rejected",
			seq: 4,
			at: 1,
			intent: "a.b",
			attempt: "x",
			reason: "no",
		});
		expect(
			plain(
				parseMark({
					kind: "linked",
					seq: 5,
					at: 1,
					intent: "a.b",
					attempt: "x",
					ref: { kind: "mutation", mutationKey: "m", status: "success" },
				}),
			),
		).toEqual({
			kind: "linked",
			seq: 5,
			at: 1,
			intent: "a.b",
			attempt: "x",
			ref: { kind: "mutation", mutationKey: "m", status: "success" },
		});
	});

	it("S19.1: rejects non-records, wrong kinds, and missing primitives", () => {
		expect(parseMark(null)).toBeUndefined();
		expect(parseMark("nope")).toBeUndefined();
		expect(parseMark([BEGUN])).toBeUndefined();
		expect(parseMark({ ...BEGUN, kind: "unknown" })).toBeUndefined();
		expect(parseMark({ ...BEGUN, seq: "1" })).toBeUndefined();
		expect(parseMark({ ...BEGUN, at: Number.NaN })).toBeUndefined();
		expect(parseMark({ ...BEGUN, intent: "" })).toBeUndefined();
		expect(parseMark({ ...BEGUN, attempt: 5 })).toBeUndefined();
	});

	it("S19.1: payload/outcome/reason/data pass through as unknown", () => {
		const payload = { nested: [1, 2, { deep: true }], n: null };
		const mark = parseMark({ ...BEGUN, payload });
		expect(mark?.kind === "begun" && mark.payload).toEqual(payload);
	});

	it("S19.1: abandon reason is structurally validated", () => {
		const base = {
			kind: "abandoned",
			seq: 1,
			at: 1,
			intent: "a.b",
			attempt: "x",
		} as const;
		const nav = parseMark({ ...base, abandon: { why: "navigation" } });
		expect(nav?.kind === "abandoned" && nav.abandon).toEqual({
			why: "navigation",
		});
		const user = parseMark({
			...base,
			abandon: { why: "user", detail: "cancelled" },
		});
		expect(user?.kind === "abandoned" && user.abandon).toEqual({
			why: "user",
			detail: "cancelled",
		});
		const superseded = parseMark({
			...base,
			abandon: { why: "superseded", by: "a2" },
		});
		expect(
			plain(superseded?.kind === "abandoned" && superseded.abandon),
		).toEqual({
			why: "superseded",
			by: "a2",
		});
		// superseded without `by` and unknown why → whole mark invalid
		expect(
			parseMark({ ...base, abandon: { why: "superseded" } }),
		).toBeUndefined();
		expect(parseMark({ ...base, abandon: { why: "poof" } })).toBeUndefined();
		expect(parseMark({ ...base, abandon: "navigation" })).toBeUndefined();
	});

	it("S19.1: provenance ref is structurally validated", () => {
		const base = {
			kind: "linked",
			seq: 1,
			at: 1,
			intent: "a.b",
			attempt: "x",
		} as const;
		const manualBare = parseMark({
			...base,
			ref: { kind: "manual", label: "l" },
		});
		expect(manualBare?.kind === "linked" && manualBare.ref).toEqual({
			kind: "manual",
			label: "l",
		});
		const manualData = parseMark({
			...base,
			ref: { kind: "manual", label: "l", data: { a: 1 } },
		});
		expect(manualData?.kind === "linked" && manualData.ref).toEqual({
			kind: "manual",
			label: "l",
			data: { a: 1 },
		});
		expect(
			parseMark({ ...base, ref: { kind: "xstate", actorId: "a" } }),
		).toBeUndefined();
		expect(parseMark({ ...base, ref: { kind: "bogus" } })).toBeUndefined();
	});

	it("S19.1: origin parsed when meaningful, dropped when empty", () => {
		const withOrigin = parseMark({
			...BEGUN,
			origin: { restored: true, app: "web", junk: 9 },
		});
		expect(withOrigin?.origin).toEqual({ app: "web", restored: true });
		const emptyOrigin = parseMark({ ...BEGUN, origin: { junk: 9 } });
		expect(emptyOrigin?.origin).toBeUndefined();
	});
});

describe("S19.2 envelope — serialize + parseWirePayload", () => {
	it("S19.2: serializeMarks uses a versioned envelope { v: 1, marks }", () => {
		const marks = [parseMark(BEGUN)].filter((m): m is Mark => m !== undefined);
		const json = serializeMarks(marks);
		expect(JSON.parse(json)).toEqual({ v: 1, marks: [BEGUN] });
	});

	it("S19.2: round-trips through serialize → parse", () => {
		const marks = [
			at([parseMark(BEGUN)], 0),
			at(
				[
					parseMark({
						kind: "fulfilled",
						seq: 2,
						at: 1001,
						intent: "cart.checkout",
						attempt: "a1",
						outcome: null,
					}),
				],
				0,
			),
		].filter((m): m is Mark => m !== undefined);
		const restored = parseWirePayload(serializeMarks(marks));
		expect(restored).toEqual(marks);
	});

	it("S19.2: tolerant — garbage/non-record/unknown-version → []", () => {
		expect(parseWirePayload("not json")).toEqual([]);
		expect(parseWirePayload("[]")).toEqual([]);
		expect(parseWirePayload("42")).toEqual([]);
		expect(parseWirePayload(JSON.stringify({ v: 2, marks: [BEGUN] }))).toEqual(
			[],
		);
		expect(parseWirePayload(JSON.stringify({ v: 1, marks: "nope" }))).toEqual(
			[],
		);
	});

	it("S19.1/2: skips invalid entries, keeps valid ones", () => {
		const json = JSON.stringify({
			v: 1,
			marks: [
				BEGUN,
				{ kind: "bogus" },
				5,
				{ kind: "noted", seq: 2, at: 1, intent: "a.b", attempt: "x", data: 1 },
			],
		});
		const restored = parseWirePayload(json);
		expect(restored.map((m) => m.kind)).toEqual(["begun", "noted"]);
	});
});
