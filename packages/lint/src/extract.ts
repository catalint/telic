import ts from "typescript";
import type { TelicCall, TelicFn } from "./types.js";

// The linter uses the HOST's compiler (peer `typescript`), never a bundled
// one — this import resolves to whatever TypeScript >= 5.5 the consumer has.

function canonicalFn(name: string): TelicFn | undefined {
	if (name === "intent" || name === "command" || name === "handle" || name === "dispatch") {
		return name;
	}
	return undefined;
}

type ImportBindings = {
	// A file is eligible only if it imports from a specifier containing "telic"
	// (L3.1) — this is what keeps unrelated local `handle` functions from ever
	// being reported.
	readonly eligible: boolean;
	// local identifier -> canonical telic function it aliases (from any module).
	readonly aliases: ReadonlyMap<string, TelicFn>;
	// namespace imports bound to a telic specifier (`import * as t from "telic"`).
	readonly namespaces: ReadonlySet<string>;
};

function collectImportBindings(sourceFile: ts.SourceFile): ImportBindings {
	let eligible = false;
	const aliases = new Map<string, TelicFn>();
	const namespaces = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		const isTelicSpecifier = specifier.includes("telic");
		const clause = statement.importClause;
		// A type-only import (`import type { … }`) or a side-effect import
		// (`import "…"`, no clause) erases at runtime and binds no telic value
		// into scope — it must NOT make the file eligible, or a coincidental
		// local `handle`/`intent`/… would be a false positive (L3.1).
		if (clause === undefined || clause.isTypeOnly) continue;
		if (isTelicSpecifier) eligible = true;
		const bindings = clause.namedBindings;
		if (bindings === undefined) continue;
		if (ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				const importedName = (element.propertyName ?? element.name).text;
				const canonical = canonicalFn(importedName);
				if (canonical !== undefined) aliases.set(element.name.text, canonical);
			}
		} else if (ts.isNamespaceImport(bindings) && isTelicSpecifier) {
			namespaces.add(bindings.name.text);
		}
	}
	return { eligible, aliases, namespaces };
}

function resolveCallee(expression: ts.Expression, bindings: ImportBindings): TelicFn | undefined {
	if (ts.isIdentifier(expression)) {
		const aliased = bindings.aliases.get(expression.text);
		if (aliased !== undefined) return aliased;
		return canonicalFn(expression.text);
	}
	if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
		if (bindings.namespaces.has(expression.expression.text)) {
			return canonicalFn(expression.name.text);
		}
	}
	return undefined;
}

function literalName(argument: ts.Expression): string | undefined {
	// String literal or no-substitution template only (L3.1) — a name built
	// from a variable or an interpolated template cannot be checked statically.
	if (ts.isStringLiteralLike(argument)) return argument.text;
	return undefined;
}

export function extractCalls(fileName: string, sourceText: string): TelicCall[] {
	const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(
		fileName,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const bindings = collectImportBindings(sourceFile);
	if (!bindings.eligible) return [];

	const calls: TelicCall[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const canonical = resolveCallee(node.expression, bindings);
			const firstArg = node.arguments[0];
			if (canonical !== undefined && firstArg !== undefined) {
				const name = literalName(firstArg);
				if (name !== undefined) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					calls.push({ fn: canonical, name, file: fileName, line: line + 1 });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(sourceFile, visit);
	return calls;
}
