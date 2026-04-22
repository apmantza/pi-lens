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
import type { PiAgentAPI } from "./dispatch/types.js";
import { detectFileKind, getFileKindLabel } from "./file-kinds.js";
import { detectFileChangedAfterCommand } from "./file-utils.js";
import type { FormatService } from "./format-service.js";
import { ensureTool } from "./installer/index.js";
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

const STYLELINT_CONFIGS = [
	".stylelintrc",
	".stylelintrc.json",
	".stylelintrc.jsonc",
	".stylelintrc.yaml",
	".stylelintrc.yml",
	".stylelintrc.js",
	".stylelintrc.cjs",
	"stylelint.config.js",
	"stylelint.config.cjs",
	"stylelint.config.mjs",
];

const SQLFLUFF_CONFIGS = [
	".sqlfluff",
	"pyproject.toml",
	"setup.cfg",
	"tox.ini",
];

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
]);

function isJsTs(filePath: string): boolean {
	return JSTS_EXTS.has(path.extname(filePath).toLowerCase());
}

function isCssLike(filePath: string): boolean {
	return CSS_EXTS.has(path.extname(filePath).toLowerCase());
}

function isRubyLike(filePath: string): boolean {
	return RUBY_EXTS.has(path.extname(filePath).toLowerCase());
}

function isSqlFile(filePath: string): boolean {
	return SQL_EXTS.has(path.extname(filePath).toLowerCase());
}

function supportsAutofix(filePath: string): boolean {
	return AUTOFIX_EXTS.has(path.extname(filePath).toLowerCase());
}

export function hasEslintConfig(cwd: string): boolean {
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

export function hasStylelintConfig(cwd: string): boolean {
	if (STYLELINT_CONFIGS.some((cfg) => nodeFs.existsSync(path.join(cwd, cfg)))) {
		return true;
	}
	try {
		const pkg = JSON.parse(
			nodeFs.readFileSync(path.join(cwd, "package.json"), "utf-8"),
		);
		if (pkg.stylelint) return true;
	} catch {}
	return false;
}

export function hasSqlfluffConfig(cwd: string): boolean {
	for (const cfg of SQLFLUFF_CONFIGS) {
		const cfgPath = path.join(cwd, cfg);
		if (!nodeFs.existsSync(cfgPath)) continue;
		if (cfg === "pyproject.toml") {
			try {
				const content = nodeFs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[tool.sqlfluff]")) return true;
			} catch {}
			continue;
		}
		if (cfg === "setup.cfg" || cfg === "tox.ini") {
			try {
				const content = nodeFs.readFileSync(cfgPath, "utf-8");
				if (content.includes("[sqlfluff]")) return true;
			} catch {}
			continue;
		}
		return true;
	}

	for (const depFile of ["requirements.txt", "Pipfile", "pyproject.toml"]) {
		const depPath = path.join(cwd, depFile);
		if (!nodeFs.existsSync(depPath)) continue;
		try {
			const content = nodeFs.readFileSync(depPath, "utf-8").toLowerCase();
			if (content.includes("sqlfluff")) return true;
		} catch {}
	}

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

function findStylelintBin(cwd: string): string {
	const isWin = process.platform === "win32";
	const local = path.join(
		cwd,
		"node_modules",
		".bin",
		isWin ? "stylelint.cmd" : "stylelint",
	);
	if (nodeFs.existsSync(local)) return local;
	return "stylelint";
}

function findRubocopCommand(cwd: string): { cmd: string; args: string[] } {
	const gemfile = path.join(cwd, "Gemfile");
	if (nodeFs.existsSync(gemfile)) {
		try {
			const content = nodeFs.readFileSync(gemfile, "utf-8");
			if (content.includes("rubocop")) {
				return { cmd: "bundle", args: ["exec", "rubocop"] };
			}
		} catch {}
	}
	return { cmd: "rubocop", args: [] };
}

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
	if (!hasStylelintConfig(cwd)) return 0;
	let cmd = findStylelintBin(cwd);
	let versionCheck = await safeSpawnAsync(cmd, ["--version"], {
		timeout: 5000,
		cwd,
	});
	if (versionCheck.error || versionCheck.status !== 0) {
		const installed = await ensureTool("stylelint");
		if (!installed) return 0;
		cmd = installed;
		versionCheck = await safeSpawnAsync(cmd, ["--version"], {
			timeout: 5000,
			cwd,
		});
		if (versionCheck.error || versionCheck.status !== 0) return 0;
	}

	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["--fix", "--allow-empty-input", filePath],
		cwd,
		[2],
	);
}

async function trySqlfluffFix(filePath: string, cwd: string): Promise<number> {
	let cmd = "sqlfluff";
	let versionCheck = await safeSpawnAsync(cmd, ["--version"], {
		timeout: 5000,
		cwd,
	});
	if (versionCheck.error || versionCheck.status !== 0) {
		const installed = await ensureTool("sqlfluff");
		if (!installed) return 0;
		cmd = installed;
		versionCheck = await safeSpawnAsync(cmd, ["--version"], {
			timeout: 5000,
			cwd,
		});
		if (versionCheck.error || versionCheck.status !== 0) return 0;
	}

	const args = ["fix", "--force", filePath];
	if (!hasSqlfluffConfig(cwd)) {
		args.splice(2, 0, "--dialect", "ansi");
	}
	return detectFileChangedAfterCommand(filePath, cmd, args, cwd);
}

async function tryRubocopFix(filePath: string, cwd: string): Promise<number> {
	const { cmd, args } = findRubocopCommand(cwd);
	let versionCheck = await safeSpawnAsync(cmd, [...args, "--version"], {
		timeout: 10000,
		cwd,
	});
	if (versionCheck.error || versionCheck.status !== 0) {
		const installed = await ensureTool("rubocop");
		if (!installed) return 0;
		versionCheck = await safeSpawnAsync(cmd, [...args, "--version"], {
			timeout: 10000,
			cwd,
		});
		if (versionCheck.error || versionCheck.status !== 0) return 0;
	}

	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		[...args, "-a", "--no-color", filePath],
		cwd,
		[1],
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
	needsContentRefresh: boolean;
}> {
	const { biomeClient, ruffClient, fixedThisTurn } = deps;
	const noAutofix = getFlag("no-autofix");
	let fixedCount = 0;
	const autofixTools: string[] = [];
	let needsContentRefresh = false;

	if (!fixedThisTurn.has(filePath) && !noAutofix) {
		const preferEslintForJsTs = isJsTs(filePath) && hasEslintConfig(cwd);
		const [ruffReady, biomeReady] = await Promise.all([
			ruffClient.isPythonFile(filePath)
				? ruffClient.ensureAvailable()
				: Promise.resolve(false),
			biomeClient.isSupportedFile(filePath) && !preferEslintForJsTs
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

	if (!noAutofix && isJsTs(filePath) && hasEslintConfig(cwd)) {
		const eslintFixed = await tryEslintFix(filePath, cwd);
		if (eslintFixed > 0) {
			fixedCount += eslintFixed;
			autofixTools.push(`eslint:${eslintFixed}`);
			fixedThisTurn.add(filePath);
			dbg(`autofix: eslint fixed ${eslintFixed} issue(s) in ${filePath}`);
			needsContentRefresh = true;
		}
	}

	if (!noAutofix && isCssLike(filePath)) {
		const stylelintFixed = await tryStylelintFix(filePath, cwd);
		if (stylelintFixed > 0) {
			fixedCount += stylelintFixed;
			autofixTools.push(`stylelint:${stylelintFixed}`);
			fixedThisTurn.add(filePath);
			dbg(`autofix: stylelint fixed ${stylelintFixed} issue(s) in ${filePath}`);
			needsContentRefresh = true;
		}
	}

	if (!noAutofix && isSqlFile(filePath)) {
		const sqlfluffFixed = await trySqlfluffFix(filePath, cwd);
		if (sqlfluffFixed > 0) {
			fixedCount += sqlfluffFixed;
			autofixTools.push(`sqlfluff:${sqlfluffFixed}`);
			fixedThisTurn.add(filePath);
			dbg(`autofix: sqlfluff fixed ${sqlfluffFixed} issue(s) in ${filePath}`);
			needsContentRefresh = true;
		}
	}

	if (!noAutofix && isRubyLike(filePath)) {
		const rubocopFixed = await tryRubocopFix(filePath, cwd);
		if (rubocopFixed > 0) {
			fixedCount += rubocopFixed;
			autofixTools.push(`rubocop:${rubocopFixed}`);
			fixedThisTurn.add(filePath);
			dbg(`autofix: rubocop fixed ${rubocopFixed} issue(s) in ${filePath}`);
			needsContentRefresh = true;
		}
	}

	return { fixedCount, autofixTools, needsContentRefresh };
}

async function resyncLspFile(
	filePath: string,
	fileContent: string,
	needsContentRefresh: boolean,
	lspSyncCompleted: boolean,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
): Promise<void> {
	if (getFlag("no-lsp")) return;
	if (!needsContentRefresh && lspSyncCompleted) return;

	const limitCheck = exceedsLspSyncLimits(filePath, fileContent);
	if (limitCheck.tooLarge) return;

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
type TestSummary = { passed: number; total: number; failed: number } | null;

function buildAllClearOutput(
	_dispatchResult: DispatchResult,
	testSummary: TestSummary,
	elapsed: number,
	filePath: string,
): string {
	const kind = detectFileKind(filePath);
	const langLabel = kind ? getFileKindLabel(kind) : path.extname(filePath);
	const parts: string[] = [];

	if (kind) {
		parts.push(`${langLabel} clean`);
	}

	if (testSummary && testSummary.failed === 0) {
		parts.push(`${testSummary.passed}/${testSummary.total} tests`);
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
	const { biomeClient, ruffClient, testRunnerClient, getFormatService } = deps;

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
	if (!lspPhaseEnded) {
		phase.end("lsp_sync", { completed: lspSyncCompleted });
	} else {
		phase.end("lsp_sync", { completed: true, deferred: true });
	}

	// --- 5. Auto-fix ---
	// Biome (TS/JS) and Ruff (Python) never touch the same file, so their
	// availability checks run in parallel.
	phase.start("autofix");
	const {
		fixedCount,
		autofixTools,
		needsContentRefresh: fixRefresh,
	} = await runAutofix(filePath, cwd, getFlag, dbg, deps);
	if (fixRefresh) needsContentRefresh = true;
	phase.end("autofix", { fixedCount, tools: autofixTools });

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
	let hasBlockers = dispatchResult.hasBlockers;

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
		output += `\n\n⚠️ **File modified by auto-format/fix. Re-read before next edit.**`;
	}
	phase.end("dispatch_lint", {
		hasOutput: !!dispatchResult.output,
		diagnosticCount: dispatchResult.diagnostics.length,
	});

	// --- 7. Test runner ---
	phase.start("test_runner");
	let testSummary: TestSummary = null;
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
			const testResult = await testRunnerClient.runTestFileAsync(
				target.testFile,
				cwd,
				target.runner,
				target.config,
			);
			logLatency({
				type: "phase",
				toolName,
				filePath,
				phase: "test_runner",
				durationMs: Date.now() - testStart,
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
				if (testSummary.failed > 0) hasBlockers = true;
				const testOutput = testRunnerClient.formatResult(testResult);
				if (testOutput) output += `\n\n${testOutput}`;
			}
		}
	}
	phase.end("test_runner", { found: testInfoFound, ran: testRunnerRan });

	// --- 8. Cascade diagnostics (LSP only) ---
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
		output = buildAllClearOutput(
			dispatchResult,
			testSummary,
			elapsed,
			filePath,
		);
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
