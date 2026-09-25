import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	CI_ONLY_PRE_PUSH_TESTS,
	TREE_SCANNING_GOVERNANCE_TESTS,
} from "../../scripts/pre-push-targeted-tests.mjs";
import {
	assertNonEmptyScan,
	codeMatches,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
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

export function isTreeScannerCandidate(source: string): boolean {
	const walkHelpers = [WALK_HELPERS, ...walkHelperAliases(source)].join("|");
	const SHAPES = shapesFor(walkHelpers);
	const ANY_WALK = anyWalkFor(walkHelpers);
	return (
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
	"tests/config/knip-entry-coverage.test.ts":
		"reads one production file as an input fixture for behavior assertions, not a production population scan",
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
	"tests/config/win32-gate-lane.test.ts":
		"walks the tests/ tree, not the production source population; out of the production tree-scanner registry",
	"tests/host-sdk-type-only.test.ts":
		"governance sweep over a specific production module or target that import resolution already selects; not a broad production-population scanner",
	"tests/real-harness/fixture-shape.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
	"tests/scripts/pre-push-targeted-tests.test.ts":
		"enumerates a production path for behavior/fixture assertions, not a production population scan",
};

/** The scanner population discovered on this tree, repo-relative and sorted. */
export function discoveredTreeScanners(): string[] {
	const walked = listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(ROOT, file) !== SELF);
	// readWalkedFiles, not readFileSync: a path that vanished between the walk
	// and the read is out of the population, not a finding (#3082).
	return readWalkedFiles(walked)
		.filter(({ source }) => isTreeScannerCandidate(source))
		.map(({ file }) => relativePosix(ROOT, file))
		.sort();
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
			// scanner reds. Not seen: a helper renamed through a dynamic `import()`
			// or `require`, which no test in this tree uses.
			expect(expectedRegistry).toEqual(
				[...TREE_SCANNING_GOVERNANCE_TESTS].sort(),
			);
			expect(new Set(TREE_SCANNING_GOVERNANCE_TESTS).size).toBe(
				TREE_SCANNING_GOVERNANCE_TESTS.length,
			);

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
			"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
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
