/**
 * Workspace / monorepo module scanner
 *
 * Detects monorepo structure from common manifest files and builds a
 * module-level dependency graph for cascade downstream analysis.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	hasCargoWorkspaceTable,
	readCargoDependencyNames,
	readCargoPackageName,
	readCargoWorkspaceMembers,
} from "../cargo-manifest.js";
import {
	getProjectIgnoreMatcher,
	isExcludedDirName,
	type ProjectIgnoreMatcher,
} from "../file-utils.js";
import { isWithinForm, normalizeMapKey, toPosix } from "../path-utils.js";
import { getWorkspaceManifestMarkers } from "../workspace-topology.js";

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

// Cap on candidate sub-directories probed per workspace glob level (#262).
const MAX_WORKSPACE_CANDIDATES = 5_000;

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

function readJsonSafe(filePath: string): PackageJson | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as PackageJson;
	} catch {
		return undefined;
	}
}

/**
 * Presence checks for the four workspace-manifest markers are sourced from
 * the shared workspace-topology marker index (#806) — one `readdir` pass at
 * `cwd` collects them alongside `.pi-lens.json`/`tsconfig.json` other
 * consumers need for the SAME directory, instead of four independent
 * `existsSync` probes. Manifest CONTENT (workspace globs, the `[workspace]`
 * TOML section, the `workspaces` package.json field) is still read and
 * parsed here — the topology index only answers "is the marker present".
 */
function detectWorkspaceType(cwd: string): WorkspaceType | null {
	const markers = getWorkspaceManifestMarkers(cwd);
	if (markers.hasPnpmWorkspaceYaml) return "pnpm";
	if (markers.hasGoWork) return "go";
	if (markers.hasCargoToml) {
		try {
			const content = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
			// The shared presence check (#2498) — see its own doc comment in
			// cargo-manifest.ts for why a bare `.includes`/regex reimplementation
			// of this test is wrong (comment/sentinel handling).
			if (hasCargoWorkspaceTable(content)) {
				return "cargo";
			}
		} catch {}
	}
	if (markers.hasPackageJson) {
		const pkgJson = readJsonSafe(path.join(cwd, "package.json"));
		const workspaces = normalizeWorkspacePatterns(pkgJson?.workspaces);
		if (workspaces.length > 0) return "npm";
	}
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
	const normalized = toPosix(stripQuotes(pattern.trim()));
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
	return (
		entries
			.filter((entry) => {
				const fullPath = path.join(baseDir, entry.name);
				return (
					entry.isDirectory() &&
					!isExcludedDirName(entry.name) &&
					!ignoreMatcher.isIgnored(fullPath, true)
				);
			})
			// Bound the manifest-probe fan-out so a pathological single directory
			// can't trigger an unbounded existsSync sweep (#262).
			.slice(0, MAX_WORKSPACE_CANDIDATES)
			.map((entry) => path.join(baseDir, entry.name))
			.filter(
				(root) =>
					fs.existsSync(path.join(root, "package.json")) ||
					fs.existsSync(path.join(root, "Cargo.toml")) ||
					fs.existsSync(path.join(root, "go.mod")),
			)
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
		relativePath: toPosix(path.relative(cwd, pkgRoot)),
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
		members = readCargoWorkspaceMembers(content);
	} catch {
		return [];
	}

	const modules: WorkspaceModule[] = [];
	for (const member of members) {
		const pkgRoot = path.resolve(cwd, member);
		const memberToml = path.join(pkgRoot, "Cargo.toml");
		let name = "";
		let deps: string[] = [];
		try {
			const content = fs.readFileSync(memberToml, "utf-8");
			name = readCargoPackageName(content) ?? "";
			deps = readCargoDependencyNames(content);
		} catch {
			continue;
		}
		if (!name) continue;
		modules.push({
			name,
			root: normalizeMapKey(pkgRoot),
			relativePath: toPosix(path.relative(cwd, pkgRoot)),
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
			relativePath: toPosix(path.relative(cwd, pkgRoot)),
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
	_moduleSourceFilesMemo.clear();
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
		if (isWithinForm(normalized, mod.root)) {
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
 * Memo for {@link getModuleSourceFiles} (#1137 remnant, #1318 slice 2). The
 * sole caller is the cascade's per-downstream-module loop
 * (`review-graph/query.ts`), which runs on EVERY edited file — so a monorepo
 * edit re-walked every downstream module's directory tree (recursive
 * `readdirSync`, depth ≤4) even though module file lists almost never change.
 * Keyed by normalized module root; bounded by the workspace's module count
 * (itself bounded by the glob-expansion caps above). Invalidation rides
 * existing freshness seams, no new scheme:
 * - every directory the walk VISITED is re-stat'd by mtimeMs (the repo's
 *   cheap freshness tier, same class as the ancestor-directory-mtime
 *   validation in project-config discovery) — a file add/remove/rename in any
 *   directory that contributed to the result changes that dir's mtime. Recent
 *   stamps are treated as unverifiable because filesystem mtime granularity
 *   can alias a write with the preceding walk;
 * - the ignore matcher is compared by object identity —
 *   `getProjectIgnoreMatcher` returns a fresh object whenever a
 *   `.gitignore`/`.pi-lens.json`/global-config input's size:mtimeMs changes,
 *   so ignore-rule edits re-walk too.
 * Cleared with the module-graph cache (`clearModuleGraphCache`).
 */
interface ModuleSourceFilesMemoEntry {
	files: string[];
	maxFiles: number;
	dirs: Array<{ dir: string; mtimeMs: number; stampedAt: number }>;
	matcher: ProjectIgnoreMatcher;
}
const _moduleSourceFilesMemo = new Map<string, ModuleSourceFilesMemoEntry>();
const MTIME_GRANULARITY_GUARD_MS = 2_000;

function isMemoEntryFresh(entry: ModuleSourceFilesMemoEntry): boolean {
	const validatedAt = Date.now();
	for (const { dir, mtimeMs, stampedAt } of entry.dirs) {
		if (validatedAt - stampedAt < MTIME_GRANULARITY_GUARD_MS) return false;
		try {
			if (fs.statSync(dir).mtimeMs !== mtimeMs) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Get representative source files in a module. Memoized per module root (see
 * above) — the returned array is a copy; mutating it does not affect the memo.
 */
export function getModuleSourceFiles(
	moduleRoot: string,
	maxFiles = 20,
): string[] {
	const root = normalizeMapKey(moduleRoot);
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	const cached = _moduleSourceFilesMemo.get(root);
	if (
		cached &&
		cached.maxFiles === maxFiles &&
		cached.matcher === ignoreMatcher &&
		isMemoEntryFresh(cached)
	) {
		return [...cached.files];
	}

	const files: string[] = [];
	const dirs: Array<{ dir: string; mtimeMs: number; stampedAt: number }> = [];
	let allDirsStamped = true;
	const visit = (dir: string, depth: number): void => {
		if (files.length >= maxFiles || depth > 4) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// Stamp AFTER the readdir: a change landing between readdir and stat
		// records the newer mtime, so validation re-walks (fail-safe direction).
		try {
			dirs.push({
				dir,
				mtimeMs: fs.statSync(dir).mtimeMs,
				stampedAt: Date.now(),
			});
		} catch {
			allDirsStamped = false;
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
			// #1974: extension gate before isIgnored — isIgnored recompiles
			// minimatch patterns per ancestor dir per call, so it should only run
			// for files the cheap extension check already flags as source.
			if (!SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
			if (ignoreMatcher.isIgnored(fullPath, false)) continue;
			files.push(normalizeMapKey(fullPath));
		}
	};
	visit(root, 0);
	if (allDirsStamped) {
		_moduleSourceFilesMemo.set(root, {
			files: [...files],
			maxFiles,
			dirs,
			matcher: ignoreMatcher,
		});
	}
	return files;
}
