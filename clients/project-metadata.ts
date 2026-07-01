/**
 * Project Metadata Detection for pi-lens
 *
 * Extracts project configuration from common config files:
 * - package.json (Node.js/npm/pnpm/yarn/bun)
 * - pyproject.toml (Python)
 * - Cargo.toml (Rust)
 * - go.mod (Go)
 * - composer.json (PHP)
 * - Gemfile (Ruby)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	detectNodePackageManager,
	formatRunScript,
	type NodePackageManager,
} from "./package-manager.js";

// --- Types ---

export type ProjectType = "node" | "python" | "rust" | "go" | "php" | "ruby" | "java" | "kotlin" | "csharp" | "dart" | "gleam" | "zig" | "elixir" | "cpp" | "multi" | "unknown";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "pip" | "poetry" | "uv" | "cargo" | "gomod" | "composer" | "bundler";

export interface ProjectMetadata {
	/** Project type detected from config files */
	type: ProjectType;
	/** Package manager/toolchain detected */
	packageManager?: PackageManager;
	/** Available scripts/commands (e.g., npm scripts, Makefile targets) */
	scripts: Record<string, string>;
	/** Project name from config */
	name?: string;
	/** Project version */
	version?: string;
	/** Detected languages in the project */
	languages: string[];
	/** Whether the project has tests configured */
	hasTests: boolean;
	/** Test framework detected */
	testFramework?: string;
	/** Whether the project has linting configured */
	hasLinting: boolean;
	/** Linter detected */
	linter?: string;
	/** Whether the project has formatting configured */
	hasFormatting: boolean;
	/** Formatter detected */
	formatter?: string;
	/** Whether TypeScript is used (for Node projects) */
	hasTypeScript: boolean;
	/** Key config files found */
	configFiles: string[];
}

// --- Detection Functions ---

/**
 * Detect project metadata from a target directory.
 * Reads common config files and extracts structured information.
 */
export function detectProjectMetadata(targetPath: string): ProjectMetadata {
	const metadata: ProjectMetadata = {
		type: "unknown",
		scripts: {},
		languages: [],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: [],
	};

	// Check for Node.js project
	const nodeMeta = detectNodeProject(targetPath);
	if (nodeMeta) {
		Object.assign(metadata, nodeMeta);
	}

	// Check for Python project
	const pythonMeta = detectPythonProject(targetPath);
	if (pythonMeta && metadata.type === "unknown") {
		Object.assign(metadata, pythonMeta);
	}

	// Check for Rust project
	const rustMeta = detectRustProject(targetPath);
	if (rustMeta && metadata.type === "unknown") {
		Object.assign(metadata, rustMeta);
	}

	// Check for Go project
	const goMeta = detectGoProject(targetPath);
	if (goMeta && metadata.type === "unknown") {
		Object.assign(metadata, goMeta);
	}

	// Check for PHP project
	const phpMeta = detectPhpProject(targetPath);
	if (phpMeta && metadata.type === "unknown") {
		Object.assign(metadata, phpMeta);
	}

	// Check for Ruby project
	const rubyMeta = detectRubyProject(targetPath);
	if (rubyMeta && metadata.type === "unknown") {
		Object.assign(metadata, rubyMeta);
	}

	// Check for Java project
	const javaMeta = detectJavaProject(targetPath);
	if (javaMeta && metadata.type === "unknown") {
		Object.assign(metadata, javaMeta);
	}

	// Check for Kotlin project
	const kotlinMeta = detectKotlinProject(targetPath);
	if (kotlinMeta && metadata.type === "unknown") {
		Object.assign(metadata, kotlinMeta);
	}

	// Check for C# project
	const csharpMeta = detectCsharpProject(targetPath);
	if (csharpMeta && metadata.type === "unknown") {
		Object.assign(metadata, csharpMeta);
	}

	// Check for Dart project
	const dartMeta = detectDartProject(targetPath);
	if (dartMeta && metadata.type === "unknown") {
		Object.assign(metadata, dartMeta);
	}

	// Check for Gleam project
	const gleamMeta = detectGleamProject(targetPath);
	if (gleamMeta && metadata.type === "unknown") {
		Object.assign(metadata, gleamMeta);
	}

	// Check for Zig project
	const zigMeta = detectZigProject(targetPath);
	if (zigMeta && metadata.type === "unknown") {
		Object.assign(metadata, zigMeta);
	}

	// Check for Elixir project
	const elixirMeta = detectElixirProject(targetPath);
	if (elixirMeta && metadata.type === "unknown") {
		Object.assign(metadata, elixirMeta);
	}

	// Check for C/C++ project
	const cppMeta = detectCppProject(targetPath);
	if (cppMeta && metadata.type === "unknown") {
		Object.assign(metadata, cppMeta);
	}

	// Multi-project detection: if multiple types found
	const types = [nodeMeta, pythonMeta, rustMeta, goMeta, phpMeta, rubyMeta,
		javaMeta, kotlinMeta, csharpMeta, dartMeta, gleamMeta, zigMeta, elixirMeta, cppMeta]
		.filter(Boolean)
		.map(m => m!.type);

	if (types.length > 1) {
		metadata.type = "multi";
		metadata.languages = [...new Set(types)];
	}

	return metadata;
}

/**
 * Detect Node.js project from package.json and lockfiles
 */
function detectNodeProject(targetPath: string): ProjectMetadata | null {
	const packageJsonPath = path.join(targetPath, "package.json");
	if (!fs.existsSync(packageJsonPath)) {
		return null;
	}

	let packageJson: Record<string, unknown>;
	try {
		packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "node",
		name: typeof packageJson.name === "string" ? packageJson.name : undefined,
		version: typeof packageJson.version === "string" ? packageJson.version : undefined,
		packageManager: detectNodePackageManager(targetPath),
		scripts: typeof packageJson.scripts === "object" && packageJson.scripts !== null
			? (packageJson.scripts as Record<string, string>)
			: {},
		languages: ["javascript"],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: fs.existsSync(path.join(targetPath, "tsconfig.json")),
		configFiles: ["package.json"],
	};

	// Detect TypeScript
	if (metadata.hasTypeScript) {
		metadata.languages.push("typescript");
		metadata.configFiles.push("tsconfig.json");
	}

	// Detect tests from scripts or config files
	const scripts = Object.keys(metadata.scripts).join(" ").toLowerCase();
	if (scripts.includes("test") || scripts.includes("spec")) {
		metadata.hasTests = true;
	}
	// Detect test frameworks from dependencies
	const allDeps = {
		...((packageJson.dependencies || {}) as Record<string, string>),
		...((packageJson.devDependencies || {}) as Record<string, string>),
	};
	if (allDeps["vitest"]) {
		metadata.hasTests = true;
		metadata.testFramework = "vitest";
	} else if (allDeps["jest"]) {
		metadata.hasTests = true;
		metadata.testFramework = "jest";
	} else if (allDeps["mocha"]) {
		metadata.hasTests = true;
		metadata.testFramework = "mocha";
	} else if (allDeps["ava"]) {
		metadata.hasTests = true;
		metadata.testFramework = "ava";
	} else if (allDeps["tap"]) {
		metadata.hasTests = true;
		metadata.testFramework = "tap";
	} else if (allDeps["node:test"]) {
		metadata.hasTests = true;
		metadata.testFramework = "node:test";
	}

	// Detect linting
	if (allDeps["eslint"] || fs.existsSync(path.join(targetPath, ".eslintrc")) ||
	    fs.existsSync(path.join(targetPath, ".eslintrc.js")) ||
	    fs.existsSync(path.join(targetPath, "eslint.config.js")) ||
	    fs.existsSync(path.join(targetPath, "eslint.config.mjs"))) {
		metadata.hasLinting = true;
		metadata.linter = "eslint";
		metadata.configFiles.push("eslint config");
	}
	if (allDeps["@biomejs/biome"] || fs.existsSync(path.join(targetPath, "biome.json"))) {
		metadata.hasLinting = true;
		metadata.linter = metadata.linter ? `${metadata.linter}, biome` : "biome";
		metadata.configFiles.push("biome.json");
	}

	// Detect formatting
	if (allDeps["prettier"] || fs.existsSync(path.join(targetPath, ".prettierrc")) ||
	    fs.existsSync(path.join(targetPath, ".prettierrc.json"))) {
		metadata.hasFormatting = true;
		metadata.formatter = metadata.formatter ? `${metadata.formatter}, prettier` : "prettier";
		metadata.configFiles.push("prettier config");
	}
	if (allDeps["@biomejs/biome"]) {
		metadata.hasFormatting = true;
		metadata.formatter = metadata.formatter ? `${metadata.formatter}, biome` : "biome";
	}

	return metadata;
}

/**
 * Detect Python project from pyproject.toml, setup.py, requirements.txt
 */
function detectPythonProject(targetPath: string): ProjectMetadata | null {
	const pyprojectPath = path.join(targetPath, "pyproject.toml");
	const setupPyPath = path.join(targetPath, "setup.py");
	const requirementsPath = path.join(targetPath, "requirements.txt");

	if (!fs.existsSync(pyprojectPath) && !fs.existsSync(setupPyPath) && !fs.existsSync(requirementsPath)) {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "python",
		packageManager: detectPythonPackageManager(targetPath),
		scripts: {},
		languages: ["python"],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: [],
	};

	// Read pyproject.toml if available
	if (fs.existsSync(pyprojectPath)) {
		metadata.configFiles.push("pyproject.toml");
		try {
			const content = fs.readFileSync(pyprojectPath, "utf-8");
			
			// Extract project name
			const nameMatch = content.match(/\[project\][\s\S]*?name\s*=\s*["']([^"']+)["']/);
			if (nameMatch) metadata.name = nameMatch[1];
			
			// Extract version
			const versionMatch = content.match(/\[project\][\s\S]*?version\s*=\s*["']([^"']+)["']/);
			if (versionMatch) metadata.version = versionMatch[1];

			// Detect test framework
			if (content.includes("pytest") || fs.existsSync(path.join(targetPath, "pytest.ini"))) {
				metadata.hasTests = true;
				metadata.testFramework = "pytest";
			}

			// Detect linting
			if (content.includes("ruff") || fs.existsSync(path.join(targetPath, "ruff.toml"))) {
				metadata.hasLinting = true;
				metadata.linter = "ruff";
				metadata.hasFormatting = true;
				metadata.formatter = "ruff";
			} else if (content.includes("pylint") || content.includes("flake8")) {
				metadata.hasLinting = true;
				metadata.linter = content.includes("pylint") ? "pylint" : "flake8";
			}
		} catch {
			// Ignore parse errors
		}
	}

	if (fs.existsSync(setupPyPath)) metadata.configFiles.push("setup.py");
	if (fs.existsSync(requirementsPath)) metadata.configFiles.push("requirements.txt");

	return metadata;
}

/**
 * Detect Python package manager
 */
function detectPythonPackageManager(targetPath: string): PackageManager | undefined {
	if (fs.existsSync(path.join(targetPath, "uv.lock"))) {
		return "uv";
	}
	if (fs.existsSync(path.join(targetPath, "poetry.lock"))) {
		return "poetry";
	}
	if (fs.existsSync(path.join(targetPath, "Pipfile.lock")) || fs.existsSync(path.join(targetPath, "Pipfile"))) {
		return "pip"; // pipenv uses Pipfile
	}
	if (fs.existsSync(path.join(targetPath, "requirements.txt"))) {
		return "pip";
	}
	return undefined;
}

/**
 * Detect Rust project from Cargo.toml
 */
function detectRustProject(targetPath: string): ProjectMetadata | null {
	const cargoPath = path.join(targetPath, "Cargo.toml");
	if (!fs.existsSync(cargoPath)) {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "rust",
		packageManager: "cargo",
		scripts: {},
		languages: ["rust"],
		hasTests: true, // Cargo has built-in test support
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["Cargo.toml"],
	};

	// Read Cargo.toml
	try {
		const content = fs.readFileSync(cargoPath, "utf-8");
		
		// Extract package name
		const nameMatch = content.match(/\[package\][\s\S]*?name\s*=\s*["']([^"']+)["']/);
		if (nameMatch) metadata.name = nameMatch[1];
		
		// Extract version
		const versionMatch = content.match(/\[package\][\s\S]*?version\s*=\s*["']([^"']+)["']/);
		if (versionMatch) metadata.version = versionMatch[1];
	} catch {
		// Ignore parse errors
	}

	// Check for clippy (linter)
	if (fs.existsSync(path.join(targetPath, ".clippy.toml")) ||
	    fs.existsSync(path.join(targetPath, "clippy.toml"))) {
		metadata.hasLinting = true;
		metadata.linter = "clippy";
	}

	// Check for rustfmt
	if (fs.existsSync(path.join(targetPath, ".rustfmt.toml")) ||
	    fs.existsSync(path.join(targetPath, "rustfmt.toml"))) {
		metadata.hasFormatting = true;
		metadata.formatter = "rustfmt";
	}

	return metadata;
}

/**
 * Detect Go project from go.mod
 */
function detectGoProject(targetPath: string): ProjectMetadata | null {
	const goModPath = path.join(targetPath, "go.mod");
	if (!fs.existsSync(goModPath)) {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "go",
		packageManager: "gomod",
		scripts: {},
		languages: ["go"],
		hasTests: true, // Go has built-in test support
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["go.mod"],
	};

	// Read go.mod
	try {
		const content = fs.readFileSync(goModPath, "utf-8");
		
		// Extract module name (first line: module example.com/module)
		const moduleMatch = content.match(/^module\s+(\S+)/m);
		if (moduleMatch) metadata.name = moduleMatch[1];
		
		// Extract go version
		const versionMatch = content.match(/^go\s+(\S+)/m);
		if (versionMatch) metadata.version = versionMatch[1];
	} catch {
		// Ignore parse errors
	}

	// Check for golangci-lint
	if (fs.existsSync(path.join(targetPath, ".golangci.yml")) ||
	    fs.existsSync(path.join(targetPath, ".golangci.yaml"))) {
		metadata.hasLinting = true;
		metadata.linter = "golangci-lint";
	}

	return metadata;
}

/**
 * Detect PHP project from composer.json
 */
function detectPhpProject(targetPath: string): ProjectMetadata | null {
	const composerPath = path.join(targetPath, "composer.json");
	if (!fs.existsSync(composerPath)) {
		return null;
	}

	let composerJson: Record<string, unknown>;
	try {
		composerJson = JSON.parse(fs.readFileSync(composerPath, "utf-8"));
	} catch {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "php",
		packageManager: "composer",
		name: typeof composerJson.name === "string" ? composerJson.name : undefined,
		scripts: typeof composerJson.scripts === "object" && composerJson.scripts !== null
			? (composerJson.scripts as Record<string, string>)
			: {},
		languages: ["php"],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["composer.json"],
	};

	// Detect tests from scripts
	const scripts = Object.keys(metadata.scripts).join(" ").toLowerCase();
	if (scripts.includes("test") || scripts.includes("phpunit")) {
		metadata.hasTests = true;
		metadata.testFramework = "phpunit";
	}

	return metadata;
}

/**
 * Detect Ruby project from Gemfile
 */
function detectRubyProject(targetPath: string): ProjectMetadata | null {
	const gemfilePath = path.join(targetPath, "Gemfile");
	const gemspecPath = fs.readdirSync(targetPath).find(f => f.endsWith(".gemspec"));
	
	if (!fs.existsSync(gemfilePath) && !gemspecPath) {
		return null;
	}

	const metadata: ProjectMetadata = {
		type: "ruby",
		packageManager: "bundler",
		scripts: {},
		languages: ["ruby"],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: [],
	};

	if (fs.existsSync(gemfilePath)) metadata.configFiles.push("Gemfile");
	if (gemspecPath) metadata.configFiles.push(gemspecPath);

	// Check for Rakefile to get tasks
	const rakefilePath = path.join(targetPath, "Rakefile");
	if (fs.existsSync(rakefilePath)) {
		metadata.configFiles.push("Rakefile");
	}

	// Check for test framework
	if (fs.existsSync(path.join(targetPath, "spec"))) {
		metadata.hasTests = true;
		metadata.testFramework = "rspec";
	} else if (fs.existsSync(path.join(targetPath, "test"))) {
		metadata.hasTests = true;
		metadata.testFramework = "minitest";
	}

	// Check for rubocop
	if (fs.existsSync(path.join(targetPath, ".rubocop.yml"))) {
		metadata.hasLinting = true;
		metadata.linter = "rubocop";
		metadata.configFiles.push(".rubocop.yml");
	}

	return metadata;
}

function detectJavaProject(targetPath: string): ProjectMetadata | null {
	const hasPom = fs.existsSync(path.join(targetPath, "pom.xml"));
	const hasGradle = fs.existsSync(path.join(targetPath, "build.gradle")) ||
		fs.existsSync(path.join(targetPath, "build.gradle.kts"));
	if (!hasPom && !hasGradle) return null;
	return {
		type: "java",
		packageManager: hasPom ? "maven" as PackageManager : "gradle" as PackageManager,
		scripts: {},
		languages: ["java"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: hasPom ? ["pom.xml"] : ["build.gradle"],
	};
}

function detectKotlinProject(targetPath: string): ProjectMetadata | null {
	const hasGradleKts = fs.existsSync(path.join(targetPath, "build.gradle.kts"));
	const hasKotlinSrc = fs.existsSync(path.join(targetPath, "src", "main", "kotlin"));
	if (!hasGradleKts && !hasKotlinSrc) return null;
	return {
		type: "kotlin",
		packageManager: "gradle" as PackageManager,
		scripts: {},
		languages: ["kotlin"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: hasGradleKts ? ["build.gradle.kts"] : [],
	};
}

function detectCsharpProject(targetPath: string): ProjectMetadata | null {
	const entries = fs.readdirSync(targetPath);
	const hasSln = entries.some(e => /\.(sln|slnx)$/i.test(e));
	const hasCsproj = entries.some(e => /\.csproj$/i.test(e));
	if (!hasSln && !hasCsproj) return null;
	const configFile = entries.find(e => /\.(sln|slnx|csproj)$/i.test(e)) ?? "";
	return {
		type: "csharp",
		packageManager: "dotnet" as PackageManager,
		scripts: {},
		languages: ["csharp"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: [configFile],
	};
}

function detectDartProject(targetPath: string): ProjectMetadata | null {
	if (!fs.existsSync(path.join(targetPath, "pubspec.yaml"))) return null;
	return {
		type: "dart",
		packageManager: "pub" as PackageManager,
		scripts: {},
		languages: ["dart"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["pubspec.yaml"],
	};
}

function detectGleamProject(targetPath: string): ProjectMetadata | null {
	if (!fs.existsSync(path.join(targetPath, "gleam.toml"))) return null;
	return {
		type: "gleam",
		packageManager: "gleam" as PackageManager,
		scripts: {},
		languages: ["gleam"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["gleam.toml"],
	};
}

function detectZigProject(targetPath: string): ProjectMetadata | null {
	if (!fs.existsSync(path.join(targetPath, "build.zig"))) return null;
	return {
		type: "zig",
		packageManager: "zig" as PackageManager,
		scripts: {},
		languages: ["zig"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["build.zig"],
	};
}

function detectElixirProject(targetPath: string): ProjectMetadata | null {
	if (!fs.existsSync(path.join(targetPath, "mix.exs"))) return null;
	return {
		type: "elixir",
		packageManager: "mix" as PackageManager,
		scripts: {},
		languages: ["elixir"],
		hasTests: true,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles: ["mix.exs"],
	};
}

function detectCppProject(targetPath: string): ProjectMetadata | null {
	const hasCmake = fs.existsSync(path.join(targetPath, "CMakeLists.txt"));
	const hasMakefile = fs.existsSync(path.join(targetPath, "Makefile"));
	// Also detect by source files if no build system marker
	const hasCppFiles = fs.existsSync(targetPath) &&
		fs.readdirSync(targetPath).some(f => /\.(cpp|cxx|cc|c\+\+)$/i.test(f));
	if (!hasCmake && !hasMakefile && !hasCppFiles) return null;
	const configFiles: string[] = [];
	if (hasCmake) configFiles.push("CMakeLists.txt");
	if (hasMakefile) configFiles.push("Makefile");
	return {
		type: "cpp",
		scripts: {},
		languages: ["cpp"],
		hasTests: false,
		hasLinting: false,
		hasFormatting: false,
		hasTypeScript: false,
		configFiles,
	};
}

// --- Formatting Utilities ---

/**
 * Format project metadata for display in reports
 */
export function formatProjectMetadata(metadata: ProjectMetadata): string {
	const lines: string[] = [];

	// Header
	const name = metadata.name ? `**${metadata.name}**` : "Project";
	const type = metadata.type !== "unknown" ? `(${capitalize(metadata.type)})` : "";
	lines.push(`📊 ${name} ${type}`.trim());

	// Package manager
	if (metadata.packageManager) {
		lines.push(`📦 Package Manager: ${capitalize(metadata.packageManager)}`);
	}

	// Languages
	if (metadata.languages.length > 0) {
		lines.push(`📝 Languages: ${metadata.languages.map(capitalize).join(", ")}`);
	}

	// Tools
	const tools: string[] = [];
	if (metadata.hasTests) {
		tools.push(metadata.testFramework ? `🧪 ${metadata.testFramework}` : "🧪 tests");
	}
	if (metadata.hasLinting) {
		tools.push(metadata.linter ? `🔍 ${metadata.linter}` : "🔍 linting");
	}
	if (metadata.hasFormatting) {
		tools.push(metadata.formatter ? `✨ ${metadata.formatter}` : "✨ formatting");
	}
	if (tools.length > 0) {
		lines.push(tools.join(" | "));
	}

	// Config files (limited)
	if (metadata.configFiles.length > 0) {
		const limited = metadata.configFiles.slice(0, 5);
		const more = metadata.configFiles.length > 5 ? ` (+${metadata.configFiles.length - 5} more)` : "";
		lines.push(`⚙️ Config: ${limited.join(", ")}${more}`);
	}

	return lines.join("\n");
}

/**
 * Get available commands for a project (build, test, lint, etc.)
 */
export function getAvailableCommands(metadata: ProjectMetadata): Array<{action: string; command: string}> {
	const commands: Array<{action: string; command: string}> = [];

	// Node.js projects - use npm scripts
	if (metadata.type === "node" && Object.keys(metadata.scripts).length > 0) {
		const scriptPriority = ["test", "build", "lint", "format", "dev", "start", "typecheck"];
		
		for (const priority of scriptPriority) {
			const matching = Object.entries(metadata.scripts).find(([name]) => 
				name.toLowerCase().includes(priority)
			);
			if (matching) {
				const pm = (metadata.packageManager ?? "npm") as NodePackageManager;
				commands.push({
					action: priority,
					command: formatRunScript(pm, matching[0]),
				});
			}
		}
	}

	// Python projects
	if (metadata.type === "python") {
		if (metadata.hasTests) {
			const testCmd = metadata.packageManager === "poetry" ? "poetry run pytest" :
			                metadata.packageManager === "uv" ? "uv run pytest" :
			                "pytest";
			commands.push({ action: "test", command: testCmd });
		}
		if (metadata.linter?.includes("ruff")) {
			commands.push({ action: "lint", command: "ruff check ." });
			commands.push({ action: "format", command: "ruff format ." });
		}
	}

	// Rust projects
	if (metadata.type === "rust") {
		commands.push({ action: "build", command: "cargo build" });
		commands.push({ action: "test", command: "cargo test" });
		if (metadata.hasLinting) {
			commands.push({ action: "lint", command: "cargo clippy" });
		}
	}

	// Go projects
	if (metadata.type === "go") {
		commands.push({ action: "build", command: "go build" });
		commands.push({ action: "test", command: "go test ./..." });
		if (metadata.hasLinting) {
			commands.push({ action: "lint", command: "golangci-lint run" });
		}
	}

	return commands;
}

function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
