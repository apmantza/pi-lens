import * as fs from "node:fs";
import * as path from "node:path";
import { detectFileKind, type FileKind } from "./file-kinds.js";
import { getStartupDefaultsForProfile } from "./language-policy.js";
import { getSourceFiles } from "./scan-utils.js";

export const SUPPORTED_FILE_KINDS: readonly FileKind[] = [
	"jsts",
	"python",
	"go",
	"rust",
	"cxx",
	"cmake",
	"shell",
	"json",
	"markdown",
	"css",
	"yaml",
	"sql",
	"ruby",
];

const PROJECT_MARKERS_BY_KIND: Partial<Record<FileKind, readonly string[]>> = {
	jsts: ["package.json", "tsconfig.json", "jsconfig.json"],
	python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
	go: ["go.mod"],
	rust: ["Cargo.toml"],
	ruby: ["Gemfile", "Rakefile"],
	yaml: [".yamllint", "yamllint.yaml", "yamllint.yml", "pyproject.toml"],
	sql: [".sqlfluff", "pyproject.toml"],
};

const ROOT_MARKERS_BY_KIND: Partial<Record<FileKind, readonly string[]>> = {
	jsts: ["package.json", "tsconfig.json", "jsconfig.json", "pnpm-workspace.yaml"],
	python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"],
	go: ["go.work", "go.mod", "go.sum"],
	rust: ["Cargo.toml"],
	ruby: ["Gemfile", "Rakefile"],
	yaml: [".yamllint", ".yamllint.yml", ".yamllint.yaml"],
	sql: [".sqlfluff", "pyproject.toml", "setup.cfg", "tox.ini"],
};

export interface ProjectLanguageProfile {
	present: Record<FileKind, boolean>;
	configured: Partial<Record<FileKind, boolean>>;
	counts: Partial<Record<FileKind, number>>;
	detectedKinds: FileKind[];
}

function nearestRoot(start: string, markers: readonly string[]): string | undefined {
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

export function detectProjectLanguageProfile(
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
	return getStartupDefaultsForProfile(profile);
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
