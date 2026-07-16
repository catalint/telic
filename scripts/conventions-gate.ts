#!/usr/bin/env bun
/**
 * conventions-gate — mechanical enforcement of telic's non-negotiable
 * conventions, so the whole-repo review pass never has to catch them by hand
 * again. Scans packages/{*}/src (excluding *.test.ts) plus one project-level
 * parity check. Exit 0 = clean, 1 = violations (printed file:line rule).
 *
 * Only CLEANLY-GREPPABLE classes live here. Semantic rules that need judgement
 * (prototype-key lookups — D27, once-key ordering)
 * are NOT greppable without false positives; they live in
 * .github/copilot-instructions.md and the SPEC instead. Adding a noisy grep for
 * them would train maintainers to ignore this gate — the exact failure mode
 * telic's diagnostics philosophy warns against.
 *
 * Zero npm deps: node:fs + node:path only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { budgets } from "../packages/core/scripts/size-gate.ts";

type Violation = {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
	readonly detail: string;
};

const repoRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir: string = join(repoRoot, "packages");

/** Recursively collect non-test .ts files under a directory. */
function collectSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...collectSourceFiles(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

const INITIATIVE_TOKENS =
	/\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(|\bnew\s+(?:WebSocket|EventSource)\b|\bXMLHttpRequest\b/;
const IMPORT_FROM = /(?:^|\s)(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/;
const MODULE_SCOPE_DECL = /^(?:export\s+)?(?:const|let|var)\s/;
const BROWSER_GLOBAL = /\b(?:window|document|navigator|localStorage|sessionStorage)\b/;

/** All per-file, per-line rules. Each returns the violations for one file. */
function checkFile(file: string, isCore: boolean): Violation[] {
	const rel = relative(repoRoot, file);
	const violations: Violation[] = [];
	const lines = readFileSync(file, "utf8").split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const at = index + 1;

		if (INITIATIVE_TOKENS.test(line)) {
			violations.push({
				file: rel,
				line: at,
				rule: "initiative-boundary",
				detail:
					"telic never owns time or transport — no timer/socket/XHR initiated by the library (caller-owned AbortSignals are the sanctioned deadline)",
			});
		}

		const fromMatch = IMPORT_FROM.exec(line) ?? SIDE_EFFECT_IMPORT.exec(line);
		if (fromMatch !== null) {
			const specifier = fromMatch[1] ?? "";
			const isRelative = specifier.startsWith(".");
			if (isRelative && !specifier.endsWith(".js") && !specifier.endsWith(".json")) {
				violations.push({
					file: rel,
					line: at,
					rule: "js-extension-imports",
					detail: `relative import "${specifier}" must carry an explicit .js extension (node16 emit)`,
				});
			}
			if (isCore && !isRelative && !specifier.startsWith("node:")) {
				violations.push({
					file: rel,
					line: at,
					rule: "zero-dep-core",
					detail: `@telic/core src must not import the npm package "${specifier}" — vendor integrations are structural types only`,
				});
			}
		}

		if (MODULE_SCOPE_DECL.test(line)) {
			const eq = line.indexOf("=");
			const rhs = eq >= 0 ? line.slice(eq + 1) : "";
			if (BROWSER_GLOBAL.test(rhs)) {
				violations.push({
					file: rel,
					line: at,
					rule: "ssr-module-scope",
					detail:
						"no window/document/navigator/storage access at module scope — feature-detect at call time so SSR stays safe",
				});
			}
		}
	}
	return violations;
}

/** Reads one property off an unknown value without casting (mirrors lint/config.ts). */
function readProp(value: unknown, key: string): unknown {
	if (typeof value === "object" && value !== null) return Reflect.get(value, key);
	return undefined;
}

/** Project-level: core's package.json `exports` subpaths must match the size-gate budget entries exactly. */
function checkExportsBudgetParity(): Violation[] {
	const pkgPath = join(packagesDir, "core", "package.json");
	const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
	const exportsField = readProp(parsed, "exports");
	const exportKeys =
		typeof exportsField === "object" && exportsField !== null
			? Object.keys(exportsField).filter((key) => key !== "./package.json")
			: [];
	const budgetKeys = budgets.map((budget) => budget.entry);
	const exportSet = new Set(exportKeys);
	const budgetSet = new Set(budgetKeys);

	const violations: Violation[] = [];
	for (const key of exportKeys) {
		if (!budgetSet.has(key)) {
			violations.push({
				file: "packages/core/scripts/size-gate.ts",
				line: 0,
				rule: "exports-budget-parity",
				detail: `exports subpath "${key}" has no size budget — every published subpath needs a brotli budget`,
			});
		}
	}
	for (const key of budgetKeys) {
		if (!exportSet.has(key)) {
			violations.push({
				file: "packages/core/package.json",
				line: 0,
				rule: "exports-budget-parity",
				detail: `size budget "${key}" has no matching exports subpath (stale budget entry)`,
			});
		}
	}
	return violations;
}

function main(): void {
	const violations: Violation[] = [];
	for (const pkg of readdirSync(packagesDir)) {
		const srcDir = join(packagesDir, pkg, "src");
		let isDir = false;
		try {
			isDir = statSync(srcDir).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) continue;
		const isCore = pkg === "core";
		for (const file of collectSourceFiles(srcDir)) {
			violations.push(...checkFile(file, isCore));
		}
	}
	violations.push(...checkExportsBudgetParity());

	if (violations.length === 0) {
		process.stdout.write("conventions gate passed\n");
		return;
	}
	process.stdout.write(`conventions gate FAILED — ${violations.length} violation(s):\n\n`);
	for (const violation of violations) {
		const at = violation.line > 0 ? `:${violation.line}` : "";
		process.stdout.write(`  ${violation.file}${at}\n    [${violation.rule}] ${violation.detail}\n`);
	}
	process.exit(1);
}

main();
