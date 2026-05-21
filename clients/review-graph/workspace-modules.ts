/**
 * Workspace / monorepo module scanner
 *
 * Detects monorepo structure from common manifest files and builds a
 * module-level dependency graph for cascade downstream analysis.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectIgnoreMatcher, isExcludedDirName } from "../file-utils.js";
import { normalizeMapKey } from "../path-utils.js";

export interface WorkspaceModule {
	name: string;
	root: string;
	relativePath: string;
	entrypoints: string[];
	internalDeps: string[];
	externalDeps: string[];
}

export interface ModuleGraph {
	root: string;
	modules: Map<string, WorkspaceModule>;
	/** module name → dependent module names */
	dependents: Map<string, string[]>;
}

type WorkspaceType = "pnpm" | "npm" | "cargo" | "go";

type PackageJson = {
	name?: string;
	main?: string;
	workspaces?: string[] | { packages?: string[] };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".go",
	".rs",
	".rb",
	".cpp",
	".c",
	".cc",
	".h",
	".hpp",
]);

function readJsonSafe(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

function detectWorkspaceType(cwd: string): WorkspaceType | null {
	if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(cwd, "go.work"))) return "go";
	const cargoToml = path.join(cwd, "Cargo.toml");
	if (fs.existsSync(cargoToml)) {
		try {
			const content = fs.readFileSync(cargoToml, "utf-8");
			if (content.includes("[workspace]")) return "cargo";
		} catch {}
	}
	const pkgJson = readJsonSafe(path.join(cwd, "package.json")) as
		| PackageJson
		| undefined;
	const workspaces = normalizeWorkspacePatterns(pkgJson?.workspaces);
	if (workspaces.length > 0) return "npm";
	return null;
}

function stripQuotes(value: string): string {
	return value.trim().replace(/^['"]|['"]$/g, "");
}

function normalizeWorkspacePatterns(
	value: PackageJson["workspaces"],
): string[] {
	if (Array.isArray(value)) return value.map(stripQuotes).filter(Boolean);
	if (value?.packages && Array.isArray(value.packages)) {
		return value.packages.map(stripQuotes).filter(Boolean);
	}
	return [];
}

function expandWorkspacePattern(cwd: string, pattern: string): string[] {
	const normalized = stripQuotes(pattern.trim()).replace(/\\/g, "/");
	if (!normalized || normalized.startsWith("!")) return [];

	const starIndex = normalized.indexOf("*");
	if (starIndex === -1) {
		const root = path.resolve(cwd, normalized);
		return fs.existsSync(path.join(root, "package.json")) ||
			fs.existsSync(path.join(root, "Cargo.toml")) ||
			fs.existsSync(path.join(root, "go.mod"))
			? [root]
			: [];
	}

	// Support the common workspace forms: packages/* and apps/*.
	const prefix = normalized.slice(0, starIndex).replace(/\/$/, "");
	const baseDir = path.resolve(cwd, prefix || ".");
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const ignoreMatcher = getProjectIgnoreMatcher(cwd);
	return entries
		.filter((entry) => {
			const fullPath = path.join(baseDir, entry.name);
			return (
				entry.isDirectory() &&
				!isExcludedDirName(entry.name) &&
				!ignoreMatcher.isIgnored(fullPath, true)
			);
		})
		.map((entry) => path.join(baseDir, entry.name))
		.filter(
			(root) =>
				fs.existsSync(path.join(root, "package.json")) ||
				fs.existsSync(path.join(root, "Cargo.toml")) ||
				fs.existsSync(path.join(root, "go.mod")),
		);
}

function depsFromPackageJson(pkgJson: PackageJson): string[] {
	return Object.keys({
		...pkgJson.dependencies,
		...pkgJson.devDependencies,
		...pkgJson.peerDependencies,
	});
}

function extractYamlList(content: string, key: string): string[] {
	const values: string[] = [];
	let inList = false;
	for (const rawLine of content.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!inList) {
			if (trimmed === `${key}:`) inList = true;
			continue;
		}
		if (trimmed.startsWith("-")) {
			const value = stripQuotes(trimmed.slice(1).trim()).replace(/\/$/, "");
			if (value) values.push(value);
			continue;
		}
		// A new top-level key ends the list.
		if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) break;
	}
	return values;
}

function extractTomlArray(content: string, key: string): string[] {
	const prefix = `${key}`;
	let collecting = false;
	let buffer = "";
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		if (!line) continue;
		if (!collecting) {
			if (!line.startsWith(prefix)) continue;
			const equalsIndex = line.indexOf("=");
			if (equalsIndex === -1 || line.slice(0, equalsIndex).trim() !== key)
				continue;
			const afterEquals = line.slice(equalsIndex + 1).trim();
			if (!afterEquals.startsWith("[")) continue;
			collecting = true;
			buffer += afterEquals.slice(1);
		} else {
			buffer += `,${line}`;
		}
		const closeIndex = buffer.indexOf("]");
		if (closeIndex !== -1) {
			buffer = buffer.slice(0, closeIndex);
			break;
		}
	}
	return buffer
		.split(",")
		.map((s) => stripQuotes(s.trim()))
		.filter(Boolean);
}

function extractTomlSection(content: string, section: string): string[] {
	const lines: string[] = [];
	let inSection = false;
	for (const rawLine of content.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (trimmed === `[${section}]`) {
			inSection = true;
			continue;
		}
		if (inSection && trimmed.startsWith("[") && trimmed.endsWith("]")) break;
		if (inSection) lines.push(rawLine);
	}
	return lines;
}

function extractTomlString(content: string, key: string): string | undefined {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		const equalsIndex = line.indexOf("=");
		if (equalsIndex === -1 || line.slice(0, equalsIndex).trim() !== key)
			continue;
		const value = line.slice(equalsIndex + 1).trim();
		const quote = value[0];
		if ((quote !== '"' && quote !== "'") || value.length < 2) return undefined;
		const endIndex = value.indexOf(quote, 1);
		return endIndex === -1 ? undefined : value.slice(1, endIndex);
	}
	return undefined;
}

function moduleFromPackageJson(
	cwd: string,
	pkgRoot: string,
): WorkspaceModule | null {
	const pkgJson = readJsonSafe(path.join(pkgRoot, "package.json")) as
		| PackageJson
		| undefined;
	if (!pkgJson?.name) return null;
	return {
		name: pkgJson.name,
		root: normalizeMapKey(pkgRoot),
		relativePath: path.relative(cwd, pkgRoot).replace(/\\/g, "/"),
		entrypoints: pkgJson.main ? [pkgJson.main] : ["index.js"],
		internalDeps: [],
		externalDeps: depsFromPackageJson(pkgJson),
	};
}

function scanPnpmModules(cwd: string): WorkspaceModule[] {
	let patterns: string[] = [];
	try {
		const content = fs.readFileSync(
			path.join(cwd, "pnpm-workspace.yaml"),
			"utf-8",
		);
		patterns = extractYamlList(content, "packages");
	} catch {
		return [];
	}

	return patterns
		.flatMap((pattern) => expandWorkspacePattern(cwd, pattern))
		.map((pkgRoot) => moduleFromPackageJson(cwd, pkgRoot))
		.filter((mod): mod is WorkspaceModule => mod !== null);
}

function scanNpmModules(cwd: string): WorkspaceModule[] {
	const pkgJson = readJsonSafe(path.join(cwd, "package.json")) as
		| PackageJson
		| undefined;
	const patterns = normalizeWorkspacePatterns(pkgJson?.workspaces);
	return patterns
		.flatMap((pattern) => expandWorkspacePattern(cwd, pattern))
		.map((pkgRoot) => moduleFromPackageJson(cwd, pkgRoot))
		.filter((mod): mod is WorkspaceModule => mod !== null);
}

function scanCargoModules(cwd: string): WorkspaceModule[] {
	let members: string[] = [];
	try {
		const content = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
		members = extractTomlArray(content, "members");
	} catch {
		return [];
	}

	const modules: WorkspaceModule[] = [];
	for (const member of members) {
		const pkgRoot = path.resolve(cwd, member);
		const memberToml = path.join(pkgRoot, "Cargo.toml");
		let name = "";
		const deps: string[] = [];
		try {
			const content = fs.readFileSync(memberToml, "utf-8");
			name = extractTomlString(content, "name") ?? "";
			for (const line of extractTomlSection(content, "dependencies")) {
				const depName = line.trim().match(/^([A-Za-z0-9_-]+)\s*=/);
				if (depName) deps.push(depName[1]);
			}
		} catch {
			continue;
		}
		if (!name) continue;
		modules.push({
			name,
			root: normalizeMapKey(pkgRoot),
			relativePath: path.relative(cwd, pkgRoot).replace(/\\/g, "/"),
			entrypoints: ["src/lib.rs", "src/main.rs"],
			internalDeps: [],
			externalDeps: deps,
		});
	}
	return modules;
}

function scanGoModules(cwd: string): WorkspaceModule[] {
	let dirs: string[] = [];
	try {
		const content = fs.readFileSync(path.join(cwd, "go.work"), "utf-8");
		dirs = [...content.matchAll(/(?:^|\s)(\.\/?[^\s)]+)/gm)].map((m) => m[1]);
	} catch {
		return [];
	}

	const modules: WorkspaceModule[] = [];
	for (const dir of dirs) {
		const pkgRoot = path.resolve(cwd, dir);
		let name = "";
		try {
			const content = fs.readFileSync(path.join(pkgRoot, "go.mod"), "utf-8");
			const match = content.match(/^module\s+(\S+)/m);
			if (match) name = match[1];
		} catch {
			continue;
		}
		if (!name) continue;
		modules.push({
			name,
			root: normalizeMapKey(pkgRoot),
			relativePath: path.relative(cwd, pkgRoot).replace(/\\/g, "/"),
			entrypoints: ["."],
			internalDeps: [],
			externalDeps: [],
		});
	}
	return modules;
}

function resolveInternalDeps(modules: WorkspaceModule[]): void {
	const nameSet = new Set(modules.map((m) => m.name));
	for (const mod of modules) {
		const internal: string[] = [];
		const external: string[] = [];
		for (const dep of mod.externalDeps) {
			if (nameSet.has(dep)) internal.push(dep);
			else external.push(dep);
		}
		mod.internalDeps = internal;
		mod.externalDeps = external;
	}
}

function buildDependents(modules: WorkspaceModule[]): Map<string, string[]> {
	const dependents = new Map<string, string[]>();
	for (const mod of modules) {
		for (const dep of mod.internalDeps) {
			const list = dependents.get(dep) ?? [];
			list.push(mod.name);
			dependents.set(dep, list);
		}
	}
	return dependents;
}

let _moduleGraphCache: { cwd: string; graph: ModuleGraph } | null = null;

/**
 * Build a module-level dependency graph for the workspace at cwd.
 * Cached per session (cleared when cwd changes).
 */
export function buildModuleGraph(cwd: string): ModuleGraph | null {
	if (_moduleGraphCache && _moduleGraphCache.cwd === cwd) {
		return _moduleGraphCache.graph;
	}

	const type = detectWorkspaceType(cwd);
	if (!type) return null;

	let modules: WorkspaceModule[] = [];
	switch (type) {
		case "pnpm":
			modules = scanPnpmModules(cwd);
			break;
		case "npm":
			modules = scanNpmModules(cwd);
			break;
		case "cargo":
			modules = scanCargoModules(cwd);
			break;
		case "go":
			modules = scanGoModules(cwd);
			break;
	}

	if (modules.length === 0) return null;

	resolveInternalDeps(modules);
	const graph: ModuleGraph = {
		root: cwd,
		modules: new Map(modules.map((m) => [m.name, m])),
		dependents: buildDependents(modules),
	};

	_moduleGraphCache = { cwd, graph };
	return graph;
}

export function clearModuleGraphCache(): void {
	_moduleGraphCache = null;
}

/**
 * Find the module that owns a given file path.
 */
export function findModuleForPath(
	graph: ModuleGraph,
	filePath: string,
): WorkspaceModule | undefined {
	const normalized = normalizeMapKey(filePath);
	let best: WorkspaceModule | undefined;
	for (const mod of graph.modules.values()) {
		if (normalized === mod.root || normalized.startsWith(`${mod.root}/`)) {
			if (!best || mod.root.length > best.root.length) best = mod;
		}
	}
	return best;
}

/**
 * Get all transitive downstream dependent module names for a given module.
 */
export function getDownstreamModules(
	graph: ModuleGraph,
	moduleName: string,
): string[] {
	const downstream = new Set<string>();
	const queue = [moduleName];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const dep of graph.dependents.get(current) ?? []) {
			if (!downstream.has(dep)) {
				downstream.add(dep);
				queue.push(dep);
			}
		}
	}
	return [...downstream];
}

/**
 * Get representative source files in a module.
 */
export function getModuleSourceFiles(
	moduleRoot: string,
	maxFiles = 20,
): string[] {
	const files: string[] = [];
	const root = normalizeMapKey(moduleRoot);
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	const visit = (dir: string, depth: number): void => {
		if (files.length >= maxFiles || depth > 4) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (files.length >= maxFiles) break;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (
					!isExcludedDirName(entry.name) &&
					!ignoreMatcher.isIgnored(fullPath, true)
				) {
					visit(fullPath, depth + 1);
				}
				continue;
			}
			if (!entry.isFile()) continue;
			if (ignoreMatcher.isIgnored(fullPath, false)) continue;
			if (SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
				files.push(normalizeMapKey(fullPath));
			}
		}
	};
	visit(root, 0);
	return files;
}
