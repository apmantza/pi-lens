import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ArchitectClient } from "../clients/architect-client.js";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { DependencyChecker } from "../clients/dependency-checker.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import { getSourceFiles } from "../clients/scan-utils.js";
import type { TodoScanner } from "../clients/todo-scanner.js";
import type { TypeCoverageClient } from "../clients/type-coverage-client.js";

const getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

export async function handleBooboo(
	args: string,
	ctx: ExtensionContext,
	clients: {
		astGrep: AstGrepClient;
		complexity: ComplexityClient;
		todo: TodoScanner;
		knip: KnipClient;
		jscpd: JscpdClient;
		typeCoverage: TypeCoverageClient;
		depChecker: DependencyChecker;
		architect: ArchitectClient;
	},
	pi: ExtensionAPI,
) {
	const targetPath = args.trim() || ctx.cwd || process.cwd();
	ctx.ui.notify("🔍 Running full codebase review...", "info");

	// Summary counts for terminal display
	const summaryItems: {
		category: string;
		count: number;
		severity: "🔴" | "🟡" | "🟢" | "ℹ️";
		fixable: boolean; // true = can be fixed via /lens-booboo-fix
	}[] = [];
	const fullReport: string[] = [];
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");

	// Part 1: Design smells via ast-grep
	if (clients.astGrep.isAvailable()) {
		const configPath = path.join(
			getExtensionDir(),
			"..",
			"rules",
			"ast-grep-rules",
			".sgconfig.yml",
		);

		try {
			const result = childProcess.spawnSync(
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

				const parseItems = (raw: string): Record<string, any>[] => {
					const trimmed = raw.trim();
					if (trimmed.startsWith("[")) {
						try {
							return JSON.parse(trimmed);
						} catch (err) {
							void err;
							return [];
						}
					}
					return raw.split("\n").flatMap((l: string) => {
						try {
							return [JSON.parse(l)];
						} catch (err) {
							void err;
							return [];
						}
					});
				};

				for (const item of parseItems(output)) {
					const ruleId =
						item.ruleId || item.rule?.title || item.name || "unknown";
					const ruleDesc = clients.astGrep.getRuleDescription?.(ruleId);
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
					summaryItems.push({
						category: "ast-grep",
						count: issues.length,
						severity: issues.length > 10 ? "🔴" : "🟡",
						fixable: true,
					});

					let fullSection = `## ast-grep (Structural Issues)\n\n**${issues.length} issue(s) found**\n\n`;
					fullSection +=
						"| Line | Rule | Message |\n|------|------|--------|\n";
					for (const issue of issues) {
						fullSection += `| ${issue.line} | ${issue.rule} | ${issue.message} |\n`;
					}
					fullReport.push(fullSection);
				}
			}
		} catch (err) {
			const _err = err as any;
			// Ignored
		}
	}

	// Part 2: Similar functions
	if (clients.astGrep.isAvailable()) {
		const similarGroups = await clients.astGrep.findSimilarFunctions(
			targetPath,
			"typescript",
		);
		if (similarGroups.length > 0) {
			summaryItems.push({
				category: "Similar Functions",
				count: similarGroups.length,
				severity: "🟡",
				fixable: true,
			});

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

	// Part 3: Complexity metrics
	const results: import("../clients/complexity-client.js").FileComplexity[] =
		[];
	const aiSlopIssues: string[] = [];
	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));
	const files = getSourceFiles(targetPath, isTsProject);

	for (const fullPath of files) {
		if (clients.complexity.isSupportedFile(fullPath)) {
			const metrics = clients.complexity.analyzeFile(fullPath);
			if (metrics) {
				results.push(metrics);
				if (!/\.(test|spec)\.[jt]sx?$/.test(path.basename(fullPath))) {
					const warnings = clients.complexity.checkThresholds(metrics);
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

	if (results.length > 0) {
		const avgMI =
			results.reduce((a, b) => a + b.maintainabilityIndex, 0) / results.length;
		const avgCognitive =
			results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
		const avgCyclomatic =
			results.reduce((a, b) => a + b.cyclomaticComplexity, 0) / results.length;
		const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
		const maxCognitive = Math.max(...results.map((r) => r.cognitiveComplexity));
		const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));

		const lowMI = results
			.filter((r) => r.maintainabilityIndex < 60)
			.sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
		const highCognitive = results
			.filter((r) => r.cognitiveComplexity > 20)
			.sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);

		let _summary = `[Complexity] ${results.length} file(s) scanned\n`;
		_summary += `  Maintainability: ${avgMI.toFixed(1)} avg | Cognitive: ${avgCognitive.toFixed(1)} avg | Max Nesting: ${maxNesting} levels\n`;

		if (lowMI.length > 0) {
			_summary += `\n  Low Maintainability (MI < 60):\n`;
			for (const f of lowMI.slice(0, 5)) {
				_summary += `    ✗ ${f.filePath}: MI ${f.maintainabilityIndex.toFixed(1)}\n`;
			}
			if (lowMI.length > 5)
				_summary += `    ... and ${lowMI.length - 5} more\n`;
		}

		if (highCognitive.length > 0) {
			_summary += `\n  High Cognitive Complexity (> 20):\n`;
			for (const f of highCognitive.slice(0, 5)) {
				_summary += `    ⚠ ${f.filePath}: ${f.cognitiveComplexity}\n`;
			}
			if (highCognitive.length > 5)
				_summary += `    ... and ${highCognitive.length - 5} more\n`;
		}

		if (aiSlopIssues.length > 0) {
			_summary += `\n[AI Slop Indicators]\n${aiSlopIssues.join("\n")}`;
		}
		// Add complexity summary items
		if (lowMI.length > 0) {
			summaryItems.push({
				category: "Low MI",
				count: lowMI.length,
				severity: lowMI.some((f) => f.maintainabilityIndex < 20) ? "🔴" : "🟡",
				fixable: false,
			});
		}
		if (highCognitive.length > 0) {
			summaryItems.push({
				category: "High Complexity",
				count: highCognitive.length,
				severity: "🟡",
				fixable: true,
			});
		}
		if (aiSlopIssues.length > 0) {
			summaryItems.push({
				category: "AI Slop",
				count: (aiSlopIssues.length / 2) | 0,
				severity: "🟡",
				fixable: true,
			}); // Each issue is 2 lines
		}

		let fullSection = `## Complexity Metrics\n\n**${results.length} file(s) scanned**\n\n`;
		fullSection += `### Summary\n\n| Metric | Value |\n|--------|-------|\n| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n| Min Maintainability Index | ${minMI.toFixed(1)} |\n| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n| Max Cognitive Complexity | ${maxCognitive} |\n| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n| Max Nesting Depth | ${maxNesting} |\n| Total Files | ${results.length} |\n\n`;

		if (lowMI.length > 0) {
			fullSection += `### Low Maintainability (MI < 60)\n\n| File | MI | Cognitive | Cyclomatic | Nesting |\n|------|-----|-----------|------------|--------|\n`;
			for (const f of lowMI) {
				fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
			}
			fullSection += "\n";
		}

		if (highCognitive.length > 0) {
			fullSection += `### High Cognitive Complexity (> 20)\n\n| File | Cognitive | MI | Cyclomatic | Nesting |\n|------|-----------|-----|------------|--------|\n`;
			for (const f of highCognitive) {
				fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
			}
			fullSection += "\n";
		}

		fullSection += `### All Files\n\n| File | MI | Cognitive | Cyclomatic | Nesting | Entropy |\n|------|-----|-----------|------------|---------|--------|\n`;
		for (const f of results.sort(
			(a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
		)) {
			fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} | ${f.codeEntropy.toFixed(2)} |\n`;
		}
		fullSection += "\n";

		if (aiSlopIssues.length > 0) {
			fullSection += `### AI Slop Indicators\n\n`;
			for (const issue of aiSlopIssues) {
				fullSection += `${issue}\n`;
			}
			fullSection += "\n";
		}
		fullReport.push(fullSection);
	}

	// Part 4: TODOs
	const todoResult = clients.todo.scanDirectory(targetPath);
	if (todoResult.items.length > 0) {
		summaryItems.push({
			category: "TODOs",
			count: todoResult.items.length,
			severity: "ℹ️",
			fixable: false,
		});
		let fullSection = `## TODOs / Annotations\n\n`;
		if (todoResult.items.length > 0) {
			fullSection += `**${todoResult.items.length} annotation(s) found**\n\n| Type | File | Line | Text |\n|------|------|------|------|\n`;
			for (const item of todoResult.items) {
				fullSection += `| ${item.type} | ${item.file} | ${item.line} | ${item.message} |\n`;
			}
		} else {
			fullSection += `No annotations found.\n`;
		}
		fullSection += "\n";
		fullReport.push(fullSection);
	}

	// Part 5: Dead code
	if (clients.knip.isAvailable()) {
		const knipResult = clients.knip.analyze(targetPath);
		if (knipResult.issues.length > 0) {
			summaryItems.push({
				category: "Dead Code",
				count: knipResult.issues.length,
				severity: "🟡",
				fixable: true,
			});
			let fullSection = `## Dead Code (Knip)\n\n`;
			if (knipResult.issues.length > 0) {
				fullSection += `**${knipResult.issues.length} issue(s) found**\n\n| Type | Name | File |\n|------|------|------|\n`;
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

	// Part 6: Duplicate code
	if (clients.jscpd.isAvailable()) {
		const jscpdResult = clients.jscpd.scan(targetPath);
		if (jscpdResult.clones.length > 0) {
			summaryItems.push({
				category: "Duplicates",
				count: jscpdResult.clones.length,
				severity: "🟡",
				fixable: true,
			});
			let fullSection = `## Code Duplication (jscpd)\n\n`;
			if (jscpdResult.clones.length > 0) {
				fullSection += `**${jscpdResult.clones.length} duplicate block(s) found** (${jscpdResult.duplicatedLines}/${jscpdResult.totalLines} lines, ${jscpdResult.percentage.toFixed(1)}%)\n\n| File A | Line A | File B | Line B | Lines | Tokens |\n|--------|--------|--------|--------|-------|--------|\n`;
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
	if (clients.typeCoverage.isAvailable()) {
		const tcResult = clients.typeCoverage.scan(targetPath);
		if (tcResult.percentage < 100) {
			const untyped = tcResult.total - tcResult.typed;
			summaryItems.push({
				category: "Untyped",
				count: untyped,
				severity: tcResult.percentage < 90 ? "🟡" : "ℹ️",
				fixable: false,
			});
			let fullSection = `## Type Coverage\n\n**${tcResult.percentage.toFixed(1)}% typed** (${tcResult.typed}/${tcResult.total} identifiers)\n\n`;
			if (tcResult.untypedLocations.length > 0) {
				fullSection += `### Untyped Identifiers\n\n| File | Line | Column | Name |\n|------|------|--------|------|\n`;
				for (const u of tcResult.untypedLocations) {
					fullSection += `| ${u.file} | ${u.line} | ${u.column} | ${u.name} |\n`;
				}
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}
	}

	// Part 8: Circular deps
	if (!pi.getFlag("no-madge") && clients.depChecker.isAvailable()) {
		const { circular } = clients.depChecker.scanProject(targetPath);
		if (circular.length > 0) {
			summaryItems.push({
				category: "Circular Deps",
				count: circular.length,
				severity: "🔴",
				fixable: false,
			});
			let fullSection = `## Circular Dependencies (Madge)\n\n**${circular.length} circular chain(s) found**\n\n`;
			for (const dep of circular) {
				fullSection += `- ${dep.path.join(" → ")}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}
	}

	// Part 9: Arch rules
	if (!clients.architect.hasConfig()) {
		clients.architect.loadConfig(process.cwd());
	}
	if (clients.architect.hasConfig()) {
		const archViolations: Array<{ file: string; message: string }> = [];
		const archScanDir = (dir: string) => {
			for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
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
					archScanDir(full);
				} else if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(entry.name)) {
					const relPath = path.relative(targetPath, full).replace(/\\/g, "/");
					const content = nodeFs.readFileSync(full, "utf-8");
					const lineCount = content.split("\n").length;
					for (const v of clients.architect.checkFile(relPath, content)) {
						archViolations.push({ file: relPath, message: v.message });
					}
					const sizeV = clients.architect.checkFileSize(relPath, lineCount);
					if (sizeV)
						archViolations.push({ file: relPath, message: sizeV.message });
				}
			}
		};
		archScanDir(targetPath);
		if (archViolations.length > 0) {
			summaryItems.push({
				category: "Architectural",
				count: archViolations.length,
				severity: "🔴",
				fixable: false,
			});
			let fullSection = `## Architectural Rules\n\n**${archViolations.length} violation(s) found**\n\n`;
			for (const v of archViolations) {
				fullSection += `- **${v.file}**: ${v.message}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}
	}

	nodeFs.mkdirSync(reviewDir, { recursive: true });
	const projectName = path.basename(process.cwd());
	const mdReport = `# Code Review: ${projectName}\n\n**Scanned:** ${new Date().toISOString()}\n\n**Path:** \`${targetPath}\`\n\n---\n\n${fullReport.join("\n")}`;
	const reportPath = path.join(reviewDir, `booboo-${timestamp}.md`);
	nodeFs.writeFileSync(reportPath, mdReport, "utf-8");

	// Build summary table for terminal
	if (summaryItems.length === 0) {
		ctx.ui.notify("✓ Code review clean — saved to .pi-lens/reviews/", "info");
	} else {
		const totalIssues = summaryItems.reduce((sum, s) => sum + s.count, 0);
		const fixableCount = summaryItems
			.filter((s) => s.fixable)
			.reduce((sum, s) => sum + s.count, 0);
		const refactorNeeded = totalIssues - fixableCount;

		let summary = `📊 Code Review: ${totalIssues} issues found\n`;
		summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		for (const item of summaryItems) {
			summary += `${item.severity} ${item.category}: ${item.count}${item.fixable ? " (fixable)" : ""}\n`;
		}
		summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		if (fixableCount > 0 && refactorNeeded > 0) {
			summary += `🔧 ${fixableCount} fixable via /lens-booboo-fix | 🏗️ ${refactorNeeded} need /lens-booboo-refactor\n`;
		} else if (fixableCount > 0) {
			summary += `🔧 All ${fixableCount} issues fixable via /lens-booboo-fix\n`;
		} else {
			summary += `🏗️ All issues need /lens-booboo-refactor\n`;
		}
		summary += `📄 Full report: ${reportPath}`;
		ctx.ui.notify(summary, "info");
	}
}
