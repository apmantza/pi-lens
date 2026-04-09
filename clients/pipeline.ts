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
import { getDiagnosticLogger } from "./diagnostic-logger.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { dispatchLintWithResult } from "./dispatch/integration.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import type { PiAgentAPI } from "./dispatch/types.js";
import { detectFileKind, getFileKindLabel } from "./file-kinds.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { getLSPService } from "./lsp/index.js";
import type { MetricsClient } from "./metrics-client.js";
import { normalizeMapKey } from "./path-utils.js";
import type { RuffClient } from "./ruff-client.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { formatSecrets, scanForSecrets } from "./secrets-scanner.js";
import type { TestRunnerClient } from "./test-runner-client.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

function exceedsLspSyncLimits(
	filePath: string,
	content: string,
): {
	tooLarge: boolean;
	reason: string;
} {
	const sizeBytes = Buffer.byteLength(content, "utf-8");
	if (sizeBytes > LSP_MAX_FILE_BYTES) {
		return {
			tooLarge: true,
			reason: `${Math.round(sizeBytes / 1024)}KB exceeds ${Math.round(LSP_MAX_FILE_BYTES / 1024)}KB`,
		};
	}

	const lineCount = content.split("\n").length;
	if (lineCount > LSP_MAX_FILE_LINES) {
		return {
			tooLarge: true,
			reason: `${lineCount} lines exceeds ${LSP_MAX_FILE_LINES}`,
		};
	}

	return { tooLarge: false, reason: "" };
}

// --- Types ---

export interface PipelineContext {
	filePath: string;
	cwd: string;
	toolName: string;
	modifiedRanges?: { start: number; end: number }[];
	telemetry?: {
		model: string;
		sessionId: string;
		turnIndex: number;
		writeIndex: number;
	};
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
	/** True if blocking diagnostics/tests were found */
	hasBlockers: boolean;
	/**
	 * Cascade diagnostics (errors in OTHER files caused by this edit).
	 * Intentionally NOT included in output — surfaced at turn_end instead
	 * so mid-refactor intermediate errors don't derail the agent.
	 */
	cascadeOutput?: string;
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

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

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

function hasBiomeConfig(cwd: string): boolean {
	for (const cfg of BIOME_CONFIGS) {
		if (nodeFs.existsSync(path.join(cwd, cfg))) return true;
	}
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.devDependencies?.["@biomejs/biome"]) return true;
	} catch {}
	return false;
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

const _eslintCache = new Map<
	string,
	{ available: boolean; bin: string | null }
>();

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
	const cacheKey = path.resolve(cwd);
	let cached = _eslintCache.get(cacheKey);
	if (!cached) {
		const candidate = findEslintBin(cwd);
		const check = await safeSpawnAsync(candidate, ["--version"], {
			timeout: 5000,
			cwd,
		});
		cached = {
			available: !check.error && check.status === 0,
			bin: !check.error && check.status === 0 ? candidate : null,
		};
		_eslintCache.set(cacheKey, cached);
	}
	if (!cached.available || !cached.bin) return 0;
	const cmd = cached.bin;
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
				hasBlockers: true,
				isError: true,
				fileModified: false,
			};
		}
	}

	// --- 2. Auto-format ---
	phase.start("format");
	let formatChanged = false;
	let formattersUsed: string[] = [];
	let needsContentRefresh = false;
	if (!getFlag("no-autoformat") && fileContent) {
		const formatService = getFormatService();
		try {
			formatService.recordRead(filePath);
			const result = await formatService.formatFile(filePath);
			formattersUsed = result.formatters.map((f) => f.name);
			if (result.anyChanged) {
				formatChanged = true;
				needsContentRefresh = true;
				dbg(
					`autoformat: ${result.formatters.map((f) => `${f.name}(${f.changed ? "changed" : "unchanged"})`).join(", ")}`,
				);
			}
		} catch (err) {
			dbg(`autoformat error: ${err}`);
		}
	}
	phase.end("format", { formattersUsed, formatChanged });

	// --- 3. LSP file sync ---
	// Awaited so that dispatch lint (phase 5) and cascade diagnostics
	// (phase 7) run with fresh LSP state, not stale diagnostics.
	// Fire-and-forget would cause cascade diagnostics to see pre-write state.
	phase.start("lsp_sync");
	let lspSyncCompleted = false;
	let lspPhaseEnded = false;
	if (getFlag("lens-lsp") && !getFlag("no-lsp") && fileContent) {
		const deferLspSync =
			!getFlag("no-autofix") &&
			(ruffClient.isPythonFile(filePath) ||
				(biomeClient.isSupportedFile(filePath) && hasBiomeConfig(cwd)) ||
				isJsTs(filePath));

		if (deferLspSync) {
			lspSyncCompleted = true;
			phase.end("lsp_sync", { completed: true, deferred: true });
			lspPhaseEnded = true;
		} else {
			const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
			if (limitCheck.tooLarge) {
				dbg(`LSP sync skipped for ${filePath}: ${limitCheck.reason}`);
				lspSyncCompleted = true;
			} else {
				const lspService = getLSPService();
				try {
					const hasLSP = await lspService.hasLSP(filePath);
					if (hasLSP) {
						// Always go through openFile. The client dedupes duplicate didOpen
						// by converting to didChange when already open.
						await lspService.openFile(filePath, fileContent);
					}
					lspSyncCompleted = true;
				} catch (err) {
					dbg(`LSP sync error: ${err}`);
					lspSyncCompleted = true; // Continue even if LSP fails
				}
			}
		}
	} else {
		lspSyncCompleted = true;
	}
	if (!lspPhaseEnded) {
		phase.end("lsp_sync", { completed: lspSyncCompleted });
	}

	let output = "";
	const autofixTools: string[] = []; // track which tools fixed something
	let testSummary: { passed: number; total: number; failed: number } | null =
		null;
	let hasBlockers = false;

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
			!noAutofixBiome &&
			biomeClient.isSupportedFile(filePath) &&
			hasBiomeConfig(cwd)
				? biomeClient.ensureAvailable()
				: Promise.resolve(false),
		]);

		if (ruffReady) {
			const result = await ruffClient.fixFileAsync(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				autofixTools.push(`ruff:${result.fixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: ruff fixed ${result.fixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
		}

		if (biomeReady) {
			const result = await biomeClient.fixFileAsync(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				autofixTools.push(`biome:${result.fixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: biome fixed ${result.fixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
		}
	}
	// ESLint --fix: only for jsts files in projects that use ESLint
	if (!noAutofix && isJsTs(filePath)) {
		const eslintFixed = await tryEslintFix(filePath, cwd);
		if (eslintFixed > 0) {
			fixedCount += eslintFixed;
			autofixTools.push(`eslint:${eslintFixed}`);
			fixedThisTurn.add(filePath);
			dbg(`autofix: eslint fixed ${eslintFixed} issue(s) in ${filePath}`);
			needsContentRefresh = true;
		}
	}

	phase.end("autofix", { fixedCount, tools: ["ruff", "biome", "eslint"] });

	if (needsContentRefresh) {
		try {
			fileContent = nodeFs.readFileSync(filePath, "utf-8");
		} catch {
			fileContent = undefined;
		}
	}

	// Re-sync LSP after format/autofix changes so dispatch uses current code,
	// not diagnostics from the pre-fix snapshot.
	if (
		getFlag("lens-lsp") &&
		!getFlag("no-lsp") &&
		fileContent &&
		(needsContentRefresh || !lspSyncCompleted)
	) {
		const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
		if (!limitCheck.tooLarge) {
			try {
				const lspService = getLSPService();
				const hasLSP = await lspService.hasLSP(filePath);
				if (hasLSP) {
					await lspService.openFile(filePath, fileContent);
				}
			} catch (err) {
				dbg(`LSP resync after autofix error: ${err}`);
			}
		}
	}

	// --- 5. Dispatch lint ---
	phase.start("dispatch_lint");
	dbg(`dispatch: running lint tools for ${filePath}`);

	const piApi: PiAgentAPI = {
		getFlag: getFlag as (flag: string) => boolean | string | undefined,
	};

	const dispatchResult = await dispatchLintWithResult(
		filePath,
		cwd,
		piApi,
		ctx.modifiedRanges,
	);
	hasBlockers = dispatchResult.hasBlockers;

	// Log and track diagnostics for analytics
	if (dispatchResult.diagnostics.length > 0) {
		const logger = getDiagnosticLogger();
		const tracker = getDiagnosticTracker();
		tracker.trackShown(dispatchResult.diagnostics);
		const toKey = (d: (typeof dispatchResult.diagnostics)[number]) =>
			[
				d.tool || "",
				d.id || "",
				d.rule || "",
				d.filePath || "",
				d.line || 0,
				d.column || 0,
			].join("|");
		const inlineKeys = new Set(
			[...dispatchResult.blockers, ...dispatchResult.fixed]
				.filter((d) => d.tool !== "similarity")
				.map(toKey),
		);
		for (const d of dispatchResult.diagnostics) {
			const shownInline = inlineKeys.has(toKey(d));
			logger.logCaught(
				d,
				{
					model: ctx.telemetry?.model ?? "unknown",
					sessionId: ctx.telemetry?.sessionId ?? "unknown",
					turnIndex: ctx.telemetry?.turnIndex ?? 0,
					writeIndex: ctx.telemetry?.writeIndex ?? 0,
				},
				shownInline,
			);
		}
	}

	if (fixedCount > 0) {
		const tracker = getDiagnosticTracker();
		tracker.trackAutoFixed(fixedCount);
	}

	if (dispatchResult.resolvedCount > 0) {
		const tracker = getDiagnosticTracker();
		tracker.trackAgentFixed(dispatchResult.resolvedCount);
	}

	if (dispatchResult.output) {
		output += `\n\n${dispatchResult.output}`;
	}

	if (fixedCount > 0) {
		const detail =
			autofixTools.length > 0 ? ` (${autofixTools.join(", ")})` : "";
		output += `\n\n✅ Auto-fixed ${fixedCount} issue(s)${detail}`;
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
		const target = testRunnerClient.getTestRunTarget(filePath, cwd);
		testInfoFound = !!target;
		if (target) {
			dbg(
				`test-runner: ${target.strategy} target ${target.testFile} (${target.runner}) for ${filePath}`,
			);
			testRunnerRan = true;
			const testStart = Date.now();
			// Use async variant — keeps the event loop free while tests run
			// so LSP messages and other file writes proceed concurrently.
			const testResult = await testRunnerClient.runTestFileAsync(
				target.testFile,
				cwd,
				target.runner,
				target.config,
			);
			const testDuration = Date.now() - testStart;
			logLatency({
				type: "phase",
				toolName,
				filePath,
				phase: "test_runner",
				durationMs: testDuration,
				metadata: {
					testFile: target.testFile,
					runner: target.runner,
					strategy: target.strategy,
					success: !testResult?.error,
				},
			});
			if (testResult && !testResult.error) {
				testSummary = {
					passed: testResult.passed,
					total: testResult.passed + testResult.failed + testResult.skipped,
					failed: testResult.failed,
				};
				if (testSummary.failed > 0) {
					hasBlockers = true;
				}
				const testOutput = testRunnerClient.formatResult(testResult);
				if (testOutput) {
					output += `\n\n${testOutput}`;
				}
			}
		}
	}
	phase.end("test_runner", { found: testInfoFound, ran: testRunnerRan });

	// --- 7. Cascade diagnostics (LSP only) ---
	// Deferred: cascade errors are errors in OTHER files caused by this edit.
	// They are NOT shown inline (mid-refactor they are always noisy — agent is
	// still editing the other files). Returned in cascadeOutput so index.ts can
	// surface the LAST snapshot at turn_end once all edits in the turn are done.
	let cascadeOutput: string | undefined;
	if (getFlag("lens-lsp") && !getFlag("no-lsp")) {
		const MAX_CASCADE_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;
		const MAX_DIAGNOSTICS_PER_FILE =
			RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
		const cascadeStart = Date.now();

		try {
			const lspService = getLSPService();
			const allDiags = await lspService.getAllDiagnostics();
			const normalizedEditedPath = resolveRunnerPath(cwd, filePath);
			let stalePathsSkipped = 0;
			const otherFileErrors: Array<{
				file: string;
				errors: import("./lsp/client.js").LSPDiagnostic[];
			}> = [];

			for (const [diagPath, diags] of allDiags) {
				const normalizedDiagPath = resolveRunnerPath(cwd, diagPath);
				if (normalizeMapKey(normalizedDiagPath) === normalizedEditedPath)
					continue;

				if (!nodeFs.existsSync(normalizedDiagPath)) {
					stalePathsSkipped++;
					continue;
				}

				const errors = diags.filter((d) => d.severity === 1);
				if (errors.length > 0) {
					otherFileErrors.push({
						file: toRunnerDisplayPath(cwd, normalizedDiagPath),
						errors,
					});
				}
			}

			otherFileErrors.sort((a, b) => b.errors.length - a.errors.length);

			if (otherFileErrors.length > 0) {
				let c = `📐 Cascade errors in ${otherFileErrors.length} other file(s) — fix before finishing turn:`;
				for (const { file, errors } of otherFileErrors.slice(
					0,
					MAX_CASCADE_FILES,
				)) {
					const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
					const suffix =
						errors.length > MAX_DIAGNOSTICS_PER_FILE
							? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
							: "";
					c += `\n<diagnostics file="${file}">`;
					for (const e of limited) {
						const line = (e.range?.start?.line ?? 0) + 1;
						const col = (e.range?.start?.character ?? 0) + 1;
						const code = e.code ? ` code=${String(e.code)}` : "";
						c += `\n  line ${line}, col ${col}${code}: ${e.message.split("\n")[0].slice(0, 100)}`;
					}
					c += `${suffix}\n</diagnostics>`;
				}
				if (otherFileErrors.length > MAX_CASCADE_FILES) {
					c += `\n... and ${otherFileErrors.length - MAX_CASCADE_FILES} more files with errors`;
				}
				cascadeOutput = c;
			}

			logLatency({
				type: "phase",
				toolName,
				filePath,
				phase: "cascade_diagnostics",
				durationMs: Date.now() - cascadeStart,
				metadata: {
					filesWithErrors: otherFileErrors.length,
					stalePathsSkipped,
				},
			});
		} catch (err) {
			dbg(`cascade diagnostics error: ${err}`);
		}
	}

	// --- Final timing ---
	const elapsed = Date.now() - pipelineStart;

	// --- All-clear / warnings notice ---
	// When no blocking output exists, emit a one-liner so the agent knows
	// checks actually ran and what the result was.
	if (!output) {
		const kind = detectFileKind(filePath);
		const langLabel = kind ? getFileKindLabel(kind) : path.extname(filePath);
		const parts: string[] = [];

		if (dispatchResult.warnings.length > 0) {
			// Has non-blocking warnings — show delta count (new vs total)
			const newWarnings = dispatchResult.warnings.length;
			const totalWarnings = newWarnings + dispatchResult.baselineWarningCount;
			const totalStr =
				totalWarnings === newWarnings
					? `${totalWarnings} warning(s)`
					: `${newWarnings} new (${totalWarnings} total)`;
			parts.push(`no blockers`);
			parts.push(`${totalStr} -> /lens-booboo`);
		} else if (kind) {
			parts.push(`${langLabel} clean`);
		}

		if (testSummary) {
			if (testSummary.failed === 0) {
				parts.push(`${testSummary.passed}/${testSummary.total} tests`);
			}
			// failing tests already have their own output above — skip here
		}

		parts.push(`${elapsed}ms`);
		output = `checkmark ${parts.join(" · ")}`.replace("checkmark", "\u2713");
	}

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
		hasBlockers,
		cascadeOutput,
		isError: false,
		fileModified: formatChanged || fixedCount > 0,
	};
}
