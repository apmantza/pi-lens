import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXCLUDED_DIRS } from "./file-utils.js";

export const PROJECT_ROOT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"composer.json",
];

export const MAX_STARTUP_SOURCE_FILES = 2000;
const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs)$/;

export interface StartupScanContext {
	cwd: string;
	scanRoot: string;
	projectRoot: string | null;
	canWarmCaches: boolean;
	reason?: "home-dir" | "no-project-root" | "too-many-source-files";
	sourceFileCount?: number;
}

export interface StartupScanOptions {
	homeDir?: string;
	maxSourceFiles?: number;
}

export function findNearestProjectRoot(startDir: string): string | null {
	let current = path.resolve(startDir);

	while (true) {
		if (
			PROJECT_ROOT_MARKERS.some((marker) =>
				fs.existsSync(path.join(current, marker)),
			)
		) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function countSourceFilesWithinLimit(dir: string, limit: number): number {
	let count = 0;
	const stack = [path.resolve(dir)];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.includes(entry.name)) continue;
				stack.push(path.join(current, entry.name));
				continue;
			}

			if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
				count += 1;
				if (count > limit) return count;
			}
		}
	}

	return count;
}

export function resolveStartupScanContext(
	cwd: string,
	options: StartupScanOptions = {},
): StartupScanContext {
	const resolvedCwd = path.resolve(cwd);
	const homeDir = path.resolve(options.homeDir ?? os.homedir());
	const maxSourceFiles = options.maxSourceFiles ?? MAX_STARTUP_SOURCE_FILES;
	const projectRoot = findNearestProjectRoot(resolvedCwd);

	if (!projectRoot) {
		return {
			cwd: resolvedCwd,
			scanRoot: resolvedCwd,
			projectRoot: null,
			canWarmCaches: false,
			reason: resolvedCwd === homeDir ? "home-dir" : "no-project-root",
		};
	}

	if (path.resolve(projectRoot) === homeDir) {
		return {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: "home-dir",
		};
	}

	const sourceFileCount = countSourceFilesWithinLimit(projectRoot, maxSourceFiles);
	if (sourceFileCount > maxSourceFiles) {
		return {
			cwd: resolvedCwd,
			scanRoot: projectRoot,
			projectRoot,
			canWarmCaches: false,
			reason: "too-many-source-files",
			sourceFileCount,
		};
	}

	return {
		cwd: resolvedCwd,
		scanRoot: projectRoot,
		projectRoot,
		canWarmCaches: true,
		sourceFileCount,
	};
}
