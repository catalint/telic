import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCalls } from "./extract.js";
import type { TelicFn } from "./types.js";

const fixturesDir = join(import.meta.dir, "..", "fixtures");

function readFixture(name: string): string {
	return readFileSync(join(fixturesDir, name), "utf8");
}

describe("extractCalls — eligibility (L3.1)", () => {
	it("extracts calls when the file imports from a telic specifier", () => {
		const calls = extractCalls("a.ts", `import { intent } from "@telic/core";\nintent("checkout.pay");`);
		expect(calls).toEqual([{ fn: "intent", name: "checkout.pay", file: "a.ts", line: 2 }]);
	});

	it("skips the whole file when no import specifier contains 'telic'", () => {
		const source = `import { handle } from "./local-bus";\nhandle("orders.setStatus", async () => ({ ok: true }));`;
		expect(extractCalls("a.ts", source)).toEqual([]);
	});

	it("skips the real non-telic fixture entirely", () => {
		expect(extractCalls("non-telic.ts", readFixture("non-telic.ts"))).toEqual([]);
	});

	it("does not become eligible from a TYPE-ONLY telic import", () => {
		const source = `import type { IntentName } from "@telic/core";\nhandle("orders.setStatus");`;
		expect(extractCalls("a.ts", source)).toEqual([]);
	});

	it("skips the real type-only fixture entirely", () => {
		expect(extractCalls("type-only.ts", readFixture("type-only.ts"))).toEqual([]);
	});

	it("does not become eligible from a side-effect-only telic import", () => {
		const source = `import "@telic/core";\nintent("checkout.setEmail");`;
		expect(extractCalls("a.ts", source)).toEqual([]);
	});

	it("stays eligible when a value binding sits beside an inline type import", () => {
		const source = `import { intent, type IntentName } from "@telic/core";\nintent("checkout.pay");`;
		expect(extractCalls("a.ts", source)).toEqual([
			{ fn: "intent", name: "checkout.pay", file: "a.ts", line: 2 },
		]);
	});
});

describe("extractCalls — callee resolution", () => {
	it("resolves aliased named imports to their canonical function", () => {
		const source = `import { intent as track } from "@telic/x";\ntrack("checkout.updateCart");`;
		const calls = extractCalls("a.ts", source);
		expect(calls).toEqual([{ fn: "intent", name: "checkout.updateCart", file: "a.ts", line: 2 }]);
	});

	it("resolves namespace member calls from a telic namespace", () => {
		const source = `import * as telic from "@telic/core";\ntelic.command("checkout.setAddress");`;
		const calls = extractCalls("a.ts", source);
		expect(calls).toEqual([{ fn: "command", name: "checkout.setAddress", file: "a.ts", line: 2 }]);
	});

	it("counts a bare canonical name in an eligible file", () => {
		const source = `import { intent } from "@telic/core";\nhandle("checkout.pay", async () => ({ ok: true }));`;
		const calls = extractCalls("a.ts", source);
		expect(calls).toEqual([{ fn: "handle", name: "checkout.pay", file: "a.ts", line: 2 }]);
	});

	it("counts aliases whose import comes from a non-telic module (file still telic-eligible)", () => {
		const source = `import { intent } from "@telic/core";\nimport { handle as on } from "./bus";\non("checkout.pay", async () => ({ ok: true }));`;
		const calls = extractCalls("a.ts", source);
		expect(calls).toEqual([{ fn: "handle", name: "checkout.pay", file: "a.ts", line: 3 }]);
	});
});

describe("extractCalls — first-argument literal (L3.1)", () => {
	it("ignores a call whose first arg is not a static string", () => {
		const source = `import { intent } from "@telic/core";\nconst n = "checkout.pay";\nintent(n);`;
		expect(extractCalls("a.ts", source)).toEqual([]);
	});

	it("ignores an interpolated template literal", () => {
		const source = "import { intent } from \"@telic/core\";\nconst x = 1;\nintent(`checkout.${x}`);";
		expect(extractCalls("a.ts", source)).toEqual([]);
	});

	it("accepts a no-substitution template literal", () => {
		const source = "import { intent } from \"@telic/core\";\nintent(`checkout.pay`);";
		const calls = extractCalls("a.ts", source);
		expect(calls).toEqual([{ fn: "intent", name: "checkout.pay", file: "a.ts", line: 2 }]);
	});
});

describe("extractCalls — real fixtures", () => {
	it("finds all four call kinds in setters.ts", () => {
		const calls = extractCalls("setters.ts", readFixture("setters.ts"));
		const byFn = calls.map((call): TelicFn => call.fn);
		expect(byFn).toEqual(["intent", "intent", "command", "handle", "intent", "dispatch"]);
		expect(calls.map((call) => call.name)).toContain("checkout.setCoupon");
	});

	it("resolves aliases and namespace calls in aliased.ts", () => {
		const calls = extractCalls("aliased.ts", readFixture("aliased.ts"));
		expect(calls).toEqual([
			{ fn: "intent", name: "checkout.updateCart", file: "aliased.ts", line: 5 },
			{ fn: "handle", name: "checkout.applyCoupon", file: "aliased.ts", line: 6 },
			{ fn: "command", name: "checkout.setAddress", file: "aliased.ts", line: 7 },
		]);
	});
});
