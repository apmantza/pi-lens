/**
 * Test Runner Client for pi-lens
 *
 * Detects test files and runs them on write/edit to provide
 * immediate test feedback to the AI agent.
 *
 * Supports: vitest, jest, pytest, go, cargo, dotnet, gradle, maven, rspec,
 * minitest, phpunit, mix (extensible to more)
 *
 * Design: File-level targeted testing — only runs tests for the
 * specific file being edited, not the entire suite.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { emitBounded } from "./bounded-telemetry.js";
import { LEDGER_FIELD_MAX } from "./degradation-ledger.js";
import { minimatch } from "./deps/minimatch.js";
import { createSubsystemLogger } from "./extension-log.js";
import { detectFileRole } from "./file-role.js";
import { findGlobalBinary } from "./package-manager.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { normalizeEphemeralMapKey, normalizeMapKey } from "./path-utils.js";
import { isMeasuredDuration, toMeasuredDurationMs } from "./run-duration.js";
import { safeSpawn, safeSpawnAsync } from "./safe-spawn.js";
import { stripAnsi } from "./sanitize.js";

// --- Types ---

export interface TestResult {
	file: string; // test file that was run
	sourceFile: string; // the file the agent edited
	runner: string; // "vitest", "jest", "pytest"
	passed: number;
	failed: number;
	skipped: number;
	failures: TestFailure[];
	/**
	 * #1479: elapsed run time in ms, or `undefined` when this run was not
	 * measured at all.
	 *
	 * The two states are different facts and a reader must be able to tell
	 * them apart. A present `0` is a MEASUREMENT — pytest really does print
	 * `in 0.00s`, and a suite whose `startTime` equals its `endTime` really did
	 * run in under a millisecond. `undefined` means no runner-reported figure
	 * was found: no suite timestamps in the payload, an unrecognised summary
	 * line, a runner error, or nothing run at all.
	 *
	 * Producers must not substitute `0` for "did not measure". That is the
	 * defect #1452 removed from the JSON path and #1479 removes from the log.
	 *
	 * #1480: `run-duration.ts` holds this contract in executable form.
	 * `toMeasuredDurationMs` normalises a freshly parsed figure into it,
	 * `isMeasuredDuration` tests it, and `formatRunDurationMs` renders it, so
	 * a reader does not have to find this comment to get the rule right.
	 */
	duration?: number; // ms; absent = not measured
	error?: string; // if runner itself failed
}

export interface TestFailure {
	name: string; // test name
	message: string; // failure message
	location?: string; // "file.ts:42"
	stack?: string; // abbreviated stack trace
}

// Runner detection: config file → runner name
export interface RunnerConfig {
	configFiles: string[];
	command: string;
	// Name of the binary in node_modules/.bin (and every package manager's
	// global bin dir) — defaults to the runner key. Must match the ACTUAL
	// binary name resolution looks for (e.g. rspec's real binary is "bundle",
	// not "rspec" — see the rspec entry below), because `stripWrapperArgs`
	// only drops args()'s leading element(s) when they match this name (see
	// its doc comment for the exact wrapper-convention rule it applies).
	binName?: string;
	args: (testFile: string, cwd: string) => string[];
	parseJson: boolean;
}

// Source file → test file patterns (reverse lookup)
const SOURCE_TO_TEST_PATTERNS: Array<{
	ext: string;
	testExts: string[];
	dirs: string[];
}> = [
	{
		ext: ".ts",
		testExts: [".test.ts", ".spec.ts"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".tsx",
		testExts: [".test.tsx", ".spec.tsx"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".js",
		testExts: [".test.js", ".spec.js"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".jsx",
		testExts: [".test.jsx", ".spec.jsx"],
		dirs: ["__tests__", "tests", ".", "__tests__"],
	},
	{
		ext: ".py",
		testExts: ["test_*.py", "*_test.py"],
		dirs: ["tests", "test", ".", "."],
	},
	{ ext: ".go", testExts: ["_test.go"], dirs: [".", ".", ".", "."] }, // Go tests are co-located
	{ ext: ".rs", testExts: [".rs"], dirs: ["tests", "tests", "src", "."] }, // Rust: tests/ or #[test] in src
	// PHPUnit convention: tests/ mirrors src/ with ClassNameTest.php naming
	// (e.g. src/Foo/Bar.php -> tests/Foo/BarTest.php). Basename is already the
	// class name (PHP files are named after their class), so no case transform
	// is needed — the mirrored-directory search below handles the tests/ root.
	{ ext: ".php", testExts: ["Test.php"], dirs: ["tests"] },
	// ExUnit convention: test/ mirrors lib/ with a _test.exs suffix on the same
	// basename (e.g. lib/accounts/user.ex -> test/accounts/user_test.exs).
	{ ext: ".ex", testExts: ["_test.exs"], dirs: ["test"] },
];

// Bound for walking up parent directories to find a hoisted node_modules
// (monorepo workspaces) — deep enough for realistic nesting
// (repo/packages/scope/pkg-name), never unbounded to the filesystem root.
const MAX_NODE_MODULES_WALK_UP = 5;

// Bound for recursive descent into a Python test directory when the exact
// same-relative-subdir mirror doesn't match (e.g. tests/unit/ grouping by
// test type rather than mirroring source layout) — capped depth, never an
// unbounded walk of the whole tests tree.
const MAX_PYTEST_RECURSE_DEPTH = 3;

// --- Runner Detection ---

export const RUNNERS: Record<string, RunnerConfig> = {
	vitest: {
		configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
		command: "npx",
		binName: "vitest",
		args: (testFile, _cwd) => [
			"vitest",
			"run",
			testFile,
			"--reporter=json",
			"--passWithNoTests",
		],
		parseJson: true,
	},
	jest: {
		configFiles: [
			"jest.config.ts",
			"jest.config.js",
			"jest.config.json",
			".jestrc.js",
		],
		command: "npx",
		binName: "jest",
		args: (testFile, _cwd) => [
			"jest",
			testFile,
			"--json",
			"--passWithNoTests",
			"--forceExit",
		],
		parseJson: true,
	},
	pytest: {
		configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
		command: "python",
		args: (testFile, _cwd) => ["-m", "pytest", testFile, "--tb=short", "-q"],
		parseJson: false, // pytest JSON requires plugin, use text parsing
	},
	go: {
		configFiles: ["go.mod"],
		command: "go",
		args: (testFile, cwd) => {
			// Convert file path to package path
			const relPath = path.relative(cwd, testFile);
			const pkgDir = path.dirname(relPath);
			return ["test", `-run`, ".", `./${pkgDir === "." ? "." : pkgDir}`];
		},
		parseJson: false, // Go test output is text-based
	},
	cargo: {
		configFiles: ["Cargo.toml"],
		command: "cargo",
		args: (_testFile, _cwd) => ["test", "--no-fail-fast"],
		parseJson: false, // cargo test output is text-based
	},
	dotnet: {
		configFiles: ["*.csproj", "*.sln"],
		command: "dotnet",
		args: (_testFile, _cwd) => ["test", "--no-build"],
		parseJson: false,
	},
	gradle: {
		configFiles: ["build.gradle", "build.gradle.kts", "settings.gradle"],
		command: process.platform === "win32" ? "gradlew.bat" : "./gradlew",
		args: (_testFile, _cwd) => ["test", "--no-daemon"],
		parseJson: false,
	},
	maven: {
		configFiles: ["pom.xml"],
		command: "mvn",
		args: (_testFile, _cwd) => ["test", "-q"],
		parseJson: false,
	},
	rspec: {
		configFiles: [".rspec", "spec/spec_helper.rb"],
		command: "bundle",
		// The real binary is "bundle" (the command runs `bundle exec rspec
		// <file>`), NOT "rspec" — without this, binName defaulted to the
		// runner key "rspec" and local/global resolution looked for the wrong
		// binary name (#1098).
		binName: "bundle",
		args: (testFile, _cwd) => ["exec", "rspec", testFile],
		parseJson: false,
	},
	minitest: {
		configFiles: ["Gemfile"],
		command: "ruby",
		args: (testFile, _cwd) => ["-Itest", testFile],
		parseJson: false,
	},
	phpunit: {
		// phpunit.xml(.dist) is the strong signal; composer.json is checked for
		// a require-dev dependency on phpunit/phpunit (see the special case in
		// detectRunner's Priority-1 loop, mirroring the pytest/pyproject.toml
		// handling above).
		configFiles: ["phpunit.xml", "phpunit.xml.dist", "composer.json"],
		command: "phpunit",
		args: (testFile, _cwd) => [testFile],
		parseJson: false, // PHPUnit's default CLI output is text-based
	},
	mix: {
		configFiles: ["mix.exs"],
		command: "mix",
		args: (testFile, _cwd) => ["test", testFile],
		parseJson: false, // mix test's default output is text-based
	},
};

/**
 * Drop the leading arg(s) of a runner's args() that merely NAME the binary
 * being invoked (the npx-wrapper convention: `npx vitest run …` → once
 * `vitest` becomes the resolved command itself, the leading "vitest" arg is
 * redundant). This must NOT strip a real subcommand.
 *
 * Two wrapper shapes are recognized:
 *   - `[binName, ...rest]` (vitest/jest-style: `npx <bin> ...`) → drop 1.
 *   - `["-m", binName, ...rest]` (pytest-style: `python -m <bin> ...`) → drop 2.
 * Anything else (cargo's `["test", "--no-fail-fast"]`, go's
 * `["test", "-run", …]`, rspec's `["exec", "rspec", file]` once binName is
 * "bundle", etc.) is a real subcommand/argv and is returned unchanged (#1098).
 */
export function stripWrapperArgs(binName: string, args: string[]): string[] {
	if (args[0] === binName) return args.slice(1);
	if (args[0] === "-m" && args[1] === binName) return args.slice(2);
	return args;
}

// --- Client ---

const MAX_FAILED_TARGETS_PER_RUNNER = 32;
const MAX_FAILED_TARGET_CHECKS_PER_SELECTION = 8;
const FAILED_TARGET_DETAIL_CAP_PER_TURN = 8;

interface TestRunnerClientOptions {
	statFailedTarget?: (filePath: string) => void;
}

interface TestRunRequest {
	runner: string;
	config: RunnerConfig;
	turnIndex?: number;
}

interface FailedTargetStateRecord {
	outcome: "retired-missing" | "retained-indeterminate" | "capacity-evicted";
	runner: string;
	candidate: string;
	errorCode?: string;
	turnIndex?: number;
}

interface FailedTargetEntry {
	displayPath: string;
	sequence: number;
}

interface FailedTargetSelection {
	cwd: string;
	runner: string;
	failedTargets: PathKeyedMap<FailedTargetEntry>;
	relatedAbs?: string;
	selfAbs?: string;
	turnIndex?: number;
}

interface TestResultRecord {
	cwd: string;
	runner: string;
	testFile: string;
	result: TestResult;
	turnIndex?: number;
}

function canonicalFailedPath(filePath: string): string {
	const absolute = path.resolve(filePath);
	try {
		return normalizeMapKey(fs.realpathSync.native(absolute));
	} catch {
		return normalizeMapKey(absolute);
	}
}

function canonicalProjectRoot(cwd: string): {
	key: string;
	resolved: boolean;
} {
	const absolute = path.resolve(cwd);
	try {
		return {
			key: normalizeEphemeralMapKey(fs.realpathSync.native(absolute)),
			resolved: true,
		};
	} catch {
		return { key: normalizeEphemeralMapKey(absolute), resolved: false };
	}
}

const MAX_CANONICAL_ROOT_MEMO_ENTRIES = 512;

interface RunnerAvailability {
	available: boolean;
	evidencePath?: string;
}

function filesystemErrorCode(error: unknown): string | undefined {
	if (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return undefined;
}

interface PytestSummary {
	passed: number;
	failed: number;
	skipped: number;
	duration?: number;
}

const PYTEST_SUMMARY_OUTCOME =
	"(?:passed|failed|skipped|reruns?|errors?|warnings?|deselected|xfailed|xpassed)";
const PYTEST_SUMMARY_LINE = new RegExp(
	`^\\s*(?:=+\\s*)?\\d+\\s+${PYTEST_SUMMARY_OUTCOME}` +
		`(?:\\s*,\\s*\\d+\\s+${PYTEST_SUMMARY_OUTCOME})*` +
		`\\s+in\\s+[\\d.]+s(?:\\s*=+)?\\s*$`,
	"i",
);

/** Extract aggregate values from pytest's final outcome line only. */
function parsePytestSummary(output: string): PytestSummary {
	// Pytest may color the whole summary or individual tokens. Strip ANSI before
	// selecting and extracting so formatting cannot turn the first count into 0.
	const normalizedOutput = stripAnsi(output);
	const summaryLine = normalizedOutput
		.split(/\r?\n/)
		.reverse()
		.find((line) => PYTEST_SUMMARY_LINE.test(line));
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	if (!summaryLine) return { passed, failed, skipped };

	const summaryBody = summaryLine.replace(/^=+\s*|\s*=+\s*$/g, "");
	for (const field of summaryBody.split(",")) {
		const [countText, outcome] = field.trim().split(/\s+/, 2);
		const count = Number.parseInt(countText, 10);
		if (!Number.isFinite(count)) continue;
		switch (outcome) {
			case "passed":
				passed = count;
				break;
			case "failed":
				failed = count;
				break;
			case "skipped":
				skipped = count;
				break;
		}
	}

	const durationMatch = /in\s+([\d.]+)s/.exec(summaryLine);
	// Rounded, like `jsonRunDurationMs` and PHPUnit's legacy path:
	// `in 2.01s` is 2009.9999999999998 in binary floating point.
	const duration = durationMatch
		? Math.round(Number.parseFloat(durationMatch[1]) * 1000)
		: undefined;
	return { passed, failed, skipped, duration };
}

export class TestRunnerClient {
	private log: (msg: string) => void;
	// This is an instance-lifetime memo of RESOLVED spellings only, which leaves
	// two temporal edges. A symlink retargeted mid-session keeps its old
	// resolution until a new client instance — acceptable because round 2's
	// evidence re-validation already handles verdict-level staleness (positive
	// verdicts re-stat their config file). A spelling that did NOT resolve is
	// never memoized (#2077): the fallback key is a guess about a path that does
	// not exist yet, so memoizing it would pin an alias probed before its
	// symlink was created to a stale verdict for the instance's life. Re-probing
	// costs one failing realpath per call, and only for a cwd that does not
	// resolve — a state where `detectRunner` already walks node_modules on every
	// call. Keep the memo bounded so pathological spelling churn cannot grow it
	// without limit.
	private canonicalRootMemo = new Map<string, string>();
	private availableRunners = new PathKeyedMap<Map<string, RunnerAvailability>>(
		normalizeEphemeralMapKey,
	);
	private failedTestsByRunner = new Map<
		string,
		PathKeyedMap<PathKeyedMap<FailedTargetEntry>>
	>();
	private failedTargetSequence = 0;
	private readonly statFailedTarget: (filePath: string) => void;
	// Best-effort vitest config `test.include`/`test.exclude` globs, scraped as
	// plain text (never executed) and cached per cwd so the config file is
	// only read/parsed once, not on every edit. `null` means "no config found
	// or it couldn't be parsed in the simple shape we look for" — callers
	// treat that as "no additional signal" and fall back to naming-convention
	// detection only.
	private vitestTestGlobsCache = new PathKeyedMap<{
		result: { include?: string[]; exclude?: string[] } | null;
		/**
		 * #2252 F2: the config file `result` was derived from, present whether
		 * or not it parsed. `undefined` means no candidate config file existed
		 * at cache time. Re-checked on every read — same shape as
		 * `getRunnerAvailability`'s `evidencePath`: a `result: null` entry is
		 * revalidated by `fs.existsSync`, not trusted forever, so a config file
		 * that appears (or a broken one that gets fixed) converges instead of
		 * latching the earlier miss.
		 */
		evidencePath?: string;
	}>(normalizeEphemeralMapKey);

	constructor(verbose = false, options: TestRunnerClientOptions = {}) {
		this.log = verbose ? createSubsystemLogger("test-runner") : () => {};
		this.statFailedTarget =
			options.statFailedTarget ?? ((filePath) => void fs.statSync(filePath));
	}

	private getCanonicalProjectRoot(cwd: string): string {
		const cached = this.canonicalRootMemo.get(cwd);
		if (cached !== undefined) return cached;

		const { key, resolved } = canonicalProjectRoot(cwd);
		if (!resolved) return key;
		if (this.canonicalRootMemo.size >= MAX_CANONICAL_ROOT_MEMO_ENTRIES) {
			const oldest = this.canonicalRootMemo.keys().next().value;
			if (oldest !== undefined) this.canonicalRootMemo.delete(oldest);
		}
		this.canonicalRootMemo.set(cwd, key);
		return key;
	}

	private getRunnerAvailability(
		byRunner: Map<string, RunnerAvailability> | undefined,
		runner: string,
	): boolean | undefined {
		const cached = byRunner?.get(runner);
		if (!cached) return undefined;
		if (
			cached.available &&
			cached.evidencePath !== undefined &&
			!fs.existsSync(cached.evidencePath)
		) {
			byRunner?.delete(runner);
			return undefined;
		}
		return cached.available;
	}

	/**
	 * #2252: only a POSITIVE verdict is memoized. A negative one has no
	 * `evidencePath` to re-stat, so `getRunnerAvailability` had no way to tell
	 * "still absent" from "a config file just appeared" and served the first
	 * miss for the client's whole process lifetime — measured live: probe an
	 * empty directory, add `vitest.config.ts`, and the SAME client kept
	 * answering "no runner". Same precedent as #2242's alias-canonicalization
	 * fix (`clients/test-runner-client.ts`'s `getCanonicalProjectRoot`): drop
	 * the memo write on the failure branch rather than adding a TTL or a
	 * re-arm signal. The cost is bounded and already paid today — a cache miss
	 * re-runs the exact same `configFiles.some(fs.existsSync)` walk this
	 * method's caller already does on every FIRST probe of a runner.
	 */
	private setRunnerAvailability(
		byRunner: Map<string, RunnerAvailability>,
		runner: string,
		available: boolean,
		evidencePath?: string,
	): void {
		if (!available) return;
		byRunner.set(runner, { available, evidencePath });
	}

	/**
	 * Check if a test runner is available in the project
	 * Detection order:
	 * 1. Config files (vitest.config.ts, jest.config.js, etc.)
	 * 2. package.json dependencies
	 * 3. node_modules presence
	 */
	detectRunner(
		cwd: string,
		sourceFilePath?: string,
	): { runner: string; config: RunnerConfig } | null {
		const rootKey = this.getCanonicalProjectRoot(cwd);
		let byRunner = this.availableRunners.get(rootKey);
		if (!byRunner) {
			byRunner = new Map();
			this.availableRunners.set(rootKey, byRunner);
		}
		// Priority 1: Config files
		for (const [name, config] of Object.entries(RUNNERS)) {
			const cached = this.getRunnerAvailability(byRunner, name);
			if (cached !== undefined) {
				if (cached) {
					return { runner: name, config };
				}
				continue;
			}

			let configEvidencePath: string | undefined;
			const found = config.configFiles.some((cf) => {
				if (name === "pytest" && cf === "pyproject.toml") {
					const pyprojectPath = path.join(cwd, cf);
					if (!fs.existsSync(pyprojectPath)) return false;
					try {
						const pyproject = fs.readFileSync(pyprojectPath, "utf-8");
						const matches = pyproject.includes("[tool.pytest.ini_options]");
						if (matches) configEvidencePath = pyprojectPath;
						return matches;
					} catch {
						return false;
					}
				}
				if (name === "phpunit" && cf === "composer.json") {
					const composerPath = path.join(cwd, cf);
					if (!fs.existsSync(composerPath)) return false;
					try {
						const composer = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
						const allDeps = {
							...composer.require,
							...composer["require-dev"],
						};
						const matches = Boolean(allDeps["phpunit/phpunit"]);
						if (matches) configEvidencePath = composerPath;
						return matches;
					} catch {
						return false;
					}
				}
				const candidate = path.join(cwd, cf);
				const matches = fs.existsSync(candidate);
				if (matches) configEvidencePath = candidate;
				return matches;
			});

			this.setRunnerAvailability(byRunner, name, found, configEvidencePath);
			if (found) {
				this.log(`Detected runner via config: ${name}`);
				return { runner: name, config };
			}
		}

		const packageJsonPath = path.join(cwd, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			const allDeps = {
				...pkg.dependencies,
				...pkg.devDependencies,
			};

			// Check for vitest first (more specific than jest)
			if (allDeps.vitest) {
				this.log("Detected vitest in package.json");
				this.setRunnerAvailability(byRunner, "vitest", true, packageJsonPath);
				return { runner: "vitest", config: RUNNERS.vitest };
			}
			if (allDeps.jest) {
				this.log("Detected jest in package.json");
				this.setRunnerAvailability(byRunner, "jest", true, packageJsonPath);
				return { runner: "jest", config: RUNNERS.jest };
			}
			if (allDeps.pytest || allDeps["pytest-cov"]) {
				this.log("Detected pytest in package.json (unusual)");
				this.setRunnerAvailability(byRunner, "pytest", true, packageJsonPath);
				return { runner: "pytest", config: RUNNERS.pytest };
			}
		} catch (err) {
			void err;
			// package.json parse error or file not found
		}

		// Priority 3: Check node_modules for installed packages, including a
		// hoisted monorepo layout where cwd is a workspace package (e.g.
		// packages/foo) but the runner only lives in node_modules at the
		// workspace root (npm/yarn/pnpm workspace hoisting). Walk up a
		// bounded number of parent directories looking for a node_modules
		// containing the package — never an unbounded walk to the
		// filesystem root.
		const hoistedVitest = this.findHoistedNodeModulesPackage(cwd, "vitest");
		if (hoistedVitest) {
			this.log(`Detected vitest in node_modules (${hoistedVitest})`);
			return { runner: "vitest", config: RUNNERS.vitest };
		}
		const hoistedJest = this.findHoistedNodeModulesPackage(cwd, "jest");
		if (hoistedJest) {
			this.log(`Detected jest in node_modules (${hoistedJest})`);
			return { runner: "jest", config: RUNNERS.jest };
		}

		for (const name of ["go", "cargo", "dotnet", "gradle", "maven"]) {
			const config = RUNNERS[name];
			const found = config.configFiles.some((cf) => {
				// Handle glob patterns like *.csproj
				if (cf.includes("*")) {
					try {
						const files = fs.readdirSync(cwd);
						return files.some((f) =>
							new RegExp(cf.replace(/\*/g, ".*")).test(f),
						);
					} catch {
						return false;
					}
				}
				return fs.existsSync(path.join(cwd, cf));
			});
			if (found) {
				this.log(`Detected ${name} from config file`);
				return { runner: name, config };
			}
		}

		// Priority 5: Check if pytest is available globally (Python files only)
		const isPythonSource =
			typeof sourceFilePath === "string" && sourceFilePath.endsWith(".py");
		if (!isPythonSource) return null;

		try {
			const whichCmd = process.platform === "win32" ? "where" : "which";
			const result = safeSpawn(whichCmd, ["pytest"], {
				timeout: 2000,
			});
			if (result.status === 0) {
				this.log("Detected pytest globally");
				return { runner: "pytest", config: RUNNERS.pytest };
			}
		} catch (err) {
			void err;
		}

		return null;
	}

	/**
	 * Walk up from `cwd` through parent directories looking for a
	 * `node_modules/<packageName>` — handles monorepo workspace hoisting
	 * (npm/yarn/pnpm), where a workspace package's own `node_modules` may
	 * not exist at all, with dependencies hoisted to the workspace root
	 * several directories up. Bounded by `MAX_NODE_MODULES_WALK_UP` levels
	 * and stops at the filesystem root — never an unbounded walk.
	 * Returns the `node_modules` directory where the package was found, or
	 * null if not found within the bound.
	 */
	private findHoistedNodeModulesPackage(
		cwd: string,
		packageName: string,
	): string | null {
		let dir = path.resolve(cwd);
		for (let level = 0; level <= MAX_NODE_MODULES_WALK_UP; level++) {
			const nodeModulesPath = path.join(dir, "node_modules");
			if (fs.existsSync(path.join(nodeModulesPath, packageName))) {
				return nodeModulesPath;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break; // reached filesystem root
			dir = parent;
		}
		return null;
	}

	/**
	 * Depth-bounded breadth-first search under `rootDir` for a pytest-style
	 * test file matching `pattern` (exact, e.g. `test_foo.py`) or the
	 * looser `test_*<basename>*.py` convention. Used as a last-resort
	 * fallback when a Python test suite groups tests by kind
	 * (`tests/unit/`, `tests/integration/`) instead of mirroring the
	 * source directory layout, so the exact-mirror candidates in
	 * `findTestFile` don't match. Bounded by `maxDepth` levels below
	 * `rootDir` and skips hidden directories and `__pycache__` — never an
	 * unbounded walk of the whole tests tree.
	 */
	private findPytestMatchRecursive(
		rootDir: string,
		pattern: string,
		basename: string,
		maxDepth: number,
	): string | null {
		const queue: Array<{ dir: string; depth: number }> = [
			{ dir: rootDir, depth: 0 },
		];

		while (queue.length > 0) {
			const next = queue.shift();
			if (!next) break;
			const { dir, depth } = next;

			let entries: import("node:fs").Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isFile()) {
					if (
						entry.name === pattern ||
						(entry.name.startsWith("test_") &&
							entry.name.endsWith(".py") &&
							entry.name.includes(basename))
					) {
						return fullPath;
					}
				} else if (entry.isDirectory() && depth < maxDepth) {
					if (entry.name === "__pycache__" || entry.name.startsWith("."))
						continue;
					queue.push({ dir: fullPath, depth: depth + 1 });
				}
			}
		}

		return null;
	}

	/**
	 * Path of `dir` relative to `cwd`, using forward slashes, or null if `dir`
	 * is not inside `cwd` (e.g. resolves to `..` or an absolute path).
	 * Used to compute a mirrored test-tree subdirectory (e.g. `clients` for
	 * `clients/knip-client.ts`, so `tests/clients/knip-client.test.ts` is
	 * checked alongside the flat `tests/knip-client.test.ts` candidate).
	 */
	private relativeSourceDir(
		sourceFilePath: string,
		cwd: string,
	): string | null {
		const dir = path.dirname(sourceFilePath);
		const relDir = path.relative(cwd, path.resolve(cwd, dir));
		if (
			!relDir ||
			relDir === "." ||
			relDir.startsWith("..") ||
			path.isAbsolute(relDir)
		) {
			return null;
		}
		return relDir;
	}

	/**
	 * Best-effort, text-only scrape of a vitest config's `test.include` /
	 * `test.exclude` arrays. This deliberately does NOT execute the config
	 * file (that would mean loading arbitrary ESM/TS via Vite's config
	 * loader — too heavy for a per-edit hot path). It just looks for a
	 * simple `include: [ ... ]` / `exclude: [ ... ]` shape with string
	 * literals inside and pulls those out with a regex.
	 *
	 * Returns `null` (never throws) when there's no vitest config file, it
	 * can't be read, or the include/exclude shape isn't a plain array of
	 * string literals (e.g. it's built from a function call, spread, or
	 * template expression) — anything more dynamic than that is out of
	 * scope for this heuristic.
	 *
	 * Cached per `cwd`, including a `null` result — #2252 F2: a project with
	 * no vitest config, or one this heuristic can't scrape, is a COMMON shape
	 * (every non-vitest project pays this on every edit otherwise; measured
	 * ~1500x — 0.4µs cached vs. 598.7µs re-reading the candidate list every
	 * call). The cache entry is revalidated on every read, the same shape
	 * `getRunnerAvailability` uses for a positive verdict: bounded
	 * `fs.existsSync` checks against the config file the result was derived
	 * from (or, when none existed, against the candidate list itself), never
	 * a full re-read/re-parse on a cache hit. So a config file appearing (or
	 * a broken one being fixed) still converges — only the FULL parse is
	 * paid once, not the existence check.
	 */
	parseVitestTestGlobs(
		cwd: string,
	): { include?: string[]; exclude?: string[] } | null {
		const rootKey = this.getCanonicalProjectRoot(cwd);
		// .mts isn't in RUNNERS.vitest.configFiles (that list drives runner
		// *detection* priority) but is a legal vitest config extension, so it's
		// included here for the scrape even though detectRunner doesn't check it.
		const candidates = [...RUNNERS.vitest.configFiles, "vitest.config.mts"];

		const cached = this.vitestTestGlobsCache.get(rootKey);
		if (cached !== undefined) {
			const stillValid =
				cached.evidencePath !== undefined
					? fs.existsSync(cached.evidencePath)
					: !candidates.some((cf) => fs.existsSync(path.join(cwd, cf)));
			if (stillValid) return cached.result;
			this.vitestTestGlobsCache.delete(rootKey);
		}

		let content: string | null = null;
		let foundPath: string | undefined;
		for (const cf of candidates) {
			const candidatePath = path.join(cwd, cf);
			try {
				content = fs.readFileSync(candidatePath, "utf-8");
				foundPath = candidatePath;
				break;
			} catch {
				continue;
			}
		}

		let result: { include?: string[]; exclude?: string[] } | null = null;
		if (content !== null) {
			const include = this.extractGlobArrayLiteral(content, "include");
			const exclude = this.extractGlobArrayLiteral(content, "exclude");
			if (include || exclude) {
				result = {};
				if (include) result.include = include;
				if (exclude) result.exclude = exclude;
			}
		}

		this.vitestTestGlobsCache.set(rootKey, { result, evidencePath: foundPath });
		return result;
	}

	/**
	 * Extract `<key>: [ 'a', "b", `c` ]` as a plain string array from raw
	 * config text. Returns undefined if the key isn't present, or if the
	 * array body contains anything besides string literals and commas/
	 * whitespace (a function call, spread, variable reference, etc.) —
	 * that's a sign the value is dynamic and this best-effort scrape can't
	 * safely interpret it.
	 */
	private extractGlobArrayLiteral(
		content: string,
		key: string,
	): string[] | undefined {
		const arrayMatch = content.match(
			new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`),
		);
		if (!arrayMatch) return undefined;

		const body = arrayMatch[1];
		const literalPattern = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g;
		const literals: string[] = [];
		let lastEnd = 0;
		let match: RegExpExecArray | null;
		while ((match = literalPattern.exec(body)) !== null) {
			const between = body.slice(lastEnd, match.index).trim();
			// Only whitespace/commas may appear between literals — anything
			// else (identifiers, parens, spreads) means the array isn't a
			// plain list of string literals.
			if (between !== "" && !/^,$/.test(between)) return undefined;
			literals.push(match[1] ?? match[2] ?? match[3] ?? "");
			lastEnd = literalPattern.lastIndex;
		}
		const trailing = body.slice(lastEnd).trim();
		if (trailing !== "" && trailing !== ",") return undefined;

		return literals.length > 0 ? literals : undefined;
	}

	/**
	 * Whether `sourceFilePath` is itself a test file (as opposed to a source
	 * file whose *related* test file needs to be discovered).
	 *
	 * Primary signal: `detectFileRole` (naming convention: `.test.`/`.spec.`
	 * basenames, `test_`/`spec_` prefixes, `__tests__/`/`tests/`/`spec/`
	 * directories — shared with the rest of the codebase, not a second
	 * parallel detector).
	 *
	 * Secondary signal (vitest only): the project's own `test.include` /
	 * `test.exclude` globs, best-effort scraped by `parseVitestTestGlobs`.
	 * This can correct the naming-convention answer in both directions —
	 * an `exclude` glob can rule out a path that looks like a test by name,
	 * and an `include` glob can catch a project that puts tests somewhere
	 * unconventional. When no config is found or it can't be parsed, this
	 * is a no-op and behavior is unchanged.
	 *
	 * #628: a positive `include` override is only trusted when the glob is a
	 * *narrow* test signal (see `isNarrowTestGlob`) — a bare "any file with
	 * this extension" include (e.g. `src/**\/*.ts`) is common in real vitest
	 * configs and matches ordinary source files, so treating any match as
	 * "this is a test" produced vacuous `0p/0f` self-runs on plain source
	 * files (background-review.ts, index.ts, …). The `exclude` direction is
	 * left as a plain match: over-excluding only causes discovery to run on a
	 * file that's actually a test (falls back to `findTestFile`, not a false
	 * "self" positive), which is the safe failure mode.
	 */
	private isTestFile(
		sourceFilePath: string,
		cwd: string,
		runner: string,
	): boolean {
		let result = detectFileRole(sourceFilePath) === "test";

		if (runner === "vitest") {
			const globs = this.parseVitestTestGlobs(cwd);
			if (globs) {
				const rel = path
					.relative(cwd, path.resolve(cwd, sourceFilePath))
					.replace(/\\/g, "/");
				const matches = (
					globs_: string[] | undefined,
					filter?: (g: string) => boolean,
				) =>
					!!globs_?.some(
						(g) => (!filter || filter(g)) && minimatch(rel, g, { dot: true }),
					);

				if (matches(globs.exclude)) {
					result = false;
				} else if (
					!result &&
					matches(globs.include, (g) => this.isNarrowTestGlob(g))
				) {
					result = true;
				}
			}
		}

		return result;
	}

	/**
	 * Whether an `include` glob is a specific enough signal to override a
	 * plain "this is source, not a test" naming-convention verdict (#628).
	 *
	 * Trusted when either:
	 *  - a literal (non-wildcard) path segment before the first wildcard
	 *    names a conventional test location (`tests/`, `test/`, `spec/`,
	 *    `specs/`, `__tests__/`) — the real case this override exists for:
	 *    a project whose test files live in such a directory without a
	 *    `.test.`/`.spec.` name (e.g. `tests/**\/*.ts`).
	 *  - the static suffix after the last wildcard encodes more than the
	 *    bare language extension (e.g. `.check.ts`, `.flow.ts`) — an explicit
	 *    project-specific naming convention, not "any file with this
	 *    extension" (e.g. `**\/*.check.ts`).
	 *
	 * Rejected for a bare extension glob with no test-ish directory (e.g.
	 * `src/**\/*.ts`, `**\/*.ts`) — that shape matches every source file in
	 * the tree and is exactly what produced vacuous self-runs in practice.
	 */
	private isNarrowTestGlob(glob: string): boolean {
		const testDirPattern = /^(tests?|specs?|__tests__)$/i;
		for (const segment of glob.split("/")) {
			if (segment.includes("*") || segment.includes("?")) break;
			if (testDirPattern.test(segment)) return true;
		}

		const lastWildcard = Math.max(glob.lastIndexOf("*"), glob.lastIndexOf("?"));
		const suffix = lastWildcard >= 0 ? glob.slice(lastWildcard + 1) : glob;
		const dotSegments = suffix.split(".").filter(Boolean);
		return dotSegments.length >= 2;
	}

	/**
	 * Find test file for a given source file
	 * Returns the test file path if it exists, null otherwise
	 */
	findTestFile(
		sourceFilePath: string,
		cwd: string,
		runnerOverride?: string,
	): { testFile: string; runner: string } | null {
		const ext = path.extname(sourceFilePath);
		const basename = path.basename(sourceFilePath, ext);
		const dir = path.dirname(sourceFilePath);
		const patterns = SOURCE_TO_TEST_PATTERNS.find((p) => p.ext === ext);
		if (!patterns) return null;

		const detected = runnerOverride
			? { runner: runnerOverride, config: RUNNERS[runnerOverride] }
			: this.detectRunner(cwd, sourceFilePath);
		if (!detected) return null;

		// Relative subdirectory of the source file, used to check a mirrored
		// test-tree layout (tests/<same-subdir>/<basename><testExt>), on top of
		// the flat tests/<basename><testExt> layout already checked below.
		// Null when the source file sits at the project root (dir === ".") or
		// falls outside cwd — in that case there is no subdir to mirror.
		const relDir = this.relativeSourceDir(sourceFilePath, cwd);

		// Check each potential test file location
		for (let i = 0; i < patterns.testExts.length; i++) {
			const testExt = patterns.testExts[i];
			const testDir = patterns.dirs[i];

			// Handle glob patterns (pytest style: test_*.py)
			if (testExt.includes("*")) {
				const pattern = testExt.replace(/\*/g, basename);
				const searchDirs =
					testDir === "."
						? [dir]
						: relDir
							? [path.join(cwd, testDir, relDir), path.join(cwd, testDir)]
							: [path.join(cwd, testDir)];

				for (const searchDir of searchDirs) {
					let files;
					try {
						files = fs.readdirSync(searchDir);
					} catch (err) {
						void err;
						continue;
					}

					const match = files.find(
						(f) =>
							f === pattern ||
							(f.startsWith("test_") &&
								f.endsWith(".py") &&
								f.includes(basename)),
					);
					if (match) {
						const testPath = path.join(searchDir, match);
						this.log(`Found test file: ${testPath}`);
						return { testFile: testPath, runner: detected.runner };
					}
				}

				// None of the exact-mirror candidates matched. Python test
				// suites commonly group tests by kind (tests/unit/,
				// tests/integration/) rather than mirroring the source tree,
				// so do a depth-bounded recursive search under the test
				// root as a last resort before falling back to import
				// scanning — bounded so a large repo can't turn this into
				// an unbounded directory walk.
				if (testDir !== ".") {
					const recursiveMatch = this.findPytestMatchRecursive(
						path.join(cwd, testDir),
						pattern,
						basename,
						MAX_PYTEST_RECURSE_DEPTH,
					);
					if (recursiveMatch) {
						this.log(`Found test file (recursive): ${recursiveMatch}`);
						return { testFile: recursiveMatch, runner: detected.runner };
					}
				}
			} else {
				// Exact pattern match (jest/vitest style)
				const testFilename = basename + testExt;
				const searchPaths = [
					path.join(dir, testFilename), // same directory
					path.join(dir, "__tests__", testFilename), // __tests__ subdirectory
					...(relDir
						? [
								path.join(cwd, "tests", relDir, testFilename), // mirrored tests/<subdir>/
								path.join(cwd, "__tests__", relDir, testFilename), // mirrored __tests__/<subdir>/
							]
						: []),
					path.join(cwd, "tests", testFilename), // top-level tests/
					path.join(cwd, "__tests__", testFilename), // top-level __tests__/
					// PHP/Elixir-style source-root mirroring (e.g. src/Foo/Bar.php ->
					// tests/Foo/BarTest.php, lib/accounts/user.ex ->
					// test/accounts/user_test.exs): strips a conventional source-root
					// segment and mirrors under this pattern's OWN configured test
					// root (testDir), not the hardcoded "tests"/"__tests__" above —
					// ExUnit's root is "test" (singular), which those don't cover.
					...this.sourceRootMirroredCandidates(dir, cwd, testDir, testFilename),
				];

				for (const testPath of searchPaths) {
					if (fs.existsSync(testPath)) {
						this.log(`Found test file: ${testPath}`);
						return { testFile: testPath, runner: detected.runner };
					}
				}
			}
		}

		// Basename lookup found nothing — try import scanning as a fallback.
		const importMatch = this.findTestFileByImport(sourceFilePath, cwd);
		if (importMatch) {
			return { testFile: importMatch, runner: detected.runner };
		}

		return null;
	}

	/**
	 * Select the most useful test target for this edit.
	 *
	 * Strategy:
	 * 1) If there are known failing tests, rerun those first (fast feedback loop).
	 * 2) Otherwise run related tests for the edited file.
	 */
	getTestRunTarget(
		sourceFilePath: string,
		cwd: string,
		turnIndex?: number,
	): {
		testFile: string;
		runner: string;
		config: RunnerConfig;
		strategy: "failed-first" | "related" | "self";
	} | null {
		const detected = this.detectRunner(cwd, sourceFilePath);
		if (!detected) return null;

		const failedSet = this.getFailedTargets(cwd, detected.runner);

		// If the edited file is itself a test file, there's no "related test"
		// to discover — running findTestFile on it would strip its own
		// extension and search for nonsense like foo.test.test.ts. Skip
		// discovery entirely and treat the file as its own target.
		const selfIsTest = this.isTestFile(sourceFilePath, cwd, detected.runner);
		const related = selfIsTest
			? null
			: this.findTestFile(sourceFilePath, cwd, detected.runner);

		if (failedSet && failedSet.size > 0) {
			const failedFirst = this.retireMissingFailedTargets({
				cwd,
				runner: detected.runner,
				failedTargets: failedSet,
				relatedAbs: related ? path.resolve(related.testFile) : undefined,
				selfAbs: selfIsTest ? path.resolve(sourceFilePath) : undefined,
				turnIndex,
			});
			if (failedFirst) {
				return {
					testFile: failedFirst,
					runner: detected.runner,
					config: detected.config,
					strategy: "failed-first",
				};
			}
		}

		if (selfIsTest) {
			return {
				testFile: path.resolve(sourceFilePath),
				runner: detected.runner,
				config: detected.config,
				strategy: "self",
			};
		}

		if (!related) return null;

		return {
			testFile: path.resolve(related.testFile),
			runner: detected.runner,
			config: detected.config,
			strategy: "related",
		};
	}

	/**
	 * Run tests for a specific file without blocking the event loop, so LSP
	 * messages, other file writes, and all async operations continue while
	 * tests run.
	 */
	async runTestFileAsync(
		testFile: string,
		cwd: string,
		runner: string,
		config: RunnerConfig,
	): Promise<TestResult>;
	async runTestFileAsync(
		testFile: string,
		cwd: string,
		request: TestRunRequest,
	): Promise<TestResult>;
	async runTestFileAsync(
		testFile: string,
		cwd: string,
		runnerOrRequest: string | TestRunRequest,
		legacyConfig?: RunnerConfig,
	): Promise<TestResult> {
		const absoluteTestFile = path.resolve(testFile);
		let request: TestRunRequest;
		if (typeof runnerOrRequest === "string") {
			if (!legacyConfig) {
				return this.emptyResult(
					absoluteTestFile,
					"",
					runnerOrRequest,
					"Runner configuration missing",
				);
			}
			request = { runner: runnerOrRequest, config: legacyConfig };
		} else {
			request = runnerOrRequest;
		}
		const { runner, config, turnIndex } = request;
		if (!fs.existsSync(absoluteTestFile)) {
			return this.emptyResult(
				absoluteTestFile,
				"",
				runner,
				"Test file not found",
			);
		}

		try {
			const { command, args } = await this.resolveExec(
				runner,
				config,
				absoluteTestFile,
				cwd,
			);
			this.log(`Running (async): ${command} ${args.join(" ")}`);

			const result = await safeSpawnAsync(command, args, {
				cwd,
				timeout: 60000,
			});

			const stdout = result.stdout || "";
			const stderr = result.stderr || "";

			if (result.error) {
				this.log(`Runner error: ${result.error.message}`);
				return this.emptyResult(
					absoluteTestFile,
					"",
					runner,
					`Runner error: ${result.error.message}`,
				);
			}

			let parsed: TestResult;
			switch (runner) {
				case "vitest":
					parsed = this.parseVitestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "jest":
					parsed = this.parseJestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "pytest":
					parsed = this.parsePytestOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						cwd,
						runner,
					);
					break;
				case "phpunit":
					parsed = this.parsePhpunitOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
				case "mix":
					parsed = this.parseMixTestOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
				default:
					parsed = this.parseGenericRunnerOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						runner,
					);
					break;
			}

			this.recordResult({
				cwd,
				runner,
				testFile: absoluteTestFile,
				result: parsed,
				turnIndex,
			});
			return parsed;
		} catch (err: any) {
			this.log(`Run error: ${err.message}`);
			return this.emptyResult(absoluteTestFile, "", runner, err.message);
		}
	}

	private getFailedTargets(
		cwd: string,
		runner: string,
		create = false,
	): PathKeyedMap<FailedTargetEntry> | undefined {
		let roots = this.failedTestsByRunner.get(runner);
		if (!roots && create) {
			roots = new PathKeyedMap<PathKeyedMap<FailedTargetEntry>>(
				canonicalFailedPath,
			);
			this.failedTestsByRunner.set(runner, roots);
		}
		if (!roots) return undefined;

		const root = canonicalFailedPath(cwd);
		let targets = roots.get(root);
		if (!targets && create) {
			targets = new PathKeyedMap<FailedTargetEntry>(canonicalFailedPath);
			roots.set(root, targets);
		}
		return targets;
	}

	private deleteFailedRoot(cwd: string, runner: string): void {
		const roots = this.failedTestsByRunner.get(runner);
		if (!roots) return;
		roots.delete(canonicalFailedPath(cwd));
		if (roots.size === 0) this.failedTestsByRunner.delete(runner);
	}

	private failedTargetCount(runner: string): number {
		const roots = this.failedTestsByRunner.get(runner);
		if (!roots) return 0;
		let count = 0;
		for (const targets of roots.values()) count += targets.size;
		return count;
	}

	private evictOldestFailedTarget(runner: string): string | undefined {
		const roots = this.failedTestsByRunner.get(runner);
		if (!roots) return undefined;
		let oldest:
			| {
					root: string;
					identity: string;
					entry: FailedTargetEntry;
			  }
			| undefined;
		for (const [root, targets] of roots) {
			for (const [identity, entry] of targets) {
				if (!oldest || entry.sequence < oldest.entry.sequence) {
					oldest = { root, identity, entry };
				}
			}
		}
		if (!oldest) return undefined;

		const targets = roots.get(oldest.root);
		targets?.delete(oldest.identity);
		if (targets?.size === 0) roots.delete(oldest.root);
		if (roots.size === 0) this.failedTestsByRunner.delete(runner);
		return oldest.entry.displayPath;
	}

	private classifyFailedTarget(candidate: string): {
		status: "present" | "missing" | "indeterminate";
		errorCode?: string;
	} {
		try {
			this.statFailedTarget(candidate);
			return { status: "present" };
		} catch (error) {
			const errorCode = filesystemErrorCode(error);
			if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
				return { status: "missing", errorCode };
			}
			return { status: "indeterminate", errorCode };
		}
	}

	private recordFailedTargetState(record: FailedTargetStateRecord): void {
		const { outcome, runner, candidate, errorCode, turnIndex } = record;
		const boundedTarget =
			candidate.length <= LEDGER_FIELD_MAX
				? candidate
				: `…${candidate.slice(1 - LEDGER_FIELD_MAX)}`;
		const targetIdentity = createHash("sha256")
			.update(runner)
			.update("\0")
			.update(candidate)
			.digest("hex");
		const identity = `${outcome}:${targetIdentity}`;
		const payload = {
			durationMs: 0,
			filePath: boundedTarget,
			metadata: {
				outcome,
				runner,
				errorCode: errorCode ?? "unknown",
			},
		};
		const options = {
			ledgerKind: "test-runner-failed-target-state" as const,
			risingEdgePer: "identity" as const,
			reason: `${outcome}: ${boundedTarget}`,
		};
		emitBounded(
			"test_runner_failed_target_state",
			identity,
			payload,
			turnIndex === undefined
				? options
				: {
						...options,
						capPerTurn: {
							limit: FAILED_TARGET_DETAIL_CAP_PER_TURN,
							turnIndex,
						},
					},
		);
	}

	/**
	 * Retire only confirmed-missing failed-first paths, then return one usable
	 * target. A bounded prefix is checked per selection; remaining candidates
	 * carry over to the next selection instead of adding unbounded synchronous
	 * filesystem work to turn_end. Related/self targets keep priority.
	 */
	private retireMissingFailedTargets(
		selection: FailedTargetSelection,
	): string | undefined {
		const { cwd, runner, failedTargets, relatedAbs, selfAbs, turnIndex } =
			selection;
		let checked = 0;
		const inspected = new Set<string>();
		const inspect = (
			identity: string,
			entry: FailedTargetEntry,
		): string | undefined => {
			if (checked >= MAX_FAILED_TARGET_CHECKS_PER_SELECTION) return undefined;
			checked += 1;
			inspected.add(identity);
			const candidate = entry.displayPath;
			const verdict = this.classifyFailedTarget(candidate);
			if (verdict.status === "missing") {
				failedTargets.delete(identity);
				this.recordFailedTargetState({
					outcome: "retired-missing",
					runner,
					candidate,
					errorCode: verdict.errorCode,
					turnIndex,
				});
				return undefined;
			}
			if (verdict.status === "indeterminate") {
				this.recordFailedTargetState({
					outcome: "retained-indeterminate",
					runner,
					candidate,
					errorCode: verdict.errorCode,
					turnIndex,
				});
			}
			return candidate;
		};

		for (const preferred of [relatedAbs, selfAbs]) {
			if (!preferred) continue;
			const identity = canonicalFailedPath(preferred);
			const entry = failedTargets.get(identity);
			if (!entry) continue;
			const selected = inspect(identity, entry);
			if (selected) return selected;
		}

		for (const [identity, entry] of failedTargets) {
			if (inspected.has(identity)) continue;
			if (checked >= MAX_FAILED_TARGET_CHECKS_PER_SELECTION) break;
			const selected = inspect(identity, entry);
			if (selected) return selected;
		}

		if (failedTargets.size === 0) this.deleteFailedRoot(cwd, runner);
		return undefined;
	}

	/**
	 * Check if a source file has corresponding tests (without running them)
	 */
	hasTestFile(sourceFilePath: string, cwd: string): boolean {
		return this.findTestFile(sourceFilePath, cwd) !== null;
	}

	/**
	 * Suggest test files for a list of source files.
	 * Returns deduplicated test file paths with their corresponding source file.
	 */
	suggestTestFiles(
		sourceFiles: string[],
		cwd: string,
	): Array<{ testFile: string; sourceFile: string; runner: string }> {
		const seen = new Set<string>();
		const results: Array<{
			testFile: string;
			sourceFile: string;
			runner: string;
		}> = [];
		for (const sourceFile of sourceFiles) {
			const found = this.findTestFile(sourceFile, cwd);
			if (!found) continue;
			const abs = path.resolve(found.testFile);
			if (seen.has(abs)) continue;
			seen.add(abs);
			results.push({ testFile: abs, sourceFile, runner: found.runner });
		}
		return results;
	}

	// --- Shared JSON test output parser (Vitest + Jest share the same structure) ---

	private parseJsonTestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		interface JsonResult {
			numPassedTests: number;
			numFailedTests: number;
			// #1452: neither reporter emits `numSkippedTests`. Measured against
			// vitest 4.1.10 and jest 30.4.2: a `test.skip` lands in
			// `numPendingTests`, and `test.todo` in `numTodoTests`. Kept in the
			// shape (and still read first) because older reporter versions did
			// emit it and reading a present field costs nothing.
			numSkippedTests?: number;
			numPendingTests?: number;
			numTodoTests?: number;
			testResults?: Array<{
				name: string;
				status: string;
				message?: string;
				// #1452: per-suite wall clock, epoch ms. Present in BOTH reporters
				// (vitest emits `endTime` as a float). NOT `perfStats` — see
				// `jsonRunDurationMs`.
				startTime?: number;
				endTime?: number;
				assertionResults?: Array<{
					status: string;
					title: string;
					duration?: number | null;
					failureMessages?: string[];
					location?: { line: number; column: number };
				}>;
			}>;
		}

		try {
			const json: JsonResult = JSON.parse(stdout);
			const failures: TestFailure[] = [];

			for (const suite of json.testResults || []) {
				if (suite.status === "failed" && suite.assertionResults) {
					for (const test of suite.assertionResults) {
						if (test.status === "failed") {
							failures.push({
								name: test.title,
								message:
									test.failureMessages?.[0] || suite.message || "Test failed",
								location: test.location
									? `${path.relative(cwd, testFile)}:${test.location.line}`
									: undefined,
								stack: this.truncateStack(test.failureMessages?.join("\n")),
							});
						}
					}
				}
			}

			return {
				file: testFile,
				sourceFile: "",
				runner,
				passed: json.numPassedTests || 0,
				failed: json.numFailedTests || 0,
				// #1452: `numSkippedTests` is absent from both reporters' JSON, so
				// this read was always 0. `numPendingTests` is where a `test.skip`
				// actually lands; `numTodoTests` is counted with it because the
				// text parsers (pytest `N skipped`, mix `N excluded` + `N skipped`)
				// also fold every not-run test into one `skipped` figure.
				// `??` would accept a present 0, so a reporter that emits
				// `numSkippedTests: 0` beside a real `numPendingTests` would
				// reproduce the very defect this removes. Take the larger reading.
				skipped: Math.max(
					json.numSkippedTests ?? 0,
					(json.numPendingTests || 0) + (json.numTodoTests || 0),
				),
				failures,
				duration: this.jsonRunDurationMs(json.testResults),
			};
		} catch (err) {
			void err;
			const failed = stdout.includes("FAIL") || stderr.includes("FAIL");
			return this.emptyResult(
				testFile,
				"",
				runner,
				failed ? "Tests failed (could not parse output)" : undefined,
			);
		}
	}

	/**
	 * #1452: real run duration in ms from a vitest/jest `--json` payload.
	 *
	 * NOT `testResults[].perfStats`. That field exists on jest's INTERNAL
	 * `TestResult`, but the JSON reporter's `formatTestResults` projects it to
	 * per-suite `startTime`/`endTime` and drops it — measured absent from both
	 * vitest 4.1.10 and jest 30.4.2 output, so reading it would have left this
	 * at 0. The per-suite epoch pair is what both reporters actually emit.
	 *
	 * Wall-clock SPAN across suites (max end - min start), not a sum: suites in
	 * one payload may have run in parallel workers, and summing would report
	 * more elapsed time than the run took. With the single suite pi-lens
	 * actually produces (one test file per invocation) the two agree.
	 *
	 * The span excludes the runner's own startup: the top-level `startTime` is
	 * ~330ms earlier than the first suite's on this repo. What the per-suite
	 * pair then measures is NOT the same quantity across runners. On vitest it
	 * tracks test time closely (135ms span against 134ms of summed assertions),
	 * but jest stamps a suite's `startTime` before transform and module load,
	 * so the same fields give 5595ms against 128ms of assertions. Both are
	 * honest suite wall clock; neither is comparable to the other, and only the
	 * vitest figure is close to what pytest's `in 0.05s` or ExUnit's
	 * `Finished in 0.05 seconds` report.
	 *
	 * Falls back to the summed per-assertion `duration` when a reporter omits
	 * the suite pair. Never returns a negative or non-finite value — a garbled
	 * payload must degrade to "unmeasured", not to a wrong number.
	 *
	 * #1479: that degradation is now literal. This used to return 0 for a
	 * payload it could not read, which is the figure a sub-millisecond suite
	 * also produces, so the caller could not tell them apart. It returns
	 * `undefined` instead. A readable pair whose span is 0 still returns 0,
	 * because that is a measurement.
	 */
	private jsonRunDurationMs(
		suites:
			| Array<{
					startTime?: number;
					endTime?: number;
					assertionResults?: Array<{ duration?: number | null }>;
			  }>
			| undefined,
	): number | undefined {
		let minStart = Number.POSITIVE_INFINITY;
		let maxEnd = Number.NEGATIVE_INFINITY;
		let assertionTotal = 0;
		for (const suite of suites || []) {
			if (
				typeof suite.startTime === "number" &&
				Number.isFinite(suite.startTime) &&
				typeof suite.endTime === "number" &&
				Number.isFinite(suite.endTime)
			) {
				minStart = Math.min(minStart, suite.startTime);
				maxEnd = Math.max(maxEnd, suite.endTime);
			}
			for (const assertion of suite.assertionResults || []) {
				if (
					typeof assertion.duration === "number" &&
					Number.isFinite(assertion.duration) &&
					assertion.duration > 0
				) {
					assertionTotal += assertion.duration;
				}
			}
		}
		const span = maxEnd - minStart;
		if (Number.isFinite(span) && span > 0) return Math.round(span);
		if (assertionTotal > 0) return Math.round(assertionTotal);
		// Ordering above is unchanged from #1452 on purpose: a positive span
		// still beats the assertion sum, and the sum still beats a suite pair
		// that read as zero. Only the terminal case moved. A pair we could
		// read whose span is 0 is a run that took under a millisecond — report
		// it. Everything else was never measured.
		if (Number.isFinite(span) && span === 0) return 0;
		return undefined;
	}

	// --- Vitest Parser ---
	private parseVitestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
	}

	// --- Jest Parser ---
	private parseJestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		return this.parseJsonTestOutput(stdout, stderr, testFile, cwd, runner);
	}

	// --- Pytest Parser (text-based, no JSON dependency) ---

	private parsePytestOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		_cwd: string,
		runner: string,
	): TestResult {
		const failures: TestFailure[] = [];
		const output = `${stdout}\n${stderr}`;

		// #1479: `duration` stays undefined unless pytest emits its own `in N.NNs`
		// summary. A measured `in 0.00s` remains a real zero.
		const { passed, failed, skipped, duration } = parsePytestSummary(output);

		// Parse individual failures: "FAILED tests/test_foo.py::test_something - AssertionError: ..."
		const failureRegex = /FAILED\s+(\S+::\S+)\s*-\s*(.+?)(?:\n|$)/g;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({
				name: match[1],
				message: match[2].trim().slice(0, 500),
				location: match[1].replace("::", ":"),
			});
		}

		// Also look for assertion errors with traceback
		const tracebackRegex = /_{10,}\s*\n\s*(\w+Error:\s*.+?)(?:\n|$)/gs;
		while ((match = tracebackRegex.exec(output)) !== null) {
			// Add to last failure if exists, or create generic
			if (failures.length > 0 && !failures[failures.length - 1].stack) {
				failures[failures.length - 1].stack = match[1].trim().slice(0, 1000);
			}
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error: exitCode === 2 ? "Pytest configuration error" : undefined,
		};
	}

	// --- PHPUnit Parser (text-based, default CLI output) ---

	private parsePhpunitOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		let passed = 0;
		let failed = 0;
		let skipped = 0;

		// Success (or success-with-incomplete/skipped): "OK (12 tests, 34 assertions)"
		const okMatch = output.match(
			/OK\s*\((\d+)\s+tests?,\s*\d+\s+assertions?\)/i,
		);
		if (okMatch) {
			passed = Number.parseInt(okMatch[1], 10);
		} else {
			// Failure summary: "Tests: 12, Assertions: 34, Errors: 1, Failures: 2, Skipped: 1."
			const testsMatch = output.match(/Tests:\s*(\d+)/i);
			const failuresMatch = output.match(/Failures:\s*(\d+)/i);
			const errorsMatch = output.match(/Errors:\s*(\d+)/i);
			const skippedMatch = output.match(/Skipped:\s*(\d+)/i);

			const total = testsMatch ? Number.parseInt(testsMatch[1], 10) : 0;
			const failures = failuresMatch
				? Number.parseInt(failuresMatch[1], 10)
				: 0;
			const errors = errorsMatch ? Number.parseInt(errorsMatch[1], 10) : 0;
			skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
			failed = failures + errors;
			passed = Math.max(0, total - failed - skipped);
		}

		// Individual failures: "1) Foo\BarTest::testSomething"
		const failures: TestFailure[] = [];
		const failureRegex = /^\d+\)\s+(\S+)/gm;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({ name: match[1], message: match[1] });
		}

		// #1452: PHPUnit prints its own elapsed time and this parser dropped it,
		// so every PHPUnit run reported 0ms. Two shapes are accepted because the
		// summary changed across supported majors:
		//   PHPUnit >= 9.3   "Time: 00:00.123, Memory: 8.00 MB"   (HH:)MM:SS.mmm
		//   PHPUnit <= 9.2   "Time: 1.23 seconds, Memory: 10.00MB" | "Time: 123 ms"
		// NOT VERIFIED AGAINST A LIVE PHPUnit — there is no PHP toolchain on the
		// box this was written on. Both shapes are covered by unit tests against
		// literal summary lines taken from the PHPUnit printers, and the parser
		// leaves duration UNMEASURED when neither matches (#1479 — it used to
		// leave 0, which the turn-end log printed as a measurement), so an
		// unrecognised summary degrades to "we do not know" rather than to a
		// wrong figure.
		let duration: number | undefined;
		const clockMatch = output.match(
			/^Time:\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/im,
		);
		if (clockMatch) {
			const hours = clockMatch[1] ? Number.parseInt(clockMatch[1], 10) : 0;
			const minutes = Number.parseInt(clockMatch[2], 10);
			const seconds = Number.parseInt(clockMatch[3], 10);
			// ".1" is a tenth, ".12" hundredths — pad rather than parseInt, or
			// "Time: 00:00.1" would read as 1ms instead of 100ms.
			const millis = clockMatch[4]
				? Number.parseInt(clockMatch[4].padEnd(3, "0"), 10)
				: 0;
			duration = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
		} else {
			const legacyMatch = output.match(
				/^Time:\s*([\d.]+)\s*(seconds?|s|ms|milliseconds?|minutes?)\b/im,
			);
			if (legacyMatch) {
				const value = Number.parseFloat(legacyMatch[1]);
				const unit = legacyMatch[2].toLowerCase();
				const scale =
					unit.startsWith("ms") || unit.startsWith("milli")
						? 1
						: unit.startsWith("min")
							? 60_000
							: 1000;
				if (Number.isFinite(value) && value > 0) {
					duration = Math.round(value * scale);
				}
			}
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error:
				exitCode !== 0 && passed === 0 && failed === 0
					? "PHPUnit runner error"
					: undefined,
		};
	}

	// --- mix test Parser (ExUnit, text-based, default CLI output) ---

	private parseMixTestOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		let passed = 0;
		let failed = 0;
		let skipped = 0;
		// #1479: undefined until ExUnit's own `Finished in N seconds` is read.
		let duration: number | undefined;

		// Summary: "3 tests, 1 failure" (optionally ", N excluded" / ", N skipped")
		const summaryMatch = output.match(
			/(\d+)\s+tests?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+excluded)?(?:,\s*(\d+)\s+skipped)?/i,
		);
		if (summaryMatch) {
			const total = Number.parseInt(summaryMatch[1], 10);
			failed = Number.parseInt(summaryMatch[2], 10);
			const excluded = summaryMatch[3]
				? Number.parseInt(summaryMatch[3], 10)
				: 0;
			const skippedCount = summaryMatch[4]
				? Number.parseInt(summaryMatch[4], 10)
				: 0;
			skipped = excluded + skippedCount;
			passed = Math.max(0, total - failed - skipped);
		}

		const durationMatch = output.match(/Finished in\s+([\d.]+)\s+seconds?/i);
		if (durationMatch) {
			// Rounded for the same reason pytest's is: `2.01` seconds is
			// 2009.9999999999998 ms unrounded, and that reaches the log.
			// (Routing this through `toMeasuredDurationMs` is #1484.)
			duration = Math.round(Number.parseFloat(durationMatch[1]) * 1000);
		}

		// Individual failures: "  1) test some behavior (MyModuleTest)"
		const failures: TestFailure[] = [];
		const failureRegex = /^\s*\d+\)\s+(.+?)\s*\(([^)]+)\)\s*$/gm;
		let match;
		while ((match = failureRegex.exec(output)) !== null) {
			failures.push({
				name: match[1].trim(),
				message: match[1].trim(),
				location: match[2].trim(),
			});
		}

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error:
				exitCode !== 0 && passed === 0 && failed === 0
					? "mix test runner error"
					: undefined,
		};
	}

	// --- Generic text parser for non-JSON runners ---

	/**
	 * #1480: elapsed time for the runners `parseGenericRunnerOutput` handles.
	 *
	 * Before this, only go's `ok  pkg  0.25s` was read and every other runner
	 * reported a hardcoded 0. #1479 made the log tell "measured" from
	 * "unmeasured", but this parser is the `default:` arm behind cargo, dotnet,
	 * maven, gradle, rspec, minitest and every unrecognised runner, so all of
	 * them still reported a number nobody measured. Each runner below prints
	 * its elapsed time in the same summary block this parser already regexes
	 * for pass/fail counts.
	 *
	 * Absent, not 0, is the answer when nothing is found — see
	 * `TestResult.duration` and `run-duration.ts`. A probe that returned 0 here
	 * would be claiming a measurement.
	 *
	 * One parser serves all runners, so the probe is selected BY RUNNER NAME.
	 * Running every probe over every runner's output was the original shape of
	 * this code, and it let gradle borrow a number: `BUILD SUCCESSFUL in 3s`
	 * plus a preceding `... ok` line satisfied go's `ok <pkg> <n>s` probe, so
	 * the whole-build wall clock got reported as test time — the exact wrong
	 * number this function refuses to print. Gating on the runner makes that
	 * structurally impossible rather than merely unlikely, and it matters most
	 * for the `default:` arm of the switch, which is where an unrecognised or
	 * custom runner's arbitrary output lands.
	 *
	 * Within a runner the patterns are still anchored where an anchor helps,
	 * for the same reason #1452's PHPUnit `Time:` pattern is anchored: an
	 * unanchored /m match takes the FIRST hit over stdout+stderr, and a failure
	 * diff quoting "Finished in ..." would beat the real summary. Note what the
	 * `^` in `^Finished in` does and does not buy. It rejects a decoy that is
	 * INDENTED, which is what a quoted expectation or an assertion diff is; it
	 * does NOT rank two column-0 matches, so an unindented decoy printed by the
	 * suite itself would still win. It is a cheap filter for the common shape,
	 * not a proof of uniqueness. And it is not an anchor to the counts line for
	 * rspec or minitest: both print their elapsed time on a `Finished in ...`
	 * line and their counts (`3 examples, 0 failures`, `1 runs, 1 assertions,
	 * ...`) on a different line.
	 *
	 * KNOWN LIMIT — first summary only. cargo across multiple crates, `dotnet
	 * test` across multiple assemblies, and `go test ./...` across multiple
	 * packages each print one summary per unit, and these probes take the
	 * first. A multi-unit run therefore UNDER-REPORTS its duration. That is
	 * left as-is deliberately: the count parsers below have the same first-match
	 * shape for those runners, so duration and counts describe the same scope.
	 * Fixing one without the other would trade an under-report for an
	 * inconsistency. Pinned by test so it stays a known limit, not an accident.
	 *
	 * Formats and how each was verified:
	 *
	 * - go — `ok  example.com/pkg  0.253s`. Pre-existing pattern, unchanged
	 *   apart from the shared finite/non-negative guard.
	 *
	 * - cargo — `test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured;
	 *   0 filtered out; finished in 0.253s`. NOT VERIFIED AGAINST A LIVE CARGO
	 *   RUN — this box has no MSVC linker, so `cargo test` cannot link. Format
	 *   read out of the libtest printer shipped with the local rustc 1.94.1:
	 *   `library/test/src/formatters/pretty.rs` builds `"; finished in
	 *   {exec_time}"` and `library/test/src/time.rs` renders `TestSuiteExecTime`
	 *   as `{:.2}s`. Older rustc omits the suffix entirely; that degrades to
	 *   unmeasured.
	 *
	 * - dotnet/vstest — `Failed: 1, Passed: 2, Skipped: 0, Total: 3, Duration:
	 *   1 m 30 s - t.dll (net8.0)`. NOT VERIFIED AGAINST A LIVE `dotnet test` —
	 *   NuGet restore has no network here. Format read out of the
	 *   vstest.console.dll shipped with the local .NET SDK 8.0.423, which holds
	 *   the literal `{0} - Failed: {1}, Passed: {2}, Skipped: {3}, Total: {4},
	 *   Duration: {5}` next to the unit literals `" h"`, `" m"`, `" s"`,
	 *   `" ms"`, `"< 1 ms"`. The duration is a space-joined token list, so it
	 *   is summed rather than read as one number.
	 *
	 * - maven/surefire — `Tests run: 4, Failures: 0, Errors: 0, Skipped: 0,
	 *   Time elapsed: 0.05 s -- in com.example.AppTest`. NOT VERIFIED AGAINST A
	 *   LIVE MAVEN — no mvn on this box. Summed across the per-class lines,
	 *   because surefire prints `Time elapsed` per test class and its final
	 *   `Results:` total carries no time. `[INFO] Total time: 3.4 s` is
	 *   deliberately NOT used: that is whole-build wall clock including compile,
	 *   which would report a wrong number rather than none. Surefire 2.x wrote
	 *   `sec` where 3.x writes `s`; both are accepted.
	 *
	 *   EXPECT THIS TO BE ABSENT IN PRACTICE. pi-lens invokes `mvn test -q`
	 *   (see RUNNERS.maven above), and surefire logs its per-class `Tests run:
	 *   ..., Time elapsed: ...` lines at INFO, which `-q` suppresses. Only the
	 *   ERROR-level lines of a FAILING class survive, so a green maven run
	 *   typically reports unmeasured and a red one reports the failing classes'
	 *   time alone. REASONED, NOT RUN — there is no mvn on this box to confirm
	 *   it. Left in rather than dropped: it costs nothing, it is correct when
	 *   the output does carry the lines (a repo that sets `-Dsurefire.useFile`
	 *   or drops `-q` via `.mvn/maven.config`), and `unmeasured` is an honest
	 *   report of the quiet case.
	 *
	 * - rspec — `Finished in 0.32394 seconds (files took 0.49427 seconds to
	 *   load)`. VERIFIED against a live rspec-core 3.13.6 run on ruby 3.4.10.
	 *   The minutes form (`Finished in 2 minutes 15.14 seconds`) comes from
	 *   `RSpec::Core::Formatters::Helpers.format_duration` in the same
	 *   installed gem; rspec never prints hours. Load time trails the run time
	 *   on the same line and must not be read instead of it.
	 *
	 * - minitest — `Finished in 0.254594s, 7.8557 runs/s, 7.8557 assertions/s.`
	 *   VERIFIED against a live minitest 5.25.4 run on ruby 3.4.10. The format
	 *   string is `"Finished in %.6fs, ..."` in minitest.rb, always seconds.
	 *
	 * - gradle — deliberately left unmeasured, and now UNREACHABLE by any other
	 *   runner's probe rather than merely unmatched by it. Gradle's console
	 *   summary (`4 tests completed, 1 failed`) carries no elapsed time, and
	 *   `BUILD SUCCESSFUL in 3s` is whole-build wall clock including compile
	 *   and dependency resolution. Reporting that as test time would be a wrong
	 *   number; #1479 makes the absence legible in the log instead.
	 */
	private parseGenericRunnerDuration(
		output: string,
		runner: string,
	): number | undefined {
		switch (runner) {
			case "go":
				return this.parseGoDuration(output);
			case "cargo":
				return this.parseCargoDuration(output);
			case "dotnet":
				return this.parseDotnetDuration(output);
			case "maven":
				return this.parseMavenDuration(output);
			case "rspec":
				return this.parseRspecDuration(output);
			case "minitest":
				return this.parseMinitestDuration(output);
			default:
				// gradle and anything unrecognised: unmeasured, never
				// zero-as-measurement and never another runner's number.
				return undefined;
		}
	}

	/** go: `ok  	example.com/pkg	0.253s`. First package summary only. */
	private parseGoDuration(output: string): number | undefined {
		const goSummary = output.match(/ok\s+\S+\s+([\d.]+)s/m);
		if (!goSummary) return undefined;
		return toMeasuredDurationMs(Number.parseFloat(goSummary[1]) * 1000);
	}

	/** cargo: `...; 0 filtered out; finished in 0.25s`. First crate only. */
	private parseCargoDuration(output: string): number | undefined {
		const cargoTime = output.match(
			/^test result:.*?;\s*finished in\s+([\d.]+)\s*s\b/im,
		);
		if (!cargoTime) return undefined;
		return toMeasuredDurationMs(Number.parseFloat(cargoTime[1]) * 1000);
	}

	/**
	 * dotnet/vstest: `..., Total: 3, Duration: 1 m 30 s - t.dll (net8.0)`.
	 *
	 * Anchored to the counts line, and the tail stops at the ` - <dll>`
	 * separator: without that stop an assembly name is scanned for unit tokens,
	 * and a name like `Timeouts.30s.Tests.dll` adds 30 seconds of nothing.
	 * First assembly only.
	 */
	private parseDotnetDuration(output: string): number | undefined {
		const dotnetTime = output.match(
			/Failed:\s*\d+,\s*Passed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*\d+,\s*Duration:\s*([^\r\n-]+)/i,
		);
		if (!dotnetTime) return undefined;
		// `< 1 ms` is vstest's "too fast to name a number", and under the
		// optional-duration contract 0 is exactly the right thing to say: the
		// run WAS measured and it rounds to 0 ms. The token scan below would
		// reach the same 0 by finding no tokens, but only by accident, and the
		// accident is indistinguishable from an unparseable tail — so the case
		// is spelled out.
		if (/^\s*</.test(dotnetTime[1])) return 0;
		let total = 0;
		let tokens = 0;
		// "ms" before "m", or "250 ms" scores as 250 minutes.
		const units: Record<string, number> = {
			ms: 1,
			s: 1000,
			m: 60_000,
			h: 3_600_000,
		};
		for (const token of dotnetTime[1].matchAll(/([\d.]+)\s*(ms|h|m|s)\b/gi)) {
			total += Number.parseFloat(token[1]) * units[token[2].toLowerCase()];
			tokens++;
		}
		// A tail we matched but could not read a single token out of is not a
		// zero-length run, it is an unrecognised format.
		if (tokens === 0) return undefined;
		return toMeasuredDurationMs(total);
	}

	/**
	 * maven/surefire: summed across per-class `Time elapsed` lines.
	 *
	 * The guard is "did any line match", NOT "is the sum positive". Surefire
	 * prints `Time elapsed: 0.00 s` for a trivial test class, and that is a
	 * measurement of zero, not a failure to measure.
	 */
	private parseMavenDuration(output: string): number | undefined {
		let surefireTotal = 0;
		let matched = false;
		for (const line of output.matchAll(
			/^.*Tests run:\s*\d+,.*?Time elapsed:\s*([\d.]+)\s*(?:s|sec|secs|seconds)\b.*$/gim,
		)) {
			const seconds = Number.parseFloat(line[1]);
			if (!Number.isFinite(seconds) || seconds < 0) continue;
			surefireTotal += seconds;
			matched = true;
		}
		if (!matched) return undefined;
		return toMeasuredDurationMs(surefireTotal * 1000);
	}

	/** rspec: `Finished in 2 minutes 15.14 seconds (files took 0.5 ...)`. */
	private parseRspecDuration(output: string): number | undefined {
		const rspecTime = output.match(
			/^Finished in\s+(?:([\d.]+)\s+minutes?\s+)?([\d.]+)\s+seconds?/im,
		);
		if (!rspecTime) return undefined;
		const minutes = rspecTime[1] ? Number.parseFloat(rspecTime[1]) : 0;
		return toMeasuredDurationMs(
			minutes * 60_000 + Number.parseFloat(rspecTime[2]) * 1000,
		);
	}

	/**
	 * minitest: `Finished in 0.254594s, 7.8557 runs/s, ...`.
	 *
	 * The trailing `,` is load-bearing, not decoration: it is what separates
	 * minitest's own line from a bare `Finished in 99s` the suite under test
	 * printed at column 0, which the `^` alone does not rank.
	 */
	private parseMinitestDuration(output: string): number | undefined {
		const minitestTime = output.match(/^Finished in\s+([\d.]+)s\s*,/im);
		if (!minitestTime) return undefined;
		return toMeasuredDurationMs(Number.parseFloat(minitestTime[1]) * 1000);
	}

	private parseGenericRunnerOutput(
		stdout: string,
		stderr: string,
		exitCode: number,
		testFile: string,
		runner: string,
	): TestResult {
		const output = `${stdout}\n${stderr}`;
		const lower = output.toLowerCase();

		let passed = 0;
		// #1487: NOT `exitCode === 0 ? 0 : 1`. Pre-seeding `failed` to 1 on a
		// non-zero exit made the runner-error branch below unreachable — it
		// requires `failed === 0`, which a spawn/config/load failure (no
		// counts to parse) could never reach once this had already claimed
		// the slot. `matched` tracks whether a count parser actually found
		// real counts; the exit-code-distrust fallback further down uses it
		// to tell "a runner that never ran" from "a runner whose summary
		// legitimately parsed to zero failures".
		let failed = 0;
		let skipped = 0;
		let matched = false;
		// #1480: `number | undefined`, and sourced per runner. This used to be
		// `let duration = 0` with only go's probe able to move it, so every
		// other runner reported a zero it never measured.
		const duration = this.parseGenericRunnerDuration(output, runner);

		const cargoSummary = output.match(
			/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;/i,
		);
		if (cargoSummary) {
			passed = Number.parseInt(cargoSummary[1], 10);
			failed = Number.parseInt(cargoSummary[2], 10);
			skipped = Number.parseInt(cargoSummary[3], 10);
			matched = true;
		}

		const dotnetSummary = output.match(
			/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/i,
		);
		if (dotnetSummary) {
			failed = Number.parseInt(dotnetSummary[1], 10);
			passed = Number.parseInt(dotnetSummary[2], 10);
			skipped = Number.parseInt(dotnetSummary[3], 10);
			matched = true;
		}

		// #1480 (adjacent, duration-independent): surefire prints one
		// `Tests run:` line PER TEST CLASS (those carry `Time elapsed:`) and
		// then a per-MODULE aggregate under `Results:` (which does not). Taking
		// the FIRST match scored a run by its first class alone — a two-class
		// run with a failure in the second class reported 0 failures.
		//
		// Taking the LAST match is just as wrong, in a worse direction. A
		// multi-module reactor run prints one `Results:` aggregate per module,
		// and the last is the last module: a `--fail-at-end` build whose first
		// module had 3 failures and whose second module was green would report
		// 0 failures, turning a red build into `PASS` in the turn-end log. That
		// is reachable without pi-lens passing the flag, because maven also
		// reads `.mvn/maven.config` and `MAVEN_ARGS`.
		//
		// So: SUM the aggregates. That makes counts reactor-wide, the same
		// scope `parseMavenDuration` sums its per-class times over. When no
		// aggregate is present (output truncated, or `Results:` suppressed) the
		// per-class lines sum to the same totals, so they are the fallback.
		const mavenLines = [
			...output.matchAll(
				/^.*?Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+).*$/gim,
			),
		];
		const mavenAggregates = mavenLines.filter(
			(line) => !/Time elapsed:/i.test(line[0]),
		);
		const mavenScored =
			mavenAggregates.length > 0 ? mavenAggregates : mavenLines;
		if (mavenScored.length > 0) {
			let total = 0;
			let mavenFailed = 0;
			let mavenSkipped = 0;
			for (const line of mavenScored) {
				total += Number.parseInt(line[1], 10);
				mavenFailed +=
					Number.parseInt(line[2], 10) + Number.parseInt(line[3], 10);
				mavenSkipped += Number.parseInt(line[4], 10);
			}
			failed = mavenFailed;
			skipped = mavenSkipped;
			passed = Math.max(0, total - failed - skipped);
			matched = true;
		}

		const rspecSummary = output.match(
			/(\d+)\s+examples?,\s+(\d+)\s+failures?/i,
		);
		if (rspecSummary) {
			const total = Number.parseInt(rspecSummary[1], 10);
			failed = Number.parseInt(rspecSummary[2], 10);
			passed = Math.max(0, total - failed);
			matched = true;
		}

		const minitestSummary = output.match(
			/(\d+)\s+runs?,\s+\d+\s+assertions?,\s+(\d+)\s+failures?,\s+(\d+)\s+errors?/i,
		);
		if (minitestSummary) {
			const total = Number.parseInt(minitestSummary[1], 10);
			const failures = Number.parseInt(minitestSummary[2], 10);
			const errors = Number.parseInt(minitestSummary[3], 10);
			failed = failures + errors;
			passed = Math.max(0, total - failed);
			matched = true;
		}

		const gradleSummary = output.match(
			/(\d+)\s+tests? completed,\s+(\d+)\s+failed/i,
		);
		if (gradleSummary) {
			const total = Number.parseInt(gradleSummary[1], 10);
			failed = Number.parseInt(gradleSummary[2], 10);
			passed = Math.max(0, total - failed);
			matched = true;
		}

		// #1487/#1524/#1524-r3: `--- FAIL: TestName` is extracted first and
		// separately from the other two name patterns, because it is the
		// ONLY one of the three that is unambiguous evidence a real go test
		// ran — see the `runnerError` comment below for why the other two
		// may no longer veto on their own. go otherwise has no count parser
		// at all (only a duration probe), so without this go's `matched`
		// stayed false even on a real failure.
		//
		// #1524-r3: go ALSO gets a real count parser here, not just a name
		// extractor. A panic inside `TestMain`/package `init` (exit 2) never
		// prints a `--- FAIL:` line — there is no test to name, the process
		// died before any test ran — so `goFailNames` alone left `matched`
		// false and such a panic hit the same runner-error branch as a
		// spawn failure, even though `go test` DID run and DID fail. `FAIL
		// \t<pkg>` is go's own per-package verdict line and is printed for
		// exactly this case; `ok  <pkg>  <n>s` is its pass counterpart.
		// Package-line counts, like the go duration probe above, take the
		// FIRST package summary only — the same known limit already
		// documented on `parseGenericRunnerDuration`.
		const goFailNames = [...output.matchAll(/--- FAIL:[^\S\n]+([^\s(]+)/g)];
		// #1524-r4: only COUNT unparented failures. go prints a `--- FAIL:`
		// line for every level of a failing subtest tree — `TestA` AND
		// `TestA/sub` each get their own line for what is really one
		// underlying failure — so counting every line inflated `failed`
		// (two lines here read as two failures for one broken test). A name
		// containing "/" whose prefix up to that "/" is itself in the list
		// is a subtest of an already-counted parent; only names that are
		// NOT such a subtest count. `goFailNames` itself (all lines) is
		// still what decides `matched`/the runner-error veto below and
		// what's listed in `failures` — subtest names are still useful
		// detail there, just not double-counted.
		const goFailNameSet = new Set(goFailNames.map((m) => m[1].trim()));
		const goTopLevelFailCount = goFailNames.filter((m) => {
			const name = m[1].trim();
			const slash = name.indexOf("/");
			return slash === -1 || !goFailNameSet.has(name.slice(0, slash));
		}).length;
		if (runner === "go") {
			// #1524-r4: `(?![^\n]*\[(?:build|setup) failed\])` rejects go's
			// INFRASTRUCTURE verdict lines — `FAIL <pkg> [build failed]` (a
			// compile error) and `FAIL <pkg> [setup failed]` (no packages to
			// test) — which matched the same shape as a real `FAIL <pkg>
			// <duration>` test verdict line. Neither ran a single test; both
			// were rendering as `✗ 1/1 failed ✗ go failure` instead of the
			// runner error they are.
			const goFailPackage =
				/^FAIL(?![^\n]*\[(?:build|setup) failed\])[^\S\n]+\S+/m.test(output);
			const goOkPackages = [
				...output.matchAll(/^ok[^\S\n]+\S+[^\S\n]+[\d.]+s/gm),
			];
			if (goFailNames.length > 0 || goFailPackage) {
				failed = Math.max(failed, goTopLevelFailCount || 1);
				matched = true;
			}
			// #1524-r4: unconditional, not `else if`. A multi-package run
			// can have BOTH a real failure and packages that passed clean —
			// `ok a` / `--- FAIL: TestB` / `ok c` is 2 passed AND 1 failed,
			// not "1 failed, 0 passed" with the green packages silently
			// dropped because the fail branch above already ran.
			if (goOkPackages.length > 0) {
				passed = Math.max(passed, goOkPackages.length);
				matched = true;
			}
		}

		// #1524-r3: anchored to line START (`^`), and `[^\S\n]` (horizontal
		// whitespace only) in place of `\s` between the keyword and the
		// name. The prior `\bFAILED\s+([^\n]+)` and `Failure:\s+([^\n]+)`
		// let their OWN `\s+` gap cross the newline: a bare `FAILED` at the
		// end of a line has nothing after it on that line, so `\s+` ate the
		// newline itself and `([^\n]+)` captured the FIRST TOKEN OF THE
		// NEXT LINE as the "test name" — proven on a gradle compile failure
		// (`> Task :compileJava FAILED` followed by
		// `FAILURE: Build failed with an exception.`, which then rendered
		// as the invented failure name) and the newline-spanning shape in
		// general (`FAILED\n\nsome trailing note` → name "some trailing
		// note"). Requiring `(\S.*)$` on the SAME line makes a keyword with
		// nothing following it on that line simply not match, rather than
		// reaching across for content that was never the name.
		const failures: TestFailure[] = [];
		for (const m of goFailNames.slice(0, 5)) {
			failures.push({ name: m[1].trim(), message: m[1].trim() });
		}
		const otherNames = [
			...output.matchAll(/^[^\S\n]*FAILED[^\S\n]+(\S.*)$/gm),
			...output.matchAll(/^[^\S\n]*Failure:[^\S\n]+(\S.*)$/gm),
		];
		for (const m of otherNames) {
			if (failures.length >= 5) break;
			failures.push({ name: m[1].trim(), message: m[1].trim() });
		}

		// #1487: gated on `!matched`, not on `failed === 0`. A non-zero exit
		// with NO count parser match — a spawn/config/load failure, nothing
		// ran — is infrastructure, not a test verdict: report it as a runner
		// error. A non-zero exit a count parser DID match (even to a
		// legitimate `failed === 0`, e.g. a green last module of a red
		// reactor) is a real run that produced real counts, so it is never a
		// runner error, and the exit-code-distrust guard below still forces
		// at least one failure so it can't render as PASS.
		//
		// #1524-r3: the veto is `goFailNames.length === 0`, NOT
		// `failures.length === 0`. Only `--- FAIL:` is a marker a test
		// runner emits SPECIFICALLY for a failed test; `FAILED`/`Failure:`
		// are generic words a build tool prints for reasons that have
		// nothing to do with a test — a gradle task failing to compile, a
		// maven goal failing before surefire ever runs, an rspec file that
		// never loaded. Letting those two veto the runner-error branch on
		// their own reintroduced #1487's exact symptom for the commonest
		// gradle/maven/rspec failure shapes (proven: `[ERROR] Failed to
		// execute goal ... FAILED` and rspec's `Failure: cannot load such
		// file` both rendered as a fabricated test failure instead of the
		// runner error they actually are). They still label a name onto
		// `failures` above when `matched` or `goFailNames` already settled
		// the question some other way, but they no longer settle it alone.
		const runnerError =
			exitCode !== 0 &&
			!matched &&
			goFailNames.length === 0 &&
			lower.includes("error")
				? `Runner ${runner} exited with ${exitCode}`
				: undefined;

		// #1524-r4 (tidy): a runner-error result reports through
		// `formatResult`'s runner-error branch, not the failed-tests
		// branch, so any name `otherNames` picked up before this was
		// decided (e.g. a same-line `Failure: cannot load such file`)
		// would sit in `failures` unused but visible to anything reading
		// the raw `TestResult` — an error result with a non-empty
		// `failures` list is a self-contradiction. Clear it here so the
		// result is one or the other, never both.
		if (runnerError) {
			failures.length = 0;
		}

		// #1480 (adjacent): a non-zero exit is the runner saying the run
		// failed. Every count parser above can legitimately arrive at
		// `failed === 0` — a summary that only covers part of the run, a green
		// module of a red reactor build, a failure outside any test — and the
		// turn-end log would then print PASS over a build the runner rejected.
		// Trust the exit code: no parse of the text may talk it out of at least
		// one failure. Skipped when `runnerError` is set — that case already
		// reports through `formatResult`'s runner-error branch, which requires
		// `passed === 0 && failed === 0` to stay reachable, and forcing
		// `failed` to 1 here would make it unreachable again (#1487).
		if (exitCode !== 0 && failed === 0 && !runnerError) {
			failed = 1;
		}

		if (passed === 0 && failed === 0 && skipped === 0 && exitCode === 0) {
			passed = 1;
		}

		if (failures.length === 0 && failed > 0) {
			const firstLine =
				output
					.split("\n")
					.find((l) => /fail|error|exception/i.test(l))
					?.trim()
					.slice(0, 300) || `Tests failed for runner ${runner}`;
			failures.push({ name: `${runner} failure`, message: firstLine });
		}

		this.log(
			runnerError
				? `Generic runner ${runner}: never started (${runnerError})`
				: `Generic runner ${runner}: ran (matched=${matched}, passed=${passed}, failed=${failed}, failures=${failures.length})`,
		);

		return {
			file: testFile,
			sourceFile: "",
			runner,
			passed,
			failed,
			skipped,
			failures,
			duration,
			error: runnerError,
		};
	}

	// --- Formatting ---

	/**
	 * Format test result for LLM consumption
	 */
	formatResult(result: TestResult): string {
		if (result.error && result.passed === 0 && result.failed === 0) {
			// Runner error, not test failure
			return `[Tests] ⚠ Could not run tests: ${result.error}`;
		}

		const total = result.passed + result.failed + result.skipped;
		if (total === 0) {
			return ""; // No tests to report
		}

		// #1479 deliberately does NOT change this surface. The agent-facing
		// string already suppressed the suffix for a 0, so an unmeasured run
		// and a zero-length one look the same here and always did. The issue
		// scopes the unmeasured/zero distinction to the turn-end log line;
		// widening it to the LLM prompt is a separate call about prompt noise.
		// #1480: the "is this a measurement at all" half of the test comes from
		// `run-duration.ts` so this surface cannot drift from the log's answer.
		// The `> 0` half is the scope decision above and stays local to it — it
		// is what suppresses the suffix for a measured zero, which is a choice
		// about prompt noise rather than about the duration contract. Routing
		// the first half through the shared predicate also stops a non-finite
		// duration rendering as ` (Infinitys)`.
		const durationStr =
			isMeasuredDuration(result.duration) && result.duration > 0
				? ` (${(result.duration / 1000).toFixed(2)}s)`
				: "";

		if (result.failed === 0) {
			return `[Tests] ✓ ${result.passed}/${total} passed${durationStr} — ${result.runner}`;
		}

		// Has failures
		let output = `[Tests] ✗ ${result.failed}/${total} failed, ${result.passed} passed${durationStr} — ${result.runner}\n`;

		for (const failure of result.failures.slice(0, 5)) {
			output += `  ✗ ${failure.name}\n`;
			const msg = failure.message.split("\n")[0].slice(0, 200); // First line, truncated
			output += `    ${msg}\n`;
			if (failure.location) {
				output += `    at ${failure.location}\n`;
			}
		}

		if (result.failures.length > 5) {
			output += `  ... and ${result.failures.length - 5} more failure(s)\n`;
		}

		output += `  → Fix failing tests before proceeding\n`;

		return output.trimEnd();
	}

	// --- Helpers ---

	/**
	 * Additional mirrored-directory candidate for source trees whose test
	 * tree mirrors the source tree under a *different*, conventional
	 * source-root segment rather than the source file's full relative
	 * directory — e.g. PHPUnit's `src/Foo/Bar.php` -> `tests/Foo/BarTest.php`
	 * (strips `src`) or ExUnit's `lib/accounts/user.ex` ->
	 * `test/accounts/user_test.exs` (strips `lib`).
	 *
	 * Unlike the `relDir`-based candidates above (which mirror under the
	 * hardcoded "tests"/"__tests__" roots), this uses `testDir` — the
	 * pattern's own configured test root from `SOURCE_TO_TEST_PATTERNS`
	 * (e.g. "tests" for PHP, "test" for Elixir) — since ExUnit's root is
	 * singular and wouldn't otherwise be checked.
	 *
	 * Returns an empty array when the source directory doesn't start with a
	 * known source-root segment (src/lib/app) followed by at least one more
	 * path segment — i.e. this is a no-op for languages/layouts that don't
	 * use this convention.
	 */
	private sourceRootMirroredCandidates(
		dir: string,
		cwd: string,
		testDir: string,
		testFilename: string,
	): string[] {
		const knownSourceRoots = new Set(["src", "lib", "app"]);
		const relDir = path.relative(cwd, dir);
		const segments = relDir.split(path.sep).filter(Boolean);
		if (segments.length > 1 && knownSourceRoots.has(segments[0])) {
			return [path.join(cwd, testDir, ...segments.slice(1), testFilename)];
		}
		return [];
	}

	/**
	 * Fallback discovery: scan known test directories for a file that imports
	 * the source module. Catches cases where the test file name doesn't match
	 * the source basename (e.g. cline.test.ts testing cline-auth.ts).
	 *
	 * Checks for the basename appearing in a quoted import/require path:
	 *   from "../providers/cline/cline-auth"   → /cline-auth"  ✓
	 *   from "./cline-auth.js"                 → /cline-auth.  ✓
	 *   import("cline-auth")                   → "cline-auth"  ✓
	 */
	private findTestFileByImport(
		sourceFilePath: string,
		cwd: string,
	): string | null {
		const ext = path.extname(sourceFilePath);
		const basename = path.basename(sourceFilePath, ext);
		const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

		const searchDirs = [
			path.join(cwd, "tests"),
			path.join(cwd, "__tests__"),
			path.dirname(sourceFilePath),
		];

		for (const dir of searchDirs) {
			let entries: string[];
			try {
				entries = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!testPattern.test(entry)) continue;
				const testPath = path.join(dir, entry);
				let content: string;
				try {
					content = fs.readFileSync(testPath, "utf-8");
				} catch {
					continue;
				}
				if (
					content.includes(`/${basename}"`) ||
					content.includes(`/${basename}'`) ||
					content.includes(`/${basename}.`) ||
					content.includes(`"${basename}"`) ||
					content.includes(`'${basename}'`)
				) {
					this.log(`Found test file via import scan: ${testPath}`);
					return testPath;
				}
			}
		}
		return null;
	}

	/**
	 * Resolve the executable and args for a runner, preferring a local
	 * node_modules/.bin binary over npx to avoid the ~150ms npx startup cost.
	 *
	 * When a resolved binary becomes the command itself, `stripWrapperArgs`
	 * drops ONLY the leading arg(s) that named the wrapped binary — never a
	 * real subcommand (#1098: `cargo test --no-fail-fast` unconditionally lost
	 * `test` here because the old code assumed every runner's args() started
	 * with an npx-style runner-name arg, which only holds for wrapper-style
	 * runners like vitest/jest/pytest).
	 */
	private async resolveExec(
		runner: string,
		config: RunnerConfig,
		testFile: string,
		cwd: string,
	): Promise<{ command: string; args: string[] }> {
		// PHPUnit has no npx-style automatic local-binary resolution — Composer's
		// standard local-install location is vendor/bin/phpunit, so check that
		// explicitly before falling back to a global `phpunit` on PATH.
		if (runner === "phpunit") {
			const suffix = process.platform === "win32" ? ".bat" : "";
			const vendorBin = path.join(cwd, "vendor", "bin", `phpunit${suffix}`);
			if (fs.existsSync(vendorBin)) {
				return { command: vendorBin, args: config.args(testFile, cwd) };
			}
			return { command: "phpunit", args: config.args(testFile, cwd) };
		}

		const binName = config.binName ?? runner;
		const suffix = process.platform === "win32" ? ".cmd" : "";
		const localBin = path.join(cwd, "node_modules", ".bin", binName + suffix);

		// A resolved binary (local, or any manager's global bin) becomes the command
		// itself, so the leading wrapper-name arg(s) that named it (e.g. "vitest",
		// or "-m pytest") are stripped from args() — see stripWrapperArgs.
		if (fs.existsSync(localBin)) {
			return {
				command: localBin,
				args: stripWrapperArgs(binName, config.args(testFile, cwd)),
			};
		}

		// Any package manager's global bin dir (npm/pnpm/yarn/bun) before npx (#375).
		const globalBin = await findGlobalBinary(binName);
		if (globalBin) {
			return {
				command: globalBin,
				args: stripWrapperArgs(binName, config.args(testFile, cwd)),
			};
		}

		return { command: config.command, args: config.args(testFile, cwd) };
	}

	private emptyResult(
		testFile: string,
		sourceFile: string,
		runner: string,
		error?: string,
	): TestResult {
		return {
			file: testFile,
			sourceFile,
			runner,
			passed: 0,
			failed: 0,
			skipped: 0,
			failures: [],
			// #1479: no duration key at all. Nothing ran, so there is nothing
			// to report — this used to say 0, which reads as "ran, instantly".
			error,
		};
	}

	private truncateStack(stack?: string): string | undefined {
		if (!stack) return undefined;
		// Keep first 3 lines of stack trace
		const lines = stack.split("\n").slice(0, 3);
		return lines.join("\n").slice(0, 500);
	}

	private recordResult(record: TestResultRecord): void {
		const { cwd, runner, testFile, result, turnIndex } = record;
		const targetPath = path.resolve(testFile);
		const target = canonicalFailedPath(targetPath);
		let failedTargets = this.getFailedTargets(cwd, runner, result.failed > 0);
		if (!failedTargets) return;

		if (result.failed > 0) {
			const alreadyRecorded = failedTargets.has(target);
			if (
				!alreadyRecorded &&
				this.failedTargetCount(runner) >= MAX_FAILED_TARGETS_PER_RUNNER
			) {
				const evicted = this.evictOldestFailedTarget(runner);
				if (evicted) {
					this.recordFailedTargetState({
						outcome: "capacity-evicted",
						runner,
						candidate: evicted,
						turnIndex,
					});
				}
				// Eviction can remove this root's final prior target. Reacquire the
				// root map before inserting so the newest failure never lands in a
				// detached PathKeyedMap.
				failedTargets = this.getFailedTargets(cwd, runner, true);
				if (!failedTargets) return;
			}
			// Sequence is global across roots, so a refreshed target becomes the
			// newest failure without relying on one root map's insertion order.
			failedTargets.set(target, {
				displayPath: targetPath,
				sequence: ++this.failedTargetSequence,
			});
			return;
		}

		if (failedTargets.delete(target) && failedTargets.size === 0) {
			this.deleteFailedRoot(cwd, runner);
		}
	}
}
