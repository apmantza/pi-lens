/**
 * #3278 acceptance criterion 3 — the ABSENCE detector for the runner
 * reported-path-identity family.
 *
 * `tests/config/path-key-fold-sweep.test.ts` enumerates existing case FOLDS, so
 * a site with NO fold at all presents nothing to count: measured while fixing
 * #3277, mutating `go-vet.ts` to a hand-rolled `toLowerCase` compare left that
 * sweep GREEN. Eleven members of this family were invisible to it for exactly
 * that reason. This sweep counts the opposite thing — every runner or tool-client
 * site that still answers "is this reported diagnostic about the dispatched
 * file?" with its OWN predicate instead of the seam — and pins the census
 * shrink-only.
 *
 * The recurrence it prevents is #209 / #3277 / #3278: a runner compares the
 * tool's spelling of the edited file against the dispatcher's with `===`,
 * `!==`, `endsWith` or a basename, so a spelling that differs only in case
 * (the SAME file on Windows and on a case-folding POSIX mount) drops every
 * finding for that file and the run is reported clean — or, in the `endsWith`
 * and basename directions, a DIFFERENT file's finding is attributed to it. The
 * sanctioned spelling is
 * `pathsEqual(path.resolve(<the cwd the tool ran in>, reported), absTarget)`.
 *
 * It also closes `path-key-fold-sweep`'s `PATH_CALL` blind spot for this
 * family (#3278 criterion 4): that needle requires a `path.`/`win32.`/`posix.`
 * qualifier, and several runners import `resolve`/`join` BARE from
 * `node:path` — measured on `go-vet.ts`, where the qualified needle matched 0
 * and the bare call was the live one. `PATH_CALL_HERE` below matches both.
 *
 * Detector hygiene (AGENTS.md defect shape 38): the scan runs over
 * comment-and-string-blanked source, so a comment or string copy of the needle
 * can neither create a finding nor launder one away. A comparison against a
 * blanked string LITERAL is skipped by a per-needle policy documented at
 * `LITERAL_OPERAND` — lowercasing or comparing a basename against `".bin"` or
 * `"dockerfile"` is file-KIND detection, a different transformation with a
 * different correctness argument.
 */

import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	codeMatches,
	escapeRegExp,
	listSourceFiles,
	matchingCloseIndex,
	matchingOpenIndex,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const RUNNERS_ROOT = path.resolve(REPO_ROOT, "clients/dispatch/runners");

/**
 * #3286 widened the population: the family is NOT confined to
 * `clients/dispatch/runners/**`. A tool's autofix half lives in its
 * `clients/<tool>-client.ts`, and `ruff-client.ts` held the same bare `!==` over
 * two `path.resolve` results that nine runners held — invisible to this sweep
 * and to #3284's grep, both of which stopped at the runners directory, so it
 * shipped as the #3278 remainder instead of being caught.
 *
 * The rule is the GLOB, not a list of names: every `clients/*-client.ts` is in,
 * so a new tool client joins the population by existing. MEASURED cost of the
 * widening over the 18 tool clients, rather than the ~15 exemption rows #3286
 * predicted for all of `clients/`: the census flags TWO sites — the
 * `ruff-client.ts` member this round folds, and one non-member registered in
 * `NON_MEMBER_PINS` below. The detector's own policies (`LITERAL_OPERAND`, the
 * `relative`/`dirname` exclusions) already drop the containment, walk-up and
 * file-KIND shapes that made the prediction pessimistic.
 *
 * Nested directories (`clients/lsp/`, `clients/mcp/`, …) hold no `*-client.ts`
 * today and are excluded rather than silently in: a client under one of them
 * would be a new population question, not an automatic member.
 */
const CLIENTS_ROOT = path.resolve(REPO_ROOT, "clients");
const TOOL_CLIENT_SUFFIX = "-client.ts";

/**
 * A string or template-literal operand. Comparing a path against a LITERAL is
 * never reported-path identity: it is kind detection (`=== ".bin"`) or
 * containment (`!== ".."`, `startsWith("../")`). String contents are blanked by
 * `stripForScan`, so the opening quote or backtick is what survives — a
 * template with a live `${…}` interpolation still starts with a backtick.
 */
const LITERAL_OPERAND = /^\s*(?:"|'|`)/;

/**
 * A call that produces a whole-path IDENTITY, with the `path.`/`win32.`/`posix.`
 * qualifier OPTIONAL so a bare `resolve(`/`join(` imported from `node:path`
 * counts — the blind spot `path-key-fold-sweep`'s `PATH_CALL` has, measured on
 * `go-vet.ts` (#3278 criterion 4).
 *
 * `relative` and `dirname` are deliberately NOT here. A `path.relative` result
 * is a FRAGMENT used for containment (`helm-lint.ts`'s `isWithin`,
 * `go-vet.ts`'s `fileRel.startsWith("../")`) and a `path.dirname` result is a
 * walk cursor (`shellcheck.ts`/`vale.ts`'s `parent === current` termination) —
 * different questions with different correctness arguments, and no member of
 * this family was ever written with either. `basename` IS here: it is
 * `cue-vet.ts`'s own over-merge shape.
 */
const PATH_CALL_HERE =
	/\b(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*\(/;

const PATH_CALLEE =
	/(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*$/;

/**
 * A local whose initializer IS such a call: `const resolvedTarget =
 * path.resolve(filePath);`. Six of #3278's members wrote the comparison in TWO
 * statements, so both operands are plain identifiers and an adjacency-only
 * needle sees nothing — measured: the first draft of this sweep flagged 5 of the
 * 9 live members and silently missed `javac`, `zig-check`, `cpp-check` and
 * `dotnet-build`. One hop of local dataflow is what closes that.
 */
const PATH_DERIVED_DECL =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:path|win32|posix)\s*\.\s*)?(?:resolve|normalize|basename|join)\s*\(/g;

/** The two operators this family compares with. */
const IDENTITY_COMPARISON = /===|!==/g;
const SUFFIX_COMPARISON = /\.\s*(?:endsWith|startsWith)\s*\(/g;

/**
 * The second family spelling: hand-fold the separators, THEN compare — the shape
 * `dart-analyze.ts` carried until #3278 and `gleam-check.ts` until #3285.
 * Matched on RAW source through `codeMatches` because the needle IS a regex
 * literal, whose body string-blanking erases (the same mechanism
 * `path-key-fold-sweep`'s shape A uses), while `codeMatches` still drops any
 * match whose span is a comment or a string.
 */
const SLASH_FOLD_COMPARE =
	/\.replace\(\s*\/\\\\\/g\s*,\s*["'`]\/["'`]\s*\)\s*(?:\.\s*(?:endsWith|startsWith)\s*\(|===|!==)/g;

function stripForScan(source: string): string {
	return stripSource(source, { strings: "blank" });
}

/**
 * ── The NO-PREDICATE direction of this census (#3295), INVERTED ───────────────
 *
 * Rounds 1 and 2 of #3304 both enumerated this direction by SHAPE and both
 * missed a member. Round 1 listed the location captures it knew
 * (`:(\d+):(\d+)`) and missed `shellcheck`'s `item.file` and `trivy-config`'s
 * `resultEntry.Target`. Round 2 listed those two JSON fields BY NAME and missed
 * `stylelint`'s `result.source`, which a real `dispatchForFile` probe delivered
 * as the dispatched file — plus `vale`'s map KEY, `rubocop`'s `file.path`,
 * `eslint`'s `fileResult.filePath`, `biome-check`'s `d.location.path`,
 * `tflint`'s `issue.range.filename`, `swiftlint`/`ktlint`/`hadolint`'s
 * `item.file`, `actionlint`'s `issue.filepath`, `spellcheck`'s `parsed.path`,
 * `sqlfluff`'s `item.filepath`, `markdownlint`'s `^.*?:` prefix, `php-lint`'s
 * `in <file> on line`, and the SHARED diagnostic factory in
 * `utils/diagnostic-parsers.ts`, whose own docstring says the regex "Must
 * capture: [fullMatch, file?, line?, col?, ...]" and which then drops
 * `match[1]` on the floor.
 *
 * A list of field names can only ever catch the fields someone remembered. So
 * this detector names NO path field and NO location shape. A file is a member
 * when all three hold:
 *
 * 1. it CONSTRUCTS a diagnostic — an object literal carrying `tool:` (the
 *    `Diagnostic` discriminator every runner and the shared factory write) that
 *    also carries a `filePath` property;
 * 2. that `filePath` is the DISPATCHED path, not something read out of the
 *    tool's output — either `ctx.filePath`, or an identifier this file never
 *    declares, which is therefore the parse function's own path PARAMETER;
 * 3. it PARSES tool output ({@link PARSE_MARKERS}), and
 * 4. it holds no `pathsEqual(` call in comment-and-string-blanked source.
 *
 * Direction 2 is what separates a blanket stamp from the attribute policy:
 * `mypy.ts` writes the same `filePath,` shorthand, but over a LOCAL
 * `const filePath = path.resolve(cwd, reported)`, so its declaration is right
 * there in the file and the site reads as what it is. Same for `spotbugs.ts`'s
 * `let filePath` from `<SourceLine sourcepath=…>`. `helm-lint.ts`,
 * `credo.ts`, `phpstan.ts`, `ruff.ts`, `pyright.ts` and `lsp.ts` write a
 * non-identifier expression that reads the reported path, and are non-members
 * for the same reason.
 *
 * KNOWN LIMIT, pinned rather than papered over: this detector cannot prove the
 * OPERANDS of a `pathsEqual(` call. A runner that called `pathsEqual` on two
 * unrelated paths would launder itself out of this census. That direction is
 * covered by the sibling census in this file (which counts local predicates,
 * and would flag a hand-rolled compare) and by the per-member own-file /
 * sibling-file cells in
 * `tests/clients/dispatch/runners/reported-path-attribution.test.ts`, whose
 * mutation signature is the delivered diagnostic, not the call's spelling.
 * `LAUNDERING_LIMIT` below asserts the limit so it cannot be forgotten.
 */
const PARSE_MARKERS: ReadonlyArray<{
	readonly id: string;
	readonly needle: RegExp;
}> = [
	/**
	 * Every JSON reporter. Catches actionlint, biome-check, credo, eslint,
	 * golangci-lint, hadolint, ktlint, oxlint, phpstan, psscriptanalyzer,
	 * pyright, rubocop, ruff, rust-clippy, shellcheck, spellcheck, sqlfluff,
	 * stylelint, swiftlint, terragrunt, tflint, trivy-config, vale.
	 */
	{ id: "json", needle: /\bJSON\.parse\s*\(/ },
	/**
	 * Every regex parse of textual output. Catches biome-check, cue-vet,
	 * elixir-check, fish-indent, gleam-check, go-vet, helm-lint, helm-render,
	 * htmlhint, javac, markdownlint, oxlint, php-lint, prisma-validate, shfmt,
	 * spotbugs, taplo, utils/diagnostic-parsers, yamllint, zig-check.
	 */
	{ id: "capture", needle: /\.\s*(?:match|matchAll)\s*\(|\.\s*exec\s*\(/ },
	/**
	 * Line-splitting over a captured stream. Catches cpp-check, dart-analyze,
	 * dotnet-build, fish-indent, go-vet, markdownlint, shfmt, spellcheck,
	 * taplo, utils/diagnostic-parsers, yamllint — and anything that walks
	 * stdout by hand instead of matching it.
	 */
	{ id: "lines", needle: /\.\s*split\s*\(\s*(?:\/|"|'|`)/ },
	/**
	 * A SARIF / scanner report envelope, whose findings hang off `Results` or
	 * `runs[].results`. Catches trivy-config; present so a future SARIF
	 * consumer joins the population without a detector change.
	 */
	{ id: "report", needle: /\.\s*(?:[Rr]esults|runs)\b/ },
];

/** The `Diagnostic` discriminator every construction site writes. */
/**
 * Where a diagnostic is CONSTRUCTED, structurally rather than lexically
 * (M3304-F9, round 4). Round 3 recognised construction only by an in-file
 * `tool:` object literal, so a parser whose diagnostic is assembled in a HELPER
 * — `out.push(makeRow(filePath, match))`, or a call to the shared factory in
 * `utils/diagnostic-parsers.ts` — had no local `tool:` literal and escaped the
 * census while still parsing tool output and stamping the dispatched path.
 *
 * Three arms, any of which is construction:
 *
 * (a) an object literal carrying `tool:` — the `Diagnostic` discriminator;
 * (b) a call to a diagnostic-producing export of
 *     `clients/dispatch/runners/utils/**` ({@link SANCTIONED_HELPERS}), handed
 *     the dispatched path as an argument;
 * (c) an object literal carrying a `filePath` property that is PUSHED or
 *     RETURNED — a diagnostic whose other fields came from somewhere else and
 *     which therefore never writes `tool:` here.
 *
 * (b)'s list cannot go stale: {@link diagnosticProducingUtilExports} recomputes
 * it from the utils sources on every run and
 * `pins every diagnostic-producing helper the utils modules export` reds when a
 * new export appears that is not registered.
 */
const DIAGNOSTIC_LITERAL = /\btool\s*:/g;

/** An object literal in VALUE position: `push({`, `return {`, `return [{`. */
const DELIVERED_LITERAL = /(?:\.\s*push\s*\(\s*|\breturn\s+\[?\s*)\{/g;

/**
 * A second `Diagnostic` field beside `filePath`, or a spread that supplies the
 * rest of the row. Keeps arm (c) on diagnostics instead of every delivered
 * object that happens to carry a path.
 */
const DIAGNOSTIC_FIELD = /(?:^|[{,\n])\s*(?:message|severity|semantic|\.\.\.)/;

/**
 * `filePath` in KEY position of that literal — shorthand or with a value. The
 * leading `{`/`,`/newline is load-bearing: without it `{ path: filePath, … }`
 * reads its VALUE as a shorthand key, which flagged `clients/knip-client.ts`
 * and `clients/tree-sitter-client.ts` on this round's first measurement.
 */
const DIAGNOSTIC_PATH_PROPERTY = /(?:^|[{,\n])\s*filePath\s*(:|,|\}|\r?\n)/;

/** The dispatch path written out longhand. */
const DISPATCH_PATH_EXPRESSION = /^ctx\s*\.\s*filePath$/;

/** A bare identifier, i.e. a name whose binding decides the question. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const RUNNERS_UTILS_ROOT = path.resolve(RUNNERS_ROOT, "utils");

/**
 * A factory in `utils/**` whose product is a diagnostic parser: a function that
 * RETURNS an arrow annotated `: Diagnostic[] =>`. Recomputed, never pinned by
 * name, so `createLineParser` gaining a sibling does not need an edit here.
 */
const DIAGNOSTIC_FACTORY =
	/\b(?:function|const)\s+([A-Za-z_$][\w$]*)[\s\S]{0,600}?\)\s*:\s*Diagnostic\[\]\s*=>/g;

/** `export function NAME(` — the annotation after its parameter list decides. */
const EXPORTED_FUNCTION =
	/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** `export const NAME = callee(` — the callee decides. */
const EXPORTED_CONST_CALL =
	/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * The `{ … }` containing `index`, as `[open, close]`, or `null`. Walks back over
 * ALREADY-STRIPPED source, so a brace inside a comment or a string cannot move
 * the boundary.
 */
function enclosingBraceSpan(
	stripped: string,
	index: number,
): [number, number] | null {
	let depth = 0;
	let open = -1;
	for (let i = index; i >= 0; i--) {
		const ch = stripped[i];
		if (ch === "}") depth += 1;
		else if (ch === "{") {
			if (depth === 0) {
				open = i;
				break;
			}
			depth -= 1;
		}
	}
	if (open < 0) return null;
	const close = matchingCloseIndex(stripped, open, "{", "}");
	return close === -1 ? null : [open, close];
}

/** The property VALUE starting at `from`, up to this literal's next `,` at depth 0. */
function propertyValue(stripped: string, from: number, close: number): string {
	let depth = 0;
	for (let i = from; i < close; i++) {
		const ch = stripped[i];
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		else if (ch === "," && depth === 0) return stripped.slice(from, i).trim();
	}
	return stripped.slice(from, close).trim();
}

/** Does this file DECLARE `name`? A declared name is a local the parser derived. */
function declaresLocal(stripped: string, name: string): boolean {
	return new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\b`).test(
		stripped,
	);
}

/** Is this expression the dispatched path rather than something parsed? */
function isDispatchPath(stripped: string, expression: string): boolean {
	const value = expression.trim();
	if (DISPATCH_PATH_EXPRESSION.test(value)) return true;
	return BARE_IDENTIFIER.test(value) && !declaresLocal(stripped, value);
}

/**
 * The exports of `clients/dispatch/runners/utils/**` that PRODUCE diagnostics,
 * recomputed from source: an exported function whose return annotation names
 * `Diagnostic`, or an exported const initialized by a diagnostic FACTORY.
 */
export function diagnosticProducingUtilExports(): string[] {
	const names = new Set<string>();
	const files = listSourceFiles(RUNNERS_UTILS_ROOT, { extensions: [".ts"] });
	for (const { source } of readWalkedFiles(files)) {
		const stripped = stripForScan(source);
		const factories = new Set<string>();
		for (const match of stripped.matchAll(DIAGNOSTIC_FACTORY))
			factories.add(match[1]!);
		for (const match of stripped.matchAll(EXPORTED_FUNCTION)) {
			const open = (match.index ?? 0) + match[0].length - 1;
			let depth = 0;
			let close = open;
			for (let i = open; i < stripped.length; i++) {
				if (stripped[i] === "(") depth += 1;
				else if (stripped[i] === ")") {
					depth -= 1;
					if (depth === 0) {
						close = i;
						break;
					}
				}
			}
			const body = stripped.indexOf("{", close);
			if (body > close && stripped.slice(close, body).includes("Diagnostic"))
				names.add(match[1]!);
		}
		for (const match of stripped.matchAll(EXPORTED_CONST_CALL)) {
			if (factories.has(match[2]!) || match[0].includes("Diagnostic"))
				names.add(match[1]!);
		}
	}
	return [...names].sort();
}

/**
 * Diagnostic-producing helpers a runner may delegate construction to. Pinned so
 * the arm is auditable; the pin is checked against
 * {@link diagnosticProducingUtilExports} on every run, so a new utils export
 * that returns diagnostics cannot silently widen the escape.
 *
 * - `parseRuffOutput` / `parseGoVetOutput` — both are `createLineParser(...)`
 *   products in `clients/dispatch/runners/utils/diagnostic-parsers.ts`, and the
 *   factory builds the whole `Diagnostic` object literal itself. A caller that
 *   hands one of them `ctx.filePath` is constructing a diagnostic stamped with
 *   the dispatched path, with no `tool:` anywhere in its own source.
 */
const SANCTIONED_HELPERS: readonly string[] = [
	"parseGoVetOutput",
	"parseRuffOutput",
];

/** Arm (b): a call to a sanctioned helper handed the dispatched path. */
function delegatesToSanctionedHelper(stripped: string): boolean {
	for (const helper of SANCTIONED_HELPERS) {
		const call = new RegExp(`\\b${escapeRegExp(helper)}\\s*\\(`, "g");
		for (const match of stripped.matchAll(call)) {
			const open = (match.index ?? 0) + match[0].length - 1;
			let depth = 0;
			let close = open;
			for (let i = open; i < stripped.length; i++) {
				if (stripped[i] === "(") depth += 1;
				else if (stripped[i] === ")") {
					depth -= 1;
					if (depth === 0) {
						close = i;
						break;
					}
				}
			}
			const args = stripped.slice(open + 1, close).split(",");
			if (args.some((argument) => isDispatchPath(stripped, argument)))
				return true;
		}
	}
	return false;
}

/**
 * Does this file construct a diagnostic stamped with the DISPATCHED path —
 * rather than with a path read out of the tool's output?
 */
export function stampsDispatchPathOnDiagnostic(source: string): boolean {
	const stripped = stripForScan(source);
	const sites: number[] = [];
	for (const marker of stripped.matchAll(DIAGNOSTIC_LITERAL))
		sites.push(marker.index ?? 0);
	// Arm (c): the literal is DELIVERED — pushed or returned — and carries at
	// least one more `Diagnostic` field, so it is a diagnostic even when its
	// `tool:` came from a spread or a helper. Without the second field this arm
	// also flags `{ filePath, mapped }` result records and `logLatency` rows
	// (measured: `clients/dispatch/runners/helm-render.ts`).
	for (const marker of stripped.matchAll(DELIVERED_LITERAL)) {
		const at = (marker.index ?? 0) + marker[0].length;
		const span = enclosingBraceSpan(stripped, at);
		if (!span) continue;
		if (DIAGNOSTIC_FIELD.test(stripped.slice(span[0], span[1]))) sites.push(at);
	}

	for (const site of sites) {
		const span = enclosingBraceSpan(stripped, site);
		if (!span) continue;
		const [open, close] = span;
		const body = stripped.slice(open, close);
		const property = DIAGNOSTIC_PATH_PROPERTY.exec(body);
		if (!property) continue;
		const at = open + (property.index ?? 0);
		if (property[1] !== ":") {
			// Shorthand `filePath,` — the binding is `filePath` itself.
			if (!declaresLocal(stripped, "filePath")) return true;
			continue;
		}
		if (
			isDispatchPath(
				stripped,
				propertyValue(stripped, at + property[0].length, close),
			)
		)
			return true;
	}
	// Arm (b): construction delegated to a diagnostic-producing utils export.
	return delegatesToSanctionedHelper(stripped);
}

/** Which parse markers this file trips, for the census's own report. */
export function parseMarkersIn(source: string): string[] {
	const stripped = stripForScan(source);
	return PARSE_MARKERS.filter((marker) => marker.needle.test(stripped)).map(
		(marker) => marker.id,
	);
}

export function countLocationParsersWithoutPathsEqual(source: string): number {
	const stripped = stripForScan(source);
	return parseMarkersIn(source).length > 0 &&
		stampsDispatchPathOnDiagnostic(source) &&
		!/\bpathsEqual\s*\(/.test(stripped)
		? 1
		: 0;
}

/** Names bound, one hop, to a whole-path call in this file. */
function pathDerivedNames(stripped: string): Set<string> {
	const names = new Set<string>();
	for (const match of stripped.matchAll(PATH_DERIVED_DECL)) names.add(match[1]);
	return names;
}

interface Operand {
	/** The expression IS a path call written right at the operator. */
	inlineCall: boolean;
	/** The expression is a name bound one hop to a path call. */
	derivedName: boolean;
}

/** The expression ENDING at `index` (exclusive). */
function leftOperand(
	stripped: string,
	index: number,
	names: Set<string>,
): Operand {
	const before = stripped.slice(0, index);
	const trimmed = before.trimEnd();
	if (trimmed.endsWith(")")) {
		const open = matchingOpenIndex(stripped, trimmed.length - 1, "(", ")");
		return {
			inlineCall:
				open > 0 &&
				PATH_CALLEE.test(stripped.slice(Math.max(0, open - 40), open)),
			derivedName: false,
		};
	}
	const name = /([A-Za-z_$][\w$]*)$/.exec(trimmed);
	return { inlineCall: false, derivedName: name != null && names.has(name[1]) };
}

/** The expression STARTING at `index`. */
function rightOperand(
	stripped: string,
	index: number,
	names: Set<string>,
): Operand {
	const after = stripped.slice(index, index + 200).trimStart();
	const inlineCall = new RegExp(`^${PATH_CALL_HERE.source}`).test(after);
	const name = /^([A-Za-z_$][\w$]*)/.exec(after);
	return {
		inlineCall,
		derivedName: !inlineCall && name != null && names.has(name[1]),
	};
}

/**
 * Two path expressions compared for identity: either side written as the path
 * call itself, or BOTH sides names bound to one. "One side derived, the other
 * anything" is deliberately NOT enough — that rule flagged the `parent ===
 * current` walk termination in `shellcheck.ts` and `vale.ts`, which is not this
 * family (measured; see PATH_CALL_HERE's doc).
 */
function isFamilyCompare(left: Operand, right: Operand): boolean {
	return (
		left.inlineCall ||
		right.inlineCall ||
		(left.derivedName && right.derivedName)
	);
}

/**
 * Every site in one runner file that decides path identity with its own
 * predicate, keyed on the COMPARISON's position so a site both arms see counts
 * once.
 */
export function countLocalPathIdentityCompares(source: string): number {
	const stripped = stripForScan(source);
	const names = pathDerivedNames(stripped);
	const flagged = new Set<number>();

	for (const match of stripped.matchAll(IDENTITY_COMPARISON)) {
		const at = match.index ?? 0;
		const rightStart = at + match[0].length;
		if (LITERAL_OPERAND.test(stripped.slice(rightStart, rightStart + 8)))
			continue;
		if (
			isFamilyCompare(
				leftOperand(stripped, at, names),
				rightOperand(stripped, rightStart, names),
			)
		) {
			flagged.add(at);
		}
	}

	for (const match of stripped.matchAll(SUFFIX_COMPARISON)) {
		const at = match.index ?? 0;
		const argStart = at + match[0].length;
		if (LITERAL_OPERAND.test(stripped.slice(argStart, argStart + 8))) continue;
		if (
			isFamilyCompare(
				leftOperand(stripped, at, names),
				rightOperand(stripped, argStart, names),
			)
		) {
			flagged.add(at);
		}
	}

	for (const match of codeMatches(source, SLASH_FOLD_COMPARE)) {
		flagged.add(match.index ?? 0);
	}
	return flagged.size;
}

function census(): { counts: Record<string, number>; scanned: number } {
	const files = [
		...listSourceFiles(RUNNERS_ROOT, { extensions: [".ts"] }),
		...listSourceFiles(CLIENTS_ROOT, {
			extensions: [TOOL_CLIENT_SUFFIX],
			exclude: (relative) => relative.includes("/"),
		}),
	];
	const counts: Record<string, number> = {};
	let scanned = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		scanned += 1;
		const count = countLocalPathIdentityCompares(source);
		if (count > 0) counts[relativePosix(REPO_ROOT, file)] = count;
	}
	return { counts, scanned };
}

const REMEDIATION =
	"A runner or tool client decides reported-path identity with its own " +
	"predicate. Route it " +
	"through `pathsEqual(path.resolve(<the cwd the tool ran in>, reported), " +
	"absTarget)` (clients/path-utils.ts) and shrink this pin. Refs #3278.";

/**
 * The remaining local predicates, file → count. Shrink-only: `auditSymbolCounts`
 * fails on movement in EITHER direction, so restoring a member's deleted
 * compare, adding one in a new runner or tool client, and removing one without
 * shrinking the pin all red.
 *
 * EMPTY since #3285/#3286: the family has no member left that decides
 * reported-path identity for itself.
 *
 * `gleam-check.ts` held the last runner row (`@1`,
 * `!sourcePath.replace(…).endsWith(filePath.replace(…))`) because its
 * `endsWith` was LOAD-BEARING for codespan's `┌─` locus gutter and #3284 had no
 * captured gleam output to establish that gutter from. #3285 established it from
 * gleam v1.18.1 + codespan-reporting 0.13.1, moved the gutter out of the
 * location CAPTURE, and folded the compare; `clients/ruff-client.ts` was added
 * to the population by the widening above and folded in the same round (#3286).
 */
const LOCAL_COMPARE_PINS: Readonly<Record<string, number>> = {};

/**
 * Exact shrink-only pin for parsers the inverted detector flags that are NOT
 * members: the tool output they parse carries NO per-diagnostic path for the
 * site that stamps the dispatched file. Each is registered by name with the
 * reason MEASURED from the runner's own source — never a silent skip, so a file
 * that grows a real reported path here presents a count of 1 against a pin of 1
 * and the per-runner dispatch cells are what must then change.
 *
 * - `fish-indent.ts@1` — `/\(line\s+(\d+)\)/` over the first non-blank stderr
 *   line. The matched span holds a parse POSITION and no path token;
 *   `fish_indent --check` is handed exactly one file.
 * - `shfmt.ts@1` — `/^@@\s+-(\d+)/m` over a unified diff BODY. The only path in
 *   `--diff` output is the `---`/`+++` echo of our own argv, which this parser
 *   never reads.
 * - `prisma-validate.ts@1` — `/:(\d+)(?::\d+)?\b/` over the whole output, with
 *   no path token in the matched span. Adding a path capture would change which
 *   `:N` in a free-form error wins, on a format this tree holds no captured
 *   upstream vector for.
 * - `psscriptanalyzer.ts@1` — the runner's own `PS_SCRIPT` runs
 *   `Select-Object RuleName,Severity,Line,Column,Message`, so the path is
 *   PROJECTED AWAY before `ConvertTo-Json`: no path can reach the parser.
 * - `ruff.ts@1` — flagged by ARM (b) in round 4: it hands `ctx.filePath` to
 *   `parseRuffOutput`, the shared factory's product, and holds no `pathsEqual`
 *   of its own. Both of its arms are covered: the JSON arm attributes each
 *   diagnostic to `item.filename || filePath` (the reported path, not a blanket
 *   stamp), and the TEXT arm delegates to `parseRuffOutput`, whose predicate
 *   lives in `utils/diagnostic-parsers.ts` — itself in this census population,
 *   so removing it reds there — and is mutation-proved by the
 *   `diagnostic-parsers` cells in
 *   `tests/clients/dispatch/runners/reported-path-attribution.test.ts`.
 * - `phpstan.ts@1` — the flagged stamp is the `output.errors[]` arm, phpstan's
 *   FILE-INDEPENDENT findings (internal errors, ignore patterns that matched
 *   nothing). Those carry no file at all and attach to the edited file at line 1
 *   by the documented #1937-round-2 decision. The `output.files` arm right above
 *   it already attributes each error to its OWN key resolved against the runner
 *   cwd (#265 A3), which is the attribute policy, not a blanket stamp.
 */
const NO_PREDICATE_PINS: Readonly<Record<string, number>> = {
	"clients/dispatch/runners/fish-indent.ts": 1,
	"clients/dispatch/runners/phpstan.ts": 1,
	"clients/dispatch/runners/prisma-validate.ts": 1,
	"clients/dispatch/runners/psscriptanalyzer.ts": 1,
	"clients/dispatch/runners/ruff.ts": 1,
	"clients/dispatch/runners/shfmt.ts": 1,
};

/**
 * Sites the detector flags that are NOT members of this family: BOTH operands
 * are directories this process derived from its own `path.resolve`, with no
 * tool output on either side. Registered, never silenced — the count is pinned
 * the same shrink-only way, so a real member landing in one of these files
 * presents a different id and reds.
 *
 * - `clients/test-runner-client.ts@1` — `path.resolve(root) !== dispatch`
 *   (`clients/test-runner-client.ts:832`) asks "is the anchored LANGUAGE root a
 *   different directory from the dispatch root?" so the runner-detection ladder
 *   does not probe the same directory twice (#2879 round 2, F1). Neither side is
 *   a reported path, and a case-variant answer costs one idempotent re-probe,
 *   not a dropped finding — the whole cost of #3286's population widening.
 */
const NON_MEMBER_PINS: Readonly<Record<string, number>> = {
	"clients/test-runner-client.ts": 1,
};

function stalePins(
	counts: Record<string, number>,
	pins: Readonly<Record<string, number>>,
): string[] {
	return Object.entries(pins)
		.filter(([file, pinned]) => (counts[file] ?? 0) !== pinned)
		.map(([file, pinned]) => `${file}@${pinned} -> ${counts[file] ?? 0}`);
}

describe("runner reported-path attribution single-source-of-truth (#3278)", () => {
	it("has no unpinned local reported-path compare in any runner or tool client", () => {
		const { counts, scanned } = census();
		assertNonEmptyScan(
			"clients/dispatch/runners + clients/*-client.ts source files",
			scanned,
			78,
		);
		const pinned = { ...LOCAL_COMPARE_PINS, ...NON_MEMBER_PINS };
		const audit = auditSymbolCounts({
			sweepName: "local reported-path compare (#3278)",
			counts,
			pinned,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(counts, pinned),
			"a pinned local compare is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("has no unpinned location parser without pathsEqual (#3295)", () => {
		const counts: Record<string, number> = {};
		const files = [
			...listSourceFiles(RUNNERS_ROOT, { extensions: [".ts"] }),
			...listSourceFiles(CLIENTS_ROOT, {
				extensions: [TOOL_CLIENT_SUFFIX],
				exclude: (relative) => relative.includes("/"),
			}),
		];
		for (const { file, source } of readWalkedFiles(files)) {
			const count = countLocationParsersWithoutPathsEqual(source);
			if (count > 0) counts[relativePosix(REPO_ROOT, file)] = count;
		}
		const audit = auditSymbolCounts({
			sweepName: "location parser without reported-path predicate (#3295)",
			counts,
			pinned: NO_PREDICATE_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(counts, NO_PREDICATE_PINS),
			"a pinned non-member grew a predicate or stopped parsing — shrink the pin",
		).toEqual([]);
	});

	// The detector's own teeth, in both directions, on synthetic source: without
	// these the sweep could silently stop matching and read as "family clean".
	it("detects every spelling the family has actually shipped", () => {
		expect(
			countLocalPathIdentityCompares(
				"const a = path.resolve(reported);\n" +
					"const b = path.resolve(filePath);\n" +
					"if (a !== b) continue;",
			),
			"the TWO-statement form — javac, zig-check, cpp-check, dotnet-build",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (path.resolve(reported) !== absTarget) continue;",
			),
			"inline qualified call on the left (detekt)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"const keep = resolve(cwd, m[1]) === absTarget;",
			),
			"bare `resolve` import — path-key-fold-sweep's PATH_CALL blind spot",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (absEdited === resolve(d.filePath)) keep();",
			),
			"the call on the RIGHT of the comparison (rust-clippy)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"return path.posix.basename(normalized) === fileName;",
			),
			"the basename over-merge (cue-vet)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (!sourcePath.endsWith(path.resolve(filePath))) continue;",
			),
			"the call as the endsWith ARGUMENT",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				"if (!path.resolve(file).endsWith(target)) continue;",
			),
			"endsWith hung off the call (dart-analyze's deleted outer arm)",
		).toBe(1);
		expect(
			countLocalPathIdentityCompares(
				'if (!a.replace(/\\\\/g, "/").endsWith(b.replace(/\\\\/g, "/"))) x();',
			),
			"hand-fold the separators, then compare (gleam-check's, until #3285)",
		).toBe(1);
	});

	it("does not fire on the sanctioned spelling, on neighbouring path idioms, or on prose", () => {
		expect(
			countLocalPathIdentityCompares(
				"if (!pathsEqual(path.resolve(cwd, reported), absTarget)) continue;",
			),
			"the seam this sweep exists to drive callers onto",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"let current = path.resolve(cwd);\n" +
					"const parent = path.dirname(current);\n" +
					"if (parent === current) break;",
			),
			"walk-up termination (shellcheck.ts, vale.ts) — not this family",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"const relative = path.relative(root, candidate);\n" +
					'return relative === "" || !relative.startsWith("..");',
			),
			"containment (helm-lint.ts's isWithin, helm-render.ts) — not this family",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				'if (path.basename(filePath).toLowerCase() === "dockerfile") return;',
			),
			"file-KIND detection against a literal (LITERAL_OPERAND policy)",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				"// if (path.resolve(reported) !== absTarget) continue;",
			),
			"a comment copy of the needle must never create a finding",
		).toBe(0);
		expect(
			countLocalPathIdentityCompares(
				'const doc = "path.resolve(reported) !== absTarget";',
			),
			"a string copy of the needle must never create a finding",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				readFileSync(
					path.resolve(
						REPO_ROOT,
						"tests/fixtures/reported-path-attribution/sanctioned.ts",
					),
					"utf8",
				),
			),
			"the seam this census exists to drive parsers onto",
		).toBe(0);
	});

	/**
	 * The inverted detector's own teeth (#3295 round 3). Rounds 1 and 2 each
	 * shipped a detector that enumerated path SHAPES and each missed a live
	 * member, so these cells assert the three conjuncts independently — a
	 * detector that silently stopped matching one of them would read as "census
	 * clean" over the same 79 files.
	 */
	it("flags a diagnostic built from parsed output with no reported-path predicate", () => {
		const member =
			"const parsed = JSON.parse(raw) as Array<{ source?: string }>;\n" +
			"for (const r of parsed) {\n" +
			"  out.push({ id: r.source, message: m, filePath, tool: 'x' });\n" +
			"}";
		expect(
			countLocationParsersWithoutPathsEqual(member),
			"JSON.parse + a diagnostic stamped with the path PARAMETER",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const m = line.match(/^(.*?):(\\d+)/);\n" +
					"out.push({ id: m[1], filePath: ctx.filePath, tool: 'x' });",
			),
			"a regex capture + the dispatch path written out longhand",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const lines = raw.split('\\n');\n" +
					"out.push({ id: lines[0], filePath, tool: 'x' });",
			),
			"a hand-walked stdout split is a parse marker too",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const entries = report.Results ?? [];\n" +
					"out.push({ id: entries[0], filePath, tool: 'x' });",
			),
			"a SARIF/scanner report envelope is a parse marker too",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				readFileSync(
					path.resolve(
						REPO_ROOT,
						"tests/fixtures/reported-path-attribution/no-predicate.ts",
					),
					"utf8",
				),
			),
			"a comment copy AND a string copy of `pathsEqual` must not self-excuse",
		).toBe(1);
	});

	it("does not flag a parser that attributes to the path the tool reported", () => {
		expect(
			countLocationParsersWithoutPathsEqual(
				"const parsed = JSON.parse(raw);\n" +
					"for (const e of parsed) {\n" +
					"  const filePath = path.resolve(cwd, e.file);\n" +
					"  out.push({ id: e.id, filePath, tool: 'x' });\n" +
					"}",
			),
			"mypy/spotbugs: the shorthand is a LOCAL derived from the reported path",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const parsed = JSON.parse(raw);\n" +
					"out.push({ id: 1, filePath: parsed.file || fallback, tool: 'x' });",
			),
			"ruff/pyright/credo: the value expression reads the reported path",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const m = raw.match(/^(.*?):(\\d+)/);\n" +
					"logAvailabilityDecision({ tool: 'x', verdict: 'available' });",
			),
			"a non-diagnostic literal carrying `tool:` is not a construction site",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				"out.push({ id: 1, filePath, tool: 'x' });",
			),
			"a diagnostic built with no tool output parsed at all is not a member",
		).toBe(0);
	});

	/**
	 * The detector's NAMED limit (AGENTS.md "detectors match code, not prose"):
	 * it proves a `pathsEqual(` CALL exists, never that its operands are the
	 * reported path and the dispatch target. This cell pins the hole so nobody
	 * reads the census as stronger than it is; the direction it cannot see is
	 * covered by the sibling local-compare census above and by the per-runner
	 * own-file / sibling-file cells in
	 * `tests/clients/dispatch/runners/reported-path-attribution.test.ts`, whose
	 * signature is the DELIVERED diagnostic.
	 */
	/**
	 * M3304-F9: "builds a diagnostic" must be STRUCTURAL, not lexical. Round 3
	 * recognised only an in-file `tool:` literal, so a parser that delegates
	 * construction to a helper escaped the census entirely.
	 */
	it("flags a parser whose diagnostic is built in a sanctioned helper", () => {
		expect(
			countLocationParsersWithoutPathsEqual(
				readFileSync(
					path.resolve(
						REPO_ROOT,
						"tests/fixtures/reported-path-attribution/helper-built.ts",
					),
					"utf8",
				),
			),
			"arm (b): no `tool:` literal, construction delegated to parseRuffOutput",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const rows = raw.split('\\n');\n" +
					"out.push({ ...base, filePath, message: rows[0] });",
			),
			"arm (c): a DELIVERED literal whose other fields came from a spread",
		).toBe(1);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const rows = raw.split('\\n');\n" +
					"return { filePath, mapped: rows.length > 0 };",
			),
			"arm (c) stays on diagnostics: a delivered result record is not one",
		).toBe(0);
		expect(
			countLocationParsersWithoutPathsEqual(
				"const parsed = JSON.parse(raw);\n" +
					"return { path: filePath, mtimeMs: parsed.m, size: parsed.s };",
			),
			"`filePath` in VALUE position is not a `filePath` KEY (knip-client)",
		).toBe(0);
	});

	/**
	 * The arm-(b) list cannot go stale: it is recomputed from the utils sources
	 * on every run, so a NEW export that returns diagnostics reds here until it
	 * is registered — the failure mode that let three shapes through in rounds
	 * 1-3 was exactly a hand-maintained list of names.
	 */
	it("pins every diagnostic-producing helper the utils modules export", () => {
		expect(diagnosticProducingUtilExports()).toEqual([...SANCTIONED_HELPERS]);
	});

	it("cannot see through a pathsEqual call on unrelated operands (named limit)", () => {
		expect(
			countLocationParsersWithoutPathsEqual(
				"const parsed = JSON.parse(raw);\n" +
					"if (pathsEqual(cwd, cwd)) { /* unrelated operands */ }\n" +
					"out.push({ id: 1, filePath, tool: 'x' });",
			),
			"KNOWN LIMIT: operand-blind. Behaviour is pinned by the dispatch cells.",
		).toBe(0);
	});
});
