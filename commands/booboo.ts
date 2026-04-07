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
import {
	EXCLUDED_DIRS,
	getKnipIgnorePatterns,
	isTestFile,
} from "../clients/file-utils.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import { validateProductionReadiness } from "../clients/production-readiness.js";
import {
	buildProjectIndex,
	type ProjectIndex,
} from "../clients/project-index.js";
import {
	detectProjectMetadata,
	formatProjectMetadata,
	getAvailableCommands,
} from "../clients/project-metadata.js";
import { RunnerTracker } from "../clients/runner-tracker.js";
import { safeSpawn } from "../clients/safe-spawn.js";
import { getSourceFiles } from "../clients/scan-utils.js";
import {
	collectSourceFiles,
	getFilterStats,
} from "../clients/source-filter.js";
import { calculateSimilarity } from "../clients/state-matrix.js";
import type { TodoScanner } from "../clients/todo-scanner.js";
import { TreeSitterClient } from "../clients/tree-sitter-client.js";
import type { TypeCoverageClient } from "../clients/type-coverage-client.js";

const getExtensionDir = () => {
	if (typeof __dirname !== "undefined") {
		return __dirname;
	}
	return ".";
};

/**
 * Centralized test file exclusion for booboo runners.
 * Mirrors the dispatch system's skipTestFiles behavior.
 */
function shouldIncludeFile(filePath: string): boolean {
	return !isTestFile(filePath);
}

/** Standard test file glob exclusions for CLI tools */
const _TEST_FILE_EXCLUDES = [
	"!**/*.test.ts",
	"!**/*.test.tsx",
	"!**/*.test.js",
	"!**/*.test.jsx",
	"!**/*.spec.ts",
	"!**/*.spec.tsx",
	"!**/*.spec.js",
	"!**/*.spec.jsx",
	"!**/*.poc.test.ts",
	"!**/*.poc.test.tsx",
	"!**/test-utils.ts",
	"!**/test-*.ts",
	"!**/__tests__/**",
	"!**/tests/**",
	"!**/test/**",
];

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
	const requestedPath = args.trim() || ctx.cwd || process.cwd();
	const targetPath = path.resolve(requestedPath);
	const reviewRoot = targetPath;

	const categoryKey = (name: string) =>
		name.toLowerCase().replace(/\s+/g, "-");

	// Detect project metadata for richer reporting
	const projectMeta = detectProjectMetadata(targetPath);
	const _metaDisplay = formatProjectMetadata(projectMeta);

	// No noisy notification at start - just run the review silently

	// Detect project type once for all runners
	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));

	// Collect source files once with unified artifact filtering
	// This ensures all scanners work on the same deduplicated file set
	const sourceFiles = collectSourceFiles(targetPath);
	const allFiles = collectSourceFiles(targetPath, {
		extensions: [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mjs",
			".cjs",
			".py",
			".go",
			".rs",
			".rb",
		],
	});
	const filterStats = getFilterStats(allFiles, sourceFiles);

	if (filterStats.skipped > 0) {
		const byTypeStr = Object.entries(filterStats.byType)
			.map(([ext, count]) => `${count} ${ext}`)
			.join(", ");
		// biome-ignore lint/suspicious/noConsole: CLI output
		console.log(
			`[lens-booboo] Filtered ${filterStats.skipped} build artifacts (${byTypeStr}), scanning ${filterStats.kept} source files`,
		);
	}

	// Get available commands for the project
	const availableCommands = getAvailableCommands(projectMeta);

	// Load false positives from fix session to filter them out
	const sessionFile = path.join(reviewRoot, ".pi-lens", "fix-session.json");
	let falsePositives: string[] = [];
	try {
		const sessionData = JSON.parse(
			nodeFs.readFileSync(sessionFile, "utf-8") || "{}",
		);
		falsePositives = sessionData.falsePositives || [];
	} catch {
		// No session file yet
	}

	// Helper to check if an issue is marked as false positive
	const isFalsePositive = (
		category: string,
		file: string,
		line?: number,
	): boolean => {
		const fpKey =
			line !== undefined
				? `${category}:${file}:${line}`
				: `${category}:${file}`;
		return falsePositives.some(
			(fp) => fp === fpKey || fp.startsWith(`${category}:${file}`),
		);
	};

	// Summary counts for terminal display
	const summaryItems: {
		category: string;
		count: number;
		severity: "🔴" | "🟡" | "🟢" | "ℹ️";
		fixable: boolean;
	}[] = [];
	const fullReport: string[] = [];
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const reviewDir = path.join(reviewRoot, ".pi-lens", "reviews");

	// Initialize runner tracker (no per-runner progress to avoid UI overwriting)
	const tracker = new RunnerTracker();

	// Helper to format elapsed time
	const formatElapsed = (ms: number): string =>
		ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

	// Runner 1: Design smells via ast-grep
	await tracker.run("ast-grep (design smells)", async () => {
		if (!(await clients.astGrep.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const configPath = path.join(
			getExtensionDir(),
			"..",
			"rules",
			"ast-grep-rules",
			".sgconfig.yml",
		);

		try {
			const result = safeSpawn(
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
					"!**/*.poc.test.ts",
					"--globs",
					"!**/test-utils.ts",
					"--globs",
					"!**/test-*.ts",
					"--globs",
					"!**/__tests__/**",
					"--globs",
					"!**/tests/**",
					"--globs",
					"!**/.pi-lens/**",
					"--globs",
					"!**/.pi/**",
					"--globs",
					"!**/node_modules/**",
					"--globs",
					"!**/.git/**",
					"--globs",
					"!**/.ruff_cache/**",
					targetPath,
				],
				{
					timeout: 30000,
				},
			);

			const output = result.stdout || result.stderr || "";
			if (output.trim() && result.status !== undefined) {
				const issues: Array<{
					file: string;
					line: number;
					rule: string;
					message: string;
				}> = [];

				const parseItems = (raw: string): Record<string, any>[] => {
					const trimmed = raw.trim();
					if (trimmed.startsWith("[")) {
						try {
							return JSON.parse(trimmed);
						} catch {
							return [];
						}
					}
					return raw.split("\n").flatMap((l: string) => {
						try {
							return [JSON.parse(l)];
						} catch {
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
						file: item.file || item.path || targetPath,
						line: lineNum + 1,
						rule: ruleId,
						message: message,
					});
				}

				const filteredIssues = issues.filter(
					(issue) => !isFalsePositive(categoryKey("ast-grep"), issue.file, issue.line),
				);

				if (filteredIssues.length > 0) {
					summaryItems.push({
						category: "ast-grep",
						count: filteredIssues.length,
						severity: filteredIssues.length > 10 ? "🔴" : "🟡",
						fixable: true,
					});

					let fullSection = `## ast-grep (Structural Issues)\n\n**${filteredIssues.length} issue(s) found**\n\n`;
					fullSection +=
						"| Line | Rule | Message |\n|------|------|--------|\n";
					for (const issue of filteredIssues) {
						fullSection += `| ${issue.line} | ${issue.rule} | ${issue.message} |\n`;
					}

					fullSection += "\n### 💡 How to Fix\n\n";
					const seenRules = new Set<string>();
					for (const issue of filteredIssues.slice(0, 5)) {
						if (seenRules.has(issue.rule)) continue;
						seenRules.add(issue.rule);
						const ruleDesc = clients.astGrep.getRuleDescription?.(issue.rule);
						if (ruleDesc?.note || ruleDesc?.fix) {
							fullSection += `**${issue.rule}:**\n`;
							if (ruleDesc.note) fullSection += `${ruleDesc.note}\n\n`;
							if (ruleDesc.fix)
								fullSection += `Suggested fix:\n\`\`\`typescript\n${ruleDesc.fix}\n\`\`\`\n\n`;
						}
					}

					fullReport.push(fullSection);
				}

				return { findings: filteredIssues.length, status: "done" };
			}
			return { findings: 0, status: "done" };
		} catch {
			return { findings: 0, status: "error" };
		}
	});

	// Runner 2: Similar functions
	await tracker.run("ast-grep (similar functions)", async () => {
		if (!(await clients.astGrep.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const similarGroups = await clients.astGrep.findSimilarFunctions(
			targetPath,
			"typescript",
		);

		// Filter out test files using centralized exclusion
		const filteredGroups = similarGroups
			.map((group) => ({
				...group,
				functions: group.functions.filter((fn) => shouldIncludeFile(fn.file)),
			}))
			.filter((group) => group.functions.length > 1); // Need at least 2 non-test functions

		if (filteredGroups.length > 0) {
			summaryItems.push({
				category: "Similar Functions",
				count: filteredGroups.length,
				severity: "🟡",
				fixable: true,
			});

			let fullSection = `## Similar Functions\n\n**${filteredGroups.length} group(s) of structurally similar functions**\n\n`;
			for (const group of filteredGroups) {
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

		return { findings: filteredGroups.length, status: "done" };
	});

	// Runner 3: Semantic similarity
	await tracker.run("semantic similarity (Amain)", async () => {
		try {
			const { glob } = await import("glob");
			const sourceFiles = await glob("**/*.ts", {
				cwd: targetPath,
				ignore: [
					"**/node_modules/**",
					"**/*.test.ts",
					"**/*.test.tsx",
					"**/*.spec.ts",
					"**/*.spec.tsx",
					"**/*.poc.test.ts",
					"**/*.poc.test.tsx",
					"**/test-utils.ts",
					"**/test-*.ts",
					"**/__tests__/**",
					"**/tests/**",
					"**/dist/**",
				],
			});

			if (sourceFiles.length === 0) {
				return { findings: 0, status: "done" };
			}

			// Filter out test files using centralized exclusion
			const absoluteFiles = sourceFiles
				.map((f) => path.join(targetPath, f))
				.filter(shouldIncludeFile);
			const index = await buildProjectIndex(targetPath, absoluteFiles);
			const topPairs = findTopSimilarPairs(index, 10);

			if (topPairs.length > 0) {
				summaryItems.push({
					category: "Semantic Duplicates",
					count: topPairs.length,
					severity: "🟡",
					fixable: true,
				});

				let fullSection = `## Semantic Duplicates (Amain Algorithm)\n\n`;
				fullSection += `**${topPairs.length} pair(s) with >90% semantic similarity**\n\n`;
				fullSection +=
					"Functions with different names/variables but similar logic structures.\n\n";

				for (const pair of topPairs) {
					fullSection += `### ${pair.func1} ↔ ${pair.func2}\n\n`;
					fullSection += `- Similarity: **${(pair.similarity * 100).toFixed(1)}%**\n`;
					fullSection += `- Consider consolidating or extracting shared logic\n\n`;
				}
				fullReport.push(fullSection);
			}

			return { findings: topPairs.length, status: "done" };
		} catch (err) {
			console.error("[booboo] Semantic similarity analysis failed:", err);
			return { findings: 0, status: "error" };
		}
	});

	// Runner 4: Complexity metrics
	await tracker.run("complexity metrics", async () => {
		const results: import("../clients/complexity-client.js").FileComplexity[] =
			[];
		const aiSlopIssues: string[] = [];
		// Use pre-collected sourceFiles (already filtered for artifacts)
		const files = sourceFiles.filter(shouldIncludeFile);

		for (const fullPath of files) {
			if (clients.complexity.isSupportedFile(fullPath)) {
				const metrics = clients.complexity.analyzeFile(fullPath);
				if (metrics) {
					results.push(metrics);
					// AI slop check - already filtered by shouldIncludeFile above
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

		if (results.length > 0) {
			const avgMI =
				results.reduce((a, b) => a + b.maintainabilityIndex, 0) /
				results.length;
			const avgCognitive =
				results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
			const avgCyclomatic =
				results.reduce((a, b) => a + b.cyclomaticComplexity, 0) /
				results.length;
			const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
			const maxCognitive = Math.max(
				...results.map((r) => r.cognitiveComplexity),
			);
			const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));

			// Only flag files with EXTREME issues (tuned to reduce false positives)
			// MI < 20 is "critically unmaintainable" (was < 40, too aggressive)
			const severeLowMI = results
				.filter((r) => r.maintainabilityIndex < 20 && !isTestFile(r.filePath))
				.sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
			// Cognitive > 80 is extreme (was > 30, flagged too many files)
			const veryHighCognitive = results
				.filter((r) => r.cognitiveComplexity > 80 && !isTestFile(r.filePath))
				.sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);
			// Deep nesting > 8 levels is extreme (was > 5, normal code hits this)
			const deepNesting = results
				.filter((r) => r.maxNestingDepth > 8 && !isTestFile(r.filePath))
				.sort((a, b) => b.maxNestingDepth - a.maxNestingDepth);

			let findings = 0;

			if (severeLowMI.length > 0) {
				findings += severeLowMI.length;
				summaryItems.push({
					category: "Low Maintainability",
					count: severeLowMI.length,
					severity: "🔴",
					fixable: false,
				});
			}
			if (veryHighCognitive.length > 0) {
				findings += veryHighCognitive.length;
				summaryItems.push({
					category: "Very High Complexity",
					count: veryHighCognitive.length,
					severity: "🔴",
					fixable: true,
				});
			}
			if (deepNesting.length > 0) {
				findings += deepNesting.length;
				summaryItems.push({
					category: "Deep Nesting",
					count: deepNesting.length,
					severity: "🟡",
					fixable: true,
				});
			}
			if (aiSlopIssues.length > 0) {
				findings += Math.floor(aiSlopIssues.length / 2);
				summaryItems.push({
					category: "AI Slop",
					count: Math.floor(aiSlopIssues.length / 2),
					severity: "🟡",
					fixable: true,
				});
			}

			let fullSection = `## Complexity Metrics\n\n**${results.length} file(s) scanned**\n\n`;
			fullSection += `### Summary\n\n| Metric | Value |\n|--------|-------|\n`;
			fullSection += `| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n`;
			fullSection += `| Min Maintainability Index | ${minMI.toFixed(1)} |\n`;
			fullSection += `| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n`;
			fullSection += `| Max Cognitive Complexity | ${maxCognitive} |\n`;
			fullSection += `| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n`;
			fullSection += `| Max Nesting Depth | ${maxNesting} |\n`;
			fullSection += `| Total Files | ${results.length} |\n\n`;

			// Report severe issues (thresholds match findings count)
			if (severeLowMI.length > 0) {
				fullSection += `### Low Maintainability (MI < 40)\n\n| File | MI | Cognitive | Cyclomatic | Nesting |\n|------|-----|-----------|------------|--------|\n`;
				for (const f of severeLowMI) {
					fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
				}
				fullSection += "\n";
			}

			if (veryHighCognitive.length > 0) {
				fullSection += `### Very High Cognitive Complexity (> 30)\n\n| File | Cognitive | MI | Cyclomatic | Nesting |\n|------|-----------|-----|------------|--------|\n`;
				for (const f of veryHighCognitive) {
					fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
				}
				fullSection += "\n";
			}

			if (deepNesting.length > 0) {
				fullSection += `### Deep Nesting (> 5 levels)\n\n| File | Nesting | Cognitive | MI |\n|------|---------|-----------|-----|\n`;
				for (const f of deepNesting) {
					fullSection += `| ${f.filePath} | ${f.maxNestingDepth} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} |\n`;
				}
				fullSection += "\n";
			}

			// Only show "All Files" table in verbose mode - it's informational noise
			if (pi.getFlag("lens-verbose")) {
				fullSection += `### All Files\n\n| File | MI | Cognitive | Cyclomatic | Nesting | Entropy |\n|------|-----|-----------|------------|---------|--------|\n`;
				for (const f of results.sort(
					(a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
				)) {
					fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} | ${f.codeEntropy.toFixed(2)} |\n`;
				}
				fullSection += "\n";
			}

			if (aiSlopIssues.length > 0) {
				fullSection += `### AI Slop Indicators\n\n`;
				for (const issue of aiSlopIssues) {
					fullSection += `${issue}\n`;
				}
				fullSection += "\n";
			}

			fullReport.push(fullSection);
			return { findings, status: "done" };
		}

		return { findings: 0, status: "done" };
	});

	// Runner 4: Tree-sitter patterns (complementary to ast-grep)
	// - Falls back to tree-sitter if ast-grep unavailable
	// - Detects patterns ast-grep can't easily do (multi-statement, complex nesting)
	// - Captures values for richer reporting
	await tracker.run("tree-sitter patterns", async () => {
		const client = new TreeSitterClient();
		if (!client.isAvailable()) {
			return { findings: 0, status: "skipped" };
		}

		const languageId = isTsProject ? "typescript" : "javascript";
		let findings = 0;
		const structuralIssues: Array<{
			file: string;
			line: number;
			pattern: string;
			severity: string;
			fixable: boolean;
			note?: string;
		}> = [];

		// Only run basic patterns if ast-grep is NOT available (avoid duplication)
		const astGrepAvailable = await clients.astGrep.ensureAvailable();

		if (!astGrepAvailable) {
			// Fallback: console.log detection (ast-grep normally handles this)
			const consoleLogs = await client.structuralSearch(
				"console.$METHOD($MSG)",
				languageId,
				targetPath,
				{ maxResults: 30, fileFilter: shouldIncludeFile },
			);

			for (const match of consoleLogs) {
				const method = match.captures.METHOD || "log";
				if (["log", "debug", "info", "warn"].includes(method)) {
					structuralIssues.push({
						file: match.file,
						line: match.line,
						pattern: `console.${method}()`,
						severity: "🟡",
						fixable: true,
						note: astGrepAvailable
							? undefined
							: "(fallback - ast-grep not available)",
					});
					findings++;
				}
			}
		}

		// Pattern 1: Nested promise chains (ast-grep struggles with multi-statement nesting)
		// This detects: .then().catch().then() chains that could be async/await
		const promiseChains = await client.structuralSearch(
			"$PROMISE.then($$$HANDLER1).catch($$$HANDLER2).then($$$HANDLER3)",
			languageId,
			targetPath,
			{ maxResults: 20, fileFilter: shouldIncludeFile },
		);

		for (const match of promiseChains) {
			structuralIssues.push({
				file: match.file,
				line: match.line,
				pattern: "deep promise chain (3+ levels)",
				severity: "🟡",
				fixable: true,
				note: "Consider converting to async/await for readability",
			});
			findings++;
		}

		// Pattern 2: Callback pyramids (error-first callbacks nested 3+ levels)
		const callbackPyramids = await client.structuralSearch(
			"$FUNC($$$ARGS, ($ERR, $$$PARAMS) => { $$$BODY })",
			languageId,
			targetPath,
			{ maxResults: 20, fileFilter: shouldIncludeFile },
		);

		// Filter for actual callback nesting (error parameter pattern)
		const nestedCallbacks = callbackPyramids.filter((m) => {
			const body = m.captures.BODY || "";
			// Check if body contains another callback
			return body.includes("(") && body.includes("=>");
		});

		for (const match of nestedCallbacks.slice(0, 10)) {
			structuralIssues.push({
				file: match.file,
				line: match.line,
				pattern: "callback pyramid (error-first pattern)",
				severity: "🟡",
				fixable: true,
				note: "Consider promisify + async/await",
			});
			findings++;
		}

		// Pattern 3: Mixed async patterns (async function + .then() + callback)
		// Detects inconsistent async styles in same function
		const asyncFunctions = await client.structuralSearch(
			"async function $NAME($$$PARAMS) { $BODY }",
			languageId,
			targetPath,
			{ maxResults: 50, fileFilter: shouldIncludeFile },
		);

		for (const match of asyncFunctions) {
			const body = match.captures.BODY || "";
			// Check if async function uses both await and .then()
			const hasAwait = body.includes("await");
			const hasThen = body.match(/\.\s*then\s*\(/);

			if (hasAwait && hasThen) {
				structuralIssues.push({
					file: match.file,
					line: match.line,
					pattern: "mixed async/await + promise chains",
					severity: "🟡",
					fixable: true,
					note: "Use consistent async style (prefer await)",
				});
				findings++;
			}
		}

		// Pattern 4: Complex nested if/else (ast-grep can do this, but tree-sitter captures entire block)
		const deepIfs = await client.structuralSearch(
			"if ($COND1) { if ($COND2) { if ($COND3) { $$$BODY } } }",
			languageId,
			targetPath,
			{ maxResults: 15, fileFilter: shouldIncludeFile },
		);

		for (const match of deepIfs) {
			structuralIssues.push({
				file: match.file,
				line: match.line,
				pattern: "deeply nested conditionals (3+ levels)",
				severity: "🟡",
				fixable: true,
				note: "Consider early returns or guard clauses",
			});
			findings++;
		}

		// Add to summary if issues found
		if (findings > 0) {
			summaryItems.push({
				category: astGrepAvailable
					? "Advanced Structural"
					: "Structural Patterns (fallback)",
				count: findings,
				severity: "🟡",
				fixable: true,
			});

			// Build detailed report
			let fullSection = `## ${astGrepAvailable ? "Advanced Structural" : "Structural Patterns"} (Tree-sitter)\n\n`;
			fullSection += `**${findings} issue(s) found**`;
			if (!astGrepAvailable) {
				fullSection += ` *(ast-grep not available - showing basic + advanced patterns)*`;
			}
			fullSection += `\n\n`;

			// Group by pattern type
			const byPattern: Record<string, typeof structuralIssues> = {};
			for (const issue of structuralIssues) {
				if (!byPattern[issue.pattern]) byPattern[issue.pattern] = [];
				byPattern[issue.pattern].push(issue);
			}

			for (const [pattern, issues] of Object.entries(byPattern)) {
				fullSection += `### ${pattern} (${issues.length})\n\n`;
				fullSection += "| File | Line | Note |\n|------|------|------|\n";
				for (const issue of issues.slice(0, 10)) {
					fullSection += `| ${issue.file} | ${issue.line} | ${issue.note || ""} |\n`;
				}
				if (issues.length > 10) {
					fullSection += `| ... | ... | ... |\n`;
				}
				fullSection += "\n";
			}

			fullReport.push(fullSection);
		}

		return { findings, status: "done" };
	});

	// Runner 5: TODOs (cache test edit)
	await tracker.run("TODO scanner", async () => {
		const todoResult = clients.todo.scanDirectory(targetPath);

		if (todoResult.items.length > 0) {
			summaryItems.push({
				category: "TODOs",
				count: todoResult.items.length,
				severity: "ℹ️",
				fixable: false,
			});

			let fullSection = `## TODOs / Annotations\n\n`;
			fullSection += `**${todoResult.items.length} annotation(s) found**\n\n`;
			fullSection +=
				"| Type | File | Line | Text |\n|------|------|------|------|\n";
			for (const item of todoResult.items) {
				fullSection += `| ${item.type} | ${item.file} | ${item.line} | ${item.message} |\n`;
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}

		return { findings: todoResult.items.length, status: "done" };
	});

	// Runner 6: Dead code
	await tracker.run("dead code (Knip)", async () => {
		if (!(await clients.knip.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const knipResult = clients.knip.analyze(targetPath, getKnipIgnorePatterns());

		// Filter out test file issues as additional safeguard
		const filteredIssues = knipResult.issues.filter(
			(issue) => !issue.file || shouldIncludeFile(issue.file),
		);

		if (filteredIssues.length > 0) {
			summaryItems.push({
				category: "Dead Code",
				count: filteredIssues.length,
				severity: "🟡",
				fixable: true,
			});

			let fullSection = `## Dead Code (Knip)\n\n`;
			fullSection += `**${filteredIssues.length} issue(s) found**\n\n`;
			fullSection += "| Type | Name | File |\n|------|------|------|\n";
			for (const issue of filteredIssues) {
				fullSection += `| ${issue.type} | ${issue.name} | ${issue.file ?? ""} |\n`;
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}

		return { findings: filteredIssues.length, status: "done" };
	});

	// Runner 7: Duplicate code
	await tracker.run("duplicate code (jscpd)", async () => {
		if (!(await clients.jscpd.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		// In TS projects, exclude .js files (they're compiled artifacts)
		const jscpdResult = clients.jscpd.scan(targetPath, 5, 50, isTsProject);

		// Filter out test file duplicates using centralized exclusion
		const filteredClones = jscpdResult.clones.filter(
			(dup) => shouldIncludeFile(dup.fileA) && shouldIncludeFile(dup.fileB),
		);

		if (filteredClones.length > 0) {
			summaryItems.push({
				category: "Duplicates",
				count: filteredClones.length,
				severity: "🟡",
				fixable: true,
			});

			let fullSection = `## Code Duplication (jscpd)\n\n`;
			fullSection += `**${filteredClones.length} duplicate block(s) found** (${jscpdResult.duplicatedLines}/${jscpdResult.totalLines} lines, ${jscpdResult.percentage.toFixed(1)}%)\n\n`;
			fullSection +=
				"| File A | Line A | File B | Line B | Lines | Tokens |\n|--------|--------|--------|--------|-------|--------|\n";
			for (const dup of filteredClones) {
				fullSection += `| ${dup.fileA} | ${dup.startA} | ${dup.fileB} | ${dup.startB} | ${dup.lines} | ${dup.tokens} |\n`;
			}
			fullSection += "\n";
			fullReport.push(fullSection);
		}

		return { findings: filteredClones.length, status: "done" };
	});

	// Runner 8: Type coverage
	await tracker.run("type coverage", async () => {
		if (!clients.typeCoverage.isAvailable()) {
			return { findings: 0, status: "skipped" };
		}

		const tcResult = clients.typeCoverage.scan(targetPath);

		if (tcResult.percentage < 100) {
			// Filter out test file locations using centralized exclusion
			const filteredLocations = tcResult.untypedLocations.filter((u) =>
				shouldIncludeFile(u.file),
			);

			const filesWithLowCoverage = new Set(
				filteredLocations
					.filter(() => tcResult.percentage < 90)
					.map((u) => u.file),
			).size;

			summaryItems.push({
				category: "Type Coverage",
				count: filesWithLowCoverage || 1,
				severity: tcResult.percentage < 90 ? "🟡" : "ℹ️",
				fixable: false,
			});

			let fullSection = `## Type Coverage\n\n**${tcResult.percentage.toFixed(1)}% typed** (${tcResult.typed}/${tcResult.total} identifiers)\n\n`;
			const byFile: Record<string, number> = {};
			for (const u of filteredLocations) {
				byFile[u.file] = (byFile[u.file] || 0) + 1;
			}
			const sortedFiles = Object.entries(byFile)
				.filter(([file]) => shouldIncludeFile(file))
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);

			if (sortedFiles.length > 0) {
				fullSection += `### Top Files by Untyped Count\n\n| File | Untyped Count |\n|------|---------------|\n`;
				for (const [file, count] of sortedFiles) {
					fullSection += `| ${file} | ${count} |\n`;
				}
				if (Object.keys(byFile).length > 10) {
					fullSection += `| ... | +${Object.keys(byFile).length - 10} more files |\n`;
				}
			}
			fullSection += "\n";
			fullReport.push(fullSection);

			return { findings: filesWithLowCoverage || 1, status: "done" };
		}

		return { findings: 0, status: "done" };
	});

	// Runner 9: Circular deps
	await tracker.run("circular deps (Madge)", async () => {
		if (pi.getFlag("no-madge") || !(await clients.depChecker.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const { circular } = clients.depChecker.scanProject(targetPath);

		// Filter out circular deps involving only test files using centralized exclusion
		const filteredCircular = circular.filter((dep) => {
			// Keep if ANY file in the chain is not a test file
			return dep.path.some((file) => shouldIncludeFile(file));
		});

		if (filteredCircular.length > 0) {
			summaryItems.push({
				category: "Circular Deps",
				count: filteredCircular.length,
				severity: "🔴",
				fixable: false,
			});

			let fullSection = `## Circular Dependencies (Madge)\n\n`;
			fullSection += `**${filteredCircular.length} circular chain(s) found**\n\n`;
			for (const dep of filteredCircular) {
				fullSection += `- ${dep.path.join(" → ")}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}

		return { findings: filteredCircular.length, status: "done" };
	});

	// Runner 10: Arch rules
	await tracker.run("architectural rules", async () => {
		// Always refresh config for the requested target path.
		clients.architect.loadConfig(targetPath);

		if (!clients.architect.hasConfig()) {
			return { findings: 0, status: "skipped" };
		}

		const archViolations: Array<{ file: string; message: string }> = [];

		// Use pre-collected sourceFiles (already filtered for artifacts and exclusions)
		for (const fullPath of sourceFiles) {
			if (isTestFile(fullPath)) continue;
			const relPath = path.relative(targetPath, fullPath).replace(/\\/g, "/");
			const content = nodeFs.readFileSync(fullPath, "utf-8");
			const lineCount = content.split("\n").length;
			for (const v of clients.architect.checkFile(relPath, content)) {
				archViolations.push({ file: relPath, message: v.message });
			}
			const sizeV = clients.architect.checkFileSize(relPath, lineCount);
			if (sizeV) archViolations.push({ file: relPath, message: sizeV.message });
		}

		if (archViolations.length > 0) {
			summaryItems.push({
				category: "Architectural",
				count: archViolations.length,
				severity: "🔴",
				fixable: false,
			});

			let fullSection = `## Architectural Rules\n\n`;
			fullSection += `**${archViolations.length} violation(s) found**\n\n`;
			for (const v of archViolations) {
				fullSection += `- **${v.file}**: ${v.message}\n`;
			}
			fullReport.push(`${fullSection}\n`);
		}

		return { findings: archViolations.length, status: "done" };
	});

	// Runner 11: Production Readiness (inspired by pi-validate)
	await tracker.run("production readiness", async () => {
		const readiness = validateProductionReadiness(targetPath);

		// Add to summary if not perfect
		if (readiness.overallScore < 100) {
			const severity =
				readiness.grade === "A"
					? "🟢"
					: readiness.grade === "B"
						? "🟢"
						: readiness.grade === "C"
							? "🟡"
							: "🟠";

			// Count issues across all categories
			const totalIssues_ = Object.values(readiness.categories).reduce(
				(sum, cat) => sum + cat.issues.length,
				0,
			);

			if (totalIssues_ > 0) {
				summaryItems.push({
					category: "Production Readiness",
					count: totalIssues_,
					severity: severity as "🔴" | "🟡" | "🟢" | "ℹ️",
					fixable: true,
				});
			}
		}

		// Add to full report
		let section = `## Production Readiness\n\n`;
		section += `**Score:** ${readiness.overallScore}/100 **Grade:** ${readiness.grade}\n\n`;

		for (const [key, cat] of Object.entries(readiness.categories)) {
			section += `### ${key.charAt(0).toUpperCase() + key.slice(1)} (${cat.score}/100)\n\n`;
			if (cat.details.length > 0) {
				for (const detail of cat.details) {
					section += `- ${detail}\n`;
				}
			}
			if (cat.issues.length > 0) {
				for (const issue of cat.issues) {
					section += `- ⚠️ ${issue}\n`;
				}
			}
			if (cat.details.length === 0 && cat.issues.length === 0) {
				section += `- ✅ No issues\n`;
			}
			section += "\n";
		}

		fullReport.push(section);

		// Add metadata to report
		const criticalIssues = [];
		for (const [key, cat] of Object.entries(readiness.categories)) {
			for (const issue of cat.issues) {
				// Flag critical issues
				if (key === "code" && issue.includes("debugger")) {
					criticalIssues.push(`[CRITICAL] ${issue}`);
				} else if (key === "tests" && cat.score < 50) {
					criticalIssues.push(`[CRITICAL] No tests found`);
				}
			}
		}

		return {
			findings: Object.values(readiness.categories).reduce(
				(sum, cat) => sum + cat.issues.length,
				0,
			),
			status: "done",
		};
	});

	// --- Create structured JSON report ---
	nodeFs.mkdirSync(reviewDir, { recursive: true });
	const projectName = path.basename(reviewRoot);

	const totalIssues = summaryItems.reduce((sum, s) => sum + s.count, 0);
	const fixableCount = summaryItems
		.filter((s) => s.fixable)
		.reduce((sum, s) => sum + s.count, 0);
	const refactorNeeded = summaryItems
		.filter((s) => !s.fixable)
		.reduce((sum, s) => sum + s.count, 0);

	// Build runner summary
	const runnerSummary = tracker.getRunners().map((r) => ({
		name: r.name,
		status: r.status,
		findings: r.findings,
		time: formatElapsed(r.elapsedMs),
	}));

	const jsonReport = {
		meta: {
			timestamp: new Date().toISOString(),
			project: projectName,
			path: targetPath,
			totalIssues,
			fixableCount,
			refactorNeeded,
			// New: runner execution details
			runners: runnerSummary,
			totalTime: formatElapsed(
				runnerSummary.reduce((sum, r) => {
					const ms = r.time.endsWith("ms")
						? parseInt(r.time, 10)
						: parseFloat(r.time) * 1000;
					return sum + (Number.isNaN(ms) ? 0 : ms);
				}, 0),
			),
		},
		// New: project metadata
		project: {
			type: projectMeta.type,
			name: projectMeta.name,
			version: projectMeta.version,
			packageManager: projectMeta.packageManager,
			languages: projectMeta.languages,
			hasTests: projectMeta.hasTests,
			testFramework: projectMeta.testFramework,
			hasLinting: projectMeta.hasLinting,
			linter: projectMeta.linter,
			hasFormatting: projectMeta.hasFormatting,
			formatter: projectMeta.formatter,
			hasTypeScript: projectMeta.hasTypeScript,
			configFiles: projectMeta.configFiles,
			scripts: projectMeta.scripts,
		},
		// New: available commands for the project
		commands: availableCommands,
		byCategory: summaryItems.reduce(
			(acc, item) => {
				acc[item.category] = {
					count: item.count,
					severity: item.severity,
					fixable: item.fixable,
					falsePositivePrefix: `${categoryKey(item.category)}:`,
				};
				return acc;
			},
			{} as Record<
				string,
				{
					count: number;
					severity: string;
					fixable: boolean;
					falsePositivePrefix: string;
				}
			>,
		),
		howToMarkFalsePositive: {
			command: "Ignore via AGENTS.md rules or suppress comments",
			format: "Add to .claude/rules or use biome/oxlint ignore comments",
			examples: [
				"// biome-ignore lint/suspicious/noConsole: intentional debug",
				"// oxlint-disable-next-line no-console",
			],
		},
		sessionFile: path.join(reviewRoot, ".pi-lens", "fix-session.json"),
		details: fullReport.join("\n"),
	};

	const jsonPath = path.join(reviewDir, `booboo-${timestamp}.json`);
	nodeFs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf-8");

	// --- Create markdown report ---

	// Build project info section
	let projectSection = `## Project Info\n\n**Type:** ${projectMeta.type}`;
	if (projectMeta.name) projectSection += ` | **Name:** ${projectMeta.name}`;
	if (projectMeta.version)
		projectSection += ` | **Version:** ${projectMeta.version}`;
	if (projectMeta.packageManager)
		projectSection += `\n**Package Manager:** ${projectMeta.packageManager}`;
	if (projectMeta.languages.length > 0)
		projectSection += `\n**Languages:** ${projectMeta.languages.join(", ")}`;

	// Tools
	const tools: string[] = [];
	if (projectMeta.testFramework) tools.push(`🧪 ${projectMeta.testFramework}`);
	else if (projectMeta.hasTests) tools.push("🧪 tests");
	if (projectMeta.linter) tools.push(`🔍 ${projectMeta.linter}`);
	if (projectMeta.formatter) tools.push(`✨ ${projectMeta.formatter}`);
	if (tools.length > 0) projectSection += `\n**Tools:** ${tools.join(" | ")}`;

	// Available commands
	if (availableCommands.length > 0) {
		projectSection += `\n\n### Available Commands\n\n| Action | Command |\n|--------|---------|`;
		for (const cmd of availableCommands) {
			projectSection += `\n| ${cmd.action} | \`${cmd.command}\` |`;
		}
	}

	const mdReport = `# Code Review: ${projectName}

**Scanned:** ${jsonReport.meta.timestamp}
**Path:** \`${targetPath}\`
**Summary:** ${jsonReport.meta.totalIssues} issues | ${jsonReport.meta.fixableCount} fixable | ${jsonReport.meta.refactorNeeded} need refactor
**Total Time:** ${jsonReport.meta.totalTime}

${projectSection}

## Runner Summary

| Runner | Status | Findings | Time |
|--------|--------|----------|------|
${runnerSummary.map((r) => `| ${r.name} | ${r.status} | ${r.findings} | ${r.time} |`).join("\n")}

---

${fullReport.join("\n")}`;

	const mdPath = path.join(reviewDir, `booboo-${timestamp}.md`);
	nodeFs.writeFileSync(mdPath, mdReport, "utf-8");

	// --- Brief terminal summary ---
	if (summaryItems.length === 0) {
		ctx.ui.notify("✓ Code review clean", "info");
	} else {
		const { totalIssues, fixableCount, refactorNeeded } = jsonReport.meta;

		// Build runner lines for terminal output
		const runnerLines = tracker
			.getRunners()
			.filter((r) => r.findings > 0)
			.map(
				(r) =>
					`  ${r.status === "error" ? "✗" : "⚠"} ${r.name}: ${r.findings} finding${r.findings !== 1 ? "s" : ""} (${formatElapsed(r.elapsedMs)})`,
			);

		const summaryLines = [
			`📊 Code Review: ${totalIssues} issues`,
			...runnerLines,
			`  ⏱️  Total: ${jsonReport.meta.totalTime}`,
			`📄 MD: ${mdPath}`,
		];

		ctx.ui.notify(summaryLines.join("\n"), "info");
	}
}

// ============================================================================
// Semantic Similarity Helper
// ============================================================================

interface SimilarPair {
	func1: string;
	func2: string;
	similarity: number;
}

/**
 * Find top N most similar function pairs in the project index
 * Uses canonical pair ordering to avoid duplicates (A,B) vs (B,A)
 */
function findTopSimilarPairs(
	index: ProjectIndex,
	maxPairs: number,
): SimilarPair[] {
	const entries = Array.from(index.entries.values());
	const seenPairs = new Set<string>();
	const pairs: SimilarPair[] = [];

	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const entry1 = entries[i];
			const entry2 = entries[j];

			// Skip if same file (we want cross-file duplicates)
			if (entry1.filePath === entry2.filePath) continue;

			const similarity = calculateSimilarity(entry1.matrix, entry2.matrix);

			if (similarity >= 0.9) {
				// Canonical pair key (sorted to avoid duplicates)
				const pairKey = [entry1.id, entry2.id].sort().join("::");
				if (seenPairs.has(pairKey)) continue;
				seenPairs.add(pairKey);

				pairs.push({
					func1: entry1.id,
					func2: entry2.id,
					similarity,
				});
			}
		}
	}

	// Sort by similarity descending, take top N
	return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, maxPairs);
}
