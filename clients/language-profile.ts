import * as fs from "node:fs";
import * as path from "node:path";
import {
	CODE_KINDS,
	detectFileKind,
	DOTNET_CSHARP_ROOT_MARKERS,
	DOTNET_FSHARP_ROOT_MARKERS,
	KIND_EXTENSIONS,
	TERRAGRUNT_FILENAMES,
	type FileKind,
} from "./file-kinds.js";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import { direntsHaveMarkerGlobMatch, normalizeMapKey } from "./path-utils.js";
import {
	LANGUAGE_POLICY,
	type ProjectLanguageProfile,
} from "./language-policy.js";
import { getSourceFiles } from "./scan-utils.js";
import { readDirEntriesSafe, shouldRecurseIntoDir } from "./source-walker.js";
import { findNearestDirWithAnyBasename } from "./workspace-topology.js";
import { BoundedLruCache } from "./bounded-cache.js";

/** Every registered kind participates in project-language detection (#894). */
export const SUPPORTED_FILE_KINDS: readonly FileKind[] = Object.keys(
	KIND_EXTENSIONS,
) as FileKind[];

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
	cue: ["cue.mod"],
	gleam: ["gleam.toml"],
	terraform: [".terraform.lock.hcl"],
	terragrunt: TERRAGRUNT_FILENAMES,
	nix: ["flake.nix"],
	toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
	csharp: DOTNET_CSHARP_ROOT_MARKERS,
	fsharp: DOTNET_FSHARP_ROOT_MARKERS,
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
	cue: ["cue.mod", ".git"],
	gleam: ["gleam.toml"],
	terraform: [".terraform.lock.hcl"],
	terragrunt: TERRAGRUNT_FILENAMES,
	nix: ["flake.nix"],
	toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
	csharp: DOTNET_CSHARP_ROOT_MARKERS,
	fsharp: DOTNET_FSHARP_ROOT_MARKERS,
};

function hasProjectMarker(projectRoot: string, marker: string): boolean {
	if (!marker.includes("*")) return fs.existsSync(path.join(projectRoot, marker));
	try {
		return direntsHaveMarkerGlobMatch(
			fs.readdirSync(projectRoot, { withFileTypes: true }),
			marker,
		);
	} catch {
		return false;
	}
}

// Process-lifetime memo keyed on projectRoot. Only populated when the
// caller did not pass an explicit `sourceFiles` array — the explicit-array
// case is used by the warmup pipeline to inject pre-collected files and
// must not pollute the no-arg cache. The synchronous getSourceFiles() call
// inside this function does the same expensive ignoreMatcher-driven walk
// as resolveStartupScanContext, so the same memo strategy applies.
const languageProfileCache = new BoundedLruCache<string, ProjectLanguageProfile>(32);

export function detectProjectLanguageProfile(
	projectRoot: string,
	sourceFiles?: string[],
): ProjectLanguageProfile {
	if (sourceFiles === undefined) {
		const cached = languageProfileCache.get(normalizeMapKey(projectRoot));
		if (cached) return cached;
	}
	const result = computeProjectLanguageProfile(projectRoot, sourceFiles);
	if (sourceFiles === undefined) {
		languageProfileCache.set(normalizeMapKey(projectRoot), result);
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
			if (hasProjectMarker(projectRoot, marker)) {
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

	// #807: nearest-marker discovery now shares workspace-topology.ts's single
	// walk/cache/invalidation seam instead of this file's own per-kind
	// `existsSync` climb loop. `findNearestDirWithAnyBasename` additionally
	// rejects a marker at/above `$HOME` (the pre-#807 loop didn't), matching
	// the AGENTS.md walker invariant — harmless here because the
	// workspace-relative check right below already discards any candidate
	// outside `workspaceRoot`, and `workspaceRoot` is never at/above `$HOME`
	// in practice. This keeps resolveLanguageRootForFile's OWN stricter
	// workspace-relative policy check unchanged: the topology service only
	// supplies discovery, not this function's policy.
	const found = findNearestDirWithAnyBasename(startDir, markers);
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

// Keep the warmup walker lightweight (no source-filter dependency), but derive
// its extension gate from the same authority as every other project-wide
// enumeration. Generated-artifact filtering remains intentionally absent here:
// warmup only needs language presence and never opens file contents.
export const WARMUP_SOURCE_EXTS: ReadonlySet<string> = new Set(
	SUPPORTED_FILE_KINDS.flatMap((kind) => KIND_EXTENSIONS[kind]),
);

// Extensions belonging to CODE_KINDS — same derivation, used to give program
// source priority within the capped warmup budget (#894 review, see below).
const WARMUP_CODE_EXTS: ReadonlySet<string> = new Set(
	SUPPORTED_FILE_KINDS.filter((kind) => CODE_KINDS.has(kind)).flatMap(
		(kind) => KIND_EXTENSIONS[kind],
	),
);

// Language detection needs which languages are PRESENT, not every file — so the
// warmup walk is hard-capped. Without this, a walk rooted at a too-broad directory
// (e.g. $HOME, if startup-scan's canWarmCaches guard is bypassed) traverses the
// entire tree — #250's multi-hour home-dir scans. Generous enough to detect every
// language present in any real project (mirrors startup-scan's 2000 limit).
const MAX_WARMUP_SOURCE_FILES = 2000;

// Total matched-file ceiling for the warmup walk, as a multiple of `maxFiles`
// (#894 review): with per-category budgets the walk no longer stops at the
// first `maxFiles` matches, so this keeps its total work deterministic —
// at the default budget it tolerates up to ~20k data/doc files ahead of the
// code dirs before giving up on finding more code files.
const MATCHED_FILES_CEILING_FACTOR = 10;

export async function collectSourceFilesForWarmup(
	rootDir: string,
	maxFiles = MAX_WARMUP_SOURCE_FILES,
	yieldEvery = 100,
): Promise<string[]> {
	const root = path.resolve(rootDir);
	const ignoreMatcher = getProjectIgnoreMatcher(root);
	// #703: prime the tracked-files set once before the walk so a tracked file
	// matching a `.gitignore`/global pattern still counts toward language
	// detection. Fail-open on no-git/spawn failure.
	await ignoreMatcher.ensureTrackedIndex();
	const stack = [root];
	// #894 review: `maxFiles` is a PER-CATEGORY budget — code kinds and
	// data/doc kinds (NON_CODE_KINDS: json/yaml/markdown/…) fill separate
	// buffers. With a single shared budget, 2000+ locale/fixture JSON files
	// encountered before the code dirs exhausted the cap and flipped
	// `present[kind]` to false for the project's real languages. Each buffer
	// keeps the original #250 cap; the walk stops once the code budget is
	// full (real languages are then detected; extra non-code presence can't
	// justify more walking) or after `MATCHED_FILES_CEILING_FACTOR * maxFiles`
	// matching files total — a deterministic work bound in the same spirit as
	// #250's cap, generous enough that a locale/fixture pile ahead of the code
	// dirs can't starve detection, tight enough that a misrooted /
	// data-dominated tree stays bounded (#250/#758 class).
	const codeOut: string[] = [];
	const nonCodeOut: string[] = [];
	let matchedSeen = 0;
	let processedSinceYield = 0;

	walk: while (stack.length > 0) {
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
				const ext = path.extname(entry.name).toLowerCase();
				// #1974: run the cheap extension gate BEFORE the ignore matcher.
				// `isIgnored` is O(ancestorDirs × patterns) with a fresh minimatch
				// regex compile per call — measured 0.7–0.9ms per unique file on a
				// repo whose runtime output dir (wal/) held 43k ignored *.log files,
				// dominating the warmup walk (30.4s of 30.9s). A file that fails
				// the ext gate is dropped by the walk either way, so the ignore
				// probe on it is pure waste. Both gates must pass to collect; only
				// the order changes, so output is unchanged.
				if (!WARMUP_SOURCE_EXTS.has(ext)) continue;
				if (ignoreMatcher.isIgnored(fullPath, false)) continue;
				matchedSeen += 1;
				const bucket = WARMUP_CODE_EXTS.has(ext) ? codeOut : nonCodeOut;
				// Per-category hard cap — language detection only needs
				// presence (#250), so overflowing files of a full category
				// are dropped rather than evicting the other category.
				if (bucket.length < maxFiles) bucket.push(fullPath);
				if (
					codeOut.length >= maxFiles ||
					matchedSeen >= MATCHED_FILES_CEILING_FACTOR * maxFiles
				) {
					break walk;
				}
			}
			// Each iteration performs only bounded dirent/ext/ignore checks. Keep the
			// count cadence: the cost does not scale with the corpus item size, and
			// this walk's existing matched-file ceiling bounds the total work.
			if (++processedSinceYield % yieldEvery === 0) {
				// See countSourceFilesWithinLimitAsync for why setImmediate.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}
	}
	return [...codeOut, ...nonCodeOut];
}

export async function detectProjectLanguageProfileAsync(
	projectRoot: string,
): Promise<ProjectLanguageProfile> {
	const cached = languageProfileCache.get(normalizeMapKey(projectRoot));
	if (cached) return cached;
	const files = await collectSourceFilesForWarmup(projectRoot);
	// Hand the pre-collected file list to the sync detector so it skips its
	// own (synchronous) tree walk. The detector still does the file-marker
	// probe (`existsSync` for package.json / pyproject.toml / etc.) which
	// is constant-time and cheap.
	const result = detectProjectLanguageProfile(projectRoot, files);
	languageProfileCache.set(normalizeMapKey(projectRoot), result);
	return result;
}
