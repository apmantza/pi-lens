import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeFileAtomic } from "./atomic-write.js";
import { getProjectDataDir } from "./file-utils.js";
import { incrementDegradationCount } from "./degradation-ledger.js";
import { readJsonCache } from "./json-cache-read.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { fingerprintProjectSnapshotJson } from "./project-snapshot-fingerprint.js";
import type {
	ProjectSnapshotPersistWorkerRequest,
	ProjectSnapshotPersistWorkerResult,
} from "./project-snapshot-persist-worker.js";
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

/**
 * The derived project-changes sequence index as of `ProjectSnapshot.seq`
 * (#1019). Persisting it lets session-start BOUND the change-log replay: hydrate
 * this (O(files)) then fold only entries with `seq > snapshot.seq`
 * (O(changes-since-snapshot)) instead of replaying the entire append-only log.
 * `projectSeq` is invariably `=== snapshot.seq` (both come from the same
 * `runtime.projectSeq` moment); `fileSeqByPath` uses the same
 * `normalizeMapKey(path.resolve())` keys as the change-log replay, so no
 * re-normalization (and no per-key `realpath` syscall) is needed on hydrate.
 */
export interface SnapshotSequenceIndex {
	projectSeq: number;
	fileSeqByPath: Array<[filePath: string, fileSeq: number]>;
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
	sequenceIndex?: SnapshotSequenceIndex;
	wordIndex?: SerializedWordIndex;
	projectRulesScan?: RuleScanResult;
	startupScan?: StartupScanContext;
	languageProfile?: ProjectLanguageProfile;
	conventions?: ProjectConventions;
}

function parseSequenceIndex(value: unknown): SnapshotSequenceIndex | undefined {
	if (!value || typeof value !== "object") return undefined;
	const index = value as Partial<SnapshotSequenceIndex>;
	if (typeof index.projectSeq !== "number") return undefined;
	if (!Array.isArray(index.fileSeqByPath)) return undefined;
	const fileSeqByPath = index.fileSeqByPath.filter(
		(entry): entry is [string, number] =>
			Array.isArray(entry) &&
			typeof entry[0] === "string" &&
			typeof entry[1] === "number",
	);
	return { projectSeq: index.projectSeq, fileSeqByPath };
}

// #958 item 2: the canonical snapshot body is now streamed gzip
// (`project-snapshot.json.gz`), written by a worker thread off the save path
// (see the persist plumbing below). The previous uncompressed
// `project-snapshot.json` remains readable for ONE compatibility release so an
// upgrading user doesn't lose their snapshot — see loadSnapshotBody's legacy
// fallback. gzip measured 5-10x on top of the #957 compaction win (the
// review-graph's own measurement was 60MB → 1.4MB).
export function getProjectSnapshotPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "project-snapshot.json.gz");
}

/**
 * Pre-#958 uncompressed body path. Read as a one-release fallback when no
 * `.json.gz` is present; deleted whenever a fresh gz body is promoted so the
 * two never coexist.
 */
export function getProjectSnapshotLegacyPath(cwd: string): string {
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
		sequenceIndex: parseSequenceIndex(snapshot.sequenceIndex),
		wordIndex: snapshot.wordIndex,
		projectRulesScan: snapshot.projectRulesScan,
		startupScan: snapshot.startupScan,
		languageProfile: snapshot.languageProfile,
		conventions: snapshot.conventions,
	};
}

export interface ProjectSnapshotMeta {
	timestamp: string;
	version: number;
	seq: number;
	/** SHA-256 of the snapshot body with volatile `generatedAt` omitted (#1997). */
	fingerprint?: string;
	/**
	 * #2008: on-disk byte length of the gz body at the last successful persist.
	 * The dedupe skip decision compares it against a live stat so a torn or
	 * truncated gzip under an intact meta cannot keep winning unchanged-skip.
	 * Absent on legacy metas → dedupe is withheld (always publish) until the
	 * next successful write populates it.
	 */
	gzBytes?: number;
	/**
	 * The derived sequence index as of `seq` (#1019), MIRRORED here from the
	 * snapshot body so session-start can bound the change-log replay WITHOUT
	 * parsing the (40-112MB) body — which would forfeit the #947 skip-stale
	 * optimization. Absent on legacy metas (pre-#1019) → callers full-replay.
	 */
	sequenceIndex?: SnapshotSequenceIndex;
}

function parseSnapshotMeta(value: unknown): ProjectSnapshotMeta | null {
	if (!value || typeof value !== "object") return null;
	const meta = value as Partial<ProjectSnapshotMeta>;
	if (typeof meta.version !== "number") return null;
	if (typeof meta.seq !== "number") return null;
	return {
		timestamp: typeof meta.timestamp === "string" ? meta.timestamp : "",
		version: meta.version,
		seq: meta.seq,
		fingerprint:
			typeof meta.fingerprint === "string" &&
			/^[a-f0-9]{64}$/.test(meta.fingerprint)
				? meta.fingerprint
				: undefined,
		gzBytes:
			typeof meta.gzBytes === "number" &&
			Number.isInteger(meta.gzBytes) &&
			meta.gzBytes > 0
				? meta.gzBytes
				: undefined,
		sequenceIndex: parseSequenceIndex(meta.sequenceIndex),
	};
}

/**
 * Read the tiny meta sidecar (`project-snapshot.meta.json`) WITHOUT parsing
 * the (potentially 40-112MB) snapshot body. Written on every save; absent on
 * legacy installs — callers must treat a `null` return as "no opinion" and
 * fall through to parsing the body. #947.
 */
export function readProjectSnapshotMeta(
	cwd: string,
): ProjectSnapshotMeta | null {
	const meta = readJsonCache<ProjectSnapshotMeta>(
		getProjectSnapshotMetaPath(cwd),
		(parsed) => parseSnapshotMeta(parsed) ?? undefined,
	);
	return meta ?? null;
}

/**
 * Cheap staleness verdict from the meta sidecar alone. When this returns
 * true, the snapshot body CANNOT be fresh (isProjectSnapshotFresh would
 * reject it on the same two fields), so the expensive body parse can be
 * skipped entirely. #947.
 */
export function isProjectSnapshotMetaStale(
	meta: ProjectSnapshotMeta,
	currentProjectSeq: number,
): boolean {
	return (
		meta.version !== PROJECT_SNAPSHOT_VERSION || meta.seq !== currentProjectSeq
	);
}

/**
 * In-process parse cache for the snapshot body, keyed by file path and
 * validated by mtime+size. The body is large (40-112MB observed) and several
 * session-start/background consumers parse it seconds after we ourselves
 * wrote it — `saveRuntimeProjectSnapshot` alone re-parsed the file it had
 * just written 2-3x per session (~300-600ms of event-loop blocks). A hit
 * returns the already-parsed object; any external write changes the mtime
 * and forces a re-parse. #947. This tier serves READER processes (module_report,
 * mcp/analyze) that never write; the writer process's read-your-writes is
 * served by the authoritative map below.
 */
interface SnapshotParseCacheEntry {
	mtimeMs: number;
	/**
	 * On-disk file size in bytes at cache time. FAT/exFAT round `mtime` to a 2s
	 * bucket, so two writes inside the same bucket can report an IDENTICAL
	 * `mtimeMs` even though the body changed — mtime alone would then serve a
	 * stale cached parse for a file that was, in fact, just rewritten. `size`
	 * is a free, defensive tiebreaker: a same-bucket rewrite that also keeps
	 * the exact same byte length still slips through, but that residual case is
	 * the same fail-open/self-healing posture as the rest of this cache. NOTE
	 * (#958): for the gz body this is the COMPRESSED file size; the
	 * cache-eligibility gate below uses the UNCOMPRESSED byte length instead,
	 * because that is what actually bounds resident heap.
	 */
	size: number;
	snapshot: ProjectSnapshot | null;
}
const SNAPSHOT_PARSE_CACHE_MAX = 4;
// #957 review: the cache exists to avoid re-parsing NORMAL snapshots within a
// session. A 112MB-class body parses to hundreds of MB of heap — pinning that
// for process lifetime inverts the win, so oversized bodies are simply never
// cached (they re-parse per read, exactly the pre-#947 behavior). Measured
// against the UNCOMPRESSED body size, never the (much smaller) gz file size.
const SNAPSHOT_PARSE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const snapshotParseCache = new Map<string, SnapshotParseCacheEntry>();

function withoutWordIndex(
	snapshot: ProjectSnapshot | null,
): ProjectSnapshot | null {
	if (!snapshot?.wordIndex) return snapshot;
	const { wordIndex: _releasedPostings, ...stripped } = snapshot;
	return stripped;
}

function cacheParsedSnapshot(
	snapshotPath: string,
	entry: SnapshotParseCacheEntry,
): void {
	// Refresh recency (Map preserves insertion order).
	snapshotParseCache.delete(snapshotPath);
	snapshotParseCache.set(snapshotPath, entry);
	while (snapshotParseCache.size > SNAPSHOT_PARSE_CACHE_MAX) {
		const oldest = snapshotParseCache.keys().next().value;
		if (oldest === undefined) break;
		snapshotParseCache.delete(oldest);
	}
}

/**
 * Authoritative in-process "latest write" for a snapshot, keyed by canonical
 * cwd (#958 item 2). The body is now written by a worker thread AFTER
 * `saveProjectSnapshot` returns, so between a save and the worker's promotion
 * the on-disk gz still holds the PREVIOUS generation. Reading disk in that
 * window would serve stale data to the merge-write callers
 * (`saveRuntimeProjectSnapshot`, word-index, reverse-deps) that do
 * load→mutate→save and would silently drop each other's fields. Because every
 * write in a process funnels through `saveProjectSnapshot` — and each process
 * runs in its own worktree cwd, so there is effectively one writer per snapshot
 * — the in-memory object we just handed the worker IS the authoritative truth
 * for this process. `loadProjectSnapshot` consults it first and only falls
 * through to disk when the on-disk file has an mtime STRICTLY NEWER than the
 * one we last observed for our own write (an external writer we should honor).
 */
interface AuthoritativeSnapshotEntry {
	snapshot: ProjectSnapshot;
	/**
	 * The mtime of the body file as we last wrote/observed it. Set to the
	 * pre-write file's mtime at save time (or -Infinity when no file exists
	 * yet), then updated to the promoted file's mtime once the worker (or the
	 * sync fallback) lands the write. Load prefers this entry while the on-disk
	 * mtime is `<=` this value.
	 */
	knownMtime: number;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}
const authoritativeSnapshots = new Map<string, AuthoritativeSnapshotEntry>();
const PROJECT_SNAPSHOT_MAX_WARM_ROOTS = 8;
const PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT = 20 * 60_000;

function projectSnapshotIdleEvictMs(): number {
	const value = Number.parseInt(
		process.env.PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS ?? "",
		10,
	);
	return Number.isSafeInteger(value) && value > 0
		? value
		: PROJECT_SNAPSHOT_IDLE_EVICT_MS_DEFAULT;
}

function clearAuthoritativeSnapshotTimer(
	entry: AuthoritativeSnapshotEntry,
): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = undefined;
}

function deleteAuthoritativeSnapshot(key: string): void {
	const entry = authoritativeSnapshots.get(key);
	if (entry) clearAuthoritativeSnapshotTimer(entry);
	authoritativeSnapshots.delete(key);
}

function scheduleAuthoritativeSnapshotEviction(
	key: string,
	entry: AuthoritativeSnapshotEntry,
): void {
	clearAuthoritativeSnapshotTimer(entry);
	const generation = entry.lastUsedAt;
	entry.idleTimer = setTimeout(() => {
		entry.idleTimer = undefined;
		if (
			authoritativeSnapshots.get(key) !== entry ||
			entry.lastUsedAt !== generation
		)
			return;
		deleteAuthoritativeSnapshot(key);
	}, projectSnapshotIdleEvictMs());
	entry.idleTimer.unref?.();
}

function touchAuthoritativeSnapshot(
	key: string,
	entry: AuthoritativeSnapshotEntry,
): void {
	entry.lastUsedAt = Date.now();
	scheduleAuthoritativeSnapshotEviction(key, entry);
}

function enforceAuthoritativeSnapshotCap(): void {
	while (authoritativeSnapshots.size > PROJECT_SNAPSHOT_MAX_WARM_ROOTS) {
		const victim = [...authoritativeSnapshots.entries()].sort(
			([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
		)[0];
		if (!victim) return;
		clearAuthoritativeSnapshotTimer(victim[1]);
		deleteAuthoritativeSnapshot(victim[0]);
	}
}

/** Test-only cache keys, in LRU order from oldest to newest. */
export function _getAuthoritativeSnapshotCacheKeysForTests(): string[] {
	return [...authoritativeSnapshots.entries()]
		.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
		.map(([key]) => key);
}

/** Test hook: drop all cached parses + authoritative writes (per-worker isolation). */
export function _resetProjectSnapshotParseCacheForTests(): void {
	snapshotParseCache.clear();
	for (const entry of authoritativeSnapshots.values())
		clearAuthoritativeSnapshotTimer(entry);
	authoritativeSnapshots.clear();
}

/** Test hook: prove the parse-cache tier never owns serialized postings. */
export function _projectSnapshotParseCacheRetainsWordIndexForTests(): boolean {
	return [...snapshotParseCache.values()].some(
		(entry) => entry.snapshot?.wordIndex !== undefined,
	);
}

/** Resolve which body file is currently on disk: gz canonical, else legacy. */
function resolveSnapshotBodyPath(cwd: string): {
	path: string;
	gz: boolean;
	mtimeMs: number;
	size: number;
} | null {
	const gzPath = getProjectSnapshotPath(cwd);
	try {
		const stat = fs.statSync(gzPath);
		return { path: gzPath, gz: true, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		/* fall through to the legacy uncompressed body */
	}
	const legacyPath = getProjectSnapshotLegacyPath(cwd);
	try {
		const stat = fs.statSync(legacyPath);
		return {
			path: legacyPath,
			gz: false,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		};
	} catch {
		return null;
	}
}

/**
 * Read + parse the body off disk, transparently gunzipping the `.json.gz`
 * canonical form and falling back to the pre-#958 uncompressed `.json` body
 * for one compatibility release. Returns the parsed snapshot (or null on any
 * failure) plus the UNCOMPRESSED byte length, so the caller can apply the
 * heap-bounded cache gate against the real body size rather than the gz size.
 */
// Test-observable count of ACTUAL disk body reads (both gz and legacy), so the
// #947 meta-gate tests can assert "body parsed / not parsed" independently of
// the compression format — the pre-#958 tests keyed this off a readJsonCache
// spy, which the gz path (gunzip + JSON.parse) legitimately bypasses.
let _snapshotBodyReadCountForTests = 0;
export function getSnapshotBodyReadCountForTests(): number {
	return _snapshotBodyReadCountForTests;
}
export function resetSnapshotBodyReadCountForTests(): void {
	_snapshotBodyReadCountForTests = 0;
}

function readSnapshotBody(
	bodyPath: string,
	gz: boolean,
): {
	snapshot: ProjectSnapshot | null;
	rawBytes: number;
} {
	_snapshotBodyReadCountForTests++;
	if (!gz) {
		const snapshot =
			readJsonCache<ProjectSnapshot>(
				bodyPath,
				(parsed) => parseSnapshot(parsed) ?? undefined,
			) ?? null;
		let rawBytes = 0;
		try {
			rawBytes = fs.statSync(bodyPath).size;
		} catch {
			/* best-effort */
		}
		return { snapshot, rawBytes };
	}
	try {
		const json = gunzipSync(fs.readFileSync(bodyPath)).toString("utf-8");
		const snapshot = parseSnapshot(JSON.parse(json)) ?? null;
		return { snapshot, rawBytes: Buffer.byteLength(json) };
	} catch (err) {
		// Corrupt / truncated gz, or a parse failure: fail open exactly like
		// readJsonCache does — a null return rebuilds the snapshot. Log it so a
		// corrupt body is diagnosable rather than indistinguishable from "no
		// snapshot yet" (both return a null snapshot here).
		logLatency({
			type: "phase",
			phase: "project_snapshot_body_corrupt",
			filePath: bodyPath,
			durationMs: 0,
			metadata: { error: err instanceof Error ? err.message : String(err) },
		});
		return { snapshot: null, rawBytes: 0 };
	}
}

/**
 * Scan a JSON value starting at `start` (skipping any leading whitespace)
 * and return the index one past its end. Handles strings, objects, arrays,
 * and bare scalars (numbers/`true`/`false`/`null`) — correctly skipping
 * nested strings/braces/brackets (respecting `\"` escapes) WITHOUT ever
 * constructing a JS value for them. This is the primitive
 * `stripTopLevelJsonKeys` (#1785 F5) is built on: `JSON.parse` has no way to
 * skip a subtree's construction cost — a reviver only prunes the
 * already-built result — so avoiding a field's parse cost requires never
 * handing its text to `JSON.parse` in the first place.
 */
function skipJsonValue(text: string, start: number): number {
	let i = start;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	const ch = text[i];
	if (ch === '"') {
		i++;
		while (i < text.length) {
			if (text[i] === "\\") {
				i += 2;
				continue;
			}
			if (text[i] === '"') {
				i++;
				break;
			}
			i++;
		}
		return i;
	}
	if (ch === "{" || ch === "[") {
		const open = ch;
		const close = open === "{" ? "}" : "]";
		let depth = 0;
		let inString = false;
		for (; i < text.length; i++) {
			const c = text[i];
			if (inString) {
				if (c === "\\") {
					i++;
					continue;
				}
				if (c === '"') inString = false;
				continue;
			}
			if (c === '"') {
				inString = true;
				continue;
			}
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					i++;
					break;
				}
			}
		}
		return i;
	}
	// A bare scalar (number/true/false/null): scan to the next structural
	// character. Every snapshot value is one of the five JSON kinds above, so
	// this branch only ever fires for those scalars.
	while (i < text.length && !",}]".includes(text[i]!)) i++;
	return i;
}

/**
 * Reconstruct a JSON object literal with the given top-level keys removed,
 * without ever materializing their values as JS objects (#1785 F5). Used to
 * excise the expensive fields — `wordIndex`'s postings graph above all,
 * `files`/`symbols`/`reverseDeps` too — before `JSON.parse` ever sees them,
 * so a caller that only needs a few small top-level fields (`seq`,
 * `cachedExports`, `projectRulesScan`, …) doesn't pay to construct the
 * fields it's about to discard. Correctness relies only on the writer
 * (`JSON.stringify(snapshot)`, `clients/gzip-stage-write.ts`) never emitting
 * pretty-printed/indented output — compact `JSON.stringify` output is what
 * every persist path in this file produces.
 */
function stripTopLevelJsonKeys(
	text: string,
	keysToStrip: ReadonlySet<string>,
): string {
	const objStart = text.indexOf("{");
	if (objStart === -1) return text;
	let out = text.slice(0, objStart + 1);
	let i = objStart + 1;
	let wroteField = false;
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i]!)) i++;
		if (text[i] === "}" || i >= text.length) {
			out += text.slice(i);
			break;
		}
		if (text[i] === ",") {
			i++;
			continue;
		}
		const keyStart = i;
		const keyTextEnd = skipJsonValue(text, keyStart);
		let key: string;
		try {
			key = JSON.parse(text.slice(keyStart, keyTextEnd)) as string;
		} catch {
			// Malformed key text — bail out to the untouched original rather
			// than risk producing invalid JSON; the caller's own JSON.parse
			// on the result will then fail loudly instead of silently.
			return text;
		}
		let j = keyTextEnd;
		while (j < text.length && /\s/.test(text[j]!)) j++;
		// text[j] is ':' for a well-formed object.
		const valueStart = j + 1;
		const valueEnd = skipJsonValue(text, valueStart);
		if (!keysToStrip.has(key)) {
			out += (wroteField ? "," : "") + text.slice(keyStart, valueEnd);
			wroteField = true;
		}
		i = valueEnd;
	}
	return out;
}

/**
 * Test-only direct access to the raw-text stripper (#1785 F5). Unlike
 * asserting on `loadProjectSnapshotExportsAndRules`'s RETURN shape — which
 * only proves the output omits the heavy fields, not that their parse cost
 * was ever avoided (the function could strip nothing and still hand-pick 4
 * fields out of a fully-parsed object) — this lets a test inspect the
 * INTERMEDIATE text `JSON.parse` actually receives, which is the only way to
 * prove the expensive fields' text never reached `JSON.parse` at all.
 */
export function _stripTopLevelJsonKeysForTests(
	text: string,
	keysToStrip: readonly string[],
): string {
	return stripTopLevelJsonKeys(text, new Set(keysToStrip));
}

// A fixed, 4-entry, import-time constant — not per-session accumulating
// state, so it needs no session_start reset (counted in
// tests/support/session-state-registry.ts's SESSION_STATE_SYMBOL_COUNTS
// pin for "project-snapshot.ts", alongside the bounded digest hook below).
//
// Adding a key here? Add it to `NARROW_DIGEST_HEAVY_KEY_LITERALS` too (~40
// lines down) — it's a DELIBERATELY separate, independent list (#1785 F7: a
// digest that reads its own containsHeavyKey answer off THIS set can't
// detect this set failing/emptying, so it must not).
const HEAVY_SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
	"wordIndex",
	"files",
	"symbols",
	"reverseDeps",
]);

/** The subset of `ProjectSnapshot` the retroactive-hydration path needs. */
export interface ProjectSnapshotExportsAndRules {
	version: typeof PROJECT_SNAPSHOT_VERSION;
	seq: number;
	cachedExports: Array<[name: string, filePath: string]>;
	projectRulesScan?: RuleScanResult;
}

/**
 * Test-observable DIGEST of the text `parseExportsAndRulesOnly` hands to
 * `JSON.parse` — never the text itself. #1785 F6 (review round 4): an
 * earlier version of this hook retained the full narrowed text at module
 * scope, unconditionally, with no cap and no reset on the hot path — the
 * EXACT retention class the narrow loader exists to close, reintroduced by
 * its own observability hook (measured: 28.2MB retained on a production
 * body). `session-state-conformance.test.ts`'s registry didn't catch it
 * because `project-snapshot.ts` carries a file-level exemption written for
 * the bounded parse caches elsewhere in this file — this variable rode that
 * exemption instead of declaring its own bound. A length + a "does the text
 * still contain a heavy key" boolean is everything a test needs to prove the
 * strip ran, without ever holding the (potentially many-MB) text itself.
 */
interface NarrowParseDigest {
	length: number;
	containsHeavyKey: boolean;
}
// #1785 F7 (review round 5): a FIXED LITERAL list, independent of
// `HEAVY_SNAPSHOT_KEYS` — the digest below exists to detect a broken/emptied
// `HEAVY_SNAPSHOT_KEYS`, so deriving `containsHeavyKey` from that same
// constant makes the check vacuous by construction: empty the set and the
// stripper strips nothing AND `[...HEAVY_SNAPSHOT_KEYS].some(...)` iterates
// zero entries and reports `false` — the exact failure mode this hook exists
// to catch, silently passing. Verified: with the shared-constant version,
// emptying `HEAVY_SNAPSHOT_KEYS` left 38 tests green instead of red.
const NARROW_DIGEST_HEAVY_KEY_LITERALS = [
	"wordIndex",
	"files",
	"symbols",
	"reverseDeps",
] as const;

let _lastNarrowParseDigestForTests: NarrowParseDigest | undefined;
export function getLastNarrowParseDigestForTests():
	| NarrowParseDigest
	| undefined {
	return _lastNarrowParseDigestForTests;
}
export function resetLastNarrowParseDigestForTests(): void {
	_lastNarrowParseDigestForTests = undefined;
}

function parseExportsAndRulesOnly(
	json: string,
): ProjectSnapshotExportsAndRules | null {
	const narrowed = stripTopLevelJsonKeys(json, HEAVY_SNAPSHOT_KEYS);
	_lastNarrowParseDigestForTests = {
		length: narrowed.length,
		containsHeavyKey: NARROW_DIGEST_HEAVY_KEY_LITERALS.some((key) =>
			narrowed.includes(`"${key}":`),
		),
	};
	const parsed = JSON.parse(narrowed) as Partial<ProjectSnapshot>;
	if (parsed.version !== PROJECT_SNAPSHOT_VERSION) return null;
	if (typeof parsed.seq !== "number") return null;
	if (!Array.isArray(parsed.cachedExports)) return null;
	return {
		version: PROJECT_SNAPSHOT_VERSION,
		seq: parsed.seq,
		cachedExports: parsed.cachedExports.filter(
			(entry): entry is [string, string] =>
				Array.isArray(entry) &&
				typeof entry[0] === "string" &&
				typeof entry[1] === "string",
		),
		projectRulesScan: parsed.projectRulesScan,
	};
}

function readSnapshotExportsAndRulesBody(
	bodyPath: string,
	gz: boolean,
): ProjectSnapshotExportsAndRules | null {
	try {
		const json = gz
			? gunzipSync(fs.readFileSync(bodyPath)).toString("utf-8")
			: fs.readFileSync(bodyPath, "utf-8");
		return parseExportsAndRulesOnly(json);
	} catch (err) {
		logLatency({
			type: "phase",
			phase: "project_snapshot_body_corrupt",
			filePath: bodyPath,
			durationMs: 0,
			metadata: {
				error: err instanceof Error ? err.message : String(err),
				narrow: true,
			},
		});
		return null;
	}
}

/**
 * #1785 F5: a narrow counterpart to `loadProjectSnapshot` for callers that
 * only need `seq`/`version`/`cachedExports`/`projectRulesScan` — critically,
 * NOT `wordIndex`, `files`, `symbols`, or `reverseDeps`. The full
 * `loadProjectSnapshot` (even `loadProjectSnapshotWithoutWordIndex`, which
 * only strips the RETAINED copy AFTER a full parse) pays `gunzip` +
 * `JSON.parse` for the ENTIRE body regardless — dominated by `wordIndex`'s
 * postings graph (measured: +200ms warm / +700ms cold on a 29MB body,
 * 209-278ms on this repo's own 16.7MB snapshot). This function excises the
 * heavy fields from the raw text BEFORE parsing (`stripTopLevelJsonKeys`),
 * so their construction cost is never paid at all; the remaining cost is
 * dominated by `cachedExports` (typically a small array), not the postings.
 *
 * Consults the same in-process authoritative-write cache
 * `loadProjectSnapshotInternal` does, for the same read-your-own-write
 * reason — a save's in-memory object is cheap to narrow (no parse needed at
 * all) and must win over a possibly-stale on-disk body exactly like the full
 * loader.
 */
export function loadProjectSnapshotExportsAndRules(
	cwd: string,
): ProjectSnapshotExportsAndRules | null {
	const key = normalizeMapKey(cwd);
	const body = resolveSnapshotBodyPath(cwd);
	const authoritative = authoritativeSnapshots.get(key);
	if (authoritative) {
		const diskMtime = body ? body.mtimeMs : Number.NEGATIVE_INFINITY;
		if (diskMtime <= authoritative.knownMtime) {
			const { version, seq, cachedExports, projectRulesScan } =
				authoritative.snapshot;
			return { version, seq, cachedExports, projectRulesScan };
		}
	}
	if (!body) return null;
	return readSnapshotExportsAndRulesBody(body.path, body.gz);
}

function loadProjectSnapshotInternal(
	cwd: string,
	requireWordIndex: boolean,
): ProjectSnapshot | null {
	const key = normalizeMapKey(cwd);
	const body = resolveSnapshotBodyPath(cwd);
	// Authoritative in-process write wins while our own (possibly still
	// in-flight) write has not been superseded on disk by a newer external
	// mtime. `body === null` means nothing is on disk yet — our just-scheduled
	// write is the only truth, so serve it.
	const authoritative = authoritativeSnapshots.get(key);
	if (authoritative) {
		const diskMtime = body ? body.mtimeMs : Number.NEGATIVE_INFINITY;
		if (diskMtime <= authoritative.knownMtime) {
			touchAuthoritativeSnapshot(key, authoritative);
			return authoritative.snapshot;
		}
		// An external writer moved past our write — honor disk and stop
		// serving the now-stale in-memory object.
		deleteAuthoritativeSnapshot(key);
	}
	if (!body) {
		snapshotParseCache.delete(getProjectSnapshotPath(cwd));
		return null;
	}
	const cacheKey = body.path;
	const cached = snapshotParseCache.get(cacheKey);
	// Both mtime AND size must match (see the `size` field doc on
	// SnapshotParseCacheEntry for why: coarse FAT/exFAT mtime resolution can
	// otherwise alias a just-rewritten file onto a stale cache entry).
	if (cached && cached.mtimeMs === body.mtimeMs && cached.size === body.size) {
		if (!requireWordIndex || !cached.snapshot || cached.snapshot.wordIndex) {
			return cached.snapshot;
		}
	}
	const { snapshot, rawBytes } = readSnapshotBody(body.path, body.gz);
	// Serialized postings expand into a much larger object graph. Cache only a
	// shallow postings-stripped body: metadata/report consumers stay warm while
	// the live warm WordIndex remains the sole retained postings graph (#1370).
	const cacheSnapshot = withoutWordIndex(snapshot);
	if (
		rawBytes > 0 &&
		(rawBytes <= SNAPSHOT_PARSE_CACHE_MAX_BYTES || snapshot?.wordIndex)
	) {
		cacheParsedSnapshot(cacheKey, {
			mtimeMs: body.mtimeMs,
			size: body.size,
			snapshot: cacheSnapshot,
		});
	} else {
		snapshotParseCache.delete(cacheKey);
	}
	return snapshot;
}

/** Load the canonical body, including serialized postings when present. */
export function loadProjectSnapshot(cwd: string): ProjectSnapshot | null {
	return loadProjectSnapshotInternal(cwd, true);
}

/**
 * Load snapshot metadata without retaining or re-reading serialized postings.
 * After publication this is served by the postings-stripped parse cache.
 */
export function loadProjectSnapshotWithoutWordIndex(
	cwd: string,
): ProjectSnapshot | null {
	return loadProjectSnapshotInternal(cwd, false);
}

// --- Worker-thread body persist (gzip off the save path, #958 item 2) --------
//
// Mirrors clients/review-graph/persist-worker.ts's parent plumbing: a monotonic
// per-cwd `generation`, a worker that stringifies+gzips a per-generation stage
// file, and generation-gated promotion (rename stage → canonical) so a slow
// write for generation N can never clobber a newer generation N+1 already on
// disk. When the worker is unavailable/dies, the pending body falls back to a
// synchronous main-thread gzip write (the degraded path only — the #950 review
// measured a naïve sync gzip as the DEFAULT save path regressing host memory by
// +656MB, which is exactly why the worker exists).

interface PendingSnapshotBody {
	key: string;
	cwd: string;
	gzPath: string;
	legacyPath: string;
	stagePath: string;
	snapshot: ProjectSnapshot;
	generation: number;
	durablePersist?: SnapshotPersistRecord;
	dedupeFingerprints: string[];
}

interface SnapshotPersistRecord {
	seq: number;
	fingerprint: string;
	generatedAt: string;
	generation: number;
	rawBytes?: number;
	gzBytes?: number;
}

interface SnapshotPersistStats {
	rawBytes: number;
	gzBytes: number;
	serializeMs: number;
	writeMs: number;
	offloaded: boolean;
}
const _snapshotGenerationStates = new Map<
	string,
	{ generation: number; seq: number }
>();
const _successfulSnapshotPersists = new Map<string, SnapshotPersistRecord>();
const _failedSnapshotPersists = new Map<
	string,
	{ seq: number; generation: number }
>();
const _activeSnapshotPersists = new Map<string, PendingSnapshotBody>();
const _queuedSnapshotPersists = new Map<string, PendingSnapshotBody>();
const _snapshotWorkerRequests = new Map<number, PendingSnapshotBody>();
let _snapshotPersistWorker: Worker | undefined;
let _snapshotWorkerRequestId = 0;
let _snapshotWorkerDisabled = false;
let _snapshotGenerationGateEnabledForTests = true;
let _snapshotPromotionSeamForTests: (() => Promise<void>) | undefined;
let _lastSnapshotPersistErrorForTests: string | undefined;
let _snapshotExiting = false;
let _snapshotWorkerBodyWritesForTests = 0;

function snapshotWorkerEnabled(): boolean {
	// The synchronous fallback writer is a legitimate degraded mode (hosts that
	// can't spawn a worker); tests also force it so a save→load is fully
	// synchronous. Production defaults to the worker.
	const raw = process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	return !(raw === "1" || raw === "true");
}

function pendingSnapshotIsCurrent(pending: PendingSnapshotBody): boolean {
	return (
		!_snapshotGenerationGateEnabledForTests ||
		_snapshotGenerationStates.get(pending.key)?.generation ===
			pending.generation
	);
}

function rememberSuccessfulSnapshotPersist(
	key: string,
	record: SnapshotPersistRecord,
): void {
	_successfulSnapshotPersists.delete(key);
	_successfulSnapshotPersists.set(key, record);
	while (_successfulSnapshotPersists.size > PROJECT_SNAPSHOT_MAX_WARM_ROOTS) {
		const oldest = _successfulSnapshotPersists.keys().next().value;
		if (oldest === undefined) break;
		_successfulSnapshotPersists.delete(oldest);
	}
}

/**
 * #2008 verdict on the durable meta+body pair. Absent from the baselines when
 * there is no evidence to judge (no meta fingerprint or no body on disk).
 * Anything other than `"ok"` means a same-fingerprint skip must NOT be
 * trusted: the persisted body may be torn under an intact meta.
 */
type SnapshotBodyIntegrity = "ok" | "legacy-meta" | "size-mismatch";

interface SnapshotPersistBaselines {
	durable?: SnapshotPersistRecord;
	fingerprints: string[];
	integrity?: SnapshotBodyIntegrity;
}

function assessSnapshotBodyIntegrity(
	meta: ProjectSnapshotMeta,
	body: { gz: boolean; size: number },
): {
	outcome: SnapshotBodyIntegrity;
	expectedGzBytes?: number;
	actualBytes: number;
} {
	if (meta.gzBytes === undefined) {
		// Legacy meta (pre-#2008): nothing to compare against, so the evidence is
		// untrusted until the next successful persist populates gzBytes.
		return { outcome: "legacy-meta", actualBytes: body.size };
	}
	if (!body.gz || body.size !== meta.gzBytes) {
		return {
			outcome: "size-mismatch",
			expectedGzBytes: meta.gzBytes,
			actualBytes: body.size,
		};
	}
	return {
		outcome: "ok",
		expectedGzBytes: meta.gzBytes,
		actualBytes: body.size,
	};
}

/**
 * Bounded observability for #2008: the degradation ledger keeps one entry per
 * corrupted subject with the exact detection count for the session; every
 * detection also emits one `project_snapshot_body_integrity` latency row
 * naming expected vs actual bytes, so an operator can confirm both the
 * detection and the forced republish from logs alone.
 */
function noteSnapshotBodyIntegrityWithheld(args: {
	gzPath: string;
	verdict: Exclude<SnapshotBodyIntegrity, "ok">;
	seq?: number;
	expectedGzBytes?: number;
	actualBytes: number;
}): void {
	incrementDegradationCount({
		kind: "snapshot-integrity",
		subject: args.gzPath,
		reason: args.verdict,
	});
	logLatency({
		type: "phase",
		phase: "project_snapshot_body_integrity",
		filePath: args.gzPath,
		durationMs: 0,
		metadata: {
			outcome: "dedupe_withheld",
			reason: args.verdict,
			...(args.seq !== undefined ? { seq: args.seq } : {}),
			...(args.expectedGzBytes === undefined
				? {}
				: { expectedGzBytes: args.expectedGzBytes }),
			actualBytes: args.actualBytes,
		},
	});
}

/** Log one row naming a skip that was refused because integrity regressed. */
function noteSnapshotSkipRefused(args: {
	gzPath: string;
	verdict: Exclude<SnapshotBodyIntegrity, "ok">;
	seq: number;
}): void {
	logLatency({
		type: "phase",
		phase: "project_snapshot_body_integrity",
		filePath: args.gzPath,
		durationMs: 0,
		metadata: {
			outcome: "skip_refused_rewrite",
			reason: args.verdict,
			seq: args.seq,
		},
	});
}

/**
 * PURE READ of the durable meta+body evidence for a snapshot key (#2008
 * refactor): it must never mutate {@link _successfulSnapshotPersists}. This
 * runs up to three times per persist — admission in saveProjectSnapshot, the
 * dispatch-time refresh, and the skip-honor re-read — including on results
 * whose fingerprints are only partially used, so the seeding write lives in
 * {@link seedSnapshotPersistBaselineFromDurable} and is called only by the
 * seam that owns the persist lifecycle (dispatchSnapshotPersist).
 */
function snapshotPersistBaselinesFor(
	cwd: string,
	key: string,
): SnapshotPersistBaselines {
	const local = _successfulSnapshotPersists.get(key);
	const meta = readProjectSnapshotMeta(cwd);
	const body = resolveSnapshotBodyPath(cwd);
	// No body means no dedupe evidence. This keeps same-seq deletion repair live.
	if (!meta?.fingerprint || !body) {
		if (!body) _successfulSnapshotPersists.delete(key);
		return { fingerprints: [] };
	}
	// #2008: a meta whose recorded gz size no longer matches the on-disk body
	// describes evidence we cannot trust — a truncated/torn gzip under an
	// intact meta used to win same-fingerprint dedupe forever, keeping the
	// corrupt body canonical until seq advanced. Withhold the fingerprints so
	// the pending save republishes (and rewrites) the body.
	const integrity = assessSnapshotBodyIntegrity(meta, body);
	if (integrity.outcome !== "ok") {
		noteSnapshotBodyIntegrityWithheld({
			gzPath: getProjectSnapshotPath(cwd),
			verdict: integrity.outcome,
			seq: meta.seq,
			expectedGzBytes: integrity.expectedGzBytes,
			actualBytes: integrity.actualBytes,
		});
		return { fingerprints: [] };
	}
	const durable: SnapshotPersistRecord = {
		seq: meta.seq,
		fingerprint: meta.fingerprint,
		generatedAt: meta.timestamp,
		generation: _snapshotGenerationStates.get(key)?.generation ?? 0,
		gzBytes: meta.gzBytes,
	};
	const fingerprints = [durable.fingerprint];
	// A sibling process may have advanced durable state from local A to B. An
	// unchanged replay of A is stale work and must not overwrite B. A third
	// semantic state C matches neither fingerprint and still publishes.
	if (local && local.fingerprint !== durable.fingerprint) {
		fingerprints.push(local.fingerprint);
	}
	return { durable, fingerprints, integrity: "ok" };
}

/**
 * Seed the in-process baseline for `key` from freshly-read durable state.
 * Deliberately separate from {@link snapshotPersistBaselinesFor} so the read
 * stays pure; called only at the dispatch seam where the persist lifecycle
 * begins.
 */
function seedSnapshotPersistBaselineFromDurable(
	key: string,
	durable: SnapshotPersistRecord | undefined,
): void {
	if (!durable || _successfulSnapshotPersists.has(key)) return;
	rememberSuccessfulSnapshotPersist(key, durable);
}

function writeProjectSnapshotMeta(
	metaPath: string,
	snapshot: ProjectSnapshot,
	bodyRecord?: Pick<
		SnapshotPersistRecord,
		"fingerprint" | "generatedAt" | "gzBytes"
	>,
): void {
	writeFileAtomic(
		metaPath,
		JSON.stringify({
			timestamp: bodyRecord?.generatedAt ?? snapshot.generatedAt,
			version: snapshot.version,
			seq: snapshot.seq,
			...(bodyRecord
				? {
						fingerprint: bodyRecord.fingerprint,
						...(bodyRecord.gzBytes === undefined
							? {}
							: { gzBytes: bodyRecord.gzBytes }),
					}
				: {}),
			...(snapshot.sequenceIndex
				? { sequenceIndex: snapshot.sequenceIndex }
				: {}),
		}),
		{ bestEffort: false },
	);
}

function recordSnapshotPersistFailure(
	pending: PendingSnapshotBody,
	error: string,
	bodyPersisted = false,
): void {
	// Honesty (#533): a failed async body write must be surfaced, never left to
	// masquerade as a saved snapshot. The meta gate is already self-healing (an
	// old body under a newer-seq meta is rejected on the body's own embedded
	// seq), and dropping the authoritative entry means the next load reflects
	// what is ACTUALLY on disk rather than the object we failed to persist.
	_lastSnapshotPersistErrorForTests = error;
	_failedSnapshotPersists.set(pending.key, {
		seq: pending.snapshot.seq,
		generation: pending.generation,
	});
	while (_failedSnapshotPersists.size > PROJECT_SNAPSHOT_MAX_WARM_ROOTS) {
		const oldest = _failedSnapshotPersists.keys().next().value;
		if (oldest === undefined) break;
		_failedSnapshotPersists.delete(oldest);
	}
	deleteAuthoritativeSnapshot(pending.key);
	logLatency({
		type: "phase",
		phase: "project_snapshot_persist_failed",
		filePath: pending.gzPath,
		durationMs: 0,
		metadata: {
			error,
			seq: pending.snapshot.seq,
			outcome: bodyPersisted ? "metadata_repair_required" : "failed",
			...(bodyPersisted ? { bodyPersisted: true } : {}),
		},
	});
	// #1333: the logLatency call above already carries this failure to
	// latency.log — the console.error was a duplicate RAW write into pi's frame.
}

function logSnapshotPersistSuccess(
	pending: PendingSnapshotBody,
	fingerprint: string,
	stats: SnapshotPersistStats,
): void {
	rememberSuccessfulSnapshotPersist(pending.key, {
		seq: pending.snapshot.seq,
		fingerprint,
		generatedAt: pending.snapshot.generatedAt,
		generation: pending.generation,
		rawBytes: stats.rawBytes,
		gzBytes: stats.gzBytes,
	});
	_failedSnapshotPersists.delete(pending.key);
	logLatency({
		type: "phase",
		phase: "project_snapshot_persist",
		filePath: pending.gzPath,
		durationMs: stats.serializeMs + stats.writeMs,
		metadata: { seq: pending.snapshot.seq, outcome: "executed", ...stats },
	});
}

function logSnapshotPersistDecision(args: {
	cwd: string;
	seq: number;
	fingerprint?: string;
	decision: "requested" | "coalesced" | "skipped_unchanged" | "retry";
	avoidedRawBytes?: number;
	avoidedGzipBytes?: number;
}): void {
	logLatency({
		type: "phase",
		phase: "project_snapshot_persist_decision",
		filePath: getProjectSnapshotPath(args.cwd),
		durationMs: 0,
		metadata: {
			seq: args.seq,
			decision: args.decision,
			...(args.fingerprint
				? { fingerprint: args.fingerprint.slice(0, 12) }
				: {}),
			...(args.avoidedRawBytes === undefined
				? {}
				: { avoidedRawBytes: args.avoidedRawBytes }),
			...(args.avoidedGzipBytes === undefined
				? {}
				: { avoidedGzipBytes: args.avoidedGzipBytes }),
		},
	});
}

/**
 * Reconcile the authoritative in-process entry with a body that just landed on
 * disk: update its `knownMtime` so a subsequent load keeps serving our own
 * object without re-parsing, and DROP oversized bodies (their post-promotion
 * disk read is the pre-#947 behavior — we won't pin hundreds of MB of heap).
 */
function reconcileAuthoritativeAfterWrite(
	pending: PendingSnapshotBody,
	rawBytes: number,
): void {
	const entry = authoritativeSnapshots.get(pending.key);
	// Only reconcile the entry that still belongs to THIS (latest) generation —
	// a superseding save already replaced it with a newer object.
	if (!entry || entry.snapshot !== pending.snapshot) return;
	// The worker needs the serialized snapshot until promotion completes, but
	// retaining it afterward duplicates the mutable warm index's postings. A
	// shared reference is unsafe: ProjectSnapshot stores serialized arrays while
	// WordIndex owns mutable Map/PathKeyedMap state. Drop the authoritative copy
	// after publication; later merge-writers rehydrate the canonical disk body.
	if (pending.snapshot.wordIndex) {
		try {
			const stat = fs.statSync(pending.gzPath);
			cacheParsedSnapshot(pending.gzPath, {
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				snapshot: withoutWordIndex(pending.snapshot),
			});
		} catch {
			// A cache miss is safe: the first metadata consumer reconstructs it.
		}
		deleteAuthoritativeSnapshot(pending.key);
		logLatency({
			type: "phase",
			phase: "project_snapshot_word_index_released",
			filePath: pending.gzPath,
			durationMs: 0,
			metadata: { rawBytes },
		});
		return;
	}
	if (rawBytes > SNAPSHOT_PARSE_CACHE_MAX_BYTES) {
		// Benign but invisible otherwise: the next load will re-parse this body
		// from disk instead of serving the in-process object.
		logLatency({
			type: "phase",
			phase: "project_snapshot_authoritative_dropped_oversized",
			filePath: pending.gzPath,
			durationMs: 0,
			metadata: { rawBytes, maxBytes: SNAPSHOT_PARSE_CACHE_MAX_BYTES },
		});
		deleteAuthoritativeSnapshot(pending.key);
		return;
	}
	try {
		entry.knownMtime = fs.statSync(pending.gzPath).mtimeMs;
	} catch {
		// If we can't stat our own write, leave knownMtime as-is; the worst case
		// is one extra disk re-parse on the next load.
	}
}

function finalizeProjectSnapshotMeta(
	pending: PendingSnapshotBody,
	record: Pick<
		SnapshotPersistRecord,
		"fingerprint" | "generatedAt" | "gzBytes"
	>,
): boolean {
	try {
		writeProjectSnapshotMeta(
			getProjectSnapshotMetaPath(pending.cwd),
			pending.snapshot,
			record,
		);
		return true;
	} catch (err) {
		recordSnapshotPersistFailure(
			pending,
			err instanceof Error ? err.message : String(err),
			true,
		);
		return false;
	}
}

function completeSnapshotPersist(pending: PendingSnapshotBody): void {
	if (_activeSnapshotPersists.get(pending.key) !== pending) return;
	_activeSnapshotPersists.delete(pending.key);
	if (_snapshotExiting) return;
	const queued = _queuedSnapshotPersists.get(pending.key);
	if (!queued) return;
	_queuedSnapshotPersists.delete(pending.key);
	dispatchSnapshotPersist(queued);
}

function writeSnapshotBodyOnMainThread(
	pending: PendingSnapshotBody,
	reason?: string,
): void {
	if (!pendingSnapshotIsCurrent(pending)) {
		completeSnapshotPersist(pending);
		return;
	}
	if (reason) {
		// We took the synchronous main-thread gzip path (the +656MB-risk path,
		// #950) instead of the worker. Surface it rather than burying it in an
		// `offloaded:false` success line below. `degraded` distinguishes a REAL
		// degradation (worker died/unavailable/promote-failed) from the benign
		// `exit_hook` teardown flush, so an operator triaging worker health isn't
		// misled by normal process-exit flushes.
		logLatency({
			type: "phase",
			phase: "project_snapshot_worker_fallback",
			filePath: pending.gzPath,
			durationMs: 0,
			metadata: {
				reason,
				seq: pending.snapshot.seq,
				degraded: reason !== "exit_hook",
			},
		});
	}
	try {
		const serializeStarted = performance.now();
		const json = JSON.stringify(pending.snapshot);
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(json);
		const fingerprint = fingerprintProjectSnapshotJson(
			json,
			pending.snapshot.generatedAt,
		);
		if (pending.dedupeFingerprints.includes(fingerprint)) {
			// Re-read the tiny durable sidecar before honoring a fingerprint
			// captured at dispatch time (#2008): a body torn between dispatch and
			// execution must fall through to the full write, not skip.
			const current = snapshotPersistBaselinesFor(pending.cwd, pending.key);
			if (current.integrity === "ok") {
				const prior = current.durable ?? pending.durablePersist;
				if (
					authoritativeSnapshots.get(pending.key)?.snapshot === pending.snapshot
				) {
					deleteAuthoritativeSnapshot(pending.key);
				}
				logSnapshotPersistDecision({
					cwd: pending.cwd,
					seq: pending.snapshot.seq,
					fingerprint,
					decision: "skipped_unchanged",
					avoidedRawBytes: rawBytes,
					avoidedGzipBytes: prior?.gzBytes,
				});
				return;
			}
			if (current.integrity !== undefined) {
				noteSnapshotSkipRefused({
					gzPath: pending.gzPath,
					verdict: current.integrity,
					seq: pending.snapshot.seq,
				});
			}
			// integrity === undefined: the meta/body evidence vanished entirely
			// since dispatch — falling through to the full write repairs it, the
			// same contract as deletion-before-dispatch.
		}
		const writeStarted = performance.now();
		const gzip = gzipSync(json);
		fs.mkdirSync(path.dirname(pending.gzPath), { recursive: true });
		writeFileAtomic(pending.gzPath, gzip, { bestEffort: false });
		fs.rmSync(pending.legacyPath, { force: true });
		const metadataFinalized = finalizeProjectSnapshotMeta(pending, {
			fingerprint,
			generatedAt: pending.snapshot.generatedAt,
			gzBytes: gzip.byteLength,
		});
		if (!metadataFinalized) return;
		reconcileAuthoritativeAfterWrite(pending, rawBytes);
		logSnapshotPersistSuccess(pending, fingerprint, {
			rawBytes,
			gzBytes: gzip.byteLength,
			serializeMs,
			writeMs: performance.now() - writeStarted,
			offloaded: false,
		});
		if (reason) _lastSnapshotPersistErrorForTests = reason;
	} catch (err) {
		recordSnapshotPersistFailure(
			pending,
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		completeSnapshotPersist(pending);
	}
}

/**
 * The ForTests promotion seam covers worker-message and every main-thread
 * fallback promotion. It stays sync and seam-free in production, identical to
 * calling the writer directly. The process-exit hook is deliberately the sole
 * direct write because an exit handler cannot await this asynchronous seam.
 */
function dispatchMainThreadWriteThroughSeam(
	pending: PendingSnapshotBody,
	reason: string | undefined,
): void {
	if (_snapshotPromotionSeamForTests) {
		void _snapshotPromotionSeamForTests().then(() =>
			writeSnapshotBodyOnMainThread(pending, reason),
		);
		return;
	}
	writeSnapshotBodyOnMainThread(pending, reason);
}

function handleSnapshotWorkerResult(
	result: ProjectSnapshotPersistWorkerResult,
): void {
	const pending = _snapshotWorkerRequests.get(result.id);
	if (!pending) {
		fs.rmSync(result.stagePath, { force: true });
		return;
	}
	_snapshotWorkerRequests.delete(result.id);
	if (
		result.error ||
		result.rawBytes === undefined ||
		result.gzBytes === undefined ||
		result.serializeMs === undefined ||
		result.writeMs === undefined ||
		result.semanticFingerprint === undefined
	) {
		fs.rmSync(result.stagePath, { force: true });
		dispatchMainThreadWriteThroughSeam(
			pending,
			result.error ?? "invalid worker result",
		);
		return;
	}
	// Generation gate: a newer save already superseded this one — discard the
	// stale stage file rather than promote it over the fresher body.
	if (!result.skippedUnchanged) _snapshotWorkerBodyWritesForTests++;
	if (
		_snapshotGenerationGateEnabledForTests &&
		_snapshotGenerationStates.get(pending.key)?.generation !== result.generation
	) {
		// The stale stage is part of the promotion transaction: remove it before
		// returning so a superseded save cannot leave an orphan behind.
		fs.rmSync(result.stagePath, { force: true });
		completeSnapshotPersist(pending);
		return;
	}
	if (result.skippedUnchanged) {
		// Re-read the tiny durable sidecar at the decision seam. A sibling process
		// may have advanced B after this request captured A. A stale replay of A
		// must preserve B's body metadata, not restore the captured A sidecar.
		const baselines = snapshotPersistBaselinesFor(pending.cwd, pending.key);
		if (baselines.integrity !== "ok") {
			// The worker skipped WITHOUT staging a body, trusting the durable
			// fingerprint captured at dispatch. The re-read says that evidence no
			// longer passes the #2008 integrity gate — refuse the skip and rewrite
			// synchronously so a torn/missing body cannot outlive this save. The
			// sync writer recomputes the same baselines, finds them untrusted, and
			// performs the full gzip+stage+promote (its finally completes this
			// pending, so do not complete it twice here).
			if (baselines.integrity !== undefined) {
				noteSnapshotSkipRefused({
					gzPath: pending.gzPath,
					verdict: baselines.integrity,
					seq: pending.snapshot.seq,
				});
			}
			dispatchMainThreadWriteThroughSeam(
				pending,
				"snapshot body integrity regressed",
			);
			return;
		}
		const prior = baselines.durable ?? pending.durablePersist;
		if (
			authoritativeSnapshots.get(pending.key)?.snapshot === pending.snapshot
		) {
			deleteAuthoritativeSnapshot(pending.key);
		}
		logSnapshotPersistDecision({
			cwd: pending.cwd,
			seq: pending.snapshot.seq,
			fingerprint: result.semanticFingerprint,
			decision: "skipped_unchanged",
			avoidedRawBytes: result.rawBytes,
			avoidedGzipBytes: prior?.gzBytes,
		});
		completeSnapshotPersist(pending);
		return;
	}
	try {
		fs.renameSync(result.stagePath, pending.gzPath);
		fs.rmSync(pending.legacyPath, { force: true });
		const metadataFinalized = finalizeProjectSnapshotMeta(pending, {
			fingerprint: result.semanticFingerprint,
			generatedAt: pending.snapshot.generatedAt,
			gzBytes: result.gzBytes,
		});
		if (!metadataFinalized) {
			completeSnapshotPersist(pending);
			return;
		}
		reconcileAuthoritativeAfterWrite(pending, result.rawBytes);
		logSnapshotPersistSuccess(pending, result.semanticFingerprint, {
			rawBytes: result.rawBytes,
			gzBytes: result.gzBytes,
			serializeMs: result.serializeMs,
			writeMs: result.writeMs,
			offloaded: true,
		});
		completeSnapshotPersist(pending);
	} catch (err) {
		fs.rm(result.stagePath, { force: true }, () => {});
		dispatchMainThreadWriteThroughSeam(
			pending,
			err instanceof Error ? err.message : String(err),
		);
	}
}

function dispatchSnapshotPersist(pending: PendingSnapshotBody): void {
	// A queued request may have waited behind the publication that created its
	// best dedupe evidence. Refresh only the tiny sidecar/body stat here; never
	// retain the stale admission-time baseline through dispatch.
	const baselines = snapshotPersistBaselinesFor(pending.cwd, pending.key);
	pending.durablePersist = baselines.durable;
	pending.dedupeFingerprints = baselines.fingerprints;
	seedSnapshotPersistBaselineFromDurable(pending.key, baselines.durable);
	_activeSnapshotPersists.set(pending.key, pending);
	if (!snapshotWorkerEnabled()) {
		dispatchMainThreadWriteThroughSeam(pending, undefined);
		return;
	}
	const worker = getSnapshotPersistWorker();
	if (!worker) {
		dispatchMainThreadWriteThroughSeam(pending, "persist worker unavailable");
		return;
	}
	const id = ++_snapshotWorkerRequestId;
	_snapshotWorkerRequests.set(id, pending);
	const request: ProjectSnapshotPersistWorkerRequest = {
		id,
		generation: pending.generation,
		stagePath: pending.stagePath,
		data: pending.snapshot,
		priorFingerprints: pending.dedupeFingerprints,
		testDelayMs:
			process.env.NODE_ENV === "test"
				? Number(process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS) ||
					undefined
				: undefined,
	};
	try {
		worker.postMessage(request);
	} catch (err) {
		_snapshotWorkerRequests.delete(id);
		dispatchMainThreadWriteThroughSeam(
			pending,
			err instanceof Error ? err.message : String(err),
		);
	}
}

function handleSnapshotWorkerDeath(reason: string): void {
	_snapshotPersistWorker = undefined;
	_snapshotWorkerDisabled = true;
	const requests = [..._snapshotWorkerRequests.values()];
	_snapshotWorkerRequests.clear();
	for (const pending of requests)
		dispatchMainThreadWriteThroughSeam(pending, reason);
}

function resolveSnapshotPersistWorkerPath(): string | undefined {
	// esbuild does NOT rewrite new URL(...) asset refs, so from the bundled
	// dist/index.js a sibling ./project-snapshot-persist-worker.js resolves
	// beside the BUNDLE where nothing exists. Try the compiled-sibling layout
	// first (source checkout / unbundled dist/clients tree), then the dist-tree
	// path relative to the bundle entry — same shape as the review graph's
	// resolvePersistWorkerPath (#950 review F1).
	const candidates = [
		new URL("./project-snapshot-persist-worker.js", import.meta.url),
		new URL("./clients/project-snapshot-persist-worker.js", import.meta.url),
	];
	for (const url of candidates) {
		try {
			const resolved = fileURLToPath(url);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* try next layout */
		}
	}
	return undefined;
}

function getSnapshotPersistWorker(): Worker | undefined {
	if (_snapshotWorkerDisabled) return undefined;
	if (_snapshotPersistWorker) return _snapshotPersistWorker;
	try {
		const workerPath = resolveSnapshotPersistWorkerPath();
		if (workerPath === undefined) {
			handleSnapshotWorkerDeath(
				"persist worker script not found in any layout",
			);
			return undefined;
		}
		const worker = new Worker(workerPath);
		// The ForTests promotion seam wraps ONLY when set — the production path
		// binds the sync handler directly, so scheduling is byte-identical when
		// no test seam is installed (the async-handler variant of this shifted
		// promotion timing under full-suite load and flaked the round-trip test).
		worker.on("message", (result: ProjectSnapshotPersistWorkerResult) => {
			if (_snapshotPromotionSeamForTests) {
				void _snapshotPromotionSeamForTests().then(() =>
					handleSnapshotWorkerResult(result),
				);
				return;
			}
			handleSnapshotWorkerResult(result);
		});
		worker.on("error", (err: Error) => handleSnapshotWorkerDeath(err.message));
		worker.on("exit", (code) => {
			if (_snapshotPersistWorker === worker) _snapshotPersistWorker = undefined;
			// Any body still queued when the worker exits was abandoned mid-flight
			// (a crash, a `terminate()`, or host recycling) — it will never be
			// promoted by this worker, so fall it back to the sync writer rather
			// than let it vanish (honesty, #533). `terminate()` can report a 0
			// exit code on some platforms, so this cannot key off `code !== 0`.
			const stranded = [..._snapshotWorkerRequests.values()];
			if (stranded.length > 0) {
				_snapshotWorkerRequests.clear();
				for (const pending of stranded) {
					dispatchMainThreadWriteThroughSeam(
						pending,
						`persist worker exited with code ${code}`,
					);
				}
			}
			// Only an ABNORMAL exit disables respawning; a clean idle exit (nothing
			// stranded) just drops the reference so the next persist respawns.
			if (code !== 0) _snapshotWorkerDisabled = true;
		});
		// #1148: adding a message listener refs the Worker's public MessagePort.
		// Unref only after every listener is installed so it stays background-only.
		worker.unref();
		_snapshotPersistWorker = worker;
		return worker;
	} catch (err) {
		handleSnapshotWorkerDeath(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

// #950 review F3: a process that dies between a worker's staged write and its
// promotion leaves project-snapshot.json.gz.stage-<pid>-<gen> (and the worker's
// .tmp-<pid>) behind forever. Sweep leftovers from PRIOR processes once per
// cache dir; our own live stage files carry this pid and are skipped.
const _sweptSnapshotStageDirs = new Set<string>();
function sweepStaleSnapshotStageFiles(cacheDir: string): void {
	if (_sweptSnapshotStageDirs.has(cacheDir)) return;
	_sweptSnapshotStageDirs.add(cacheDir);
	fs.readdir(cacheDir, (err, entries) => {
		if (err) return;
		const ownMarker = `.stage-${process.pid}-`;
		for (const entry of entries) {
			if (!entry.startsWith("project-snapshot.json.gz.stage-")) continue;
			if (entry.includes(ownMarker)) continue;
			fs.rm(path.join(cacheDir, entry), { force: true }, () => {});
		}
	});
}

// Flush any in-flight worker writes synchronously at process teardown so a body
// whose worker hasn't promoted yet isn't lost. Sync writes only (no child
// spawn — the teardown libuv hazard); best-effort.
let _snapshotExitHookInstalled = false;
function ensureSnapshotPersistExitHook(): void {
	if (_snapshotExitHookInstalled) return;
	_snapshotExitHookInstalled = true;
	process.once("exit", () => {
		_snapshotExiting = true;
		const latestByKey = new Map<string, PendingSnapshotBody>();
		for (const pending of _snapshotWorkerRequests.values()) {
			latestByKey.set(pending.key, pending);
		}
		for (const pending of _queuedSnapshotPersists.values()) {
			const prior = latestByKey.get(pending.key);
			// Queued work is later admission order. Equal-seq requests deliberately
			// share a gate generation, so a tie must still select the queued payload.
			if (!prior || prior.generation <= pending.generation) {
				latestByKey.set(pending.key, pending);
			}
		}
		_snapshotWorkerRequests.clear();
		_queuedSnapshotPersists.clear();
		_activeSnapshotPersists.clear();
		for (const pending of latestByKey.values()) {
			// Only the newest generation per key still matters; older ones are
			// superseded and their stage files are swept on next launch.
			if (
				_snapshotGenerationStates.get(pending.key)?.generation !==
				pending.generation
			)
				continue;
			writeSnapshotBodyOnMainThread(pending, "exit_hook");
		}
		void _snapshotPersistWorker?.terminate();
	});
}

export function saveProjectSnapshot(
	cwd: string,
	snapshot: ProjectSnapshot,
): void {
	const gzPath = getProjectSnapshotPath(cwd);
	const legacyPath = getProjectSnapshotLegacyPath(cwd);
	const metaPath = getProjectSnapshotMetaPath(cwd);
	const cacheDir = path.dirname(gzPath);
	const key = normalizeMapKey(cwd);
	fs.mkdirSync(cacheDir, { recursive: true });
	const baselines = snapshotPersistBaselinesFor(cwd, key);
	const priorPersist = baselines.durable;
	logSnapshotPersistDecision({
		cwd,
		seq: snapshot.seq,
		decision: "requested",
	});
	if (_failedSnapshotPersists.delete(key)) {
		logSnapshotPersistDecision({ cwd, seq: snapshot.seq, decision: "retry" });
	}

	// #958: for a new seq, meta is written FIRST and body SECOND. A crash or
	// failure between the two writes can now only produce
	// "meta already claims the new seq, body hasn't caught up yet" (the meta
	// races ahead). The meta-first gate (isProjectSnapshotMetaStale) reads
	// that as *fresh* and falls through to parsing the body, whose own
	// embedded `seq` is still the old one, so `isProjectSnapshotFresh`
	// correctly rejects it as stale on the body's own merits — one wasted
	// parse, self-healing, no data lost. The OLD body-then-meta order could
	// instead leave an old-seq meta sitting over a freshly written body,
	// which the meta-first gate discards WITHOUT ever reading it — throwing
	// away a genuinely fresh snapshot. That direction is not recoverable
	// until the next save, so it's the one this reorder eliminates.
	//
	// The new-seq meta write stays synchronous and throwing. Same-seq work does
	// not need to advance the freshness gate, so it leaves the current sidecar
	// untouched until the worker has a semantic verdict. This prevents a stale
	// local request from replacing a
	// newer sibling process's same-seq fingerprint before it can coalesce.
	if (priorPersist?.seq !== snapshot.seq) {
		writeProjectSnapshotMeta(metaPath, snapshot);
	}

	// Record the authoritative in-process write BEFORE handing the body off, so
	// a merge-read between now and the worker's promotion sees our own object
	// (the on-disk body still holds the previous generation until promotion). The
	// pre-write mtime is our baseline: while disk stays at it (or below), our
	// object wins; a promotion or an external write moves past it. Baseline off
	// the CURRENTLY-RESOLVED body — which is the legacy uncompressed
	// `project-snapshot.json` in the one-release upgrade window before the first
	// gz promotion — not gz-only: statting only gzPath there would leave the
	// baseline at -Infinity, so the load gate (which resolves the legacy body's
	// real, positive mtime) would reject our own fresh write and serve the stale
	// legacy body to a merge-consumer, silently dropping this snapshot's fields.
	const priorBody = resolveSnapshotBodyPath(cwd);
	const knownMtime = priorBody ? priorBody.mtimeMs : Number.NEGATIVE_INFINITY;
	const authoritativeEntry: AuthoritativeSnapshotEntry = {
		snapshot,
		knownMtime,
		lastUsedAt: Date.now(),
	};
	authoritativeSnapshots.set(key, authoritativeEntry);
	scheduleAuthoritativeSnapshotEviction(key, authoritativeEntry);
	enforceAuthoritativeSnapshotCap();
	// A stale disk-parse-cache entry for this path must not out-vote the fresh
	// authoritative write once the latter is dropped (oversized bodies).
	snapshotParseCache.delete(gzPath);

	const generationState = _snapshotGenerationStates.get(key);
	const generation =
		generationState?.seq === snapshot.seq
			? generationState.generation
			: (generationState?.generation ?? 0) + 1;
	_snapshotGenerationStates.set(key, { generation, seq: snapshot.seq });
	const stagePath = `${gzPath}.stage-${process.pid}-${generation}`;
	const pending: PendingSnapshotBody = {
		key,
		cwd,
		gzPath,
		legacyPath,
		stagePath,
		snapshot,
		generation,
		durablePersist: priorPersist,
		dedupeFingerprints: baselines.fingerprints,
	};
	sweepStaleSnapshotStageFiles(cacheDir);
	ensureSnapshotPersistExitHook();

	if (_activeSnapshotPersists.has(key)) {
		_queuedSnapshotPersists.set(key, pending);
		logSnapshotPersistDecision({
			cwd,
			seq: snapshot.seq,
			decision: "coalesced",
		});
		return;
	}
	dispatchSnapshotPersist(pending);
}

// --- Test hooks for the worker persist path ---------------------------------

/** Test-only: wait until worker requests have either landed or degraded. */
export async function waitForProjectSnapshotPersistsForTests(): Promise<void> {
	for (
		let attempts = 0;
		attempts < 200 &&
		(_snapshotWorkerRequests.size > 0 ||
			_activeSnapshotPersists.size > 0 ||
			_queuedSnapshotPersists.size > 0);
		attempts++
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Test-only: force any in-flight worker body write to the sync main-thread path. */
export function flushProjectSnapshotPersistsForTests(): void {
	const requests = [..._snapshotWorkerRequests.values()];
	_snapshotWorkerRequests.clear();
	for (const pending of requests) {
		dispatchMainThreadWriteThroughSeam(pending, undefined);
	}
}

/** Test-only: exercise the degraded worker-death path. */
export async function terminateProjectSnapshotPersistWorkerForTests(): Promise<void> {
	const worker = _snapshotPersistWorker;
	if (worker) await worker.terminate();
}

/** Test-only: restore worker creation + clear generation state after a deliberate death. */
export function resetProjectSnapshotPersistWorkerForTests(): void {
	_snapshotWorkerDisabled = false;
	_snapshotGenerationGateEnabledForTests = true;
	_snapshotPromotionSeamForTests = undefined;
	_snapshotPersistWorker = undefined;
	_snapshotWorkerRequests.clear();
	_snapshotGenerationStates.clear();
	_successfulSnapshotPersists.clear();
	_failedSnapshotPersists.clear();
	_activeSnapshotPersists.clear();
	_queuedSnapshotPersists.clear();
	_snapshotExiting = false;
	_snapshotWorkerBodyWritesForTests = 0;
	_lastSnapshotPersistErrorForTests = undefined;
}

/** Test-only: expose bounded queue state without retaining snapshot bodies. */
export function getProjectSnapshotPersistStateForTests(cwd: string): {
	active: boolean;
	queued: boolean;
	successfulFingerprint?: string;
	workerBodyWrites: number;
} {
	const key = normalizeMapKey(cwd);
	return {
		active: _activeSnapshotPersists.has(key),
		queued: _queuedSnapshotPersists.has(key),
		successfulFingerprint: _successfulSnapshotPersists.get(key)?.fingerprint,
		workerBodyWrites: _snapshotWorkerBodyWritesForTests,
	};
}

/** Test-only mutation switch for proving the supersession invariant. */
export function setProjectSnapshotGenerationGateForTests(
	enabled: boolean,
): void {
	_snapshotGenerationGateEnabledForTests = enabled;
}

/** Test-only seam immediately before generation-gated promotion. */
export function setProjectSnapshotPromotionSeamForTests(
	seam: (() => Promise<void>) | undefined,
): void {
	_snapshotPromotionSeamForTests = seam;
}

export function getProjectSnapshotPersistErrorForTests(): string | undefined {
	return _lastSnapshotPersistErrorForTests;
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
		// #1019: capture the runtime's live sequence index AT this seq. The runtime
		// is seeded from the change log at session start and bumped in lockstep with
		// every append, so `getFileSeqEntries()` IS the fold of the log up to
		// `projectSeq` — and its keys are already `normalizeMapKey(path.resolve())`,
		// the exact form the change-log replay produces.
		sequenceIndex: {
			projectSeq: args.runtime.projectSeq,
			fileSeqByPath: args.runtime.getFileSeqEntries(),
		},
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

/**
 * #1785 F2/F3: additive counterpart to `hydrateRuntimeFromProjectSnapshot`
 * for a LATE/retroactive hydration attempt — one that runs after other work
 * may already have populated the runtime for real (e.g. quick mode's
 * background warmup building a genuine `wordIndex`, docCount > 0). The
 * unconditional version above is only safe for the FIRST hydration attempt,
 * made before anything else has run: clearing `cachedExports` is correct
 * there because there is nothing yet to destroy.
 *
 * A late call cannot make that assumption, and `cachedExports` and
 * `projectRulesScan` are populated by INDEPENDENT tasks from whatever else is
 * running (nothing else in quick mode touches either), so this guards each
 * field on its OWN "nothing computed since" check rather than one
 * all-or-nothing bail-out — the field a concurrent task actually populated is
 * protected without needlessly withholding the other, still-idle field the
 * snapshot could still supply. Returns whether it hydrated ANY field, so the
 * caller can log honestly instead of claiming success when nothing changed.
 *
 * #1785 F5: takes ONLY the narrow `{ cachedExports, projectRulesScan }`
 * shape (see `ProjectSnapshotExportsAndRules`) — deliberately no `wordIndex`
 * parameter at all, not even an optional one. The retroactive path's
 * captured/reloaded snapshot always comes from
 * `loadProjectSnapshotExportsAndRules`, which never parses `wordIndex` in
 * the first place (avoiding its dominant share of a full body parse's cost —
 * see that function's doc comment for the measured numbers). This is also
 * the right behavior, not just a performance shortcut: quick mode's warmup
 * is the only thing that ever builds a `wordIndex` in this window, and F2's
 * hazard was this exact late-hydration path nulling that live index from a
 * disk copy that predated it — removing the parameter removes the hazard by
 * construction instead of merely guarding against it at runtime.
 */
export function hydrateRuntimeFromProjectSnapshotIfIdle(
	runtime: RuntimeCoordinator,
	snapshot: Pick<ProjectSnapshot, "cachedExports" | "projectRulesScan">,
): boolean {
	let hydratedAnything = false;

	if (runtime.cachedExports.size === 0 && snapshot.cachedExports.length > 0) {
		runtime.cachedExports.clear();
		for (const [name, filePath] of snapshot.cachedExports) {
			runtime.cachedExports.set(name, filePath);
		}
		hydratedAnything = true;
	}

	if (
		!runtime.projectRulesScan.hasCustomRules &&
		runtime.projectRulesScan.rules.length === 0 &&
		snapshot.projectRulesScan
	) {
		runtime.projectRulesScan = snapshot.projectRulesScan;
		hydratedAnything = true;
	}

	return hydratedAnything;
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
			// rather than clobbering it with undefined. #348: only carry it forward
			// when `existing` was built AT THIS SAME seq — otherwise a stale
			// snapshot's leftover index (already correctly rejected as stale by
			// isProjectSnapshotFresh on load, seq mismatch) would get silently
			// re-stamped with the CURRENT seq by this save, "laundering" a stale
			// index into looking fresh before the word-index task even runs.
			if (
				!snapshot.wordIndex &&
				existing.wordIndex &&
				existing.seq === snapshot.seq
			) {
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
