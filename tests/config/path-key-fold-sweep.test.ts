/**
 * #1193 P3 enforcement: no NEW hand-rolled path transformation outside
 * `clients/path-utils.ts`.
 *
 * `toPosix` exists because the idiom `p.replace(/\\/g, "/")` was hand-copied
 * across the tree, and its own doc comment states the reason a lint rule was
 * impossible before the fold: "today a bare inline `.replace(/\\/g, "/")` is
 * byte-identical to the sanctioned use so it can't be ruled (#1158); once
 * everything routes through `toPosix`, an un-migrated inline `.replace`
 * becomes detectable." This is that detector. Four merged September path-key
 * defects (#3159, #3169, #3178 — four rounds — and #3192) are the recurrence
 * it prevents: every one of them was two spellings of one path deriving two
 * keys, and every new hand-rolled fold is a fresh chance at the same bug.
 *
 * It pins TWO shapes, per file, as a shrink-only census (`auditSymbolCounts`,
 * the same machinery the session-state sweep uses — a file whose count moves
 * in EITHER direction presents an id the pin does not name and fails loud):
 *
 *   A. **Raw separator fold** — a literal `.replace(/\\/g, "/")`. The
 *      sanctioned spelling is `toPosix`.
 *   B. **Path-key case fold** — a `.toLowerCase()` applied to the result of a
 *      `path`/`win32`/`posix` call, or sitting in the same statement as a
 *      `"win32"` platform test. The sanctioned spellings are
 *      `normalizeEphemeralMapKey` (process-local, same-run keys) and
 *      `normalizeMapKey`/`normalizeFilePath` (filesystem-canonical keys).
 *
 * Scanned trees are `clients/`, `tools/`, `mcp/` and `index.ts` — the runtime
 * surface where a path becomes a map key. `scripts/` is deliberately out:
 * its `.mjs` helpers run before `npm run build` in workflows that never
 * install, so they cannot import the compiled seam (the same build-order
 * constraint `tests/config/escape-regexp-fold-sweep.test.ts` documents),
 * and none of them derives a map key.
 *
 * Both shapes are matched against CODE ONLY, under
 * `stripSource(..., { strings: "blank" })`: comments, string literals AND
 * template-literal TEXT are blanked, while a template's `${...}` interpolation
 * keeps being lexed as ordinary code (`stripSource` has done that since #2502),
 * so a fold inside an interpolation still counts. Round 1 shipped
 * `strings: "keep"` here and review finding F1 proved the hole with the
 * detector's own export — `countPathCaseFolds("const doc = \`path.resolve(p)
 * .toLowerCase()\`;")` answered **1**, and the separator needle behaved the
 * same way. That is the self-excuse direction AGENTS.md defect shape 38 forbids:
 * a string copy of the needle could make an unregistered fold read as live, or
 * keep a pin looking current after its real fold was deleted.
 *
 * `strings: "keep"` was chosen in round 1 because shape A's needle IS a regex
 * literal (blanking erases the regex body) and shape B's arm 2 keyed on the
 * `"win32"` string. Both evidences are retained WITHOUT it, and each has its
 * own test below:
 *
 * - shape A goes through `codeMatches` (`tests/support/sweep-kit.ts:477`),
 *   which already solves exactly this: it matches the needle on RAW source,
 *   then keeps only the matches whose span is still code in the
 *   strings-blanked text. The regex body is therefore visible to the MATCH and
 *   invisible to the laundering check. No new stripper, and no new option on
 *   `stripSource` — the kit already owned the mechanism.
 * - shape B arm 2 keys on the `platform` IDENTIFIER of the comparison
 *   (`platform ===`, `process.platform !==`) rather than the `"win32"` literal
 *   it is compared against. An identifier survives string blanking, cannot be
 *   written inside a string to launder a site, and is the structural fact
 *   rather than one spelling of it (AGENTS.md defect shape 34).
 *
 * SWEEP_HEURISTIC_LIMITS.
 *
 * 1. Shape B's second arm keys on a `"win32"` literal in the same statement, so
 *    a fold behind an already-hoisted boolean
 *    (`const isWin = process.platform === "win32"; … isWin ? x.toLowerCase() : x`)
 *    is not detected. That is a known blind spot, not a silent one: shape B's
 *    first arm still catches every fold applied DIRECTLY to a path expression,
 *    which is how all five #1193 P3 members were written.
 * 2. `PATH_CALL` requires a `path.`/`win32.`/`posix.` qualifier, so a BARE
 *    `resolve(`/`join(` imported from `node:path` is invisible to shape B's
 *    first arm. Measured on `clients/dispatch/runners/go-vet.ts`, whose import
 *    style is bare: the qualified needle matched 0 occurrences there and the
 *    bare call was the live one (#3278 criterion 4). Widening the qualifier
 *    here would pull `relative`/`join` calls in dozens of files into a census
 *    about KEY derivation, so the family that actually needed the bare form —
 *    "a runner compares a tool-reported path against the dispatched file" — is
 *    counted by its own detector instead:
 *    `tests/config/reported-path-attribution-sweep.test.ts`, whose
 *    `PATH_CALL_HERE` makes the qualifier optional.
 * 3. This sweep counts FOLDS THAT EXIST. A site with no fold at all presents
 *    nothing to count, which is why it could not see any of #3278's twelve
 *    members; absence in this family is the other detector's job.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	codeMatches,
	listSourceFiles,
	matchingCloseIndex,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to own both transformations. */
const CANONICAL_FILE = "clients/path-utils.ts";

/** Shape A: the literal `.replace(/\\/g, "/")` idiom `toPosix` replaced. */
const SLASH_FOLD = /\.replace\(\s*\/\\\\\/g\s*,\s*["'`]\/["'`]\s*\)/g;

/**
 * A call that produces a path IDENTITY; shape B's first arm roots here.
 *
 * `basename`/`extname`/`dirname` are deliberately NOT here. Lowercasing a
 * BASENAME or an EXTENSION is file-KIND detection (`tool-policy.ts`'s
 * `path.extname(filePath).toLowerCase()`, `formatters.ts`'s dockerfile check,
 * `instance-reaper.ts`'s process-name match) — a different transformation with
 * a different correctness argument, and folding it into this census would bury
 * the path-key signal under ~10 unrelated sites.
 */
const PATH_CALL =
	/\b(?:(?:path|win32|posix)\s*\.\s*(?:resolve|normalize|join|relative)|toPosix)\s*\(/g;

/**
 * A comparison against a `platform` identifier — `platform === "win32"`,
 * `process.platform !== "win32"`, `platform == WIN32`. Shape B's second arm
 * roots here instead of on the compared string, which this scan blanks.
 */
const PLATFORM_TEST = /\bplatform\s*[!=]==?/;

/**
 * Each method call in the chain that follows `closeIndex`, up to 8 links, with
 * the index of its own name. Both shape-B arms key the flagged set on a
 * `.toLowerCase()`'s OWN position, so a site both arms see counts once.
 */
function chainedCallsAfter(
	source: string,
	closeIndex: number,
): Array<{ name: string; index: number }> {
	const links: Array<{ name: string; index: number }> = [];
	let cursor = closeIndex + 1;
	for (let link = 0; link < 8; link++) {
		const next = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(cursor));
		if (!next) break;
		links.push({ name: next[1], index: cursor + next[0].indexOf(next[1]) });
		const open = cursor + next[0].length - 1;
		const close = matchingCloseIndex(source, open, "(", ")");
		if (close === -1) break;
		cursor = close + 1;
	}
	return links;
}

/** The statement `index` sits in, bounded by the nearest `;`, `{` or `}`. */
function enclosingStatement(source: string, index: number): string {
	let start = index;
	while (start > 0 && !";{}".includes(source[start - 1])) start--;
	let end = index;
	while (end < source.length && !";{}".includes(source[end])) end++;
	return source.slice(start, end);
}

/**
 * The ONE stripping policy this sweep scans under — the shape-B census and the
 * laundering self-tests below both go through it, so a single edit here can
 * never leave the self-tests guarding a policy the census no longer uses.
 * Shape A does not call it: `codeMatches` applies the same policy internally
 * for its own laundering filter, which is why it can match a regex body that
 * this text has blanked.
 */
export function stripForScan(raw: string): string {
	return stripSource(raw, { strings: "blank" });
}

/**
 * Shape A occurrences in RAW source.
 *
 * Takes raw, not stripped, on purpose: `codeMatches` needs the unblanked regex
 * body to MATCH and the blanked text to JUDGE, and a caller that pre-stripped
 * would have destroyed one of the two. Making the raw string the only accepted
 * input removes the chance of passing the wrong text (F1's shape, one layer up).
 */
export function countSlashFolds(raw: string): number {
	return codeMatches(raw, SLASH_FOLD).length;
}

/** Shape B occurrences in already-stripped source. */
export function countPathCaseFolds(stripped: string): number {
	const flagged = new Set<number>();
	// Arm 1: `.toLowerCase()` somewhere in the chain hanging off a path call.
	for (const match of stripped.matchAll(PATH_CALL)) {
		const open = match.index + match[0].length - 1;
		const close = matchingCloseIndex(stripped, open, "(", ")");
		if (close === -1) continue;
		for (const link of chainedCallsAfter(stripped, close)) {
			if (link.name === "toLowerCase") flagged.add(link.index);
		}
	}
	// Arm 2: `.toLowerCase()` in the same statement as a `platform` comparison.
	// The IDENTIFIER, not the `"win32"` literal it is compared against (F1): a
	// string literal is blanked by this scan's policy, and keying on one
	// spelling of the compared value is defect shape 34 besides.
	for (const match of stripped.matchAll(/\.\s*toLowerCase\s*\(\s*\)/g)) {
		const statement = enclosingStatement(stripped, match.index);
		if (!PLATFORM_TEST.test(statement)) continue;
		flagged.add(match.index + match[0].indexOf("toLowerCase"));
	}
	return flagged.size;
}

interface Census {
	slashFolds: Record<string, number>;
	caseFolds: Record<string, number>;
	scanned: number;
}

// Real per-tree floors, set well below each tree's population at authoring
// time (438/18/6/1) so ordinary growth never trips them, but a tree dropped
// from the walk reliably does — the #1718 empty-sweep shape.
const SCAN_ROOTS: ReadonlyArray<{ dir: string; floor: number }> = [
	{ dir: "clients", floor: 380 },
	{ dir: "tools", floor: 12 },
	{ dir: "mcp", floor: 3 },
];

function census(): Census {
	const files: string[] = [];
	for (const { dir, floor } of SCAN_ROOTS) {
		// `listSourceFiles` throws on a missing root; a renamed tree must fail
		// loud rather than quietly scan fewer files.
		const found = listSourceFiles(path.join(REPO_ROOT, dir), {
			extensions: [".ts"],
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/`, found.length, floor);
		files.push(...found);
	}
	files.push(path.join(REPO_ROOT, "index.ts"));

	const slashFolds: Record<string, number> = {};
	const caseFolds: Record<string, number> = {};
	for (const file of files) {
		const rel = relativePosix(REPO_ROOT, file);
		if (rel === CANONICAL_FILE) continue;
		const raw = readWalkedFile(file);
		if (raw === undefined) continue;
		const slash = countSlashFolds(raw);
		const lower = countPathCaseFolds(stripForScan(raw));
		if (slash > 0) slashFolds[rel] = slash;
		if (lower > 0) caseFolds[rel] = lower;
	}
	return { slashFolds, caseFolds, scanned: files.length };
}

/**
 * Pins the scan no longer confirms, `file@pinned` → `file@live`.
 *
 * `auditSymbolCounts` is deliberately asymmetric — a REGISTERED id the scan
 * stops flagging is fine there, because a registry routinely covers state a
 * heuristic cannot see. A shrink-only CENSUS is the opposite case: a row that
 * no longer describes a live fold is dead weight that makes the table read as
 * bigger than the debt it tracks, and the next migration slice would have no
 * signal that its deletion landed. Mutation M3c proved the gap — removing
 * `feature-hints.ts`'s fold left the sweep green under the audit alone.
 */
function stalePins(
	counts: Readonly<Record<string, number>>,
	pins: Readonly<Record<string, number>>,
): string[] {
	return Object.entries(pins)
		.filter(([file, pinned]) => (counts[file] ?? 0) !== pinned)
		.map(([file, pinned]) => `${file}@${pinned} -> ${counts[file] ?? 0}`);
}

const REMEDIATION =
	"A path transformation moved. Route a separator fold through `toPosix` and " +
	"a path-KEY case fold through `normalizeEphemeralMapKey` (process-local, " +
	"same-run) or `normalizeMapKey` (filesystem-canonical), both in " +
	`${CANONICAL_FILE} — then update this file's pin. Refs #1193.`;

/**
 * The raw-separator-fold census at #1193 P3, file → occurrence count. Every
 * row is an UNMIGRATED site, not an approved one: this table is the shrink
 * target the umbrella issue's P3/P4 slices work down. `auditSymbolCounts`
 * fails on movement in EITHER direction, so a new fold in a listed file, a
 * fold in an unlisted file, and a fold REMOVED without updating the pin all
 * red — the removal direction is what makes the table shrink deliberately
 * instead of drifting.
 */
const SLASH_FOLD_PINS: Readonly<Record<string, number>> = {
	"clients/actionable-warnings.ts": 1,
	"clients/cache-manager.ts": 1,
	"clients/codebase-model.ts": 1,
	"clients/config-locations.ts": 1,
	"clients/dispatch/dispatcher.ts": 1,
	"clients/dispatch/integration.ts": 2,
	"clients/dispatch/runner-context.ts": 3,
	"clients/dispatch/runners/actionlint.ts": 1,
	"clients/feature-hints.ts": 1,
	"clients/file-role.ts": 2,
	"clients/file-utils.ts": 2,
	"clients/finding-identity.ts": 1,
	"clients/git-guard.ts": 1,
	"clients/lens-engine.ts": 2,
	"clients/lsp/client.ts": 1,
	"clients/lsp/edits.ts": 3,
	"clients/lsp/index.ts": 2,
	"clients/lsp/server.ts": 1,
	"clients/mcp/review.ts": 1,
	"clients/review-graph/workspace-modules.ts": 4,
	"clients/rules-scanner.ts": 1,
	"clients/test-runner-client.ts": 1,
	"clients/tool-cwd.ts": 1,
	"clients/zizmor-config.ts": 1,
	"index.ts": 1,
	"tools/lsp-navigation.ts": 1,
};

/**
 * The path-key case-fold census, file → occurrence count. Every remaining row
 * carries a written reason, because each is a deliberate decision rather than
 * an unmigrated copy (`dispatch/runners/elixir-check.ts@2` was the fourth and
 * is gone: its comparison now asks `pathsEqual`, #1193's on-disk identity
 * seam):
 *
 * - `lsp/launch.ts` — the PATH-entry dedupe key, whose `platform` is an
 *   explicit ARGUMENT (`combinePathValuesForPlatform`); the seam reads
 *   `process.platform`, so it cannot express the simulated arm the ubuntu lane
 *   tests. See that function's own doc comment.
 * - `mcp/ipc.ts` — the cross-process IPC rendezvous hash, folded only on the
 *   platforms whose filesystem folds case (#3255). Deliberately NOT a map key:
 *   see the `workspaceHash` doc comment for why a pure derivation is required
 *   there and why neither seam fits — its `platform` is an injected argument,
 *   which `normalizeEphemeralMapKey`'s `process.platform` read cannot express.
 *   (A second, deletion-only fold reproducing the retired always-fold rule was
 *   pinned here at @2 for one round and then deleted: on a case-sensitive host
 *   that id is the colliding one, so the file it named could belong to a live
 *   case-variant sibling.)
 * - `runtime-tool-call.ts` — `toPosix(path.resolve(f)).toLowerCase()`, where
 *   the fold is the haystack for lowercase MARKER substrings, not a key.
 */
const CASE_FOLD_PINS: Readonly<Record<string, number>> = {
	"clients/lsp/launch.ts": 1,
	"clients/mcp/ipc.ts": 1,
	"clients/runtime-tool-call.ts": 1,
};

describe("path transformation single-source-of-truth (#1193)", () => {
	it("has no unpinned raw separator fold outside the canonical leaf", () => {
		const { slashFolds, scanned } = census();
		assertNonEmptyScan("clients/tools/mcp/index.ts source files", scanned, 400);
		const audit = auditSymbolCounts({
			sweepName: "raw separator fold (#1193 shape A)",
			counts: slashFolds,
			pinned: SLASH_FOLD_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(slashFolds, SLASH_FOLD_PINS),
			"a pinned separator fold is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("has no unpinned path-key case fold outside the canonical leaf", () => {
		const { caseFolds } = census();
		const audit = auditSymbolCounts({
			sweepName: "path-key case fold (#1193 shape B)",
			counts: caseFolds,
			pinned: CASE_FOLD_PINS,
			remediation: REMEDIATION,
		});
		expect(audit.problems).toEqual([]);
		expect(
			stalePins(caseFolds, CASE_FOLD_PINS),
			"a pinned path-key case fold is gone — good, now shrink the pin",
		).toEqual([]);
	}, 30_000);

	it("the canonical leaf still owns both transformations", () => {
		const raw = readFileSync(path.join(REPO_ROOT, CANONICAL_FILE), "utf8");
		const stripped = stripForScan(raw);
		expect(countSlashFolds(raw)).toBeGreaterThan(0);
		expect(/export function toPosix\s*\(/.test(stripped)).toBe(true);
		expect(/export function normalizeEphemeralMapKey\s*\(/.test(stripped)).toBe(
			true,
		);
	});
});

/**
 * The detector's own threat model, as literal snippets — the #1692 attack
 * catalogue applied to this sweep, one NAMED case per attack.
 *
 * Every case runs the SAME policy the census does (`stripForScan` for shape B,
 * `codeMatches`'s own internal blanking for shape A), so weakening that policy
 * reds here and not only in a whole-tree count nobody can read. The
 * template-literal cases are review finding F1: round 1 scanned under
 * `strings: "keep"` and both needles counted 1 when written as template TEXT.
 */
describe("path-fold detectors resist comment and string laundering", () => {
	const strip = stripForScan;
	const SLASH_NEEDLE = String.raw`p.replace(/\\/g, "/")`;
	const CASE_NEEDLE = "path.resolve(p).toLowerCase()";

	it("flags a real separator fold", () => {
		expect(countSlashFolds(`const a = ${SLASH_NEEDLE};`)).toBe(1);
	});

	it("does not flag a separator fold written only in a line comment", () => {
		expect(countSlashFolds(`// legacy: ${SLASH_NEEDLE} is banned\n`)).toBe(0);
	});

	it("does not flag a separator fold written only in a block comment", () => {
		expect(countSlashFolds(`/** never write ${SLASH_NEEDLE} */\n`)).toBe(0);
	});

	it("does not flag a separator fold written only in a string literal", () => {
		expect(countSlashFolds(`const doc = '${SLASH_NEEDLE}';`)).toBe(0);
	});

	it("does not flag a separator fold written only as template-literal text", () => {
		// F1. Pre-fix this answered 1.
		expect(countSlashFolds("const doc = `" + SLASH_NEEDLE + "`;")).toBe(0);
	});

	it("flags a separator fold inside a template interpolation", () => {
		// The other half of F1's remedy: `${...}` is CODE, so a real fold there
		// must still count. A policy that blanked whole templates would zero it.
		expect(countSlashFolds("const t = `${" + SLASH_NEEDLE + "}`;")).toBe(1);
	});

	it("does not flag a replacement string that is not the posix separator", () => {
		// `.replace(/\\/g, "\\\\")` is backslash ESCAPING, not a posix fold —
		// `scripts/capture-runner-output.mjs:108` is the live example. `codeMatches`
		// matches on RAW source, so the needle still requires the literal `/`
		// replacement; only the laundering JUDGEMENT runs on blanked text.
		expect(countSlashFolds(String.raw`const a = p.replace(/\\/g, "\\");`)).toBe(
			0,
		);
	});

	it("flags a case fold applied to a resolved path", () => {
		expect(countPathCaseFolds(strip(`const k = ${CASE_NEEDLE};`))).toBe(1);
	});

	it("flags a case fold behind a platform test", () => {
		expect(
			countPathCaseFolds(
				strip('const k = process.platform === "win32" ? n.toLowerCase() : n;'),
			),
		).toBe(1);
	});

	it("does not flag a case fold described only in a comment", () => {
		expect(
			countPathCaseFolds(
				strip(`// we used to do ${CASE_NEEDLE} on win32\nconst k = p;`),
			),
		).toBe(0);
	});

	it("does not flag a case fold written only in a string literal", () => {
		expect(countPathCaseFolds(strip(`const doc = '${CASE_NEEDLE}';`))).toBe(0);
	});

	it("does not flag a case fold written only as template-literal text", () => {
		// F1's exact reviewer probe. Pre-fix this answered 1.
		expect(
			countPathCaseFolds(strip("const doc = `" + CASE_NEEDLE + "`;")),
		).toBe(0);
	});

	it("flags a case fold inside a template interpolation", () => {
		expect(
			countPathCaseFolds(strip("const t = `${" + CASE_NEEDLE + "}`;")),
		).toBe(1);
	});

	it("does not flag a platform test whose win32 spelling is only a string", () => {
		// Arm 2 keys on the `platform` identifier, so a bare `"win32"` string
		// next to an unrelated `.toLowerCase()` is not evidence of a path key.
		expect(
			countPathCaseFolds(
				strip('const label = "win32"; const l = name.toLowerCase();'),
			),
		).toBe(0);
	});

	it("does not flag a basename or extension case fold", () => {
		// File-KIND detection, not key derivation — the narrowing PATH_CALL
		// documents. A pin row here would bury the path-key signal.
		expect(
			countPathCaseFolds(strip("const ext = path.extname(f).toLowerCase();")),
		).toBe(0);
		expect(
			countPathCaseFolds(strip("const b = path.basename(f).toLowerCase();")),
		).toBe(0);
	});

	it("counts one case fold per site, not once per detecting arm", () => {
		// `path.resolve(...).toLowerCase()` inside a platform ternary matches
		// BOTH arms; the flagged set is keyed by position so the pin stays a
		// count of SITES.
		expect(
			countPathCaseFolds(
				strip(
					'const k = process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);',
				),
			),
		).toBe(1);
	});
});
