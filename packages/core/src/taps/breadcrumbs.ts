/**
 * Breadcrumb tap — every mark becomes a breadcrumb, plus an
 * `intentContext(memory)` enricher for `beforeSend` (S13.2).
 *
 * Vendor-neutral: the caller passes its own `addBreadcrumb`-shaped sink (Sentry,
 * Rollbar telemetry, …); this module never imports a vendor SDK and has no
 * runtime dependencies. `taps/sentry.ts` re-exports this as a named preset.
 */
import type { AttemptView, Mark, MarkKind, Memory, Tap } from "../types";

export type BreadcrumbLevel = "error" | "warning" | "info";

/** Structural shape of a breadcrumb (a real Sentry `Breadcrumb` is a superset). */
export type BreadcrumbLike = {
	readonly category: string;
	readonly message: string;
	readonly level: BreadcrumbLevel;
	readonly data: Record<string, unknown>;
	readonly timestamp: number;
};

export type BreadcrumbTapOptions = {
	readonly addBreadcrumb: (breadcrumb: BreadcrumbLike) => void;
};

export function createBreadcrumbTap(opts: BreadcrumbTapOptions): Tap {
	const { addBreadcrumb } = opts;
	return {
		id: "breadcrumb",
		onMark(mark: Mark): void {
			addBreadcrumb({
				category: "intent",
				message: `${mark.kind} ${mark.intent}`,
				level: levelFor(mark.kind),
				data: dataFor(mark),
				timestamp: mark.at / 1000,
			});
		},
	};
}

export type IntentContext = {
	readonly inProgress: readonly AttemptView[];
	readonly recent: readonly Mark[];
};

/** Snapshot for `beforeSend` enrichment: active attempts + the last 10 marks. */
export function intentContext(memory: Memory): IntentContext {
	return {
		inProgress: memory.inProgress(),
		recent: memory.marks().slice(-10),
	};
}

function levelFor(kind: MarkKind): BreadcrumbLevel {
	if (kind === "rejected") return "error";
	if (kind === "abandoned") return "warning";
	return "info";
}

function dataFor(mark: Mark): Record<string, unknown> {
	const data: Record<string, unknown> = { attempt: mark.attempt, seq: mark.seq };
	switch (mark.kind) {
		case "begun":
			data.payload = mark.payload;
			return data;
		case "noted":
			data.data = mark.data;
			return data;
		case "fulfilled":
			data.outcome = mark.outcome;
			return data;
		case "rejected":
			data.reason = mark.reason;
			return data;
		case "abandoned":
			data.abandon = mark.abandon;
			return data;
		case "linked":
			data.ref = mark.ref;
			return data;
	}
}
