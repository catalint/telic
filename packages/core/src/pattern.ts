/**
 * Intent-name pattern matching (SPEC S8): exact, "scope.*", "*".
 * No regex; O(1) per check after compile.
 */
import type { IntentName, IntentPattern } from "./types";

export type CompiledPattern =
	| { readonly kind: "all" }
	| { readonly kind: "scope"; readonly prefix: string }
	| { readonly kind: "exact"; readonly name: string };

export function compilePattern(pattern: IntentPattern): CompiledPattern {
	if (pattern === "*") return { kind: "all" };
	if (pattern.endsWith(".*")) return { kind: "scope", prefix: `${pattern.slice(0, -1)}` };
	return { kind: "exact", name: pattern };
}

export function matchesPattern(compiled: CompiledPattern, name: IntentName): boolean {
	switch (compiled.kind) {
		case "all":
			return true;
		case "scope":
			return name.startsWith(compiled.prefix) && name.length > compiled.prefix.length;
		case "exact":
			return name === compiled.name;
	}
}

/** First segment of a pattern for listener bucketing; null for "*". */
export function bucketOf(pattern: IntentPattern): string | null {
	if (pattern === "*") return null;
	const dot = pattern.indexOf(".");
	return dot === -1 ? pattern : pattern.slice(0, dot);
}

/** First segment of an intent name. */
export function scopeOf(name: IntentName): string {
	const dot = name.indexOf(".");
	return dot === -1 ? name : name.slice(0, dot);
}
