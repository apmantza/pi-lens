/**
 * #2558: forbid a NEW copy of the regex-escaping helper outside
 * `clients/string-utils.ts`.
 *
 * Before this issue, `escapeRegExp` (and near-namesakes `escapeRegExpChar`,
 * `escapeRegExpLiteral`, and a renamed `escapeRegex`) was hand-copied into
 * eight production modules and four test helpers, all with the byte-identical
 * body `x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` — found by grepping the
 * NAME (`function escapeRegExp`), which a renamed copy trivially evades
 * (`scripts/lib/astgrep-self-scan.mjs` shipped exactly that: `escapeRegex`,
 * same body, different name). `clients/string-utils.ts` now owns the one
 * runtime copy and `tests/support/sweep-kit.ts` re-exports it for the test
 * side; every former copy imports from one of those instead.
 *
 * This sweep matches the ESCAPING BODY, not the function's name (AGENTS.md
 * defect shape 38 — "cheapest evasion" screen: a guard that only matches a
 * name is defeated by a rename that keeps the body). It flags two shapes,
 * both meaning "a reusable escaping helper duplicates this body":
 *
 *   A. `function <name>(<param>) { ... return <param>.replace(<escape>); }`
 *   B. `(<param>) => <param>.replace(<escape>)` (arrow, parenthesized or
 *      bare single param) — this is also how `feature-hints.ts`'s inline
 *      `.map((token) => token.replace(...))` copy read before its fold, so
 *      an inline arrow callback counts as a "definition" too.
 *
 * Round 2 (F1): the scan tree used to stop at `clients`/`tools`/`mcp`/`tests`
 * with only `.ts`, so the very recurrence this file's header names —
 * `scripts/lib/astgrep-self-scan.mjs`'s renamed `escapeRegex` — was outside
 * the swept tree and a reintroduction there passed silently. `scripts` is now
 * scanned too, with `.mjs` added to the extensions (never bare `.js`: a bare
 * `.js` would also match compiled output sitting next to its `.ts` source —
 * `clients/string-utils.js` itself — and self-flag the canonical file's own
 * build artifact as a second "copy" of its own body).
 *
 * It deliberately does NOT flag a bare inline `value.replace(<escape>)` that
 * is not itself a function/arrow body — e.g. `const escapedSha =
 * mergeSha.replace(...)` in `scripts/lib/merge-train-lane.mjs`, and the same
 * shape in `scripts/rollup-changelog.mjs`, `scripts/run-all-ts-rules-posthog.mjs`,
 * and `scripts/lib/compat-contracts.mjs`: each is a single one-off
 * computation at its own call site, not a copy-pasted HELPER. These four
 * specifically stay un-folded (not merely un-flagged) because
 * `merge-train-lane.mjs`'s workflow (`.github/workflows/merge-train-lane.yml`)
 * runs `node scripts/merge-train-lane.mjs` directly with no `npm install`/
 * `npm run build` step before it, so importing the compiled
 * `clients/string-utils.js` there would 404 that job; the other three keep
 * the same one-off shape for consistency rather than for their own
 * build-order reason. (Round 2 F3: three PLAIN test-side one-offs that
 * looked like the same case — `tests/clients/deps-centralization.test.ts`,
 * `tests/clients/config-deprecation-registry.test.ts`,
 * `tests/support/public-surface-drift.ts` — turned out to have no such
 * constraint and are folded onto the `sweep-kit.js` re-export instead.)
 *
 * A DIFFERENT character class is a variant, not a copy, and stays out of
 * this sweep's reach on purpose: `clients/file-utils.ts`'s `globToRegExp`
 * omits `*` and `?` from the escaped set because its caller handles those
 * two glob wildcards itself immediately afterward.
 *
 * Uses `stripSource(..., { strings: "keep" })` (`tests/support/sweep-kit.ts`)
 * so comments are blanked (a fake definition written only in a comment must
 * not count — the #1635/#1692 comment-laundering shape) while regex literals
 * and string contents are preserved (the default "blank" policy blanks
 * regex bodies too, which would erase the very escape sequence this sweep
 * matches on).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to define the escaping body. */
const CANONICAL_FILE = "clients/string-utils.ts";

// The literal idiom, as it appears in source: `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`
// (quote style may vary; whitespace around the comma may vary).
const ESCAPE_CALL = String.raw`\.replace\(\s*\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g\s*,\s*["'\`]\\\\\$&["'\`]\s*\)`;

/** Shape A: a function declaration/expression whose body returns the escape. */
const FUNCTION_SHAPE = new RegExp(
	String.raw`function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)[^{]*\{\s*return\s+[A-Za-z_$][\w$]*` +
		ESCAPE_CALL +
		String.raw`\s*;?\s*\}`,
);

/** Shape B: an arrow function (parenthesized or bare single param) whose
 * expression body is the escape — including an inline callback such as
 * `.map((token) => token.replace(...))`. */
const ARROW_SHAPE = new RegExp(
	String.raw`(?:\(\s*[A-Za-z_$][\w$]*[^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[\w$]+)?\s*=>\s*[A-Za-z_$][\w$]*` +
		ESCAPE_CALL,
);

// ".mjs", not ".js": scripts/lib/*.mjs are hand-written source, but a bare
// ".js" would also match compiled output sitting next to its .ts source
// (clients/string-utils.js itself, and every other clients/*.js this repo's
// build emits in place) and self-flag the canonical file's own build
// artifact as a second "copy" of its own body.
const CANDIDATE_EXTENSIONS = [".ts", ".mjs"];

// A real per-directory floor (not the `assertNonEmptyScan` default of 1) —
// set well below each directory's actual population (434/17/5/91/1073 at
// authoring time) so normal file growth/removal never trips it, but a
// directory silently dropped from the scan (e.g. `scripts` reverted after
// F1, or a whole tree renamed) reliably does. Mirrors
// `tests/config/tracked-control-bytes.test.ts`'s per-population floors.
const CANDIDATE_DIRS: ReadonlyArray<{ dir: string; floor: number }> = [
	{ dir: "clients", floor: 380 },
	{ dir: "tools", floor: 10 },
	{ dir: "mcp", floor: 3 },
	{ dir: "scripts", floor: 60 },
	{ dir: "tests", floor: 900 },
];

function listCandidateFiles(): string[] {
	const files: string[] = [];
	for (const { dir, floor } of CANDIDATE_DIRS) {
		const abs = path.join(root, dir);
		// A configured scan directory that has gone missing (renamed, deleted)
		// must fail loud, not silently scan fewer files than intended — the
		// #1718 empty-sweep shape one layer up: `listSourceFiles` itself throws
		// on a missing `dir`, and this must not swallow that.
		const found = listSourceFiles(abs, {
			extensions: CANDIDATE_EXTENSIONS,
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/ (.ts + .mjs)`, found.length, floor);
		files.push(...found);
	}
	return files;
}

describe("escapeRegExp single-source-of-truth (#2558)", () => {
	// Whole-tree walk: 5.27 s under full-suite load on CI (PR #2742 rounds 2
	// and 3 timed out at the 5 s default). Same budget as the other tree-walk
	// sweeps (dependency-boundaries.test.ts).
	it("has no local escaping-helper definition outside the canonical leaf", () => {
		const files = listCandidateFiles();
		// Belt-and-suspenders total floor on top of each directory's own floor
		// above (~1620 at authoring time).
		assertNonEmptyScan(
			"clients/tools/mcp/scripts/tests source files",
			files.length,
			1400,
		);

		const offenders: string[] = [];
		for (const file of files) {
			const rel = relativePosix(root, file);
			if (rel === CANONICAL_FILE) continue;
			const raw = readFileSync(file, "utf8");
			const stripped = stripSource(raw, { strings: "keep" });
			if (FUNCTION_SHAPE.test(stripped) || ARROW_SHAPE.test(stripped)) {
				offenders.push(rel);
			}
		}

		expect(
			offenders,
			`new escaping-helper definition(s) found outside ${CANONICAL_FILE} — ` +
				`import { escapeRegExp } from "clients/string-utils.js" ` +
				`(or its tests/support/sweep-kit.js re-export) instead of re-copying ` +
				`the body: ${offenders.join(", ")}`,
		).toEqual([]);
	}, 30_000);

	it("the canonical leaf still defines escapeRegExp with the expected body", () => {
		const src = readFileSync(path.join(root, CANONICAL_FILE), "utf8");
		expect(FUNCTION_SHAPE.test(stripSource(src, { strings: "keep" }))).toBe(
			true,
		);
	});
});
