/**
 * Unknown-argument reporting for MCP `tools/call` (#3749).
 *
 * The MCP dispatcher used to hand the caller's raw `arguments` to a tool and
 * let the tool read the keys it knew. A mistyped key (`pilens_diagnostics
 * {"filePath": ...}` where the schema says `path`) was dropped without a
 * word, and the tool ran on defaults: an agent read `No issues in the current
 * turn delta.` as a clean file. This module is the one check the dispatcher
 * applies to every tool, driven by the `inputSchema` the tool already
 * advertises in `tools/list`:
 *
 *  - a key the schema does not declare is REPORTED (a leading warning line
 *    plus `structuredContent.ignoredArguments`), never silently dropped;
 *  - when such a key leaves a schema-`required` input missing, the call is an
 *    error instead of a run on defaults.
 *
 * Hard rejection of every unknown key is NOT done here: it would break
 * callers that pass extra keys today, and is owned by the #2418 stability
 * policy.
 */

/** The slice of a JSON-Schema object the check reads. */
export interface ToolInputSchemaLike {
	properties?: Record<string, unknown>;
	required?: readonly string[];
}

export interface IgnoredArgument {
	key: string;
	/** The nearest declared key, when one is plausibly what the caller meant. */
	suggestion?: string;
}

export interface ArgumentReport {
	ignored: IgnoredArgument[];
	/** Schema-required keys the caller did not send. */
	missingRequired: string[];
	/**
	 * Ignored keys that are a declared key the call did NOT send, written
	 * another way (`filePath` for `path`): the caller's intent is lost, not
	 * merely decorated with an extra key. Decided by `refusalMatches` only,
	 * never by the loose hint.
	 */
	unsentSuggestions: { key: string; suggestion: string }[];
}

/** Keys named in the line / structured list; the rest are counted. */
export const MAX_REPORTED_KEYS = 8;
/** A reported key is cut here so one huge key cannot make a huge line. */
export const MAX_REPORTED_KEY_CHARS = 64;

/** Equal, or one character inserted, dropped or replaced. */
function withinOneEdit(a: string, b: string): boolean {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
	return a.length < b.length
		? a.slice(i) === b.slice(i + 1)
		: b.slice(i) === a.slice(i + 1);
}

/**
 * The declared key a caller most plausibly meant by `key`: one containing
 * (or contained in) the other once case and punctuation are folded away
 * (`filePath` for `path` or `file`; `FILE` for `file`), or a one-character
 * typo. `undefined` when nothing is near: a wrong suggestion is worse than
 * none.
 */
function nearestDeclaredKey(
	key: string,
	declared: readonly string[],
): string | undefined {
	const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
	const folded = fold(key);
	let best: { key: string; score: number } | undefined;
	for (const candidate of declared) {
		const other = fold(candidate);
		const contained =
			Math.min(folded.length, other.length) >= 3 &&
			(folded.includes(other) || other.includes(folded));
		if (!contained && !withinOneEdit(folded, other)) continue;
		// The closest in length wins; a tie keeps the earlier declared key.
		const score = Math.abs(folded.length - other.length);
		if (!best || score < best.score) best = { key: candidate, score };
	}
	return best?.key;
}

/** Lower-cased camelCase / snake_case / kebab tokens, each without a plural `s`. */
function tokensOf(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => token.replace(/s$/, ""))
		.filter(Boolean);
}

/**
 * The REFUSAL predicate (#3749, named in docs/public-api-stability.md): the
 * declared keys that `key` is, exactly, written another way. A declared key
 * matches when its tokens (a) equal the ignored key's tokens joined (case and
 * punctuation folded: `Path`, `PATH`, `Server_Scope` for `serverScope`), or (b)
 * are the TRAILING tokens of the ignored key, its head noun (`filePath` and
 * `file_path` end in the token `path`; `pathName` and `sourcePath` do not end
 * in `path` / `source`), unless the leading tokens change what the key names
 * (#3809): they are themselves a declared key (`cwdPath` is `cwd`, not `path`,
 * when `cwd` is declared), or one is a quantity, flag or sink word (`maxFiles`,
 * `includeFiles`, `outFile` are not `file`). A plural `s` is ignored on either
 * side (`paths` for `path`). Reverse containment, abbreviations, typos, leading
 * or middle tokens and substrings (`files` for `maxLspFiles`, `file` for
 * `path`) never match: those stay a warning, because refusing on them sent
 * callers to the wrong parameter. A folded-equal match decides alone; suffix
 * matches count only when none exists.
 */
export function refusalMatches(
	key: string,
	declared: readonly string[],
): string[] {
	return classifyKey(key, declared).matches;
}

/**
 * Qualifier words that turn a head noun into a different parameter: a quantity
 * (`maxFiles` counts files) or a flag or sink (`includeFiles`, `outFile`),
 * never the file parameter itself (#3809). A finite list on purpose: a
 * spelling not on it (`newFile`, `hasFile`) still refuses on its head noun.
 * Compared after the plural `s` is dropped, so no entry ends in `s`.
 */
const NON_LOCATOR_QUALIFIERS: ReadonlySet<string> = new Set([
	"max",
	"min",
	"num",
	"count",
	"total",
	"include",
	"exclude",
	"out",
	"output",
]);

interface KeyMatches {
	/** The declared keys the refusal predicate returns for the key. */
	matches: string[];
	/** Head-noun matches dropped because the qualifier names something else. */
	retargeted: string[];
}

function classifyKey(key: string, declared: readonly string[]): KeyMatches {
	const tokens = tokensOf(key);
	const folded = tokens.join("");
	const declaredFolds = new Set(
		declared.map((name) => tokensOf(name).join("")),
	);
	const equal: string[] = [];
	const suffix: string[] = [];
	const retargeted: string[] = [];
	for (const candidate of declared) {
		const wanted = tokensOf(candidate);
		if (wanted.length === 0) continue;
		if (folded === wanted.join("")) {
			equal.push(candidate);
			continue;
		}
		if (tokens.slice(-wanted.length).join(" ") !== wanted.join(" ")) continue;
		const qualifier = tokens.slice(0, -wanted.length);
		const retargets =
			declaredFolds.has(qualifier.join("")) ||
			qualifier.some((token) => NON_LOCATOR_QUALIFIERS.has(token));
		(retargets ? retargeted : suffix).push(candidate);
	}
	return equal.length > 0
		? { matches: equal, retargeted: [] }
		: { matches: suffix, retargeted };
}

/**
 * Compare a call's arguments with the tool's declared schema. `undefined`
 * when every key is declared (the call is untouched). An own-property test,
 * not `in`: `constructor` and `toString` are not declared keys.
 */
export function findIgnoredArguments(
	schema: ToolInputSchemaLike,
	args: Record<string, unknown>,
): ArgumentReport | undefined {
	const properties = schema.properties ?? {};
	const declared = Object.keys(properties);
	const unsentSuggestions: ArgumentReport["unsentSuggestions"] = [];
	const ignored = Object.keys(args)
		.filter((key) => !Object.hasOwn(properties, key))
		.map((key): IgnoredArgument => {
			const { matches, retargeted } = classifyKey(key, declared);
			// Sending any one spelling of the parameter (`path` or `paths`) settles it.
			const unsent = matches.some((match) => Object.hasOwn(args, match))
				? undefined
				: matches[0];
			if (
				unsent !== undefined &&
				!unsentSuggestions.some((entry) => entry.suggestion === unsent)
			)
				unsentSuggestions.push({ key, suggestion: unsent });
			// The hint prefers the refusal match, so the line and the refusal agree,
			// and never points a retargeted key back at the head noun it is not.
			const suggestion =
				matches[0] ??
				nearestDeclaredKey(
					key,
					declared.filter((name) => !retargeted.includes(name)),
				);
			return suggestion === undefined ? { key } : { key, suggestion };
		});
	if (ignored.length === 0) return undefined;
	const missingRequired = (schema.required ?? []).filter(
		(key) => !Object.hasOwn(args, key),
	);
	return { ignored, missingRequired, unsentSuggestions };
}

function shown(key: string): string {
	return key.length > MAX_REPORTED_KEY_CHARS
		? `${key.slice(0, MAX_REPORTED_KEY_CHARS)}…`
		: key;
}

/** The leading line: names the ignored keys with the nearest valid key. */
export function ignoredArgumentsLine(
	tool: string,
	report: ArgumentReport,
): string {
	const listed = report.ignored.slice(0, MAX_REPORTED_KEYS).map((entry) => {
		const hint = entry.suggestion
			? ` (did you mean \`${entry.suggestion}\`?)`
			: "";
		return `\`${shown(entry.key)}\`${hint}`;
	});
	const more = report.ignored.length - listed.length;
	const tail = more > 0 ? ` and ${more} more` : "";
	return `Ignored unknown argument(s) for ${tool}: ${listed.join(", ")}${tail}. They had no effect on this call.`;
}

/** The structured payload: bounded key list plus the exact count. */
export function ignoredArgumentsStructured(report: ArgumentReport): {
	ignoredArguments: string[];
	ignoredArgumentCount: number;
} {
	return {
		ignoredArguments: report.ignored
			.slice(0, MAX_REPORTED_KEYS)
			.map((entry) => shown(entry.key)),
		ignoredArgumentCount: report.ignored.length,
	};
}

interface TextContentResult {
	content: { type: "text"; text: string }[];
}

/** Put the warning line first in a finished result and attach the payload. */
export function withIgnoredArguments<T extends TextContentResult>(
	result: T,
	tool: string,
	report: ArgumentReport,
): T & { structuredContent: ReturnType<typeof ignoredArgumentsStructured> } {
	const line = ignoredArgumentsLine(tool, report);
	const [first, ...rest] = result.content;
	return {
		...result,
		content: first
			? [{ ...first, text: `${line}\n\n${first.text}` }, ...rest]
			: [{ type: "text" as const, text: line }],
		structuredContent: ignoredArgumentsStructured(report),
	};
}

/**
 * The error that replaces a run on defaults when an ignored key leaves the
 * call without something it needed: a schema-required input, or the declared
 * key the ignored key was plainly a mistyped form of. `undefined` when
 * neither is missing (the call runs, with the warning).
 */
export function refusalResult(
	tool: string,
	report: ArgumentReport,
):
	| (TextContentResult & {
			isError: true;
			structuredContent: ReturnType<typeof ignoredArgumentsStructured>;
	  })
	| undefined {
	const reasons: string[] = [];
	if (report.missingRequired.length > 0)
		reasons.push(
			`required argument(s) ${report.missingRequired.map((key) => `\`${key}\``).join(", ")} missing`,
		);
	for (const { key, suggestion } of report.unsentSuggestions) {
		if (report.missingRequired.includes(suggestion)) continue;
		reasons.push(
			`\`${shown(key)}\` looks like a mistyped \`${suggestion}\`, which was not sent`,
		);
	}
	if (reasons.length === 0) return undefined;
	return {
		content: [
			{
				type: "text",
				text: `${ignoredArgumentsLine(tool, report)}\nNot run: ${reasons.join("; ")}.`,
			},
		],
		isError: true,
		structuredContent: ignoredArgumentsStructured(report),
	};
}
