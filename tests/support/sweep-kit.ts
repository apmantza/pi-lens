/**
 * Shared machinery for this repo's registered-or-fail sweeps — #1755.
 *
 * Seven sweeps now guard pi-lens (session-state conformance, the
 * finding-delivery registry #1692, the host-event shape scan #1706, the
 * hardcoded-machine-paths guard #1735, the ast-grep self-scan #1729, the
 * changelog guard, and the charter/telemetry sweeps #1741/#1743). Each one
 * hand-rolled the same four pieces, and each one re-learned the same lessons
 * in review. This module owns those four pieces once:
 *
 * 1. **Source scanning.** One comment/string stripper ({@link stripSource}),
 *    with the string policy as a caller option — #1692 needs string contents
 *    INTACT because a surface's evidence is often itself a string argument,
 *    while the session-state walk needs them BLANKED so a call named inside a
 *    string is not read as a call.
 * 2. **Registry semantics.** Registered-or-fail, exemptions that require a
 *    reason, and stale-entry self-detection ({@link auditRegistry}).
 * 3. **Tag and evidence binding.** One seam per tag, call-shaped needles, and
 *    nearest-exclusive assignment with a declared claim capacity — #1692's
 *    final algorithm, lifted rather than re-derived
 *    ({@link scanTaggedSeams}, {@link assignNearestExclusive},
 *    {@link checkSeamEvidence}).
 * 4. **The emptiness guard.** A sweep that scans zero files or matches zero
 *    registry entries FAILS ({@link assertNonEmptyScan}). AGENTS.md defect
 *    shape 10, the #1718 lesson: a dead sweep must never read as clean.
 *
 * ## The attack catalogue this kit inherits
 *
 * #1692 paid four review rounds for these. A sweep built on this kit gets the
 * defenses for free; a sweep that re-implements the machinery pays again.
 * `tests/support/sweep-kit.test.ts` carries one NAMED fixture per attack, so
 * a future sweep author reads the threat model out of the tests.
 *
 * - **Comment/string laundering** (#1635 R1, #1692 F1). A call or declaration
 *    named only in a comment or a string is not one. Defense: strip before
 *    you scan, and pick the string policy deliberately.
 * - **Keyword-position regex** (#1635 R2). `typeof /resetX()/` mis-lexes as
 *    division under a preceding-CHARACTER check, leaving the regex body
 *    unstripped and a phantom call visible. Defense: decide regex position
 *    from the preceding TOKEN.
 * - **Proximity laundering** (#1692 R1a). A new untagged seam pasted right
 *    after a tagged one inherits its tag under any lookback window. Defense:
 *    bind to exactly the immediately-preceding non-blank line, and let each
 *    tag line bind at most one seam ({@link bindTagsToSeams}).
 * - **Valid-tag laundering** (#1692 R1b). A rogue seam wearing a REAL id
 *    passes a whole-file evidence search, because that id's evidence lives
 *    somewhere else. Defense: bound the evidence search to the seam's own
 *    region.
 * - **Region overlap / close-range laundering** (#1692 R1c). A rogue seam
 *    placed inside the real seam's window shares the one real occurrence, and
 *    a per-region check clears both. Defense: nearest-EXCLUSIVE assignment
 *    with a declared claim capacity ({@link assignNearestExclusive}).
 * - **Identity-stub laundering** (#1692 R2). Keep the evidence ARGUMENT
 *    (`store: "gitleaks"`) and swap the callee for an identity stub. Defense:
 *    require a call-shaped occurrence of a declared callee within a tight
 *    window of the claimed occurrence.
 * - **Stale allowlist** (#1735). An allowlist entry whose file no longer
 *    matches the sweep is dead weight that reads as a screen. Defense:
 *    {@link auditRegistry} reports it ({@link RegistryAudit.staleExemptions}).
 * - **Dead scan** (#1718, #1729). Zero files scanned, or zero rules resolved,
 *    reports as a clean run. Defense: {@link assertNonEmptyScan}, and
 *    {@link auditRegistry}'s two SEPARATE floors — `minScanned` for "the walk
 *    found nothing to look at" and `minFlagged` for "the walk was healthy but
 *    the detector matched nothing". Same symptom, two causes, two fixes, so
 *    they never share a message (#1755 review F4).
 * - **Prototype-chain exemption** (#1755 review F1). An item named `toString`,
 *    `constructor`, `valueOf` or `__proto__` satisfies `item in exemptions`
 *    against a map that never mentions it, and the stale-exemption check reads
 *    own keys only, so it cannot report the phantom. Defense: `Object.hasOwn`.
 * - **Misplaced tag** (#1755 review F2/F3). A tag far above its seam across a
 *    run of blank lines, or written inline at the end of a seam line where it
 *    silently tags the NEXT seam instead. Defense: a bounded blank-line gap
 *    (`maxBlankGap`, default 1) and outright rejection of inline tags — see
 *    {@link bindTagsToSeams}.
 * - **Positional-ordinal disambiguation** (#2487 review round 3). A prior
 *    version of this kit shipped `disambiguateFlaggedKeys`, which numbered
 *    colliding occurrences `key`, `key#2`, `key#3`, ... by SCAN POSITION, not
 *    by occurrence identity. A new colliding call inserted BETWEEN two already
 *    exempted ones shifts every ordinal after it, so an exemption reasoned
 *    about one call site silently rides a different one — one round it failed
 *    loud with no file:line to act on, another round it stayed fully green
 *    while an unreviewed unbounded call shipped. Removed outright: fix the
 *    KEY GENERATOR so genuinely distinct call sites derive genuinely distinct
 *    keys (`tests/config/sync-child-process-timeout.test.ts`'s `exemptionKey`
 *    now matches each call's own ARGUMENTS against a discriminating snippet,
 *    not a position-dependent ordinal), and let `requireUniqueFlagged` fail
 *    loud — by file:line, via `FlaggedEntry.detail` — on any collision the
 *    generator still produces.
 *
 * ## Known limits, named rather than papered over
 *
 * - {@link listSourceFiles}'s `exclude` filters FILES only. It never prunes a
 *   directory walk, so excluding `vendor/x.ts` still descends into `vendor/`.
 *   That is cheap on these trees; a sweep over a `node_modules`-sized tree
 *   needs directory pruning this kit does not offer (#1755 review F5).
 * - RESOLVED by #2502: under `strings: "blank"`, a call written inside a
 *   TEMPLATE EXPRESSION (`` `${resetThing()}` ``) used to be blanked with the
 *   rest of the template — a false NEGATIVE, the direction that matters for a
 *   guard, and the noted reason a reachability walk couldn't see it. Fixing
 *   `${` nesting depth (below) required lexing the expression as real code
 *   rather than opaque text, which makes it visible to a `"blank"`-policy scan
 *   the same as any other code — the limitation is gone, not just narrowed.
 *
 * This module is deliberately STATELESS — no module-level caches, no latches.
 * A sweep helper that memoized its own scan would be exactly the
 * process-lifetime-state shape the session-state sweep exists to catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { lineContentHash } from "../../clients/read-guard.js";
import { toPosix } from "../../clients/path-utils.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
// Re-exported for test doubles/helpers so the test side has ONE import to
// reach for instead of hand-copying the escaping body (#2558). This is the
// ONE test-side re-export; the runtime copy lives in clients/string-utils.ts.
export { escapeRegExp } from "../../clients/string-utils.js";

// ── 1. Source scanning ──────────────────────────────────────────────────────

/** What {@link stripSource} does with string and template literal CONTENTS. */
type StringPolicy =
	/**
	 * Blank string/template contents along with comments (delimiters kept).
	 * Use when a bare identifier inside a string must not read as code — the
	 * session-state reachability walk's requirement.
	 */
	| "blank"
	/**
	 * Keep string/template contents verbatim; blank only comments. Use when the
	 * thing you search for is itself a string or template fragment — #1692's
	 * evidence needles (`store: "gitleaks"`, `${trivyAgeLabel}`).
	 */
	| "keep";

export interface StripOptions {
	/** Default `"blank"`. */
	strings?: StringPolicy;
}

const KEYWORDS_BEFORE_REGEX = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"case",
	"await",
	"yield",
	"delete",
	"void",
	"new",
	"do",
	"else",
	"throw",
]);

/**
 * Blank comments — and, under `strings: "blank"`, string and template literal
 * contents — IN PLACE. Length, line count and column layout are preserved, so
 * an index or line number found in the stripped text lines up with the raw
 * source. Every sweep in this repo depends on that invariant.
 *
 * REGEX LITERALS are lexed in both modes, and have to be: `safe-spawn.ts`'s
 * `arg.replace(/"/g, '""')` puts a bare `"` inside a regex, and a scanner that
 * does not know it is inside a regex reads that quote as a string opener and
 * swallows the rest of the file — a FALSE NEGATIVE, the direction that
 * matters for a sweep. Under `strings: "keep"` the regex BODY is preserved
 * (only its position is tracked); under `"blank"` it is blanked, since an
 * identifier inside a regex is not a call.
 *
 * A `/` opens a regex only where a VALUE may start, decided from the preceding
 * TOKEN rather than the preceding CHARACTER (#1635 review R2): a character
 * check reads the `f` of `typeof /x()/` as an identifier, calls the regex a
 * division, and leaves a phantom call visible to the scan.
 *
 * A TEMPLATE LITERAL's `${...}` interpolation is lexed as ordinary code, not
 * opaque text (#2502) — nested templates, strings, comments and regexes
 * inside it are recognized by this same state machine, so a stray delimiter
 * in there (a nested `` ` `` in particular) cannot be misread as the
 * template's own close. Its code is therefore never blanked by this
 * function's own hand, on EITHER string policy: doing so once (to imitate the
 * pre-#2502 "whole template is opaque" behavior) blanked plain identifiers
 * like `arg` in `arg.replace(/"/g, ...)` above, which made `regexMayStart`'s
 * backward walk over the already-blanked `out` array tunnel straight through
 * them to the template's own opening backtick and misclassify the `/` that
 * follows as NOT a regex-start — silently corrupting the rest of the file.
 */
export function stripSource(
	source: string,
	options: StripOptions = {},
): string {
	const blankStrings = (options.strings ?? "blank") === "blank";
	const out = source.split("");
	const blank = (index: number) => {
		if (out[index] !== "\n") out[index] = " ";
	};
	const regexMayStart = (index: number): boolean => {
		let end = -1;
		for (let j = index - 1; j >= 0; j--) {
			const prev = out[j];
			if (prev === " " || prev === "\t" || prev === "\n" || prev === "\r") {
				continue;
			}
			end = j;
			break;
		}
		if (end < 0) return true; // start of file
		const prev = out[end];
		if (!/[\w$]/.test(prev)) return !/[)\]"'`]/.test(prev);
		let start = end;
		while (start > 0 && /[\w$]/.test(out[start - 1])) start--;
		return KEYWORDS_BEFORE_REGEX.has(out.slice(start, end + 1).join(""));
	};
	let quote: string | undefined;
	let lineComment = false;
	let blockComment = false;
	let regex = false;
	let regexClass = false;
	// Stack of currently-OPEN template literals (outermost first). Each frame
	// tracks the unmatched `{` depth of that template's CURRENT `${...}`
	// interpolation — 0 means the template is presently in its literal-text
	// portion (`quote` is `` ` `` and this frame is the one it belongs to);
	// >=1 means we are lexing the interpolation's expression as ordinary code
	// (`quote` is unset) and this frame's count is how many unmatched `{` we
	// have seen since the `${` that opened it.
	//
	// #2502: a scalar `quote` alone cannot express "inside template N's
	// expression, which itself opened template N+1". Without this stack, a
	// backtick that opens a NESTED template inside an interpolation
	// (`` `x ${cond ? `y(` : `z`} w` ``) is read as `ch === quote` — the
	// (wrong) CLOSE of the outer template — leaving the outer template's own
	// remaining text, including this nested template's own stray delimiters,
	// to fall through as ordinary unmasked code.
	const templateStack: { braceDepth: number }[] = [];
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		if (regex) {
			if (blankStrings) blank(i);
			if (ch === "\\") {
				if (blankStrings) blank(i + 1);
				i++;
			} else if (ch === "[") regexClass = true;
			else if (ch === "]") regexClass = false;
			else if (ch === "/" && !regexClass) regex = false;
			else if (ch === "\n") regex = false; // unterminated: bail, don't swallow
			continue;
		}
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			else blank(i);
			continue;
		}
		if (blockComment) {
			blank(i);
			if (ch === "*" && next === "/") {
				blank(i + 1);
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (ch === "\\") {
				if (blankStrings) {
					blank(i);
					blank(i + 1);
				}
				i++;
			} else if (quote === "`" && ch === "$" && next === "{") {
				// Enter this template's `${...}` interpolation: it now reads as
				// ordinary code (so a nested template, string, comment or regex
				// inside the expression is lexed by its own real machinery below,
				// rather than as opaque template text) until the matching `}`.
				// `${`/`}` are delimiters, kept exactly like the surrounding
				// backticks — never blanked, on either policy.
				templateStack[templateStack.length - 1].braceDepth = 1;
				quote = undefined;
				i++;
			} else if (ch === quote) {
				if (quote === "`") templateStack.pop();
				quote = undefined;
			} else if (ch === "\n" && quote !== "`") {
				// A `'`/`"` string cannot span a raw newline in valid source, so
				// reaching one means this scanner mis-identified the opener. Recover
				// at the line break rather than swallowing the rest of the file.
				quote = undefined;
			} else if (blankStrings) {
				blank(i);
			}
			continue;
		}
		if (ch === "/" && next === "/") {
			blank(i);
			blank(i + 1);
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blank(i);
			blank(i + 1);
			blockComment = true;
			i++;
			continue;
		}
		if (ch === "/" && regexMayStart(i)) {
			if (blankStrings) blank(i);
			regex = true;
			regexClass = false;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			if (ch === "`") templateStack.push({ braceDepth: 0 });
			continue;
		}
		if (templateStack.length > 0) {
			// Inside a template's `${...}` interpolation (invariant: reaching
			// here with a non-empty stack means the top frame's braceDepth is
			// already >=1 — every path that resumes template TEXT mode sets
			// `quote` back to `` ` `` in the same step it would otherwise leave
			// the top frame at depth 0). Track nested `{`/`}` — an object
			// literal or block inside the expression — so the `}` that actually
			// closes the interpolation is the one where this frame's count
			// returns to 0, not the first `}` encountered.
			//
			// Deliberately NOT blanked, on EITHER policy: this is ordinary CODE,
			// not template text, and `regexMayStart` above depends on it staying
			// that way. It walks `out` backward, skipping blanked positions to
			// see past neutralized comments/strings straight to the real
			// preceding token — an early version of this fix blanked plain
			// expression characters (to match the pre-#2502 "whole template is
			// opaque" behavior under `strings: "blank"`), which made that walk
			// tunnel through the blanked identifiers of e.g. `${arg.replace(`
			// straight back to the template's own OPENING backtick — a
			// preserved delimiter, so the scan stopped there and misread a
			// value-position `/` (regex-start) as following a string/template
			// close instead of `(`, silently corrupting comment/regex/string
			// recognition for the rest of the file. Leaving expression code
			// unblanked keeps `out` identical to `source` here, exactly like
			// top-level code, so `regexMayStart` needs no special case.
			const top = templateStack[templateStack.length - 1];
			if (ch === "{") top.braceDepth++;
			else if (ch === "}") {
				top.braceDepth--;
				if (top.braceDepth === 0) quote = "`"; // resume this template's text
			}
		}
	}
	return out.join("");
}

function matchIsCode(
	stringsBlanked: string,
	start: number,
	end: number,
): boolean {
	return /[^\s"'`]/.test(stringsBlanked.slice(start, end));
}

/** Return every raw match whose span contains source code. */
export function codeMatches(source: string, regex: RegExp): RegExpMatchArray[] {
	const stringsBlanked = stripSource(source, { strings: "blank" });
	const globalRegex = new RegExp(
		regex.source,
		regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
	);
	return [...source.matchAll(globalRegex)].filter((match) => {
		const start = match.index ?? 0;
		return matchIsCode(stringsBlanked, start, start + match[0].length);
	});
}

export interface CallSite {
	line: number;
	argsText: string;
	optionsLiteral: string | undefined;
	/** Matched simple callee, for consumers that scan several names at once. */
	callee: string;
}

export interface CallSiteScanner {
	find(calleePattern: RegExp): CallSite[];
}

/**
 * Return AST call sites whose simple callee matches `calleePattern`.
 *
 * The arguments are taken from the call node, not from a balanced-text scan:
 * nested expressions, template literals, and comments cannot change where a
 * call ends. `optionsLiteral` is the last top-level object-literal argument;
 * nested objects and object-shaped text in strings are never candidates.
 */
export function createCallSiteScanner(
	source: string,
	parsedRoot?: SgNode,
): CallSiteScanner {
	let root: SgNode | undefined;
	const parseRoot = (): SgNode => {
		root ??= parsedRoot ?? parse(Lang.TypeScript, source).root();
		return root;
	};

	return {
		find(calleePattern: RegExp): CallSite[] {
			// Avoid parsing files that cannot contain the requested callee. This is a
			// lexical admission check only; every admitted match still comes from the
			// AST below. Anchors are common in callers because the AST supplies the
			// complete simple name, so remove them for this presence probe.
			const needle = calleePattern.source.replace(/^\^|\$$/g, "");
			const candidate = new RegExp(
				`${needle}\\s*\\(`,
				calleePattern.flags.replace("g", ""),
			);
			if (!candidate.test(stripSource(source))) return [];
			const syntaxRoot = parseRoot();
			const sites: CallSite[] = [];
			const visit = (node: SgNode): void => {
				if (node.kind() === "call_expression") {
					const fn = node.field("function");
					const callee =
						fn?.kind() === "identifier"
							? fn.text()
							: fn?.kind() === "member_expression"
								? fn.field("property")?.text()
								: undefined;
					if (callee !== undefined) {
						calleePattern.lastIndex = 0;
						const match = calleePattern.exec(callee);
						if (match?.[0] === callee) {
							const args = node.field("arguments");
							const children = args?.namedChildren() ?? [];
							const first = children[0];
							const last = children.at(-1);
							const options = children
								.filter((arg) => arg.kind() === "object")
								.sort((a, b) => a.range().start.index - b.range().start.index)
								.at(-1);
							sites.push({
								line: node.range().start.line + 1,
								callee,
								argsText:
									first && last
										? source.slice(
												first.range().start.index,
												last.range().end.index,
											)
										: "",
								optionsLiteral: options?.text(),
							});
						}
					}
				}
				for (const child of node.children()) visit(child);
			};
			visit(syntaxRoot);
			return sites;
		},
	};
}

export function callSites(source: string, calleePattern: RegExp): CallSite[] {
	return createCallSiteScanner(source).find(calleePattern);
}

/** Return the first raw match that is not only literal text. */
export function firstCommentMatch(
	source: string,
	regex: RegExp,
): RegExpMatchArray | undefined {
	const commentsBlanked = stripSource(source, { strings: "keep" });
	const stringsBlanked = stripSource(source, { strings: "blank" });
	const globalRegex = new RegExp(
		regex.source,
		regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
	);
	for (const match of source.matchAll(globalRegex)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (
			!/\S/.test(commentsBlanked.slice(start, end)) ||
			matchIsCode(stringsBlanked, start, end)
		) {
			return match;
		}
	}
	return undefined;
}

export interface ListSourceFilesOptions {
	/** File extensions to include, with the dot. Default `[".ts"]`. */
	extensions?: readonly string[];
	/** Skip `.d.ts` declaration files. Default `true`. */
	skipDeclarations?: boolean;
	/** Skip `*.test.<ext>` files. Default `false`. */
	skipTests?: boolean;
	/** Return `true` to drop a file, given its root-relative posix path. */
	exclude?: (relativePosixPath: string) => boolean;
}

/**
 * Every matching file under `root`, recursively, as ABSOLUTE paths sorted for
 * deterministic ordering across platforms (`readdirSync` order is not a
 * contract, and a sweep whose output order shifts between Windows and CI
 * Linux produces diff noise that hides real changes).
 */
export function listSourceFiles(
	root: string,
	options: ListSourceFilesOptions = {},
): string[] {
	const extensions = options.extensions ?? [".ts"];
	const skipDeclarations = options.skipDeclarations ?? true;
	const skipTests = options.skipTests ?? false;
	const walk = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return walk(entryPath);
			if (!extensions.some((ext) => entry.name.endsWith(ext))) return [];
			if (skipDeclarations && /\.d\.[cm]?ts$/.test(entry.name)) return [];
			if (skipTests && /\.test\.[cm]?[jt]s$/.test(entry.name)) return [];
			if (options.exclude?.(relativePosix(root, entryPath))) return [];
			return [entryPath];
		});
	return walk(root).sort();
}

/** `root`-relative posix path for an absolute path. */
export function relativePosix(root: string, absolute: string): string {
	return toPosix(path.relative(root, absolute));
}

/**
 * Nearest named function/class/const-or-let declaration STRICTLY ABOVE
 * `lineIndex` (0-based) in `lines` — a cheap line-scan heuristic, not a
 * parser. Built for {@link stableOccurrenceKey}: keying a per-occurrence
 * exemption on this name survives a line inserted anywhere else in the file,
 * because the declaration's TEXT, not its line number, is what the walk
 * matches (#2475 — the bounded-eviction-idiom sweep's `path:line` exemptions
 * used to re-key on every unrelated insertion above a flagged site).
 *
 * Declarations are matched by shape at the start of the line: `function`/
 * `class` (with `export`/`default`/`abstract`/`async` modifiers), or a
 * `const`/`let` bound to a name. The walk goes upward and returns the FIRST
 * match — the nearest enclosing declaration, on the assumption true of every
 * #2442 site: a flagged statement sits directly inside the body of the
 * declaration immediately above it. `maxLookback` bounds the walk so one
 * pathological file can't turn this into an O(fileSize) scan per occurrence.
 *
 * Matched at column 0 ONLY — no leading whitespace. This repo's shipped
 * source declares every top-level function/class/const at column 0, so
 * anchoring there is what keeps a nested LOCAL (`let evictKey` two lines
 * above a flagged `for` loop, indented inside an `if` inside the function)
 * from winning over the function that actually encloses the flagged site —
 * the first draft matched any indentation and resolved
 * `clients/debug-handles.ts`'s flagged line to `evictKey`, a loop-local
 * variable, instead of `recordTrackedInit`. The trade is real: a declaration
 * nested inside a class or namespace is invisible to this pattern and falls
 * back to the content hash in {@link stableOccurrenceKey}, same as a
 * module-scope site with no enclosing declaration at all.
 */
const DECLARATION_PATTERN =
	/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s+|class\s+)([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/;

export function findEnclosingSymbol(
	lines: readonly string[],
	lineIndex: number,
	maxLookback = 400,
): string | undefined {
	// Starts ABOVE lineIndex, never on it: a flagged occurrence that itself
	// happens to read as `const x = ...` (the eviction idiom's own shape) must
	// never resolve to ITSELF as its own "enclosing" declaration.
	const floor = Math.max(0, lineIndex - maxLookback);
	for (let i = lineIndex - 1; i >= floor; i--) {
		const match = DECLARATION_PATTERN.exec(lines[i] ?? "");
		if (match) return match[1] ?? match[2];
	}
	return undefined;
}

/**
 * A per-occurrence exemption key immune to line-number churn (#2475): the
 * enclosing declaration's NAME when {@link findEnclosingSymbol} finds one —
 * readable, and stable under any edit that doesn't touch the declaration or
 * the flagged line itself — with a short content hash of the flagged line's
 * OWN text always appended (`lineContentHash`, already used by read-guard's
 * line-move relocation for exactly this "survive line movement, catch
 * content movement" property). The hash does two jobs: it disambiguates two
 * flagged occurrences that share one enclosing declaration WHEN their flagged
 * lines' text differs, and it is the WHOLE key when no declaration is found
 * at all (a top-level flagged site). Either way, editing the flagged line's
 * own text — as opposed to inserting a line elsewhere in the file — correctly
 * changes the key, which is the direction that must re-trigger review.
 *
 * This does NOT guarantee two distinct occurrences always get distinct keys.
 * In a class-shaped file every method's flagged line resolves to the SAME
 * enclosing symbol (the class name — `findEnclosingSymbol` matches column-0
 * declarations only, and a method sits indented), so two sibling methods that
 * each flag a byte-identical line (a stereotyped idiom like
 * `for (const key of map.keys()) {`) collide on one key (#2487 review F1).
 * An exemption keyed to that string then excuses BOTH occurrences, not the
 * one it was reasoned about — the same laundering `stableOccurrenceKey` was
 * built to close, one layer down. `auditRegistry`'s `requireUniqueFlagged`
 * (default on) is the backstop: it fails loud on any duplicate flagged key
 * rather than let a caller of this function rely on the hash alone.
 */
export function stableOccurrenceKey(
	relPath: string,
	lines: readonly string[],
	lineIndex: number,
): string {
	const symbol = findEnclosingSymbol(lines, lineIndex);
	const hash = lineContentHash(lines[lineIndex] ?? "");
	return symbol ? `${relPath}#${symbol}:${hash}` : `${relPath}#${hash}`;
}

// ── 2. Registry semantics ───────────────────────────────────────────────────

/**
 * One item the scan flags. A bare string is both the registry/exemption key
 * AND the diagnostic detail shown in messages. A caller that can distinguish
 * an occurrence's stable KEY from a human-readable DETAIL (a file:line, a
 * snippet) should pass the object form so a duplicate-key collision message
 * ({@link RegistryAuditInput.requireUniqueFlagged}) can name each colliding
 * occurrence by its own detail rather than repeating the shared key.
 */
type FlaggedEntry = string | { key: string; detail: string };

export interface RegistryAuditInput {
	/** Sweep name, used in every composed message. */
	sweepName: string;
	/** The items the scan currently flags — the sweep's REDS. */
	flagged: Iterable<FlaggedEntry>;
	/** Items the registry covers. */
	registered: Iterable<string>;
	/** Exempted item → the reason it is exempt. A reason is REQUIRED. */
	exemptions?: Readonly<Record<string, string>>;
	/** Minimum reason length that counts as a real reason. Default 15. */
	minReasonLength?: number;
	/**
	 * Minimum flagged items before the audit trusts its own input. Default 1:
	 * a sweep that flags nothing is dead, not clean (defect shape 10, #1718).
	 */
	minFlagged?: number;
	/**
	 * How many source items the scan actually LOOKED at, and the floor it must
	 * clear (#1755 review F4). `minFlagged` alone cannot tell "scanned 0 files"
	 * from "scanned 370 files, matched none" — two different bugs with two
	 * different fixes, and the first is #1718's exactly. Pass both to get
	 * distinguishable failures; omit both to skip the check.
	 */
	scannedCount?: number;
	minScanned?: number;
	/** Appended to the unaccounted-items message: what the author should do. */
	remediation?: string;
	/**
	 * Fail loud when the same key appears more than once in `flagged` — two
	 * distinct occurrences whose derived id collided (#2487 review F1: a
	 * class's sibling methods can hash-collide under `stableOccurrenceKey`).
	 * A duplicate key means one exemption or registry entry silently excuses
	 * MORE than the single site it names, which is exactly the laundering this
	 * kit's per-occurrence keying exists to prevent. Default `true` — no sweep
	 * built on this kit legitimately relies on two distinct occurrences
	 * sharing one flagged key. Set `false` only for a caller that deliberately
	 * flags the same key more than once (none does today).
	 */
	requireUniqueFlagged?: boolean;
}

export interface RegistryAudit {
	flaggedCount: number;
	/** Echo of `scannedCount`, so a caller can assert on the walk separately. */
	scannedCount?: number;
	/** Flagged, but neither registered nor exempted. */
	unaccounted: string[];
	/** Exempted, but the scan no longer flags it — dead weight (#1735). */
	staleExemptions: string[];
	/** Exempted with a missing or too-short reason. */
	reasonlessExemptions: string[];
	/** Every problem as a ready-to-print message. Empty means clean. */
	problems: string[];
}

/**
 * Registered-or-fail, with exemption reasons and stale-entry self-detection.
 *
 * Deliberately asymmetric: a REGISTERED item the scan does not flag is fine
 * (registries routinely cover state a mechanical heuristic cannot see, such as
 * closure-held latches), but an EXEMPTED item the scan does not flag is stale
 * — an exemption's only job is to excuse a live hit, so one that excuses
 * nothing is a screen that stopped screening. That is #1735's pattern, here as
 * library behavior.
 */
export function auditRegistry(input: RegistryAuditInput): RegistryAudit {
	const flaggedEntries = [...input.flagged].map((entry) =>
		typeof entry === "string" ? { key: entry, detail: entry } : entry,
	);
	const flagged = flaggedEntries.map((entry) => entry.key);
	const flaggedSet = new Set(flagged);
	const registered = new Set(input.registered);
	const exemptions = input.exemptions ?? {};
	const minReasonLength = input.minReasonLength ?? 15;
	const minFlagged = input.minFlagged ?? 1;
	const requireUniqueFlagged = input.requireUniqueFlagged ?? true;
	const problems: string[] = [];

	// Two distinct emptiness failures, reported separately (#1755 review F4).
	// "Scanned nothing" means the scan lost its target — a moved root, a bad
	// glob, #1718's nonexistent machine path. "Scanned plenty, matched nothing"
	// means the DETECTOR broke while the walk stayed healthy. Same symptom, two
	// causes, so they must not share a message.
	if (
		input.minScanned !== undefined &&
		(input.scannedCount ?? 0) < input.minScanned
	) {
		problems.push(
			`${input.sweepName}: the scan LOOKED AT ${input.scannedCount ?? 0} source item(s), ` +
				`below the declared floor of ${input.minScanned} — the walk itself is broken ` +
				"(moved root, bad glob, nonexistent path), so nothing downstream means anything.",
		);
	}

	if (flagged.length < minFlagged) {
		problems.push(
			`${input.sweepName}: the scan flagged ${flagged.length} item(s), below the ` +
				`declared floor of ${minFlagged} — a sweep that matches nothing reads as ` +
				"clean while guarding nothing. Fix the scan or lower the floor deliberately.",
		);
	}

	// Duplicate-key collision (#2487 review F1). Two distinct occurrences that
	// derived the SAME key are exactly the shape a per-occurrence exemption
	// exists to forbid: one exemption entry then excuses both, silently.
	// Checked on the raw entries (not `flaggedSet`) so the message can name
	// every colliding occurrence's own detail — real diagnostic content in a
	// MESSAGE, never folded into a key. Runs BEFORE the exemption-matching
	// checks below: a caller should fix a collision, not exempt around it.
	if (requireUniqueFlagged) {
		const byKey = new Map<string, string[]>();
		for (const entry of flaggedEntries) {
			const details = byKey.get(entry.key) ?? [];
			details.push(entry.detail);
			byKey.set(entry.key, details);
		}
		const collisions = [...byKey.entries()].filter(
			([, details]) => details.length > 1,
		);
		if (collisions.length > 0) {
			problems.push(
				`${input.sweepName}: ${collisions.length} flagged key(s) collide — ` +
					"two or more distinct occurrences derived the SAME key, so one " +
					"exemption or registry entry would silently excuse more than the " +
					"single site it names:\n" +
					collisions
						.map(
							([key, details]) =>
								`  ${key} (${details.length}×): ${details.join(", ")}`,
						)
						.join("\n") +
					"\n\nGive each occurrence a distinguishing key (or fix the " +
					"generator that produced two identical ones) before exempting " +
					"either.",
			);
		}
	}

	// `Object.hasOwn`, never `item in exemptions` (#1755 review F1). The `in`
	// operator walks the PROTOTYPE CHAIN, so a flagged item named `toString`,
	// `constructor`, `valueOf` or `__proto__` would exempt itself against an
	// exemption map that never mentions it — and `staleExemptions` below reads
	// `Object.keys` (own properties only), so it could never report the phantom
	// exemption as stale either. No sweep's id namespace collides today, but the
	// kit is built for six more with arbitrary id namespaces.
	// Detail lookup for readable messages (#2487 review round 3 F1). A caller
	// that passes the object `FlaggedEntry` form gives each key a
	// human-readable detail — a file:line, typically — and a problem message
	// should NAME the site rather than print a bare key nobody can act on.
	// Round 3's probe 1 was exactly this: an unaccounted ordinal key
	// (`...#3`) printed with no file:line, so the natural remediation excused
	// the wrong call site. Built once, over every entry, first occurrence
	// wins (a duplicate key's collision is already reported separately, above).
	//
	// Used by `unaccounted` ONLY (#2487 review round 4 F2). A stale
	// exemption's key is, by construction, one `flaggedEntries` never
	// contains (that is what "stale" means: the scan no longer flags it), so
	// it can never have an entry in `detailByKey` — calling this lookup for
	// `staleExemptions` was dead code that always fell through to the bare
	// key. `staleExemptions` prints the bare key directly below instead.
	const detailByKey = new Map<string, string>();
	for (const entry of flaggedEntries) {
		if (
			entry.detail &&
			entry.detail !== entry.key &&
			!detailByKey.has(entry.key)
		) {
			detailByKey.set(entry.key, entry.detail);
		}
	}
	const describe = (item: string): string => {
		const detail = detailByKey.get(item);
		return detail ? `${item} (${detail})` : item;
	};

	const unaccounted = flagged.filter(
		(item) => !registered.has(item) && !Object.hasOwn(exemptions, item),
	);
	if (unaccounted.length > 0) {
		problems.push(
			`${input.sweepName}: ${unaccounted.length} flagged item(s) are neither ` +
				"registered nor exempted:\n" +
				unaccounted.map((item) => `  ${describe(item)}`).join("\n") +
				(input.remediation ? `\n\n${input.remediation}` : ""),
		);
	}

	const staleExemptions = Object.keys(exemptions).filter(
		(item) => !flaggedSet.has(item),
	);
	if (staleExemptions.length > 0) {
		problems.push(
			`${input.sweepName}: ${staleExemptions.length} exemption(s) name an item the ` +
				"scan no longer flags — remove them, a stale exemption is dead weight, not a screen:\n" +
				staleExemptions.map((item) => `  ${item}`).join("\n"),
		);
	}

	const reasonlessExemptions = Object.entries(exemptions)
		.filter(([, reason]) => (reason ?? "").trim().length < minReasonLength)
		.map(([item]) => item);
	if (reasonlessExemptions.length > 0) {
		problems.push(
			`${input.sweepName}: ${reasonlessExemptions.length} exemption(s) carry no real ` +
				`reason (under ${minReasonLength} characters):\n` +
				reasonlessExemptions.map((item) => `  ${item}`).join("\n"),
		);
	}

	return {
		flaggedCount: flagged.length,
		scannedCount: input.scannedCount,
		unaccounted,
		staleExemptions,
		reasonlessExemptions,
		problems,
	};
}

// ── 3. Tag and evidence binding ─────────────────────────────────────────────

/** One call-shaped seam found in STRIPPED source. `line` is 1-based. */
export interface SeamHit {
	line: number;
	text: string;
}

/** A seam plus the registry ids its tag comment names (empty when untagged). */
export interface TaggedSeam {
	seam: SeamHit;
	ids: string[];
	/**
	 * The seam's own line carries a tag comment (#1755 review F3). That is a
	 * misplacement, never a binding — see {@link bindTagsToSeams}.
	 */
	inlineTagOnSeamLine?: boolean;
}

/**
 * Every line of `strippedSource` matching `pattern`.
 *
 * `pattern` should be CALL-SHAPED (`\bfoo\.push\(`, `^function format\w*Mode\(`)
 * rather than a bare name: a bare name matches the import line and any doc
 * comment mentioning it, which is how #1692's first version stayed 19/19 green
 * with all three real gate calls stubbed to identity.
 */
export function findSeams(strippedSource: string, pattern: RegExp): SeamHit[] {
	const hits: SeamHit[] = [];
	strippedSource.split("\n").forEach((text, index) => {
		if (pattern.test(text)) hits.push({ line: index + 1, text: text.trim() });
	});
	return hits;
}

/** Default tag shape: `@<name>: id[,id]`. */
export function tagPattern(tagName: string): RegExp {
	return new RegExp(`@${tagName}:\\s*([\\w:,-]+)`);
}

/**
 * Bind each seam to EXACTLY the immediately-preceding non-blank RAW line — no
 * lookback window, no "nearest tag wins".
 *
 * #1692 review round R1a: a four-line lookback let a NEW untagged seam inherit
 * the previous seam's tag, which is precisely how someone adds an unregistered
 * surface — paste a second call right after an already-tagged one.
 *
 * `consumedTagLines` carries #1692's second guard forward: a tag LINE binds at
 * most one seam. Stated honestly, it is REDUNDANT under the strict binding
 * rule above — a tag line can be the immediately-preceding non-blank line of
 * only one seam, because any second seam finds the FIRST seam above it
 * instead. No mutation test reds when it is removed, and the kit does not
 * claim one. It is kept because it is the invariant the rule exists to
 * enforce, and it becomes load-bearing the moment a caller relaxes binding.
 *
 * BLANK-LINE GAP (#1755 review F2). The lookback skips blank lines, but only
 * `maxBlankGap` of them (default 1). #1692's version skipped an UNBOUNDED run,
 * so a tag eight blank lines above a seam still bound to it — "immediately
 * preceding" in the code but not on the screen, and a reviewer scrolling past
 * that much whitespace does not read the two as one unit. Callers that need
 * the old unbounded rule pass `maxBlankGap: Number.POSITIVE_INFINITY` and say
 * why.
 *
 * INLINE TAGS (#1755 review F3). A tag written at the END of a seam line
 * (`advisoryParts.push(x); // @surface: alpha`) does NOT tag that seam — the
 * line above it is what a seam reads. Worse, it would silently tag the NEXT
 * seam down. That shape is rejected outright: the seam is returned untagged
 * with `inlineTagOnSeamLine` set, and {@link findUnregisteredSeams} reports it
 * with the fix. Put the tag on its own line above the seam.
 */
export function bindTagsToSeams(
	rawSource: string,
	seams: readonly SeamHit[],
	tag: RegExp,
	maxBlankGap = 1,
): TaggedSeam[] {
	const rawLines = rawSource.split("\n");
	const consumedTagLines = new Set<number>();
	const seamLineIndexes = new Set(seams.map((s) => s.line - 1));
	return seams.map((seam) => {
		const seamLineIndex = seam.line - 1;
		// F3: a tag on the seam's OWN line is a misplacement, not a binding.
		if (tag.test(rawLines[seamLineIndex] ?? "")) {
			return { seam, ids: [], inlineTagOnSeamLine: true };
		}
		let i = seamLineIndex - 1; // 0-based index of the raw line just above
		let skipped = 0;
		while (i >= 0 && rawLines[i].trim() === "") {
			if (skipped >= maxBlankGap) return { seam, ids: [] };
			skipped++;
			i--;
		}
		if (i < 0) return { seam, ids: [] };
		// A tag sitting on ANOTHER seam's line never binds either — same F3
		// misplacement, seen from below.
		if (seamLineIndexes.has(i)) return { seam, ids: [] };
		const m = tag.exec(rawLines[i]);
		if (!m || consumedTagLines.has(i)) return { seam, ids: [] };
		consumedTagLines.add(i);
		return { seam, ids: m[1].split(",").map((s) => s.trim()) };
	});
}

/** Every real seam in `rawSource`, paired with its (possibly empty) tag ids. */
export function scanTaggedSeams(
	rawSource: string,
	seamPattern: RegExp,
	tag: RegExp,
	maxBlankGap?: number,
): TaggedSeam[] {
	const stripped = stripSource(rawSource);
	return bindTagsToSeams(
		rawSource,
		findSeams(stripped, seamPattern),
		tag,
		maxBlankGap,
	);
}

/**
 * Seams that carry no tag, or a tag naming an id outside `registryIds`.
 * Returns ready-to-print problem strings; empty means every seam is registered.
 */
export function findUnregisteredSeams(
	rawSource: string,
	seamPattern: RegExp,
	tag: RegExp,
	registryIds: ReadonlySet<string>,
	registryName = "the registry",
	maxBlankGap?: number,
): string[] {
	const problems: string[] = [];
	for (const { seam, ids, inlineTagOnSeamLine } of scanTaggedSeams(
		rawSource,
		seamPattern,
		tag,
		maxBlankGap,
	)) {
		if (inlineTagOnSeamLine) {
			problems.push(
				`line ${seam.line}: the tag comment sits on the seam's own line, where it ` +
					"tags nothing — move it to its own line directly above the seam — " +
					seam.text,
			);
			continue;
		}
		if (ids.length === 0) {
			problems.push(`line ${seam.line}: untagged seam — ${seam.text}`);
			continue;
		}
		for (const id of ids) {
			if (!registryIds.has(id)) {
				problems.push(
					`line ${seam.line}: tagged "${id}", which is not in ${registryName} — ${seam.text}`,
				);
			}
		}
	}
	return problems;
}

/** 1-based line numbers in `strippedSource` where `needle` occurs. */
export function occurrenceLines(
	strippedSource: string,
	needle: string,
): number[] {
	const out: number[] = [];
	strippedSource.split("\n").forEach((line, i) => {
		if (line.includes(needle)) out.push(i + 1);
	});
	return out;
}

/**
 * Greedy nearest-neighbor, EXCLUSIVE assignment of evidence occurrences to the
 * seams competing for them — #1692 review round R1c.
 *
 * The per-region check it replaced asked "is evidence somewhere in MY window",
 * not "is this evidence actually MINE and nobody else's", so a rogue seam
 * placed inside a real gate's window passed just by sharing the window.
 *
 * Candidates are (seam, occurrence) pairs inside the `back`/`forward` window,
 * sorted by ascending distance; the closest pair is taken first and both sides
 * leave the pool. `capacity` is the per-occurrence claim capacity: 1 by
 * default (one seam per occurrence), raised only when N legitimate seams
 * genuinely share one upstream call and the sweep DECLARES that number.
 *
 * Callers must run one assignment PER ID: two different ids legitimately
 * reusing the same call are not competitors, and folding them into one
 * assignment would fail the honest one.
 */
export function assignNearestExclusive(
	seamLines: readonly number[],
	occurrences: readonly number[],
	back: number,
	forward: number,
	capacity: number,
): Map<number, number> {
	const pairs: Array<{ seamLine: number; occLine: number; dist: number }> = [];
	for (const seamLine of seamLines) {
		for (const occLine of occurrences) {
			if (occLine >= seamLine - back && occLine <= seamLine + forward) {
				pairs.push({ seamLine, occLine, dist: Math.abs(seamLine - occLine) });
			}
		}
	}
	pairs.sort((a, b) => a.dist - b.dist);
	const occClaimCount = new Map<number, number>();
	const claimedSeam = new Set<number>();
	const assignment = new Map<number, number>();
	for (const p of pairs) {
		if (claimedSeam.has(p.seamLine)) continue;
		const used = occClaimCount.get(p.occLine) ?? 0;
		if (used >= capacity) continue;
		occClaimCount.set(p.occLine, used + 1);
		claimedSeam.add(p.seamLine);
		assignment.set(p.seamLine, p.occLine);
	}
	return assignment;
}

/**
 * True when some line within `proximity` of `lineIdx` (0-based) holds a
 * call-shaped occurrence of `calleeName`.
 *
 * #1692 review R2's defense: the evidence ARGUMENT alone (`store: "gitleaks"`)
 * survives swapping the callee for an identity stub. Requiring the callee near
 * that SPECIFIC argument occurrence is what a stub cannot fake.
 */
export function hasNearbyCallSite(
	lines: readonly string[],
	lineIdx: number,
	calleeName: string,
	proximity: number,
): boolean {
	const start = Math.max(0, lineIdx - proximity);
	const end = Math.min(lines.length, lineIdx + proximity + 1);
	for (let i = start; i < end; i++) {
		if (lines[i].includes(`${calleeName}(`)) return true;
	}
	return false;
}

/** Window defaults lifted from #1692's shipped form. */
const DEFAULT_EVIDENCE_WINDOW = {
	back: 150,
	forward: 10,
	calleeProximity: 3,
} as const;

export interface SeamEvidenceInput {
	/** The registry id whose seams are being proved. */
	id: string;
	/** ALL tagged seams in the scanned file — every seam is a competitor. */
	taggedSeams: readonly TaggedSeam[];
	/** The file's lines, comment-stripped with string contents KEPT. */
	strippedLines: readonly string[];
	/** Literal substrings each seam of `id` must exclusively claim. */
	evidence: readonly string[];
	/**
	 * Callee names that must appear call-shaped near a claimed ARGUMENT
	 * occurrence. Empty or omitted skips the identity-stub check — appropriate
	 * only for surfaces that name no gate.
	 */
	callees?: readonly string[];
	/** Per-occurrence claim capacity. Default 1. */
	capacity?: number;
	back?: number;
	forward?: number;
	calleeProximity?: number;
}

/**
 * Prove that every seam tagged `id` exclusively claims each of `id`'s evidence
 * needles, and that an ARGUMENT-shaped needle sits next to a real call.
 *
 * A needle that is already call-shaped (contains `(`) is its own callee proof
 * and skips the proximity check. Returns problem strings; empty means proved.
 */
export function checkSeamEvidence(input: SeamEvidenceInput): string[] {
	const problems: string[] = [];
	const seamsForId = input.taggedSeams
		.filter(({ ids }) => ids.includes(input.id))
		.map(({ seam }) => seam.line);
	if (seamsForId.length === 0) return problems;
	const back = input.back ?? DEFAULT_EVIDENCE_WINDOW.back;
	const forward = input.forward ?? DEFAULT_EVIDENCE_WINDOW.forward;
	const proximity =
		input.calleeProximity ?? DEFAULT_EVIDENCE_WINDOW.calleeProximity;
	const capacity = input.capacity ?? 1;
	const callees = input.callees ?? [];
	const whole = input.strippedLines.join("\n");
	for (const needle of input.evidence) {
		const occurrences = occurrenceLines(whole, needle);
		const assignment = assignNearestExclusive(
			seamsForId,
			occurrences,
			back,
			forward,
			capacity,
		);
		for (const seamLine of seamsForId) {
			const claimed = assignment.get(seamLine);
			if (claimed === undefined) {
				problems.push(
					`"${input.id}": the seam at line ${seamLine} could not exclusively claim an ` +
						`occurrence of "${needle}" within ${back}/${forward} lines — either no ` +
						"occurrence is that close, or a competing seam claimed the nearest one first",
				);
				continue;
			}
			if (callees.length > 0 && !needle.includes("(")) {
				const satisfied = callees.some((callee) =>
					hasNearbyCallSite(
						input.strippedLines,
						claimed - 1,
						callee,
						proximity,
					),
				);
				if (!satisfied) {
					problems.push(
						`"${input.id}": the occurrence of "${needle}" claimed by the seam at line ` +
							`${seamLine} (line ${claimed}) is not within ${proximity} lines of a ` +
							`call-shaped ${callees.join("/")}( — possible identity-stub`,
					);
				}
			}
		}
	}
	return problems;
}

// ── 3b. Per-file symbol-count pin ───────────────────────────────────────────

export interface SymbolCountAuditInput {
	/** Sweep name, used in every composed message. */
	sweepName: string;
	/** file → count of stateful symbols the scan detects there RIGHT NOW. */
	counts: Readonly<Record<string, number>>;
	/** file → count the registry/exemption list has PINNED. */
	pinned: Readonly<Record<string, number>>;
	/** Appended to the drift message: what the author should do. */
	remediation?: string;
}

/**
 * A per-file stateful-SYMBOL-COUNT pin, layered on {@link auditRegistry}'s
 * registered-or-fail semantics rather than a parallel mechanism (#1817).
 *
 * The session-state sweep's file-level coverage audit ({@link auditRegistry}
 * called directly on file paths) answers "is this FILE registered or
 * exempted" — it cannot see that a NEW stateful symbol landed inside a file
 * that already answered yes. That is exactly how #1801 review F1 shipped:
 * `tree-sitter-client.ts`'s `staleGrammarVersionAt` memo sat invisible inside
 * an already-registered module while the sweep stayed 55/55 green.
 *
 * The fix folds each file's LIVE detected-symbol count into its registry id
 * (`file@N`) and re-uses {@link auditRegistry} unchanged: a file whose count
 * changed presents a DIFFERENT id than the one pinned, and an id the pin does
 * not name is, to `auditRegistry`, an ordinary unaccounted item. No new
 * registry, no new exemption semantics — the same machinery, one extra
 * dimension folded into the id.
 *
 * This is coarser than full symbol-to-reset attribution (option (a) in
 * #1817): it says a file's total changed, not which symbol changed or
 * whether the new one needs a reset. That is the deliberate trade — cheap
 * enough to pin all ~72 currently-flagged files in one table, and it still
 * makes the #1801 shape structurally impossible to add silently, because the
 * pin can only ever fail LOUD (an unmatched id), never pass on a symbol it
 * never saw.
 */
export function auditSymbolCounts(input: SymbolCountAuditInput): RegistryAudit {
	const key = (file: string, count: number) => `${file}@${count}`;
	return auditRegistry({
		sweepName: input.sweepName,
		flagged: Object.entries(input.counts).map(([file, count]) =>
			key(file, count),
		),
		registered: Object.entries(input.pinned).map(([file, count]) =>
			key(file, count),
		),
		// Count-drift is a supplementary check layered on a coverage sweep that
		// already declares its own scanned/flagged floors — a second emptiness
		// floor here would just duplicate that message under a different name.
		minFlagged: 0,
		remediation:
			input.remediation ??
			"A file's pinned stateful-symbol count no longer matches what the scan " +
				"detects. First decide whether the new (or removed) symbol needs its " +
				"own registry entry, a reset, or an exemption reason, or it is an " +
				"import-time constant the scan cannot distinguish (SWEEP_HEURISTIC_LIMITS " +
				"item 5) — THEN update the pin to the new count.",
	});
}

// ── 4. The emptiness guard ──────────────────────────────────────────────────

/**
 * Fail when a sweep scanned or matched too little to mean anything — AGENTS.md
 * defect shape 10, the #1718 lesson.
 *
 * #1718's self-scan pointed at a nonexistent machine path and reported a clean
 * run for months. #1729's rule filter could resolve to zero rules and print
 * `[]`. Both read as "no findings". Every sweep declares a floor and calls this
 * BEFORE trusting an empty result set.
 */
export function assertNonEmptyScan(
	label: string,
	count: number,
	minimum = 1,
): void {
	if (count < minimum) {
		throw new Error(
			`${label}: scanned/matched ${count}, below the declared floor of ${minimum}. ` +
				"An empty sweep must fail, not read as clean — if the target genuinely " +
				"went away, delete the sweep instead of letting it pass on nothing.",
		);
	}
}

/** Enforce lexical order so parallel admission additions stay local. */
export function assertSortedRegistry(
	label: string,
	keys: readonly string[],
): void {
	const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
	if (duplicate !== undefined) {
		throw new Error(
			`${label}: entries must be unique; duplicate key is ${duplicate}`,
		);
	}
	const sorted = [...keys].sort();
	const first = keys.findIndex((key, index) => key !== sorted[index]);
	if (first !== -1) {
		throw new Error(
			`${label}: entries must be sorted; first out-of-order key is ${keys[first]}`,
		);
	}
}
