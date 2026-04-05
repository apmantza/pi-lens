/**
 * Post-write pipeline for pi-lens
 *
 * Extracted from index.ts tool_result handler.
 * Runs sequentially on every file write/edit:
 *   1. Secrets scan (blocking — early exit)
 *   2. Auto-format (Biome, Prettier, Ruff, gofmt, etc.)
 *   3. Auto-fix (Biome --write, Ruff --fix, ESLint --fix)
 *   4. LSP file sync (open/update in LSP servers)
 *   5. Dispatch lint (type errors, security rules)
 *   6. Test runner (run corresponding test file)
 *   7. Cascade diagnostics (other files with errors, LSP only)
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { BiomeClient } from "./biome-client.js";
import { dispatchLintWithResult } from "./dispatch/integration.js";
import type { PiAgentAPI } from "./dispatch/types.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { getLSPService } from "./lsp/index.js";
import type { MetricsClient } from "./metrics-client.js";
import type { RuffClient } from "./ruff-client.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { formatSecrets, scanForSecrets } from "./secrets-scanner.js";
import type { TestRunnerClient } from "./test-runner-client.js";

// --- Types ---

export interface PipelineContext {
	filePath: string;
	cwd: string;
	toolName: string;
	/** pi.getFlag accessor */
	getFlag: (name: string) => boolean | string | undefined;
	/** Debug logger */
	dbg: (msg: string) => void;
}

export interface PipelineDeps {
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	testRunnerClient: TestRunnerClient;
	metricsClient: MetricsClient;
	getFormatService: () => FormatService;
	fixedThisTurn: Set<string>;
}

export interface PipelineResult {
	/** Text to append to tool_result content */
	output: string;
	/** True if secrets found — block the agent */
	isError: boolean;
	/** True if file was modified by format/autofix */
	fileModified: boolean;
}

// --- Phase timing helpers ---

interface PhaseTracker {
	start(name: string): void;
	end(name: string, metadata?: Record<string, unknown>): void;
}

function createPhaseTracker(toolName: string, filePath: string): PhaseTracker {
	const phases: Array<{
		name: string;
		startTime: number;
		ended: boolean;
	}> = [];

	return {
		start(name: string) {
			phases.push({ name, startTime: Date.now(), ended: false });
		},
		end(name: string, metadata?: Record<string, unknown>) {
			const p = phases.find((x) => x.name === name && !x.ended);
			if (p) {
				p.ended = true;
				logLatency({
					type: "phase",
					toolName,
					filePath,
					phase: name,
					durationMs: Date.now() - p.startTime,
					metadata,
				});
			}
		},
	};
}

// --- ESLint autofix helpers ---

const ESLINT_CONFIGS = [
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.json",
	".eslintrc.yaml",
	".eslintrc.yml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
];

const JSTS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

function isJsTs(filePath: string): boolean {
	return JSTS_EXTS.has(path.extname(filePath).toLowerCase());
}

function hasEslintConfig(cwd: string): boolean {
	for (const cfg of ESLINT_CONFIGS) {
		if (nodeFs.existsSync(path.join(cwd, cfg))) return true;
	}
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.eslintConfig) return true;
	} catch {}
	return false;
}

let _eslintAvailable: boolean | null = null;
let _eslintBin: string | null = null;

function findEslintBin(cwd: string): string {
	const isWin = process.platform === "win32";
	const local = path.join(
		cwd,
		"node_modules",
		".bin",
		isWin ? "eslint.cmd" : "eslint",
	);
	if (nodeFs.existsSync(local)) return local;
	return "eslint";
}

/**
 * Run eslint --fix on a file. Returns number of fixable issues resolved,
 * or 0 if ESLint is not configured / not available.
 */
async function tryEslintFix(filePath: string, cwd: string): Promise<number> {
	if (!hasEslintConfig(cwd)) return 0;
	if (_eslintAvailable === false) return 0;
	if (_eslintAvailable === null) {
		const candidate = findEslintBin(cwd);
		const check = await safeSpawnAsync(candidate, ["--version"], {
			timeout: 5000,
			cwd,
		});
		_eslintAvailable = !check.error && check.status === 0;
		if (_eslintAvailable) _eslintBin = candidate;
	}
	if (!_eslintAvailable || !_eslintBin) return 0;
	const cmd = _eslintBin;
	// --fix-dry-run returns JSON with fixable counts without writing to disk.
	// Use it to get the real count, then apply with --fix only if needed.
	const dry = await safeSpawnAsync(
		cmd,
		[
			"--fix-dry-run",
			"--format",
			"json",
			"--no-error-on-unmatched-pattern",
			filePath,
		],
		{ timeout: 30000, cwd },
	);
	if (dry.status === 2) return 0;
	let fixableCount = 0;
	try {
		const results: Array<{
			fixableErrorCount?: number;
			fixableWarningCount?: number;
		}> = JSON.parse(dry.stdout);
		fixableCount = results.reduce(
			(sum, r) =>
				sum + (r.fixableErrorCount ?? 0) + (r.fixableWarningCount ?? 0),
			0,
		);
	} catch {}
	if (fixableCount === 0) return 0;
	// Apply the fixes
	const fix = await safeSpawnAsync(
		cmd,
		["--fix", "--no-error-on-unmatched-pattern", filePath],
		{ timeout: 30000, cwd },
	);
	if (fix.status === 2) return 0;
	return fixableCount;
}

// --- Main Pipeline ---

export async function runPipeline(
	ctx: PipelineContext,
	deps: PipelineDeps,
): Promise<PipelineResult> {
	const { filePath, cwd, toolName, getFlag, dbg } = ctx;
	const {
		biomeClient,
		ruffClient,
		testRunnerClient,
		metricsClient,
		getFormatService,
		fixedThisTurn,
	} = deps;

	const phase = createPhaseTracker(toolName, filePath);
	const pipelineStart = Date.now();
	phase.start("total");

	// --- Read file content ---
	phase.start("read_file");
	let fileContent: string | undefined;
	try {
		fileContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		// File may not exist (e.g., deleted)
	}
	phase.end("read_file");

	// --- 1. Secrets scan (blocking — early exit) ---
	if (fileContent) {
		const secretFindings = scanForSecrets(fileContent, filePath);
		if (secretFindings.length > 0) {
			const secretsOutput = formatSecrets(secretFindings, filePath);
			logLatency({
				type: "tool_result",
				toolName,
				filePath,
				durationMs: Date.now() - pipelineStart,
				result: "blocked_secrets",
				metadata: { secretsFound: secretFindings.length },
			});
			return {
				output: `\n\n${secretsOutput}`,
				isError: true,
				fileModified: false,
			};
		}
	}

	// --- 2. Auto-format ---
	phase.start("format");
	let formatChanged = false;
	let formattersUsed: string[] = [];
	if (!getFlag("no-autoformat") && fileContent) {
		const formatService = getFormatService();
		try {
			formatService.recordRead(filePath);
			const result = await formatService.formatFile(filePath);
			formattersUsed = result.formatters.map((f) => f.name);
			if (result.anyChanged) {
				formatChanged = true;
				dbg(
					`autoformat: ${result.formatters.map((f) => `${f.name}(${f.changed ? "changed" : "unchanged"})`).join(", ")}`,
				);
				fileContent = nodeFs.readFileSync(filePath, "utf-8");
			}
		} catch (err) {
			dbg(`autoformat error: ${err}`);
		}
	}
	phase.end("format", { formattersUsed, formatChanged });

	// --- 3. LSP file sync ---
	if (getFlag("lens-lsp") && fileContent) {
		const lspService = getLSPService();
		lspService
			.hasLSP(filePath)
			.then(async (hasLSP) => {
				if (hasLSP) {
					if (toolName === "write") {
						await lspService.openFile(filePath, fileContent);
					} else {
						await lspService.updateFile(filePath, fileContent);
					}
				}
			})
			.catch((err) => {
				dbg(`LSP error: ${err}`);
			});
	}

	let output = "";

	// --- 4. Auto-fix ---
	// Biome (TS/JS) and Ruff (Python) never touch the same file, so their
	// availability checks can run in parallel.
	phase.start("autofix");
	const noAutofix = getFlag("no-autofix");
	const noAutofixBiome = getFlag("no-autofix-biome");
	const noAutofixRuff = getFlag("no-autofix-ruff");
	let fixedCount = 0;

	if (!fixedThisTurn.has(filePath) && !noAutofix) {
		const [ruffReady, biomeReady] = await Promise.all([
			!noAutofixRuff && ruffClient.isPythonFile(filePath)
				? ruffClient.ensureAvailable()
				: Promise.resolve(false),
			!noAutofixBiome && biomeClient.isSupportedFile(filePath)
				? biomeClient.ensureAvailable()
				: Promise.resolve(false),
		]);

		if (ruffReady) {
			const result = ruffClient.fixFile(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				fixedThisTurn.add(filePath);
				dbg(`autofix: ruff fixed ${result.fixed} issue(s) in ${filePath}`);
			}
		}

		if (biomeReady) {
			const result = biomeClient.fixFile(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				fixedThisTurn.add(filePath);
				dbg(`autofix: biome fixed ${result.fixed} issue(s) in ${filePath}`);
			}
		}
	}
	// ESLint --fix: only for jsts files in projects that use ESLint
	if (!noAutofix && isJsTs(filePath)) {
		const eslintFixed = await tryEslintFix(filePath, cwd);
		if (eslintFixed > 0) {
			fixedCount += eslintFixed;
			fixedThisTurn.add(filePath);
			dbg(`autofix: eslint fixed ${eslintFixed} issue(s) in ${filePath}`);
		}
	}

	phase.end("autofix", { fixedCount, tools: ["ruff", "biome", "eslint"] });

	// --- 5. Dispatch lint ---
	phase.start("dispatch_lint");
	dbg(`dispatch: running lint tools for ${filePath}`);

	const piApi: PiAgentAPI = {
		getFlag: getFlag as (flag: string) => boolean | string | undefined,
	};

	const dispatchResult = await dispatchLintWithResult(filePath, cwd, piApi);

	if (dispatchResult.output) {
		output += `\n\n${dispatchResult.output}`;
	}

	if (fixedCount > 0) {
		output += `\n\n✅ Auto-fixed ${fixedCount} issue(s) in ${path.basename(filePath)}`;
	}

	if (formatChanged || fixedCount > 0) {
		output += `\n\n⚠️ **File modified by auto-format/fix. Re-read before next edit.**`;
	}
	phase.end("dispatch_lint", {
		hasOutput: !!dispatchResult.output,
		diagnosticCount: dispatchResult.diagnostics.length,
	});

	// --- 6. Test runner ---
	phase.start("test_runner");
	let testInfoFound = false;
	let testRunnerRan = false;
	if (!getFlag("no-tests")) {
		const testInfo = testRunnerClient.findTestFile(filePath, cwd);
		testInfoFound = !!testInfo;
		if (testInfo) {
			dbg(`test-runner: found test file ${testInfo.testFile} for ${filePath}`);
			const detectedRunner = testRunnerClient.detectRunner(cwd);
			if (detectedRunner) {
				testRunnerRan = true;
				const testStart = Date.now();
				// Use async variant — keeps the event loop free while tests run
				// so LSP messages and other file writes proceed concurrently.
				const testResult = await testRunnerClient.runTestFileAsync(
					testInfo.testFile,
					cwd,
					detectedRunner.runner,
					detectedRunner.config,
				);
				const testDuration = Date.now() - testStart;
				logLatency({
					type: "phase",
					toolName,
					filePath,
					phase: "test_runner",
					durationMs: testDuration,
					metadata: {
						testFile: testInfo.testFile,
						runner: detectedRunner.runner,
						success: !testResult?.error,
					},
				});
				if (testResult && !testResult.error) {
					const testOutput = testRunnerClient.formatResult(testResult);
					if (testOutput) {
						output += `\n\n${testOutput}`;
					}
				}
			}
		}
	}
	phase.end("test_runner", { found: testInfoFound, ran: testRunnerRan });

	// --- 7. Cascade diagnostics (LSP only) ---
	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		const MAX_CASCADE_FILES = 5;
		const MAX_DIAGNOSTICS_PER_FILE = 20;
		const cascadeStart = Date.now();

		try {
			const lspService = getLSPService();
			const allDiags = await lspService.getAllDiagnostics();
			const normalizedEditedPath = path.resolve(filePath);
			const otherFileErrors: Array<{
				file: string;
				errors: import("./lsp/client.js").LSPDiagnostic[];
			}> = [];

			for (const [diagPath, diags] of allDiags) {
				if (path.resolve(diagPath) === normalizedEditedPath) continue;
				const errors = diags.filter((d) => d.severity === 1);
				if (errors.length > 0) {
					otherFileErrors.push({ file: diagPath, errors });
				}
			}

			if (otherFileErrors.length > 0) {
				output += `\n\n📐 Cascade errors detected in ${otherFileErrors.length} other file(s):`;
				for (const { file, errors } of otherFileErrors.slice(
					0,
					MAX_CASCADE_FILES,
				)) {
					const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
					const suffix =
						errors.length > MAX_DIAGNOSTICS_PER_FILE
							? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
							: "";
					output += `\n<diagnostics file="${file}">`;
					for (const e of limited) {
						const line = (e.range?.start?.line ?? 0) + 1;
						const col = (e.range?.start?.character ?? 0) + 1;
						const code = e.code ? ` [${e.code}]` : "";
						output += `\n  ${code} (${line}:${col}) ${e.message.split("\n")[0].slice(0, 100)}`;
					}
					output += `${suffix}\n</diagnostics>`;
				}
				if (otherFileErrors.length > MAX_CASCADE_FILES) {
					output += `\n... and ${otherFileErrors.length - MAX_CASCADE_FILES} more files with errors`;
				}
			}

			logLatency({
				type: "phase",
				toolName,
				filePath,
				phase: "cascade_diagnostics",
				durationMs: Date.now() - cascadeStart,
				metadata: { filesWithErrors: otherFileErrors.length },
			});
		} catch (err) {
			dbg(`cascade diagnostics error: ${err}`);
		}
	}

	// --- Final timing ---
	const elapsed = Date.now() - pipelineStart;
	phase.end("total", { hasOutput: !!output });

	logLatency({
		type: "tool_result",
		toolName,
		filePath,
		durationMs: elapsed,
		result: output ? "completed" : "no_output",
	});

	return {
		output,
		isError: false,
		fileModified: formatChanged || fixedCount > 0,
	};
}
