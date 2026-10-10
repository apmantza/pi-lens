import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";
import {
	cleanupTmpHygiene,
	removeRunBackstopDirs,
	unadmittedRootBackstopEntries,
	tmpHygieneAdmissionFor,
	tmpHygieneLeakReport,
	tmpHygieneObservedEntries,
	tmpHygieneExcludeLiveOwnerEntries,
	tmpHygieneForeignRunEntries,
	tmpHygieneRunFiles,
	tmpHygieneCreators,
	formatTmpHygieneLeakEntry,
	tmpHygieneSweepableEntries,
	tmpHygieneWaitForOwnerDrain,
	tmpHygieneUnadmittedEntries,
	classifyTmpHygieneOwner,
	reapStaleTmpHygieneRecords,
	formatTmpHygieneOwnerSummary,
	realTmpHygieneProcessProbe,
	touchTmpHygieneOwnerMarker,
	TMP_HYGIENE_HOME,
	TMP_HYGIENE_OWNER_STALE_MS,
	TMP_HYGIENE_WORKER_HOME,
	newRepoRootEntries,
	REPO_ROOT_BUILD_OUTPUT,
	repoRootBaseline,
	unadmittedRepoRootEntries,
	untrackedUnignoredEntries,
	type TmpHygieneProcessProbe,
} from "../support/vitest-setup.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	getTmpRootRegistry,
	recordedTmpRootCreators,
} from "../support/tmp-root-registry.js";
import { getLatencyLogPath } from "../../clients/latency-logger.js";
import {
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotPath,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// #3186 round 3: this worker's own owner marker as the setup wrote it, read at
// module load — before a single `beforeEach` of this file has run. The last
// case of the liveness suite compares the live mtime against it to prove the
// heartbeat hooks are actually registered, not merely defined.
const OWN_MARKER_PATH = path.join(
	TMP_HYGIENE_HOME,
	"tmp-hygiene-owners",
	`${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-${process.pid}.json`,
);
const OWN_MARKER_MTIME_AT_LOAD = fs.statSync(OWN_MARKER_PATH).mtimeMs;

// Tmp-fixture hygiene governance (#2912). The setup hook in
// tests/support/vitest-setup.ts keeps the REAL TMPDIR: it never repoints
// TMPDIR/TMP/TEMP, so the gate watches the same /tmp namespace production
// uses. At each test-file load it snapshots the existing `pi-lens-`-prefixed
// entries there; each file's afterAll reports additions, and this file, the
// serialized governance owner that runs after every other project, reds on
// new unadmitted entries in its afterAll and removes them after the
// assertion. Containment is per file: a raw mkdtempSync root is removed by its
// owning file's teardown, and since #2912 the worker's own setup also removes a
// setupTestEnvironment root at afterAll/SIGTERM and a raw root a deferred write
// recreated (tests/support/tmp-root-registry.ts). A root its file never removed
// stays for this owner to red. The admission baseline in
// tests/config/tmp-fixture-hygiene-baseline.json is a shrink-only ratchet
// over the entries that outlive their owning file. This sweep keeps the
// mkdtemp population observable: each site's parent must derive from the real
// tmpdir (os.tmpdir()/the ambient TMPDIR at call time), stay repo-rooted, or
// use the sanctioned scratch seam, so every fixture it creates is either
// watched by the prefix diff, never tmpfs, or self-swept.

const MKTEMP_CALLEE = /\bmkdtempSync\s*\(|\bmkdtemp\s*\(/g;
const TMPDIR_SOURCE = /\bos\.tmpdir\s*\(\s*\)|[^a-zA-Z]tmpdir\s*\(\s*\)/;
const TMPDIR_ENV_SOURCE = /process\.env\.TMPDIR/;
// Repo-rooted parents never enter /tmp, so the prefix snapshot cannot observe
// them. They are repo pollution of a different class (tracked-but-ignored
// `.probe-*` dirs), not tmpfs inodes.
const REPO_ROOTED_SOURCE =
	/\bREPO_ROOT\b|process\.cwd\s*\(\s*\)|\brepositoryRoot\b|\brepoRoot\b/;
// The sanctioned scratch seam (scripts/lib/scratch-dir.mjs) owns its
// lifecycle (owner.pid + sweepScratchDirs); sites under it are not strays.
const SCRATCH_SEAM_SOURCE = /\bSCRATCH_DIR_ROOT\b/;
const HARDCODED_TMP = /(["'`])\/tmp\//;

function scanMkdtempSites(): { file: string; line: number; text: string }[] {
	const roots = [
		path.join(REPO_ROOT, "tests"),
		path.join(REPO_ROOT, "scripts"),
	];
	const sites: { file: string; line: number; text: string }[] = [];
	let fileCount = 0;
	for (const root of roots) {
		// readWalkedFiles: a path that vanished between the walk and the read is
		// out of the population, not a finding (#3082).
		for (const { file, source: raw } of readWalkedFiles(
			listSourceFiles(root, { extensions: [".ts", ".mjs"] }),
		)) {
			fileCount += 1;
			const code = stripSource(raw);
			const lines = code.split("\n");
			for (const [index, line] of lines.entries()) {
				MKTEMP_CALLEE.lastIndex = 0;
				if (!MKTEMP_CALLEE.test(line)) continue;
				sites.push({
					file: path.relative(REPO_ROOT, file).replace(/\\/g, "/"),
					line: index + 1,
					text: line.trim().slice(0, 160),
				});
			}
		}
	}
	assertNonEmptyScan("mkdtemp population", sites.length, 50);
	assertNonEmptyScan("mkdtemp file population", fileCount, 100);
	return sites;
}

/** The tmp-fixture prefixes each `tests/` file declares (#3306).
 *
 *  Only `pi-lens-`-prefixed families are indexed, because those are the only
 *  entries the census observes at all (`snapshotTmpPiLensEntries` in
 *  tests/support/vitest-setup.ts filters the tmpdir listing on that prefix). */
type TmpOwnerIndex = {
	/** prefix -> the `tests/`-relative files that declare it. */
	prefixes: Map<string, Set<string>>;
};

// #3306: a raw `mkdtempSync(path.join(os.tmpdir(), "pi-lens-x-"))` root used to
// map to NO owner, because only literal `setupTestEnvironment("…")` calls were
// indexed — `tests/index-wiring.test.ts`'s three `pi-lens-wiring-<reason>-`
// roots therefore reported `owner: tests/unknown` and read as a scanner bug.
// The decision (criterion 3) is to attribute them, and to derive the
// registration from the call site itself rather than from a hand-kept list
// beside it: there is nothing for a new producer to register, and no list to
// fall out of step with the tree.
//
// Round 2, M3328-1: the scan reads CODE, not prose. Comments AND string
// contents are blanked (`stripSource`'s default), so neither a commented-out
// call nor an ordinary string that spells one — `const decoy =
// 'setupTestEnvironment("pi-lens-evil-")'` — can register a prefix. A file that
// claims another file's family is not a cosmetic mis-label: it becomes a
// candidate owner, and one candidate that "ran here" is what stops the
// foreign-run filter from sparing a sibling invocation's live root (#3314).
//
// The one deliberate exception the detector rule allows is the prefix ARGUMENT
// itself, whose only possible evidence IS a string literal. It is read from the
// raw text at delimiter offsets the BLANKED code located — `stripSource`
// preserves length, lines and columns — so the callee is always code and only
// the literal's body comes from the source text.
/** `setupTestEnvironment(` up to and including its first argument's opening
 *  delimiter, located in blanked code. */
const SETUP_ENV_CALL = /setupTestEnvironment\(\s*["'`]/g;
/** Any literal in an ARGUMENT position — after `(` or `,`. This is first a
 *  MECHANISM, not a second policy: in blanked code an opening and a closing
 *  delimiter look alike, and `(`/`,` is how a literal's OPENING one is found. A
 *  fixture prefix reaches `mkdtempSync` as an argument anyway. Measured on the
 *  real tree, widening it to assignment and property positions changes nothing
 *  (2087 prefixes either way), so it is not claimed as a guard. */
const ARGUMENT_LITERAL = /[(,]\s*["'`]/g;

/** The static head of the string or template literal whose OPENING delimiter
 *  sits at `open`. Both delimiters are found in `code` (blanked), the body is
 *  read from `raw`, and an interpolation ends the head — so
 *  `` `pi-lens-wiring-${reason}-` `` yields `pi-lens-wiring-`, the family the
 *  entry name actually starts with. */
function literalHeadAt(
	code: string,
	raw: string,
	open: number,
): string | undefined {
	const quote = code[open];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	const close = code.indexOf(quote, open + 1);
	if (close < 0) return undefined;
	const body = raw.slice(open + 1, close);
	const interpolation = body.indexOf("${");
	return interpolation < 0 ? body : body.slice(0, interpolation);
}

function scanUnnamespacedMkdtempSource(
	raw: string,
	file: string,
): { file: string; line: number; prefix: string }[] {
	const code = stripSource(raw);
	const sites: { file: string; line: number; prefix: string }[] = [];
	const call =
		/\bmkdtemp(?:Sync)?\s*\(\s*(?:path\.)?join\(\s*(?:os\.tmpdir|tmpdir)\s*\(\s*\)\s*,\s*["'`]/g;
	for (const match of code.matchAll(call)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		const prefix = literalHeadAt(code, raw, open);
		if (prefix !== undefined && prefix !== "" && !prefix.startsWith("pi-lens-"))
			sites.push({
				file,
				line: code.slice(0, open).split("\n").length,
				prefix,
			});
	}
	return sites;
}

function scanUnnamespacedMkdtempRoots(): {
	file: string;
	line: number;
	prefix: string;
}[] {
	const sites: { file: string; line: number; prefix: string }[] = [];
	for (const { file, source } of readWalkedFiles(
		listSourceFiles(path.join(REPO_ROOT, "tests"), { extensions: [".ts"] }),
	)) {
		const relative = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
		if (
			relative === "tests/support/vitest-setup.ts" ||
			relative === "tests/clients/lens-map.test.ts"
		)
			continue;
		sites.push(...scanUnnamespacedMkdtempSource(source, relative));
	}
	return sites;
}

/** The prefix argument of one mkdtemp call, read from its own call window in
 *  blanked code: the static head of a literal, or the identifier standing in
 *  for it. `windowStart` maps the window back onto the whole file, so the
 *  literal body can be read from `raw` at the same offsets. */
function mkdtempPrefixArg(
	code: string,
	raw: string,
	windowStart: number,
	window: string,
): { literal?: string; ident?: string } {
	const call = /\bmkdtemp(?:Sync)?\s*\(/.exec(window);
	if (call === null) return {};
	const tailStart = call.index + call[0].length;
	const tail = window.slice(tailStart);
	const literal = /,\s*["'`]/.exec(tail);
	if (literal)
		return {
			literal: literalHeadAt(
				code,
				raw,
				windowStart + tailStart + literal.index + literal[0].length - 1,
			),
		};
	const ident = tail.match(/,\s*([A-Za-z_$][\w$]*)\s*\)/);
	if (ident) return { ident: ident[1] };
	return {};
}

function buildTmpOwnerIndex(
	root: string = path.join(REPO_ROOT, "tests"),
	/** Population floors, so the scan cannot silently go empty. Parameters
	 *  because the fixture-driven case below drives this over a planted tree of
	 *  three sites and would otherwise trip the real tree's floor. */
	floors: { prefixes: number; files: number } = { prefixes: 200, files: 100 },
): TmpOwnerIndex {
	const prefixes = new Map<string, Set<string>>();
	let fileCount = 0;
	const add = (prefix: string | undefined, file: string): void => {
		if (prefix === undefined) return;
		// A prefix must NAME a family. `pi-lens-` alone is the namespace itself and
		// would claim every entry in the census: measured, the dynamic
		// `setupTestEnvironment(`pi-lens-${tool}-${name}-`)` in
		// tests/clients/dispatch/runners/compiler-outcome-runners-javac-dotnet.test.ts
		// has that static head, and with it indexed, `pi-lens-nothing-spells-this-`
		// resolved to that file.
		if (!prefix.startsWith("pi-lens-") || prefix === "pi-lens-") return;
		const owners = prefixes.get(prefix) ?? new Set<string>();
		owners.add(file);
		prefixes.set(prefix, owners);
	};
	for (const { file, source: raw } of readWalkedFiles(
		listSourceFiles(root, { extensions: [".ts"] }),
	)) {
		fileCount += 1;
		const owner = path.relative(root, file).replace(/\\/g, "/");
		const code = stripSource(raw);
		for (const match of code.matchAll(SETUP_ENV_CALL))
			add(literalHeadAt(code, raw, match.index + match[0].length - 1), owner);
		const harvested: string[] = [];
		for (const match of code.matchAll(ARGUMENT_LITERAL)) {
			const head = literalHeadAt(code, raw, match.index + match[0].length - 1);
			if (head?.startsWith("pi-lens-")) harvested.push(head);
		}
		const lines = code.split("\n");
		let lineStart = 0;
		for (const [index, line] of lines.entries()) {
			const windowStart = lineStart;
			lineStart += line.length + 1;
			MKTEMP_CALLEE.lastIndex = 0;
			if (!MKTEMP_CALLEE.test(line)) continue;
			// Multi-line calls carry path.join(os.tmpdir(), …) on the following
			// lines; read the call window, the way the sibling sweep above does.
			const window = lines.slice(index, index + 3).join("\n");
			if (!TMPDIR_SOURCE.test(window) && !TMPDIR_ENV_SOURCE.test(window))
				continue;
			const { literal, ident } = mkdtempPrefixArg(
				code,
				raw,
				windowStart,
				window,
			);
			if (literal !== undefined) {
				add(literal, owner);
				continue;
			}
			// The prefix is an identifier: these sites sit in a per-file helper
			// (`freshTmpDir(prefix)`), and its callers spell the literals in the
			// SAME file, so the file's own `pi-lens-` literals are the family set.
			// A file with none cannot produce an entry this census observes
			// (`snapshotTmpPiLensEntries` only sees `pi-lens-` names), so there is
			// nothing to attribute and nothing to enforce — measured:
			// tests/scripts/lsp-fixture-workspace.test.ts:49 passes
			// `WORKSPACE_TEST_PREFIX = "lsp-fixture-workspace-test-"`.
			if (ident !== undefined)
				for (const prefix of harvested) add(prefix, owner);
		}
	}
	assertNonEmptyScan(
		"tmp owner prefix population",
		prefixes.size,
		floors.prefixes,
	);
	assertNonEmptyScan("tmp owner file population", fileCount, floors.files);
	return { prefixes };
}

let tmpOwnerIndex: TmpOwnerIndex | undefined;
function ownerIndex(): TmpOwnerIndex {
	tmpOwnerIndex ??= buildTmpOwnerIndex();
	return tmpOwnerIndex;
}

/** EVERY `tests/` file that declares a prefix of this entry. The foreign-run
 *  filter needs all of them: one candidate that ran in this invocation is
 *  enough to keep the entry judged (#3314). */
function ownersForTmpEntry(
	entry: string,
	index: TmpOwnerIndex = ownerIndex(),
): string[] {
	const owners = new Set<string>();
	for (const [prefix, files] of index.prefixes)
		if (entry.startsWith(prefix)) for (const file of files) owners.add(file);
	return [...owners];
}

/** The longest declared prefix wins, so an overlapping fixture family is
 *  attributed to the file that named the more specific one (round-1 LOW-3297-3). */
function ownerForTmpEntry(
	entry: string,
	index: TmpOwnerIndex = ownerIndex(),
): string | undefined {
	let owner: string | undefined;
	let ownerPrefixLength = -1;
	for (const [prefix, files] of index.prefixes) {
		if (!entry.startsWith(prefix) || prefix.length <= ownerPrefixLength)
			continue;
		ownerPrefixLength = prefix.length;
		owner = [...files].sort()[0];
	}
	return owner;
}

/** The `tests/` files whose source names the literal head of a repo-root entry
 *  (`mkdtempSync` appends six random characters): a best-effort pointer so a
 *  leak names a suspect, never a verdict (#3715). */
function repoRootEntryCandidates(entry: string): string[] {
	// A build-output name is a literal, not a mkdtemp head: the producer is
	// whatever spawned `npm pack`, `build:dist` or `prepare` with cwd = checkout.
	if (REPO_ROOT_BUILD_OUTPUT.includes(entry))
		return ["a test that ran npm pack / build:dist / prepare in the checkout"];
	const head = entry.length > 6 ? entry.slice(0, -6) : entry;
	const hits: string[] = [];
	for (const { file, source } of readWalkedFiles(
		listSourceFiles(path.join(REPO_ROOT, "tests"), {
			extensions: [".ts", ".mjs"],
		}),
	))
		// Comments blanked: a docblock naming the head is not a producer.
		if (stripSource(source, { strings: "keep" }).includes(head))
			hits.push(path.relative(REPO_ROOT, file).replace(/\\/g, "/"));
	return hits;
}

describe("tmp-fixture-hygiene", () => {
	afterAll(async () => {
		const scan = await tmpHygieneWaitForOwnerDrain();
		const liveOwners = scan.live;
		const { testFile, leftovers } = tmpHygieneLeakReport();
		// #3314: entries whose every candidate owner is a file no worker of THIS
		// run id loaded belong to another vitest invocation sharing this TMPDIR.
		// They are dropped before attribution AND spared by the sweep below.
		const otherInvocation = new Set(
			tmpHygieneForeignRunEntries(
				leftovers,
				ownersForTmpEntry,
				tmpHygieneRunFiles(),
			),
		);
		const attributable = tmpHygieneExcludeLiveOwnerEntries(
			leftovers.filter((entry) => !otherInvocation.has(entry)),
			ownerForTmpEntry,
			liveOwners,
		);
		const creators = tmpHygieneCreators();
		const described = attributable.map((entry) =>
			formatTmpHygieneLeakEntry(
				entry,
				ownerForTmpEntry(entry),
				creators.get(entry),
			),
		);
		// #3715: the repo root is a second namespace the tmp census does not see.
		const rootCensus = unadmittedRepoRootEntries(repoRootBaseline());
		if (rootCensus.unknown)
			process.stderr.write(
				`[tmp-hygiene] repo-root census could not run: ${rootCensus.unknown}\n`,
			);
		try {
			expect(
				attributable,
				`[tmp-hygiene] tests/${testFile} leaked ${attributable.length} top-level entries: ${described.join(",")}; live owners: ${[...liveOwners].join(",") || "none"}`,
			).toEqual([]);
			expect(
				rootCensus.leaked,
				`[tmp-hygiene] this run left ${rootCensus.leaked.length} new untracked, unignored or build-output entries in the repo root: ${rootCensus.leaked
					.map(
						(entry) =>
							`${entry} (candidate owners: ${repoRootEntryCandidates(entry).join(", ") || "unknown"})`,
					)
					.join(
						"; ",
					)}. Remove them and fix the producer: a fixture belongs under os.tmpdir() or in a directory the file removes.`,
			).toEqual([]);
		} finally {
			const reaped = cleanupTmpHygiene(otherInvocation);
			// Bounded observability (#3186, extended by #3314): ONE census line per
			// hygiene run, not one record per marker or per entry, so a suppressed,
			// ignored, attributed, or reaped entry is explicable from this run.
			process.stderr.write(
				`${formatTmpHygieneOwnerSummary(scan, otherInvocation.size, reaped)}\n`,
			);
		}
	});

	it("routes every tests/ and scripts/ mkdtemp parent through a contained root", () => {
		const escapees = scanMkdtempSites().filter((site) => {
			if (site.file === "tests/support/vitest-setup.ts") return false;
			const file = path.join(REPO_ROOT, site.file);
			const raw = readWalkedFile(file);
			if (raw === undefined) return false;
			const rawLines = raw.split("\n");
			// Multi-line calls carry path.join(os.tmpdir(), ...) on the
			// following lines; read the call window, not the call line.
			const window = rawLines.slice(site.line - 1, site.line + 2).join("\n");
			if (HARDCODED_TMP.test(window)) return true;
			if (TMPDIR_SOURCE.test(window)) return false;
			if (TMPDIR_ENV_SOURCE.test(window)) return false;
			if (REPO_ROOTED_SOURCE.test(window)) return false;
			if (SCRATCH_SEAM_SOURCE.test(window)) return false;
			// claimScratchDir IS the seam: it takes the caller's root.
			if (site.file === "scripts/lib/scratch-dir.mjs") return false;
			// One-hop const: a child of a tmpdir-derived `const root`.
			const parentId = window.match(
				/mkdtempSync\(\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/,
			)?.[1];
			if (parentId) {
				const decl = new RegExp(
					`const ${parentId} = [^;]*mkdtemp[^;]*tmpdir\\s*\\(`,
					"s",
				);
				if (decl.test(raw)) return false;
			}
			return true;
		});
		expect(
			escapees.map((site) => `${site.file}:${site.line}: ${site.text}`),
		).toEqual([]);
	});

	it("keeps every real-tmp mkdtemp prefix in the pi-lens namespace", () => {
		// #3329 recurrence: an unnamespaced real-tmp root is invisible to the
		// pi-lens census and can leak without an owner. Source is blanked first so
		// comments and string decoys cannot self-excuse a new producer.
		expect(scanUnnamespacedMkdtempRoots()).toEqual([]);
		expect(
			scanUnnamespacedMkdtempSource(
				[
					[
						"// ",
						"fs.mkdtempSync",
						'(path.join(os.tmpdir(), "comment-"));',
					].join(""),
					[
						"const decoy = '",
						"fs.mkdtempSync",
						'(path.join(os.tmpdir(), \\"string-\\"))\';',
					].join(""),
					["fs.mkdtempSync", '(path.join(os.tmpdir(), "real-"));'].join(""),
				].join("\n"),
				"fixture.ts",
			),
		).toEqual([{ file: "fixture.ts", line: 3, prefix: "real-" }]);
	});

	// PR #3100 review F2: #3083's per-file backstop directories live under the
	// run-shared home, which no owner removes, and round 1's
	// `process.once("exit")` never fired under vitest's SIGTERM fork teardown —
	// two green runs left one, then two, directories holding real stamps. This
	// file is the owner that sweeps them, dead last, when no worker is alive to
	// recreate one from a delayed callback; the sibling row is the recurrence in
	// the other direction, a second vitest invocation sharing this checkout's
	// `.probe-home` losing its live directory to our sweep.
	// The planted directories hold a nested `stamp.json` standing in for the real
	// cooldown stamp, so the sweep is proven to remove a NON-EMPTY tree. The
	// production filename is deliberately not spelled here: the #3042
	// registry-isolation sweep in tests/clients/pi-lens-home-hermeticity.test.ts
	// flags any file naming a producer's target filename beside PI_LENS_HOME
	// without its own pin, and this owner cannot pin a home — the run-shared one
	// is its subject. Comments are blanked before that scan, so this note neither
	// trips nor excuses it.
	//
	// Over a FIXTURE directory, not the live home: the sweep is destructive and
	// this file is the last worker, so pointing the guard at the live home would
	// perform the run's cleanup from inside the assertion and hide whether
	// `cleanupTmpHygiene` still calls the sweep at all. That the default target
	// is the live home is what the out-of-process leftover count proves.
	//
	// All four cells of the cleanup axis in one case (round 3 F1). Before the
	// stale arm, `oldForeign` had no remover at all: a run-id-only sweep cleans
	// only itself, so every targeted invocation that excludes this file left one
	// more stamped directory under the persistent home for ever.
	// #3715: the repo root is observed. Four cells, each through the shipped read:
	// the diff is by name against the run's baseline, git (not a name list)
	// decides what is a leak, an entry git cannot classify is reported as
	// unknown rather than clean, and the REAL baseline is live.
	it("names the entries a run added to the repo root, and only those", () => {
		const env = setupTestEnvironment("pi-lens-3715-root-diff-");
		try {
			for (const name of ["kept", "added-dir", ".added-dot"])
				fs.mkdirSync(path.join(env.tmpDir, name));
			expect(newRepoRootEntries(["kept", "gone-since"], env.tmpDir)).toEqual([
				".added-dot",
				"added-dir",
			]);
			expect(newRepoRootEntries(undefined, env.tmpDir)).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("classifies a new repo-root entry by git: an untracked stray is a leak; a tracked or ignored one is not", () => {
		const stray = `.probe-3715-stray-${process.pid}`;
		const ignored = `probe-3715-${process.pid}-ignored.js`;
		fs.mkdirSync(path.join(REPO_ROOT, stray));
		fs.writeFileSync(path.join(REPO_ROOT, ignored), "");
		try {
			expect(
				untrackedUnignoredEntries(
					[stray, ignored, "package.json", ".probe-home"],
					REPO_ROOT,
				),
			).toEqual([stray]);
		} finally {
			fs.rmSync(path.join(REPO_ROOT, stray), { recursive: true, force: true });
			fs.rmSync(path.join(REPO_ROOT, ignored), { force: true });
		}
	});

	// #4003 recurrence: `tests/packaging-pack-manifest.test.ts` ran a real
	// `npm pack` in the checkout, whose `prepare` built `dist/` there; git
	// ignores `dist/`, so the census above passed while every dist-dependent
	// file became order-dependent. A new build-output name is a leak even when
	// ignored, and a pre-existing one is not.
	it("flags a new dist/ or .pack-backup/ in the repo root even though git ignores it", () => {
		const env = setupTestEnvironment("pi-lens-4003-build-output-");
		try {
			for (const name of ["dist", ".pack-backup", "kept-dist"])
				fs.mkdirSync(path.join(env.tmpDir, name));
			const census = unadmittedRepoRootEntries(["kept-dist"], env.tmpDir);
			expect(census.unknown).toBeUndefined();
			expect(census.leaked).toEqual([".pack-backup", "dist"]);
			expect(
				unadmittedRepoRootEntries(["dist", ".pack-backup"], env.tmpDir).leaked,
			).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// #4003: a build-output leak must survive the cell where git cannot answer
	// for the OTHER new entries; reporting only `unknown` there would let a new
	// dist/ pass in a tree git cannot read.
	it("still flags a new dist/ when git cannot classify another new entry", () => {
		const env = setupTestEnvironment("pi-lens-4003-build-output-unknown-");
		try {
			for (const name of ["dist", "stray"])
				fs.mkdirSync(path.join(env.tmpDir, name));
			const census = unadmittedRepoRootEntries([], env.tmpDir);
			expect(census.leaked).toEqual(["dist"]);
			expect(census.unknown).toContain("stray");
		} finally {
			env.cleanup();
		}
	});

	it("reports unknown, never clean, when git cannot classify, and when the baseline predates the census", () => {
		const env = setupTestEnvironment("pi-lens-3715-no-git-");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "stray"));
			expect(untrackedUnignoredEntries(["stray"], env.tmpDir)).toBeUndefined();
			const unknown = unadmittedRepoRootEntries([], env.tmpDir);
			expect(unknown.leaked).toEqual([]);
			expect(unknown.unknown).toContain("stray");
			expect(unadmittedRepoRootEntries(undefined).unknown).toContain(
				"predates",
			);
		} finally {
			env.cleanup();
		}
	});

	it("the run's real baseline sees a stray planted in the repo root, and not once it is removed", () => {
		const stray = `.probe-3715-live-${process.pid}`;
		fs.mkdirSync(path.join(REPO_ROOT, stray));
		try {
			const during = unadmittedRepoRootEntries(repoRootBaseline());
			expect(during.unknown).toBeUndefined();
			expect(during.leaked).toContain(stray);
		} finally {
			fs.rmSync(path.join(REPO_ROOT, stray), { recursive: true, force: true });
		}
		expect(unadmittedRepoRootEntries(repoRootBaseline()).leaked).not.toContain(
			stray,
		);
	});

	// #3721 (the #3880 flake): the log sinks bind their path from PI_LENS_HOME at
	// module load, and one home for every worker made the 33 files that run with
	// PI_LENS_TEST_MODE=0 share one `latency.log`. Observed through the REAL
	// sink path rather than the env string: this worker's `latency.log` must live
	// in a directory only this process owns. Reverted to the run-shared home,
	// test-runner-python-environment beside session-root-config-eviction at 4
	// workers failed 15 of 15 runs ("got 1", "got 2").
	it("binds every worker's log sink to a home no other worker shares", () => {
		const runId = process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
		expect(TMP_HYGIENE_WORKER_HOME).not.toBe(TMP_HYGIENE_HOME);
		expect(path.dirname(TMP_HYGIENE_WORKER_HOME)).toBe(TMP_HYGIENE_HOME);
		expect(path.basename(TMP_HYGIENE_WORKER_HOME)).toBe(
			`worker-home-${runId}-${process.pid}`,
		);
		expect(path.dirname(getLatencyLogPath())).toBe(TMP_HYGIENE_WORKER_HOME);
	});

	it("sweeps this run's private backstop directories and spares a sibling invocation's", () => {
		const fixture = path.join(
			process.env.PI_LENS_HOME as string,
			`hygiene-backstop-guard-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}`,
		);
		const mine = path.join(
			fixture,
			`backstop-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-owner-guard`,
		);
		const liveForeign = path.join(fixture, "backstop-0000000000-0-owner-guard");
		const oldForeign = path.join(fixture, "backstop-0000000001-0-owner-guard");
		for (const dir of [mine, liveForeign, oldForeign]) {
			fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "nested", "stamp.json"),
				JSON.stringify({ lastSweepAt: 1 }),
			);
		}
		// #3721: the per-worker `PI_LENS_HOME` directories follow the same two
		// arms. `mineWorker` stands in for a home a deferred writer recreated after
		// its worker removed it (this run's prefix, swept on the prefix alone);
		// `oldForeignWorker` for a killed run's; `liveForeignWorker` for a live
		// sibling invocation's, which its own owner removes.
		const mineWorker = path.join(
			fixture,
			`worker-home-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-4242`,
		);
		const liveForeignWorker = path.join(fixture, "worker-home-0000000000-7");
		const oldForeignWorker = path.join(fixture, "worker-home-0000000001-7");
		for (const dir of [mineWorker, liveForeignWorker, oldForeignWorker]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "latency.log"), "{}\n");
		}
		// Round 4 F4, second half: root-level residue is reclaimed on the same
		// window. It is a FILE, which is why the seam's directory-only sweep
		// cannot be the whole rule.
		const oldRoot = path.join(fixture, "orphan-backstop-owner-guard-old");
		const liveRoot = path.join(fixture, "orphan-backstop-owner-guard-live");
		for (const file of [oldRoot, liveRoot])
			fs.writeFileSync(file, JSON.stringify({ lastSweepAt: 1 }));
		// #3109: the last member of this class in this directory. The
		// `tmp-hygiene-baseline-<run>.json` record is written once per run and
		// only ever removed by the owner-inclusive run that wrote it
		// (`cleanupTmpHygiene`'s own `fs.rmSync`) — an owner-less (targeted) run
		// never reaches that line, so a foreign one accumulates for ever, the
		// same shape as `oldRoot` above. `liveBaseline` stands in for THIS run's
		// own record: fresh, and must survive this call the way `mine` above
		// does not, because it is consumed explicitly afterward, not by this
		// sweep.
		const oldBaseline = path.join(
			fixture,
			"tmp-hygiene-baseline-owner-guard-old.json",
		);
		const liveBaseline = path.join(
			fixture,
			"tmp-hygiene-baseline-owner-guard-live.json",
		);
		for (const file of [oldBaseline, liveBaseline])
			fs.writeFileSync(file, JSON.stringify({ tmp: [], backstopRoot: {} }));
		// #3314: the run-file manifest is the second member of that class, written
		// beside the baseline with the same lifetime, so the same stale rule
		// reclaims an abandoned run's copy. Narrowing the sweep's needle back to
		// `tmp-hygiene-baseline-` leaves `oldFiles` behind for ever.
		const oldFiles = path.join(
			fixture,
			"tmp-hygiene-files-owner-guard-old.log",
		);
		const liveFiles = path.join(
			fixture,
			"tmp-hygiene-files-owner-guard-live.log",
		);
		for (const file of [oldFiles, liveFiles])
			fs.writeFileSync(file, "config/tmp-fixture-hygiene.test.ts\n");
		// A day old: past any six-hour window, and far past the 16-minute
		// worst-case vitest invocation the window is sized against.
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		fs.utimesSync(oldForeign, dayAgo, dayAgo);
		fs.utimesSync(oldForeignWorker, dayAgo, dayAgo);
		fs.utimesSync(oldRoot, dayAgo, dayAgo);
		fs.utimesSync(oldBaseline, dayAgo, dayAgo);
		fs.utimesSync(oldFiles, dayAgo, dayAgo);
		// Round 5: `mine`'s mtime is put two seconds INTO THE FUTURE, the
		// boundary that redded CI (run 35072411511). A directory created
		// microseconds before the sweep can carry a filesystem timestamp later
		// than the process clock, and the run-id arm's `maxAgeMs: 0` read as
		// "age >= 0" and skipped it. The rule for my own run's directories is
		// the prefix alone, so no clock comparison may enter it.
		const soon = new Date(Date.now() + 2_000);
		fs.utimesSync(mine, soon, soon);
		fs.utimesSync(mineWorker, soon, soon);
		try {
			removeRunBackstopDirs(fixture, fixture);
			expect(fs.existsSync(mineWorker)).toBe(false);
			expect(fs.existsSync(liveForeignWorker)).toBe(true);
			expect(fs.existsSync(oldForeignWorker)).toBe(false);
			expect(fs.existsSync(mine)).toBe(false);
			expect(fs.existsSync(liveForeign)).toBe(true);
			expect(fs.existsSync(oldForeign)).toBe(false);
			expect(fs.existsSync(oldRoot)).toBe(false);
			expect(fs.existsSync(liveRoot)).toBe(true);
			expect(fs.existsSync(oldBaseline)).toBe(false);
			expect(fs.existsSync(liveBaseline)).toBe(true);
			expect(fs.existsSync(oldFiles)).toBe(false);
			expect(fs.existsSync(liveFiles)).toBe(true);
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	// PR #3100 round 4 F4. The per-file detector used to assert the shared root
	// holds NO backstop residue at all, while the tmp gate in the same file has
	// always diffed against a setup snapshot. A checkout that had run master
	// first — the expected first state for this change — therefore redded every
	// test file for ever, naming an innocent file as the writer: with
	// `.probe-home/orphan-backstop.json` planted, all 8 tests of
	// bootstrap-lazy-liveness passed and the FILE failed. CI never sees it,
	// because CI checks out fresh.
	//
	// `before` is injected because the real baseline is captured at setup, so no
	// test can plant an entry into it; the directory read and the filter are the
	// shipped ones. Both directions matter — the second is the guarantee round 3
	// had and must not lose: a producer writing DURING the run is still named.
	it("names only root backstop residue this run is answerable for", () => {
		// The run-shared root, which `unadmittedRootBackstopEntries` reads by default
		// (a worker's own PI_LENS_HOME is not it since #3721).
		const home = TMP_HYGIENE_HOME;
		const planted = `orphan-backstop-round4-guard-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}`;
		const file = path.join(home, planted);
		fs.writeFileSync(file, "{}");
		const mtimeMs = fs.statSync(file).mtimeMs;
		try {
			// Present at setup, untouched since: not this run's doing.
			expect(
				unadmittedRootBackstopEntries({ [planted]: mtimeMs }),
			).not.toContain(planted);
			// Absent at setup: a producer created it during the run.
			expect(unadmittedRootBackstopEntries({})).toContain(planted);
			// Present at setup and OVERWRITTEN during the run — the case a
			// name-only baseline masks. Measured on the real writer with the pin
			// mutated away: same path, new mtime, and name-only named only the
			// quarantine directory beside it, never the rewritten stamp.
			expect(
				unadmittedRootBackstopEntries({ [planted]: mtimeMs - 1000 }),
			).toContain(planted);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	// PR #3100 round 3 F3. The wiring — that `cleanupTmpHygiene` still calls the
	// sweep — has no behavioural guard available: this file is the LAST worker,
	// so a guard driving the live home would perform the run's cleanup from
	// inside its own assertion and stay green with the call deleted (measured:
	// the whole hermeticity file and all 61 tests/config files passed while one
	// directory leaked). The same source-scan idiom this file already uses for
	// the setup-hook registration above, over comment-and-string-blanked text so
	// a comment naming the call can never satisfy it.
	it("keeps the backstop sweep wired into cleanupTmpHygiene", () => {
		const setup = stripSource(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
				"utf8",
			),
		);
		const body = setup.match(
			/export function cleanupTmpHygiene\([\s\S]*?\n\}/,
		)?.[0];
		expect(
			body,
			"cleanupTmpHygiene is no longer declared as expected",
		).toBeTypeOf("string");
		expect(body).toMatch(/\bremoveRunBackstopDirs\s*\(/);
		// #3314: same idiom, same reason — the sweep is destructive and its only
		// caller is this file's teardown, so a guard that ran it would perform the
		// run's cleanup inside its own assertion. The decision is pinned
		// behaviourally by `spares another invocation's entries from the sweep`;
		// this is the wiring that makes the sweep consult it.
		expect(body).toMatch(/\btmpHygieneSweepableEntries\s*\(/);
	});

	it("registers the tmp-hygiene setup hook in every vitest project", () => {
		const config = fs.readFileSync(
			path.join(REPO_ROOT, "vitest.config.ts"),
			"utf8",
		);
		expect(config).toContain("./tests/support/vitest-setup.ts");
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		expect(setup).toContain("[tmp-hygiene]");
	});

	it("holds every tmp-leak admission to a reason, an issue, and a real file", () => {
		const setup = fs.readFileSync(
			path.join(REPO_ROOT, "tests/support/vitest-setup.ts"),
			"utf8",
		);
		const block = setup.match(/const TMP_LEAK_ADMISSIONS[^;]*;/s)?.[0] ?? "";
		const entries = [
			...block.matchAll(
				/file:\s*"([^"]+)"[\s\S]*?reason:\s*"([^"]+)"[\s\S]*?issue:\s*"([^"]+)"/g,
			),
		];
		for (const [, file, reason, issue] of entries) {
			expect(reason.length).toBeGreaterThan(20);
			expect(issue).toMatch(/^#\d+$/);
			if (file !== "*") {
				expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
			}
		}
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{
			prefix: string;
			owner: string;
			reason: string;
		}>;
		expect(baseline.length).toBeGreaterThan(0);
		for (const row of baseline) {
			expect(row.prefix.startsWith("pi-lens-")).toBe(true);
			expect(row.reason).toContain("#2912");
			expect(fs.existsSync(path.join(REPO_ROOT, row.owner))).toBe(true);
		}
	});

	it("keeps every live baseline prefix within its checked-in owner population", () => {
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{ prefix: string }>;
		const created = baseline.map((row) =>
			fs.mkdtempSync(path.join(os.tmpdir(), `${row.prefix}population-`)),
		);
		try {
			const observed = tmpHygieneObservedEntries();
			for (const row of baseline) {
				expect(
					observed.some((entry) => entry.startsWith(row.prefix)),
					`${row.prefix} disappeared from its owner population; remove the admission`,
				).toBe(true);
			}
		} finally {
			for (const dir of created)
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reds new prefixes and removal of an admitted prefix from the real namespace", () => {
		const baseline = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "tests/config/tmp-fixture-hygiene-baseline.json"),
				"utf8",
			),
		) as Array<{ prefix: string }>;
		const created = baseline.map((row) =>
			fs.mkdtempSync(path.join(os.tmpdir(), `${row.prefix}governance-`)),
		);
		const fabricated = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-fabricated-new-prefix-X-"),
		);
		try {
			const observed = tmpHygieneObservedEntries();
			expect(
				tmpHygieneUnadmittedEntries(
					observed,
					"config/tmp-fixture-hygiene.test.ts",
				).sort(),
			).toContain(path.basename(fabricated));
		} finally {
			for (const dir of [...created, fabricated])
				fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reds when a live prefix loses its admission row", () => {
		const live = "pi-lens-still-live-abc";
		const admissions = [
			{
				file: "*",
				prefix: "pi-lens-other-",
				reason: "unrelated admission",
				issue: "#2912",
			},
		];
		expect(
			tmpHygieneUnadmittedEntries(
				[live],
				"config/tmp-fixture-hygiene.test.ts",
				admissions,
			),
		).toContain(live);
	});

	it("selects the longest matching prefix for overlapping fixture families", () => {
		const admission = tmpHygieneAdmissionFor(
			"config/tmp-fixture-hygiene.test.ts",
			"pi-lens-which-latch-shabc123",
			[
				{
					file: "*",
					prefix: "pi-lens-which-latch",
					reason: "short",
					issue: "#2912",
				},
				{
					file: "*",
					prefix: "pi-lens-which-latch-sh",
					reason: "long",
					issue: "#2912",
				},
			],
		);
		expect(admission?.prefix).toBe("pi-lens-which-latch-sh");
	});

	// #3186: PR #3168 CI run 35160969016 redded THIS file over
	// pi-lens-tool-policy-conventions-{4irwKN,BDRp7z,PQRGdj} — dirs owned by
	// tests/clients/tool-policy-conventions.test.ts, whose afterEach removed
	// its setupTestEnvironment dir synchronously while saveProjectSnapshot's
	// body persist was still in flight. Premise-first repro against the real
	// production call (clients/project-snapshot.ts saveProjectSnapshot, no
	// mock): a bare Node invocation that calls it, then removes the directory
	// the instant it returns, saw the directory back on disk ~10-50ms later,
	// unforced, on every trial — saveProjectSnapshot dispatches its body
	// persist to a worker thread/main-thread fallback the caller never
	// awaits, and that persist's write path (clients/gzip-stage-write.ts)
	// does `fs.promises.mkdir(dirname, {recursive:true})` before writing,
	// recreating whatever ancestor directory a synchronous cleanup already
	// removed.
	//
	// The real fix is at the producer, not an admission here: every call
	// site (including tool-policy-conventions.test.ts's own afterEach, as of
	// this change) awaits the drain seam the repo already ships for exactly
	// this — waitForProjectSnapshotPersistsForTests — before its cleanup
	// runs, so nothing is left in flight to recreate the directory once
	// removed. Proven WITHOUT a raw wall-clock wait (this file's own
	// dedicated, fully-serialized project is not in vitest.config.ts's
	// wallClockBudgetInclude/realHarnessInclude, so a new raw timer here
	// would need moving the file's whole project assignment just for one
	// case): JS is single-threaded, so immediately after the synchronous
	// saveProjectSnapshot() call returns, NO microtask or macrotask of its
	// fire-and-forget worker/main-thread-fallback dispatch has run yet —
	// the body file cannot exist. Awaiting the real drain seam instead of a
	// fixed pause is what proves completion, not elapsed time: once it
	// resolves, the body file is verifiably ON DISK (not "probably done by
	// now"), so cleanup right after it can leave nothing pending to recreate
	// what it removes — checked synchronously, no wait either side.
	it("draining the real project-snapshot persist before cleanup leaves nothing to recreate pi-lens-tool-policy-conventions dirs", async () => {
		const env = setupTestEnvironment("pi-lens-tool-policy-conventions-");
		const cwd = path.join(env.tmpDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const runtime = new RuntimeCoordinator();
		runtime.seedProjectSequence(1);
		const snapshot = buildProjectSnapshotFromRuntime({
			cwd,
			runtime,
			conventions: {
				frameworks: [
					{ id: "react", confidence: "high", signals: ["fixture:react"] },
				],
				testRunners: [],
				buildTools: [],
				agentDocs: [],
			},
		});
		const gzPath = getProjectSnapshotPath(cwd);
		saveProjectSnapshot(cwd, snapshot);
		expect(
			fs.existsSync(gzPath),
			"the persist is dispatched fire-and-forget; it cannot have landed in the same synchronous tick",
		).toBe(false);
		await waitForProjectSnapshotPersistsForTests(); // the #3186 fix
		expect(
			fs.existsSync(gzPath),
			"the drain must not resolve before the persist actually reaches disk",
		).toBe(true);
		env.cleanup();
		expect(
			fs.existsSync(env.tmpDir),
			"nothing was left pending to recreate the directory cleanup just removed",
		).toBe(false);
	});

	// #3186 round 3. Every case below is one cell of the platform × owner-state
	// table in PR #3297's body. The recurrence each prevents is named per case;
	// the class recurrence is HIGH-3297-V1 — round 2 authenticated owner markers
	// with `/proc/<pid>/stat` as the SOLE gate, so on darwin/win32 every marker
	// was written without a start time and then rejected, the live-owner arm was
	// unavailable for all workers, and the hygiene owner reported another
	// worker's still-draining fixture as a leak (the original #3186 defect).
	//
	// The process boundary is the ONLY thing doubled: markers, their heartbeat
	// mtimes and the directory scan are real, so a `fs` mock cannot launder the
	// heartbeat these cases are about.
	describe("owner-marker liveness across platforms (#3186)", () => {
		const OWNER = "config/tmp-fixture-hygiene.test.ts";
		// #3316: these cells double the process boundary, and a double answers
		// `isAlive` for EVERY marker in the directory it is pointed at — including
		// markers of sibling test files this case never wrote. A fully skipped file
		// leaves one behind (vitest runs no `afterAll` for a file with no executed
		// test, so the setup's marker removal never happens), its mtime is minutes
		// fresh, and `helm-render-iac-real-binary.test.ts` in the same invocation
		// therefore redded `ignores a marker from a previous run` and `attributes
		// malformed markers without throwing` on master. The cells get their OWN
		// marker namespace: every marker the scan sees is one of these cases'.
		const ownerDir = (): string =>
			path.join(
				process.env.PI_LENS_HOME as string,
				`tmp-hygiene-owners-cell-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}`,
			);
		beforeAll(() => {
			fs.mkdirSync(ownerDir(), { recursive: true });
		});
		afterAll(() => {
			fs.rmSync(ownerDir(), { recursive: true, force: true });
		});

		function writeOwnerMarker(
			suffix: string,
			body: unknown,
			opts: { runId?: string; ageMs?: number } = {},
		): string {
			const file = path.join(
				ownerDir(),
				`${opts.runId ?? process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-${suffix}.json`,
			);
			fs.writeFileSync(
				file,
				typeof body === "string" ? body : JSON.stringify(body),
			);
			if (opts.ageMs !== undefined) {
				const seconds = (Date.now() - opts.ageMs) / 1000;
				fs.utimesSync(file, seconds, seconds);
			}
			return file;
		}

		/** A platform with no process start time at all (darwin, win32). */
		const noStartTimes: TmpHygieneProcessProbe = {
			startTimeSupported: false,
			startTimeOf: () => undefined,
			isAlive: () => true,
		};
		/** A platform that has start times, observing `observed` for the pid. */
		const withStartTimes = (
			observed: string | undefined,
		): TmpHygieneProcessProbe => ({
			startTimeSupported: true,
			startTimeOf: () => observed,
			isAlive: () => true,
		});

		async function suppressed(
			probe: TmpHygieneProcessProbe,
		): Promise<{ attributed: string[]; live: string[]; counts: unknown }> {
			const scan = await tmpHygieneWaitForOwnerDrain(50, probe, ownerDir());
			return {
				attributed: tmpHygieneExcludeLiveOwnerEntries(
					["pi-lens-owner-cell-3186"],
					() => OWNER,
					scan.live,
				),
				live: [...scan.live],
				counts: scan.counts,
			};
		}

		it("suppresses a live worker on a platform with no process start times", async () => {
			// F1 / HIGH-3297-V1: darwin and win32 write markers with no startTime.
			// Rejecting them all is the round-2 defect this case exists to catch.
			const marker = writeOwnerMarker("cell-live-nostart", {
				pid: 1,
				file: OWNER,
			});
			try {
				expect((await suppressed(noStartTimes)).attributed).toEqual([]);
				fs.rmSync(marker, { force: true });
				expect((await suppressed(noStartTimes)).attributed).toEqual([
					"pi-lens-owner-cell-3186",
				]);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("attributes a start-time-less marker on a platform that has start times", async () => {
			// F9 / MEDIUM-3297-2: the reviewer's hand-written `{"pid":1,...}` marker
			// must not suppress on Linux, where the setup always records a start
			// time. The heartbeat must not soften this direction.
			const marker = writeOwnerMarker("cell-nostart-linux", {
				pid: 1,
				file: OWNER,
			});
			try {
				expect((await suppressed(withStartTimes("900"))).attributed).toEqual([
					"pi-lens-owner-cell-3186",
				]);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("attributes a marker whose pid was reused by another process", async () => {
			// F2: same pid, different process lifetime.
			const marker = writeOwnerMarker("cell-reused", {
				pid: 1,
				startTime: "900",
				file: OWNER,
			});
			try {
				expect((await suppressed(withStartTimes("4321"))).attributed).toEqual([
					"pi-lens-owner-cell-3186",
				]);
				// ...and the matching lifetime is the one that suppresses.
				expect((await suppressed(withStartTimes("900"))).attributed).toEqual(
					[],
				);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("attributes a marker whose heartbeat stopped, on every platform", async () => {
			// F3: a SIGKILLed worker stops beating. This is the bound that holds
			// where no start time exists, so it is asserted on BOTH platform cells
			// with every other check passing.
			const marker = writeOwnerMarker(
				"cell-stale-heartbeat",
				{ pid: 1, startTime: "900", file: OWNER },
				{ ageMs: TMP_HYGIENE_OWNER_STALE_MS + 60_000 },
			);
			try {
				expect((await suppressed(noStartTimes)).attributed).toEqual([
					"pi-lens-owner-cell-3186",
				]);
				expect((await suppressed(withStartTimes("900"))).attributed).toEqual([
					"pi-lens-owner-cell-3186",
				]);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("attributes a marker whose pid is gone", async () => {
			// F2 (dead-pid arm): the portable liveness check, the only immediate
			// orphan signal where no start time exists.
			const marker = writeOwnerMarker("cell-dead-pid", {
				pid: 1,
				file: OWNER,
			});
			try {
				expect(
					(await suppressed({ ...noStartTimes, isAlive: () => false }))
						.attributed,
				).toEqual(["pi-lens-owner-cell-3186"]);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("ignores a marker from a previous run", async () => {
			// F4: a stale run's marker is neither live nor attributed here.
			const marker = writeOwnerMarker(
				"cell-foreign",
				{ pid: 1, file: OWNER },
				{ runId: "run-3186-previous" },
			);
			try {
				const result = await suppressed(noStartTimes);
				expect(result.attributed).toEqual(["pi-lens-owner-cell-3186"]);
				expect(result.live).toEqual([]);
				expect(
					(result.counts as Record<string, number>).foreign,
				).toBeGreaterThanOrEqual(1);
			} finally {
				fs.rmSync(marker, { force: true });
			}
		});

		it("attributes malformed markers without throwing", async () => {
			// F5: half-written JSON and a marker missing its owner file must never
			// suppress and must never fail the hygiene owner's own teardown.
			const bad = writeOwnerMarker("cell-bad-json", '{"pid":1,"file"');
			const shapeless = writeOwnerMarker("cell-no-file", { pid: 1 });
			try {
				const result = await suppressed(noStartTimes);
				expect(result.attributed).toEqual(["pi-lens-owner-cell-3186"]);
				expect(result.live).toEqual([]);
				expect(
					(result.counts as Record<string, number>).malformed,
				).toBeGreaterThanOrEqual(2);
			} finally {
				fs.rmSync(bad, { force: true });
				fs.rmSync(shapeless, { force: true });
			}
		});

		it("attributes only the drained owner when two owners share the entry set", async () => {
			// F8: the filter is per entry by owner, so one live owner never
			// suppresses a second, drained owner's leftovers.
			const live = new Set(["clients/alpha.test.ts"]);
			const owners: Record<string, string> = {
				"pi-lens-alpha-1": "clients/alpha.test.ts",
				"pi-lens-beta-1": "clients/beta.test.ts",
			};
			expect(
				tmpHygieneExcludeLiveOwnerEntries(
					["pi-lens-alpha-1", "pi-lens-beta-1"],
					(entry) => owners[entry],
					live,
				),
			).toEqual(["pi-lens-beta-1"]);
		});

		it("records one census line per hygiene run, not one per marker", () => {
			// Bounded observability: the record the afterAll writes is this exact
			// line, and it is a census, so N markers never produce N records.
			expect(
				formatTmpHygieneOwnerSummary({
					live: new Set(["clients/alpha.test.ts"]),
					counts: {
						live: 1,
						orphaned: 2,
						malformed: 3,
						foreign: 4,
						self: 1,
					},
				}),
			).toBe(
				"[tmp-hygiene-owners] live=1 orphaned=2 malformed=3 foreign=4 self=1 otherInvocationEntries=0 reaped=0",
			);
			// #3314's field is part of the same ONE line, not a second record: the
			// entries this run ignored as another invocation's are explicable from
			// the run's own output.
			expect(
				formatTmpHygieneOwnerSummary(
					{
						live: new Set<string>(),
						counts: {
							live: 0,
							orphaned: 0,
							malformed: 0,
							foreign: 2,
							self: 1,
						},
					},
					3,
				),
			).toBe(
				"[tmp-hygiene-owners] live=0 orphaned=0 malformed=0 foreign=2 self=1 otherInvocationEntries=3 reaped=0",
			);
		});

		it("reaps only stale foreign owner records across three censuses", () => {
			// #3332: a skipped file or killed worker never reaches teardown, so its
			// marker and run manifest used to accumulate under the persistent home.
			// The current run stays protected by name, while a fresh sibling stays
			// protected by age (#3314).
			const ownerDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-tmp-reap-owners-"),
			);
			const recordDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-tmp-reap-records-"),
			);
			const originalRunId = process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
			const now = Date.now();
			const old = new Date(now - TMP_HYGIENE_OWNER_STALE_MS - 1);
			try {
				for (const run of ["one", "two", "three"]) {
					process.env.PI_LENS_TMP_HYGIENE_RUN_ID = `reap-3332-${run}`;
					const marker = path.join(
						ownerDir,
						`${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-1.json`,
					);
					const manifest = path.join(
						recordDir,
						`tmp-hygiene-files-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}.log`,
					);
					fs.writeFileSync(marker, JSON.stringify({ pid: 1, file: OWNER }));
					fs.writeFileSync(manifest, `${OWNER}\n`);
					fs.utimesSync(marker, old, old);
					fs.utimesSync(manifest, old, old);
					reapStaleTmpHygieneRecords(ownerDir, recordDir, now);
				}
				const freshMarker = path.join(ownerDir, "reap-3332-fresh-1.json");
				const freshManifest = path.join(
					recordDir,
					"tmp-hygiene-files-reap-3332-fresh.log",
				);
				fs.writeFileSync(freshMarker, JSON.stringify({ pid: 1, file: OWNER }));
				fs.writeFileSync(freshManifest, `${OWNER}\n`);
				reapStaleTmpHygieneRecords(ownerDir, recordDir, now);
				expect(fs.readdirSync(ownerDir).sort()).toEqual([
					"reap-3332-fresh-1.json",
					"reap-3332-three-1.json",
				]);
				expect(fs.readdirSync(recordDir).sort()).toEqual([
					"tmp-hygiene-files-reap-3332-fresh.log",
					"tmp-hygiene-files-reap-3332-three.log",
				]);
			} finally {
				if (originalRunId === undefined)
					delete process.env.PI_LENS_TMP_HYGIENE_RUN_ID;
				else process.env.PI_LENS_TMP_HYGIENE_RUN_ID = originalRunId;
				fs.rmSync(ownerDir, { recursive: true, force: true });
				fs.rmSync(recordDir, { recursive: true, force: true });
			}
		});

		it("declares start-time support exactly when this host's markers carry one", () => {
			// The V1 shape stated as an invariant: `startTimeSupported` is measured
			// against THIS process, so it can never be true while the setup writes
			// markers without a start time (which is what made every marker on
			// darwin/win32 unauthenticatable in round 2).
			const probe = realTmpHygieneProcessProbe();
			// This worker's REAL marker, in the run-shared directory the production
			// census reads — not the private cell namespace above.
			const ownMarker = JSON.parse(
				fs.readFileSync(OWN_MARKER_PATH, "utf8"),
			) as { startTime?: string };
			expect(typeof ownMarker.startTime === "string").toBe(
				probe.startTimeSupported,
			);
			expect(
				classifyTmpHygieneOwner({
					runMatches: true,
					// A pid that is alive on every OS and is not this worker's own:
					// `1` is init on POSIX but does not exist on Windows, where the
					// real `isAlive(1)` answers false and the verdict read "orphaned"
					// (#4019).
					marker: {
						pid: process.ppid,
						startTime: ownMarker.startTime,
						file: OWNER,
					},
					markerMtimeMs: Date.now(),
					nowMs: Date.now(),
					selfPid: process.pid,
					probe: { ...probe, startTimeOf: () => ownMarker.startTime },
					staleAfterMs: TMP_HYGIENE_OWNER_STALE_MS,
				}),
			).toBe("live");
		});

		it("keeps the worker heartbeat fresh while the worker runs", () => {
			// F6/F3 producer side: the marker this worker published is beaten from
			// the test lifecycle, so a sibling owner reading its REAL mtime right
			// now classifies it live. No timer is involved, and the assertion is on
			// the verdict rather than on an elapsed-time delta.
			expect(
				classifyTmpHygieneOwner({
					runMatches: true,
					// pid swapped so this reads as a SIBLING's marker, not "self".
					marker: { pid: 1, file: OWNER },
					markerMtimeMs: fs.statSync(OWN_MARKER_PATH).mtimeMs,
					nowMs: Date.now(),
					selfPid: process.pid,
					probe: noStartTimes,
					staleAfterMs: TMP_HYGIENE_OWNER_STALE_MS,
				}),
			).toBe("live");
		});

		it("registers the heartbeat on the test lifecycle, not just defines it", () => {
			// F6: the hooks in tests/support/vitest-setup.ts are what keep a live
			// worker's marker fresh. This worker's marker has been beaten by its own
			// beforeEach/afterEach since this file was loaded, so its mtime has
			// moved off the value the setup's initial write left. Deleting the
			// `beforeEach`/`afterEach` registration reds this case.
			expect(fs.statSync(OWN_MARKER_PATH).mtimeMs).not.toBe(
				OWN_MARKER_MTIME_AT_LOAD,
			);
		});
		it("beats a stale marker back to live", () => {
			// F3 producer side, mutation-provable: age this worker's own marker past
			// the ceiling, force one beat, and the same facts flip from orphaned to
			// live. Removing the write inside the beat reds this.
			const aged = (Date.now() - TMP_HYGIENE_OWNER_STALE_MS - 60_000) / 1000;
			fs.utimesSync(OWN_MARKER_PATH, aged, aged);
			const facts = (): Parameters<typeof classifyTmpHygieneOwner>[0] => ({
				runMatches: true,
				marker: { pid: 1, file: OWNER },
				markerMtimeMs: fs.statSync(OWN_MARKER_PATH).mtimeMs,
				nowMs: Date.now(),
				selfPid: process.pid,
				probe: noStartTimes,
				staleAfterMs: TMP_HYGIENE_OWNER_STALE_MS,
			});
			expect(classifyTmpHygieneOwner(facts())).toBe("orphaned");
			touchTmpHygieneOwnerMarker(0n);
			expect(classifyTmpHygieneOwner(facts())).toBe("live");
		});
	});

	// #3314 / #3306. Two vitest invocations share one TMPDIR whenever they share a
	// shell's `TMPDIR`; measured on master, invocation B (`tests/config`) redded
	// on two roots invocation A (`tests/index-wiring.test.ts`) left behind:
	// `pi-lens-wiring-resume-… (owner: tests/unknown)`. Both halves of that line
	// are recurrences these cases prevent — the entry was not this run's to judge,
	// and the report could not name the file that made it.
	describe("census scope across invocations (#3314, #3306)", () => {
		const OWN = "config/tmp-fixture-hygiene.test.ts";
		const WIRING = "index-wiring.test.ts";

		/** A manifest of this run, written where the reader takes an explicit
		 *  path: the record is real, its content is the axis under test. */
		function manifest(files: readonly string[], tag: string): Set<string> {
			const file = path.join(
				process.env.PI_LENS_HOME as string,
				`tmp-hygiene-files-scope-${process.env.PI_LENS_TMP_HYGIENE_RUN_ID}-${tag}.log`,
			);
			fs.writeFileSync(file, files.map((name) => `${name}\n`).join(""));
			try {
				return tmpHygieneRunFiles(file);
			} finally {
				fs.rmSync(file, { force: true });
			}
		}

		it("names the test file behind a raw mkdtemp prefix", () => {
			// F3/F5: `tests/index-wiring.test.ts` creates its roots from a
			// `pi-lens-wiring-${reason}-` TEMPLATE, so neither a literal
			// `setupTestEnvironment("…")` scan nor a literal-only mkdtemp scan could
			// attribute `pi-lens-wiring-resume-…`. The index reads the static head.
			expect(ownerForTmpEntry("pi-lens-wiring-resume-iCpHXp")).toBe(WIRING);
			expect(ownersForTmpEntry("pi-lens-wiring-resume-iCpHXp")).toContain(
				WIRING,
			);
			// The raw-literal class in the same file, and an unrelated one
			// elsewhere, so the needle is not a single-fixture special case.
			expect(ownerForTmpEntry("pi-lens-wiring-new-AbCdEf")).toBe(WIRING);
			expect(ownerForTmpEntry("pi-lens-crash-surface-AbCdEf")).toBe(WIRING);
			// A prefix no tests/ file spells still has no owner: the census must
			// keep saying so rather than inventing one.
			expect(ownerForTmpEntry("pi-lens-nothing-spells-this-")).toBeUndefined();
			// The index is bounded to the namespace the census can observe, and no
			// entry in it is the bare namespace. Both halves are measured over the
			// real tree, which spells plenty of non-`pi-lens-` fixture prefixes and
			// one dynamic `pi-lens-${tool}-` whose static head is the namespace
			// itself — with either half gone, that head claims every entry.
			for (const prefix of ownerIndex().prefixes.keys()) {
				expect(prefix.startsWith("pi-lens-"), prefix).toBe(true);
				expect(prefix).not.toBe("pi-lens-");
			}
		});

		it("ignores entries owned by a file no worker of this run loaded", () => {
			// F1: the measured #3314 red. The entry's only candidate owner is
			// index-wiring, which this manifest says never ran here.
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-wiring-resume-iCpHXp"],
					ownersForTmpEntry,
					manifest([OWN], "foreign"),
				),
			).toEqual(["pi-lens-wiring-resume-iCpHXp"]);
		});

		it("judges an entry whose owner ran here, and every entry with no manifest", () => {
			// F1's inverse, and the fail-closed arm: this run's own leak must still
			// red (F4), and a manifest that cannot be read must never silence one.
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-wiring-resume-iCpHXp"],
					ownersForTmpEntry,
					manifest([OWN, WIRING], "own"),
				),
			).toEqual([]);
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-wiring-resume-iCpHXp"],
					ownersForTmpEntry,
					new Set<string>(),
				),
			).toEqual([]);
			// An entry no file claims is judged too — `pi-lens-ast-grep` is
			// production-owned and reaches its admission, not this filter.
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-ast-grep"],
					ownersForTmpEntry,
					manifest([OWN], "unowned"),
				),
			).toEqual([]);
		});

		it("keeps an entry judged when any candidate owner ran here", () => {
			// Attribution is longest-prefix, so an entry can have several candidate
			// owners. One of them running here is enough to keep it judged: the
			// ignore arm must be unanimous, never a first match.
			const owners = (entry: string): string[] =>
				entry.startsWith("pi-lens-shared-") ? ["a.test.ts", "b.test.ts"] : [];
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-shared-1"],
					owners,
					new Set(["b.test.ts"]),
				),
			).toEqual([]);
			expect(
				tmpHygieneForeignRunEntries(
					["pi-lens-shared-1"],
					owners,
					new Set(["c.test.ts"]),
				),
			).toEqual(["pi-lens-shared-1"]);
		});

		it("spares another invocation's entries from the sweep", () => {
			// #3314's destructive half: on master, invocation B REMOVED the roots it
			// mis-attributed, so a sibling invocation lost a live fixture. The
			// decision is separated from the sweep because the sweep's only caller
			// is this file's own teardown.
			const observed = ["pi-lens-sibling-1", "pi-lens-mine-1"];
			expect(
				tmpHygieneSweepableEntries(
					observed,
					new Set<string>(),
					new Set(["pi-lens-sibling-1"]),
				),
			).toEqual(["pi-lens-mine-1"]);
			// Without the spare set the same entry is removed — the direction that
			// broke the other run.
			expect(tmpHygieneSweepableEntries(observed, new Set<string>())).toEqual(
				observed,
			);
			// The two rules the sweep already had are still in force.
			expect(
				tmpHygieneSweepableEntries(observed, new Set(["pi-lens-mine-1"])),
			).toEqual(["pi-lens-sibling-1"]);
			expect(
				tmpHygieneSweepableEntries(["pi-lens-ast-grep"], new Set<string>()),
			).toEqual([]);
		});

		it("reads only this run's file manifest", () => {
			// F7: the manifest is run-id scoped by NAME. This worker's own line is
			// in the record the default reader opens, and a record written for
			// another run id is not in it.
			// Written with the exact name and in the exact directory another
			// invocation's manifest would occupy, so a reader that merged every
			// manifest beside it — the shared-namespace mistake the owner markers
			// made — would pick this up.
			const foreign = path.join(
				process.cwd(),
				".probe-home",
				"tmp-hygiene-files-3314-foreign-run-guard.log",
			);
			fs.writeFileSync(foreign, "config/never-ran-here.test.ts\n");
			try {
				expect(tmpHygieneRunFiles()).toContain(OWN);
				expect(tmpHygieneRunFiles()).not.toContain(
					"config/never-ran-here.test.ts",
				);
			} finally {
				fs.rmSync(foreign, { force: true });
			}
		});

		/** A two-file fixture tree: one file whose CALLS create fixture families,
		 *  one file that only mentions those families in prose — a comment, a string
		 *  spelling `setupTestEnvironment`, a string spelling `mkdtempSync`, and a
		 *  string naming the other file's real family. Both cases below drive the
		 *  real index over it. */
		function plantOwnerIndexFixture(): { dir: string; index: TmpOwnerIndex } {
			const dir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-owner-index-fixture-"),
			);
			fs.writeFileSync(
				path.join(dir, "planted.test.ts"),
				[
					'const a = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-planted-lit-"));',
					"const b = fs.mkdtempSync(",
					"\tpath.join(os.tmpdir(), `pi-lens-planted-tpl-${reason}-`),",
					");",
					"function make(prefix: string) {",
					"\treturn fs.mkdtempSync(path.join(os.tmpdir(), prefix));",
					"}",
					'make("pi-lens-planted-param-");',
					// The real call of the laundered needle, so the fix cannot be "stop
					// reading setupTestEnvironment at all".
					'const real = setupTestEnvironment("pi-lens-planted-setup-");',
				].join("\n"),
			);
			fs.writeFileSync(
				path.join(dir, "decoy.test.ts"),
				[
					'// fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-planted-comment-"));',
					// The reviewer's decoy, verbatim in shape: prose that spells a call,
					// in a string a real test fixture could plausibly hold.
					"const decoy = 'setupTestEnvironment(\"pi-lens-planted-string-\")';",
					"const decoyTmp = \"fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lens-planted-strtmp-'))\";",
					// ...and a decoy naming the OTHER file's real family, the shape that
					// costs a sibling invocation its live root.
					"const note = 'setupTestEnvironment(\"pi-lens-planted-lit-\")';",
				].join("\n"),
			);
			return { dir, index: buildTmpOwnerIndex(dir, { prefixes: 3, files: 2 }) };
		}

		it("registers a raw mkdtemp prefix from the call site, never from prose", () => {
			const { dir: fixture, index } = plantOwnerIndexFixture();
			try {
				const owner = (entry: string): string | undefined =>
					ownerForTmpEntry(entry, index);
				expect(owner("pi-lens-planted-lit-XyZ")).toBe("planted.test.ts");
				expect(owner("pi-lens-planted-tpl-fork-XyZ")).toBe("planted.test.ts");
				expect(owner("pi-lens-planted-param-XyZ")).toBe("planted.test.ts");
				expect(owner("pi-lens-planted-setup-XyZ")).toBe("planted.test.ts");
				expect(
					owner("pi-lens-planted-comment-XyZ"),
					"a commented-out call must own nothing",
				).toBeUndefined();
				expect(
					owner("pi-lens-planted-string-XyZ"),
					"a string that spells setupTestEnvironment must own nothing (M3328-1)",
				).toBeUndefined();
				expect(
					owner("pi-lens-planted-strtmp-XyZ"),
					"a string that spells mkdtempSync must own nothing (M3328-1)",
				).toBeUndefined();
				expect(
					ownersForTmpEntry("pi-lens-planted-lit-XyZ", index),
					"a string naming another file's family must not make this file a candidate",
				).toEqual(["planted.test.ts"]);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});

		it("spares a sibling's root when this run only mentioned its prefix in prose", () => {
			// M3328-1's impact, end to end: this run loaded `decoy.test.ts`, which
			// merely MENTIONS `pi-lens-planted-lit-` in a string, while the root
			// belongs to `planted.test.ts`, which no worker of this run loaded.
			// Laundering that mention into ownership gives the entry a candidate owner
			// that ran here, the unanimous filter stops sparing it, and the sweep
			// deletes a live sibling invocation's fixture — #3314's central failure,
			// reached through prose.
			const { dir: fixture, index } = plantOwnerIndexFixture();
			try {
				expect(
					tmpHygieneForeignRunEntries(
						["pi-lens-planted-lit-XyZ"],
						(entry) => ownersForTmpEntry(entry, index),
						new Set(["decoy.test.ts"]),
					),
					"an entry whose owner this run never loaded stays another invocation's",
				).toEqual(["pi-lens-planted-lit-XyZ"]);
				// ...and the same entry IS this run's business once the file that
				// really creates it ran here.
				expect(
					tmpHygieneForeignRunEntries(
						["pi-lens-planted-lit-XyZ"],
						(entry) => ownersForTmpEntry(entry, index),
						new Set(["decoy.test.ts", "planted.test.ts"]),
					),
				).toEqual([]);
			} finally {
				fs.rmSync(fixture, { recursive: true, force: true });
			}
		});
	});

	// #2912 (2026-10-10): the owner must name the test file that CREATED a
	// leaked entry, not the file whose declared prefix matches its name. The
	// jscpd leak on #4122/#4285 was misattributed to
	// tests/clients/jscpd-client.test.ts by prefix; the real producer was a
	// real-pi child of tests/real-harness/outside-root.test.ts.
	describe("owner attribution by creator (#2912)", () => {
		const OWN = "config/tmp-fixture-hygiene.test.ts";
		const FOREIGN_PREFIX_OWNER = "clients/jscpd-client.test.ts";
		const FOREIGN_PREFIX = "pi-lens-jscpd-managed-";

		it("names the creating test file beside the prefix owner", () => {
			const entry = `${FOREIGN_PREFIX}AbCdEf`;
			expect(formatTmpHygieneLeakEntry(entry, FOREIGN_PREFIX_OWNER, OWN)).toBe(
				`${entry} (owner: tests/${FOREIGN_PREFIX_OWNER}; created by tests/${OWN})`,
			);
		});

		it("labels an unobserved entry as created outside the test process, never with a prefix owner", () => {
			const entry = `${FOREIGN_PREFIX}AbCdEf`;
			expect(
				formatTmpHygieneLeakEntry(entry, FOREIGN_PREFIX_OWNER, undefined),
			).toBe(`${entry} (created outside the test process (child))`);
		});

		it("records this file as the creator of an entry another file's prefix names", () => {
			// A real creation through the real interposer, not a synthetic map: one
			// file's prefix on a name another file made is the acceptance shape.
			// The prefix is spelled as a template with only an interpolation, so
			// this file does NOT enter the owner index as a candidate: the prefix
			// owner stays the other file, which is what makes the attribution test
			// meaningful.
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${FOREIGN_PREFIX}`));
			try {
				const entry = path.basename(dir);
				const creator =
					recordedTmpRootCreators(getTmpRootRegistry()).get(entry);
				expect(creator).toBe(OWN);
				expect(ownerForTmpEntry(entry)).toBe(FOREIGN_PREFIX_OWNER);
				expect(
					formatTmpHygieneLeakEntry(entry, ownerForTmpEntry(entry), creator),
				).toContain(`created by tests/${OWN}`);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("reads one creator per entry, keeps the first on a duplicate line, and is empty when absent", () => {
			const file = path.join(
				TMP_HYGIENE_HOME,
				`tmp-hygiene-creators-probe-${process.pid}.log`,
			);
			fs.writeFileSync(
				file,
				"pi-lens-a\tfirst.test.ts\npi-lens-a\tsecond.test.ts\npi-lens-b\tthird.test.ts\n",
			);
			try {
				expect([...tmpHygieneCreators(file).entries()].sort()).toEqual([
					["pi-lens-a", "first.test.ts"],
					["pi-lens-b", "third.test.ts"],
				]);
			} finally {
				fs.rmSync(file, { force: true });
			}
			expect(
				tmpHygieneCreators(
					path.join(TMP_HYGIENE_HOME, "no-such-creators-record.log"),
				).size,
			).toBe(0);
		});
	});
});
