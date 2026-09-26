/**
 * #3071 — every `DegradationKind` literal emitted at a `recordDegradationOnce`
 * / `incrementDegradationCount` / `logDurableDegradation` call site is a
 * declared member of the `DegradationKind` union.
 *
 * ## The defect this guards
 *
 * `DegradationRecord.kind` is typed `unknown` and `DegradationGroup.kind` is
 * typed plain `string` (`clients/degradation-ledger.ts`) — nothing in the type
 * system ties a call site's `kind:` literal back to the union declared just
 * above them. `tests/config/degradation-kind-order.test.ts` pins the union's
 * own ALPHABETICAL order, but never checks that order against what call sites
 * actually emit, so a kind spelled at a call site with no matching union
 * member compiles clean and is silently unreachable by any reader (`pilens
 * degradation`, the durable ledger dashboard, a future exhaustive `switch`)
 * that trusts the union as the complete vocabulary.
 *
 * Measured on 4ff36009f (#3071's filing): declared 138, literal kinds at call
 * sites 112, undeclared 13. Measured again for this change (master had moved:
 * two more record sites were added in the interim — `lsp-document-drift`,
 * `lsp-probe-finding-policy`) — see the PR body for the exact 15-name list
 * this sweep found and `clients/degradation-ledger.ts` now declares.
 *
 * ## Scope, stated rather than silently narrowed
 *
 * This walks `clients/`, `index.ts`, `mcp/` and `tools/` (`commands/` too,
 * were it to exist) for a CALL EXPRESSION whose simple callee is one of the
 * three names, exactly like {@link
 * import("../support/sweep-kit.js").createCallSiteScanner} resolves any other
 * sweep's call sites — comments and string CONTENTS are blanked first
 * (`stripSource`) so a callee named only in prose is not a call. `scripts/`
 * is not walked: nothing there calls these three names directly (one bench
 * script only READS `getDegradationSummary()`), and record sites are 100%
 * inside the four scanned trees today (`stableOccurrenceKey`'s `#file:hash`
 * details below say exactly which file supplied each one).
 *
 * `kindLiteralsInOptions` extracts the STRING literal(s) the call's own
 * `kind:` property evaluates to, TEXTUALLY, and knows two shapes:
 * - a bare literal (`kind: "actionable-warnings-cap"`);
 * - a two-armed ternary between two literals (`clients/deadline-utils.ts`:
 *   `kind: fired === "deadline" ? "hook-await-exceeded" :
 *   "hook-await-abandoned"`) — both arms are returned, and the ternary's own
 *   CONDITION (here, the literal `"deadline"` being compared against) is
 *   deliberately excluded: only text after the `?` counts as a produced kind.
 *
 * A `kind` written as a PROPERTY ACCESS or FUNCTION CALL — a pass-through
 * parameter (`bounded-telemetry.ts`'s `options.ledgerKind`,
 * `bundled-resource-health.ts`'s `kind` parameter, `config-warn.ts`'s
 * `degradationKindFor(...)` classifier call, `instance-reaper.ts`'s
 * `options.kind`) or a whole record object built earlier and passed by name
 * (`index.ts`'s `incrementDegradationCount(degradation)`) — contributes NO
 * literal here: the literal, if any, lives at THAT function's own callers,
 * outside this scan's three names. This is a stated, not a silent, limit
 * (the "sweep is only as good as its needles" self-test below pins the
 * distinction), and it costs nothing for #3071's purpose: every one of those
 * pass-through sites resolves (by inspection, recorded in the PR body) to an
 * ALREADY-declared kind — `auditRegistry` treats a declared-but-unflagged
 * union member as fine by design (registries routinely cover state a
 * mechanical heuristic cannot see), so this sweep stays honest without
 * chasing multi-hop parameter forwarding.
 *
 * A `kind` written as a BARE IDENTIFIER (`TRUST_REFUSAL_KIND`, no `.`, no
 * `(`) is a DIFFERENT shape and is never silently dropped (#3140, the #3071
 * false-negative gap): `resolveSameFileConstKind` resolves it when it is a
 * SAME-FILE top-level `const NAME = "literal";`, one hop, never chased across
 * an import — the ONE rule this scan applies, not a per-site heuristic pile.
 * When that one hop does not resolve it (the binding is reached only through
 * an import — `PROCESS_SINGLETON_RESET_KIND`, folded in from
 * `clients/process-singletons.ts` below), the site must be named in
 * `AUDITED_IDENTIFIER_KIND_SITES` with its resolved kind, or the scan reports
 * it LOUD as `"<file>:<line> kind: <identifier> is unresolvable"` — never a
 * silent `[]`. A property access or function call is not put through this
 * same-file lookup: those are genuine pass-throughs whose value lives at a
 * DIFFERENT call site, and chasing them is the "multi-hop parameter
 * forwarding" this scan deliberately does not do.
 *
 * READ-TIME FOLD EMITTERS. `getDegradationSummary()` in
 * `clients/degradation-ledger.ts` (`LEDGER_FILE`) folds several kinds in at
 * READ time via `summary.push({ kind: ... })`
 * rather than through the three names above (`log-sink-write-failure`,
 * `log-sink-rotated`, `log-sink-rotate-failed`, `log-sink-option-conflict`,
 * `process-singleton-reset`, `global-dir-probe-redirect` — each one's own
 * `DegradationKind` doc comment explains why it cannot go through
 * `recordDegradation`). #3140: `process-singleton-reset` was live at this
 * exact path, undeclared, invisible to a scan that only walked the three
 * RECORD_CALLEES names — so this scan ALSO walks `LEDGER_FILE`'s own
 * `.push(...)` call sites (`LEDGER_PUSH_CALLEES`), scoped to that ONE file:
 * `push` is far too generic a callee name to walk across `clients/`, `mcp/`,
 * `tools/` (every array push would match), but within this single file every
 * `.push()` call is either `groups.entries.push(...)` (no `kind:` property —
 * `kindValueText` finds nothing and it is silently skipped, same as any other
 * call with no `kind:`) or one of these read-time-fold summary rows, verified
 * by inspection rather than by narrowing the pattern further.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	assertNonEmptyScan,
	callSites,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const LEDGER_FILE = "clients/degradation-ledger.ts";

/** The three functions every durable degradation record goes through. */
const RECORD_CALLEES =
	/^(recordDegradationOnce|incrementDegradationCount|logDurableDegradation)$/;

/**
 * `LEDGER_FILE`'s own read-time fold emitters — see the module header's
 * "READ-TIME FOLD EMITTERS" section for why this is scoped to that ONE file
 * rather than joining `RECORD_CALLEES` for the whole tree.
 */
const LEDGER_PUSH_CALLEES = /^push$/;

/** Every tree that could hold a call site for the three names above. */
const SCAN_ROOTS = ["clients", "index.ts", "mcp", "tools", "commands"];

/**
 * Bare-identifier `kind:` values this scan cannot resolve via the same-file
 * `resolveSameFileConstKind` rule — the binding is reached only through an
 * IMPORT, a second hop whose own resolution rules (relative path, `.js`/`.ts`
 * extension, barrel re-exports) would turn "one rule" into the per-site
 * heuristic pile #3140 explicitly asks this scan to avoid. Verified by
 * inspection instead and named here, keyed by `<repo-relative file>#
 * <identifier>` so an entry survives line churn but still names exactly the
 * one call site it excuses (`auditRegistry`'s own collision policy, applied
 * by hand since there is only one entry).
 */
const AUDITED_IDENTIFIER_KIND_SITES: ReadonlyMap<string, string> = new Map([
	[
		// `PROCESS_SINGLETON_RESET_KIND` is imported into LEDGER_FILE from
		// `clients/process-singletons.ts:86` (`export const
		// PROCESS_SINGLETON_RESET_KIND = "process-singleton-reset"`) for the
		// `summary.push` read-time fold — same declared kind either way, this
		// scan just cannot walk the import to see it.
		`${LEDGER_FILE}#PROCESS_SINGLETON_RESET_KIND`,
		"process-singleton-reset",
	],
]);

/**
 * The raw text of a call site's `kind:` property VALUE, up to the next `,`
 * or the object's own closing `}` — shared by `kindLiteralsInOptions` (the
 * literal/ternary shapes) and `bareIdentifierKind` (the #3140 bare-identifier
 * shape) so both read the same key/value boundary rather than two drifting
 * copies of it. Returns `undefined` when the object literal has no `kind:`
 * property at all (a pass-through whole-record call, or a `{ kind, ... }`
 * shorthand — neither writes literal text after a colon named `kind`).
 */
function kindValueText(optionsLiteral: string): string | undefined {
	// Comments blanked, string CONTENTS blanked too: this pass only needs the
	// STRUCTURE (brace/paren depth, the key name, the `,`/`}` that ends the
	// value) — the literal content itself is read from the ORIGINAL text below,
	// by the same offsets, since `stripSource` preserves length and layout.
	const structure = stripSource(optionsLiteral, { strings: "blank" });
	// The FIRST "kind:" in the object wins. Every one of the 169 measured
	// call sites (#3071) writes `kind` as its object literal's FIRST
	// property, so this is never ambiguous against a later nested `kind`
	// (e.g. inside `metadata: { kind: ... }`) in practice — stated as a known
	// limit rather than defended with an untestable depth check: a
	// `metadata`-nested `kind` written BEFORE the record's own would be
	// misread, but no shipped call site does that, and a guard against it
	// could not be shown to catch anything real (AGENTS.md: a guard that
	// cannot be made to red does not need to exist).
	const keyMatch = /(?<![\w$])kind(?![\w$])\s*:/.exec(structure);
	if (!keyMatch) return undefined;

	// The value's own text runs from just after the colon to the next `,`
	// (the property separator) or the object's own closing `}` (when `kind`
	// is the last property), whichever comes first. No bracket-depth tracking
	// is needed: none of the 169 measured call sites' `kind` values contain a
	// nested `,` at all (not the ternary — `fired === "deadline" ? "a" : "b"`
	// has none — and not a pass-through function call's arguments, since
	// those never resolve to a literal either way, truncated or not) — stated
	// as a known limit rather than defended with untestable depth tracking
	// (AGENTS.md: a guard that cannot be made to red does not need to exist).
	// A future `kind` value that legitimately needs one (a nested call whose
	// OWN comma must be skipped to reach a trailing literal) would need this
	// widened, and would fail LOUD here (`bare`/`ternary` below matching
	// nothing) rather than silently misreading — the safe direction.
	const start = keyMatch.index + keyMatch[0].length;
	const candidates = [
		structure.indexOf(",", start),
		structure.indexOf("}", start),
	].filter((index) => index !== -1);
	const end =
		candidates.length > 0 ? Math.min(...candidates) : structure.length;

	return optionsLiteral.slice(keyMatch.index + keyMatch[0].length, end);
}

/**
 * The STRING literal(s) a call site's `kind:` property evaluates to,
 * textually. See the module header for the two shapes recognized and why a
 * pass-through identifier/property-access value returns `[]` rather than
 * being chased through its own callers.
 */
function kindLiteralsInOptions(optionsLiteral: string): string[] {
	const valueText = kindValueText(optionsLiteral);
	if (valueText === undefined) return [];

	const STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
	const unquote = (raw: string) => raw.slice(1, -1).replace(/\\(.)/g, "$1");

	// A two-armed ternary: only the text AFTER the `?` is a produced value —
	// the condition before it (which may itself compare against a string
	// literal, as `deadline-utils.ts` does) is never returned.
	const ternary = new RegExp(
		`^\\s*[\\s\\S]*?\\?\\s*${STR}\\s*:\\s*${STR}\\s*$`,
	).exec(valueText);
	if (ternary) return [unquote(ternary[1]), unquote(ternary[2])];

	// A bare literal: the whole value, trimmed, is one string.
	const bare = new RegExp(`^\\s*${STR}\\s*$`).exec(valueText);
	return bare ? [unquote(bare[1])] : [];
}

/**
 * The bare identifier a `kind:` value is, when it is EXACTLY one identifier
 * token and nothing else — no `.` (property access), no `(` (function call).
 * #3140: this is the shape that is genuinely resolvable without chasing a
 * caller (a same-file `const`, or a cross-file binding named in
 * `AUDITED_IDENTIFIER_KIND_SITES`), unlike a true pass-through
 * (`options.ledgerKind`, `degradationKindFor(...)`) whose value lives at a
 * DIFFERENT call site entirely and stays out of this scan's reach by design.
 * Returns `undefined` for anything else, including a bare literal (already
 * handled by `kindLiteralsInOptions`) and a `kind:`-less object (no value
 * text at all).
 */
function bareIdentifierKind(optionsLiteral: string): string | undefined {
	const valueText = kindValueText(optionsLiteral);
	if (valueText === undefined) return undefined;
	return /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(valueText)?.[1];
}

/**
 * Resolve a bare `kind:` identifier to the string literal a SAME-FILE
 * top-level `const NAME = "literal";` (or `export const NAME = "literal";`)
 * binds it to — one hop, never chased across an import. #3140:
 * `TRUST_REFUSAL_KIND` at `clients/config-core/process-spec.ts:266` is
 * exactly this shape — a module constant naming an already-declared kind,
 * not a genuine forwarded parameter — so treating it the same as
 * `options.ledgerKind` (silently out of this scan's reach) was the
 * false-negative half of the #3071 gap: the scan returned `[]` with no
 * "unresolvable" signal for a value it could have read one line away.
 *
 * Returns `undefined` when no such SAME-FILE TOP-LEVEL binding exists,
 * including a binding reached only through an import —
 * `AUDITED_IDENTIFIER_KIND_SITES` names that case explicitly instead of this
 * function chasing it: an import's own resolution rules (relative path,
 * `.js`/`.ts` extension, barrel re-exports) would turn this from one rule
 * into a heuristic pile — and including a FUNCTION-SCOPED `const` of the
 * same name (round 2 finding, #3140): every module-level statement in this
 * repo's own oxfmt-enforced style starts at COLUMN 0, and anything nested
 * inside a block is indented at least one level, so `^(?:export\s+)?const`
 * anchored with the `m` flag is genuine top-level structure, not a
 * heuristic — a shadowing function-scoped `const TRUST_REFUSAL_KIND = "…"`
 * inside some unrelated function must never satisfy this and hand back its
 * value instead of falling through to the loud "unresolvable" report; that
 * silently-wrong resolution is exactly the failure mode this design exists
 * to prevent. When BOTH a top-level const and a same-named function-scoped
 * shadow exist, the top-level one's value is what resolves — the anchor
 * only excludes the shadow, it does not refuse the file.
 */
function resolveSameFileConstKind(
	fileSource: string,
	identifier: string,
): string | undefined {
	// Comments blanked, string CONTENT kept (unlike `kindValueText` above):
	// the quoted literal itself is read directly off the match, since a
	// module-level `const` declaration's own value is never itself a `kind:`
	// object literal whose STRUCTURE this scan needs to walk.
	const commentsBlanked = stripSource(fileSource, { strings: "keep" });
	const STR = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
	// `^` (with `m`) anchors "const" — or "export const" — to the START of a
	// LINE: genuine top-level structure in this repo's own tab-indented
	// style, since anything nested inside a block carries at least one
	// leading tab. A function-scoped shadow of the same name is therefore
	// never a match, however far down the file it sits.
	const pattern = new RegExp(
		`^(?:export\\s+)?const\\s+${identifier}\\s*=\\s*${STR}\\s*;`,
		"m",
	);
	const match = pattern.exec(commentsBlanked);
	if (!match) return undefined;
	return match[1].slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Classify one call site's `kind:` value: a resolved literal kind (or two,
 * for a ternary), or — for the #3140 bare-identifier shape — an unresolved
 * identifier that is neither a same-file `const` nor an audited cross-file
 * site. Pulled out of `scanCallSites` so the "identifier not in the list
 * reds with the unresolvable report" shape can be proven against an
 * in-memory fixture below, the same convention as the call-site extraction
 * self-tests already in this file.
 */
function classifyKindOccurrences(
	optionsLiteral: string,
	fileSource: string,
	relPath: string,
): { kinds: string[]; unresolved: string[] } {
	const literals = kindLiteralsInOptions(optionsLiteral);
	if (literals.length > 0) return { kinds: literals, unresolved: [] };

	const identifier = bareIdentifierKind(optionsLiteral);
	if (identifier === undefined) return { kinds: [], unresolved: [] };

	const sameFile = resolveSameFileConstKind(fileSource, identifier);
	if (sameFile !== undefined) return { kinds: [sameFile], unresolved: [] };

	const audited = AUDITED_IDENTIFIER_KIND_SITES.get(`${relPath}#${identifier}`);
	if (audited !== undefined) return { kinds: [audited], unresolved: [] };

	return { kinds: [], unresolved: [identifier] };
}

/** Every member the `DegradationKind` union declares, in file order. */
function declaredKinds(): string[] {
	const source = readWalkedFile(path.join(REPO_ROOT, LEDGER_FILE));
	const body = source?.match(
		/export type DegradationKind =([\s\S]*?)\n\nexport interface DegradationRecord/,
	)?.[1];
	return [...(body ?? "").matchAll(/\| "([^"]+)"/g)].map((match) => match[1]);
}

interface KindOccurrence {
	kind: string;
	/** `stableOccurrenceKey` over the RAW source — content-derived, survives
	 *  an unrelated line inserted elsewhere in the file. */
	detail: string;
}

/**
 * Every `kind` literal found at a {@link RECORD_CALLEES} call site, plus
 * `LEDGER_FILE`'s own {@link LEDGER_PUSH_CALLEES} read-time fold emitters
 * (module header, "READ-TIME FOLD EMITTERS"). `unresolved` carries one entry
 * per bare-identifier `kind:` value {@link classifyKindOccurrences} could
 * neither resolve to a same-file `const` nor find in
 * `AUDITED_IDENTIFIER_KIND_SITES` (#3140) — the loud report the false-negative
 * half of the #3071 gap needs instead of a silent `[]`.
 */
function scanCallSites(): {
	occurrences: KindOccurrence[];
	scannedFiles: number;
	unresolved: string[];
} {
	const files = SCAN_ROOTS.flatMap((root) => {
		const abs = path.join(REPO_ROOT, root);
		if (!fs.existsSync(abs)) return [];
		if (!fs.statSync(abs).isDirectory()) return [abs];
		return listSourceFiles(abs, { extensions: [".ts"], skipTests: true });
	});

	const occurrences: KindOccurrence[] = [];
	const unresolved: string[] = [];
	let scannedFiles = 0;
	for (const file of files) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scannedFiles++;
		const relPath = relativePosix(REPO_ROOT, file);
		const lines = source.split("\n");
		const sites = [...callSites(source, RECORD_CALLEES)];
		// LEDGER_FILE only — see LEDGER_PUSH_CALLEES's own doc comment for why
		// this does not join RECORD_CALLEES for the whole tree.
		if (relPath === LEDGER_FILE) {
			sites.push(...callSites(source, LEDGER_PUSH_CALLEES));
		}
		for (const site of sites) {
			if (!site.optionsLiteral) continue;
			const classified = classifyKindOccurrences(
				site.optionsLiteral,
				source,
				relPath,
			);
			for (const kind of classified.kinds) {
				occurrences.push({
					kind,
					detail: stableOccurrenceKey(relPath, lines, site.line - 1),
				});
			}
			for (const identifier of classified.unresolved) {
				unresolved.push(
					`${relPath}:${site.line} kind: ${identifier} is unresolvable — ` +
						"not a same-file const, not in AUDITED_IDENTIFIER_KIND_SITES (#3140)",
				);
			}
		}
	}
	return { occurrences, scannedFiles, unresolved };
}

describe("DegradationKind call-site literal extraction (#3071)", () => {
	// The sweep is only as good as its needles (`tests/support/sweep-kit.ts`
	// module header's own convention) — pin each shape against a minimal
	// fixture rather than trusting the production scan to exercise all of
	// them.
	it("extracts a bare literal", () => {
		expect(
			kindLiteralsInOptions('{ kind: "config-deprecated", subject: file }'),
		).toEqual(["config-deprecated"]);
	});

	it("extracts both arms of a ternary and never its condition", () => {
		// Named recurrence: an earlier draft of this sweep matched ANY quoted
		// string inside the value text, so `fired === "deadline" ? "a" : "b"`
		// flagged a phantom third kind, `"deadline"` — the ternary's own
		// CONDITION, never assigned to `kind` at all. This fixture is that
		// exact shape (`clients/deadline-utils.ts`'s call site).
		expect(
			kindLiteralsInOptions(
				'{ kind: fired === "deadline" ? "hook-await-exceeded" : "hook-await-abandoned", subject: x }',
			),
		).toEqual(["hook-await-exceeded", "hook-await-abandoned"]);
	});

	it("returns nothing for a pass-through identifier or property access", () => {
		expect(
			kindLiteralsInOptions("{ kind: options.ledgerKind, subject: x }"),
		).toEqual([]);
		expect(kindLiteralsInOptions("{ kind, subject: x }")).toEqual([]);
		expect(
			kindLiteralsInOptions("{ kind: degradationKindFor(a, b), subject: x }"),
		).toEqual([]);
	});

	it("finds the record's own kind ahead of a nested one written later", () => {
		// The realistic shape (every measured call site): `kind` is the FIRST
		// property, so a `kind` nested inside a LATER field (`metadata`) never
		// competes with it — the first "kind:" in source order is the real one.
		expect(
			kindLiteralsInOptions(
				'{ kind: "real-kind", subject: x, metadata: { kind: "decoy" } }',
			),
		).toEqual(["real-kind"]);
	});

	it("strips a comment inside the object literal before matching", () => {
		expect(
			kindLiteralsInOptions('{ /* kind: "decoy" */ kind: "real-kind" }'),
		).toEqual(["real-kind"]);
	});
});

describe("DegradationKind bare-identifier resolution (#3140)", () => {
	// Named recurrence: `clients/config-core/process-spec.ts:345` writes
	// `kind: TRUST_REFUSAL_KIND` — a same-file module constant naming an
	// already-declared kind, not a genuine forwarded parameter — and the
	// pre-#3140 scan returned `[]` for it with no "unresolvable" signal,
	// silently skipping a site that could have been read one line away.

	it("extracts a bare identifier and nothing else", () => {
		expect(bareIdentifierKind("{ kind: TRUST_REFUSAL_KIND, subject: x }")).toBe(
			"TRUST_REFUSAL_KIND",
		);
	});

	it("does not treat a property access or function call as a bare identifier", () => {
		// These stay in the EXISTING silent pass-through bucket — genuine
		// forwarded values, resolved at a deeper caller, unchanged by #3140.
		expect(
			bareIdentifierKind("{ kind: options.ledgerKind, subject: x }"),
		).toBeUndefined();
		expect(
			bareIdentifierKind("{ kind: degradationKindFor(a, b), subject: x }"),
		).toBeUndefined();
	});

	it("does not treat a bare literal as a bare identifier", () => {
		expect(
			bareIdentifierKind('{ kind: "config-deprecated", subject: x }'),
		).toBeUndefined();
	});

	it("resolves a same-file top-level const bound to a string literal", () => {
		const fixtureSource =
			'const TRUST_REFUSAL_KIND = "trust-refusal";\n' +
			"function refuse() { incrementDegradationCount({ kind: TRUST_REFUSAL_KIND }); }\n";
		expect(resolveSameFileConstKind(fixtureSource, "TRUST_REFUSAL_KIND")).toBe(
			"trust-refusal",
		);
	});

	it("does not resolve an identifier reached only through an import", () => {
		// The exact `PROCESS_SINGLETON_RESET_KIND` shape: bound in ANOTHER
		// file, only imported here — one hop past what this rule chases.
		const fixtureSource =
			'import { PROCESS_SINGLETON_RESET_KIND } from "./process-singletons.js";\n' +
			"summary.push({ kind: PROCESS_SINGLETON_RESET_KIND });\n";
		expect(
			resolveSameFileConstKind(fixtureSource, "PROCESS_SINGLETON_RESET_KIND"),
		).toBeUndefined();
	});

	it("does not match a const of the same name in a comment", () => {
		const fixtureSource =
			'// const TRUST_REFUSAL_KIND = "decoy";\n' +
			"someOtherCall({ kind: TRUST_REFUSAL_KIND });\n";
		expect(
			resolveSameFileConstKind(fixtureSource, "TRUST_REFUSAL_KIND"),
		).toBeUndefined();
	});

	// Round 2 finding: the doc comment above promises SAME-FILE TOP-LEVEL, but
	// the regex before this fix had no top-level anchor, so a function-scoped
	// `const` shadowing the same name resolved to ITS value instead of falling
	// through to the loud "unresolvable" report — silently-wrong resolution,
	// exactly the failure mode this design exists to prevent. Latent today (no
	// real call site is shadowed), pinned so it stays that way.
	it("does not resolve a function-scoped const shadowing the same name (no top-level binding)", () => {
		const fixtureSource =
			"function unrelated() {\n" +
			'\tconst TRUST_REFUSAL_KIND = "shadowed-wrong-value";\n' +
			"\treturn TRUST_REFUSAL_KIND;\n" +
			"}\n" +
			"someOtherCall({ kind: TRUST_REFUSAL_KIND });\n";
		expect(
			resolveSameFileConstKind(fixtureSource, "TRUST_REFUSAL_KIND"),
		).toBeUndefined();
	});

	it("resolves the TOP-LEVEL const, not a function-scoped shadow of the same name", () => {
		const fixtureSource =
			'const TRUST_REFUSAL_KIND = "trust-refusal";\n' +
			"function unrelated() {\n" +
			'\tconst TRUST_REFUSAL_KIND = "shadowed-wrong-value";\n' +
			"\treturn TRUST_REFUSAL_KIND;\n" +
			"}\n" +
			"someOtherCall({ kind: TRUST_REFUSAL_KIND });\n";
		expect(resolveSameFileConstKind(fixtureSource, "TRUST_REFUSAL_KIND")).toBe(
			"trust-refusal",
		);
	});

	it("classifies a same-file const identifier as a resolved kind", () => {
		const fixtureSource = 'const TRUST_REFUSAL_KIND = "trust-refusal";\n';
		expect(
			classifyKindOccurrences(
				"{ kind: TRUST_REFUSAL_KIND, subject: x }",
				fixtureSource,
				"clients/config-core/process-spec.ts",
			),
		).toEqual({ kinds: ["trust-refusal"], unresolved: [] });
	});

	it("classifies an audited cross-file identifier as a resolved kind", () => {
		expect(
			classifyKindOccurrences(
				"{ kind: PROCESS_SINGLETON_RESET_KIND, subject: x }",
				'import { PROCESS_SINGLETON_RESET_KIND } from "./process-singletons.js";\n',
				LEDGER_FILE,
			),
		).toEqual({ kinds: ["process-singleton-reset"], unresolved: [] });
	});

	it("reports an unaudited, unresolvable identifier loud instead of silently returning nothing", () => {
		// Red-first fixture (#3140): an identifier kind that is neither a
		// same-file const nor in AUDITED_IDENTIFIER_KIND_SITES must never come
		// back as a bare `[]` the way `kindLiteralsInOptions` alone would —
		// the exact false-negative shape the issue names.
		expect(
			classifyKindOccurrences(
				"{ kind: SOME_UNAUDITED_KIND, subject: x }",
				"// no const declares it in this file\n",
				"clients/somewhere.ts",
			),
		).toEqual({ kinds: [], unresolved: ["SOME_UNAUDITED_KIND"] });
	});

	it("still returns nothing for a property access or function call — the existing silent pass-through", () => {
		expect(
			classifyKindOccurrences(
				"{ kind: options.ledgerKind, subject: x }",
				"",
				"clients/bounded-telemetry.ts",
			),
		).toEqual({ kinds: [], unresolved: [] });
	});
});

// One walk per worker (#3479): the three cases below read the same scan of
// SCAN_ROOTS. Uncached, pre-push ran three full walks in parallel with the
// other tree-scanning suites and each blew vitest's 5 s default. Whichever
// case runs first pays the walk (a `-t` filter can make that a liveness
// case), so the whole block carries the loaded-machine bound.
let scanCache: ReturnType<typeof scanCallSites> | undefined;
function scannedCallSites(): ReturnType<typeof scanCallSites> {
	scanCache ??= scanCallSites();
	return scanCache;
}
const SCAN_TIMEOUT_MS = 30_000;

describe(
	"DegradationKind union coverage (#3071, #3140)",
	{ timeout: SCAN_TIMEOUT_MS },
	() => {
		it("declares every kind literal emitted at a recordDegradationOnce / incrementDegradationCount / logDurableDegradation call site, plus LEDGER_FILE's own read-time fold emitters, and never silently drops an identifier-valued kind", () => {
			const { occurrences, scannedFiles, unresolved } = scannedCallSites();
			// #1718 shape: a walk that resolved to nothing would read as a clean
			// sweep. 400 is comfortably under the ~470 TypeScript files these four
			// trees held at authoring time, so ordinary churn does not trip it.
			assertNonEmptyScan(
				"DegradationKind call-site coverage (files)",
				scannedFiles,
				400,
			);
			// 100 is comfortably under the 118 distinct kinds / 169 occurrences
			// measured at authoring time.
			assertNonEmptyScan(
				"DegradationKind call-site coverage (occurrences)",
				occurrences.length,
				100,
			);

			// #3140: a bare-identifier `kind:` at a scanned call site that is
			// neither a same-file const nor named in AUDITED_IDENTIFIER_KIND_SITES
			// fails LOUD here, with the file:line, rather than vanishing into a
			// silent `[]` that lets an undeclared kind ship unnoticed.
			expect(unresolved).toEqual([]);

			const declared = declaredKinds();
			expect(declared.length).toBeGreaterThan(0);

			// One flagged entry per DISTINCT kind — many call sites legitimately
			// share one kind, which is expected and not a `stableOccurrenceKey`
			// collision; the first occurrence's key is kept as the readable detail.
			const byKind = new Map<string, string>();
			for (const occurrence of occurrences) {
				if (!byKind.has(occurrence.kind)) {
					byKind.set(occurrence.kind, occurrence.detail);
				}
			}
			const flagged = [...byKind.entries()].map(([kind, detail]) => ({
				key: kind,
				detail,
			}));

			const audit = auditRegistry({
				sweepName: "DegradationKind call-site coverage",
				flagged,
				registered: declared,
				scannedCount: scannedFiles,
				minScanned: 400,
				minFlagged: 100,
				remediation:
					"Add the kind to the DegradationKind union in " +
					`${LEDGER_FILE} (alphabetically — ` +
					"tests/config/degradation-kind-order.test.ts enforces the order) " +
					"before shipping a call site that emits it (#3071).",
			});

			expect(audit.problems).toEqual([]);
		});

		// A declared-but-unflagged union member is FINE by design
		// (`auditRegistry`'s own asymmetric policy, module header above) — so the
		// assertion above alone would stay green even if the LEDGER_PUSH_CALLEES
		// branch or the bare-identifier resolution path were deleted entirely,
		// as long as the union still declares the two kinds. These two checks
		// independently confirm the scan actually OBSERVES the occurrence, not
		// only that the union happens to declare it.
		it("actually scans LEDGER_FILE's summary.push emitters, not just the union declaration", () => {
			const { occurrences } = scannedCallSites();
			const kinds = new Set(occurrences.map((occurrence) => occurrence.kind));
			expect(kinds.has("process-singleton-reset")).toBe(true);
		});

		it("actually resolves TRUST_REFUSAL_KIND at its own call site, not only via project-trust.ts's bare literal", () => {
			const { occurrences } = scannedCallSites();
			const resolvedAtProcessSpec = occurrences.some(
				(occurrence) =>
					occurrence.kind === "trust-refusal" &&
					occurrence.detail.includes("process-spec.ts"),
			);
			expect(resolvedAtProcessSpec).toBe(true);
		});
	},
);
