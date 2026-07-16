import { describe, expect, it } from "bun:test";
import { bucketOf, compilePattern, matchesPattern, scopeOf } from "./pattern.js";
import type { IntentName, IntentPattern } from "./types.js";

describe("compilePattern (S8.2)", () => {
	it('given "*", when compiled, then yields kind "all"', () => {
		expect(compilePattern("*")).toEqual({ kind: "all" });
	});

	it('given a scope pattern "billing.*", when compiled, then yields kind "scope" with the dotted prefix', () => {
		expect(compilePattern("billing.*")).toEqual({ kind: "scope", prefix: "billing." });
	});

	it('given an exact pattern "billing.renewDomain", when compiled, then yields kind "exact" with the full name', () => {
		expect(compilePattern("billing.renewDomain")).toEqual({
			kind: "exact",
			name: "billing.renewDomain",
		});
	});
});

describe("matchesPattern — exact (S8.1)", () => {
	it("given an exact pattern, when matched against the same name, then it matches", () => {
		const compiled = compilePattern("billing.renewDomain");
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
	});

	it("given an exact pattern, when matched against a different name, then it does not match", () => {
		const compiled = compilePattern("billing.renewDomain");
		expect(matchesPattern(compiled, "billing.cancelSubscription")).toBe(false);
	});

	it("given an exact pattern, when matched case-differently, then it does not match (S8.3 case-sensitive)", () => {
		const compiled = compilePattern("billing.renewDomain");
		expect(matchesPattern(compiled, "billing.RenewDomain")).toBe(false);
	});

	it("given an exact pattern with multiple dots, when matched against that exact name, then it matches", () => {
		const compiled = compilePattern("a.b.c");
		expect(matchesPattern(compiled, "a.b.c")).toBe(true);
	});

	it("given an exact pattern, when matched against a name that merely extends it, then it does not match", () => {
		const compiled = compilePattern("billing.renewDomain");
		expect(matchesPattern(compiled, "billing.renewDomainExtra")).toBe(false);
	});
});

describe("matchesPattern — scope wildcard (S8.1)", () => {
	it('given "a.*", when matched against "a.b", then it matches', () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "a.b")).toBe(true);
	});

	it('given "a.*", when matched against "a.b.c" (any depth after the dot), then it matches', () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "a.b.c")).toBe(true);
	});

	it('given "a.*", when matched against the bare scope name with no dot, then it does not match', () => {
		const compiled = compilePattern("a.*");
		// S1.2: `<scope>.<rest>` shape is enforced by the type system, not the runtime — this
		// exercises matchesPattern's own length guard against a dot-less name.
		// @ts-expect-error — intentionally violates the IntentName shape to test the runtime guard
		const bareName: IntentName = "a";
		expect(matchesPattern(compiled, bareName)).toBe(false);
	});

	it('given "a.*", when matched against "a." (empty segment after the dot), then it does not match', () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "a.")).toBe(false);
	});

	it('given "a.*", when matched against "ab.c" (different scope sharing a prefix letter), then it does not match', () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "ab.c")).toBe(false);
	});

	it('given "a.*", when matched against "b.a" (scope segment in the wrong position), then it does not match', () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "b.a")).toBe(false);
	});

	it("given a scope pattern, when matched case-differently, then it does not match (S8.3 case-sensitive)", () => {
		const compiled = compilePattern("a.*");
		expect(matchesPattern(compiled, "A.b")).toBe(false);
	});

	it('given "billing.*", when matched against names at multiple depths under the scope, then it matches all of them', () => {
		const compiled = compilePattern("billing.*");
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
		expect(matchesPattern(compiled, "billing.renewDomain.subStep")).toBe(true);
	});
});

describe('matchesPattern — "*" (S8.1)', () => {
	it('given "*", when matched against any name, then it matches', () => {
		const compiled = compilePattern("*");
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
		expect(matchesPattern(compiled, "a.b.c")).toBe(true);
		expect(matchesPattern(compiled, "z.z")).toBe(true);
	});
});

describe("compile→match round-trip (S8.2)", () => {
	it("given an exact pattern, when compiled and matched, then only the exact name round-trips", () => {
		const pattern: IntentPattern = "billing.renewDomain";
		const compiled = compilePattern(pattern);
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
		expect(matchesPattern(compiled, "billing.cancelSubscription")).toBe(false);
	});

	it("given a scope pattern, when compiled and matched, then every name under the scope round-trips", () => {
		const pattern: IntentPattern = "billing.*";
		const compiled = compilePattern(pattern);
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
		expect(matchesPattern(compiled, "billing.renewDomain.subStep")).toBe(true);
		expect(matchesPattern(compiled, "shipping.trackOrder")).toBe(false);
	});

	it('given the "*" pattern, when compiled and matched, then every name round-trips', () => {
		const pattern: IntentPattern = "*";
		const compiled = compilePattern(pattern);
		expect(matchesPattern(compiled, "billing.renewDomain")).toBe(true);
		expect(matchesPattern(compiled, "shipping.trackOrder")).toBe(true);
	});
});

describe("bucketOf (S8.2)", () => {
	it('given "*", when bucketed, then yields null', () => {
		expect(bucketOf("*")).toBeNull();
	});

	it('given a scope pattern "billing.*", when bucketed, then yields the scope segment', () => {
		expect(bucketOf("billing.*")).toBe("billing");
	});

	it('given an exact pattern "billing.renewDomain", when bucketed, then yields the scope segment', () => {
		expect(bucketOf("billing.renewDomain")).toBe("billing");
	});

	it("given an exact pattern with multiple dots, when bucketed, then yields only the first segment", () => {
		expect(bucketOf("a.b.c")).toBe("a");
	});
});

describe("scopeOf (S8.2)", () => {
	it('given "billing.renewDomain", when scoped, then yields "billing"', () => {
		expect(scopeOf("billing.renewDomain")).toBe("billing");
	});

	it("given a name with multiple dots, when scoped, then yields only the first segment", () => {
		expect(scopeOf("a.b.c")).toBe("a");
	});
});
