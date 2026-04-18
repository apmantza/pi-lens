import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { CacheManager } from "./clients/cache-manager.js";
import { loadBootstrapClients } from "./clients/bootstrap.js";
import { getDiagnosticTracker } from "./clients/diagnostic-tracker.js";
import {
	getDispatchSlopScoreLine,
	getLatencyReports,
	resetDispatchBaselines,
} from "./clients/dispatch/integration.js";
import { resetFormatService } from "./clients/format-service.js";
import { evaluateGitGuard, isGitCommitOrPushAttempt } from "./clients/git-guard.js";
import { ensureTool } from "./clients/installer/index.js";
import { initLSPConfig } from "./clients/lsp/config.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import { captureSnapshot } from "./clients/metrics-history.js";
import { findSimilarFunctions } from "./clients/project-index.js";
import { RuntimeCoordinator } from "./clients/runtime-coordinator.js";
import {
	consumeSessionStartGuidance,
	consumeTurnEndFindings,
} from "./clients/runtime-context.js";
import { handleSessionStart } from "./clients/runtime-session.js";
import { handleToolResult } from "./clients/runtime-tool-result.js";
import { handleTurnEnd } from "./clients/runtime-turn.js";
import { formatRulesForPrompt } from "./clients/rules-scanner.js";
import { handleBooboo } from "./commands/booboo.js";
import { createAstGrepReplaceTool } from "./tools/ast-grep-replace.js";
import { createAstGrepSearchTool } from "./tools/ast-grep-search.js";
import { createLspNavigationTool } from "./tools/lsp-navigation.js";

const _getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

const DEBUG_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const DEBUG_LOG = path.join(DEBUG_LOG_DIR, "sessionstart.log");
function dbg(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		nodeFs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
		nodeFs.appendFileSync(DEBUG_LOG, line);
	} catch (e) {
		// Pipeline error logged
		console.error("[pi-lens-debug] write failed:", e);
	}
}

// --- State ---

let _verbose = false;
const runtime = new RuntimeCoordinator();
const _lspConfigInitializedCwds = new Set<string>();
const LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS = Math.max(
	0,
	Number.parseInt(process.env.PI_LENS_TOOLCALL_NAV_TOUCH_MS ?? "700", 10) ||
		700,
);

function log(msg: string) {
	if (_verbose) console.error(`[pi-lens] ${msg}`);
}

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
 * Only called when --lens-lsp is active (that’s when tsserver runs).
 */
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
				// Malformed or unreadable — skip
			}
		}
	} catch {
		// readdirSync failed — skip
	}
	return cleaned;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	const astGrepClient = new AstGrepClient();
	const cacheManager = new CacheManager();


	// --- Flags ---

	pi.registerFlag("lens-verbose", {
		description: "Enable verbose pi-lens logging",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-biome", {
		description: "Disable Biome linting/formatting",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-oxlint", {
		description: "Disable Oxlint fast JS/TS linter",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-ast-grep", {
		description: "Disable ast-grep structural analysis",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-ruff", {
		description: "Disable Ruff Python linting",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-shellcheck", {
		description: "Disable shellcheck for shell scripts",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-lsp", {
		description:
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example ts-lsp, pyright)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-madge", {
		description: "Disable circular dependency checking via madge",
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
		description:
			"Disable auto-fixing of lint issues (Biome, Ruff). Use --no-autofix-biome or --no-autofix-ruff for individual control.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autofix-biome", {
		description:
			"Disable Biome auto-fix on write (Biome autofix is enabled by default)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-autofix-ruff", {
		description:
			"Disable Ruff auto-fix on write (Ruff autofix is enabled by default)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-tests", {
		description: "Disable test runner on write",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("error-debt", {
		description:
			"Track test failures and block if tests start failing (error debt tracker)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-go", {
		description: "Disable Go linting (go vet)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("no-rust", {
		description: "Disable Rust linting (cargo check)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-lsp", {
		description:
			"Enable LSP (Language Server Protocol) for semantic analysis (Phase 3)",
		type: "boolean",
		default: true,
	});

	pi.registerFlag("auto-install", {
		description:
			"Auto-install missing LSP servers without prompting (for Go, Rust, YAML, JSON, Bash)",
		type: "boolean",
		default: false,
	});

	// Internal flag for running only blocking rules on file write (performance)
	pi.registerFlag("lens-blocking-only", {
		description:
			"[Internal] Only run BLOCKING rules (severity: error) for fast feedback",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-eslint-core", {
		description:
			"Use bundled ESLint core rules when project has no ESLint config (JS-only fallback)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-guard", {
		description:
			"Experimental: block git commit/push when unresolved pi-lens blockers exist",
		type: "boolean",
		default: false,
	});

	// --- Commands ---

	pi.registerCommand("lens-booboo", {
		description:
			"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
		handler: async (args, ctx) => {
			const { complexityClient, todoScanner, knipClient, jscpdClient, typeCoverageClient, depChecker, architectClient } = await loadBootstrapClients();
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
					architect: architectClient,
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
						? "⚠️ Moderate debt — consider refactoring"
						: "🔴 High debt — run /lens-booboo-refactor",
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("lens-health", {
		description:
			"Show pi-lens runtime health: pipeline crashes, slow runners, and last dispatch latency. Usage: /lens-health",
		handler: async (_args, ctx) => {
			const crashEntries = runtime.getCrashEntries().sort(
				(a, b) => b[1] - a[1],
			);
			const totalCrashes = crashEntries.reduce((sum, [, count]) => sum + count, 0);

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
							? path.relative(runtime.projectRoot, v.samplePaths[0]).replace(/\\/g, "/")
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

	// --- Tools (extracted to tools/) ---
	pi.registerTool(createAstGrepSearchTool(astGrepClient) as any);
	pi.registerTool(createAstGrepReplaceTool(astGrepClient) as any);
	pi.registerTool(createLspNavigationTool((name) => pi.getFlag(name)) as any);

	// REMOVED: ~450 lines of inline tool definitions moved to tools/
	// See tools/ast-grep-search.ts, tools/ast-grep-replace.ts, tools/lsp-navigation.ts

// Runtime state is managed by RuntimeCoordinator.

// Delta baselines: store pre-write diagnostics to diff against post-write
const _astGrepBaselines = new Map<
	string,
	import("./clients/ast-grep-types.js").AstGrepDiagnostic[]
>();
const _biomeBaselines = new Map<
	string,
	import("./clients/biome-client.js").BiomeDiagnostic[]
>();

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
		_verbose = !!pi.getFlag("lens-verbose");
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
			architectClient,
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
			architectClient,
			testRunnerClient,
			goClient,
			rustClient,
			ensureTool: async (name: string) =>
				(await import("./clients/installer/index.js")).ensureTool(name),
			cleanStaleTsBuildInfo,
			resetDispatchBaselines,
			resetLSPService,
		});
	} catch (sessionErr) {
		dbg(`session_start crashed: ${sessionErr}`);
		dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
	}
});

pi.on("tool_call", async (event, ctx) => {
	const toolName = (event as { toolName?: string }).toolName ?? "";
	if (pi.getFlag("lens-guard") && isGitCommitOrPushAttempt(toolName, event.input)) {
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

	if (pi.getFlag("lens-lsp") && !pi.getFlag("no-lsp")) {
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
		!!pi.getFlag("lens-lsp") &&
		!pi.getFlag("no-lsp");
	if (shouldAutoTouch) {
		try {
			const fileContent = nodeFs.readFileSync(filePath, "utf-8");
			const maxClientWaitMs =
				toolName === "lsp_navigation" ? LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS : undefined;
			void getLSPService()
				.touchFile(
					filePath,
					fileContent,
					false,
					`tool_call:${toolName}`,
					false,
					maxClientWaitMs,
				)
				.catch((err) => dbg(`lsp auto-touch failed for ${filePath}: ${err}`));
		} catch {
			// Best effort only; never block tool calls.
		}
	}

	const { complexityClient } = await loadBootstrapClients();
	// Record complexity baseline for historical tracking (booboo/tdi).
	// Not shown inline — just captured for delta analysis.
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

	// --- Pre-write duplicate detection ---
	// Check if new content redefines functions that already exist elsewhere.
	// Uses cachedExports (populated at session_start via ast-grep scan).
	const isWriteOrEdit =
		isToolCallEventType("write", event) || isToolCallEventType("edit", event);
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
					reason: `🔴 STOP — Redefining existing export(s). Import instead:\n${dupeWarnings.map((w) => `  • ${w}`).join("\n")}`,
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
					const { extractFunctions } = await import("./clients/dispatch/runners/similarity.js");
					const { findSimilarFunctions } = await import("./clients/project-index.js");
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
							const targetPath = targetPathMatch?.[1] ?? String(match.targetLocation);
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
						reason += "\nUse this only as a hint; verify behavior before refactoring.";
						if (reason.length > INLINE_SIMILARITY_MAX_CHARS) {
							reason = `${reason.slice(0, INLINE_SIMILARITY_MAX_CHARS)}\n... (truncated)`;
						}
						return {
							block: false,
							reason,
						};
					}
				} catch {
					// Parsing failed — skip similarity check silently
				}
			}
		}
	}
});

// Real-time feedback on file writes/edits
// biome-ignore lint/suspicious/noExplicitAny: pi.on overload mismatch for tool_result event type
(pi as any).on("tool_result", async (event: any) => {
	updateRuntimeIdentityFromEvent(event);
	const {
		biomeClient,
		ruffClient,
		testRunnerClient,
		metricsClient,
		agentBehaviorClient,
	} = await loadBootstrapClients();
	return handleToolResult({
		event: event as any,
		getFlag: (name: string) => pi.getFlag(name),
		dbg,
		runtime,
		cacheManager,
		biomeClient,
		ruffClient,
		testRunnerClient,
		metricsClient,
		resetLSPService,
		agentBehaviorRecord: (toolName, filePath) =>
			agentBehaviorClient.recordToolCall(toolName, filePath),
		formatBehaviorWarnings: (warnings) =>
			agentBehaviorClient.formatWarnings(warnings as any),
	});
});
// --- Inject project rules into system prompt ---
pi.on("before_agent_start", async (event) => {
	updateRuntimeIdentityFromEvent(event);
	if (!runtime.projectRulesScan.hasCustomRules) return;

	const rulesSection = formatRulesForPrompt(runtime.projectRulesScan);
	return {
		systemPrompt: `${event.systemPrompt}\n\n## Project Rules\nRead these files only when relevant:\n${rulesSection}\n`,
	};
});

// --- Turn end: batch jscpd/madge on collected files, then clear state ---
// Clear cascade snapshot at start of each new turn so stale data never leaks
pi.on("turn_start", () => {
	runtime.beginTurn();
});

pi.on("turn_end", async (_event, ctx) => {
	try {
		const { jscpdClient, knipClient, depChecker } = await loadBootstrapClients();
		await handleTurnEnd({
			ctxCwd: ctx.cwd,
			getFlag: (name: string) => pi.getFlag(name),
			dbg,
			runtime,
			cacheManager,
			jscpdClient,
			knipClient,
			depChecker,
			resetLSPService,
			resetFormatService,
		});
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
			const injectedMessages = [
				...(sessionGuidance?.messages ?? []),
				...(turnEndFindings?.messages ?? []),
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
