/**
 * useIntent — R1/R2. Mounts are not intents: this hook NEVER begins on mount.
 * It returns identity-stable `{ begin, run }` callbacks (safe in dep arrays)
 * that delegate to the intent handle from event handlers and app logic, and it
 * tracks the attempts begun through it so a component unmount abandons the
 * still-active ones with `{ why: "unmount" }` (R2.2, opt-out via
 * `abandonOnUnmount: false`).
 *
 * The runtime is the one behind the intent handle you pass (module-level
 * `intent()` handles follow the default runtime; `runtime.intent()` handles
 * stay on their runtime) — `<TelicProvider>` governs `useHandle` and the
 * memory hooks, not which runtime an existing intent handle records on.
 *
 * Memory is a secondary surface (AP2): this hook records; it exposes no way
 * to read or rewrite the tape.
 */
import type { Attempt, BeginArgs, BeginOptions, Intent } from "@telic/core";
import { useEffect, useRef } from "react";

export type UseIntentOptions = {
	/**
	 * Default true: attempts begun through this hook that are still active when
	 * the component unmounts abandon `{ why: "unmount" }`. Set false for
	 * attempts that must outlive the component (R2.2).
	 */
	readonly abandonOnUnmount?: boolean;
};

/** Identity-stable delegating handle returned by useIntent (R2.1). */
export type UseIntentHandle<P, F, R> = {
	begin(...args: BeginArgs<P>): Attempt<P, F, R>;
	run<T extends { readonly ok: boolean }>(
		payload: P,
		fn: (attempt: Attempt<P, F, R>) => Promise<T>,
		opts?: BeginOptions,
	): Promise<T>;
};

type IntentHookState<P, F, R> = {
	intent: Intent<P, F, R>;
	abandonOnUnmount: boolean;
	readonly live: Set<Attempt<P, F, R>>;
	readonly handle: UseIntentHandle<P, F, R>;
};

function track<P, F, R>(state: IntentHookState<P, F, R>, attempt: Attempt<P, F, R>): void {
	state.live.add(attempt);
	// Settled attempts leave the tracking set — only still-active ones abandon on unmount.
	void attempt.settled.then((): void => {
		state.live.delete(attempt);
	});
}

/**
 * Stable `{ begin, run }` for an intent, with tracked-attempt abandon on
 * unmount. NO mount-time begins (R1): recording happens only when the caller
 * invokes the returned callbacks.
 */
export function useIntent<P, F, R>(
	intent: Intent<P, F, R>,
	opts?: UseIntentOptions,
): UseIntentHandle<P, F, R> {
	const stateRef = useRef<IntentHookState<P, F, R> | undefined>(undefined);
	if (stateRef.current === undefined) {
		const state: IntentHookState<P, F, R> = {
			intent,
			abandonOnUnmount: true,
			live: new Set<Attempt<P, F, R>>(),
			handle: {
				begin: (...args: BeginArgs<P>): Attempt<P, F, R> => {
					const attempt = state.intent.begin(...args);
					track(state, attempt);
					return attempt;
				},
				run: <T extends { readonly ok: boolean }>(
					payload: P,
					fn: (attempt: Attempt<P, F, R>) => Promise<T>,
					runOpts?: BeginOptions,
				): Promise<T> =>
					state.intent.run(
						payload,
						(attempt: Attempt<P, F, R>): Promise<T> => {
							track(state, attempt);
							return fn(attempt);
						},
						runOpts,
					),
			},
		};
		stateRef.current = state;
	}
	const state = stateRef.current;
	// Latest-wins delegation: the stable handle always targets the current
	// render's intent/options (idempotent render-phase ref write).
	state.intent = intent;
	state.abandonOnUnmount = opts?.abandonOnUnmount !== false;

	useEffect((): (() => void) => {
		return (): void => {
			// R2.3: under StrictMode's dev double-mount this cleanup runs with an
			// empty set (begins only happen in handlers, R1) — nothing abandons.
			if (!state.abandonOnUnmount) {
				state.live.clear();
				return;
			}
			for (const attempt of state.live) {
				if (attempt.phase().phase === "active") attempt.abandon({ why: "unmount" });
			}
			state.live.clear();
		};
	}, [state]);

	return state.handle;
}
