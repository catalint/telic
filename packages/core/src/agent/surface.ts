/**
 * AI-agent read surface (SPEC S14): a frozen, globalThis-installable facade
 * for external agents/devtools to introspect a runtime's memory. Import is
 * side-effect-free — no environment access happens until
 * `exposeAgentSurface()` is actually called (S14.4).
 */
import type { AttemptView, IntentDescriptor, Mark, MemorySnapshot, Runtime, Seq } from "../types.js";

/**
 * Pure delegations to `Runtime`/`Memory` — every returned value is already
 * frozen/redacted by core semantics (S14.2). `marks()`/`inProgress()` are
 * NOT additionally filtered here; the facade is a local reader.
 */
export type AgentSurface = {
	readonly version: 1;
	snapshot(): MemorySnapshot;
	marks(sinceSeq?: Seq): readonly Mark[];
	inProgress(): readonly AttemptView[];
	describe(): readonly IntentDescriptor[];
};

export type ExposeAgentSurfaceOptions = {
	readonly key?: string;
	readonly target?: object;
};

const DEFAULT_KEY = "__INTENT_MEMORY__";

/** S14.3: a previous telic facade is any existing value carrying a `version` property. */
function hasVersionProperty(value: unknown): boolean {
	return typeof value === "object" && value !== null && "version" in value;
}

function buildSurface(runtime: Runtime): AgentSurface {
	const surface: AgentSurface = {
		version: 1,
		snapshot: (): MemorySnapshot => runtime.memory.snapshot(),
		marks: (sinceSeq?: Seq): readonly Mark[] =>
			runtime.memory.marks(sinceSeq === undefined ? undefined : { sinceSeq }),
		inProgress: (): readonly AttemptView[] => runtime.memory.inProgress(),
		describe: (): readonly IntentDescriptor[] => runtime.describe(),
	};
	return Object.freeze(surface);
}

/**
 * Installs a frozen AI-agent read facade at `target[key]` (default key
 * "__INTENT_MEMORY__", default target `globalThis`). Overwrites silently
 * only when the existing value is a previous telic facade (S14.3);
 * otherwise the existing property is left untouched and a no-op uninstaller
 * is returned. The real uninstaller removes the property only if it is
 * still the exact facade this call installed — a later
 * `exposeAgentSurface()` call may have replaced it since.
 */
export function exposeAgentSurface(runtime: Runtime, opts?: ExposeAgentSurfaceOptions): () => void {
	const key: string = opts?.key ?? DEFAULT_KEY;
	const target: object = opts?.target ?? globalThis;

	const existing: unknown = Reflect.get(target, key);
	if (existing !== undefined && !hasVersionProperty(existing)) {
		return (): void => {
			// Nothing was installed; the pre-existing, non-facade value stays untouched.
		};
	}

	const surface = buildSurface(runtime);
	Reflect.set(target, key, surface);

	return (): void => {
		if (Reflect.get(target, key) === surface) Reflect.deleteProperty(target, key);
	};
}
