/**
 * /lens-rate command
 *
 * Provides a visual scoring breakdown of code quality across multiple dimensions.
 * Uses existing scan data to calculate scores.
 */

import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ArchitectClient } from "../clients/architect-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import { EXCLUDED_DIRS, isTestFile } from "../clients/file-utils.js";
import { getSourceFiles } from "../clients/scan-utils.js";
import type { TypeCoverageClient } from "../clients/type-coverage-client.js";

interface CategoryScore {
	name: string;
	score: number; // 0-100
	icon: string;
	issues: string[];
}

interface RateResult {
	overall: number;
	categories: CategoryScore[];
}

interface ScanClients {
	complexity: ComplexityClient;
	knip: KnipClient;
	typeCoverage: TypeCoverageClient;
	architect: ArchitectClient;
}

/**
 * Run all scans and calculate scores
 */
export async function gatherScores(
	targetPath: string,
	clients: ScanClients,
): Promise<RateResult> {
	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));
	const files = getSourceFiles(targetPath, isTsProject);
	const categories: CategoryScore[] = [];

	// ─── Type Safety ───
	let typeCoverageScore = 100;
	const typeIssues: string[] = [];

	if (clients.typeCoverage.isAvailable()) {
		const result = clients.typeCoverage.scan(targetPath);
		if (result.success) {
			typeCoverageScore = result.percentage;
			if (result.percentage < 90) {
				typeIssues.push(`${result.total - result.typed} untyped identifiers`);
			}
		}
	}
	categories.push({
		name: "Type Safety",
		score: Math.round(typeCoverageScore),
		icon: "🔷",
		issues: typeIssues,
	});

	// ─── Complexity ───
	let complexityScore = 100;
	const complexityIssues: string[] = [];

	let totalScore = 0;
	let fileCount = 0;
	let worstFile = "";
	let worstScore = 100;

	for (const file of files.slice(0, 50)) {
		if (clients.complexity.isSupportedFile(file)) {
			const metrics = clients.complexity.analyzeFile(file);
			if (metrics) {
				totalScore += metrics.maintainabilityIndex;
				fileCount++;
				if (metrics.maintainabilityIndex < worstScore) {
					worstScore = metrics.maintainabilityIndex;
					worstFile = path.basename(file);
				}
			}
		}
	}
	if (fileCount > 0) {
		complexityScore = totalScore / fileCount;
		if (complexityScore < 70) {
			complexityIssues.push(`High complexity: ${worstFile}`);
		}
	}
	categories.push({
		name: "Complexity",
		score: Math.round(complexityScore),
		icon: "🧩",
		issues: complexityIssues,
	});

	// ─── Security ───
	let securityScore = 100;
	const securityIssues: string[] = [];
	let secretsFound = 0;

	// Check for secrets in source files (skip test files)
	const secretPatterns = [
		{ name: "API Key (sk-)", pattern: /sk-[a-zA-Z0-9]{20,}/ },
		{ name: "GitHub Token", pattern: /ghp_[a-zA-Z0-9]{36}/ },
		{ name: "AWS Key", pattern: /AKIA[A-Z0-9]{16}/ },
		{ name: "Anthropic Key", pattern: /sk-ant-[a-zA-Z0-9]{20,}/ },
		{ name: "OpenAI Key", pattern: /sk-proj-[a-zA-Z0-9]{20,}/ },
		{
			name: "Private Key",
			pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
		},
	];

	for (const file of files.slice(0, 100)) {
		// Skip test files
		if (isTestFile(file)) continue;
		try {
			const content = nodeFs.readFileSync(file, "utf-8");
			for (const line of content.split("\n")) {
				if (line.trim().startsWith("//") || line.trim().startsWith("#"))
					continue;
				for (const { name, pattern } of secretPatterns) {
					if (pattern.test(line)) {
						secretsFound++;
						if (securityIssues.length < 3) {
							securityIssues.push(`${name} in ${path.basename(file)}`);
						}
					}
				}
			}
		} catch (err) {
			// Skip unreadable files
			void err;
		}
	}
	securityScore = Math.max(0, 100 - secretsFound * 15);
	categories.push({
		name: "Security",
		score: securityScore,
		icon: "🔒",
		issues: securityIssues,
	});

	// ─── Architecture ───
	let archScore = 100;
	const archIssues: string[] = [];

	clients.architect.loadConfig(targetPath);
	if (clients.architect.hasConfig()) {
		let archViolations = 0;
		const scanDir = (dir: string) => {
			for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (EXCLUDED_DIRS.includes(entry.name)) continue;
					scanDir(full);
				} else if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(entry.name)) {
					const relPath = path.relative(targetPath, full).replace(/\\/g, "/");
					const content = nodeFs.readFileSync(full, "utf-8");
					const violations = clients.architect.checkFile(relPath, content);
					archViolations += violations.length;
					if (violations.length > 0 && archIssues.length < 3) {
						archIssues.push(`${violations.length} in ${path.basename(full)}`);
					}
					const sizeV = clients.architect.checkFileSize(
						relPath,
						content.split("\n").length,
					);
					if (sizeV) archViolations++;
				}
			}
		};
		scanDir(targetPath);
		archScore = Math.max(0, 100 - archViolations * 10);
	}
	categories.push({
		name: "Architecture",
		score: archScore,
		icon: "🏗️",
		issues: archIssues,
	});

	// ─── Dead Code ───
	let deadCodeScore = 100;
	const deadCodeIssues: string[] = [];

	if (clients.knip.isAvailable()) {
		const result = clients.knip.analyze(targetPath);
		if (result.success) {
			const unusedExports = result.unusedExports.length;
			const unusedFiles = result.unusedFiles.length;
			const total = unusedExports + unusedFiles;
			deadCodeScore = Math.max(0, 100 - total * 3);
			if (unusedExports > 0) {
				deadCodeIssues.push(`${unusedExports} unused export(s)`);
			}
			if (unusedFiles > 0) {
				deadCodeIssues.push(`${unusedFiles} unused file(s)`);
			}
		}
	}
	categories.push({
		name: "Dead Code",
		score: deadCodeScore,
		icon: "🗑️",
		issues: deadCodeIssues,
	});

	// ─── Tests ───
	let testScore = 100;
	const testIssues: string[] = [];

	// Quick test run
	try {
		const testResult = childProcess.spawnSync(
			"npx",
			["vitest", "run", "--reporter=basic"],
			{
				encoding: "utf-8",
				timeout: 60000,
				shell: process.platform === "win32",
				cwd: targetPath,
			},
		);
		if (testResult.status !== 0) {
			const output = (testResult.stdout || "") + (testResult.stderr || "");
			if (output.includes("failed")) {
				// Count failing tests
				const failMatch = output.match(/(\d+) failed/);
				testScore = 50;
				testIssues.push(
					failMatch ? `${failMatch[1]} test(s) failing` : "Some tests failing",
				);
			} else {
				testScore = 70;
				testIssues.push("Tests timed out or errored");
			}
		}
	} catch {
		testScore = 70;
		testIssues.push("Could not run tests");
	}
	categories.push({
		name: "Tests",
		score: testScore,
		icon: "✅",
		issues: testIssues,
	});

	// ─── Calculate Overall ───
	const overall = Math.round(
		categories.reduce((sum, c) => sum + c.score, 0) / categories.length,
	);

	return { overall, categories };
}

/**
 * Format score as a bar
 */
function scoreBar(score: number, width = 10): string {
	const filled = Math.round((score / 100) * width);
	const empty = width - filled;
	const color = score >= 80 ? "🟩" : score >= 60 ? "🟨" : "🟥";
	return color.repeat(filled) + "⬜".repeat(empty);
}

/**
 * Get grade from score
 */
function getGrade(score: number): string {
	if (score >= 90) return "A";
	if (score >= 80) return "B";
	if (score >= 70) return "C";
	if (score >= 60) return "D";
	return "F";
}

/**
 * Format rate result for terminal
 */
export function formatRateResult(result: RateResult): string {
	const lines: string[] = [];

	lines.push("┌─────────────────────────────────────────────────────────┐");
	const gradeText = ` (${getGrade(result.overall)})`;
	const scoreText = `📊 CODE QUALITY SCORE: ${result.overall}/100${gradeText}`;
	const padding = Math.max(0, 55 - scoreText.length);
	lines.push(`│  ${scoreText}${" ".repeat(padding)}│`);
	lines.push("├─────────────────────────────────────────────────────────┤");

	for (const cat of result.categories) {
		const name = cat.name.padEnd(14);
		const bar = scoreBar(cat.score);
		const score = String(cat.score).padStart(3);
		lines.push(`│  ${cat.icon} ${name} ${bar} ${score} │`);
	}

	lines.push("└─────────────────────────────────────────────────────────┘");

	// Show issues if any
	const allIssues = result.categories
		.filter((c) => c.issues.length > 0)
		.flatMap((c) => c.issues.map((i) => `${c.icon} ${c.name}: ${i}`));

	if (allIssues.length > 0) {
		lines.push("");
		lines.push("Issues to address:");
		for (const issue of allIssues.slice(0, 5)) {
			lines.push(`  • ${issue}`);
		}
		if (allIssues.length > 5) {
			lines.push(`  ... and ${allIssues.length - 5} more`);
		}
		lines.push("");
		lines.push("💡 Run /lens-booboo for full details");
	}

	return lines.join("\n");
}

/**
 * Handle /lens-rate command
 */
export async function handleRate(
	args: string,
	ctx: ExtensionContext,
	clients: ScanClients,
): Promise<string> {
	const targetPath = args.trim() || ctx.cwd || process.cwd();
	ctx.ui.notify("📊 Calculating code quality scores...", "info");
	const result = await gatherScores(targetPath, clients);
	return formatRateResult(result);
}
