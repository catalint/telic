import { extractCalls } from "./extract.js";
import {
	deadContract,
	duplicateIntentName,
	scopeOwnership,
	setterLikeName,
} from "./rules.js";
import type { Finding, LintConfig, RuleName, SourceInput, TelicCall } from "./types.js";

export function collectCalls(files: readonly SourceInput[]): TelicCall[] {
	const calls: TelicCall[] = [];
	for (const file of files) {
		for (const call of extractCalls(file.fileName, file.sourceText)) calls.push(call);
	}
	return calls;
}

const RULE_ORDER: Record<RuleName, number> = {
	"setter-like-name": 0,
	"duplicate-intent-name": 1,
	"scope-ownership": 2,
	"dead-contract": 3,
};

function compareFindings(left: Finding, right: Finding): number {
	if (left.file !== right.file) return left.file < right.file ? -1 : 1;
	if (left.line !== right.line) return left.line - right.line;
	const ruleDelta = RULE_ORDER[left.rule] - RULE_ORDER[right.rule];
	if (ruleDelta !== 0) return ruleDelta;
	if (left.name !== right.name) return left.name < right.name ? -1 : 1;
	return 0;
}

export function runRules(
	calls: readonly TelicCall[],
	config: LintConfig,
	configDir: string,
): Finding[] {
	const findings = [
		...setterLikeName(calls),
		...duplicateIntentName(calls),
		...scopeOwnership(calls, config, configDir),
		...deadContract(calls, config),
	];
	findings.sort(compareFindings);
	return findings;
}

export function scan(
	files: readonly SourceInput[],
	config: LintConfig,
	configDir: string,
): Finding[] {
	return runRules(collectCalls(files), config, configDir);
}
