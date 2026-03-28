import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { dispatchLint } from "./clients/dispatch/integration.js";
import { GoClient } from "./clients/go-client.js";
import { buildInterviewer } from "./clients/interviewer.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
import { MetricsClient } from "./clients/metrics-client.js";
import {
	captureSnapshot,
	captureSnapshots,
	formatTrendCell,
	getTrendSummary,
} from "./clients/metrics-history.js";
import { RuffClient } from "./clients/ruff-client.js";
import { RustClient } from "./clients/rust-client.js";
import { getSourceFiles } from "./clients/scan-utils.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";
import { handleBooboo } from "./commands/booboo.js";
import { handleFix } from "./commands/fix.js";
import { handleRefactor, initRefactorLoop } from "./commands/refactor.js";

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

	// --- Initialize auto-loops (must be early for event handlers) ---
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

	pi.registerFlag("autofix-biome", {
		description:
			"Auto-fix Biome lint/format issues on write (applies --write --unsafe)",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("autofix-ruff", {
		description: "Auto-fix Ruff lint/format issues on write",
		type: "boolean",
		default: true,
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

	// --- Rule action map for lens-booboo-fix ---
	// Rules marked "skip" are architectural — they need deliberate user decisions.
	// They are excluded from inline tool_result hard stops (use /lens-refactor instead).
	const RULE_ACTIONS: Record<
		string,
		{ type: "biome" | "agent" | "skip"; note: string }
	> = {
		"no-lonely-if": { type: "biome", note: "auto-fixed by Biome --write" },
		"empty-catch": {
			type: "agent",
			note: "Add this.log('Error: ' + err.message) to the catch block",
		},
		"no-console-log": {
			type: "agent",
			note: "Remove or replace with class logger method",
		},
		"no-debugger": { type: "agent", note: "Remove the debugger statement" },
		"no-return-await": {
			type: "agent",
			note: "Remove the unnecessary `return await`",
		},
		"nested-ternary": {
			type: "agent",
			note: "Extract to if/else or a named variable",
		},
		"no-throw-string": {
			type: "agent",
			note: "Wrap in `new Error(...)` instead of throwing a string",
		},
		"no-star-imports": {
			type: "skip",
			note: "Requires knowing which exports are actually used.",
		},
		"no-as-any": {
			type: "skip",
			note: "Replacing `as any` requires knowing the correct type.",
		},
		"no-non-null-assertion": {
			type: "skip",
			note: "Each `!` needs nullability analysis in context.",
		},
		"large-class": {
			type: "skip",
			note: "Splitting a class requires architectural decisions.",
		},
		"long-method": {
			type: "skip",
			note: "Extraction requires understanding the function's purpose.",
		},
		"long-parameter-list": {
			type: "skip",
			note: "Redesigning the signature requires an API decision.",
		},
		"no-shadow": {
			type: "skip",
			note: "Renaming requires understanding all variable scopes.",
		},
		"no-process-env": {
			type: "skip",
			note: "Using process.env directly makes code untestable. Use DI or a config module.",
		},
		"no-param-reassign": {
			type: "agent",
			note: "Create a new variable instead of reassigning the parameter.",
		},
		"no-single-char-var": {
			type: "skip",
			note: "Renaming requires understanding the variable's purpose.",
		},
		"switch-without-default": {
			type: "agent",
			note: "Add a default case to handle unexpected values.",
		},
		"no-architecture-violation": {
			type: "skip",
			note: "Layer boundary violations require architectural decisions.",
		},
		"switch-exhaustiveness": {
			type: "agent",
			note: "Add the missing case(s) or a default clause to handle all union values.",
		},
	};

	// Derived from RULE_ACTIONS — used to suppress architectural rules from inline hard stops.
	const SKIP_RULES = new Set(
		Object.entries(RULE_ACTIONS)
			.filter(([, v]) => v.type === "skip")
			.map(([k]) => k),
	);

	pi.registerCommand("lens-booboo-fix", {
		description:
			"Iterative fix loop: auto-fixes Biome/Ruff, then generates a per-issue plan for agent to execute. Run repeatedly until clean. Usage: /lens-booboo-fix [path] [--reset]",
		handler: (args, ctx) =>
			handleFix(
				args,
				ctx,
				{
					tsClient,
					astGrep: astGrepClient,
					ruff: ruffClient,
					biome: biomeClient,
					knip: knipClient,
					jscpd: jscpdClient,
					complexity: complexityClient,
				},
				pi,
				RULE_ACTIONS,
			),
	});

	pi.registerCommand("lens-booboo-refactor", {
		description:
			"Interactive architectural refactor: scans for worst offender, opens a browser interview with options + recommendation, then steers the agent with your decision. Usage: /lens-booboo-refactor [path]",
		handler: (args, ctx) =>
			handleRefactor(
				args,
				ctx,
				{
					astGrep: astGrepClient,
					complexity: complexityClient,
					architect: architectClient,
				},
				pi,
				SKIP_RULES,
				RULE_ACTIONS,
			),
	});

	pi.registerCommand("lens-metrics", {
		description:
			"Measure complexity metrics for all files and export to report.md. Usage: /lens-metrics [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("📊 Measuring code metrics...", "info");

			const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19);
			const projectName = path.basename(process.cwd());

			const results: import("./clients/complexity-client.js").FileComplexity[] =
				[];

			const isTsProject = nodeFs.existsSync(
				path.join(targetPath, "tsconfig.json"),
			);
			const files = getSourceFiles(targetPath, isTsProject);
			for (const fullPath of files) {
				if (complexityClient.isSupportedFile(fullPath)) {
					const metrics = complexityClient.analyzeFile(fullPath);
					if (metrics) {
						results.push(metrics);
					}
				}
			}

			if (results.length === 0) {
				ctx.ui.notify("No supported files found to analyze", "warning");
				return;
			}

			// Calculate aggregates
			const avgMI =
				results.reduce((a, b) => a + b.maintainabilityIndex, 0) /
				results.length;
			const avgCognitive =
				results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
			const avgCyclomatic =
				results.reduce((a, b) => a + b.cyclomaticComplexity, 0) /
				results.length;
			const avgFunctionLength =
				results.reduce((a, b) => a + b.avgFunctionLength, 0) / results.length;
			const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
			const maxCognitive = Math.max(
				...results.map((r) => r.cognitiveComplexity),
			);
			const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));
			const totalFunctions = results.reduce((a, b) => a + b.functionCount, 0);
			const totalLOC = results.reduce((a, b) => a + b.linesOfCode, 0);

			// Grade distribution
			const grades = results.map((r) => {
				const mi = r.maintainabilityIndex;
				if (mi >= 80) return { letter: "A", color: "🟢" };
				if (mi >= 60) return { letter: "B", color: "🟡" };
				if (mi >= 40) return { letter: "C", color: "🟠" };
				if (mi >= 20) return { letter: "D", color: "🔴" };
				return { letter: "F", color: "⚫" };
			});

			const gradeCount = { A: 0, B: 0, C: 0, D: 0, F: 0 };
			for (const g of grades) {
				gradeCount[g.letter as keyof typeof gradeCount]++;
			}

			// Capture snapshots for history tracking
			const history = captureSnapshots(
				results.map((r) => ({
					filePath: r.filePath,
					metrics: {
						maintainabilityIndex: r.maintainabilityIndex,
						cognitiveComplexity: r.cognitiveComplexity,
						maxNestingDepth: r.maxNestingDepth,
						linesOfCode: r.linesOfCode,
					},
				})),
			);

			// Build report
			let report = `# Code Metrics Report: ${projectName}\n\n`;
			report += `**Generated:** ${new Date().toISOString()}\n\n`;
			report += `**Path:** \`${targetPath}\`\n\n`;
			report += `---\n\n`;

			// AI slop aggregates
			const totalAISlopWarnings = results.reduce((a, b) => {
				return a + complexityClient.checkThresholds(b).length;
			}, 0);
			const totalEmojiComments = results.reduce(
				(a, b) => a + b.aiCommentPatterns,
				0,
			);
			const totalTryCatch = results.reduce((a, b) => a + b.tryCatchCount, 0);
			const totalSingleUse = results.reduce(
				(a, b) => a + b.singleUseFunctions,
				0,
			);
			const maxParams = Math.max(...results.map((r) => r.maxParamsInFunction));

			// Summary
			report += `## Summary\n\n`;
			report += `| Metric | Value |\n`;
			report += `|--------|-------|\n`;
			report += `| Files Analyzed | ${results.length} |\n`;
			report += `| Total Functions | ${totalFunctions} |\n`;
			report += `| Total Lines of Code | ${totalLOC.toLocaleString()} |\n`;
			report += `| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n`;
			report += `| Min Maintainability Index | ${minMI.toFixed(1)} |\n`;
			report += `| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n`;
			report += `| Max Cognitive Complexity | ${maxCognitive} |\n`;
			report += `| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n`;
			report += `| Max Nesting Depth | ${maxNesting} |\n`;
			report += `| Avg Function Length | ${avgFunctionLength.toFixed(1)} lines |\n\n`;

			// AI Slop Summary
			report += `## AI Slop Indicators (Aggregate)\n\n`;
			report += `| Indicator | Count |\n`;
			report += `|-----------|-------|\n`;
			report += `| Total Warnings | ${totalAISlopWarnings} |\n`;
			report += `| Emoji/Boilerplate Comments | ${totalEmojiComments} |\n`;
			report += `| Try/Catch Blocks | ${totalTryCatch} |\n`;
			report += `| Single-Use Helper Functions | ${totalSingleUse} |\n`;
			report += `| Max Function Parameters | ${maxParams} |\n\n`;

			// Grade distribution
			report += `## Maintainability Grade Distribution\n\n`;
			report += `| Grade | Count | Percentage |\n`;
			report += `|-------|-------|------------|\n`;
			for (const [grade, count] of Object.entries(gradeCount)) {
				const pct = ((count / results.length) * 100).toFixed(1);
				const gradeIcons: Record<string, string> = {
					A: "🟢",
					B: "🟡",
					C: "🟠",
					D: "🔴",
				};
				const gradeThresholds: Record<string, number> = {
					A: 80,
					B: 60,
					C: 40,
					D: 20,
				};
				const icon = gradeIcons[grade] ?? "⚫";
				const threshold = gradeThresholds[grade] ?? 0;
				report += `| ${icon} ${grade} (MI ≥ ${threshold}) | ${count} | ${pct}% |\n`;
			}
			report += `\n`;

			// All files table (sorted by MI ascending)
			report += `## All Files\n\n`;
			report += `| Grade | File | MI | Cognitive | LOC | Entropy | Trend |\n`;
			report += `|-------|------|-----|-----------|-----|---------|-------|\n`;

			const sorted = [...results].sort(
				(a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
			);
			for (const f of sorted) {
				const mi = f.maintainabilityIndex;
				let grade: string;
				if (mi >= 80) grade = "🟢 A";
				else if (mi >= 60) grade = "🟡 B";
				else if (mi >= 40) grade = "🟠 C";
				else if (mi >= 20) grade = "🔴 D";
				else grade = "⚫ F";

				// Make path relative for readability
				const relPath = path.relative(targetPath, f.filePath);
				const trendCell = formatTrendCell(f.filePath, history);
				const entropyCell = f.codeEntropy > 0 ? f.codeEntropy.toFixed(2) : "—";

				report += `| ${grade} | ${relPath} | ${mi.toFixed(1)} | ${f.cognitiveComplexity} | ${f.linesOfCode} | ${entropyCell} | ${trendCell} |\n`;
			}
			report += `\n`;

			// Trend Summary
			const trendSummary = getTrendSummary(history);
			report += `## Trend Summary\n\n`;
			report += `| Trend | Count |\n`;
			report += `|-------|-------|\n`;
			report += `| 📈 Improving | ${trendSummary.improving} |\n`;
			report += `| ➡️ Stable | ${trendSummary.stable} |\n`;
			report += `| 📉 Regressing | ${trendSummary.regressing} |\n\n`;

			if (trendSummary.worstRegressions.length > 0) {
				report += `### Top Regressions\n\n`;
				report += `Files with largest MI decline since last scan:\n\n`;
				for (const r of trendSummary.worstRegressions) {
					report += `- **${r.file}**: MI ${r.miDelta > 0 ? "+" : ""}${r.miDelta}\n`;
				}
				report += `\n`;
			}

			// Top 10 worst files (actionable)
			report += `## Top 10 Files Needing Attention\n\n`;
			report += `These files have the lowest maintainability scores:\n\n`;
			for (let i = 0; i < Math.min(10, sorted.length); i++) {
				const f = sorted[i];
				const relPath = path.relative(targetPath, f.filePath);
				const warnings: string[] = [];

				if (f.maintainabilityIndex < 20) warnings.push("🔴 Critical: MI < 20");
				else if (f.maintainabilityIndex < 40) warnings.push("🟠 Low: MI < 40");
				if (f.cognitiveComplexity > 50)
					warnings.push(`High cognitive (${f.cognitiveComplexity})`);
				if (f.maxNestingDepth > 5)
					warnings.push(`Deep nesting (${f.maxNestingDepth})`);
				if (f.maxFunctionLength > 50)
					warnings.push(`Long functions (max ${f.maxFunctionLength})`);

				// AI slop indicators
				const slopWarnings = complexityClient.checkThresholds(f);
				for (const w of slopWarnings) {
					if (
						w.includes("AI-style") ||
						w.includes("try/catch") ||
						w.includes("single-use") ||
						w.includes("parameter list")
					) {
						warnings.push(`🤖 ${w.split(" — ")[0]}`);
					}
				}

				report += `${i + 1}. **${relPath}** — MI: ${f.maintainabilityIndex.toFixed(1)}\n`;
				if (warnings.length > 0) {
					report += `   - ${warnings.join(", ")}\n`;
				}
			}
			report += `\n`;

			// Save report
			nodeFs.mkdirSync(reviewDir, { recursive: true });

			const reportPath = path.join(reviewDir, `metrics-${timestamp}.md`);
			nodeFs.writeFileSync(reportPath, report, "utf-8");

			// Also save latest.md for easy access
			const latestPath = path.join(reviewDir, "latest.md");
			nodeFs.writeFileSync(latestPath, report, "utf-8");

			// Console summary
			const summary = [
				`📊 Metrics Report`,
				`   ${results.length} files, ${totalLOC.toLocaleString()} LOC, ${totalFunctions} functions`,
				`   MI: ${avgMI.toFixed(1)} avg (${gradeCount.A}A ${gradeCount.B}B ${gradeCount.C}C ${gradeCount.D}D ${gradeCount.F}F)`,
				`   Cognitive: ${avgCognitive.toFixed(1)} avg, ${maxCognitive} max`,
				`📄 Saved: ${reportPath}`,
			].join("\n");

			ctx.ui.notify(summary, "info");
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
			"Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search. Examples:\n- Find function: 'function $NAME() { $$$BODY }'\n- Find call: 'fetchMetrics($ARGS)'\n- Find import: 'import { $NAMES } from \"$PATH\"'\n- Generic identifier (broad): 'fetchMetrics'\n\nAlways prefer specific patterns with context over bare identifiers. Use 'paths' to scope to specific files/folders.",
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

			const { pattern, lang, paths } = params as {
				pattern: string;
				lang: string;
				paths?: string[];
			};
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.search(pattern, lang, searchPaths);

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
			let output = astGrepClient.formatMatches(result.matches, isDryRun);
			if (isDryRun && result.matches.length > 0)
				output += "\n\n(Dry run - use apply=true to apply)";
			if (apply && result.matches.length > 0)
				output = `Applied ${result.matches.length} replacements:\n${output}`;

			return {
				content: [{ type: "text", text: output }],
				details: { matchCount: result.matches.length, applied: apply ?? false },
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
	const astGrepBaselines = new Map<
		string,
		import("./clients/ast-grep-client.js").AstGrepDiagnostic[]
	>();
	const biomeBaselines = new Map<
		string,
		import("./clients/biome-client.js").BiomeDiagnostic[]
	>();

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		_verbose = !!pi.getFlag("lens-verbose");
		dbg("session_start fired");

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

		// TODO/FIXME scan — fast, no deps
		const todoResult = todoScanner.scanDirectory(cwd);
		const todoReport = todoScanner.formatResult(todoResult);
		dbg(`session_start TODO scan: ${todoResult.items.length} items`);
		if (todoReport) parts.push(todoReport);

		// Dead code scan — use cache if fresh
		if (knipClient.isAvailable()) {
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

		// Duplicate code detection — use cache if fresh
		if (jscpdClient.isAvailable()) {
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
		if (astGrepClient.isAvailable()) {
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

		dbg(
			`tool_call fired for: ${filePath} (exists: ${nodeFs.existsSync(filePath)})`,
		);
		if (!nodeFs.existsSync(filePath)) return;

		// Record complexity baseline for TS/JS files + capture history snapshot
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
		}

		const hints: string[] = [];

		if (/\.(ts|tsx|js|jsx)$/.test(filePath) && !pi.getFlag("no-lsp")) {
			tsClient.updateFile(filePath, nodeFs.readFileSync(filePath, "utf-8"));
			const diags = tsClient.getDiagnostics(filePath);
			if (diags.length > 0) {
				hints.push(
					`⚠ Pre-write: file already has ${diags.length} TypeScript error(s) — fix before adding more`,
				);
			}
		}

		// Snapshot baselines for delta mode (no pre-write hints — delta handles it)
		if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
			const baselineDiags = astGrepClient.scanFile(filePath);
			astGrepBaselines.set(filePath, baselineDiags);

			// Add to TDR baseline
			const initialTdr = baselineDiags
				.filter((d) => d.ruleDescription?.grade !== undefined)
				.reduce((acc, d) => acc + (d.ruleDescription?.grade ?? 0), 0);

			metricsClient.recordBaseline(filePath, initialTdr);
		} else {
			metricsClient.recordBaseline(filePath);
		}

		if (
			!pi.getFlag("no-biome") &&
			biomeClient.isAvailable() &&
			biomeClient.isSupportedFile(filePath)
		) {
			biomeBaselines.set(
				filePath,
				biomeClient
					.checkFile(filePath)
					.filter((d) => d.category === "lint" || d.severity === "error"),
			);
		}

		// Architectural rules pre-write hints
		if (architectClient.hasConfig()) {
			const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
			const archHints = architectClient.getHints(relPath);
			if (archHints.length > 0) {
				hints.push(`📐 Architectural rules for ${relPath}:`);
				for (const h of archHints) {
					hints.push(`  → ${h}`);
				}
			}
		}

		dbg(`  pre-write hints: ${hints.length} — ${hints.join(" | ") || "none"}`);
		if (hints.length > 0) {
			preWriteHints.set(filePath, hints.join("\n"));
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

		dbg(`tool_result fired for: ${filePath}`);
		dbg(`  cwd: ${process.cwd()}`);
		dbg(
			`  __dirname: ${typeof __dirname !== "undefined" ? __dirname : "undefined"}`,
		);

		// Prepend any pre-write hints collected during tool_call
		const preHint = preWriteHints.get(filePath);
		preWriteHints.delete(filePath);

		// Record write for metrics (silent tracking)

		try {
			const content = nodeFs.readFileSync(filePath, "utf-8");
			metricsClient.recordWrite(filePath, content);
		} catch (err) {
			void err;
		}

		let lspOutput = preHint ? `\n\n${preHint}` : "";

		// --- Declarative dispatch: run all applicable lint tools ---
		// Phase 2: Replaced ~400 lines of if/else with unified dispatch system
		dbg(`dispatch: running lint tools for ${filePath}`);
		const dispatchOutput = await dispatchLint(filePath, projectRoot, pi);
		if (dispatchOutput) {
			lspOutput += `\n\n${dispatchOutput}`;
		}

		// Agent behavior warnings (blind writes, thrashing)
		if (behaviorWarnings.length > 0) {
			lspOutput += `\n\n${agentBehaviorClient.formatWarnings(behaviorWarnings)}`;
		}

		if (!lspOutput) return;

		return {
			content: [...event.content, { type: "text" as const, text: lspOutput }],
		};
	});

	// --- Turn end: batch jscpd/madge on collected files, then clear state ---
	pi.on("turn_end", async (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const turnState = cacheManager.readTurnState(cwd);
		const files = Object.keys(turnState.files);

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
		if (depChecker.isAvailable()) {
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
	});
}
