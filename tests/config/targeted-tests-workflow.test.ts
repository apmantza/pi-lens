import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	CI_ONLY_PRE_PUSH_TESTS,
	TEST_TREE_GOVERNANCE_TESTS,
	TREE_SCANNING_GOVERNANCE_TESTS,
} from "../../scripts/pre-push-targeted-tests.mjs";
import {
	assertNonEmptyScan,
	codeMatches,
	escapeRegExp,
	listSourceFiles,
	readWalkedFile,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = resolve(ROOT, "tests");
const SELF = "tests/config/targeted-tests-workflow.test.ts";
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

// ── Scanner detection (#3426 H3432-2) ──────────────────────────────────────
//
// The pre-push selector arms `TREE_SCANNING_GOVERNANCE_TESTS` on a production
// change because those suites read the source tree instead of importing the
// changed module. A hand list cannot keep that population honest: an added
// tree scanner is silently omitted. This census enumerates scanner-shaped code
// over comment/string-BLANKED source (the sweep-kit `codeMatches` seam), so a
// `readdirSync("clients")` named only in a comment or string is not a scanner
// while real code is. The registry must equal this discovered population minus
// the reasoned exemptions below — an unreasoned omission reds.

const PRODUCTION_ROOTS = "clients|tools|mcp|scripts|commands|index\\.ts";
const WALK_HELPERS =
	"listSourceFiles|clientSourceFiles|collectTestFiles|globSync|glob|fastGlob|readdirSync|readdir";

// Modules whose exports walk a tree, and the export names that do.
const WALK_MODULES = "fast-glob|glob|node:fs|fs|node:fs/promises|fs/promises";
const WALK_EXPORTS = new Set([
	"glob",
	"globSync",
	"sync",
	"async",
	"stream",
	"readdir",
	"readdirSync",
]);
const IDENT = "[A-Za-z_$][\\w$]*";
const DEFAULT_IMPORT = new RegExp(
	`\\bimport\\s+(?:\\*\\s+as\\s+)?(${IDENT})\\s+from\\s*["'](fast-glob|glob)["']`,
	"g",
);
const NAMED_IMPORT = new RegExp(
	`\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*["'](?:${WALK_MODULES})["']`,
	"g",
);

// The local names this file binds to a walk helper (#3448): `fg` for
// `import fg from "fast-glob"`, `g` for `import { glob as g } from "glob"`.
// Only an import that is code binds a name; one in a comment does not.
function walkHelperAliases(source: string): string[] {
	const aliases = new Set<string>();
	for (const match of codeMatches(source, DEFAULT_IMPORT)) {
		// A default or namespace binding is callable itself and through its
		// walking members (`fg.sync(...)`).
		aliases.add(
			`${match[1].replaceAll("$", "\\$")}(?:\\.(?:${[...WALK_EXPORTS].join("|")}))?`,
		);
	}
	for (const match of codeMatches(source, NAMED_IMPORT)) {
		for (const specifier of match[1].split(",")) {
			const [imported, local = imported] = specifier
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/);
			if (imported && WALK_EXPORTS.has(imported) && local)
				aliases.add(local.replaceAll("$", "\\$"));
		}
	}
	return [...aliases];
}

// ── Walks delegated to a tests/support module (#3472) ──────────────────────
//
// `countsByDetector` (tests/support/flake-shape-scan.ts) walks the tests tree
// on behalf of the flake-shape ratchet, so the ratchet's own calls name no
// walk helper. The census resolves each relative import that lands in
// tests/support/, finds the exports whose body reaches a walk helper (through
// module-local functions and through further support imports), and treats a
// test that calls one of them as a walker. The chunks are column-0
// declarations of the comment/string-blanked module, not a name list.

const SUPPORT_ROOT = resolve(TESTS_ROOT, "support");
const DECLARATION =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)?|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=])/gm;
const DEFAULT_ARROW_DECLARATION =
	/^export\s+default\s+(?:async\s+)?(?:<[^;\n]+>\s*)?(?:\([^)]*\)(?:\s*:\s*[^=\n]+)?|[A-Za-z_$][\w$]*)\s*=>/gm;
const RELATIVE_IMPORT =
	/\bimport\s+(?:type\s+)?([^;"']*?)\s*from\s*["'](\.[^"']*)["']/g;
const DEFAULT_EXPORT_ALIAS = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g;
const DEFAULT_EXPORT_SPECIFIER = /\bexport\s*\{([^}]*)\}(?!\s*from\b)/g;
const REEXPORT_SPECIFIER =
	/\bexport\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g;
const DIRECT_HELPER = new RegExp(`^(?:${WALK_HELPERS})$`);
const CALLEE = /\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g;

/** Reads a source file by absolute path; `undefined` when it is gone. */
type SourceReader = (absolute: string) => string | undefined;

interface ImportBinding {
	file: string;
	/** The exported name, or `*` for a namespace binding. */
	imported: string;
}

interface SupportModule {
	chunks: Map<string, string>;
	imports: Map<string, ImportBinding>;
	reexports: Map<string, ImportBinding>;
	helpers: RegExp;
}

// Keep diagnostics concise while counting every distinct miss in this census.
const SUPPORT_IMPORT_GAP_LIMIT = 16;

function supportImports(
	from: string,
	source: string,
): Map<string, ImportBinding> {
	const bindings = new Map<string, ImportBinding>();
	for (const match of codeMatches(source, RELATIVE_IMPORT)) {
		const resolved = resolve(dirname(from), match[2]).replace(/\.js$/, ".ts");
		if (!resolved.startsWith(`${SUPPORT_ROOT}${sep}`)) continue;
		const clause = match[1];
		const defaultImport = /^([A-Za-z_$][\w$]*)/.exec(clause.trim());
		if (defaultImport)
			bindings.set(defaultImport[1], { file: resolved, imported: "default" });
		const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
		if (namespace)
			bindings.set(namespace[1], { file: resolved, imported: "*" });
		const named = /\{([^}]*)\}/.exec(clause);
		for (const specifier of named?.[1].split(",") ?? []) {
			const [imported, local = imported] = specifier
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/);
			if (imported) bindings.set(local, { file: resolved, imported });
		}
	}
	return bindings;
}

function supportModule(file: string, source: string): SupportModule {
	const blanked = stripSource(source, { strings: "blank" });
	const starts = [
		...blanked.matchAll(DECLARATION),
		...blanked.matchAll(DEFAULT_ARROW_DECLARATION),
	].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	const chunks = new Map<string, string>();
	starts.forEach((start, index) => {
		const end = starts[index + 1]?.index ?? blanked.length;
		const chunk = blanked.slice(start.index, end);
		const name = start[1] ?? start[2];
		if (name) chunks.set(name, chunk);
		if (/^(?:export\s+)?default\b/.test(start[0])) chunks.set("default", chunk);
	});
	for (const [, name] of codeMatches(source, DEFAULT_EXPORT_ALIAS)) {
		const chunk = chunks.get(name);
		if (chunk !== undefined) chunks.set("default", chunk);
	}
	for (const [, specifiers] of codeMatches(source, DEFAULT_EXPORT_SPECIFIER)) {
		for (const specifier of specifiers.split(",")) {
			const [local, exported = local] = specifier
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/);
			if (exported === "default") {
				const chunk = chunks.get(local);
				if (chunk !== undefined) chunks.set("default", chunk);
			}
		}
	}
	const reexports = new Map<string, ImportBinding>();
	for (const [, specifiers, specifier] of codeMatches(
		source,
		REEXPORT_SPECIFIER,
	)) {
		const resolved = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
		if (!resolved.startsWith(`${SUPPORT_ROOT}${sep}`)) continue;
		for (const entry of specifiers.split(",")) {
			const [imported, exported = imported] = entry
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/);
			if (imported && exported)
				reexports.set(exported, { file: resolved, imported });
		}
	}
	const helpers = [WALK_HELPERS, ...walkHelperAliases(source)].join("|");
	return {
		chunks,
		imports: supportImports(file, source),
		reexports,
		helpers: new RegExp(`\\b(?:${helpers})\\s*\\(`),
	};
}

/**
 * Answers "does this support export reach a walk helper", caching proven walks
 * per census. A cycle answers `false` only while that name is being visited.
 */
function createSupportWalkIndex(read: SourceReader) {
	const modules = new Map<string, SupportModule | undefined>();
	const verdicts = new Map<string, boolean>();
	const supportImportGaps: string[] = [];
	let droppedSupportImportGaps = 0;
	const load = (file: string): SupportModule | undefined => {
		if (!modules.has(file)) {
			const source = read(file);
			if (source === undefined) {
				if (supportImportGaps.length < SUPPORT_IMPORT_GAP_LIMIT)
					supportImportGaps.push(file);
				else droppedSupportImportGaps += 1;
			}
			modules.set(
				file,
				source === undefined ? undefined : supportModule(file, source),
			);
		}
		return modules.get(file);
	};
	const walks = (file: string, name: string): boolean => {
		const key = `${file}#${name}`;
		const known = verdicts.get(key);
		if (known !== undefined) return known;
		verdicts.set(key, false);
		const module = load(file);
		let verdict = false;
		const reexport = module?.reexports.get(name);
		if (reexport) {
			verdict = walks(reexport.file, reexport.imported);
		} else {
			const chunk = module?.chunks.get(name);
			if (module && chunk !== undefined) {
				verdict = module.helpers.test(chunk);
				for (const [, callee, member] of chunk.matchAll(CALLEE)) {
					if (verdict) break;
					const binding = module.imports.get(callee);
					if (binding?.imported === "*" && member)
						verdict = walks(binding.file, member);
					else if (binding) verdict = walks(binding.file, binding.imported);
					else if (callee !== name && module.chunks.has(callee))
						verdict = walks(file, callee);
				}
			}
		}
		// A false reached through a cycle is provisional, not proof of no walk.
		if (verdict) verdicts.set(key, true);
		else verdicts.delete(key);
		return verdict;
	};
	const gapEvidence = () => ({
		paths: [...supportImportGaps],
		dropped: droppedSupportImportGaps,
		total: supportImportGaps.length + droppedSupportImportGaps,
	});
	const assertComplete = () => {
		const evidence = gapEvidence();
		if (evidence.total > 0) {
			throw new Error(
				`support import coverage incomplete (${evidence.total} unreadable path(s); ${evidence.dropped} omitted): ${evidence.paths.join(", ")}`,
			);
		}
	};
	return {
		/** Missing paths are request-local; the next census creates a fresh index. */
		gapEvidence,
		assertComplete,
		/** True when `source` calls a support export that walks a tree. */
		callsSupportWalker(from: string, source: string): boolean {
			return [...supportImports(from, source)].some(([local, binding]) => {
				const name = escapeRegExp(local);
				if (binding.imported === "*") {
					const members = new RegExp(`\\b${name}\\.([\\w$]+)\\s*\\(`, "g");
					return codeMatches(source, members).some((call) =>
						walks(binding.file, call[1]),
					);
				}
				// A direct helper name is judged by the production-root shapes.
				return (
					!DIRECT_HELPER.test(binding.imported) &&
					codeHas(source, new RegExp(`\\b${name}\\s*\\(`, "g")) &&
					walks(binding.file, binding.imported)
				);
			});
		},
	};
}

function shapesFor(walkHelpers: string): Record<string, RegExp> {
	return {
		// A walk helper called with a production-root path literal.
		productionWalk: new RegExp(
			`\\b(?:${walkHelpers})\\s*\\([^;{}]*?["'][^"']*(?:${PRODUCTION_ROOTS})[^"']*["']`,
			"g",
		),
		// A helper that only ever walks production source.
		namedProductionWalk:
			/\b(?:clientSourceFiles|shippedSourceFiles|hookPathFiles|hookHelperModules)\s*\(/g,
		// A direct production-file read (targeted ratchets such as degradation-kind).
		productionRead: new RegExp(
			`\\b(?:readFile|readFileSync|readJson)\\s*\\([^;{}]*?["'][^"']*(?:${PRODUCTION_ROOTS})/[^"']*["']`,
			"g",
		),
		// A git population read (tracked files) rather than a filesystem walk.
		gitPopulationRead:
			/gitExecFileSync\s*\([^;]*?["'](?:ls-files|diff|ls-tree)["']/g,
		// The production TypeScript strictness ratchet.
		strictnessRatchet: /(?:strictness-report\.mjs|\brunCheck\s*\()/g,
		// A named root list (SCAN_ROOTS, DIRS, …) paired with a walk.
		rootListWalk:
			/\b(?:SCAN_ROOTS|PRODUCTION_ROOTS|productionRoots|SCAN_DIRS|SOURCE_ROOTS|DIRS)\b/g,
		// A walk over the tests tree, gated by a population floor.
		testsPopulationFloor: /listSourceFiles\s*\(\s*TESTS_ROOT/g,
		// An inline production-root array iterated with a walk helper.
		inlineRootLoop: new RegExp(
			`for\\s*\\([^)]*\\bof\\s*\\[[^\\]]*["'](?:clients|tools|mcp)["'][^\\]]*\\][\\s\\S]{0,800}?\\b(?:${walkHelpers})\\s*\\(`,
			"g",
		),
		// A `.d.mts`/`.mjs` sibling-pair walk.
		dmtsSiblingPair: /endsWith\s*\(\s*["'][^"']*\.d\.mts/g,
	};
}

const FLOOR =
	/\b(?:assertNonEmptyScan|auditRegistry|assertSortedRegistry)\s*\(/g;
function anyWalkFor(walkHelpers: string): RegExp {
	return new RegExp(`\\b(?:${walkHelpers})\\s*\\(`, "g");
}

// The single blanking seam the mutation test removes: replace `codeMatches`
// with a raw `.test()` and the comment-only case below flips red.
function codeHas(source: string, pattern: RegExp): boolean {
	return codeMatches(source, pattern).length > 0;
}

/** Resolves the tests/support walks a file delegates to (#3472). */
interface SupportWalks {
	file: string;
	index: ReturnType<typeof createSupportWalkIndex>;
}

export function isTreeScannerCandidate(
	source: string,
	support?: SupportWalks,
): boolean {
	const walkHelpers = [WALK_HELPERS, ...walkHelperAliases(source)].join("|");
	const SHAPES = shapesFor(walkHelpers);
	const ANY_WALK = anyWalkFor(walkHelpers);
	return (
		support?.index.callsSupportWalker(support.file, source) === true ||
		codeHas(source, SHAPES.productionWalk) ||
		codeHas(source, SHAPES.namedProductionWalk) ||
		(codeHas(source, SHAPES.productionRead) && codeHas(source, FLOOR)) ||
		(codeHas(source, SHAPES.gitPopulationRead) && codeHas(source, FLOOR)) ||
		codeHas(source, SHAPES.strictnessRatchet) ||
		(codeHas(source, SHAPES.rootListWalk) &&
			codeHas(source, ANY_WALK) &&
			codeHas(source, FLOOR)) ||
		(codeHas(source, SHAPES.testsPopulationFloor) && codeHas(source, FLOOR)) ||
		(codeHas(source, SHAPES.inlineRootLoop) && codeHas(source, FLOOR)) ||
		(codeHas(source, SHAPES.dmtsSiblingPair) && codeHas(source, ANY_WALK))
	);
}

// Every discovered scanner that is deliberately outside the pre-push registry.
// A reason is required; `auditRegistry`'s stale-entry check (below) deletes an
// entry whose file stops matching the scanner shapes.
const TREE_SCANNER_EXEMPTIONS: Readonly<Record<string, string>> = {
	"tests/build-freshness-guard.test.ts":
		"runs the freshness helpers over temp roots it builds; its one real-root case checks compiled-twin mtimes, which the pre-push build step satisfies, not a source population",
	"tests/clients/analyzed-files-producer-coverage.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/bus-producer-coverage.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/cargo-manifest.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/config-diagnostic-codes.test.ts":
		"real-git fixture behavior cases over a temp repository, not a tracked-source population scan",
	"tests/clients/config-notice-bounds.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/data-dir-display-path-sweep.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/deps-centralization.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/dispatch/runners/exit-table-governance.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/lsp/launch.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/mutating-tool-classification.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/ndjson-writer-conformance.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/clients/pi-lens-home-hermeticity.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/safe-spawn-default-output-cap.test.ts":
		"copies a production path list inside behavior cases, not a production population sweep",
	"tests/clients/socket-error-listener-sweep.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/clients/workspace-topology-conformance.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/bounded-eviction-idiom-sweep.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/gitignore-tracked-shadow.test.ts":
		"real-git fixture behavior cases over a temp repository, not a tracked-source population scan",
	"tests/config/lsp-advertised-capability-senders.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/lsp-service-double-sweep.test.ts":
		"walks the tests/ tree, not the production source population; out of the production tree-scanner registry",
	"tests/config/path-key-fold-sweep.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/process-table-seam.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/script-entry-portability.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/config/sync-child-process-timeout.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/config/test-shard-assignment.test.ts":
		"reads the live test file set for shard placement and duration-snapshot drift, not a production or test-code defect population; unknown files receive the median cost and accumulated missing/stale snapshot entries can cross the 15% drift threshold (regenerated by scripts/gen-test-shard-weights.mjs)",
	"tests/config/win32-gate-lane.test.ts":
		"walks the tests/ tree, not the production source population; out of the production tree-scanner registry",
	"tests/host-sdk-type-only.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/packaging-pack-manifest.test.ts":
		"walks the unpacked `npm pack` tarball (the published file set, #3219), not a tracked-source population; its real pack runs in the Unit tests lane",
	"tests/real-harness/fixture-shape.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/real-harness/outside-root.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/scripts/pre-push-targeted-tests.test.ts":
		"pins the pre-push selector's production-versus-tests scanner arming against the live collectTestFiles inventory; it checks hook selection classes, not a tests-tree defect population",
	"tests/support/tests-tree-write-guard-race.test.ts":
		"exercises the tests-tree write guard against a temp root the test creates; the live tests/ tree is not the population",
	"tests/support/tests-tree-write-guard.test.ts":
		"exercises the tests-tree write guard against a temp root the test creates; the live tests/ tree is not the population",
};

// Independently reviewed admissions for the current exemption set. The reason
// text above explains each status; its digest pins that reviewed explanation
// so plausible but unrelated prose cannot silently excuse a live scanner.
// Adding, deleting, or rewording an exemption requires an explicit admission
// review here as well as the stale-entry/census checks below.
const REVIEWED_EXEMPTION_REASON_SHA256: Readonly<Record<string, string>> = {
	"tests/build-freshness-guard.test.ts":
		"ea497d088a210d85cef8f2e67ce466fb9bfb9d6e354ab44503b7fbcf61dc6f09",
	"tests/clients/analyzed-files-producer-coverage.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/bus-producer-coverage.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/cargo-manifest.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/config-diagnostic-codes.test.ts":
		"328eedc0f2ae31de9712393c0b6bb60bed4b2b7ee26f33e331ea9a8dd9bd9640",
	"tests/clients/config-notice-bounds.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/data-dir-display-path-sweep.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/deps-centralization.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/dispatch/runners/exit-table-governance.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/lsp/launch.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/mutating-tool-classification.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/ndjson-writer-conformance.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/clients/pi-lens-home-hermeticity.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/safe-spawn-default-output-cap.test.ts":
		"962f7e39a3c4804aa1a9a15ab5716bab85cae3094e46f983444c81c219934703",
	"tests/clients/socket-error-listener-sweep.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/clients/workspace-topology-conformance.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/bounded-eviction-idiom-sweep.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/gitignore-tracked-shadow.test.ts":
		"328eedc0f2ae31de9712393c0b6bb60bed4b2b7ee26f33e331ea9a8dd9bd9640",
	"tests/config/lsp-advertised-capability-senders.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/lsp-service-double-sweep.test.ts":
		"603e6212ad082ac4ed3c67fb1a7e1520c7caeb948dc81b0dbefb6b789fc1e459",
	"tests/config/path-key-fold-sweep.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/process-table-seam.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/script-entry-portability.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/config/sync-child-process-timeout.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/config/test-shard-assignment.test.ts":
		"60a56bf699306e0bc49c7170e00f7dafd11b34b67f1793c2d5e89d2cd5d19a0e",
	"tests/config/win32-gate-lane.test.ts":
		"603e6212ad082ac4ed3c67fb1a7e1520c7caeb948dc81b0dbefb6b789fc1e459",
	"tests/host-sdk-type-only.test.ts":
		"a5f39f74f8b98ecb71fd32eca749b87f32253b782a3ceb03e421ca71cfa22e88",
	"tests/packaging-pack-manifest.test.ts":
		"a23d57340227888c7a1cdef6804380a521059657a230689a9f04cc1f14b36823",
	"tests/real-harness/fixture-shape.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/real-harness/outside-root.test.ts":
		"d7b3f6416a0c3322ccacd55c509f742554dda016cb99a2ff0f383ef33578ae13",
	"tests/scripts/pre-push-targeted-tests.test.ts":
		"16cca8c9c3dc8ab143a20b9464160dc66889beff2afa1e442a5a2bf6e4ef0a59",
	"tests/support/tests-tree-write-guard-race.test.ts":
		"80ad6f38da37fe72579a02e932e78067e7d8dbb3fcc288547ccf68b805780833",
	"tests/support/tests-tree-write-guard.test.ts":
		"80ad6f38da37fe72579a02e932e78067e7d8dbb3fcc288547ccf68b805780833",
};

function exemptionAdmissionDrift(
	exemptions: Readonly<Record<string, string>> = TREE_SCANNER_EXEMPTIONS,
): string[] {
	const admitted = Object.entries(exemptions).map(
		([file, reason]) =>
			[file, createHash("sha256").update(reason).digest("hex")] as const,
	);
	const current = Object.fromEntries(admitted);
	return [
		...new Set([
			...Object.keys(REVIEWED_EXEMPTION_REASON_SHA256).filter(
				(file) => !Object.hasOwn(current, file),
			),
			...Object.entries(current)
				.filter(
					([file, digest]) => REVIEWED_EXEMPTION_REASON_SHA256[file] !== digest,
				)
				.map(([file]) => file),
		]),
	].sort();
}

function discoverTreeScannersFromWalk(
	walked: readonly { file: string; source: string }[],
	readSupport: SourceReader,
): string[] {
	const index = createSupportWalkIndex(readSupport);
	const discovered = walked
		.filter(({ file, source }) =>
			isTreeScannerCandidate(source, { file, index }),
		)
		.map(({ file }) => relativePosix(ROOT, file))
		.sort();
	index.assertComplete();
	return discovered;
}

/** The scanner population discovered on this tree, repo-relative and sorted. */
export function discoveredTreeScanners(): string[] {
	const walked = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(ROOT, file) !== SELF);
	// readWalkedFiles, not readFileSync: a path that vanished between the walk
	// and the read is out of the population, not a finding (#3082).
	return discoverTreeScannersFromWalk(readWalkedFiles(walked), readWalkedFile);
}

// One census per worker: two assertions read the same walking of ~1,200 files.
let censusCache: string[] | undefined;
function census(): string[] {
	censusCache ??= discoveredTreeScanners();
	return censusCache;
}
const CENSUS_TIMEOUT_MS = 30_000;

function readWorkflow() {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<
			string,
			{
				name?: string;
				if?: string;
				"continue-on-error"?: boolean;
				steps?: Array<{
					uses?: string;
					run?: string;
					with?: Record<string, unknown>;
				}>;
			}
		>;
	};
}

describe("targeted advisory workflow contract (#3215)", () => {
	it(
		"pins exactly the tree scanners the census discovers (#3426)",
		() => {
			const discovered = census();
			const expectedRegistry = discovered.filter(
				(file) => !Object.hasOwn(TREE_SCANNER_EXEMPTIONS, file),
			);
			// Mechanical equality in both directions: an unregistered scanner reds,
			// including one that calls a walk helper through an import alias
			// (`fg("clients/**")`, #3448), and a registry entry that is no longer a
			// scanner reds, as does one whose walk lives in an imported
			// tests/support module (#3472). Not seen: a helper renamed through a
			// dynamic `import()` or `require`, or a support export that only a
			// `export … from` re-export reaches (hook-await-scan.ts re-exports an
			// .mjs; its tree walkers are already the named production shapes).
			// A scanner may sit in either list (#3472): the production list is
			// armed by a production change, the tests-tree list by a tests/ change.
			const registered = [
				...TREE_SCANNING_GOVERNANCE_TESTS,
				...TEST_TREE_GOVERNANCE_TESTS,
			];
			expect(expectedRegistry).toEqual([...registered].sort());
			expect(new Set(registered).size).toBe(registered.length);

			// Dead-sweep floors (AGENTS.md shape 10, #1718): the census cannot pass
			// by discovering nothing. Registered through the sweep-kit seam so the
			// sweep-floor meta-sweep sees this file's own floor.
			assertNonEmptyScan("tree-scanner census", discovered.length, 30);
			assertNonEmptyScan(
				"tree-scanner registry",
				TREE_SCANNING_GOVERNANCE_TESTS.length,
				10,
			);
		},
		CENSUS_TIMEOUT_MS,
	);

	it(
		"gives every exemption a real reason and flags stale ones (#1735)",
		() => {
			const discovered = new Set(census());
			const reasonless = Object.entries(TREE_SCANNER_EXEMPTIONS)
				.filter(([, reason]) => reason.trim().length < 20)
				.map(([file]) => file);
			expect(reasonless).toEqual([]);
			expect(exemptionAdmissionDrift()).toEqual([]);
			// #3951 N1: a reworded reviewed reason must fail its digest pin.
			const reviewedRow = "tests/build-freshness-guard.test.ts";
			expect(
				exemptionAdmissionDrift({
					...TREE_SCANNER_EXEMPTIONS,
					[reviewedRow]: `${TREE_SCANNER_EXEMPTIONS[reviewedRow]}.`,
				}),
			).toEqual([reviewedRow]);

			// #3951 N1: a missing reviewed row must be reported.
			const withoutReviewedRow = Object.fromEntries(
				Object.entries(TREE_SCANNER_EXEMPTIONS).filter(
					([file]) => file !== reviewedRow,
				),
			);
			expect(exemptionAdmissionDrift(withoutReviewedRow)).toEqual([
				reviewedRow,
			]);
			// #3951 F2: plausible prose must not let a live scanner migrate into
			// exemptions and disappear from the independently reviewed admission.
			expect(
				exemptionAdmissionDrift({
					...TREE_SCANNER_EXEMPTIONS,
					"tests/config/tmp-fixture-hygiene.test.ts":
						"this is a plausible but unreviewed reason for exemption",
				}),
			).toEqual(["tests/config/tmp-fixture-hygiene.test.ts"]);
			const stale = Object.keys(TREE_SCANNER_EXEMPTIONS).filter(
				(file) => !discovered.has(file),
			);
			expect(stale).toEqual([]);
		},
		CENSUS_TIMEOUT_MS,
	);

	it("runs the selector on every PR with a full checkout and no gating power", () => {
		const job = readWorkflow().jobs["targeted-tests-advisory"];
		expect(job?.name).toBe("Targeted tests (advisory)");
		expect(job?.if).toBe("github.event_name == 'pull_request'");
		expect(job?.["continue-on-error"]).toBe(true);
		const checkout = job?.steps?.find((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(checkout?.uses).toBe(
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		);
		expect(checkout?.with?.["fetch-depth"]).toBe(0);
		const setupNode = job?.steps?.find((step) =>
			step.uses?.startsWith("actions/setup-node@"),
		);
		expect(setupNode?.uses).toBe(
			"actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
		);
	});

	it("keeps install/build parity and publishes the selector outcome", () => {
		const selector = readFileSync(
			resolve(ROOT, "scripts/pre-push-targeted-tests.mjs"),
			"utf8",
		);
		const job = readWorkflow().jobs["targeted-tests-advisory"];
		const runs = job?.steps?.map((step) => step.run).filter(Boolean) ?? [];
		// Lockfile-locked and script-free (SonarCloud githubactions:S8543 /
		// S6505 on the copied `npm install`); the grammar download is the one
		// `prepare` piece the targeted files need, so it is an explicit step.
		expect(runs).toContain("npm ci --no-audit --no-fund --ignore-scripts");
		expect(runs).toContain(
			"node scripts/download-grammars.js --core --dest grammars",
		);
		expect(
			runs.indexOf("node scripts/download-grammars.js --core --dest grammars"),
		).toBeLessThan(runs.indexOf("npm run build"));
		expect(runs).toContain("npm run build");
		// #3426 H3432-1: the advisory job is the CI row for the CI-only tier.
		expect(runs).toContain(
			"node scripts/pre-push-targeted-tests.mjs --skip-build --include-ci-only",
		);
		expect(selector).toContain("GITHUB_STEP_SUMMARY");
		expect(selector).toContain("cap exceeded");
	});
});

// Red-first proof for the HIGH-2 omission defect: the census must see an
// executable production walk and must NOT see one named only in prose. The
// fixture strings mirror `tests/config/review-tree-scanner-probe.test.ts`.
describe("tree-scanner census — prose is never code (#3426 H3432-2)", () => {
	it("detects an executable production walk", () => {
		expect(
			isTreeScannerCandidate('const files = fs.readdirSync("clients");'),
		).toBe(true);
	});

	it("does NOT detect a production walk named only in a comment", () => {
		expect(
			isTreeScannerCandidate(
				'// const files = fs.readdirSync("clients"); is not a scan',
			),
		).toBe(false);
	});

	it("does NOT detect a production walk quoted inside a string", () => {
		expect(
			isTreeScannerCandidate(
				"const note = 'readdirSync(\"clients\") is not a scan';",
			),
		).toBe(false);
	});

	it("does NOT claim a non-scanning unit test", () => {
		expect(isTreeScannerCandidate("expect(2 + 2).toBe(4);")).toBe(false);
	});
});

// #3448: the census resolves each file's walk-helper import bindings before
// matching, so a renamed helper is still a scanner.
describe("tree-scanner census — import aliases are resolved (#3448)", () => {
	it.each([
		['import fg from "fast-glob";\nconst files = fg("clients/**/*.ts");'],
		['import fg from "fast-glob";\nconst files = fg.sync("clients/**/*.ts");'],
		['import * as fg from "fast-glob";\nconst files = fg.glob("tools/**");'],
		['import { glob as g } from "glob";\nconst files = await g("mcp/**");'],
		['import { sync } from "fast-glob";\nconst files = sync("clients/**");'],
		[
			'import { readdirSync as rd } from "node:fs";\nconst files = rd("clients");',
		],
	])("detects an aliased production walk: %s", (source) => {
		expect(isTreeScannerCandidate(source)).toBe(true);
	});

	it("does NOT bind an alias from an import named only in a comment", () => {
		expect(
			isTreeScannerCandidate(
				'// import fg from "fast-glob";\nconst files = fg("clients/**");',
			),
		).toBe(false);
	});

	it("does NOT bind an alias from an unrelated module", () => {
		expect(
			isTreeScannerCandidate(
				'import fg from "./fixtures.js";\nconst files = fg("clients/**");',
			),
		).toBe(false);
	});
});

// #3472: a walk delegated to a tests/support module. `scan.ts` below stands in
// for tests/support/flake-shape-scan.ts: the test names no walk helper, and the
// export it calls reaches one through module-local functions or other support
// modules. The reader is in-memory, so no file on disk decides these cases.
describe("tree-scanner census — walks delegated to tests/support (#3472)", () => {
	const TEST_FILE = resolve(TESTS_ROOT, "clients/subject.test.ts");
	const WALKING_SCAN = [
		"export function counts(detector: string) {",
		"	return files().length + detector.length;",
		"}",
		"function files() {",
		"	return listSourceFiles(ROOT);",
		"}",
	].join("\n");

	function candidate(source: string, modules: Record<string, string>): boolean {
		const read = (absolute: string) =>
			modules[relativePosix(SUPPORT_ROOT, absolute)];
		return isTreeScannerCandidate(source, {
			file: TEST_FILE,
			index: createSupportWalkIndex(read),
		});
	}

	it.each([
		[
			"a module-local helper reached from the export",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{ "scan.ts": WALKING_SCAN },
		],
		[
			"an arrow-function export",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts": "export const counts = (d: string) =>\n	readdirSync(d);",
			},
		],
		[
			"an aliased import",
			'import { counts as c } from "../support/scan.js";\nc("x");',
			{ "scan.ts": WALKING_SCAN },
		],
		[
			"a named default export import",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"export default function counts(d: string) {\n\treturn listSourceFiles(d);\n}",
			},
		],
		[
			"an anonymous default function import",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"export default function(d: string) {\n\treturn listSourceFiles(d);\n}",
			},
		],
		[
			"a default arrow expression import",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts": "export default (d: string) => listSourceFiles(d);",
			},
		],
		[
			"a default arrow expression with a return annotation",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"export default (d: string): string[] => listSourceFiles(d);",
			},
		],
		[
			"a generic default arrow expression",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"export default <T extends string>(d: T): string[] => listSourceFiles(d);",
			},
		],
		[
			"a default import of a local function assignment",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"function counts(d: string) {\n\treturn listSourceFiles(d);\n}\nexport default counts;",
			},
		],
		[
			"a default import of a named export alias",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"const counts = (d: string) => listSourceFiles(d);\nexport { counts as default };",
			},
		],
		[
			"a namespace import",
			'import * as scan from "../support/scan.js";\nscan.counts("x");',
			{ "scan.ts": WALKING_SCAN },
		],
		[
			"a second support module",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts":
					'import { allFiles } from "./inner.js";\nexport function counts(d: string) {\n	return allFiles(d);\n}',
				"inner.ts":
					"export function allFiles(d: string) {\n	return glob(d);\n}",
			},
		],
		[
			"a walk helper the support module renames",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts":
					'import { readdirSync as ls } from "node:fs";\nexport function counts(d: string) {\n	return ls(d);\n}',
			},
		],
		[
			"a walking default re-export",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts": 'export { default } from "./inner.js";',
				"inner.ts": "export default (d: string) => listSourceFiles(d);",
			},
		],
	])("detects %s", (_label, source, modules) => {
		expect(candidate(source, modules)).toBe(true);
	});

	it.each([
		[
			"an export whose body does not walk",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts": "export function counts(d: string) {\n	return d.length;\n}",
			},
		],
		[
			"a default export whose body does not walk",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					"export default function counts(d: string) {\n\treturn d.length;\n}",
			},
		],
		[
			"a sourced default re-export instead of a same-name local walker",
			'import scan from "../support/scan.js";\nscan("x");',
			{
				"scan.ts":
					'function scan(d: string) { return listSourceFiles(d); }\nexport { scan as default } from "./inner.js";',
				"inner.ts":
					"export default function scan(d: string) { return d.length; }",
			},
		],
		[
			"a walk named only in a support comment or string",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts":
					'// readdirSync(ROOT) is not a walk\nexport function counts(d: string) {\n	return "listSourceFiles(ROOT)" + d;\n}',
			},
		],
		[
			"a walking export that is imported but never called",
			'import { counts } from "../support/scan.js";\n// counts("x");',
			{ "scan.ts": WALKING_SCAN },
		],
		[
			"a module outside tests/support",
			'import { counts } from "../../clients/scan.js";\ncounts("x");',
			{ "../../clients/scan.ts": WALKING_SCAN },
		],
		[
			"a re-export target outside tests/support",
			'import { counts } from "../support/scan.js";\ncounts("x");',
			{
				"scan.ts": 'export { counts } from "../../clients/string-utils.js";',
				"../../clients/string-utils.ts": WALKING_SCAN,
			},
		],
		[
			"a direct helper name, which the production-root shapes judge",
			'import { listSourceFiles } from "../support/kit.js";\nlistSourceFiles(dir);',
			{
				"kit.ts":
					"export function listSourceFiles(d: string) {\n	return readdirSync(d);\n}",
			},
		],
		[
			"a call cycle with no walk in it",
			'import { a } from "../support/scan.js";\na();',
			{
				"scan.ts":
					"export function a() {\n	return b();\n}\nfunction b() {\n	return a();\n}",
			},
		],
	])("does NOT detect %s", (_label, source, modules) => {
		expect(candidate(source, modules)).toBe(false);
	});

	// #3472: one census shares the index across files; resolving a cycle from
	// one export must not hide another export's reachable walk later.
	it("does not cache a cycle cut as a non-walking export", () => {
		const source = [
			"export function a(depth = 1) { if (depth > 0) return b(depth - 1); return files(); }",
			"export function b(depth = 1) { return a(depth); }",
			"function files() { return listSourceFiles(ROOT); }",
		].join("\n");
		const index = createSupportWalkIndex(() => source);
		for (const name of ["a", "b", "a", "b"]) {
			expect(
				index.callsSupportWalker(
					TEST_FILE,
					`import { ${name} } from "../support/scan.js";\n${name}();`,
				),
				name,
			).toBe(true);
		}
	});

	it("follows namespace calls inside support modules", () => {
		expect(
			candidate('import { counts } from "../support/scan.js";\ncounts();', {
				"scan.ts":
					'import * as inner from "./inner.js";\nexport function counts() { return inner.files(); }',
				"inner.ts": "export function files() { return readdirSync(ROOT); }",
			}),
		).toBe(true);
	});

	it("does not attribute a sibling export's walk to a non-walking export", () => {
		expect(
			candidate('import { counts } from "../support/scan.js";\ncounts();', {
				"scan.ts":
					"export function counts() { return 0; }\nexport function files() { return readdirSync(ROOT); }",
			}),
		).toBe(false);
	});

	it("ignores missing support modules and quoted namespace calls", () => {
		expect(
			candidate(
				'import { counts } from "../support/missing.js";\ncounts();',
				{},
			),
		).toBe(false);
		expect(
			candidate(
				'import * as scan from "../support/scan.js";\n"scan.counts()"; // scan.counts()',
				{
					"scan.ts": WALKING_SCAN,
				},
			),
		).toBe(false);
	});

	it("records a missing relative support import read by the real reader", () => {
		const testFile = resolve(
			TESTS_ROOT,
			"config/targeted-tests-workflow.test.ts",
		);
		const index = createSupportWalkIndex(readWalkedFile);
		const source =
			'import { counts } from "../support/__census_gap_probe__.js";\ncounts();';

		expect(index.callsSupportWalker(testFile, source)).toBe(false);
		expect(index.gapEvidence()).toEqual({
			paths: [resolve(SUPPORT_ROOT, "__census_gap_probe__.ts")],
			dropped: 0,
			total: 1,
		});
		expect(() => index.assertComplete()).toThrow(
			/support import coverage incomplete \(1 unreadable path\(s\); 0 omitted\)/,
		);
	});

	it("fails closed at the census boundary when a support import is unreadable", () => {
		const testFile = resolve(
			TESTS_ROOT,
			"config/targeted-tests-workflow.test.ts",
		);
		const walked = [
			{
				file: testFile,
				source:
					'import { counts } from "../support/__census_boundary_gap__.js";\ncounts();',
			},
		];

		expect(() => discoverTreeScannersFromWalk(walked, () => undefined)).toThrow(
			/support import coverage incomplete \(1 unreadable path\(s\); 0 omitted\)/,
		);
	});

	it("caps missing-import paths and counts every distinct omitted path", () => {
		const count = 20;
		const source = Array.from({ length: count }, (_, index) => {
			const name = `count${index}`;
			return `import { scan as ${name} } from "../support/gap-${index}.js";\n${name}();`;
		}).join("\n");
		const index = createSupportWalkIndex(() => undefined);

		expect(index.callsSupportWalker(TEST_FILE, source)).toBe(false);
		const evidence = index.gapEvidence();
		expect(evidence.paths).toHaveLength(16);
		expect(evidence.dropped).toBe(4);
		expect(evidence.total).toBe(count);
	});

	it("retries a missing support module in the next census request", () => {
		const testFile = resolve(
			TESTS_ROOT,
			"config/targeted-tests-workflow.test.ts",
		);
		const source =
			'import { counts } from "../support/appears_later.js";\ncounts();';
		const first = createSupportWalkIndex(readWalkedFile);
		const second = createSupportWalkIndex(
			() => "export function counts() { return listSourceFiles(ROOT); }",
		);

		expect(first.callsSupportWalker(testFile, source)).toBe(false);
		expect(first.gapEvidence().total).toBe(1);
		expect(second.callsSupportWalker(testFile, source)).toBe(true);
		expect(second.gapEvidence()).toEqual({ paths: [], dropped: 0, total: 0 });
	});

	it("resolves countsByDetector to the real tests-tree walk behind it", () => {
		const ratchet = resolve(TESTS_ROOT, "clients/flake-shape-ratchet.test.ts");
		const index = createSupportWalkIndex(readWalkedFile);
		const call =
			'import { countsByDetector } from "../support/flake-shape-scan.js";\ncountsByDetector("raw-timer-wait");';
		expect(index.callsSupportWalker(ratchet, call)).toBe(true);
	});

	it(
		"registers the flake-shape ratchet as a tests-tree scanner",
		() => {
			const ratchet = "tests/clients/flake-shape-ratchet.test.ts";
			expect(census()).toContain(ratchet);
			expect(TEST_TREE_GOVERNANCE_TESTS).toContain(ratchet);
			expect(TREE_SCANNING_GOVERNANCE_TESTS).not.toContain(ratchet);
		},
		CENSUS_TIMEOUT_MS,
	);

	it(
		"registers the host event-shape scan as a tests-tree scanner",
		() => {
			const scanner = "tests/support/host-event-shape-scan.test.ts";
			expect(census()).toContain(scanner);
			expect(TEST_TREE_GOVERNANCE_TESTS).toContain(scanner);
			expect(TREE_SCANNING_GOVERNANCE_TESTS).not.toContain(scanner);
		},
		CENSUS_TIMEOUT_MS,
	);
});

describe("CI-only pre-push tier (#3426 H3432-1)", () => {
	it("carries a reason and a CI row for every deferred suite", () => {
		const entries = Object.entries(CI_ONLY_PRE_PUSH_TESTS);
		expect(entries.length).toBeGreaterThanOrEqual(1);
		for (const [file, reason] of entries) {
			expect(file).toMatch(/^tests\/.+\.test\.ts$/);
			expect(reason.trim().length).toBeGreaterThanOrEqual(20);
		}
	});

	it("runs the deferred suite in the advisory CI job, never the pre-push hook", () => {
		const job = readWorkflow().jobs["targeted-tests-advisory"];
		const runs = job?.steps?.map((step) => step.run).filter(Boolean) ?? [];
		expect(runs.some((run) => run?.includes("--include-ci-only"))).toBe(true);
		const prePush = readFileSync(resolve(ROOT, ".husky/pre-push"), "utf8");
		expect(prePush).not.toContain("--include-ci-only");
	});
});
