/**
 * The sweep kit's own guard — #1755.
 *
 * Every semantic the kit sells is mutation-proofed here: delete or neuter the
 * guard in `sweep-kit.ts` and at least one test below reds. The attack
 * fixtures are NAMED (`ATTACK_*`) and grouped so a future sweep author reads
 * the threat model out of this file rather than rediscovering it in review, as
 * #1692 did across four rounds.
 *
 * Fixture-based, not repo-based: each probe runs against synthetic source, so
 * a probe's own correctness never depends on nobody editing a real file later.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	assignNearestExclusive,
	auditRegistry,
	bindTagsToSeams,
	checkSeamEvidence,
	findEnclosingSymbol,
	findSeams,
	findUnregisteredSeams,
	hasNearbyCallSite,
	listSourceFiles,
	occurrenceLines,
	relativePosix,
	scanTaggedSeams,
	stableOccurrenceKey,
	stripSource,
	callSites,
	tagPattern,
	assertSortedKeys,
} from "./sweep-kit.js";

describe("sweep-kit: callSites", () => {
	it("uses AST boundaries and returns only the last top-level object literal", () => {
		const source = [
			"// safeSpawnAsync('comment')",
			'const prose = "safeSpawnAsync(\")\" )";',
			"safeSpawnAsync(",
			"  command(1, { nested: true }),",
			"  `args with )`, // safeSpawnAsync()",
			"  { first: true },",
			"  { ...base, cwd },",
			");",
		].join("\n");
		const sites = callSites(source, /^safeSpawnAsync$/);
		expect(sites).toHaveLength(1);
		expect(sites[0]).toMatchObject({
			line: 3,
			callee: "safeSpawnAsync",
			argsText: expect.stringContaining("command(1, { nested: true })"),
			optionsLiteral: "{ ...base, cwd }",
		});
	});

	it("does not match callee text in comments or strings, and handles wrappers", () => {
		const source = [
			"function spawnPs(command, args, opts) {",
			"  return safeSpawnAsync(command, args, opts);",
			"}",
			"spawnPs(command, args, { nested: true }, { cwd });",
			"mySafeSpawnAsync(command, args, opts);",
			"safeSpawnAsyncX(command, args, opts);",
		].join("\n");
		expect(callSites(source, /^safeSpawnAsync$/)).toEqual([
			{
				line: 2,
				callee: "safeSpawnAsync",
				argsText: "command, args, opts",
				optionsLiteral: undefined,
			},
		]);
		expect(callSites(source, /^spawnPs$/)).toMatchObject([
			{ line: 4, callee: "spawnPs", optionsLiteral: "{ cwd }" },
		]);
		expect(callSites(source, /safeSpawnAsync/)).toEqual([
			{
				line: 2,
				callee: "safeSpawnAsync",
				argsText: "command, args, opts",
				optionsLiteral: undefined,
			},
		]);
	});

	it("distinguishes a spread options object from an opaque identifier", () => {
		const source = [
			"safeSpawnAsync(command, { first: true }, { ...base });",
			"safeSpawnAsync(command, args, opts);",
		].join("\n");
		const sites = callSites(source, /^safeSpawnAsync$/);
		expect(sites.map((site) => site.optionsLiteral)).toEqual([
			"{ ...base }",
			undefined,
		]);
	});

	it("keeps timeout text in an argument separate from an options literal", () => {
		const sites = callSites(
			[
				'spawnSync(command, "timeout: 5000");',
				"spawnSync(command, { timeout: 5000 });",
			].join("\n"),
			/^spawnSync$/,
		);
		expect(sites.map((site) => site.optionsLiteral)).toEqual([
			undefined,
			"{ timeout: 5000 }",
		]);
	});
});

// ── The attack catalogue, as named fixtures ─────────────────────────────────

/** #1635 R1: a call named only in a comment is not a call. */
const ATTACK_COMMENT_LAUNDERING = [
	"function handleSessionStart() {",
	"\t// resetZizmorTokenAvailability(); — #1535 says this belongs here",
	"\tresetDegradationLedger();",
	"}",
].join("\n");

/** #1635 R1: a call named only inside a string literal is not a call. */
const ATTACK_STRING_LAUNDERING = [
	"function handleSessionStart() {",
	'\tdbg("calling resetZizmorTokenAvailability() next");',
	"}",
].join("\n");

/**
 * #1635 R2: a preceding-CHARACTER regex check reads the `f` of `typeof` as an
 * identifier, calls the regex a division, and leaves the phantom call visible.
 */
const ATTACK_KEYWORD_POSITION_REGEX = [
	"function handleSessionStart() {",
	"\tif (typeof /resetZizmorTokenAvailability()/) {",
	"\t\tresetDegradationLedger();",
	"\t}",
	"}",
].join("\n");

/** #1635 R2 control: a regex holding an unbalanced brace must not truncate. */
const ATTACK_REGEX_UNBALANCED_BRACE = [
	"function handleSessionStart() {",
	"\tconst re = /[{]/;",
	"\tresetDegradationLedger();",
	"}",
].join("\n");

/**
 * The stripper hole this kit closes for `strings: "keep"` callers: a bare
 * quote inside a regex (`safe-spawn.ts`'s `arg.replace(/"/g, '""')`) makes a
 * comments-only scanner that does not lex regexes read the rest of the file as
 * one string literal — a silent false negative for everything below it.
 */
const ATTACK_QUOTE_INSIDE_REGEX = [
	'const safe = arg.replace(/"/g, \'""\');',
	'advisoryParts.push("the seam that must stay visible");',
].join("\n");

/** #1692 R1a: a second seam pasted right after a tagged one must not inherit. */
const ATTACK_PROXIMITY_LAUNDERING = [
	"function handleTurnEnd() {",
	"\t// @delivery-surface: real-id",
	'\tadvisoryParts.push("the real, registered finding");',
	'\tadvisoryParts.push("a brand-new finding pasted right after it");',
	"}",
].join("\n");

/** #1692 R1a: nor across a blank-line gap. */
const ATTACK_PROXIMITY_LAUNDERING_BLANK_GAP = [
	"function handleTurnEnd() {",
	"\t// @delivery-surface: real-id",
	"",
	'\tadvisoryParts.push("the real, registered finding");',
	"",
	'\tadvisoryParts.push("a second finding, blank-line-separated");',
	"}",
].join("\n");

/** #1692 R1b: a rogue seam wearing a REAL id, far from that id's evidence. */
const ATTACK_VALID_TAG_LAUNDERING_FAR = [
	'const gitleaksGate = gateFindingsByPathFreshness({ store: "gitleaks" });',
	...Array.from({ length: 170 }, (_, i) => `// filler ${i}`),
	"// @delivery-surface: real-id",
	'advisoryParts.push("a rogue finding wearing a real tag, far away");',
].join("\n");

/**
 * #1692 R1c: the rogue seam sits INSIDE the real seam's window, closer to the
 * one real occurrence than the legitimate seam is. Both windows contain it, so
 * a per-region check clears both; exclusive assignment leaves one unsatisfied.
 */
const ATTACK_REGION_OVERLAP = [
	'const gitleaksGate = gateFindingsByPathFreshness({ store: "gitleaks" });',
	...Array.from({ length: 69 }, (_, i) => `// spacer ${i}`),
	"// @delivery-surface: real-id",
	'advisoryParts.push("a rogue finding, CLOSER to the real gate");',
	...Array.from({ length: 29 }, (_, i) => `// spacer b ${i}`),
	"// @delivery-surface: real-id",
	'advisoryParts.push("the finding that would have been the real one");',
].join("\n");

/** #1692 R2: keep the argument literal, swap the callee for an identity stub. */
const ATTACK_IDENTITY_STUB = [
	"function identityStub(x) { return x; }",
	'const gitleaksGate = identityStub({ store: "gitleaks", findings: [] });',
	"// @delivery-surface: real-id",
	'advisoryParts.push("finding");',
].join("\n");

/** The R2 control: the un-stubbed call satisfies argument AND callee. */
const CONTROL_REAL_CALL_SITE = [
	"const gitleaksGate = gateFindingsByPathFreshness({",
	'  store: "gitleaks",',
	"  findings: [],",
	"});",
	"// @delivery-surface: real-id",
	'advisoryParts.push("finding");',
].join("\n");

/**
 * #2502 P1c: a nested template literal inside an interpolation must not read
 * as the outer template's closing backtick. Pre-fix, `stripSource` has no
 * `${` nesting state: the backtick that opens `` `y(` `` (nested inside the
 * ternary) hits the plain `ch === quote` check and is read as the OUTER
 * template's own close. The outer template's real closing backtick, two
 * tokens later, is then lexed as ordinary code instead — and the nested
 * template's own stray `(` (from `` `y(` ``'s text) falls through unmasked.
 */
const ATTACK_NESTED_TEMPLATE_LAUNDERING = [
	"function run(cond) {",
	"\tconst label = `x ${cond ? `y(` : `z`} w`;",
	"\tresetDegradationLedger();",
	"}",
].join("\n");

/**
 * #2502 review round F1: a call written INSIDE a template's `${...}`
 * expression must stay visible to a `strings: "blank"` scan — that
 * visibility is the entire point of #2502 lexing the interpolation as real
 * code instead of opaque template text (see the kit's module doc, "RESOLVED
 * by #2502"). Nothing pinned this: the `templateStack.length > 0` branch
 * that leaves expression characters unblanked has no guard of its own, so
 * re-adding `if (blankStrings) blank(i);` there (restoring the pre-#2502
 * false negative) leaves every existing test green.
 */
const ATTACK_TEMPLATE_EXPRESSION_CALL = "const a = `${resetThing()}`;";

/**
 * #2502 review round F2: the real bug that a `strings: "keep"` nested-
 * template test needs to catch — reproduced from a genuine in-repo
 * divergence, verified by running the pre-#2502 `stripSource` over
 * `scripts/lib/merge-train-lane.mjs`. That file's real nested template at
 * line 299 (`` `\`${c.name}\` (${c.conclusion})` ``) has an ESCAPED backtick
 * (`` \` ``) in its own text; the pre-#2502 scalar `quote` (no nesting
 * state) loses track at that escape and is left stuck "inside a string"
 * past the template's real end. On the old lexer this left the THREE `//`
 * comment lines immediately below it (302-304) completely unblanked under
 * `strings: "keep"` — a comment leak, not the character-leak the `"blank"`
 * fixture above pins. This is the minimal reproduction of that exact
 * mechanism: a nested template whose text contains an escaped backtick,
 * followed by a `//` comment that must still be blanked.
 */
const ATTACK_ESCAPED_BACKTICK_COMMENT_LEAK = [
	"function run(cond) {",
	"\tconst label = `x ${cond ? `\\`y(\\`` : `z`} w`;",
	"\t// trailing comment must stay blanked",
	"\tresetDegradationLedger();",
	"}",
].join("\n");

const SEAM_PATTERN = /\b(blockerParts|advisoryParts|staleSecretParts)\.push\(/;
const TAG = tagPattern("delivery-surface");

// ── 1. Source scanning ──────────────────────────────────────────────────────

describe("sweep-kit: stripSource", () => {
	it("preserves length and line structure (every sweep's index invariant)", () => {
		const source = 'const a = 1; // note\nconst b = "text";\n';
		const stripped = stripSource(source);
		expect(stripped).toHaveLength(source.length);
		expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
		expect(stripped).toContain("const a = 1;");
		expect(stripped).not.toContain("note");
		expect(stripped).not.toContain("text");
	});

	it('strings: "keep" blanks comments but leaves string contents intact (#1692 needs the argument literal)', () => {
		const source = 'const a = "gitleaks"; // a comment naming gitleaks\n';
		const kept = stripSource(source, { strings: "keep" });
		expect(kept).toHaveLength(source.length);
		expect(kept).toContain('"gitleaks"');
		expect(kept).not.toContain("a comment naming");
	});

	it('strings: "keep" still blanks BLOCK comments', () => {
		const source = 'const a = 1; /* gitleaks */ const b = "gitleaks";\n';
		const kept = stripSource(source, { strings: "keep" });
		expect(kept.match(/gitleaks/g)).toHaveLength(1);
	});

	it("ATTACK_COMMENT_LAUNDERING: a call named only in a comment is blanked", () => {
		const stripped = stripSource(ATTACK_COMMENT_LAUNDERING);
		expect(stripped).toContain("resetDegradationLedger();");
		expect(stripped).not.toContain("resetZizmorTokenAvailability");
	});

	it("ATTACK_STRING_LAUNDERING: a call named only in a string is blanked", () => {
		expect(stripSource(ATTACK_STRING_LAUNDERING)).not.toContain(
			"resetZizmorTokenAvailability",
		);
	});

	it("ATTACK_KEYWORD_POSITION_REGEX: a keyword-position regex body is stripped", () => {
		const stripped = stripSource(ATTACK_KEYWORD_POSITION_REGEX);
		expect(stripped).not.toContain("resetZizmorTokenAvailability");
		expect(stripped).toContain("resetDegradationLedger();");
	});

	it("ATTACK_REGEX_UNBALANCED_BRACE: a brace inside a regex does not survive to a brace matcher", () => {
		const stripped = stripSource(ATTACK_REGEX_UNBALANCED_BRACE);
		// The `{` inside the character class is blanked, so a brace counter
		// running over the stripped text sees a balanced function body.
		const braces = stripped.split("").filter((c) => c === "{").length;
		expect(braces).toBe(1);
		expect(stripped).toContain("resetDegradationLedger();");
	});

	it("a value-position regex is still lexed as a regex (the R2 fix must not overshoot)", () => {
		const stripped = stripSource(
			'const safe = arg.replace(/"/g, \'""\');\nconst x = 1;\n',
		);
		expect(stripped).toContain("const x = 1;");
	});

	it('ATTACK_QUOTE_INSIDE_REGEX: strings: "keep" does not swallow the file after a quote inside a regex', () => {
		const kept = stripSource(ATTACK_QUOTE_INSIDE_REGEX, { strings: "keep" });
		expect(kept).toContain("the seam that must stay visible");
		expect(findSeams(kept, SEAM_PATTERN)).toHaveLength(1);
	});

	it("an unterminated string recovers at the line break instead of eating the rest", () => {
		const stripped = stripSource('const a = "oops\nconst b = 2;\n');
		expect(stripped).toContain("const b = 2;");
	});

	it("ATTACK_NESTED_TEMPLATE_LAUNDERING: a nested template's backtick does not close the outer template early", () => {
		const stripped = stripSource(ATTACK_NESTED_TEMPLATE_LAUNDERING);
		expect(stripped).toHaveLength(ATTACK_NESTED_TEMPLATE_LAUNDERING.length);
		// Pre-fix, the nested template's own `(` (from `` `y(` ``'s text)
		// survives unmasked once the inner backtick prematurely closes the
		// outer template's quote — every other paren in this fixture is
		// naturally balanced, so a leaked, unmatched `(` is the tell.
		const opens = stripped.split("(").length - 1;
		const closes = stripped.split(")").length - 1;
		expect(opens).toBe(closes);
		expect(stripped).not.toContain("y(");
		// The real call after the template must stay visible and untouched by
		// the mis-lex — pre-fix, a lucky backtick parity can still leave
		// `quote` cleared by here, but the leaked `(` above is what corrupts a
		// downstream depth scan (see sync-child-process-timeout.test.ts P1c).
		expect(stripped).toContain("resetDegradationLedger();");
	});

	// #2502 review F2 — this test used to run ATTACK_NESTED_TEMPLATE_LAUNDERING
	// under `strings: "keep"`, but that fixture has no `/` and no comment, so
	// `"keep"` (which only ever blanks comments) leaves it byte-identical to
	// source under BOTH the pre-#2502 lexer and the fixed one — the assertion
	// could not fail. Replaced with ATTACK_ESCAPED_BACKTICK_COMMENT_LEAK, whose
	// trailing comment actually distinguishes the two lexers (see its doc for
	// the real-world divergence this reproduces).
	it('ATTACK_ESCAPED_BACKTICK_COMMENT_LEAK: strings: "keep" still blanks a comment after a nested template with an escaped backtick', () => {
		const kept = stripSource(ATTACK_ESCAPED_BACKTICK_COMMENT_LEAK, {
			strings: "keep",
		});
		expect(kept).toHaveLength(ATTACK_ESCAPED_BACKTICK_COMMENT_LEAK.length);
		expect(kept).not.toContain("trailing comment must stay blanked");
		expect(kept).toContain("resetDegradationLedger();");
	});

	// #2502 review F1.
	it('ATTACK_TEMPLATE_EXPRESSION_CALL: a call inside a template\'s ${...} expression stays visible under strings: "blank"', () => {
		const stripped = stripSource(ATTACK_TEMPLATE_EXPRESSION_CALL);
		expect(stripped).toContain("resetThing()");
	});
});

describe("sweep-kit: listSourceFiles", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-kit-"));
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	fs.mkdirSync(path.join(root, "nested"), { recursive: true });
	fs.writeFileSync(path.join(root, "a.ts"), "");
	fs.writeFileSync(path.join(root, "a.d.ts"), "");
	fs.writeFileSync(path.join(root, "a.test.ts"), "");
	fs.writeFileSync(path.join(root, "skip-me.ts"), "");
	fs.writeFileSync(path.join(root, "nested", "b.ts"), "");
	fs.writeFileSync(path.join(root, "nested", "c.mjs"), "");

	it("recurses, skips declarations, and returns sorted posix-relative paths", () => {
		const found = listSourceFiles(root).map((p) => relativePosix(root, p));
		expect(found).toEqual(["a.test.ts", "a.ts", "nested/b.ts", "skip-me.ts"]);
	});

	it("skipTests drops *.test.ts", () => {
		const found = listSourceFiles(root, { skipTests: true }).map((p) =>
			relativePosix(root, p),
		);
		expect(found).toEqual(["a.ts", "nested/b.ts", "skip-me.ts"]);
	});

	it("honours extensions and the exclude predicate", () => {
		const found = listSourceFiles(root, {
			extensions: [".ts", ".mjs"],
			skipTests: true,
			exclude: (rel) => rel === "skip-me.ts",
		}).map((p) => relativePosix(root, p));
		expect(found).toEqual(["a.ts", "nested/b.ts", "nested/c.mjs"]);
	});
});

describe("sweep-kit: findEnclosingSymbol / stableOccurrenceKey (#2475)", () => {
	/** Shaped exactly like a real bounded-eviction-idiom flagged site. */
	const FIXTURE_LINES = [
		"const other = 1;",
		"",
		"export function registerThing(x: string): void {",
		"\tstore.add(x);",
		"\twhile (store.size > CAP) {",
		"\t\tconst oldest = store.values().next().value;",
		"\t\tif (oldest === undefined) break;",
		"\t\tstore.delete(oldest);",
		"\t}",
		"}",
	];
	const FLAGGED_LINE_INDEX = 5; // "const oldest = store.values()...", 0-based

	it("walks up to the nearest top-level declaration", () => {
		expect(findEnclosingSymbol(FIXTURE_LINES, FLAGGED_LINE_INDEX)).toBe(
			"registerThing",
		);
	});

	it("never resolves the flagged line to ITSELF, even when the line is itself const-shaped", () => {
		// The idiom's own shape (`const oldest = ...`) matches the declaration
		// pattern; a top-level occurrence with nothing above it must fall back to
		// the hash, not claim itself as its own enclosing declaration.
		expect(
			findEnclosingSymbol(["const oldest = store.values().next().value;"], 0),
		).toBeUndefined();
	});

	it("does not stop at a nested local — a loop-local `let` must not outrank the enclosing function", () => {
		// This is the exact shape `clients/debug-handles.ts:118`'s real flagged
		// site has: an indented `let evictKey` sits two lines above the flagged
		// `for`, inside the SAME function as `recordTrackedInit`. The first draft
		// of the pattern matched any indentation and resolved to `evictKey`.
		const lines = [
			"function recordTrackedInit(): void {",
			"\tif (map.size >= CAP) {",
			"\t\tlet evictKey: number | undefined;",
			"\t\tfor (const key of map.keys()) {",
			"\t\t\tevictKey = key;",
			"\t\t}",
			"\t}",
			"}",
		];
		expect(findEnclosingSymbol(lines, 3)).toBe("recordTrackedInit");
	});

	it("a key is UNCHANGED when an unrelated line is inserted ABOVE the flagged site — #2475's whole point", () => {
		const before = stableOccurrenceKey(
			"fixture.ts",
			FIXTURE_LINES,
			FLAGGED_LINE_INDEX,
		);

		// Simulate an unrelated PR inserting one line above the flagged site —
		// exactly what #2459, #2449, and #2474 each did to a real EXEMPT_SITES
		// entry, forcing an unrelated re-key every time.
		const after = [
			...FIXTURE_LINES.slice(0, 2),
			"const inserted = 2; // unrelated line landed by another PR",
			...FIXTURE_LINES.slice(2),
		];
		const newFlaggedIndex = FLAGGED_LINE_INDEX + 1;
		expect(after[newFlaggedIndex]).toBe(FIXTURE_LINES[FLAGGED_LINE_INDEX]);

		const afterKey = stableOccurrenceKey("fixture.ts", after, newFlaggedIndex);
		expect(afterKey).toBe(before);

		// Control: quote the OLD `path:line` scheme reproducing the exact bug —
		// the real red-first proof (inserting one comment line above
		// `clients/lsp/session-roots.ts:51` on pre-fix code) turned
		// `clients/lsp/session-roots.ts:51` into `:52` and broke the sweep
		// (`AssertionError: clients/lsp/session-roots.ts:52 is in an exempted
		// file but is not itself exempted`). This assertion is that same shape,
		// held here as a permanent guard against reverting to it.
		const oldStyleBefore = `fixture.ts:${FLAGGED_LINE_INDEX + 1}`;
		const oldStyleAfter = `fixture.ts:${newFlaggedIndex + 1}`;
		expect(oldStyleAfter).not.toBe(oldStyleBefore);
	});

	it("a key CHANGES when the flagged line's own text changes — deleting/rewriting the site still reds", () => {
		const before = stableOccurrenceKey(
			"fixture.ts",
			FIXTURE_LINES,
			FLAGGED_LINE_INDEX,
		);

		const editedLines = [...FIXTURE_LINES];
		editedLines[FLAGGED_LINE_INDEX] =
			"\t\tconst oldest = store.keys().next().value;"; // .values() -> .keys()
		expect(
			stableOccurrenceKey("fixture.ts", editedLines, FLAGGED_LINE_INDEX),
		).not.toBe(before);
	});

	it("a key CHANGES when the enclosing function is renamed", () => {
		const before = stableOccurrenceKey(
			"fixture.ts",
			FIXTURE_LINES,
			FLAGGED_LINE_INDEX,
		);

		const renamedLines = [...FIXTURE_LINES];
		renamedLines[2] = "export function registerOtherThing(x: string): void {";
		expect(
			stableOccurrenceKey("fixture.ts", renamedLines, FLAGGED_LINE_INDEX),
		).not.toBe(before);
	});

	it("falls back to a bare content hash with no enclosing declaration", () => {
		const lines = ["const oldest = store.values().next().value;"];
		expect(stableOccurrenceKey("fixture.ts", lines, 0)).toMatch(
			/^fixture\.ts#[0-9a-f]{8}$/,
		);
	});
});

// ── 2. Registry semantics ───────────────────────────────────────────────────

describe("sweep-kit: auditRegistry", () => {
	const base = {
		sweepName: "probe sweep",
		flagged: ["a.ts", "b.ts", "c.ts"],
		registered: ["a.ts"],
		exemptions: { "b.ts": "a host derivation, rebuilt every turn" },
	};

	it("flags an item that is neither registered nor exempted", () => {
		const audit = auditRegistry(base);
		expect(audit.unaccounted).toEqual(["c.ts"]);
		expect(audit.problems.join("\n")).toContain(
			"neither registered nor exempted",
		);
	});

	it("appends the caller's remediation to the unaccounted message", () => {
		const audit = auditRegistry({
			...base,
			remediation: "Register it or exempt it.",
		});
		expect(audit.problems.join("\n")).toContain("Register it or exempt it.");
	});

	it("passes when every flagged item is accounted for", () => {
		const audit = auditRegistry({ ...base, registered: ["a.ts", "c.ts"] });
		expect(audit.problems).toEqual([]);
		expect(audit.unaccounted).toEqual([]);
	});

	it("does NOT treat a registered-but-unflagged item as a problem", () => {
		// Registries legitimately cover state a mechanical heuristic cannot see
		// (closure-held latches). Only EXEMPTIONS have to be live.
		const audit = auditRegistry({
			...base,
			registered: ["a.ts", "c.ts", "closure-only.ts"],
		});
		expect(audit.problems).toEqual([]);
	});

	it("ATTACK_STALE_ALLOWLIST (#1735): an exemption the scan no longer flags is reported", () => {
		const audit = auditRegistry({
			...base,
			registered: ["a.ts", "c.ts"],
			exemptions: { "gone.ts": "was a host derivation, file since deleted" },
		});
		expect(audit.staleExemptions).toEqual(["gone.ts"]);
		expect(audit.problems.join("\n")).toContain("no longer flags");
	});

	it("an exemption with no reason is rejected", () => {
		const audit = auditRegistry({
			...base,
			registered: ["a.ts", "c.ts"],
			exemptions: { "b.ts": "" },
		});
		expect(audit.reasonlessExemptions).toEqual(["b.ts"]);
	});

	it("an exemption with a token reason is rejected — a reason must be a reason", () => {
		const audit = auditRegistry({
			...base,
			registered: ["a.ts", "c.ts"],
			exemptions: { "b.ts": "  ok  " },
		});
		expect(audit.reasonlessExemptions).toEqual(["b.ts"]);
	});

	// #2487 review round 4 F2. `describe`'s object-`FlaggedEntry` detail
	// lookup (round 3 F1's fix) had no test that actually exercises it: the
	// review found replacing `describe` with the identity function left
	// every test in this file green. This pins the behavior directly —
	// passing a `{ key, detail }` entry whose detail differs from its key
	// must surface that detail, parenthesized, in the `unaccounted` message.
	// Reds if `describe` regresses to returning the bare key.
	it("BLOCKING (#2487 round 4 F2): an unaccounted object-form entry's detail appears in the message, not just its key", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: [
				{ key: "collidingKey", detail: "clients/real-file.ts:42 realFn" },
			],
			registered: [],
			exemptions: {},
		});
		expect(audit.unaccounted).toEqual(["collidingKey"]);
		expect(audit.problems.join("\n")).toContain(
			"collidingKey (clients/real-file.ts:42 realFn)",
		);
	});

	// #1755 review F1. `item in exemptions` walks the prototype chain, so an
	// item NAMED like an Object.prototype member exempts itself against a map
	// that never mentions it — and staleExemptions (own keys only) can never
	// report the phantom, so nothing else catches it either.
	it("ATTACK_PROTOTYPE_EXEMPTION (#1755 F1): a flagged item named toString/constructor does not exempt itself", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["toString", "constructor", "valueOf", "__proto__", "real-item"],
			registered: [],
			exemptions: {},
		});
		expect(audit.unaccounted).toEqual([
			"toString",
			"constructor",
			"valueOf",
			"__proto__",
			"real-item",
		]);
		expect(audit.staleExemptions).toEqual([]);
	});

	it("ATTACK_PROTOTYPE_EXEMPTION: a REAL exemption for such a name still works", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["toString", "real-item"],
			registered: ["real-item"],
			exemptions: {
				toString: "a genuinely reviewed exemption, spelled out here",
			},
		});
		expect(audit.unaccounted).toEqual([]);
		expect(audit.reasonlessExemptions).toEqual([]);
	});

	// #1755 review F4. "Scanned 0 files" and "scanned 370, flagged 0" are two
	// different bugs with two different fixes; one message for both hides which.
	it("F4: a dead WALK and a dead DETECTOR produce different failures", () => {
		const deadWalk = auditRegistry({
			sweepName: "probe sweep",
			flagged: [],
			registered: [],
			scannedCount: 0,
			minScanned: 100,
			minFlagged: 1,
		});
		const deadDetector = auditRegistry({
			sweepName: "probe sweep",
			flagged: [],
			registered: [],
			scannedCount: 370,
			minScanned: 100,
			minFlagged: 1,
		});
		expect(deadWalk.problems.join("\n")).toContain("LOOKED AT 0 source item");
		expect(deadDetector.problems.join("\n")).not.toContain("LOOKED AT");
		expect(deadDetector.problems.join("\n")).toContain("flagged 0 item");
		expect(deadWalk.problems.join("\n")).not.toBe(
			deadDetector.problems.join("\n"),
		);
	});

	it("F4: a healthy walk above its floor adds no walk problem", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["a.ts"],
			registered: ["a.ts"],
			scannedCount: 370,
			minScanned: 100,
		});
		expect(audit.problems).toEqual([]);
		expect(audit.scannedCount).toBe(370);
	});

	it("F4: omitting minScanned skips the walk check entirely", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["a.ts"],
			registered: ["a.ts"],
		});
		expect(audit.problems).toEqual([]);
	});

	it("EMPTINESS (shape 10, #1718): a scan below its declared floor fails, it does not read as clean", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: [],
			registered: [],
			minFlagged: 1,
		});
		expect(audit.unaccounted).toEqual([]); // nothing unaccounted...
		expect(audit.problems.join("\n")).toContain("declared floor"); // ...but NOT clean
	});

	it("EMPTINESS: a half-dead scan below a nonzero floor also fails", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["a.ts"],
			registered: ["a.ts"],
			minFlagged: 40,
		});
		expect(audit.problems.join("\n")).toContain("declared floor");
	});

	// PR #2487 review F1: `stableOccurrenceKey` anchors on the nearest COLUMN-0
	// declaration, so in a class-shaped file every method's flagged occurrence
	// resolves to the SAME symbol (the class name). Two sibling methods that
	// each flag a stereotyped line (`for (const key of map.keys()) {`) then
	// hash identically too, so both occurrences collide on one key — and a
	// single exemption for that key silently excuses BOTH sites, exactly the
	// #2442 F6 "exemption cannot launder a new sibling" shape this sweep exists
	// to catch, reintroduced one layer down. `auditRegistry` must fail LOUD on
	// a duplicate flagged key rather than let the second occurrence ride the
	// first's exemption.
	it("ATTACK_TWIN_OCCURRENCE_COLLISION (#2487 review F1): two distinct occurrences that hash to the same key cannot both ride one exemption", () => {
		// One class, two methods, each with the identical stereotyped eviction
		// line — the reviewer's exact probe shape.
		const twinClassLines = [
			"class ProbeTwinCache {",
			"\tevictFirst() {",
			"\t\tfor (const key of map.keys()) {",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"\tevictSecond() {",
			"\t\tfor (const key of map.keys()) {",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"}",
		];
		const keyA = stableOccurrenceKey(
			"clients/__probe_collision.ts",
			twinClassLines,
			2, // evictFirst's flagged line
		);
		const keyB = stableOccurrenceKey(
			"clients/__probe_collision.ts",
			twinClassLines,
			7, // evictSecond's flagged line
		);
		// Confirms the collision precondition — same enclosing symbol
		// (`ProbeTwinCache`, the nearest column-0 declaration for BOTH methods)
		// and the same content hash (identical flagged line text).
		expect(keyA).toBe(keyB);
		expect(keyA).toBe("clients/__probe_collision.ts#ProbeTwinCache:3737b5dc");

		const audit = auditRegistry({
			sweepName: "probe twin-collision sweep",
			flagged: [keyA, keyB],
			registered: [],
			exemptions: {
				[keyA]: "a single reviewed exemption naming one occurrence",
			},
		});
		// Pre-fix: `keyA`/`keyB` are literally the same string, so BOTH pass the
		// `Object.hasOwn(exemptions, item)` check in `unaccounted` and the audit
		// reads clean — one exemption laundered a second, un-reviewed site.
		expect(audit.problems.join("\n")).toContain("collide");
		expect(audit.problems.join("\n")).toContain(keyA);
	});

	it("a genuinely unique flagged list carries no collision problem", () => {
		const audit = auditRegistry({
			sweepName: "probe sweep",
			flagged: ["a.ts", "b.ts"],
			registered: ["a.ts", "b.ts"],
		});
		expect(audit.problems).toEqual([]);
	});
});

describe("sweep-kit: assertNonEmptyScan", () => {
	it("throws on zero", () => {
		expect(() => assertNonEmptyScan("probe", 0)).toThrow(
			/below the declared floor/,
		);
	});

	it("throws below an explicit floor", () => {
		expect(() => assertNonEmptyScan("probe", 9, 10)).toThrow(
			/below the declared floor/,
		);
	});

	it("passes at the floor", () => {
		expect(() => assertNonEmptyScan("probe", 10, 10)).not.toThrow();
	});
});

// ── 3. Tag and evidence binding ─────────────────────────────────────────────

describe("sweep-kit: seam and tag binding", () => {
	const registry = new Set(["real-id"]);

	it("finds call-shaped seams in stripped source and skips commented ones", () => {
		const source = [
			"function f() {",
			"\t// see also advisoryParts.push(x) in the sibling module",
			'\tadvisoryParts.push("real");',
			"}",
		].join("\n");
		expect(findSeams(stripSource(source), SEAM_PATTERN)).toHaveLength(1);
	});

	it("binds a tag on the immediately preceding non-blank line", () => {
		const source = [
			"// @delivery-surface: real-id",
			'advisoryParts.push("x");',
		].join("\n");
		const tagged = scanTaggedSeams(source, SEAM_PATTERN, TAG);
		expect(tagged).toHaveLength(1);
		expect(tagged[0].ids).toEqual(["real-id"]);
	});

	it("binds a comma-separated multi-id tag", () => {
		const source = [
			"// @delivery-surface: real-id,other-id",
			'advisoryParts.push("x");',
		].join("\n");
		expect(scanTaggedSeams(source, SEAM_PATTERN, TAG)[0].ids).toEqual([
			"real-id",
			"other-id",
		]);
	});

	it("ATTACK_PROXIMITY_LAUNDERING (#1692 R1a): the second seam does not inherit the first seam's tag", () => {
		const problems = findUnregisteredSeams(
			ATTACK_PROXIMITY_LAUNDERING,
			SEAM_PATTERN,
			TAG,
			registry,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/untagged seam/);
		expect(problems[0]).toContain("line 4:");
	});

	it("ATTACK_PROXIMITY_LAUNDERING_BLANK_GAP: a blank-line gap does not let one tag bind two seams", () => {
		const problems = findUnregisteredSeams(
			ATTACK_PROXIMITY_LAUNDERING_BLANK_GAP,
			SEAM_PATTERN,
			TAG,
			registry,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("line 6:");
	});

	it("a tag naming an id outside the registry is flagged", () => {
		const source = [
			"// @delivery-surface: totally-made-up",
			'advisoryParts.push("x");',
		].join("\n");
		const problems = findUnregisteredSeams(
			source,
			SEAM_PATTERN,
			TAG,
			registry,
			"REGISTRY",
		);
		expect(problems[0]).toContain("not in REGISTRY");
	});

	it("a seam-shaped call inside a comment is not a seam", () => {
		const source = "// advisoryParts.push(x) — for reference only";
		expect(findUnregisteredSeams(source, SEAM_PATTERN, TAG, registry)).toEqual(
			[],
		);
	});

	// #1755 review F2: an unbounded blank-line skip binds a tag eight blank
	// lines above a seam — "immediately preceding" in the code, but not on the
	// screen, and a reviewer scrolling that whitespace does not read the two as
	// one unit.
	it("ATTACK_BLANK_GAP_LAUNDERING (#1755 F2): a tag beyond the blank-line budget does not bind", () => {
		const source = [
			"// @delivery-surface: real-id",
			"",
			"",
			"",
			'advisoryParts.push("far below its supposed tag");',
		].join("\n");
		expect(scanTaggedSeams(source, SEAM_PATTERN, TAG)[0].ids).toEqual([]);
		expect(
			findUnregisteredSeams(source, SEAM_PATTERN, TAG, registry)[0],
		).toMatch(/untagged seam/);
	});

	it("F2: one blank line still binds (the default budget), and the budget is a caller option", () => {
		const source = [
			"// @delivery-surface: real-id",
			"",
			'advisoryParts.push("one blank line below its tag");',
		].join("\n");
		expect(scanTaggedSeams(source, SEAM_PATTERN, TAG)[0].ids).toEqual([
			"real-id",
		]);

		const farSource = [
			"// @delivery-surface: real-id",
			"",
			"",
			"",
			'advisoryParts.push("three blank lines below");',
		].join("\n");
		expect(scanTaggedSeams(farSource, SEAM_PATTERN, TAG)[0].ids).toEqual([]);
		expect(
			scanTaggedSeams(farSource, SEAM_PATTERN, TAG, Number.POSITIVE_INFINITY)[0]
				.ids,
		).toEqual(["real-id"]);
	});

	// #1755 review F3: a tag written at the end of a seam line tags nothing,
	// and silently hands itself to the NEXT seam down.
	it("ATTACK_INLINE_TAG (#1755 F3): a trailing tag on a seam line is rejected, not bound", () => {
		const source = 'advisoryParts.push("x"); // @delivery-surface: real-id';
		const tagged = scanTaggedSeams(source, SEAM_PATTERN, TAG);
		expect(tagged[0].ids).toEqual([]);
		expect(tagged[0].inlineTagOnSeamLine).toBe(true);
		const problems = findUnregisteredSeams(source, SEAM_PATTERN, TAG, registry);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/sits on the seam's own line/);
	});

	it("ATTACK_INLINE_TAG: the next seam down does not inherit the misplaced tag either", () => {
		const source = [
			'advisoryParts.push("x"); // @delivery-surface: real-id',
			'advisoryParts.push("y");',
		].join("\n");
		const problems = findUnregisteredSeams(source, SEAM_PATTERN, TAG, registry);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/sits on the seam's own line/);
		expect(problems[1]).toMatch(/untagged seam/);
		expect(problems[1]).toContain("line 2:");
	});

	it("bindTagsToSeams reports no ids when the seam is the first line", () => {
		const seams = [{ line: 1, text: 'advisoryParts.push("x");' }];
		expect(
			bindTagsToSeams('advisoryParts.push("x");', seams, TAG)[0].ids,
		).toEqual([]);
	});
});

describe("sweep-kit: evidence assignment", () => {
	const registryEvidence = ['store: "gitleaks"'];
	const gates = ["gateFindingsByPathFreshness"];

	const check = (rawSource: string) => {
		const strippedLines = stripSource(rawSource, { strings: "keep" }).split(
			"\n",
		);
		return checkSeamEvidence({
			id: "real-id",
			taggedSeams: scanTaggedSeams(rawSource, SEAM_PATTERN, TAG),
			strippedLines,
			evidence: registryEvidence,
			callees: gates,
		});
	};

	it("CONTROL_REAL_CALL_SITE: the honest seam passes", () => {
		expect(check(CONTROL_REAL_CALL_SITE)).toEqual([]);
	});

	it("ATTACK_VALID_TAG_LAUNDERING_FAR (#1692 R1b): a real tag beyond the window is caught", () => {
		const problems = check(ATTACK_VALID_TAG_LAUNDERING_FAR);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	it("ATTACK_REGION_OVERLAP (#1692 R1c): a rogue seam sharing the real seam's window is caught", () => {
		const problems = check(ATTACK_REGION_OVERLAP);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	it("ATTACK_IDENTITY_STUB (#1692 R2): the argument literal alone does not prove the call", () => {
		const problems = check(ATTACK_IDENTITY_STUB);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("exclusivity is scoped per id — two different ids may share one call", () => {
		const source = [
			'const gate = gateFindingsByPathFreshness({ store: "gitleaks" });',
			"// @delivery-surface: real-id",
			'advisoryParts.push("a");',
			"// @delivery-surface: other-id",
			'advisoryParts.push("b");',
		].join("\n");
		const strippedLines = stripSource(source, { strings: "keep" }).split("\n");
		const taggedSeams = scanTaggedSeams(source, SEAM_PATTERN, TAG);
		for (const id of ["real-id", "other-id"]) {
			expect(
				checkSeamEvidence({
					id,
					taggedSeams,
					strippedLines,
					evidence: registryEvidence,
					callees: gates,
				}),
			).toEqual([]);
		}
	});

	it("a declared capacity lets N same-id seams share one occurrence, and only N", () => {
		const source = [
			'const gate = gateFindingsByPathFreshness({ store: "gitleaks" });',
			"// @delivery-surface: real-id",
			'advisoryParts.push("a");',
			"// @delivery-surface: real-id",
			'advisoryParts.push("b");',
		].join("\n");
		const strippedLines = stripSource(source, { strings: "keep" }).split("\n");
		const taggedSeams = scanTaggedSeams(source, SEAM_PATTERN, TAG);
		const withCapacity = (capacity: number) =>
			checkSeamEvidence({
				id: "real-id",
				taggedSeams,
				strippedLines,
				evidence: registryEvidence,
				callees: gates,
				capacity,
			});
		expect(withCapacity(2)).toEqual([]);
		expect(withCapacity(1).length).toBeGreaterThan(0);
	});

	it("a call-shaped needle is its own callee proof and skips the proximity check", () => {
		const source = [
			"const gate = someOtherHelper();",
			...Array.from({ length: 20 }, (_, i) => `// filler ${i}`),
			"// @delivery-surface: real-id",
			'advisoryParts.push("x");',
		].join("\n");
		const strippedLines = stripSource(source, { strings: "keep" }).split("\n");
		expect(
			checkSeamEvidence({
				id: "real-id",
				taggedSeams: scanTaggedSeams(source, SEAM_PATTERN, TAG),
				strippedLines,
				evidence: ["someOtherHelper("],
				callees: gates,
			}),
		).toEqual([]);
	});

	it("no seam carries the id — nothing to prove, no false problem", () => {
		expect(
			checkSeamEvidence({
				id: "absent-id",
				taggedSeams: scanTaggedSeams(CONTROL_REAL_CALL_SITE, SEAM_PATTERN, TAG),
				strippedLines: CONTROL_REAL_CALL_SITE.split("\n"),
				evidence: registryEvidence,
				callees: gates,
			}),
		).toEqual([]);
	});
});

describe("sweep-kit: assignNearestExclusive primitives", () => {
	it("gives an occurrence to the nearest seam and leaves the loser unassigned", () => {
		const assignment = assignNearestExclusive([10, 40], [12], 150, 10, 1);
		expect(assignment.get(10)).toBe(12);
		expect(assignment.has(40)).toBe(false);
	});

	it("capacity N lets N seams claim the same occurrence", () => {
		const assignment = assignNearestExclusive([10, 40], [12], 150, 10, 2);
		expect(assignment.get(10)).toBe(12);
		expect(assignment.get(40)).toBe(12);
	});

	it("an occurrence outside the window is not a candidate", () => {
		expect(assignNearestExclusive([200], [10], 150, 10, 1).size).toBe(0);
	});

	it("the forward window is asymmetric — evidence after a seam is bounded tighter", () => {
		expect(assignNearestExclusive([10], [19], 150, 10, 1).size).toBe(1);
		expect(assignNearestExclusive([10], [21], 150, 10, 1).size).toBe(0);
	});

	it("occurrenceLines reports 1-based lines", () => {
		expect(occurrenceLines("a\nneedle\nb\nneedle", "needle")).toEqual([2, 4]);
	});

	it("hasNearbyCallSite requires the call SHAPE, not the bare name", () => {
		const lines = ["const x = gateFindings;", 'store: "gitleaks"'];
		expect(hasNearbyCallSite(lines, 1, "gateFindings", 3)).toBe(false);
		expect(
			hasNearbyCallSite(["gateFindings(", 'store: "x"'], 1, "gateFindings", 3),
		).toBe(true);
	});

	it("hasNearbyCallSite respects the proximity bound", () => {
		const lines = ["gateFindings(", "", "", "", 'store: "x"'];
		expect(hasNearbyCallSite(lines, 4, "gateFindings", 3)).toBe(false);
		expect(hasNearbyCallSite(lines, 4, "gateFindings", 4)).toBe(true);
	});
});

describe("assertSortedKeys (#2671)", () => {
	// Recurrence: review round 1 of PR #2757 — duplicate keys passed the
	// order check because Object.keys had already collapsed them upstream;
	// the predicate itself must refuse a duplicate.
	it("rejects a duplicate key before checking order", () => {
		expect(() => assertSortedKeys("fixture", ["a", "a"])).toThrow(
			"entries must be unique",
		);
	});
	it("names the first out-of-order key", () => {
		expect(() => assertSortedKeys("fixture", ["a", "c", "b"])).toThrow(
			"first out-of-order key is c",
		);
	});
});
