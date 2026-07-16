import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "./scan.js";
import type { Finding, LintConfig, RuleName, SourceInput } from "./types.js";

const fixturesDir = join(import.meta.dir, "..", "fixtures");

function fixture(name: string): SourceInput {
	return { fileName: name, sourceText: readFileSync(join(fixturesDir, name), "utf8") };
}

function names(findings: readonly Finding[], rule: RuleName): string[] {
	return findings
		.filter((finding) => finding.rule === rule)
		.map((finding) => finding.name)
		.sort();
}

const NO_CONFIG: LintConfig = {};

describe("setter-like-name (L2.1)", () => {
	it("flags intent/command/handle setters but not dispatch or clean names", () => {
		const findings = scan([fixture("setters.ts")], NO_CONFIG, fixturesDir);
		expect(names(findings, "setter-like-name")).toEqual([
			"account.changePassword",
			"checkout.setEmail",
			"prefs.toggleDarkMode",
			"settings.updateTheme",
		]);
	});

	it("flags setter names reached through aliases and namespaces", () => {
		const findings = scan([fixture("aliased.ts")], NO_CONFIG, fixturesDir);
		expect(names(findings, "setter-like-name")).toEqual([
			"checkout.setAddress",
			"checkout.updateCart",
		]);
	});
});

describe("duplicate-intent-name (L2.2)", () => {
	it("flags a name declared via intent() in more than one file, once per extra file", () => {
		const findings = scan(
			[fixture("duplicate-a.ts"), fixture("duplicate-b.ts")],
			NO_CONFIG,
			fixturesDir,
		);
		const dupes = findings.filter((finding) => finding.rule === "duplicate-intent-name");
		expect(dupes).toHaveLength(1);
		expect(dupes[0]?.name).toBe("billing.renewDomain");
		expect(dupes[0]?.file).toBe("duplicate-b.ts"); // canonical (sorted-first) is duplicate-a.ts
	});

	it("does not flag a single-file declaration", () => {
		const findings = scan([fixture("duplicate-a.ts")], NO_CONFIG, fixturesDir);
		expect(names(findings, "duplicate-intent-name")).toEqual([]);
	});
});

describe("dead-contract (L2.4, opt-in)", () => {
	it("is silent when deadContract is off", () => {
		const findings = scan([fixture("dead-contract.ts")], NO_CONFIG, fixturesDir);
		expect(names(findings, "dead-contract")).toEqual([]);
	});

	it("flags an unhandled command and an unused handler when enabled", () => {
		const findings = scan([fixture("dead-contract.ts")], { deadContract: true }, fixturesDir);
		const dead = findings.filter((finding) => finding.rule === "dead-contract");
		expect(dead.map((finding) => finding.name).sort()).toEqual(["ops.cleanup", "ops.reindex"]);
		expect(dead.every((finding) => finding.severity === "warning")).toBe(true);
	});
});

describe("eligibility inside a scan", () => {
	it("contributes nothing from a non-telic file", () => {
		const findings = scan([fixture("non-telic.ts")], { deadContract: true }, fixturesDir);
		expect(findings).toEqual([]);
	});
});

describe("determinism", () => {
	it("orders findings by file then line regardless of input order", () => {
		const forward = scan([fixture("aliased.ts"), fixture("setters.ts")], NO_CONFIG, fixturesDir);
		const reversed = scan([fixture("setters.ts"), fixture("aliased.ts")], NO_CONFIG, fixturesDir);
		expect(forward).toEqual(reversed);
		const expected = [...forward].sort((left, right) =>
			left.file !== right.file
				? left.file < right.file
					? -1
					: 1
				: left.line - right.line,
		);
		expect(forward).toEqual(expected);
		expect(forward[0]?.file).toBe("aliased.ts");
	});
});
