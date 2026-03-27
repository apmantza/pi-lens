import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ArchitectClient } from "./clients/architect-client.js";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { GoClient } from "./clients/go-client.js";
import { buildInterviewer } from "./clients/interviewer.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { captureSnapshot, captureSnapshots, getTrendSummary, formatTrendCell } from "./clients/metrics-history.js";
import { RuffClient } from "./clients/ruff-client.js";
import { RustClient } from "./clients/rust-client.js";
import { getSourceFiles } from "./clients/scan-utils.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeSafetyClient } from "./clients/type-safety-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";

import { handleBooboo } from "./commands/booboo.js";
import { handleFix } from "./commands/fix.js";
import { handleRefactor, initRefactorLoop } from "./commands/refactor.js";

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
	const typeSafetyClient = new TypeSafetyClient();
	const architectClient = new ArchitectClient();
	const goClient = new GoClient();
	const rustClient = new RustClient();

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

	let cachedJscpdClones: import("./clients/jscpd-client.js").DuplicateClone[] =
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

		// TODO/FIXME scan — fast, no deps
		const todoResult = todoScanner.scanDirectory(cwd);
		const todoReport = todoScanner.formatResult(todoResult);
		dbg(`session_start TODO scan: ${todoResult.items.length} items`);
		if (todoReport) parts.push(todoReport);

		// Dead code scan — only if knip is available
		if (knipClient.isAvailable()) {
			const knipResult = knipClient.analyze(cwd);
			const knipReport = knipClient.formatResult(knipResult);
			dbg(`session_start Knip scan done`);
			if (knipReport) parts.push(knipReport);
		} else {
			dbg(`session_start Knip: not available`);
		}

		// Duplicate code detection (cached for real-time feedback)
		if (jscpdClient.isAvailable()) {
			const jscpdResult = jscpdClient.scan(cwd);
			cachedJscpdClones = jscpdResult.clones;
			const jscpdReport = jscpdClient.formatResult(jscpdResult);
			dbg(`session_start jscpd scan done`);
			if (jscpdReport) parts.push(jscpdReport);
		} else {
			dbg(`session_start jscpd: not available`);
		}

		// TypeScript type coverage
		if (typeCoverageClient.isAvailable()) {
			const tcResult = typeCoverageClient.scan(cwd);
			const tcReport = typeCoverageClient.formatResult(tcResult);
			dbg(`session_start type-coverage scan done`);
			if (tcReport) parts.push(tcReport);
		} else {
			dbg(`session_start type-coverage: not available`);
		}

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
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const filePath = (event.input as { path?: string }).path;
		if (!filePath) return;

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

		// TypeScript LSP diagnostics
		if (!pi.getFlag("no-lsp") && tsClient.isTypeScriptFile(filePath)) {
			try {
				tsClient.updateFile(filePath, nodeFs.readFileSync(filePath, "utf-8"));
			} catch (err) {
				void err;
			}

			const diags = tsClient.getDiagnostics(filePath);
			if (diags.length > 0) {
				// Separate unused imports (TS6133, TS6196) from other diagnostics
				const unusedImports = diags.filter(
					(d) => d.code === 6133 || d.code === 6196,
				);
				const otherDiags = diags.filter(
					(d) => d.code !== 6133 && d.code !== 6196,
				);

				if (unusedImports.length > 0) {
					lspOutput += `\n\n🧹 Remove ${unusedImports.length} unused import(s) — they are dead code:\n`;
					for (const d of unusedImports.slice(0, 10)) {
						lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
					}
				}

				if (otherDiags.length > 0) {
					const errors = otherDiags.filter((d) => d.severity !== 2);
					const warnings = otherDiags.filter((d) => d.severity === 2);
					if (errors.length > 0) {
						lspOutput += `\n\n🔴 Fix ${errors.length} TypeScript error(s) — these must be resolved:\n`;
						for (const d of errors.slice(0, 10)) {
							lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
						}
					}
					if (warnings.length > 0) {
						lspOutput += `\n\n🟡 ${warnings.length} TypeScript warning(s) — address before moving on:\n`;
						for (const d of warnings.slice(0, 10)) {
							lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
						}
					}
				}
			}
		}

		// Python — Ruff linting + formatting
		if (!pi.getFlag("no-ruff") && ruffClient.isPythonFile(filePath)) {
			const diags = ruffClient.checkFile(filePath);
			const fmtReport = ruffClient.checkFormatting(filePath);
			const fixable = diags.filter((d) => d.fixable);
			const hasFormatIssues = !!fmtReport;

			if (pi.getFlag("autofix-ruff")) {
				// Apply fixes then re-check to show what remains
				let fixed = 0;
				let formatted = false;
				if (fixable.length > 0) {
					const fixResult = ruffClient.fixFile(filePath);
					if (fixResult.success && fixResult.changed)
						fixed = fixResult.fixed ?? fixable.length;
				}
				const fmtResult = ruffClient.formatFile(filePath);
				if (fmtResult.success && fmtResult.changed) formatted = true;

				if (fixed > 0 || formatted) {
					lspOutput += `\n\n[Ruff] Auto-fixed: ${fixed} lint issue(s)${formatted ? ", reformatted" : ""} — file updated on disk`;
					// Re-check remaining issues
					const remaining = ruffClient.checkFile(filePath);
					const remainingFmt = ruffClient.checkFormatting(filePath);
					if (remaining.length > 0 || remainingFmt) {
						lspOutput += `\n\n${ruffClient.formatDiagnostics(remaining)}`;
						if (remainingFmt) lspOutput += `\n\n${remainingFmt}`;
					} else {
						lspOutput += `\n\n[Ruff] ✓ All issues resolved`;
					}
				} else {
					if (diags.length > 0)
						lspOutput += `\n\n${ruffClient.formatDiagnostics(diags)}`;
					if (fmtReport) lspOutput += `\n\n${fmtReport}`;
				}
			} else {
				if (diags.length > 0)
					lspOutput += `\n\n🟠 Fix ${diags.length} Ruff issue(s):\n${ruffClient.formatDiagnostics(diags)}`;
				if (fmtReport) lspOutput += `\n\n${fmtReport}`;
				if (fixable.length > 0 || hasFormatIssues) {
					lspOutput += `\n  → Enable --autofix-ruff to auto-fix ${fixable.length} of these on every write`;
				}
			}
		}

		// Type safety checks (switch exhaustiveness, etc.)
		if (typeSafetyClient.isSupportedFile(filePath)) {
			const report = typeSafetyClient.analyzeFile(filePath);
			if (report && report.issues.length > 0) {
				const errors = report.issues.filter((i) => i.severity === "error");
				const warnings = report.issues.filter((i) => i.severity === "warning");
				if (errors.length > 0) {
					lspOutput += `\n\n🔴 STOP — ${errors.length} type safety violation(s). Fix before continuing:\n`;
					for (const issue of errors) {
						lspOutput += `  L${issue.line}: ${issue.message}\n`;
						lspOutput += `    → Add missing cases or add a default clause\n`;
					}
				}
				if (warnings.length > 0) {
					lspOutput += `\n\n🟡 ${warnings.length} type safety warning(s):\n`;
					for (const issue of warnings) {
						lspOutput += `  L${issue.line}: ${issue.message}\n`;
					}
				}
			}
		}

		// Architectural rule validation (post-write)
		if (architectClient.hasConfig() && nodeFs.existsSync(filePath)) {
			const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
			const content = nodeFs.readFileSync(filePath, "utf-8");
			const lineCount = content.split("\n").length;

			// Check for violations
			const violations = architectClient.checkFile(relPath, content);
			if (violations.length > 0) {
				lspOutput += `\n\n🔴 STOP — ${violations.length} architectural violation(s). Fix before continuing:\n`;
				for (const v of violations) {
					const lineStr = v.line ? `L${v.line}: ` : "";
					lspOutput += `  ${lineStr}${v.message}\n`;
				}
				lspOutput += `    → Refactor the code to comply with the project's architectural rules.\n`;
			}

			// Check file size limit — hard stop, file is too large to reason about
			const sizeViolation = architectClient.checkFileSize(relPath, lineCount);
			if (sizeViolation) {
				lspOutput += `\n\n🔴 STOP — Architectural Limit Exceeded:\n`;
				lspOutput += `  ${sizeViolation.message}\n`;
				lspOutput += `    → Split into smaller, focused modules before adding more code.\n`;
			}
		}

		// ast-grep structural analysis — delta mode (only show new violations)
		if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
			const after = astGrepClient.scanFile(filePath);
			const before = astGrepBaselines.get(filePath) ?? [];
			astGrepBaselines.set(filePath, after);

			// Update TDR metrics with current diagnostics
			const tdrEntries: import("./clients/metrics-client.js").TDREntry[] = after
				.filter((d) => d.ruleDescription?.grade !== undefined)
				.map((d) => {
					const desc = d.ruleDescription;
					return {
						category: d.rule,
						count: desc?.grade ?? 0,
						severity: d.severity === "error" ? "error" : "warning",
					};
				});
			metricsClient.updateTDR(filePath, tdrEntries);

			// Count by rule before/after
			const countBefore = new Map<string, number>();
			const countAfter = new Map<string, number>();
			for (const d of before)
				countBefore.set(d.rule, (countBefore.get(d.rule) ?? 0) + 1);
			for (const d of after)
				countAfter.set(d.rule, (countAfter.get(d.rule) ?? 0) + 1);

			// Find new/increased rules
			const newViolations: typeof after = [];
			for (const d of after) {
				const ruleBefore = countBefore.get(d.rule) ?? 0;
				const ruleAfter = countAfter.get(d.rule) ?? 0;
				if (
					ruleAfter > ruleBefore &&
					newViolations.filter((x) => x.rule === d.rule).length <
						ruleAfter - ruleBefore
				) {
					newViolations.push(d);
				}
			}

			// Find fixed rules
			const fixedRules: string[] = [];
			for (const [rule, n] of countBefore) {
				const after_n = countAfter.get(rule) ?? 0;
				if (after_n < n) fixedRules.push(`${rule} (-${n - after_n})`);
			}

			// Filter out skip-category rules — architectural, handled by /lens-refactor
			const actionableViolations = newViolations.filter(
				(v) => !SKIP_RULES.has(v.rule),
			);
			if (actionableViolations.length > 0) {
				const hasFixable = actionableViolations.some((v) => v.fix);
				lspOutput += `\n\n🔴 STOP — you introduced ${actionableViolations.length} new structural violation(s). Fix before continuing:\n`;
				lspOutput += astGrepClient.formatDiagnostics(actionableViolations);
				if (hasFixable)
					lspOutput += `\n  → Auto-fixable: check the hints above`;
			}
			if (fixedRules.length > 0) {
				lspOutput += `\n\n✅ ast-grep: fixed ${fixedRules.join(", ")}`;
			}
			if (after.length > 0 && actionableViolations.length > 0) {
				const actionableTotal = after.filter(
					(v) => !SKIP_RULES.has(v.rule),
				).length;
				if (actionableTotal > 0)
					lspOutput += `\n  (${actionableTotal} actionable remaining — skip-category rules omitted)`;
			}
		}

		// Biome: lint only — delta mode
		const biomeAvailable = biomeClient.isAvailable();
		if (
			!pi.getFlag("no-biome") &&
			biomeAvailable &&
			biomeClient.isSupportedFile(filePath)
		) {
			const allDiags = biomeClient.checkFile(filePath);
			const after = allDiags.filter(
				(d) => d.category === "lint" || d.severity === "error",
			);
			const before = biomeBaselines.get(filePath) ?? [];
			biomeBaselines.set(filePath, after);

			// Count by rule before/after
			const countBefore = new Map<string, number>();
			const countAfter = new Map<string, number>();
			const ruleKey = (d: (typeof after)[0]) => d.rule ?? d.message;
			for (const d of before)
				countBefore.set(ruleKey(d), (countBefore.get(ruleKey(d)) ?? 0) + 1);
			for (const d of after)
				countAfter.set(ruleKey(d), (countAfter.get(ruleKey(d)) ?? 0) + 1);

			const newDiags: typeof after = [];
			for (const d of after) {
				const key = ruleKey(d);
				const n_before = countBefore.get(key) ?? 0;
				const n_after = countAfter.get(key) ?? 0;
				if (
					n_after > n_before &&
					newDiags.filter((x) => ruleKey(x) === key).length < n_after - n_before
				) {
					newDiags.push(d);
				}
			}

			const fixedRules: string[] = [];
			for (const [rule, n] of countBefore) {
				const after_n = countAfter.get(rule) ?? 0;
				if (after_n < n) fixedRules.push(`${rule} (-${n - after_n})`);
			}

			if (pi.getFlag("autofix-biome") && after.length > 0) {
				const fixResult = biomeClient.fixFile(filePath);
				if (fixResult.success && fixResult.changed) {
					lspOutput += `\n\n[Biome] Auto-fixed ${fixResult.fixed} issue(s) — file updated on disk`;
					const remaining = biomeClient
						.checkFile(filePath)
						.filter((d) => d.category === "lint" || d.severity === "error");
					if (remaining.length > 0)
						lspOutput += `\n\n${biomeClient.formatDiagnostics(remaining, filePath)}`;
					else lspOutput += `\n\n[Biome] ✓ All issues resolved`;
				} else if (after.length > 0) {
					lspOutput += `\n\n${biomeClient.formatDiagnostics(after, filePath)}`;
				}
			} else if (newDiags.length > 0) {
				const fixable = newDiags.filter((d) => d.fixable);
				lspOutput += `\n\n🔴 STOP — you introduced ${newDiags.length} new Biome violation(s). Fix before continuing:\n`;
				lspOutput += biomeClient.formatDiagnostics(newDiags, filePath);
				if (fixable.length > 0)
					lspOutput += `\n  → Auto-fixable: \`npx @biomejs/biome check --write ${path.basename(filePath)}\``;
				if (fixedRules.length > 0) {
					lspOutput += `\n\n✅ Biome: fixed ${fixedRules.join(", ")}`;
				}
			} else if (fixedRules.length > 0) {
				lspOutput += `\n\n✅ Biome: fixed ${fixedRules.join(", ")}`;
			}
		}

		// Go — go vet diagnostics
		if (
			!pi.getFlag("no-go") &&
			goClient.isGoFile(filePath) &&
			goClient.isGoAvailable()
		) {
			const goDiags = goClient.checkFile(filePath);
			if (goDiags.length > 0) {
				lspOutput += `\n\n${goClient.formatDiagnostics(goDiags)}`;
			}
		}

		// Rust — cargo check diagnostics
		if (
			!pi.getFlag("no-rust") &&
			rustClient.isRustFile(filePath) &&
			rustClient.isAvailable()
		) {
			const cwd = process.cwd();
			const rustDiags = rustClient.checkFile(filePath, cwd);
			if (rustDiags.length > 0) {
				lspOutput += `\n\n${rustClient.formatDiagnostics(rustDiags)}`;
			}
		}

		// Test runner — run tests for the edited file
		if (!pi.getFlag("no-tests")) {
			const cwd = process.cwd();
			dbg(`  test runner: checking for tests for ${filePath}`);
			const detected = testRunnerClient.detectRunner(cwd);
			dbg(`  test runner: detected runner: ${detected?.runner || "none"}`);
			if (detected) {
				const testInfo = testRunnerClient.findTestFile(filePath, cwd);
				dbg(
					`  test runner: testInfo: ${testInfo ? testInfo.testFile : "none"}`,
				);
				if (testInfo) {
					dbg(`  test file found: ${testInfo.testFile} (${testInfo.runner})`);
					const testResult = testRunnerClient.runTestFile(
						testInfo.testFile,
						cwd,
						testInfo.runner,
						detected.config,
					);
					testResult.sourceFile = filePath;
					const testReport = testRunnerClient.formatResult(testResult);
					dbg(`  test report: ${testReport || "(empty)"}`);
					if (testReport) {
						lspOutput += `\n\n${testReport}`;
					}
				}
			}
		}

		// Check for code duplication involving the edited file
		if (cachedJscpdClones.length > 0) {
			const fileClones = cachedJscpdClones.filter(
				(clone) =>
					path.resolve(clone.fileA) === path.resolve(filePath) ||
					path.resolve(clone.fileB) === path.resolve(filePath),
			);
			if (fileClones.length > 0) {
				dbg(`  jscpd: ${fileClones.length} duplicate(s) involving ${filePath}`);
				let dupReport = `🔴 STOP — this file has ${fileClones.length} duplicate block(s). Extract to a shared utility before adding more code:\n`;
				for (const clone of fileClones.slice(0, 3)) {
					const other =
						path.resolve(clone.fileA) === path.resolve(filePath)
							? `${path.basename(clone.fileB)}:${clone.startB}`
							: `${path.basename(clone.fileA)}:${clone.startA}`;
					dupReport += `  ${clone.lines} lines duplicated with ${other}\n`;
				}
				if (fileClones.length > 3) {
					dupReport += `  ... and ${fileClones.length - 3} more\n`;
				}
				lspOutput += `\n\n${dupReport}`;
			}
		}

		// Check for duplicate exports (function already exists elsewhere)
		if (cachedExports.size > 0 && /\.(ts|tsx|js|jsx)$/.test(filePath)) {
			try {
				const newExports = await astGrepClient.scanExports(
					filePath,
					"typescript",
				);
				const dupes: string[] = [];
				for (const [name, _file] of newExports) {
					if (cachedExports.has(name)) {
						const existingFile = cachedExports.get(name);
						if (
							existingFile &&
							path.resolve(existingFile) !== path.resolve(filePath)
						) {
							dupes.push(`${name} (already in ${path.basename(existingFile)})`);
						}
					}
				}
				if (dupes.length > 0) {
					dbg(`  duplicate exports: ${dupes.length} found`);
					let exportReport = `🔴 Do not redefine — ${dupes.length} function(s) already exist elsewhere:\n`;
					for (const dupe of dupes.slice(0, 5)) {
						exportReport += `  ${dupe}\n`;
					}
					exportReport += `  → Import the existing function instead\n`;
					lspOutput += `\n\n${exportReport}`;
				}
				// Update cache with new exports
				for (const [name, file] of newExports) {
					cachedExports.set(name, file);
				}
			} catch (err) {
				void err;
				// ast-grep not available, skip
			}
		}

		// Circular dependency check (cached, only when imports change)
		if (
			!pi.getFlag("no-madge") &&
			depChecker.isAvailable() &&
			/\.(ts|tsx|js|jsx)$/.test(filePath)
		) {
			const depResult = depChecker.checkFile(filePath);
			if (depResult.hasCircular && depResult.circular.length > 0) {
				const circularDeps = depResult.circular
					.flatMap((d) => d.path)
					.filter((p: string) => !filePath.endsWith(path.basename(p)));
				const uniqueDeps = [...new Set(circularDeps)];
				if (uniqueDeps.length > 0) {
					lspOutput += `\n\n${depChecker.formatWarning(filePath, uniqueDeps)}`;
				}
			}
		}

		if (!lspOutput) return;

		return {
			content: [...event.content, { type: "text" as const, text: lspOutput }],
		};
	});
}
