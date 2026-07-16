/**
 * @telic/react — React adapter for @telic/core (SPEC.md R1–R6).
 *
 * Doctrine (R1): mounts are not intents. No hook here begins an attempt on
 * mount; recording happens in event handlers via the stable callbacks the
 * hooks return. No react-dom dependency (R6) — works under react-dom and
 * react-native renderers.
 */
export { mediatorFor } from "./binding.js";
export { TelicProvider } from "./context.js";
export type { TelicProviderProps } from "./context.js";
export { useHandle } from "./use-handle.js";
export { useIntent } from "./use-intent.js";
export type { UseIntentHandle, UseIntentOptions } from "./use-intent.js";
export { useInProgress, useLastAttempt, useMemorySeq } from "./use-memory.js";
