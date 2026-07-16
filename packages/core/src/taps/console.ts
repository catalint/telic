/**
 * Console tap — one human-readable line per mark, for local development.
 *
 * The default sink is `globalThis.console?.debug`, resolved lazily so the
 * import stays side-effect-free and SSR-safe. This is the ONLY telic module
 * allowed to touch `console`, and only as an injectable default (S13.1).
 */
import type { Mark, Tap } from "../types";

export type ConsoleTapOptions = {
	/** Line sink; defaults to `globalThis.console?.debug` (no-op when absent). */
	readonly log?: (line: string, mark: Mark) => void;
};

export function createConsoleTap(opts?: ConsoleTapOptions): Tap {
	const log = opts?.log ?? defaultLog;
	return {
		id: "console",
		onMark(mark: Mark): void {
			log(formatMark(mark), mark);
		},
	};
}

function defaultLog(line: string): void {
	// biome-ignore lint/suspicious/noConsole: sanctioned console exception (S13.1) — the default sink, resolved lazily and no-op when absent.
	globalThis.console?.debug?.(line);
}

/** Compact, never-throwing one-token preview of an unknown value. */
function summarize(value: unknown): string {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
		case "bigint":
			return String(value);
		case "undefined":
			return "";
		case "object": {
			if (value === null) return "null";
			return Array.isArray(value) ? "[…]" : "{…}";
		}
		default:
			return typeof value;
	}
}

function formatMark(mark: Mark): string {
	const head = `${mark.kind} ${mark.intent}#${mark.attempt.slice(0, 8)}`;
	switch (mark.kind) {
		case "begun": {
			const payload = summarize(mark.payload);
			return payload === "" ? head : `${head} ${payload}`;
		}
		case "noted": {
			const data = summarize(mark.data);
			return data === "" ? head : `${head} ${data}`;
		}
		case "fulfilled": {
			const outcome = summarize(mark.outcome);
			return outcome === "" ? head : `${head} → ${outcome}`;
		}
		case "rejected":
			return `${head} ✗ ${summarize(mark.reason)}`;
		case "abandoned":
			return `${head} (${mark.abandon.why})`;
		case "linked":
			return `${head} → ${mark.ref.kind}`;
	}
}
