import * as nodeFs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { DependencyChecker } from "../clients/dependency-checker.js";
import { createDispatchContext } from "../clients/dispatch/dispatcher.js";
import { evaluateRules } from "../clients/dispatch/fact-rule-runner.js";
import { runProviders } from "../clients/dispatch/fact-runner.js";
import { FactStore } from "../clients/dispatch/fact-store.js";
import {
	getKnipIgnorePatterns,
	getProjectIgnoreGlobs,
	isTestFile,
} from "../clients/file-utils.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import { validateProductionReadiness } from "../clients/production-readiness.js";
import {
	detectProjectMetadata,
	getAvailableCommands,
} from "../clients/project-metadata.js";
import { RunnerTracker } from "../clients/runner-tracker.js";
import { safeSpawn } from "../clients/safe-spawn.js";
import {
	collectSourceFiles,
	getFilterStats,
} from "../clients/source-filter.js";
import type { TodoScanner } from "../clients/todo-scanner.js";
import { TreeSitterClient } from "../clients/tree-sitter-client.js";
import { queryLoader } from "../clients/tree-sitter-query-loader.js";
import type { TypeCoverageClient } from "../clients/type-coverage-client.js";
// Side-effect import: registers all fact providers and fact rules
import "../clients/dispatch/integration.js";

const ROOT_MARKERS = [
	"package.json",
	"tsconfig.json",
	".git",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
];

function hasRootMarker(dir: string): boolean {
	return ROOT_MARKERS.some((m) => nodeFs.existsSync(path.join(dir, m)));
}

function resolveProjectRoot(startDir: string): string {
	// Walk up: find nearest ancestor with a root marker
	let dir = startDir;
	const fsRoot = path.parse(dir).root;
	while (dir !== fsRoot) {
		if (hasRootMarker(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// Walk down one level: if exactly one immediate subdir has a root marker, use it
	try {
		const entries = nodeFs.readdirSync(startDir, { withFileTypes: true });
		const candidates = entries
			.filter((e) => e.isDirectory())
			.map((e) => path.join(startDir, e.name))
			.filter(hasRootMarker);
		if (candidates.length === 1) return candidates[0];
	} catch {
		// unreadable dir — fall through
	}

	return startDir;
}

// Module-level singleton — web-tree-sitter WASM must only be initialized once per process
let _sharedTreeSitterClient: TreeSitterClient | null = null;
function getSharedTreeSitterClient(): TreeSitterClient {
	if (!_sharedTreeSitterClient) {
		_sharedTreeSitterClient = new TreeSitterClient();
	}
	return _sharedTreeSitterClient;
}

const EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
};

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
	},
	pi: ExtensionAPI,
) {
	const requestedPath = args.trim() || ctx.cwd || process.cwd();
	const targetPath = resolveProjectRoot(path.resolve(requestedPath));
	const reviewRoot = targetPath;

	// Build --globs exclusion args for sg scan from centralized .gitignore matching.
	const sgExcludeGlobs = getProjectIgnoreGlobs(targetPath).flatMap((glob) => [
		"--globs",
		`!${glob}`,
	]);

	const categoryKey = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

	// Tunable thresholds — adjust these to reduce false positives across all projects
	const FACT_SEVERITY_FILTER = new Set(["error", "warning"]);
	const MIN_TREE_SITTER_HITS_PER_RULE = 3;

	// Detect project metadata for richer reporting
	const projectMeta = detectProjectMetadata(targetPath);
	const langs = new Set(projectMeta.languages);

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
					"!**/vendor/**",
					"--globs",
					"!**/third_party/**",
					"--globs",
					"!**/third-party/**",
					"--globs",
					"!**/.git/**",
					"--globs",
					"!**/.ruff_cache/**",
					...sgExcludeGlobs,
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
					(issue) =>
						!isFalsePositive(categoryKey("ast-grep"), issue.file, issue.line),
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
					const warnings = clients.complexity
						.checkThresholds(metrics)
						.filter((w) => !w.includes("entropy") && !w.includes("AI-style"));
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
				fullSection += `### Low Maintainability (MI < 20)\n\n| File | MI | Cognitive | Cyclomatic | Nesting |\n|------|-----|-----------|------------|--------|\n`;
				for (const f of severeLowMI) {
					fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
				}
				fullSection += "\n";
			}

			if (veryHighCognitive.length > 0) {
				fullSection += `### Very High Cognitive Complexity (> 80)\n\n| File | Cognitive | MI | Cyclomatic | Nesting |\n|------|-----------|-----|------------|--------|\n`;
				for (const f of veryHighCognitive) {
					fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
				}
				fullSection += "\n";
			}

			if (deepNesting.length > 0) {
				fullSection += `### Deep Nesting (> 8 levels)\n\n| File | Nesting | Cognitive | MI |\n|------|---------|-----------|-----|\n`;
				for (const f of deepNesting) {
					fullSection += `| ${f.filePath} | ${f.maxNestingDepth} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} |\n`;
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

	// TODO(#173): migrate this tree-sitter/fact-rule project scan to consume
	// clients/project-diagnostics/scanner.ts once the Markdown report renderer can
	// group normalized ProjectDiagnostic records into the richer booboo sections.
	// Runner 4: Tree-sitter patterns — language-aware, driven by .yml rule files
	// Uses the same queryLoader + singleton client as the per-write dispatch runner.
	// Covers all languages: TypeScript, JavaScript, Python, Go, Rust, Ruby.
	await tracker.run("tree-sitter patterns", async () => {
		const client = getSharedTreeSitterClient();
		if (!client.isAvailable()) return { findings: 0, status: "skipped" };

		const initialized = await client.init();
		if (!initialized) return { findings: 0, status: "skipped" };

		await queryLoader.loadQueries(targetPath);
		const allQueries = queryLoader.getAllQueries();
		if (allQueries.length === 0) return { findings: 0, status: "skipped" };

		// Deduplicate structural rules that fire per nesting level
		const DEDUP_PER_FILE = new Set(["deep-promise-chain", "deep-nesting"]);

		interface TSIssue {
			file: string;
			line: number;
			ruleId: string;
			severity: string;
			message: string;
		}

		const byRule = new Map<string, TSIssue[]>();
		let findings = 0;

		for (const filePath of allFiles) {
			if (isTestFile(filePath)) continue;
			const ext = filePath.slice(filePath.lastIndexOf("."));
			const langId = EXT_TO_LANG[ext];
			if (!langId) continue;

			const langQueries = allQueries.filter(
				(q) =>
					q.language === langId ||
					(langId === "javascript" && q.language === "typescript"),
			);
			if (langQueries.length === 0) continue;

			for (const query of langQueries) {
				let matches;
				try {
					matches = await client.runQueryOnFile(query, filePath, langId, {
						maxResults: 20,
					});
				} catch {
					continue;
				}
				if (!matches?.length) continue;

				const relFile = path.relative(targetPath, filePath);
				const bucket = byRule.get(query.id) ?? [];

				if (DEDUP_PER_FILE.has(query.id)) {
					if (!bucket.some((h) => h.file === relFile)) {
						bucket.push({
							file: relFile,
							line: matches[0].line ?? 1,
							ruleId: query.id,
							severity: query.severity,
							message: query.message,
						});
						findings++;
					}
				} else {
					for (const m of matches) {
						bucket.push({
							file: relFile,
							line: m.line ?? 1,
							ruleId: query.id,
							severity: query.severity,
							message: query.message,
						});
						findings++;
					}
				}
				byRule.set(query.id, bucket);
			}
		}

		// Suppress rules with fewer than N hits (false positives from one-off matches)
		for (const [ruleId, bucket] of byRule) {
			if (bucket.length < MIN_TREE_SITTER_HITS_PER_RULE) {
				byRule.delete(ruleId);
				findings -= bucket.length;
			}
		}

		if (findings === 0) return { findings: 0, status: "done" };

		const errorCount = [...byRule.values()]
			.flat()
			.filter((i) => i.severity === "error").length;
		summaryItems.push({
			category: "Tree-sitter Patterns",
			count: findings,
			severity: errorCount > 0 ? "🔴" : "🟡",
			fixable: true,
		});

		// Sort rules by hit count descending
		const sorted = [...byRule.entries()].sort(
			(a, b) => b[1].length - a[1].length,
		);
		let fullSection = `## Tree-sitter Patterns\n\n**${findings} issue(s) across ${byRule.size} rule(s)**\n\n`;
		for (const [ruleId, issues] of sorted) {
			const sev = issues[0].severity === "error" ? "🔴" : "🟡";
			fullSection += `### ${sev} ${ruleId} (${issues.length})\n\n`;
			fullSection += `${issues[0].message}\n\n`;
			fullSection += "| File | Line |\n|------|------|\n";
			for (const issue of issues.slice(0, 10)) {
				fullSection += `| ${issue.file} | ${issue.line} |\n`;
			}
			if (issues.length > 10)
				fullSection += `| ... | +${issues.length - 10} more |\n`;
			fullSection += "\n";
		}
		fullReport.push(fullSection);

		return { findings, status: "done" };
	});

	// Runner 4b: Fact rules — semantic analysis over TS/JS files
	// Runs all registered fact rules (error-obscuring, async-noise, unsafe-boundary, etc.)
	// using the same provider/rule pipeline as the per-write dispatch system.
	await tracker.run("fact rules", async () => {
		const boobooFacts = new FactStore();
		const tsFiles = allFiles.filter((f) => /\.tsx?$/.test(f) && !isTestFile(f));
		if (tsFiles.length === 0) return { findings: 0, status: "skipped" };

		interface FactIssue {
			file: string;
			line: number;
			ruleId: string;
			severity: string;
			message: string;
		}
		const byRule = new Map<string, FactIssue[]>();
		let findings = 0;

		for (const filePath of tsFiles) {
			boobooFacts.clearFileFactsFor(filePath);
			const ctx = createDispatchContext(
				filePath,
				targetPath,
				pi,
				boobooFacts,
				false,
			);

			try {
				await runProviders(ctx);
			} catch {
				continue;
			}

			const diagnostics = evaluateRules(ctx).filter((d) =>
				FACT_SEVERITY_FILTER.has(d.severity ?? "warning"),
			);
			for (const diag of diagnostics) {
				const relFile = path.relative(targetPath, filePath);
				const bucket = byRule.get(diag.rule ?? diag.id) ?? [];
				bucket.push({
					file: relFile,
					line: diag.line ?? 1,
					ruleId: diag.rule ?? diag.id,
					severity: diag.severity ?? "warning",
					message: diag.message ?? "",
				});
				byRule.set(diag.rule ?? diag.id, bucket);
				findings++;
			}
		}

		if (findings === 0) return { findings: 0, status: "done" };

		const errorCount = [...byRule.values()]
			.flat()
			.filter((i) => i.severity === "error").length;
		summaryItems.push({
			category: "Fact Rules",
			count: findings,
			severity: errorCount > 0 ? "🔴" : "🟡",
			fixable: true,
		});

		const sorted = [...byRule.entries()].sort(
			(a, b) => b[1].length - a[1].length,
		);
		let fullSection = `## Fact Rules (Semantic Analysis)\n\n**${findings} issue(s) across ${byRule.size} rule(s)**\n\n`;
		for (const [ruleId, issues] of sorted) {
			const sev = issues[0].severity === "error" ? "🔴" : "🟡";
			fullSection += `### ${sev} ${ruleId} (${issues.length})\n\n`;
			fullSection += `${issues[0].message}\n\n`;
			fullSection += "| File | Line |\n|------|------|\n";
			for (const issue of issues.slice(0, 10)) {
				fullSection += `| ${issue.file} | ${issue.line} |\n`;
			}
			if (issues.length > 10)
				fullSection += `| ... | +${issues.length - 10} more |\n`;
			fullSection += "\n";
		}
		fullReport.push(fullSection);

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

	// Runner 6: Dead code (JS/TS only — Knip is a JS/TS tool)
	await tracker.run("dead code (Knip)", async () => {
		if (!langs.has("javascript") && !langs.has("typescript")) {
			return { findings: 0, status: "skipped" };
		}
		if (!(await clients.knip.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const knipResult = await clients.knip.analyze(
			targetPath,
			getKnipIgnorePatterns(),
		);

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
		const jscpdResult = await clients.jscpd.scan(
			targetPath,
			5,
			50,
			isTsProject,
		);

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
		if (!langs.has("typescript")) {
			return { findings: 0, status: "skipped" };
		}
		if (!(await clients.typeCoverage.isAvailableAsync())) {
			return { findings: 0, status: "skipped" };
		}

		const tcResult = await clients.typeCoverage.scanAsync(targetPath);

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
			fullSection +=
				"Type coverage highlights identifiers that resolve to `any` (implicit or explicit). Inferred non-`any` types are treated as typed.\n\n";
			const byFile: Record<string, number> = {};
			for (const u of filteredLocations) {
				byFile[u.file] = (byFile[u.file] || 0) + 1;
			}
			const sortedFiles = Object.entries(byFile)
				.filter(([file]) => shouldIncludeFile(file))
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);

			if (sortedFiles.length > 0) {
				fullSection += `### Top Files by Any-Typed Identifier Count\n\n| File | Any-Typed Count |\n|------|-----------------|\n`;
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

	// Runner 9: Circular deps (JS/TS only — Madge is a JS/TS tool)
	await tracker.run("circular deps (Madge)", async () => {
		if (!langs.has("javascript") && !langs.has("typescript")) {
			return { findings: 0, status: "skipped" };
		}
		if (!(await clients.depChecker.ensureAvailable())) {
			return { findings: 0, status: "skipped" };
		}

		const { circular } = await clients.depChecker.scanProject(targetPath);

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

	// Runner 12: Compiler checks (language-aware)
	// Runs the project's native type-checker/compiler for whole-workspace type errors.
	// Each language uses its canonical batch tool — these catch cross-file breakage
	// that per-file LSP checks miss (e.g. broken imports, declaration emit errors).
	await tracker.run("compiler checks", async () => {
		interface CompilerIssue {
			file: string;
			line: number;
			col: number;
			severity: string;
			code: string;
			message: string;
			compiler: string;
		}

		const issues: CompilerIssue[] = [];

		// TypeScript: tsc --noEmit
		if (
			langs.has("typescript") &&
			nodeFs.existsSync(path.join(targetPath, "tsconfig.json"))
		) {
			const result = safeSpawn(
				"npx",
				["tsc", "--noEmit", "--pretty", "false"],
				{
					cwd: targetPath,
					timeout: 60_000,
				},
			);
			const output = (result.stdout || "") + (result.stderr || "");
			// tsc --pretty false format: "file(line,col): error TS####: message"
			const tscRe =
				/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
			for (const m of output.matchAll(tscRe)) {
				const [, file, line, col, sev, code, msg] = m;
				const absFile = path.isAbsolute(file)
					? file
					: path.join(targetPath, file);
				if (shouldIncludeFile(absFile)) {
					issues.push({
						file: path.relative(targetPath, absFile),
						line: parseInt(line, 10),
						col: parseInt(col, 10),
						severity: sev,
						code,
						message: msg.trim(),
						compiler: "tsc",
					});
				}
			}
		}

		// Go: go vet ./...
		if (langs.has("go") && nodeFs.existsSync(path.join(targetPath, "go.mod"))) {
			const result = safeSpawn("go", ["vet", "./..."], {
				cwd: targetPath,
				timeout: 60_000,
			});
			const output = (result.stderr || "") + (result.stdout || "");
			// go vet format: "file.go:line:col: message" or "file.go:line: message"
			const goRe = /^(.+\.go):(\d+)(?::(\d+))?:\s+(.+)$/gm;
			for (const m of output.matchAll(goRe)) {
				const [, file, line, col, msg] = m;
				const absFile = path.isAbsolute(file)
					? file
					: path.join(targetPath, file);
				issues.push({
					file: path.relative(targetPath, absFile),
					line: parseInt(line, 10),
					col: col ? parseInt(col, 10) : 1,
					severity: "error",
					code: "go-vet",
					message: msg.trim(),
					compiler: "go vet",
				});
			}
		}

		// Rust: cargo check --message-format=json
		if (
			langs.has("rust") &&
			nodeFs.existsSync(path.join(targetPath, "Cargo.toml"))
		) {
			const result = safeSpawn(
				"cargo",
				["check", "--message-format=json", "--quiet"],
				{
					cwd: targetPath,
					timeout: 120_000,
				},
			);
			const output = result.stdout || "";
			for (const line of output.split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.reason !== "compiler-message") continue;
					const inner = msg.message;
					if (!inner || !["error", "warning"].includes(inner.level)) continue;
					const span =
						inner.spans?.find((s: { is_primary: boolean }) => s.is_primary) ??
						inner.spans?.[0];
					if (!span) continue;
					const absFile = span.file_name
						? path.isAbsolute(span.file_name)
							? span.file_name
							: path.join(targetPath, span.file_name)
						: targetPath;
					issues.push({
						file: path.relative(targetPath, absFile),
						line: span.line_start ?? 1,
						col: span.column_start ?? 1,
						severity: inner.level,
						code: inner.code?.code ?? "cargo",
						message: inner.message,
						compiler: "cargo check",
					});
				} catch {
					// non-JSON line
				}
			}
		}

		// Python: pyright --outputjson (preferred) or mypy
		if (langs.has("python")) {
			const hasPyright =
				safeSpawn("pyright", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasPyright) {
				const result = safeSpawn("pyright", ["--outputjson", "."], {
					cwd: targetPath,
					timeout: 60_000,
				});
				const output = result.stdout || "";
				try {
					const json = JSON.parse(output);
					for (const diag of json?.generalDiagnostics ?? []) {
						if (!["error", "warning"].includes(diag.severity)) continue;
						const absFile = diag.file
							? path.isAbsolute(diag.file)
								? diag.file
								: path.join(targetPath, diag.file)
							: targetPath;
						if (shouldIncludeFile(absFile)) {
							issues.push({
								file: path.relative(targetPath, absFile),
								line: (diag.range?.start?.line ?? 0) + 1,
								col: (diag.range?.start?.character ?? 0) + 1,
								severity: diag.severity,
								code: diag.rule ?? "pyright",
								message: diag.message,
								compiler: "pyright",
							});
						}
					}
				} catch {
					// pyright didn't produce valid JSON
				}
			}
		}

		// Ruby: rubocop --format json
		if (
			langs.has("ruby") &&
			nodeFs.existsSync(path.join(targetPath, "Gemfile"))
		) {
			const hasRubocop =
				safeSpawn("rubocop", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasRubocop) {
				const result = safeSpawn(
					"rubocop",
					[
						"--format",
						"json",
						"--no-color",
						"--display-only-fail-level-offenses",
					],
					{ cwd: targetPath, timeout: 60_000 },
				);
				const output = result.stdout || "";
				try {
					const json = JSON.parse(output);
					for (const fileResult of json?.files ?? []) {
						const absFile = path.isAbsolute(fileResult.path)
							? fileResult.path
							: path.join(targetPath, fileResult.path);
						if (!shouldIncludeFile(absFile)) continue;
						for (const offense of fileResult.offenses ?? []) {
							const sev =
								offense.severity === "error" || offense.severity === "fatal"
									? "error"
									: "warning";
							issues.push({
								file: path.relative(targetPath, absFile),
								line: offense.location?.line ?? 1,
								col: offense.location?.column ?? 1,
								severity: sev,
								code: offense.cop_name ?? "rubocop",
								message: offense.message ?? "",
								compiler: "rubocop",
							});
						}
					}
				} catch {
					// rubocop didn't produce valid JSON
				}
			}
		}

		// Java: mvn compile (preferred) or javac on discovered .java files
		if (nodeFs.existsSync(path.join(targetPath, "pom.xml"))) {
			const result = safeSpawn(
				"mvn",
				["compile", "-q", "-B", "--no-transfer-progress"],
				{
					cwd: targetPath,
					timeout: 120_000,
				},
			);
			const output = (result.stdout || "") + (result.stderr || "");
			const mvnRe = /^\[ERROR\]\s+([^\s[]+\.java):\[(\d+),(\d+)\]\s+([^\n]+)/gm;
			for (const m of output.matchAll(mvnRe)) {
				const [, file, line, col, msg] = m;
				const absFile = path.isAbsolute(file)
					? file
					: path.join(targetPath, file);
				if (shouldIncludeFile(absFile)) {
					issues.push({
						file: path.relative(targetPath, absFile),
						line: parseInt(line, 10),
						col: parseInt(col, 10),
						severity: "error",
						code: "javac",
						message: msg.trim(),
						compiler: "mvn compile",
					});
				}
			}
		} else if (
			nodeFs.existsSync(path.join(targetPath, "build.gradle")) ||
			nodeFs.existsSync(path.join(targetPath, "build.gradle.kts"))
		) {
			const gradleCmd = nodeFs.existsSync(path.join(targetPath, "gradlew"))
				? "./gradlew"
				: "gradle";
			const result = safeSpawn(gradleCmd, ["compileJava", "--quiet"], {
				cwd: targetPath,
				timeout: 120_000,
			});
			const output = (result.stdout || "") + (result.stderr || "");
			const gradleRe =
				/^([^\s:]+\.(?:java|kt)):\s*(\d+):\s*(?:error|warning):\s+([^\n]+)/gm;
			for (const m of output.matchAll(gradleRe)) {
				const [, file, line, msg] = m;
				const absFile = path.isAbsolute(file)
					? file
					: path.join(targetPath, file);
				if (shouldIncludeFile(absFile)) {
					issues.push({
						file: path.relative(targetPath, absFile),
						line: parseInt(line, 10),
						col: 1,
						severity: "error",
						code: "gradle",
						message: msg.trim(),
						compiler: "gradle compileJava",
					});
				}
			}
		}

		// C#: dotnet build
		if (
			nodeFs
				.readdirSync(targetPath)
				.some((e) => /\.(sln|slnx|csproj)$/i.test(e))
		) {
			const hasDotnet =
				safeSpawn("dotnet", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasDotnet) {
				const result = safeSpawn(
					"dotnet",
					["build", "--no-incremental", "-v", "minimal"],
					{ cwd: targetPath, timeout: 120_000 },
				);
				const output = (result.stdout || "") + (result.stderr || "");
				const csRe =
					/^([^\s(]+\.cs)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+([^[]+)/gm;
				for (const m of output.matchAll(csRe)) {
					const [, file, line, col, sev, code, msg] = m;
					const absFile = path.isAbsolute(file)
						? file
						: path.join(targetPath, file);
					if (shouldIncludeFile(absFile)) {
						issues.push({
							file: path.relative(targetPath, absFile),
							line: parseInt(line, 10),
							col: parseInt(col, 10),
							severity: sev,
							code,
							message: msg.trim(),
							compiler: "dotnet build",
						});
					}
				}
			}
		}

		// Dart: dart analyze
		if (nodeFs.existsSync(path.join(targetPath, "pubspec.yaml"))) {
			const hasDart =
				safeSpawn("dart", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasDart) {
				const result = safeSpawn("dart", ["analyze", "--format=machine"], {
					cwd: targetPath,
					timeout: 60_000,
				});
				const output = (result.stdout || "") + (result.stderr || "");
				// severity|type|code|file|line|col|length|message
				for (const line of output.split(/\r?\n/)) {
					const parts = line.split("|");
					if (parts.length < 8) continue;
					const [sev, , code, file, lineNum, , , ...msgParts] = parts;
					const absFile = path.isAbsolute(file)
						? file
						: path.join(targetPath, file);
					if (!shouldIncludeFile(absFile)) continue;
					issues.push({
						file: path.relative(targetPath, absFile),
						line: parseInt(lineNum, 10),
						col: 1,
						severity: sev.toLowerCase() === "error" ? "error" : "warning",
						code: code.trim(),
						message: msgParts.join("|").trim(),
						compiler: "dart analyze",
					});
				}
			}
		}

		// Gleam: gleam check
		if (nodeFs.existsSync(path.join(targetPath, "gleam.toml"))) {
			const hasGleam =
				safeSpawn("gleam", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasGleam) {
				const result = safeSpawn("gleam", ["check"], {
					cwd: targetPath,
					timeout: 60_000,
				});
				const output = (result.stdout || "") + (result.stderr || "");
				const gleamLines = output.split("\n");
				const gleamHeaderRe = /^([^:]+):(\d+):(\d+)[ \t]*(?:error|warning)/;
				for (let i = 0; i < gleamLines.length; i++) {
					const m = gleamHeaderRe.exec(gleamLines[i]);
					if (!m) continue;
					const [, file, line, col] = m;
					const msg = gleamLines[i + 1]?.trim() ?? "";
					const absFile = path.isAbsolute(file)
						? file
						: path.join(targetPath, file);
					if (shouldIncludeFile(absFile)) {
						issues.push({
							file: path.relative(targetPath, absFile),
							line: parseInt(line, 10),
							col: parseInt(col, 10),
							severity: "error",
							code: "gleam",
							message: msg,
							compiler: "gleam check",
						});
					}
				}
			}
		}

		// Zig: zig build (or zig check on entry files)
		if (nodeFs.existsSync(path.join(targetPath, "build.zig"))) {
			const hasZig =
				safeSpawn("zig", ["version"], { timeout: 5_000 }).status === 0;
			if (hasZig) {
				const result = safeSpawn("zig", ["build", "--summary", "none"], {
					cwd: targetPath,
					timeout: 120_000,
				});
				const output = (result.stdout || "") + (result.stderr || "");
				const zigLineRe =
					/^([^:]+):(\d+):(\d+):[ \t]*(error|warning|note):[ \t]*(.+)/;
				for (const zigLine of output.split("\n")) {
					const m = zigLineRe.exec(zigLine);
					if (!m) continue;
					const [, file, line, col, sev, msg] = m;
					const absFile = path.isAbsolute(file)
						? file
						: path.join(targetPath, file);
					if (!absFile.includes("zig-cache") && shouldIncludeFile(absFile)) {
						issues.push({
							file: path.relative(targetPath, absFile),
							line: parseInt(line, 10),
							col: parseInt(col, 10),
							severity: sev === "error" ? "error" : "warning",
							code: "zig",
							message: msg.trim(),
							compiler: "zig build",
						});
					}
				}
			}
		}

		// Elixir: mix compile
		if (nodeFs.existsSync(path.join(targetPath, "mix.exs"))) {
			const hasMix =
				safeSpawn("mix", ["--version"], { timeout: 5_000 }).status === 0;
			if (hasMix) {
				const result = safeSpawn("mix", ["compile", "--warnings-as-errors"], {
					cwd: targetPath,
					timeout: 60_000,
				});
				const output = (result.stdout || "") + (result.stderr || "");
				const elixirLines = output.split(/\r?\n/);
				for (let i = 0; i < elixirLines.length; i++) {
					const line = elixirLines[i];
					const prefixMatch = line.match(/^(?:warning|error):\s+/);
					if (!prefixMatch) continue;
					const msg = line.slice(prefixMatch[0].length);
					const nextLine = elixirLines[i + 1];
					if (!nextLine) continue;
					const locMatch = nextLine.trim().match(/^([^:]+):(\d+)$/);
					if (!locMatch) continue;
					const [, file, lineNum] = locMatch;
					const absFile = path.isAbsolute(file)
						? file
						: path.join(targetPath, file);
					if (shouldIncludeFile(absFile)) {
						issues.push({
							file: path.relative(targetPath, absFile),
							line: parseInt(lineNum, 10),
							col: 1,
							severity: "warning",
							code: "mix",
							message: msg.trim(),
							compiler: "mix compile",
						});
					}
				}
			}
		}

		if (issues.length === 0) return { findings: 0, status: "done" };

		// Group by compiler for reporting
		const byCompiler: Record<string, CompilerIssue[]> = {};
		for (const issue of issues) {
			if (!byCompiler[issue.compiler]) byCompiler[issue.compiler] = [];
			byCompiler[issue.compiler].push(issue);
		}

		const errorCount = issues.filter((i) => i.severity === "error").length;
		summaryItems.push({
			category: "Compiler Errors",
			count: issues.length,
			severity: errorCount > 0 ? "🔴" : "🟡",
			fixable: true,
		});

		let fullSection = `## Compiler Checks\n\n**${issues.length} issue(s) found** (${errorCount} errors)\n\n`;
		for (const [compiler, compIssues] of Object.entries(byCompiler)) {
			fullSection += `### ${compiler} (${compIssues.length})\n\n`;
			fullSection +=
				"| File | Line | Code | Message |\n|------|------|------|---------|\n";
			for (const issue of compIssues.slice(0, 30)) {
				const sev = issue.severity === "error" ? "🔴" : "🟡";
				fullSection += `| ${issue.file} | ${issue.line} | ${sev} ${issue.code} | ${issue.message} |\n`;
			}
			if (compIssues.length > 30) {
				fullSection += `| ... | | | +${compIssues.length - 30} more |\n`;
			}
			fullSection += "\n";
		}
		fullReport.push(fullSection);

		return { findings: issues.length, status: "done" };
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
		const { totalIssues } = jsonReport.meta;

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
