#!/usr/bin/env bun
/**
 * Consumer matrix (D19d): builds @telic/core, packs it into a tarball, and
 * type-checks the consumer + augmentation files against the COMPILED package
 * under each requested TypeScript version — proving the emitted .d.ts is
 * consumable on the whole support floor and that IntentRegistry augmentation
 * flows across the declaration boundary.
 *
 * Usage:
 *   bun ci/consumer-smoke/run.ts            # every default version
 *   bun ci/consumer-smoke/run.ts 6.0.3      # one version (CI matrix passes one)
 */
import { $ } from "bun";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TS_VERSIONS = ["5.5.4", "5.9.2", "6.0.3"] as const;

const here: string = import.meta.dir;
const repoRoot: string = join(here, "..", "..");
const coreDir: string = join(repoRoot, "packages", "core");

const requested: string[] = process.argv.slice(2);
const versions: string[] = requested.length > 0 ? requested : [...DEFAULT_TS_VERSIONS];

async function buildAndPack(): Promise<string> {
	console.log("building @telic/core …");
	await $`bun run build`.cwd(coreDir);
	const packDir: string = mkdtempSync(join(tmpdir(), "telic-pack-"));
	await $`bun pm pack --destination ${packDir}`.cwd(coreDir);
	const tarball: string | undefined = readdirSync(packDir).find((file: string): boolean =>
		file.endsWith(".tgz"),
	);
	if (tarball === undefined) throw new Error("bun pm pack produced no .tgz");
	return join(packDir, tarball);
}

async function checkVersion(tarball: string, version: string): Promise<boolean> {
	const workDir: string = mkdtempSync(join(tmpdir(), `telic-consumer-${version}-`));
	await Bun.write(
		join(workDir, "package.json"),
		`${JSON.stringify(
			{ name: "telic-consumer-smoke", private: true, version: "0.0.0", type: "module" },
			null,
			2,
		)}\n`,
	);
	cpSync(join(here, "consumer.ts"), join(workDir, "consumer.ts"));
	cpSync(join(here, "augment.ts"), join(workDir, "augment.ts"));

	await $`bun add ${tarball} typescript@${version}`.cwd(workDir).quiet();

	console.log(`\n=== @telic/core vs TypeScript ${version} ===`);
	const result =
		await $`./node_modules/.bin/tsc --strict --noEmit --moduleResolution bundler --module esnext --target es2022 --lib esnext,dom,dom.iterable consumer.ts augment.ts`
			.cwd(workDir)
			.nothrow();
	if (result.exitCode === 0) {
		console.log(`OK — TypeScript ${version}`);
		return true;
	}
	process.stdout.write(result.stdout.toString());
	process.stderr.write(result.stderr.toString());
	console.error(`FAILED — TypeScript ${version}`);
	return false;
}

async function main(): Promise<void> {
	const tarball: string = await buildAndPack();
	const results: boolean[] = [];
	for (const version of versions) results.push(await checkVersion(tarball, version));
	if (results.some((ok: boolean): boolean => !ok)) {
		console.error("\nconsumer matrix FAILED");
		process.exit(1);
	}
	console.log("\nconsumer matrix passed");
}

await main();
