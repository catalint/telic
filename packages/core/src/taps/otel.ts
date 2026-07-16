/**
 * OpenTelemetry tap — projects the attempt lifecycle onto spans: a span per
 * begun attempt, a `noted` event per note, ending OK/ERROR on the matching
 * terminal mark (S27).
 *
 * Structural injection only — no @opentelemetry import, no runtime
 * dependencies. Any real `@opentelemetry/api` Tracer/Span satisfies
 * TracerLike/SpanLike structurally.
 */
import type { AttemptId, Mark, Tap } from "../types.js";

/** Structural subset of the @opentelemetry/api `Span` surface actually used here. */
export type SpanLike = {
	setAttribute(key: string, value: string | number | boolean): void;
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
	setStatus(status: { readonly code: 0 | 1 | 2; readonly message?: string }): void;
	end(endTime?: number): void;
};

/** Structural subset of the @opentelemetry/api `Tracer` surface actually used here. */
export type TracerLike = {
	startSpan(name: string, options?: Record<string, unknown>): SpanLike;
};

export type OtelTapOptions = {
	readonly tracer: TracerLike;
};

// Mirrors @opentelemetry/api's numeric SpanStatusCode (UNSET 0, OK 1, ERROR 2)
// without importing it — a real Span's setStatus accepts these verbatim.
const STATUS_OK = { code: 1 } as const;
const STATUS_ERROR = { code: 2 } as const;

export function createOtelTap(opts: OtelTapOptions): Tap {
	const { tracer } = opts;
	// Live spans keyed by attempt id; deleted on end. A mark for an attempt with
	// no entry (begin ring-evicted, or the tap attached after begin) is a
	// silent no-op — mirrors S13.3's missing-start-mark handling.
	const liveSpans = new Map<AttemptId, SpanLike>();

	return {
		id: "otel",
		onMark(mark: Mark): void {
			switch (mark.kind) {
				case "begun": {
					const span = tracer.startSpan(`intent:${mark.intent}`);
					span.setAttribute("telic.attempt_id", mark.attempt);
					span.setAttribute("telic.intent", mark.intent);
					if (mark.key !== undefined) span.setAttribute("telic.key", mark.key);
					liveSpans.set(mark.attempt, span);
					return;
				}
				case "noted": {
					const span = liveSpans.get(mark.attempt);
					if (span === undefined) return;
					if (isFlatPrimitiveRecord(mark.data)) {
						span.addEvent("noted", mark.data);
					} else {
						span.addEvent("noted", { json: jsonAttrValue(mark.data) });
					}
					return;
				}
				case "fulfilled": {
					const span = liveSpans.get(mark.attempt);
					if (span === undefined) return;
					span.setStatus(STATUS_OK);
					span.end(mark.at);
					liveSpans.delete(mark.attempt);
					return;
				}
				case "rejected": {
					const span = liveSpans.get(mark.attempt);
					if (span === undefined) return;
					span.setStatus(STATUS_ERROR);
					span.end(mark.at);
					liveSpans.delete(mark.attempt);
					return;
				}
				case "abandoned": {
					const span = liveSpans.get(mark.attempt);
					if (span === undefined) return;
					span.setStatus(STATUS_OK);
					span.setAttribute("telic.abandoned", mark.abandon.why);
					span.end(mark.at);
					liveSpans.delete(mark.attempt);
					return;
				}
				case "linked":
					return;
			}
		},
	};
}

function isFlatPrimitiveRecord(value: unknown): value is Record<string, string | number | boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	// Only PLAIN objects flatten to span attributes. Date/RegExp/Map/Set/class
	// instances have zero enumerable OWN values, which makes .every() vacuously
	// true — they'd be emitted as an empty attribute bag, dropping their state.
	// Route them to the json fallback instead (an empty `{}` literal still flattens
	// to an empty event, as intended — S27.4).
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value).every(isAttributeValue);
}

function isAttributeValue(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// JSON.stringify(undefined) returns undefined, not a string — normalize so
// the event attribute value always satisfies SpanLike's attribute type.
function jsonAttrValue(data: unknown): string {
	return JSON.stringify(data) ?? "null";
}
