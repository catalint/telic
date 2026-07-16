// Minimal, dependency-free glob matcher. Supports `**` (matches zero or more
// path segments), `*` (any run of chars within one segment), `?` (one char
// within a segment), and one level of `{a,b}` brace alternation. Enough for
// both the default `**/*.{ts,tsx}` and config scope globs like
// `packages/checkout/**`.

function normalizeSeparators(value: string): string {
	return value.replace(/\\/g, "/");
}

function splitSegments(value: string): string[] {
	return normalizeSeparators(value)
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".");
}

function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const prefix = pattern.slice(0, open);
	const suffix = pattern.slice(close + 1);
	const options = pattern.slice(open + 1, close).split(",");
	const expanded: string[] = [];
	for (const option of options) {
		for (const tail of expandBraces(suffix)) {
			expanded.push(prefix + option + tail);
		}
	}
	return expanded;
}

function segmentToRegExp(segment: string): RegExp {
	let source = "^";
	for (const char of segment) {
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	source += "$";
	return new RegExp(source);
}

function segmentMatches(patternSegment: string, pathSegment: string): boolean {
	if (!patternSegment.includes("*") && !patternSegment.includes("?")) {
		return patternSegment === pathSegment;
	}
	return segmentToRegExp(patternSegment).test(pathSegment);
}

function matchFrom(
	patternSegments: readonly string[],
	patternIndex: number,
	pathSegments: readonly string[],
	pathIndex: number,
): boolean {
	if (patternIndex === patternSegments.length) {
		return pathIndex === pathSegments.length;
	}
	const head = patternSegments[patternIndex];
	if (head === undefined) return false;
	if (head === "**") {
		for (let next = pathIndex; next <= pathSegments.length; next++) {
			if (matchFrom(patternSegments, patternIndex + 1, pathSegments, next)) return true;
		}
		return false;
	}
	if (pathIndex === pathSegments.length) return false;
	const current = pathSegments[pathIndex];
	if (current === undefined) return false;
	if (!segmentMatches(head, current)) return false;
	return matchFrom(patternSegments, patternIndex + 1, pathSegments, pathIndex + 1);
}

export function matchGlob(pattern: string, path: string): boolean {
	const pathSegments = splitSegments(path);
	for (const expanded of expandBraces(pattern)) {
		if (matchFrom(splitSegments(expanded), 0, pathSegments, 0)) return true;
	}
	return false;
}

export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
	return patterns.some((pattern) => matchGlob(pattern, path));
}

// Resolve a (relative) config glob against the config file's directory so it
// can be matched against absolute scanned paths in the same coordinate space.
export function resolveGlob(baseDir: string, pattern: string): string {
	const normalizedPattern = normalizeSeparators(pattern);
	if (normalizedPattern.startsWith("/")) return normalizedPattern;
	const normalizedBase = normalizeSeparators(baseDir).replace(/\/+$/, "");
	return `${normalizedBase}/${normalizedPattern}`;
}
