import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { JsonFinding } from "./types.js";

// Drive the CLI through its SOURCE entry (not dist) so the test carries no
// build dependency — `bun test` runs before `bun run build`.
const cliEntry = join(import.meta.dir, "cli.ts");
const cliProject = join(import.meta.dir, "..", "fixtures", "cli-project");

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function runCli(args: readonly string[], cwd: string): Promise<Run> {
	const proc = Bun.spawn(["bun", cliEntry, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

describe("telic-lint CLI", () => {
	it("emits JSON findings and exits 1 against the cli-project fixture", async () => {
		const run = await runCli(["--json"], cliProject);
		expect(run.code).toBe(1);
		const findings: JsonFinding[] = JSON.parse(run.stdout);
		const byRuleName = findings.map((finding): string => `${finding.rule}:${finding.name}`).sort();
		expect(byRuleName).toEqual([
			"dead-contract:checkout.reconcile",
			"scope-ownership:checkout.refund",
			"setter-like-name:checkout.setEmail",
		]);
		// Paths are relativized to cwd for CI-stable diffs.
		expect(findings.every((finding) => !finding.file.startsWith("/"))).toBe(true);
	});

	it("prints a human table by default", async () => {
		const run = await runCli([], cliProject);
		expect(run.code).toBe(1);
		expect(run.stdout).toContain("setter-like-name");
		expect(run.stdout).toContain("src/checkout/order.ts");
		expect(run.stdout).toContain("3 findings");
	});

	it("exits 0 when a glob matches nothing", async () => {
		const run = await runCli(["does-not-exist/**/*.ts"], cliProject);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("no findings");
	});

	it("exits 2 on a missing --config path", async () => {
		const run = await runCli(["--config", "nope.json"], cliProject);
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("config file not found");
	});

	it("prints usage and exits 0 for --help", async () => {
		const run = await runCli(["--help"], cliProject);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Usage:");
	});
});
