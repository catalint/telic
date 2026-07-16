/**
 * useHandle — R3 presence-based mediation registration.
 *
 * Registers THE handler for an intent name while the component is mounted:
 * registration in an effect, unregistration as the effect cleanup. Handler
 * identity changes re-register (latest closure wins) WITHOUT a spurious
 * `handler-replaced` diagnostic — React runs the previous effect's cleanup
 * (unregister) before the next effect (register), so the registry never sees
 * two registrations for the hook at once. Matches mediate's semantics: the
 * diagnostic only fires when `handle()` is called while a handler is still
 * registered (S15.1).
 *
 * StrictMode (R3.2): mount → cleanup → mount ends with exactly one live
 * registration; parked dispatches drained by the first registration are not
 * re-executed by the second (drain-once is core behavior, S15.7).
 *
 * Binding (R5): the module-level mediation world by default; under
 * `<TelicProvider runtime={rt}>` the shared per-runtime mediator
 * (`mediatorFor(rt)`), so provider-world dispatchers reach this handler.
 *
 * SSR (R6): effects never run on the server — nothing registers there.
 */
import type { IntentName, MediationHandler } from "@telic/core";
import { useEffect } from "react";
import { useTelicBinding } from "./context.js";

/** Registers `handler` for `name` while mounted (R3). */
export function useHandle(name: IntentName, handler: MediationHandler): void {
	const binding = useTelicBinding();
	useEffect((): (() => void) => {
		const unregister = binding.handle(name, handler);
		return (): void => {
			unregister();
		};
	}, [binding, name, handler]);
}
