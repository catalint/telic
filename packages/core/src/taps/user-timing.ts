/**
 * User Timing tap — projects the attempt lifecycle onto the Performance
 * timeline: a `mark` per begun attempt, a `measure` per terminal mark spanning
 * back to that begin (S13.3).
 *
 * Defaults to `globalThis.performance`, resolved at factory-call time so the
 * import stays side-effect-free and SSR-safe. Inert when performance is absent.
 * The begin mark's name is derivable from any terminal mark (intent + attempt),
 * so no per-attempt bookkeeping is kept.
 */
import type { Mark, Tap } from "../types";

/** Structural subset of the DOM `Performance` mark/measure surface. */
export type PerfLike = {
	mark(name: string, options?: { readonly detail?: unknown; readonly startTime?: number }): void;
	measure(
		name: string,
		options?: { readonly detail?: unknown; readonly start?: string; readonly end?: string },
	): void;
};

export type UserTimingTapOptions = {
	readonly perf?: PerfLike;
};

export function createUserTimingTap(opts?: UserTimingTapOptions): Tap {
	const perf = resolvePerf(opts?.perf);
	if (perf === undefined) {
		return { id: "user-timing", onMark(): void {} };
	}
	return {
		id: "user-timing",
		onMark(mark: Mark): void {
			if (mark.kind === "begun") {
				perf.mark(beginMarkName(mark.intent, mark.attempt), { detail: mark });
				return;
			}
			if (mark.kind === "fulfilled" || mark.kind === "rejected" || mark.kind === "abandoned") {
				try {
					perf.measure(`telic:${mark.intent} ${mark.kind}`, {
						start: beginMarkName(mark.intent, mark.attempt),
						detail: mark,
					});
				} catch {
					// Missing start mark (ring-evicted, or the tap attached after the
					// begin) — a silent no-op per S13.3.
				}
			}
		},
	};
}

function beginMarkName(intent: string, attempt: string): string {
	return `telic:${intent}:${attempt}`;
}

function resolvePerf(perf?: PerfLike): PerfLike | undefined {
	if (perf !== undefined) return perf;
	const globalPerf: PerfLike | undefined = globalThis.performance;
	return globalPerf;
}
