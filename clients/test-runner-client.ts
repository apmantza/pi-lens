/**
 * Test Runner Client for pi-lens
 *
 * Detects test files and runs them on write/edit to provide
 * immediate test feedback to the AI agent.
 *
 * Supports: vitest, jest, pytest (extensible to more)
 *
 * Design: File-level targeted testing — only runs tests for the
 * specific file being edited, not the entire suite.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface TestResult {
	file: string; // test file that was run
	sourceFile: string; // the file the agent edited
	runner: string; // "vitest", "jest", "pytest"
	passed: number;
	failed: number;
	skipped: number;
	failures: TestFailure[];
	duration: number; // ms
	error?: string; // if runner itself failed
}

export interface TestFailure {
	name: string; // test name
	message: string; // failure message
	location?: string; // "file.ts:42"
	stack?: string; // abbreviated stack trace
}

// Runner detection: config file → runner name
interface RunnerConfig {
	configFiles: string[];
	command: string;
	args: (testFile: string, cwd: string) => string[];
	parseJson: boolean;
}

// --- Test File Patterns ---

const _TEST_FILE_PATTERNS: Array<{ lang: string; patterns: RegExp[] }> = [
	{
		lang: "typescript",
		patterns: [
			/^(.+)\.test\.tsx?$/,
			/^(.+)\.spec\.tsx?$/,
			/^(.+?)__tests__\/(.+)\.tsx?$/,
		],
	},
	{
		lang: "javascript",
		patterns: [
			/^(.+)\.test\.jsx?$/,
			/^(.+)\.spec\.jsx?$/,
			/^(.+?)__tests__\/(.+)\.jsx?$/,
		],
	},
	{
		lang: "python",
		patterns: [/^(.+)\.py$/, /^(.+?)test_(.+)\.py$/],
	},
];

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
];

// --- Runner Detection ---

const RUNNERS: Record<string, RunnerConfig> = {
	vitest: {
		configFiles: [
			"vitest.config.ts",
			"vitest.config.js",
			"vitest.config.mjs",
			"vite.config.ts",
		],
		command: "npx",
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
		command: "./gradlew",
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
		args: (testFile, _cwd) => ["exec", "rspec", testFile],
		parseJson: false,
	},
	minitest: {
		configFiles: ["Gemfile"],
		command: "ruby",
		args: (testFile, _cwd) => ["-Itest", testFile],
		parseJson: false,
	},
};

// --- Client ---

export class TestRunnerClient {
	private log: (msg: string) => void;
	private availableRunners: Map<string, boolean> = new Map();

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.log(`[test-runner] ${msg}`)
			: () => {};
	}

	/**
	 * Check if a test runner is available in the project
	 * Detection order:
	 * 1. Config files (vitest.config.ts, jest.config.js, etc.)
	 * 2. package.json dependencies
	 * 3. node_modules presence
	 */
	detectRunner(cwd: string): { runner: string; config: RunnerConfig } | null {
		// Priority 1: Config files
		for (const [name, config] of Object.entries(RUNNERS)) {
			const cacheKey = `${cwd}:${name}:config`;
			if (this.availableRunners.has(cacheKey)) {
				if (this.availableRunners.get(cacheKey)) {
					return { runner: name, config };
				}
				continue;
			}

			const found = config.configFiles.some((cf) =>
				fs.existsSync(path.join(cwd, cf)),
			);

			this.availableRunners.set(cacheKey, found);
			if (found) {
				this.log(`Detected runner via config: ${name}`);
				return { runner: name, config };
			}
		}

		// Priority 2: package.json dependencies
		const packageJsonPath = path.join(cwd, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
				const allDeps = {
					...pkg.dependencies,
					...pkg.devDependencies,
				};

				// Check for vitest first (more specific than jest)
				if (allDeps.vitest) {
					this.log("Detected vitest in package.json");
					this.availableRunners.set(`${cwd}:vitest:config`, true);
					return { runner: "vitest", config: RUNNERS.vitest };
				}
				if (allDeps.jest) {
					this.log("Detected jest in package.json");
					this.availableRunners.set(`${cwd}:jest:config`, true);
					return { runner: "jest", config: RUNNERS.jest };
				}
				if (allDeps.pytest || allDeps["pytest-cov"]) {
					this.log("Detected pytest in package.json (unusual)");
					this.availableRunners.set(`${cwd}:pytest:config`, true);
					return { runner: "pytest", config: RUNNERS.pytest };
				}
			} catch {
				// package.json parse error
			}
		}

		// Priority 3: Check node_modules for installed packages
		const nodeModulesPath = path.join(cwd, "node_modules");
		if (fs.existsSync(nodeModulesPath)) {
			if (fs.existsSync(path.join(nodeModulesPath, "vitest"))) {
				this.log("Detected vitest in node_modules");
				return { runner: "vitest", config: RUNNERS.vitest };
			}
			if (fs.existsSync(path.join(nodeModulesPath, "jest"))) {
				this.log("Detected jest in node_modules");
				return { runner: "jest", config: RUNNERS.jest };
			}
		}

		// Priority 4: Non-JS/Python runners (check config files that don't need package.json)
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

		// Priority 5: Check if pytest is available globally (for Python)
		try {
			const whichCmd = process.platform === "win32" ? "where" : "which";
			const result = spawnSync(whichCmd, ["pytest"], {
				encoding: "utf-8",
				timeout: 2000,
				shell: true,
			});
			if (result.status === 0) {
				this.log("Detected pytest globally");
				return { runner: "pytest", config: RUNNERS.pytest };
			}
		} catch (err) { void err; }

		return null;
	}

	/**
	 * Find test file for a given source file
	 * Returns the test file path if it exists, null otherwise
	 */
	findTestFile(
		sourceFilePath: string,
		cwd: string,
	): { testFile: string; runner: string } | null {
		const ext = path.extname(sourceFilePath);
		const basename = path.basename(sourceFilePath, ext);
		const dir = path.dirname(sourceFilePath);
		const _relativeDir = path.relative(cwd, dir);

		const patterns = SOURCE_TO_TEST_PATTERNS.find((p) => p.ext === ext);
		if (!patterns) return null;

		const detected = this.detectRunner(cwd);
		if (!detected) return null;

		// Check each potential test file location
		for (let i = 0; i < patterns.testExts.length; i++) {
			const testExt = patterns.testExts[i];
			const testDir = patterns.dirs[i];

			// Handle glob patterns (pytest style: test_*.py)
			if (testExt.includes("*")) {
				const pattern = testExt.replace("*", basename);
				const searchDir = testDir === "." ? dir : path.join(cwd, testDir);

				if (fs.existsSync(searchDir)) {
					try {
						const files = fs.readdirSync(searchDir);
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
					} catch {
						// Directory not readable
					}
				}
			} else {
				// Exact pattern match (jest/vitest style)
				const testFilename = basename + testExt;
				const searchPaths = [
					path.join(dir, testFilename), // same directory
					path.join(dir, "__tests__", testFilename), // __tests__ subdirectory
					path.join(cwd, "tests", testFilename), // top-level tests/
					path.join(cwd, "__tests__", testFilename), // top-level __tests__/
				];

				for (const testPath of searchPaths) {
					if (fs.existsSync(testPath)) {
						this.log(`Found test file: ${testPath}`);
						return { testFile: testPath, runner: detected.runner };
					}
				}
			}
		}

		return null;
	}

	/**
	 * Run tests for a specific file
	 */
	runTestFile(
		testFile: string,
		cwd: string,
		runner: string,
		config: RunnerConfig,
	): TestResult {
		const absoluteTestFile = path.resolve(testFile);
		if (!fs.existsSync(absoluteTestFile)) {
			return this.emptyResult(
				absoluteTestFile,
				"",
				runner,
				"Test file not found",
			);
		}

		try {
			const args = config.args(absoluteTestFile, cwd);
			this.log(`Running: ${config.command} ${args.join(" ")}`);

			const result = spawnSync(config.command, args, {
				encoding: "utf-8",
				cwd,
				timeout: 60000, // 60s timeout
				shell: true,
			});

			const stdout = result.stdout || "";
			const stderr = result.stderr || "";

			// Check for runner errors (not test failures)
			if (result.error) {
				this.log(`Runner error: ${result.error.message}`);
				return this.emptyResult(
					absoluteTestFile,
					"",
					runner,
					`Runner error: ${result.error.message}`,
				);
			}

			// Parse output based on runner
			switch (runner) {
				case "vitest":
					return this.parseVitestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
				case "jest":
					return this.parseJestOutput(
						stdout,
						stderr,
						absoluteTestFile,
						cwd,
						runner,
					);
				case "pytest":
					return this.parsePytestOutput(
						stdout,
						stderr,
						result.status ?? 0,
						absoluteTestFile,
						cwd,
						runner,
					);
				default:
					return this.emptyResult(
						absoluteTestFile,
						"",
						runner,
						"Unknown runner",
					);
			}
		} catch (err: any) {
			this.log(`Run error: ${err.message}`);
			return this.emptyResult(absoluteTestFile, "", runner, err.message);
		}
	}

	/**
	 * Check if a source file has corresponding tests (without running them)
	 */
	hasTestFile(sourceFilePath: string, cwd: string): boolean {
		return this.findTestFile(sourceFilePath, cwd) !== null;
	}

	// --- Vitest Parser ---

	private parseVitestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		// Vitest JSON output structure
		interface VitestResult {
			numTotalTestSuites: number;
			numPassedTestSuites: number;
			numFailedTestSuites: number;
			numTotalTests: number;
			numPassedTests: number;
			numFailedTests: number;
			numSkippedTests: number;
			testResults: Array<{
				name: string;
				status: "passed" | "failed" | "skipped";
				message?: string;
				assertionResults?: Array<{
					status: "passed" | "failed" | "skipped";
					title: string;
					failureMessages?: string[];
					location?: { line: number; column: number };
				}>;
			}>;
		}

		try {
			const json: VitestResult = JSON.parse(stdout);
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
				skipped: json.numSkippedTests || 0,
				failures,
				duration: 0, // Vitest JSON doesn't include duration in this format
			};
		} catch {
			// If JSON parsing fails, check for basic pass/fail indicators
			const failed = stdout.includes("FAIL") || stderr.includes("FAIL");
			return this.emptyResult(
				testFile,
				"",
				runner,
				failed ? "Tests failed (could not parse output)" : undefined,
			);
		}
	}

	// --- Jest Parser ---

	private parseJestOutput(
		stdout: string,
		stderr: string,
		testFile: string,
		cwd: string,
		runner: string,
	): TestResult {
		interface JestResult {
			numFailedTestSuites: number;
			numFailedTests: number;
			numPassedTests: number;
			numPassedTestSuites: number;
			numSkippedTests?: number;
			testResults: Array<{
				name: string;
				status: "passed" | "failed";
				message?: string;
				assertionResults?: Array<{
					status: "passed" | "failed" | "skipped";
					title: string;
					failureMessages?: string[];
					location?: { line: number; column: number };
				}>;
			}>;
		}

		try {
			const json: JestResult = JSON.parse(stdout);
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
				skipped: json.numSkippedTests || 0,
				failures,
				duration: 0,
			};
		} catch {
			const failed = stdout.includes("FAIL") || stderr.includes("FAIL");
			return this.emptyResult(
				testFile,
				"",
				runner,
				failed ? "Tests failed (could not parse output)" : undefined,
			);
		}
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

		// Parse summary line: "5 passed, 2 failed, 1 skipped in 0.23s"
		const summaryMatch =
			output.match(/(\d+)\s+passed?.*?(\d+)\s+failed.*?in\s+([\d.]+)s/i) ||
			output.match(/(\d+)\s+passed.*?in\s+([\d.]+)s/i);

		let passed = 0;
		let failed = 0;
		let skipped = 0;
		let duration = 0;

		if (summaryMatch) {
			// Extract numbers from various patterns
			const passedMatch = output.match(/(\d+)\s+passed/);
			const failedMatch = output.match(/(\d+)\s+failed/);
			const skippedMatch = output.match(/(\d+)\s+skipped/);
			const durationMatch = output.match(/in\s+([\d.]+)s/);

			passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
			failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
			skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
			duration = durationMatch ? parseFloat(durationMatch[1]) * 1000 : 0;
		}

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

		const durationStr =
			result.duration > 0 ? ` (${(result.duration / 1000).toFixed(2)}s)` : "";

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
			duration: 0,
			error,
		};
	}

	private truncateStack(stack?: string): string | undefined {
		if (!stack) return undefined;
		// Keep first 3 lines of stack trace
		const lines = stack.split("\n").slice(0, 3);
		return lines.join("\n").slice(0, 500);
	}
}
