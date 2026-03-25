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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { GoClient } from "./clients/go-client.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { RuffClient } from "./clients/ruff-client.js";
import { RustClient } from "./clients/rust-client.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
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
		description:
			"Check for unused exports, files, and dependencies. Usage: /lens-dead-code [path]",
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
			"Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("🔍 Running full codebase review...", "info");

			const parts: string[] = [];
			const fullReport: string[] = [];
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19);
			const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");

			// Part 1: Design smells via ast-grep
			if (astGrepClient.isAvailable()) {
				const configPath = path.join(
					typeof __dirname !== "undefined" ? __dirname : ".",
					"rules",
					"ast-grep-rules",
					".sgconfig.yml",
				);

				try {
					const result = require("node:child_process").spawnSync(
						"npx",
						[
							"sg",
							"scan",
							"--config",
							configPath,
							"--json",
							"--globs",
							"!**/*.test.ts",
							"--globs",
							"!**/*.spec.ts",
							"--globs",
							"!**/test-utils.ts",
							"--globs",
							"!**/.pi-lens/**",
							targetPath,
						],
						{
							encoding: "utf-8",
							timeout: 30000,
							shell: true,
							maxBuffer: 32 * 1024 * 1024, // 32MB
						},
					);

					const output = result.stdout || result.stderr || "";
					if (output.trim() && result.status !== undefined) {
						const issues: Array<{
							line: number;
							rule: string;
							message: string;
						}> = [];

						// ast-grep outputs either a JSON array or NDJSON (one object per line)
						// biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
						const parseItems = (raw: string): Record<string, any>[] => {
							const trimmed = raw.trim();
							if (trimmed.startsWith("[")) {
								try {
									return JSON.parse(trimmed);
								} catch (err) { void err;
									return [];
								}
							}
							return raw.split("\n").flatMap((l: string) => {
								try {
									return [JSON.parse(l)];
								} catch (err) { void err;
									return [];
								}
							});
						};

						for (const item of parseItems(output)) {
							const ruleId =
								item.ruleId || item.rule?.title || item.name || "unknown";
							const ruleDesc = astGrepClient.getRuleDescription?.(ruleId);
							const message = ruleDesc?.message || item.message || ruleId;
							const lineNum =
								item.labels?.[0]?.range?.start?.line ||
								item.spans?.[0]?.range?.start?.line ||
								item.range?.start?.line ||
								0;

							issues.push({
								line: lineNum + 1,
								rule: ruleId,
								message: message,
							});
						}

						if (issues.length > 0) {
							// UI summary (truncated)
							let report = `[ast-grep] ${issues.length} issue(s) found:\n`;
							for (const issue of issues.slice(0, 20)) {
								report += `  L${issue.line}: ${issue.rule} — ${issue.message}\n`;
							}
							if (issues.length > 20) {
								report += `  ... and ${issues.length - 20} more\n`;
							}
							parts.push(report);

							// Full report for file
							let fullSection = `## ast-grep (Structural Issues)\n\n**${issues.length} issue(s) found**\n\n`;
							fullSection +=
								"| Line | Rule | Message |\n|------|------|--------|\n";
							for (const issue of issues) {
								fullSection += `| ${issue.line} | ${issue.rule} | ${issue.message} |\n`;
							}
							fullReport.push(fullSection);
						}
					}
				} catch (_err: any) {
					dbg(`ast-grep scan failed: ${_err.message}`);
				}
			}

			// Part 2: Similar functions (advanced duplicate detection)
			if (astGrepClient.isAvailable()) {
				const similarGroups = await astGrepClient.findSimilarFunctions(
					targetPath,
					"typescript",
				);
				if (similarGroups.length > 0) {
					// UI summary (truncated)
					let report = `[Similar Functions] ${similarGroups.length} group(s) of structurally similar functions:\n`;
					for (const group of similarGroups.slice(0, 5)) {
						report += `  Pattern: ${group.functions.map((f) => f.name).join(", ")}\n`;
						for (const fn of group.functions) {
							report += `    ${fn.name} (${path.basename(fn.file)}:${fn.line})\n`;
						}
					}
					if (similarGroups.length > 5) {
						report += `  ... and ${similarGroups.length - 5} more groups\n`;
					}
					parts.push(report);

					// Full report for file
					let fullSection = `## Similar Functions\n\n**${similarGroups.length} group(s) of structurally similar functions**\n\n`;
					for (const group of similarGroups) {
						fullSection += `### Pattern: ${group.functions.map((f) => f.name).join(", ")}\n\n`;
						fullSection +=
							"| Function | File | Line |\n|----------|------|------|\n";
						for (const fn of group.functions) {
							fullSection += `| ${fn.name} | ${fn.file} | ${fn.line} |\n`;
						}
						fullSection += "\n";
					}
					fullReport.push(fullSection);
				}
			}

			// Part 3: Complexity metrics + AI slop detection
			const results: import("./clients/complexity-client.js").FileComplexity[] =
				[];
			const aiSlopIssues: string[] = [];

			const scanDir = (dir: string) => {
				let entries: nodeFs.Dirent[];
				try {
					entries = nodeFs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}

				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						if (
							[
								"node_modules",
								".git",
								"dist",
								"build",
								".next",
								".pi-lens",
							].includes(entry.name)
						)
							continue;
						scanDir(fullPath);
					} else if (complexityClient.isSupportedFile(fullPath)) {
						const metrics = complexityClient.analyzeFile(fullPath);
						if (metrics) {
							results.push(metrics);

							// Check AI slop indicators — skip test files (low MI is expected/structural)
							if (!/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
								const warnings = complexityClient.checkThresholds(metrics);
								if (warnings.length > 0) {
									aiSlopIssues.push(`  ${metrics.filePath}:`);
									for (const w of warnings) {
										aiSlopIssues.push(`    ⚠ ${w}`);
									}
								}
							}
						}
					}
				}
			};

			scanDir(targetPath);

			if (results.length > 0) {
				const avgMI =
					results.reduce((a, b) => a + b.maintainabilityIndex, 0) /
					results.length;
				const avgCognitive =
					results.reduce((a, b) => a + b.cognitiveComplexity, 0) /
					results.length;
				const avgCyclomatic =
					results.reduce((a, b) => a + b.cyclomaticComplexity, 0) /
					results.length;
				const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
				const maxCognitive = Math.max(
					...results.map((r) => r.cognitiveComplexity),
				);
				const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));

				const lowMI = results
					.filter((r) => r.maintainabilityIndex < 60)
					.sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
				const highCognitive = results
					.filter((r) => r.cognitiveComplexity > 20)
					.sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);

				// UI summary (truncated)
				let summary = `[Complexity] ${results.length} file(s) scanned\n`;
				summary += `  Maintainability: ${avgMI.toFixed(1)} avg | Cognitive: ${avgCognitive.toFixed(1)} avg | Max Nesting: ${maxNesting} levels\n`;

				if (lowMI.length > 0) {
					summary += `\n  Low Maintainability (MI < 60):\n`;
					for (const f of lowMI.slice(0, 5)) {
						summary += `    ✗ ${f.filePath}: MI ${f.maintainabilityIndex.toFixed(1)}\n`;
					}
					if (lowMI.length > 5)
						summary += `    ... and ${lowMI.length - 5} more\n`;
				}

				if (highCognitive.length > 0) {
					summary += `\n  High Cognitive Complexity (> 20):\n`;
					for (const f of highCognitive.slice(0, 5)) {
						summary += `    ⚠ ${f.filePath}: ${f.cognitiveComplexity}\n`;
					}
					if (highCognitive.length > 5)
						summary += `    ... and ${highCognitive.length - 5} more\n`;
				}

				// Add AI slop issues
				if (aiSlopIssues.length > 0) {
					summary += `\n[AI Slop Indicators]\n${aiSlopIssues.join("\n")}`;
				}

				parts.push(summary);

				// Full report for file
				let fullSection = `## Complexity Metrics\n\n**${results.length} file(s) scanned**\n\n`;
				fullSection += `### Summary\n\n`;
				fullSection += `| Metric | Value |\n|--------|-------|\n`;
				fullSection += `| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n`;
				fullSection += `| Min Maintainability Index | ${minMI.toFixed(1)} |\n`;
				fullSection += `| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n`;
				fullSection += `| Max Cognitive Complexity | ${maxCognitive} |\n`;
				fullSection += `| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n`;
				fullSection += `| Max Nesting Depth | ${maxNesting} |\n`;
				fullSection += `| Total Files | ${results.length} |\n\n`;

				if (lowMI.length > 0) {
					fullSection += `### Low Maintainability (MI < 60)\n\n`;
					fullSection += `| File | MI | Cognitive | Cyclomatic | Nesting |\n`;
					fullSection += `|------|-----|-----------|------------|--------|\n`;
					for (const f of lowMI) {
						fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
					}
					fullSection += "\n";
				}

				if (highCognitive.length > 0) {
					fullSection += `### High Cognitive Complexity (> 20)\n\n`;
					fullSection += `| File | Cognitive | MI | Cyclomatic | Nesting |\n`;
					fullSection += `|------|-----------|-----|------------|--------|\n`;
					for (const f of highCognitive) {
						fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
					}
					fullSection += "\n";
				}

				// All files table
				fullSection += `### All Files\n\n`;
				fullSection += `| File | MI | Cognitive | Cyclomatic | Nesting | Entropy |\n`;
				fullSection += `|------|-----|-----------|------------|---------|--------|\n`;
				for (const f of results.sort(
					(a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
				)) {
					fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} | ${f.codeEntropy.toFixed(2)} |\n`;
				}
				fullSection += "\n";

				// AI slop indicators
				if (aiSlopIssues.length > 0) {
					fullSection += `### AI Slop Indicators\n\n`;
					for (const issue of aiSlopIssues) {
						fullSection += `${issue}\n`;
					}
					fullSection += "\n";
				}

				fullReport.push(fullSection);
			}

			// Part 4: TODOs scan
			const todoResult = todoScanner.scanDirectory(targetPath);
			const todoReport = todoScanner.formatResult(todoResult);
			if (todoReport) {
				parts.push(todoReport);
				// Full TODO report
				let fullSection = `## TODOs / Annotations\n\n`;
				if (todoResult.items.length > 0) {
					fullSection += `**${todoResult.items.length} annotation(s) found**\n\n`;
					fullSection += `| Type | File | Line | Text |\n`;
					fullSection += `|------|------|------|------|\n`;
					for (const item of todoResult.items) {
						fullSection += `| ${item.type} | ${item.file} | ${item.line} | ${item.message} |\n`;
					}
				} else {
					fullSection += `No annotations found.\n`;
				}
				fullSection += "\n";
				fullReport.push(fullSection);
			}

			// Part 5: Dead code (knip)
			if (knipClient.isAvailable()) {
				const knipResult = knipClient.analyze(targetPath);
				const knipReport = knipClient.formatResult(knipResult);
				if (knipReport) {
					parts.push(knipReport);
					// Full knip report
					let fullSection = `## Dead Code (Knip)\n\n`;
					if (knipResult.issues.length > 0) {
						fullSection += `**${knipResult.issues.length} issue(s) found**\n\n`;
						fullSection += `| Type | Name | File |\n`;
						fullSection += `|------|------|------|\n`;
						for (const issue of knipResult.issues) {
							fullSection += `| ${issue.type} | ${issue.name} | ${issue.file ?? ""} |\n`;
						}
					} else {
						fullSection += `No dead code issues found.\n`;
					}
					fullSection += "\n";
					fullReport.push(fullSection);
				}
			}

			// Part 6: Code duplication
			if (jscpdClient.isAvailable()) {
				const jscpdResult = jscpdClient.scan(targetPath);
				const jscpdReport = jscpdClient.formatResult(jscpdResult);
				if (jscpdReport) {
					parts.push(jscpdReport);
					// Full jscpd report
					let fullSection = `## Code Duplication (jscpd)\n\n`;
					if (jscpdResult.clones.length > 0) {
						fullSection += `**${jscpdResult.clones.length} duplicate block(s) found** (${jscpdResult.duplicatedLines}/${jscpdResult.totalLines} lines, ${jscpdResult.percentage.toFixed(1)}%)\n\n`;
						fullSection += `| File A | Line A | File B | Line B | Lines | Tokens |\n`;
						fullSection += `|--------|--------|--------|--------|-------|--------|\n`;
						for (const dup of jscpdResult.clones) {
							fullSection += `| ${dup.fileA} | ${dup.startA} | ${dup.fileB} | ${dup.startB} | ${dup.lines} | ${dup.tokens} |\n`;
						}
					} else {
						fullSection += `No duplicate code found.\n`;
					}
					fullSection += "\n";
					fullReport.push(fullSection);
				}
			}

			// Part 7: Type coverage
			if (typeCoverageClient.isAvailable()) {
				const tcResult = typeCoverageClient.scan(targetPath);
				const tcReport = typeCoverageClient.formatResult(tcResult);
				if (tcReport) {
					parts.push(tcReport);
					// Full type coverage report
					let fullSection = `## Type Coverage\n\n`;
					fullSection += `**${tcResult.percentage.toFixed(1)}% typed** (${tcResult.typed}/${tcResult.total} identifiers)\n\n`;
					if (tcResult.untypedLocations.length > 0) {
						fullSection += `### Untyped Identifiers\n\n`;
						fullSection += `| File | Line | Column | Name |\n`;
						fullSection += `|------|------|--------|------|\n`;
						for (const u of tcResult.untypedLocations) {
							fullSection += `| ${u.file} | ${u.line} | ${u.column} | ${u.name} |\n`;
						}
					}
					fullSection += "\n";
					fullReport.push(fullSection);
				}
			}

			// Build and save full markdown report
			const fs = require("node:fs");
			fs.mkdirSync(reviewDir, { recursive: true });

			const projectName = path.basename(process.cwd());
			let mdReport = `# Code Review: ${projectName}\n\n`;
			mdReport += `**Scanned:** ${new Date().toISOString()}\n\n`;
			mdReport += `**Path:** \`${targetPath}\`\n\n`;
			mdReport += `---\n\n`;
			mdReport += fullReport.join("\n");

			const reportPath = path.join(reviewDir, `booboo-${timestamp}.md`);
			fs.writeFileSync(reportPath, mdReport, "utf-8");

			if (parts.length === 0) {
				ctx.ui.notify(
					"✓ Code review clean — saved to .pi-lens/reviews/",
					"info",
				);
			} else {
				ctx.ui.notify(
					`${parts.join("\n\n")}\n\n📄 Full report: ${reportPath}`,
					"info",
				);
			}
		},
	});

	// --- Rule action map for lens-booboo-fix ---
	const RULE_ACTIONS: Record<
		string,
		{ type: "biome" | "agent" | "skip"; note: string }
	> = {
		"no-var": { type: "biome", note: "auto-fixed by Biome --write" },
		"prefer-template": { type: "biome", note: "auto-fixed by Biome --write" },
		"no-useless-concat": { type: "biome", note: "auto-fixed by Biome --write" },
		"no-lonely-if": { type: "biome", note: "auto-fixed by Biome --write" },
		"prefer-const": { type: "biome", note: "auto-fixed by Biome --write" },
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
	};

	pi.registerCommand("lens-booboo-fix", {
		description:
			"Iterative fix loop: auto-fixes Biome/Ruff, then generates a per-issue plan for agent to execute. Run repeatedly until clean. Usage: /lens-booboo-fix [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			const fs = require("node:fs") as typeof import("node:fs");
			const sessionFile = path.join(
				process.cwd(),
				".pi-lens",
				"fix-session.json",
			);
			const configPath = path.join(
				typeof __dirname !== "undefined" ? __dirname : ".",
				"rules",
				"ast-grep-rules",
				".sgconfig.yml",
			);

			ctx.ui.notify("🔧 Running booboo fix loop...", "info");

			const MAX_ITERATIONS = 3;

			// Load session state
			let session: { iteration: number; counts: Record<string, number> } = {
				iteration: 0,
				counts: {},
			};
			try {
				session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
			} catch (e) {
				dbg(`fix-session load failed: ${e}`);
			}
			session.iteration++;

			// Hard stop at max iterations
			if (session.iteration > MAX_ITERATIONS) {
				ctx.ui.notify(
					`⛔ Max iterations (${MAX_ITERATIONS}) reached. Run /lens-booboo for full remaining report, or delete .pi-lens/fix-session.json to reset.`,
					"warning",
				);
				return;
			}
			const prevCounts = { ...session.counts };

			// --- Step 1: Auto-fix with Biome ---
			let biomeRan = false;
			if (!pi.getFlag("no-biome") && biomeClient.isAvailable()) {
				require("node:child_process").spawnSync(
					"npx",
					["@biomejs/biome", "check", "--write", "--unsafe", targetPath],
					{ encoding: "utf-8", timeout: 30000, shell: true },
				);
				biomeRan = true;
			}

			// --- Step 2: Auto-fix with Ruff ---
			let ruffRan = false;
			if (!pi.getFlag("no-ruff") && ruffClient.isAvailable()) {
				require("node:child_process").spawnSync(
					"ruff",
					["check", "--fix", targetPath],
					{ encoding: "utf-8", timeout: 15000, shell: true },
				);
				require("node:child_process").spawnSync(
					"ruff",
					["format", targetPath],
					{ encoding: "utf-8", timeout: 15000, shell: true },
				);
				ruffRan = true;
			}

			// --- Step 3: ast-grep scan (after auto-fix) ---
			type AstIssue = {
				rule: string;
				file: string;
				line: number;
				message: string;
			};
			const astIssues: AstIssue[] = [];
			if (astGrepClient.isAvailable()) {
				const result = require("node:child_process").spawnSync(
					"npx",
					[
						"sg",
						"scan",
						"--config",
						configPath,
						"--json",
						"--globs",
						"!**/*.test.ts",
						"--globs",
						"!**/*.spec.ts",
						"--globs",
						"!**/test-utils.ts",
						"--globs",
						"!**/.pi-lens/**",
						targetPath,
					],
					{
						encoding: "utf-8",
						timeout: 30000,
						shell: true,
						maxBuffer: 32 * 1024 * 1024,
					},
				);

				const raw = result.stdout?.trim() ?? "";
				// biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
				const items: Record<string, any>[] = raw.startsWith("[")
					? (() => {
							try {
								return JSON.parse(raw);
							} catch (e) {
								dbg(`ast-grep parse failed: ${e}`);
								return [];
							}
						})()
					: raw.split("\n").flatMap((l: string) => {
							try {
								return [JSON.parse(l)];
							} catch (err) { void err;
								return [];
							}
						});

				for (const item of items) {
					const rule =
						item.ruleId || item.rule?.title || item.name || "unknown";
					const line =
						(item.labels?.[0]?.range?.start?.line ??
							item.range?.start?.line ??
							0) + 1;
					const relFile = path
						.relative(targetPath, item.file ?? "")
						.replace(/\\/g, "/");
					astIssues.push({
						rule,
						file: relFile,
						line,
						message: item.message ?? rule,
					});
				}
			}

			// --- Step 4: AI slop from complexity scan ---
			const slopFiles: Array<{ file: string; warnings: string[] }> = [];
			const slopScanDir = (dir: string) => {
				if (!fs.existsSync(dir)) return;
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						if (
							[
								"node_modules",
								".git",
								"dist",
								"build",
								".next",
								".pi-lens",
							].includes(entry.name)
						)
							continue;
						slopScanDir(fullPath);
					} else if (
						complexityClient.isSupportedFile(fullPath) &&
						!/\.(test|spec)\.[jt]sx?$/.test(entry.name)
					) {
						const metrics = complexityClient.analyzeFile(fullPath);
						if (metrics) {
							const warnings = complexityClient
								.checkThresholds(metrics)
								.filter(
									(w) =>
										w.includes("AI-style") ||
										w.includes("try/catch") ||
										w.includes("single-use") ||
										w.includes("Excessive comments"),
								);
							if (warnings.length > 0) {
								slopFiles.push({
									file: path.relative(targetPath, fullPath).replace(/\\/g, "/"),
									warnings,
								});
							}
						}
					}
				}
			};
			slopScanDir(targetPath);

			// --- Step 5: Remaining Biome lint ---
			const remainingBiome: Array<{
				file: string;
				line: number;
				rule: string;
				message: string;
				fixable: boolean;
			}> = [];
			if (!pi.getFlag("no-biome") && biomeClient.isAvailable()) {
				// Sample a few key files for remaining lint (not whole project — Biome just ran)
				// Just report counts from a quick scan
				const checkResult = require("node:child_process").spawnSync(
					"npx",
					[
						"@biomejs/biome",
						"check",
						"--reporter=json",
						"--max-diagnostics=50",
						targetPath,
					],
					{ encoding: "utf-8", timeout: 20000, shell: true },
				);
				try {
					const data = JSON.parse(checkResult.stdout ?? "{}");
					for (const diag of (data.diagnostics ?? []).slice(0, 20)) {
						if (!diag.category?.startsWith("lint/")) continue;
						const filePath = diag.location?.path?.file ?? "";
						const line = diag.location?.span?.start?.line ?? 0;
						const rule = diag.category ?? "lint";
						const fixable = diag.tags?.includes("fixable") ?? false;
						remainingBiome.push({
							file: path.relative(targetPath, filePath).replace(/\\/g, "/"),
							line: line + 1,
							rule,
							message: diag.message ?? rule,
							fixable,
						});
					}
				} catch (e) {
					dbg(`biome lint parse failed: ${e}`);
				}
			}

			// --- Categorize ast-grep issues ---
			const agentTasks: AstIssue[] = [];
			const skipRules = new Map<string, { note: string; count: number }>();

			// Group by rule
			const byRule = new Map<string, AstIssue[]>();
			for (const issue of astIssues) {
				const list = byRule.get(issue.rule) ?? [];
				list.push(issue);
				byRule.set(issue.rule, list);
			}

			for (const [rule, issues] of byRule) {
				const action = RULE_ACTIONS[rule];
				if (!action || action.type === "agent") {
					agentTasks.push(...issues);
				} else if (action.type === "skip") {
					skipRules.set(rule, { note: action.note, count: issues.length });
				}
				// biome type → already handled by Step 1
			}

			// --- Update session counts ---
			const currentCounts = {
				agent_ast: agentTasks.length,
				biome_lint: remainingBiome.length,
				slop_files: slopFiles.length,
			};
			session.counts = currentCounts;
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf-8");

			// --- Check if done ---
			const totalFixable =
				agentTasks.length + remainingBiome.length + slopFiles.length;
			if (totalFixable === 0) {
				const msg = `✅ BOOBOO FIX LOOP COMPLETE — No more fixable issues found after ${session.iteration} iteration(s).\n\nRemaining skipped items are architectural — see /lens-booboo for full report.`;
				ctx.ui.notify(msg, "info");
				fs.unlinkSync(sessionFile);
				return;
			}

			// --- Build delta line ---
			let deltaLine = "";
			if (session.iteration > 1 && Object.keys(prevCounts).length > 0) {
				const prevTotal = Object.values(prevCounts).reduce((a, b) => a + b, 0);
				const currTotal = totalFixable;
				const fixed = prevTotal - currTotal;
				deltaLine =
					fixed > 0
						? `✅ Fixed ${fixed} issues since last iteration.`
						: `⚠️ No change since last iteration — check if fixes were applied.`;
			}

			// --- Build the fix plan message ---
			const lines: string[] = [];
			lines.push(
				`📋 BOOBOO FIX PLAN — Iteration ${session.iteration}/${MAX_ITERATIONS} (${totalFixable} fixable items remaining)`,
			);
			if (deltaLine) lines.push(deltaLine);
			lines.push("");

			// Auto-fix note
			if (biomeRan || ruffRan) {
				lines.push(
					`⚡ Auto-fixed: ${[biomeRan && "Biome --write --unsafe", ruffRan && "Ruff --fix + format"].filter(Boolean).join(", ")} already ran.`,
				);
				lines.push("");
			}

			// Agent tasks — grouped by rule
			if (agentTasks.length > 0) {
				lines.push(`## 🔨 Fix these [${agentTasks.length} items]`);
				lines.push("");
				const groupedAgent = new Map<string, AstIssue[]>();
				for (const t of agentTasks) {
					const g = groupedAgent.get(t.rule) ?? [];
					g.push(t);
					groupedAgent.set(t.rule, g);
				}
				for (const [rule, issues] of groupedAgent) {
					const action = RULE_ACTIONS[rule];
					const note = action?.note ?? "Fix this violation";
					lines.push(`### ${rule} (${issues.length})`);
					lines.push(`→ ${note}`);
					for (const issue of issues.slice(0, 15)) {
						lines.push(`  - \`${issue.file}:${issue.line}\``);
					}
					if (issues.length > 15)
						lines.push(`  ... and ${issues.length - 15} more`);
					lines.push("");
				}
			}

			// Remaining Biome lint
			if (remainingBiome.length > 0) {
				lines.push(
					`## 🟠 Remaining Biome lint [${remainingBiome.length} items]`,
				);
				lines.push("→ Fix each manually or run `/lens-format` from the UI:");
				for (const d of remainingBiome.slice(0, 10)) {
					lines.push(`  - \`${d.file}:${d.line}\` [${d.rule}] ${d.message}`);
				}
				if (remainingBiome.length > 10)
					lines.push(`  ... and ${remainingBiome.length - 10} more`);
				lines.push("");
			}

			// AI slop
			if (slopFiles.length > 0) {
				lines.push(`## 🤖 AI Slop indicators [${slopFiles.length} files]`);
				for (const { file, warnings } of slopFiles.slice(0, 10)) {
					lines.push(
						`  - \`${file}\`: ${warnings.map((w) => w.split(" — ")[0]).join(", ")}`,
					);
				}
				if (slopFiles.length > 10)
					lines.push(`  ... and ${slopFiles.length - 10} more`);
				lines.push("");
			}

			// Skips
			if (skipRules.size > 0) {
				lines.push(
					`## ⏭️ Skip [${[...skipRules.values()].reduce((a, b) => a + b.count, 0)} items — architectural]`,
				);
				for (const [rule, { note, count }] of skipRules) {
					lines.push(`  - **${rule}** (${count}): ${note}`);
				}
				lines.push("");
			}

			lines.push("---");
			lines.push(
				"Fix the items above, then run `/lens-booboo-fix` again for the next iteration.",
			);
			lines.push(
				"If an item in '🔨 Fix these' is not safe to fix, skip it with one sentence why.",
			);

			const fixPlan = lines.join("\n");

			// Save plan for reference
			const planPath = path.join(process.cwd(), ".pi-lens", "fix-plan.md");
			fs.writeFileSync(
				planPath,
				`# Fix Plan — Iteration ${session.iteration}\n\n${fixPlan}`,
				"utf-8",
			);

			// Notify and inject into conversation
			ctx.ui.notify(`📄 Fix plan saved: ${planPath}`, "info");
			// Use steer delivery — agent is busy processing this tool call
			// steer interrupts mid-processing with the next fix plan
			pi.sendUserMessage(fixPlan, { deliverAs: "steer" });
		},
	});

	pi.registerCommand("lens-metrics", {
		description:
			"Measure complexity metrics for all files and export to report.md. Usage: /lens-metrics [path]",
		handler: async (args, ctx) => {
			const targetPath = args.trim() || ctx.cwd || process.cwd();
			ctx.ui.notify("📊 Measuring code metrics...", "info");

			const fs = require("node:fs");
			const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19);
			const projectName = path.basename(process.cwd());

			const results: import("./clients/complexity-client.js").FileComplexity[] =
				[];

			const scanDir = (dir: string) => {
				let entries: nodeFs.Dirent[];
				try {
					entries = nodeFs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}

				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						if (
							[
								"node_modules",
								".git",
								"dist",
								"build",
								".next",
								".pi-lens",
							].includes(entry.name)
						)
							continue;
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
			grades.forEach((g) => gradeCount[g.letter as keyof typeof gradeCount]++);

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
			report += `| Grade | File | MI | Cognitive | Cyclomatic | Nesting | Functions | LOC | Entropy |\n`;
			report += `|-------|------|-----|-----------|------------|---------|-----------|-----|--------|\n`;

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

				report += `| ${grade} | ${relPath} | ${mi.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity.toFixed(1)} | ${f.maxNestingDepth} | ${f.functionCount} | ${f.linesOfCode} | ${f.codeEntropy.toFixed(2)} |\n`;
			}
			report += `\n`;

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
			fs.mkdirSync(reviewDir, { recursive: true });

			const reportPath = path.join(reviewDir, `metrics-${timestamp}.md`);
			fs.writeFileSync(reportPath, report, "utf-8");

			// Also save latest.md for easy access
			const latestPath = path.join(reviewDir, "latest.md");
			fs.writeFileSync(latestPath, report, "utf-8");

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

				const formatDir = (dir: string) => {
					let entries: nodeFs.Dirent[];
					try {
						entries = nodeFs.readdirSync(dir, { withFileTypes: true });
					} catch {
						return;
					}

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

	// Delivered once into the first tool_result of the session, then cleared
	let sessionSummary: string | null = null;
	let sessionMetricsShown = false;
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
		const filePath =
			isToolCallEventType("write", event) || isToolCallEventType("edit", event)
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
		if (
			complexityClient.isSupportedFile(filePath) &&
			!complexityBaselines.has(filePath)
		) {
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

		// Snapshot baselines for delta mode (no pre-write hints — delta handles it)
		if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
			astGrepBaselines.set(filePath, astGrepClient.scanFile(filePath));
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
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			metricsClient.recordWrite(filePath, content);
		} catch (err) {
			void err;
		}

		let lspOutput = sessionDump ? `\n\n${sessionDump}` : "";
		if (preHint) lspOutput += `\n\n${preHint}`;

		// TypeScript LSP diagnostics
		if (!pi.getFlag("no-lsp") && tsClient.isTypeScriptFile(filePath)) {
			try {
				tsClient.updateFile(filePath, fs.readFileSync(filePath, "utf-8"));
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

			if (newViolations.length > 0) {
				const hasFixable = newViolations.some((v) => v.fix);
				lspOutput += `\n\n🔴 You introduced ${newViolations.length} new structural violation(s) — fix before moving on:\n`;
				lspOutput += astGrepClient.formatDiagnostics(newViolations);
				if (hasFixable)
					lspOutput += `\n  Some are fixable — check the → hints above`;
			}
			if (fixedRules.length > 0) {
				lspOutput += `\n\n✅ ast-grep: fixed ${fixedRules.join(", ")}`;
			}
			if (after.length > 0 && newViolations.length > 0) {
				lspOutput += `\n  (${after.length} total remaining)`;
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
			} else {
				if (newDiags.length > 0) {
					const fixable = newDiags.filter((d) => d.fixable);
					lspOutput += `\n\n🟠 You introduced ${newDiags.length} new Biome violation(s) — fix before moving on:\n`;
					lspOutput += biomeClient.formatDiagnostics(newDiags, filePath);
					if (fixable.length > 0)
						lspOutput += `\n  → Auto-fixable: \`npx @biomejs/biome check --write ${path.basename(filePath)}\``;
				}
				if (fixedRules.length > 0) {
					lspOutput += `\n\n✅ Biome: fixed ${fixedRules.join(", ")}`;
				}
				if (after.length > 0 && newDiags.length > 0) {
					lspOutput += `\n  (${after.length} total remaining)`;
				}
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

		// Complexity threshold warnings (actionable)
		if (complexityClient.isSupportedFile(filePath)) {
			const metrics = complexityClient.analyzeFile(filePath);
			if (metrics) {
				const warnings = complexityClient.checkThresholds(metrics);
				if (warnings.length > 0) {
					const isTestFile = /\.(test|spec)\.[jt]sx?$/.test(filePath);
					if (!isTestFile) {
						let warningReport = `🟡 Complexity issues — refactor when you get a chance:\n`;
						for (const w of warnings) {
							warningReport += `  ⚠ ${w}\n`;
						}
						lspOutput += `\n\n${warningReport}`;
					}
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
				let dupReport = `🟠 This file has ${fileClones.length} duplicate block(s) — extract to shared utilities:\n`;
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
			} catch (err) { void err;
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
