import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// RELOADED: Testing format/lsp flow on large file
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AgentBehaviorClient } from "./clients/agent-behavior-client.js";
import { ArchitectClient } from "./clients/architect-client.js";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import { CacheManager } from "./clients/cache-manager.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { resetDispatchBaselines } from "./clients/dispatch/integration.js";
import { extractFunctions } from "./clients/dispatch/runners/similarity.js";
import { createFileTime, FileTimeError } from "./clients/file-time.js";
import {
	getFormatService,
	resetFormatService,
} from "./clients/format-service.js";
import { GoClient } from "./clients/go-client.js";
import { ensureTool } from "./clients/installer/index.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
// RELOAD TEST 6: Cache verification run
import { logLatency } from "./clients/latency-logger.js";
import { getLSPService, resetLSPService } from "./clients/lsp/index.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { captureSnapshot } from "./clients/metrics-history.js";
import { runPipeline } from "./clients/pipeline.js";
import {
	buildProjectIndex,
	findSimilarFunctions,
	isIndexFresh,
	loadIndex,
	saveIndex,
	type ProjectIndex,
} from "./clients/project-index.js";
import { RuffClient } from "./clients/ruff-client.js";
import {
	formatRulesForPrompt,
	type RuleScanResult,
	scanProjectRules,
} from "./clients/rules-scanner.js";
import { RustClient } from "./clients/rust-client.js";
import { getSourceFiles } from "./clients/scan-utils.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { resolveStartupScanContext } from "./clients/startup-scan.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";
import { handleBooboo } from "./commands/booboo.js";

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

	pi.registerTool({
		name: "ast_grep_search",
		label: "AST Search",
		description:
			"Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search.\n\n" +
			"✅ GOOD patterns (single AST node):\n" +
			"  - function $NAME() { $$$BODY }     (function declaration)\n" +
			"  - fetchMetrics($ARGS)               (function call)\n" +
			'  - import { $NAMES } from "$PATH"   (import statement)\n' +
			"  - console.log($MSG)                  (method call)\n\n" +
			"❌ BAD patterns (multiple nodes / raw text):\n" +
			'  - it"test name"                    (missing parens - use it($TEST))\n' +
			"  - console.log without args          (incomplete code)\n" +
			"  - arbitrary text without code structure\n\n" +
			"Always prefer specific patterns with context over bare identifiers. " +
			"Use 'paths' to scope to specific files/folders. " +
			"Use 'selector' to extract specific nodes (e.g., just the function name). " +
			"Use 'context' to show surrounding lines.",
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
			"Replace code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, not text. Dry-run by default (use apply=true to apply).\n\n" +
			"✅ GOOD patterns (single AST node):\n" +
			"  - pattern='console.log($MSG)' rewrite='logger.info($MSG)'\n" +
			"  - pattern='var $X' rewrite='let $X'\n" +
			"  - pattern='function $NAME() { }' rewrite='' (delete)\n\n" +
			"❌ BAD patterns (will error):\n" +
			"  - Raw text without code structure\n" +
			'  - Missing parentheses: use it($TEST) not it"text"\n' +
			"  - Incomplete code fragments\n\n" +
			"Always use 'paths' to scope to specific files/folders. Dry-run first to preview changes.",
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
			"- implementation: Jump to interface implementations\n" +
			"- prepareCallHierarchy: Get callable item at position (for incoming/outgoing)\n" +
			"- incomingCalls: Find all functions/methods that CALL this function\n" +
			"- outgoingCalls: Find all functions/methods CALLED by this function\n\n" +
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
					Type.Literal("prepareCallHierarchy"),
					Type.Literal("incomingCalls"),
					Type.Literal("outgoingCalls"),
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
			callHierarchyItem: Type.Optional(
				Type.Object(
					{
						name: Type.String(),
						kind: Type.Number(),
						uri: Type.String(),
						range: Type.Object({
							start: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
							end: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
						}),
						selectionRange: Type.Object({
							start: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
							end: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
						}),
					},
					{
						description:
							"Call hierarchy item. Required for incomingCalls/outgoingCalls",
					},
				),
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
					case "prepareCallHierarchy":
						result = await lspService.prepareCallHierarchy(
							filePath,
							lspLine,
							lspChar,
						);
						break;
					case "incomingCalls":
						if (!params.callHierarchyItem) {
							return {
								content: [
									{
										type: "text" as const,
										text: "callHierarchyItem parameter required for incomingCalls",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.incomingCalls(params.callHierarchyItem);
						break;
					case "outgoingCalls":
						if (!params.callHierarchyItem) {
							return {
								content: [
									{
										type: "text" as const,
										text: "callHierarchyItem parameter required for outgoingCalls",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.outgoingCalls(params.callHierarchyItem);
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
	let cachedProjectIndex: ProjectIndex | null = null; // similarity index for pre-write checks
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

	pi.on("session_start", async (_event, ctx) => {
		try {
			_verbose = !!pi.getFlag("lens-verbose");
			dbg("session_start fired");

			// Reset session state
			metricsClient.reset();
			complexityBaselines.clear();
			resetDispatchBaselines();
			cachedExports.clear();
			cachedProjectIndex = null;

			// Reset LSP service so the new session starts with fresh diagnostics.
			// Without this, stale cascade errors from a previous session persist
			// if the extension module stayed hot between reloads.
			if (pi.getFlag("lens-lsp")) {
				resetLSPService();
				dbg("session_start: LSP service reset");
			}

			// Log available tools without triggering startup installs.
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

			// Clean up stale TypeScript build caches before LSP starts.
			// tsconfig.tsbuildinfo caches the full file list from the last build.
			// If files have been deleted since then, the LSP reads the stale list
			// and reports phantom "Cannot find module" cascade errors for files
			// the agent never touched.
			if (pi.getFlag("lens-lsp")) {
				const cleaned = cleanStaleTsBuildInfo(ctx.cwd ?? process.cwd());
				if (cleaned.length > 0) {
					ctx.ui.notify(
						`🧹 Deleted stale TypeScript build cache (${cleaned.map((f) => path.basename(f)).join(", ")}) — phantom errors suppressed.`,
						"info",
					);
					dbg(
						`session_start: cleaned stale tsbuildinfo: ${cleaned.join(", ")}`,
					);
				}
			}

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
			const startupScan = resolveStartupScanContext(cwd);
			const scanRoot = startupScan.projectRoot ?? cwd;
			projectRoot = scanRoot; // Module-level for architect client
			dbg(`session_start cwd: ${cwd}`);
			dbg(
				`session_start scan root: ${scanRoot} (warmCaches=${startupScan.canWarmCaches}${startupScan.reason ? `, reason=${startupScan.reason}` : ""})`,
			);

			// Load architect rules if present
			const hasArchitectRules = architectClient.loadConfig(scanRoot);
			if (hasArchitectRules) tools.push("Architect rules");

			// Log test runner if detected
			const detectedRunner = startupScan.projectRoot
				? testRunnerClient.detectRunner(scanRoot)
				: null;
			if (detectedRunner) {
				tools.push(`Test runner (${detectedRunner.runner})`);
			}
			if (goClient.isGoAvailable()) tools.push("Go (go vet)");
			if (rustClient.isAvailable()) tools.push("Rust (cargo)");
			log(`Active tools: ${tools.join(", ")}`);
			dbg(`session_start tools: ${tools.join(", ")}`);

			// --- Condensed skill guidance for efficient tool selection ---
			// Full skills available at skills/ast-grep/SKILL.md and skills/lsp-navigation/SKILL.md
			const condensedGuidance =
				"## Code Tool Selection\n- Navigation (definitions, references): lsp_navigation\n- Pattern search (functions, imports): ast_grep_search\n- Text/TODOs: grep\n- Full guides: skills/ast-grep, skills/lsp-navigation";

			const parts: string[] = [];

			// --- Error ownership reminder ---
			// Shown on every session start to encourage fixing existing errors
			parts.push(
				"📌 Remember: If you find ANY errors (test failures, compile errors, lint issues) in this codebase, fix them — even if you didn't cause them. Don't skip errors as 'not my fault'.",
			);

			// Add condensed skill guidance to system message
			parts.push(condensedGuidance);

			if (startupScan.projectRoot) {
				// Scan for project-specific rules (.claude/rules, .agents/rules, CLAUDE.md, etc.)
				projectRulesScan = scanProjectRules(scanRoot);
				if (projectRulesScan.hasCustomRules) {
					const ruleCount = projectRulesScan.rules.length;
					const sources = [
						...new Set(projectRulesScan.rules.map((r) => r.source)),
					];
					dbg(
						`session_start: found ${ruleCount} project rule(s) from ${sources.join(", ")}`,
					);
					parts.push(
						`📋 Project rules found: ${ruleCount} file(s) in ${sources.join(", ")}. These apply alongside pi-lens defaults.`,
					);
				} else {
					dbg("session_start: no project rules found");
				}
			} else {
				projectRulesScan = { rules: [], hasCustomRules: false };
			}

			if (startupScan.canWarmCaches) {
				const todoResult = todoScanner.scanDirectory(scanRoot);
				dbg(`session_start TODO scan: ${todoResult.items.length} items`);

				if (knipClient.isAvailable()) {
					const cached = cacheManager.readCache<
						ReturnType<KnipClient["analyze"]>
					>("knip", scanRoot);
					if (cached) {
						dbg(
							`session_start Knip: cache hit (${Math.round((Date.now() - new Date(cached.meta.timestamp).getTime()) / 1000)}s ago)`,
						);
					} else {
						const startMs = Date.now();
						const knipResult = knipClient.analyze(scanRoot);
						cacheManager.writeCache("knip", knipResult, scanRoot, {
							scanDurationMs: Date.now() - startMs,
						});
						dbg(`session_start Knip scan done`);
					}
				} else {
					dbg(`session_start Knip: not available`);
				}

				if (jscpdClient.isAvailable()) {
					const cached = cacheManager.readCache<ReturnType<JscpdClient["scan"]>>(
						"jscpd",
						scanRoot,
					);
					if (cached) {
						dbg(`session_start jscpd: cache hit`);
						_cachedJscpdClones = cached.data.clones;
					} else {
						const startMs = Date.now();
						const jscpdResult = jscpdClient.scan(scanRoot);
						_cachedJscpdClones = jscpdResult.clones;
						cacheManager.writeCache("jscpd", jscpdResult, scanRoot, {
							scanDurationMs: Date.now() - startMs,
						});
						dbg(`session_start jscpd scan done`);
					}
				} else {
					dbg(`session_start jscpd: not available`);
				}

				if (astGrepClient.isAvailable()) {
					const exports = await astGrepClient.scanExports(scanRoot, "typescript");
					dbg(`session_start exports scan: ${exports.size} functions found`);
					for (const [name, file] of exports) {
						cachedExports.set(name, file);
					}
				}

				try {
					const existing = await loadIndex(scanRoot);
					if (
						existing &&
						existing.entries.size > 0 &&
						(await isIndexFresh(scanRoot))
					) {
						cachedProjectIndex = existing;
						dbg(
							`session_start: loaded fresh project index from disk (${existing.entries.size} entries)`,
						);
					} else {
						const sourceFiles = getSourceFiles(scanRoot, true);
						const tsFiles = sourceFiles.filter(
							(f) => f.endsWith(".ts") || f.endsWith(".tsx"),
						);
						if (tsFiles.length > 0 && tsFiles.length <= 500) {
							cachedProjectIndex = await buildProjectIndex(scanRoot, tsFiles);
							await saveIndex(cachedProjectIndex, scanRoot);
							dbg(
								`session_start: built project index (${cachedProjectIndex.entries.size} entries from ${tsFiles.length} files)`,
							);
						} else {
							dbg(
								`session_start: skipped project index (${tsFiles.length} files — ${tsFiles.length === 0 ? "none" : "too many"})`,
							);
						}
					}
				} catch (err) {
					dbg(`session_start: project index build failed: ${err}`);
				}
			} else {
				dbg(
					`session_start: skipped heavy startup scans (${startupScan.reason ?? "unknown"})`,
				);
				if (startupScan.reason === "home-dir" || startupScan.reason === "no-project-root") {
					parts.push(
						"⚡ Skipping heavy startup scans until pi-lens detects a real project root. On-demand commands still work.",
					);
				} else if (startupScan.reason === "too-many-source-files") {
					parts.push(
						`⚡ Skipping heavy startup scans for this project because it exceeds the eager startup source-file budget (${startupScan.sourceFileCount ?? "many"} files).`,
					);
				}
			}

			dbg(
				`session_start: scans complete (${parts.length} part(s)), cached for commands`,
			);

			if (parts.length > 0) {
				for (const part of parts) {
					ctx.ui.notify(part, "info");
				}
			}

			// --- Error debt: check if tests ran since last session ---
			// If files were modified in previous turn, run tests and check for regression
			const errorDebtEnabled = pi.getFlag("error-debt");
			const pendingDebt = startupScan.projectRoot
				? cacheManager.readCache<{
					pendingCheck: boolean;
					baselineTestsPassed: boolean;
				}>("errorDebt", scanRoot)
				: null;

			if (
				errorDebtEnabled &&
				startupScan.canWarmCaches &&
				startupScan.projectRoot &&
				detectedRunner &&
				pendingDebt?.data?.pendingCheck
			) {
				dbg("session_start: running pending error debt check");
				const testResult = testRunnerClient.runTestFile(
					".",
					scanRoot,
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
			} else if (
				errorDebtEnabled &&
				startupScan.canWarmCaches &&
				startupScan.projectRoot &&
				detectedRunner
			) {
				// No pending check - establish fresh baseline
				dbg("session_start: establishing fresh error debt baseline");
				const testResult = testRunnerClient.runTestFile(
					".",
					scanRoot,
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
		} catch (sessionErr) {
			dbg(`session_start crashed: ${sessionErr}`);
			dbg(`session_start crash stack: ${(sessionErr as Error).stack}`);
		}
	});

	pi.on("tool_call", async (event, _ctx) => {
		const filePath =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event)
				? (event.input as { path: string }).path
				: undefined;

		if (!filePath) return;

		dbg(
			`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
		);
		if (!nodeFs.existsSync(filePath)) return;

		// Record complexity baseline for historical tracking (booboo/tdi).
		// Not shown inline — just captured for delta analysis.
		if (
			complexityClient.isSupportedFile(filePath) &&
			!complexityBaselines.has(filePath)
		) {
			const baseline = complexityClient.analyzeFile(filePath);
			if (baseline) {
				complexityBaselines.set(filePath, baseline);
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
		if (isToolCallEventType("write", event) && cachedExports.size > 0) {
			const newContent = (event.input as { content?: string }).content;
			if (newContent) {
				const dupeWarnings: string[] = [];
				const exportRe =
					/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
				let m: RegExpExecArray | null;
				while ((m = exportRe.exec(newContent))) {
					const name = m[1];
					const existingFile = cachedExports.get(name);
					if (
						existingFile &&
						path.resolve(existingFile) !== path.resolve(filePath)
					) {
						dupeWarnings.push(
							`\`${name}\` already exists in ${path.relative(projectRoot, existingFile)}`,
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
					cachedProjectIndex &&
					cachedProjectIndex.entries.size > 0 &&
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
						const newFunctions = extractFunctions(sourceFile, newContent);
						const simWarnings: string[] = [];
						const relPath = path.relative(projectRoot, filePath);

						for (const func of newFunctions) {
							if (func.transitionCount < 20) continue;
							const matches = findSimilarFunctions(
								func.matrix,
								cachedProjectIndex,
								0.8,
								1,
							);
							for (const match of matches) {
								// Skip self-matches
								if (match.targetId === `${relPath}:${func.name}`) continue;
								const pct = Math.round(match.similarity * 100);
								simWarnings.push(
									`\`${func.name}\` is ${pct}% similar to \`${match.targetName}\` in ${match.targetLocation}`,
								);
							}
						}

						if (simWarnings.length > 0) {
							return {
								block: false,
								reason: `⚠️ Structural similarity detected — consider reusing existing code:\n${simWarnings.map((w) => `  • ${w}`).join("\n")}`,
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
	pi.on("tool_result", async (event) => {
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
		const toolResultStart = Date.now();
		dbg(
			`tool_result: tracking turn state for ${event.toolName} on ${filePath}`,
		);

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

		const turnStateMs = Date.now() - toolResultStart;
		logLatency({
			type: "phase",
			toolName: event.toolName,
			filePath,
			phase: "turn_state_tracking",
			durationMs: turnStateMs,
		});
		dbg(`tool_result fired for: ${filePath} (turn_state: ${turnStateMs}ms)`);

		let result: { output: string; isError?: boolean };
		try {
			result = await runPipeline(
				{
					filePath,
					cwd: projectRoot,
					toolName: event.toolName,
					getFlag: (name: string) => pi.getFlag(name),
					dbg,
				},
				{
					biomeClient,
					ruffClient,
					testRunnerClient,
					metricsClient,
					getFormatService,
					fixedThisTurn,
				},
			);
		} catch (pipelineErr) {
			dbg(`runPipeline crashed: ${pipelineErr}`);
			dbg(`runPipeline crash stack: ${(pipelineErr as Error).stack}`);
			return;
		}

		// Secrets found — block immediately
		if (result.isError) {
			return {
				content: [
					...event.content,
					{ type: "text" as const, text: result.output },
				],
				isError: true,
			};
		}

		// Append behavior warnings
		let output = result.output;
		if (behaviorWarnings.length > 0) {
			output += `\n\n${agentBehaviorClient.formatWarnings(behaviorWarnings)}`;
		}

		const totalMs = Date.now() - toolResultStart;
		logLatency({
			type: "tool_result",
			toolName: event.toolName,
			filePath,
			durationMs: totalMs,
			result: output ? "completed" : "no_output",
		});

		if (!output) return;

		return {
			content: [...event.content, { type: "text" as const, text: output }],
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
		try {
			const cwd = ctx.cwd ?? process.cwd();
			const turnState = cacheManager.readTurnState(cwd);
			const files = Object.keys(turnState.files);

			if (files.length === 0) return;

			dbg(
				`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
			);

			// Max cycles guard — force through after N turns with unresolved issues
			if (cacheManager.isMaxCyclesExceeded(cwd)) {
				dbg(
					"turn_end: max cycles exceeded, clearing state and forcing through",
				);
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
		} catch (turnEndErr) {
			dbg(`turn_end crashed: ${turnEndErr}`);
			dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
		}
	});
}
