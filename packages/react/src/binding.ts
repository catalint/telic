/**
 * Runtime binding — where hooks read, subscribe, and register (R5).
 *
 * No provider → the MODULE world: core's late-bound module-level `on`/`memory`
 * (they follow the default runtime across configureDefaultRuntime, S10.4/S10.5)
 * and mediate's module-level `handle` (the default-runtime mediation world,
 * S15.1).
 *
 * Provider runtime → that runtime's own surfaces plus ONE shared Mediator per
 * runtime: S15.1's "one mediator per runtime" shape. The mediator is created
 * lazily via createMediator and cached in a WeakMap so every <TelicProvider>
 * and every `mediatorFor()` caller for a given runtime shares one handler
 * registry — and the runtime's describe() `handled` probe stays accurate.
 */
import type {
	IntentEvent,
	IntentName,
	IntentPattern,
	MediationHandler,
	Mediator,
	Memory,
	OnOptions,
	Runtime,
	Seq,
	Unsubscribe,
} from "@telic/core";
import { currentRuntime, memory, on } from "@telic/core";
import { createMediator, handle } from "@telic/core/mediate";

/** What a hook needs from its bound world. Internal — not exported from the package. */
export type RuntimeBinding = {
	readonly memory: Memory;
	seq(): Seq;
	on(
		pattern: IntentPattern,
		listener: (event: IntentEvent) => void,
		opts?: OnOptions,
	): Unsubscribe;
	handle(name: IntentName, handler: MediationHandler): Unsubscribe;
};

/**
 * The default binding: the module-level world. Building this object has no
 * side effects — the default runtime is only resolved lazily when a member is
 * actually called (SSR-safe module scope, R6).
 */
export const moduleBinding: RuntimeBinding = {
	memory,
	seq: (): Seq => currentRuntime().seq(),
	on: (
		pattern: IntentPattern,
		listener: (event: IntentEvent) => void,
		opts?: OnOptions,
	): Unsubscribe => on(pattern, listener, opts),
	handle: (name: IntentName, handler: MediationHandler): Unsubscribe => handle(name, handler),
};

const mediators = new WeakMap<Runtime, Mediator>();

/**
 * The adapter's shared Mediator for an explicit runtime — created lazily via
 * `createMediator(runtime)`, exactly one per runtime (S15.1). `useHandle`
 * under a `<TelicProvider runtime={rt}>` registers here, so dispatch through
 * `mediatorFor(rt)` reaches component handlers. Do not call this with the
 * DEFAULT runtime (use the module-level dispatch/handle from
 * `@telic/core/mediate` for it — S15.1).
 */
export function mediatorFor(runtime: Runtime): Mediator {
	const existing = mediators.get(runtime);
	if (existing !== undefined) return existing;
	const created = createMediator(runtime);
	mediators.set(runtime, created);
	return created;
}

function buildBinding(runtime: Runtime, mediator: Mediator): RuntimeBinding {
	return {
		memory: runtime.memory,
		seq: (): Seq => runtime.seq(),
		on: (
			pattern: IntentPattern,
			listener: (event: IntentEvent) => void,
			opts?: OnOptions,
		): Unsubscribe => runtime.on(pattern, listener, opts),
		handle: (name: IntentName, handler: MediationHandler): Unsubscribe =>
			mediator.handle(name, handler),
	};
}

const defaultBindings = new WeakMap<Runtime, RuntimeBinding>();

/**
 * Binding for a provider runtime. With no explicit mediator the binding is
 * cached per runtime (stable identity across provider remounts); an explicit
 * mediator gets a fresh binding bound to it.
 */
export function bindingForRuntime(runtime: Runtime, mediator?: Mediator): RuntimeBinding {
	if (mediator !== undefined) return buildBinding(runtime, mediator);
	const cached = defaultBindings.get(runtime);
	if (cached !== undefined) return cached;
	const built = buildBinding(runtime, mediatorFor(runtime));
	defaultBindings.set(runtime, built);
	return built;
}
