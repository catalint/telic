import { describe, expect, it } from "bun:test";
import type {
	Attempt,
	AttemptId,
	AttemptView,
	Diagnostic,
	IntentDescriptor,
	IntentEvent,
	Mark,
	MarkKind,
	Runtime,
	RuntimeLimits,
	RuntimeMode,
	Seq,
} from "./core";
import {
	configureDefaultRuntime,
	connectBrowserLifecycle,
	createRuntime,
	currentRuntime,
	intent,
	memory,
	on,
} from "./core";
import type { StandardSchemaV1 } from "./standard-schema";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; duplicated per file by design)
// ---------------------------------------------------------------------------

type MakeRuntimeResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
	ids: string[];
};

/** Fresh, fully-injected runtime per test: mutable clock, deterministic ids, captured diagnostics. */
function makeRuntime(opts?: {
	mode?: RuntimeMode;
	limits?: RuntimeLimits;
	strictPrivacy?: boolean;
}): MakeRuntimeResult {
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
		...(opts?.strictPrivacy !== undefined ? { strictPrivacy: opts.strictPrivacy } : {}),
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

/** Hand-rolled synchronous Standard Schema (no zod). */
function schema<T>(check: (value: unknown) => T | Issues): StandardSchemaV1<T, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value: unknown): StandardSchemaV1.Result<T> => runCheck(check, value),
		},
	};
}

/** Async Standard Schema — validate resolves a Promise, tripping the S2.2 async-schema path. */
function asyncSchema<T>(check: (value: unknown) => T | Issues): StandardSchemaV1<T, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test-async",
			validate: (value: unknown): Promise<StandardSchemaV1.Result<T>> =>
				Promise.resolve(runCheck(check, value)),
		},
	};
}

const numberSchema = schema<number>((value) =>
	typeof value === "number" ? value : { issues: [{ message: "expected number" }] },
);

const positiveNumberSchema = schema<number>((value) =>
	typeof value === "number" && value > 0
		? value
		: { issues: [{ message: "expected positive number" }] },
);

const asyncNumberSchema = asyncSchema<number>((value) =>
	typeof value === "number" ? value : { issues: [{ message: "expected number" }] },
);

type Credentials = { email: string; token: string };

const credentialsSchema = schema<Credentials>((value) => {
	if (
		typeof value === "object" &&
		value !== null &&
		"email" in value &&
		"token" in value &&
		typeof value.email === "string" &&
		typeof value.token === "string"
	) {
		return { email: value.email, token: value.token };
	}
	return { issues: [{ message: "invalid credentials" }] };
});

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
// Fake LifecycleEnv (S10.6) — structural; adjust to core's exported shape.
// Listeners are fired by capture rather than by event-name so the test does
// not depend on whether core listens to "navigate" or "navigatesuccess".
// ---------------------------------------------------------------------------

type EnvListener = (event: Event) => void;

type FakeNavigation = {
	addEventListener: (type: string, listener: EnvListener) => void;
	removeEventListener: (type: string, listener: EnvListener) => void;
	currentEntry: { url: string };
};

type FakeEnv = {
	addEventListener: (type: string, listener: EnvListener) => void;
	removeEventListener: (type: string, listener: EnvListener) => void;
	navigation?: FakeNavigation;
};

type FakeLifecycle = {
	env: FakeEnv;
	firePagehide: () => void;
	fireSoftNav: (url: string) => void;
	removed: () => number;
	liveWindowCount: () => number;
};

function makeFakeLifecycle(opts?: { withNavigation?: boolean }): FakeLifecycle {
	const withNav = opts?.withNavigation !== false;
	const windowListeners = new Map<string, Set<EnvListener>>();
	const navListeners = new Set<EnvListener>();
	const currentEntry = { url: "/" };
	let removedCount = 0;

	const addWindow = (type: string, listener: EnvListener): void => {
		const set = windowListeners.get(type) ?? new Set<EnvListener>();
		set.add(listener);
		windowListeners.set(type, set);
	};
	const removeWindow = (type: string, listener: EnvListener): void => {
		if (windowListeners.get(type)?.delete(listener)) removedCount += 1;
	};

	const navigation: FakeNavigation | undefined = withNav
		? {
				addEventListener: (_type: string, listener: EnvListener): void => {
					navListeners.add(listener);
				},
				removeEventListener: (_type: string, listener: EnvListener): void => {
					if (navListeners.delete(listener)) removedCount += 1;
				},
				currentEntry,
			}
		: undefined;

	const env: FakeEnv = navigation
		? { addEventListener: addWindow, removeEventListener: removeWindow, navigation }
		: { addEventListener: addWindow, removeEventListener: removeWindow };

	return {
		env,
		firePagehide: (): void => {
			const set = windowListeners.get("pagehide");
			if (!set) return;
			for (const listener of [...set]) listener(new Event("pagehide"));
		},
		fireSoftNav: (url: string): void => {
			currentEntry.url = url;
			for (const listener of [...navListeners]) listener(new Event("navigatesuccess"));
		},
		removed: (): number => removedCount,
		liveWindowCount: (): number => {
			let total = 0;
			for (const set of windowListeners.values()) total += set.size;
			return total;
		},
	};
}

// ---------------------------------------------------------------------------
// S1. Declarations
// ---------------------------------------------------------------------------

describe("S1: declarations", () => {
	it("S1.1: given a fresh runtime, when intents are declared, then declaration is side-effect-free (no marks)", () => {
		const { rt } = makeRuntime();
		rt.intent("alpha.one");
		rt.intent("beta.two");
		expect(rt.memory.marks().length).toBe(0);
		expect(rt.memory.inProgress().length).toBe(0);
	});

	it("S1.3: given a name declared twice, when re-declared, then a duplicate-intent diagnostic fires and the second handle still works", () => {
		const { rt, diagnostics } = makeRuntime();
		rt.intent("dup.thing");
		const second = rt.intent("dup.thing");
		expect(diagnostics.filter(diagOfCode("duplicate-intent")).length).toBe(1);
		expect(only(diagnostics.filter(diagOfCode("duplicate-intent"))).intent).toBe("dup.thing");
		expect(second.name).toBe("dup.thing");
		second.begin();
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(1);
	});

	it("S1.4: given a setter-like name, when declared, then a setter-like-name diagnostic fires once and begin still records", () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("ui.setColor");
		const setterDiags = diagnostics.filter(diagOfCode("setter-like-name"));
		expect(setterDiags.length).toBe(1);
		expect(only(setterDiags).intent).toBe("ui.setColor");
		flow.begin();
		flow.begin();
		// "once per name": begin does not re-emit the nudge, and recording proceeds normally.
		expect(diagnostics.filter(diagOfCode("setter-like-name")).length).toBe(1);
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(2);
	});

	it("S1.5: given strictPrivacy, when an intent declares a payload schema with no exposure or redact, then a missing-exposure diagnostic fires once per name", () => {
		const { rt, diagnostics } = makeRuntime({ strictPrivacy: true });
		rt.intent("billing.charge", { payload: schema((value) => value) });
		// Re-declaring the same name must not re-emit the nudge (once per name).
		rt.intent("billing.charge", { payload: schema((value) => value) });
		const missing = diagnostics.filter(diagOfCode("missing-exposure"));
		expect(missing.length).toBe(1);
		expect(only(missing).intent).toBe("billing.charge");
	});

	it("S1.5: given strictPrivacy is off (default), when a payload schema lacks exposure and redact, then no missing-exposure diagnostic fires", () => {
		const { rt, diagnostics } = makeRuntime();
		rt.intent("billing.charge", { payload: schema((value) => value) });
		expect(diagnostics.filter(diagOfCode("missing-exposure")).length).toBe(0);
	});

	it("S1.5: given strictPrivacy, when an explicit exposure is set, then missing-exposure is suppressed", () => {
		const { rt, diagnostics } = makeRuntime({ strictPrivacy: true });
		rt.intent("billing.charge", { payload: schema((value) => value), exposure: "private" });
		expect(diagnostics.filter(diagOfCode("missing-exposure")).length).toBe(0);
	});

	it("S1.5: given strictPrivacy, when a redact is set, then missing-exposure is suppressed", () => {
		const { rt, diagnostics } = makeRuntime({ strictPrivacy: true });
		rt.intent("billing.charge", { payload: schema((value) => value), redact: (value) => value });
		expect(diagnostics.filter(diagOfCode("missing-exposure")).length).toBe(0);
	});

	it("S1.5: given strictPrivacy, when an intent has no payload schema, then missing-exposure does not fire", () => {
		const { rt, diagnostics } = makeRuntime({ strictPrivacy: true });
		rt.intent("billing.charge");
		expect(diagnostics.filter(diagOfCode("missing-exposure")).length).toBe(0);
	});

	it("S1.2: given odd but type-valid dotted names, when declared, then the runtime does not throw", () => {
		const { rt } = makeRuntime();
		expect(() => rt.intent("weird.")).not.toThrow();
		expect(() => rt.intent(".weird")).not.toThrow();
		expect(() => rt.intent("a.b.c.d")).not.toThrow();
		// A dot-less name violates the IntentName shape at the type level; the runtime must still not throw.
		// @ts-expect-error — intentionally violates `${string}.${string}` to exercise the no-throw guarantee
		expect(() => rt.intent("nodot")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// S2. begin()
// ---------------------------------------------------------------------------

describe("S2: begin()", () => {
	it("S2.1: given a payload, when begun, then the begun mark carries seq/at/payload/exposure and identifies the attempt", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("cart.checkout", { payload: numberSchema });
		const attempt = flow.begin(42);
		const begun = only(rt.memory.marks().filter(ofKind("begun")));
		expect(begun.kind).toBe("begun");
		expect(seqNum(begun.seq)).toBe(1);
		expect(begun.at).toBe(1000);
		expect(begun.payload).toBe(42);
		expect(begun.exposure).toBe("full");
		expect(begun.intent).toBe("cart.checkout");
		expect(begun.attempt).toBe(attempt.id);
	});

	it("S2.1: given a redact config, when begun, then the mark payload is redacted but the handle keeps the raw payload", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("profile.email", {
			payload: credentialsSchema,
			redact: (payload) => ({ email: payload.email, token: "[redacted]" }),
		});
		const attempt = flow.begin({ email: "u@x.com", token: "secret" });
		const begun = only(rt.memory.marks().filter(ofKind("begun")));
		expect(begun.payload).toEqual({ email: "u@x.com", token: "[redacted]" });
		expect(attempt.payload).toEqual({ email: "u@x.com", token: "secret" });
	});

	it('S2.1: given exposure "private", when begun, then the mark payload is "[private]" regardless of redact and the handle keeps raw', () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("vault.secret", {
			payload: credentialsSchema,
			exposure: "private",
			redact: (payload) => ({ email: payload.email }),
		});
		const attempt = flow.begin({ email: "u@x.com", token: "top-secret" });
		const begun = only(rt.memory.marks().filter(ofKind("begun")));
		expect(begun.payload).toBe("[private]");
		expect(begun.exposure).toBe("private");
		expect(attempt.payload).toEqual({ email: "u@x.com", token: "top-secret" });
	});

	it("S2.2: given a payload schema that rejects, when begun, then an invalid-payload diagnostic fires and the begin still records", () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("val.check", { payload: positiveNumberSchema });
		const attempt = flow.begin(-5);
		const invalids = diagnostics.filter(diagOfCode("invalid-payload"));
		expect(invalids.length).toBe(1);
		expect(only(invalids).intent).toBe("val.check");
		expect(only(invalids).issues.length).toBeGreaterThan(0);
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(1);
		expect(attempt.phase().phase).toBe("active");
	});

	it("S2.2: given an async payload schema, when begun, then an async-schema diagnostic fires, validation is skipped, and the begin records", () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("val.async", { payload: asyncNumberSchema });
		flow.begin(5);
		const asyncDiags = diagnostics.filter(diagOfCode("async-schema"));
		expect(asyncDiags.length).toBe(1);
		expect(only(asyncDiags).intent).toBe("val.async");
		expect(diagnostics.filter(diagOfCode("invalid-payload")).length).toBe(0);
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(1);
	});

	it("S2.3: given an ambient parent via within, when a child begins without an explicit parent, then it stamps the ambient parent", () => {
		const { rt } = makeRuntime();
		const parent = rt.intent("flow.parent").begin();
		const child = rt.intent("flow.child");
		rt.within(parent.id, () => {
			child.begin();
		});
		const childBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((m) => m.intent === "flow.child"),
		);
		expect(childBegun.parent).toBe(parent.id);
	});

	it("S2.3: given an explicit parent option, when a child begins inside a different ambient scope, then the explicit parent wins", () => {
		const { rt } = makeRuntime();
		const ambient = rt.intent("flow.ambient").begin();
		const explicit = rt.intent("flow.explicit").begin();
		const child = rt.intent("flow.child2");
		rt.within(ambient.id, () => {
			child.begin(undefined, { parent: explicit.id });
		});
		const childBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((m) => m.intent === "flow.child2"),
		);
		expect(childBegun.parent).toBe(explicit.id);
	});

	it("S2.5: given retryOf, when begun, then the begun mark stamps retryOf", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("retry.op");
		const first = flow.begin();
		first.reject("failed");
		const retry = flow.begin(undefined, { retryOf: first.id });
		const retryBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((m) => idStr(m.attempt) === idStr(retry.id)),
		);
		expect(retryBegun.retryOf).toBe(first.id);
	});

	it("S2.4: given an active keyed attempt (default dedupe), when begun again with the same key, then the same handle is returned and no second mark is emitted", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("up.load");
		const first = flow.begin(undefined, { key: "file-1" });
		const second = flow.begin(undefined, { key: "file-1" });
		expect(second).toBe(first);
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(1);
	});

	it("S2.4: given supersede, when begun again with the same key, then the old attempt is abandoned {why:superseded, by:newId} before the new begun mark", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("up.load2");
		const first = flow.begin(undefined, { key: "k" });
		const second = flow.begin(undefined, { key: "k", onConflict: "supersede" });
		expect(second).not.toBe(first);
		const p = first.phase();
		expect(p.phase).toBe("abandoned");
		if (p.phase === "abandoned") expect(p.abandon).toEqual({ why: "superseded", by: second.id });
		const abandonedMark = only(rt.memory.marks().filter(ofKind("abandoned")));
		const newBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((m) => idStr(m.attempt) === idStr(second.id)),
		);
		expect(seqNum(abandonedMark.seq)).toBeLessThan(seqNum(newBegun.seq));
	});

	it("S2.4: given no key (default concurrent), when begun twice, then two distinct attempts and two begun marks", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("con.current");
		const first = flow.begin();
		const second = flow.begin();
		expect(second).not.toBe(first);
		expect(rt.memory.marks().filter(ofKind("begun")).length).toBe(2);
	});

	it("S2.6: given an already-aborted abandonWhen signal, when begun, then the attempt is abandoned {why:signal} immediately", () => {
		const { rt } = makeRuntime();
		const controller = new AbortController();
		controller.abort();
		const attempt = rt.intent("ab.already").begin(undefined, { abandonWhen: controller.signal });
		const p = attempt.phase();
		expect(p.phase).toBe("abandoned");
		if (p.phase === "abandoned") expect(p.abandon).toEqual({ why: "signal" });
	});

	it("S2.6: given an abandonWhen signal that aborts later, when it aborts, then the attempt abandons {why:signal}", () => {
		const { rt } = makeRuntime();
		const controller = new AbortController();
		const attempt = rt.intent("ab.later").begin(undefined, { abandonWhen: controller.signal });
		expect(attempt.phase().phase).toBe("active");
		controller.abort();
		const p = attempt.phase();
		expect(p.phase).toBe("abandoned");
		if (p.phase === "abandoned") expect(p.abandon).toEqual({ why: "signal" });
	});

	it("S2.7: given mode silent, when begun, then the handle is inert (phase active-since-0, methods no-op, signal never aborts) and nothing is recorded", () => {
		const { rt } = makeRuntime({ mode: "silent" });
		const flow = rt.intent("si.lent", { fulfilled: numberSchema });
		const attempt = flow.begin();
		expect(attempt.phase()).toEqual({ phase: "active", since: 0 });
		attempt.fulfill(1);
		attempt.abandon();
		expect(attempt.phase()).toEqual({ phase: "active", since: 0 });
		expect(attempt.signal.aborted).toBe(false);
		expect(rt.memory.marks().length).toBe(0);
		expect(rt.memory.inProgress().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S3. Attempt lifecycle
// ---------------------------------------------------------------------------

describe("S3: attempt lifecycle", () => {
	it("S3.1: given a freshly begun attempt, when observed before settling, then its phase is active since now()", () => {
		const { rt, clock } = makeRuntime();
		const attempt = rt.intent("ph.ase").begin();
		const p = attempt.phase();
		expect(p.phase).toBe("active");
		if (p.phase === "active") expect(p.since).toBe(clock.t);
	});

	it("S3.2: given an active attempt, when fulfilled, then a fulfilled mark and fulfilled phase carry the outcome", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("op.compute", { fulfilled: numberSchema }).begin();
		attempt.fulfill(42);
		const fulfilled = only(rt.memory.marks().filter(ofKind("fulfilled")));
		expect(fulfilled.outcome).toBe(42);
		const p = attempt.phase();
		expect(p.phase).toBe("fulfilled");
		if (p.phase === "fulfilled") expect(p.outcome).toBe(42);
	});

	it("S3.2: given a fulfilled-schema that rejects the outcome, when fulfilled, then an invalid-outcome diagnostic fires and the fulfilled mark still records", () => {
		const { rt, diagnostics } = makeRuntime();
		const attempt = rt.intent("out.check", { fulfilled: positiveNumberSchema }).begin();
		attempt.fulfill(-3);
		const invalids = diagnostics.filter(diagOfCode("invalid-outcome"));
		expect(invalids.length).toBe(1);
		expect(idStr(only(invalids).attempt)).toBe(idStr(attempt.id));
		expect(rt.memory.marks().filter(ofKind("fulfilled")).length).toBe(1);
		expect(attempt.phase().phase).toBe("fulfilled");
	});

	it("S3.3: given an active attempt, when rejected, then a rejected mark and rejected phase carry the reason", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("op.fail").begin();
		attempt.reject("boom");
		const rejected = only(rt.memory.marks().filter(ofKind("rejected")));
		expect(rejected.reason).toBe("boom");
		const p = attempt.phase();
		expect(p.phase).toBe("rejected");
		if (p.phase === "rejected") expect(p.reason).toBe("boom");
	});

	it("S3.5: given an active attempt, when abandoned with no reason, then it abandons {why:user} by default", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("op.drop").begin();
		attempt.abandon();
		const abandoned = only(rt.memory.marks().filter(ofKind("abandoned")));
		expect(abandoned.abandon).toEqual({ why: "user" });
		const p = attempt.phase();
		expect(p.phase).toBe("abandoned");
		if (p.phase === "abandoned") expect(p.abandon).toEqual({ why: "user" });
	});

	it("S3.4: given a fulfilled attempt, when rejected, then the second settle is ignored with a double-settle {ignored:rejected} diagnostic and no mark", () => {
		const { rt, diagnostics } = makeRuntime();
		const attempt = rt.intent("ds.fr").begin();
		attempt.fulfill();
		attempt.reject("late");
		expect(attempt.phase().phase).toBe("fulfilled");
		expect(rt.memory.marks().filter(ofKind("rejected")).length).toBe(0);
		const double = only(diagnostics.filter(diagOfCode("double-settle")));
		expect(double.ignored).toBe("rejected");
		expect(idStr(double.attempt)).toBe(idStr(attempt.id));
	});

	it("S3.4: given a rejected attempt, when abandoned, then the second settle is ignored with a double-settle {ignored:abandoned} diagnostic", () => {
		const { rt, diagnostics } = makeRuntime();
		const attempt = rt.intent("ds.ra").begin();
		attempt.reject("boom");
		attempt.abandon();
		expect(attempt.phase().phase).toBe("rejected");
		expect(rt.memory.marks().filter(ofKind("abandoned")).length).toBe(0);
		expect(only(diagnostics.filter(diagOfCode("double-settle"))).ignored).toBe("abandoned");
	});

	it("S3.4: given an abandoned attempt, when fulfilled, then the second settle is ignored with a double-settle {ignored:fulfilled} diagnostic and never throws", () => {
		const { rt, diagnostics } = makeRuntime();
		const attempt = rt.intent("ds.af").begin();
		attempt.abandon();
		expect(() => attempt.fulfill()).not.toThrow();
		expect(attempt.phase().phase).toBe("abandoned");
		expect(rt.memory.marks().filter(ofKind("fulfilled")).length).toBe(0);
		expect(only(diagnostics.filter(diagOfCode("double-settle"))).ignored).toBe("fulfilled");
	});

	it("S3.6: given note while active then after settle, then only the active note records and the post-settle note is silently ignored", () => {
		const { rt, diagnostics } = makeRuntime();
		const attempt = rt.intent("no.te").begin();
		attempt.note("while-active");
		attempt.fulfill();
		attempt.note("after-settle");
		const notes = rt.memory.marks().filter(ofKind("noted"));
		expect(notes.length).toBe(1);
		expect(only(notes).data).toBe("while-active");
		expect(diagnostics.length).toBe(0);
	});

	it("S3.7: given link while active and again after settle, then both linked marks are emitted", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("li.nk").begin();
		attempt.link({ kind: "manual", label: "active-link" });
		attempt.fulfill();
		attempt.link({ kind: "manual", label: "post-settle-link" });
		const links = rt.memory.marks().filter(ofKind("linked"));
		expect(links.length).toBe(2);
		expect(at(links, 0).ref).toEqual({ kind: "manual", label: "active-link" });
		expect(at(links, 1).ref).toEqual({ kind: "manual", label: "post-settle-link" });
	});

	it("S3.8: given an attempt, when it settles, then its signal aborts with reason = terminal phase; accessing signal after settle returns an already-aborted signal", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("sig.nal");
		const active = flow.begin();
		const signal = active.signal;
		expect(signal.aborted).toBe(false);
		active.fulfill();
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe("fulfilled");

		const settledFirst = flow.begin();
		settledFirst.reject("nope");
		expect(settledFirst.signal.aborted).toBe(true);
		expect(settledFirst.signal.reason).toBe("rejected");
	});

	it("S3.9: given an attempt, when it settles, then settled resolves with the terminal phase; accessing settled after settle resolves immediately", async () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("set.tled");
		const first = flow.begin();
		first.fulfill();
		const settled = await first.settled;
		expect(settled.phase).toBe("fulfilled");

		const second = flow.begin();
		second.reject("bad");
		const settledSecond = await second.settled;
		expect(settledSecond.phase).toBe("rejected");
		if (settledSecond.phase === "rejected") expect(settledSecond.reason).toBe("bad");
	});

	it("S3.10: given wrap, when invoked after an await boundary, then a begin inside re-enters the ambient scope and stamps the parent", async () => {
		const { rt } = makeRuntime();
		const parent = rt.intent("flow.outerWrap").begin();
		const child = rt.intent("flow.innerWrap");
		let observedInside: AttemptView | undefined;
		const step = parent.wrap((): Attempt => {
			observedInside = rt.current();
			return child.begin();
		});
		// Ambient does not survive an await (S9.3); wrap re-establishes it on each call.
		await Promise.resolve();
		expect(rt.current()).toBeUndefined();
		const childAttempt = step();
		expect(observedInside?.id).toBe(parent.id);
		const childBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((m) => idStr(m.attempt) === idStr(childAttempt.id)),
		);
		expect(childBegun.parent).toBe(parent.id);
	});

	it("S3.11: given an unsettled attempt, when disposed, then it abandons {why:dispose}; a settled attempt's dispose is a no-op", () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("dis.pose");
		const unsettled = flow.begin();
		unsettled[Symbol.dispose]();
		const p = unsettled.phase();
		expect(p.phase).toBe("abandoned");
		if (p.phase === "abandoned") expect(p.abandon).toEqual({ why: "dispose" });

		const settled = flow.begin();
		settled.fulfill();
		const marksBefore = rt.memory.marks().length;
		const diagsBefore = diagnostics.length;
		settled[Symbol.dispose]();
		expect(settled.phase().phase).toBe("fulfilled");
		expect(rt.memory.marks().length).toBe(marksBefore);
		expect(diagnostics.length).toBe(diagsBefore);
	});

	it("S3.12: given run resolving ok:true with a fulfilled schema and data, then it fulfills with data as outcome and returns the result", async () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("op.run1", { payload: numberSchema, fulfilled: numberSchema });
		const result = await flow.run(3, async () => ({ ok: true, data: 99 }));
		expect(result).toEqual({ ok: true, data: 99 });
		const fulfilled = only(rt.memory.marks().filter(ofKind("fulfilled")));
		expect(fulfilled.outcome).toBe(99);
	});

	it("S3.12: given run resolving ok:true without a fulfilled schema, then it fulfills with a void outcome", async () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("op.run2", { payload: numberSchema });
		await flow.run(1, async () => ({ ok: true, data: 42 }));
		const fulfilled = only(rt.memory.marks().filter(ofKind("fulfilled")));
		expect(fulfilled.outcome).toBeUndefined();
	});

	it("S3.12: given run resolving ok:false, then it rejects with result.error when present, else the whole result", async () => {
		const { rt } = makeRuntime();
		const withError = rt.intent("op.run3a", { payload: numberSchema });
		const failure = { code: "E1" };
		const errResult = await withError.run(1, async () => ({ ok: false, error: failure }));
		expect(errResult).toEqual({ ok: false, error: failure });
		expect(
			only(rt.memory.marks({ pattern: "op.run3a" }).filter(ofKind("rejected"))).reason,
		).toEqual(failure);

		const withoutError = rt.intent("op.run3b", { payload: numberSchema });
		await withoutError.run(1, async () => ({ ok: false }));
		expect(
			only(rt.memory.marks({ pattern: "op.run3b" }).filter(ofKind("rejected"))).reason,
		).toEqual({ ok: false });
	});

	it("S3.12: given run whose fn throws (sync or async), then the attempt rejects with the thrown value and run rethrows", async () => {
		const { rt } = makeRuntime();
		const asyncFlow = rt.intent("throw.async", { payload: numberSchema });
		const asyncBoom = new Error("async boom");
		await expect(
			asyncFlow.run(1, async (): Promise<{ ok: boolean }> => {
				throw asyncBoom;
			}),
		).rejects.toBe(asyncBoom);
		expect(
			only(rt.memory.marks({ pattern: "throw.async" }).filter(ofKind("rejected"))).reason,
		).toBe(asyncBoom);

		const syncFlow = rt.intent("throw.sync", { payload: numberSchema });
		const syncBoom = new Error("sync boom");
		await expect(
			syncFlow.run(1, () => {
				throw syncBoom;
			}),
		).rejects.toBe(syncBoom);
		expect(only(rt.memory.marks({ pattern: "throw.sync" }).filter(ofKind("rejected"))).reason).toBe(
			syncBoom,
		);
	});

	it("S3.12/S3.4: given run whose fn fulfills manually then returns ok:false, then the manual fulfill wins and the reject is ignored (double-settle)", async () => {
		const { rt, diagnostics } = makeRuntime();
		const flow = rt.intent("op.run5", { payload: numberSchema, fulfilled: numberSchema });
		const result = await flow.run(1, async (attempt) => {
			attempt.fulfill(7);
			return { ok: false, error: "late" };
		});
		expect(result).toEqual({ ok: false, error: "late" });
		const view = rt.memory.last("op.run5");
		expect(view?.phase).toBe("fulfilled");
		if (view && view.phase === "fulfilled") expect(view.outcome).toBe(7);
		expect(
			diagnostics.filter(diagOfCode("double-settle")).some((d) => d.ignored === "rejected"),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// S5. Subscriptions — on()
// ---------------------------------------------------------------------------

describe("S5: subscriptions — on()", () => {
	it("S5.2: given exact, scope, and star subscriptions, when a matching intent begins, then all three receive it and non-matching reaches only star", () => {
		const { rt } = makeRuntime();
		const exact: IntentEvent[] = [];
		const scoped: IntentEvent[] = [];
		const star: IntentEvent[] = [];
		rt.on("billing.pay", (event: IntentEvent) => {
			exact.push(event);
		});
		rt.on("billing.*", (event: IntentEvent) => {
			scoped.push(event);
		});
		rt.on("*", (event: IntentEvent) => {
			star.push(event);
		});
		rt.intent("billing.pay").begin();
		rt.intent("shipping.track").begin();
		expect(exact.length).toBe(1);
		expect(scoped.length).toBe(1);
		expect(star.length).toBe(2);
	});

	it("S5.3: given a kinds filter, when marks of other kinds occur, then only the filtered kind is delivered", () => {
		const { rt } = makeRuntime();
		const delivered: Mark[] = [];
		rt.on(
			"*",
			(event: IntentEvent) => {
				delivered.push(event.mark);
			},
			{ kinds: ["fulfilled"] },
		);
		const attempt = rt.intent("op.x", { fulfilled: numberSchema }).begin();
		attempt.fulfill(1);
		expect(delivered.length).toBe(1);
		expect(only(delivered).kind).toBe("fulfilled");
	});

	it("S5.4: given retained marks, when subscribing with replay:true, then matching marks are delivered synchronously in seq order with the current attempt view", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("re.play", { fulfilled: numberSchema }).begin();
		attempt.fulfill(5);
		const replayed: IntentEvent[] = [];
		let onReturned = false;
		let deliveredSynchronously = false;
		rt.on(
			"*",
			(event: IntentEvent) => {
				replayed.push(event);
				if (!onReturned) deliveredSynchronously = true;
			},
			{ replay: true },
		);
		onReturned = true;
		expect(deliveredSynchronously).toBe(true);
		expect(replayed.length).toBe(2);
		expect(seqNum(at(replayed, 0).mark.seq)).toBeLessThan(seqNum(at(replayed, 1).mark.seq));
		// S5.4 replays the CURRENT view — both marks show the now-fulfilled attempt (contrast S5.6).
		expect(at(replayed, 0).attempt?.phase).toBe("fulfilled");
		expect(at(replayed, 1).attempt?.phase).toBe("fulfilled");
	});

	it("S5.1/S5.5: given a subscription, when unsubscribed (and disposed), then delivery stops and duplicate unsubscribe/dispose are safe", () => {
		const { rt } = makeRuntime();
		const events: IntentEvent[] = [];
		const unsub = rt.on("*", (event: IntentEvent) => {
			events.push(event);
		});
		rt.intent("u.a").begin();
		unsub();
		rt.intent("u.b").begin();
		expect(events.length).toBe(1);
		expect(() => unsub()).not.toThrow();

		const events2: IntentEvent[] = [];
		const sub = rt.on("*", (event: IntentEvent) => {
			events2.push(event);
		});
		sub[Symbol.dispose]();
		rt.intent("u.c").begin();
		expect(events2.length).toBe(0);
		expect(() => sub[Symbol.dispose]()).not.toThrow();
	});

	it("S5.5: given a throwing listener, when a mark is delivered, then a listener-error diagnostic fires and other listeners still run", () => {
		const { rt, diagnostics } = makeRuntime();
		const good: Mark[] = [];
		rt.on("*", () => {
			throw new Error("listener boom");
		});
		rt.on("*", (event: IntentEvent) => {
			good.push(event.mark);
		});
		rt.intent("l.err").begin();
		expect(good.length).toBe(1);
		const errs = diagnostics.filter(diagOfCode("listener-error"));
		expect(errs.length).toBeGreaterThanOrEqual(1);
		expect(errs.some((d) => d.pattern === "*")).toBe(true);
	});

	it("S5.5: given a listener that subscribes during delivery, then the new listener takes effect from the next mark", () => {
		const { rt } = makeRuntime();
		const late: Mark[] = [];
		let subscribed = false;
		rt.on("*", () => {
			if (!subscribed) {
				subscribed = true;
				rt.on("*", (event: IntentEvent) => {
					late.push(event.mark);
				});
			}
		});
		const flow = rt.intent("d.uring", { fulfilled: numberSchema });
		const attempt = flow.begin();
		expect(late.length).toBe(0);
		attempt.fulfill(1);
		expect(late.length).toBe(1);
	});

	it("S5.6: given a live subscription, when marks are delivered, then event.attempt reflects the post-mark phase", () => {
		const { rt } = makeRuntime();
		const events: IntentEvent[] = [];
		rt.on("*", (event: IntentEvent) => {
			events.push(event);
		});
		const attempt = rt.intent("v.iew", { fulfilled: numberSchema }).begin();
		attempt.fulfill(9);
		expect(at(events, 0).attempt?.phase).toBe("active");
		expect(at(events, 1).attempt?.phase).toBe("fulfilled");
	});
});

// ---------------------------------------------------------------------------
// S7. Taps
// ---------------------------------------------------------------------------

describe("S7: taps", () => {
	it("S7.1: given retained marks, when a tap attaches, then onAttach is called once synchronously with the existing tape", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("t.ap", { fulfilled: numberSchema }).begin();
		attempt.fulfill(1);
		let attached: readonly Mark[] | undefined;
		const laterMarks: Mark[] = [];
		rt.tap({
			id: "cap",
			onMark: (mark) => {
				laterMarks.push(mark);
			},
			onAttach: (existing) => {
				attached = existing;
			},
		});
		expect(attached?.length).toBe(2);
		expect(laterMarks.length).toBe(0);
	});

	it("S7.2/S5.5: given a tap and a listener, when a mark occurs, then the tap's onMark runs before the listener", () => {
		const { rt } = makeRuntime();
		const order: string[] = [];
		rt.tap({
			id: "t1",
			onMark: () => {
				order.push("tap");
			},
		});
		rt.on("*", () => {
			order.push("listener");
		});
		rt.intent("o.rder").begin();
		expect(order).toEqual(["tap", "listener"]);
	});

	it("S7.3: given a throwing tap, when a mark occurs, then a tap-error diagnostic with the tap id fires and delivery continues", () => {
		const { rt, diagnostics } = makeRuntime();
		rt.tap({
			id: "boom-tap",
			onMark: () => {
				throw new Error("tap boom");
			},
		});
		const listened: Mark[] = [];
		rt.on("*", (event: IntentEvent) => {
			listened.push(event.mark);
		});
		expect(() => rt.intent("t.err").begin()).not.toThrow();
		expect(diagnostics.filter(diagOfCode("tap-error")).some((d) => d.tap === "boom-tap")).toBe(
			true,
		);
		expect(listened.length).toBe(1);
	});

	it("S7.1: given an attached tap, when detached, then subsequent marks are not delivered", () => {
		const { rt } = makeRuntime();
		const marks: Mark[] = [];
		const detach = rt.tap({
			id: "d",
			onMark: (mark) => {
				marks.push(mark);
			},
		});
		rt.intent("de.tach").begin();
		detach();
		rt.intent("de.tach2").begin();
		expect(marks.length).toBe(1);
	});

	it('S7.4: given an exposure:"local" intent, when begun, then the local mark is still delivered to taps', () => {
		const { rt } = makeRuntime();
		const marks: Mark[] = [];
		rt.tap({
			id: "local",
			onMark: (mark) => {
				marks.push(mark);
			},
		});
		rt.intent("lo.cal", { exposure: "local" }).begin();
		const mark = only(marks);
		expect(mark.kind).toBe("begun");
		if (mark.kind === "begun") expect(mark.exposure).toBe("local");
	});
});

// ---------------------------------------------------------------------------
// S9. within / current
// ---------------------------------------------------------------------------

describe("S9: within / current", () => {
	it("S9.1: given within, when fn throws, then the exception propagates and the ambient stack is restored", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("w.rap").begin();
		expect(rt.current()).toBeUndefined();
		expect(() =>
			rt.within(attempt.id, () => {
				throw new Error("inside");
			}),
		).toThrow("inside");
		expect(rt.current()).toBeUndefined();
	});

	it("S9.1: given nested within, then current() returns the innermost view and restores the outer on exit", () => {
		const { rt } = makeRuntime();
		const outer = rt.intent("w.a").begin();
		const inner = rt.intent("w.b").begin();
		rt.within(outer.id, () => {
			expect(rt.current()?.id).toBe(outer.id);
			rt.within(inner.id, () => {
				expect(rt.current()?.id).toBe(inner.id);
			});
			expect(rt.current()?.id).toBe(outer.id);
		});
		expect(rt.current()).toBeUndefined();
	});

	it("S9.2: given no ambient scope current() is undefined; inside within it is the pushed attempt's view", () => {
		const { rt } = makeRuntime();
		expect(rt.current()).toBeUndefined();
		const attempt = rt.intent("c.ur").begin();
		rt.within(attempt.id, () => {
			const view = rt.current();
			expect(view?.id).toBe(attempt.id);
			expect(view?.intent).toBe("c.ur");
		});
	});
});

// ---------------------------------------------------------------------------
// S10. Runtime & default runtime
// ---------------------------------------------------------------------------

describe("S10: runtime", () => {
	it("S10.1: given injectable now and id, when attempts begin, then marks reflect the injected clock and id generator", () => {
		const { rt, clock, ids } = makeRuntime();
		const flow = rt.intent("in.ject");
		const first = flow.begin();
		expect(only(rt.memory.marks().filter(ofKind("begun"))).at).toBe(1000);
		expect(idStr(first.id)).toBe("a1");
		clock.t = 2500;
		const second = flow.begin();
		expect(at(rt.memory.marks().filter(ofKind("begun")), 1).at).toBe(2500);
		expect(idStr(second.id)).toBe("a2");
		expect(ids).toEqual(["a1", "a2"]);
	});

	it("S10.2: given a runtime without onDiagnostic, when a diagnostic condition occurs, then nothing throws and it is dropped silently", () => {
		const rt = createRuntime({ now: () => 1000, id: () => "x1" });
		rt.intent("dup.silent");
		expect(() => rt.intent("dup.silent")).not.toThrow();
	});

	it("S10.3: given foreign marks, when ingested, then they are re-seq'd locally, keep their origin, create attempt views, and are delivered to taps/listeners", () => {
		const { rt } = makeRuntime();
		rt.intent("local.first").begin(); // local seq 1, before subscribing
		const listened: Mark[] = [];
		rt.on("*", (event: IntentEvent) => {
			listened.push(event.mark);
		});
		const tapped: Mark[] = [];
		rt.tap({
			id: "ing",
			onMark: (mark) => {
				tapped.push(mark);
			},
		});

		const source = makeRuntime();
		const srcAttempt = source.rt.intent("sync.remote", { fulfilled: numberSchema }).begin();
		srcAttempt.fulfill(7);
		const foreign: Mark[] = source.rt.memory
			.marks()
			.map((mark): Mark => ({ ...mark, origin: { tab: "tab-2" } }));
		rt.ingest(foreign);

		const ingestedBegun = only(
			rt.memory
				.marks()
				.filter(ofKind("begun"))
				.filter((mark) => mark.intent === "sync.remote"),
		);
		expect(seqNum(ingestedBegun.seq)).toBe(2); // re-seq'd (was 1 in the source runtime)
		expect(ingestedBegun.origin).toEqual({ tab: "tab-2" });
		expect(idStr(ingestedBegun.attempt)).toBe(idStr(srcAttempt.id));

		const view = rt.memory.last("sync.*");
		expect(view).toBeDefined();
		if (view) {
			expect(view.origin).toEqual({ tab: "tab-2" });
			expect(idStr(view.id)).toBe(idStr(srcAttempt.id));
			expect(view.phase).toBe("fulfilled");
		}

		expect(tapped.length).toBe(2);
		expect(listened.length).toBe(2);
	});

	// Ordering here is LOAD-BEARING: the silent-default assertion must run before the
	// runtime is configured. No S1–S9 test touches the module-level intent/memory facade.
	describe("S10.4/S10.5: default runtime (module-level, ordering is load-bearing)", () => {
		it("S10.4: given a server-like env (no document in bun), when the default runtime is silent, then module-level begins are inert and record nothing", () => {
			// Other suites (mediate/flow) share this process and may already have
			// configured the default runtime, so "first lazy use" is unobservable
			// here; restore the server-default mode and assert the silent behavior.
			configureDefaultRuntime({ mode: "silent" });
			const flow = intent("dflt.silentFirst");
			const attempt = flow.begin();
			expect(attempt.phase()).toEqual({ phase: "active", since: 0 });
			attempt.fulfill();
			expect(attempt.phase()).toEqual({ phase: "active", since: 0 });
			expect(attempt.signal.aborted).toBe(false);
			expect(memory.marks().length).toBe(0);
		});

		it("S10.5: given the default runtime configured to record, then module begins record; a second configure after recording emits late-configure and replaces with an empty tape", () => {
			const defaultDiagnostics: Diagnostic[] = [];
			const clock = { t: 5000 };
			let counter = 0;
			configureDefaultRuntime({
				mode: "record",
				now: () => clock.t,
				id: () => {
					counter += 1;
					return `d${counter}`;
				},
				onDiagnostic: (diagnostic) => {
					defaultDiagnostics.push(diagnostic);
				},
			});
			intent("dflt.record").begin();
			expect(memory.marks().length).toBeGreaterThan(0);

			configureDefaultRuntime({
				mode: "record",
				onDiagnostic: (diagnostic) => {
					defaultDiagnostics.push(diagnostic);
				},
			});
			expect(defaultDiagnostics.some((d) => d.code === "late-configure")).toBe(true);
			expect(memory.marks().length).toBe(0);
		});
	});
});

// ---------------------------------------------------------------------------
// S10.6 connectBrowserLifecycle
// ---------------------------------------------------------------------------

describe("S10.6: connectBrowserLifecycle", () => {
	it("S10.6: given active attempts, when pagehide fires, then all are abandoned {why:navigation}", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("nav.thing");
		const first = flow.begin();
		const second = flow.begin();
		const fake = makeFakeLifecycle();
		connectBrowserLifecycle(rt, fake.env);
		fake.firePagehide();
		const p1 = first.phase();
		const p2 = second.phase();
		expect(p1.phase).toBe("abandoned");
		expect(p2.phase).toBe("abandoned");
		if (p1.phase === "abandoned") expect(p1.abandon).toEqual({ why: "navigation" });
	});

	it("S10.6: given soft navigation, then only boundTo-mismatched attempts abandon and boundTo-less attempts survive", () => {
		const { rt } = makeRuntime();
		const flow = rt.intent("wiz.step");
		const staying = flow.begin(undefined, {
			boundTo: { test: (url) => url.startsWith("/wizard") },
		});
		const leaving = flow.begin(undefined, { boundTo: { test: (url) => url.startsWith("/cart") } });
		const unbound = flow.begin();
		const fake = makeFakeLifecycle();
		connectBrowserLifecycle(rt, fake.env);
		fake.fireSoftNav("/wizard/step2");
		expect(staying.phase().phase).toBe("active");
		expect(unbound.phase().phase).toBe("active");
		const leftPhase = leaving.phase();
		expect(leftPhase.phase).toBe("abandoned");
		if (leftPhase.phase === "abandoned") expect(leftPhase.abandon).toEqual({ why: "navigation" });
	});

	it("S10.6: given a connected lifecycle, when disconnect is called, then listeners are removed and later events are inert", () => {
		const { rt } = makeRuntime();
		const fake = makeFakeLifecycle();
		const disconnect = connectBrowserLifecycle(rt, fake.env);
		expect(fake.liveWindowCount()).toBeGreaterThan(0);
		disconnect();
		expect(fake.removed()).toBeGreaterThan(0);
		expect(fake.liveWindowCount()).toBe(0);
		const attempt = rt.intent("nav.after").begin();
		fake.firePagehide();
		expect(attempt.phase().phase).toBe("active");
	});

	it("S10.6: given an env without the Navigation API, when connected, then it does not throw and pagehide still abandons", () => {
		const { rt } = makeRuntime();
		const fake = makeFakeLifecycle({ withNavigation: false });
		expect(() => connectBrowserLifecycle(rt, fake.env)).not.toThrow();
		const attempt = rt.intent("nav.nonav").begin();
		fake.firePagehide();
		expect(attempt.phase().phase).toBe("abandoned");
	});

	it("S10.6: given an env without the Navigation API, when connected, then a navigation-unavailable diagnostic fires once", () => {
		const { rt, diagnostics } = makeRuntime();
		const fake = makeFakeLifecycle({ withNavigation: false });
		connectBrowserLifecycle(rt, fake.env);
		expect(diagnostics.filter(diagOfCode("navigation-unavailable")).length).toBe(1);
	});

	it("S10.6: given an env WITH the Navigation API, when connected, then no navigation-unavailable diagnostic fires", () => {
		const { rt, diagnostics } = makeRuntime();
		const fake = makeFakeLifecycle();
		connectBrowserLifecycle(rt, fake.env);
		expect(diagnostics.filter(diagOfCode("navigation-unavailable")).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S11. Purity & environment
// ---------------------------------------------------------------------------

describe("S11: purity & environment", () => {
	it("S11.1/S11.2: given bun (no DOM globals), when './core' is imported, then the import is side-effect-free and exposes the API", () => {
		// Reaching this test at all proves the module import did not touch window/document at
		// module scope (bun would have thrown on load). The module-level silence is asserted in S10.4.
		expect("document" in globalThis).toBe(false);
		expect(typeof createRuntime).toBe("function");
		expect(typeof configureDefaultRuntime).toBe("function");
		expect(typeof connectBrowserLifecycle).toBe("function");
		expect(typeof intent).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// S12. describe()
// ---------------------------------------------------------------------------

describe("S12: describe()", () => {
	it("S12.1: given distinct declared intents, when describe() is called, then one descriptor per name carries name/tags/exposure/hasPayloadSchema", () => {
		const { rt } = makeRuntime();
		rt.intent("billing.renew", {
			tags: ["funnel"],
			exposure: "private",
			payload: schema((value) => value),
		});
		rt.intent("ui.open");
		const descriptors: readonly IntentDescriptor[] = rt.describe();
		expect(descriptors.length).toBe(2);
		expect(at(descriptors, 0)).toEqual({
			name: "billing.renew",
			tags: ["funnel"],
			exposure: "private",
			hasPayloadSchema: true,
			handled: false,
		});
		expect(at(descriptors, 1)).toEqual({
			name: "ui.open",
			tags: [],
			exposure: "full",
			hasPayloadSchema: false,
			handled: false,
		});
	});

	it("S12.1: given a name re-declared with a different config, when describe() is called, then the FIRST declaration's config wins and the entry is not duplicated", () => {
		const { rt } = makeRuntime();
		rt.intent("order.place", {
			tags: ["first"],
			exposure: "full",
			payload: schema((value) => value),
		});
		rt.intent("order.place", { tags: ["second"], exposure: "private" });
		const descriptors = rt.describe();
		expect(descriptors.length).toBe(1);
		expect(only(descriptors)).toEqual({
			name: "order.place",
			tags: ["first"],
			exposure: "full",
			hasPayloadSchema: true,
			handled: false,
		});
	});

	it("S12.1: given names declared non-alphabetically (with a re-declaration), when describe() is called, then descriptors are in first-declaration order", () => {
		const { rt } = makeRuntime();
		rt.intent("c.x");
		rt.intent("a.y");
		rt.intent("b.z");
		rt.intent("a.y"); // re-declaration must not reorder or duplicate
		expect(rt.describe().map((descriptor) => descriptor.name)).toEqual(["c.x", "a.y", "b.z"]);
	});

	it("S12.2: given declared intents, when describe() is called, then the returned array and its entries are frozen and a fresh copy is returned per call", () => {
		const { rt } = makeRuntime();
		rt.intent("frozen.one", { tags: ["t"] });
		const descriptors = rt.describe();
		expect(Object.isFrozen(descriptors)).toBe(true);
		expect(Object.isFrozen(at(descriptors, 0))).toBe(true);
		expect(Object.isFrozen(at(descriptors, 0).tags)).toBe(true);
		// Fresh frozen copy per call: the internal registry container is never handed out.
		expect(rt.describe()).not.toBe(rt.describe());
	});

	it("S12.3: given a silent runtime, when intents are declared, then describe() still reports them (declaration is ungated) while nothing records", () => {
		const { rt } = makeRuntime({ mode: "silent" });
		const load = rt.intent("ssr.load", { exposure: "local" });
		rt.intent("ssr.render");
		const descriptors = rt.describe();
		expect(descriptors.map((descriptor) => descriptor.name)).toEqual(["ssr.load", "ssr.render"]);
		expect(at(descriptors, 0).exposure).toBe("local");
		// Declaration is side-effect-free; only recording is silenced (S12.3).
		load.begin();
		expect(rt.memory.marks().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S10.4/S10.5/S10.7. Module-level late binding (the orphaned-runtime regression)
//
// The default runtime is module-scope state: these tests establish known state
// by replacing it via configureDefaultRuntime and use unique intent scopes per
// test (the module-level declaration registry persists across tests by design).
// ---------------------------------------------------------------------------

type ConfigureDefaultResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
};

/** Replaces the DEFAULT runtime with a fully-injected recording one (module-level API tests). */
function configureRecordingDefault(): ConfigureDefaultResult {
	const clock = { t: 1000 };
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	configureDefaultRuntime({
		mode: "record",
		now: () => clock.t,
		id: () => {
			counter += 1;
			return `dflt${counter}`;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
	});
	return { rt: currentRuntime(), clock, diagnostics };
}

describe("S10.4/S10.5/S10.7: module-level late binding", () => {
	it("S10.7: given a module-level intent declared BEFORE configure, when begun after, then the mark lands on the configured runtime (memory, tap, describe)", () => {
		const flow = intent("s107a.checkout", {
			payload: schema((value) => value),
			tags: ["funnel"],
		});
		const other = intent("s107a.pay");
		const { rt } = configureRecordingDefault();
		// Eager re-registration: describe() is complete BEFORE any recording, in registry order (S10.5/S12).
		const names = rt.describe().map((descriptor) => descriptor.name);
		expect(names).toContain("s107a.checkout");
		expect(names).toContain("s107a.pay");
		expect(names.indexOf("s107a.checkout")).toBeLessThan(names.indexOf("s107a.pay"));
		const checkoutDescriptor = rt.describe().find((d) => d.name === "s107a.checkout");
		expect(checkoutDescriptor).toEqual({
			name: "s107a.checkout",
			tags: ["funnel"],
			exposure: "full",
			hasPayloadSchema: true,
			handled: false,
		});
		const seen: Mark[] = [];
		rt.tap({
			id: "s107a-tap",
			onMark: (mark) => {
				seen.push(mark);
			},
		});
		const attempt = flow.begin({ amount: 1 });
		attempt.fulfill();
		other.begin();
		const checkoutMarks = memory.marks({ pattern: "s107a.checkout" });
		expect(checkoutMarks.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		expect(only(checkoutMarks.filter(ofKind("begun"))).payload).toEqual({ amount: 1 });
		expect(seen.map((mark) => mark.kind)).toEqual(["begun", "fulfilled", "begun"]);
	});

	it("S10.4: given a module-level on() subscribed BEFORE configure, when marks record after, then the listener hears them; unsubscribe detaches AND forgets the registry entry", () => {
		const events: IntentEvent[] = [];
		const unsubscribe = on("s104sub.*", (event) => {
			events.push(event);
		});
		configureRecordingDefault();
		intent("s104sub.go").begin();
		expect(events.map((event) => event.mark.kind)).toEqual(["begun"]);
		unsubscribe();
		configureRecordingDefault();
		intent("s104sub.next").begin();
		// Unsubscribed entries do not resurrect across a configure.
		expect(events.length).toBe(1);
	});

	it("S10.4: given a module-level on() with replay, when the default runtime is replaced, then the re-attach does NOT re-fire replay but stays live", () => {
		configureRecordingDefault();
		intent("s104rep.thing").begin();
		const events: IntentEvent[] = [];
		on(
			"s104rep.*",
			(event) => {
				events.push(event);
			},
			{ replay: true },
		);
		// Replay is honored once, on the first attach.
		expect(events.map((event) => event.mark.kind)).toEqual(["begun"]);
		configureRecordingDefault();
		expect(events.length).toBe(1);
		intent("s104rep.more").begin();
		expect(events.length).toBe(2);
	});

	it("S10.7: given an attempt begun before a configure, when settled after, then it settles on the runtime that recorded its begin; the handle's NEXT begin records on the new one", () => {
		const { rt: oldRt } = configureRecordingDefault();
		const oldSeen: Mark[] = [];
		oldRt.tap({
			id: "s107c-old",
			onMark: (mark) => {
				oldSeen.push(mark);
			},
		});
		const flow = intent("s107c.slow");
		const attempt = flow.begin();
		const { rt: newRt } = configureRecordingDefault();
		const newSeen: Mark[] = [];
		newRt.tap({
			id: "s107c-new",
			onMark: (mark) => {
				newSeen.push(mark);
			},
		});
		attempt.fulfill();
		// The sanctioned cross-runtime edge: terminal mark lands on the OLD runtime.
		expect(oldSeen.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		expect(newSeen.length).toBe(0);
		expect(memory.last("s107c.slow")).toBeUndefined();
		// Late binding: the SAME module-level handle now records on the new runtime.
		flow.begin();
		expect(newSeen.map((mark) => mark.kind)).toEqual(["begun"]);
		expect(memory.marks({ pattern: "s107c.slow" }).length).toBe(1);
	});

	it("S10.4: given a repeat module-level declaration, then duplicate-intent fires on the current default runtime and the registry keeps the FIRST config", () => {
		const { rt, diagnostics } = configureRecordingDefault();
		intent("s104dup.submit", { tags: ["first"], exposure: "private" });
		const second = intent("s104dup.submit", { tags: ["second"] });
		const dupDiags = diagnostics
			.filter(diagOfCode("duplicate-intent"))
			.filter((diagnostic) => diagnostic.intent === "s104dup.submit");
		expect(dupDiags.length).toBe(1);
		expect(rt.describe().find((d) => d.name === "s104dup.submit")).toEqual({
			name: "s104dup.submit",
			tags: ["first"],
			exposure: "private",
			hasPayloadSchema: false,
			handled: false,
		});
		// The second handle still works and resolves to the FIRST declaration.
		expect(second.tags).toEqual(["first"]);
		second.begin();
		const begun = memory.marks({ pattern: "s104dup.submit" }).filter(ofKind("begun"));
		expect(only(begun).payload).toBe("[private]");
	});

	it("S10.5: given the default runtime HAS recorded, when configured again, then late-configure still fires on the new onDiagnostic", () => {
		configureRecordingDefault();
		intent("s105late.record").begin();
		const { diagnostics } = configureRecordingDefault();
		expect(diagnostics.some((diagnostic) => diagnostic.code === "late-configure")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// S2.1 (amended by S16.3): key on the begun mark and AttemptView
// ---------------------------------------------------------------------------

describe("S2.1/S16.3: begin key stamping", () => {
	it("S2.1/S16.3: given a begin with a key, then the begun mark and the AttemptView carry it; without a key the property is absent", () => {
		const { rt } = makeRuntime();
		rt.intent("keyed.upload").begin(undefined, { key: "file-1" });
		rt.intent("keyed.plain").begin();
		const keyedMark = only(rt.memory.marks({ pattern: "keyed.upload" }).filter(ofKind("begun")));
		expect(keyedMark.key).toBe("file-1");
		expect(rt.memory.last("keyed.upload")?.key).toBe("file-1");
		const plainMark = only(rt.memory.marks({ pattern: "keyed.plain" }).filter(ofKind("begun")));
		expect("key" in plainMark).toBe(false);
		const plainView = rt.memory.last("keyed.plain");
		expect(plainView !== undefined && "key" in plainView).toBe(false);
	});
});
