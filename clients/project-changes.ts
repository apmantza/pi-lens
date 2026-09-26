import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { getProjectDataDir } from "./file-utils.js";
import { withGenerationLockSync } from "./generation-lock.js";
import { normalizeMapKey } from "./path-utils.js";

export type ProjectChangeSource =
	| "agent-write"
	| "agent-edit"
	| "format"
	| "autofix"
	| "partial-apply"
	| "lsp-edit"
	/** An LSP `textDocument/rename` or `workspace/willRenameFiles` resource rename (#2450). */
	| "lsp-rename"
	/** A `workspace/executeCommand` (allowlisted) or the `workspace/applyEdit` it solicited (#2450). */
	| "lsp-execute-command"
	| "opaque-script"
	| "external"
	/**
	 * A mutation attributed to a named tool that is neither pi's `write`/`edit`
	 * nor one of pi-lens's own passes (#2423) — a third-party edit tool, or a
	 * producer recording through `clients/mutation-bridge.ts`. The tool name is
	 * carried in the member itself rather than collapsed onto `agent-edit`, so a
	 * change report can tell an extension's rewrite from the model's own edit.
	 */
	| `agent-tool:${string}`;

export interface ProjectChangeRange {
	start: number;
	end: number;
}

export interface ProjectChangeEntry {
	seq: number;
	timestamp: string;
	sessionId: string;
	turnIndex: number;
	source: ProjectChangeSource;
	filePath: string;
	fileSeq: number;
	changedRange?: ProjectChangeRange;
	/**
	 * #3511 review round 2 (R2-F1): appended without the change-log lock, so
	 * a lock holder may have logged the same seq. A snapshot whose runtime
	 * never folded this entry is not fresh (see `ProjectSequenceIndex`).
	 */
	unlocked?: true;
}

export function getProjectChangeLogPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "change-log.jsonl");
}

function parseChangeLine(line: string): ProjectChangeEntry | undefined {
	try {
		const parsed = JSON.parse(line) as Partial<ProjectChangeEntry>;
		if (
			typeof parsed.seq !== "number" ||
			typeof parsed.fileSeq !== "number" ||
			typeof parsed.filePath !== "string" ||
			typeof parsed.source !== "string"
		) {
			return undefined;
		}
		return {
			seq: parsed.seq,
			timestamp: parsed.timestamp ?? new Date(0).toISOString(),
			sessionId: parsed.sessionId ?? "unknown",
			turnIndex: parsed.turnIndex ?? 0,
			source: parsed.source as ProjectChangeSource,
			filePath: parsed.filePath,
			fileSeq: parsed.fileSeq,
			changedRange: parsed.changedRange,
			...(parsed.unlocked === true ? { unlocked: true as const } : {}),
		};
	} catch {
		return undefined;
	}
}

// #3511: the log's max seq, read incrementally so each allocation costs only
// the bytes appended since this process last read the log. `bytes` is the
// offset of the first line not yet folded; the log is append-only.
const changeLogCursors = new BoundedFifoMap<
	string,
	{ bytes: number; maxSeq: number }
>(16);

/**
 * Parse a whole read of the log. The read also seeds the #3511 allocation
 * cursor, so a process's first logged mutation after session_start reads
 * only the lines appended since, not the whole log again.
 */
function parseChangeLog(
	logPath: string,
	content: string,
): ProjectChangeEntry[] {
	const entries = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map(parseChangeLine)
		.filter((entry): entry is ProjectChangeEntry => Boolean(entry));
	const bytes = Buffer.byteLength(
		content.slice(0, content.lastIndexOf("\n") + 1),
	);
	let maxSeq = 0;
	for (const entry of entries) maxSeq = Math.max(maxSeq, entry.seq);
	changeLogCursors.set(logPath, { bytes, maxSeq });
	return entries;
}

export function readProjectChanges(cwd: string): ProjectChangeEntry[] {
	const logPath = getProjectChangeLogPath(cwd);
	try {
		return parseChangeLog(logPath, fs.readFileSync(logPath, "utf-8"));
	} catch {
		return [];
	}
}

/**
 * Async twin of `readProjectChanges` (#1162). `fs.promises.readFile` — unlike
 * the sync `readFileSync` above — YIELDS to the event loop, which is what lets
 * a caller bound it with a `Promise.race` timeout: a `setTimeout` can never
 * preempt a synchronous blocking read (the thread doesn't return to the event
 * loop until the OS does), so a bounded read on the session_start hot path
 * requires the async form. Same parse/error-swallow semantics as the sync
 * version — a missing/corrupt log is the normal cold-start case, not a
 * caller-visible error.
 */
async function readProjectChangesAsync(
	cwd: string,
): Promise<ProjectChangeEntry[]> {
	const logPath = getProjectChangeLogPath(cwd);
	try {
		return parseChangeLog(
			logPath,
			await fs.promises.readFile(logPath, "utf-8"),
		);
	} catch {
		return [];
	}
}

export function readChangesSince(
	cwd: string,
	seq: number,
	maxEntries = 200,
): ProjectChangeEntry[] {
	const limit = Math.max(1, maxEntries);
	return readProjectChanges(cwd)
		.filter((entry) => entry.seq > seq)
		.sort((a, b) => a.seq - b.seq)
		.slice(-limit);
}

export interface ProjectSequenceIndex {
	projectSeq: number;
	fileSeqByPath: Map<string, number>;
	/** #3511 review round 2: the log entries this read folded. */
	logEntries?: number;
	/**
	 * #3511 review round 2 (R2-F1): the 1-based position of the log's last
	 * `unlocked` entry, 0 when there is none. A snapshot whose runtime folded
	 * fewer entries (`ProjectSnapshot.logEntries`) may have missed it, even at
	 * the log's max seq, so it is not fresh.
	 */
	unlockedThrough?: number;
}

/**
 * A snapshot-embedded sequence index used to BOUND the replay (#1019). It is
 * the derived `{ projectSeq, fileSeqByPath }` as of `sinceSeq` (the snapshot's
 * own `seq`), so `readLatestProjectSequence` can fold only the log entries with
 * `seq > sinceSeq` on top of it instead of replaying the entire append-only
 * log. Keys in `fileSeqByPath` are ALREADY in `normalizeMapKey(path.resolve())`
 * form (they come straight from the runtime's `_fileSeq`, produced by the exact
 * same normalization the full replay uses), so the partial path does NOT
 * re-normalize them — that is the whole point: the per-entry
 * `normalizeMapKey` calls `realpathSync.native()` (one filesystem syscall per
 * historical entry), and skipping the O(entire-log) history is what turns the
 * dominant session-start cost into O(changes-since-snapshot).
 */
export interface ProjectSequenceBase {
	projectSeq: number;
	fileSeqByPath: Iterable<readonly [string, number]>;
	/** The snapshot's `seq`: entries at or below this are covered by the base. */
	sinceSeq: number;
	/** The log entries the snapshot's runtime folded (#3511 review round 2). */
	logEntries?: number;
}

// Test-observable count of the EXPENSIVE per-entry folds (each one does a
// `path.resolve` + `normalizeMapKey`/`realpathSync.native` syscall). Lets the
// #1019 equivalence tests prove the partial path folds strictly FEWER entries
// than the full replay for the same log — i.e. that the bound actually holds —
// without a brittle spy on the path helpers.
let _sequenceFoldCountForTests = 0;
export function getSequenceFoldCountForTests(): number {
	return _sequenceFoldCountForTests;
}
export function resetSequenceFoldCountForTests(): void {
	_sequenceFoldCountForTests = 0;
}

function foldEntry(
	entry: ProjectChangeEntry,
	fileSeqByPath: Map<string, number>,
): void {
	_sequenceFoldCountForTests++;
	const key = normalizeMapKey(path.resolve(entry.filePath));
	fileSeqByPath.set(key, Math.max(fileSeqByPath.get(key) ?? 0, entry.fileSeq));
}

function fullReplay(entries: ProjectChangeEntry[]): ProjectSequenceIndex {
	let projectSeq = 0;
	const fileSeqByPath = new Map<string, number>();
	for (const entry of entries) {
		projectSeq = Math.max(projectSeq, entry.seq);
		foldEntry(entry, fileSeqByPath);
	}
	return { projectSeq, fileSeqByPath };
}

/**
 * Attempt the bounded partial replay: hydrate `base` (pre-normalized keys, no
 * `realpath` cost) and fold ONLY entries with `seq > base.sinceSeq`. Returns
 * `null` — signalling the caller to fall back to a full replay — whenever the
 * base cannot be trusted to be byte-identical to a full replay:
 *
 *  - `base.sinceSeq` is AHEAD of the log's max seq (the log was truncated /
 *    rotated below the snapshot, or the snapshot seq is simply ahead). Serving
 *    the base would over-report the seq; the full replay reflects the real log.
 *
 * The result is provably equal to a full replay under the append-only,
 * single-writer invariant (`base` == fold of the log up to `sinceSeq`): every
 * historical file's seq is already in `base`, and folding the strictly-newer
 * entries with the SAME `Math.max` the full replay uses reproduces the max over
 * the whole log for both `projectSeq` and each file. `Math.max` makes the fold
 * order-independent, so gaps / out-of-order entries are handled exactly as the
 * full replay handles them.
 */
function partialReplay(
	entries: ProjectChangeEntry[],
	base: ProjectSequenceBase,
): ProjectSequenceIndex | null {
	let logMaxSeq = 0;
	for (const entry of entries) {
		if (entry.seq > logMaxSeq) logMaxSeq = entry.seq;
	}
	// Snapshot ahead of / newer than the log (truncation, rotation, or a stale
	// log): the base describes a state the log no longer backs — never serve it.
	if (base.sinceSeq > logMaxSeq) return null;

	const fileSeqByPath = new Map<string, number>(base.fileSeqByPath);
	let projectSeq = Math.max(0, base.projectSeq);
	for (const entry of entries) {
		if (entry.seq <= base.sinceSeq) continue; // covered by the base
		projectSeq = Math.max(projectSeq, entry.seq);
		foldEntry(entry, fileSeqByPath);
	}
	return { projectSeq, fileSeqByPath };
}

/**
 * Compute the current `{ projectSeq, fileSeqByPath }` from the append-only
 * change log. With no `base`, this is a full replay of the entire log. With a
 * snapshot-embedded `base` (#1019), it folds only entries newer than
 * `base.sinceSeq` on top of the base — O(changes since snapshot) instead of
 * O(entire log) — and transparently falls back to a full replay when the base
 * cannot be trusted (see `partialReplay`). A legacy/stale/missing snapshot
 * simply passes no `base` (or one the guard rejects), so correctness never
 * depends on the optimization being applicable.
 */
export function readLatestProjectSequence(
	cwd: string,
	base?: ProjectSequenceBase,
): ProjectSequenceIndex {
	return replay(readProjectChanges(cwd), base);
}

/**
 * The bounded replay when `base` can be trusted, else the full one, plus the
 * fold point and the last unlocked entry (#3511 review round 2). An unlocked
 * entry after the base's fold point may share a seq at or below `sinceSeq`
 * that the base never folded, so that base is not trusted.
 */
function replay(
	entries: ProjectChangeEntry[],
	base: ProjectSequenceBase | undefined,
): ProjectSequenceIndex {
	let unlockedThrough = 0;
	entries.forEach((entry, index) => {
		if (entry.unlocked) unlockedThrough = index + 1;
	});
	const index =
		(base &&
			unlockedThrough <= (base.logEntries ?? 0) &&
			partialReplay(entries, base)) ||
		fullReplay(entries);
	return { ...index, logEntries: entries.length, unlockedThrough };
}

/**
 * Async twin of `readLatestProjectSequence` (#1162) — same fold logic, but
 * reads the log via `readProjectChangesAsync` so a caller can bound the wait
 * with a `Promise.race` timeout (see that function's doc comment for why the
 * sync form can't be bounded at all).
 */
export async function readLatestProjectSequenceAsync(
	cwd: string,
	base?: ProjectSequenceBase,
): Promise<ProjectSequenceIndex> {
	return replay(await readProjectChangesAsync(cwd), base);
}

export function appendProjectChange(
	cwd: string,
	entry: ProjectChangeEntry,
): void {
	const logPath = getProjectChangeLogPath(cwd);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function readChangeLogMaxSeq(logPath: string): number {
	let fd: number;
	try {
		fd = fs.openSync(logPath, "r");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw err;
	}
	try {
		const cursor = changeLogCursors.get(logPath) ?? { bytes: 0, maxSeq: 0 };
		const size = fs.fstatSync(fd).size;
		if (size > cursor.bytes) {
			const tail = Buffer.alloc(size - cursor.bytes);
			const read = fs.readSync(fd, tail, 0, tail.length, cursor.bytes);
			// A line still being written by an unlocked writer is read next time.
			const complete = tail.subarray(0, read).lastIndexOf(0x0a) + 1;
			for (const line of tail
				.subarray(0, complete)
				.toString("utf-8")
				.split("\n")) {
				const entry = line.trim() ? parseChangeLine(line) : undefined;
				if (entry && entry.seq > cursor.maxSeq) cursor.maxSeq = entry.seq;
			}
			cursor.bytes += complete;
		}
		changeLogCursors.set(logPath, cursor);
		return cursor.maxSeq;
	} finally {
		fs.closeSync(fd);
	}
}

// Held for one incremental read and one append line: far inside the lease.
const CHANGE_LOG_LOCK = { staleMs: 5_000, waitMs: 500 };

/**
 * #3511: append one entry whose seq is allocated from the shared log, so two
 * processes never log the same seq. `build` receives the log's max seq and
 * returns the entry to append; both run under the change-log lock. When the
 * lock stays held past its wait (or fails), the entry is still appended,
 * unlocked and tagged `unlocked` (review round 2), and the degradation is
 * recorded.
 */
export function appendProjectChangeAllocated(
	cwd: string,
	build: (logMaxSeq: number) => ProjectChangeEntry,
): void {
	const logPath = getProjectChangeLogPath(cwd);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const append = (locked: boolean) => {
		const entry = build(readChangeLogMaxSeq(logPath));
		const line = locked ? entry : { ...entry, unlocked: true as const };
		fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf-8");
	};
	const result = withGenerationLockSync(
		`${logPath}.locks`,
		CHANGE_LOG_LOCK,
		() => append(true),
	);
	if (result.held) return;
	const code = (result.cause as NodeJS.ErrnoException | undefined)?.code;
	incrementDegradationCount({
		kind: "change-log-lock-unavailable",
		subject: logPath,
		reason: `appended unlocked: ${code ? `lock failed (${code})` : "lock wait ran out"}`,
	});
	append(false);
}
