import * as fs from "node:fs";
import * as path from "node:path";
import {
	getProjectIgnoreMatcher,
	isExcludedDirName,
	type ProjectIgnoreMatcher,
} from "./file-utils.js";
import {
	isGeneratedArtifactDirectoryName,
	isGeneratedOrArtifact,
} from "./generated-artifacts.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
	collectSourceFilesWithBudgetAsync,
	type SourceCollectionOptions,
	type SourceCollectionResult,
} from "./source-filter.js";

export interface ProjectPathPolicyOptions {
	rootDir: string;
	isDirectory?: boolean;
	includeGenerated?: boolean;
	includeDeclarationFiles?: boolean;
	inspectGeneratedHeaders?: boolean;
	ignoreMatcher?: ProjectIgnoreMatcher;
}

export interface ProjectSourceFilePolicyOptions
	extends Omit<ProjectPathPolicyOptions, "isDirectory"> {}

export interface ProjectSourceCollectionOptions
	extends SourceCollectionOptions {}

export function shouldSkipProjectPath(
	filePath: string,
	options: ProjectPathPolicyOptions,
): boolean {
	const isDirectory = options.isDirectory === true;
	const matcher =
		options.ignoreMatcher ?? getProjectIgnoreMatcher(options.rootDir);
	if (matcher.isIgnored(filePath, isDirectory)) return true;

	const name = path.basename(filePath);
	if (isDirectory) {
		if (isExcludedDirName(name)) return true;
		return (
			options.includeGenerated !== true &&
			isGeneratedArtifactDirectoryName(name)
		);
	}

	return (
		options.includeGenerated !== true &&
		isGeneratedOrArtifact(filePath, {
			readContentHeader: options.inspectGeneratedHeaders !== false,
			includeDeclarations: options.includeDeclarationFiles !== true,
		})
	);
}

export function shouldScanProjectSourceFile(
	filePath: string,
	options: ProjectSourceFilePolicyOptions,
): boolean {
	try {
		if (!fs.statSync(filePath).isFile()) return false;
	} catch {
		return false;
	}
	return !shouldSkipProjectPath(filePath, {
		...options,
		isDirectory: false,
	});
}

export function collectProjectSourceFiles(
	rootDir: string,
	options?: ProjectSourceCollectionOptions,
): string[] {
	return collectSourceFiles(rootDir, options);
}

/**
 * Async, chunked-yield twin of {@link collectProjectSourceFiles}. Produces the
 * exact same file list (it shares `classifyEntry` with the sync collector) but
 * yields to the event loop every N entries so a large-tree walk on a hot hook
 * tick (e.g. the per-edit cascade graph rebuild) never holds the loop in one
 * synchronous burst. Prefer this on the per-edit / per-cascade path.
 */
export function collectProjectSourceFilesAsync(
	rootDir: string,
	options?: ProjectSourceCollectionOptions & { yieldEvery?: number },
): Promise<string[]> {
	return collectSourceFilesAsync(rootDir, options);
}

/**
 * Budget-aware twin of {@link collectProjectSourceFilesAsync} (#760): same
 * walk, but returns `{ files, entryBudgetExceeded }` so a caller on a hot
 * path (e.g. the per-edit cascade graph rebuild) can observe that the walk
 * stopped at its `maxScanEntries` entry budget and got a truncated
 * best-effort list rather than a complete enumeration.
 */
export function collectProjectSourceFilesWithBudgetAsync(
	rootDir: string,
	options?: ProjectSourceCollectionOptions & { yieldEvery?: number },
): Promise<SourceCollectionResult> {
	return collectSourceFilesWithBudgetAsync(rootDir, options);
}
