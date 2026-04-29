/**
 * Formatter Definitions for pi-lens
 *
 * Auto-detects formatters based on:
 * - Config files (biome.json, .prettierrc, etc.)
 * - Dependencies (package.json, requirements.txt, etc.)
 * - Binary availability (which/where)
 *
 * Inspired by OpenCode's formatter.ts pattern
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { safeSpawn } from "./safe-spawn.js";
import {
	getAutoInstallToolIdForFormatter,
	getFormatterPolicyForFile,
	getSmartDefaultFormatterName,
	hasBiomeConfig,
	hasBlackConfig,
	hasClangFormatConfig,
	hasNearestPackageJsonDependency,
	hasNearestPackageJsonField,
	hasOcamlformatConfig,
	hasOxfmtConfig,
	hasPhpCsFixerConfig,
	hasPrettierConfig,
	hasRubocopConfig,
	hasRuffConfig,
	hasSqlfluffConfig,
	hasStandardrbConfig,
	hasStyluaConfig,
} from "./tool-policy.js";

const _lazyInstallAttempts = new Set<string>();

async function tryLazyInstallFormatterTool(
	tool: "rubocop" | "rustfmt",
	cwd: string,
): Promise<boolean> {
	const attemptKey = `${tool}:${cwd}`;
	if (_lazyInstallAttempts.has(attemptKey)) return false;
	_lazyInstallAttempts.add(attemptKey);

	if (tool === "rubocop") {
		const res = safeSpawn("gem", ["install", "rubocop", "--no-document"], {
			timeout: 180000,
			cwd,
		});
		const ok = !res.error && res.status === 0;
		if (!ok) {
			console.error(
				`[format] lazy-install rubocop failed: ${res.error?.message ?? res.stderr ?? `exit ${res.status}`}`,
			);
		}
		return ok;
	}

	const res = safeSpawn("rustup", ["component", "add", "rustfmt"], {
		timeout: 180000,
		cwd,
	});
	const ok = !res.error && res.status === 0;
	if (!ok) {
		console.error(
			`[format] lazy-install rustfmt failed: ${res.error?.message ?? res.stderr ?? `exit ${res.status}`}`,
		);
	}
	return ok;
}

// --- Types ---

export interface FormatterInfo {
	name: string;
	command: string[]; // Command with $FILE placeholder — used as fallback
	extensions: string[];
	/** Detect if this formatter should be used for a project */
	detect(cwd: string): Promise<boolean>;
	/**
	 * Optionally resolve the full command at runtime (venv, vendor/bin, bundle exec).
	 * Return null to fall back to the static `command` field.
	 * filePath is already resolved to an absolute path.
	 */
	resolveCommand?(filePath: string, cwd: string): Promise<string[] | null>;
}

export interface FormatterResult {
	success: boolean;
	changed: boolean;
	error?: string;
}

// --- Utility Functions ---

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findUp(
	targets: string[],
	startDir: string,
	stopDir: string = path.parse(startDir).root,
): Promise<string[]> {
	const found: string[] = [];
	let currentDir = startDir;

	while (currentDir !== stopDir) {
		for (const target of targets) {
			const checkPath = path.join(currentDir, target);
			if (await fileExists(checkPath)) {
				found.push(checkPath);
			}
		}
		const parent = path.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}

	return found;
}

async function which(command: string): Promise<string | null> {
	const result = safeSpawn(
		process.platform === "win32" ? "where" : "which",
		[command],
		{ timeout: 5000 },
	);
	if (result.error || result.status !== 0) return null;
	return result.stdout?.trim().split(/\r?\n/)[0] ?? null;
}

async function resolveGoFmtBinary(): Promise<string | null> {
	const inPath = await which("gofmt");
	if (inPath) return inPath;

	const goCheck = safeSpawn("go", ["env", "GOROOT"], {
		timeout: 5000,
	});
	if (goCheck.error || goCheck.status !== 0) return null;

	const goroot = (goCheck.stdout ?? "").trim();
	if (!goroot) return null;

	const binary = path.join(
		goroot,
		"bin",
		process.platform === "win32" ? "gofmt.exe" : "gofmt",
	);
	return (await fileExists(binary)) ? binary : null;
}

// --- Venv / Local Binary Helpers ---

/**
 * Walk up from cwd looking for a binary in .venv or venv.
 * Returns the absolute path if found, null otherwise.
 */
async function findInVenv(binary: string, cwd: string): Promise<string | null> {
	const isWin = process.platform === "win32";
	const candidates = isWin
		? [
				`.venv/Scripts/${binary}.exe`,
				`venv/Scripts/${binary}.exe`,
				`.venv/Scripts/${binary}`,
				`venv/Scripts/${binary}`,
			]
		: [`.venv/bin/${binary}`, `venv/bin/${binary}`];

	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Check vendor/bin for PHP Composer-managed tools.
 * Walks up from cwd to find vendor/bin/<binary>.
 */
async function findInVendorBin(
	binary: string,
	cwd: string,
): Promise<string | null> {
	const isWin = process.platform === "win32";
	const names = isWin ? [`${binary}.bat`, binary] : [binary];
	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		for (const name of names) {
			const full = path.join(dir, "vendor", "bin", name);
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Check node_modules/.bin for locally installed Node tools.
 * Walks up from cwd to find node_modules/.bin/<binary>.
 */
async function findInNodeModules(
	binary: string,
	cwd: string,
): Promise<string | null> {
	const isWin = process.platform === "win32";
	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		const candidates = isWin
			? [
					path.join(dir, "node_modules", ".bin", `${binary}.cmd`),
					path.join(dir, "node_modules", ".bin", binary),
				]
			: [path.join(dir, "node_modules", ".bin", binary)];
		for (const full of candidates) {
			if (await fileExists(full)) return full;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Returns true if `bundle exec <gem>` should be used:
 * bundle binary is available AND Gemfile.lock exists in the tree.
 */
async function canUseBundleExec(cwd: string): Promise<boolean> {
	if ((await which("bundle")) === null) return false;
	const lockfiles = await findUp(["Gemfile.lock"], cwd);
	return lockfiles.length > 0;
}

async function resolveManagedSmartDefaultCommand(
	formatterName: string,
	filePath: string,
	args: string[],
): Promise<string[] | null> {
	const toolId = getAutoInstallToolIdForFormatter(formatterName);
	if (!toolId) return null;
	const { ensureTool } = await import("./installer/index.js");
	const installed = await ensureTool(toolId);
	if (!installed) return null;
	return [installed, ...args, filePath];
}

function hasExplicitFormatterConfig(
	formatterName: string,
	cwd: string,
): boolean {
	switch (formatterName) {
		case "biome":
			return hasBiomeConfig(cwd);
		case "prettier":
			return (
				hasPrettierConfig(cwd) || hasNearestPackageJsonField(cwd, "prettier")
			);
		case "oxfmt":
			return (
				hasOxfmtConfig(cwd) ||
				hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt")
			);
		case "ruff":
			return hasRuffConfig(cwd);
		case "black":
			return hasBlackConfig(cwd);
		case "sqlfluff":
			return hasSqlfluffConfig(cwd);
		case "rubocop":
			return hasRubocopConfig(cwd);
		case "standardrb":
			return hasStandardrbConfig(cwd);
		case "clang-format":
			return hasClangFormatConfig(cwd);
		case "php-cs-fixer":
			return hasPhpCsFixerConfig(cwd);
		case "stylua":
			return hasStyluaConfig(cwd);
		case "ocamlformat":
			return hasOcamlformatConfig(cwd);
		default:
			return false;
	}
}

// --- Formatter Definitions ---

async function hasEditorConfig(cwd: string): Promise<boolean> {
	try {
		await fs.access(path.join(cwd, ".editorconfig"));
		return true;
	} catch {
		return false;
	}
}

export const biomeFormatter: FormatterInfo = {
	name: "biome",
	command: ["npx", "@biomejs/biome", "format", "--write", "$FILE"],
	async resolveCommand(filePath, cwd) {
		const editorConfigFlag = (await hasEditorConfig(cwd))
			? ["--use-editorconfig=true"]
			: [];
		const local = await findInNodeModules("biome", cwd);
		if (local) return [local, "format", "--write", ...editorConfigFlag, filePath];
		const toolId = getAutoInstallToolIdForFormatter("biome");
		if (!toolId) return null;
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool(toolId);
		if (installed) return [installed, "format", "--write", ...editorConfigFlag, filePath];
		return null;
	},
	extensions: [
		".js",
		".jsx",
		".mjs",
		".cjs",
		".ts",
		".tsx",
		".mts",
		".cts",
		".json",
		".jsonc",
		".css",
		".scss",
		".sass",
		".vue",
		".svelte",
		".html",
		".htm",
	],
	async detect(cwd: string) {
		return (
			hasBiomeConfig(cwd) ||
			hasNearestPackageJsonDependency(cwd, "@biomejs/biome")
		);
	},
};

export const prettierFormatter: FormatterInfo = {
	name: "prettier",
	command: ["npx", "prettier", "--write", "$FILE"],
	async resolveCommand(filePath, cwd) {
		const local = await findInNodeModules("prettier", cwd);
		if (local) return [local, "--write", filePath];
		return resolveManagedSmartDefaultCommand("prettier", filePath, ["--write"]);
	},
	extensions: [
		".js",
		".jsx",
		".mjs",
		".cjs",
		".ts",
		".tsx",
		".mts",
		".cts",
		".json",
		".jsonc",
		".css",
		".scss",
		".sass",
		".less",
		".vue",
		".svelte",
		".html",
		".htm",
		".md",
		".mdx",
		".yaml",
		".yml",
		".graphql",
		".gql",
	],
	async detect(cwd: string) {
		return (
			hasPrettierConfig(cwd) ||
			hasNearestPackageJsonDependency(cwd, "prettier") ||
			hasNearestPackageJsonField(cwd, "prettier")
		);
	},
};

export const oxfmtFormatter: FormatterInfo = {
	name: "oxfmt",
	command: ["oxfmt", "$FILE"],
	async resolveCommand(filePath, cwd) {
		const local = await findInNodeModules("oxfmt", cwd);
		if (local) return [local, filePath];
		const found = await which("oxfmt");
		if (found) return [found, filePath];
		return null;
	},
	extensions: [
		".js",
		".jsx",
		".mjs",
		".cjs",
		".ts",
		".tsx",
		".mts",
		".cts",
	],
	async detect(cwd: string) {
		return (
			hasOxfmtConfig(cwd) ||
			hasNearestPackageJsonDependency(cwd, "@oxc-project/oxfmt")
		);
	},
};

export const ruffFormatter: FormatterInfo = {
	name: "ruff",
	command: ["ruff", "format", "$FILE"],
	extensions: [".py", ".pyi"],
	async resolveCommand(filePath, cwd) {
		const venv = await findInVenv("ruff", cwd);
		if (venv) return [venv, "format", filePath];
		const toolId = getAutoInstallToolIdForFormatter("ruff");
		if (!toolId) return null;
		const { ensureTool } = await import("./installer/index.js");
		const installed = await ensureTool(toolId);
		if (installed) return [installed, "format", filePath];
		return null;
	},
	async detect(cwd: string) {
		if (hasRuffConfig(cwd)) return true;
		// No-config fallback: if Ruff is already available, allow formatter usage.
		// This keeps Python default behavior consistent with startup defaults.
		const { getToolPath } = await import("./installer/index.js");
		const installed = await getToolPath("ruff");
		return Boolean(installed);
	},
};

export const blackFormatter: FormatterInfo = {
	name: "black",
	command: ["black", "$FILE"],
	extensions: [".py", ".pyi"],
	async resolveCommand(filePath, cwd) {
		const venv = await findInVenv("black", cwd);
		if (venv) return [venv, filePath];
		return null;
	},
	async detect(cwd: string) {
		return hasBlackConfig(cwd);
	},
};

export const sqlfluffFormatter: FormatterInfo = {
	name: "sqlfluff",
	command: ["sqlfluff", "fix", "--force", "$FILE"],
	extensions: [".sql"],
	async resolveCommand(filePath, cwd) {
		const venv = await findInVenv("sqlfluff", cwd);
		if (venv) return [venv, "fix", "--force", filePath];
		return null;
	},
	async detect(cwd: string) {
		return hasSqlfluffConfig(cwd);
	},
};

export const gofmtFormatter: FormatterInfo = {
	name: "gofmt",
	command: ["gofmt", "-w", "$FILE"],
	extensions: [".go"],
	async resolveCommand(filePath, _cwd) {
		const gofmtBinary = await resolveGoFmtBinary();
		if (!gofmtBinary) return null;
		return [gofmtBinary, "-w", filePath];
	},
	async detect(_cwd: string) {
		return (await resolveGoFmtBinary()) !== null;
	},
};

export const rustfmtFormatter: FormatterInfo = {
	name: "rustfmt",
	command: ["rustfmt", "$FILE"],
	extensions: [".rs"],
	async detect(cwd: string) {
		if ((await which("rustfmt")) !== null) return true;
		// If we're in a Rust project, attempt one lazy install of rustfmt component.
		const rustProject = (await findUp(["Cargo.toml"], cwd)).length > 0;
		if (!rustProject) return false;
		if ((await which("rustup")) === null) return false;
		await tryLazyInstallFormatterTool("rustfmt", cwd);
		return (await which("rustfmt")) !== null;
	},
};

export const zigFormatter: FormatterInfo = {
	name: "zig",
	command: ["zig", "fmt", "$FILE"],
	extensions: [".zig", ".zon"],
	async detect(_cwd: string) {
		return (await which("zig")) !== null;
	},
};

export const dartFormatter: FormatterInfo = {
	name: "dart",
	command: ["dart", "format", "$FILE"],
	extensions: [".dart"],
	async detect(_cwd: string) {
		return (await which("dart")) !== null;
	},
};

export const shfmtFormatter: FormatterInfo = {
	name: "shfmt",
	command: ["shfmt", "-w", "$FILE"],
	extensions: [".sh", ".bash"],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("shfmt");
		if (inPath) return [inPath, "-w", filePath];
		return resolveManagedSmartDefaultCommand("shfmt", filePath, ["-w"]);
	},
	async detect(_cwd: string) {
		if ((await which("shfmt")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("shfmt"));
	},
};

export const nixfmtFormatter: FormatterInfo = {
	name: "nixfmt",
	command: ["nixfmt", "$FILE"],
	extensions: [".nix"],
	async detect(_cwd: string) {
		return (await which("nixfmt")) !== null;
	},
};

export const mixFormatter: FormatterInfo = {
	name: "mix",
	command: ["mix", "format", "$FILE"],
	extensions: [".ex", ".exs", ".eex", ".heex", ".leex"],
	async detect(_cwd: string) {
		return (await which("mix")) !== null;
	},
};

export const ocamlformatFormatter: FormatterInfo = {
	name: "ocamlformat",
	command: ["ocamlformat", "-i", "$FILE"],
	extensions: [".ml", ".mli"],
	async detect(cwd: string) {
		const hasBinary = (await which("ocamlformat")) !== null;
		if (!hasBinary) return false;
		const configs = [".ocamlformat"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const clangFormatFormatter: FormatterInfo = {
	name: "clang-format",
	command: ["clang-format", "-i", "$FILE"],
	extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ino"],
	async detect(cwd: string) {
		const hasBinary = (await which("clang-format")) !== null;
		if (!hasBinary) return false;
		const configs = [".clang-format", "_clang-format"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const ktlintFormatter: FormatterInfo = {
	name: "ktlint",
	command: ["ktlint", "-F", "$FILE"],
	extensions: [".kt", ".kts"],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("ktlint");
		if (inPath) return [inPath, "-F", filePath];
		return resolveManagedSmartDefaultCommand("ktlint", filePath, ["-F"]);
	},
	async detect(_cwd: string) {
		if ((await which("ktlint")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("ktlint"));
	},
};

export const rubocopFormatter: FormatterInfo = {
	name: "rubocop",
	command: ["rubocop", "-a", "--no-color", "$FILE"],
	extensions: [".rb", ".rake", ".gemspec", ".ru"],
	async resolveCommand(filePath, cwd) {
		if (await canUseBundleExec(cwd))
			return ["bundle", "exec", "rubocop", "-a", "--no-color", filePath];
		return null;
	},
	async detect(cwd: string) {
		if (!hasRubocopConfig(cwd)) return false;
		if ((await which("rubocop")) !== null) return true;
		await tryLazyInstallFormatterTool("rubocop", cwd);
		return (await which("rubocop")) !== null;
	},
};

export const standardrbFormatter: FormatterInfo = {
	name: "standardrb",
	command: ["standardrb", "--fix", "$FILE"],
	extensions: [".rb", ".rake"],
	async resolveCommand(filePath, cwd) {
		if (await canUseBundleExec(cwd))
			return ["bundle", "exec", "standardrb", "--fix", filePath];
		return null;
	},
	async detect(cwd: string) {
		if (!hasStandardrbConfig(cwd)) return false;
		return (await which("standardrb")) !== null;
	},
};

export const gleamFormatter: FormatterInfo = {
	name: "gleam",
	command: ["gleam", "format", "$FILE"],
	extensions: [".gleam"],
	async detect(cwd: string) {
		// Present if gleam.toml exists (any Gleam project)
		const found = await findUp(["gleam.toml"], cwd);
		if (found.length > 0) return (await which("gleam")) !== null;
		return false;
	},
};

export const terraformFormatter: FormatterInfo = {
	name: "terraform",
	command: ["terraform", "fmt", "$FILE"],
	extensions: [".tf", ".tfvars"],
	async detect(_cwd: string) {
		return (await which("terraform")) !== null;
	},
};

export const phpCsFixerFormatter: FormatterInfo = {
	name: "php-cs-fixer",
	command: ["php-cs-fixer", "fix", "$FILE"],
	extensions: [".php"],
	async resolveCommand(filePath, cwd) {
		const vendor = await findInVendorBin("php-cs-fixer", cwd);
		if (vendor) return [vendor, "fix", filePath];
		return null;
	},
	async detect(cwd: string) {
		const vendorBin = await findInVendorBin("php-cs-fixer", cwd);
		const globalBin = await which("php-cs-fixer");
		if (!vendorBin && !globalBin) return false;
		// Only run if project has explicit config
		const configs = [".php-cs-fixer.php", ".php-cs-fixer.dist.php"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const csharpierFormatter: FormatterInfo = {
	name: "csharpier",
	command: ["dotnet", "csharpier", "$FILE"],
	extensions: [".cs"],
	async detect(_cwd: string) {
		// Check dotnet is available AND csharpier tool is installed
		if ((await which("dotnet")) === null) return false;
		const result = safeSpawn("dotnet", ["csharpier", "--version"], {
			timeout: 5000,
		});
		return !result.error && result.status === 0;
	},
};

export const fantomasFormatter: FormatterInfo = {
	name: "fantomas",
	command: ["fantomas", "$FILE"],
	extensions: [".fs", ".fsi", ".fsx"],
	async detect(_cwd: string) {
		return (await which("fantomas")) !== null;
	},
};

export const swiftformatFormatter: FormatterInfo = {
	name: "swiftformat",
	command: ["swiftformat", "$FILE"],
	extensions: [".swift"],
	async detect(_cwd: string) {
		return (await which("swiftformat")) !== null;
	},
};

export const styluaFormatter: FormatterInfo = {
	name: "stylua",
	command: ["stylua", "$FILE"],
	extensions: [".lua"],
	async detect(cwd: string) {
		if ((await which("stylua")) === null) return false;
		// Prefer explicit config but also run if binary is present in a Lua project
		const configs = ["stylua.toml", ".stylua.toml"];
		const found = await findUp(configs, cwd);
		return found.length > 0;
	},
};

export const ormoluFormatter: FormatterInfo = {
	name: "ormolu",
	command: ["ormolu", "--mode", "inplace", "$FILE"],
	extensions: [".hs", ".lhs"],
	async detect(_cwd: string) {
		return (await which("ormolu")) !== null;
	},
};

export const taploFormatter: FormatterInfo = {
	name: "taplo",
	command: ["taplo", "fmt", "$FILE"],
	extensions: [".toml"],
	async resolveCommand(filePath, _cwd) {
		const inPath = await which("taplo");
		if (inPath) return [inPath, "fmt", filePath];
		return resolveManagedSmartDefaultCommand("taplo", filePath, ["fmt"]);
	},
	async detect(_cwd: string) {
		if ((await which("taplo")) !== null) return true;
		const { getToolPath } = await import("./installer/index.js");
		return Boolean(await getToolPath("taplo"));
	},
};

// --- Registry ---

const ALL_FORMATTERS: FormatterInfo[] = [
	biomeFormatter,
	prettierFormatter,
	oxfmtFormatter,
	ruffFormatter,
	blackFormatter,
	sqlfluffFormatter,
	gofmtFormatter,
	rustfmtFormatter,
	zigFormatter,
	dartFormatter,
	shfmtFormatter,
	nixfmtFormatter,
	mixFormatter,
	ocamlformatFormatter,
	clangFormatFormatter,
	ktlintFormatter,
	terraformFormatter,
	phpCsFixerFormatter,
	csharpierFormatter,
	fantomasFormatter,
	swiftformatFormatter,
	styluaFormatter,
	ormoluFormatter,
	rubocopFormatter,
	standardrbFormatter,
	gleamFormatter,
	taploFormatter,
];

// Cache for detection results - stores array of enabled formatter names per cwd+ext
const detectionCache = new Map<string, Map<string, string[]>>();

// --- Public API ---

export async function getFormattersForFile(
	filePath: string,
	cwd: string,
): Promise<FormatterInfo[]> {
	const ext = path.extname(filePath).toLowerCase();
	const cacheKey = `${cwd}:${ext}`;

	// Check cache
	let cached = detectionCache.get(cwd);
	if (!cached) {
		cached = new Map();
		detectionCache.set(cwd, cached);
	}

	if (cached.has(cacheKey)) {
		const enabledNames = cached.get(cacheKey);
		if (!enabledNames || enabledNames.length === 0) return [];
		// Return cached formatters by name (preserves priority order)
		return ALL_FORMATTERS.filter((f) => enabledNames.includes(f.name));
	}

	// Detect formatters for this extension
	const matching = ALL_FORMATTERS.filter((f) => f.extensions.includes(ext));
	const formatterPolicy = getFormatterPolicyForFile(filePath);
	const smartDefaultFormatterName = getSmartDefaultFormatterName(filePath);

	const candidateFormatters = formatterPolicy?.formatterNames?.length
		? matching.filter((f) => formatterPolicy.formatterNames.includes(f.name))
		: matching;

	let selected: FormatterInfo | undefined;
	if (formatterPolicy) {
		const explicitlyConfigured = candidateFormatters.filter((formatter) =>
			hasExplicitFormatterConfig(formatter.name, cwd),
		);
		if (explicitlyConfigured.length > 0) {
			selected = formatterPolicy.defaultFormatter
				? (explicitlyConfigured.find(
						(f) => f.name === formatterPolicy.defaultFormatter,
					) ?? explicitlyConfigured[0])
				: explicitlyConfigured[0];
		} else if (smartDefaultFormatterName) {
			const smartDefaultFormatter = candidateFormatters.find(
				(f) => f.name === smartDefaultFormatterName,
			);
			if (smartDefaultFormatter) {
				const autoInstallToolId = getAutoInstallToolIdForFormatter(
					smartDefaultFormatter.name,
				);
				if (autoInstallToolId || (await smartDefaultFormatter.detect(cwd))) {
					selected = smartDefaultFormatter;
				}
			}
		}
	} else {
		for (const formatter of candidateFormatters) {
			try {
				if (await formatter.detect(cwd)) {
					selected = formatter;
					break;
				}
			} catch (err) {
				// pi-lens-ignore: missing-error-propagation — optional formatter detection, skip on failure
				console.error(`[format] Detection failed for ${formatter.name}:`, err);
			}
		}
	}

	const enabled = selected ? [selected] : [];

	// Store the list of enabled formatter names in cache
	const enabledNames = enabled.map((f) => f.name);
	cached.set(cacheKey, enabledNames);
	return enabled;
}

export function clearFormatterCache(): void {
	detectionCache.clear();
}

export function clearFormatterRuntimeState(): void {
	detectionCache.clear();
	_lazyInstallAttempts.clear();
}

export async function formatFile(
	filePath: string,
	formatter: FormatterInfo,
): Promise<FormatterResult> {
	try {
		const absolutePath = path.resolve(filePath);
		const cwd = path.dirname(absolutePath);
		const contentBefore = await fs.readFile(absolutePath, "utf-8");

		// Resolve command: prefer local (venv/vendor/node_modules) over global
		const resolved = formatter.resolveCommand
			? await formatter.resolveCommand(absolutePath, cwd)
			: null;
		const cmd =
			resolved ??
			formatter.command.map((c) => c.replace("$FILE", absolutePath));

		// Run formatter
		const result = safeSpawn(cmd[0], cmd.slice(1), { timeout: 15000, cwd });

		if (result.error) {
			return {
				success: false,
				changed: false,
				error: result.error.message,
			};
		}

		// Check if content changed
		const contentAfter = await fs.readFile(absolutePath, "utf-8");
		const changed = contentBefore !== contentAfter;

		return {
			success: true,
			changed,
		};
	} catch (err) {
		return {
			success: false,
			changed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export function listAllFormatters(): string[] {
	return ALL_FORMATTERS.map((f) => f.name);
}
