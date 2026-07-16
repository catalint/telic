import { describe, expect, it } from "bun:test";
import { deadContract, duplicateIntentName, scopeOwnership, setterLikeName } from "./rules.js";
import type { LintConfig, TelicCall, TelicFn } from "./types.js";

function call(fn: TelicFn, name: string, file: string, line = 1): TelicCall {
	return { fn, name, file, line };
}

describe("scopeOwnership (L2.3)", () => {
	const config: LintConfig = { scopes: { checkout: ["src/checkout/**"] } };
	const configDir = "/proj";

	it("allows a call whose file matches an owned glob", () => {
		const findings = scopeOwnership(
			[call("intent", "checkout.pay", "/proj/src/checkout/order.ts")],
			config,
			configDir,
		);
		expect(findings).toEqual([]);
	});

	it("flags a call in a configured scope whose file is outside every glob", () => {
		const findings = scopeOwnership(
			[call("intent", "checkout.pay", "/proj/src/billing/pay.ts")],
			config,
			configDir,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("scope-ownership");
		expect(findings[0]?.name).toBe("checkout.pay");
	});

	it("ignores dispatch() for scope ownership", () => {
		const findings = scopeOwnership(
			[call("dispatch", "checkout.pay", "/proj/src/billing/pay.ts")],
			config,
			configDir,
		);
		expect(findings).toEqual([]);
	});

	it("does nothing when there are no scopes and requireScopeOwnership is off", () => {
		const findings = scopeOwnership([call("intent", "checkout.pay", "/x/a.ts")], {}, "/x");
		expect(findings).toEqual([]);
	});

	it("flags an unconfigured scope when requireScopeOwnership is on", () => {
		const strict: LintConfig = { scopes: { checkout: ["src/checkout/**"] }, requireScopeOwnership: true };
		const findings = scopeOwnership(
			[
				call("intent", "checkout.pay", "/proj/src/checkout/order.ts"), // owned -> ok
				call("intent", "billing.charge", "/proj/src/billing/pay.ts"), // unconfigured scope -> flagged
			],
			strict,
			configDir,
		);
		expect(findings.map((finding) => finding.name)).toEqual(["billing.charge"]);
	});

	it("flags every scope when requireScopeOwnership is on with no scopes declared", () => {
		const findings = scopeOwnership(
			[call("handle", "new.capability", "/proj/src/x.ts")],
			{ requireScopeOwnership: true },
			configDir,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.name).toBe("new.capability");
	});

	it("treats a scope colliding with an Object.prototype key as unconfigured, never crashing", () => {
		const findings = scopeOwnership(
			[
				call("intent", "constructor.x", "/proj/src/a.ts"),
				call("handle", "toString.foo", "/proj/src/b.ts"),
			],
			config,
			configDir,
		);
		expect(findings).toEqual([]);
	});

	it("falls through to requireScopeOwnership for an Object.prototype-colliding scope", () => {
		const strict: LintConfig = { scopes: { checkout: ["src/checkout/**"] }, requireScopeOwnership: true };
		const findings = scopeOwnership(
			[call("intent", "toString.foo", "/proj/src/x.ts")],
			strict,
			configDir,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("scope-ownership");
		expect(findings[0]?.message).toContain("not declared in config.scopes");
	});

	it("treats a scope literally named after an Object.prototype key as an ordinary owned scope", () => {
		const prototypeNamedScopes: LintConfig = {
			scopes: { constructor: ["src/legacy/**"], ["__proto__"]: ["src/proto/**"] },
		};
		const findings = scopeOwnership(
			[
				call("intent", "constructor.migrate", "/proj/src/legacy/migrate.ts"),
				call("handle", "__proto__.trace", "/proj/src/proto/trace.ts"),
			],
			prototypeNamedScopes,
			configDir,
		);
		expect(findings).toEqual([]);
	});
});

describe("duplicateIntentName ordering (L2.2)", () => {
	it("treats the sorted-first file as canonical and flags each extra file once", () => {
		const findings = duplicateIntentName([
			call("intent", "billing.renew", "c.ts", 3),
			call("intent", "billing.renew", "a.ts", 1),
			call("intent", "billing.renew", "b.ts", 2),
		]);
		expect(findings.map((finding) => finding.file)).toEqual(["b.ts", "c.ts"]);
		expect(findings.every((finding) => finding.message.includes("a.ts"))).toBe(true);
	});

	it("only considers intent() declarations, not command/handle", () => {
		const findings = duplicateIntentName([
			call("command", "billing.renew", "a.ts"),
			call("handle", "billing.renew", "b.ts"),
		]);
		expect(findings).toEqual([]);
	});
});

describe("setterLikeName exclusions", () => {
	it("does not flag dispatch and does not flag names without a dot", () => {
		const findings = setterLikeName([
			call("dispatch", "checkout.setEmail", "a.ts"),
			call("intent", "setEmail", "a.ts"),
		]);
		expect(findings).toEqual([]);
	});

	it("matches the setter prefix only on the post-first-dot segment", () => {
		const findings = setterLikeName([
			call("intent", "a.b.setC", "a.ts"), // post-dot segment is "b.setC" -> not setter-like
			call("intent", "a.setC", "b.ts"), // post-dot segment is "setC" -> setter-like
		]);
		expect(findings.map((finding) => finding.name)).toEqual(["a.setC"]);
	});
});

describe("deadContract pairing", () => {
	it("does not flag a command that has a handler in another file", () => {
		const findings = deadContract(
			[call("command", "ops.run", "a.ts"), call("handle", "ops.run", "b.ts")],
			{ deadContract: true },
		);
		expect(findings).toEqual([]);
	});
});
