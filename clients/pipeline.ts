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
import type { PiLensFlagSource } from "./lens-config.js";
import {
	findNearestContaining,
	normalizeEphemeralMapKey,
} from "./path-utils.js";
import {
	recordFromDispatchDiagnostic,
	type ActionableWarningRecord,
} from "./actionable-warnings.js";
import {
	recordFromCodeQualityDiagnostic,
	type CodeQualityWarningRecord,
} from "./code-quality-warnings.js";
import type { BiomeClient } from "./biome-client.js";
import { recordDiagnostics } from "./widget-state.js";
import { getDiagnosticLogger } from "./diagnostic-logger.js";
import { getDiagnosticTracker } from "./diagnostic-tracker.js";
import { loadDispatchIntegration } from "./dispatch/lazy.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import {
	type AvailabilityLatch,
	classifyProbeFailure,
	createAvailabilityChecker,
	createAvailabilityLatch,
	describeProbeEvidence,
	logAvailabilityDecision,
	startHostStallSampler,
	resolveAvailableOrInstall,
	resolveCommandArgsWithInstallFallback,
	resolveToolCommand,
	resolveToolCommandWithInstallFallback,
} from "./dispatch/runners/utils/runner-helpers.js";
import { findDetektConfig } from "./dispatch/runners/detekt.js";
import type { Diagnostic, PiAgentAPI } from "./dispatch/types.js";
import { detectFileKind, getFileKindLabel } from "./file-kinds.js";
import {
	detectFileChangedAfterCommand,
	getProjectIgnoreMatcher,
	isExcludedDirName,
} from "./file-utils.js";
import type { FormatService } from "./format-service.js";
import { logLatency } from "./latency-logger.js";
import type { PostAutofixNotice } from "./post-autofix-notice.js";
import { emitLensAnalysisComplete } from "./lens-events.js";
import { publishFilesTouched } from "./bus-publish.js";
import {
	publishDiagnostics,
	wasPreviouslyReportedDirty,
	type PilensDiagnosticEntry,
} from "./diagnostics-publish.js";
import { loadLspService } from "./lsp-lazy.js";
import type { MetricsClient } from "./metrics-client.js";
import { clearGraphCache } from "./review-graph/builder.js";
import { BoundedLruCache } from "./bounded-cache.js";
import type { RuffClient } from "./ruff-client.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import type { WordIndex } from "./word-index.js";
import { getAmbientAbortSignal, safeSpawnAsync } from "./safe-spawn.js";
import { bounded } from "./deadline-utils.js";
import { enabledAuxiliaryLspServerIds } from "./dispatch/auxiliary-lsp.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { dropFindingsForMissingPaths } from "./advisory-provenance.js";
import {
	getAutofixPolicyForFile,
	getPreferredAutofixTools,
	getRubocopCommand,
	hasBiomeConfig,
	hasDetektConfig,
	hasEslintConfig,
	hasGolangciConfig,
	hasKtfmtConfig,
	hasKtlintConfig,
	hasOxlintConfig,
	hasRubocopConfig,
	hasSqlfluffConfig,
	hasStylelintConfig,
	markdownlintConfigArgs,
} from "./tool-policy.js";
import type { PathSetLike } from "./runtime-coordinator.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const LSP_SPAWN_BUDGET_MS = RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs;
const AUTOFIX_CHANGED_FILE_SCAN_LIMIT = 5000;

/**
 * Hard ceiling for the pre-dispatch LSP sync (`resyncLspFile`). The sync sends a
 * didChange/didOpen; that write can backpressure indefinitely when the language
 * server's stdin isn't being drained (a wedged/CPU-bound server), which would
 * hang the whole edit with no per-call bound — client acquisition is capped, but
 * the notify write is not. So the sync is abandoned after this budget (the edit
 * proceeds; the dispatch LSP runner, which has its own 30s cap, still tries).
 */
function lspSyncBudgetMs(): number {
	const raw = Number(process.env.PI_LENS_LSP_SYNC_BUDGET_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 3000;
}

type FileSnapshot = Map<string, { mtimeMs: number; size: number }>;

// Scan one directory's entries into `snapshot`, pushing walkable subdirs onto
// `stack`. Extracted from the walk loop to keep each function's cognitive
// complexity low. Excluded/ignored dirs are not descended; ignored/vanished
// files are skipped.
// Files stat'd between event-loop yields. The walk stays on the tool_result
// hot path; yielding every N keeps its longest synchronous stretch well under
// the <50ms hook-burst budget even at the AUTOFIX_CHANGED_FILE_SCAN_LIMIT cap.
const SNAPSHOT_YIELD_EVERY = 500;

// Scan one directory's entries into `snapshot`, pushing walkable subdirs onto
// `stack`. Yields to the event loop every SNAPSHOT_YIELD_EVERY files (shared
// `counter`) so a single huge directory can't hold the loop. Excluded/ignored
// dirs are not descended; ignored/vanished files are skipped.
async function snapshotDirInto(
	dir: string,
	ignoreMatcher: ReturnType<typeof getProjectIgnoreMatcher>,
	stack: string[],
	snapshot: FileSnapshot,
	counter: { n: number },
): Promise<void> {
	let entries: nodeFs.Dirent[];
	try {
		// Async (#1137): a synchronous per-directory read blocks the loop for the
		// whole stall on a slow cloud-backed (OneDrive) directory; fs.promises
		// keeps this tool_result-path walk off the event loop.
		entries = await nodeFs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				!isExcludedDirName(entry.name) &&
				!ignoreMatcher.isIgnored(fullPath, true)
			) {
				stack.push(fullPath);
			}
			continue;
		}
		if (!entry.isFile()) continue;
		if (ignoreMatcher.isIgnored(fullPath, false)) continue;
		try {
			const stat = await nodeFs.promises.stat(fullPath);
			snapshot.set(path.resolve(fullPath), {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
			});
		} catch {
			// ignore vanished files
		}
		if (++counter.n % SNAPSHOT_YIELD_EVERY === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
}

// Exported for the event-loop occupancy guard (#361/#368): an O(files) walk on
// the tool_result autofix path, bounded by AUTOFIX_CHANGED_FILE_SCAN_LIMIT and
// chunk-yielding every SNAPSHOT_YIELD_EVERY files so it never blocks the TUI.
export async function snapshotProjectFiles(
	root: string,
): Promise<FileSnapshot> {
	const snapshot: FileSnapshot = new Map();
	const projectRoot = path.resolve(root);
	const ignoreMatcher = getProjectIgnoreMatcher(projectRoot);
	// #703: prime the tracked-files set once before the walk so a tracked file
	// matching a `.gitignore`/global pattern still shows up in the autofix
	// snapshot. Fail-open on no-git/spawn failure.
	await ignoreMatcher.ensureTrackedIndex();
	const stack = [projectRoot];
	const counter = { n: 0 };
	while (stack.length > 0 && snapshot.size < AUTOFIX_CHANGED_FILE_SCAN_LIMIT) {
		await snapshotDirInto(
			stack.pop()!,
			ignoreMatcher,
			stack,
			snapshot,
			counter,
		);
	}
	return snapshot;
}

async function diffProjectSnapshot(
	root: string,
	before: FileSnapshot,
): Promise<string[]> {
	const after = await snapshotProjectFiles(root);
	const changed = new Set<string>();
	for (const [filePath, next] of after) {
		const prev = before.get(filePath);
		if (prev?.mtimeMs !== next.mtimeMs || prev?.size !== next.size) {
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
	/** Language/tool root used for runner execution and config resolution. */
	cwd: string;
	/** Authoritative workspace root used for project-wide policy and state. */
	projectRoot?: string;
	toolName: string;
	/** Receipt-time decision; never infer this after debounce coalescing. */
	autofixMode?: "immediate" | "deferred";
	modifiedRanges?: { start: number; end: number }[];
	telemetry?: {
		model: string;
		sessionId: string;
		turnIndex: number;
		writeIndex: number;
		/** Raw model id / provider, separate from the combined `model` display
		 * string above — worklog attribution (#1448) wants the two apart. */
		modelId?: string;
		provider?: string;
	};
	/** pi.getFlag accessor */
	getFlag: (name: string, filePath?: string) => boolean | string | undefined;
	/**
	 * Optional: resolve which config tier (cli/project/global/default) decided
	 * a mutation flag's value, for provenance in dbg/skip logs (#792). Absent
	 * ⇒ logs omit the `source=` suffix (existing tests that don't wire this
	 * through keep passing unchanged).
	 */
	getFlagSource?: (name: string, filePath?: string) => PiLensFlagSource;
	/** Debug logger */
	dbg: (msg: string) => void;
	/**
	 * RuntimeCoordinator sequence state, threaded to the deferred cascade so the
	 * review-graph builder can skip its per-build O(project) walk+stat sweep when
	 * only pi-observed edits occurred since the last build (#451). `projectSeq` is
	 * a function (not a captured number) because the cascade runs AFTER this
	 * pipeline returns (#450) — it must read the CURRENT seq at build time.
	 * Absent ⇒ builder behaves exactly as before (full sweep).
	 */
	seqState?: {
		projectSeq: () => number;
		getFilesChangedSince: (seq: number) => string[];
	};
	/** Current turn_end cascade settle start, or undefined outside that wait. */
	turnEndCascadeSettleStart?: () => number | undefined;
	/**
	 * Live reference to `runtime.wordIndex` (#348 phase 2), threaded to the
	 * deferred cascade so it can update the warm in-memory word index at the
	 * same seam as the graph rebuild. `null`/absent ⇒ documented no-op (see
	 * `updateWordIndexForCascade` in dispatch/integration.ts) — never a
	 * synchronous build here.
	 */
	wordIndex?: WordIndex | null;
	/** Debounced-persist hook fired after a successful per-edit update. */
	onWordIndexUpdated?: (index: WordIndex) => void;
}

export interface PipelineDeps {
	biomeClient: BiomeClient;
	ruffClient: RuffClient;
	metricsClient: MetricsClient;
	getFormatService: () => FormatService;
	fixedThisTurn: PathSetLike;
}

export interface PipelineResult {
	/** Text to append to tool_result content */
	output: string;
	/** True if blocking diagnostics/tests were found */
	hasBlockers: boolean;
	/**
	 * Cascade diagnostics (errors in OTHER files caused by this edit).
	 * Runs concurrently AFTER the edit returns — the pipeline no longer awaits it,
	 * so it is off the write hot path. Intentionally NOT included in output;
	 * settled (bounded) and surfaced at turn_end so mid-refactor intermediate
	 * errors don't derail the agent. Never rejects (see the `.catch` below).
	 */
	cascadePromise?: Promise<import("./cascade-types.js").CascadeRun>;
	/** True if secrets found — block the agent */
	isError: boolean;
	/** True if file was modified by format/autofix */
	fileModified: boolean;
	/** Files modified by pi-lens format/autofix, including side-effect files. */
	changedFiles?: string[];
	/** Blocking-only formatted output for turn_end re-surfacing if agent didn't fix */
	inlineBlockerSummary?: string;
	/**
	 * #1561 F1: the distinct `tool` ids that raised the blockers in
	 * `inlineBlockerSummary`. Blockers span every runner, not just the language
	 * server, so a later verdict has to prove it covers these before it may
	 * retire the record (see `retireInlineBlockerOnConfirmedClean`).
	 */
	inlineBlockerSources?: string[];
	/**
	 * #1641 remainder: the 1-based cited lines of the blockers behind
	 * `inlineBlockerSummary`, carried structurally instead of re-parsed from the
	 * rendered text later. Cheap here — `dispatchResult.blockers` already has
	 * `.line` on each diagnostic from this same dispatch; re-deriving it by
	 * regexing the summary string at turn end would be the re-derivation-vs-
	 * correlation screen's exact failure shape (a line embedded in prose is not
	 * reliably parseable, and dispatcher-side rendering changes would silently
	 * break it). Omits entries with no line (a blocker that doesn't cite one,
	 * e.g. a whole-file secret finding).
	 */
	inlineBlockerLines?: number[];
	/** Fixable warning diagnostics introduced by this pipeline run. */
	actionableWarnings?: ActionableWarningRecord[];
	/** Non-fixable code-quality warnings introduced/touched by this pipeline run. */
	codeQualityWarnings?: CodeQualityWarningRecord[];
	/**
	 * Raw dispatch diagnostics surfaced this run (blockers + warnings + fixed),
	 * for #484 turn-summary collection. Same list `recordDiagnostics`/the
	 * diagnostic logger already consume — not a new collection path.
	 */
	diagnostics?: Diagnostic[];
	/** Immediate-mode formatters that actually changed this file this run. */
	formattersUsed?: string[];
	/** Count of autofix violations resolved this run (dispatch --fix runners). */
	fixedCount?: number;
	/** `tool:count` labels for autofix tools that ran this run. */
	autofixTools?: string[];
	/** Authoritative bytes after an immediate mutation of the target file. */
	postMutation?: { filePath: string; content: string; source: "autofix" };
	/**
	 * Data for the post-autofix "the file on disk changed" notice (#1590).
	 *
	 * The pipeline renders no sentence of its own here. Whether the
	 * authoritative bytes actually shipped is decided one layer up, in
	 * `handleToolResult`, which is the only place that sees the per-file
	 * attachment cap and the per-command aggregate budget. The pipeline
	 * therefore emits the DATA (display paths it already resolved) and
	 * `renderPostAutofixNotice` turns it into exactly one sentence under that
	 * one decision. Present when auto-format or autofix changed content.
	 */
	postAutofixNotice?: PostAutofixNotice;
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

/**
 * eslint autofix availability, per cwd + PATH. The verdict is owned by the
 * shared availability latch (#1494): a `missing` / `non-installable` outcome
 * sticks for the session, a timeout expires on a cooldown and is re-probed, so
 * one stalled probe cannot silently stop autofixing a project's JS/TS.
 */
const ESLINT_FIX_PROBE_BUDGET_MS = 5000;

const _eslintCache = new BoundedLruCache<
	string,
	{ latch: AvailabilityLatch; bin: string | null }
>(32);

/**
 * Run eslint --fix on a file. Runs a single spawn and diffs the file before/after,
 * same idiom as the other autofix helpers below. Exit code 1 (unfixable problems
 * remain) is allowed because fixes may still have been applied; only exit code 2
 * (config/fatal error) is treated as failure.
 * Returns 1 if the file changed, 0 if ESLint is not configured / not available /
 * made no changes.
 */
async function tryEslintFix(filePath: string, cwd: string): Promise<number> {
	const userHasConfig = hasEslintConfig(cwd);
	if (!userHasConfig) return 0;
	// PATH is part of command resolution; include it so an install or PATH
	// refresh cannot leave a negative eslint result live for the session.
	const cacheKey = `${path.resolve(cwd)}|${process.env.PATH ?? ""}`;
	let cached = _eslintCache.get(cacheKey);
	if (!cached) {
		cached = { latch: createAvailabilityLatch(), bin: null };
		_eslintCache.set(cacheKey, cached);
	}
	if (cached.latch.read() === null) {
		const candidate = resolveToolCommand(cwd, "eslint") ?? "eslint";
		// The budget is enforced by a HOST-side timer, so a stalled event loop
		// expires it while eslint is still healthy. Measure the overlapping stall
		// and hand it to the classifier, exactly like the runner path: without it a
		// host-stall timeout is re-caused as `probe-timeout` and gets the escalating
		// 30s→300s cooldown instead of the 5s host-stall one (#1467).
		const stallSampler = startHostStallSampler();
		const startedAt = Date.now();
		let check: Awaited<ReturnType<typeof safeSpawnAsync>>;
		let hostStallMs: number;
		try {
			check = await safeSpawnAsync(candidate, ["--version"], {
				timeout: ESLINT_FIX_PROBE_BUDGET_MS,
				cwd,
			});
		} finally {
			hostStallMs = stallSampler.stop();
		}
		const elapsedMs = Date.now() - startedAt;
		const decisionCwd = path.resolve(cwd);
		if (!check.error && check.status === 0) {
			cached.bin = candidate;
			cached.latch.noteAvailable();
			logAvailabilityDecision(
				{
					tool: "eslint",
					verdict: "available",
					outcome: "success",
					cause: "ok",
					elapsedMs,
					latched: true,
					hostStallMs,
					budgetMs: ESLINT_FIX_PROBE_BUDGET_MS,
					classifiedBy: "probe",
					evidence: describeProbeEvidence(check, "eslint"),
				},
				decisionCwd,
			);
		} else {
			cached.bin = null;
			const { outcome, cause, evidence } = classifyProbeFailure(check, {
				hostStallMs,
				command: "eslint",
			});
			const retryAfterMs = cached.latch.noteUnavailable(outcome, cause);
			logAvailabilityDecision(
				{
					tool: "eslint",
					verdict: "unavailable",
					outcome,
					cause,
					elapsedMs,
					latched: retryAfterMs === 0,
					hostStallMs,
					...(retryAfterMs > 0 && { retryAfterMs }),
					budgetMs: ESLINT_FIX_PROBE_BUDGET_MS,
					classifiedBy: "probe",
					evidence,
				},
				decisionCwd,
			);
		}
	}
	if (cached.latch.read() !== true || !cached.bin) return 0;
	const cmd = cached.bin;

	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["--fix", "--no-error-on-unmatched-pattern", filePath],
		cwd,
		[1],
	);
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

// golangci-lint/detekt/ktfmt have no TOOL_COMMAND_SPEC; resolve via availability
// checkers like their runners do.
const golangciAutofixChecker = createAvailabilityChecker(
	"golangci-lint",
	".exe",
);
const detektAutofixChecker = createAvailabilityChecker("detekt", ".bat");
const ktfmtAutofixChecker = createAvailabilityChecker("ktfmt", ".bat");

async function tryKtfmtFix(filePath: string, cwd: string): Promise<number> {
	// Config-first: the autofix policy only reaches here when the project opted
	// into ktfmt, so resolveAvailableOrInstall honors that gate. ktfmt writes the
	// formatted file in place and exits 0; treat any byte change as the fix.
	const cmd = await resolveAvailableOrInstall(
		ktfmtAutofixChecker,
		"ktfmt",
		cwd,
	);
	if (!cmd) return 0;
	const absPath = path.resolve(cwd, filePath);
	return detectFileChangedAfterCommand(filePath, cmd, [absPath], cwd, [0]);
}

async function tryGolangciLintFix(
	filePath: string,
	cwd: string,
): Promise<number> {
	// Config-first: the autofix policy only reaches here when a .golangci.* config
	// exists. resolveAvailableOrInstall honors that gate (won't auto-install a
	// config-first tool). golangci-lint exits non-zero when issues remain after
	// --fix, so allow its issue-found codes.
	const cmd = await resolveAvailableOrInstall(
		golangciAutofixChecker,
		"golangci-lint",
		cwd,
	);
	if (!cmd) return 0;
	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["run", "--fix", filePath],
		cwd,
		[1, 7],
	);
}

async function tryDetektFix(filePath: string, cwd: string): Promise<number> {
	const configPath = findDetektConfig(cwd);
	if (!configPath) return 0;
	if (!(await detektAutofixChecker.isAvailableAsync(cwd))) return 0;
	const cmd = detektAutofixChecker.getCommand(cwd);
	if (!cmd) return 0;
	const absPath = path.resolve(cwd, filePath);
	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["--auto-correct", "--input", absPath, "--config", configPath],
		cwd,
		[1, 2],
	);
}

export async function tryMarkdownlintFix(
	filePath: string,
	cwd: string,
): Promise<number> {
	const cmd = await resolveToolCommandWithInstallFallback(cwd, "markdownlint");
	if (!cmd) return 0;
	// Shared config-args seam (#1247): the lint runner consumes the same
	// builder, so the bare --fix here can never fall back to markdownlint's
	// default all-rules-on config again (the whole-file CHANGELOG/AGENTS
	// reformat + `#946` → `# 946` corruption).
	// markdownlint-cli2 --fix exits non-zero when unfixable violations remain.
	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		[...markdownlintConfigArgs(cwd), "--fix", filePath],
		cwd,
		[1],
	);
}

async function tryOxlintFix(filePath: string, cwd: string): Promise<number> {
	const cmd = await resolveToolCommandWithInstallFallback(cwd, "oxlint");
	if (!cmd) return 0;
	return detectFileChangedAfterCommand(
		filePath,
		cmd,
		["--fix", filePath],
		cwd,
		[1],
	);
}

async function tryRustClippyFix(filePath: string): Promise<string[]> {
	const check = await safeSpawnAsync("cargo", ["--version"], { timeout: 5000 });
	if (check.error || check.status !== 0) return [];

	const cargoDir = findNearestContaining(path.dirname(path.resolve(filePath)), [
		"Cargo.toml",
	]);
	if (!cargoDir) return [];

	const before = await snapshotProjectFiles(cargoDir);
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

	const pubspecDir = findNearestContaining(
		path.dirname(path.resolve(filePath)),
		["pubspec.yaml"],
	);
	if (!pubspecDir) return [];

	const before = await snapshotProjectFiles(pubspecDir);
	const result = await safeSpawnAsync("dart", ["fix", "--apply"], {
		timeout: 30000,
		cwd: pubspecDir,
	});
	if (result.error || result.status !== 0) return [];
	return diffProjectSnapshot(pubspecDir, before);
}

// --- Pipeline phase helpers ---

export async function runAutofix(
	filePath: string,
	cwd: string,
	getFlag: PipelineContext["getFlag"],
	dbg: PipelineContext["dbg"],
	deps: Pick<PipelineDeps, "biomeClient" | "ruffClient" | "fixedThisTurn">,
	getFlagSource?: PipelineContext["getFlagSource"],
): Promise<{
	fixedCount: number;
	autofixTools: string[];
	attemptedTools: string[];
	changedFiles: string[];
	needsContentRefresh: boolean;
	skipReason?: string;
}> {
	const { biomeClient, ruffClient, fixedThisTurn } = deps;
	const noAutofix = getFlag("no-autofix", filePath);
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
		const source = getFlagSource?.("no-autofix", filePath);
		dbg(
			`autofix: skipped for ${filePath} (--no-autofix${source ? `, source=${source}` : ""})`,
		);
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
		hasGolangciConfig: hasGolangciConfig(cwd),
		hasDetektConfig: hasDetektConfig(cwd),
		hasKtfmtConfig: hasKtfmtConfig(cwd),
		hasKtlintConfig: hasKtlintConfig(cwd),
		hasOxlintConfig: hasOxlintConfig(cwd),
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
			const result = await ruffClient.fixFileAsync(filePath, cwd);
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
			const result = await biomeClient.fixFileAsync(filePath, cwd);
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
			continue;
		}

		if (toolName === "golangci-lint") {
			const fixed = await tryGolangciLintFix(filePath, cwd);
			if (fixed > 0) {
				fixedCount += fixed;
				autofixTools.push(`golangci-lint:${fixed}`);
				fixedThisTurn.add(filePath);
				markTargetChanged();
				dbg(`autofix: golangci-lint fixed ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "detekt") {
			const fixed = await tryDetektFix(filePath, cwd);
			if (fixed > 0) {
				fixedCount += fixed;
				autofixTools.push(`detekt:${fixed}`);
				fixedThisTurn.add(filePath);
				markTargetChanged();
				dbg(`autofix: detekt --auto-correct fixed ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "ktfmt") {
			const fixed = await tryKtfmtFix(filePath, cwd);
			if (fixed > 0) {
				fixedCount += fixed;
				autofixTools.push(`ktfmt:${fixed}`);
				fixedThisTurn.add(filePath);
				markTargetChanged();
				dbg(`autofix: ktfmt formatted ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "markdownlint") {
			const fixed = await tryMarkdownlintFix(filePath, cwd);
			if (fixed > 0) {
				fixedCount += fixed;
				autofixTools.push(`markdownlint:${fixed}`);
				fixedThisTurn.add(filePath);
				markTargetChanged();
				dbg(`autofix: markdownlint --fix fixed ${filePath}`);
				needsContentRefresh = true;
			}
			continue;
		}

		if (toolName === "oxlint") {
			const fixed = await tryOxlintFix(filePath, cwd);
			if (fixed > 0) {
				fixedCount += fixed;
				autofixTools.push(`oxlint:${fixed}`);
				fixedThisTurn.add(filePath);
				markTargetChanged();
				dbg(`autofix: oxlint --fix fixed ${filePath}`);
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

export async function resyncLspFile(
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
		const lspService = (await loadLspService()).getLSPService();
		if (lspService.supportsLSP(filePath)) {
			// Push the final post-format/post-fix content through touchFile (not the
			// bare openFile) so it registers in the touch-debounce map via
			// markTouched. The dispatch-lsp-runner's touchFile fires ~80ms later with
			// identical content; registering this push makes its shouldSkipNotify
			// return true, so it reuses the diagnostics THIS push triggers instead of
			// re-clearing the cache and forcing the server to recompute from scratch —
			// the dominant per-edit LSP latency (#203). diagnostics:"none" keeps this
			// call non-blocking; the dispatch runner owns the diagnostics wait. We let
			// the cache clear (no preserveDiagnostics) so the wait resolves on fresh,
			// correctly-positioned diagnostics rather than stale pre-edit ones — the
			// didChange triggers a server recompute regardless of cache preservation.
			//
			// The touch is client-wait-capped, but its didChange/didOpen *write* can
			// backpressure forever on a wedged server (stdin not drained), which would
			// hang the whole edit with no bound and — until this — no log. Race it
			// against a hard budget + the turn's abort signal (Escape): whichever wins,
			// the edit proceeds. A wedged server no longer parks the pipeline.
			const budgetMs = lspSyncBudgetMs();
			const abort = getAmbientAbortSignal();
			if (abort?.aborted) return;

			// #2540: Kick off auxiliary server acquisition concurrently and unawaited
			// with the ambient turn signal so auxiliary warmup overlaps with the primary
			// server during resync. Leaves the single-occupancy deferred slot (#2509)
			// free for actionable-warnings while Escape mid-turn abandons the wait.
			const auxServerIds = enabledAuxiliaryLspServerIds(getFlag);
			if (auxServerIds.length > 0) {
				void lspService
					.getAuxiliaryClientsForFile(
						filePath,
						new Set(auxServerIds),
						undefined,
						LSP_SPAWN_BUDGET_MS,
						abort,
						"tool_result_edit",
					)
					.catch(() => {});
			}

			const startedAt = Date.now();
			const touch = lspService
				.touchFile(filePath, fileContent, {
					diagnostics: "none",
					source: "lsp_sync",
					clientScope: "primary",
					maxClientWaitMs: LSP_SPAWN_BUDGET_MS,
				})
				.then(() => "done" as const)
				.catch((err) => {
					dbg(`LSP resync after autofix error: ${err}`);
					return "done" as const;
				});
			// #2523 slice 2: this was `combineAbortSignals(abort,
			// AbortSignal.timeout(budgetMs))` fed into a hand-rolled
			// `Promise.race` — a private fifth copy of "deadline AND signal".
			// `bounded()` is the same thing with the abandonment recorded, and
			// without the composite signal that #2530 review F4 measured
			// accumulating on the SOURCE.
			//
			// `touch` never rejects (it catches above) and never resolves
			// `undefined`, so `undefined` here means exactly "a bound fired".
			const outcome = await bounded(touch, {
				ms: budgetMs,
				// The ambient turn signal: set for the whole tool_result path and
				// absent only in a bare unit harness, where the wall budget is
				// still live (`bounded()` reads a missing signal as one that
				// never aborts).
				signal: abort,
				hook: "tool_result_edit",
				label: "resyncLspFile",
			});
			if (outcome === undefined) {
				// Abandon the still-pending write; the edit continues. Log it so this
				// stall — previously an invisible hang — is queryable in latency.log.
				//
				// #1766: a resync deadline can expire while the target server's FIRST
				// spawn is still in flight (cold spawn > budget). That is not the same
				// state as a running server that stalled on a write — the server the
				// old wording blamed as "slow/wedged" did not exist yet. Distinguish
				// the two via a fresh, synchronous inFlight lookup so the record keeps
				// the discriminating identity (which server, which lifecycle state).
				// Guarded: a test double or future service shape lacking the method
				// must degrade to the old "timeout"/slow-wedged wording, not throw
				// into the catch below and suppress this record entirely (#1766 F3).
				const spawnInFlight =
					!abort?.aborted &&
					typeof lspService.isSpawnInFlight === "function" &&
					lspService.isSpawnInFlight(filePath);
				const reason = abort?.aborted
					? "aborted"
					: spawnInFlight
						? "spawn-in-flight"
						: "timeout";
				logLatency({
					type: "phase",
					phase: "lsp_sync_abandoned",
					filePath,
					durationMs: Date.now() - startedAt,
					metadata: {
						source: "lsp_sync",
						reason,
						budgetMs,
					},
				});
				const cause = abort?.aborted
					? "aborted (Escape)"
					: spawnInFlight
						? `timed out after ${budgetMs}ms; reason: spawn-in-flight (server still cold-spawning)`
						: `timed out after ${budgetMs}ms; server slow/wedged`;
				dbg(`LSP resync ${cause} for ${filePath}`);
			}
		}
	} catch (err) {
		dbg(`LSP resync after autofix error: ${err}`);
	}
}

/** Maps a dispatch `Diagnostic` (clients/dispatch/types.ts) to the #502 bus payload shape. */
function toPilensDiagnosticEntry(d: Diagnostic): PilensDiagnosticEntry {
	const entry: PilensDiagnosticEntry = {
		severity: d.severity,
		message: d.message,
		tool: d.tool,
	};
	if (d.rule !== undefined) entry.ruleId = d.rule;
	if (d.line !== undefined) entry.line = d.line;
	if (d.column !== undefined) entry.col = d.column;
	if (d.fixable !== undefined) entry.fixable = d.fixable;
	return entry;
}

type DispatchResult = Awaited<
	ReturnType<
		(typeof import("./dispatch/integration.js"))["dispatchLintWithResult"]
	>
>;
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

export interface FormatPhaseResult {
	formatChanged: boolean;
	formattersUsed: string[];
	formatFailures: string[];
	/**
	 * Formatters whose executable was proven absent this run (#2413). Kept apart
	 * from `formatFailures` so the deferred drain never requeues durable
	 * unavailability as a transient `format-failed`, and so the user is never
	 * shown unavailable infrastructure as a code error.
	 */
	formatUnavailable: Array<{ formatter: string; reason: string }>;
	fileContent: string | undefined;
}

export async function runFormatPhase(
	filePath: string,
	getFormatService: () => FormatService,
	dbg: PipelineContext["dbg"],
): Promise<FormatPhaseResult> {
	let formatChanged = false;
	let formattersUsed: string[] = [];
	const formatFailures: string[] = [];
	const formatUnavailable: Array<{ formatter: string; reason: string }> = [];
	let fileContent: string | undefined;

	const formatService = getFormatService();
	try {
		formatService.recordRead(filePath);
		const result = await formatService.formatFile(filePath);
		// An unavailable tool is NOT a formatter that ran (#2413): keep it out of
		// `formattersUsed` (which drives change bookkeeping / turn summaries) and
		// out of `formatFailures` (which requeues). Record it once, distinctly.
		for (const f of result.formatters) {
			if (f.outcome !== "unavailable") continue;
			const reason = f.error ?? "formatter executable not found";
			formatUnavailable.push({ formatter: f.name, reason });
			recordDegradationOnce({
				kind: "formatter-unavailable",
				subject: `${f.name}:${path.basename(filePath)}`,
				reason,
			});
		}
		formattersUsed = result.formatters
			.filter((f) => f.outcome !== "unavailable")
			.map((f) => f.name);
		if (result.anyChanged) {
			formatChanged = true;
			dbg(
				"autoformat: " +
					result.formatters
						.map(
							(f) => f.name + "(" + (f.changed ? "changed" : "unchanged") + ")",
						)
						.join(", "),
			);
		}
		if (!result.allSucceeded) {
			const failures = result.formatters.filter((f) => !f.success);
			for (const failure of failures) {
				recordDegradationOnce({
					kind: "formatter-failure",
					subject: `${failure.name}:${path.basename(filePath)}`,
					reason: failure.error ?? "unknown error",
				});
			}
			formatFailures.push(
				...failures.map((f) => `${f.name}: ${f.error ?? "unknown error"}`),
			);
			dbg(
				"autoformat: " +
					failures
						.map((f) => f.name + " failed: " + (f.error ?? "unknown error"))
						.join("; "),
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		recordDegradationOnce({
			kind: "formatter-failure",
			subject: `format-service:${path.basename(filePath)}`,
			reason: message,
		});
		formatFailures.push(message);
		dbg(`autoformat error: ${err}`);
	}

	try {
		fileContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		fileContent = undefined;
	}

	return {
		formatChanged,
		formattersUsed,
		formatFailures,
		formatUnavailable,
		fileContent,
	};
}

/**
 * Build the 🔴 STOP blocker output with an inline code snippet for each
 * diagnostic so the agent can see the exact line it wrote without re-reading
 * the file.
 *
 * Example:
 *   L4: 'randomInt' is declared but its value is never read.
 *       → const randomInt = Math.floor(result);
 */
function buildEnrichedBlockerOutput(
	blockers: Diagnostic[],
	fileContent = "",
): string {
	// Empty fileContent (readback failed, e.g. deleted-file race) still
	// renders the gated blocker list - just without per-line snippets.
	const fileLines = fileContent ? fileContent.split("\n") : [];
	const MAX_SNIPPET = 120; // chars — keep it tight in context

	let out = `\n\n🔴 STOP — ${blockers.length} issue(s) must be fixed:\n`;
	const shown = blockers.slice(0, 10);

	for (const d of shown) {
		const lineNo = d.line ?? 1;
		const nodeCtx = d.astNodeType ? ` (${d.astNodeType})` : "";
		out += `  L${lineNo}: ${d.message}${nodeCtx}\n`;
		// Prefer the exact matched node text (tree-sitter); fall back to the
		// full source line (LSP / other runners).
		const snippet = d.matchedText
			? d.matchedText.trim().split("\n")[0]?.slice(0, MAX_SNIPPET)
			: fileLines[lineNo - 1]?.trim().slice(0, MAX_SNIPPET);
		if (snippet) out += `      → ${snippet}\n`;
		if (d.fixSuggestion) out += `      💡 ${d.fixSuggestion}\n`;
	}

	if (blockers.length > 10) {
		out += `  ... and ${blockers.length - 10} more\n`;
	}

	return out;
}

// --- Main Pipeline ---

export async function runPipeline(
	ctx: PipelineContext,
	deps: PipelineDeps,
): Promise<PipelineResult> {
	const { filePath, cwd, toolName, getFlag, getFlagSource, dbg } = ctx;
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

	// --- 2. Auto-format ---
	phase.start("format");
	let formatChanged = false;
	let formattersUsed: string[] = [];
	let formatFailures: string[] = [];
	const piChangedFiles = new Set<string>();
	const autoformatDisabled = !!getFlag("no-autoformat", filePath);
	const immediateFormat = !!getFlag("immediate-format");
	const formatDeferred =
		!autoformatDisabled && !immediateFormat && !!fileContent;
	if (!autoformatDisabled && immediateFormat && fileContent) {
		const formatResult = await runFormatPhase(filePath, getFormatService, dbg);
		formatChanged = formatResult.formatChanged;
		formattersUsed = formatResult.formattersUsed;
		formatFailures = formatResult.formatFailures;
		fileContent = formatResult.fileContent;
		if (formatChanged) {
			const absPath = path.resolve(filePath);
			piChangedFiles.add(absPath);
			publishFilesTouched({
				reason: "format",
				paths: [absPath],
				cwd,
				dbg,
				fixes: formattersUsed.map((tool) => ({
					path: absPath,
					tool,
					kind: "format",
				})),
			});
		}
	} else if (formatDeferred) {
		dbg(`autoformat: deferred until agent_end for ${filePath}`);
	} else if (autoformatDisabled) {
		const source = getFlagSource?.("no-autoformat", filePath);
		dbg(
			`autoformat: skipped for ${filePath} (--no-autoformat${source ? `, source=${source}` : ""})`,
		);
	}
	phase.end("format", {
		formattersUsed,
		formatChanged,
		deferred: formatDeferred,
	});

	// --- 3. Auto-fix ---
	phase.start("autofix");
	let fixedCount = 0;
	let autofixTools: string[] = [];
	let attemptedTools: string[] = [];
	let autofixChangedFiles: string[] = [];
	let fixRefresh = false;
	let autofixSkipReason: string | undefined;
	if (ctx.autofixMode === "deferred") {
		autofixSkipReason = "deferred_to_agent_end";
		dbg(`autofix: deferred until agent_end for ${filePath}`);
	} else
		({
			fixedCount,
			autofixTools,
			attemptedTools,
			changedFiles: autofixChangedFiles,
			needsContentRefresh: fixRefresh,
			skipReason: autofixSkipReason,
		} = await runAutofix(filePath, cwd, getFlag, dbg, deps, getFlagSource));
	for (const changedFile of autofixChangedFiles) {
		piChangedFiles.add(path.resolve(changedFile));
	}
	if (autofixChangedFiles.length > 0) {
		// autofixTools entries are "tool:count" (e.g. "ruff:3"); runAutofix runs
		// against ONE target filePath per call, so every tool that fired in this
		// batch applies to every file the batch changed — best-effort attribution
		// (not per-file precision) since the underlying tool runners don't report
		// per-changed-file breakdown. Good enough for the "was this hunk
		// mechanical" use case the fix-provenance field exists for.
		const absChangedFiles = autofixChangedFiles.map((f) => path.resolve(f));
		const toolNames = autofixTools.map((t) => t.split(":")[0]);
		publishFilesTouched({
			reason: "autofix",
			paths: absChangedFiles,
			cwd,
			dbg,
			fixes: absChangedFiles.flatMap((p) =>
				toolNames.map((tool) => ({ path: p, tool, kind: "autofix" as const })),
			),
		});
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

	// --- 4. LSP file sync ---
	// Sync once with final post-format/post-fix content so dispatch and cascade
	// diagnostics do not observe stale pre-format text.
	phase.start("lsp_sync");
	let lspSyncCompleted = false;
	if (fileContent) {
		await resyncLspFile(filePath, fileContent, true, false, getFlag, dbg);
		lspSyncCompleted = true;
	}
	phase.end("lsp_sync", { completed: lspSyncCompleted, finalContent: true });

	// --- 5. Dispatch lint ---
	phase.start("dispatch_lint");
	dbg(`dispatch: running lint tools for ${filePath}`);

	const piApi: PiAgentAPI = {
		getFlag: getFlag as (flag: string) => boolean | string | undefined,
	};
	const { dispatchLintWithResult, computeCascadeForFile } =
		await loadDispatchIntegration();
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
		{
			projectRoot: ctx.projectRoot,
			writeIndex: ctx.telemetry?.writeIndex,
			telemetryModel: ctx.telemetry?.modelId,
			telemetryProvider: ctx.telemetry?.provider,
		},
	);
	recordDiagnostics(
		filePath,
		dispatchResult.diagnostics,
		ctx.telemetry?.writeIndex,
	);
	// #502: emit the write batch's FINAL diagnostic state immediately after
	// recordDiagnostics commits it — this call site runs after format,
	// autofix, and dispatch have all completed for this batch (see the phase
	// order above), so dispatchResult.diagnostics IS the latest post-batch
	// picture, not an intermediate runner result. Full-replace semantics: we
	// always pass the complete current set for this file, including an
	// explicit `[]` on the transition from a previously-reported-dirty state
	// to clean (see clients/diagnostics-publish.ts for the contract).
	{
		const absPath = path.resolve(filePath);
		const wasDirty = wasPreviouslyReportedDirty(absPath);
		if (dispatchResult.diagnostics.length > 0 || wasDirty) {
			publishDiagnostics({
				cwd,
				files: [
					{
						path: absPath,
						diagnostics: dispatchResult.diagnostics.map(
							toPilensDiagnosticEntry,
						),
					},
				],
				dbg,
			});
		}
	}
	const hasBlockers = dispatchResult.hasBlockers;
	const actionableWarnings = dispatchResult.warnings
		.map((diagnostic) => recordFromDispatchDiagnostic(diagnostic, cwd))
		.filter((warning): warning is ActionableWarningRecord => Boolean(warning));
	const codeQualityWarnings = dispatchResult.warnings
		.map((diagnostic) => recordFromCodeQualityDiagnostic(diagnostic, cwd))
		.filter((warning): warning is CodeQualityWarningRecord => Boolean(warning));

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
			[...dispatchResult.blockers, ...dispatchResult.fixed].map(toKey),
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
	// #2028: the 🔴 STOP block is an agent-facing delivery surface
	// (finding-delivery-gate.ts's `tool-call:stop-blocker`), so it routes through
	// the shared deleted-path gate before rendering: a blocker whose cited file
	// no longer exists has no remediation the agent can perform (the finding IS
	// the deleted file's content), so it is dropped here rather than re-asserted.
	// One bounded stat per unique cited path, only when blockers exist — zero
	// cost on the clean/fast paths.
	const deliverableBlockers = dispatchResult.hasBlockers
		? dropFindingsForMissingPaths({
				store: "stop-blocker",
				findings: dispatchResult.blockers,
				cwd,
				citedPath: (b) => b.filePath || undefined,
			})
		: dispatchResult.blockers;
	if (dispatchResult.hasBlockers && fileContent) {
		// Enrich blocker output with a code snippet so the agent can see the
		// exact line it wrote that caused each violation — no re-read needed.
		if (deliverableBlockers.length > 0) {
			output += buildEnrichedBlockerOutput(deliverableBlockers, fileContent);
		}
		// Append fixed/coverage parts from the original output (slice off the
		// blocker section we're replacing).
		const rest = dispatchResult.output.slice(
			dispatchResult.blockerOutput.length,
		);
		if (rest) output += rest;
	} else if (dispatchResult.output) {
		// #2028 review P3: this path fires when readback FAILED - raw output
		// still cites possibly-deleted files. Re-render from the gated set
		// (no snippets without fileContent) and keep the post-blocker slice.
		if (
			dispatchResult.hasBlockers &&
			deliverableBlockers.length !== dispatchResult.blockers.length
		) {
			let gatedOut = buildEnrichedBlockerOutput(deliverableBlockers);
			const rest = dispatchResult.output.slice(
				dispatchResult.blockerOutput.length,
			);
			if (rest) gatedOut += rest;
			output += `\n\n${gatedOut}`;
		} else {
			output += `\n\n${dispatchResult.output}`;
		}
	}
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
	// #1590: the notice sentence itself is NOT rendered here. This layer cannot
	// see the attachment cap or the aggregate budget, so it hands the display
	// paths to `handleToolResult`, which owns the decision and renders the one
	// sentence with `renderPostAutofixNotice`.
	const postAutofixNotice: PostAutofixNotice | undefined =
		formatChanged || fixedCount > 0
			? {
					targetPath: toRunnerDisplayPath(cwd, filePath),
					changedFiles: [...piChangedFiles].map((changedFile) =>
						toRunnerDisplayPath(cwd, changedFile),
					),
				}
			: undefined;
	phase.end("dispatch_lint", {
		hasOutput: !!dispatchResult.output,
		diagnosticCount: dispatchResult.diagnostics.length,
	});

	// --- 6. Cascade diagnostics (LSP only) ---
	// Kicked off UNAWAITED so the graph rebuild + neighbor LSP pulls run
	// concurrently after the edit returns rather than blocking it (#450). The
	// result is never shown inline — settled (bounded) and surfaced at turn_end.
	// The stored promise must never reject: an unhandled rejection is fatal, so a
	// failing compute resolves to an "error" skip-run instead.
	const cascadeOrigin = {
		turnSeq: ctx.telemetry?.turnIndex,
		writeSeq: ctx.telemetry?.writeIndex,
		projectSeq: ctx.seqState?.projectSeq(),
	};
	const cascadePromise = getFlag("no-lsp")
		? undefined
		: computeCascadeForFile(filePath, cwd, {
				hasBlockers,
				dbg,
				turnSeq: ctx.telemetry?.turnIndex,
				writeSeq: ctx.telemetry?.writeIndex,
				seqState: ctx.seqState,
				turnEndCascadeSettleStart: ctx.turnEndCascadeSettleStart,
				fileContent,
				wordIndex: ctx.wordIndex,
				onWordIndexUpdated: ctx.onWordIndexUpdated,
			})
				.then((run) => ({ ...run, origin: cascadeOrigin }))
				.catch((err): import("./cascade-types.js").CascadeRun => {
					dbg(`cascade compute failed for ${filePath}: ${err}`);
					return {
						filePath,
						origin: cascadeOrigin,
						result: undefined,
						neighborCount: 0,
						diagnosticCount: 0,
						skipReason: "error",
						// #1023: a thrown compute is ALSO "couldn't compute downstream
						// impact" — carry an indeterminate marker so turn_end surfaces an
						// honest advisory instead of the error skip being logs-only.
						indeterminate: {
							reason: "error",
							detail: "cascade computation failed",
						},
					};
				});

	// --- Final timing + all-clear ---
	const elapsed = Date.now() - pipelineStart;
	// #1590: `postAutofixNotice` is output this run produces, just rendered a
	// layer up. Treat it as output here, or a format-only change would newly
	// gain an "all clear" line it never had while the sentence lived inline.
	if (!output && !postAutofixNotice) {
		output = buildAllClearOutput(dispatchResult, elapsed, filePath);
	}

	phase.end("total", { hasOutput: !!output });

	const fileModified = formatChanged || fixedCount > 0;
	const changedFiles = [...piChangedFiles];
	emitLensAnalysisComplete({
		cwd,
		filePath,
		toolName,
		model: ctx.telemetry?.model ?? "unknown",
		sessionId: ctx.telemetry?.sessionId ?? "unknown",
		turnIndex: ctx.telemetry?.turnIndex ?? 0,
		writeIndex: ctx.telemetry?.writeIndex ?? 0,
		diagnostics: dispatchResult.diagnostics,
		blockers: dispatchResult.blockers,
		warnings: dispatchResult.warnings,
		fixed: dispatchResult.fixed,
		resolvedCount: dispatchResult.resolvedCount,
		hasBlockers,
		fileModified,
		changedFiles,
		durationMs: elapsed,
	});

	return {
		output,
		hasBlockers,
		cascadePromise,
		isError: false,
		fileModified,
		changedFiles,
		inlineBlockerSummary: dispatchResult.hasBlockers
			? dispatchResult.blockerOutput.trim() || undefined
			: undefined,
		// #1561 F1: taken from the very diagnostics `blockerOutput` was rendered
		// from, so the provenance can never disagree with the text it guards. An
		// untagged diagnostic contributes the literal "unknown", which no verdict
		// claims coverage for — it pins the entry rather than silently widening
		// what an LSP check is allowed to clear.
		inlineBlockerSources: dispatchResult.hasBlockers
			? [
					...new Set(
						dispatchResult.blockers.map((d) => d.tool?.trim() || "unknown"),
					),
				]
			: undefined,
		inlineBlockerLines: dispatchResult.hasBlockers
			? dispatchResult.blockers
					// #1641 review F2: `dispatchResult.blockers` is NOT guaranteed to be
					// scoped to THIS file — a chart-wide runner (helm-lint, helm-render)
					// reports blocking diagnostics against other files in the chart
					// (e.g. `values.yaml`) alongside `ctx.filePath`. The precedent every
					// per-file runner already follows (dotnet-build.ts, javac.ts) is to
					// drop cross-file rows before they reach a per-file record; this is
					// that same filter applied at the aggregation point instead, since
					// `blockers` is pooled across every runner dispatched for this file.
					// Without it, a cross-file line count gets attributed to THIS
					// file's past-EOF check and can demote an in-bounds, fully valid
					// blocker for content the diagnostic never described.
					//
					// #1641 review round 2 (LOW): `path.resolve` equality doesn't fold
					// case, and an LSP-sourced diagnostic's `filePath` is stamped with
					// realpath canonical casing (dispatch/runners/lsp.ts ->
					// normalizeMapKey) while `ctx.filePath` can arrive lowercase-drive
					// on Windows — the drive-letter class from #1139/#1150. A bare
					// `path.resolve` equality then drops EVERY LSP blocker line and
					// this record silently skips the past-EOF gate (fail-open, but
					// exactly the pre-fix behavior on the surface #1641 targets).
					// `normalizeEphemeralMapKey` slash-folds and (on win32)
					// lowercase-folds both sides with no filesystem I/O — cheap enough
					// for this per-blocker hot-path filter. `pathsEqual` was
					// deliberately NOT used here: it calls `realpathSync` per
					// comparison, which this filter cannot afford per blocker.
					.filter(
						(d) =>
							normalizeEphemeralMapKey(d.filePath) ===
							normalizeEphemeralMapKey(filePath),
					)
					.map((d) => d.line)
					.filter((line): line is number => typeof line === "number")
			: undefined,
		actionableWarnings,
		codeQualityWarnings,
		diagnostics: dispatchResult.diagnostics,
		formattersUsed,
		fixedCount,
		autofixTools,
		postAutofixNotice,
		postMutation:
			ctx.autofixMode !== "deferred" &&
			autofixChangedFiles.some(
				(f) => path.resolve(f) === path.resolve(filePath),
			) &&
			fileContent !== undefined
				? {
						filePath: path.resolve(filePath),
						content: fileContent,
						source: "autofix",
					}
				: undefined,
	};
}
