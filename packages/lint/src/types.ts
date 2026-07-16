// Shared value-free types for the linter. Kept ts-compiler-agnostic so
// isolatedDeclarations only ever sees our own annotated shapes.

export type TelicFn = "intent" | "command" | "handle" | "dispatch";

export type RuleName =
	| "setter-like-name"
	| "duplicate-intent-name"
	| "scope-ownership"
	| "dead-contract";

export type Severity = "error" | "warning";

// One eligible telic call site extracted from a source file.
export type TelicCall = {
	readonly fn: TelicFn;
	readonly name: string;
	readonly file: string;
	readonly line: number;
};

// Raw source to scan — driven directly by tests, or read from disk by the CLI.
export type SourceInput = {
	readonly fileName: string;
	readonly sourceText: string;
};

export type Finding = {
	readonly rule: RuleName;
	readonly file: string;
	readonly line: number;
	readonly name: string;
	readonly message: string;
	readonly severity: Severity;
};

// The machine-readable finding shape emitted by `--json` (L1.3): exactly
// rule/file/line/name/message, no severity.
export type JsonFinding = {
	readonly rule: RuleName;
	readonly file: string;
	readonly line: number;
	readonly name: string;
	readonly message: string;
};

export type LintConfig = {
	scopes?: Record<string, readonly string[]>;
	requireScopeOwnership?: boolean;
	deadContract?: boolean;
};
