/**
 * #2556 — path containment over a `path.relative` result has one owner.
 *
 * `clients/path-utils.ts` owns containment: `relativeInside` (the lexical test),
 * `isUnderDir`, `isWithinForm` and `isWithinIdentity`. Every other containment test
 * is a copy of a rule that seam already owns (AGENTS.md shape 83), and the
 * copies are wrong in two measured ways:
 *
 * - **cross-drive (#4878 F1, HIGH):** `!rel.startsWith("..")` reads a
 *   `path.relative` result as "inside" whenever it does not begin with `..`.
 *   Across Windows drives `path.relative` returns an ABSOLUTE path, so a file
 *   on another drive reads as inside. `tests/support/vi-mock-export-gate.ts`
 *   shipped this and `Unit tests Windows` failed 26 cells on a head Linux CI
 *   and the local run called green.
 * - **`..`-name (#4835):** the prefix test reads a directory named `..foo`,
 *   which is INSIDE the root it belongs to, as outside.
 *
 * Neither shape has a tree-wide layer: `tests/config/path-identity-sweep.test.ts`
 * reads map keys and raw `realpath` calls, `path-key-fold-sweep` reads equality
 * folds, and `reported-path-attribution-sweep` deliberately drops a
 * `path.relative` result as a "fragment used for containment" (#4876 review r2
 * F5 records that blind spot). This ratchet is that layer, and the three stay
 * apart because each answers a different rule: a key, an equality, an
 * attribution, a containment. Folding them would make one detector depend on
 * another's needle vocabulary and would widen a frozen census instead of
 * governing the population it was built for.
 *
 * The detector is `tests/support/path-containment-scan.ts` and its own state
 * table is `tests/support/path-containment-scan.test.ts`; both parse the file,
 * so a comment is never code and a string is read only by its cooked value.
 *
 * KNOWN MISSED SHAPES (accepted floor — the needle cannot see them):
 * - a `path.relative` result handed to another FUNCTION and tested there, when
 *   the callee is in another module (live population 2, both in
 *   `tests/support/`: `vi-mock-export-gate.ts#isProductionModulePath` and
 *   `module-instance-scan.ts#isBuildCompiled`, each already pairing
 *   `path.isAbsolute`). A call that carries BOTH the relative value and a `..`
 *   literal IS reported (the argument hand-off reading), so this row is the
 *   cross-module case only.
 * - a value stored on an object or array and read back later
 *   (`records[i].rel.startsWith("..")`), a reassigned `let`
 *   (`let rel = f(); rel = path.relative(a, b)`), a destructured read, or a
 *   `relative` callee re-exported from another module under another name.
 * - a parent-segment literal carried through an OBJECT field or a function
 *   argument chain (`rel.startsWith(markers.parent)`). Named constants, RegExp
 *   literals and `indexOf`/`includes`/`match`/`test` readings are NOT in this
 *   list: #4882 review F1 proved the enumerated-predicate cut blind to them,
 *   and the derived reading now reports each.
 * - a SAME-FILE helper that returns a `path.relative` result, tested at its
 *   call site (`const rel = inside(path, root); rel.startsWith("..")`). The
 *   value reading is per file and follows declarators, so a name bound inside
 *   a helper is caught (#4882 verify r3 measured a late-bound `lateRel`), but
 *   the call/return edge is not walked. Live population 0: no helper of that
 *   shape has its result meet a `..` test in the scanned trees (#4882 verify
 *   r3 N2 measured the population, and it is empty), so this is a declaration,
 *   not a gap with members.
 * - a character-index read with no `..` literal
 *   (`rel[0] === "." && rel[1] === "."`). The arm needs a parent-segment
 *   LITERAL and this spelling never writes one, so neither the literal walk
 *   nor a comparison sees it. Live population 0 (0 sites, #4882 verify r3 N3);
 *   `rel[0] + rel[1] === ".."` IS reported, because it spells the literal.
 * - a relative result read through a member chain whose method returns
 *   something unrelated (`rel.split("/").length`), which the fail-closed
 *   reading reports rather than drops.
 * - a `switch (rel) { case "..": }`, which is not a comparison node. Measured
 *   on the authoring head: no such switch over a relative result exists in the
 *   scanned trees, so the live population is 0.
 *
 * SCOPE (defect shape 80, one verdict per root a containment test can be
 * written in — the fixer contract's `Evidence` section names them): `clients/`,
 * `tools/`, `mcp/`, `index.ts`, `scripts/` (with `scripts/lib/` and
 * `scripts/hooks/`, `.ts` and `.mjs`), `tests/support/`, and `tests/` outside
 * `support/`. `tests/config/` is inside `tests/` and therefore scanned. The
 * only root left out is a fixture directory's own generated content, which is
 * data rather than a containment answer; its measured population is 0.
 *
 * POPULATION on the authoring head (measured, `PI_LENS_PRINT_PINS=1`): 43
 * sites — 42 baseline rows plus the seam's own admission. 25 of them sit in
 * the runtime trees the first cut scanned (24 rows + `isAtOrAboveHomeDir`),
 * 4 in `scripts/` and 13 in `tests/` outside `support/`, all four scripts/ and
 * eleven of the thirteen tests members measured by #4882 review F2; the other
 * two are the predicate half's widening (an `expect(…).toBe("../…")` and a
 * `toMatch(/^\.\./)` assertion), not new defects.
 */
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	mayHoldContainment,
	scanPathContainmentSites,
	type PathContainmentSite,
} from "../support/path-containment-scan.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * The trees this lane scans. The fixer contract (`docs/pi-lens-fixer.md`,
 * its `Evidence` section) names the class-sweep roots: the shipped runtime
 * (`clients/`, `tools/`, `mcp/`,
 * `index.ts`), the repository's own scripts (`scripts/`, `scripts/lib/`,
 * `scripts/hooks/`), and the test trees (`tests/support/` plus `tests/`
 * outside it). Defect shape 80: a census that reads one root while its subject
 * can be written in several answers "clean" from the wrong root, and #4882
 * review F2 measured 15 live members in the two roots the first cut omitted —
 * four in `scripts/` and eleven in `tests/` outside `support/`.
 *
 * `tests/support` is its own tree and `tests` excludes it, so every file is
 * counted once. `scripts/` is `.mjs`-heavy (193 files at the authoring head)
 * and its two `.ts` files are scans too, so it takes both extensions.
 */
interface ScanTree {
	root: string;
	extensions: readonly string[];
	/** Drop a file by its tree-relative posix path. */
	exclude?: (relativePath: string) => boolean;
}

const SCAN_ROOTS: readonly ScanTree[] = [
	{ root: "clients", extensions: [".ts"] },
	{ root: "tools", extensions: [".ts"] },
	{ root: "mcp", extensions: [".ts"] },
	{ root: "scripts", extensions: [".ts", ".mjs"] },
	{ root: "tests/support", extensions: [".ts", ".mjs"] },
	{
		root: "tests",
		extensions: [".ts"],
		exclude: (relativePath) => relativePath.startsWith("support/"),
	},
];

/**
 * Half the live file count per tree, so a moved root or a dropped tree reds
 * instead of reading as a clean population (defect shape 10). Live on the
 * authoring head: 512 `clients/`, 16 `tools/`, 6 `mcp/`, 195 `scripts/`,
 * 128 `tests/support/`, 1682 `tests/` outside `support/`.
 */
const FILE_FLOORS: Readonly<Record<string, number>> = {
	clients: 256,
	tools: 8,
	mcp: 3,
	scripts: 97,
	"tests/support": 64,
	tests: 841,
};

const CROSS_DRIVE =
	"cross-drive arm (#4878 F1): it tests only the `..` prefix and pairs no isAbsolute arm, so across Windows drives path.relative returns an absolute path that does not start with `..` and this site reads an out-of-tree target as INSIDE. Unreproduced on a production call path, so it stays baselined; folding it onto isUnderDir is #2556's remainder.";

const DOTDOT_NAME =
	"`..`-name arm (#4835): it tests the `..` PREFIX, so a directory named `..foo` — inside the root it belongs to — reads as outside. Unreproduced on a production call path and already paired with isAbsolute, so it stays baselined; pairing it with isWithinForm/isUnderDir is #2556's remainder.";

/**
 * A site whose relative text is a component of a DURABLE finding id (#2556
 * remainder, measured on the fold). Routing it through `relativeInside` would
 * change the id for exactly the inputs the two spellings disagree on (a
 * directory named `..foo`, a cross-drive path): a stored id stops matching its
 * finding and the record is orphaned once (the #533 class). The fold's deletion
 * test names it: removing the seam would not send this copy back to hand-rolling,
 * because the copy's output, not its predicate, is the contract. It stays a
 * copy, baselined, until an id migration owns the change.
 */
const DURABLE_ID =
	"durable id component (shape 83 residual, not folded): it tests the `..` prefix and pairs no isAbsolute arm, so a directory named `..foo` and a cross-drive path read as outside, and the text it returns is hashed into a stored finding id. Folding it onto `relativeInside` would change that id for those inputs and orphan the stored record once; no production call path produces either input today, so it stays baselined until an id migration owns the change.";

/**
 * A hand-rolled copy that answers the seam's question CORRECTLY today: a `..`
 * SEGMENT (`..` + separator, or `../`), the exact parent (`rel === ".."`), and
 * the cross-drive absolute form (`isAbsolute(rel)`) are all rejected, so a
 * directory named `..foo` reads as inside and no shipping defect is claimed
 * (#4882 verify r3 N4: 12 rows carried the `..`-name arm while their source
 * spelled `..${sep}`/`../`, which does not misread `..foo`). It stays
 * baselined because it re-derives a rule `clients/path-utils.ts` owns (shape
 * 83), and the copies that DID drift are #4878 F1 and #4835; folding it onto
 * `isUnderDir` is #2556's remainder.
 */
const SEAM_COPY =
	'seam copy (shape 83), correct on every axis it is asked about: it matches a `..` SEGMENT rather than a bare prefix, and it pairs both `rel === ".."` and `isAbsolute(rel)`, so `..foo` reads as inside and a cross-drive absolute `rel` reads as outside. No shipping defect is claimed; it stays baselined because it re-derives a rule `clients/path-utils.ts` owns (shape 83), and the copies that drifted are #4878 F1 and #4835. Folding it onto `isUnderDir` is #2556\'s remainder.';

/**
 * The seam's own predicate. Containment is admitted ONLY through
 * `clients/path-utils.ts#relativeInside`, so this file's site is an admission
 * with a reason, not a baseline row: a second containment test inside it still reds as
 * unlisted.
 */
const SEAM_ADMISSIONS: Readonly<Record<string, string>> = {
	"clients/path-utils.ts#relativeInside":
		"The seam's own predicate (#2556): the one `path.relative` containment test in the tree, with `..` exactly, a `..` SEGMENT and an absolute result as its three outside arms. `isAtOrAboveHomeDir`, `toProjectRelativePath` and every runtime site that needs a relative text or a verdict call it, so a second containment test anywhere else still reds as unlisted.",
};

/**
 * The hand-rolled sites. Row = `<file>#<anchor>`; the anchor is the enclosing
 * named symbol, and a second predicate inside the SAME symbol carries an
 * ordinal (`… #2`), so every site keeps its own row and one row never excuses
 * two. The baseline only shrinks: nothing here is fixed in this lane, because
 * no site is reproduced through a production call path (principles §1,
 * speculative robustness) — the #2556 comment names them as a member list, not
 * as findings.
 *
 * Six members the issue's hand census (16: 6 without an isAbsolute arm, 10
 * with) did not list are here too, because the structural detector finds them:
 * `go-vet.ts` spells the callee as a named `relative` import, `mcp/server.ts`
 * sits outside the census's grep roots, three spell the test as a template or a
 * comparison, and `clients/path-utils.ts#inside` is the seam's own third
 * predicate. The four `scripts/` and thirteen `tests/` rows are the roots
 * #4882 review F2 measured; a `tests/` row is an assertion about a fixture's
 * own prefix, not a containment decision the product acts on, and says so.
 *
 * 42 rows plus the seam's one admission made the 43 sites this census printed
 * on the authoring head. #2556's `..`-name fold then routed ten runtime
 * `..`-prefix rows through `isUnderDir`/`isWithinForm`/`toProjectRelativePath`
 * and deleted them: 32 rows plus the admission made the 33 sites printed then.
 * The `relativeInside` fold (#2556's remainder) then routed twelve more runtime
 * rows and the admission itself through the seam: 20 rows plus the seam's new
 * admission made the 21 sites printed then. `relativeFile`
 * (`clients/finding-identity.ts`, the relative component of every finding id)
 * then went through `relativeInside` too, because a `..foo` directory's file
 * hashed the checkout's absolute path, so its id differed per clone: 19 rows
 * plus the admission make the 20 sites printed now.
 */
const BASELINE: Readonly<Record<string, string>> = {
	"clients/actionable-warnings.ts#legacyActionableWarningId": `${DURABLE_ID} This one rebuilds the id older releases wrote so a stored record can be migrated, so its spelling is the old release's by definition.`,
	"scripts/hooks/guard-bash.mjs#hasNodeModulesSymlinkOutside": `${SEAM_COPY} It cannot fold because the hook is a bare-Node \`.mjs\` that Claude Code runs before any build, so it may not import a TypeScript seam. Baselined as the record that the copy was read.`,
	"scripts/hooks/guard-bash.mjs#isUnderTmpRoot": `${SEAM_COPY} The same bare-Node boundary (no build step, so no TypeScript seam import) is why it stays a copy.`,
	"scripts/lib/pr-worktree.mjs#nestedDestinationError": `${SEAM_COPY} It runs on the same bare-Node boundary as the git guard: a \`.mjs\` script that cannot import the TypeScript seam.`,
	"scripts/lib/pr-worktree.mjs#deriveClosePlan": `${CROSS_DRIVE} It pairs no \`isAbsolute\` arm: on Windows a worktree path on another drive makes \`pathApi.relative\` return an absolute path, which is neither \`""\` nor \`".."\` nor a \`..\`-plus-separator prefix, so the close plan treats a path outside the worktrees root as inside. Unreproduced on a production call path this round, so it stays baselined; folding it is #2556's remainder.`,
	"tests/support/v8-coverage.ts#fileFromScriptUrl": `${CROSS_DRIVE} A cross-drive relative reads as inside the coverage root, so a script outside \`include\` is reported as a covered file. The only member in \`tests/support/\`, the tree the #4878 F1 site shipped in.`,
	"tests/clients/actionable-warnings-lsp-cache.test.ts#legacyActionableWarningIdForTest": `${CROSS_DRIVE} A test-local copy of \`clients/actionable-warnings.ts\`'s legacy-id helper, used as the INDEPENDENT expectation the production helper is compared against. Folding it onto the seam would make the cell restate the code it checks (principles §2, tautological test), so the copy is the point.`,
	"tests/clients/actionable-warnings.test.ts#legacyActionableWarningIdForTest": `${CROSS_DRIVE} The same test-local copy in the sibling cell: an independent expectation, so importing the production helper would make the comparison vacuous.`,
	"tests/clients/ignore-verdict-identity-4689.test.ts#does not read the rules of a sibling directory named `<root>\\outside`": `${CROSS_DRIVE} An assertion on the primitive's own answer (\`expect(path.relative(repo, outside)).toBe("../repo\\\\outside/x.log")\`), pinning that the sibling is outside by TEXT. It derives no containment decision; a cross-drive absolute \`rel\` fails this cell instead of acting on it, which is the direction a test should fail.`,
	"tests/clients/npx-child-env-isolation.test.ts#spawns npx without npm_config_* or a project-derived userconfig": `${CROSS_DRIVE} An assertion that the child's cwd sits outside the fixture tmp dir (\`toMatch(/^\\.\\./)\`): the test's own expectation about where a spawned child ran, not a containment answer the product acts on.`,
	"tests/clients/project-report.test.ts#preFixToDisplayPath": `${CROSS_DRIVE} The #4101 witness: it recomputes the PRE-FIX hand-rolled body to prove the fix is not equivalent to it, so the broken spelling is the thing under test. Folding it onto the seam would delete the witness.`,
	"tests/clients/worker-home-pin-hermeticity.test.ts#under": `${DOTDOT_NAME} A test-local containment helper over \`path.resolve\`d, case-folded spellings (the macOS home-case probe); folding it onto \`isUnderDir\` would follow links and change what the cell measures.`,
	"tests/index-3190-inline-blocker-deleted-path-witness.test.ts#scrub": `${DOTDOT_NAME} The witness derives a \`~\` form only for a path inside the probe home; a directory named \`..foo\` reads as outside, so the scrub falls back to its never-matching sentinel and the cell fails loudly.`,
	"tests/index-3290-actionable-warnings-witness.test.ts#tildeProbeHome": `${DOTDOT_NAME} The same home-relative probe in the actionable-warnings witness: a \`..foo\` directory reads as outside and the cell fails loudly instead of publishing a wrong \`~\` path.`,
	"tests/scripts/build-dist-tsc.test.ts#falls back to the isolated npm-exec path, unchanged, when no local binary is given": `${CROSS_DRIVE} An assertion on the primitive's own answer for a temp prefix (\`expect(path.relative(root, prefix).startsWith("..")).toBe(true)\`): it states where the fixture sits and derives no containment decision.`,
	"tests/scripts/bundle-dist.test.ts#spawns with cwd: root and a --prefix pointing outside root": `${CROSS_DRIVE} The same assertion in the sibling spawn cell: the prefix must be outside \`root\`, and a cross-drive absolute \`rel\` fails the cell rather than acting on a wrong answer.`,
	"tests/scripts/exec-isolation.test.ts#creates a fresh directory under the OS temp dir on every call": `${CROSS_DRIVE} Asserts the helper's own output is outside the tmp root by the primitive's answer; a wrong containment fails the cell instead of acting on it.`,
	"tests/scripts/exec-isolation.test.ts#returns a fresh, empty directory that is neither the project root, an ancestor of it, nor a descendant of it": `${CROSS_DRIVE} Asserts the created prefix is outside the project root in both directions (\`fromRoot\` and \`toRoot\`), by the primitive's own answer.`,
	"tests/scripts/exec-isolation.test.ts#returns a fresh, empty directory that is neither the project root, an ancestor of it, nor a descendant of it#2": `${CROSS_DRIVE} The ordinal row for the second arm in the same cell (\`toRoot\`), which the census keys separately so one row never excuses two sites.`,
};

interface Occurrence {
	row: string;
	detail: string;
}

interface Census {
	scanned: Map<string, number>;
	occurrences: Occurrence[];
}

let cached: Promise<Census> | undefined;

async function runCensus(): Promise<Census> {
	const scanned = new Map<string, number>();
	const occurrences: Occurrence[] = [];
	const files = [
		...SCAN_ROOTS.flatMap((tree) =>
			listSourceFiles(path.join(REPO_ROOT, tree.root), {
				extensions: tree.extensions,
				exclude: tree.exclude,
			}).map((file) => ({ file, tree: tree.root })),
		),
		{ file: path.join(REPO_ROOT, "index.ts"), tree: "index.ts" },
	];
	for (const { file, tree } of files) {
		const rel = relativePosix(REPO_ROOT, file);
		const source = readWalkedFile(file);
		// Shape 81: a native tree is freed only when the event loop turns, so
		// yield once per file instead of holding every parsed tree to the end.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (source === undefined) continue;
		scanned.set(tree, (scanned.get(tree) ?? 0) + 1);
		// The prefilter can only skip WORK (see `mayHoldContainment`): every
		// admitted form needs the callee's name somewhere in the file, so a file
		// that never spells `relative` holds no site. The walked file still
		// counts toward the tree's floor above.
		if (!mayHoldContainment(source)) continue;
		for (const site of scanPathContainmentSites(source))
			occurrences.push({
				row: rowOf(rel, site),
				detail: `${rel}:${site.line + 1} (${site.form})`,
			});
	}
	return { scanned, occurrences };
}

function rowOf(rel: string, site: PathContainmentSite): string {
	return `${rel}#${site.anchor}`;
}

function census(): Promise<Census> {
	return (cached ??= runCensus());
}

const total = (scanned: Map<string, number>): number =>
	[...scanned.values()].reduce((sum, count) => sum + count, 0);

describe("path containment sweep (#2556)", () => {
	it(
		"scans every tree the lane's scope names",
		async () => {
			const { scanned } = await census();
			for (const tree of SCAN_ROOTS)
				assertNonEmptyScan(
					`path containment sweep: ${tree.root} files scanned`,
					scanned.get(tree.root) ?? 0,
					FILE_FLOORS[tree.root] ?? 1,
				);
			assertNonEmptyScan(
				"path containment sweep: index.ts scanned",
				scanned.get("index.ts") ?? 0,
				1,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"admits no hand-rolled containment test over a path.relative result",
		async () => {
			const { scanned, occurrences } = await census();
			if (process.env.PI_LENS_PRINT_PINS === "1")
				for (const occurrence of occurrences)
					console.log(`ROW\t${occurrence.row}\t${occurrence.detail}`);

			const audited = auditRegistry({
				sweepName: "path containment sweep (#2556)",
				flagged: occurrences.map((occurrence) => ({
					key: occurrence.row,
					detail: occurrence.detail,
				})),
				// Nothing is admitted without a reason: a site folds onto the seam or
				// takes a baseline row, so this registry stays empty on purpose.
				registered: [],
				exemptions: { ...SEAM_ADMISSIONS, ...BASELINE },
				scannedCount: total(scanned),
				// The four per-tree floors above, summed: a walk that lost half its
				// input in every tree is not a population.
				minScanned:
					Object.values(FILE_FLOORS).reduce((sum, floor) => sum + floor, 0) + 1,
				// A DEAD-SCAN floor, not a population pin: a detector that stopped
				// matching reads here, while the population itself is held by the
				// shrink-only audit below (a lost site reds as a stale row, which is
				// exact where a floor is only a lower bound). Live: 21 sites.
				minFlagged: 14,
				minReasonLength: 80,
				remediation:
					"Fold the test onto clients/path-utils.ts (isUnderDir for two spellings or identities, isWithinForm for two paths already in one form), or add a baseline row `<file>#<anchor>` naming the reason it stays. Refs #2556.",
			});
			expect(audited.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	/**
	 * The spread prefix is not a parent segment, and the files that spell it must
	 * stay spellings this ratchet reads as clean. Each case has two halves: the
	 * file still carries the `...` test (so the cell cannot go vacuous), and the
	 * detector reports nothing in it.
	 */
	it("never reads a spread prefix as a parent segment", () => {
		for (const rel of [
			"clients/config-warn.ts",
			"clients/middle-man-analysis.ts",
			"tests/support/sweep-kit.ts",
		]) {
			const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
			expect(source, `${rel} still spells a spread prefix`).toContain(
				'startsWith("...")',
			);
			expect(scanPathContainmentSites(source), rel).toEqual([]);
		}
	});

	it("keeps the seam's own predicate out of the shrink-only baseline", () => {
		const overlap = Object.keys(SEAM_ADMISSIONS).filter((row) =>
			Object.hasOwn(BASELINE, row),
		);
		expect(overlap).toEqual([]);
		expect(Object.keys(SEAM_ADMISSIONS)).toEqual([
			"clients/path-utils.ts#relativeInside",
		]);
	});
});
