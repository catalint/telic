import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LintConfig } from "./types.js";

export const CONFIG_FILENAME = "telic.config.json";

export type ParseConfigResult =
	| { readonly ok: true; readonly config: LintConfig }
	| { readonly ok: false; readonly error: string };

export type DiscoverConfigResult =
	| {
			readonly ok: true;
			readonly config: LintConfig;
			readonly configDir: string;
			readonly configPath: string | undefined;
	  }
	| { readonly ok: false; readonly error: string };

function isPlainObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Hand-rolled structural validation — zero runtime deps (no zod).
export function parseConfig(value: unknown): ParseConfigResult {
	if (!isPlainObject(value)) {
		return { ok: false, error: "config must be a JSON object" };
	}
	const config: LintConfig = {};

	const scopesValue: unknown = Reflect.get(value, "scopes");
	if (scopesValue !== undefined) {
		if (!isPlainObject(scopesValue)) {
			return { ok: false, error: "config.scopes must be an object of scope -> glob[]" };
		}
		// Prototype-free accumulator so a scope literally named "__proto__"
		// becomes an ordinary own property instead of polluting the prototype.
		const scopes: Record<string, readonly string[]> = Object.create(null);
		for (const scopeName of Object.keys(scopesValue)) {
			const globsValue: unknown = Reflect.get(scopesValue, scopeName);
			if (!Array.isArray(globsValue)) {
				return {
					ok: false,
					error: `config.scopes["${scopeName}"] must be an array of glob strings`,
				};
			}
			const globs: string[] = [];
			for (const glob of globsValue) {
				if (typeof glob !== "string") {
					return {
						ok: false,
						error: `config.scopes["${scopeName}"] must be an array of glob strings`,
					};
				}
				globs.push(glob);
			}
			scopes[scopeName] = globs;
		}
		config.scopes = scopes;
	}

	const requireScopeOwnership: unknown = Reflect.get(value, "requireScopeOwnership");
	if (requireScopeOwnership !== undefined) {
		if (typeof requireScopeOwnership !== "boolean") {
			return { ok: false, error: "config.requireScopeOwnership must be a boolean" };
		}
		config.requireScopeOwnership = requireScopeOwnership;
	}

	const deadContract: unknown = Reflect.get(value, "deadContract");
	if (deadContract !== undefined) {
		if (typeof deadContract !== "boolean") {
			return { ok: false, error: "config.deadContract must be a boolean" };
		}
		config.deadContract = deadContract;
	}

	return { ok: true, config };
}

function loadConfigFile(path: string): DiscoverConfigResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ok: false, error: `could not read config file: ${path}` };
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		return { ok: false, error: `invalid JSON in config file: ${path}` };
	}
	const parsed = parseConfig(parsedJson);
	if (!parsed.ok) return { ok: false, error: `${path}: ${parsed.error}` };
	return { ok: true, config: parsed.config, configDir: dirname(path), configPath: path };
}

// Discover telic.config.json upward from cwd; --config (explicitPath) overrides
// discovery. All config is optional — no file means zero-config (rules 1-2).
export function discoverConfig(cwd: string, explicitPath?: string): DiscoverConfigResult {
	if (explicitPath !== undefined) {
		const path = resolve(cwd, explicitPath);
		if (!existsSync(path)) return { ok: false, error: `config file not found: ${explicitPath}` };
		return loadConfigFile(path);
	}
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, CONFIG_FILENAME);
		if (existsSync(candidate)) return loadConfigFile(candidate);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { ok: true, config: {}, configDir: resolve(cwd), configPath: undefined };
}
