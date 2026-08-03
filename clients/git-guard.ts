import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { CacheManager } from "./cache-manager.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { tokenizeShellCommand } from "./bash-file-access.js";
import { normalizeMapKey } from "./path-utils.js";
import { logLatency } from "./latency-logger.js";

/** The structured, single-source turn record used by context and git-guard. */
export interface TurnEndFindingsCache {
	content: string;
	hasBlockers: boolean;
	affectedFiles: string[];
	sessionId: string;
	projectSeqStart: number;
	projectSeqEnd: number;
	fileSeqByPath: Record<string, number>;
	/** Content fingerprints catch edits made outside pi-lens between turns. */
	fileContentHashes: Record<string, string>;
	/** A capped record is never treated as complete/allowable. */
	affectedFilesTruncated?: boolean;
	/** Files represented by blockerContent, distinct from test failures. */
	blockingFiles?: string[];
	/** Context has consumed the message, but the guard still owns the state. */
	consumed?: boolean;
	testFailures?: boolean;
	testFailureContent?: string;
	testFailureFiles?: string[];
	blockerContent?: string;
}

type GuardDecision = {
	block: boolean;
	unknown?: boolean;
	reason?: string;
};

const MAX_AFFECTED_FILES = 256;

function resolveGuardPath(filePath: string, cwd: string): string {
	return path.resolve(cwd, filePath);
}

function guardPathKey(filePath: string, cwd: string): string {
	return normalizeMapKey(resolveGuardPath(filePath, cwd));
}

function fileFingerprint(filePath: string): string {
	try {
		return createHash("sha256").update(nodeFs.readFileSync(filePath)).digest("hex");
	} catch (err) {
		return `unreadable:${(err as { code?: string }).code ?? "unknown"}`;
	}
}

function currentFileFingerprint(filePath: string): string {
	try {
		nodeFs.statSync(filePath);
		return fileFingerprint(filePath);
	} catch (err) {
		return (err as { code?: string }).code === "ENOENT"
			? "missing"
			: `unreadable:${(err as { code?: string }).code ?? "unknown"}`;
	}
}

function snapshotFileHashes(files: string[], cwd: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const file of files) {
		const resolved = resolveGuardPath(file, cwd);
		hashes[guardPathKey(resolved, cwd)] = currentFileFingerprint(resolved);
	}
	return hashes;
}

function capAffectedFiles(files: string[], cwd: string): {
	files: string[];
	truncated: boolean;
} {
	const unique = [...new Set(files.map((file) => resolveGuardPath(file, cwd)))];
	return {
		files: unique.slice(0, MAX_AFFECTED_FILES),
		truncated: unique.length > MAX_AFFECTED_FILES,
	};
}

function getShellCommand(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const raw = input as { command?: unknown; cmd?: unknown };
	if (typeof raw.command === "string" && raw.command.trim()) return raw.command;
	if (typeof raw.cmd === "string" && raw.cmd.trim()) return raw.cmd;
	if (typeof raw.command === "string") return raw.command;
	return "";
}

function executableName(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	return (normalized.slice(normalized.lastIndexOf("/") + 1) ?? "").toLowerCase();
}

function isShellWrapper(value: string): boolean {
	return new Set([
		"sh",
		"bash",
		"dash",
		"zsh",
		"ash",
		"cmd",
		"cmd.exe",
		"pwsh",
		"pwsh.exe",
		"powershell",
		"powershell.exe",
	]).has(executableName(value));
}

function isGitExecutable(value: string): boolean {
	return new Set(["git", "git.exe", "git.cmd", "git.bat"]).has(
		executableName(value),
	);
}

function containsCommitOrPush(tokens: string[], depth: number): boolean {
	if (depth > 3 || tokens.length === 0) return false;
	let commandTokens = tokens;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(commandTokens[0] ?? "")) {
		commandTokens = commandTokens.slice(1);
	}
	if (commandTokens.length === 0) return false;
	if (isGitExecutable(commandTokens[0])) {
		const tokens = commandTokens;
		let i = 1;
		const takesValue = new Set([
			"-C",
			"-c",
			"--config-env",
			"--git-dir",
			"--work-tree",
			"--exec-path",
			"--namespace",
		]);
		while (i < tokens.length && tokens[i].startsWith("-")) {
			const option = tokens[i];
			if (["--help", "-h", "--version", "-v", "-V"].includes(option)) return false;
			if (option === "--") return tokens[i + 1] === "commit" || tokens[i + 1] === "push";
			if (["-C", "-c"].some((prefix) => option.startsWith(prefix) && option.length > prefix.length)) {
				i += 1;
				continue;
			}
			if (["--config-env", "--git-dir", "--work-tree", "--exec-path", "--namespace"].some((prefix) => option.startsWith(`${prefix}=`))) {
				i += 1;
				continue;
			}
			i += takesValue.has(option) ? 2 : 1;
		}
		return tokens[i] === "commit" || tokens[i] === "push";
	}
	if (!isShellWrapper(commandTokens[0])) return false;
	const lower = commandTokens.slice(1).map((token) => token.toLowerCase());
	const switchIndex = lower.findIndex(
		(token) =>
			token === "-c" ||
			token === "-lc" ||
			token === "/c" ||
			token === "-command" ||
			token === "-command:" ||
			token === "-encodedcommand",
	);
	if (switchIndex < 0 || switchIndex + 2 >= commandTokens.length) return false;
	// Encoded PowerShell is intentionally unsupported: decoding it here would
	// be a second shell/parser and could turn an ambiguous command into a false
	// allow. Plain -Command/-c is safely handed back to the shared lexer.
	if (lower[switchIndex] === "-encodedcommand") return false;
	let commandIndex = switchIndex + 2;
	if (commandTokens[commandIndex] === "--") commandIndex += 1;
	return tokenizeShellCommand(commandTokens[commandIndex] ?? "").some(
		(segment) => containsCommitOrPush(segment.tokens, depth + 1),
	);
}

/** Analyze actual executable invocations, not substrings in shell text. */
export function isGitCommitOrPushAttempt(toolName: string, input: unknown): boolean {
	if (toolName !== "bash") return false;
	const command = getShellCommand(input);
	if (!command) return false;
	return tokenizeShellCommand(command).some((segment) =>
		containsCommitOrPush(segment.tokens, 0),
	);
}

function isTurnEndFindingsCache(value: unknown): value is TurnEndFindingsCache {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TurnEndFindingsCache>;
	return (
		typeof record.content === "string" &&
		typeof record.hasBlockers === "boolean" &&
		Array.isArray(record.affectedFiles) &&
		record.affectedFiles.every((file) => typeof file === "string") &&
		typeof record.sessionId === "string" &&
		typeof record.projectSeqStart === "number" &&
		typeof record.projectSeqEnd === "number" &&
		Number.isFinite(record.projectSeqStart) &&
		Number.isFinite(record.projectSeqEnd) &&
		!!record.fileSeqByPath &&
		typeof record.fileSeqByPath === "object" &&
		Object.values(record.fileSeqByPath).every(
			(seq) => typeof seq === "number" && Number.isFinite(seq),
		) &&
		!!record.fileContentHashes &&
		typeof record.fileContentHashes === "object" &&
		Object.values(record.fileContentHashes).every((hash) => typeof hash === "string") &&
		(record.affectedFilesTruncated === undefined || typeof record.affectedFilesTruncated === "boolean") &&
		(record.blockingFiles === undefined || Array.isArray(record.blockingFiles))
	);
}

function cacheRecord(
	cacheManager: CacheManager,
	cwd: string,
): TurnEndFindingsCache | undefined {
	const entry = cacheManager.readCache<unknown>("turn-end-findings", cwd);
	return entry && isTurnEndFindingsCache(entry.data) ? entry.data : undefined;
}

function markCacheUnknown(runtime: RuntimeCoordinator, reason: string): void {
	runtime.markGitGuardCacheUnknown(reason);
}

/** Persist a complete, bounded, content-bound guard record. */
export function writeGitGuardRecord(
	cacheManager: CacheManager,
	runtime: RuntimeCoordinator,
	cwd: string,
	record: TurnEndFindingsCache,
): boolean {
	const capped = capAffectedFiles(
		Array.isArray(record.affectedFiles) ? record.affectedFiles : [],
		cwd,
	);
	const fileSeqByPath = { ...(record.fileSeqByPath ?? {}) };
	for (const file of capped.files) {
		const key = guardPathKey(file, cwd);
		if (fileSeqByPath[key] === undefined) {
			fileSeqByPath[key] = runtime.getFileSeq(resolveGuardPath(file, cwd));
		}
	}
	const data: TurnEndFindingsCache = {
		...record,
		affectedFiles: capped.files,
		affectedFilesTruncated: capped.truncated,
		fileSeqByPath,
		blockingFiles: Array.isArray(record.blockingFiles)
			? capAffectedFiles(record.blockingFiles, cwd).files
			: undefined,
		fileContentHashes: snapshotFileHashes(capped.files, cwd),
	};
	try {
		cacheManager.writeCache("turn-end-findings", data, cwd);
		runtime.clearGitGuardCacheUnknown();
		return true;
	} catch {
		markCacheUnknown(runtime, "cache_write_failed");
		return false;
	}
}

function logDecision(
	cwd: string,
	decision: "blocked" | "allowed" | "unknown",
	reasonCategory: string,
	metadata: Record<string, unknown> = {},
): void {
	logLatency({
		type: "phase",
		toolName: "git-guard",
		filePath: cwd,
		phase: "decision",
		durationMs: 0,
		result: decision,
		metadata: { decision, reasonCategory, ...metadata },
	});
}

function unknown(cwd: string, reasonCategory: string, metadata = {}): GuardDecision {
	logDecision(cwd, "unknown", reasonCategory, metadata);
	return {
		block: true,
		unknown: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): blocker state is unknown (${reasonCategory}). Re-run pi-lens checks or start a fresh session, then retry.`,
	};
}

/**
 * Reconcile the one persisted record after a per-file dispatch. This is called
 * on tool_result, never tool_call, and therefore does not add disk I/O to the
 * edit preflight path.
 */
export function syncGitGuardRecord(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	editedFilePath?: string,
): void {
	const entries = runtime.getInlineBlockersSnapshot?.() ?? [];
	const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
	const existing = cacheRecord(cacheManager, cwd);
	if (
		existing &&
		existing.sessionId !== runtime.telemetrySessionId &&
		entries.length === 0
	) {
		markCacheUnknown(runtime, "session_mismatch");
		return;
	}
	if (!existing && inspection !== "missing" && entries.length === 0) {
		markCacheUnknown(runtime, `cache_${inspection}`);
		return;
	}
	const fileSeqByPath: Record<string, number> = {};
	for (const [filePath, seq] of runtime.getFileSeqEntries?.() ?? []) {
		fileSeqByPath[guardPathKey(filePath, cwd)] = seq;
	}
	const inlineFiles = entries.map((entry) => resolveGuardPath(entry.filePath, cwd));
	const existingBlockingFiles = existing?.blockingFiles ?? [];
	const editedKey = editedFilePath ? guardPathKey(editedFilePath, cwd) : undefined;
	const testFiles = existing?.testFailureFiles ?? [];
	let affectedFiles = [...(existing?.affectedFiles ?? []), ...inlineFiles];
	if (!entries.length && editedKey && existing) {
		const isStillTestFailure = testFiles.some(
			(file) => guardPathKey(file, cwd) === editedKey,
		);
		const isUnknownBlockingPath =
			existingBlockingFiles.length === 0 && !!existing.blockerContent;
		if (!isStillTestFailure && !isUnknownBlockingPath) {
			affectedFiles = affectedFiles.filter(
				(file) => guardPathKey(file, cwd) !== editedKey,
			);
		}
	}
	const blockerContent =
		entries.length > 0
			? entries.map((entry) => `${entry.filePath}: ${entry.summary}`).join("\n")
			: existing?.blockerContent;
	const hasTestFailures = existing?.testFailures === true;
	const hasBlockers = !!blockerContent || hasTestFailures;
	const content = [blockerContent, hasTestFailures ? existing?.testFailureContent : undefined]
		.filter((value): value is string => !!value)
		.join("\n\n");
	if (!hasBlockers && !content) {
		cacheManager.clearCache("turn-end-findings", cwd);
		return;
	}
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		content: content || existing?.content || "",
		blockerContent,
		blockingFiles: entries.length > 0 ? inlineFiles : existingBlockingFiles,
		hasBlockers,
		affectedFiles,
		sessionId: runtime.telemetrySessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath,
		fileContentHashes: {},
		consumed: false,
		testFailures: existing?.testFailures,
		testFailureContent: existing?.testFailureContent,
		testFailureFiles: existing?.testFailureFiles,
	});
}

/** Add blocking test failures to the same turn-end record. */
export function mergeGitGuardTestFailure(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
	content: string,
	files: string[],
): void {
	const existing = cacheRecord(cacheManager, cwd);
	const fileSeqByPath: Record<string, number> = {};
	for (const [filePath, seq] of runtime.getFileSeqEntries?.() ?? []) {
		fileSeqByPath[guardPathKey(filePath, cwd)] = seq;
	}
	const failedFiles = files.map((file) => resolveGuardPath(file, cwd));
	const blockerContent = existing?.blockerContent;
	const testFailureFiles = [
		...(existing?.testFailureFiles ?? []),
		...failedFiles,
	].filter((file, index, all) =>
		all.findIndex((candidate) => guardPathKey(candidate, cwd) === guardPathKey(file, cwd)) === index,
	);
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		content: [blockerContent, content].filter(Boolean).join("\n\n"),
		blockerContent,
		blockingFiles: existing?.blockingFiles ?? [],
		testFailureContent: content,
		testFailureFiles: testFailureFiles,
		hasBlockers: true,
		affectedFiles: [...(existing?.affectedFiles ?? []), ...failedFiles],
		sessionId: runtime.telemetrySessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath,
		fileContentHashes: {},
		consumed: false,
		testFailures: true,
	});
}

/** A passing test run resolves only its own previous test failures. */
export function clearGitGuardTestFailure(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
	passedFiles: string[] = [],
): void {
	const existing = cacheRecord(cacheManager, cwd);
	if (!existing?.testFailures) return;
	const passedKeys = new Set(
		(passedFiles.length > 0 ? passedFiles : existing.testFailureFiles ?? []).map(
			(file) => guardPathKey(file, cwd),
		),
	);
	const remainingFiles = (existing.testFailureFiles ?? []).filter(
		(file) => !passedKeys.has(guardPathKey(file, cwd)),
	);
	const blockerContent = existing.blockerContent ?? "";
	if (!blockerContent && remainingFiles.length === 0) {
		cacheManager.clearCache("turn-end-findings", cwd);
		return;
	}
	const blockingKeys = new Set(
		(existing.blockingFiles ?? []).map((file) => guardPathKey(file, cwd)),
	);
	const affectedFiles = existing.affectedFiles.filter(
		(file) =>
			blockingKeys.has(guardPathKey(file, cwd)) ||
			remainingFiles.some((testFile) => guardPathKey(testFile, cwd) === guardPathKey(file, cwd)),
	);
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		...existing,
		content: blockerContent,
		blockerContent,
		affectedFiles,
		testFailures: remainingFiles.length > 0,
		testFailureContent: remainingFiles.length > 0 ? existing.testFailureContent : undefined,
		testFailureFiles: remainingFiles.length > 0 ? remainingFiles : undefined,
		hasBlockers: !!blockerContent || remainingFiles.length > 0,
		sessionId: runtime.telemetrySessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath: Object.fromEntries(
			runtime.getFileSeqEntries().map(([filePath, seq]) => [guardPathKey(filePath, cwd), seq]),
		),
		fileContentHashes: {},
	});
}

export function evaluateGitGuard(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): GuardDecision {
	if (runtime.gitGuardHasBlockers) {
		logDecision(cwd, "blocked", "runtime_blockers", {
			projectSeq: runtime.projectSeq,
		});
		const detail = runtime.gitGuardSummary ? `\n${runtime.gitGuardSummary}` : "";
		return {
			block: true,
			reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.${detail}\nRun lens_diagnostics mode=all for full details, then commit again.`,
		};
	}
	if (runtime.gitGuardCacheUnknownReason) {
		return unknown(cwd, runtime.gitGuardCacheUnknownReason);
	}

	const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
	if (inspection === "missing") {
		logDecision(cwd, "allowed", "no_record");
		return { block: false };
	}
	if (inspection !== "fresh") return unknown(cwd, `cache_${inspection}`);
	const pending = cacheManager.readCache<unknown>("turn-end-findings", cwd);
	if (!pending || !isTurnEndFindingsCache(pending.data)) {
		return unknown(cwd, "cache_malformed");
	}
	const record = pending.data;
	if (!record.hasBlockers) {
		logDecision(cwd, "allowed", "advisory_only");
		return { block: false };
	}
	if (record.affectedFilesTruncated) {
		return unknown(cwd, "affected_files_truncated");
	}
	if (record.sessionId !== runtime.telemetrySessionId) {
		return unknown(cwd, "session_mismatch");
	}
	if (record.projectSeqEnd !== runtime.projectSeq) {
		return unknown(cwd, "project_sequence_mismatch", {
			recordedProjectSeq: record.projectSeqEnd,
			currentProjectSeq: runtime.projectSeq,
		});
	}
	const liveFiles: string[] = [];
	for (const file of record.affectedFiles) {
		const resolved = resolveGuardPath(file, cwd);
		const key = guardPathKey(resolved, cwd);
		const recordedSeq = record.fileSeqByPath[key];
		if (
			recordedSeq === undefined ||
			recordedSeq !== (runtime.getFileSeq?.(resolved) ?? 0)
		) {
			return unknown(cwd, "file_sequence_mismatch", { file: resolved });
		}
		try {
			if (!isPathIgnoredByProject(resolved, runtime.projectRoot || cwd, false)) {
				const currentHash = currentFileFingerprint(resolved);
				if (currentHash !== "missing") {
					liveFiles.push(resolved);
					const expectedHash = record.fileContentHashes[key];
					if (
						!expectedHash ||
						expectedHash.startsWith("unreadable:") ||
						currentHash.startsWith("unreadable:") ||
						expectedHash !== currentHash
					) {
						return unknown(cwd, "file_content_changed", { file: resolved });
					}
				}
			}
		} catch {
			return unknown(cwd, "file_unreadable", { file: resolved });
		}
	}
	if (record.hasBlockers && record.affectedFiles.length === 0) {
		return unknown(cwd, "blocker_without_affected_file");
	}
	// A deleted/ignored affected file has been resolved; no stale blocker is
	// allowed to survive solely because its old path remains in the record.
	if (record.hasBlockers && liveFiles.length === 0 && record.affectedFiles.length > 0) {
		logDecision(cwd, "allowed", "affected_files_resolved", {
			projectSeq: record.projectSeqEnd,
		});
		return { block: false };
	}
	logDecision(cwd, "blocked", "cache_blockers", {
		projectSeq: record.projectSeqEnd,
		affectedFileCount: record.affectedFiles.length,
	});
	return {
		block: true,
		reason:
			"🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.\nRun lens_diagnostics mode=all for full details, then commit again.",
	};
}
