/**
 * Wire format (SPEC S19) — hand-rolled structural validators, ZERO deps.
 *
 * The serialization boundary for persistence (S18) and future transports. Core
 * never imports this module; this module never imports core. `parseMark` /
 * `parseWirePayload` are tolerant readers — recorded payloads
 * (`payload`/`outcome`/`reason`/`data`) pass through as `unknown`; structured
 * fields (`kind`, `abandon`, `ref`, `origin`) are validated so the
 * result is a REAL, branded `Mark`.
 */
import type {
	AbandonReason,
	AttemptId,
	IntentName,
	Mark,
	MarkOrigin,
	ProvenanceRef,
	Seq,
} from "./types.js";

// ---------------------------------------------------------------------------
// Branded/type bridges (overload trick — no `as` casts; mirrors core.ts)
// ---------------------------------------------------------------------------

function asSeq(value: number): Seq;
function asSeq(value: number): number {
	return value;
}

function asAttemptId(value: string): AttemptId;
function asAttemptId(value: string): string {
	return value;
}

function asIntentName(value: string): IntentName;
function asIntentName(value: string): string {
	return value;
}

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalAttemptId(value: unknown): AttemptId | undefined {
	return typeof value === "string" ? asAttemptId(value) : undefined;
}

function parseOrigin(value: unknown): MarkOrigin | undefined {
	if (!isRecord(value)) return undefined;
	const origin: MarkOrigin = {
		...(typeof value.tab === "string" ? { tab: value.tab } : {}),
		...(typeof value.app === "string" ? { app: value.app } : {}),
		...(typeof value.restored === "boolean"
			? { restored: value.restored }
			: {}),
	};
	return Object.keys(origin).length > 0 ? origin : undefined;
}

function parseAbandon(value: unknown): AbandonReason | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.why) {
		case "navigation":
		case "unmount":
		case "dispose":
		case "signal":
		case "timeout":
			return { why: value.why };
		case "user":
			return typeof value.detail === "string"
				? { why: "user", detail: value.detail }
				: { why: "user" };
		case "superseded":
			return typeof value.by === "string"
				? { why: "superseded", by: asAttemptId(value.by) }
				: undefined;
		default:
			return undefined;
	}
}

function parseRef(value: unknown): ProvenanceRef | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.kind) {
		case "xstate":
			return typeof value.actorId === "string" &&
				typeof value.state === "string" &&
				typeof value.event === "string"
				? {
						kind: "xstate",
						actorId: value.actorId,
						state: value.state,
						event: value.event,
					}
				: undefined;
		case "mutation":
			return typeof value.mutationKey === "string" &&
				typeof value.status === "string"
				? {
						kind: "mutation",
						mutationKey: value.mutationKey,
						status: value.status,
					}
				: undefined;
		case "manual":
			return typeof value.label === "string"
				? "data" in value
					? { kind: "manual", label: value.label, data: value.data }
					: { kind: "manual", label: value.label }
				: undefined;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// parseMark
// ---------------------------------------------------------------------------

/** Structural validate one wire entry into a real branded Mark, or undefined. */
export function parseMark(value: unknown): Mark | undefined {
	if (!isRecord(value)) return undefined;
	const { kind } = value;
	if (typeof kind !== "string") return undefined;
	if (typeof value.seq !== "number" || !Number.isFinite(value.seq))
		return undefined;
	if (typeof value.at !== "number" || !Number.isFinite(value.at))
		return undefined;
	if (typeof value.intent !== "string" || value.intent.length === 0)
		return undefined;
	if (typeof value.attempt !== "string" || value.attempt.length === 0)
		return undefined;

	const seq = asSeq(value.seq);
	const at = value.at;
	const intent = asIntentName(value.intent);
	const attempt = asAttemptId(value.attempt);
	const origin = parseOrigin(value.origin);
	const originFields = origin !== undefined ? { origin } : {};

	switch (kind) {
		case "begun": {
			const key = optionalString(value.key);
			const parent = optionalAttemptId(value.parent);
			const retryOf = optionalAttemptId(value.retryOf);
			const mark: Mark = {
				kind: "begun",
				seq,
				at,
				intent,
				attempt,
				payload: value.payload,
				...(key !== undefined ? { key } : {}),
				...(parent !== undefined ? { parent } : {}),
				...(retryOf !== undefined ? { retryOf } : {}),
				...originFields,
			};
			return Object.freeze(mark);
		}
		case "noted": {
			const mark: Mark = {
				kind: "noted",
				seq,
				at,
				intent,
				attempt,
				data: value.data,
				...originFields,
			};
			return Object.freeze(mark);
		}
		case "fulfilled": {
			const mark: Mark = {
				kind: "fulfilled",
				seq,
				at,
				intent,
				attempt,
				outcome: value.outcome,
				...originFields,
			};
			return Object.freeze(mark);
		}
		case "rejected": {
			const mark: Mark = {
				kind: "rejected",
				seq,
				at,
				intent,
				attempt,
				reason: value.reason,
				...originFields,
			};
			return Object.freeze(mark);
		}
		case "abandoned": {
			const abandon = parseAbandon(value.abandon);
			if (abandon === undefined) return undefined;
			const mark: Mark = {
				kind: "abandoned",
				seq,
				at,
				intent,
				attempt,
				abandon,
				...originFields,
			};
			return Object.freeze(mark);
		}
		case "linked": {
			const ref = parseRef(value.ref);
			if (ref === undefined) return undefined;
			const mark: Mark = {
				kind: "linked",
				seq,
				at,
				intent,
				attempt,
				ref,
				...originFields,
			};
			return Object.freeze(mark);
		}
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Versioned wire envelope. Parsing rejects unknown versions (drop > misread). */
export type WireEnvelope = {
	readonly v: 1;
	readonly marks: readonly Mark[];
};

/** JSON, versioned envelope `{ v: 1, marks }`. */
export function serializeMarks(marks: readonly Mark[]): string {
	const envelope: WireEnvelope = { v: 1, marks };
	return JSON.stringify(envelope);
}

/** Tolerant: skips invalid entries, returns [] on garbage or unknown versions. */
export function parseWirePayload(json: string): readonly Mark[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	if (parsed.v !== 1) return [];
	if (!Array.isArray(parsed.marks)) return [];
	const marks: Mark[] = [];
	for (const raw of parsed.marks) {
		const mark = parseMark(raw);
		if (mark !== undefined) marks.push(mark);
	}
	return marks;
}
