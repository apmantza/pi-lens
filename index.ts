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
	 * - Biome: feedback only by default, use /format to apply fixes
	 * - Ruff: applies --fix + format (lint + format fixes)
 *
 * On-demand commands:
 * - /format - Apply Biome formatting
 * - /find-todos - Scan for TODO/FIXME/HACK annotations
 * - /dead-code - Find unused exports/dependencies (requires knip)
 * - /check-deps - Full circular dependency scan (requires madge)
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

	// --- Commands ---

	pi.registerCommand("find-todos", {
		description:
			"Scan for TODO/FIXME/HACK annotations. Usage: /find-todos [path]",
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

	pi.registerCommand("dead-code", {
		description: "Check for unused exports, files, and dependencies",
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

	pi.registerCommand("check-deps", {
		description: "Check for circular dependencies in the project",
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

	pi.registerCommand("design-review", {
		description:
			"Analyze files for design smells (long methods, large classes, deep nesting). Usage: /design-review [path]",
		handler: async (args, ctx) => {
			if (!astGrepClient.isAvailable()) {
				ctx.ui.notify(
					"ast-grep not installed. Run: npm i -D @ast-grep/cli",
					"error",
				);
				return;
			}

			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("🔍 Analyzing design smells...", "info");

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
				if (!output.trim() || result.status !== 1) {
					ctx.ui.notify("✓ No design smells found", "info");
					return;
				}

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

				if (issues.length === 0) {
					ctx.ui.notify("✓ No design smells found", "info");
					return;
				}

				let report = `[Design Review] ${issues.length} design smell(s) found:\n`;
				for (const issue of issues.slice(0, 20)) {
					report += `  L${issue.line}: ${issue.rule} — ${issue.message}\n`;
				}
				if (issues.length > 20) {
					report += `  ... and ${issues.length - 20} more\n`;
				}
				ctx.ui.notify(report, "info");
			} catch (err: any) {
				ctx.ui.notify(`Design review failed: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("format", {
		description:
			"Apply Biome formatting to files. Usage: /format [file-path] or /format --all",
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

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		_verbose = !!pi.getFlag("lens-verbose");
		dbg("session_start fired");

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

		// Duplicate code detection
		if (jscpdClient.isAvailable()) {
			const jscpdResult = jscpdClient.scan(cwd);
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

		let lspOutput = sessionDump ? `\n\n${sessionDump}` : "";
		if (preHint) lspOutput += `\n\n${preHint}`;

		// TypeScript LSP diagnostics
		if (!pi.getFlag("no-lsp") && tsClient.isTypeScriptFile(filePath)) {
			const fs = require("node:fs");
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

		// Biome: lint + format check
		const biomeAvailable = biomeClient.isAvailable();
		dbg(
			`  biome available: ${biomeAvailable}, supported: ${biomeClient.isSupportedFile(filePath)}, no-biome: ${pi.getFlag("no-biome")}`,
		);
		if (!pi.getFlag("no-biome") && biomeClient.isSupportedFile(filePath)) {
			const biomeDiags = biomeClient.checkFile(filePath);
			dbg(`  biome diags: ${biomeDiags.length}`);
			if (pi.getFlag("autofix-biome") && biomeDiags.length > 0) {
				// Always attempt fix — let Biome decide what it can do
				const fixResult = biomeClient.fixFile(filePath);
				if (fixResult.success && fixResult.changed) {
					lspOutput += `\n\n[Biome] Auto-fixed ${fixResult.fixed} issue(s) — file updated on disk`;
					const remaining = biomeClient.checkFile(filePath);
					if (remaining.length > 0) {
						lspOutput += `\n\n${biomeClient.formatDiagnostics(remaining, filePath)}`;
					} else {
						lspOutput += `\n\n[Biome] ✓ All issues resolved`;
					}
				} else {
					// Nothing fixable — show diagnostics as-is
					lspOutput += `\n\n${biomeClient.formatDiagnostics(biomeDiags, filePath)}`;
				}
			} else if (biomeDiags.length > 0) {
				const fixable = biomeDiags.filter((d) => d.fixable);
				lspOutput += `\n\n${biomeClient.formatDiagnostics(biomeDiags, filePath)}`;
				if (fixable.length > 0) {
					lspOutput += `\n\n[Biome] ${fixable.length} fixable — enable --autofix-biome flag or run /format`;
				}
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
