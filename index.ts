import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { loadBootstrapClients } from "./clients/bootstrap.js";
import { CacheManager } from "./clients/cache-manager.js";
import { getDiagnosticTracker } from "./clients/diagnostic-tracker.js";
import {
	getDispatchSlopScoreLine,
	getLatencyReports,
	resetDispatchBaselines,
} from "./clients/dispatch/integration.js";
import { resetFormatService } from "./clients/format-service.js";
import {
	evaluateGitGuard,
	isGitCommitOrPushAttempt,
} from "./clients/git-guard.js";
import { getAllToolStatuses } from "./clients/installer/index.js";
import { logLatency } from "./clients/latency-logger.js";
import type { LSPSymbol } from "./clients/lsp/client.js";
import { initLSPConfig } from "./clients/lsp/config.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import {
	consumeSessionStartGuidance,
	consumeTestFindings,
	consumeTurnEndFindings,
} from "./clients/runtime-context.js";
import { RuntimeCoordinator } from "./clients/runtime-coordinator.js";
import { handleSessionStart } from "./clients/runtime-session.js";
import { handleToolResult } from "./clients/runtime-tool-result.js";
import { handleTurnEnd } from "./clients/runtime-turn.js";
import { handleBooboo } from "./commands/booboo.js";
import { createAstGrepReplaceTool } from "./tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "./tools/ast-grep-search.js";
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
const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_TOOLCALL_NAV_TOUCH_MS ??
			process.env.PI_LENS_LSP_NAV_CLIENT_WAIT_MS ??
			"1500",
		10,
	) || 1500,
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

/**
 * Find and delete stale tsconfig.tsbuildinfo files in the project.
 *
 * A tsbuildinfo is stale when its `root` array references files that no
 * longer exist on disk. The TypeScript Language Server reads this cache
 * on startup and will report phantom "Cannot find module" errors for
 * every deleted file until the cache is cleared.
 *
 * Only called when LSP is active (that's when tsserver runs).
 */
function findSymbolAtLine(
	symbols: LSPSymbol[],
	line1: number,
):
	| {
			name: string;
			kind: number;
			range: { start: { line: number }; end: { line: number } };
	  }
	| undefined {
	const targetLine = line1 - 1;
	function search(items: LSPSymbol[]): LSPSymbol | undefined {
		for (const s of items) {
			const start = s.range?.start?.line ?? 0;
			const end = s.range?.end?.line ?? start;
			if (targetLine >= start && targetLine <= end) {
				if (s.children && s.children.length > 0) {
					const child = search(s.children);
					if (child) return child;
				}
				return s;
			}
		}
		return undefined;
	}
	const match = search(symbols);
	if (!match?.range) return undefined;
	return {
		name: match.name ?? "(unknown)",
		kind: match.kind ?? 0,
		range: match.range,
	};
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

	pi.registerFlag("no-lsp", {
		description:
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example ts-lsp, pyright)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autoformat", {
		description:
			"Disable automatic formatting on file write (formatters run by default)",
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

	pi.registerFlag("no-read-guard", {
		description: "Disable read-before-edit behavior monitor",
		type: "boolean",
		default: false,
	});

	// --- Commands ---

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
				tdi.score <= 30
					? "✅ Codebase is healthy!"
					: tdi.score <= 60
						? "⚠️ Moderate debt - consider refactoring"
						: "🔴 High debt - run /lens-booboo-refactor",
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

			const lines: string[] = [
				"🩺 PI-LENS HEALTH",
				"",
				`Pipeline crashes (session): ${totalCrashes}`,
				`Files affected: ${crashEntries.length}`,
			];
			const slopScoreLine = getDispatchSlopScoreLine();

			if (crashEntries.length > 0) {
				lines.push("", "Top crash files:");
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
				lines.push("", "No dispatch latency reports yet.");
			}

			lines.push(
				"",
				`Diagnostics shown: ${diagStats.totalShown}`,
				`Auto-fixed: ${diagStats.totalAutoFixed}`,
				`Agent-fixed: ${diagStats.totalAgentFixed}`,
				`Unresolved carryover: ${diagStats.totalUnresolved}`,
			);

			if (diagStats.repeatOffenders.length > 0) {
				lines.push("Repeat offenders:");
				for (const offender of diagStats.repeatOffenders.slice(0, 5)) {
					lines.push(
						`  ${path.basename(offender.filePath)}:${offender.line} ${offender.ruleId} (${offender.count}x)`,
					);
				}
			}

			if (diagStats.topViolations.length > 0) {
				lines.push("Top noisy rules:");
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

	// --- Tools (extracted to tools/) ---
	pi.registerTool(createAstGrepSearchTool(astGrepClient) as any);
	pi.registerTool(createAstGrepReplaceTool(astGrepClient) as any);
	pi.registerTool(createLspNavigationTool((name) => pi.getFlag(name)) as any);

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
				getFlag: (name: string) => pi.getFlag(name),
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
		} catch (sessionErr) {
			dbg(`session_start crashed: ${sessionErr}`);
			dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = (event as { toolName?: string }).toolName ?? "";
		if (
			pi.getFlag("lens-guard") &&
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

		const inputObj = (event.input ?? {}) as Record<string, unknown>;
		const rawFilePath =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event)
				? (event.input as { path: string }).path
				: toolName === "read" || toolName === "lsp_navigation"
					? typeof inputObj.filePath === "string"
						? inputObj.filePath
						: undefined
					: undefined;
		const filePath = rawFilePath
			? path.isAbsolute(rawFilePath)
				? rawFilePath
				: path.resolve(ctx.cwd ?? runtime.projectRoot, rawFilePath)
			: undefined;

		if (!pi.getFlag("no-lsp")) {
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

		const shouldAutoTouch =
			(toolName === "read" ||
				toolName === "write" ||
				toolName === "edit" ||
				toolName === "lsp_navigation") &&
			!pi.getFlag("no-lsp");
		if (shouldAutoTouch) {
			try {
				const fileContent = nodeFs.readFileSync(filePath, "utf-8");
				const maxClientWaitMs =
					toolName === "lsp_navigation"
						? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS
						: undefined;
				void getLSPService()
					.touchFile(
						filePath,
						fileContent,
						false,
						`tool_call:${toolName}`,
						false,
						maxClientWaitMs,
					)
					.then(() => {
						if (ctx.ui) {
							ctx.ui && updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
						}
					})
					.catch((err) => dbg(`lsp auto-touch failed for ${filePath}: ${err}`));
			} catch {
				// Best effort only; never block tool calls.
			}
		}

		// --- Read-Before-Edit Guard: record reads ---
		if (toolName === "read" && filePath) {
			const readInput = event.input as {
				filePath?: string;
				offset?: number;
				limit?: number;
			};
			const rawOffset = readInput.offset ?? 1;
			const rawLimit = readInput.limit ?? 1;

			// Record read immediately (before LSP expansion);
			// LSP expansion data is captured below
			runtime.readGuard.recordRead({
				filePath,
				requestedOffset: rawOffset,
				requestedLimit: rawLimit,
				effectiveOffset: rawOffset,
				effectiveLimit: rawLimit,
				expandedByLsp: false,
				turnIndex: runtime.turnIndex,
				writeIndex: runtime.nextWriteIndex(),
				timestamp: Date.now(),
			});
		}

		// --- Opportunistic LSP range expansion for single-line reads ---
		if (toolName === "read" && !pi.getFlag("no-lsp") && filePath) {
			const readInput = event.input as {
				filePath?: string;
				offset?: number;
				limit?: number;
			};
			const isSingleLine =
				readInput.offset != null &&
				(readInput.limit == null || readInput.limit <= 1);
			if (isSingleLine) {
				const lsp = getLSPService();
				const startedAt = Date.now();
				lsp
					.getWarmClientForFile(filePath)
					.then((spawned) => {
						if (!spawned?.client.isAlive()) return;
						return spawned.client.documentSymbol(filePath).then((symbols) => {
							const match = findSymbolAtLine(symbols, readInput.offset!);
							if (match) {
								const newOffset = match.range.start.line + 1;
								const endLine = match.range.end.line + 1;
								readInput.offset = newOffset;
								readInput.limit = endLine - newOffset + 1;

								// Update read guard with expanded range
								const reads = runtime.readGuard.getReadHistory(filePath);
								const lastRead = reads[reads.length - 1];
								if (lastRead) {
									lastRead.effectiveOffset = newOffset;
									lastRead.effectiveLimit = endLine - newOffset + 1;
									lastRead.expandedByLsp = true;
									lastRead.enclosingSymbol = {
										name: match.name,
										kind: String(match.kind),
										startLine: match.range.start.line + 1,
										endLine: match.range.end.line + 1,
									};
								}

								logLatency({
									type: "phase",
									phase: "lsp_read_range_expansion",
									filePath,
									durationMs: Date.now() - startedAt,
									metadata: {
										symbol: match.name,
										kind: match.kind,
										fromLine: readInput.offset,
										toRange: `${newOffset}-${endLine}`,
										serverId: spawned.info.id,
									},
								});
								dbg(
									`lsp expanded read range: ${path.basename(filePath)} line ${readInput.offset} → ${match.name} (${newOffset}-${endLine})`,
								);
							}
						});
					})
					.catch(() => {
						/* silent fallback */
					});
			}
		}

		const { complexityClient } = await loadBootstrapClients();
		// Record complexity baseline for historical tracking (booboo/tdi).
		// Not shown inline - just captured for delta analysis.
		if (
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
		const isWriteOrEdit =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event);
		if (isWriteOrEdit && filePath && !pi.getFlag("no-read-guard")) {
			const isNewFile = runtime.readGuard.isNewFile(filePath);
			if (!isNewFile) {
				// Compute touched lines for the edit
				let touchedLines: [number, number] | undefined;
				if (isToolCallEventType("edit", event)) {
					const editInput = event.input as {
						oldRange?: { start: { line: number }; end: { line: number } };
						edits?: Array<{
							range?: { start: { line: number }; end: { line: number } };
						}>;
					};
					if (editInput.oldRange) {
						touchedLines = [
							editInput.oldRange.start.line,
							editInput.oldRange.end.line,
						];
					} else if (editInput.edits?.length) {
						// Find min/max line from all edits
						const lines = editInput.edits.flatMap((e) => [
							e.range?.start?.line ?? 1,
							e.range?.end?.line ?? 1,
						]);
						touchedLines = [Math.min(...lines), Math.max(...lines)];
					}
				} else if (isToolCallEventType("write", event)) {
					// For write, we consider the whole file
					// This will be checked against any previous read of the file
					// If the file was never read, it will be blocked by zero-read check
					touchedLines = [1, Number.MAX_SAFE_INTEGER];
				}

				const verdict = runtime.readGuard.checkEdit(filePath, touchedLines);
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
			const newContent = isToolCallEventType("write", event)
				? (event.input as { content?: string }).content
				: (event.input as { edits?: Array<{ newText?: string }> }).edits
						?.map((e) => e.newText ?? "")
						.join("\n");
			if (newContent) {
				const INLINE_SIMILARITY_THRESHOLD = 0.9;
				const INLINE_SIMILARITY_MAX_HINTS = 3;
				const INLINE_SIMILARITY_MAX_CHARS = 700;
				const dupeWarnings: string[] = [];
				const exportRe =
					/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
				let m: RegExpExecArray | null;
				while ((m = exportRe.exec(newContent))) {
					const name = m[1];
					const existingFile = runtime.cachedExports.get(name);
					if (
						existingFile &&
						path.resolve(existingFile) !== path.resolve(filePath)
					) {
						dupeWarnings.push(
							`\`${name}\` already exists in ${path.relative(runtime.projectRoot, existingFile)}`,
						);
					}
				}
				if (dupeWarnings.length > 0) {
					return {
						block: true,
						reason: `🔴 STOP - Redefining existing export(s). Import instead:\n${dupeWarnings.map((w) => `  • ${w}`).join("\n")}`,
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
		updateRuntimeIdentityFromEvent(event);
		const { biomeClient, ruffClient, metricsClient, agentBehaviorClient } =
			await loadBootstrapClients();
		return handleToolResult({
			event: event as any,
			getFlag: (name: string) => pi.getFlag(name),
			dbg,
			runtime,
			cacheManager,
			biomeClient,
			ruffClient,
			metricsClient,
			resetLSPService,
			agentBehaviorRecord: (toolName, filePath) =>
				agentBehaviorClient.recordToolCall(toolName, filePath),
			formatBehaviorWarnings: (warnings) =>
				agentBehaviorClient.formatWarnings(warnings as any),
		});
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	// Clear cascade snapshot at start of each new turn so stale data never leaks
	pi.on("turn_start", () => {
		runtime.beginTurn();
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const { jscpdClient, knipClient, depChecker, testRunnerClient } =
				await loadBootstrapClients();
			await handleTurnEnd({
				ctxCwd: ctx.cwd,
				getFlag: (name: string) => pi.getFlag(name),
				dbg,
				runtime,
				cacheManager,
				jscpdClient,
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

	// --- Inject turn-end findings into next agent turn ---
	// jscpd, madge, and turn-end delta results are cached at turn_end and consumed here
	// via the context event, which fires before each provider request.
	// Important: context handlers must APPEND to the existing message list, not replace it.
	// Replacing `event.messages` can drop the user's first prompt entirely, which causes
	// OpenAI Responses requests to fail with: "One of input/previous_response_id/prompt/conversation_id must be provided."
	// biome-ignore lint/suspicious/noExplicitAny: pi.on("context") overload has TS resolution bug
	(pi as any).on(
		"context",
		async (
			event: { messages?: Array<{ role: string; content: unknown }> } | unknown,
			ctx: { cwd?: string },
		) => {
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
					messages: [...existingMessages, ...injectedMessages],
				};
			} catch (err) {
				dbg(`context event error: ${err}`);
			}
		},
	);
}
