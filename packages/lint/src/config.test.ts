import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverConfig, parseConfig } from "./config.js";

const cliProject = join(import.meta.dir, "..", "fixtures", "cli-project");

describe("parseConfig", () => {
	it("accepts an empty object", () => {
		const result = parseConfig({});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.config).toEqual({});
	});

	it("accepts a full config", () => {
		const result = parseConfig({
			scopes: { checkout: ["src/checkout/**"] },
			requireScopeOwnership: true,
			deadContract: true,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.scopes).toEqual({ checkout: ["src/checkout/**"] });
			expect(result.config.requireScopeOwnership).toBe(true);
			expect(result.config.deadContract).toBe(true);
		}
	});

	it("rejects a non-object", () => {
		expect(parseConfig([]).ok).toBe(false);
		expect(parseConfig(42).ok).toBe(false);
		expect(parseConfig(null).ok).toBe(false);
	});

	it("rejects scopes that are not an object", () => {
		expect(parseConfig({ scopes: ["a"] }).ok).toBe(false);
	});

	it("rejects a scope whose value is not a string array", () => {
		expect(parseConfig({ scopes: { checkout: [1, 2] } }).ok).toBe(false);
		expect(parseConfig({ scopes: { checkout: "src/**" } }).ok).toBe(false);
	});

	it("rejects non-boolean flags", () => {
		expect(parseConfig({ requireScopeOwnership: "yes" }).ok).toBe(false);
		expect(parseConfig({ deadContract: 1 }).ok).toBe(false);
	});
});

describe("discoverConfig", () => {
	it("loads an explicit --config path", () => {
		const result = discoverConfig(process.cwd(), join(cliProject, "telic.config.json"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config.deadContract).toBe(true);
			expect(result.configDir).toBe(cliProject);
		}
	});

	it("errors on a missing explicit path", () => {
		const result = discoverConfig(process.cwd(), join(cliProject, "nope.json"));
		expect(result.ok).toBe(false);
	});

	it("discovers upward from a nested cwd", () => {
		const nested = join(cliProject, "src", "checkout");
		const result = discoverConfig(nested);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.configPath).toBe(join(cliProject, "telic.config.json"));
			expect(result.configDir).toBe(cliProject);
		}
	});

	it("returns zero-config when nothing is found", () => {
		const empty = mkdtempSync(join(tmpdir(), "telic-lint-"));
		const result = discoverConfig(empty);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.config).toEqual({});
			expect(result.configPath).toBeUndefined();
			expect(result.configDir).toBe(empty);
		}
	});
});
