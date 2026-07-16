/**
 * Sentry preset for the vendor-neutral breadcrumb tap (S13.2).
 *
 * `taps/breadcrumbs` is the primary; this module keeps the Sentry name as a
 * discoverable alias for existing consumers. Identical semantics — no @sentry
 * import, no runtime dependencies.
 */
import type { Tap } from "../types.js";
import type { BreadcrumbTapOptions } from "./breadcrumbs.js";
import { createBreadcrumbTap } from "./breadcrumbs.js";

export type {
	BreadcrumbLevel,
	BreadcrumbLike,
	BreadcrumbTapOptions,
	IntentContext,
} from "./breadcrumbs.js";
export { intentContext } from "./breadcrumbs.js";

/** Alias of {@link createBreadcrumbTap} — the Sentry-named preset. */
export const createSentryBreadcrumbTap: (opts: BreadcrumbTapOptions) => Tap = createBreadcrumbTap;

/** @deprecated Use {@link BreadcrumbTapOptions} from `@telic/core/taps/breadcrumbs`. */
export type SentryBreadcrumbTapOptions = BreadcrumbTapOptions;
