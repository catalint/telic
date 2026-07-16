import { describe, expect, it } from "bun:test";
import { matchAnyGlob, matchGlob, resolveGlob } from "./glob.js";

describe("matchGlob — * within a segment", () => {
	it("matches a wildcard extension", () => {
		expect(matchGlob("*.ts", "order.ts")).toBe(true);
	});

	it("does not let * cross a path separator", () => {
		expect(matchGlob("*.ts", "checkout/order.ts")).toBe(false);
	});

	it("does not match a different extension", () => {
		expect(matchGlob("*.ts", "order.tsx")).toBe(false);
	});
});

describe("matchGlob — ** across segments", () => {
	it("matches any depth", () => {
		expect(matchGlob("**", "a/b/c.ts")).toBe(true);
	});

	it("matches zero segments (the directory itself)", () => {
		expect(matchGlob("packages/checkout/**", "packages/checkout")).toBe(true);
	});

	it("matches a nested file under a prefix", () => {
		expect(matchGlob("packages/checkout/**", "packages/checkout/deep/order.ts")).toBe(true);
	});

	it("does not match a sibling directory", () => {
		expect(matchGlob("packages/checkout/**", "packages/billing/invoice.ts")).toBe(false);
	});
});

describe("matchGlob — brace alternation", () => {
	it("matches both extensions in {ts,tsx}", () => {
		expect(matchGlob("**/*.{ts,tsx}", "a/b/c.ts")).toBe(true);
		expect(matchGlob("**/*.{ts,tsx}", "a/b/c.tsx")).toBe(true);
	});

	it("matches a top-level file for the default glob", () => {
		expect(matchGlob("**/*.{ts,tsx}", "index.ts")).toBe(true);
	});

	it("rejects a non-matching extension", () => {
		expect(matchGlob("**/*.{ts,tsx}", "a/b/c.json")).toBe(false);
	});
});

describe("matchAnyGlob", () => {
	it("is true when any pattern matches", () => {
		expect(matchAnyGlob(["src/**", "test/**"], "test/a.ts")).toBe(true);
	});

	it("is false when none match", () => {
		expect(matchAnyGlob(["src/**", "test/**"], "docs/a.ts")).toBe(false);
	});
});

describe("resolveGlob", () => {
	it("joins a relative glob onto an absolute base", () => {
		expect(resolveGlob("/proj", "packages/checkout/**")).toBe("/proj/packages/checkout/**");
	});

	it("strips a trailing slash on the base", () => {
		expect(resolveGlob("/proj/", "src/**")).toBe("/proj/src/**");
	});

	it("leaves an already-absolute glob untouched", () => {
		expect(resolveGlob("/proj", "/abs/src/**")).toBe("/abs/src/**");
	});

	it("resolved absolute glob matches an absolute path", () => {
		const resolved = resolveGlob("/proj", "src/checkout/**");
		expect(matchGlob(resolved, "/proj/src/checkout/order.ts")).toBe(true);
		expect(matchGlob(resolved, "/proj/src/billing/pay.ts")).toBe(false);
	});
});
