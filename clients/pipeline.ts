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
import {
	computeImpactCascadeForFile,
	dispatchLintWithResult,
} from "./dispatch/integration.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import {
	resolveCommandArgsWithInstallFallback,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "./dispatch/runners/utils/runner-helpers.js";
import type { PiAgentAPI } from "./dispatch/types.js";
import { detectFileKind, getFileKindLabel } from "./file-kinds.js";
import { detectFileChangedAfterCommand } from "./file-utils.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import { getLSPService } from "./lsp/index.js";
import type { MetricsClient } from "./metrics-client.js";
import { normalizeMapKey } from "./path-utils.js";
import type { RuffClient } from "./ruff-client.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { formatSecrets, scanForSecrets } from "./secrets-scanner.js";
import {
	getAutofixPolicyForFile,
	getPreferredAutofixTools,
	getRubocopCommand,
	hasEslintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
} from "./tool-policy.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

function exceedsLspSyncLimits(
	_filePath: string,
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
	impactCascadeOutput?: string;
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

const JSTS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const CSS_EXTS = new Set([".css", ".scss", ".sass", ".less"]);
const RUBY_EXTS = new Set([".rb", ".rake", ".gemspec", ".ru"]);
const SQL_EXTS = new Set([".sql"]);
const AUTOFIX_EXTS = new Set([
	...JSTS_EXTS,
	".json",
	".jsonc",
	...CSS_EXTS,
	".py",
	".pyi",
	...RUBY_EXTS,
	...SQL_EXTS,
	".kt",
	".kts",
	".rs",
	".dart",
]);

function supportsAutofix(filePath: string): boolean {
	return AUTOFIX_EXTS.has(path.extname(filePath).toLowerCase());
}

export {
	hasEslintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
};

const _eslintCache = new Map<
	string,
	{ available: boolean; bin: string | null }
>();

/**
 * Run eslint --fix on a file. Returns number of fixable issues resolved,
 * or 0 if ESLint is not configured / not available.
 */
async function tryEslintFix(filePath: string, cwd: string): Promise<number> {
	const userHasConfig = hasEslintConfig(cwd);
	if (!userHasConfig) return 0;
	const cacheKey = path.resolve(cwd);
	let cached = _eslintCache.get(cacheKey);
	if (!cached) {
		const candidate = resolveToolCommand(cwd, "eslint") ?? "eslint";
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
	const configArgs: string[] = [];
	// --fix-dry-run returns JSON with fixable counts without writing to disk.
	// Use it to get the real count, then apply with --fix only if needed.
	const dry = await safeSpawnAsync(
		cmd,
		[
			"--fix-dry-run",
			"--format",
			"json",
			"--no-error-on-unmatched-pattern",
			...configArgs,
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
	} catch {
		/* treat as zero fixable on error */
	}
	if (fixableCount === 0) return 0;
	// Apply the fixes
	const fix = await safeSpawnAsync(
		cmd,
		["--fix", "--no-error-on-unmatched-pattern", ...configArgs, filePath],
		{ timeout: 30000, cwd },
	);
	if (fix.status === 2) return 0;
	return fixableCount;
}

async function tryStylelintFix(filePath: string, cwd: string): Promise<number> {
	const cmd = await resolveToolCommandWithInstallFallback(cwd, "stylelint");
	if (!cmd) return 0;

	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["--fix", "--allow-empty-input", filePath],
		cwd,
		[2],
	);
}

async function trySqlfluffFix(filePath: string, cwd: string): Promise<number> {
	const cmd = await resolveToolCommandWithInstallFallback(cwd, "sqlfluff");
	if (!cmd) return 0;

	const args = ["fix", "--force", filePath];
	if (!hasSqlfluffConfig(cwd)) {
		args.splice(2, 0, "--dialect", "ansi");
	}
	return detectFileChangedAfterCommand(filePath, cmd, args, cwd);
}

async function tryRubocopFix(filePath: string, cwd: string): Promise<number> {
	const resolved = await resolveCommandArgsWithInstallFallback(
		getRubocopCommand(cwd),
		"rubocop",
		cwd,
		["--version"],
		10000,
	);
	if (!resolved) return 0;

	return detectFileChangedAfterCommand(
		filePath,
		resolved.cmd,
		[...resolved.args, "-a", "--no-color", filePath],
		cwd,
		[1],
	);
}

async function tryKtlintFix(filePath: string, cwd: string): Promise<number> {
	const cmd = await resolveToolCommandWithInstallFallback(cwd, "ktlint");
	if (!cmd) return 0;

	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["-F", filePath],
		cwd,
		[1],
	);
}

async function tryRustClippyFix(
	filePath: string,
	_cwd: string,
): Promise<number> {
	const check = await safeSpawnAsync("cargo", ["--version"], { timeout: 5000 });
	if (check.error || check.status !== 0) return 0;

	let dir = path.dirname(path.resolve(filePath));
	const root = path.parse(dir).root;
	let cargoDir: string | undefined;
	while (dir !== root) {
		if (nodeFs.existsSync(path.join(dir, "Cargo.toml"))) {
			cargoDir = dir;
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!cargoDir) return 0;

	return detectFileChangedAfterCommand(
		filePath,
		"cargo",
		["clippy", "--fix", "--allow-dirty", "--allow-staged", "-q"],
		cargoDir,
		[0],
	);
}

async function tryDartFix(filePath: string, _cwd: string): Promise<number> {
	const check = await safeSpawnAsync("dart", ["--version"], { timeout: 5000 });
	if (check.error || check.status !== 0) return 0;

	let dir = path.dirname(path.resolve(filePath));
	const root = path.parse(dir).root;
	let pubspecDir: string | undefined;
	while (dir !== root) {
		if (nodeFs.existsSync(path.join(dir, "pubspec.yaml"))) {
			pubspecDir = dir;
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!pubspecDir) return 0;

	return detectFileChangedAfterCommand(
		filePath,
		"dart",
		["fix", "--apply"],
		pubspecDir,
		[0],
	);
}

// --- Pipeline phase helpers ---

async function syncLspFile(
	filePath: string,
	fileContent: string,
	_cwd: string,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
	_ruffClient: RuffClient,
	_biomeClient: BiomeClient,
): Promise<{ completed: boolean; phaseEnded: boolean }> {
	if (getFlag("no-lsp")) {
		return { completed: true, phaseEnded: false };
	}

	const deferLspSync = !getFlag("no-autofix") && supportsAutofix(filePath);

	if (deferLspSync) {
		return { completed: true, phaseEnded: true };
	}

	const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
	if (limitCheck.tooLarge) {
		dbg(`LSP sync skipped for ${filePath}: ${limitCheck.reason}`);
		return { completed: true, phaseEnded: false };
	}

	try {
		const lspService = getLSPService();
		const hasLSP = await lspService.hasLSP(filePath);
		if (hasLSP) {
			await lspService.openFile(filePath, fileContent);
		}
	} catch (err) {
		dbg(`LSP sync error: ${err}`);
	}
	return { completed: true, phaseEnded: false };
}

async function runAutofix(
	filePath: string,
	cwd: string,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
	deps: Pick<PipelineDeps, "biomeClient" | "ruffClient" | "fixedThisTurn">,
): Promise<{
	fixedCount: number;
	autofixTools: string[];
	attemptedTools: string[];
	needsContentRefresh: boolean;
	skipReason?: string;
}> {
	const { biomeClient, ruffClient, fixedThisTurn } = deps;
	const noAutofix = getFlag("no-autofix");
	let fixedCount = 0;
	const autofixTools: string[] = [];
	const attemptedTools: string[] = [];
	let needsContentRefresh = false;

	if (fixedThisTurn.has(filePath)) {
		dbg(`autofix: skipped for ${filePath} (already fixed this turn)`);
		return {
			fixedCount,
			autofixTools,
			attemptedTools,
			needsContentRefresh,
			skipReason: "already_fixed_this_turn",
		};
	}

	if (noAutofix) {
		dbg(`autofix: skipped for ${filePath} (--no-autofix)`);
		return {
			fixedCount,
			autofixTools,
			attemptedTools,
			needsContentRefresh,
			skipReason: "disabled_by_flag",
		};
	}

	const autofixContext = {
		hasEslintConfig: hasEslintConfig(cwd),
		hasStylelintConfig: hasStylelintConfig(cwd),
		hasSqlfluffConfig: hasSqlfluffConfig(cwd),
		hasRubocopConfig: hasRubocopConfig(cwd),
	};
	const autofixPolicy = getAutofixPolicyForFile(filePath, autofixContext);
	const preferredAutofixTools = autofixPolicy?.safe
		? getPreferredAutofixTools(filePath, autofixContext)
		: [];

	dbg(
		`autofix: policy for ${filePath} -> ${autofixPolicy?.defaultTool ?? "none"} ` +
			`(preferred: ${preferredAutofixTools.join(",") || "none"}, gate: ${autofixPolicy?.gate ?? "none"}, safe: ${autofixPolicy?.safe ? "yes" : "no"})`,
	);

	if (!autofixPolicy) {
		dbg(`autofix: no policy for ${filePath}`);
		return {
			fixedCount,
			autofixTools,
			attemptedTools,
			needsContentRefresh,
			skipReason: "no_policy",
		};
	}

	if (!autofixPolicy.safe || preferredAutofixTools.length === 0) {
		dbg(`autofix: no safe preferred tools for ${filePath}`);
		return {
			fixedCount,
			autofixTools,
			attemptedTools,
			needsContentRefresh,
			skipReason: "no_safe_tools",
		};
	}

	for (const toolName of preferredAutofixTools) {
		attemptedTools.push(toolName);
		if (toolName === "ruff") {
			const ruffReady = ruffClient.isPythonFile(filePath)
				? await ruffClient.ensureAvailable()
				: false;
			if (!ruffReady) {
				dbg(`autofix: ruff unavailable for ${filePath}`);
				continue;
			}
			const result = await ruffClient.fixFileAsync(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				autofixTools.push(`ruff:${result.fixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: ruff fixed ${result.fixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "biome") {
			const biomeReady = biomeClient.isSupportedFile(filePath)
				? await biomeClient.ensureAvailable()
				: false;
			if (!biomeReady) {
				dbg(`autofix: biome unavailable or unsupported for ${filePath}`);
				continue;
			}
			const result = await biomeClient.fixFileAsync(filePath);
			if (result.success && result.fixed > 0) {
				fixedCount += result.fixed;
				autofixTools.push(`biome:${result.fixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: biome fixed ${result.fixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "eslint") {
			const eslintFixed = await tryEslintFix(filePath, cwd);
			if (eslintFixed > 0) {
				fixedCount += eslintFixed;
				autofixTools.push(`eslint:${eslintFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: eslint fixed ${eslintFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "stylelint") {
			const stylelintFixed = await tryStylelintFix(filePath, cwd);
			if (stylelintFixed > 0) {
				fixedCount += stylelintFixed;
				autofixTools.push(`stylelint:${stylelintFixed}`);
				fixedThisTurn.add(filePath);
				dbg(
					`autofix: stylelint fixed ${stylelintFixed} issue(s) in ${filePath}`,
				);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "sqlfluff") {
			const sqlfluffFixed = await trySqlfluffFix(filePath, cwd);
			if (sqlfluffFixed > 0) {
				fixedCount += sqlfluffFixed;
				autofixTools.push(`sqlfluff:${sqlfluffFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: sqlfluff fixed ${sqlfluffFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "rubocop") {
			const rubocopFixed = await tryRubocopFix(filePath, cwd);
			if (rubocopFixed > 0) {
				fixedCount += rubocopFixed;
				autofixTools.push(`rubocop:${rubocopFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: rubocop fixed ${rubocopFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "ktlint") {
			const ktlintFixed = await tryKtlintFix(filePath, cwd);
			if (ktlintFixed > 0) {
				fixedCount += ktlintFixed;
				autofixTools.push(`ktlint:${ktlintFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: ktlint fixed ${ktlintFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "rust-clippy") {
			const clippyFixed = await tryRustClippyFix(filePath, cwd);
			if (clippyFixed > 0) {
				fixedCount += clippyFixed;
				autofixTools.push(`rust-clippy:${clippyFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: rust-clippy fixed ${clippyFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "dart-analyze") {
			const dartFixed = await tryDartFix(filePath, cwd);
			if (dartFixed > 0) {
				fixedCount += dartFixed;
				autofixTools.push(`dart-analyze:${dartFixed}`);
				fixedThisTurn.add(filePath);
				dbg(`autofix: dart fix applied ${dartFixed} change(s) in ${filePath}`);
				needsContentRefresh = true;
			}
		}
	}

	if (attemptedTools.length > 0 && autofixTools.length === 0) {
		dbg(
			`autofix: attempted ${attemptedTools.join(",")} for ${filePath}, but no fixes were applied`,
		);
	}

	return {
		fixedCount,
		autofixTools,
		attemptedTools,
		needsContentRefresh,
	};
}

async function resyncLspFile(
	filePath: string,
	fileContent: string,
	needsContentRefresh: boolean,
	lspSyncCompleted: boolean,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
	formatChanged = false,
): Promise<void> {
	if (getFlag("no-lsp")) return;
	if (!needsContentRefresh && lspSyncCompleted) return;

	const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
	if (limitCheck.tooLarge) return;

	try {
		const lspService = getLSPService();
		const hasLSP = await lspService.hasLSP(filePath);
		if (hasLSP) {
			// Format-only resyncs preserve the existing diagnostics cache so
			// waitForDiagnostics fast-paths instead of sitting the full 5s timeout
			// waiting for TypeScript to re-confirm what it already knows.
			await lspService.openFile(filePath, fileContent, {
				preserveDiagnostics: formatChanged,
			});
		}
	} catch (err) {
		dbg(`LSP resync after autofix error: ${err}`);
	}
}

export async function gatherCascadeDiagnostics(
	excludePaths: Set<string>,
	cwd: string,
	toolName: string,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
): Promise<string | undefined> {
	if (getFlag("no-lsp")) return undefined;

	const MAX_CASCADE_FILES = RUNTIME_CONFIG.pipeline.cascadeMaxFiles;
	const MAX_DIAGNOSTICS_PER_FILE =
		RUNTIME_CONFIG.pipeline.cascadeMaxDiagnosticsPerFile;
	const cascadeStart = Date.now();

	try {
		const CASCADE_TTL_MS = 240_000;
		const lspService = getLSPService();
		const allDiags = await lspService.getAllDiagnostics();
		const normalizedExcludePaths = new Set(
			[...excludePaths].map((p) => normalizeMapKey(resolveRunnerPath(cwd, p))),
		);
		const now = Date.now();
		let stalePathsSkipped = 0;
		const otherFileErrors: Array<{
			file: string;
			errors: import("./lsp/client.js").LSPDiagnostic[];
		}> = [];

		for (const [diagPath, { diags, ts }] of allDiags) {
			const normalizedDiagPath = resolveRunnerPath(cwd, diagPath);
			if (normalizedExcludePaths.has(normalizeMapKey(normalizedDiagPath)))
				continue;
			if (!nodeFs.existsSync(normalizedDiagPath)) {
				stalePathsSkipped++;
				continue;
			}
			if (now - ts > CASCADE_TTL_MS) {
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

		let cascadeOutput: string | undefined;
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
			filePath: [...excludePaths][0] ?? cwd,
			phase: "cascade_diagnostics",
			durationMs: Date.now() - cascadeStart,
			metadata: {
				filesWithErrors: otherFileErrors.length,
				stalePathsSkipped,
			},
		});

		return cascadeOutput;
	} catch (err) {
		dbg(`cascade diagnostics error: ${err}`);
		return undefined;
	}
}

type DispatchResult = Awaited<ReturnType<typeof dispatchLintWithResult>>;
function buildAllClearOutput(
	_dispatchResult: DispatchResult,
	elapsed: number,
	filePath: string,
): string {
	const kind = detectFileKind(filePath);
	const langLabel = kind ? getFileKindLabel(kind) : path.extname(filePath);
	const parts: string[] = [];

	if (kind) {
		parts.push(`${langLabel} clean`);
	}

	parts.push(`${elapsed}ms`);
	return `checkmark ${parts.join(" · ")}`.replace("checkmark", "\u2713");
}

// --- Main Pipeline ---

export async function runPipeline(
	ctx: PipelineContext,
	deps: PipelineDeps,
): Promise<PipelineResult> {
	const { filePath, cwd, toolName, getFlag, dbg } = ctx;
	const { biomeClient, ruffClient, getFormatService } = deps;

	const phase = createPhaseTracker(toolName, filePath);
	const pipelineStart = Date.now();
	phase.start("total");

	// --- 1. Read file content ---
	phase.start("read_file");
	let fileContent: string | undefined;
	try {
		fileContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		// File may not exist (e.g., deleted)
	}
	phase.end("read_file");

	// --- 2. Secrets scan (blocking — early exit) ---
	if (fileContent) {
		const secretFindings = scanForSecrets(fileContent, filePath);
		if (secretFindings.length > 0) {
			logLatency({
				type: "tool_result",
				toolName,
				filePath,
				durationMs: Date.now() - pipelineStart,
				result: "blocked_secrets",
				metadata: { secretsFound: secretFindings.length },
			});
			return {
				output: `\n\n${formatSecrets(secretFindings, filePath)}`,
				hasBlockers: true,
				isError: true,
				fileModified: false,
			};
		}
	}

	// --- 3. Auto-format ---
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
			if (!result.allSucceeded) {
				const failures = result.formatters.filter((f) => !f.success);
				dbg(
					`autoformat: ${failures.map((f) => `${f.name} failed: ${f.error ?? "unknown error"}`).join("; ")}`,
				);
			}
		} catch (err) {
			dbg(`autoformat error: ${err}`);
		}
	}
	phase.end("format", { formattersUsed, formatChanged });

	// --- 4. LSP file sync ---
	// Awaited so that dispatch lint (phase 6) and cascade diagnostics (phase 8)
	// run with fresh LSP state. Fire-and-forget would cause stale diagnostics.
	phase.start("lsp_sync");
	let lspSyncCompleted = false;
	let lspPhaseEnded = false;
	if (fileContent) {
		const sync = await syncLspFile(
			filePath,
			fileContent,
			cwd,
			getFlag,
			dbg,
			ruffClient,
			biomeClient,
		);
		lspSyncCompleted = sync.completed;
		lspPhaseEnded = sync.phaseEnded;
	} else {
		lspSyncCompleted = true;
	}
	if (lspPhaseEnded) {
		phase.end("lsp_sync", { completed: true, deferred: true });
	} else {
		phase.end("lsp_sync", { completed: lspSyncCompleted });
	}

	// --- 5. Auto-fix ---
	// Biome (TS/JS) and Ruff (Python) never touch the same file, so their
	// availability checks run in parallel.
	phase.start("autofix");
	const {
		fixedCount,
		autofixTools,
		attemptedTools,
		needsContentRefresh: fixRefresh,
		skipReason: autofixSkipReason,
	} = await runAutofix(filePath, cwd, getFlag, dbg, deps);
	if (fixRefresh) needsContentRefresh = true;
	phase.end("autofix", {
		fixedCount,
		tools: autofixTools,
		attemptedTools,
		skipReason: autofixSkipReason,
	});

	if (needsContentRefresh) {
		try {
			fileContent = nodeFs.readFileSync(filePath, "utf-8");
		} catch {
			fileContent = undefined;
		}
	}

	// Re-sync LSP after format/autofix changes so dispatch uses current code.
	if (fileContent) {
		await resyncLspFile(
			filePath,
			fileContent,
			needsContentRefresh,
			lspSyncCompleted,
			getFlag,
			dbg,
			formatChanged && fixedCount === 0,
		);
	}

	// --- 6. Dispatch lint ---
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
		{
			model: ctx.telemetry?.model ?? "unknown",
			sessionId: ctx.telemetry?.sessionId ?? "unknown",
			turnIndex: ctx.telemetry?.turnIndex ?? 0,
			writeIndex: ctx.telemetry?.writeIndex ?? 0,
		},
	);
	const hasBlockers = dispatchResult.hasBlockers;

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
			logger.logCaught(
				d,
				{
					model: ctx.telemetry?.model ?? "unknown",
					sessionId: ctx.telemetry?.sessionId ?? "unknown",
					turnIndex: ctx.telemetry?.turnIndex ?? 0,
					writeIndex: ctx.telemetry?.writeIndex ?? 0,
				},
				inlineKeys.has(toKey(d)),
			);
		}
	}

	if (fixedCount > 0) getDiagnosticTracker().trackAutoFixed(fixedCount);
	if (dispatchResult.resolvedCount > 0)
		getDiagnosticTracker().trackAgentFixed(dispatchResult.resolvedCount);

	let output = "";
	if (dispatchResult.output) output += `\n\n${dispatchResult.output}`;
	if (fixedCount > 0) {
		const detail =
			autofixTools.length > 0 ? ` (${autofixTools.join(", ")})` : "";
		output += `\n\n✅ Auto-fixed ${fixedCount} issue(s)${detail}`;
	}
	if (formatChanged || fixedCount > 0) {
		output += `\n\n⚠️ **File was modified by auto-format/fix. You MUST re-read the file before making any further edits — the content on disk has changed (whitespace, indentation, quotes, or code). Editing from memory will produce mismatches.**`;
	}
	phase.end("dispatch_lint", {
		hasOutput: !!dispatchResult.output,
		diagnosticCount: dispatchResult.diagnostics.length,
	});

	// --- 7. Cascade diagnostics (LSP only) ---
	// Deferred: cascade errors in OTHER files are NOT shown inline — surfaced at
	// turn_end so mid-refactor intermediate errors don't derail the agent.
	const cascadeOutput = await gatherCascadeDiagnostics(
		new Set([filePath]),
		cwd,
		toolName,
		getFlag,
		dbg,
	);
	const impactCascadeOutput = await computeImpactCascadeForFile(filePath, cwd);

	// --- Final timing + all-clear ---
	const elapsed = Date.now() - pipelineStart;
	if (!output) {
		output = buildAllClearOutput(dispatchResult, elapsed, filePath);
	}

	phase.end("total", { hasOutput: !!output });

	return {
		output,
		hasBlockers,
		cascadeOutput,
		impactCascadeOutput,
		isError: false,
		fileModified: formatChanged || fixedCount > 0,
	};
}
