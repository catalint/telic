/**
 * Testing subpath (SPEC S21) — RUNNER-AGNOSTIC helpers. No bun:test / vitest /
 * jest imports: pure factories + data-returning assertion helpers usable under
 * any runner. Ships in the published package (subpath ./testing).
 */
import { createRuntime } from "./core.js";
import type {
	AttemptId,
	AttemptPhase,
	AttemptView,
	Diagnostic,
	IntentPattern,
	Mark,
	Runtime,
	RuntimeLimits,
	RuntimeMode,
} from "./types.js";

const DEFAULT_CLOCK_START = 1000;

/** Deterministic, mutable clock. `now()` is what the runtime reads live. */
export type TestClock = {
	now(): number;
	advance(ms: number): void;
	set(ms: number): void;
};

export type TestRuntime = {
	readonly runtime: Runtime;
	readonly clock: TestClock;
	/** The runtime's own id source ("t1", "t2", …); calling it advances the shared counter. */
	nextId(): string;
	/** Diagnostics collected in emission order. */
	readonly diagnostics: Diagnostic[];
};

export type CreateTestRuntimeOptions = {
	/** Clock start (epoch ms). Default 1000. */
	readonly start?: number;
	readonly limits?: RuntimeLimits;
	readonly mode?: RuntimeMode;
	readonly strictPrivacy?: boolean;
};

/** Deterministic runtime: fixed clock (start 1000), counter ids ("t1"…), collected diagnostics. */
export function createTestRuntime(
	opts?: CreateTestRuntimeOptions,
): TestRuntime {
	let current = opts?.start ?? DEFAULT_CLOCK_START;
	let counter = 0;
	const diagnostics: Diagnostic[] = [];
	const nextId = (): string => {
		counter += 1;
		return `t${counter}`;
	};
	const clock: TestClock = {
		now: (): number => current,
		advance: (ms: number): void => {
			current += ms;
		},
		set: (ms: number): void => {
			current = ms;
		},
	};
	const runtime = createRuntime({
		now: (): number => current,
		id: nextId,
		...(opts?.limits !== undefined ? { limits: opts.limits } : {}),
		...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
		...(opts?.strictPrivacy !== undefined
			? { strictPrivacy: opts.strictPrivacy }
			: {}),
		onDiagnostic: (diagnostic: Diagnostic): void => {
			diagnostics.push(diagnostic);
		},
	});
	return { runtime, clock, nextId, diagnostics };
}

/** Retained marks, optionally pattern-filtered, in seq order. */
export function marksOf(
	runtime: Runtime,
	pattern?: IntentPattern,
): readonly Mark[] {
	return runtime.memory.marks(pattern !== undefined ? { pattern } : undefined);
}

/** Retained matching attempts, most recently begun first. Default pattern "*". */
export function attemptsOf(
	runtime: Runtime,
	pattern?: IntentPattern,
): readonly AttemptView[] {
	return runtime.memory.attempts(pattern ?? "*");
}

/** The phase of a retained attempt, or undefined when unknown/evicted. */
export function phaseOf(
	runtime: Runtime,
	attemptId: AttemptId,
): AttemptPhase | undefined {
	const view = runtime.memory
		.attempts("*")
		.find((candidate) => candidate.id === attemptId);
	if (view === undefined) return undefined;
	switch (view.phase) {
		case "active":
			return { phase: "active", since: view.since };
		case "fulfilled":
			return { phase: "fulfilled", at: view.at, outcome: view.outcome };
		case "rejected":
			return { phase: "rejected", at: view.at, reason: view.reason };
		case "abandoned":
			return { phase: "abandoned", at: view.at, abandon: view.abandon };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys so serialization is insertion-order-independent. */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => sortDeep(item));
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortDeep(value[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Stable, sorted-key JSON of the whole tape for snapshot testing. seq/at/ids are
 * included because the test runtime is deterministic (S21.3).
 */
export function serializeTape(runtime: Runtime): string {
	return JSON.stringify(sortDeep(runtime.memory.marks()));
}
