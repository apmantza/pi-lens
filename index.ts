/**
 * pi-lens - Real-time code feedback for pi
 *
 * Provides real-time diagnostics on every write/edit:
 * - TypeScript/JavaScript: Biome (lint+format) + TypeScript LSP (type checking)
 * - Python: Ruff (lint+format)
 * - All languages: ast-grep (63 structural rules)
 * - JavaScript/TypeScript: Dependency checker (circular deps)
 *
 * Proactive hints before write/edit:
 * - Warns when target file already has existing violations
 *
	 * Auto-fix on write (enable with --autofix-ruff flag, Biome auto-fix disabled by default):
	 * - Biome: feedback only by default, use /lens-format to apply fixes
	 * - Ruff: applies --fix + format (lint + format fixes)
 *
 * On-demand commands:
 * - /lens-format - Apply Biome formatting
 * - /lens-todos - Scan for TODO/FIXME/HACK annotations
 * - /lens-dead-code - Find unused exports/dependencies (requires knip)
 * - /lens-deps - Full circular dependency scan (requires madge)
 *
 * External dependencies:
 * - npm: @biomejs/biome, @ast-grep/cli, knip, madge
 * - pip: ruff
 */

import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
import { RuffClient } from "./clients/ruff-client.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { GoClient } from "./clients/go-client.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { RustClient } from "./clients/rust-client.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";

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

function log(msg: string) {
	if (_verbose) console.log(`[pi-lens] ${msg}`);
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
	const goClient = new GoClient();
	const rustClient = new RustClient();

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

	pi.registerCommand("lens-todos", {
		description:
			"Scan for TODO/FIXME/HACK annotations. Usage: /lens-todos [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("🔍 Scanning for TODOs...", "info");

			const result = todoScanner.scanDirectory(targetPath);
			const report = todoScanner.formatResult(result);

			if (report) {
				ctx.ui.notify(report, "info");
			} else {
				ctx.ui.notify("✓ No TODOs found", "info");
			}
		},
	});

	pi.registerCommand("lens-dead-code", {
		description: "Check for unused exports, files, and dependencies. Usage: /lens-dead-code [path]",
		handler: async (args, ctx) => {
			if (!knipClient.isAvailable()) {
				ctx.ui.notify("Knip not installed. Run: npm install -D knip", "error");
				return;
			}

			ctx.ui.notify("🔍 Analyzing for dead code...", "info");
			const result = knipClient.analyze(args.trim() || ctx.cwd);
			const report = knipClient.formatResult(result);

			if (report) {
				ctx.ui.notify(report, "info");
			} else {
				ctx.ui.notify("✓ No dead code found", "info");
			}
		},
	});

	pi.registerCommand("lens-deps", {
		description: "Check for circular dependencies. Usage: /lens-deps [path]",
		handler: async (args, ctx) => {
			if (!depChecker.isAvailable()) {
				ctx.ui.notify(
					"Madge not installed. Run: npm install -D madge",
					"error",
				);
				return;
			}

			ctx.ui.notify("🔍 Scanning dependencies...", "info");
			const { circular } = depChecker.scanProject(args.trim() || ctx.cwd);
			const report = depChecker.formatScanResult(circular);

			if (report) {
				ctx.ui.notify(report, "warning");
			} else {
				ctx.ui.notify("✓ No circular dependencies found", "info");
			}
		},
	});

	pi.registerCommand("lens-booboo", {
		description:
			"Code review: design smells + complexity metrics. Usage: /lens-booboo [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("🔍 Running code review...", "info");

			const parts: string[] = [];

			// Part 1: Design smells via ast-grep
			if (astGrepClient.isAvailable()) {
				const configPath = path.join(
					typeof __dirname !== "undefined" ? __dirname : ".",
					"rules",
					"ast-grep-rules",
					".sgconfig.yml",
				);

				try {
					const result = require("node:child_process").spawnSync("npx", [
						"sg",
						"scan",
						"--config", configPath,
						"--json",
						targetPath,
					], {
						encoding: "utf-8",
						timeout: 30000,
						shell: true,
					});

					const output = result.stdout || result.stderr || "";
					if (output.trim() && result.status === 1) {
						let issues: Array<{line: number; rule: string; message: string}> = [];
						const lines = output.split("\n").filter((l: string) => l.trim());

						for (const line of lines) {
							try {
								const item = JSON.parse(line);
								const ruleId = item.ruleId || item.name || "unknown";
								const ruleDesc = astGrepClient.getRuleDescription?.(ruleId);
								const message = ruleDesc?.message || item.message || ruleId;
								const lineNum = item.labels?.[0]?.range?.start?.line ||
									item.spans?.[0]?.range?.start?.line || 0;

								issues.push({
									line: lineNum + 1,
									rule: ruleId,
									message: message,
								});
							} catch {
								// Skip unparseable lines
							}
						}

						if (issues.length > 0) {
							let report = `[Design Smells] ${issues.length} issue(s) found:\n`;
							for (const issue of issues.slice(0, 20)) {
								report += `  L${issue.line}: ${issue.rule} — ${issue.message}\n`;
							}
							if (issues.length > 20) {
								report += `  ... and ${issues.length - 20} more\n`;
							}
							parts.push(report);
						}
					}
				} catch (err: any) {
					// ast-grep scan failed, skip
				}
			}

			// Part 2: Similar functions (advanced duplicate detection)
			if (astGrepClient.isAvailable()) {
				const similarGroups = await astGrepClient.findSimilarFunctions(targetPath, "typescript");
				if (similarGroups.length > 0) {
					let report = `[Similar Functions] ${similarGroups.length} group(s) of structurally similar functions:\n`;
					for (const group of similarGroups.slice(0, 5)) {
						report += `  Pattern: ${group.functions.map(f => f.name).join(", ")}\n`;
						for (const fn of group.functions) {
							report += `    ${fn.name} (${path.basename(fn.file)}:${fn.line})\n`;
						}
					}
					if (similarGroups.length > 5) {
						report += `  ... and ${similarGroups.length - 5} more groups\n`;
					}
					parts.push(report);
				}
			}

			// Part 3: Complexity metrics
			const results: import("./clients/complexity-client.js").FileComplexity[] = [];

			const scanDir = (dir: string) => {
				if (!require("node:fs").existsSync(dir)) return;
				const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });

				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						if (["node_modules", ".git", "dist", "build", ".next", ".pi-lens"].includes(entry.name)) continue;
						scanDir(fullPath);
					} else if (complexityClient.isSupportedFile(fullPath)) {
						const metrics = complexityClient.analyzeFile(fullPath);
						if (metrics) {
							results.push(metrics);
						}
					}
				}
			};

			scanDir(targetPath);

			if (results.length > 0) {
				const avgMI = results.reduce((a, b) => a + b.maintainabilityIndex, 0) / results.length;
				const avgCognitive = results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
				const avgCyclomatic = results.reduce((a, b) => a + b.cyclomaticComplexity, 0) / results.length;
				const maxNesting = Math.max(...results.map(r => r.maxNestingDepth));

				const lowMI = results.filter(r => r.maintainabilityIndex < 60).sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
				const highCognitive = results.filter(r => r.cognitiveComplexity > 20).sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);

				let summary = `[Complexity] ${results.length} file(s) scanned\n`;
				summary += `  Maintainability: ${avgMI.toFixed(1)} avg | Cognitive: ${avgCognitive.toFixed(1)} avg | Max Nesting: ${maxNesting} levels\n`;

				if (lowMI.length > 0) {
					summary += `\n  Low Maintainability (MI < 60):\n`;
					for (const f of lowMI.slice(0, 5)) {
						summary += `    ✗ ${f.filePath}: MI ${f.maintainabilityIndex.toFixed(1)}\n`;
					}
					if (lowMI.length > 5) summary += `    ... and ${lowMI.length - 5} more\n`;
				}

				if (highCognitive.length > 0) {
					summary += `\n  High Cognitive Complexity (> 20):\n`;
					for (const f of highCognitive.slice(0, 5)) {
						summary += `    ⚠ ${f.filePath}: ${f.cognitiveComplexity}\n`;
					}
					if (highCognitive.length > 5) summary += `    ... and ${highCognitive.length - 5} more\n`;
				}

				parts.push(summary);
			}

			if (parts.length === 0) {
				ctx.ui.notify("✓ Code review clean", "info");
			} else {
				ctx.ui.notify(parts.join("\n\n"), "info");
			}
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

				const formatDir = (dir: string) => {
					if (!require("node:fs").existsSync(dir)) return;
					const entries = require("node:fs").readdirSync(dir, {
						withFileTypes: true,
					});

					for (const entry of entries) {
						const fullPath = path.join(dir, entry.name);
						if (entry.isDirectory()) {
							if (
								["node_modules", ".git", "dist", "build", ".next"].includes(
									entry.name,
								)
							)
								continue;
							formatDir(fullPath);
						} else if (/\.(ts|tsx|js|jsx|json|css)$/.test(entry.name)) {
							const result = biomeClient.formatFile(fullPath);
							if (result.changed) formatted++;
							else if (result.success) skipped++;
						}
					}
				};

				formatDir(ctx.cwd || process.cwd());
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
		"c", "cpp", "csharp", "css", "dart", "elixir", "go", "haskell", "html",
		"java", "javascript", "json", "kotlin", "lua", "php", "python", "ruby",
		"rust", "scala", "sql", "swift", "tsx", "typescript", "yaml",
	] as const;

	pi.registerTool({
		name: "ast_grep_search",
		label: "AST Search",
		description: "Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search. Examples:\n- Find function: 'function $NAME() { $$$BODY }'\n- Find call: 'fetchMetrics($ARGS)'\n- Find import: 'import { $NAMES } from \"$PATH\"'\n- Generic identifier (broad): 'fetchMetrics'\n\nAlways prefer specific patterns with context over bare identifiers. Use 'paths' to scope to specific files/folders.",
		promptSnippet: "Use ast_grep_search for AST-aware code search",
		parameters: Type.Object({
			pattern: Type.String({ description: "AST pattern (use function/class/call context, not text)" }),
			lang: Type.Union(LANGUAGES.map((l) => Type.Literal(l)), { description: "Target language" }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Specific files/folders to search" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!astGrepClient.isAvailable()) {
				return { content: [{ type: "text", text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli" }], isError: true, details: {} };
			}

			const { pattern, lang, paths } = params as { pattern: string; lang: string; paths?: string[] };
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.search(pattern, lang, searchPaths);

			if (result.error) {
				return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true, details: {} };
			}

			const output = astGrepClient.formatMatches(result.matches);
			return { content: [{ type: "text", text: output }], details: { matchCount: result.matches.length } };
		},
	});

	pi.registerTool({
		name: "ast_grep_replace",
		label: "AST Replace",
		description: "Replace code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, not text. Dry-run by default (use apply=true to apply).\n\nExamples:\n- pattern='console.log($MSG)' rewrite='logger.info($MSG)'\n- pattern='var $X' rewrite='let $X'\n- pattern='function $NAME() { }' rewrite='' (delete)\n\nAlways use 'paths' to scope to specific files/folders. Dry-run first to preview changes.",
		promptSnippet: "Use ast_grep_replace for AST-aware find-and-replace",
		parameters: Type.Object({
			pattern: Type.String({ description: "AST pattern to match (be specific with context)" }),
			rewrite: Type.String({ description: "Replacement using meta-variables from pattern" }),
			lang: Type.Union(LANGUAGES.map((l) => Type.Literal(l)), { description: "Target language" }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Specific files/folders" })),
			apply: Type.Optional(Type.Boolean({ description: "Apply changes (default: false)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!astGrepClient.isAvailable()) {
				return { content: [{ type: "text", text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli" }], isError: true, details: {} };
			}

			const { pattern, rewrite, lang, paths, apply } = params as { pattern: string; rewrite: string; lang: string; paths?: string[]; apply?: boolean };
			const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
			const result = await astGrepClient.replace(pattern, rewrite, lang, searchPaths, apply ?? false);

			if (result.error) {
				return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true, details: {} };
			}

			const isDryRun = !apply;
			let output = astGrepClient.formatMatches(result.matches, isDryRun);
			if (isDryRun && result.matches.length > 0) output += "\n\n(Dry run - use apply=true to apply)";
			if (apply && result.matches.length > 0) output = `Applied ${result.matches.length} replacements:\n${output}`;

			return { content: [{ type: "text", text: output }], details: { matchCount: result.matches.length, applied: apply ?? false } };
		},
	});

	// Delivered once into the first tool_result of the session, then cleared
	let sessionSummary: string | null = null;
	let sessionMetricsShown = false;
	let cachedJscpdClones: import("./clients/jscpd-client.js").DuplicateClone[] = [];
	let cachedExports = new Map<string, string>(); // function name -> file path
	const complexityBaselines: Map<string, import("./clients/complexity-client.js").FileComplexity> = new Map();

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		_verbose = !!pi.getFlag("lens-verbose");
		dbg("session_start fired");

		// Reset session state
		sessionMetricsShown = false;
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
		dbg(`session_start cwd: ${cwd}`);

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

		if (parts.length > 0) {
			sessionSummary = `[Session Start]\n${parts.join("\n\n")}`;
			dbg(`session_start summary queued (${parts.length} parts)`);
		} else {
			dbg(`session_start: no parts, no summary`);
		}
	});

	// --- Pre-write proactive hints ---
	// Stored during tool_call, prepended to tool_result output so the agent sees them.
	const preWriteHints = new Map<string, string>();

	pi.on("tool_call", async (event, _ctx) => {
		const filePath = isToolCallEventType("write", event)
			? (event.input as { path: string }).path
			: isToolCallEventType("edit", event)
				? (event.input as { path: string }).path
				: undefined;

		if (!filePath) return;

		const fs = require("node:fs") as typeof import("node:fs");
		dbg(
			`tool_call fired for: ${filePath} (exists: ${fs.existsSync(filePath)})`,
		);
		if (!fs.existsSync(filePath)) return;

		// Record baseline for metrics tracking
		metricsClient.recordBaseline(filePath);

		// Record complexity baseline for TS/JS files
		if (complexityClient.isSupportedFile(filePath) && !complexityBaselines.has(filePath)) {
			const baseline = complexityClient.analyzeFile(filePath);
			if (baseline) {
				complexityBaselines.set(filePath, baseline);
			}
		}

		const hints: string[] = [];

		if (/\.(ts|tsx|js|jsx)$/.test(filePath) && !pi.getFlag("no-lsp")) {
			tsClient.updateFile(filePath, fs.readFileSync(filePath, "utf-8"));
			const diags = tsClient.getDiagnostics(filePath);
			if (diags.length > 0) {
				hints.push(
					`⚠ Pre-write: file already has ${diags.length} TypeScript error(s) — fix before adding more`,
				);
			}
		}

		if (
			/\.(ts|tsx|js|jsx)$/.test(filePath) &&
			!pi.getFlag("no-biome") &&
			biomeClient.isAvailable()
		) {
			const diags = biomeClient.checkFile(filePath);
			if (diags.length > 0) {
				hints.push(
					`⚠ Pre-write: file already has ${diags.length} Biome issue(s)`,
				);
			}
		}

		if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
			const diags = astGrepClient.scanFile(filePath);
			if (diags.length > 0) {
				hints.push(
					`⚠ Pre-write: file already has ${diags.length} structural violations`,
				);
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

		// Deliver session-start summary (TODOs, dead code) once into the first tool_result
		const sessionDump = sessionSummary;
		sessionSummary = null;

		// Prepend any pre-write hints collected during tool_call
		const preHint = preWriteHints.get(filePath);
		preWriteHints.delete(filePath);

		// Record write for metrics (silent tracking)
		const fs = require("node:fs") as typeof import("node:fs");
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf-8");
			metricsClient.recordWrite(filePath, content);
		}

		let lspOutput = sessionDump ? `\n\n${sessionDump}` : "";
		if (preHint) lspOutput += `\n\n${preHint}`;

		// TypeScript LSP diagnostics
		if (!pi.getFlag("no-lsp") && tsClient.isTypeScriptFile(filePath)) {
			if (fs.existsSync(filePath)) {
				tsClient.updateFile(filePath, fs.readFileSync(filePath, "utf-8"));
			}

			const diags = tsClient.getDiagnostics(filePath);
			if (diags.length > 0) {
				lspOutput += `\n\n[TypeScript] ${diags.length} issue(s):\n`;
				for (const d of diags.slice(0, 10)) {
					const label = d.severity === 2 ? "Warning" : "Error";
					lspOutput += `  [${label}] L${d.range.start.line + 1}: ${d.message}\n`;
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
					lspOutput += `\n\n${ruffClient.formatDiagnostics(diags)}`;
				if (fmtReport) lspOutput += `\n\n${fmtReport}`;
				if (fixable.length > 0 || hasFormatIssues) {
					lspOutput += `\n\n[Ruff] ${fixable.length} fixable — enable --autofix-ruff flag to auto-fix`;
				}
			}
		}

		// ast-grep structural analysis
		const astAvailable = astGrepClient.isAvailable();
		dbg(
			`  ast-grep available: ${astAvailable}, no-ast-grep: ${pi.getFlag("no-ast-grep")}`,
		);
		if (!pi.getFlag("no-ast-grep") && astAvailable) {
			const astDiags = astGrepClient.scanFile(filePath);
			dbg(`  ast-grep diags: ${astDiags.length}`);
			if (astDiags.length > 0) {
				lspOutput += `\n\n${astGrepClient.formatDiagnostics(astDiags)}`;
			}
		}

		// Biome: lint only (formatting noise filtered out, use /lens-format)
		const biomeAvailable = biomeClient.isAvailable();
		dbg(
			`  biome available: ${biomeAvailable}, supported: ${biomeClient.isSupportedFile(filePath)}, no-biome: ${pi.getFlag("no-biome")}`,
		);
		if (!pi.getFlag("no-biome") && biomeClient.isSupportedFile(filePath)) {
			const biomeDiags = biomeClient.checkFile(filePath);
			// Filter out format-only issues (noise for agent, use /lens-format)
			const lintDiags = biomeDiags.filter((d) => d.category === "lint" || d.severity === "error");
			dbg(`  biome diags: ${biomeDiags.length} total, ${lintDiags.length} lint-only`);
			if (pi.getFlag("autofix-biome") && lintDiags.length > 0) {
				// Always attempt fix — let Biome decide what it can do
				const fixResult = biomeClient.fixFile(filePath);
				if (fixResult.success && fixResult.changed) {
					lspOutput += `\n\n[Biome] Auto-fixed ${fixResult.fixed} issue(s) — file updated on disk`;
					const remaining = biomeClient.checkFile(filePath);
					const remainingLint = remaining.filter((d) => d.category === "lint" || d.severity === "error");
					if (remainingLint.length > 0) {
						lspOutput += `\n\n${biomeClient.formatDiagnostics(remainingLint, filePath)}`;
					} else {
						lspOutput += `\n\n[Biome] ✓ All issues resolved`;
					}
				} else {
					// Nothing fixable — show diagnostics as-is
					lspOutput += `\n\n${biomeClient.formatDiagnostics(lintDiags, filePath)}`;
				}
			} else if (lintDiags.length > 0) {
				const fixable = lintDiags.filter((d) => d.fixable);
				lspOutput += `\n\n${biomeClient.formatDiagnostics(lintDiags, filePath)}`;
				if (fixable.length > 0) {
					lspOutput += `\n\n[Biome] ${fixable.length} fixable — enable --autofix-biome flag or run /lens-format`;
				}
			}
		}

		// Go — go vet diagnostics
		if (!pi.getFlag("no-go") && goClient.isGoFile(filePath) && goClient.isGoAvailable()) {
			const goDiags = goClient.checkFile(filePath);
			if (goDiags.length > 0) {
				lspOutput += `\n\n${goClient.formatDiagnostics(goDiags)}`;
			}
		}

		// Rust — cargo check diagnostics
		if (!pi.getFlag("no-rust") && rustClient.isRustFile(filePath) && rustClient.isAvailable()) {
			const cwd = process.cwd();
			const rustDiags = rustClient.checkFile(filePath, cwd);
			if (rustDiags.length > 0) {
				lspOutput += `\n\n${rustClient.formatDiagnostics(rustDiags)}`;
			}
		}

		// Complexity threshold warnings (actionable)
		if (complexityClient.isSupportedFile(filePath)) {
			const metrics = complexityClient.analyzeFile(filePath);
			if (metrics) {
				const warnings = complexityClient.checkThresholds(metrics);
				if (warnings.length > 0) {
					let warningReport = `[Complexity Warnings]\n`;
					for (const w of warnings) {
						warningReport += `  ⚠ ${w}\n`;
					}
					lspOutput += `\n\n${warningReport}`;
				}
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
				dbg(`  test runner: testInfo: ${testInfo ? testInfo.testFile : "none"}`);
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
				clone => path.resolve(clone.fileA) === path.resolve(filePath) ||
				         path.resolve(clone.fileB) === path.resolve(filePath)
			);
			if (fileClones.length > 0) {
				dbg(`  jscpd: ${fileClones.length} duplicate(s) involving ${filePath}`);
				let dupReport = `[jscpd] ${fileClones.length} duplicate block(s) involving ${path.basename(filePath)}:\n`;
				for (const clone of fileClones.slice(0, 3)) {
					const other = path.resolve(clone.fileA) === path.resolve(filePath)
						? `${path.basename(clone.fileB)}:${clone.startB}`
						: `${path.basename(clone.fileA)}:${clone.startA}`;
					dupReport += `  ${clone.lines} lines — ${other}\n`;
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
				const newExports = await astGrepClient.scanExports(filePath, "typescript");
				const dupes: string[] = [];
				for (const [name, file] of newExports) {
					if (cachedExports.has(name)) {
						const existingFile = cachedExports.get(name);
						if (existingFile && path.resolve(existingFile) !== path.resolve(filePath)) {
							dupes.push(`${name} (already in ${path.basename(existingFile)})`);
						}
					}
				}
				if (dupes.length > 0) {
					dbg(`  duplicate exports: ${dupes.length} found`);
					let exportReport = `[Duplicate Exports] ${dupes.length} function(s) already exist:\n`;
					for (const dupe of dupes.slice(0, 5)) {
						exportReport += `  ${dupe}\n`;
					}
					lspOutput += `\n\n${exportReport}`;
				}
				// Update cache with new exports
				for (const [name, file] of newExports) {
					cachedExports.set(name, file);
				}
			} catch {
				// ast-grep not available, skip
			}
		}

		// Silent metrics summary (appended to first tool_result after files are touched)
		const metricsSummary = metricsClient.formatSessionSummary();
		if (metricsSummary) {
			dbg(`  metrics summary available`);
			// Only add once per session (check if we've already shown it)
			if (!sessionMetricsShown) {
				// Build combined metrics + complexity summary
				let combinedSummary = metricsSummary;

				// Add complexity delta for changed files
				const complexityDeltas: string[] = [];
				for (const [filePath, baseline] of complexityBaselines) {
					if (fs.existsSync(filePath)) {
						const current = complexityClient.analyzeFile(filePath);
						if (current) {
							const delta = complexityClient.formatDelta(baseline, current);
							if (delta) complexityDeltas.push(delta);
						}
					}
				}

				if (complexityDeltas.length > 0) {
					combinedSummary += `\n\n[Complexity Changes]${complexityDeltas.join("\n")}`;
				}

				lspOutput += `\n\n${combinedSummary}`;
				sessionMetricsShown = true;
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
					.filter(
						(p: string) => !filePath.endsWith(require("node:path").basename(p)),
					);
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
