import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	getFormatService,
	resetFormatService,
} from "./clients/format-service.js";
import { getAllToolStatuses } from "./clients/installer/index.js";
import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
} from "./clients/lens-config.js";
import { initLensEvents } from "./clients/lens-events.js";
import { wireBusEmitter } from "./clients/bus-publish.js";
import { wireDiagnosticsBusEmitter } from "./clients/diagnostics-publish.js";
import { wireDispositionBusEmitter } from "./clients/disposition-publish.js";
import { wireFormatEventsBusEmitter } from "./clients/format-events-publish.js";
import {
	consumeAgentNudge,
	recordCrossProcessTouches,
	wireAgentNudgeSubscriber,
} from "./clients/agent-nudge.js";
import {
	readCrossProcessTouchesForSessionStart,
	readCrossProcessTouchesForTurnStart,
} from "./clients/recent-touches.js";
import { registerCascadeTierReconcileTask } from "./clients/lsp/cascade-tier.js";
import { initLSPConfig } from "./clients/lsp/config.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import { sweepOrphans, sweepUntrackedOrphans } from "./clients/instance-reaper.js";
import {
	deregisterInstance,
	registerInstance,
} from "./clients/instance-registry.js";
import { checkCrossProcessLspBudget } from "./clients/lsp-budget.js";
import { handleAgentEnd } from "./clients/runtime-agent-end.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "./clients/runtime-context.js";
import { RuntimeCoordinator } from "./clients/runtime-coordinator.js";
import { handleSessionStart } from "./clients/runtime-session.js";
import { handleToolCall } from "./clients/runtime-tool-call.js";
import {
	decideSessionStart,
	decrementSecondarySessionCount,
	noteSessionShutdown,
} from "./clients/session-lifecycle.js";
import {
	clearLastAnalyzedStateCache,
	flushDebouncedToolResults,
	handleToolResult,
} from "./clients/runtime-tool-result.js";
import { cancelLSPIdleReset, handleTurnEnd } from "./clients/runtime-turn.js";
import {
	registerBuiltinQuietWindowTasks,
	registerQuietWindowTask,
	runQuietWindow,
} from "./clients/quiet-window.js";
import { setAmbientAbortSignal } from "./clients/safe-spawn.js";
import { initI18n, t } from "./i18n.js";
import { createAstGrepDumpTool } from "./tools/ast-dump.js";
import {
	createActivateToolsTool,
	type ActivatableToolInfo,
} from "./tools/activate-tools.js";
import { createLensDiagnosticsTool } from "./tools/lens-diagnostics.js";
import { createLensDiagnosticMarkTool } from "./tools/lens-diagnostic-mark.js";
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
import { createSymbolSearchTool } from "./tools/symbol-search.js";
import { logLatency } from "./clients/latency-logger.js";
import {
	markPiLensLoaded,
	PI_LENS_LOADED_FROM,
} from "./clients/startup-timing.js";
import { toRunnerDisplayPath } from "./clients/dispatch/runner-context.js";
import {
	formatTurnSummaryLine,
	TURN_SUMMARY_CUSTOM_TYPE,
} from "./clients/turn-summary.js";
import { renderTurnSummaryMessage } from "./clients/turn-summary-render.js";
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
// #484: the quiet-window task registry (clients/quiet-window.ts `_tasks`) is
// module-level and survives factory re-activation in the same process (#473
// in-process subagent re-binds, reload). Register the turn-summary emit task
// ONCE (flag below, same pattern as registerCascadeTierReconcileTask) and
// have it read the CURRENT activation's pi/flag closures through this
// holder, refreshed on every activation — never a stale captured `pi`.
let _turnSummaryEmitRegistered = false;
let _turnSummaryEmitCtx:
	| {
			pi: ExtensionAPI;
			getLensFlag: (name: string) => boolean | string | undefined;
			isLensEnabled: () => boolean;
	  }
	| undefined;
const _lspConfigInitializedCwds = new Set<string>();

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
	wireBusEmitter(pi.events?.emit?.bind(pi.events));
	wireDiagnosticsBusEmitter(pi.events?.emit?.bind(pi.events));
	wireDispositionBusEmitter(pi.events?.emit?.bind(pi.events));
	wireFormatEventsBusEmitter(pi.events?.emit?.bind(pi.events));
	// #485: read-only bus subscriber — never publishes, so the #482 loop guard
	// (ingest -> write -> publish) has no write side to trip here.
	wireAgentNudgeSubscriber({
		events: pi.events,
		getReadGuard: () => runtime.readGuard,
		dbg,
	});
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
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example pyright)",
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

	pi.registerFlag("lens-turn-summary", {
		description:
			"Opt-in: persist a per-turn transcript entry summarizing diagnostics found, autofixes applied, and autoformats applied this turn (#484). Collapsed one-line, expandable in place. Default off. Also via turnSummary.enabled=true in ~/.pi-lens/config.json.",
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

	// #484: turn-summary custom message renderer. Feature-detected — older pi
	// hosts without registerMessageRenderer simply never get a renderer
	// registered (the raw `content` fallback text still shows since sendMessage
	// itself is guarded the same way at the emit site below).
	if (typeof (pi as { registerMessageRenderer?: unknown }).registerMessageRenderer === "function") {
		try {
			pi.registerMessageRenderer(TURN_SUMMARY_CUSTOM_TYPE, renderTurnSummaryMessage);
		} catch (registerRendererErr) {
			dbg(`turn-summary renderer registration failed: ${registerRendererErr}`);
		}
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

	pi.registerCommand("lens-tdi", {
		description:
			"Show Technical Debt Index (TDI) and project health trend. Usage: /lens-tdi",
		handler: async (_args, ctx) => {
			const { loadHistory, computeTDI } = await import(
				"./clients/metrics-history.js"
			);
			const history = loadHistory();
			const tdi = computeTDI(history);

			let summary = "🔴 High debt - run lens_diagnostics mode=full for details";
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
	//
	// Always-active tools (6): stay on for every turn — cheap, broadly useful,
	// or (in the loader's case) required to bootstrap dynamic activation below.
	const alwaysActiveTools = [
		createLensDiagnosticsTool(
			cacheManager,
			() => runtime.projectRoot,
			undefined,
			// Flush pending per-edit dispatches before reporting so fixes made
			// earlier this turn are reflected (not the stale pre-fix state) (#190).
			() => flushDebouncedToolResults(),
			// #571: reconcile mode=full's fresh, confirmed results into the footer
			// (widget-state's allDiagnostics) using the SAME write-ordering token
			// source pipeline.ts's per-edit recordDiagnostics calls draw from, so
			// a scan-originated write can't clobber a concurrent newer per-edit
			// write (or vice versa).
			() => runtime.nextWriteIndex(),
		),
		createLspDiagnosticsTool(
			// #571: same reconciliation wiring as lens_diagnostics mode=full, for
			// the standalone on-demand check.
			() => runtime.nextWriteIndex(),
		),
		createSymbolSearchTool(() => runtime.projectRoot),
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
	];

	// Situational tools (5): registered but, on hosts that support pi's dynamic
	// tooling (`pi.getActiveTools`/`pi.setActiveTools`), left inactive at load —
	// deactivated in the block below right after registration. The model
	// activates the ones it needs via `pi_lens_activate_tools`. On hosts without
	// that API this whole tier is simply left statically active, matching
	// pi-lens's behavior before this feature existed.
	const lazyTools = [
		createAstGrepSearchTool(astGrepClient),
		createAstGrepReplaceTool(astGrepClient),
		createAstGrepOutlineTool(astGrepClient),
		createAstGrepDumpTool(astGrepClient),
		createLspNavigationTool((name) => getLensFlag(name)),
		createLensDiagnosticMarkTool(() => runtime.projectRoot),
	];
	const LAZY_TOOL_CATALOG: ActivatableToolInfo[] = [
		{
			name: "ast_grep_search",
			summary:
				"AST-aware structural code search across ~40 languages (ast-grep patterns).",
		},
		{
			name: "ast_grep_replace",
			summary: "AST-aware structural code rewrite/refactor (ast-grep patterns).",
		},
		{
			name: "ast_grep_outline",
			summary:
				"Syntax-only file/dir structure (symbols/imports/exports/members) via ast-grep outline — no index/LSP.",
		},
		{
			name: "ast_grep_dump",
			summary:
				"Dump the tree-sitter AST for a source snippet to discover node kinds/field names.",
		},
		{
			name: "lsp_navigation",
			summary:
				"IDE-style LSP navigation: definition, references, implementation, rename, call hierarchy.",
		},
		{
			name: "lens_diagnostic_mark",
			summary:
				"Record a disposition for a diagnostic: false-positive / suppress (inline ignore comment) / defer (this session) / flagged (to fix).",
		},
	];
	const activateToolsTool = createActivateToolsTool(
		pi as unknown as {
			getActiveTools?: () => string[];
			setActiveTools?: (names: string[]) => void;
		},
		LAZY_TOOL_CATALOG,
	);

	for (const tool of [...alwaysActiveTools, activateToolsTool, ...lazyTools]) {
		try {
			pi.registerTool(tool as any);
		} catch {
			// another extension already registered a tool with this name
		}
	}

	// Dynamic tooling (#pi 0.80.x+): deactivate the 5 situational tools so they
	// start inactive and the model must call `pi_lens_activate_tools` to bring
	// them in (next-turn visibility, per the docs' loader pattern). This used
	// to run synchronously right here, immediately after registration — but
	// that point is still inside the extension's own load/activation function,
	// before the runtime considers itself initialized, so `setActiveTools`
	// structurally cannot succeed yet on ANY host (#643: it threw "Extension
	// runtime not initialized. Action methods cannot be called during
	// extension loading" on effectively every session_start, regardless of
	// host version — the 5 lazy tools were never actually deactivated). Moved
	// into the `pi.on("session_start", ...)` handler below, which fires after
	// the extension has finished loading — see the deactivation block there.

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

			// Dynamic tooling (#pi 0.80.x+): deactivate the 5 situational tools
			// (LAZY_TOOL_CATALOG) now that the extension has actually finished
			// loading — session_start is the correct lifecycle point for this
			// call (#643; see the comment left at the old call site above, right
			// after tool registration, for why it can never succeed there).
			// Feature-detected the same way as elsewhere in this handler:
			// `pi.getActiveTools`/`setActiveTools` aren't guaranteed present on
			// every host the broad `@earendil-works/pi-coding-agent` peer
			// dependency allows, so probe with typeof rather than assuming the
			// pinned devDependency version's API exists at runtime. session_start
			// fires multiple times per process (fork/reload/new/resume, see the
			// reasonLabel handling below); re-running this every time is fine —
			// `setActiveTools` just replaces the current active set, it isn't
			// additive or stateful across calls.
			try {
				const piWithActiveTools = pi as unknown as {
					getActiveTools?: () => string[];
					setActiveTools?: (names: string[]) => void;
				};
				if (
					typeof piWithActiveTools.getActiveTools === "function" &&
					typeof piWithActiveTools.setActiveTools === "function"
				) {
					const lazyNames = new Set(LAZY_TOOL_CATALOG.map((t) => t.name));
					const active = piWithActiveTools.getActiveTools();
					const initiallyActive = active.filter(
						(name) => !lazyNames.has(name),
					);
					piWithActiveTools.setActiveTools(initiallyActive);
				}
			} catch (deactivateErr) {
				dbg(
					`dynamic tool deactivation failed (older pi host lacking getActiveTools/setActiveTools, or a genuine host error): ${deactivateErr}`,
				);
			}

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

			// #473: distinguish a concurrently-live in-process subagent bind
			// (tintinweb/pi-subagents-style) from a real sequential session
			// replacement BEFORE touching any process-shared singleton. A
			// concurrent secondary must not run handleSessionStart (which resets
			// the shared LSP fleet + runtime generation out from under the still
			// -live parent) or updateRuntimeIdentityFromEvent (which would
			// overwrite the parent's telemetry identity).
			const sessionStartDecision = decideSessionStart(ctx, stableSessionId);
			if (!sessionStartDecision.runFullSessionStart) {
				dbg(
					`session_start: concurrent secondary detected (count=${sessionStartDecision.secondaryCount}) — skipping handleSessionStart`,
				);
				logLatency({
					type: "phase",
					filePath: "<pi-lens>",
					phase: "concurrent_session_bind",
					durationMs: 0,
					metadata: {
						secondaryCount: sessionStartDecision.secondaryCount,
						sessionReason,
						sameCwd: (ctx as { cwd?: string })?.cwd === process.cwd(),
					},
				});
				return;
			}

			// #449 slice 1 / #472: register this process in the cross-process
			// instance registry and fire-and-forget an orphan-LSP sweep. Below the
			// #473 guard deliberately: a concurrent secondary neither re-registers
			// (the pid's entry already exists) nor re-sweeps (a fan-out would run
			// up to maxConcurrent redundant sweeps). Neither call is awaited —
			// registry I/O and the reaper must never delay session start; both are
			// internally best-effort (never throw).
			void registerInstance(ctx.cwd ?? process.cwd()).catch(() => {
				// best-effort observability — never fail session_start over this
			});
			void sweepOrphans();
			// #658: registry-INDEPENDENT backstop sweep, running alongside the
			// registry-driven one above. `sweepOrphans` can only ever see pids
			// still listed in some instance's `lspChildren[]`; once that trace is
			// lost (stale-heartbeat entry removal, or a silently-failed
			// `killPidTree`), the child becomes permanently invisible to it. This
			// backstop instead scans the OS process table directly for known
			// pi-lens-managed binary names and only acts on ones that are BOTH
			// untracked by the current registry snapshot AND have a
			// confirmed-dead parent — never on name alone. Fire-and-forget, same
			// non-blocking/never-throws contract as `sweepOrphans`.
			void sweepUntrackedOrphans();
			// #449 slice 2 (prototype): machine-wide LSP budget check. Reads the
			// same registry, decides locally whether THIS session should skip
			// spawning auxiliary LSP servers, and caches the decision for
			// clients/dispatch/auxiliary-lsp.ts to read on later dispatch calls.
			// Never awaited — a registry read must not delay session start, and
			// dispatch doesn't happen until later in the turn anyway, so the cache
			// is populated well before it's first read in practice.
			void checkCrossProcessLspBudget();
			// #492: child-at-session_start cross-process nudge consumer. Reads
			// `recent-touches.json` (clients/recent-touches.ts) for entries from
			// OTHER pi-lens instances (pid-excluded) within the 15-minute
			// freshness window whose file still exists, and feeds them into the
			// same #485 accumulator a bus event would use — the first `context`
			// call this session makes (clients/agent-nudge.ts, wired below) then
			// injects one batched provenance message. This is the "child blind to
			// parent" direction from #492: a subagent asked to `git status` right
			// after spawn otherwise sees unexplained `M` files with no
			// explanation. Never awaited-to-block session_start; internally
			// best-effort (recent-touches.ts never throws).
			void readCrossProcessTouchesForSessionStart({
				cwd: ctx.cwd ?? process.cwd(),
			})
				.then((entries) => {
					if (entries.length === 0) return;
					recordCrossProcessTouches(
						entries.map((e) => ({ path: e.path, reason: e.reason })),
					);
					dbg(
						`session_start: cross-process nudge — ${entries.length} file(s) from other instance(s)`,
					);
				})
				.catch((err) => {
					dbg(`session_start: cross-process nudge read failed: ${err}`);
				});
			updateRuntimeIdentityFromEvent(event);
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
				opengrepClient,
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
				opengrepClient,
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
		return handleToolCall({
			event: event as unknown as Parameters<typeof handleToolCall>[0]["event"],
			ctx: ctx as unknown as Parameters<typeof handleToolCall>[0]["ctx"],
			lensEnabled,
			getFlag: (name: string) => getLensFlag(name),
			dbg,
			runtime,
			cacheManager,
			ensureLSPConfigInitialized,
			updateLspStatus,
			resetLSPService,
		});
	});

	// Real-time feedback on file writes/edits
	// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
	(pi as any).on("tool_result", async (event: any, ctx: any) => {
		if (!lensEnabled) return;
		updateRuntimeIdentityFromEvent(event);
		// Publish this turn's abort signal so the dispatch's linter/type-check
		// child processes are killed if the agent is interrupted (#197 ctx.signal).
		setAmbientAbortSignal(ctx?.signal);
		// Earliest possible marker for the edit pipeline: the first instrumented
		// phase is `read_file` deep inside runPipeline, so a stall before that (or
		// upstream, before pi-lens even received the event) leaves NO trace — that
		// is exactly why a wedged-LSP edit hang was invisible in latency.log. This
		// row means "pi-lens received this edit"; if it is present but nothing
		// follows, the stall is in the pipeline; if it is absent, it is upstream.
		const rtToolName = (event as { toolName?: string })?.toolName;
		if (rtToolName === "edit" || rtToolName === "write") {
			logLatency({
				type: "phase",
				phase: "tool_result_received",
				filePath:
					(event as { input?: { path?: string } })?.input?.path ?? "<unknown>",
				durationMs: 0,
				metadata: { toolName: rtToolName },
			});
		}
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
	pi.on("turn_start", (_event: any, ctx) => {
		runtime.beginTurn();
		clearLastAnalyzedStateCache();

		// #492: parent-at-turn_start cross-process nudge consumer — the "parent
		// blind to child" direction, arguably the more important one (the
		// child is ephemeral; the parent keeps editing the same tree after a
		// subagent returns and its pi-lens has autoformatted on top of the
		// child's edits). Hot path: `readCrossProcessTouchesForTurnStart`
		// mtime-gates itself (ONE `fs.stat`, no read/parse when the record
		// hasn't changed since the last turn_start), so this call is
		// effectively free on every turn that has no cross-process activity —
		// fire-and-forget, never awaited (must not delay turn_start), and
		// internally never throws.
		const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		void readCrossProcessTouchesForTurnStart({ cwd })
			.then((entries) => {
				if (entries.length === 0) return;
				// Relevance filter (#492 point 6): readCrossProcessTouchesForTurnStart
				// already applied the shared baseline filter (foreign pid, 15-minute
				// freshness window, file still exists) plus the consumed-cursor
				// dedup — same baseline as the session_start reader. A parent's own
				// read-guard history is the FIRST signal for most entries (files it
				// read/edited this session, same as the #485 local filter) — but
				// unlike the local filter, an entry the parent has NEVER seen still
				// passes through here: a parent about to `git commit` needs
				// attribution for cross-process drift even in files it hasn't
				// opened yet this session, so there is deliberately no read-guard
				// drop path — every entry that reaches this point is relevant by
				// construction.
				recordCrossProcessTouches(
					entries.map((e) => ({ path: e.path, reason: e.reason })),
				);
				dbg(
					`turn_start: cross-process nudge — ${entries.length} file(s) from other instance(s)`,
				);
			})
			.catch((err) => {
				dbg(`turn_start: cross-process nudge read failed: ${err}`);
			});
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

			// #484: the turn-summary entry is deliberately NOT emitted here.
			// sendMessage while the session is streaming STEERS the live model
			// conversation (SDK sendCustomMessage's isStreaming branch), and a
			// mid-run turn_end plausibly fires while streaming — so the emit
			// lives in the agent_settled quiet window below, where the session
			// is idle and sendMessage takes the safe append branch. The
			// collector accumulates across the run's turns until then.
		} catch (turnEndErr) {
			dbg(`turn_end crashed: ${turnEndErr}`);
			dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		} finally {
			setAmbientAbortSignal(undefined);
		}
	});

	// --- Quiet window (#483): pi 0.80.6 agent_settled — fires once the whole
	// agent run (incl. any retry/continue loop) is fully idle, on both normal
	// completion and aborts (SDK finally-block). Additive to turn_end, not a
	// replacement: turn_end still settles cascade work under its own tight cap
	// so the next turn sees fresh state; this is a second, more generous
	// attempt for anything still carried over, plus other deferrable work.
	//
	// Registration is safe on older pi hosts with no `agent_settled` event:
	// the SDK's `pi.on` pushes onto a plain Map keyed by the event string with
	// no validation, so an unknown event name is simply never looked up on
	// emit — this handler would just never fire. try/catch below is
	// defensive belt-and-braces, not load-bearing.
	//
	// The SDK awaits each handler in sequence before `_runAgentPrompt`
	// returns, so this handler must NOT await the task chain itself — that
	// would hold up the host returning control (e.g. blocking the user from
	// starting a new turn). Kick it off unawaited and return immediately.
	registerBuiltinQuietWindowTasks(() => runtime);
	// #458: reconcile any cascade-lane Tier-3 touches that skipped their
	// in-lane wait (clients/lsp/cascade-tier.ts) in the same quiet window.
	registerCascadeTierReconcileTask(() => getLSPService());
	// #484: emit the opt-in run summary entry HERE, not at turn_end. The SDK's
	// sendCustomMessage STEERS the live model conversation when the session
	// isStreaming, and turn_end can fire mid-stream; at agent_settled the
	// session is idle, so sendMessage takes the safe append branch (persisted
	// transcript entry, rendered immediately, expandable in place). Note the
	// entry is NOT display-only: a CustomMessageEntry participates in LLM
	// context (`display` only controls TUI rendering) — its `content` reaches
	// the model as a user message on the NEXT context build, which is why
	// `content` is kept to the single collapsed line (~80 chars, an accepted
	// residue largely redundant with the #493 agent nudge); `details` (the
	// file-major expansion) never reaches the model. The collector accumulates
	// across the run's turns (never cleared at beginTurn) and is consumed
	// exactly once here; empty run ⇒ no entry, no latency phase. Task
	// contract per clients/quiet-window.ts: never throws (each task is
	// try/caught by the scheduler, and sendMessage is additionally
	// feature-detected + guarded so an older host degrades to a dbg line).
	// Registration is once-per-process (the quiet-window registry outlives
	// factory re-activation); the ctx holder keeps the closure current.
	_turnSummaryEmitCtx = {
		pi,
		getLensFlag: (name: string) => getLensFlag(name),
		isLensEnabled: () => lensEnabled,
	};
	if (!_turnSummaryEmitRegistered) {
		_turnSummaryEmitRegistered = true;
		registerQuietWindowTask("turn_summary_emit", () => {
			const emitCtx = _turnSummaryEmitCtx;
			if (!emitCtx || !emitCtx.isLensEnabled()) return;
			if (!emitCtx.getLensFlag("lens-turn-summary")) return;
			if (runtime.turnSummary.isEmpty()) return;
			const summaryStart = Date.now();
			const cwd = runtime.projectRoot || process.cwd();
			const details = runtime.turnSummary.consume(runtime.turnIndex, (fp) =>
				toRunnerDisplayPath(cwd, fp),
			);
			const line = formatTurnSummaryLine(details);
			const sendMessage = (
				emitCtx.pi as { sendMessage?: (msg: unknown) => void }
			).sendMessage;
			if (typeof sendMessage === "function") {
				try {
					sendMessage.call(emitCtx.pi, {
						customType: TURN_SUMMARY_CUSTOM_TYPE,
						content: line,
						display: true,
						details,
					});
				} catch (sendErr) {
					dbg(`turn-summary sendMessage failed: ${sendErr}`);
				}
			} else {
				dbg(
					"turn-summary: pi.sendMessage unavailable on this host, skipping emit",
				);
			}
			logLatency({
				type: "phase",
				toolName: "agent_settled",
				filePath: cwd,
				phase: "turn_summary",
				durationMs: Date.now() - summaryStart,
				metadata: {
					files: details.files.length,
					diagnostics: details.counts.diagnostics,
					autofixes: details.counts.autofixes,
					formats: details.counts.formats,
				},
			});
		});
	}
	try {
		(pi as any).on("agent_settled", (_event: unknown, ctx: { cwd?: string }) => {
			if (!lensEnabled) return;
			void runQuietWindow({
				runtime,
				dbg,
				cwd: ctx?.cwd,
			}).catch((err) => {
				dbg(`quiet_window crashed: ${err}`);
			});
		});
	} catch (registerErr) {
		dbg(`agent_settled registration failed (older pi host?): ${registerErr}`);
	}

	// --- Session shutdown: release all handles so subagent processes exit cleanly ---
	// The LSP idle-reset timer (240s) is unref'd but we cancel it explicitly here
	// so it does not fire after shutdown. resetLSPService shuts down any live clients.
	(pi as any).on("session_shutdown", (_event: unknown, ctx: unknown) => {
		// #473: a concurrently-live in-process subagent session shutting down
		// (its sibling primary — the real parent — still active) must NOT run
		// the shared-infra teardown below: no LSP fleet shutdown, no idle-timer
		// cancel that the parent still relies on. Only cheap/idempotent work
		// (none here) would be safe to keep; everything in this handler today
		// is destructive shared-infra teardown, so a secondary skips the whole
		// body.
		const stableSessionId = (() => {
			try {
				return (
					ctx as { sessionManager?: { getSessionId?: () => string } }
				)?.sessionManager?.getSessionId?.();
			} catch {
				return undefined;
			}
		})();
		const shutdownClassification = noteSessionShutdown(ctx, stableSessionId);
		if (shutdownClassification === "secondary") {
			decrementSecondarySessionCount();
			dbg("session_shutdown: concurrent secondary — skipping shared-infra teardown");
			return;
		}

		cancelLSPIdleReset();
		// #449 slice 1: SYNC-only deregistration (no child spawns — see the
		// processExiting note below); safe to call unconditionally here.
		deregisterInstance();
		// processExiting: the loop is closing here — killing LSP servers must NOT
		// spawn taskkill, or libuv aborts on uv_async_send to the closing loop
		// (Assertion !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c) — seen
		// on `pi update`. Direct handle-kill only. Grandchildren behind a
		// shell/.cmd wrapper are NOT reaped by the OS (Windows does not kill
		// children when a parent dies) — they rely on stdin EOF, LSP
		// `initialize.processId` self-watchdog compliance, and the #449/#472
		// cross-process instance registry's orphan reaper as the backstop (#472).
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
				const agentNudge = consumeAgentNudge(dbg);
				const injectedMessages = [
					...(sessionGuidance?.messages ?? []),
					...(turnEndFindings?.messages ?? []),
					...(testFindings?.messages ?? []),
					...(agentNudge?.messages ?? []),
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
