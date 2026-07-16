/**
 * @telic/flow — the saga coordinator as a value (SPEC S16).
 *
 * telic contributes the bookkeeping a coordinator needs — child attempts,
 * keyed skip-on-resume, AttemptId-as-Idempotency-Key — while the app keeps
 * the policy: which steps, what order, what data flows. No retries, no
 * timers, no parallelism (S16.6). Resume = the caller invokes flow() again
 * with the same key; skip-matching is same-session only until the
 * persistence tap ships.
 */

import { currentRuntime, resolveModuleIntent } from "./core.js";
import type { Attempt, IntentName, Runtime } from "./types.js";

/** run()-style result a step fn resolves with; child settlement follows S3.12 (S16.2). */
export type FlowStepResult = {
	readonly ok: boolean;
	readonly data?: unknown;
	readonly error?: unknown;
};

/** Prior steps' recorded outcomes, keyed by step intent name (S16.2). */
export type FlowContext = Readonly<Record<string, unknown>>;

export type FlowStepFn = (
	ctx: FlowContext,
	attempt: Attempt<unknown, unknown, unknown>,
) => Promise<FlowStepResult>;

export type FlowStepOptions = {
	/** Skip when memory holds a FULFILLED attempt of this intent with the matching key (S16.4). */
	readonly skipIfFulfilled?: boolean;
};

export type FlowStep = {
	readonly intent: IntentName;
	readonly fn: FlowStepFn;
	readonly skipIfFulfilled: boolean;
};

/** Flow options: `key` gives the flow (and its children) a resume identity (S16.1/S16.3). */
export type FlowOptions = {
	readonly key?: string;
};

export type FlowResult =
	| { readonly ok: true; readonly outcomes: FlowContext }
	| { readonly ok: false; readonly step: IntentName; readonly reason: unknown };

/** Declares one sequential flow step (S16.2). */
export function step(intentName: IntentName, fn: FlowStepFn, opts?: FlowStepOptions): FlowStep {
	return { intent: intentName, fn, skipIfFulfilled: opts?.skipIfFulfilled === true };
}

/** Most recently begun FULFILLED attempt of the intent carrying the key, when retained (S16.4). */
function findFulfilledOutcome(
	runtime: Runtime,
	intentName: IntentName,
	key: string,
): { readonly outcome: unknown } | undefined {
	for (const view of runtime.memory.attempts(intentName)) {
		if (view.key !== key || view.phase !== "fulfilled") continue;
		return { outcome: view.outcome };
	}
	return undefined;
}

/**
 * Records a parent attempt and runs the steps SEQUENTIALLY, each as a child
 * attempt parented to the flow attempt (S16.1). The returned promise resolves
 * — it NEVER rejects; a step rejection rejects the flow attempt with
 * `{ step, reason }` and remaining steps never begin (S16.5).
 */
export async function flow(
	name: IntentName,
	payload: unknown,
	opts: FlowOptions | undefined,
	steps: readonly FlowStep[],
): Promise<FlowResult> {
	const runtime = currentRuntime();
	const flowKey = opts?.key;
	const flowAttempt = resolveModuleIntent(name).begin(
		payload,
		flowKey !== undefined ? { key: flowKey } : undefined,
	);
	const outcomes: Record<string, unknown> = {};

	for (const flowStep of steps) {
		const childKey = flowKey !== undefined ? `${flowKey}:${flowStep.intent}` : undefined;

		if (flowStep.skipIfFulfilled && childKey !== undefined) {
			const recorded = findFulfilledOutcome(runtime, flowStep.intent, childKey);
			if (recorded !== undefined) {
				// Resume: feed the recorded outcome into ctx; NO new child attempt (S16.4).
				outcomes[flowStep.intent] = recorded.outcome;
				continue;
			}
		}

		const stepHandle = resolveModuleIntent(flowStep.intent);
		const ctx: FlowContext = Object.freeze({ ...outcomes });
		let childAttempt: Attempt<unknown, unknown, unknown> | undefined;
		let stepResult: FlowStepResult;
		try {
			// within(flowAttempt): the child's begin (run's sync prefix) is parented (S16.1).
			stepResult = await runtime.within(flowAttempt, () =>
				stepHandle.run(
					undefined,
					(attempt): Promise<FlowStepResult> => {
						childAttempt = attempt;
						return flowStep.fn(ctx, attempt);
					},
					childKey !== undefined ? { key: childKey } : undefined,
				),
			);
		} catch (thrown) {
			// fn threw: the child is already rejected (S3.12); the FLOW rejects
			// and the remaining steps never begin (S16.5).
			flowAttempt.reject({ step: flowStep.intent, reason: thrown });
			return { ok: false, step: flowStep.intent, reason: thrown };
		}
		if (!stepResult.ok) {
			const reason = "error" in stepResult ? stepResult.error : stepResult;
			flowAttempt.reject({ step: flowStep.intent, reason });
			return { ok: false, step: flowStep.intent, reason };
		}
		// ctx accumulates the RECORDED outcome — identical to what a skip on
		// resume would feed (S16.4 symmetry).
		const childPhase = childAttempt?.phase();
		outcomes[flowStep.intent] =
			childPhase !== undefined && childPhase.phase === "fulfilled" ? childPhase.outcome : undefined;
	}

	const finalOutcomes: FlowContext = Object.freeze({ ...outcomes });
	flowAttempt.fulfill(finalOutcomes);
	return { ok: true, outcomes: finalOutcomes };
}
