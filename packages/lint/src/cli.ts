#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { discoverConfig } from "./config.js";
import { formatHuman, formatJson } from "./report.js";
import { scan } from "./scan.js";
import type { Finding, SourceInput } from "./types.js";
import { collectSourceFiles } from "./walk.js";

const USAGE = `telic-lint — taxonomy governance for @telic intent/command/handle/dispatch

Usage:
  telic-lint [globs...] [options]

Options:
  --json            emit machine-readable findings ([{ rule, file, line, name, message }])
  --config <path>   use this config file instead of discovering telic.config.json
  -h, --help        show this help

Exit codes: 0 = clean, 1 = findings, 2 = usage/config error.`;

type CliArgs = {
	readonly globs: string[];
	readonly json: boolean;
	readonly configPath: string | undefined;
	readonly help: boolean;
};

type ParseArgsResult = { readonly ok: true; readonly args: CliArgs } | { readonly ok: false; readonly error: string };

function parseArgs(argv: readonly string[]): ParseArgsResult {
	const globs: string[] = [];
	let json = false;
	let help = false;
	let configPath: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--json") {
			json = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--config") {
			const value = argv[index + 1];
			if (value === undefined) return { ok: false, error: "--config requires a path argument" };
			configPath = value;
			index++;
		} else if (arg.startsWith("--config=")) {
			configPath = arg.slice("--config=".length);
		} else if (arg.startsWith("-")) {
			return { ok: false, error: `unknown option: ${arg}` };
		} else {
			globs.push(arg);
		}
	}
	return { ok: true, args: { globs, json, configPath, help } };
}

function relativizeFindings(findings: readonly Finding[], cwd: string): Finding[] {
	return findings.map((finding) => {
		const relPath = relative(cwd, finding.file);
		return { ...finding, file: relPath.length > 0 ? relPath : finding.file };
	});
}

function run(): number {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`telic-lint: ${parsed.error}\n\n${USAGE}\n`);
		return 2;
	}
	if (parsed.args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const cwd = process.cwd();
	const discovered = discoverConfig(cwd, parsed.args.configPath);
	if (!discovered.ok) {
		process.stderr.write(`telic-lint: ${discovered.error}\n`);
		return 2;
	}

	const files = collectSourceFiles(cwd, parsed.args.globs);
	const inputs: SourceInput[] = [];
	for (const file of files) {
		try {
			inputs.push({ fileName: file, sourceText: readFileSync(file, "utf8") });
		} catch {
			// unreadable file — skip; it cannot contribute findings.
		}
	}

	const findings = scan(inputs, discovered.config, discovered.configDir);
	const relativized = relativizeFindings(findings, cwd);
	const output = parsed.args.json ? formatJson(relativized) : formatHuman(relativized);
	process.stdout.write(`${output}\n`);
	return findings.length > 0 ? 1 : 0;
}

// Set exitCode rather than process.exit() so buffered stdout drains fully
// before the process ends (avoids truncated output when piped).
process.exitCode = run();
