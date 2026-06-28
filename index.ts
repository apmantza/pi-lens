import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "./clients/tool-event.js";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { loadBootstrapClients } from "./clients/bootstrap.js";
import { CacheManager } from "./clients/cache-manager.js";
import { resolvePackagePath } from "./clients/package-root.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFailedLspServerIds,
	getSessionLanguages,
	importWidgetState,
	type PersistedWidgetState,
	renderWidget,
	setRenderCallback,
} from "./clients/widget-state.js";
import { selectLspStatus } from "./clients/lsp-status.js";
import {
	dropStaleFiles,
	loadSessionState,
	saveSessionState,
	sessionStartMode,
} from "./clients/session-state-store.js";
import { getDiagnosticTracker } from "./clients/diagnostic-tracker.js";
import {
	getCascadeSessionStats,
	getDispatchSlopScoreLine,
	getLatencyReports,
	resetDispatchBaselines,
} from "./clients/dispatch/integration.js";
import {
	extractReadPathsFromCommand,
	extractWrittenPathsFromCommand,
} from "./clients/bash-file-access.js";
import { detectFileKind } from "./clients/file-kinds.js";
import { isPathIgnoredByProject } from "./clients/file-utils.js";
import {
	getFormatService,
	resetFormatService,
} from "./clients/format-service.js";
import {
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
} from "./clients/git-guard.js";
import { getAllToolStatuses } from "./clients/installer/index.js";
import { LANGUAGE_POLICY } from "./clients/language-policy.js";
import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
} from "./clients/lens-config.js";
import { initLensEvents } from "./clients/lens-events.js";
import { initLSPConfig } from "./clients/lsp/config.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import {
	EXPANSION_BUDGET_MS,
	EXPANSION_LIMIT_LINES,
	tryExpandRead,
} from "./clients/read-expansion.js";
import { logReadGuardEvent } from "./clients/read-guard-logger.js";
import {
	countFileLines,
	getTouchedLinesForGuard,
	relocateEditRange,
	tryCorrectIndentationMismatch,
	tryCorrectIndentationMismatchFromContent,
} from "./clients/read-guard-tool-lines.js";
import {
	computeTrailingWhitespaceOldTextPatch,
	findUniqueMatchLineRange,
} from "./clients/oldtext-autopatch.js";
import { applyPartiallyApplicableEdits } from "./clients/partial-edit-apply.js";
import { normalizeForGuardMatch } from "./clients/host-edit-normalize.js";
import { retargetReplacementIndentation } from "./clients/indent-retarget.js";
import { handleAgentEnd } from "./clients/runtime-agent-end.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "./clients/runtime-context.js";
import { RuntimeCoordinator } from "./clients/runtime-coordinator.js";
import { handleSessionStart } from "./clients/runtime-session.js";
import {
	clearLastAnalyzedStateCache,
	flushDebouncedToolResults,
	handleToolResult,
} from "./clients/runtime-tool-result.js";
import { cancelLSPIdleReset, handleTurnEnd } from "./clients/runtime-turn.js";
import { isExternalOrVendorFile } from "./clients/path-utils.js";
import { setAmbientAbortSignal } from "./clients/safe-spawn.js";
import { TreeSitterClient } from "./clients/tree-sitter-client.js";
import { handleBooboo } from "./commands/booboo.js";
import { initI18n, t } from "./i18n.js";
import { createAstDumpTool, createAstGrepDumpTool } from "./tools/ast-dump.js";
import { createLensDiagnosticsTool } from "./tools/lens-diagnostics.js";
import { createAstGrepReplaceTool } from "./tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "./tools/ast-grep-search.js";
import { createAstGrepOutlineTool } from "./tools/ast-grep-outline.js";
import { createLspDiagnosticsTool } from "./tools/lsp-diagnostics.js";
import { createLspNavigationTool } from "./tools/lsp-navigation.js";
import {
	createModuleReportTool,
	createReadEnclosingTool,
	createReadSymbolTool,
} from "./tools/module-report.js";
import { logLatency } from "./clients/latency-logger.js";
import {
	markPiLensLoaded,
	PI_LENS_LOADED_FROM,
} from "./clients/startup-timing.js";
import {
	getEventLoopStats,
	shouldLogWorstBlock,
	startEventLoopMonitor,
} from "./clients/event-loop-monitor.js";

// First executable statement: every import above has been evaluated, so the
// full load/transpile cost has been paid. Capture it now.
const PI_LENS_LOAD_MS = markPiLensLoaded();
// Start the event-loop occupancy monitor as early as possible so startup
// blocks are captured. Native histogram — no per-event overhead. (#192)
startEventLoopMonitor();
// Worst event-loop block already persisted to latency.log (so we only log a
// *new* worst freeze per turn, not the same growing max). (#192)
let lastLoggedLoopWorstMs = 0;

const DEBUG_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const DEBUG_LOG = path.join(DEBUG_LOG_DIR, "sessionstart.log");
function dbg(msg: string) {
	// Skip file logging during tests to isolate test output from production logs
	if (process.env.PI_LENS_TEST_MODE === "1" || process.env.VITEST) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		nodeFs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
		nodeFs.appendFileSync(DEBUG_LOG, line);
	} catch (e) {
		// Pipeline error logged
		console.error("[pi-lens-debug] write failed:", e);
	}
}

// Log how long pi took to load pi-lens — the jiti transpile of every module is
// paid by now. Source mode includes transpiling ~200 .ts files; the precompiled
// dist build does not, so the delta is the #182 startup win. One line per load.
dbg(
	`pi-lens loaded: ${PI_LENS_LOAD_MS}ms after process start (from ${PI_LENS_LOADED_FROM})`,
);
logLatency({
	type: "phase",
	filePath: "<pi-lens>",
	phase: "extension_loaded",
	durationMs: PI_LENS_LOAD_MS,
	metadata: { loadedFrom: PI_LENS_LOADED_FROM },
});

// No-op log function (verbose console logging was removed with lens-verbose flag)
function log(_msg: string) {
	// Previously tied to --lens-verbose flag, now disabled
}

// --- State ---

const runtime = new RuntimeCoordinator();
const _lspConfigInitializedCwds = new Set<string>();
const _readExpansionClient = new TreeSitterClient();
const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_TOOLCALL_NAV_TOUCH_MS ??
			process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ??
			"1500",
		10,
	) || 1500,
);
const LSP_TOOLCALL_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_TOOLCALL_TOUCH_MS ?? "750", 10) || 750,
);

async function ensureLSPConfigInitialized(cwd: string): Promise<void> {
	const normalizedCwd = path.resolve(cwd);
	if (_lspConfigInitializedCwds.has(normalizedCwd)) return;
	await initLSPConfig(normalizedCwd);
	_lspConfigInitializedCwds.add(normalizedCwd);
}

function updateRuntimeIdentityFromEvent(event: unknown): void {
	const raw = event as {
		provider?: string;
		model?: string;
		sessionId?: string;
		session?: { id?: string };
		id?: string;
	};
	runtime.setTelemetryIdentity({
		provider: raw.provider,
		model: raw.model,
		sessionId: raw.sessionId ?? raw.session?.id ?? raw.id,
	});
}

function normalizeCommandArgs(args: unknown): string[] {
	if (Array.isArray(args)) {
		return args.filter((arg): arg is string => typeof arg === "string");
	}
	if (typeof args === "string") {
		return args.trim().split(/\s+/).filter(Boolean);
	}
	return [];
}

function getToolCallRawFilePath(
	toolName: string,
	event: { input?: unknown },
): string | undefined {
	const inputObj = (event.input ?? {}) as Record<string, unknown>;

	if (
		isToolCallEventType("write", event as any) ||
		isToolCallEventType("edit", event as any)
	) {
		const filePath = (event.input as { path?: unknown }).path;
		return typeof filePath === "string" ? filePath : undefined;
	}

	if (toolName === "read") {
		if (typeof inputObj.path === "string") return inputObj.path;
		if (typeof inputObj.filePath === "string") return inputObj.filePath;
		return undefined;
	}

	if (toolName === "lsp_navigation") {
		return typeof inputObj.filePath === "string"
			? inputObj.filePath
			: undefined;
	}

	return undefined;
}

function resolveToolCallFilePath(
	rawFilePath: string | undefined,
	cwd: string | undefined,
	projectRoot: string,
): string | undefined {
	if (!rawFilePath) return undefined;
	if (path.isAbsolute(rawFilePath)) return rawFilePath;
	return path.resolve(cwd ?? projectRoot, rawFilePath);
}

type ReadToolInput = {
	path?: string;
	filePath?: string;
	offset?: number;
	limit?: number;
};

function getReadToolInput(
	toolName: string,
	input: unknown,
): ReadToolInput | undefined {
	if (toolName !== "read") return undefined;
	return input as ReadToolInput;
}

function getEffectiveReadLimit(
	filePath: string | undefined,
	readInput: ReadToolInput | undefined,
): number | undefined {
	if (!filePath || !readInput) return undefined;
	const requestedOffset = readInput.offset ?? 1;
	const requestedLimit = readInput.limit;
	return (
		requestedLimit ??
		Math.max(1, countFileLines(filePath) - requestedOffset + 1)
	);
}

function isLspCapableFile(filePath: string): boolean {
	const kind = detectFileKind(filePath);
	if (!kind) return false;
	return LANGUAGE_POLICY[kind]?.lspCapable !== false;
}

function shouldSkipLspAutoTouch(
	filePath: string,
	projectRoot: string,
): boolean {
	const normalized = path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
	const base = path.basename(filePath).toLowerCase();

	if (normalized.includes("/.pi-lens/")) return true;
	if (normalized.includes("/.harness/")) return true;
	if (isExternalOrVendorFile(filePath, projectRoot)) return true;
	if (
		base === "stdout.jsonl" ||
		base === "stderr.txt" ||
		base === "prompt.txt"
	) {
		return true;
	}
	if (base === "case.json" && normalized.includes("/cases/")) {
		return true;
	}
	return false;
}

// Kept in lockstep with the gate's normalizeContent + oldtext-autopatch's
// normalizeOldTextForMatch: the host edit tool's full fuzzy-match space, so the
// autopatch passes count/locate oldText exactly where the host applies it (#257).
function normalizeOldTextForMatch(text: string): string {
	return normalizeForGuardMatch(text);
}

function countTextOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (pos < haystack.length) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		count += 1;
		pos = idx + needle.length;
	}
	return count;
}

function countOldTextMatches(
	filePath: string,
	oldText: string,
	cachedNormalizedContent?: string,
): number {
	try {
		const content =
			cachedNormalizedContent ??
			normalizeOldTextForMatch(nodeFs.readFileSync(filePath, "utf-8"));
		return countTextOccurrences(content, normalizeOldTextForMatch(oldText));
	} catch {
		return 0;
	}
}

function isIndentationOnlyChange(before: string, after: string): boolean {
	const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
	const afterLines = after.replace(/\r\n/g, "\n").split("\n");
	if (beforeLines.length !== afterLines.length) return false;
	// Strip both leading and trailing whitespace: consistent with
	// findIndentationInsensitiveCandidate which matches via .trimEnd(), so a
	// candidate that differs only in trailing whitespace is still indentation-only.
	return beforeLines.every(
		(line, index) => line.trim() === afterLines[index].trim(),
	);
}

function getNewContentFromToolCall(event: unknown): string | undefined {
	if (isToolCallEventType("write", event as any)) {
		return ((event as { input?: unknown }).input as { content?: string })
			.content;
	}
	if (isToolCallEventType("edit", event as any)) {
		const edits = (
			(event as { input?: unknown }).input as {
				edits?: Array<{ newText?: string }>;
			}
		).edits;
		return edits?.map((edit) => edit.newText ?? "").join("\n");
	}
	return undefined;
}

function cleanStaleTsBuildInfo(cwd: string): string[] {
	const cleaned: string[] = [];
	try {
		// Find all tsbuildinfo files in the project (max depth 3 to avoid crawling)
		const candidates = nodeFs
			.readdirSync(cwd)
			.filter((f) => f.endsWith(".tsbuildinfo"))
			.map((f) => path.join(cwd, f));

		for (const infoPath of candidates) {
			try {
				const data = JSON.parse(nodeFs.readFileSync(infoPath, "utf-8"));
				const root: string[] = data.root ?? [];
				const dir = path.dirname(infoPath);
				const isStale = root.some(
					(f) => !nodeFs.existsSync(path.resolve(dir, f)),
				);
				if (isStale) {
					nodeFs.unlinkSync(infoPath);
					cleaned.push(infoPath);
				}
			} catch {
				// Malformed or unreadable - skip
			}
		}
	} catch {
		// readdirSync failed - skip
	}
	return cleaned;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	initI18n(pi);
	initLensEvents(pi);
	const astGrepClient = new AstGrepClient();
	const cacheManager = new CacheManager();

	type LspStatusTheme = {
		fg: (
			color: "accent" | "success" | "error" | "warning" | "dim",
			text: string,
		) => string;
	};

	function updateLspStatus(
		setStatus: (id: string, text: string | undefined) => void,
		theme: LspStatusTheme,
	) {
		try {
			// Active and Failed coexist (#170): show the working servers in green
			// AND any language whose servers all failed in red, side by side. A
			// failed server is suppressed when a live sibling covers its language
			// (alt-LSP fallback) or its kind is no longer in use this session.
			const { activeIds, failedIds } = selectLspStatus(
				getLSPService().getAliveServerIds(),
				getFailedLspServerIds(),
				getSessionLanguages(),
			);
			const parts: string[] = [];
			if (activeIds.length > 0) {
				parts.push(theme.fg("success", `LSP Active: ${activeIds.join(", ")}`));
			}
			if (failedIds.length > 0) {
				parts.push(theme.fg("error", `LSP Failed: ${failedIds.join(", ")}`));
			}
			// Inactive is a passive state (no server running for this file, or the
			// idle timer released them) — not a fault. Render it neutral/grey, not
			// red, only when there is nothing else to show.
			setStatus(
				"pi-lens-lsp",
				parts.length > 0 ? parts.join(" · ") : theme.fg("dim", "LSP Inactive"),
			);
		} catch (err) {
			// Theme may not be fully initialized during early session startup.
			// Skip the status update rather than crashing the event handler.
			dbg(`lsp status update skipped: ${err}`);
		}
	}

	function captureLspStatusRepaint(ctx: unknown): (() => void) | undefined {
		let ui:
			| {
					setStatus?: (id: string, text: string | undefined) => void;
					theme?: LspStatusTheme;
			  }
			| undefined;
		try {
			ui = (
				ctx as {
					ui?: {
						setStatus?: (id: string, text: string | undefined) => void;
						theme?: LspStatusTheme;
					};
				}
			).ui;
		} catch (err) {
			// Accessing ctx.ui is guarded by pi and can throw after session
			// replacement. Capture during an active event when possible; detached
			// timers must not touch the ctx getter later (#338).
			dbg(`lsp status repaint capture skipped: ${err}`);
			return undefined;
		}
		if (!ui || typeof ui.setStatus !== "function" || !ui.theme) {
			return undefined;
		}
		const { setStatus, theme } = ui;
		return () => updateLspStatus(setStatus, theme);
	}

	// --- Flags ---

	pi.registerFlag("no-lens", {
		description:
			"Start pi-lens disabled for this session. Re-enable with /lens-toggle.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-lsp", {
		description:
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example ts-lsp, pyright)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autoformat", {
		description:
			"Disable automatic formatting entirely (deferred format runs at agent_end by default)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("immediate-format", {
		description:
			"Run automatic formatting immediately after each write/edit instead of deferring to agent_end",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autofix", {
		description: "Disable auto-fixing of lint issues (Biome, Ruff, ESLint)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-tests", {
		description: "Disable test runner on write",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-delta", {
		description: "Disable delta mode (show all diagnostics, not just new ones)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-guard", {
		description:
			"Experimental: block git commit/push when unresolved pi-lens blockers exist",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-opengrep", {
		description:
			"Disable the Opengrep security scanner (a default-on auxiliary LSP; auto-installs, uses repo rules if present else the login-free 'auto' ruleset)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-read-guard", {
		description: "Disable read-before-edit behavior monitor",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-lens-context", {
		description:
			"Disable automatic context injection (session-start guidance, turn-end & test findings) while keeping tools, LSP, read-guard, and formatting active. Toggle with /lens-context-toggle. Also via contextInjection.enabled=false in config or PI_LENS_NO_CONTEXT_INJECTION=1.",
		type: "boolean",
		default: false,
	});

	const globalConfig = loadPiLensGlobalConfig();
	const globalConfigOnlyFlags = new Set([
		"lens-actionable-warnings",
		"lens-actionable-warning-actions",
		"lens-actionable-warning-autofix",
		"lens-actionable-warning-all",
	]);
	function getLensFlag(name: string): boolean | string | undefined {
		const cliValue = globalConfigOnlyFlags.has(name)
			? undefined
			: pi.getFlag(name);
		return resolvePiLensFlag(name, cliValue, globalConfig);
	}

	let lensEnabled = !getLensFlag("no-lens");
	// Automatic context injection (the `context` hook). Independent of lensEnabled
	// so tools/LSP/read-guard/formatting keep running when it is off. Precedence:
	// env override → CLI flag → global config (resolved inside getLensFlag).
	let contextInjectionEnabled =
		process.env.PI_LENS_NO_CONTEXT_INJECTION !== "1" &&
		!getLensFlag("no-lens-context");
	let lensWidgetVisible = globalConfig?.widget?.visible !== false;
	// #190 Phase 2: snapshot of the source session's diagnostics, captured at
	// `session_before_fork` and adopted by the forked session at the subsequent
	// `session_start` (reason="fork"). In-memory hand-off (same process) — avoids
	// deriving the source id from a file path (the id lives in the file header).
	let pendingForkSnapshot: PersistedWidgetState | undefined;
	type LensWidgetTui = { requestRender: () => void };
	type LensWidgetTheme = { fg: (color: string, s: string) => string };
	type LensWidgetComponent = {
		render: (width: number) => string[];
		invalidate: () => void;
	};
	type LensWidgetFactory = (
		tui: LensWidgetTui,
		theme: LensWidgetTheme,
	) => LensWidgetComponent;
	type LensWidgetUi = { setWidget?: unknown };
	type LensWidgetSetWidget = (
		id: string,
		widget: LensWidgetFactory | undefined,
		options?: { placement: "belowEditor" },
	) => void;

	function mountLensWidget(ui: LensWidgetUi | undefined): boolean {
		if (typeof ui?.setWidget !== "function") return false;
		const setWidget = ui.setWidget as LensWidgetSetWidget;
		setWidget(
			"pi-lens",
			(tui: LensWidgetTui, theme: LensWidgetTheme) => {
				setRenderCallback(() => tui.requestRender());
				return {
					render: (width: number) => renderWidget(width, theme),
					invalidate: () => setRenderCallback(() => {}),
				};
			},
			{ placement: "belowEditor" },
		);
		return true;
	}

	function unmountLensWidget(ui: LensWidgetUi | undefined): boolean {
		setRenderCallback(() => {});
		if (typeof ui?.setWidget !== "function") return false;
		const setWidget = ui.setWidget as LensWidgetSetWidget;
		setWidget("pi-lens", undefined);
		return true;
	}

	// --- Commands ---

	pi.registerCommand("lens-toggle", {
		description:
			"Toggle pi-lens on/off for the current session. Usage: /lens-toggle",
		handler: async (_args, ctx) => {
			lensEnabled = !lensEnabled;
			ctx.ui.notify(
				lensEnabled
					? "pi-lens enabled for this session."
					: "pi-lens disabled for this session. Run /lens-toggle again to resume.",
				lensEnabled ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("lens-context-toggle", {
		description:
			"Toggle automatic context injection on/off for the current session (tools/LSP/read-guard/formatting stay active). Usage: /lens-context-toggle",
		handler: async (_args, ctx) => {
			contextInjectionEnabled = !contextInjectionEnabled;
			ctx.ui.notify(
				contextInjectionEnabled
					? "pi-lens context injection enabled — findings will be added to the next turn."
					: "pi-lens context injection disabled — findings are still cached (lens_diagnostics, /lens-health) but not added to model context.",
				contextInjectionEnabled ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("lens-widget-toggle", {
		description:
			"Show or hide the pi-lens diagnostics widget below the editor. Usage: /lens-widget-toggle",
		handler: async (_args, ctx) => {
			const nextVisible = !lensWidgetVisible;
			const changed = nextVisible
				? mountLensWidget(ctx.ui)
				: unmountLensWidget(ctx.ui);
			if (!changed) {
				ctx.ui.notify(
					"pi-lens widget is not supported by this pi version.",
					"warning",
				);
				return;
			}

			lensWidgetVisible = nextVisible;
			ctx.ui.notify(
				lensWidgetVisible
					? "pi-lens widget shown. Run /lens-widget-toggle to hide it."
					: "pi-lens widget hidden. Run /lens-widget-toggle to show it.",
				"info",
			);
		},
	});

	pi.registerCommand("lens-booboo", {
		description:
			"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
		handler: async (args, ctx) => {
			const {
				complexityClient,
				todoScanner,
				knipClient,
				jscpdClient,
				typeCoverageClient,
				depChecker,
			} = await loadBootstrapClients();
			return handleBooboo(
				args,
				ctx,
				{
					astGrep: astGrepClient,
					complexity: complexityClient,
					todo: todoScanner,
					knip: knipClient,
					jscpd: jscpdClient,
					typeCoverage: typeCoverageClient,
					depChecker,
				},
				pi,
			);
		},
	});

	// DISABLED: lens-booboo-fix command - disabled per user request

	pi.registerCommand("lens-tdi", {
		description:
			"Show Technical Debt Index (TDI) and project health trend. Usage: /lens-tdi",
		handler: async (_args, ctx) => {
			const { loadHistory, computeTDI } = await import(
				"./clients/metrics-history.js"
			);
			const history = loadHistory();
			const tdi = computeTDI(history);

			let summary = "🔴 High debt - run /lens-booboo-refactor";
			if (tdi.score <= 30) {
				summary = "✅ Codebase is healthy!";
			} else if (tdi.score <= 60) {
				summary = "⚠️ Moderate debt - consider refactoring";
			}
			const lines = [
				`📊 TECHNICAL DEBT INDEX: ${tdi.score}/100 (${tdi.grade})`,
				``,
				`Files analyzed: ${tdi.filesAnalyzed}`,
				`Files with debt: ${tdi.filesWithDebt}`,
				`Avg MI: ${tdi.avgMI}`,
				`Total cognitive complexity: ${tdi.totalCognitive}`,
				``,
				`Debt breakdown:`,
				`  Maintainability: ${tdi.byCategory.maintainability}% (MI-based)`,
				`  Cognitive: ${tdi.byCategory.cognitive}%`,
				`  Nesting: ${tdi.byCategory.nesting}%`,
				`  Max Cyclomatic: ${tdi.byCategory.maxCyclomatic}% (worst function)`,
				`  Entropy: ${tdi.byCategory.entropy}% (code unpredictability)`,
				``,
				summary,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-health", {
		description:
			"Show pi-lens runtime health: pipeline crashes, slow runners, and last dispatch latency. Usage: /lens-health",
		handler: async (_args, ctx) => {
			const crashEntries = runtime
				.getCrashEntries()
				.sort((a, b) => b[1] - a[1]);
			const totalCrashes = crashEntries.reduce(
				(sum, [, count]) => sum + count,
				0,
			);

			const reports = getLatencyReports();
			const last = reports.length > 0 ? reports[reports.length - 1] : undefined;
			const diagStats = getDiagnosticTracker().getStats();
			const slowRunners = last
				? [...last.runners]
						.sort((a, b) => b.durationMs - a.durationMs)
						.slice(0, 3)
				: [];

			// Session duration
			const sessionAge = Date.now() - runtime.sessionStartedAt;
			const sessionMins = Math.floor(sessionAge / 60_000);
			const sessionHrs = Math.floor(sessionMins / 60);
			const sessionAgeStr =
				sessionHrs > 0
					? `${sessionHrs}h ${sessionMins % 60}m`
					: `${sessionMins}m`;
			const startedAt = new Date(runtime.sessionStartedAt).toLocaleTimeString(
				[],
				{ hour: "2-digit", minute: "2-digit" },
			);

			const lines: string[] = [
				t("lens.health.title", "🩺 PI-LENS HEALTH"),
				`Session started: ${startedAt} (${sessionAgeStr} ago)`,
				"",
				t("lens.health.crashes", "Pipeline crashes (session): {count}", {
					count: totalCrashes,
				}),
				t("lens.health.files", "Files affected: {count}", {
					count: crashEntries.length,
				}),
			];
			const slopScoreLine = getDispatchSlopScoreLine();

			if (crashEntries.length > 0) {
				lines.push("", t("lens.health.topCrashFiles", "Top crash files:"));
				for (const [file, count] of crashEntries.slice(0, 5)) {
					lines.push(`  ${path.basename(file)}: ${count}`);
				}
			}

			if (last) {
				lines.push(
					"",
					`Last dispatch: ${path.basename(last.filePath)} (${last.totalDurationMs}ms, ${last.totalDiagnostics} diagnostics)`,
				);
				if (slowRunners.length > 0) {
					lines.push("Top runners (last dispatch):");
					for (const runner of slowRunners) {
						lines.push(
							`  ${runner.runnerId}: ${runner.durationMs}ms (${runner.status})`,
						);
					}
				}
			} else {
				lines.push(
					"",
					t("lens.health.noLatency", "No dispatch latency reports yet."),
				);
			}

			lines.push(
				"",
				t("lens.health.diagnosticsShown", "Diagnostics shown: {count}", {
					count: diagStats.totalShown,
				}),
				t("lens.health.autoFixed", "Auto-fixed: {count}", {
					count: diagStats.totalAutoFixed,
				}),
				t("lens.health.agentFixed", "Agent-fixed: {count}", {
					count: diagStats.totalAgentFixed,
				}),
				t("lens.health.unresolved", "Unresolved carryover: {count}", {
					count: diagStats.totalUnresolved,
				}),
			);

			// Event-loop occupancy — the dimension our duration logs were blind to
			// (#192). `maxMs` ≈ the worst synchronous block (TUI stall) this session.
			const elStats = getEventLoopStats();
			if (elStats) {
				lines.push(
					"",
					`Event loop (session): worst block ${elStats.maxMs}ms · p99 ${elStats.p99Ms}ms · mean ${elStats.meanMs}ms`,
				);
				if (elStats.maxMs > 100) {
					lines.push(
						"  ⚠ a >100ms synchronous block can stutter the TUI — check latency.log (#192)",
					);
				}
			}

			if (diagStats.repeatOffenders.length > 0) {
				lines.push(t("lens.health.repeatOffenders", "Repeat offenders:"));
				for (const offender of diagStats.repeatOffenders.slice(0, 5)) {
					lines.push(
						`  ${path.basename(offender.filePath)}:${offender.line} ${offender.ruleId} (${offender.count}x)`,
					);
				}
			}

			if (diagStats.topViolations.length > 0) {
				lines.push(t("lens.health.topNoisyRules", "Top noisy rules:"));
				for (const v of diagStats.topViolations.slice(0, 5)) {
					const samplePath =
						v.samplePaths.length > 0
							? path
									.relative(runtime.projectRoot, v.samplePaths[0])
									.replace(/\\/g, "/")
							: "";
					const pathSuffix = samplePath ? ` (e.g. ${samplePath})` : "";
					lines.push(`  ${v.ruleId}: ${v.count}${pathSuffix}`);
				}
			}

			// LSP status
			const lspClients = getLSPService().getStatus();
			if (lspClients.length > 0) {
				lines.push("", "LSP servers:");
				for (const { serverId, root, connected } of lspClients) {
					const state = connected ? "✓" : "✗";
					const rootLabel = path.relative(runtime.projectRoot, root) || ".";
					lines.push(`  ${state} ${serverId} (${rootLabel})`);
				}
			} else {
				lines.push("", "LSP servers: none started");
			}

			// Cascade summary
			const cascadeStats = getCascadeSessionStats();
			if (cascadeStats.runs > 0) {
				lines.push(
					"",
					`Cascade runs: ${cascadeStats.runs}`,
					`Cascade diagnostics surfaced: ${cascadeStats.diagnosticsSurfaced}`,
				);
				if (cascadeStats.coldSnapshotTouches > 0) {
					lines.push(
						`Cold-snapshot touches: ${cascadeStats.coldSnapshotTouches}`,
					);
				}
			}

			if (slopScoreLine) {
				lines.push("", slopScoreLine);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-tools", {
		description:
			"Show pi-lens tool installation status: globally installed, auto-installed, or npx fallback. Usage: /lens-tools",
		handler: async (_args, ctx) => {
			const statuses = await getAllToolStatuses();

			const bySource = {
				"global-path": statuses.filter((s) => s.source === "global-path"),
				"npm-global": statuses.filter((s) => s.source === "npm-global"),
				"pip-user": statuses.filter((s) => s.source === "pip-user"),
				"pi-lens-auto": statuses.filter((s) => s.source === "pi-lens-auto"),
				"github-release": statuses.filter((s) => s.source === "github-release"),
				"npx-fallback": statuses.filter((s) => s.source === "npx-fallback"),
				"not-installed": statuses.filter((s) => s.source === "not-installed"),
			};

			const lines: string[] = [
				"🔧 PI-LENS TOOLS STATUS",
				"",
				`Installed: ${statuses.filter((s) => s.installed).length}/${statuses.length}`,
			];

			// Global PATH tools
			if (bySource["global-path"].length > 0) {
				lines.push("", `📍 Global PATH (${bySource["global-path"].length}):`);
				for (const tool of bySource["global-path"]) {
					const version = tool.version ? ` (${tool.version})` : "";
					lines.push(`  ✓ ${tool.name}${version}`);
				}
			}

			// npm global tools
			if (bySource["npm-global"].length > 0) {
				lines.push("", `📦 npm global (${bySource["npm-global"].length}):`);
				for (const tool of bySource["npm-global"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// pip user tools
			if (bySource["pip-user"].length > 0) {
				lines.push("", `🐍 pip user (${bySource["pip-user"].length}):`);
				for (const tool of bySource["pip-user"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// GitHub releases
			if (bySource["github-release"].length > 0) {
				lines.push(
					"",
					`⬇️ GitHub releases (${bySource["github-release"].length}):`,
				);
				for (const tool of bySource["github-release"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// pi-lens auto-installed
			if (bySource["pi-lens-auto"].length > 0) {
				lines.push(
					"",
					`🤖 Auto-installed (${bySource["pi-lens-auto"].length}):`,
				);
				for (const tool of bySource["pi-lens-auto"]) {
					lines.push(`  ✓ ${tool.name}`);
				}
			}

			// npx fallback
			if (bySource["npx-fallback"].length > 0) {
				lines.push(
					"",
					`📦 npx fallback (${bySource["npx-fallback"].length} - on-demand install):`,
				);
				for (const tool of bySource["npx-fallback"]) {
					lines.push(`  ⬜ ${tool.name}`);
				}
			}

			// Not installed (should be empty for npm tools, they'll use npx)
			const trulyMissing = bySource["not-installed"].filter(
				(s) => s.strategy !== "npm",
			);
			if (trulyMissing.length > 0) {
				lines.push("", `❌ Missing (${trulyMissing.length}):`);
				for (const tool of trulyMissing) {
					lines.push(`  ✗ ${tool.name} (${tool.strategy})`);
				}
				lines.push(
					"",
					"Note: GitHub-release tools auto-install when you open files of those languages",
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-allow-edit", {
		description:
			"Allow one edit to a file without a prior read. Usage: /lens-allow-edit <path>",
		handler: async (args, ctx) => {
			const [rawTarget] = normalizeCommandArgs(args);
			if (!rawTarget) {
				ctx.ui.notify("Usage: /lens-allow-edit <path>", "warning");
				return;
			}

			const targetPath = path.isAbsolute(rawTarget)
				? rawTarget
				: path.resolve(ctx.cwd ?? runtime.projectRoot, rawTarget);
			runtime.readGuard.addExemption(targetPath);
			ctx.ui.notify(
				`Read guard override armed for next edit: ${targetPath}`,
				"info",
			);
		},
	});

	// --- Tools (extracted to tools/) ---
	// Guard each registration: if another extension (e.g. @narumitw/pi-lsp) already
	// owns the same tool name, registerTool throws and would abort extension load.
	// Catch the collision silently so both extensions can coexist.
	for (const tool of [
		createAstGrepSearchTool(astGrepClient),
		createAstGrepReplaceTool(astGrepClient),
		createAstGrepOutlineTool(astGrepClient),
		createAstGrepDumpTool(astGrepClient),
		createAstDumpTool(astGrepClient),
		createLensDiagnosticsTool(
			cacheManager,
			() => runtime.projectRoot,
			undefined,
			// Flush pending per-edit dispatches before reporting so fixes made
			// earlier this turn are reflected (not the stale pre-fix state) (#190).
			() => flushDebouncedToolResults(),
		),
		createLspDiagnosticsTool(),
		createLspNavigationTool((name) => getLensFlag(name)),
		createModuleReportTool(() => runtime.projectRoot),
		createReadSymbolTool(
			() => runtime.projectRoot,
			// Read-substitute tie-in (#245): a returned symbol body is a genuine read
			// of that range, so record it as read-guard coverage for the symbol.
			(filePath, symbol) =>
				runtime.readGuard.recordSymbolRead(
					filePath,
					symbol,
					runtime.turnIndex,
					runtime.peekWriteIndex(),
				),
		),
		createReadEnclosingTool(
			() => runtime.projectRoot,
			(filePath, symbol) =>
				runtime.readGuard.recordSymbolRead(
					filePath,
					symbol,
					runtime.turnIndex,
					runtime.peekWriteIndex(),
				),
		),
	]) {
		try {
			pi.registerTool(tool as any);
		} catch {
			// another extension already registered a tool with this name
		}
	}

	// REMOVED: ~450 lines of inline tool definitions moved to tools/
	// See tools/ast-grep-search.ts, tools/ast-grep-replace.ts, tools/lsp-navigation.ts

	// Runtime state is managed by RuntimeCoordinator.

	// Project rules scan result and per-turn state live in RuntimeCoordinator.

	// --- Register skills with pi ---
	pi.on("resources_discover", async (_event, _ctx) => {
		// Resolve skills relative to the package root (nearest package.json), not the
		// module's own directory — under the compiled dist/ layout (#182) the module
		// lives in dist/ but skills/ stays at the package root, so a module-relative
		// join lands on the non-existent dist/skills/ and skills silently fail to load
		// (#205). resolvePackagePath walks up to package.json, correct for both the
		// source (index.ts at root) and dist (dist/index.js) layouts.
		const skillsDir = resolvePackagePath(import.meta.url, "skills");

		return {
			skillPaths: [skillsDir],
		};
	});

	// --- Events ---

	pi.on("session_start", async (event, ctx) => {
		try {
			dbg("session_start fired");
			updateRuntimeIdentityFromEvent(event);
			// #190: pi's session lifecycle. `reason` distinguishes new/resume/fork/
			// reload/startup; the STABLE session id comes from the session manager
			// (the event carries none), and is what lets a resumed session rehydrate.
			const sessionReason = (event as { reason?: string }).reason;
			const stableSessionId = (() => {
				try {
					return (
						ctx as { sessionManager?: { getSessionId?: () => string } }
					)?.sessionManager?.getSessionId?.();
				} catch {
					return undefined;
				}
			})();
			try {
				await ensureLSPConfigInitialized(ctx.cwd ?? process.cwd());
			} catch (cfgErr) {
				dbg(`lsp config init failed: ${cfgErr}`);
			}

			const {
				metricsClient,
				todoScanner,
				biomeClient,
				ruffClient,
				knipClient,
				jscpdClient,
				govulncheckClient,
				gitleaksClient,
				trivyClient,
				typeCoverageClient,
				depChecker,
				testRunnerClient,
				goClient,
				rustClient,
				deadCodeClients,
			} = await loadBootstrapClients();
			await handleSessionStart({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => getLensFlag(name),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				dbg,
				log,
				runtime,
				metricsClient,
				cacheManager,
				todoScanner,
				astGrepClient,
				biomeClient,
				ruffClient,
				knipClient,
				jscpdClient,
				deadCodeClients,
				govulncheckClient,
				gitleaksClient,
				trivyClient,
				typeCoverageClient,
				depChecker,
				testRunnerClient,
				goClient,
				rustClient,
				ensureTool: async (name: string) =>
					(await import("./clients/installer/index.js")).ensureTool(name),
				cleanStaleTsBuildInfo,
				resetDispatchBaselines,
				resetLSPService,
			});
			ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);

			// Pin the stable identity + reason AFTER handleSessionStart (which ran
			// resetForSession → a fresh random id); the stable id now wins (#190).
			runtime.setSessionLifecycle({
				sessionId: stableSessionId,
				reason: sessionReason,
			});

			// Lifecycle-aware widget state (#190). The "should I rehydrate" signal is
			// NOT the reason — it's whether a persisted snapshot exists for this
			// STABLE session id. A `pi --session <id>` launch fires reason="startup"
			// (not "resume" — that's only an in-process switchSession), so gating on
			// "resume" alone missed the common resume path. So: fork branches from
			// the in-memory stash; reload keeps state; new starts clean; everything
			// else (resume / startup / default) rehydrates IFF a snapshot exists —
			// a brand-new session has a fresh id with no file (→ clean), a
			// resumed/launched one has its prior file (→ rehydrate).
			const reasonLabel = sessionReason ?? "startup";
			const startMode = sessionStartMode(sessionReason, !!pendingForkSnapshot);
			if (startMode === "fork" && pendingForkSnapshot) {
				// Branch the forked session from the source's in-memory snapshot, then
				// persist it under the new session id so the fork owns its own copy.
				clearWidgetState();
				importWidgetState(pendingForkSnapshot);
				const forkedFileCount = pendingForkSnapshot.files.length;
				pendingForkSnapshot = undefined;
				if (stableSessionId) {
					void saveSessionState(
						ctx.cwd ?? process.cwd(),
						stableSessionId,
						exportWidgetState(),
					);
				}
				dbg(
					`session_start: fork — branched ${forkedFileCount} file(s) from source`,
				);
			} else if (startMode === "keep") {
				dbg("session_start: reload — keeping widget state");
			} else if (startMode === "clean") {
				pendingForkSnapshot = undefined;
				clearWidgetState();
				dbg("session_start: new — clean widget");
			} else {
				// maybe-rehydrate: covers resume AND startup (e.g. `pi --session <id>`)
				pendingForkSnapshot = undefined;
				clearWidgetState();
				if (stableSessionId) {
					const persisted = await loadSessionState(
						ctx.cwd ?? process.cwd(),
						stableSessionId,
					);
					if (persisted?.widget) {
						// #180/#190: drop files changed on disk since the snapshot so a
						// resume never surfaces stale diagnostics; they re-scan on edit.
						const fresh = await dropStaleFiles(
							persisted.widget,
							persisted.savedAt,
						);
						const dropped = persisted.widget.files.length - fresh.files.length;
						importWidgetState(fresh);
						dbg(
							`session_start: ${reasonLabel} ${stableSessionId} — rehydrated ${fresh.files.length} file(s)` +
								(dropped > 0 ? `, dropped ${dropped} stale` : ""),
						);
					} else {
						dbg(
							`session_start: ${reasonLabel} ${stableSessionId} — no persisted state (clean)`,
						);
					}
				} else {
					dbg(`session_start: ${reasonLabel} — no stable session id (clean)`);
				}
			}

			if (lensWidgetVisible) {
				mountLensWidget(ctx.ui);
			}
		} catch (sessionErr) {
			dbg(`session_start crashed: ${sessionErr}`);
			dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
		}
	});

	// #190 Phase 2: capture the source session's diagnostics just before a fork,
	// so the forked session (its `session_start` fires with reason="fork") can
	// branch from them instead of starting empty. In-memory hand-off within the
	// same process; cleared once adopted (or on any non-fork start).
	(pi as any).on("session_before_fork", () => {
		try {
			pendingForkSnapshot = exportWidgetState();
			dbg(
				`session_before_fork: stashed ${pendingForkSnapshot.files.length} file(s) for the fork`,
			);
		} catch (forkErr) {
			dbg(`session_before_fork crashed: ${forkErr}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = (event as { toolName?: string }).toolName ?? "";
		if (!lensEnabled) return;
		if (
			getLensFlag("lens-guard") &&
			isGitCommitOrPushAttempt(toolName, event.input)
		) {
			const guard = evaluateGitGuard(
				runtime,
				cacheManager,
				ctx.cwd ?? runtime.projectRoot,
			);
			if (guard.block) {
				return {
					block: true,
					reason: guard.reason,
				};
			}
		}

		const rawFilePath = getToolCallRawFilePath(toolName, event);
		const filePath = resolveToolCallFilePath(
			rawFilePath,
			ctx.cwd,
			runtime.projectRoot,
		);

		if (!getLensFlag("no-lsp")) {
			try {
				const configCwd = filePath
					? path.dirname(filePath)
					: (ctx.cwd ?? runtime.projectRoot ?? process.cwd());
				await ensureLSPConfigInitialized(configCwd);
			} catch (cfgErr) {
				dbg(`lsp config init failed during tool_call: ${cfgErr}`);
			}
		}

		if (!filePath) return;

		dbg(
			`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
		);
		if (!nodeFs.existsSync(filePath)) return;
		if (isPathIgnoredByProject(filePath, runtime.projectRoot, false)) {
			dbg(`tool_call: skipping gitignored file ${filePath}`);
			return;
		}

		const isExternalOrVendor = isExternalOrVendorFile(
			filePath,
			runtime.projectRoot,
		);

		const lspCapableFile = isLspCapableFile(filePath);
		const lspAutoTouchSkipped = shouldSkipLspAutoTouch(
			filePath,
			runtime.projectRoot,
		);
		const lspAutoTouchEligible = lspCapableFile && !lspAutoTouchSkipped;
		const shouldWarmReadLsp =
			toolName === "read" &&
			lspAutoTouchEligible &&
			runtime.shouldWarmLspOnRead(filePath);
		const shouldAutoTouch =
			(toolName === "write" ||
				toolName === "edit" ||
				toolName === "lsp_navigation" ||
				shouldWarmReadLsp) &&
			!getLensFlag("no-lsp") &&
			lspAutoTouchEligible;
		if (!lspCapableFile && !getLensFlag("no-lsp")) {
			dbg(
				`lsp auto-touch skipped: ${path.basename(filePath)} (file kind not LSP-capable)`,
			);
		} else if (lspAutoTouchSkipped && !getLensFlag("no-lsp")) {
			dbg(
				`lsp auto-touch skipped: ${path.basename(filePath)} (internal/support artifact)`,
			);
		}
		if (toolName === "read" && !getLensFlag("no-lsp") && !shouldWarmReadLsp) {
			const readSkipReason = !lspAutoTouchEligible
				? "file not eligible for LSP warm"
				: "already warming or warmed recently";
			dbg(
				`lsp read warm skipped: ${path.basename(filePath)} (${readSkipReason})`,
			);
		}
		if (shouldAutoTouch) {
			try {
				const fileContent = nodeFs.readFileSync(filePath, "utf-8");
				const maxClientWaitMs =
					toolName === "lsp_navigation"
						? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS
						: LSP_TOOLCALL_TOUCH_BUDGET_MS;
				if (toolName === "read") {
					runtime.markLspReadWarmStarted(filePath);
					dbg(`lsp read warm started: ${path.basename(filePath)}`);
				}
				void getLSPService()
					.touchFile(filePath, fileContent, {
						diagnostics: "none",
						source: `tool_call:${toolName}`,
						clientScope: "primary",
						maxClientWaitMs,
					})
					.then((result) => {
						if (toolName === "read") {
							if (result === undefined) {
								runtime.clearLspReadWarmState(filePath);
								dbg(
									`lsp read warm unavailable: ${path.basename(filePath)} (no LSP client ready)`,
								);
							} else {
								runtime.markLspReadWarmCompleted(filePath);
								dbg(`lsp read warm completed: ${path.basename(filePath)}`);
							}
						}
						if (ctx.ui) {
							ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
						}
					})
					.catch((err) => {
						if (toolName === "read") {
							runtime.clearLspReadWarmState(filePath);
						}
						dbg(`lsp auto-touch failed for ${filePath}: ${err}`);
					});
			} catch {
				if (toolName === "read") {
					runtime.clearLspReadWarmState(filePath);
				}
				// Best effort only; never block tool calls.
			}
		}

		const readInput = getReadToolInput(toolName, event.input);
		const requestedReadOffset = readInput?.offset ?? 1;
		const requestedReadLimit = readInput?.limit;
		let effectiveReadOffset = requestedReadOffset;
		let effectiveReadLimit = getEffectiveReadLimit(filePath, readInput);

		// --- Opportunistic read expansion via tree-sitter ---
		// For partial reads (small limit, not from line 1), find the enclosing
		// symbol and expand the read range to cover it. This gives the read guard
		// accurate symbol-level coverage without requiring an LSP server.
		let expandedByLsp = false;
		let enclosingSymbol:
			| {
					name: string;
					kind: string;
					startLine: number;
					endLine: number;
			  }
			| undefined;

		if (
			toolName === "read" &&
			!getLensFlag("no-lsp") &&
			!isExternalOrVendor &&
			filePath &&
			readInput &&
			requestedReadLimit != null &&
			requestedReadLimit <= EXPANSION_LIMIT_LINES
		) {
			const totalLines =
				effectiveReadLimit != null && requestedReadLimit == null
					? effectiveReadLimit
					: countFileLines(filePath);
			try {
				const expansion = await tryExpandRead(
					filePath,
					requestedReadOffset,
					requestedReadLimit,
					totalLines,
					_readExpansionClient,
				);
				if (expansion) {
					readInput.offset = expansion.newOffset;
					readInput.limit = expansion.newLimit;
					effectiveReadOffset = expansion.newOffset;
					effectiveReadLimit = expansion.newLimit;
					expandedByLsp = true;
					enclosingSymbol = expansion.enclosingSymbol;
					logReadGuardEvent({
						event: "ts_range_expanded",
						sessionId: runtime.telemetrySessionId,
						filePath,
						requestedOffset: requestedReadOffset,
						requestedLimit: requestedReadLimit,
						effectiveOffset: expansion.newOffset,
						effectiveLimit: expansion.newLimit,
						symbol: expansion.enclosingSymbol.name,
						symbolKind: expansion.enclosingSymbol.kind,
						symbolStartLine: expansion.enclosingSymbol.startLine,
						symbolEndLine: expansion.enclosingSymbol.endLine,
						metadata: {
							durationMs: expansion.durationMs,
							budgetMs: EXPANSION_BUDGET_MS,
						},
					});
					const symbolPath = [
						...(expansion.ancestry ?? []).map((a) => a.name),
						expansion.enclosingSymbol.name,
					].join(" → ");
					dbg(
						`ts expanded read: ${path.basename(filePath)} ` +
							`lines ${requestedReadOffset}–${requestedReadOffset + requestedReadLimit - 1} ` +
							`→ ${symbolPath} ` +
							`(${expansion.newOffset}–${expansion.newOffset + expansion.newLimit - 1})`,
					);
				}
			} catch {
				// Best-effort only.
			}
		}

		// --- Read-Before-Edit Guard: record reads ---
		if (toolName === "read" && filePath && !isExternalOrVendor) {
			const totalLines = countFileLines(filePath);
			const deliveredLimit = effectiveReadLimit ?? 1;
			logReadGuardEvent({
				event: "read_pattern",
				sessionId: runtime.telemetrySessionId,
				filePath,
				requestedOffset: requestedReadOffset,
				requestedLimit: requestedReadLimit ?? deliveredLimit,
				effectiveOffset: effectiveReadOffset,
				effectiveLimit: deliveredLimit,
				metadata: {
					totalLines,
					isPartial:
						requestedReadLimit != null && requestedReadLimit < totalLines,
					fileKind: detectFileKind(filePath) ?? "unknown",
					fractionRead:
						totalLines > 0
							? Math.round((deliveredLimit / totalLines) * 100) / 100
							: 1,
					expandedByTs: expandedByLsp,
				},
			});
			runtime.readGuard.recordRead({
				filePath,
				requestedOffset: requestedReadOffset,
				requestedLimit: requestedReadLimit ?? deliveredLimit,
				effectiveOffset: effectiveReadOffset,
				effectiveLimit: deliveredLimit,
				expandedByLsp,
				enclosingSymbol,
				turnIndex: runtime.turnIndex,
				writeIndex: runtime.peekWriteIndex(),
				timestamp: Date.now(),
			});
		}

		// --- Read-Before-Edit Guard: register file access done via `bash` ---
		// Mirrors how the Read/Write tools are tracked. Only the bash tool —
		// grep/find tools (and their patterns) are not contiguous file access.
		//   reads  (cat/head/tail/sed -n) → recordRead with the exact range shown
		//   writes (>, >>, tee, sed -i, cp/mv dest, touch) → noteCreatedFile, so the
		//          agent "owns" the file (recordWritten fires at tool_result), same
		//          as the Write tool.
		if (toolName === "bash" && !getLensFlag("no-read-guard")) {
			const cmd = (event.input as Record<string, unknown>)?.command;
			if (typeof cmd === "string" && cmd) {
				const effectiveCwd = ctx.cwd ?? runtime.projectRoot ?? process.cwd();
				const inScope = (fp: string) =>
					!isPathIgnoredByProject(fp, runtime.projectRoot, false) &&
					!isExternalOrVendorFile(fp, runtime.projectRoot);

				for (const span of extractReadPathsFromCommand(cmd, effectiveCwd)) {
					if (!inScope(span.filePath)) continue;
					runtime.readGuard.recordRead({
						filePath: span.filePath,
						requestedOffset: span.offset,
						requestedLimit: span.limit,
						effectiveOffset: span.offset,
						effectiveLimit: span.limit,
						expandedByLsp: false,
						turnIndex: runtime.turnIndex,
						writeIndex: runtime.peekWriteIndex(),
						timestamp: Date.now(),
					});
				}

				for (const wp of extractWrittenPathsFromCommand(cmd, effectiveCwd)) {
					if (!inScope(wp)) continue;
					runtime.readGuard.noteCreatedFile(
						wp,
						runtime.turnIndex,
						runtime.peekWriteIndex(),
					);
				}
			}
		}

		const { complexityClient } = await loadBootstrapClients();
		// Record complexity baseline for historical tracking (booboo/tdi).
		// Not shown inline - just captured for delta analysis.
		if (
			!isExternalOrVendor &&
			complexityClient.isSupportedFile(filePath) &&
			!runtime.complexityBaselines.has(filePath)
		) {
			const baseline = complexityClient.analyzeFile(filePath);
			if (baseline) {
				runtime.complexityBaselines.set(filePath, baseline);
				const { captureSnapshot } = await import(
					"./clients/metrics-history.js"
				);
				captureSnapshot(filePath, {
					maintainabilityIndex: baseline.maintainabilityIndex,
					cognitiveComplexity: baseline.cognitiveComplexity,
					maxNestingDepth: baseline.maxNestingDepth,
					linesOfCode: baseline.linesOfCode,
					maxCyclomatic: baseline.maxCyclomaticComplexity,
					entropy: baseline.codeEntropy,
				});
			}
		}

		// --- Read-Before-Edit Guard: check edits ---
		// write = full replacement; no prior read needed (you're starting fresh).
		// edit = partial modification; guard enforced to prevent blind overwrites.
		const isEditOnly = isToolCallEventType("edit", event);
		const isWriteOrEdit = isToolCallEventType("write", event) || isEditOnly;

		// Track any Write so recordWritten can inject a synthetic read afterward.
		// The agent authored the content (new or overwritten), so it trivially "knows" the file.
		if (
			!isEditOnly &&
			isWriteOrEdit &&
			filePath &&
			!getLensFlag("no-read-guard")
		) {
			runtime.readGuard.noteCreatedFile(
				filePath,
				runtime.turnIndex,
				runtime.peekWriteIndex(),
			);
		}

		// --- Indentation mismatch correction ---
		// Some models output spaces in oldText when the file uses tabs (or vice versa).
		// Detect this before the read guard runs so a recoverable mismatch does not
		// degrade into a no-line-info allow path.
		if (isEditOnly && filePath) {
			const editInput = (event as { input?: unknown }).input as {
				oldText?: string;
				newText?: string;
				edits?: Array<{ oldText?: string; newText?: string }>;
			};
			type EditIndentTarget = {
				label: string;
				value: string;
				newText: string | undefined;
				apply: (corrected: string) => void;
				applyNewText: (corrected: string) => void;
			};
			const oldTexts: EditIndentTarget[] = editInput.oldText
				? [
						{
							label: "oldText",
							value: editInput.oldText,
							newText: editInput.newText,
							apply: (corrected: string) => {
								editInput.oldText = corrected;
							},
							applyNewText: (corrected: string) => {
								editInput.newText = corrected;
							},
						},
					]
				: (editInput.edits ?? [])
						.map((e, i) =>
							e.oldText
								? {
										label: `edits[${i}].oldText`,
										value: e.oldText,
										newText: e.newText,
										apply: (corrected: string) => {
											e.oldText = corrected;
										},
										applyNewText: (corrected: string) => {
											e.newText = corrected;
										},
									}
								: null,
						)
						.filter((entry): entry is EditIndentTarget => entry !== null);
			// Read the file once; derive the two normalized forms needed by
			// tryCorrectIndentationMismatchFromContent (CRLF->LF only) and
			// countOldTextMatches / the autopatch bridge (host fuzzy-match space).
			let crlfContent: string | undefined;
			let matchNormalizedContent: string | undefined;
			try {
				const raw = nodeFs.readFileSync(filePath, "utf-8");
				crlfContent = raw.replace(/\r\n/g, "\n");
				matchNormalizedContent = normalizeOldTextForMatch(raw);
			} catch {
				// File unreadable — corrections will be skipped gracefully below.
			}

			// --- Pass 0: escaped control-char correction ---
			// Models may write literal \n or \t in oldText (JSON interprets them as actual
			// newline/tab) when the file has the two-character escape sequences (e.g. inside
			// a regex or string literal). Safety gates: original must not match at all;
			// escaped version must match exactly once.
			if (matchNormalizedContent !== undefined) {
				for (const entry of oldTexts) {
					const v = entry.value;
					if (!v.includes("\t") && !v.includes("\n")) continue;
					if (countOldTextMatches(filePath, v, matchNormalizedContent) !== 0)
						continue;
					const escaped = v.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
					if (escaped === v) continue;
					if (
						countOldTextMatches(filePath, escaped, matchNormalizedContent) !== 1
					)
						continue;
					entry.apply(escaped);
					entry.value = escaped;
					logReadGuardEvent({
						event: "oldtext_escape_autopatched",
						sessionId: runtime.telemetrySessionId,
						filePath,
						metadata: { tool: "edit", label: entry.label },
					});
				}
			}

			// --- Pass 1: trailing whitespace correction ---
			// Editors strip trailing whitespace on save; the model may copy content
			// that had it. Safety gates: the original raw oldText must not already
			// match, and the stripped raw candidate must match exactly once. When
			// trailing empty lines are stripped from oldText, strip the equivalent
			// suffix from newText so the replacement span is not accidentally widened.
			if (crlfContent !== undefined) {
				for (const entry of oldTexts) {
					const patch = computeTrailingWhitespaceOldTextPatch({
						oldText: entry.value,
						newText: entry.newText,
						fileContent: crlfContent,
					});
					if (!patch) continue;
					entry.apply(patch.oldText);
					entry.value = patch.oldText;
					const newTextPatched =
						patch.newText !== undefined && patch.newText !== entry.newText;
					if (newTextPatched) {
						entry.applyNewText(patch.newText!);
						entry.newText = patch.newText;
					}
					logReadGuardEvent({
						event: "oldtext_trailing_ws_autopatched",
						sessionId: runtime.telemetrySessionId,
						filePath,
						metadata: {
							tool: "edit",
							label: entry.label,
							removedLineTrailingWhitespace:
								patch.removedLineTrailingWhitespace,
							removedTrailingEmptyLineCount:
								patch.removedTrailingEmptyLineCount,
							newTextTrailingEmptyLinesPatched: newTextPatched,
						},
					});
					// Bridge: same rationale as the indent autopatch — the
					// trailing-ws patcher only applies when the stripped oldText
					// matches exactly once against the file, so the agent's text
					// reflects real content at the matched span. Register a
					// synthetic read covering it so the read-guard downstream
					// doesn't fire a zero_read block after the verification.
					if (matchNormalizedContent !== undefined && runtime.readGuard) {
						const range = findUniqueMatchLineRange(
							matchNormalizedContent,
							patch.oldText,
						);
						if (range) {
							runtime.readGuard.recordRead({
								filePath,
								requestedOffset: range.startLine,
								requestedLimit: range.endLine - range.startLine + 1,
								effectiveOffset: range.startLine,
								effectiveLimit: range.endLine - range.startLine + 1,
								expandedByLsp: false,
								turnIndex: runtime.turnIndex,
								writeIndex: 0,
								timestamp: Date.now(),
							});
						}
					}
				}
			}

			const correctedOldTexts = oldTexts
				.map(({ label, value, newText, apply, applyNewText }) => {
					const corrected =
						crlfContent !== undefined
							? tryCorrectIndentationMismatchFromContent(value, crlfContent)
							: tryCorrectIndentationMismatch(value, filePath);
					return corrected === undefined
						? undefined
						: {
								label,
								value,
								newText,
								corrected,
								apply,
								applyNewText,
								currentMatchCount: countOldTextMatches(
									filePath,
									value,
									matchNormalizedContent,
								),
								correctedMatchCount: countOldTextMatches(
									filePath,
									corrected,
									matchNormalizedContent,
								),
								indentationOnly: isIndentationOnlyChange(value, corrected),
							};
				})
				.filter(
					(
						entry,
					): entry is EditIndentTarget & {
						corrected: string;
						currentMatchCount: number;
						correctedMatchCount: number;
						indentationOnly: boolean;
					} => entry !== undefined,
				);
			// Apply safe corrections individually — each edit stands alone.
			// Unsafe corrections (non-indentation-only or ambiguous) fall through
			// to resolveOldTextEdits, which handles them per-edit with proper
			// oldtext_duplicate / oldtext_not_found reporting and partial apply.
			for (const entry of correctedOldTexts) {
				if (
					entry.indentationOnly &&
					entry.currentMatchCount === 0 &&
					entry.correctedMatchCount === 1
				) {
					entry.apply(entry.corrected);
					const correctedNewText = entry.newText
						? retargetReplacementIndentation(
								entry.newText,
								entry.value,
								entry.corrected,
							)
						: undefined;
					if (correctedNewText !== undefined) {
						entry.applyNewText(correctedNewText);
					}
					logReadGuardEvent({
						event: "oldtext_indent_autopatched",
						sessionId: runtime.telemetrySessionId,
						filePath,
						metadata: {
							tool: "edit",
							label: entry.label,
							correctedMatchCount: entry.correctedMatchCount,
							newTextIndentationPatched: correctedNewText !== undefined,
						},
					});
					// Bridge: a unique-match autopatch proves the agent's oldText
					// reflects real content at this span. Register a synthetic read
					// for the matched range so a zero_read block downstream isn't
					// thrown after the autopatch already verified the content.
					if (matchNormalizedContent !== undefined && runtime.readGuard) {
						const range = findUniqueMatchLineRange(
							matchNormalizedContent,
							entry.corrected,
						);
						if (range) {
							runtime.readGuard.recordRead({
								filePath,
								requestedOffset: range.startLine,
								requestedLimit: range.endLine - range.startLine + 1,
								effectiveOffset: range.startLine,
								effectiveLimit: range.endLine - range.startLine + 1,
								expandedByLsp: false,
								turnIndex: runtime.turnIndex,
								writeIndex: 0,
								timestamp: Date.now(),
							});
						}
					}
				}
			}
		}
		if (isEditOnly && filePath && !getLensFlag("no-read-guard")) {
			const readGuard = runtime.readGuard;
			const isExistingFile =
				typeof readGuard?.isNewFile !== "function" ||
				!readGuard.isNewFile(filePath);
			if (readGuard && isExistingFile && !isExternalOrVendor) {
				const {
					touchedLines,
					editRanges,
					preflightError,
					partiallyApplicable,
					contentMatchValidated,
				} = getTouchedLinesForGuard(
					event,
					filePath,
					runtime.telemetrySessionId,
				);
				if (preflightError) {
					if (partiallyApplicable && partiallyApplicable.length > 0) {
						try {
							const partial = await applyPartiallyApplicableEdits({
								filePath,
								edits: partiallyApplicable,
								afterWrite: async () => {
									const {
										biomeClient,
										ruffClient,
										metricsClient,
										agentBehaviorClient,
									} = await loadBootstrapClients();
									const result = await handleToolResult({
										event: {
											toolName: "write",
											input: { path: filePath },
											details: { piLensPartialApply: true },
											content: [],
											provider: (event as { provider?: string }).provider,
											model: (event as { model?: string }).model,
											sessionId: (event as { sessionId?: string }).sessionId,
											session: (event as { session?: { id?: string } }).session,
										},
										getFlag: (name: string) => getLensFlag(name),
										dbg,
										runtime,
										cacheManager,
										biomeClient,
										ruffClient,
										metricsClient,
										resetLSPService,
										readGuard: runtime.readGuard,
										agentBehaviorRecord: (toolName, analyzedPath) =>
											agentBehaviorClient.recordToolCall(
												toolName,
												analyzedPath,
											),
										formatBehaviorWarnings: (warnings) =>
											agentBehaviorClient.formatWarnings(warnings as any),
									});
									return result?.content
										?.map((item) => item.text)
										.filter((text): text is string => !!text)
										.join("\n\n");
								},
							});
							if (partial.appliedCount > 0) {
								logReadGuardEvent({
									event: "edit_partial_apply",
									sessionId: runtime.telemetrySessionId,
									filePath,
									metadata: {
										appliedCount: partial.appliedCount,
										appliedIndices: partial.appliedIndices,
										routedThroughPostEditPipeline: true,
									},
								});
								let reason = preflightError.replace(
									"🔄 RETRYABLE — Edit target not found",
									`⚠️ PARTIAL APPLY — ${partial.appliedCount} edit${partial.appliedCount !== 1 ? "s" : ""} applied (${partial.appliedIndices})`,
								);
								if (partial.postEditOutput) {
									reason += `\n\nPost-apply analysis:\n${partial.postEditOutput}`;
								}
								return { block: true, reason };
							}
						} catch {
							// fall through to full block
						}
					}
					return { block: true, reason: preflightError };
				}
				logReadGuardEvent({
					event: "edit_check_started",
					sessionId: runtime.telemetrySessionId,
					filePath,
					metadata: {
						tool: isToolCallEventType("write", event) ? "write" : "edit",
						touchedLines: touchedLines ?? null,
						isExistingFile,
					},
				});
				const verdict =
					typeof readGuard.checkEdit === "function"
						? readGuard.checkEdit(filePath, touchedLines, editRanges, {
								skipSnapshotCheck: !!contentMatchValidated,
								oldTextResolved: !!contentMatchValidated,
							})
						: { action: "allow" as const };
				// Content-verified range-stale relocation: the lines the agent meant
				// to edit moved (read-time line hashes uniquely match the new spot),
				// so re-target the positional edit to where the content now lives
				// instead of dead-ending. Safe because the hashes prove the new span
				// IS the intended content — the same guarantee that lets
				// pi-hashline-readmap auto-apply. Single-range only (set by the guard).
				if (verdict.relocation) {
					const relocated = relocateEditRange(
						(event as { input?: unknown }).input,
						verdict.relocation.from,
						verdict.relocation.to,
					);
					if (relocated) {
						const [toStart, toEnd] = verdict.relocation.to;
						runtime.readGuard?.recordRead({
							filePath,
							requestedOffset: toStart,
							requestedLimit: toEnd - toStart + 1,
							effectiveOffset: toStart,
							effectiveLimit: toEnd - toStart + 1,
							expandedByLsp: false,
							turnIndex: runtime.turnIndex,
							writeIndex: 0,
							timestamp: Date.now(),
						});
						logReadGuardEvent({
							event: "edit_range_relocated",
							sessionId: runtime.telemetrySessionId,
							filePath,
							metadata: {
								tool: "edit",
								from: verdict.relocation.from,
								to: verdict.relocation.to,
							},
						});
						// Relocation applied — let the re-targeted edit proceed.
					} else if (verdict.action === "block") {
						return { block: true, reason: verdict.reason };
					}
				} else if (verdict.action === "block") {
					return {
						block: true,
						reason: verdict.reason,
					};
				}
			}
		}

		// --- Pre-write duplicate detection ---
		// Check if new content redefines functions that already exist elsewhere.
		// Uses cachedExports (populated at session_start via ast-grep scan).
		if (isWriteOrEdit && runtime.cachedExports.size > 0) {
			const newContent = getNewContentFromToolCall(event);
			if (newContent) {
				const dupeWarnings: string[] = [];
				const exportRe =
					/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
				// Read current on-disk content once so we can check whether the file
				// being written already owns a given export (e.g. it IS the source and
				// another file merely re-exports from it). cachedExports only tracks one
				// file per name — whichever was scanned first — so a re-exporter can
				// win the slot and incorrectly shadow the original definition.
				let currentFileExports: Set<string> | undefined;
				if (filePath && nodeFs.existsSync(filePath)) {
					try {
						const currentContent = nodeFs.readFileSync(filePath, "utf-8");
						currentFileExports = new Set<string>();
						for (const m of currentContent.matchAll(exportRe)) {
							currentFileExports.add(m[1]);
						}
					} catch {
						// non-fatal — fall back to no current-export knowledge
					}
				}
				for (const match of newContent.matchAll(exportRe)) {
					const name = match[1];
					const existingFile = runtime.cachedExports.get(name);
					if (
						existingFile &&
						path.resolve(existingFile) !== path.resolve(filePath) &&
						!currentFileExports?.has(name)
					) {
						dupeWarnings.push(
							`\`${name}\` already exists in ${path.relative(runtime.projectRoot, existingFile)}`,
						);
					}
				}
				if (dupeWarnings.length > 0) {
					return {
						block: true,
						reason:
							"🔴 STOP - Redefining existing export(s). Import instead:\n" +
							dupeWarnings.map((w) => "  • " + w).join("\n"),
					};
				}
			}
		}
	});

	// Real-time feedback on file writes/edits
	// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
	(pi as any).on("tool_result", async (event: any, ctx: any) => {
		if (!lensEnabled) return;
		updateRuntimeIdentityFromEvent(event);
		// Publish this turn's abort signal so the dispatch's linter/type-check
		// child processes are killed if the agent is interrupted (#197 ctx.signal).
		setAmbientAbortSignal(ctx?.signal);
		try {
			const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
				await loadBootstrapClients();
			return await handleToolResult({
				event: event as any,
				getFlag: (name: string) => getLensFlag(name),
				dbg,
				runtime,
				cacheManager,
				biomeClient,
				ruffClient,
				metricsClient,
				resetLSPService,
				readGuard: runtime.readGuard,
				agentBehaviorRecord: (toolName, filePath) =>
					agentBehaviorClient.recordToolCall(toolName, filePath),
				formatBehaviorWarnings: (warnings) =>
					agentBehaviorClient.formatWarnings(warnings as any),
			});
		} finally {
			setAmbientAbortSignal(undefined);
		}
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	// Clear cascade snapshot at start of each new turn so stale data never leaks
	pi.on("turn_start", (_event: any) => {
		runtime.beginTurn();
		clearLastAnalyzedStateCache();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!lensEnabled) return;
		// Esc/abort during the deferred format + flush kills in-flight children.
		setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
		try {
			// Ensure any pipeline still queued in the debounce window finishes
			// before agent_end runs — otherwise project change-log entries and
			// modified ranges this turn produced may not be reflected yet.
			await flushDebouncedToolResults();
			await handleAgentEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => getLensFlag(name),
				notify: (msg, level) => ctx.ui.notify(msg, level),
				dbg,
				runtime,
				cacheManager,
				getFormatService: () =>
					getFormatService(runtime.telemetrySessionId, true),
			});
			ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		} catch (agentEndErr) {
			dbg(`agent_end crashed: ${agentEndErr}`);
			dbg(`agent_end crash stack: ${(agentEndErr as Error).stack}`);
		} finally {
			setAmbientAbortSignal(undefined);
		}
	});

	pi.on("turn_end", async (_event: any, ctx) => {
		if (!lensEnabled) return;
		// Esc/abort during the turn-end flush (knip/madge/tests + debounced
		// dispatch) kills in-flight children instead of waiting out their timeout.
		setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
		try {
			const repaintLspStatus = captureLspStatusRepaint(ctx);
			// Persist a new worst event-loop block to latency.log, attributed to
			// this turn, so freezes are queryable across sessions (#192).
			const loopMaxMs = getEventLoopStats()?.maxMs ?? 0;
			if (shouldLogWorstBlock(loopMaxMs, lastLoggedLoopWorstMs)) {
				logLatency({
					type: "phase",
					filePath: "<pi-lens>",
					phase: "loop_block",
					durationMs: Math.round(loopMaxMs),
					metadata: { worstSoFar: true, turnIndex: runtime.turnIndex },
				});
				lastLoggedLoopWorstMs = loopMaxMs;
			}

			// Drain any tool_result still in the debounce window so turn_end
			// reads consistent state (cache, modified ranges, change-log).
			await flushDebouncedToolResults();
			const { knipClient, deadCodeClients, depChecker, testRunnerClient } =
				await loadBootstrapClients();
			await handleTurnEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => getLensFlag(name),
				dbg,
				runtime,
				cacheManager,
				knipClient,
				deadCodeClients,
				depChecker,
				testRunnerClient,
				// The LSP idle reset (240s of no turns) releases the warm servers
				// from a detached timer, with no pi event in flight — so nothing
				// would repaint the footer and it would keep showing a stale
				// "LSP Active". Wrap the reset to refresh the status right after it
				// fires; resetLSPService nulls the singleton synchronously, so the
				// repaint sees zero alive servers and renders "LSP Inactive" (#281).
				// Capture the repaint callback during the active event — detached timers
				// must not touch ctx.ui after session replacement/reload (#338).
				resetLSPService: () => {
					try {
						resetLSPService();
					} finally {
						repaintLspStatus?.();
					}
				},
				resetFormatService,
			});
			repaintLspStatus?.();

			// #190: persist this session's settled widget diagnostics so a later
			// resume (`pi --session <id>`) can rehydrate them. Only when pi gave us
			// a stable session id (else the file would be orphaned, never loaded).
			// Fire-and-forget — persistence must never delay or break a turn.
			if (runtime.hasStableSessionId) {
				void saveSessionState(
					ctx.cwd ?? process.cwd(),
					runtime.telemetrySessionId,
					exportWidgetState(),
				);
			}
		} catch (turnEndErr) {
			dbg(`turn_end crashed: ${turnEndErr}`);
			dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		} finally {
			setAmbientAbortSignal(undefined);
		}
	});

	// --- Session shutdown: release all handles so subagent processes exit cleanly ---
	// The LSP idle-reset timer (240s) is unref'd but we cancel it explicitly here
	// so it does not fire after shutdown. resetLSPService shuts down any live clients.
	(pi as any).on("session_shutdown", () => {
		cancelLSPIdleReset();
		// processExiting: the loop is closing here — killing LSP servers must NOT
		// spawn taskkill, or libuv aborts on uv_async_send to the closing loop
		// (Assertion !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c) — seen
		// on `pi update`. Direct handle-kill only; the OS reaps any orphans.
		resetLSPService({ fast: true, processExiting: true });
	});

	// --- Inject turn-end findings into next agent turn ---
	// jscpd, madge, and turn-end delta results are cached at turn_end and consumed here
	// via the context event, which fires before each provider request.
	// Important: keep the user's prompt as the trailing message. Some provider bridges
	// treat the final message as the active user action, so pi-lens context must be
	// prepended instead of appended.
	// biome-ignore lint/suspicious/noExplicitAny: pi.on("context") overload has TS resolution bug
	(pi as any).on(
		"context",
		async (
			event: { messages?: Array<{ role: string; content: unknown }> } | unknown,
			ctx: { cwd?: string },
		) => {
			if (!lensEnabled || !contextInjectionEnabled) return;
			try {
				const cwd = ctx.cwd ?? process.cwd();
				const turnEndFindings = consumeTurnEndFindings(cacheManager, cwd);
				const sessionGuidance = consumeSessionStartGuidance(cacheManager, cwd);
				const testFindings = consumeTestFindings(cacheManager, cwd);
				const injectedMessages = [
					...(sessionGuidance?.messages ?? []),
					...(turnEndFindings?.messages ?? []),
					...(testFindings?.messages ?? []),
				];
				if (injectedMessages.length === 0) return;

				const existingMessages =
					(event as { messages?: Array<{ role: string; content: unknown }> })
						?.messages ?? [];

				return {
					messages: [...injectedMessages, ...existingMessages],
				};
			} catch (err) {
				dbg(`context event error: ${err}`);
			}
		},
	);
}
