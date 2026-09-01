import "./clients/console-guard-install.js";
import {
	closeModuleLoadConsoleWindow,
	installConsoleGuard,
	logExtension,
	runInConsoleCaptureWindow,
	withConsoleCaptureWindows,
} from "./clients/extension-log.js";
import { wireUserNotifier } from "./clients/user-notify.js";
import {
	getDegradationSummary,
	incrementDegradationCount,
	recordDegradation,
} from "./clients/degradation-ledger.js";
import {
	adoptProjectTrustFromPorts,
	assertInstallAllowed,
	readProjectTrustFromContext,
} from "./clients/project-trust.js";
import {
	type ExtensionRunMode,
	modeSuppressionNote,
	readExtensionMode,
	suppressesUserNotify,
	supportsTuiWidget,
} from "./clients/extension-mode.js";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createDefaultHostPorts,
	type HostPorts,
} from "./clients/host-ports.js";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { loadBootstrapClients } from "./clients/bootstrap.js";
import { CacheManager } from "./clients/cache-manager.js";
// #1561 F2: the retire hook re-syncs the gate latch and the persisted record
// the same way the per-dispatch path does, so a retired blocker stops gating
// the commit.
import { retireInlineBlockerAndResyncGuard } from "./clients/git-guard.js";
import { resolvePackagePath } from "./clients/package-root.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFailedLspServerIds,
	getSessionLanguages,
	importWidgetState,
	type PersistedWidgetState,
	reconcileCascadeNeighborLspErrors,
	renderWidget,
	scheduleStaleReconcile,
	setRenderCallback,
} from "./clients/widget-state.js";
import { selectLspStatus } from "./clients/lsp-status.js";
import type { PersistedReadGuardState } from "./clients/read-guard.js";
import { registerReadBridge } from "./clients/read-bridge.js";
import {
	isExternalOrVendorFile,
	normalizeFilePath,
} from "./clients/path-utils.js";
import { isPathIgnoredByProject } from "./clients/file-utils.js";
import {
	dropStaleFiles,
	loadSessionState,
	saveSessionState,
	sessionStartMode,
} from "./clients/session-state-store.js";
import { getDiagnosticTracker } from "./clients/diagnostic-tracker.js";
import {
	warmDispatchIntegration,
	loadDispatchIntegration,
} from "./clients/dispatch/lazy.js";
import {
	getFormatService,
	resetFormatService,
} from "./clients/format-service.js";
import { getAllToolStatuses } from "./clients/installer/index.js";
import {
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
	resolvePiLensFlagWithSource,
} from "./clients/lens-config.js";
import { LENS_FLAGS } from "./clients/lens-flag-registry.js";
import { wrapToolsForCompactLine } from "./clients/tool-render.js";
import { loadPiLensProjectConfig } from "./clients/project-lens-config.js";
import { initLensEventsGetter } from "./clients/lens-events.js";
import { wireBusEmitterGetter } from "./clients/bus-publish.js";
import { wireDiagnosticsBusEmitterGetter } from "./clients/diagnostics-publish.js";
import { wireDispositionBusEmitterGetter } from "./clients/disposition-publish.js";
import { wireFormatEventsBusEmitterGetter } from "./clients/format-events-publish.js";
import { emitBusEventRollupAtSessionEnd } from "./clients/bus-events-logger.js";
import {
	emitVerifiedPathAttributionRollup,
	resetVerifiedPathAttributionGuessCount,
} from "./clients/path-attribution-telemetry.js";
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
import { buildResolvedFoundCascadeRun } from "./clients/cascade-format.js";
import { initLSPConfig } from "./clients/lsp/config.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import { warmLspService } from "./clients/lsp-lazy.js";
import {
	sweepOrphans,
	scheduleUntrackedOrphanSweep,
} from "./clients/instance-reaper.js";
import {
	deregisterInstance,
	deregisterInstanceRoot,
	readInstanceRegistry,
	registerInstance,
	registerInstanceRoot,
} from "./clients/instance-registry.js";
import { logVanishedInstances } from "./clients/vanished-instance-marker.js";
import {
	buildMemorySample,
	formatMemoryHealthLine,
	recordMemorySampleOutcome,
	resetMemorySamplerCadence,
	shouldEmitMemorySampleAdaptive,
} from "./clients/memory-sampler.js";
import { dumpActiveHandles } from "./clients/debug-handles.js";
import {
	isDebugHeapEnabled,
	writeHeapSnapshotNow,
} from "./clients/debug-heap.js";
import {
	checkSmellsAndNoteOnce,
	countRecentSmells,
	formatSmellsHealthLine,
	shouldCheckSmellsThisTurn,
} from "./clients/smells-rollup.js";
import { configureWarmAttach } from "./clients/warm-attach.js";
import { checkCrossProcessLspBudget } from "./clients/lsp-budget.js";
import { handleAgentEnd } from "./clients/runtime-agent-end.js";
import {
	consumeSessionStartGuidance,
	consumeTurnEndFindings,
} from "./clients/runtime-context.js";
import {
	deliverStagedTestRunnerFindings,
	registerTestRunnerEntryRenderer,
	stageTestRunnerDelivery,
} from "./clients/test-runner-delivery.js";
import {
	readHostModelIdentity,
	RuntimeCoordinator,
} from "./clients/runtime-coordinator.js";
import { handleSessionStart } from "./clients/runtime-session.js";
import { handleToolCall } from "./clients/runtime-tool-call.js";
import {
	isStaleExtensionCtxError,
	wrapSessionEventHandler,
	wrapSessionEventHandlerWithResult,
} from "./clients/session-event-guard.js";
import {
	classifyCurrentSessionEmission,
	decideSessionStart,
	decrementSecondarySessionCount,
	getActivePrimaryRoot,
	noteSessionShutdown,
	releasePrimarySession,
	probeCtxActive,
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
import { createProjectReportTool } from "./tools/project-report.js";
import { createSymbolSearchTool } from "./tools/symbol-search.js";
import {
	getLastLoggedPhase,
	getPhaseForWindow,
	getRecentLoggedPhases,
	logLatency,
	resetCurrentPhaseForSession,
} from "./clients/latency-logger.js";
import { emitBounded } from "./clients/bounded-telemetry.js";
import {
	getLastLiveMessageEndSessionId,
	noteLiveMessageEndSessionId,
} from "./clients/message-end-attribution.js";

/**
 * Identity for the `loop_block` record (#1743). An event-loop block is a
 * process-wide fact — there is no file, tool, or request to discriminate on —
 * so the identity is this fixed marker, the same value the record's
 * `filePath` has carried since #192.
 */
const LOOP_BLOCK_IDENTITY = "<pi-lens>";
import {
	isFreshSessionStart,
	planToolSet,
	recordToolSetMutation,
	supportsDeferredTools,
} from "./clients/tool-set-policy.js";
import {
	type CacheContextInjectionSlice,
	clearCachePrefixSession,
	emitCacheUsageSummaryAtSessionEnd,
	logCacheUsage,
	observeCacheContext,
	observeCachePrefix,
} from "./clients/cache-observability.js";
import {
	buildStartupTimingRecords,
	getPiLensEvalMs,
	markPiLensLoaded,
	getPiLensLoadedAtMs,
	consumeHostReadyDelayAnchor,
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
	resetEventLoopMonitor,
	shouldLogLoopBlock,
	shouldLogWorstBlock,
	startEventLoopMonitor,
} from "./clients/event-loop-monitor.js";
import {
	formatBuildIdentity,
	getBuildIdentity,
} from "./clients/build-identity.js";
import { logSessionStart } from "./clients/sessionstart-logger.js";
import {
	emitConcurrentSessionBindRollupAtSessionEnd,
	logConcurrentSessionBind,
	resetConcurrentSessionBindRollupCounts,
} from "./clients/session-start-observability.js";
import { normalizeToolDefinition } from "./clients/tool-definition.js";
import { warmFormatters } from "./clients/formatters-lazy.js";

type DispatchIntegration = Awaited<ReturnType<typeof loadDispatchIntegration>>;
let loadedDispatchIntegration: DispatchIntegration | undefined;

function warmDispatchAtSessionStart(): void {
	void warmDispatchIntegration()
		.then((integration) => {
			loadedDispatchIntegration = integration;
		})
		.catch((err) => {
			logExtension({
				subsystem: "dispatch",
				level: "warn",
				message: `dispatch warm failed: ${err}`,
			});
		});
}

function resetDispatchBaselines(cwd?: string): void {
	void loadDispatchIntegration().then(({ resetDispatchBaselines }) => {
		resetDispatchBaselines(cwd);
	});
}

// First executable statement: every import above has been evaluated, so the
// full load/transpile cost has been paid. Capture it now.
const PI_LENS_LOAD_MS = markPiLensLoaded();
const PI_LENS_LOADED_AT_MS = getPiLensLoadedAtMs();
const PI_LENS_EVAL_MS = getPiLensEvalMs() ?? 0;
// Start the event-loop occupancy monitor as early as possible so startup
// blocks are captured. Native histogram — no per-event overhead. (#192)
startEventLoopMonitor();
// Worst event-loop block already persisted to latency.log (so we only log a
// *new* worst freeze per turn, not the same growing max). (#192) A suspected
// system stall (sleep/paging) never advances this high-water, so a machine
// freeze can't permanently suppress logging of later genuine blocks. (#1122)
let lastLoggedLoopWorstMs = 0;
// Worst *genuine* (non-stall) block this session, for the health readout — the
// per-turn histogram window (#1122) is reset each turn, so the session-scoped
// worst is tracked here instead of read from the live histogram.
let sessionWorstRealBlockMs = 0;
// How many turns logged a suspected system stall (sleep/paging) this session —
// surfaced in /lens-health so a machine freeze reads as environment, not a
// pi-lens block (#1122).
let sessionSuspectedStalls = 0;

function dbg(msg: string) {
	logSessionStart(msg);
}

/**
 * The most recent event ctx, kept ONLY so `clients/user-notify.ts` can resolve
 * a live `ctx.ui.notify` at delivery time (#1333). Never dereferenced eagerly
 * and never captured by a long-lived closure — a session replacement swaps the
 * ctx, and `notifyUserDegradation` swallows the stale-ctx throw.
 */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
let latestEventCtx: any;

/** Refresh the notify target from whichever event ctx just arrived. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
function rememberEventCtx(ctx: any): void {
	if (ctx) latestEventCtx = ctx;
}

/**
 * Mode-aware `ctx.ui.notify` (#1334 S2). Every user-facing notify in this file
 * goes through here so terminal ownership is derived from the HOST's
 * `ctx.mode`, not from pi-lens guessing. In "print"/"json" the message is
 * logged instead of rendered — those modes are one-shot pipelines whose stdout
 * belongs to the run's actual output, not to extension chatter. "tui", "rpc"
 * and an older host with no `mode` field all notify exactly as before.
 */
function notifyUi(
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	ctx: any,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	const mode = readExtensionMode(ctx);
	if (suppressesUserNotify(mode)) {
		recordDegradation({
			kind: "mode-suppression",
			subject: "ctx.ui.notify",
			reason: modeSuppressionNote(mode),
		});
		dbg(`notify ${modeSuppressionNote(mode)}: ${message.split("\n")[0]}`);
		return;
	}
	ctx?.ui?.notify?.(message, level);
}

/**
 * Best-effort read of the STABLE pi session id off an event ctx
 * (`ctx.sessionManager.getSessionId()`), the same accessor #473's
 * session_start handling and #791's deferred-format ownership tagging both
 * rely on. Never throws — returns `undefined` on any unexpected ctx shape
 * or accessor error (older host, inconclusive probe, etc).
 */
function getStableSessionId(ctx: unknown): string | undefined {
	try {
		return (
			ctx as
				| { sessionManager?: { getSessionId?: () => string } }
				| null
				| undefined
		)?.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

export interface CreateHostPortsOptions {
	getContext: () => unknown;
	getProjectRoot?: () => string | undefined;
	getRenderInvalidator?: () => (() => void) | undefined;
}

/** Assemble pi's live ExtensionAPI/context projections behind HostPorts. */
export function createHostPorts(
	pi: ExtensionAPI,
	options: CreateHostPortsOptions,
): HostPorts {
	const context = () => options.getContext() as any;
	const currentMode = () => readExtensionMode(context());
	const emit = (channel: string, payload: unknown): void => {
		const bus = pi.events;
		bus?.emit?.call(bus, channel, payload);
	};
	const activeTools = pi as unknown as {
		getActiveTools?: () => string[];
		setActiveTools?: (names: string[]) => void;
	};
	return createDefaultHostPorts({
		notify: {
			user(message, level) {
				const mode = currentMode();
				if (mode === "print" || mode === "json") {
					// #1366: suppressed notices are still LEDGERED so headless
					// operators can see them in pilens_health.
					recordDegradation({
						kind: "mode-suppression",
						subject: "user degradation notice",
						reason: modeSuppressionNote(mode),
					});
					return;
				}
				context()?.ui?.notify?.(message, level ?? "warning");
			},
		},
		trust: { isProjectTrusted: () => readProjectTrustFromContext(context()) },
		mode: {
			current: currentMode,
			supportsTuiWidget: () => supportsTuiWidget(currentMode()),
			suppressesUserNotify: () => suppressesUserNotify(currentMode()),
		},
		log: {
			extension: logExtension,
			debug: (message, metadata) =>
				logExtension({ subsystem: "host", level: "debug", message, metadata }),
			// DECLARATION-ONLY in S2 (#1367 review): no production code consumes
			// ports.log.sink yet -- the 13 subsystem loggers still own their
			// NDJSON files directly. Migrating them onto this port (routing to
			// their per-subsystem files, NOT extension.log) is S4 scope; this
			// placeholder exists so the interface is complete for contract tests.
			sink: (subsystem) => (entry) =>
				logExtension({
					subsystem,
					level: "debug",
					message: "host sink entry",
					metadata: { entry },
				}),
		},
		emit: { bus: emit },
		status: { set: (name, value) => context()?.ui?.setStatus?.(name, value) },
		spawn: {
			abortSignal: () => context()?.signal,
			isAllowed: assertInstallAllowed,
		},
		render: { invalidate: () => options.getRenderInvalidator?.()?.() },
		session: { id: () => getStableSessionId(context()) },
		workspace: {
			cwd: () => context()?.cwd,
			projectRoot: () => options.getProjectRoot?.(),
		},
		flags: { get: (name) => pi.getFlag(name) },
		tools: {
			has: async (name) =>
				typeof (
					pi as unknown as { getTool?: (tool: string) => unknown }
				).getTool?.(name) !== "undefined",
			getActive: () => activeTools.getActiveTools?.() ?? [],
			setActive: (names) => activeTools.setActiveTools?.(names),
		},
	});
}

// Log how long pi took to load pi-lens — the jiti transpile of every module is
// paid by now. Source mode includes transpiling ~200 .ts files; the precompiled
// dist build does not, so the delta is the #182 startup win. One line per load.
dbg(
	`pi-lens loaded: ${PI_LENS_LOAD_MS}ms after process start (from ${PI_LENS_LOADED_FROM})`,
);
for (const record of buildStartupTimingRecords({
	loadMs: PI_LENS_LOAD_MS,
	evalMs: PI_LENS_EVAL_MS,
})) {
	logLatency(record);
}

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
let _readBridgeRegistered = false;
let _readBridgeGetFlag:
	| ((name: string) => boolean | string | undefined)
	| undefined;
let _turnSummaryEmitRegistered = false;
let _turnSummaryEmitCtx:
	| {
			pi: ExtensionAPI;
			getLensFlag: (name: string) => boolean | string | undefined;
			isLensEnabled: () => boolean;
	  }
	| undefined;
let _testRunnerDeliveryRegistered = false;
let _nextTestRunnerDeliveryOwnerId = 0;
const _lspConfigInitializedCwds = new Set<string>();
const LSP_CONFIG_CWD_CAP = 128;

async function ensureLSPConfigInitialized(cwd: string): Promise<void> {
	const normalizedCwd = path.resolve(cwd);
	if (_lspConfigInitializedCwds.has(normalizedCwd)) return;
	await initLSPConfig(normalizedCwd);
	_lspConfigInitializedCwds.add(normalizedCwd);
	while (_lspConfigInitializedCwds.size > LSP_CONFIG_CWD_CAP) {
		const oldest = _lspConfigInitializedCwds.values().next().value;
		if (oldest === undefined) break;
		_lspConfigInitializedCwds.delete(oldest);
	}
}

/**
 * Adopt this activation's telemetry identity from the host CONTEXT (#1655
 * item 2).
 *
 * This used to read `provider`/`model`/`sessionId`/`session.id`/`id` off the
 * EVENT. pi sets none of them on either event that called it: `session_start`
 * is `{ type, reason }`
 * (`@earendil-works/pi-coding-agent/dist/core/agent-session.js:152`,
 * `:2072`), and `tool_result` is exactly
 * `type`/`toolName`/`toolCallId`/`input`/`content`/`details`/`isError`/`usage`
 * (`dist/core/agent-session.js:243-256`, source
 * `src/core/agent-session.ts:502-516`). So every call passed all-undefined,
 * `setTelemetryIdentity` ignored it, and `runtime.telemetryModel` stayed
 * `"unknown"` for the whole session against a real host.
 *
 * The ctx DOES carry the model. `ExtensionContext.model` is the live `Model`
 * (`dist/core/extensions/runner.js:488-491` → `AgentSession.model`, `:580-582`)
 * with `id` and `provider` (`@earendil-works/pi-ai/dist/types.d.ts:661-667`).
 *
 * SESSION ID IS DELIBERATELY NOT SET HERE. `runtime.setSessionLifecycle`
 * already pins it from `ctx.sessionManager.getSessionId()` inside
 * `session_start`, behind the #473 concurrent-secondary guard. Adopting it
 * again from a `tool_result` ctx would let a concurrent in-process secondary
 * session overwrite the parent's identity on every tool result — the exact
 * clobber that guard exists to prevent.
 */
function updateRuntimeIdentityFromCtx(ctx: unknown): void {
	runtime.setTelemetryIdentity(readHostModelIdentity(ctx));
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

/**
 * The extension activation. Always reached through the default export below,
 * which runs it inside a console capture window (#1434).
 */
function activateExtension(hostPi: ExtensionAPI) {
	// #1434: every pi-lens entry point registered through this API runs inside a
	// capture window, so a dependency writing to console during our work reaches
	// the log instead of pi's frame. Host-initiated output stays on the real
	// console, because it runs outside every window.
	const pi = withConsoleCaptureWindows(hostPi);
	const testRunnerDeliveryOwnerId = `activation-${++_nextTestRunnerDeliveryOwnerId}`;
	// Event contexts belong to the activation that owns this factory closure.
	// The process-global latest ctx remains only a boot-window fallback.
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	let ownEventCtx: any;
	// #1996 review: role belongs to THIS extension activation. A secondary can
	// be positively identified at session_start even when its stable id is
	// unavailable later; recomputing from process-global primary state would then
	// misclassify its context/message_end/shutdown as primary. Closure ownership
	// avoids a shared mutable "last session" race between sibling activations.
	let ownedSessionRole: "primary" | "concurrent-secondary" | undefined;
	const classifyOwnedSessionEmission = (
		ctx: unknown,
		sessionId: string | undefined,
	): "primary" | "concurrent-secondary" =>
		ownedSessionRole ?? classifyCurrentSessionEmission(ctx, sessionId);
	const classifyOwnedSessionShutdown = (
		ctx: unknown,
		sessionId: string | undefined,
		// #2146 F1: this session's own root. Only consulted on the fallback path
		// below — when this extension instance never recorded a role of its own,
		// so the shared registration is the only evidence available.
		root: string | undefined,
	): "primary" | "secondary" =>
		ownedSessionRole === "concurrent-secondary"
			? "secondary"
			: ownedSessionRole === "primary"
				? "primary"
				: noteSessionShutdown(ctx, sessionId, root);
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	const rememberOwnEventCtx = (ctx: any): void => {
		if (!ctx) return;
		ownEventCtx = ctx;
		rememberEventCtx(ctx);
	};
	let renderInvalidator: (() => void) | undefined;
	const hostPorts = createHostPorts(pi, {
		getContext: () => latestEventCtx,
		getProjectRoot: () => runtime.projectRoot,
		getRenderInvalidator: () => renderInvalidator,
	});
	// #1333 — defense in depth, the pi-side mirror of `mcp/server.ts`'s
	// `console.log = console.error` guard. pi owns the terminal (raw mode +
	// cursor-addressed diff repaints), so a raw byte from ANY transitively
	// loaded module desyncs its screen model. pi-lens's own sites are migrated
	// to real ndjson sinks; this net catches everything else. The REAL install
	// happens at import time via `clients/console-guard-install.js` (index.ts's
	// first import) so module-init writes are covered too; this call is an
	// idempotent re-install for tests that invoke the factory directly. No-op
	// under test mode and under `PI_LENS_CONSOLE_GUARD=0`.
	installConsoleGuard();
	initI18n(pi);
	// #1333 HUMAN channel: user-facing degradations found deep in clients/
	// (invalid config, offline grammar fetch, WASM abort) reach the user
	// through the host's own render path. Per the #338/#798 detached-callback
	// rule the notifier is resolved from the LATEST event ctx at delivery time,
	// never captured once — a session replacement invalidates the old ctx.ui.
	// #1334 S2: the ports notifier owns mode suppression + live-ctx resolution
	// (per-call, never captured -- the #338/#798 detached-callback rule).
	const refreshCtxDerivedPlumbing = (): void => {
		// These targets are module singletons, while hostPorts is scoped to this
		// extension activation. A sibling activation can overwrite them and then
		// become stale; every session_start must reclaim them before #473 can
		// return early for a concurrent in-process subagent. (#1383)
		wireUserNotifier(hostPorts);
		const getLiveEmit = () => ({
			emit: hostPorts.emit.bus,
			// H2 (#1415 review): NOT `?? latestEventCtx`. The global belongs to
			// whichever activation last received an event — a SIBLING activation
			// after a replacement, with no relation to this closure's `pi.events`.
			// Falling back to it pairs a live emitter with a foreign ctx, which
			// the stale-session probe cannot catch (it looks live) and silently
			// drops every publish until this activation's own first handler
			// fires. An unset `ownEventCtx` (this activation's own boot window)
			// must probe undefined -> "ready" -> delivery attempted, exactly like
			// today, not borrow a sibling's ctx.
			ctx: ownEventCtx,
		});
		initLensEventsGetter(getLiveEmit);
		wireBusEmitterGetter(getLiveEmit);
		wireDiagnosticsBusEmitterGetter(getLiveEmit);
		wireDispositionBusEmitterGetter(getLiveEmit);
		wireFormatEventsBusEmitterGetter(getLiveEmit);
		setRenderCallback(() => hostPorts.render.invalidate());
	};
	refreshCtxDerivedPlumbing();
	// #485: read-only bus subscriber — never publishes, so the #482 loop guard
	// (ingest -> write -> publish) has no write side to trip here.
	// #1434 residual risk, accepted not fixed: `pi.events` is the raw host bus,
	// not `pi` itself, so `withConsoleCaptureWindows` does not wrap its
	// `subscribe`. A future subscriber body that logs would bypass the capture
	// window. Subscribers registered on this bus are subscribe-only today
	// (never publish), so nothing currently exercises that gap — revisit if
	// `pi.events` grows a subscriber that does real work inside its callback.
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

	// #166: registration is driven by clients/lens-flag-registry.ts, the same
	// declarative array that drives config parsing and precedence resolution, so
	// a flag cannot exist on the CLI without a config key (or vice versa).
	for (const spec of LENS_FLAGS) {
		pi.registerFlag(spec.name, {
			description: spec.description,
			type: "boolean",
			default: spec.default,
		});
	}

	const globalConfig = loadPiLensGlobalConfig();
	function getLensFlag(
		name: string,
		editedFilePath?: string,
	): boolean | string | undefined {
		const projectConfig = loadPiLensProjectConfig(runtime.projectRoot);
		return resolvePiLensFlag(
			name,
			pi.getFlag(name),
			globalConfig,
			projectConfig,
			editedFilePath,
			runtime.projectRoot,
		);
	}

	// #792: sibling of getLensFlag reporting WHICH config tier decided the
	// value, so mutation-skip dbg lines can name it (e.g. "source=project")
	// instead of a bare boolean. Threaded to pipeline/agent_end via the
	// optional `getFlagSource` field — zero effect on getLensFlag itself.
	function getLensFlagSource(
		name: string,
		editedFilePath?: string,
	): ReturnType<typeof resolvePiLensFlagWithSource>["source"] {
		const projectConfig = loadPiLensProjectConfig(runtime.projectRoot);
		return resolvePiLensFlagWithSource(
			name,
			pi.getFlag(name),
			globalConfig,
			projectConfig,
			editedFilePath,
			runtime.projectRoot,
		).source;
	}

	let lensEnabled = !getLensFlag("no-lens");

	// Read-bridge: refresh the flag getter on every factory activation so the
	// live getLensFlag closure is always used (same pattern as _turnSummaryEmitCtx).
	// Register the singleton once — subsequent activations only refresh the getter.
	_readBridgeGetFlag = getLensFlag;
	if (!_readBridgeRegistered) {
		_readBridgeRegistered = true;
		registerReadBridge({
			getReadGuard: () => runtime.readGuard,
			getTurnIndex: () => runtime.turnIndex,
			peekWriteIndex: () => runtime.peekWriteIndex(),
			isRecordable(filePath: string): boolean {
				if (_readBridgeGetFlag?.("no-read-guard")) return false;
				if (isPathIgnoredByProject(filePath, runtime.projectRoot, false))
					return false;
				if (isExternalOrVendorFile(filePath, runtime.projectRoot)) return false;
				return true;
			},
		});
	}
	// Automatic context injection (the `context` hook). Independent of lensEnabled
	// so tools/LSP/read-guard/formatting keep running when it is off. Precedence:
	// env override → CLI flag → global config, all resolved inside getLensFlag
	// from the registry's PI_LENS_NO_CONTEXT_INJECTION env binding (#166).
	let contextInjectionEnabled = !getLensFlag("no-lens-context");
	let lensWidgetVisible = globalConfig?.widget?.visible !== false;
	let mountedLensWidgetUi: LensWidgetUi | undefined;
	let widgetMountFailureLogged = false;
	// #190 Phase 2: snapshot of the source session's diagnostics, captured at
	// `session_before_fork` and adopted by the forked session at the subsequent
	// `session_start` (reason="fork"). In-memory hand-off (same process) — avoids
	// deriving the source id from a file path (the id lives in the file header).
	let pendingForkSnapshot: PersistedWidgetState | undefined;
	// #1041: the source session's read-guard read-set, stashed at
	// `session_before_fork` alongside the widget snapshot so a forked session
	// adopts its parent's read history (same in-memory hand-off pattern).
	let pendingForkReadGuard: PersistedReadGuardState | undefined;
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

	/**
	 * #1334 S2: the widget is a terminal-only custom component. The host's own
	 * types say so — *"Use `"tui"` to guard terminal-only UI such as custom
	 * components"* — so mounting is gated on the mode pi reports, not attempted
	 * blindly. `rpc` is excluded despite `hasUI: true`: dialogs travel over the
	 * protocol there, a belowEditor component does not. An older host with no
	 * `mode` field reads "unknown" and mounts exactly as before.
	 */
	function mountLensWidget(
		ui: LensWidgetUi | undefined,
		mode: ExtensionRunMode,
	): boolean {
		if (!supportsTuiWidget(mode)) {
			dbg(`widget mount ${modeSuppressionNote(mode)}`);
			return false;
		}
		if (typeof ui?.setWidget !== "function") {
			if (!widgetMountFailureLogged) {
				widgetMountFailureLogged = true;
				logExtension({
					subsystem: "widget",
					level: "debug",
					message: "widget mount unavailable: host ui.setWidget is missing",
				});
			}
			return false;
		}
		const setWidget = ui.setWidget as LensWidgetSetWidget;
		setWidget(
			"pi-lens",
			(tui: LensWidgetTui, theme: LensWidgetTheme) => {
				renderInvalidator = () => tui.requestRender();
				setRenderCallback(() => {
					scheduleStaleReconcile();
					hostPorts.render.invalidate();
				});
				return {
					render: (width: number) => {
						scheduleStaleReconcile();
						return renderWidget(width, theme);
					},
					invalidate: () => {
						renderInvalidator = undefined;
						setRenderCallback(() => {});
					},
				};
			},
			{ placement: "belowEditor" },
		);
		mountedLensWidgetUi = ui;
		return true;
	}

	function unmountLensWidget(ui: LensWidgetUi | undefined): boolean {
		renderInvalidator = undefined;
		setRenderCallback(() => {});
		if (typeof ui?.setWidget !== "function") return false;
		const setWidget = ui.setWidget as LensWidgetSetWidget;
		setWidget("pi-lens", undefined);
		mountedLensWidgetUi = undefined;
		return true;
	}

	// #484: turn-summary custom message renderer. Feature-detected — older pi
	// hosts without registerMessageRenderer simply never get a renderer
	// registered (the raw `content` fallback text still shows since sendMessage
	// itself is guarded the same way at the emit site below).
	if (
		typeof (pi as { registerMessageRenderer?: unknown })
			.registerMessageRenderer === "function"
	) {
		try {
			pi.registerMessageRenderer(
				TURN_SUMMARY_CUSTOM_TYPE,
				renderTurnSummaryMessage,
			);
		} catch (registerRendererErr) {
			dbg(`turn-summary renderer registration failed: ${registerRendererErr}`);
		}
	}
	// #2366: test failures are a persistent, non-context custom entry. The
	// delivery task still checks appendEntry at fire time; this registration is
	// capability detection only and never authorizes a sendMessage fallback.
	registerTestRunnerEntryRenderer(pi);

	// --- Commands ---

	pi.registerCommand("lens-toggle", {
		description:
			"Toggle pi-lens on/off for the current session. Usage: /lens-toggle",
		handler: async (_args, ctx) => {
			lensEnabled = !lensEnabled;
			notifyUi(
				ctx,
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
			notifyUi(
				ctx,
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
			const mode = readExtensionMode(ctx);
			// #1334 S2: distinguish "this pi is too old" from "this run mode has
			// no terminal to draw into" — the old single message blamed the pi
			// version for what is really a mode constraint.
			if (nextVisible && !supportsTuiWidget(mode)) {
				notifyUi(
					ctx,
					`pi-lens widget needs an interactive TUI — unavailable in "${mode}" mode.`,
					"warning",
				);
				return;
			}
			const changed = nextVisible
				? mountLensWidget(ctx.ui, mode)
				: unmountLensWidget(ctx.ui);
			if (!changed) {
				notifyUi(
					ctx,
					"pi-lens widget is not supported by this pi version.",
					"warning",
				);
				return;
			}

			lensWidgetVisible = nextVisible;
			notifyUi(
				ctx,
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
			const { loadHistory, computeTDI } =
				await import("./clients/metrics-history.js");
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

			notifyUi(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-map", {
		description:
			"Render the review graph as a self-contained interactive HTML project map (pan/zoom/hover/click) and write it to disk. Usage: /lens-map",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			try {
				const { generateLensMap } = await import("./clients/lens-map.js");
				const result = await generateLensMap(cwd);
				// testFileCount is normally 0 (the review graph excludes tests by
				// role since #260) — only mention it when the map-level guard
				// actually dropped something.
				const testNote =
					result.testFileCount > 0
						? `, ${result.testFileCount} test files excluded`
						: "";
				// Compiled twins (X.js merged into X.ts) only occur in
				// compile-in-place projects — mention only when something merged.
				const twinNote =
					result.compiledTwinCount > 0
						? `, ${result.compiledTwinCount} compiled twins merged`
						: "";
				// Untracked-gitignored files dropped from the map (0 outside a
				// git repo, where the filter degrades to a no-op).
				const ignoredNote =
					result.ignoredFileCount > 0
						? `, ${result.ignoredFileCount} gitignored files excluded`
						: "";
				const lines = [
					`🗺️ Project map written to ${result.filePath}`,
					`${result.fileCount} files, ${result.edgeCount} edges, ${result.externalCount} external deps excluded${testNote}${twinNote}${ignoredNote}.`,
				];
				if (result.truncated) {
					lines.push(
						"Graph exceeded the map's node cap — showing the highest-degree files only (see the in-page note).",
					);
				}
				notifyUi(ctx, lines.join("\n"), "info");
			} catch (err) {
				notifyUi(
					ctx,
					`Failed to generate the project map: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
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

			const dispatchIntegration =
				loadedDispatchIntegration ?? (await loadDispatchIntegration());
			loadedDispatchIntegration = dispatchIntegration;
			const reports = dispatchIntegration.getLatencyReports();
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
			const slopScoreLine = dispatchIntegration.getDispatchSlopScoreLine();

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
			// (#192). The histogram window is now per-turn (#1122), so the session
			// worst genuine (non-stall) block is tracked separately; p99/mean here
			// reflect the current turn window.
			const elStats = getEventLoopStats();
			if (elStats) {
				lines.push(
					"",
					`Event loop: worst genuine block ${sessionWorstRealBlockMs}ms (session) · p99 ${elStats.p99Ms}ms · mean ${elStats.meanMs}ms (turn)`,
				);
				if (sessionWorstRealBlockMs > 100) {
					lines.push(
						"  ⚠ a >100ms synchronous block can stutter the TUI — check latency.log (#192)",
					);
				}
				if (sessionSuspectedStalls > 0) {
					lines.push(
						`  ${sessionSuspectedStalls} suspected system stall(s) (sleep/paging) this session — excluded from the block figure above (#1122)`,
					);
				}
			}

			// Memory attribution (#1123 item 2) — reuses the same O(1) accessors the
			// periodic latency.log `memory_sample` uses; see clients/memory-sampler.ts.
			try {
				lines.push(
					"",
					formatMemoryHealthLine(buildMemorySample(runtime.wordIndex)),
				);
			} catch {
				// best-effort — a health-line render must never break /lens-health
			}

			// On-demand heap snapshot (#1126) — the retainer-attribution half of the
			// memory line above: it says how many bytes are resident by subsystem,
			// this captures WHICH objects retain them. Gated behind PI_LENS_DEBUG_HEAP
			// (zero cost + no file when unset) and only ever triggered from this
			// operator-invoked diagnostics command — never a hot path or timer, so the
			// synchronous multi-second snapshot pause is opt-in and explicit. See
			// clients/debug-heap.ts.
			if (isDebugHeapEnabled()) {
				try {
					const snap = writeHeapSnapshotNow("lens_health");
					if (snap) {
						lines.push(
							`Heap snapshot written: ${snap.path} (RSS ${Math.round(snap.rssBytes / (1024 * 1024))}MB, ${snap.durationMs}ms) — open in Chrome DevTools › Memory`,
						);
					}
				} catch {
					// best-effort — a snapshot write must never break /lens-health
				}
			}

			// Smells self-surfacing (#1123 item 3) — same bounded tail-scan the
			// session_start line and turn_end note use; see clients/smells-rollup.ts.
			try {
				lines.push(formatSmellsHealthLine(countRecentSmells()));
			} catch {
				// best-effort — a health-line render must never break /lens-health
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
			const cascadeStats = dispatchIntegration.getCascadeSessionStats();
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

			notifyUi(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-perf", {
		description:
			"Show the slowest latency-log phases by p50 and p99 for the current process session and machine-wide active log window. Usage: /lens-perf",
		handler: async (_args, ctx) => {
			try {
				const { collectLatencyPerformance, renderLatencyPerformanceReport } =
					await import("./clients/performance-report.js");
				const report = await collectLatencyPerformance({
					sessionStartedAt: runtime.sessionStartedAt,
				});
				const degradations = getDegradationSummary();
				const degradationText = degradations.length
					? `\n\nDegradations:\n${degradations.map((group) => `  ${group.kind}: ${group.count} (${group.latestReasons.at(-1)?.subject}: ${group.latestReasons.at(-1)?.reason})`).join("\n")}`
					: "";
				notifyUi(
					ctx,
					`${renderLatencyPerformanceReport(report)}${degradationText}`,
					"info",
				);
			} catch (err) {
				notifyUi(
					ctx,
					`Failed to read performance telemetry: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
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

			notifyUi(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-allow-edit", {
		description:
			"Allow one edit to a file without a prior read. Usage: /lens-allow-edit <path>",
		handler: async (args, ctx) => {
			const [rawTarget] = normalizeCommandArgs(args);
			if (!rawTarget) {
				notifyUi(ctx, "Usage: /lens-allow-edit <path>", "warning");
				return;
			}

			const targetPath = path.isAbsolute(rawTarget)
				? rawTarget
				: path.resolve(ctx.cwd ?? runtime.projectRoot, rawTarget);
			runtime.readGuard.addExemption(targetPath);
			notifyUi(
				ctx,
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
			captureLspStatusRepaint,
			() => runtime,
		),
		createLspDiagnosticsTool(
			// #571: same reconciliation wiring as lens_diagnostics mode=full, for
			// the standalone on-demand check.
			() => runtime.nextWriteIndex(),
			// #1561: and the same confirmed result must retire this file's stale
			// inline blocker, not only correct the footer. The eviction is logged so
			// it is confirmable from the runtime log rather than from the absence of
			// complaints (#1432 Gap 1).
			// #1561 F2: the retire also recomputes the commit-gate latch and the
			// persisted record — see `retireInlineBlockerAndResyncGuard`.
			({ filePath, writeIndex, coveredSources, cwd }) => {
				const retired = retireInlineBlockerAndResyncGuard({
					runtime,
					cacheManager,
					cwd,
					filePath,
					writeIndex,
					coveredSources,
					lensGuardEnabled: getLensFlag("lens-guard") === true,
				});
				if (retired) {
					dbg(
						`inline_blocker: retired for ${filePath} — lsp_diagnostics confirmed clean (writeIndex ${writeIndex ?? "none"}, covered ${coveredSources.join(",") || "none"})`,
					);
				}
			},
		),
		createSymbolSearchTool(() => runtime.projectRoot),
		createProjectReportTool(() => runtime.projectRoot),
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

	// Situational tools (6): registered but, on hosts that support pi's dynamic
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
		createLspNavigationTool((name, cwd) => getLensFlag(name, cwd), {
			runtime,
			cacheManager,
			readGuard: runtime.readGuard,
			dbg,
		}),
		createLensDiagnosticMarkTool(
			() => runtime.projectRoot,
			() => ({
				model: runtime.telemetryModelId,
				provider: runtime.telemetryProviderId,
			}),
		),
	];
	const LAZY_TOOL_CATALOG: ActivatableToolInfo[] = [
		{
			name: "ast_grep_search",
			summary:
				"AST-aware structural code search across ~40 languages (ast-grep patterns).",
		},
		{
			name: "ast_grep_replace",
			summary:
				"AST-aware structural code rewrite/refactor (ast-grep patterns).",
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
	// #1453: the lazy tools the model activated in THIS logical conversation.
	// Extension closure state outlives a session rebuild (the runner keeps the
	// activated extension; it does not re-run this factory), which is exactly
	// what lets a fork/reload/resume restore the parent's tool posture. Reset
	// on startup/new, carried across fork/reload/resume — see the session_start
	// handler below.
	const rememberedLazyTools = new Set<string>();
	const activateToolsTool = createActivateToolsTool(
		pi as unknown as {
			getActiveTools?: () => string[];
			setActiveTools?: (names: string[]) => void;
		},
		LAZY_TOOL_CATALOG,
		{
			onActivated: (names) => {
				for (const name of names) rememberedLazyTools.add(name);
			},
			deferredToolSupport: (ctx) => {
				try {
					return supportsDeferredTools(
						(ctx as { model?: Parameters<typeof supportsDeferredTools>[0] })
							?.model,
					);
				} catch {
					return false;
				}
			},
			onMutation: recordToolSetMutation,
		},
	);

	// #1327: opt-in compact one-line tool rendering. Read once at load (like
	// the other session-scoped flags above) rather than per-render, so the
	// flag-off path registers the ORIGINAL tool definitions untouched —
	// byte-identical to pre-#1327 behavior (no renderCall/renderResult added
	// or altered). Only tools that already define `renderResult` (every
	// substantive pi-lens tool — see tools/render-compact.ts) are wrapped;
	// the rest pass through wrapToolsForCompactLine unchanged.
	const compactToolLineEnabled = getLensFlag("lens-compact-tool-line") === true;
	const toolsToRegister = [
		...alwaysActiveTools,
		activateToolsTool,
		...lazyTools,
	];
	for (const tool of compactToolLineEnabled
		? wrapToolsForCompactLine(toolsToRegister as any)
		: toolsToRegister) {
		try {
			pi.registerTool(normalizeToolDefinition(tool) as any);
		} catch {
			// another extension already registered a tool with this name
		}
	}

	// Dynamic tooling (#pi 0.80.x+): deactivate the 6 situational tools so they
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

	// #1929: wrapped like the other reachable handlers. The ctx delivered here
	// is USUALLY the announced session's own, built moments earlier, so the
	// probe answers `true` and nothing changes. It is not always: a session
	// replacement can land while this event sits in the queue, and then every
	// ctx read below throws. Before the wrapper that arrived as
	// `session_start crashed: …`, indistinguishable from a real handler bug,
	// and it counted nothing. Now it is one bounded `extension-ctx-stale`
	// record subject-keyed to `session_start`.
	//
	// Skipping the whole handler is the right stale-path answer, not a loss:
	// `rememberOwnEventCtx` would otherwise store the DEAD ctx as pi-lens's
	// own, and the warms plus per-session resets above all re-run when the
	// replacement session fires its own live `session_start`.
	pi.on(
		"session_start",
		wrapSessionEventHandler(
			"session_start",
			async (event, ctx) => {
				const sessionStartMonotonicAt = performance.now();
				warmDispatchAtSessionStart();
				void warmLspService().catch((err) =>
					logExtension({
						subsystem: "lsp",
						level: "warn",
						message: `LSP warm failed: ${err}`,
					}),
				);
				void warmFormatters().catch((err) =>
					logExtension({
						subsystem: "format",
						level: "warn",
						message: `formatter warm failed: ${err}`,
					}),
				);
				rememberOwnEventCtx(ctx);
				refreshCtxDerivedPlumbing();
				const sessionStartFiredAt = Date.now();
				try {
					dbg("session_start fired");
					// #1775: one bounded build-identity line per session start —
					// commit/entryMtime/version — so dogfood forensics ("does this
					// session include PR #N?") reads it off the log instead of
					// re-deriving it by hand in the serving checkout each time.
					// getBuildIdentity is a pure fs read (no spawn) and returns
					// undefined inside the test runner, so nothing is computed when
					// this line would be a no-op anyway.
					const buildIdentity = getBuildIdentity(import.meta.url);
					if (buildIdentity) dbg(formatBuildIdentity(buildIdentity));
					const sessionReason = (event as { reason?: string }).reason;

					// #1334 S5: adopt the HOST's project-trust decision before anything
					// below can auto-install a tool or spawn an LSP server. pi-lens is a
					// CONSUMER of trust (`ctx.isProjectTrusted()`), never a handler of the
					// `project_trust` event — answering that question on the user's behalf
					// is the host's/user's job. Re-read here and on every turn_start because
					// fork/reload/resume can change cwd and trust can change mid-session.
					// Feature-detected:
					// a host without the accessor yields "unknown" and nothing is gated.
					const trustState = adoptProjectTrustFromPorts(hostPorts);
					if (trustState !== "unknown") {
						dbg(`session_start: project trust = ${trustState}`);
					}
					if (trustState === "untrusted") {
						dbg(
							"session_start: untrusted project — tool auto-install and LSP spawns are disabled for this session",
						);
					}

					// #190: pi's session lifecycle. `reason` distinguishes new/resume/fork/
					// reload/startup; the STABLE session id comes from the session manager
					// (the event carries none), and is what lets a resumed session rehydrate.
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
					// -live parent) or updateRuntimeIdentityFromCtx (which would
					// overwrite the parent's telemetry identity).
					// #2129: the third argument is this start's PROJECT ROOT. Without
					// it, a subagent temp worktree arriving with an already-disposed
					// prior ctx classified `sequential-replacement`, stole the primary
					// registration, and re-ran the whole session_start battery against
					// unchanged content. Root identity is now a classification input.
					// Read defensively, and do NOT fall back to `process.cwd()`.
					// `ctx.cwd` is an `assertActive()`-wrapped accessor, so a ctx the
					// SDK already invalidated throws on the plain read. A
					// `process.cwd()` fallback would also be worse than no value: it is
					// identical for every root in the process, so a temp worktree would
					// compare equal to the primary and the decline could never fire.
					// An unreadable cwd yields `undefined` — "root unknown" — which
					// changes no verdict.
					const sessionStartCwd = (() => {
						try {
							return (ctx as { cwd?: string })?.cwd;
						} catch {
							return undefined;
						}
					})();
					const sessionStartDecision = decideSessionStart(
						ctx,
						stableSessionId,
						sessionStartCwd,
					);
					ownedSessionRole = sessionStartDecision.runFullSessionStart
						? "primary"
						: "concurrent-secondary";
					if (!sessionStartDecision.runFullSessionStart) {
						dbg(
							`session_start: ${sessionStartDecision.classification} detected (count=${sessionStartDecision.secondaryCount}, sameRoot=${sessionStartDecision.sameRoot}) — skipping handleSessionStart`,
						);
						logConcurrentSessionBind({
							secondaryCount: sessionStartDecision.secondaryCount,
							sessionReason,
							sameCwd: (ctx as { cwd?: string })?.cwd === process.cwd(),
							// #2129: `sameCwd` above compares against `process.cwd()`,
							// which answers a different question and read `true` for every
							// pre-fix bind. These three fields record the input the
							// classification actually consulted — the registered PRIMARY's
							// root — so a log reader can tell a root-declined start from a
							// live-sibling one.
							classification: sessionStartDecision.classification,
							sameRoot: sessionStartDecision.sameRoot,
							primaryRoot: sessionStartDecision.primaryRoot,
						});
						// #2130 review F2: a declined start returns BEFORE
						// `registerInstance` (which lives in the full-start body below),
						// so without this the secondary's root would be absent from
						// `instances.json` entirely — the shared-checkout guard and warm
						// attach would know LESS about it than they did before #2130, and
						// `deregisterInstanceRoot` at its shutdown would have nothing to
						// remove. Only the ROOT is added: none of `registerInstance`'s
						// other side effects (RSS resample, startedAt reseed, subagent
						// identity capture) belong to a session that is being declined.
						// Gated on `sameRoot === false` — positive evidence of a
						// different root — because a secondary in the primary's own
						// directory adds nothing to the set.
						if (
							sessionStartDecision.sameRoot === false &&
							typeof sessionStartCwd === "string"
						) {
							void registerInstanceRoot(sessionStartCwd).catch(() => {
								// best-effort observability — never fail session_start
							});
						}
						return;
					}

					// #2319: this process-singleton tally belongs to the primary
					// session that owns the session-end rollup. A concurrent secondary
					// must not erase a live primary's count before this decision.
					resetVerifiedPathAttributionGuessCount();

					// #1723 review F4: the in-flight-phase live-bracket map/closed-ring
					// (clients/latency-logger.ts) is process-shared state, exactly like
					// the LSP fleet / runtime generation the #473 gate above already
					// protects — so this reset belongs BEHIND that gate, not before it.
					// A concurrent secondary's session_start must not wipe brackets a
					// still-live PARENT activation genuinely has open; only a confirmed
					// full session start (this line has already returned otherwise) may
					// assume no sibling activation still owns live brackets in this
					// process. See `resetCurrentPhaseForSession`'s doc comment for the
					// accepted cost on the other side (a torn-down secondary's own
					// bracket goes stale until the next full session start).
					resetCurrentPhaseForSession();
					// #2249: same gate — a declined bind's own session_start must never
					// reach here (it returned above), so this only fires for a genuine
					// new primary. A crash or forced kill can skip session_shutdown's
					// own emit+reset below, so the rollup also re-arms here rather than
					// trusting shutdown alone (AGENTS.md catalog shape 17).
					// #2312 review F1: on the sequential-replacement path (prior primary
					// never reached session_shutdown), the reset below would otherwise
					// silently discard an unemitted tally. Emit first — a no-op when
					// nothing was declined — so the crash/kill case still produces its
					// one summary row instead of losing it.
					emitConcurrentSessionBindRollupAtSessionEnd(runtime.projectRoot);
					resetConcurrentSessionBindRollupCounts();

					// Dynamic tooling (#pi 0.80.x+): put the active tool set back to the
					// posture this logical conversation had — the always-active baseline
					// plus exactly the lazy tools (LAZY_TOOL_CATALOG) the model activated
					// via pi_lens_activate_tools. session_start is the correct lifecycle
					// point for this call (#643; see the comment left at the old call site
					// above, right after tool registration, for why it can never succeed
					// there).
					//
					// #1453: this RESTORES, it does not merely shrink. Every session_start
					// reason arrives with all registered pi-lens tools active, because the
					// host builds a fresh AgentSession with `includeAllExtensionTools: true`
					// on fork/reload/resume just as it does on startup, and never persists
					// an active-tool set per session. Skipping the call on those reasons
					// would therefore leave every lazy tool active forever AND change the
					// advertised tool list relative to the parent's cached prompt prefix.
					// Rebuilding the same set instead keeps the prefix identical and
					// genuinely preserves the model's activations, because pi-lens's own
					// closure state (`rememberedLazyTools`) survives the rebuild.
					//
					// Deliberately BELOW the #473 concurrent-secondary guard: the active
					// tool set is shared runtime state (one loader per process), so a
					// secondary's session_start must never rewrite the still-live
					// primary's set — last writer would win.
					//
					// Feature-detected the same way as elsewhere in this handler:
					// `pi.getActiveTools`/`setActiveTools` aren't guaranteed present on
					// every host the broad `@earendil-works/pi-coding-agent` peer
					// dependency allows, so probe with typeof rather than assuming the
					// pinned devDependency version's API exists at runtime. Under
					// `--no-lazy-tools` nothing is touched at all: all-active IS the
					// requested posture.
					try {
						const piWithActiveTools = pi as unknown as {
							getActiveTools?: () => string[];
							setActiveTools?: (names: string[]) => void;
						};
						if (
							getLensFlag("no-lazy-tools") !== true &&
							typeof piWithActiveTools.getActiveTools === "function" &&
							typeof piWithActiveTools.setActiveTools === "function"
						) {
							// A fresh conversation starts with no activation memory; a
							// rebuild inherits the parent's.
							if (isFreshSessionStart(sessionReason))
								rememberedLazyTools.clear();
							const lazyNames = new Set(LAZY_TOOL_CATALOG.map((t) => t.name));
							const plan = planToolSet(
								piWithActiveTools.getActiveTools(),
								lazyNames,
								rememberedLazyTools,
							);
							if (plan.changed) {
								piWithActiveTools.setActiveTools(plan.desired);
								recordToolSetMutation({
									addedCount: plan.addedCount,
									removedCount: plan.removedCount,
									reason: isFreshSessionStart(sessionReason)
										? "fresh_session_lazy_deactivation"
										: "session_rebuild_restore",
									deferralApplies: supportsDeferredTools(
										(
											ctx as {
												model?: Parameters<typeof supportsDeferredTools>[0];
											}
										)?.model,
									),
								});
							}
						}
					} catch (toolSetErr) {
						dbg(
							`dynamic tool set restore failed (older pi host lacking getActiveTools/setActiveTools, or a genuine host error): ${toolSetErr}`,
						);
					}

					// #449 slice 1 / #472: register this process in the cross-process
					// instance registry and fire-and-forget an orphan-LSP sweep. Below the
					// #473 guard deliberately: a concurrent secondary neither re-registers
					// (the pid's entry already exists) nor re-sweeps (a fan-out would run
					// up to maxConcurrent redundant sweeps). Neither call is awaited —
					// registry I/O and the reaper must never delay session start; both are
					// internally best-effort (never throw).
					await configureWarmAttach(ctx.cwd ?? process.cwd());
					void registerInstance(ctx.cwd ?? process.cwd()).catch(() => {
						// best-effort observability — never fail session_start over this
					});
					// #1123 item 2: log a sessionstart.log marker for any registry entry
					// whose owning pid is confirmed dead — this instance vanished without
					// reaching deregisterInstance()'s clean-shutdown removal. MUST read the
					// registry and log BEFORE sweepOrphans (below) prunes exactly these same
					// dead-pid entries out from under it, or the vanished set would already
					// be empty by the time this runs — hence the explicit read here rather
					// than letting sweepOrphans's own internal read race it.
					void readInstanceRegistry()
						.then((registry) => logVanishedInstances(registry))
						.catch(() => {
							// best-effort observability — never fail session_start over this
						})
						.finally(() => {
							void sweepOrphans();
						});
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
					//
					// #1857: SCHEDULED, not called. The sweep's OS-process enumeration was
					// measured at 9344ms on the session_start critical path, exactly
					// overlapping and starving `warmup_language_profile`. It now fires on
					// an unref'd timer well after warmup, under a machine-wide cooldown.
					scheduleUntrackedOrphanSweep();
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
					updateRuntimeIdentityFromCtx(ctx);
					try {
						await ensureLSPConfigInitialized(ctx.cwd ?? process.cwd());
					} catch (cfgErr) {
						dbg(`lsp config init failed: ${cfgErr}`);
					}

					const bootstrapClientsStartedAt = Date.now();
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
					const bootstrapClientsDurationMs =
						Date.now() - bootstrapClientsStartedAt;
					const handlerEnteredAt = Date.now();
					// Consume the process-lifetime measurement at the first real session
					// start. Concurrent secondary starts never reach this handler.
					const emitHostReadyDelay = consumeHostReadyDelayAnchor();
					// #1999: rising-edge sampler state is session-scoped module state —
					// reset beside the primary session-start reset block so a tightened
					// sampling window cannot leak across sessions.
					resetMemorySamplerCadence();
					await handleSessionStart({
						ctxCwd: ctx.cwd,
						sessionStartFiredAt,
						sessionStartMonotonicAt,
						extensionLoadedAt: PI_LENS_LOADED_AT_MS,
						emitHostReadyDelay,
						sessionReason,
						handlerEnteredAt,
						bootstrapClientsStartedAt,
						bootstrapClientsDurationMs,
						// #2129: this call site is only reached for "primary"/
						// "sequential-replacement" — a declined start returned above.
						sessionStartClassification: sessionStartDecision.classification,
						sessionStartSameRoot: sessionStartDecision.sameRoot,
						getFlag: (name: string) => getLensFlag(name),
						notify: (msg, level) => notifyUi(ctx, msg, level),
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
					const startMode = sessionStartMode(
						sessionReason,
						!!pendingForkSnapshot,
					);
					if (startMode === "fork" && pendingForkSnapshot) {
						// Branch the forked session from the source's in-memory snapshot, then
						// persist it under the new session id so the fork owns its own copy.
						clearWidgetState();
						importWidgetState(pendingForkSnapshot);
						const forkedFileCount = pendingForkSnapshot.files.length;
						pendingForkSnapshot = undefined;
						// #1041: adopt the source session's read history (staleness-reconciled
						// against current disk) so the fork isn't zero-read-blocked on files
						// the parent already read.
						let forkReadImport:
							| { imported: number; dropped: number }
							| undefined;
						if (pendingForkReadGuard) {
							forkReadImport =
								runtime.readGuard.importState(pendingForkReadGuard);
							pendingForkReadGuard = undefined;
						}
						if (stableSessionId) {
							void saveSessionState(
								ctx.cwd ?? process.cwd(),
								stableSessionId,
								exportWidgetState(),
								runtime.readGuard.exportState(),
							);
						}
						dbg(
							`session_start: fork — branched ${forkedFileCount} file(s) from source` +
								(forkReadImport
									? `, read-guard +${forkReadImport.imported} (dropped ${forkReadImport.dropped})`
									: ""),
						);
					} else if (startMode === "keep") {
						dbg("session_start: reload — keeping widget state");
					} else if (startMode === "clean") {
						pendingForkSnapshot = undefined;
						pendingForkReadGuard = undefined;
						clearWidgetState();
						dbg("session_start: new — clean widget");
					} else {
						// maybe-rehydrate: covers resume AND startup (e.g. `pi --session <id>`)
						pendingForkSnapshot = undefined;
						pendingForkReadGuard = undefined;
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
								const dropped =
									persisted.widget.files.length - fresh.files.length;
								importWidgetState(fresh);
								// #1041: rehydrate the read-before-edit guard's read-set on the
								// SAME path so the first post-resume edit of a previously-read
								// file isn't falsely zero-read-blocked. importState reconciles
								// each read against current disk (drops changed/missing files),
								// so a resume never masks a real staleness.
								const readImport = runtime.readGuard.importState(
									persisted.readGuard,
								);
								dbg(
									`session_start: ${reasonLabel} ${stableSessionId} — rehydrated ${fresh.files.length} file(s)` +
										(dropped > 0 ? `, dropped ${dropped} stale` : "") +
										(readImport.imported > 0 || readImport.dropped > 0
											? `; read-guard +${readImport.imported} read(s) (dropped ${readImport.dropped} stale)`
											: ""),
								);
							} else {
								dbg(
									`session_start: ${reasonLabel} ${stableSessionId} — no persisted state (clean)`,
								);
							}
						} else {
							dbg(
								`session_start: ${reasonLabel} — no stable session id (clean)`,
							);
						}
					}

					if (lensWidgetVisible) {
						mountLensWidget(ctx.ui, readExtensionMode(ctx));
					}
				} catch (sessionErr) {
					// The stale-ctx class has ONE classifier and one record, in
					// clients/session-event-guard.ts. Rethrow so the wrapper around
					// this registration owns it, instead of this catch logging a
					// session swap as a pi-lens crash (#1929, same shape as the
					// agent_end and turn_end catches).
					if (isStaleExtensionCtxError(sessionErr)) throw sessionErr;
					dbg(`session_start crashed: ${sessionErr}`);
					dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
				}
			},
			{ dbg },
		),
	);

	// #190 Phase 2: capture the source session's diagnostics just before a fork,
	// so the forked session (its `session_start` fires with reason="fork") can
	// branch from them instead of starting empty. In-memory hand-off within the
	// same process; cleared once adopted (or on any non-fork start).
	(pi as any).on("session_before_fork", () => {
		try {
			pendingForkSnapshot = exportWidgetState();
			// #1041: the source guard is still live here (reset happens in the
			// fork's own session_start, which fires later), so this captures the
			// parent's read-set for the fork to adopt.
			pendingForkReadGuard = runtime.readGuard.exportState();
			dbg(
				`session_before_fork: stashed ${pendingForkSnapshot.files.length} file(s) + ${pendingForkReadGuard.reads.length} read-guard file(s) for the fork`,
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
	const onToolResult = async (event: any, ctx: any) => {
		rememberOwnEventCtx(ctx);
		if (!lensEnabled) return;
		updateRuntimeIdentityFromCtx(ctx);
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
				getFlag: (name: string, filePath?: string) =>
					getLensFlag(name, filePath),
				getFlagSource: (name: string, filePath?: string) =>
					getLensFlagSource(name, filePath),
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
				// #791: tags any deferred-format record queued from this tool_result
				// with the STABLE session id of the ctx that produced it, so a
				// later agent_end can tell its own queued work apart from a
				// concurrent in-process secondary session's.
				sessionId: getStableSessionId(ctx),
			});
		} finally {
			setAmbientAbortSignal(undefined);
		}
	};
	// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
	(pi as any).on(
		"tool_result",
		wrapSessionEventHandler("tool_result", onToolResult, { dbg }),
	);

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	// Clear cascade snapshot at start of each new turn so stale data never leaks
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	const onTurnStart = (_event: any, ctx: any) => {
		rememberOwnEventCtx(ctx);
		// Trust can change without a new session. Re-adopt before this turn can
		// reach any install-capable or LSP-spawn path.
		adoptProjectTrustFromPorts(hostPorts);
		if (
			lensWidgetVisible &&
			ctx?.ui &&
			(mountedLensWidgetUi === undefined || mountedLensWidgetUi !== ctx.ui)
		) {
			mountLensWidget(ctx.ui, readExtensionMode(ctx));
		}
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
	};
	pi.on(
		"turn_start",
		wrapSessionEventHandler("turn_start", onTurnStart, { dbg }),
	);

	// #1654: `agent_end` fires every time pi's internal `_runAgentPrompt` loop
	// finishes A run — including a run that is about to auto-retry or resume
	// after overflow-compaction. pi computes `willRetry` only AFTER emitting
	// this event and never exposes it to extensions (source-level audit:
	// `AgentEndEvent` is `{type, messages}` only, pi agent-session.ts:643-645;
	// see node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts).
	// The #1387 deferred-format/autofix drain below therefore used to be able
	// to fire MID-RUN, between retries — formatting files the agent is still
	// actively working on, which can shift lines under queued work and stale
	// in-flight content bindings (the #1642 harm family).
	//
	// `agent_settled` is the documented once-per-run signal — "fired after an
	// agent run has fully settled and no automatic retry, compaction, or
	// queued continuation will run" (AgentSettledEvent, same types.d.ts) — so
	// the drain moves there (see the `agent_settled` registration below) and
	// is no longer run from `agent_end` at all.
	//
	// There is deliberately no capability-detection fallback back onto
	// `agent_end` for a host that never fires `agent_settled`: `pi.on`
	// registration is a silent no-op push onto a plain Map regardless of
	// whether the host will ever emit the event (see quiet-window.ts's module
	// doc), so "registration succeeded" proves nothing about whether the
	// event will actually fire — a heuristic built on that would be as
	// unreliable as no heuristic at all, and a timer-based "drain if settled
	// hasn't fired within N ms" watchdog would reintroduce this exact bug on
	// a SUPPORTED host whenever a retry/compaction cycle legitimately takes
	// longer than the watchdog window.
	//
	// There is also deliberately no separate "drain at session_shutdown"
	// safety net (review round 1, F2/F3/F4/F5): `agent_settled` is
	// documented to fire from `_runAgentPrompt`'s `finally` on normal
	// completion, on an aborted run, AND on a throw — the only way to miss it
	// is the process itself dying (a hard kill, an OOM, a host crash before
	// the finally runs), and a `session_shutdown`-based net cannot help with
	// that case either (the process is gone before any handler could run). A
	// run that dies without settling therefore strands its queued records in
	// this session's in-memory `_pendingDeferredMutations` map — but not
	// permanently: `claimDeferredMutations`'s existing staleness fallback
	// (`DEFERRED_FORMAT_STALE_AFTER_MS`, 10 minutes — the same mechanism
	// #791 already uses to recover a concurrent-secondary session's orphaned
	// records) lets the NEXT session in this process claim them as orphaned
	// once they've aged out. That is a real, honestly-documented behavior
	// change from pre-#1654 (deferred format used to run every `agent_end`,
	// so it never truly stranded), traded for correctness: it beats
	// formatting files the agent is still actively working on mid-retry.
	type DeferredDrainCtx = {
		cwd?: string;
		signal?: AbortSignal;
		ui?: {
			setStatus?: (id: string, text: string | undefined) => void;
			theme?: LspStatusTheme;
		};
	};

	async function runDeferredMutationDrain(
		ctx: DeferredDrainCtx,
	): Promise<void> {
		const currentSessionId = getStableSessionId(ctx);
		// #791 defense-in-depth: mirrors how session_start already skips
		// handleSessionStart for a concurrent in-process secondary
		// (subagent) — if THIS firing is positively identified as belonging
		// to a live sibling secondary session rather than the registered
		// primary, skip the deferred-format flush entirely rather than
		// relying only on the per-record ownership filter inside
		// handleAgentEnd. Fail-safe: any inconclusive signal classifies
		// "primary" and runs as before.
		const emission = classifyOwnedSessionEmission(ctx, currentSessionId);
		if (emission === "concurrent-secondary") {
			dbg(
				`deferred_mutation_drain: concurrent secondary session detected — skipping (sessionId=${currentSessionId})`,
			);
			logLatency({
				type: "phase",
				filePath: ctx.cwd ?? "<pi-lens>",
				phase: "agent_end_concurrent_secondary_skip",
				durationMs: 0,
				metadata: { sessionId: currentSessionId },
			});
			return;
		}
		await handleAgentEnd({
			ctxCwd: ctx.cwd,
			getFlag: (name: string, filePath?: string) => getLensFlag(name, filePath),
			getFlagSource: (name: string, filePath?: string) =>
				getLensFlagSource(name, filePath),
			notify: (msg, level) => notifyUi(ctx, msg, level),
			dbg,
			runtime,
			cacheManager,
			getFormatService: () =>
				getFormatService(runtime.telemetrySessionId, true),
			getAutofixClients: async () => {
				const { biomeClient, ruffClient } = await loadBootstrapClients();
				return { biomeClient, ruffClient };
			},
			currentSessionId,
		});
		if (ctx.ui?.setStatus && ctx.ui.theme) {
			updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	const onAgentEnd = async (_event: any, ctx: any) => {
		if (!lensEnabled) return;
		// Esc/abort during the debounce flush kills in-flight children. The
		// deferred-format/autofix drain no longer runs from this handler at
		// all (#1654 — see the module comment above); its own abort/requeue
		// handling is wired at the `agent_settled` registration below instead.
		try {
			// Inside the try so the `finally` below covers it: reading
			// `ctx.signal` is itself a guarded SDK accessor that can throw when a
			// session replacement lands after the guard's pre-dispatch probe
			// (#1925).
			setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
			// Ensure any pipeline still queued in the debounce window finishes
			// before agent_end runs — otherwise project change-log entries and
			// modified ranges this turn produced may not be reflected yet. This
			// is per-turn bookkeeping for edits the agent already made, not the
			// once-per-run deferred-format/autofix drain (#1654: that moved to
			// `agent_settled` below, since — unlike this flush — running it here
			// can fire mid-run, between auto-retries).
			await flushDebouncedToolResults();
			ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		} catch (agentEndErr) {
			// The stale-ctx class has ONE classifier and one record, in
			// clients/session-event-guard.ts. Rethrow so the wrapper around this
			// registration owns it, instead of a second copy here logging it as a
			// crash (#1925).
			if (isStaleExtensionCtxError(agentEndErr)) throw agentEndErr;
			dbg(`agent_end crashed: ${agentEndErr}`);
			dbg(`agent_end crash stack: ${(agentEndErr as Error).stack}`);
		} finally {
			setAmbientAbortSignal(undefined);
		}
	};
	pi.on("agent_end", wrapSessionEventHandler("agent_end", onAgentEnd, { dbg }));

	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
	const onTurnEnd = async (_event: any, ctx: any) => {
		if (!lensEnabled) return;
		// Esc/abort during the turn-end flush (knip/madge/tests + debounced
		// dispatch) kills in-flight children instead of waiting out their timeout.
		try {
			// Inside the try for the same reason as `agent_end` above (#1925).
			setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
			const repaintLspStatus = captureLspStatusRepaint(ctx);
			// Persist every event-loop block over the floor to latency.log,
			// attributed to this turn, so freezes are queryable across sessions
			// (#192). Logging used to gate on "new session worst" alone, which
			// hid every sub-maximum block after a session's first large one —
			// exactly the blocks that need to be checked against LSP pull
			// timeouts (#1549/#1713), so #1723 widened the gate to the floor and
			// kept "new worst" only as metadata / high-water bookkeeping. Volume
			// stays bounded because this runs at most once per turn (the window
			// is per-turn, #1122): one `loop_block` record per turn, not one per
			// sample. The window is per-turn also so the probe cannot itself see
			// machine sleep or commit-charge paging, both of which freeze the
			// process and masquerade as huge synchronous blocks — samples the
			// turn's CPU budget can't account for are tagged
			// `suspectSystemStall` and excluded from the genuine-block
			// high-waters. `lastPhase`/`recentPhases` are cheap block attribution
			// (#1123 item 1, widened #1723 item 2) — the phases that ran before
			// the block was detected; a bounded ring rather than one pointer,
			// because the phase actually causing a synchronous block is often
			// still in flight (and so unlogged) when the block fires, so the
			// single last-COMPLETED phase can point at unrelated prior work.
			const elStats = getEventLoopStats();
			const loopMaxMs = elStats?.maxMs ?? 0;
			const suspectSystemStall = elStats?.suspectSystemStall ?? false;
			if (shouldLogLoopBlock(loopMaxMs)) {
				const lastPhase = getLastLoggedPhase();
				const recentPhases = getRecentLoggedPhases(3);
				// #1723 residual, redesigned after review (F1/F2/F3): `lastPhase`/
				// `recentPhases` above only ever name a phase that already
				// FINISHED. The motivating case — an 18s synchronous full-scan
				// block — had no attribution because the phase burning the CPU was
				// still running when the probe sampled, so it hadn't logged a
				// completion yet. `getPhaseForWindow` (clients/latency-logger.ts)
				// checks the block's own time window against both the still-live
				// brackets dispatcher.ts's `runRunner` keeps open AND a short ring
				// of recently CLOSED ones — the latter is load-bearing, not
				// redundant: `phaseFinished` resumes as a microtask, `turn_end` is
				// scheduled as a macrotask, and microtasks always drain first, so a
				// genuinely synchronous phase has typically ALREADY closed by the
				// time this line runs. Checking live brackets alone would read
				// empty for exactly the case this exists to catch. Both bracket
				// sites are wired now: the runner chokepoint (`runRunner` in
				// dispatcher.ts, #1805) and the LSP workspace-diagnostics sweep
				// (clients/lsp/index.ts), the latter as ONE bracket around the
				// whole per-file loop so it survives the closed-bracket ring to
				// reach this read point.
				//
				// #1723 review round 3: this window — [now - loopMaxMs, now] —
				// assumes the block ENDED right at this sample, which is a
				// reasonable approximation, not a measured fact (getEventLoopStats
				// reports the window's max delay, not its precise end instant). A
				// human reader has `inFlightPhaseStartedAt`/`inFlightPhaseElapsedMs`/
				// `inFlightPhaseStillRunning` on the record below to judge that
				// assumption per-block; an automated correlation (#1549) should
				// account for the same slack rather than treating these window
				// edges as exact.
				const blockSampledAtMs = Date.now();
				const inFlight = getPhaseForWindow(
					blockSampledAtMs - loopMaxMs,
					blockSampledAtMs,
				);
				const isNewSessionWorst = shouldLogWorstBlock(
					loopMaxMs,
					lastLoggedLoopWorstMs,
				);
				// #1743: routed through the bounded-telemetry helper. No
				// `capPerTurn` here, deliberately: this site's bound is its CALL
				// CADENCE (#1723) — `turn_end` runs it at most once per turn
				// because the histogram window resets every turn — so a
				// `capPerTurn: 1` would be a second, redundant guard that could
				// only ever fire in a harness that drives two `turn_end`s without
				// an intervening `turn_start`. The helper still supplies the
				// registry membership the sweep checks.
				emitBounded("loop_block", LOOP_BLOCK_IDENTITY, {
					type: "phase",
					durationMs: Math.round(loopMaxMs),
					metadata: {
						worstSoFar: isNewSessionWorst,
						turnIndex: runtime.turnIndex,
						suspectSystemStall,
						// #1980: the CPU-vs-wall split, read from the record alone.
						// `windowCpuMs` has sat beside every block since #1122 and
						// was never read together with `durationMs`; nine of sixteen
						// genuine 5s+ blocks in a 23h window burned less CPU than the
						// block lasted, which makes them parked, not computing. The
						// monitor owns the verdict (clients/event-loop-monitor.ts's
						// `classifyLoopBlock`) so `suspectSystemStall` and
						// `stallClass` cannot disagree about one sample.
						stallClass: elStats?.stallClass,
						cpuCoverageRatio: elStats?.cpuCoverageRatio,
						windowCpuMs: elStats?.windowCpuMs,
						windowWallMs: elStats?.windowWallMs,
						lastPhase: lastPhase?.phase,
						lastPhaseAt: lastPhase?.ts,
						recentPhases,
						inFlightPhase: inFlight?.phase,
						inFlightPhaseStartedAt: inFlight?.startedAt,
						inFlightPhaseElapsedMs: inFlight?.elapsedMs,
						inFlightPhaseStillRunning: inFlight?.stillRunning,
					},
				});
				// A system stall must not raise the "new worst genuine block"
				// bar, or it would silence every real block that follows it.
				if (suspectSystemStall) {
					sessionSuspectedStalls += 1;
				} else if (isNewSessionWorst) {
					lastLoggedLoopWorstMs = loopMaxMs;
					sessionWorstRealBlockMs = Math.max(
						sessionWorstRealBlockMs,
						loopMaxMs,
					);
				}
			}
			// Start a fresh per-turn occupancy window so the next turn's worst
			// block is attributable to that turn and its CPU budget is measured
			// over the same span (#1122).
			resetEventLoopMonitor();

			// #1123 item 2 + #1999: periodic memory-attribution sample. Base cadence
			// is every MEMORY_SAMPLE_TURN_INTERVAL turns; when heapUsed grew >20%
			// between samples the gate tightens to every turn until growth stabilizes
			// (see clients/memory-sampler.ts). Session age + turn count ride along so
			// growth-vs-age curves are plottable from logs alone. Still cheap:
			// O(1)/O(bounded-cache-size) reads only, no extra throttling needed.
			if (shouldEmitMemorySampleAdaptive(runtime.turnIndex)) {
				try {
					const sample = buildMemorySample(
						runtime.wordIndex,
						undefined,
						undefined,
						{
							sessionAgeMs: Math.max(0, Date.now() - runtime.sessionStartedAt),
							sessionStartedAt: runtime.sessionStartedAt,
							turnCount: runtime.turnIndex,
							// #2130: root discriminator. Two roots in one host emitted
							// the same turnIndex with nothing to separate them.
							root: getActivePrimaryRoot(),
						},
					);
					logLatency({
						type: "phase",
						filePath: "<pi-lens>",
						phase: "memory_sample",
						durationMs: 0,
						metadata: { turnIndex: runtime.turnIndex, ...sample },
					});
					recordMemorySampleOutcome(
						sample.process.heapUsedBytes,
						runtime.turnIndex,
					);
				} catch {
					// best-effort observability — never fail turn_end over this
				}
			}

			// #1123 item 3: bounded smells re-check, same cadence style as the memory
			// sample above — at most once per SMELLS_TURN_CHECK_INTERVAL turns, and
			// each smell notifies at most once per session (checkSmellsAndNoteOnce's
			// gate). See clients/smells-rollup.ts for the tail-scan cost bound.
			if (shouldCheckSmellsThisTurn(runtime.turnIndex)) {
				try {
					// S3c (#1432 review): use the in-process session start instead of
					// letting countRecentSmells() fall back to its 24h rolling
					// window — turn_end already knows exactly when this session
					// began, so admitted rows are scoped to it, not to a day-wide
					// guess that could straddle multiple sessions.
					for (const note of checkSmellsAndNoteOnce(
						countRecentSmells(undefined, runtime.sessionStartedAt),
					)) {
						notifyUi(ctx, note, "warning");
					}
				} catch {
					// best-effort observability — never fail turn_end over this
				}
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
				sessionId: getStableSessionId(ctx),
				onTestRunnerComplete: (delivery) =>
					stageTestRunnerDelivery({
						...delivery,
						owner: {
							ownerId: testRunnerDeliveryOwnerId,
							pi,
							cacheManager,
							runtime,
							getCtx: () => ownEventCtx ?? {},
						},
					}),
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
						resetLSPService({ reason: "idle" });
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
					// #1041: persist the read-guard read-set on the same snapshot so a
					// later resume can rehydrate it (reconciled against disk on load).
					runtime.readGuard.exportState(),
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
			// One classifier for the stale-ctx class — see `agent_end` above.
			if (isStaleExtensionCtxError(turnEndErr)) throw turnEndErr;
			dbg(`turn_end crashed: ${turnEndErr}`);
			dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		} finally {
			setAmbientAbortSignal(undefined);
		}
	};
	pi.on("turn_end", wrapSessionEventHandler("turn_end", onTurnEnd, { dbg }));

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
	if (!_testRunnerDeliveryRegistered) {
		_testRunnerDeliveryRegistered = true;
		registerQuietWindowTask("test_runner_delivery", (quietContext) => {
			deliverStagedTestRunnerFindings(quietContext);
		});
	}
	// #458: reconcile any cascade-lane Tier-3 touches that skipped their
	// in-lane wait (clients/lsp/cascade-tier.ts) in the same quiet window.
	// #1023: re-inject a cold-snapshot neighbor whose error resolved after the
	// turn ended through the SAME turn-end cascade seam (append a CascadeRun the
	// next turn_end merges), reusing the existing neighbor→turn-end formatting —
	// previously this outcome was logs-only, a silent under-report (#533).
	registerCascadeTierReconcileTask(() => getLSPService(), {
		onResolvedFound: ({ filePath, diagnostics }) => {
			const run = buildResolvedFoundCascadeRun(runtime.projectRoot, {
				filePath,
				diagnostics,
			});
			// #1443: the appended run outlives this turn's consumption —
			// `beginTurn` carries it into the next turn_end exactly once instead
			// of wiping it (which used to dead-end this whole delivery path).
			if (run) runtime.appendCascadeRun(run);
		},
		// #1444 (issue impact #2): the mirror case — the neighbour published
		// CLEAN after the skipped in-lane wait. The in-lane path reconciles that
		// into the footer (`reconcileCascadeNeighborLspErrors`, the #1093 seam);
		// the skipped path never could, so a fixed neighbour kept showing its old
		// errors. Errors-only MERGE, so a live warning/biome finding survives; no
		// write token exists at quiet-window time (the run is idle, nothing is
		// racing this write), and `publishedAt` stamps the real observation time.
		// Scope caveat: the touch was `clientScope: "primary"`, so this clears the
		// LSP-error entries of a multi-primary-server file on one server's clean —
		// the same errors-only tradeoff the in-lane reconcile documents.
		onResolvedClean: ({ filePath, publishedAt }) => {
			reconcileCascadeNeighborLspErrors(filePath, [], undefined, publishedAt);
		},
	});
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
			// The captured `pi` can go STALE between the activation that set this
			// holder and this fire-and-forget quiet-window run: an interim
			// newSession/fork/switchSession/reload invalidates the runtime, after
			// which any `pi.*` call — the getFlag below (reached first), or the
			// sendMessage later — throws the SDK's stale-ctx guard. That is benign
			// here: the session this run's summary belonged to is gone, so there is
			// nothing to emit into. Treat it as a no-op, NOT a task failure — this
			// exact throw at the flag read (outside the sendMessage try/catch)
			// spammed the live-dogfood sessionstart.log 55× as `quiet_window:
			// task "turn_summary_emit" failed` — the single most frequent error in
			// that log. A non-stale error still propagates to the scheduler so it
			// is recorded (ok:false) + logged with its stack.
			let turnSummaryEnabled: boolean | string | undefined;
			try {
				turnSummaryEnabled = emitCtx.getLensFlag("lens-turn-summary");
			} catch (err) {
				if (isStaleExtensionCtxError(err)) {
					dbg(
						"turn_summary_emit: skipped — captured pi ctx is stale (session replaced/reloaded before the quiet window ran)",
					);
					return;
				}
				throw err;
			}
			if (!turnSummaryEnabled) return;
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
					if (isStaleExtensionCtxError(sendErr)) {
						dbg(
							"turn_summary_emit: skipped emit — pi ctx went stale (session replaced/reloaded)",
						);
						return;
					}
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
	const onAgentSettled = async (_event: unknown, ctx: DeferredDrainCtx) => {
		if (!lensEnabled) return;
		// Keep the activation-owned live ctx current for the detached delivery
		// task. It must probe idleness and append through this run's host seam.
		rememberOwnEventCtx(ctx);
		// #1654: the #1387 deferred-format/autofix drain runs HERE, not at
		// agent_end — see `runDeferredMutationDrain`'s doc comment above.
		// Awaited (unlike the quiet-window tasks below): this mirrors the
		// user-facing latency the drain already had pre-#1654 (it used to
		// block `agent_end` the same way), just correctly gated on true
		// settlement instead of firing mid-retry. A throw here must not
		// skip the quiet window below.
		//
		// Review round 1 (F1): `agent_settled` fires on an ABORTED run too
		// (ESC), and `ctx.signal` on that firing still reflects the
		// aborted controller. `handleAgentEnd`'s abort/requeue branches
		// (clients/runtime-agent-end.ts) read the ambient signal via
		// `getAmbientAbortSignal()`, not a parameter — exactly like
		// `agent_end`/`turn_end` already do around their own work — so an
		// ESC-aborted settle must set it here too, or every queued record
		// gets FORMATTED instead of requeued (an inversion of the #1642
		// harm this issue exists to fix) and the requeue branches become
		// production-unreachable.
		try {
			setAmbientAbortSignal(ctx?.signal);
			try {
				await runDeferredMutationDrain(ctx);
			} catch (drainErr) {
				// #1924 classified the stale-ctx case inline here. #1925 moved the
				// classifier and its record to clients/session-event-guard.ts, so
				// this site only declines to swallow it: rethrow, and the wrapper
				// around the registration skips the run and counts it.
				if (isStaleExtensionCtxError(drainErr)) throw drainErr;
				dbg(`agent_settled deferred_mutation_drain crashed: ${drainErr}`);
			} finally {
				setAmbientAbortSignal(undefined);
			}
			const cwd = ctx?.cwd;
			void runQuietWindow({
				runtime,
				dbg,
				cwd,
				sessionId: getStableSessionId(ctx),
				ownerId: testRunnerDeliveryOwnerId,
			}).catch((err) => {
				dbg(`quiet_window crashed: ${err}`);
			});
			// #1123 item 4: dump active handles AFTER the quiet-window work is
			// scheduled — the #1097-class leak (a stray ref'd timer surviving
			// past settle) is only visible once whatever settle itself queued is
			// already in flight. No-op unless PI_LENS_DEBUG_HANDLES=1.
			dumpActiveHandles("agent_settled");
		} catch (settledErr) {
			setAmbientAbortSignal(undefined);
			throw settledErr;
		}
	};
	try {
		// #1925: #1924's inline stale-ctx guard moved onto the shared wrapper
		// (clients/session-event-guard.ts), so `agent_settled` is a consumer of
		// the central path rather than the one handler with its own copy of the
		// policy. Behavior is unchanged — the run is skipped and nothing throws
		// into the host — and the skip is now counted in the degradation ledger.
		(pi as any).on(
			"agent_settled",
			wrapSessionEventHandler("agent_settled", onAgentSettled, { dbg }),
		);
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
		// cancel that the parent still relies on. Role-local cache observability
		// summary/cleanup is safe before the return; all shared-infra teardown
		// remains below and is skipped by a secondary.
		const stableSessionId = (() => {
			try {
				return (
					ctx as { sessionManager?: { getSessionId?: () => string } }
				)?.sessionManager?.getSessionId?.();
			} catch {
				return undefined;
			}
		})();
		// #2146 F1: read once, up here, so the classifier and the scoped
		// deregistration below both see the same value. A stale ctx must never
		// break teardown, so an unreadable cwd degrades to `undefined`, which
		// changes no verdict.
		const shutdownCwd = (() => {
			try {
				return (ctx as { cwd?: string })?.cwd;
			} catch {
				return undefined;
			}
		})();
		const shutdownClassification = classifyOwnedSessionShutdown(
			ctx,
			stableSessionId,
			shutdownCwd,
		);
		if (shutdownClassification === "secondary") {
			emitCacheUsageSummaryAtSessionEnd(
				stableSessionId,
				"concurrent-secondary",
			);
			clearCachePrefixSession(stableSessionId, "concurrent-secondary");
			decrementSecondarySessionCount();
			// #2130: scoped deregistration. A secondary's shutdown must never run
			// `deregisterInstance()` — the process lives on and the primary still
			// owns the entry. Drop only THIS session's own root, and only when it
			// is positively a different root than the primary's, so a secondary
			// that shares the primary's directory cannot deregister the root the
			// host is still working in. A root this session never registered is a
			// documented no-op inside `deregisterInstanceRoot`.
			//
			// #2130 round 2: the call is now QUEUED, so it lands behind this
			// session's own `void registerInstanceRoot(cwd)` from the declined
			// start above rather than racing ahead of it and leaving the temp
			// root behind. Fire and forget is still correct — the tail owns the
			// ordering, and teardown must not block on a registry write.
			try {
				const secondaryRoot = shutdownCwd;
				const primaryRoot = getActivePrimaryRoot();
				if (
					typeof secondaryRoot === "string" &&
					secondaryRoot.length > 0 &&
					primaryRoot !== undefined &&
					normalizeFilePath(secondaryRoot) !== primaryRoot
				) {
					void deregisterInstanceRoot(secondaryRoot).catch(() => {
						// best-effort bookkeeping — never fail teardown
					});
				}
			} catch {
				// Best-effort observability bookkeeping — a stale ctx or an
				// unresolvable path must never break teardown.
			}
			dbg(
				"session_shutdown: concurrent secondary — skipping shared-infra teardown",
			);
			return;
		}

		// #1654: no drain runs here — see the module comment above
		// `runDeferredMutationDrain` (review round 1, F2/F3/F4/F5) for why a
		// session_shutdown-based safety net was deliberately dropped rather
		// than kept.

		// #1018/#1996: emit the bounded primary cache summary, then drop this
		// session's prefix/attribution state. The secondary path did the same for
		// its role-local bucket before returning above.
		emitCacheUsageSummaryAtSessionEnd(stableSessionId, "primary");
		clearCachePrefixSession(stableSessionId, "primary");

		cancelLSPIdleReset();
		// #449 slice 1: SYNC-only deregistration (no child spawns — see the
		// processExiting note below); safe to call unconditionally here.
		deregisterInstance();
		// #2129 review F3: release the primary registration at the same boundary
		// the registry entry is released. Root identity made a stale `activeRoot`
		// decisive: without this, once root A's primary ended, every later start
		// in root B would classify `secondary-root` forever — never primary,
		// never a full start, no re-arm. This is the process-lifetime-latch shape
		// the catalog names. Only the PRIMARY path reaches here; a secondary
		// returned above precisely because the primary is still live.
		releasePrimarySession();
		// processExiting: the loop is closing here — killing LSP servers must NOT
		// spawn taskkill, or libuv aborts on uv_async_send to the closing loop
		// (Assertion !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c) — seen
		// on `pi update`. Direct handle-kill only. Grandchildren behind a
		// shell/.cmd wrapper are NOT reaped by the OS (Windows does not kill
		// children when a parent dies) — they rely on stdin EOF, LSP
		// `initialize.processId` self-watchdog compliance, and the #449/#472
		// cross-process instance registry's orphan reaper as the backstop (#472).
		resetLSPService({
			fast: true,
			processExiting: true,
			reason: "session_shutdown",
		});
		// S2d (gap 5, #1432 review): one session_end_bus_rollup row per event
		// name with any activity this session — same primary-only placement as
		// the shared-infra teardown above (a concurrent secondary already
		// returned before reaching here), since the rollup counters are
		// process-wide module state a live secondary would still need.
		emitBusEventRollupAtSessionEnd(runtime.projectRoot);
		emitVerifiedPathAttributionRollup(runtime.projectRoot);
		// #2249: same primary-only placement — one concurrent_session_bind_rollup
		// row summarizing this session's declined binds by classification, a
		// no-op when none occurred.
		emitConcurrentSessionBindRollupAtSessionEnd(runtime.projectRoot);
		// #1123 item 4: dump active handles AFTER teardown — whatever is still
		// alive at this point is exactly what would keep a --print/--no-session
		// process from exiting (the #1097 lesson: what survives IS the leak).
		// No-op unless PI_LENS_DEBUG_HANDLES=1.
		dumpActiveHandles("session_shutdown");
	});

	// --- Prompt-cache response-side usage observability (#1018) ---
	// On each assistant message_end, append ONE `cache_usage` latency record with
	// the provider-reported token/cost breakdown. `message_end` is a newer host
	// event; register defensively (clients/agent-nudge.ts pattern) — guard `pi.on`,
	// wrap in try/catch, and never throw out of the handler — so an older pi host
	// that never fires it simply produces no records rather than crashing wireup.
	try {
		// biome-ignore lint/suspicious/noExplicitAny: message_end overload absent on older host types
		(pi as any).on?.("message_end", (event: unknown, ctx: unknown) => {
			if (!lensEnabled) return;
			try {
				const sessionId = getStableSessionId(ctx);
				// #1956: a CONFIRMED-stale ctx has no stable session id, so the
				// cache_usage row below writes unattributed. That is right — the
				// `message` payload is valid provider token/cost data and must
				// keep writing; skipping it would lose real usage numbers. The
				// lost attribution is still a degrade, and one a session
				// replacement can repeat for every queued message_end, so it is
				// counted through the bounded ledger (`cache-usage-attribution-
				// stale`, subject `message_end`; durable `degradation_ledger`
				// rows at the first and power-of-two milestones). Never a skip,
				// and never recorded for a LIVE ctx that merely lacks a session
				// id — `probeCtxActive` returning `false` is the proof.
				const ctxActive = probeCtxActive(ctx);
				const staleCtx = ctxActive === false;
				if (ctxActive === true) {
					noteLiveMessageEndSessionId(sessionId);
				}
				logCacheUsage((event as { message?: unknown })?.message, dbg, {
					sessionId,
					sessionRole: classifyOwnedSessionEmission(ctx, sessionId),
					turnIndex: runtime.turnIndex,
				});
				if (staleCtx) {
					const degradation = {
						kind: "cache-usage-attribution-stale",
						subject: "message_end",
						reason:
							"message_end met a stale extension ctx; cache_usage row wrote without a stable session id",
						metadata: {
							sessionId: getLastLiveMessageEndSessionId() ?? "unknown",
						},
					};
					// Keep the stale-only guard narrow: live and inconclusive probes
					// must not be classified as attribution loss.
					// The cache_usage row is priority; this is best-effort.
					incrementDegradationCount(degradation);
				}
			} catch (err) {
				dbg(`message_end handler error: ${err}`);
			}
		});
	} catch (err) {
		dbg(`message_end subscribe failed (older pi host?): ${err}`);
	}

	// --- Inject turn-end findings into next agent turn ---
	// jscpd, madge, and turn-end delta results are cached at turn_end and consumed here
	// via the context event, which fires before each provider request.
	// Placement (#1016): splice the ephemeral pi-lens findings in IMMEDIATELY BEFORE
	// the final message rather than prepending at index 0. Prepending flipped
	// messages[0] every turn, which invalidated the entire prompt-cache prefix on
	// EVERY prefix-caching provider (Anthropic, Bedrock, AND OpenAI — all key the
	// cache on the exact token prefix). Inserting before the last message keeps
	// messages[0] (the real first user turn) byte-stable so the prior conversation
	// stays cached, AND keeps the real user prompt as the trailing message —
	// preserving the trailing-`user` cache breakpoint and the historical fe0ed5da
	// guarantee that input is never empty (existingMessages are always preserved,
	// never dropped).
	//
	// The `context` event fires before EVERY provider/LLM call, not just at turn
	// boundaries (clients/agent-nudge.ts), so mid-agentic-loop the trailing message
	// is often a `tool_result` — which MUST stay immediately adjacent to the
	// assistant message carrying its matching `tool_use`/`tool_calls`, across all of
	// Anthropic, Bedrock, and OpenAI (a 400 otherwise). The trailing-role guard
	// (isPlainUserPrompt) therefore only splices before the last message when it is a
	// plain user prompt; otherwise it APPENDS after the whole transcript, which both
	// preserves that adjacency and is still fully cache-friendly (the entire prior
	// transcript stays an untouched prefix).
	const isPlainUserPrompt = (msg: {
		role: string;
		content: unknown;
	}): boolean => {
		if (msg.role !== "user") return false;
		// String content is a plain prompt; only an array of content blocks can
		// carry a tool_result, which must not be preceded by an injected message.
		if (!Array.isArray(msg.content)) return true;
		return !msg.content.some(
			(block) =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "tool_result",
		);
	};
	// biome-ignore lint/suspicious/noExplicitAny: pi.on("context") overload has TS resolution bug
	(pi as any).on(
		"context",
		// #1929: `context` is reachable with a ctx the SDK already invalidated,
		// exactly like the five handlers #1925 wrapped. It could not use the void
		// wrapper because the host CONSUMES its return value on the live path, so
		// it uses the value-returning variant and states its own stale-path answer
		// below. Before this, a stale ctx surfaced as `context event error: …`,
		// indistinguishable from a real handler bug, and counted nothing.
		wrapSessionEventHandlerWithResult(
			"context",
			async (
				event:
					| { messages?: Array<{ role: string; content: unknown }> }
					| unknown,
				ctx: { cwd?: string },
			) => {
				// #1018: context telemetry deliberately runs even when the lens or its
				// injection toggle is off, so an A/B run has a no-injection observation.
				const existingMessages =
					(event as { messages?: Array<{ role: string; content: unknown }> })
						?.messages ?? [];
				const prefixSessionId = getStableSessionId(ctx);
				const sessionRole = classifyOwnedSessionEmission(ctx, prefixSessionId);
				// #1938: `observeCachePrefix` still owns the unbounded, always-accurate
				// `cache_prefix_break` signal below. Its return value used to be threaded
				// into `observeCacheContext` as `prefixObservation`, but that field was
				// removed there (see the cache-observability.ts module doc) — the call
				// stays for its `cache_prefix_break` side effect only.
				observeCachePrefix(
					existingMessages,
					runtime.turnIndex,
					prefixSessionId,
					sessionRole,
					dbg,
				);
				const effectiveInjectionEnabled =
					lensEnabled && contextInjectionEnabled;
				let telemetryLogged = false;
				const logContextObservation = (
					resultMessages: Array<{ role: string; content: unknown }>,
					placement: "prepend" | "insert-before-final" | "append" | "none",
					// #1071: the per-source slices ARE the telemetry input. The source
					// name list and the flat message list are both derived from them
					// inside observeCacheContext, so this call site cannot report a
					// source that contributed nothing.
					injectionSlices: ReadonlyArray<CacheContextInjectionSlice>,
				) => {
					if (telemetryLogged) return;
					telemetryLogged = true;
					observeCacheContext({
						existingMessages,
						resultMessages,
						sessionId: prefixSessionId,
						sessionRole,
						turnIndex: runtime.turnIndex,
						injectionEnabled: effectiveInjectionEnabled,
						injectionSlices,
						placement,
						dbg,
					});
				};
				try {
					const cwd = ctx.cwd ?? process.cwd();

					if (!effectiveInjectionEnabled) {
						logContextObservation(existingMessages, "none", []);
						return;
					}

					const turnEndFindings = consumeTurnEndFindings(
						cacheManager,
						cwd,
						runtime,
					);
					const sessionGuidance = consumeSessionStartGuidance(
						cacheManager,
						cwd,
					);
					const agentNudge = consumeAgentNudge(dbg);
					const sourceMessages = [
						{
							source: "session-guidance" as const,
							messages: sessionGuidance?.messages ?? [],
						},
						{
							source: "turn-findings" as const,
							messages: turnEndFindings?.messages ?? [],
						},
						{
							source: "agent-nudge" as const,
							messages: agentNudge?.messages ?? [],
						},
					].filter((source) => source.messages.length > 0);
					const injectedMessages = sourceMessages.flatMap(
						(source) => source.messages,
					);
					if (injectedMessages.length === 0) {
						logContextObservation(existingMessages, "none", []);
						return;
					}

					// Empty transcript (no turns yet): fall back to prepend semantics —
					// there is no trailing user message to sit before, and we must never
					// emit empty input (fe0ed5da: OpenAI Responses fails on empty input).
					if (existingMessages.length === 0) {
						const resultMessages = [...injectedMessages];
						logContextObservation(resultMessages, "prepend", sourceMessages);
						return { messages: resultMessages };
					}

					const lastMessage = existingMessages[existingMessages.length - 1];

					// Mid-loop the tail can be a tool_result (or assistant/tool) message;
					// inserting before it would break tool_use↔tool_result adjacency. Only
					// splice before the last message when it is a plain user prompt.
					if (!isPlainUserPrompt(lastMessage)) {
						// Append after the whole transcript — pure append preserves the
						// adjacency AND leaves the entire prior transcript as an untouched
						// cache prefix.
						const resultMessages = [...existingMessages, ...injectedMessages];
						logContextObservation(resultMessages, "append", sourceMessages);
						return { messages: resultMessages };
					}

					// Insert the injected block just before the final message so
					// messages[0] stays stable and the real user prompt stays trailing.
					const resultMessages = [
						...existingMessages.slice(0, -1),
						...injectedMessages,
						lastMessage,
					];
					logContextObservation(
						resultMessages,
						"insert-before-final",
						sourceMessages,
					);
					return { messages: resultMessages };
				} catch (err) {
					// The stale-ctx class has ONE classifier and one record, in
					// clients/session-event-guard.ts. Rethrow BEFORE the fallback
					// observation (#1929): a session that no longer exists must not
					// leave a "no injection" cache-context row behind, and the
					// wrapper's own record is the accurate one.
					if (isStaleExtensionCtxError(err)) throw err;
					if (!telemetryLogged)
						logContextObservation(existingMessages, "none", []);
					dbg(`context event error: ${err}`);
				}
			},
			{
				dbg,
				// #1929: a dead ctx means pi-lens contributes NOTHING to this
				// request. `undefined` is that answer, and is what the four
				// non-injecting paths above already return, so the host keeps its
				// own message list byte-for-byte. Never a half-built injection: the
				// consume* calls that feed one have side effects and may not have run.
				onStaleResult: () => undefined,
			},
		),
	);
}

export default function (pi: ExtensionAPI) {
	return runInConsoleCaptureWindow(() => activateExtension(pi));
}

// #1434: the import graph has finished evaluating, so the module window closes
// here. Everything after this point is host-owned execution, until one of
// pi-lens's own entry points opens its own window. This must stay the last
// statement in index.ts.
closeModuleLoadConsoleWindow();
