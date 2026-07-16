import { matchAnyGlob, resolveGlob } from "./glob.js";
import type { Finding, LintConfig, TelicCall } from "./types.js";

// Mirrors core S1.4 exactly: the segment after the FIRST dot, lowercased.
const SETTER_LIKE_PREFIXES = ["set", "update", "toggle", "change"] as const;

function postDotSegment(name: string): string | undefined {
	const dot = name.indexOf(".");
	if (dot === -1) return undefined;
	return name.slice(dot + 1);
}

function scopeOf(name: string): string {
	const dot = name.indexOf(".");
	return dot === -1 ? name : name.slice(0, dot);
}

// L2.1 — setter-like-name. Applies to intent/command/handle (not dispatch).
export function setterLikeName(calls: readonly TelicCall[]): Finding[] {
	const findings: Finding[] = [];
	for (const call of calls) {
		if (call.fn === "dispatch") continue;
		const rest = postDotSegment(call.name);
		if (rest === undefined) continue;
		const lowered = rest.toLowerCase();
		if (!SETTER_LIKE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) continue;
		findings.push({
			rule: "setter-like-name",
			file: call.file,
			line: call.line,
			name: call.name,
			severity: "error",
			message: `${call.fn}("${call.name}") reads like a setter — name it by the change the user intends, not the state you mutate (mirrors core S1.4)`,
		});
	}
	return findings;
}

// L2.2 — duplicate-intent-name. Same intent name declared via intent() in more
// than one file. One finding per extra file; the lexicographically-first file
// is treated as canonical (deterministic).
export function duplicateIntentName(calls: readonly TelicCall[]): Finding[] {
	const firstCallPerFileByName = new Map<string, Map<string, TelicCall>>();
	for (const call of calls) {
		if (call.fn !== "intent") continue;
		const perFile = firstCallPerFileByName.get(call.name) ?? new Map<string, TelicCall>();
		if (!perFile.has(call.file)) perFile.set(call.file, call);
		firstCallPerFileByName.set(call.name, perFile);
	}
	const findings: Finding[] = [];
	for (const [name, perFile] of firstCallPerFileByName) {
		const files = [...perFile.keys()].sort();
		if (files.length <= 1) continue;
		const canonical = files[0];
		if (canonical === undefined) continue;
		for (let index = 1; index < files.length; index++) {
			const file = files[index];
			if (file === undefined) continue;
			const call = perFile.get(file);
			if (call === undefined) continue;
			findings.push({
				rule: "duplicate-intent-name",
				file: call.file,
				line: call.line,
				name,
				severity: "error",
				message: `intent("${name}") is also declared in ${canonical} — cross-file duplicate declarations fragment the taxonomy; declare each intent name in exactly one file`,
			});
		}
	}
	return findings;
}

// L2.3 — scope-ownership. Applies to intent/handle/command (not dispatch).
export function scopeOwnership(
	calls: readonly TelicCall[],
	config: LintConfig,
	configDir: string,
): Finding[] {
	const scopes = config.scopes;
	const requireOwnership = config.requireScopeOwnership === true;
	if (scopes === undefined && !requireOwnership) return [];
	const findings: Finding[] = [];
	for (const call of calls) {
		if (call.fn === "dispatch") continue;
		const scope = scopeOf(call.name);
		const globs = scopes !== undefined && Object.hasOwn(scopes, scope) ? scopes[scope] : undefined;
		if (globs !== undefined) {
			const resolved = globs.map((glob) => resolveGlob(configDir, glob));
			if (matchAnyGlob(resolved, call.file)) continue;
			findings.push({
				rule: "scope-ownership",
				file: call.file,
				line: call.line,
				name: call.name,
				severity: "error",
				message: `${call.fn}("${call.name}") is in scope "${scope}" but its file matches none of that scope's owned globs [${globs.join(", ")}]`,
			});
		} else if (requireOwnership) {
			findings.push({
				rule: "scope-ownership",
				file: call.file,
				line: call.line,
				name: call.name,
				severity: "error",
				message: `${call.fn}("${call.name}") uses scope "${scope}" which is not declared in config.scopes — a new scope must be a reviewable act (requireScopeOwnership)`,
			});
		}
	}
	return findings;
}

// L2.4 — dead-contract (opt-in via config.deadContract). A command with no
// handler, or a handler with neither command nor dispatch.
export function deadContract(calls: readonly TelicCall[], config: LintConfig): Finding[] {
	if (config.deadContract !== true) return [];
	const handledNames = new Set<string>();
	const commandedNames = new Set<string>();
	const dispatchedNames = new Set<string>();
	for (const call of calls) {
		if (call.fn === "handle") handledNames.add(call.name);
		else if (call.fn === "command") commandedNames.add(call.name);
		else if (call.fn === "dispatch") dispatchedNames.add(call.name);
	}
	const findings: Finding[] = [];
	for (const call of calls) {
		if (call.fn === "command" && !handledNames.has(call.name)) {
			findings.push({
				rule: "dead-contract",
				file: call.file,
				line: call.line,
				name: call.name,
				severity: "warning",
				message: `command("${call.name}") has no handle("${call.name}") in the scanned set — the handler may be presence-based/lazy (registered at runtime), so this is a warning, not an error`,
			});
		} else if (
			call.fn === "handle" &&
			!commandedNames.has(call.name) &&
			!dispatchedNames.has(call.name)
		) {
			findings.push({
				rule: "dead-contract",
				file: call.file,
				line: call.line,
				name: call.name,
				severity: "warning",
				message: `handle("${call.name}") has neither a command("${call.name}") nor a dispatch("${call.name}") in the scanned set — unused capability`,
			});
		}
	}
	return findings;
}
