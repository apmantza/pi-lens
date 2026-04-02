import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// RELOADED: Testing format/lsp flow on large file
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AgentBehaviorClient } from "./clients/agent-behavior-client.js";
import { ArchitectClient } from "./clients/architect-client.js";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import {
	enableDebug as enableBusDebug,
	FileModified,
	initBusIntegration,
	SessionStarted,
	TurnEnded,
} from "./clients/bus/index.js";
import { CacheManager } from "./clients/cache-manager.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { dispatchLintWithBus } from "./clients/dispatch/bus-dispatcher.js";
import { dispatchLint } from "./clients/dispatch/integration.js";
import { createFileTime, FileTimeError } from "./clients/file-time.js";
import {
	getFormatService,
	resetFormatService,
} from "./clients/format-service.js";
import { GoClient } from "./clients/go-client.js";
import { ensureTool } from "./clients/installer/index.js";
import { buildInterviewer } from "./clients/interviewer.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
// RELOAD TEST 6: Cache verification run
import { logLatency } from "./clients/latency-logger.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { captureSnapshot } from "./clients/metrics-history.js";
import { RuffClient } from "./clients/ruff-client.js";
import {
	formatRulesForPrompt,
	type RuleScanResult,
	scanProjectRules,
} from "./clients/rules-scanner.js";
import { RustClient } from "./clients/rust-client.js";
import { getSourceFiles } from "./clients/scan-utils.js";
import { formatSecrets, scanForSecrets } from "./clients/secrets-scanner.js";
import { dispatchLintWithEffect } from "./clients/services/effect-integration.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";
import { handleBooboo } from "./commands/booboo.js";
import { initRefactorLoop } from "./commands/refactor.js";

/** Parse a diff to extract modified line ranges in the new file.
 * Handles pi's custom diff format:
 *   "   1 /**"          - unchanged line with line number
 *   "-  2 * old text"   - removed line
 *   "+  2 * new text"   - added line
 *   "     ..."          - skipped section
 */
function parseDiffRanges(diff: string): { start: number; end: number }[] {
	const changedLines: number[] = [];
	for (const line of diff.split("\n")) {
		// Match lines like "+  2 * new text" or "-  2 * old text"
		const match = line.match(/^[+-]\s+(\d+)\s/);
		if (match) {
			changedLines.push(Number.parseInt(match[1], 10));
		}
	}

	if (changedLines.length === 0) return [];

	// Convert to ranges (merge adjacent lines)
	const sorted = [...new Set(changedLines)].sort((a, b) => a - b);
	const ranges: { start: number; end: number }[] = [];
	let rangeStart = sorted[0];
	let rangeEnd = sorted[0];

	for (const line of sorted.slice(1)) {
		if (line <= rangeEnd + 1) {
			rangeEnd = line;
		} else {
			ranges.push({ start: rangeStart, end: rangeEnd });
			rangeStart = line;
			rangeEnd = line;
		}
	}
	ranges.push({ start: rangeStart, end: rangeEnd });

	return ranges;
}

const _getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

const DEBUG_LOG = path.join(os.homedir(), "pi-lens-debug.log");
function dbg(msg: string) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		nodeFs.appendFileSync(DEBUG_LOG, line);
	} catch (e) {
		console.error("[pi-lens-debug] write failed:", e);
	}
}

// --- State ---

let _verbose = false;
let projectRoot = process.cwd();

// Error debt tracking: baseline at turn start
let errorDebtBaseline: {
	testsPassed: boolean;
	buildPassed: boolean;
} | null = null;

function log(msg: string) {
	if (_verbose) console.error(`[pi-lens] ${msg}`);
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
	const tsClient = new TypeScriptClient();
	const astGrepClient = new AstGrepClient();
	const ruffClient = new RuffClient();
	const biomeClient = new BiomeClient();
	const knipClient = new KnipClient();
	const todoScanner = new TodoScanner();
	const jscpdClient = new JscpdClient();
	const typeCoverageClient = new TypeCoverageClient();
	const depChecker = new DependencyChecker();
	const testRunnerClient = new TestRunnerClient();
	const metricsClient = new MetricsClient();
	const complexityClient = new ComplexityClient();
	const architectClient = new ArchitectClient();
	const goClient = new GoClient();
	const rustClient = new RustClient();
	const agentBehaviorClient = new AgentBehaviorClient();
	const cacheManager = new CacheManager();

	// --- Initialize auto-loops ---
	initRefactorLoop(pi);

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
		description: "Disable TypeScript LSP",
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

	// Internal flag for development/debugging (not surfaced to users)
	pi.registerFlag("lens-bus", {
		description: "[Internal] Enable event bus system",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-bus-debug", {
		description: "Enable verbose bus event logging",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-effect", {
		description: "Enable Effect-TS concurrent runner execution (Phase 2)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("lens-lsp", {
		description:
			"Enable LSP (Language Server Protocol) for semantic analysis (Phase 3)",
		type: "boolean",
		default: false,
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

	// --- Commands ---

	pi.registerCommand("lens-booboo", {
		description:
			"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
		handler: (args, ctx) =>
			handleBooboo(
				args,
				ctx,
				{
					astGrep: astGrepClient,
					complexity: complexityClient,
					todo: todoScanner,
					knip: knipClient,
					jscpd: jscpdClient,
					typeCoverage: typeCoverageClient,
					depChecker: depChecker,
					architect: architectClient,
				},
				pi,
			),
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
				`  Maintainability: ${tdi.byCategory.maintainability}%`,
				`  Complexity: ${tdi.byCategory.complexity}%`,
				`  Nesting: ${tdi.byCategory.nesting}%`,
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

	pi.registerCommand("lens-format", {
		description:
			"Apply Biome formatting to files. Usage: /lens-format [file-path] or /lens-format --all",
		handler: async (args, ctx) => {
			if (!biomeClient.isAvailable()) {
				ctx.ui.notify(
					"Biome not installed. Run: npm install -D @biomejs/biome",
					"error",
				);
				return;
			}

			const arg = args.trim();

			if (!arg || arg === "--all") {
				ctx.ui.notify("🔍 Formatting all files...", "info");

				let formatted = 0;
				let skipped = 0;

				const targetPath = ctx.cwd || process.cwd();
				const isTsProject = nodeFs.existsSync(
					path.join(targetPath, "tsconfig.json"),
				);
				const files = getSourceFiles(targetPath, isTsProject);

				for (const fullPath of files) {
					if (/\.(ts|tsx|js|jsx|json|css)$/.test(fullPath)) {
						const result = biomeClient.formatFile(fullPath);
						if (result.changed) formatted++;
						else if (result.success) skipped++;
					}
				}
				ctx.ui.notify(
					`✓ Formatted ${formatted} file(s), ${skipped} already clean`,
					"info",
				);
				return;
			}

			const filePath = path.resolve(arg);
			const result = biomeClient.formatFile(filePath);

			if (result.success && result.changed) {
				ctx.ui.notify(`✓ Formatted ${path.basename(filePath)}`, "info");
			} else if (result.success) {
				ctx.ui.notify(`✓ ${path.basename(filePath)} already clean`, "info");
			} else {
				ctx.ui.notify(`⚠️ Format failed: ${result.error}`, "error");
			}
		},
	});

	// --- Tools ---

	const LANGUAGES = [
		"c",
		"cpp",
		"csharp",
		"css",
		"dart",
		"elixir",
		"go",
		"haskell",
		"html",
		"java",
		"javascript",
		"json",
		"kotlin",
		"lua",
		"php",
		"python",
		"ruby",
		"rust",
		"scala",
		"sql",
		"swift",
		"tsx",
		"typescript",
		"yaml",
	] as const;

	// --- Interviewer tool (browser-based interview with diff confirmation) ---
	buildInterviewer(pi, dbg);

	pi.registerTool({
		name: "ast_grep_search",
		label: "AST Search",
		description:
			"Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search. Examples:\n- Find function: 'function $NAME() { $$$BODY }'\n- Find call: 'fetchMetrics($ARGS)'\n- Find import: 'import { $NAMES } from \"$PATH\"'\n- Generic identifier (broad): 'fetchMetrics'\n\nAlways prefer specific patterns with context over bare identifiers. Use 'paths' to scope to specific files/folders. Use 'selector' to extract specific nodes (e.g., just the function name). Use 'context' to show surrounding lines.",
		promptSnippet: "Use ast_grep_search for AST-aware code search",
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern (use function/class/call context, not text)",
			}),
			lang: Type.Union(
				LANGUAGES.map((l) => Type.Literal(l)),
				{ description: "Target language" },
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Specific files/folders to search",
				}),
			),
			selector: Type.Optional(
				Type.String({
					description:
						"Extract specific AST node kind (e.g., 'name', 'body', 'parameter'). Use with patterns like '$NAME($$$)' to extract just the name.",
				}),
			),
			context: Type.Optional(
				Type.Number({
					description: "Show N lines before/after each match for context",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!astGrepClient.isAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
						},
					],
					isError: true,
					details: {},
				};
			}

			const { pattern, lang, paths, selector, context } = params as {
				pattern: string;
				lang: string;
				paths?: string[];
				selector?: string;
				context?: number;
			};
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.search(pattern, lang, searchPaths, {
				selector,
				context,
			});

			if (result.error) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					isError: true,
					details: {},
				};
			}

			const output = astGrepClient.formatMatches(result.matches);
			return {
				content: [{ type: "text", text: output }],
				details: { matchCount: result.matches.length },
			};
		},
	});

	pi.registerTool({
		name: "ast_grep_replace",
		label: "AST Replace",
		description:
			"Replace code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, not text. Dry-run by default (use apply=true to apply).\n\nExamples:\n- pattern='console.log($MSG)' rewrite='logger.info($MSG)'\n- pattern='var $X' rewrite='let $X'\n- pattern='function $NAME() { }' rewrite='' (delete)\n\nAlways use 'paths' to scope to specific files/folders. Dry-run first to preview changes.",
		promptSnippet: "Use ast_grep_replace for AST-aware find-and-replace",
		parameters: Type.Object({
			pattern: Type.String({
				description: "AST pattern to match (be specific with context)",
			}),
			rewrite: Type.String({
				description: "Replacement using meta-variables from pattern",
			}),
			lang: Type.Union(
				LANGUAGES.map((l) => Type.Literal(l)),
				{ description: "Target language" },
			),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Specific files/folders" }),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Apply changes (default: false)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!astGrepClient.isAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
						},
					],
					isError: true,
					details: {},
				};
			}

			const { pattern, rewrite, lang, paths, apply } = params as {
				pattern: string;
				rewrite: string;
				lang: string;
				paths?: string[];
				apply?: boolean;
			};
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.replace(
				pattern,
				rewrite,
				lang,
				searchPaths,
				apply ?? false,
			);

			if (result.error) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					isError: true,
					details: {},
				};
			}

			const isDryRun = !apply;
			const output = astGrepClient.formatMatches(
				result.matches,
				isDryRun,
				true, // showModeIndicator
			);

			return {
				content: [{ type: "text", text: output }],
				details: { matchCount: result.matches.length, applied: apply ?? false },
			};
		},
	});

	// --- LSP Navigation Tool (requires --lens-lsp) ---
	// Exposes go-to-definition, find-references, hover, documentSymbol, workspaceSymbol, goToImplementation
	pi.registerTool({
		name: "lsp_navigation",
		label: "LSP Navigate",
		description:
			"Navigate code using LSP (Language Server Protocol). Requires --lens-lsp flag.\n" +
			"Operations:\n" +
			"- definition: Jump to where a symbol is defined\n" +
			"- references: Find all usages of a symbol\n" +
			"- hover: Get type/doc info at a position\n" +
			"- documentSymbol: List all symbols (functions/classes/vars) in a file\n" +
			"- workspaceSymbol: Search symbols across the whole project\n" +
			"- implementation: Jump to interface implementations\n\n" +
			"Line and character are 1-based (as shown in editors).",
		promptSnippet:
			"Use lsp_navigation to find definitions, references, and hover info via LSP",
		parameters: Type.Object({
			operation: Type.Union(
				[
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("hover"),
					Type.Literal("documentSymbol"),
					Type.Literal("workspaceSymbol"),
					Type.Literal("implementation"),
				],
				{ description: "LSP operation to perform" },
			),
			filePath: Type.String({
				description: "Absolute or relative path to the file",
			}),
			line: Type.Optional(
				Type.Number({
					description:
						"Line number (1-based). Required for definition/references/hover/implementation",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description:
						"Character offset (1-based). Required for definition/references/hover/implementation",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Symbol name to search. Used by workspaceSymbol",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!pi.getFlag("lens-lsp")) {
				return {
					content: [
						{
							type: "text" as const,
							text: "lsp_navigation requires the --lens-lsp flag. Start pi with --lens-lsp to enable.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const {
				operation,
				filePath: rawPath,
				line,
				character,
				query,
			} = params as {
				operation: string;
				filePath: string;
				line?: number;
				character?: number;
				query?: string;
			};

			const filePath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(ctx.cwd || ".", rawPath);

			const lspService = getLSPService();
			const hasLSP = await lspService.hasLSP(filePath);
			if (!hasLSP) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No LSP server available for ${path.basename(filePath)}. Check that the language server is installed.`,
						},
					],
					isError: true,
					details: {},
				};
			}

			// Ensure file is open in LSP before querying
			let fileContent: string | undefined;
			try {
				fileContent = nodeFs.readFileSync(filePath, "utf-8");
			} catch {
				/* ignore */
			}
			if (fileContent) await lspService.openFile(filePath, fileContent);

			// Convert 1-based editor coords to 0-based LSP coords
			const lspLine = (line ?? 1) - 1;
			const lspChar = (character ?? 1) - 1;

			let result: unknown;
			try {
				switch (operation) {
					case "definition":
						result = await lspService.definition(filePath, lspLine, lspChar);
						break;
					case "references":
						result = await lspService.references(filePath, lspLine, lspChar);
						break;
					case "hover":
						result = await lspService.hover(filePath, lspLine, lspChar);
						break;
					case "documentSymbol":
						result = await lspService.documentSymbol(filePath);
						break;
					case "workspaceSymbol":
						result = await lspService.workspaceSymbol(query ?? "");
						break;
					case "implementation":
						result = await lspService.implementation(
							filePath,
							lspLine,
							lspChar,
						);
						break;
					default:
						result = [];
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			const isEmpty = !result || (Array.isArray(result) && result.length === 0);
			const output = isEmpty
				? `No results for ${operation} at ${path.basename(filePath)}${line ? `:${line}:${character}` : ""}`
				: JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					operation,
					resultCount: Array.isArray(result) ? result.length : result ? 1 : 0,
				},
			};
		},
	});

	let _cachedJscpdClones: import("./clients/jscpd-client.js").DuplicateClone[] =
		[];
	const cachedExports = new Map<string, string>(); // function name -> file path
	const complexityBaselines: Map<
		string,
		import("./clients/complexity-client.js").FileComplexity
	> = new Map();

	// Delta baselines: store pre-write diagnostics to diff against post-write
	const _astGrepBaselines = new Map<
		string,
		import("./clients/ast-grep-types.js").AstGrepDiagnostic[]
	>();
	const _biomeBaselines = new Map<
		string,
		import("./clients/biome-client.js").BiomeDiagnostic[]
	>();

	// Track files already auto-fixed this turn to prevent fix loops
	const fixedThisTurn = new Set<string>();

	// Project rules scan result (from .claude/rules, .agents/rules, etc.)
	let projectRulesScan: RuleScanResult = { rules: [], hasCustomRules: false };

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		_verbose = !!pi.getFlag("lens-verbose");
		dbg("session_start fired");

		// Initialize event bus system (Phase 1)
		const busEnabled = pi.getFlag("lens-bus");
		if (busEnabled) {
			const busDebug = pi.getFlag("lens-bus-debug");
			initBusIntegration(pi, { debug: !!busDebug });
			if (busDebug) enableBusDebug(true);
			SessionStarted.publish({
				cwd: ctx.cwd ?? process.cwd(),
				timestamp: Date.now(),
			});
			dbg("session_start: bus integration initialized");
		}

		// Reset session state
		metricsClient.reset();
		complexityBaselines.clear();

		// Log available tools
		const tools: string[] = [];
		tools.push("TypeScript LSP"); // Always available
		if (biomeClient.isAvailable()) tools.push("Biome");
		if (astGrepClient.isAvailable()) tools.push("ast-grep");
		if (ruffClient.isAvailable()) tools.push("Ruff");
		if (knipClient.isAvailable()) tools.push("Knip");
		if (depChecker.isAvailable()) tools.push("Madge");
		if (jscpdClient.isAvailable()) tools.push("jscpd");
		if (typeCoverageClient.isAvailable()) tools.push("type-coverage");

		log(`Active tools: ${tools.join(", ")}`);
		dbg(`session_start tools: ${tools.join(", ")}`);

		// Pre-install TypeScript LSP if --lens-lsp flag is set (avoid delay on first use)
		if (pi.getFlag("lens-lsp")) {
			dbg("session_start: pre-installing TypeScript LSP...");
			// Fire-and-forget: don't block session start, just warm up the cache
			ensureTool("typescript-language-server")
				.then((path) => {
					if (path) {
						dbg(`session_start: TypeScript LSP ready at ${path}`);
					} else {
						console.error("[lens] TypeScript LSP installation failed");
					}
				})
				.catch((err) => {
					console.error("[lens] TypeScript LSP pre-install error:", err);
				});
		}

		const cwd = ctx.cwd ?? process.cwd();
		projectRoot = cwd; // Module-level for architect client
		dbg(`session_start cwd: ${cwd}`);

		// Load architect rules if present
		const hasArchitectRules = architectClient.loadConfig(cwd);
		if (hasArchitectRules) tools.push("Architect rules");

		// Log test runner if detected
		const detectedRunner = testRunnerClient.detectRunner(cwd);
		if (detectedRunner) {
			tools.push(`Test runner (${detectedRunner.runner})`);
		}
		if (goClient.isGoAvailable()) tools.push("Go (go vet)");
		if (rustClient.isAvailable()) tools.push("Rust (cargo)");
		log(`Active tools: ${tools.join(", ")}`);
		dbg(`session_start tools: ${tools.join(", ")}`);

		const parts: string[] = [];

		// --- Error ownership reminder ---
		// Shown on every session start to encourage fixing existing errors
		parts.push(
			"📌 Remember: If you find ANY errors (test failures, compile errors, lint issues) in this codebase, fix them — even if you didn't cause them. Don't skip errors as 'not my fault'.",
		);

		// Scan for project-specific rules (.claude/rules, .agents/rules, CLAUDE.md, etc.)
		projectRulesScan = scanProjectRules(cwd);
		if (projectRulesScan.hasCustomRules) {
			const ruleCount = projectRulesScan.rules.length;
			const sources = [...new Set(projectRulesScan.rules.map((r) => r.source))];
			dbg(
				`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
			);
			parts.push(
				`📋 Project rules found: ${ruleCount} file(s) in ${sources.join(", ")}. These apply alongside pi-lens defaults.`,
			);
		} else {
			dbg("session_start: no project rules found");
		}

		// TODO/FIXME scan — fast, no deps
		const todoResult = todoScanner.scanDirectory(cwd);
		const todoReport = todoScanner.formatResult(todoResult);
		dbg(`session_start TODO scan: ${todoResult.items.length} items`);
		if (todoReport) parts.push(todoReport);

		// Dead code scan — use cache if fresh, auto-install if needed
		if (await knipClient.ensureAvailable()) {
			const cached = cacheManager.readCache<ReturnType<KnipClient["analyze"]>>(
				"knip",
				cwd,
			);
			if (cached) {
				dbg(
					`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
				);
				const knipReport = knipClient.formatResult(cached.data);
				if (knipReport) parts.push(knipReport);
			} else {
				const startMs = Date.now();
				const knipResult = knipClient.analyze(cwd);
				cacheManager.writeCache("knip", knipResult, cwd, {
					scanDurationMs: Date.now() - startMs,
				});
				const knipReport = knipClient.formatResult(knipResult);
				dbg(`session_start Knip scan done`);
				if (knipReport) parts.push(knipReport);
			}
		} else {
			dbg(`session_start Knip: not available`);
		}

		// Duplicate code detection — use cache if fresh, auto-install if needed
		if (await jscpdClient.ensureAvailable()) {
			const cached = cacheManager.readCache<ReturnType<JscpdClient["scan"]>>(
				"jscpd",
				cwd,
			);
			if (cached) {
				dbg(`session_start jscpd: cache hit`);
				_cachedJscpdClones = cached.data.clones;
				const jscpdReport = jscpdClient.formatResult(cached.data);
				if (jscpdReport) parts.push(jscpdReport);
			} else {
				const startMs = Date.now();
				const jscpdResult = jscpdClient.scan(cwd);
				_cachedJscpdClones = jscpdResult.clones;
				cacheManager.writeCache("jscpd", jscpdResult, cwd, {
					scanDurationMs: Date.now() - startMs,
				});
				const jscpdReport = jscpdClient.formatResult(jscpdResult);
				dbg(`session_start jscpd scan done`);
				if (jscpdReport) parts.push(jscpdReport);
			}
		} else {
			dbg(`session_start jscpd: not available`);
		}

		// Note: type-coverage runs on-demand via /lens-booboo only (not at session_start)

		// Scan for exported functions (cached for duplicate detection on write)
		if (await astGrepClient.ensureAvailable()) {
			const exports = await astGrepClient.scanExports(cwd, "typescript");
			dbg(`session_start exports scan: ${exports.size} functions found`);
			for (const [name, file] of exports) {
				cachedExports.set(name, file);
			}
		}

		dbg(
			`session_start: scans complete (${parts.length} part(s)), cached for commands`,
		);

		// Output the assembled parts to user
		if (parts.length > 0) {
			for (const part of parts) {
				ctx.ui.notify(part, "info");
			}
		}

		// --- Error debt: check if tests ran since last session ---
		// If files were modified in previous turn, run tests and check for regression
		const errorDebtEnabled = pi.getFlag("error-debt");
		const pendingDebt = cacheManager.readCache<{
			pendingCheck: boolean;
			baselineTestsPassed: boolean;
		}>("errorDebt", cwd);

		if (errorDebtEnabled && detectedRunner && pendingDebt?.data?.pendingCheck) {
			dbg("session_start: running pending error debt check");
			const testResult = testRunnerClient.runTestFile(
				".",
				cwd,
				detectedRunner.runner,
				detectedRunner.config,
			);
			const testsPassed = testResult.failed === 0 && !testResult.error;
			const baselinePassed = pendingDebt.data.baselineTestsPassed;

			// Regression detected!
			if (baselinePassed && !testsPassed) {
				const msg = `🔴 ERROR DEBT: Tests were passing but now failing (${testResult.failed} failure(s)). Fix before continuing.`;
				dbg(`session_start ERROR DEBT: ${msg}`);
				parts.push(msg);
			}

			// Update baseline
			errorDebtBaseline = {
				testsPassed: testsPassed,
				buildPassed: true,
			};
		} else if (errorDebtEnabled && detectedRunner) {
			// No pending check - establish fresh baseline
			dbg("session_start: establishing fresh error debt baseline");
			const testResult = testRunnerClient.runTestFile(
				".",
				cwd,
				detectedRunner.runner,
				detectedRunner.config,
			);
			const testsPassed = testResult.failed === 0 && !testResult.error;
			errorDebtBaseline = {
				testsPassed: testsPassed,
				buildPassed: true,
			};
			dbg(
				`session_start error debt baseline: testsPassed=${errorDebtBaseline.testsPassed}`,
			);
		}
	});

	// --- Pre-write proactive hints ---
	// Stored during tool_call, prepended to tool_result output so the agent sees them.
	const preWriteHints = new Map<string, string>();

	pi.on("tool_call", async (event, _ctx) => {
		const filePath =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event)
				? (event.input as { path: string }).path
				: undefined;

		if (!filePath) return;

		const _toolCallStart = Date.now();
		dbg(
			`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
		);
		if (!nodeFs.existsSync(filePath)) return;

		// Record complexity baseline for TS/JS files + capture history snapshot
		const complexityBaselineStart = Date.now();
		if (
			complexityClient.isSupportedFile(filePath) &&
			!complexityBaselines.has(filePath)
		) {
			const baseline = complexityClient.analyzeFile(filePath);
			if (baseline) {
				complexityBaselines.set(filePath, baseline);
				// Capture snapshot for historical tracking (async, non-blocking)
				captureSnapshot(filePath, {
					maintainabilityIndex: baseline.maintainabilityIndex,
					cognitiveComplexity: baseline.cognitiveComplexity,
					maxNestingDepth: baseline.maxNestingDepth,
					linesOfCode: baseline.linesOfCode,
				});
			}
			logLatency({
				type: "phase",
				toolName: event.toolName,
				filePath,
				phase: "complexity_baseline",
				durationMs: Date.now() - complexityBaselineStart,
				metadata: { hasBaseline: complexityBaselines.has(filePath) },
			});
		}

		const hints: string[] = [];
		let _preCheckDuration = 0;

		if (/\.(ts|tsx|js|jsx)$/.test(filePath) && !pi.getFlag("no-lsp")) {
			const tsPreCheckStart = Date.now();
			tsClient.updateFile(filePath, nodeFs.readFileSync(filePath, "utf-8"));
			const diags = tsClient.getDiagnostics(filePath);
			// Pass pre-computed diags to avoid a second getSemanticDiagnostics call (~1s on large files)
			const fixes = tsClient.getAllCodeFixes(filePath, diags);
			const errorDiags = diags.filter((d) => d.severity === 1);
			if (errorDiags.length > 0) {
				hints.push(
					`⚠ Pre-write: file has ${errorDiags.length} TypeScript error(s):`,
				);
				// Show first 3 errors with quick fixes
				for (const d of errorDiags.slice(0, 3)) {
					const lineFixes = fixes.get(d.range.start.line);
					const fixHint = lineFixes?.[0]?.description
						? ` 💡 ${lineFixes[0].description}`
						: "";
					hints.push(
						`  L${d.range.start.line + 1}: ${d.message.split("\n")[0].substring(0, 80)}${fixHint}`,
					);
				}
				if (errorDiags.length > 3) {
					hints.push(`  ... and ${errorDiags.length - 3} more errors`);
				}
			}
			_preCheckDuration += Date.now() - tsPreCheckStart;
			logLatency({
				type: "phase",
				toolName: event.toolName,
				filePath,
				phase: "ts_pre_check",
				durationMs: Date.now() - tsPreCheckStart,
				metadata: { errorCount: errorDiags.length, hintCount: hints.length },
			});
		}

		// Unified LSP pre-write check (when --lens-lsp enabled)
		// This provides pre-write hints for all LSP languages (TypeScript, Python, Go, Rust, etc.)
		if (pi.getFlag("lens-lsp") && !pi.getFlag("no-lsp")) {
			const lspPreCheckStart = Date.now();
			const lspService = getLSPService();
			lspService
				.hasLSP(filePath)
				.then(async (hasLSP) => {
					if (hasLSP) {
						const content = nodeFs.readFileSync(filePath, "utf-8");
						await lspService.openFile(filePath, content);
						await new Promise((r) => setTimeout(r, 300));
						const diags = await lspService.getDiagnostics(filePath);
						const errorDiags = diags.filter((d) => d.severity === 1);
						if (errorDiags.length > 0) {
							hints.push(
								`⚠ Pre-write: ${errorDiags.length} LSP error(s) detected:`,
							);
							for (const d of errorDiags.slice(0, 3)) {
								hints.push(
									`  L${d.range?.start?.line ?? 0 + 1}: ${d.message.slice(0, 80)}`,
								);
							}
							if (errorDiags.length > 3) {
								hints.push(`  ... and ${errorDiags.length - 3} more`);
							}
						}
						_preCheckDuration += Date.now() - lspPreCheckStart;
						logLatency({
							type: "phase",
							toolName: event.toolName,
							filePath,
							phase: "lsp_pre_check",
							durationMs: Date.now() - lspPreCheckStart,
							metadata: { hasLSP, errorCount: errorDiags?.length ?? 0 },
						});
					}
				})
				.catch((err) => {
					logLatency({
						type: "phase",
						toolName: event.toolName,
						filePath,
						phase: "lsp_pre_check",
						durationMs: Date.now() - lspPreCheckStart,
						status: "failed",
						metadata: { error: String(err) },
					});
				});
		}

		// Note: ast-grep baseline removed - we use ast-grep-napi in dispatch instead
		// Note: biome baseline removed - auto-fix handles this in post-write

		// Architectural rules: Skip pre-write hints (too noisy)
		// Post-write violations will be shown via architect runner in dispatch

		dbg(`  pre-write hints: ${hints.length} — ${hints.join(" | ") || "none"}`);
		if (hints.length > 0) {
			preWriteHints.set(filePath, hints.join("\n"));
		}
	});

	// Real-time feedback on file writes/edits
	pi.on("tool_result", async (event) => {
		// ═══════════════════════════════════════════════════════════════════
		// LATENCY TRACKING: Comprehensive phase-based logging
		// ═══════════════════════════════════════════════════════════════════
		const toolResultStart = Date.now();
		const toolName = event.toolName;
		const phases: Array<{
			name: string;
			start: number;
			end?: number;
			duration?: number;
		}> = [];

		function phaseStart(name: string) {
			phases.push({ name, start: Date.now() });
		}
		function phaseEnd(name: string, metadata?: Record<string, unknown>) {
			const p = phases.find((x) => x.name === name && !x.end);
			if (p) {
				p.end = Date.now();
				p.duration = p.end - p.start;
				if (filePath) {
					logLatency({
						type: "phase",
						toolName,
						filePath,
						phase: name,
						durationMs: p.duration,
						metadata,
					});
				}
			}
		}

		// Track tool call for behavior analysis (all tool types)
		const filePath = (event.input as { path?: string }).path;
		const behaviorWarnings = agentBehaviorClient.recordToolCall(
			event.toolName,
			filePath,
		);

		if (event.toolName !== "write" && event.toolName !== "edit") {
			dbg(
				`tool_result: skipped turn tracking - toolName="${event.toolName}" (not write/edit)`,
			);
			return;
		}
		if (!filePath) {
			dbg(
				`tool_result: skipped turn tracking - no filePath for toolName="${event.toolName}"`,
			);
			return;
		}

		// --- FileTime assert: prevent stale writes (file modified since agent read it) ---
		const sessionFileTime = createFileTime("default");
		try {
			sessionFileTime.assert(filePath);
		} catch (err: unknown) {
			if (err instanceof FileTimeError) {
				// File was modified externally or never read - warn but don't block (for now)
				// In strict mode this could block; currently we just surface the warning
				const warning = `⚠️ FileTime warning: ${err.message}`;
				dbg(warning);
				// Don't return - let the operation proceed with warning
			}
		}
		// Record this write so future assertions know the agent has the current state
		sessionFileTime.read(filePath);
		dbg(
			`tool_result: tracking turn state for ${event.toolName} on ${filePath}`,
		);
		phaseStart("total");
		phaseStart("turn_state_tracking");

		// --- Track modified ranges in turn state for async jscpd/madge at turn_end ---
		const cwd = projectRoot;
		try {
			const details = event.details as { diff?: string } | undefined;
			dbg(
				`tool_result: details.diff=${details?.diff ? "present" : "missing"}, details keys: ${Object.keys(event.details || {}).join(", ")}`,
			);
			if (event.toolName === "edit" && details?.diff) {
				const diff = details.diff;
				dbg(
					`tool_result: diff content (first 500 chars): ${diff.substring(0, 500)}`,
				);
				const ranges = parseDiffRanges(diff);
				const importsChanged =
					/import\s/.test(diff) || /from\s+['"]/.test(diff);
				dbg(
					`tool_result: parsed ${ranges.length} ranges, importsChanged=${importsChanged}`,
				);
				for (const range of ranges) {
					dbg(
						`tool_result: adding range ${range.start}-${range.end} for ${filePath}`,
					);
					cacheManager.addModifiedRange(filePath, range, importsChanged, cwd);
				}
				dbg(
					`tool_result: turn state after add: ${JSON.stringify(cacheManager.readTurnState(cwd))}`,
				);
			} else if (event.toolName === "write" && nodeFs.existsSync(filePath)) {
				const content = nodeFs.readFileSync(filePath, "utf-8");
				const lineCount = content.split("\n").length;
				const hasImports = /^import\s/m.test(content);
				cacheManager.addModifiedRange(
					filePath,
					{ start: 1, end: lineCount },
					hasImports,
					cwd,
				);
			}
		} catch (err) {
			dbg(`turn state tracking error: ${err}`);
			dbg(`turn state tracking error stack: ${(err as Error).stack}`);
		}

		dbg(`tool_result fired for: ${filePath}`);
		dbg(`  cwd: ${process.cwd()}`);
		dbg(
			`  __dirname: ${typeof __dirname !== "undefined" ? __dirname : "undefined"}`,
		);

		// Prepend any pre-write hints collected during tool_call
		const preHint = preWriteHints.get(filePath);
		preWriteHints.delete(filePath);

		// Record write for metrics (silent tracking)
		phaseEnd("turn_state_tracking");
		phaseStart("read_file");

		let fileContent: string | undefined;
		try {
			fileContent = nodeFs.readFileSync(filePath, "utf-8");
			metricsClient.recordWrite(filePath, fileContent);
		} catch (err) {
			void err;
		}
		phaseEnd("read_file");

		// --- Auto-format on write (default enabled) ---
		phaseStart("format");
		// Runs detected formatters concurrently via Effect-TS
		let formatChanged = false;
		let formattersUsed: string[] = [];
		if (!pi.getFlag("no-autoformat") && fileContent) {
			const formatService = getFormatService();
			try {
				// Record file read to establish FileTime baseline before formatting
				// This prevents "modified externally" false positives when agent writes file
				formatService.recordRead(filePath);
				const result = await formatService.formatFile(filePath);
				formattersUsed = result.formatters.map((f) => f.name);
				if (result.anyChanged) {
					formatChanged = true;
					dbg(
						`autoformat: ${result.formatters.map((f) => `${f.name}(${f.changed ? "changed" : "unchanged"})`).join(", ")}`,
					);
					// Re-read content after formatting for downstream processing
					fileContent = nodeFs.readFileSync(filePath, "utf-8");
				}
			} catch (err) {
				dbg(`autoformat error: ${err}`);
			}
		}
		phaseEnd("format", { formattersUsed, formatChanged });

		// --- Publish file modified event to bus (Phase 1) ---
		if (pi.getFlag("lens-bus")) {
			FileModified.publish({
				filePath,
				content: fileContent,
				changeType: event.toolName === "edit" ? "edit" : "write",
			});
		}

		// --- LSP integration (Phase 3) ---
		if (pi.getFlag("lens-lsp") && fileContent) {
			const lspService = getLSPService();
			lspService
				.hasLSP(filePath)
				.then(async (hasLSP) => {
					if (hasLSP) {
						// Open or update file in LSP
						if (event.toolName === "write") {
							await lspService.openFile(filePath, fileContent);
						} else {
							await lspService.updateFile(filePath, fileContent);
						}
					}
				})
				.catch((err) => {
					dbg(`LSP error: ${err}`);
				});
		}

		// --- Secrets scan (blocking - must check before other linting) ---
		if (fileContent) {
			const secretFindings = scanForSecrets(fileContent, filePath);
			if (secretFindings.length > 0) {
				const secretsOutput = formatSecrets(secretFindings, filePath);
				const elapsed = Date.now() - toolResultStart;
				logLatency({
					type: "tool_result",
					toolName,
					filePath,
					durationMs: elapsed,
					result: "blocked_secrets",
					metadata: { secretsFound: secretFindings.length },
				});
				return {
					content: [
						...event.content,
						{ type: "text" as const, text: `\n\n${secretsOutput}` },
					],
					isError: true,
				};
			}
		}

		let lspOutput = preHint ? `\n\n${preHint}` : "";

		// --- Auto-fix on write (safely - track to prevent loops) ---
		phaseStart("autofix");
		// Apply fixes BEFORE dispatch so dispatch only reports remaining issues
		// Autofix is enabled by default, use --no-autofix to disable
		const noAutofix = pi.getFlag("no-autofix");
		const noAutofixBiome = pi.getFlag("no-autofix-biome");
		const noAutofixRuff = pi.getFlag("no-autofix-ruff");
		let fixedCount = 0;

		if (!fixedThisTurn.has(filePath) && !noAutofix) {
			// Python: Ruff auto-fix (enabled by default)
			if (
				!noAutofixRuff &&
				(await ruffClient.ensureAvailable()) &&
				ruffClient.isPythonFile(filePath)
			) {
				const result = ruffClient.fixFile(filePath);
				if (result.success && result.fixed > 0) {
					fixedCount += result.fixed;
					fixedThisTurn.add(filePath);
					dbg(`autofix: ruff fixed ${result.fixed} issue(s) in ${filePath}`);
				}
			}

			// JS/TS/JSON: Biome auto-fix (enabled by default)
			if (
				!noAutofixBiome &&
				biomeClient.isAvailable() &&
				biomeClient.isSupportedFile(filePath)
			) {
				const result = biomeClient.fixFile(filePath);
				if (result.success && result.fixed > 0) {
					fixedCount += result.fixed;
					fixedThisTurn.add(filePath);
					dbg(`autofix: biome fixed ${result.fixed} issue(s) in ${filePath}`);
				}
			}
		}
		phaseEnd("autofix", { fixedCount, tools: ["ruff", "biome"] });

		// --- Declarative dispatch: run all applicable lint tools ---
		phaseStart("dispatch_lint");
		// Phase 2: Replaced ~400 lines of if/else with unified dispatch system
		dbg(`dispatch: running lint tools for ${filePath}`);

		// Select dispatcher based on flags:
		// - lens-effect: Effect-TS concurrent execution (Phase 2)
		// - lens-bus: Bus-enabled dispatcher (Phase 1)
		// - default: Original sequential dispatcher
		let dispatchOutput: string;
		if (pi.getFlag("lens-effect")) {
			dispatchOutput = await dispatchLintWithEffect(filePath, projectRoot, pi);
		} else if (pi.getFlag("lens-bus")) {
			dispatchOutput = await dispatchLintWithBus(filePath, projectRoot, pi);
		} else {
			dispatchOutput = await dispatchLint(filePath, projectRoot, pi);
		}

		if (dispatchOutput) {
			lspOutput += `\n\n${dispatchOutput}`;
		}

		// Report autofix results
		if (fixedCount > 0) {
			lspOutput += `\n\n✅ Auto-fixed ${fixedCount} issue(s) in ${path.basename(filePath)}`;
		}

		// Warn agent if file was modified by auto-format or auto-fix
		// This ensures they know to re-read before next edit
		if (formatChanged || fixedCount > 0) {
			lspOutput += `\n\n⚠️ **File modified by auto-format/fix. Re-read before next edit.**`;
		}
		phaseEnd("dispatch_lint", {
			hasOutput: !!dispatchOutput,
			effect: pi.getFlag("lens-effect"),
			bus: pi.getFlag("lens-bus"),
		});

		// --- Test runner: run corresponding tests on write ---
		phaseStart("test_runner");
		let testInfoFound = false;
		let testRunnerRan = false;
		if (!pi.getFlag("no-tests")) {
			const testInfo = testRunnerClient.findTestFile(filePath, cwd);
			testInfoFound = !!testInfo;
			if (testInfo) {
				dbg(
					`test-runner: found test file ${testInfo.testFile} for ${filePath}`,
				);
				const detectedRunner = testRunnerClient.detectRunner(cwd);
				if (detectedRunner) {
					testRunnerRan = true;
					const testStart = Date.now();
					const testResult = testRunnerClient.runTestFile(
						testInfo.testFile,
						cwd,
						detectedRunner.runner,
						detectedRunner.config,
					);
					const testDuration = Date.now() - testStart;
					logLatency({
						type: "phase",
						toolName,
						filePath,
						phase: "test_runner",
						durationMs: testDuration,
						metadata: {
							testFile: testInfo.testFile,
							runner: detectedRunner.runner,
							success: !testResult?.error,
						},
					});
					if (testResult && !testResult.error) {
						const testOutput = testRunnerClient.formatResult(testResult);
						if (testOutput) {
							lspOutput += `\n\n${testOutput}`;
						}
					}
				}
			}
		}
		phaseEnd("test_runner", { found: testInfoFound, ran: testRunnerRan });

		// Note: TypeScript diagnostics are handled by the ts-lsp dispatch runner above.
		// No inline TypeScriptClient check here — dispatch already covers it.

		// --- Complexity tracking (post-write) ---
		phaseStart("complexity_check");
		if (complexityClient.isSupportedFile(filePath)) {
			const oldBaseline = complexityBaselines.get(filePath);
			const newComplexity = complexityClient.analyzeFile(filePath);
			if (oldBaseline && newComplexity) {
				const complexityDelta = {
					cognitive:
						newComplexity.cognitiveComplexity - oldBaseline.cognitiveComplexity,
					maintainability:
						newComplexity.maintainabilityIndex -
						oldBaseline.maintainabilityIndex,
					lines: newComplexity.linesOfCode - oldBaseline.linesOfCode,
				};
				// Warn if complexity significantly increased
				if (
					complexityDelta.cognitive > 3 ||
					complexityDelta.maintainability < -5
				) {
					lspOutput += `\n\n⚠️ Complexity increased: +${complexityDelta.cognitive} cognitive, ${complexityDelta.maintainability.toFixed(1)} maintainability`;
				}
				phaseEnd("complexity_check", {
					delta: complexityDelta,
					warned:
						complexityDelta.cognitive > 3 ||
						complexityDelta.maintainability < -5,
				});
			} else {
				phaseEnd("complexity_check", { delta: null, warned: false });
			}
		} else {
			phaseEnd("complexity_check", { skipped: true });
		}

		// Agent behavior warnings (blind writes, thrashing)
		if (behaviorWarnings.length > 0) {
			lspOutput += `\n\n${agentBehaviorClient.formatWarnings(behaviorWarnings)}`;
		}

		// --- Cascade diagnostics: check other files for errors (when --lens-lsp) ---
		if (pi.getFlag("lens-lsp") && !pi.getFlag("no-lsp")) {
			const MAX_CASCADE_FILES = 5;
			const MAX_DIAGNOSTICS_PER_FILE = 20;
			const cascadeStart = Date.now();

			try {
				const lspService = getLSPService();
				const allDiags = await lspService.getAllDiagnostics();
				const normalizedEditedPath = path.resolve(filePath);
				const otherFileErrors: Array<{
					file: string;
					errors: import("./clients/lsp/client.js").LSPDiagnostic[];
				}> = [];

				for (const [diagPath, diags] of allDiags) {
					if (path.resolve(diagPath) === normalizedEditedPath) continue; // Skip edited file (dispatch already covered it)
					const errors = diags.filter((d) => d.severity === 1);
					if (errors.length > 0) {
						otherFileErrors.push({ file: diagPath, errors });
					}
				}

				if (otherFileErrors.length > 0) {
					lspOutput += `\n\n📐 Cascade errors detected in ${otherFileErrors.length} other file(s):`;
					for (const { file, errors } of otherFileErrors.slice(
						0,
						MAX_CASCADE_FILES,
					)) {
						const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
						const suffix =
							errors.length > MAX_DIAGNOSTICS_PER_FILE
								? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
								: "";
						// Structured XML format (like OpenCode) for cleaner parsing
						lspOutput += `\n<diagnostics file="${file}">`;
						for (const e of limited) {
							const line = (e.range?.start?.line ?? 0) + 1;
							const col = (e.range?.start?.character ?? 0) + 1;
							const code = e.code ? ` [${e.code}]` : "";
							lspOutput += `\n  ${code} (${line}:${col}) ${e.message.split("\n")[0].slice(0, 100)}`;
						}
						lspOutput += `${suffix}\n</diagnostics>`;
					}
					if (otherFileErrors.length > MAX_CASCADE_FILES) {
						lspOutput += `\n... and ${otherFileErrors.length - MAX_CASCADE_FILES} more files with errors`;
					}
				}

				logLatency({
					type: "phase",
					toolName,
					filePath,
					phase: "cascade_diagnostics",
					durationMs: Date.now() - cascadeStart,
					metadata: { filesWithErrors: otherFileErrors.length },
				});
			} catch (err) {
				dbg(`cascade diagnostics error: ${err}`);
			}
		}

		// LATENCY TRACKING: Log timing before returning
		const elapsed = Date.now() - toolResultStart;
		phaseEnd("total", { hasOutput: !!lspOutput });
		if (!lspOutput) {
			logLatency({
				type: "tool_result",
				toolName,
				filePath,
				durationMs: elapsed,
				result: "no_output",
			});
			return;
		}

		logLatency({
			type: "tool_result",
			toolName,
			filePath,
			durationMs: elapsed,
			result: "completed",
		});

		return {
			content: [...event.content, { type: "text" as const, text: lspOutput }],
		};
	});

	// --- Inject project rules into system prompt ---
	pi.on("before_agent_start", async (event) => {
		if (!projectRulesScan.hasCustomRules) return;

		const rulesSection = formatRulesForPrompt(projectRulesScan);
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Rules (from project files)\n\nThe following project-specific rule files exist. Read them with the \`read\` tool when relevant:\n\n${rulesSection}\n`,
		};
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	pi.on("turn_end", async (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const turnState = cacheManager.readTurnState(cwd);
		const files = Object.keys(turnState.files);

		// Publish turn ended event to bus (Phase 1)
		if (pi.getFlag("lens-bus") && files.length > 0) {
			TurnEnded.publish({
				cwd,
				modifiedFiles: files,
				timestamp: Date.now(),
			});
		}

		if (files.length === 0) return;

		dbg(
			`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
		);

		// Max cycles guard — force through after N turns with unresolved issues
		if (cacheManager.isMaxCyclesExceeded(cwd)) {
			dbg("turn_end: max cycles exceeded, clearing state and forcing through");
			cacheManager.clearTurnState(cwd);
			return;
		}

		const parts: string[] = [];

		// jscpd: scan modified files, filter results to modified line ranges
		if (jscpdClient.isAvailable()) {
			const jscpdFiles = cacheManager.getFilesForJscpd(cwd);
			if (jscpdFiles.length > 0) {
				dbg(`turn_end: jscpd scanning ${jscpdFiles.length} file(s)`);
				// Use full scan then filter — jscpd doesn't support per-file scanning
				const result = jscpdClient.scan(cwd);
				// Filter clones to only those intersecting modified ranges
				const jscpdFileSet = new Set(
					jscpdFiles.map((f) => path.resolve(cwd, f)),
				);
				const filtered = result.clones.filter((clone) => {
					const resolvedA = path.resolve(clone.fileA);
					if (!jscpdFileSet.has(resolvedA)) return false;
					const relA = path.relative(cwd, resolvedA).replace(/\\/g, "/");
					const state = turnState.files[relA];
					if (!state) return false;
					return cacheManager.isLineInModifiedRange(
						clone.startA,
						state.modifiedRanges,
					);
				});
				if (filtered.length > 0) {
					let report = `🔴 New duplicates in modified code:\n`;
					for (const clone of filtered.slice(0, 5)) {
						report += `  ${path.basename(clone.fileA)}:${clone.startA} ↔ ${path.basename(clone.fileB)}:${clone.startB} (${clone.lines} lines)\n`;
					}
					parts.push(report);
				}
				// Update the global cache with fresh results
				_cachedJscpdClones = result.clones;
				cacheManager.writeCache("jscpd", result, cwd);
			}
		}

		// madge: only check files where imports changed
		if (await depChecker.ensureAvailable()) {
			const madgeFiles = cacheManager.getFilesForMadge(cwd);
			if (madgeFiles.length > 0) {
				dbg(
					`turn_end: madge checking ${madgeFiles.length} file(s) for circular deps`,
				);
				for (const file of madgeFiles) {
					const absPath = path.resolve(cwd, file);
					const depResult = depChecker.checkFile(absPath);
					if (depResult.hasCircular && depResult.circular.length > 0) {
						const circularDeps = depResult.circular
							.flatMap((d) => d.path)
							.filter((p: string) => !absPath.endsWith(path.basename(p)));
						const uniqueDeps = [...new Set(circularDeps)];
						if (uniqueDeps.length > 0) {
							parts.push(
								`🟡 Circular dependency in ${file}: imports ${uniqueDeps.join(", ")}`,
							);
						}
					}
				}
			}
		}

		// Increment turn cycle and persist
		cacheManager.incrementTurnCycle(cwd);

		if (parts.length > 0) {
			dbg(`turn_end: ${parts.length} issue(s) found`);
			// Issues found — state persists so next turn re-checks.
			// After maxCycles, clearTurnState forces through.
		} else {
			// No issues — clear state for next batch of edits
			cacheManager.clearTurnState(cwd);
		}

		// --- Error debt: trigger background test run for next session ---
		// We don't wait - just set a flag that tests should run at next session_start
		// This way tests run async (session_start is when agent is idle)
		if (errorDebtBaseline && files.length > 0) {
			dbg("turn_end: marking error debt check for next session");
			// Write a marker file - next session_start will pick this up
			cacheManager.writeCache(
				"errorDebt",
				{
					pendingCheck: true,
					baselineTestsPassed: errorDebtBaseline.testsPassed,
				},
				cwd,
			);
		}

		// Clear fixed tracking so files can be fixed again on next turn
		fixedThisTurn.clear();

		// --- LSP cleanup on turn end (Phase 3) ---
		// Only shutdown if no files are being actively edited
		if (pi.getFlag("lens-lsp") && files.length === 0) {
			resetLSPService();
		}

		// --- Format service cleanup ---
		resetFormatService();
	});
}
