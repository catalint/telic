/**
 * Analytics tap — the mechanical replacement for hand-rolled "fired-once" sets
 * and consent gates around product analytics (S17).
 *
 * Rules match on `(pattern, kind)` with an optional `when` guard. `map` turns a
 * mark into a vendor-agnostic `AnalyticsEvent` for `send`; `emit` is the
 * side-effect escape hatch (identify calls, deduped pixels). Both run under the
 * SAME once/consent gate. Consent-denied actions either drop or buffer (FIFO,
 * capped) and replay via `recheck()`. Structural injection only; zero deps;
 * SSR-safe (no module-scope environment access).
 */

import { type CompiledPattern, compilePattern, matchesPattern } from "../pattern.js";
import type { AttemptView, IntentPattern, Mark, MarkKind, Tap } from "../types.js";

/** Vendor-agnostic analytics event produced by a rule's `map`. */
export type AnalyticsEvent = {
	readonly name: string;
	readonly props?: Record<string, string | number | boolean>;
};

/** Persistence for per-intent once-keys (localStorage, a cookie, …). */
export type AnalyticsDedupe = {
	load(): readonly string[];
	save(keys: readonly string[]): void;
};

/** How aggressively a rule dedupes itself. Default `"off"`. */
export type AnalyticsOnce = "per-intent" | "per-attempt" | "off";

export type AnalyticsRule = {
	/** Intent pattern: exact, `scope.*`, or `*`. */
	readonly on: IntentPattern;
	readonly kind: MarkKind;
	/** Guard; a false result skips the rule WITHOUT consuming its once-key. */
	readonly when?: (mark: Mark, view: AttemptView | undefined) => boolean;
	readonly once?: AnalyticsOnce;
	/** Overrides the derived once-key (`<on>|<kind>`); used verbatim. */
	readonly onceKey?: string;
	/** Produces the event for `send`; `undefined` means "no event this mark". */
	readonly map?: (mark: Mark, view: AttemptView | undefined) => AnalyticsEvent | undefined;
	/** Vendor side-effect, gated identically to `map`. */
	readonly emit?: (mark: Mark, view: AttemptView | undefined) => void;
};

/** What the tap decided to do with a matching (rule, mark) pair (S17.7). */
export type AnalyticsTraceAction =
	| "sent"
	| "emitted"
	| "deduped"
	| "denied"
	| "buffered"
	| "flushed"
	| "skipped-when";

/** One rule/mark decision record for the parity trace hook (S17.7). */
export type AnalyticsTraceEvent = {
	readonly mark: Mark;
	/** Index into `opts.rules` of the rule this decision belongs to. */
	readonly ruleIndex: number;
	readonly action: AnalyticsTraceAction;
};

export type AnalyticsTapOptions = {
	readonly send: (event: AnalyticsEvent) => void;
	/** Consent gate, evaluated per matching mark. */
	readonly consent: () => boolean;
	/** What to do while consent is denied. Default `"drop"`. */
	readonly whileDenied?: "drop" | "buffer";
	readonly rules: readonly AnalyticsRule[];
	readonly dedupe?: AnalyticsDedupe;
	/** Called for every rule/mark decision (S17.7) — the CI-assertable migration-parity record. Zero cost when absent. */
	readonly trace?: (event: AnalyticsTraceEvent) => void;
};

/** A once-key plus whether it is persistable (per-intent keys are). */
type OnceKey = {
	readonly key: string | undefined;
	readonly persist: boolean;
};

/** A resolved-but-not-yet-fired action (used both live and while buffered). */
type ResolvedAction = {
	readonly event: AnalyticsEvent | undefined;
	readonly runEmit: (() => void) | undefined;
	readonly key: string | undefined;
	readonly persist: boolean;
	/** Carried so buffered actions stay traceable at flush time (S17.7). */
	readonly mark: Mark;
	readonly ruleIndex: number;
};

const BUFFER_CAP = 50;

export function createAnalyticsTap(opts: AnalyticsTapOptions): Tap & { recheck(): void } {
	const { send, consent, rules, dedupe, trace } = opts;
	const whileDenied: "drop" | "buffer" = opts.whileDenied ?? "drop";

	for (const rule of rules) {
		if (rule.map === undefined && rule.emit === undefined) {
			throw new TypeError(`analytics rule for "${rule.on}" (${rule.kind}) needs map or emit`);
		}
	}

	const compiledRules: readonly {
		readonly rule: AnalyticsRule;
		readonly pattern: CompiledPattern;
	}[] = rules.map((rule) => ({ rule, pattern: compilePattern(rule.on) }));

	// Every consumed key (per-intent + per-attempt) gates re-firing; only the
	// per-intent subset is persisted, seeded once from the dedupe adapter.
	const consumed = new Set<string>();
	const persistedKeys = new Set<string>();
	for (const key of dedupe?.load() ?? []) {
		consumed.add(key);
		persistedKeys.add(key);
	}

	const buffer: ResolvedAction[] = [];

	function consume(key: string, persist: boolean): void {
		consumed.add(key);
		if (!persist) return;
		persistedKeys.add(key);
		dedupe?.save([...persistedKeys]);
	}

	function fire(action: ResolvedAction): void {
		if (action.event !== undefined) send(action.event);
		if (action.runEmit !== undefined) action.runEmit();
		if (action.key !== undefined) consume(action.key, action.persist);
	}

	function enqueue(action: ResolvedAction): void {
		if (buffer.length >= BUFFER_CAP) buffer.shift();
		buffer.push(action);
	}

	function onMark(mark: Mark, view: AttemptView | undefined): void {
		let consentState: boolean | undefined;
		const granted = (): boolean => {
			if (consentState === undefined) consentState = consent();
			return consentState;
		};

		for (const [ruleIndex, { rule, pattern }] of compiledRules.entries()) {
			if (rule.kind !== mark.kind) continue;
			if (!matchesPattern(pattern, mark.intent)) continue;
			if (rule.when !== undefined && !rule.when(mark, view)) {
				trace?.({ mark, ruleIndex, action: "skipped-when" });
				continue;
			}

			const { key, persist } = onceKeyFor(rule, mark);
			if (key !== undefined && consumed.has(key)) {
				trace?.({ mark, ruleIndex, action: "deduped" });
				continue;
			}

			const allowed = granted();
			if (!allowed && whileDenied !== "buffer") {
				trace?.({ mark, ruleIndex, action: "denied" });
				continue;
			}

			const event = rule.map !== undefined ? rule.map(mark, view) : undefined;
			if (event === undefined && rule.emit === undefined) continue;

			const action = resolveAction(rule, mark, view, event, key, persist, ruleIndex);
			if (allowed) {
				fire(action);
				trace?.({ mark, ruleIndex, action: event !== undefined ? "sent" : "emitted" });
			} else {
				enqueue(action);
				trace?.({ mark, ruleIndex, action: "buffered" });
			}
		}
	}

	function recheck(): void {
		if (!consent()) return;
		const pending = buffer.splice(0, buffer.length);
		for (const action of pending) {
			if (action.key !== undefined && consumed.has(action.key)) {
				// A live mark consumed the key meanwhile — the stale action is a dedupe (S17.4/S17.7).
				trace?.({ mark: action.mark, ruleIndex: action.ruleIndex, action: "deduped" });
				continue;
			}
			fire(action);
			trace?.({ mark: action.mark, ruleIndex: action.ruleIndex, action: "flushed" });
		}
	}

	return { id: "analytics", onMark, recheck };
}

function onceKeyFor(rule: AnalyticsRule, mark: Mark): OnceKey {
	const once: AnalyticsOnce = rule.once ?? "off";
	if (once === "off") return { key: undefined, persist: false };
	const base = rule.onceKey ?? `${rule.on}|${rule.kind}`;
	if (once === "per-intent") return { key: base, persist: true };
	return { key: `${base}|${mark.attempt}`, persist: false };
}

function resolveAction(
	rule: AnalyticsRule,
	mark: Mark,
	view: AttemptView | undefined,
	event: AnalyticsEvent | undefined,
	key: string | undefined,
	persist: boolean,
	ruleIndex: number,
): ResolvedAction {
	const emitFn = rule.emit;
	const runEmit: (() => void) | undefined =
		emitFn !== undefined
			? (): void => {
					emitFn(mark, view);
				}
			: undefined;
	return { event, runEmit, key, persist, mark, ruleIndex };
}
