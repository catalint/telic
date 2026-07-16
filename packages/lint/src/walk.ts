import { type Dirent, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { matchAnyGlob } from "./glob.js";

// Always excluded regardless of globs (L1.1).
const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);
const DEFAULT_GLOBS: readonly string[] = ["**/*.{ts,tsx}"];

function isLintableFile(fileName: string): boolean {
	if (fileName.endsWith(".d.ts")) return false;
	return fileName.endsWith(".ts") || fileName.endsWith(".tsx");
}

function readEntries(dir: string): Dirent<string>[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function walkInto(root: string, dir: string, patterns: readonly string[], out: string[]): void {
	for (const entry of readEntries(dir)) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
			walkInto(root, full, patterns, out);
		} else if (entry.isFile()) {
			if (!isLintableFile(entry.name)) continue;
			const relPath = relative(root, full);
			if (matchAnyGlob(patterns, relPath)) out.push(full);
		}
	}
}

// Collect absolute paths of source files under cwd matching the given globs
// (relative to cwd), defaulting to **/*.{ts,tsx}. Deterministically sorted.
export function collectSourceFiles(cwd: string, globs: readonly string[]): string[] {
	const patterns = globs.length > 0 ? globs : DEFAULT_GLOBS;
	const out: string[] = [];
	walkInto(cwd, cwd, patterns, out);
	out.sort();
	return out;
}
