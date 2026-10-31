/**
 * #4689 — path identity has one owner, mechanically.
 *
 * A file's path identity is its kernel-real path (AGENTS.md glossary), and
 * `clients/path-utils.ts` owns it: `normalizeMapKey` / `normalizeFilePath`
 * for keys and `realpathOrResolve` for a native-form identity. Before #4689
 * the read guard, the bash attribution subtraction, analysis-root and the
 * diagnostics tool each derived identity on their own, by a raw `realpath` or
 * by keying on a raw `path.resolve` result, and every such site disagreed
 * with the POSIX key for a symlinked file (AGENTS.md shape 1). A per-site
 * patch leaves the next caller on the link spelling, so this is the ratchet:
 * every remaining site in `clients/` is registered here with its reason, and
 * a new one reds until it goes through the seam or is registered.
 *
 * The detector and its own state table are `tests/support/path-identity-scan.ts`
 * and `tests/support/path-identity-scan.test.ts`. It parses each file, so a
 * comment is never code and a string is read only by its cooked value.
 *
 * KNOWN MISSED SHAPES (accepted floor — the needle cannot see them):
 * - a realpath reached through a name built at runtime: a concatenated or
 *   substituted member name (`fs["real" + "path"]`, `` fs[`${n}Sync`] ``), or a
 *   name that arrives from another module (`import { canon } from "./x"`
 *   where `x` re-exports `realpathSync` under another name; `x` itself is
 *   scanned when it lives under `clients/`);
 * - an identity taken by another syscall: `fs.readlink` chains, a
 *   `child_process` call to a binary other than `realpath`, `fs.statSync`
 *   inode comparison, or a native addon;
 * - a raw `path.resolve` key reached through more than one binding
 *   (`const a = path.resolve(x); const b = a; m.set(b, …)`), through a
 *   function's return value (`m.set(keyOf(x), …)` where `keyOf` returns
 *   `path.resolve(x)`), through an object field (`m.set(rec.path, …)`), or
 *   through a collection method this needle does not name (`Array.prototype.includes`,
 *   `indexOf`, a `Record` built with `Object.fromEntries`);
 * - a `path.relative` / `path.join` key, or a `path.resolve` key wrapped in
 *   any call that is not identity (a wrapper is judged as deciding the key);
 * - a `path.resolve` key as an operand rather than the whole argument: a
 *   ternary arm, a `||` / `??` operand, a template literal, a comma
 *   expression (`(0, path.resolve)(x)`), an `await`, a `Reflect.apply` of a
 *   map method, or a `let` assigned the value after its declaration (#4689
 *   review r1 F7 planted each; live population 0 by grep on 2026-10-21);
 * - a comparison between axes: a key (path identity) tested against a root
 *   held as a spelling, or the reverse. No needle sees which axis a value is
 *   on; `isUnderDir` answers containment on either axis instead (#4689 r2).
 * - an upward climb written without a parent call the third needle
 *   (`hand-rolled-upward-walk`, #4966) reads: a `reduce`, a regex or
 *   `slice`/`lastIndexOf` strip of the last segment, a split on the separator,
 *   a climb through `new URL("..", base)`, or a parent call hidden inside a
 *   helper arrow bound to a name (`const up = (p) => path.dirname(p)`, called
 *   in the loop; the loop calls `up`, and the `dirname` sits in another
 *   function), a recursive climb whose parent call is bound before the
 *   recursion (`const parent = path.dirname(dir); return climb(parent)`), a
 *   `dirname` reached through `.bind` or an in-file re-export
 *   (`export { dirname as up }`). Live population 0 for each (#5037 r3 F9).
 *   Each review round closed one spelling and found the next, so the redesign
 *   (a call-graph population instead of named parents) stays on #4966. The twin suite
 *   (`tests/clients/walker-symlink-twin-4966.test.ts`) runs the registered
 *   walkers from a symlink twin instead of reading their spelling.
 * - a `walkUpDirs(…, { spelling: true })` call. The option is the seam's own
 *   named escape; the census of files that climb is the twin suite's, whose
 *   exemptions name each spelled-by-design file and the suite pinning it.
 *
 * Scope: the shipped runtime, `clients/`, `tools/`, `mcp/` and `index.ts`,
 * without tests; `clients/path-utils.ts` is the seam and is not scanned.
 * `scripts/` is the repo's own tooling (git hooks, release QA, main-module
 * detection) and holds no runtime key, so it is out of scope by decision.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanPathIdentitySites } from "../support/path-identity-scan.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stableOccurrenceKey,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const SEAM = "clients/path-utils.ts";

/** The shipped runtime: the trees the class sweep covers, plus `index.ts`. */
const SCAN_ROOTS = ["clients", "tools", "mcp"] as const;

/**
 * Why a pinned row's sites are not identity derivations owed to the seam
 * today. A row names one file and one needle; it pins the site COUNT and the
 * content identity of the site set together (the silent-catch sweep's
 * scheme), so a new site reds even when an old one went away in the same
 * file (AGENTS.md shape 36), a site in a new file reds as unlisted, and a
 * removed site reds as stale until the row is re-pinned downward.
 */
const PRE_4689 =
	"pre-#4689 population admitted at its pinned count and identity: it may not grow, a shrink re-pins it, and this row claims only that the #4689 consumer census names the file for a later slice (items 2, 3, 5-7), not that each site keys by identity";

const SPELLING_MEMO =
	"a process-local memo, in-flight dedupe or latch keyed by the caller's spelling of a root or file, read back only by the same spelling path: a second spelling of one target costs a duplicate computation, never a verdict split between two writers";

const LOCAL_DEDUPE =
	"a dedupe set or grouping map local to one call or one walk: every lookup is spelled by the same code path in the same call, so no other writer can disagree with its key";

const LSP_FREEZE =
	"clients/lsp/ is frozen during the LSP split (freeze.json) and is a #4689 non-goal; its identity sites move with the LSP slice that owns them";

const RENAME_EXPECTED_CONTENT =
	"the rename flows' expected-content keys (`captureRenameExpectedContent`): a file link and its target must key one entry, and the two sites move with the rename/apply slice (#4689 batch 15), not with the async seam batch 10 that shrank this row from five sites to three";

const HELM_CONTAINMENT =
	"chart containment: a template's kernel-real path is checked against the chart's kernel-real root, and a realpath that throws refuses the template (catch -> null), which realpathOrResolve's fallback would turn into a spelling compare; `canonicalChartRoot` is the realpathOrResolve shape, named in the #4689 class sweep";

const BIN_CONTAINMENT =
	"project-local bin containment (#2556): a PATH shim's kernel-real target is checked against the kernel-real roots and a realpath that throws refuses the binary, which realpathOrResolve's fallback would turn into a spelling compare";

const FOREIGN_CHECKOUT_FAIL_CLOSED =
	"foreignGitRoot's two realpaths fail closed by errno: ENOENT/ENOTDIR on either side is no proof of a foreign checkout (null, silent), and any other refusal (EACCES, ELOOP) records one `test-checkout-identity-unavailable` gap and also returns null. realpathOrResolve's sync fallback returns an ancestor-plus-tail guess instead, so a missing target would be walked for a foreign `.git` and the gap record would never fire; the sync seam has no `kernelConfirmed` (only the async one does). #4689 batch 8 tried the swap and the worktree-isolation cells went red";

const INSTALL_SELF_CONTAINED =
	"clients/install-diagnostics.ts is the paste-able report for an install whose runtime dependencies did not resolve (#285/#335) and imports nothing from clients/: clients/path-utils.ts imports minimatch, so routing its one realpath (the symlinked-install probe, which compares the kernel-real package dir with the spelled one on purpose) through realpathOrResolve would stop the report loading exactly when it is needed; the import census in tests/clients/install-diagnostics.test.ts refuses any relative or bare specifier there, so that swap reds it";

const INSTALL_ANCHOR_WALK =
	"clients/install-diagnostics.ts walks up from its own module to the package.json that holds its version, six levels at most, to describe an install whose dependencies did not resolve (#285/#335); it imports nothing from clients/ (INSTALL_SELF_CONTAINED), so walkUpDirs is out of reach, and the walk is compared with the spelled package dir on purpose to report a symlinked install";

const URI_KEY_INDEX_WALK =
	"clients/lsp/edits.ts addIndex climbs the segments of a normalized URI index KEY (the descendants index of a workspace edit), not a directory on disk: the key's own separator and root semantics decide the ancestors, and walkUpDirs would resolve each one through the host filesystem and change the keys the index is read back by";

const PYTHON_RELATIVE_LEVELS =
	"a Python relative import climbs a COUNTED number of package levels (the leading dots), not to a marker: `from ..x import y` is `dots - 1` parents of the importing file's directory by package nesting, which the language defines on the spelled module path, so there is no ceiling or root to compare and no identity to take";

const ANCHOR_PREFIX_COUNTED_CLIMB =
	"clients/dispatch/rule-policy.ts anchorPrefix climbs a COUNTED number of segments: one dirname per segment of the config location's relativePath (its spelling below the directory that owns the file, such as `.pi-lens.json`), so the owning directory is a count fixed by that location, not a walk to a marker or a root; walkUpDirs stops on a marker or a root and cannot express the count, and the result is a spelled prefix for ignorePaths anchoring, with no identity taken";

interface Pin {
	sites: number;
	identities: string;
	reason: string;
}

/**
 * Every row the census finds in `clients/` today, by `<file>#<needle>`.
 * Re-pin from this suite's own census: `PI_LENS_PRINT_PINS=1` prints the live
 * rows. Re-pin only downward; a row that grows needs its reason restated.
 */
const PINS: Readonly<Record<string, Pin>> = {
	"clients/dead-code-client.ts#path-resolve-keyed": {
		sites: 4,
		identities: "a6ddbdf02c6f7761",
		reason: SPELLING_MEMO,
	}, // :460, :471, :473
	"clients/dependency-checker.ts#path-resolve-keyed": {
		sites: 9,
		identities: "382bf61764322182",
		reason: PRE_4689,
	}, // :563, :622, :627, :644, :688, :1093, :1105, :1106, :1109
	"clients/dispatch/runners/helm-lint.ts#path-resolve-keyed": {
		sites: 4,
		identities: "f830f8fabfb86b99",
		reason: SPELLING_MEMO,
	}, // :225, :228, :229, :231
	"clients/dispatch/runners/helm-render.ts#raw-realpath": {
		sites: 3,
		identities: "cf011114b0d18c1c",
		reason: HELM_CONTAINMENT,
	}, // :216, :217, :231
	"clients/dispatch/runners/helm-render.ts#path-resolve-keyed": {
		sites: 5,
		identities: "6842ad1422412589",
		reason: PRE_4689,
	}, // :845, :1151, :1155, :1156, :1159
	"clients/dispatch/runners/utils/runner-helpers.ts#raw-realpath": {
		sites: 2,
		identities: "f2f0de2a021822d0",
		reason: BIN_CONTAINMENT,
	}, // :514, :519
	"clients/dispatch/runners/utils/runner-helpers.ts#path-resolve-keyed": {
		sites: 10,
		identities: "f640b5350df01957",
		reason: SPELLING_MEMO,
	}, // :1182, :1193, :1290, :1447, :1449, :1452, :1617, :1691, :1693, :1696
	"clients/file-time.ts#path-resolve-keyed": {
		sites: 9,
		identities: "62c789065f4e9d86",
		reason: PRE_4689,
	}, // :58, :68, :78, :112, :132, :133, :139, :147, :169
	"clients/file-utils.ts#path-resolve-keyed": {
		sites: 2,
		identities: "7e723fe52bc1e91e",
		reason: SPELLING_MEMO,
	}, // :1524, :1535 (#4689 batch 7 moved them; count and identity unchanged)
	"clients/install-diagnostics.ts#raw-realpath": {
		sites: 1,
		identities: "1e68f8fa901aa8c4",
		reason: INSTALL_SELF_CONTAINED,
	}, // :157
	"clients/installer/index.ts#path-resolve-keyed": {
		sites: 2,
		identities: "3e2b3787d5a34312",
		reason: LOCAL_DEDUPE,
	}, // :3622, :3623
	"clients/knip-client.ts#path-resolve-keyed": {
		sites: 8,
		identities: "5ec4b14e99ee985e",
		reason: SPELLING_MEMO,
	}, // :565, :591, :601, :602, :608, :621, :623
	"clients/lsp/created-import-targets.ts#path-resolve-keyed": {
		sites: 1,
		identities: "c69256dc9b8544c4",
		reason: LSP_FREEZE,
	}, // :254
	"clients/lsp/edits.ts#raw-realpath": {
		sites: 3,
		identities: "96237f55c50b2878",
		reason: RENAME_EXPECTED_CONTENT,
	}, // :6, :879, :891
	"clients/lsp/index.ts#path-resolve-keyed": {
		sites: 1,
		identities: "3d0caf4f32bd7a68",
		reason: LSP_FREEZE,
	}, // :3707
	"clients/lsp/server.ts#raw-realpath": {
		sites: 4,
		identities: "287d24f1b5122ae6",
		reason: LSP_FREEZE,
	}, // :11, :2211, :2229, :2237
	"clients/lsp/server.ts#path-resolve-keyed": {
		sites: 4,
		identities: "324907f5e6d967e3",
		reason: LSP_FREEZE,
	}, // :319, :339, :374, :377
	"clients/lsp/session-roots.ts#path-resolve-keyed": {
		sites: 5,
		identities: "6bc813d47125e206",
		reason: LSP_FREEZE,
	}, // :129, :130, :148, :237, :254
	"clients/lsp/workspace-diagnostics-cache.ts#path-resolve-keyed": {
		sites: 2,
		identities: "83446a4ac9e72d5a",
		reason: LSP_FREEZE,
	}, // :748, :749
	"clients/mcp/analyze.ts#path-resolve-keyed": {
		sites: 4,
		identities: "b261f1cff7bd1a5f",
		reason: SPELLING_MEMO,
	}, // :174, :187, :201, :226
	"clients/metrics-client.ts#path-resolve-keyed": {
		sites: 3,
		identities: "bcca1f8df46f4cf5",
		reason: PRE_4689,
	}, // :51, :55, :67
	"clients/ndjson-logger.ts#path-resolve-keyed": {
		sites: 2,
		identities: "6ecd966532221c9e",
		reason: LOCAL_DEDUPE,
	}, // :945, :948
	"clients/package-manager.ts#path-resolve-keyed": {
		sites: 2,
		identities: "1f35334f3e60fd48",
		reason: LOCAL_DEDUPE,
	}, // :435, :436
	"clients/pipeline.ts#path-resolve-keyed": {
		sites: 2,
		identities: "f25de8a73a269e45",
		reason: PRE_4689,
	}, // :215, :1054
	"clients/probe-home-state.ts#raw-realpath": {
		sites: 1,
		identities: "480c8b119f83ad12",
		reason: PRE_4689,
	}, // :280
	"clients/project-diagnostics/fresh-fetch.ts#raw-realpath": {
		sites: 1,
		identities: "00f55ad56f820bcc",
		reason: PRE_4689,
	}, // :300
	"clients/project-lens-config.ts#path-resolve-keyed": {
		sites: 2,
		identities: "f196f38821d9305c",
		reason: SPELLING_MEMO,
	}, // :469, :472
	"clients/review-graph/git-identity.ts#raw-realpath": {
		sites: 1,
		identities: "10303ca5ad9cc1c8",
		reason: PRE_4689,
	}, // :142
	"clients/review-graph/import-resolvers.ts#path-resolve-keyed": {
		sites: 1,
		identities: "6be0c6b8129bfb47",
		reason: LOCAL_DEDUPE,
	}, // :401
	"clients/review-graph/tsconfig-paths.ts#path-resolve-keyed": {
		sites: 6,
		identities: "804b8907f5747d3f",
		reason: LOCAL_DEDUPE,
	}, // :93, :94, :134, :135, :243, :244
	"clients/runtime-agent-end.ts#path-resolve-keyed": {
		sites: 2,
		identities: "0830ee56c0e46b3a",
		reason: PRE_4689,
	}, // :562, :812
	"clients/runtime-coordinator.ts#path-resolve-keyed": {
		sites: 8,
		identities: "0ac5152568baccfe",
		reason: PRE_4689,
	}, // :860 path-resolve-keyed (new Set element), :864 path-resolve-keyed (.has key), :1489 path-resolve-keyed (.get key), :1490 path-resolve-keyed (.set key), :2896 path-resolve-keyed (.get key), :2903 path-resolve-keyed (.set key), :2910 path-resolve-keyed (.set key), :2917 path-resolve-keyed (.delete key)
	"clients/runtime-tool-result.ts#path-resolve-keyed": {
		sites: 2,
		identities: "3a38f213298e8a5d",
		reason: LOCAL_DEDUPE,
	}, // :1652, :1654
	"clients/runtime-turn.ts#path-resolve-keyed": {
		sites: 1,
		identities: "ff517a7d1b40a92e",
		reason: PRE_4689,
	}, // :3811
	"clients/test-runner-client.ts#raw-realpath": {
		sites: 4,
		identities: "c1a06e8a6462ff6b",
		reason: FOREIGN_CHECKOUT_FAIL_CLOSED,
	}, // :306, :327, :328, :343 (:327 and :328 are the calls; :306 and :343 are the gap record's `realpath` label)
	"clients/test-runner-client.ts#path-resolve-keyed": {
		sites: 2,
		identities: "3aedefc29eced70b",
		reason: LOCAL_DEDUPE,
	}, // :2144, :2145
	"clients/word-index.ts#path-resolve-keyed": {
		sites: 6,
		identities: "4b084f4a2e3ceb06",
		reason: PRE_4689,
	}, // :2621, :2659, :2662, :2665, :2708, :2711
	"clients/workspace-topology.ts#path-resolve-keyed": {
		sites: 3,
		identities: "be15a50cc4c533ac",
		reason: SPELLING_MEMO,
	}, // :219, :267, :272
	"tools/lens-diagnostics.ts#path-resolve-keyed": {
		sites: 2,
		identities: "223a7ec2d1f4172c",
		reason: PRE_4689,
	}, // :895, :897 (a per-call bucket; `getDeltaFileGroup` keys the group by identity)
	"mcp/server.ts#path-resolve-keyed": {
		sites: 1,
		identities: "95f9ef6922e0457e",
		reason: SPELLING_MEMO,
	}, // :243
	"index.ts#path-resolve-keyed": {
		sites: 1,
		identities: "66db1fe5f84f9efe",
		reason: SPELLING_MEMO,
	}, // :696
	"clients/install-diagnostics.ts#hand-rolled-upward-walk": {
		sites: 1,
		identities: "04674fe2776e3519",
		reason: INSTALL_ANCHOR_WALK,
	}, // :135
	"clients/lsp/edits.ts#hand-rolled-upward-walk": {
		sites: 1,
		identities: "6bf01490cf649768",
		reason: URI_KEY_INDEX_WALK,
	},
	"clients/review-graph/import-resolvers.ts#hand-rolled-upward-walk": {
		sites: 1,
		identities: "06064201b76ebaf1",
		reason: PYTHON_RELATIVE_LEVELS,
	}, // :415
	"clients/dispatch/rule-policy.ts#hand-rolled-upward-walk": {
		sites: 1,
		identities: "70c171ce33765a1f",
		reason: ANCHOR_PREFIX_COUNTED_CLIMB,
	}, // :176
};

interface Occurrence {
	key: string;
	detail: string;
	row: string;
}

function census(): { scanned: number; occurrences: Occurrence[] } {
	const files = [
		...SCAN_ROOTS.flatMap((tree) =>
			listSourceFiles(path.join(REPO_ROOT, tree), { skipTests: true }),
		),
		path.join(REPO_ROOT, "index.ts"),
	];
	const occurrences: Occurrence[] = [];
	let scanned = 0;
	for (const file of files) {
		const rel = relativePosix(REPO_ROOT, file);
		if (rel === SEAM) continue;
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		scanned += 1;
		const lines = source.split("\n");
		const seen = new Map<string, number>();
		for (const site of scanPathIdentitySites(source)) {
			const base = `${stableOccurrenceKey(rel, lines, site.line)}#${site.needle}`;
			const ordinal = (seen.get(base) ?? 0) + 1;
			seen.set(base, ordinal);
			occurrences.push({
				key: `${base}#${ordinal}`,
				detail: `${rel}:${site.line + 1} ${site.needle} (${site.form})`,
				row: `${rel}#${site.needle}`,
			});
		}
	}
	return { scanned, occurrences };
}

function identitiesOf(keys: readonly string[]): string {
	return createHash("sha256")
		.update([...keys].sort().join("\n"))
		.digest("hex")
		.slice(0, 16);
}

function liveRows(
	occurrences: readonly Occurrence[],
): Map<string, { sites: number; identities: string; details: string[] }> {
	const byRow = new Map<string, Occurrence[]>();
	for (const occurrence of occurrences)
		byRow.set(occurrence.row, [
			...(byRow.get(occurrence.row) ?? []),
			occurrence,
		]);
	return new Map(
		[...byRow].map(([row, members]) => [
			row,
			{
				sites: members.length,
				identities: identitiesOf(members.map((member) => member.key)),
				details: members.map((member) => member.detail),
			},
		]),
	);
}

/** Every disagreement between the live census and {@link PINS}, as messages. */
export function auditPins(
	occurrences: readonly Occurrence[],
	pins: Readonly<Record<string, Pin>>,
): { unlisted: string[]; mismatched: string[]; stale: string[] } {
	const live = liveRows(occurrences);
	const unlisted: string[] = [];
	const mismatched: string[] = [];
	for (const [row, found] of live) {
		const pin = pins[row];
		if (!pin)
			unlisted.push(
				`${row}: ${found.sites} site(s) [${found.identities}] (${found.details.join(" | ")})`,
			);
		else if (pin.sites !== found.sites || pin.identities !== found.identities)
			mismatched.push(
				`${row}: pinned ${pin.sites} [${pin.identities}], found ${found.sites} [${found.identities}] (${found.details.join(" | ")})`,
			);
	}
	const stale = Object.keys(pins).filter((row) => !live.has(row));
	return { unlisted, mismatched, stale };
}

describe("path identity sweep (#4689)", () => {
	const { scanned, occurrences } = census();

	if (process.env.PI_LENS_PRINT_PINS === "1") {
		for (const [row, found] of liveRows(occurrences))
			console.log(
				`PIN\t${JSON.stringify(row)}: { sites: ${found.sites}, identities: "${found.identities}", reason: PRE_4689 }, // ${found.details.map((detail) => detail.replace(/^[^:]*:/, ":")).join(", ")}`,
			);
	}

	it("registers every raw realpath and raw path.resolve key outside the seam", () => {
		// Calibration on the authoring head: 530 runtime files under clients/,
		// tools/ and mcp/ plus index.ts (seam excluded); half is 265. The live
		// populations are 31 raw-realpath and 158 path-resolve-keyed sites,
		// floored at 5; the hand-rolled upward walks (#4966) are floored at 1.
		assertNonEmptyScan(
			"path identity sweep: runtime files scanned",
			scanned,
			265,
		);
		for (const [needle, floor] of [
			["raw-realpath", 5],
			["path-resolve-keyed", 5],
			// The folds of #4966 left the few climbs that stay, each with a reason.
			["hand-rolled-upward-walk", 1],
		] as const)
			assertNonEmptyScan(
				`path identity sweep: ${needle} sites`,
				occurrences.filter((occurrence) =>
					occurrence.row.endsWith(`#${needle}`),
				).length,
				floor,
			);
		expect(
			auditPins(occurrences, PINS),
			"Derive the key through clients/path-utils.ts (normalizeMapKey for a map key, realpathOrResolve for a native-form identity), or pin the row with the reason it is not an identity derivation (a spelling memo, a call-local dedupe, a containment that must refuse a missing path). Refs #4689.",
		).toEqual({ unlisted: [], mismatched: [], stale: [] });
	});

	it("gives every pinned row a reason", () => {
		const reasonless = Object.entries(PINS)
			.filter(([, pin]) => pin.reason.trim().length < 30)
			.map(([row]) => row);
		expect(reasonless).toEqual([]);
	});
});
