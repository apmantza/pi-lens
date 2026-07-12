import * as fs from "node:fs";
import * as path from "node:path";
import { detectFileKind, type FileKind } from "./file-kinds.js";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import {
	LANGUAGE_POLICY,
	type ProjectLanguageProfile,
} from "./language-policy.js";
import { getSourceFiles } from "./scan-utils.js";
import { readDirEntriesSafe, shouldRecurseIntoDir } from "./source-walker.js";

export const SUPPORTED_FILE_KINDS: readonly FileKind[] = [
	"jsts",
	"python",
	"go",
	"rust",
	"cxx",
	"cmake",
	"fish",
	"shell",
	"json",
	"markdown",
	"css",
	"yaml",
	"sql",
	"ruby",
	"html",
	"docker",
	"php",
	"powershell",
	"prisma",
	"csharp",
	"fsharp",
	"java",
	"kotlin",
	"swift",
	"dart",
	"lua",
	"zig",
	"haskell",
	"elixir",
	"gleam",
	"ocaml",
	"clojure",
	"terraform",
	"nix",
	"toml",
];

const PROJECT_MARKERS_BY_KIND: Partial<Record<FileKind, readonly string[]>> = {
	jsts: ["package.json", "tsconfig.json", "jsconfig.json"],
	python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
	go: ["go.mod"],
	rust: ["Cargo.toml"],
	cxx: [
		"compile_commands.json",
		"compile_flags.txt",
		".clangd",
		"CMakeLists.txt",
		"Makefile",
		"makefile",
		"meson.build",
		"build.ninja",
	],
	ruby: ["Gemfile", "Rakefile"],
	yaml: [".yamllint", "yamllint.yaml", "yamllint.yml", "pyproject.toml"],
	sql: [".sqlfluff", "pyproject.toml"],
	php: ["composer.json", "composer.lock"],
	prisma: ["schema.prisma", "prisma/schema.prisma"],
	java: ["pom.xml", "build.gradle", ".classpath"],
	kotlin: ["build.gradle.kts", "build.gradle", "pom.xml"],
	swift: ["Package.swift"],
	dart: ["pubspec.yaml"],
	elixir: ["mix.exs"],
	gleam: ["gleam.toml"],
	terraform: [".terraform.lock.hcl"],
	nix: ["flake.nix"],
	toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
};

const ROOT_MARKERS_BY_KIND: Partial<Record<FileKind, readonly string[]>> = {
	jsts: [
		"package.json",
		"tsconfig.json",
		"jsconfig.json",
		"pnpm-workspace.yaml",
	],
	python: [
		"pyproject.toml",
		"requirements.txt",
		"setup.py",
		"setup.cfg",
		"Pipfile",
	],
	go: ["go.work", "go.mod", "go.sum"],
	rust: ["Cargo.toml"],
	cxx: [
		"compile_commands.json",
		"compile_flags.txt",
		".clangd",
		"CMakeLists.txt",
		"Makefile",
		"makefile",
		"meson.build",
		"build.ninja",
		".git",
	],
	ruby: ["Gemfile", "Rakefile"],
	yaml: [".yamllint", ".yamllint.yml", ".yamllint.yaml"],
	sql: [".sqlfluff", "pyproject.toml", "setup.cfg", "tox.ini"],
	php: ["composer.json", "composer.lock"],
	prisma: ["prisma/schema.prisma", "schema.prisma"],
	java: ["pom.xml", "build.gradle", ".classpath"],
	kotlin: ["build.gradle.kts", "build.gradle", "pom.xml"],
	swift: ["Package.swift"],
	dart: ["pubspec.yaml"],
	elixir: ["mix.exs"],
	gleam: ["gleam.toml"],
	terraform: [".terraform.lock.hcl"],
	nix: ["flake.nix"],
	toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
};

function nearestRoot(
	start: string,
	markers: readonly string[],
): string | undefined {
	let dir = path.resolve(start);
	const { root } = path.parse(dir);

	while (true) {
		for (const marker of markers) {
			if (fs.existsSync(path.join(dir, marker))) {
				return dir;
			}
		}
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return undefined;
}

// Process-lifetime memo keyed on projectRoot. Only populated when the
// caller did not pass an explicit `sourceFiles` array — the explicit-array
// case is used by the warmup pipeline to inject pre-collected files and
// must not pollute the no-arg cache. The synchronous getSourceFiles() call
// inside this function does the same expensive ignoreMatcher-driven walk
// as resolveStartupScanContext, so the same memo strategy applies.
const languageProfileCache = new Map<string, ProjectLanguageProfile>();

export function detectProjectLanguageProfile(
	projectRoot: string,
	sourceFiles?: string[],
): ProjectLanguageProfile {
	if (sourceFiles === undefined) {
		const cached = languageProfileCache.get(projectRoot);
		if (cached) return cached;
	}
	const result = computeProjectLanguageProfile(projectRoot, sourceFiles);
	if (sourceFiles === undefined) {
		languageProfileCache.set(projectRoot, result);
	}
	return result;
}

function computeProjectLanguageProfile(
	projectRoot: string,
	sourceFiles?: string[],
): ProjectLanguageProfile {
	const present = Object.fromEntries(
		SUPPORTED_FILE_KINDS.map((kind) => [kind, false]),
	) as Record<FileKind, boolean>;
	const counts: Partial<Record<FileKind, number>> = {};
	const configured: Partial<Record<FileKind, boolean>> = {};

	for (const [kind, markers] of Object.entries(PROJECT_MARKERS_BY_KIND)) {
		if (!markers) continue;
		for (const marker of markers) {
			if (fs.existsSync(path.join(projectRoot, marker))) {
				present[kind as FileKind] = true;
				configured[kind as FileKind] = true;
				break;
			}
		}
	}

	let files = sourceFiles;
	if (!files) {
		try {
			files = getSourceFiles(projectRoot, true);
		} catch {
			files = [];
		}
	}

	for (const file of files) {
		const kind = detectFileKind(file);
		if (!kind) continue;
		present[kind] = true;
		counts[kind] = (counts[kind] ?? 0) + 1;
	}

	const detectedKinds = SUPPORTED_FILE_KINDS.filter((kind) => present[kind]);

	return {
		present,
		configured,
		counts,
		detectedKinds,
	};
}

export function hasLanguage(
	profile: ProjectLanguageProfile,
	kind: FileKind,
): boolean {
	return !!profile.present[kind];
}

export function hasAnyLanguage(
	profile: ProjectLanguageProfile,
	kinds: readonly FileKind[],
): boolean {
	return kinds.some((kind) => hasLanguage(profile, kind));
}

export function isLanguageConfigured(
	profile: ProjectLanguageProfile,
	kind: FileKind,
): boolean {
	return !!profile.configured[kind];
}

export function getDefaultStartupTools(
	profile: ProjectLanguageProfile,
): string[] {
	const tools = new Set<string>();

	for (const kind of Object.keys(LANGUAGE_POLICY) as FileKind[]) {
		if (!profile.present[kind]) continue;
		const defaults = LANGUAGE_POLICY[kind].startup?.defaults ?? [];
		for (const tool of defaults) {
			if (
				LANGUAGE_POLICY[kind].startup?.heavyScansRequireConfig &&
				!profile.configured[kind]
			) {
				continue;
			}
			tools.add(tool);
		}
	}

	return [...tools];
}

export function resolveLanguageRootForFile(
	filePath: string,
	workspaceRoot: string,
): string {
	const absoluteFilePath = path.resolve(filePath);
	const startDir = path.dirname(absoluteFilePath);
	const kind = detectFileKind(absoluteFilePath);
	if (!kind) return path.resolve(workspaceRoot);

	const markers = ROOT_MARKERS_BY_KIND[kind];
	if (!markers || markers.length === 0) {
		return path.resolve(workspaceRoot);
	}

	const found = nearestRoot(startDir, markers);
	if (!found) return path.resolve(workspaceRoot);

	const workspace = path.resolve(workspaceRoot);
	const relative = path.relative(workspace, found);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return workspace;
	}

	return found;
}

// ---------------------------------------------------------------------------
// Async, chunked-yield variant for the cold-start warmup pipeline. See
// startup-scan.ts comments and runtime-session.ts handleSessionStart for the
// rationale; this is the same idea applied to the language-profile walk.
//
// We collect source files in a way that mirrors the sync `getSourceFiles` /
// `collectSourceFiles` chain but yields to the event loop every N entries.
// The collected file list is then handed to the existing sync
// `detectProjectLanguageProfile` (which is fast once it doesn't need to walk
// the tree itself), and the result is stored in the shared
// `languageProfileCache` so the subsequent sync caller skips the walk.
// ---------------------------------------------------------------------------

// Extensions accepted as project source files. Mirrors the discovery rules
// used by scan-utils.ts but inlined here to keep this file self-contained
// and avoid pulling in source-filter's heavier dependency graph during
// warmup.
const WARMUP_SOURCE_EXTS = new Set([
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
	".java",
	".kt",
	".swift",
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hpp",
	".cs",
]);

// Language detection needs which languages are PRESENT, not every file — so the
// warmup walk is hard-capped. Without this, a walk rooted at a too-broad directory
// (e.g. $HOME, if startup-scan's canWarmCaches guard is bypassed) traverses the
// entire tree — #250's multi-hour home-dir scans. Generous enough to detect every
// language present in any real project (mirrors startup-scan's 2000 limit).
const MAX_WARMUP_SOURCE_FILES = 2000;

export async function collectSourceFilesForWarmup(
	rootDir: string,
	maxFiles = MAX_WARMUP_SOURCE_FILES,
	yieldEvery = 100,
): Promise<string[]> {
	const root = path.resolve(rootDir);
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	const stack = [root];
	const out: string[] = [];
	let processedSinceYield = 0;

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		const entries = readDirEntriesSafe(current);

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				// Never checked symlinks — always follows them (unlike
				// source-filter.ts's collectSourceFiles*, refs #191).
				if (!shouldRecurseIntoDir(entry, fullPath, { ignoreMatcher, followSymlinks: true })) {
					continue;
				}
				stack.push(fullPath);
			} else if (entry.isFile()) {
				if (ignoreMatcher.isIgnored(fullPath, false)) continue;
				const ext = path.extname(entry.name).toLowerCase();
				if (!WARMUP_SOURCE_EXTS.has(ext)) continue;
				out.push(fullPath);
				// Hard cap — language detection only needs presence (#250).
				if (out.length >= maxFiles) return out;
			}
			if (++processedSinceYield % yieldEvery === 0) {
				// See countSourceFilesWithinLimitAsync for why setImmediate.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
	return out;
}

export async function detectProjectLanguageProfileAsync(
	projectRoot: string,
): Promise<ProjectLanguageProfile> {
	const cached = languageProfileCache.get(projectRoot);
	if (cached) return cached;
	const files = await collectSourceFilesForWarmup(projectRoot);
	// Hand the pre-collected file list to the sync detector so it skips its
	// own (synchronous) tree walk. The detector still does the file-marker
	// probe (`existsSync` for package.json / pyproject.toml / etc.) which
	// is constant-time and cheap.
	const result = detectProjectLanguageProfile(projectRoot, files);
	languageProfileCache.set(projectRoot, result);
	return result;
}
