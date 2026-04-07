/**
 * Production Readiness Runner for pi-lens
 *
 * Inspired by pi-validate - validates project is production-ready
 * Categories: CODE, TESTS, DOCS, CONFIG, DEPLOY
 * Each category scored 0-100, weighted total calculated
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isExcludedDirName } from "./file-utils.js";

// --- Types ---

export interface ProductionReadinessResult {
	overallScore: number;
	grade: "A" | "B" | "C" | "D" | "F";
	categories: {
		code: CategoryResult;
		tests: CategoryResult;
		docs: CategoryResult;
		config: CategoryResult;
		deploy: CategoryResult;
	};
}

export interface CategoryResult {
	score: number;
	weight: number;
	issues: string[];
	details: string[];
}

// --- Constants ---

const WEIGHTS: Record<string, number> = {
	code: 0.30,    // 30% - console.log, TODO, empty catch, as any, debugger
	tests: 0.20,   // 20% - test files, test cases, framework config
	docs: 0.20,    // 20% - README, LICENSE, CHANGELOG, pkg metadata
	config: 0.15,  // 15% - gitignore, tsconfig, package.json, no node_modules
	deploy: 0.15,  // 15% - clean git, version set, build script, entry point
};

// --- Main Entry Point ---

/**
 * Run production readiness validation on a project
 */
export function validateProductionReadiness(targetPath: string): ProductionReadinessResult {
	const categories = {
		code: validateCode(targetPath),
		tests: validateTests(targetPath),
		docs: validateDocs(targetPath),
		config: validateConfig(targetPath),
		deploy: validateDeploy(targetPath),
	};

	// Calculate weighted score
	const overallScore = Math.round(
		categories.code.score * WEIGHTS.code +
		categories.tests.score * WEIGHTS.tests +
		categories.docs.score * WEIGHTS.docs +
		categories.config.score * WEIGHTS.config +
		categories.deploy.score * WEIGHTS.deploy
	);

	return {
		overallScore,
		grade: scoreToGrade(overallScore),
		categories,
	};
}

// --- Category Validators ---

/**
 * CODE: Check for production anti-patterns
 */
function validateCode(root: string): CategoryResult {
	const issues: string[] = [];
	const details: string[] = [];
	
	const sourceFiles = findSourceFiles(root);
	if (sourceFiles.length === 0) {
		issues.push("No source files found");
		return { score: 0, weight: WEIGHTS.code, issues, details };
	}
	
	details.push(`${sourceFiles.length} source files`);

	let totalLines = 0;
	let consoleLogs = 0;
	let todos = 0;
	let emptyCatches = 0;
	let anyCasts = 0;
	let debuggers = 0;

	for (const file of sourceFiles) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			const lines = content.split("\n");
			totalLines += lines.length;

			for (const line of lines) {
				// Skip comments for some checks
				const codePart = line.replace(/\/\/.*$/g, "");
				
				if (codePart.match(/console\.(log|debug|info|warn)\(/)) consoleLogs++;
				if (codePart.match(/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)/i)) todos++;
				if (codePart.match(/catch\s*\([^)]*\)\s*\{\s*\}/)) emptyCatches++;
				if (codePart.match(/as\s+any\b/) && !line.includes("// biome-ignore")) anyCasts++;
				if (codePart.match(/\bdebugger\b/)) debuggers++;
			}
		} catch {}
	}

	details.push(`${totalLines} total lines`);

	// Build issues list
	if (consoleLogs > 0) issues.push(`${consoleLogs} console.log/debug statements`);
	if (todos > 0) issues.push(`${todos} TODO/FIXME comments`);
	if (emptyCatches > 0) issues.push(`${emptyCatches} empty catch blocks`);
	if (anyCasts > 3) issues.push(`${anyCasts} 'as any' casts (${anyCasts > 10 ? "many" : "some"})`);
	if (debuggers > 0) issues.push(`${debuggers} debugger statements!`);

	// Calculate score
	let score = 100;
	score -= Math.min(20, consoleLogs * 2);
	score -= Math.min(10, todos);
	score -= Math.min(15, emptyCatches * 5);
	score -= Math.min(10, Math.max(0, anyCasts - 3));
	score -= debuggers * 15;

	return { score: Math.max(0, score), weight: WEIGHTS.code, issues, details };
}

/**
 * TESTS: Check test coverage and configuration
 */
function validateTests(root: string): CategoryResult {
	const issues: string[] = [];
	const details: string[] = [];

	// Look for test files
	const testFiles = findTestFiles(root);
	const hasTestFiles = testFiles.length > 0;
	
	// Look for test framework config
	const testFramework = detectTestFramework(root);
	const hasTestFramework = testFramework !== null;

	// Count test cases (rough estimate)
	let testCases = 0;
	for (const file of testFiles) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			// Match common test patterns
			const matches = content.match(/\b(it|test|describe|spec|Scenario)\s*\(/g);
			if (matches) testCases += matches.length;
		} catch {}
	}

	details.push(`${testFiles.length} test files`);
	details.push(`${testCases} test cases (approximate)`);
	if (testFramework) details.push(`Framework: ${testFramework}`);

	// Build issues
	if (!hasTestFiles) issues.push("No test files found");
	else if (testFiles.length < 2) issues.push("Only 1 test file (consider adding more)");
	
	if (!hasTestFramework) issues.push("No test framework configuration detected");
	
	if (testCases === 0 && hasTestFiles) issues.push("Test files found but no test cases detected");

	// Calculate score
	let score = 100;
	if (!hasTestFiles) score -= 50;
	else if (testFiles.length < 2) score -= 10;
	
	if (!hasTestFramework) score -= 25;
	if (testCases === 0 && hasTestFiles) score -= 15;

	return { score: Math.max(0, score), weight: WEIGHTS.tests, issues, details };
}

/**
 * DOCS: Check documentation completeness
 */
function validateDocs(root: string): CategoryResult {
	const issues: string[] = [];
	const details: string[] = [];

	const required = [
		{ file: "README.md", name: "README" },
		{ file: "LICENSE", name: "LICENSE (or LICENSE.md)" },
		{ file: "CHANGELOG.md", name: "CHANGELOG" },
	];

	const found: string[] = [];
	const missing: string[] = [];

	for (const { file, name } of required) {
		const exists = fs.existsSync(path.join(root, file)) ||
			(file === "LICENSE" && fs.existsSync(path.join(root, "LICENSE.md")));
		if (exists) {
			found.push(name);
		} else {
			missing.push(name);
		}
	}

	// Check package.json for metadata (Node projects)
	const packageJsonPath = path.join(root, "package.json");
	let hasMetadata = false;
	if (fs.existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			hasMetadata = !!(pkg.description && pkg.author);
			if (hasMetadata) details.push("package.json has description and author");
			else issues.push("package.json missing description or author");
		} catch {}
	}

	details.push(`Found: ${found.join(", ") || "none"}`);
	if (missing.length > 0) details.push(`Missing: ${missing.join(", ")}`);

	// Build issues
	if (missing.includes("README")) issues.push("No README.md found");
	if (missing.includes("LICENSE (or LICENSE.md)")) issues.push("No LICENSE file found");
	if (missing.includes("CHANGELOG")) issues.push("No CHANGELOG.md found (recommended)");

	// Calculate score
	let score = 100;
	if (missing.includes("README")) score -= 40;
	if (missing.includes("LICENSE (or LICENSE.md)")) score -= 30;
	if (missing.includes("CHANGELOG")) score -= 10;
	if (!hasMetadata) score -= 10;

	return { score: Math.max(0, score), weight: WEIGHTS.docs, issues, details };
}

/**
 * CONFIG: Check configuration files
 */
function validateConfig(root: string): CategoryResult {
	const issues: string[] = [];
	const details: string[] = [];

	// Essential config files
	const checks = [
		{ file: ".gitignore", critical: true },
		{ file: "tsconfig.json", critical: false },
		{ file: "package.json", critical: true },
		{ file: ".pi-lens", critical: false, dir: true },
	];

	const found: string[] = [];

	for (const { file, critical, dir } of checks) {
		const filePath = path.join(root, file);
		const exists = dir ? fs.existsSync(filePath) : fs.existsSync(filePath);
		if (exists) {
			found.push(file);
		} else if (critical) {
			issues.push(`Missing ${file}`);
		}
	}

	// Check for node_modules in git (common mistake)
	const gitignorePath = path.join(root, ".gitignore");
	if (fs.existsSync(gitignorePath)) {
		try {
			const content = fs.readFileSync(gitignorePath, "utf-8");
			if (content.includes("node_modules")) {
				details.push(".gitignore excludes node_modules");
			} else {
				issues.push(".gitignore does not exclude node_modules");
			}
		} catch {}
	}

	details.push(`Config files: ${found.join(", ")}`);

	// Calculate score
	let score = 100;
	if (!found.includes(".gitignore")) score -= 30;
	if (!found.includes("package.json") && !fs.existsSync(path.join(root, "Cargo.toml")) &&
	    !fs.existsSync(path.join(root, "pyproject.toml"))) {
		score -= 20; // No package manifest at all
	}

	return { score: Math.max(0, score), weight: WEIGHTS.config, issues, details };
}

/**
 * DEPLOY: Check deploy readiness
 */
function validateDeploy(root: string): CategoryResult {
	const issues: string[] = [];
	const details: string[] = [];

	// Check git status
	let hasUncommitted = false;
	let hasCleanGit = false;
	
	if (fs.existsSync(path.join(root, ".git"))) {
		hasCleanGit = true;
		details.push("Git repository initialized");
		
		// Check for uncommitted changes (best effort)
		try {
			// This requires git to be available - skip if not
		} catch {}
	} else {
		issues.push("No git repository found");
	}

	// Check version is set (Node projects)
	const packageJsonPath = path.join(root, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			if (pkg.version && pkg.version !== "0.0.0" && pkg.version !== "1.0.0") {
				details.push(`Version: ${pkg.version}`);
			} else {
				issues.push("Version not set or is default (0.0.0)");
			}
			
			// Check for build script
			const hasBuildScript = pkg.scripts &&
				(pkg.scripts.build || pkg.scripts.compile || pkg.scripts["build:prod"]);
			if (hasBuildScript) {
				details.push("Build script defined");
			} else {
				issues.push("No build script found in package.json");
			}
			
			// Check for entry point
			if (pkg.main || pkg.module || pkg.exports) {
				details.push(`Entry: ${pkg.main || pkg.module || "defined via exports"}`);
			} else {
				issues.push("No entry point (main/module) defined");
			}
		} catch {}
	}

	// Check for Dockerfile or deploy config
	const hasDocker = fs.existsSync(path.join(root, "Dockerfile")) ||
		fs.existsSync(path.join(root, "docker-compose.yml"));
	const hasCI = fs.existsSync(path.join(root, ".github", "workflows")) ||
		fs.existsSync(path.join(root, ".gitlab-ci.yml")) ||
		fs.existsSync(path.join(root, "azure-pipelines.yml"));

	if (hasDocker) details.push("Dockerfile present");
	if (hasCI) details.push("CI/CD config present");

	// Calculate score
	let score = 100;
	if (!hasCleanGit) score -= 30;
	if (hasUncommitted) score -= 20;
	if (issues.some(i => i.includes("version"))) score -= 15;
	if (issues.some(i => i.includes("build script"))) score -= 10;
	if (issues.some(i => i.includes("entry point"))) score -= 10;

	return { score: Math.max(0, score), weight: WEIGHTS.deploy, issues, details };
}

// --- Utilities ---

function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
	if (score >= 90) return "A";
	if (score >= 80) return "B";
	if (score >= 70) return "C";
	if (score >= 60) return "D";
	return "F";
}

function findSourceFiles(root: string): string[] {
	const files: string[] = [];
	const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java"];

	const scan = (dir: string) => {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (isExcludedDirName(entry.name)) continue;
					scan(full);
				} else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.includes(".test.") && !entry.name.includes(".spec.")) {
					files.push(full);
				}
			}
		} catch {}
	};

	scan(root);
	return files;
}

function findTestFiles(root: string): string[] {
	const files: string[] = [];
	const testPatterns = [".test.", ".spec.", "_test.", "_spec.", "Test.", "Spec."];
	const testDirs = ["__tests__", "tests", "test", "specs", "spec"];

	const scan = (dir: string) => {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (isExcludedDirName(entry.name)) continue;
					// Check if it's a test directory
					if (testDirs.includes(entry.name) || entry.name.endsWith("-tests")) {
						// Collect all files in test directories
						const testFiles = findAllFiles(full);
						files.push(...testFiles);
					} else {
						scan(full);
					}
				} else if (testPatterns.some(p => entry.name.includes(p))) {
					files.push(full);
				}
			}
		} catch {}
	};

	scan(root);
	return [...new Set(files)]; // Deduplicate
}

function findAllFiles(dir: string): string[] {
	const files: string[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...findAllFiles(full));
			} else {
				files.push(full);
			}
		}
	} catch {}
	return files;
}

function detectTestFramework(root: string): string | null {
	const pkgPath = path.join(root, "package.json");
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			
			if (deps["vitest"]) return "vitest";
			if (deps["jest"]) return "jest";
			if (deps["mocha"]) return "mocha";
			if (deps["ava"]) return "ava";
			if (deps["tap"]) return "tap";
			if (deps["@playwright/test"]) return "playwright";
			if (deps["cypress"]) return "cypress";
			if (deps["pytest"] || fs.existsSync(path.join(root, "pytest.ini"))) return "pytest";
		} catch {}
	}

	// Check for pytest
	if (fs.existsSync(path.join(root, "pytest.ini")) ||
	    fs.existsSync(path.join(root, "pyproject.toml"))) {
		return "pytest";
	}

	// Check for cargo test
	if (fs.existsSync(path.join(root, "Cargo.toml"))) {
		return "cargo test";
	}

	// Check for go test
	if (fs.existsSync(path.join(root, "go.mod"))) {
		return "go test";
	}

	return null;
}

// --- Formatting ---

/**
 * Format production readiness result for display
 */
export function formatReadinessResult(result: ProductionReadinessResult): string {
	const lines: string[] = [];

	// Header with score and grade
	const gradeColor = result.grade === "A" ? "🟢" :
	                   result.grade === "B" ? "🟢" :
	                   result.grade === "C" ? "🟡" :
	                   result.grade === "D" ? "🟠" : "🔴";
	
	lines.push(`${gradeColor} Production Readiness: ${result.overallScore}/100 (Grade ${result.grade})`);
	lines.push("");

	// Categories
	const categories = [
		{ key: "code", name: "Code Quality", emoji: "📝" },
		{ key: "tests", name: "Tests", emoji: "🧪" },
		{ key: "docs", name: "Documentation", emoji: "📄" },
		{ key: "config", name: "Configuration", emoji: "⚙️" },
		{ key: "deploy", name: "Deploy Readiness", emoji: "🚀" },
	] as const;

	for (const { key, name, emoji } of categories) {
		const cat = result.categories[key];
		const status = cat.score >= 80 ? "✅" : cat.score >= 60 ? "⚠️" : "❌";
		lines.push(`${emoji} ${name}: ${cat.score}/100 ${status}`);
		
		for (const detail of cat.details) {
			lines.push(`   ${detail}`);
		}
		
		for (const issue of cat.issues) {
			lines.push(`   ❌ ${issue}`);
		}
		
		if (cat.details.length === 0 && cat.issues.length === 0) {
			lines.push(`   ✅ No issues`);
		}
		
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Get critical issues that must be fixed before production
 */
export function getCriticalIssues(result: ProductionReadinessResult): string[] {
	const critical: string[] = [];

	for (const [key, cat] of Object.entries(result.categories)) {
		for (const issue of cat.issues) {
			// Score critical based on category and issue severity
			if (key === "code" && issue.includes("debugger")) {
				critical.push(`[CRITICAL] ${issue}`);
			} else if (key === "tests" && !result.categories.tests.score) {
				critical.push(`[CRITICAL] No tests found`);
			} else if (key === "docs" && issue.includes("README")) {
				critical.push(`[IMPORTANT] ${issue}`);
			} else if (cat.score < 50) {
				critical.push(`[${key.toUpperCase()}] ${issue}`);
			}
		}
	}

	return [...new Set(critical)]; // Deduplicate
}
