import { describe, expect, it } from "bun:test";
import type {
	AttemptId,
	Diagnostic,
	Mark,
	MarkKind,
	Projection,
	Runtime,
	RuntimeLimits,
	RuntimeMode,
	Seq,
} from "./core.js";
import { createRuntime } from "./core.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; duplicated per file by design)
// ---------------------------------------------------------------------------

type MakeRuntimeResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
	ids: string[];
};

function makeRuntime(opts?: { mode?: RuntimeMode; limits?: RuntimeLimits }): MakeRuntimeResult {
	const clock = { t: 1000 };
	const diagnostics: Diagnostic[] = [];
	const ids: string[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => clock.t,
		id: () => {
			counter += 1;
			const generated = `a${counter}`;
			ids.push(generated);
			return generated;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
		...(opts?.mode ? { mode: opts.mode } : {}),
		...(opts?.limits ? { limits: opts.limits } : {}),
	});
	return { rt, clock, diagnostics, ids };
}

type Issues = { readonly issues: readonly { readonly message: string }[] };

function isIssues(value: unknown): value is Issues {
	return typeof value === "object" && value !== null && "issues" in value;
}

function runCheck<T>(
	check: (value: unknown) => T | Issues,
	value: unknown,
): StandardSchemaV1.Result<T> {
	const outcome = check(value);
	if (isIssues(outcome)) {
		return { issues: outcome.issues };
	}
	return { value: outcome };
}

function schema<T>(check: (value: unknown) => T | Issues): StandardSchemaV1<T, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value: unknown): StandardSchemaV1.Result<T> => runCheck(check, value),
		},
	};
}

const numberSchema = schema<number>((value) =>
	typeof value === "number" ? value : { issues: [{ message: "expected number" }] },
);

function seqNum(seq: Seq): number {
	return seq;
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

function ofKind<K extends MarkKind>(
	kind: K,
): (mark: Mark) => mark is Extract<Mark, { readonly kind: K }> {
	return (mark): mark is Extract<Mark, { readonly kind: K }> => mark.kind === kind;
}

function diagOfCode<C extends Diagnostic["code"]>(
	code: C,
): (diagnostic: Diagnostic) => diagnostic is Extract<Diagnostic, { readonly code: C }> {
	return (diagnostic): diagnostic is Extract<Diagnostic, { readonly code: C }> =>
		diagnostic.code === code;
}

// ---------------------------------------------------------------------------
// S4. Tape
// ---------------------------------------------------------------------------

describe("S4: tape", () => {
	it("S4.1: given the injected clock, when marks are emitted, then seq is monotonic from 1 and at comes from now()", () => {
		const { rt, clock } = makeRuntime();
		clock.t = 1234;
		rt.intent("s.one").begin();
		rt.intent("s.two").begin();
		const marks = rt.memory.marks();
		expect(seqNum(at(marks, 0).seq)).toBe(1);
		expect(seqNum(at(marks, 1).seq)).toBe(2);
		expect(at(marks, 0).at).toBe(1234);
	});

	it("S4.2: given emitted marks, when read back, then each mark is frozen", () => {
		const { rt } = makeRuntime();
		rt.intent("fr.mark").begin();
		const mark = at(rt.memory.marks(), 0);
		expect(Object.isFrozen(mark)).toBe(true);
	});

	it("S4.3: given a marks ring-buffer limit, when it overflows, then the oldest marks are evicted first", () => {
		const { rt } = makeRuntime({ limits: { marks: 5 } });
		const flow = rt.intent("ring.buf");
		for (let index = 0; index < 6; index += 1) flow.begin();
		const marks = rt.memory.marks();
		expect(marks.length).toBe(5);
		expect(seqNum(at(marks, 0).seq)).toBe(2); // seq 1 evicted
		expect(seqNum(at(marks, 4).seq)).toBe(6);
	});

	it("S4.4: given active attempts whose marks are evicted, then the attempt index still retains them (inProgress cannot lie)", () => {
		const { rt } = makeRuntime({ limits: { marks: 2 } });
		const flow = rt.intent("act.keep");
		const survivor = flow.begin(); // seq 1 — its begun mark will be evicted
		flow.begin(); // seq 2
		flow.begin(); // seq 3 — tape now holds only seq 2 and 3
		expect(rt.memory.marks().length).toBe(2);
		const active = rt.memory.inProgress();
		expect(active.length).toBe(3);
		expect(active.some((view) => idStr(view.id) === idStr(survivor.id))).toBe(true);
	});

	it("S4.4: given a settledAttempts LRU limit, when more attempts settle than the limit, then the oldest settled attempt is evicted from memory queries", () => {
		// Interpretation: settled-LRU eviction removes the attempt from memory queries even though its
		// marks may still linger in the ring buffer (has()/last() are "retained only", S6.1/S6.2).
		const { rt } = makeRuntime({ limits: { settledAttempts: 2 } });
		const a = rt.intent("lru.a").begin();
		a.fulfill();
		const b = rt.intent("lru.b").begin();
		b.fulfill();
		const c = rt.intent("lru.c").begin();
		c.fulfill();
		expect(rt.memory.has("lru.a")).toBe(false); // oldest settled — evicted
		expect(rt.memory.has("lru.b")).toBe(true);
		expect(rt.memory.has("lru.c")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// S6. Memory
// ---------------------------------------------------------------------------

describe("S6: memory", () => {
	it("S6.1: given several attempts, when last() is queried, then it returns the one with the highest begun seq", () => {
		const { rt } = makeRuntime();
		rt.intent("ev.one").begin();
		const latest = rt.intent("ev.two").begin();
		const last = rt.memory.last("ev.*");
		expect(last).toBeDefined();
		if (last) expect(idStr(last.id)).toBe(idStr(latest.id));
	});

	it("S6.2: given a phase filter, when has() is queried, then it matches only attempts in that phase", () => {
		const { rt } = makeRuntime();
		const done = rt.intent("h.done", { fulfilled: numberSchema }).begin();
		done.fulfill(1);
		rt.intent("h.active").begin();
		expect(rt.memory.has("h.*", { phase: "fulfilled" })).toBe(true);
		expect(rt.memory.has("h.*", { phase: "active" })).toBe(true);
		expect(rt.memory.has("h.*", { phase: "rejected" })).toBe(false);
	});

	it("S6.2: given withinMs, when has() is queried, then it compares now() against the attempt's last activity (settle time)", () => {
		const { rt, clock } = makeRuntime();
		const attempt = rt.intent("w.recent", { fulfilled: numberSchema }).begin(); // begun at 1000
		clock.t = 2000;
		attempt.fulfill(1); // last activity now 2000
		clock.t = 5000;
		expect(rt.memory.has("w.recent", { withinMs: 4000 })).toBe(true); // 5000 - 2000 = 3000 <= 4000
		expect(rt.memory.has("w.recent", { withinMs: 2000 })).toBe(false); // 3000 > 2000
	});

	it("S6.3: given active attempts, when inProgress() is queried, then it returns them oldest-begun first with an optional scope filter", () => {
		const { rt, clock } = makeRuntime();
		const first = rt.intent("p.a").begin();
		clock.t = 1010;
		const second = rt.intent("p.b").begin();
		clock.t = 1020;
		const third = rt.intent("q.c").begin();
		expect(rt.memory.inProgress().map((view) => idStr(view.id))).toEqual([
			idStr(first.id),
			idStr(second.id),
			idStr(third.id),
		]);
		expect(rt.memory.inProgress("p.*").map((view) => idStr(view.id))).toEqual([
			idStr(first.id),
			idStr(second.id),
		]);
	});

	it("S6.4: given several attempts, when attempts() is queried, then it returns them most-recent-first bounded by limit", () => {
		const { rt } = makeRuntime();
		const first = rt.intent("at.x").begin();
		const second = rt.intent("at.y").begin();
		const third = rt.intent("at.z").begin();
		expect(rt.memory.attempts("at.*").map((view) => idStr(view.id))).toEqual([
			idStr(third.id),
			idStr(second.id),
			idStr(first.id),
		]);
		expect(rt.memory.attempts("at.*", { limit: 2 }).map((view) => idStr(view.id))).toEqual([
			idStr(third.id),
			idStr(second.id),
		]);
	});

	it("S6.5: given marks, when marks() is queried, then pattern/kinds/sinceSeq (exclusive) filter the tape in seq order", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("m.a", { fulfilled: numberSchema }).begin(); // seq 1 begun
		attempt.note("hello"); // seq 2 noted
		rt.intent("m.b").begin(); // seq 3 begun
		attempt.fulfill(7); // seq 4 fulfilled

		const aMarks = rt.memory.marks({ pattern: "m.a" });
		expect(aMarks.every((mark) => mark.intent === "m.a")).toBe(true);
		expect(aMarks.length).toBe(3);

		const beguns = rt.memory.marks({ kinds: ["begun"] });
		expect(beguns.every((mark) => mark.kind === "begun")).toBe(true);
		expect(beguns.length).toBe(2);

		const notedSeq = only(rt.memory.marks().filter(ofKind("noted"))).seq; // Seq value 2
		const after = rt.memory.marks({ sinceSeq: notedSeq });
		expect(after.map((mark) => seqNum(mark.seq))).toEqual([3, 4]); // exclusive — seq 2 dropped
	});

	it("S6.6: given a projection, when registered, then it folds retained marks then live marks, subscribe fires per fold, and dispose detaches", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("pr.count");
		flow.begin();
		flow.begin(); // 2 retained begun marks
		const beginCounter: Projection<number> = {
			id: "begin-counter",
			init: () => 0,
			reduce: (state, mark) => (mark.kind === "begun" ? state + 1 : state),
		};
		const handle = rt.memory.project(beginCounter);
		expect(handle.read()).toBe(2); // replayed the current tape

		const states: number[] = [];
		const sub = handle.subscribe((state) => {
			states.push(state);
		});
		flow.begin(); // live fold
		expect(handle.read()).toBe(3);
		expect(states[states.length - 1]).toBe(3); // fired after the live fold
		const firesAfterLiveFold = states.length;

		sub();
		handle.dispose();
		flow.begin();
		expect(handle.read()).toBe(3); // detached — no further folding
		expect(states.length).toBe(firesAfterLiveFold); // no fold delivered after dispose
	});

	it("S6.6: given a projection whose reducer throws, then a listener-error diagnostic fires and the mark is skipped (state unchanged)", () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("pr.throw", { fulfilled: numberSchema });
		const projection: Projection<number> = {
			id: "throwing",
			init: () => 0,
			reduce: (state, mark) => {
				if (mark.kind === "noted") throw new Error("reduce boom");
				return mark.kind === "begun" ? state + 1 : state;
			},
		};
		const handle = rt.memory.project(projection);
		const attempt = flow.begin();
		expect(handle.read()).toBe(1);
		attempt.note("x"); // reducer throws on noted → skipped
		expect(handle.read()).toBe(1);
		expect(diagnostics.filter(diagOfCode("listener-error")).length).toBeGreaterThanOrEqual(1);
	});

	it("S6.7: given a snapshot, when taken, then it is a detached deep copy that freezes views", () => {
		const { rt } = makeRuntime();
		const full = rt.intent("sn.full", { fulfilled: numberSchema });
		const attempt = full.begin(); // seq 1

		const snap = rt.memory.snapshot();
		const snapAgain = rt.memory.snapshot();

		// Deep copy — successive snapshots hand back distinct object identities.
		expect(at(snapAgain.recent, 0)).not.toBe(at(snap.recent, 0));

		expect(snap.active.some((view) => view.intent === "sn.full")).toBe(true);
		expect(snap.recent.length).toBe(1);
		expect(snap.at).toBe(1000);
		expect(seqNum(snap.seq)).toBe(1);

		// Frozen views + marks.
		expect(Object.isFrozen(at(snap.active, 0))).toBe(true);
		expect(Object.isFrozen(at(snap.recent, 0))).toBe(true);

		// Detached — later activity does not mutate a snapshot already taken.
		const recentAtSnapshot = snap.recent.length;
		attempt.fulfill(1);
		full.begin();
		expect(snap.recent.length).toBe(recentAtSnapshot);
	});

	it("S6.8: given views returned by memory, then they are frozen", () => {
		const { rt } = makeRuntime();
		rt.intent("fr.ozen", { fulfilled: numberSchema }).begin();
		const last = rt.memory.last("fr.ozen");
		expect(last !== undefined && Object.isFrozen(last)).toBe(true);
		expect(Object.isFrozen(at(rt.memory.inProgress(), 0))).toBe(true);
		expect(Object.isFrozen(at(rt.memory.attempts("fr.*"), 0))).toBe(true);
	});
});
