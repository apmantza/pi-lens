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
import { clearGraphCache } from "./review-graph/builder.js";
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
import {
	detectFileChangedAfterCommand,
	isExcludedDirName,
} from "./file-utils.js";
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
	hasBiomeConfig,
	hasEslintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
} from "./tool-policy.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const AUTOFIX_CHANGED_FILE_SCAN_LIMIT = 5000;

type FileSnapshot = Map<string, { mtimeMs: number; size: number }>;

function snapshotProjectFiles(root: string): FileSnapshot {
	const snapshot: FileSnapshot = new Map();
	const stack = [path.resolve(root)];
	while (stack.length > 0 && snapshot.size < AUTOFIX_CHANGED_FILE_SCAN_LIMIT) {
		const dir = stack.pop()!;
		let entries: nodeFs.Dirent[];
		try {
			entries = nodeFs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!isExcludedDirName(entry.name)) stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const stat = nodeFs.statSync(fullPath);
				snapshot.set(path.resolve(fullPath), {
					mtimeMs: stat.mtimeMs,
					size: stat.size,
				});
			} catch {
				// ignore vanished files
			}
		}
	}
	return snapshot;
}

function diffProjectSnapshot(root: string, before: FileSnapshot): string[] {
	const after = snapshotProjectFiles(root);
	const changed = new Set<string>();
	for (const [filePath, next] of after) {
		const prev = before.get(filePath);
		if (!prev || prev.mtimeMs !== next.mtimeMs || prev.size !== next.size) {
			changed.add(filePath);
		}
	}
	for (const filePath of before.keys()) {
		if (!after.has(filePath)) changed.add(filePath);
	}
	return [...changed].sort((a, b) => a.localeCompare(b));
}

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
	/** Files modified by pi-lens format/autofix, including side-effect files. */
	changedFiles?: string[];
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

async function tryRustClippyFix(filePath: string): Promise<string[]> {
	const check = await safeSpawnAsync("cargo", ["--version"], { timeout: 5000 });
	if (check.error || check.status !== 0) return [];

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
	if (!cargoDir) return [];

	const before = snapshotProjectFiles(cargoDir);
	const result = await safeSpawnAsync(
		"cargo",
		["clippy", "--fix", "--allow-dirty", "--allow-staged", "-q"],
		{ timeout: 30000, cwd: cargoDir },
	);
	if (result.error || result.status !== 0) return [];
	return diffProjectSnapshot(cargoDir, before);
}

async function tryDartFix(filePath: string): Promise<string[]> {
	const check = await safeSpawnAsync("dart", ["--version"], { timeout: 5000 });
	if (check.error || check.status !== 0) return [];

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
	if (!pubspecDir) return [];

	const before = snapshotProjectFiles(pubspecDir);
	const result = await safeSpawnAsync("dart", ["fix", "--apply"], {
		timeout: 30000,
		cwd: pubspecDir,
	});
	if (result.error || result.status !== 0) return [];
	return diffProjectSnapshot(pubspecDir, before);
}

// --- Pipeline phase helpers ---

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
	changedFiles: string[];
	needsContentRefresh: boolean;
	skipReason?: string;
}> {
	const { biomeClient, ruffClient, fixedThisTurn } = deps;
	const noAutofix = getFlag("no-autofix");
	let fixedCount = 0;
	const autofixTools: string[] = [];
	const attemptedTools: string[] = [];
	const changedFiles = new Set<string>();
	const markTargetChanged = () => changedFiles.add(path.resolve(filePath));
	let needsContentRefresh = false;

	if (fixedThisTurn.has(filePath)) {
		dbg(`autofix: skipped for ${filePath} (already fixed this turn)`);
		return {
			fixedCount,
			autofixTools,
			attemptedTools,
			changedFiles: [],
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
			changedFiles: [],
			needsContentRefresh,
			skipReason: "disabled_by_flag",
		};
	}

	const autofixContext = {
		hasEslintConfig: hasEslintConfig(cwd),
		hasStylelintConfig: hasStylelintConfig(cwd),
		hasSqlfluffConfig: hasSqlfluffConfig(cwd),
		hasRubocopConfig: hasRubocopConfig(cwd),
		hasBiomeConfig: hasBiomeConfig(cwd),
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
			changedFiles: [],
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
			changedFiles: [],
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
				markTargetChanged();
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
				markTargetChanged();
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
				markTargetChanged();
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
				markTargetChanged();
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
				markTargetChanged();
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
				markTargetChanged();
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
				markTargetChanged();
				dbg(`autofix: ktlint fixed ${ktlintFixed} issue(s) in ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "rust-clippy") {
			const clippyChangedFiles = await tryRustClippyFix(filePath);
			if (clippyChangedFiles.length > 0) {
				fixedCount += clippyChangedFiles.length;
				autofixTools.push(`rust-clippy:${clippyChangedFiles.length}`);
				fixedThisTurn.add(filePath);
				for (const changedFile of clippyChangedFiles)
					changedFiles.add(changedFile);
				dbg(
					`autofix: rust-clippy changed ${clippyChangedFiles.length} file(s) from ${filePath}`,
				);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "dart-analyze") {
			const dartChangedFiles = await tryDartFix(filePath);
			if (dartChangedFiles.length > 0) {
				fixedCount += dartChangedFiles.length;
				autofixTools.push(`dart-analyze:${dartChangedFiles.length}`);
				fixedThisTurn.add(filePath);
				for (const changedFile of dartChangedFiles)
					changedFiles.add(changedFile);
				dbg(
					`autofix: dart fix changed ${dartChangedFiles.length} file(s) from ${filePath}`,
				);
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
		changedFiles: [...changedFiles],
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
		if (lspService.supportsLSP(filePath)) {
			// Format-only resyncs preserve the existing diagnostics cache so
			// waitForDiagnostics fast-paths instead of sitting the full 5s timeout
			// waiting for TypeScript to re-confirm what it already knows.
			if (formatChanged) {
				await lspService.openFile(filePath, fileContent, {
					preserveDiagnostics: true,
				});
			} else {
				await lspService.openFile(filePath, fileContent);
			}
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
	const { getFormatService } = deps;

	const phase = createPhaseTracker(toolName, filePath);
	const pipelineStart = Date.now();
	clearGraphCache();
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
				changedFiles: [],
			};
		}
	}

	// --- 3. Auto-format ---
	phase.start("format");
	let formatChanged = false;
	let formattersUsed: string[] = [];
	const formatFailures: string[] = [];
	const piChangedFiles = new Set<string>();
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
				piChangedFiles.add(path.resolve(filePath));
				try {
					fileContent = nodeFs.readFileSync(filePath, "utf-8");
				} catch {
					fileContent = undefined;
				}
			}
			if (!result.allSucceeded) {
				const failures = result.formatters.filter((f) => !f.success);
				formatFailures.push(
					...failures.map((f) => `${f.name}: ${f.error ?? "unknown error"}`),
				);
				dbg(
					`autoformat: ${failures.map((f) => `${f.name} failed: ${f.error ?? "unknown error"}`).join("; ")}`,
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			formatFailures.push(message);
			dbg(`autoformat error: ${err}`);
		}
	}
	phase.end("format", { formattersUsed, formatChanged });

	// --- 4. Auto-fix ---
	phase.start("autofix");
	const {
		fixedCount,
		autofixTools,
		attemptedTools,
		changedFiles: autofixChangedFiles,
		needsContentRefresh: fixRefresh,
		skipReason: autofixSkipReason,
	} = await runAutofix(filePath, cwd, getFlag, dbg, deps);
	for (const changedFile of autofixChangedFiles) {
		piChangedFiles.add(path.resolve(changedFile));
	}
	if (fixRefresh) {
		try {
			fileContent = nodeFs.readFileSync(filePath, "utf-8");
		} catch {
			fileContent = undefined;
		}
	}
	phase.end("autofix", {
		fixedCount,
		tools: autofixTools,
		attemptedTools,
		skipReason: autofixSkipReason,
	});

	// --- 5. LSP file sync ---
	// Sync once with final post-format/post-fix content so dispatch and cascade
	// diagnostics do not observe stale pre-format text.
	phase.start("lsp_sync");
	let lspSyncCompleted = false;
	if (fileContent) {
		await resyncLspFile(
			filePath,
			fileContent,
			true,
			false,
			getFlag,
			dbg,
			formatChanged && fixedCount === 0,
		);
		lspSyncCompleted = true;
	}
	phase.end("lsp_sync", { completed: lspSyncCompleted, finalContent: true });

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
	if (formatFailures.length > 0) {
		const details = formatFailures.slice(0, 3).join("; ");
		const suffix =
			formatFailures.length > 3
				? `; ... and ${formatFailures.length - 3} more`
				: "";
		output += `\n\n⚠️ Auto-format failed: ${details}${suffix}`;
	}
	if (formatChanged || fixedCount > 0) {
		const changedList = [...piChangedFiles].map((changedFile) =>
			toRunnerDisplayPath(cwd, changedFile),
		);
		const fileList = changedList.length
			? `\nModified files:\n${changedList
					.slice(0, 8)
					.map((f) => `  - ${f}`)
					.join(
						"\n",
					)}${changedList.length > 8 ? `\n  - ... and ${changedList.length - 8} more` : ""}`
			: "";
		output += `\n\n⚠️ **File was modified by auto-format/fix. You MUST re-read modified file(s) before making any further edits — the content on disk has changed (whitespace, indentation, quotes, or code). Editing from memory will produce mismatches.**${fileList}`;
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
		changedFiles: [...piChangedFiles],
	};
}
