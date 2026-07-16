#!/usr/bin/env bun
/**
 * Size gate (P2-10, DECISIONS D17): builds each published subpath export as a
 * standalone minified bundle, brotli-compresses it, and fails (exit 1) if any
 * entry exceeds its budget. Budgets sit ~10% above the measured baseline so the
 * gate catches regressions, not ordinary drift.
 *
 * Metric is brotli — what modern CDNs serve, and the compression the accepted
 * review's core anchor (~4.5KB, 5KB budget) was measured against. `mediate` and
 * `flow` import `./core`, so a standalone bundle pulls all of core in: their
 * budgets sit near core's, not at a tap's.
 *
 * Zero npm deps: `Bun.build` + `node:zlib` are both built in.
 */
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

type Budget = {
	readonly entry: string;
	readonly file: string;
	readonly maxBrotliBytes: number;
};

const packageRoot: string = join(import.meta.dir, "..");

/** One row per package.json `exports` subpath. Exported so the repo-root
 * conventions-gate can assert exports↔budget parity without running a build. */
export const budgets: readonly Budget[] = [
	{ entry: ".", file: "src/core.ts", maxBrotliBytes: 5000 },
	{ entry: "./taps/console", file: "src/taps/console.ts", maxBrotliBytes: 460 },
	{ entry: "./taps/breadcrumbs", file: "src/taps/breadcrumbs.ts", maxBrotliBytes: 420 },
	{ entry: "./taps/sentry", file: "src/taps/sentry.ts", maxBrotliBytes: 420 },
	{ entry: "./taps/user-timing", file: "src/taps/user-timing.ts", maxBrotliBytes: 320 },
	{ entry: "./taps/analytics", file: "src/taps/analytics.ts", maxBrotliBytes: 1050 },
	{ entry: "./agent", file: "src/agent/surface.ts", maxBrotliBytes: 340 },
	{ entry: "./mediate", file: "src/mediate.ts", maxBrotliBytes: 5250 },
	{ entry: "./flow", file: "src/flow.ts", maxBrotliBytes: 4950 },
	{ entry: "./persist", file: "src/persist.ts", maxBrotliBytes: 1900 },
	{ entry: "./wire", file: "src/wire.ts", maxBrotliBytes: 1050 },
	{ entry: "./testing", file: "src/testing.ts", maxBrotliBytes: 4700 },
	{ entry: "./adapters/tanstack-query", file: "src/adapters/tanstack-query.ts", maxBrotliBytes: 870 },
	{ entry: "./transports/broadcast", file: "src/transports/broadcast.ts", maxBrotliBytes: 1750 },
	{ entry: "./transports/post-message", file: "src/transports/post-message.ts", maxBrotliBytes: 1750 },
	{ entry: "./transports/shared-worker", file: "src/transports/shared-worker.ts", maxBrotliBytes: 2130 },
	{ entry: "./adapters/xstate", file: "src/adapters/xstate.ts", maxBrotliBytes: 690 },
	{ entry: "./devtools", file: "src/devtools.ts", maxBrotliBytes: 930 },
	{ entry: "./taps/otel", file: "src/taps/otel.ts", maxBrotliBytes: 480 },
];

type Measurement = {
	readonly entry: string;
	readonly gzipBytes: number;
	readonly brotliBytes: number;
	readonly budget: number;
	readonly ok: boolean;
};

async function measure(budget: Budget): Promise<Measurement> {
	const built = await Bun.build({
		entrypoints: [join(packageRoot, budget.file)],
		minify: true,
		target: "browser",
	});
	if (!built.success) {
		const detail = built.logs.map((entry): string => String(entry)).join("\n");
		throw new Error(`build failed for ${budget.entry}:\n${detail}`);
	}
	const output = built.outputs[0];
	if (output === undefined) throw new Error(`no build output for ${budget.entry}`);
	const bytes = new Uint8Array(await output.arrayBuffer());
	const brotli = brotliCompressSync(bytes, {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
	});
	const gzip = gzipSync(bytes, { level: 9 });
	return {
		entry: budget.entry,
		gzipBytes: gzip.length,
		brotliBytes: brotli.length,
		budget: budget.maxBrotliBytes,
		ok: brotli.length <= budget.maxBrotliBytes,
	};
}

// The gate compares brotli (what CDNs serve; the accepted review's core anchor
// is a brotli figure). gzip is shown for reference only.
function row(
	entry: string,
	gzip: string,
	brotli: string,
	budget: string,
	headroom: string,
	status: string,
): string {
	return `${entry.padEnd(22)}${gzip.padStart(8)}${brotli.padStart(9)}${budget.padStart(9)}${headroom.padStart(10)}  ${status}`;
}

async function main(): Promise<void> {
	const measurements: Measurement[] = [];
	for (const budget of budgets) measurements.push(await measure(budget));

	const header = row("entry", "gzip", "brotli", "budget", "headroom", "status");
	process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
	for (const measurement of measurements) {
		const headroom = measurement.budget - measurement.brotliBytes;
		process.stdout.write(
			`${row(
				measurement.entry,
				`${measurement.gzipBytes}`,
				`${measurement.brotliBytes}`,
				`${measurement.budget}`,
				`${headroom}`,
				measurement.ok ? "ok" : "OVER",
			)}\n`,
		);
	}

	const breached = measurements.filter((measurement): boolean => !measurement.ok);
	if (breached.length > 0) {
		const names = breached.map((measurement): string => measurement.entry).join(", ");
		process.stdout.write(`\nsize gate FAILED — over budget: ${names}\n`);
		process.exit(1);
	}
	process.stdout.write("\nsize gate passed\n");
}

if (import.meta.main) await main();
