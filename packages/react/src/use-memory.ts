/**
 * Memory subscription hooks — R4. useSyncExternalStore only.
 *
 * `useMemorySeq` subscribes to matching marks and snapshots the runtime's seq
 * — a primitive, so uSES equality is value equality and there is no
 * referential churn. `useInProgress` / `useLastAttempt` are memoized reads on
 * top of it: they recompute only when the seq snapshot changed.
 *
 * AP2 stands — memory is not truth: these are SECONDARY surfaces (spinners,
 * "still working…" affordances, debug panels), never the source of record for
 * app state. No hook here exposes a way to write.
 *
 * SSR (R6): the server snapshot delegates to the bound runtime's seq — the
 * default runtime is silent on the server (seq 0, empty memory), so hooks
 * render inert values without touching window.
 */
import type { AttemptView, IntentPattern, PayloadFor, Seq } from "@telic/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTelicBinding } from "./context.js";

/**
 * Re-renders on marks matching `pattern` (default "*"); returns the bound
 * runtime's seq (R4.1). Secondary surface only — memory is not truth.
 */
export function useMemorySeq(pattern?: IntentPattern): Seq {
	const binding = useTelicBinding();
	const resolved: IntentPattern = pattern ?? "*";
	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			const unsubscribe = binding.on(resolved, (): void => {
				onStoreChange();
			});
			return (): void => {
				unsubscribe();
			};
		},
		[binding, resolved],
	);
	const getSnapshot = useCallback((): Seq => binding.seq(), [binding]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Active attempts (oldest first) matching `scopePattern`, recomputed only when
 * a matching mark landed (R4.2). Secondary surface only — memory is not truth.
 */
export function useInProgress(pattern?: IntentPattern): readonly AttemptView[] {
	const binding = useTelicBinding();
	const seq = useMemorySeq(pattern);
	return useMemo(
		(): readonly AttemptView[] => binding.memory.inProgress(pattern),
		// seq is the recompute trigger: one memoized read per matching mark.
		[binding, pattern, seq],
	);
}

/**
 * Most recently begun attempt matching `pattern`, recomputed only when a
 * matching mark landed (R4.2). Secondary surface only — memory is not truth.
 */
export function useLastAttempt<Pat extends IntentPattern>(
	pattern: Pat,
): AttemptView<PayloadFor<Pat>> | undefined {
	const binding = useTelicBinding();
	const seq = useMemorySeq(pattern);
	return useMemo(
		(): AttemptView<PayloadFor<Pat>> | undefined => binding.memory.last(pattern),
		// seq is the recompute trigger: one memoized read per matching mark.
		[binding, pattern, seq],
	);
}
