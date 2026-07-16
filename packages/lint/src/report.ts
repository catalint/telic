import type { Finding, JsonFinding } from "./types.js";

export function toJsonFindings(findings: readonly Finding[]): JsonFinding[] {
	return findings.map((finding) => ({
		rule: finding.rule,
		file: finding.file,
		line: finding.line,
		name: finding.name,
		message: finding.message,
	}));
}

export function formatJson(findings: readonly Finding[]): string {
	return JSON.stringify(toJsonFindings(findings), null, 2);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatHuman(findings: readonly Finding[]): string {
	if (findings.length === 0) return "telic-lint: no findings";
	const lines: string[] = [];
	for (const finding of findings) {
		const level = finding.severity === "warning" ? "warn " : "error";
		lines.push(
			`${finding.file}:${finding.line}  ${level}  ${finding.rule}  ${finding.name}  ${finding.message}`,
		);
	}
	const errors = findings.filter((finding) => finding.severity !== "warning").length;
	const warnings = findings.length - errors;
	lines.push("");
	lines.push(
		`${plural(findings.length, "finding")} (${plural(errors, "error")}, ${plural(warnings, "warning")})`,
	);
	return lines.join("\n");
}
