import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { normalizeMapKey } from "./path-utils.js";
import type { ProjectLanguageProfile } from "./language-policy.js";
import {
	detectProjectConventions,
	type ProjectConventions,
} from "./project-conventions.js";
import type { RuleScanResult } from "./rules-scanner.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { StartupScanContext } from "./startup-scan.js";
import {
	deserializeWordIndex,
	serializeWordIndex,
	type SerializedWordIndex,
} from "./word-index.js";

// v2: added `wordIndex` (identifier inverted index + BM25, #162). Bumping the
// version invalidates pre-v2 snapshots so they rebuild with the new field.
export const PROJECT_SNAPSHOT_VERSION = 2;

export interface ProjectSnapshotFile {
	path: string;
	mtimeMs: number;
	size: number;
	hash?: string;
	language?: string;
	lineCount?: number;
	imports?: string[];
	symbolCount?: number;
	lastSeq: number;
}

export interface ProjectSnapshotSymbol {
	name: string;
	kind: string;
	filePath: string;
	startLine?: number;
	endLine?: number;
}

export interface ProjectSnapshot {
	version: typeof PROJECT_SNAPSHOT_VERSION;
	projectRoot: string;
	generatedAt: string;
	seq: number;
	files: Record<string, ProjectSnapshotFile>;
	symbols: Record<string, ProjectSnapshotSymbol[]>;
	reverseDeps: Record<string, string[]>;
	cachedExports: Array<[name: string, filePath: string]>;
	wordIndex?: SerializedWordIndex;
	projectRulesScan?: RuleScanResult;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
}

export function getProjectSnapshotPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json");
}

export function getProjectSnapshotMetaPath(cwd: string): string {
	return path.join(
		getProjectDataDir(cwd),
		"cache",
		"project-snapshot.meta.json",
	);
}

export function isProjectSnapshotFresh(
	snapshot: ProjectSnapshot | null | undefined,
	currentProjectSeq: number,
): snapshot is ProjectSnapshot {
	return (
		!!snapshot &&
		snapshot.version === PROJECT_SNAPSHOT_VERSION &&
		snapshot.seq === currentProjectSeq
	);
}

function parseSnapshot(value: unknown): ProjectSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const snapshot = value as Partial<ProjectSnapshot>;
	if (snapshot.version !== PROJECT_SNAPSHOT_VERSION) return null;
	if (typeof snapshot.projectRoot !== "string") return null;
	if (typeof snapshot.generatedAt !== "string") return null;
	if (typeof snapshot.seq !== "number") return null;
	if (!Array.isArray(snapshot.cachedExports)) return null;
	return {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: snapshot.projectRoot,
		generatedAt: snapshot.generatedAt,
		seq: snapshot.seq,
		files: snapshot.files ?? {},
		symbols: snapshot.symbols ?? {},
		reverseDeps: snapshot.reverseDeps ?? {},
		cachedExports: snapshot.cachedExports.filter(
			(entry): entry is [string, string] =>
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				typeof entry[1] === "string",
		),
		wordIndex: snapshot.wordIndex,
		projectRulesScan: snapshot.projectRulesScan,
		startupScan: snapshot.startupScan,
		languageProfile: snapshot.languageProfile,
		conventions: snapshot.conventions,
	};
}

export function loadProjectSnapshot(cwd: string): ProjectSnapshot | null {
	try {
		return parseSnapshot(
			JSON.parse(fs.readFileSync(getProjectSnapshotPath(cwd), "utf-8")),
		);
	} catch {
		return null;
	}
}

export function saveProjectSnapshot(
	cwd: string,
	snapshot: ProjectSnapshot,
): void {
	const snapshotPath = getProjectSnapshotPath(cwd);
	fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
	fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
	fs.writeFileSync(
		getProjectSnapshotMetaPath(cwd),
		JSON.stringify(
			{
				timestamp: snapshot.generatedAt,
				version: snapshot.version,
				seq: snapshot.seq,
			},
			null,
			2,
		),
	);
}

export function buildProjectSnapshotFromRuntime(args: {
	cwd: string;
	runtime: RuntimeCoordinator;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
}): ProjectSnapshot {
	return {
		version: PROJECT_SNAPSHOT_VERSION,
		projectRoot: normalizeMapKey(path.resolve(args.cwd)),
		generatedAt: new Date().toISOString(),
		seq: args.runtime.projectSeq,
		files: {},
		symbols: {},
		reverseDeps: {},
		cachedExports: [...args.runtime.cachedExports.entries()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		wordIndex: args.runtime.wordIndex
			? serializeWordIndex(args.runtime.wordIndex)
			: undefined,
		projectRulesScan: args.runtime.projectRulesScan,
		startupScan: args.startupScan,
		languageProfile: args.languageProfile,
		conventions: args.conventions,
	};
}

export function hydrateRuntimeFromProjectSnapshot(
	runtime: RuntimeCoordinator,
	snapshot: ProjectSnapshot,
): void {
	runtime.cachedExports.clear();
	for (const [name, filePath] of snapshot.cachedExports) {
		runtime.cachedExports.set(name, filePath);
	}
	if (snapshot.projectRulesScan) {
		runtime.projectRulesScan = snapshot.projectRulesScan;
	}
	runtime.wordIndex = deserializeWordIndex(snapshot.wordIndex);
}

export function saveRuntimeProjectSnapshot(args: {
	cwd: string;
	runtime: RuntimeCoordinator;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
	dbg?: (msg: string) => void;
}): void {
	try {
		if (typeof args.runtime.projectSeq !== "number") return;
		const existing = loadProjectSnapshot(args.cwd);
		let conventions = args.conventions ?? existing?.conventions;
		if (!conventions) {
			try {
				conventions = detectProjectConventions(args.cwd);
			} catch (err) {
				args.dbg?.(`project_snapshot: convention detection failed: ${err}`);
			}
		}
		const snapshot = buildProjectSnapshotFromRuntime({
			...args,
			startupScan: args.startupScan ?? existing?.startupScan,
			languageProfile: args.languageProfile ?? existing?.languageProfile,
			conventions,
		});
		if (existing) {
			snapshot.files = existing.files ?? {};
			snapshot.symbols = existing.symbols ?? {};
			snapshot.reverseDeps = existing.reverseDeps ?? {};
			// The word index is built by its own session task, which may not have
			// finished when another task triggers a save — keep the prior index
			// rather than clobbering it with undefined.
			if (!snapshot.wordIndex && existing.wordIndex) {
				snapshot.wordIndex = existing.wordIndex;
			}
		}
		saveProjectSnapshot(args.cwd, snapshot);
		args.dbg?.(
			`project_snapshot: saved seq=${snapshot.seq} exports=${snapshot.cachedExports.length}`,
		);
	} catch (err) {
		args.dbg?.(`project_snapshot: save failed: ${err}`);
	}
}
