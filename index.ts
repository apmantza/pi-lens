import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { loadBootstrapClients } from "./clients/bootstrap.js";
import { CacheManager } from "./clients/cache-manager.js";
import {
	clearWidgetState,
	renderWidget,
	setRenderCallback,
} from "./clients/widget-state.js";
import { getDiagnosticTracker } from "./clients/diagnostic-tracker.js";
import {
	getCascadeSessionStats,
	getDispatchSlopScoreLine,
	getLatencyReports,
	resetDispatchBaselines,
} from "./clients/dispatch/integration.js";
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
	tryCorrectIndentationMismatch,
	tryCorrectIndentationMismatchFromContent,
} from "./clients/read-guard-tool-lines.js";
import { computeTrailingWhitespaceOldTextPatch } from "./clients/oldtext-autopatch.js";
import { applyPartiallyApplicableEdits } from "./clients/partial-edit-apply.js";
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
	handleToolResult,
} from "./clients/runtime-tool-result.js";
import { cancelLSPIdleReset, handleTurnEnd } from "./clients/runtime-turn.js";
import { isExternalOrVendorFile } from "./clients/path-utils.js";
import { safeSpawnAsync } from "./clients/safe-spawn.js";
import {
	createStarterSemgrepConfig,
	findLocalSemgrepConfig,
	loadPiLensSemgrepConfig,
	removePiLensSemgrepConfig,
	resolveSemgrepConfig,
	savePiLensSemgrepConfig,
} from "./clients/semgrep-config.js";
import { TreeSitterClient } from "./clients/tree-sitter-client.js";
import { handleBooboo } from "./commands/booboo.js";
import { initI18n, t } from "./i18n.js";
import { createAstGrepReplaceTool } from "./tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "./tools/ast-grep-search.js";
import { createLspDiagnosticsTool } from "./tools/lsp-diagnostics.js";
import { createLspNavigationTool } from "./tools/lsp-navigation.js";

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

function normalizeOldTextForMatch(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
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

	function updateLspStatus(
		setStatus: (id: string, text: string | undefined) => void,
		theme: {
			fg: (color: "accent" | "success" | "error", text: string) => string;
		},
	) {
		try {
			const count = getLSPService().getAliveClientCount();
			if (count > 0) {
				setStatus("pi-lens-lsp", theme.fg("success", `LSP Active (${count})`));
			} else {
				setStatus("pi-lens-lsp", theme.fg("error", "LSP Inactive"));
			}
		} catch {
			// Theme may not be fully initialized during early session startup.
			// Skip the status update rather than crashing the event handler.
		}
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

	pi.registerFlag("lens-semgrep", {
		description:
			"Enable Semgrep dispatch when a Semgrep config is available (or with --lens-semgrep-config)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-semgrep-config", {
		description:
			"Semgrep config for dispatch: local path, auto, p/<pack>, or r/<rule>. Requires --lens-semgrep.",
		type: "string",
		default: "",
	});

	pi.registerFlag("no-read-guard", {
		description: "Disable read-before-edit behavior monitor",
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
	let lensWidgetVisible = globalConfig?.widget?.visible !== false;
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

	pi.registerCommand("lens-semgrep", {
		description:
			"Manage Semgrep dispatch. Usage: /lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | init",
		handler: async (args, ctx) => {
			const parts = normalizeCommandArgs(args);
			const action = parts[0] ?? "status";
			const cwd = ctx.cwd ?? runtime.projectRoot;

			function readConfigArg(): string | undefined {
				const flagIndex = parts.findIndex(
					(part) => part === "--config" || part === "-c",
				);
				if (flagIndex >= 0) return parts[flagIndex + 1];
				return parts[1] && !parts[1].startsWith("-") ? parts[1] : undefined;
			}

			if (action === "enable") {
				const config = readConfigArg();
				const localConfig = findLocalSemgrepConfig(cwd);
				if (!config && !localConfig) {
					ctx.ui.notify(
						[
							"Semgrep dispatch not enabled yet: no local .semgrep.yml was found.",
							"Use `/lens-semgrep init` to create a starter local config, or `/lens-semgrep enable --config auto` / `p/<pack>` if you want Semgrep registry/platform configuration.",
							"pi-lens will not auto-install Semgrep; install it with pipx/uv/brew first and login only if your chosen Semgrep config requires it.",
						].join("\n"),
						"warning",
					);
					return;
				}

				const savedPath = savePiLensSemgrepConfig(cwd, {
					enabled: true,
					...(config ? { config } : {}),
				});
				ctx.ui.notify(
					`Semgrep dispatch enabled (${config ? `config: ${config}` : `local config: ${localConfig}`}). Saved ${savedPath}`,
					"info",
				);
				return;
			}

			if (action === "disable") {
				const savedPath = savePiLensSemgrepConfig(cwd, { enabled: false });
				ctx.ui.notify(`Semgrep dispatch disabled. Saved ${savedPath}`, "info");
				return;
			}

			if (action === "clear") {
				const removed = removePiLensSemgrepConfig(cwd);
				ctx.ui.notify(
					removed
						? "Removed .pi-lens/semgrep.json; Semgrep now auto-enables only when local .semgrep.yml exists."
						: "No .pi-lens/semgrep.json found.",
					"info",
				);
				return;
			}

			if (action === "init") {
				const configPath = createStarterSemgrepConfig(cwd);
				const savedPath = savePiLensSemgrepConfig(cwd, { enabled: true });
				ctx.ui.notify(
					`Created starter Semgrep config at ${configPath} and enabled Semgrep dispatch (${savedPath}).`,
					"info",
				);
				return;
			}

			if (action !== "status") {
				ctx.ui.notify(
					"Usage: /lens-semgrep status | enable [--config <auto|p/pack|path>] | disable | clear | init",
					"warning",
				);
				return;
			}

			const localConfig = findLocalSemgrepConfig(cwd);
			const piLensConfig = loadPiLensSemgrepConfig(cwd);
			const resolved = resolveSemgrepConfig(cwd, {
				enabled: Boolean(getLensFlag("lens-semgrep")),
				config: getLensFlag("lens-semgrep-config"),
			});
			const version = await safeSpawnAsync("semgrep", ["--version"], {
				cwd,
				timeout: 5000,
			});
			const lines = [
				"🔎 SEMGREP DISPATCH",
				`CLI: ${!version.error && version.status === 0 ? `installed (${(version.stdout || version.stderr).trim()})` : "not found on PATH"}`,
				`Local config: ${localConfig ?? "none"}`,
				`pi-lens config: ${piLensConfig ? JSON.stringify(piLensConfig) : "none"}`,
				`Effective: ${resolved.enabled ? "enabled" : "disabled"}`,
				`Config arg: ${resolved.configArg ?? "none"}`,
			];
			if (resolved.reason) lines.push(`Reason: ${resolved.reason}`);
			lines.push(
				"",
				"No auto-install. Token/login is only needed for Semgrep AppSec/Pro/managed configs; local .semgrep.yml scans do not require a token.",
			);
			ctx.ui.notify(lines.join("\n"), resolved.enabled ? "info" : "warning");
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
	pi.registerTool(createAstGrepSearchTool(astGrepClient) as any);
	pi.registerTool(createAstGrepReplaceTool(astGrepClient) as any);
	pi.registerTool(createLspDiagnosticsTool() as any);
	pi.registerTool(createLspNavigationTool((name) => getLensFlag(name)) as any);

	// REMOVED: ~450 lines of inline tool definitions moved to tools/
	// See tools/ast-grep-search.ts, tools/ast-grep-replace.ts, tools/lsp-navigation.ts

	// Runtime state is managed by RuntimeCoordinator.

	// Project rules scan result and per-turn state live in RuntimeCoordinator.

	// --- Register skills with pi ---
	pi.on("resources_discover", async (_event, _ctx) => {
		// Get the extension directory (where this file is located)
		const extensionDir = path.dirname(fileURLToPath(import.meta.url));
		const skillsDir = path.join(extensionDir, "skills");

		return {
			skillPaths: [skillsDir],
		};
	});

	// --- Events ---

	pi.on("session_start", async (event, ctx) => {
		try {
			dbg("session_start fired");
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
				typeCoverageClient,
				depChecker,
				testRunnerClient,
				goClient,
				rustClient,
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
			clearWidgetState();
			if (lensWidgetVisible) {
				mountLensWidget(ctx.ui);
			}
		} catch (sessionErr) {
			dbg(`session_start crashed: ${sessionErr}`);
			dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
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
					dbg(
						`ts expanded read: ${path.basename(filePath)} ` +
							`lines ${requestedReadOffset}–${requestedReadOffset + requestedReadLimit - 1} ` +
							`→ ${expansion.enclosingSymbol.name} ` +
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
			// tryCorrectIndentationMismatchFromContent (CRLF-only) and
			// countOldTextMatches (CRLF + trailing-whitespace trimmed).
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
				if (verdict.action === "block") {
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
				const INLINE_SIMILARITY_THRESHOLD = 0.9;
				const INLINE_SIMILARITY_MAX_HINTS = 3;
				const INLINE_SIMILARITY_MAX_CHARS = 700;
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

				// --- Structural similarity check (Phase 7b) ---
				// If the project index was built at session_start, check new
				// functions against it for structural clones (~50ms).
				if (
					runtime.cachedProjectIndex &&
					runtime.cachedProjectIndex.entries.size > 0 &&
					/\.(ts|tsx)$/.test(filePath)
				) {
					try {
						const ts = await import("typescript");
						const sourceFile = ts.createSourceFile(
							filePath,
							newContent,
							ts.ScriptTarget.Latest,
							true,
						);
						const { extractFunctions } = await import(
							"./clients/dispatch/runners/similarity.js"
						);
						const { findSimilarFunctions } = await import(
							"./clients/project-index.js"
						);
						const newFunctions = extractFunctions(ts, sourceFile, newContent);
						const simWarnings: string[] = [];
						let simHintsTruncated = false;
						const relPath = path.relative(runtime.projectRoot, filePath);

						for (const func of newFunctions) {
							if (simWarnings.length >= INLINE_SIMILARITY_MAX_HINTS) {
								simHintsTruncated = true;
								break;
							}
							if (func.transitionCount < 20) continue;
							const matches = findSimilarFunctions(
								func.matrix,
								runtime.cachedProjectIndex,
								INLINE_SIMILARITY_THRESHOLD,
								1,
							);
							for (const match of matches) {
								if (simWarnings.length >= INLINE_SIMILARITY_MAX_HINTS) {
									simHintsTruncated = true;
									break;
								}
								const targetPathMatch = String(match.targetLocation).match(
									/^(.*):\d+$/,
								);
								const targetPath =
									targetPathMatch?.[1] ?? String(match.targetLocation);
								const resolvedTarget = path.isAbsolute(targetPath)
									? targetPath
									: path.join(runtime.projectRoot, targetPath);
								if (!nodeFs.existsSync(resolvedTarget)) continue;

								// Skip self-matches
								if (match.targetId === `${relPath}:${func.name}`) continue;
								const pct = Math.round(match.similarity * 100);
								simWarnings.push(
									`\`${func.name}\` is ${pct}% similar to \`${match.targetName}\` at \`${String(match.targetLocation).replace(/\\/g, "/")}\``,
								);
							}
						}

						if (simWarnings.length > 0) {
							let reason = `⚠️ Potential structural similarity (advisory):\n${simWarnings.map((w) => `  • ${w}`).join("\n")}`;
							if (simHintsTruncated) {
								reason += "\n  • ... additional similar candidates omitted";
							}
							reason +=
								"\nUse this only as a hint; verify behavior before refactoring.";
							if (reason.length > INLINE_SIMILARITY_MAX_CHARS) {
								reason = `${reason.slice(0, INLINE_SIMILARITY_MAX_CHARS)}\n... (truncated)`;
							}
							return {
								block: false,
								reason,
							};
						}
					} catch {
						// Parsing failed - skip similarity check silently
					}
				}
			}
		}
	});

	// Real-time feedback on file writes/edits
	// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
	(pi as any).on("tool_result", async (event: any) => {
		if (!lensEnabled) return;
		updateRuntimeIdentityFromEvent(event);
		const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
			await loadBootstrapClients();
		return handleToolResult({
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
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	// Clear cascade snapshot at start of each new turn so stale data never leaks
	pi.on("turn_start", (_event: any) => {
		runtime.beginTurn();
		clearLastAnalyzedStateCache();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!lensEnabled) return;
		try {
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
		}
	});

	pi.on("turn_end", async (_event: any, ctx) => {
		if (!lensEnabled) return;
		try {
			const { knipClient, depChecker, testRunnerClient } =
				await loadBootstrapClients();
			await handleTurnEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => getLensFlag(name),
				dbg,
				runtime,
				cacheManager,
				knipClient,
				depChecker,
				testRunnerClient,
				resetLSPService,
				resetFormatService,
			});
			ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
		} catch (turnEndErr) {
			dbg(`turn_end crashed: ${turnEndErr}`);
			dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		}
	});

	// --- Session shutdown: release all handles so subagent processes exit cleanly ---
	// The LSP idle-reset timer (240s) is unref'd but we cancel it explicitly here
	// so it does not fire after shutdown. resetLSPService shuts down any live clients.
	(pi as any).on("session_shutdown", () => {
		cancelLSPIdleReset();
		resetLSPService({ fast: true });
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
			if (!lensEnabled) return;
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
