/**
 * <TelicProvider runtime={…}> — R5 runtime binding.
 *
 * Hooks bind to the module-level world (the default runtime) by default; a
 * provider overrides via context with an explicit runtime — the shape used for
 * tests and embedding (pairs with createTestRuntime from @telic/core/testing).
 *
 * The provider carries a Mediator too: mediation handles registered by
 * `useHandle` under a provider must live in a per-runtime world (S15.1), so
 * the provider resolves `mediatorFor(runtime)` (one shared mediator per
 * runtime) unless an explicit `mediator` prop is given.
 */
import type { Mediator, Runtime } from "@telic/core";
import type { ReactElement, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { RuntimeBinding } from "./binding.js";
import { bindingForRuntime, moduleBinding } from "./binding.js";

const TelicContext = createContext<RuntimeBinding>(moduleBinding);

export type TelicProviderProps = {
	/** Explicit runtime for the subtree (createRuntime / createTestRuntime().runtime). Pass explicit runtimes only — the default runtime is already the no-provider binding (and is mediated by the module-level world, S15.1). */
	readonly runtime: Runtime;
	/** Optional explicit Mediator. Default: the shared per-runtime mediator (`mediatorFor(runtime)`), so dispatchers and handlers agree on one registry. */
	readonly mediator?: Mediator;
	readonly children?: ReactNode;
};

/** Binds all @telic/react hooks in the subtree to an explicit runtime (R5). */
export function TelicProvider(props: TelicProviderProps): ReactElement {
	const binding = useMemo(
		(): RuntimeBinding => bindingForRuntime(props.runtime, props.mediator),
		[props.runtime, props.mediator],
	);
	return <TelicContext.Provider value={binding}>{props.children}</TelicContext.Provider>;
}

/** INTERNAL — the binding the calling component sees (provider world or module world). */
export function useTelicBinding(): RuntimeBinding {
	return useContext(TelicContext);
}
