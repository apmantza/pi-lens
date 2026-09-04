/**
 * Tree-sitter Structural Search Client for pi-lens
 *
 * Inspired by pi-lsp-extension's search-engine.ts and pattern-compiler.ts
 * Provides AST-aware structural search with metavariable capture.
 *
 * Uses web-tree-sitter (WASM) for parsing - no native compilation needed.
 *
 * Pattern syntax:
 *   $NAME    - Matches any single AST node, captures as NAME
 *   $$$NAME  - Matches zero or more sibling nodes (variadic)
 *
 * Example:
 *   "console.log($MSG)" matches any console.log call, captures argument as MSG
 *   "function $NAME($$$PARAMS) { $BODY }" matches function declarations
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
	getDegradationLedgerGeneration,
	incrementDegradationCount,
	recordDegradation,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { BoundedFifoMap } from "./bounded-cache.js";
import { loadWebTreeSitter } from "./deps/web-tree-sitter.js";
import { transientRetryDelayMs } from "./dispatch/runners/utils/availability-policy.js";
import { getProjectIgnoreMatcher, isExcludedDirName } from "./file-utils.js";
import {
	downloadGrammarDetailed,
	fileHasWasmMagic,
	grammarBlockReason,
	grammarFileSha256,
	isVendoredGrammar,
	LANGUAGE_TO_GRAMMAR,
	pinnedGrammarHash,
	vendoredGrammarRefusal,
	vendoredGrammarsDir,
} from "./grammar-source.js";
import { resolvePackagePath } from "./package-root.js";
import {
	assertInstallAllowed,
	getProjectTrustGeneration,
} from "./project-trust.js";
import { logTreeSitterDiagnostic } from "./tree-sitter-logger.js";
import { notifyUserDegradation } from "./user-notify.js";

const _require = createRequire(import.meta.url);

import {
	createTreeCacheCounters,
	deriveScanTreeCacheCapacity,
	TreeCache,
	type TreeCacheCounters,
	type TreeCacheStats,
} from "./tree-sitter-cache.js";
import { TreeSitterNavigator } from "./tree-sitter-navigator.js";
import {
	isProvenSqlAlchemySessionReceiver,
	isSafePsycopgIdentifierComposition,
} from "./python-provenance.js";
import {
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "./tree-sitter-query-loader.js";

// Hard cap on a single structural-search file walk. Bounds a misrooted scan so
// it can't enumerate an unbounded tree synchronously before result collection
// short-circuits (#262).
const TREE_SITTER_MAX_SCAN_FILES = 20_000;

// Consecutive grammar-load failures after which a batch cache key gives up and
// caches null like any other deterministic failure. Bounds the retry loop when
// a grammar simply never loads, while still letting a transient loadLanguage()
// failure (offline lazy fetch, mid-scan load error) recover on a later scan
// instead of paying the 3.3x per-rule fallback for the process lifetime (#889).
const QUERY_BATCH_MAX_LOAD_FAILURES = 3;

// Keep post-filter tree walks bounded. A malformed or unexpectedly huge tree
// must not stall the batched query walk; the filter fails open when this cap
// is reached so unrelated diagnostics and the current match are preserved.
const NO_NESTED_ANCHOR_VISIT_CAP = 10_000;
const LEGACY_PYTHON_HALLUCINATED_IMPORT_MODULES: ReadonlySet<string> = new Set([
	"requests",
	"flask",
	"django",
	"typing",
	"collections",
	"asyncio",
	"json",
	"unittest",
	"pytest",
	"urllib",
]);
const LEGACY_PYTHON_HALLUCINATED_IMPORT_NAMES: ReadonlySet<string> = new Set([
	"JSONResponse",
	"HTMLResponse",
	"RedirectResponse",
	"StreamingResponse",
	"Depends",
	"Query",
	"Path",
	"Body",
	"Header",
	"Cookie",
	"Form",
	"File",
	"UploadFile",
	"FastAPI",
	"APIRouter",
	"HTTPException",
	"BackgroundTasks",
	"dataclass",
	"fields",
	"BaseModel",
	"Field",
	"validator",
	"aiohttp",
	"parse",
	"stringify",
	"fixture",
	"TestCase",
	"get",
	"post",
	"put",
	"delete",
	"Model",
	"Session",
	"Column",
	"Integer",
	"String",
]);
const PYTHON_SQL_SINK_METHODS: ReadonlySet<string> = new Set([
	"execute",
	"executemany",
	"query",
	"raw",
	"scalar",
	"scalars",
]);

function isKnownPythonHallucinatedImport(
	moduleName: string,
	importedName: string,
): boolean {
	if (moduleName === "sqlalchemy") return importedName === "JSONResponse";
	return (
		LEGACY_PYTHON_HALLUCINATED_IMPORT_MODULES.has(moduleName) &&
		LEGACY_PYTHON_HALLUCINATED_IMPORT_NAMES.has(importedName)
	);
}

// --- Type Declarations (local, no import needed) ---

// biome-ignore lint/suspicious/noExplicitAny: Language from web-tree-sitter
type TreeSitterLanguage = any;

interface TreeSitterTree {
	rootNode: TreeSitterNode;
}

interface TreeSitterNode {
	type: string;
	text: string;
	children: TreeSitterNode[];
	parent?: TreeSitterNode | null;
	isNamed: boolean;
	childCount: number;
	startPosition: { row: number; column: number };
	startIndex: number;
	endIndex: number;
	/** web-tree-sitter field accessor — optional so mock nodes in tests
	 * without field support still satisfy the interface. */
	childForFieldName?: (field: string) => TreeSitterNode | null;
}

interface TreeSitterParserInstance {
	setLanguage: (lang: TreeSitterLanguage) => void;
	parse: (content: string) => TreeSitterTree;
}

// --- Types ---

export interface StructuralMatch {
	file: string;
	line: number;
	column: number;
	matchedText: string;
	/** Tree-sitter node type of the first capture (e.g. "call_expression") */
	nodeType?: string;
	captures: Record<string, string>;
}

export interface SearchPattern {
	pattern: string;
	language: string;
	metavars: string[];
}

export interface TreeSitterParserCounters {
	parserInvocations: number;
	parserDurationMs: number;
	parserFailures: number;
}

export interface TreeSitterParseCacheStats
	extends TreeCacheStats, TreeSitterParserCounters {}

type ParseCacheMeasurement = TreeCacheCounters & TreeSitterParserCounters;

/**
 * Result of a cache-safe parse. `parsed: false` means the grammar/parse was
 * unavailable — distinct from a consumer that legitimately returned null.
 */
export type ParsedTreeOutcome<T> =
	| { parsed: true; value: T }
	| { parsed: false };

const NOT_PARSED: ParsedTreeOutcome<never> = { parsed: false };

interface QueryBatchEntry {
	queryDef: TreeSitterQuery;
	metavars: string[];
	postFilter?: string;
	postFilterParams?: unknown;
}

interface QueryBatch {
	// biome-ignore lint/suspicious/noExplicitAny: compiled web-tree-sitter Query
	query: any;
	entries: QueryBatchEntry[];
	/** patternIndex → index into `entries`. */
	ownerOfPattern: number[];
}

interface GrammarDirResolutionDeps {
	resolveAsset: (asset: string) => string | undefined;
	resolvePackage: (specifier: string) => string;
	cwd: () => string;
}

function createParserCounters(): TreeSitterParserCounters {
	return {
		parserInvocations: 0,
		parserDurationMs: 0,
		parserFailures: 0,
	};
}

/**
 * `size:mtimeMs` identity for a grammar candidate, or undefined when the path
 * is absent or not a regular file. Doubles as the existence check on the
 * resolve path and as the invalidation key for the verified-preamble memo
 * (#1548) — `size` + `mtimeMs` is the codebase's standard cheap stamp.
 */
function grammarFileStamp(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : undefined;
	} catch {
		return undefined;
	}
}

export function isTreeSitterWasmAbortError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Aborted") || message.includes("abort()");
}

/**
 * Positively-identified RESOLUTION-failure codes for a dynamic `import()`:
 * the specifier couldn't be found/resolved, or a transient fs error hit
 * before `import()` got as far as evaluating the target module. All of
 * these recover once whatever was missing/busy appears — they say nothing
 * durable about the module itself (mirrors the errno allowlist in
 * clients/dispatch/runners/ast-grep-napi.ts's `classifyAstGrepLoadFailure`,
 * kept local here rather than shared because that file is owned by an
 * in-flight PR, #1701, at the time of writing).
 */
const RESOLUTION_ERROR_CODES = new Set([
	"ERR_MODULE_NOT_FOUND",
	"MODULE_NOT_FOUND",
	"ERR_INVALID_MODULE_SPECIFIER",
	"ERR_UNSUPPORTED_DIR_IMPORT",
	"ENOENT",
	"EMFILE",
	"EBUSY",
	"EAGAIN",
	"EPERM",
	"ETXTBSY",
]);

/** Walk an error's `.cause` chain, collecting every `code` seen along the
 * way — a resolution failure's `code` can be wrapped in a cause rather than
 * sitting on the top-level thrown Error. */
function collectErrorCodes(err: unknown): string[] {
	const codes: string[] = [];
	let current: unknown = err;
	const seen = new Set<unknown>();
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		const code = (current as Error & { code?: unknown }).code;
		if (typeof code === "string") codes.push(code);
		current = (current as Error & { cause?: unknown }).cause;
	}
	return codes;
}

/**
 * Classify a `loadWebTreeSitter()` rejection (#1592). RESOLUTION failures
 * (a positively-identified code above) are recoverable: the module gets a
 * fresh `import()` attempt on the very next `init()` call, same as before
 * this fix, because whatever blocked resolution can plausibly clear on its
 * own. Everything else is treated as EVALUATION-shaped and latches — an
 * unrecognized error is far more likely to be the target module's own
 * top-level code throwing (which Node's ESM loader then memoizes as a
 * permanently-rejected module record for that URL) than an unclassified
 * resolution hiccup, so "unknown" defaults to the case a retry cannot fix.
 */
function classifyWebTreeSitterLoadFailure(
	err: unknown,
): "resolution" | "evaluation" {
	const codes = collectErrorCodes(err);
	return codes.some((code) => RESOLUTION_ERROR_CODES.has(code))
		? "resolution"
		: "evaluation";
}

// --- Parser Manager ---

export class TreeSitterClient {
	private initialized = false;
	private initPromise: Promise<boolean> | null = null;
	/**
	 * Set when `loadWebTreeSitter()` itself rejects with an EVALUATION-shaped
	 * error (#1592, review round 2 F1/F2) — `classifyWebTreeSitterLoadFailure`
	 * above draws that line. That call is a dynamic `import()` of a fixed
	 * resolved URL, and Node's ESM loader permanently memoizes a module
	 * record that threw during evaluation — a later `import()` of the SAME
	 * URL from a later `init()` call would just replay the cached rejection,
	 * not re-attempt the load. Without this latch, every `withTreeSitterRoot()`
	 * call (one per file parse) would re-invoke `init()`, see `initPromise`
	 * cleared by the previous attempt's `finally`, and dynamically re-import —
	 * a dead retry on the hot path. A RESOLUTION-shaped rejection does NOT
	 * set this: it leaves `initPromise` cleared as before, so the next
	 * `init()` call retries for real, because that class of failure can
	 * plausibly clear before the next call arrives.
	 *
	 * SESSION-scoped, not process-lifetime (round 2 F2, the #1567/#1575
	 * `sgSessionHold` precedent): re-armed by `resetLoadStateForSession()`,
	 * wired into `resetDispatchBaselines()` via `tree-sitter-shared.ts`'s
	 * `resetTreeSitterClientLoadState()`. Re-arming does not guarantee the
	 * next attempt succeeds — if the process itself didn't restart between
	 * sessions, Node's module cache is unchanged and the replay will just
	 * fail fast again — but it gives a fresh degradation record for the new
	 * session (the ledger's own `onceKeys` are cleared at session_start too)
	 * instead of silently reusing a stale verdict forever, and it does let a
	 * genuinely fixed install (process WAS restarted) recover.
	 *
	 * Distinct from `wasmAborted`, which stays process-lifetime and is
	 * deliberately NOT included in the session reset: that flag means the
	 * Emscripten WASM heap itself aborted mid-use — a runtime that DID load
	 * and then corrupted its own memory. Reusing that heap after a "session"
	 * boundary that isn't an actual process restart is not a retry, it's
	 * operating on data already documented (tree-sitter-shared.ts) as
	 * requiring a real restart to recover. `webTreeSitterLoadFailed` only
	 * ever covers a runtime that never loaded in the first place, so nothing
	 * corrupted survives a re-arm.
	 */
	private webTreeSitterLoadFailed = false;
	private languages: Map<string, TreeSitterLanguage> = new Map();
	private parsers: Map<string, TreeSitterParserInstance> = new Map();
	private treeCache: TreeCache;
	private navigator = new TreeSitterNavigator();
	private grammarsDir: string;
	/** In-flight lazy grammar fetches, keyed by wasm filename. Evicted on
	 * settle (#1536) — a rejected/false attempt must not be remembered as the
	 * permanent answer for the session; only concurrent demands during the
	 * SAME probe share it. */
	private grammarEnsurePromises = new Map<string, Promise<boolean>>();
	/** Epoch ms before which a failed grammar download is not retried
	 * (#1536). A transient download failure — offline, DNS hiccup, CDN blip —
	 * says nothing durable about the grammar, so it gets a bounded cooldown
	 * (the `transientRetryDelayMs` shape from availability-policy.ts) instead
	 * of latching for the process lifetime. */
	private grammarRetryAtMs = new Map<string, number>();
	/**
	 * Grammar path → the `size:mtimeMs` stamp at which its wasm preamble was
	 * verified (#1548). A POSITIVE-only memo, so the steady-state resolve costs
	 * one `stat` (which the old `existsSync` already paid) and re-reads the
	 * header only when the stamp moves. Stamped rather than a bare `Set`
	 * because a memo that never expires is defect-shape 6: the file it vouches
	 * for can be replaced under it. Failures are deliberately NOT memoized — a
	 * poisoned path must be re-examined on the next resolve so a successful
	 * re-download over it is picked up immediately.
	 */
	private verifiedGrammarPaths = new Map<string, string>();
	/**
	 * Grammar path → the `size:mtimeMs` stamp at which `Language.load` failed
	 * on it despite passing the wasm-preamble check (#1564) — e.g. a truncated
	 * download whose first four bytes are a genuine `\0asm` preamble but whose
	 * body decodes short ("Code section extends past end of the module"). The
	 * preamble check alone can't see this; only a real decode attempt can.
	 * `resolveGrammarFile` treats a path recorded here (at the SAME stamp) as
	 * absent, so the next demand re-fetches instead of reusing the same broken
	 * file forever. Stamped so a fresh download (new mtime) is re-examined
	 * rather than permanently distrusted — same shape as `verifiedGrammarPaths`.
	 */
	private decodeFailedGrammarPaths = new Map<string, string>();
	/**
	 * Grammar path → the `size:mtimeMs` stamp at which its bytes were verified
	 * to match the CURRENTLY PINNED sha256 manifest (#1760). Positive-only,
	 * same discipline as `verifiedGrammarPaths`: the hash is computed once per
	 * stamp (not per parse), and a stamp change — a fresh download — forces a
	 * re-check rather than trusting a memo made for different bytes.
	 */
	private verifiedGrammarVersionAt = new Map<string, string>();
	/**
	 * Grammar path → the `size:mtimeMs` stamp at which it was found to no
	 * longer match the pinned manifest hash — a version bump
	 * (`TREE_SITTER_WASMS_VERSION`, or a `SOURCE_OVERRIDES` entry), or on-disk
	 * corruption (#1760). `resolveGrammarFile` treats a path recorded here (at
	 * the SAME stamp) as absent, exactly like `decodeFailedGrammarPaths`, so
	 * the next demand re-fetches instead of serving the stale/corrupt file for
	 * the rest of the process's life. A fresh download (new stamp) is
	 * re-examined rather than permanently distrusted.
	 */
	private staleGrammarVersionAt = new Map<string, string>();
	/**
	 * Paths already reported as version-stale THIS SESSION, to log/record them
	 * once each (#1801 review F1). Deliberately separate from
	 * `staleGrammarVersionAt`: that map is a pure hash-verdict memo whose whole
	 * point is to persist for the process's life (re-hashing an unchanged file
	 * is exactly what it exists to avoid), so it must never double as a report
	 * gate — a gate riding on process-lifetime state can't re-arm at a session
	 * boundary. Cleared in `refreshGrammarSessionLatches`, mirroring
	 * `poisonedGrammarPaths`.
	 */
	private staleReportedGrammarPaths = new Set<string>();
	/** Paths already reported as non-wasm, to log/record them once each. */
	private poisonedGrammarPaths = new Set<string>();
	/** Consecutive download failures per grammar, for the exponential
	 * cooldown; reset on success. */
	private grammarFailureAttempts = new Map<string, number>();
	/**
	 * Retry delay (ms) last SHOWN to the user for this grammar, or `-1` for a
	 * durable (non-retryable) failure already announced. The cooldown lets
	 * the ensure loop retry silently in the background — only the delay's
	 * FIRST appearance, and any later escalation the user was never told
	 * about, needs to interrupt them (#1536 review F6): a fresh 30s cooldown
	 * re-notifies the same as an escalated 300s one once it's a genuinely new
	 * number, but two consecutive 30s cooldowns (identical, nothing new to
	 * say) do not. Absence means "not yet notified this streak."
	 *
	 * Session-scoped (#1536 review F5): cleared whenever the degradation
	 * ledger's own generation moves past `grammarNotificationsLedgerGen`,
	 * mirroring `trustBlockedGrammarNotifications` below — a lazy
	 * compare-at-use-time against a monotonic counter, not a listener. Tied to
	 * the LEDGER's generation (bumped by `resetDegradationLedger`, which
	 * `handleSessionStart` calls first thing) rather than trust, since this
	 * is a session boundary, not a trust transition.
	 */
	private grammarLastNotifiedDelayMs = new Map<string, number>();
	private grammarNotificationsLedgerGen = getDegradationLedgerGeneration();
	private trustBlockedGrammarNotifications = new Set<string>();
	private trustNotificationsGeneration = getProjectTrustGeneration();
	// biome-ignore lint/suspicious/noExplicitAny: Optional dependency loaded dynamically
	private ParserClass: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Language loader from module
	private LanguageLoader: any = null;
	// Declared BEFORE the two caches below: a static read by an instance field
	// initializer must already be initialized (TS2729).
	private static readonly QUERY_CACHE_MAX_ENTRIES = 256;
	private static readonly QUERY_BATCH_CACHE_MAX_ENTRIES = 256;
	// biome-ignore lint/suspicious/noExplicitAny: Compiled query cache by language+pattern hash
	// BoundedFifoMap, not BoundedLruCache: recency here is refreshed by this
	// class's own explicit delete+set on both the read and the write path (see
	// cacheQuery and the two lookup sites) — exactly the raw-`Map` discipline
	// the FIFO map documents. A get() that promoted on its own would change
	// which entry eviction targets (#2442 review F5/F7).
	private queryCache = new BoundedFifoMap<string, any>(
		TreeSitterClient.QUERY_CACHE_MAX_ENTRIES,
	);
	/** Combined multi-rule queries by language + rule-set identity (null = don't retry). */
	private queryBatchCache = new BoundedFifoMap<string, QueryBatch | null>(
		TreeSitterClient.QUERY_BATCH_CACHE_MAX_ENTRIES,
	);
	private queryCacheCap(): number {
		const value = Number.parseInt(
			process.env.PI_LENS_TREE_SITTER_QUERY_CACHE_CAP ?? "",
			10,
		);
		return Number.isSafeInteger(value) && value > 0
			? value
			: TreeSitterClient.QUERY_CACHE_MAX_ENTRIES;
	}

	private queryBatchCacheCap(): number {
		const value = Number.parseInt(
			process.env.PI_LENS_TREE_SITTER_QUERY_BATCH_CACHE_CAP ?? "",
			10,
		);
		return Number.isSafeInteger(value) && value > 0
			? value
			: TreeSitterClient.QUERY_BATCH_CACHE_MAX_ENTRIES;
	}

	// biome-ignore lint/suspicious/noExplicitAny: compiled query objects
	private cacheQuery(key: string, value: any): void {
		this.queryCache.delete(key); // write-refresh: this write is the newest
		// The cap is env-readable, so re-apply it before every write — a raised
		// or lowered ceiling has to take effect on the next insert, not on the
		// next restart. Both calls hand back the dropped [key, value] pairs so
		// the evicted compiled query's native handle is still freed (#2442
		// review F5/F7 — this is why set() returns the VALUE, not just the key).
		const evicted = this.queryCache.setMaxEntries(this.queryCacheCap());
		evicted.push(...this.queryCache.set(key, value));
		for (const [, dropped] of evicted) dropped?.query?.delete?.();
	}

	private cacheQueryBatch(key: string, value: QueryBatch | null): void {
		this.queryBatchCache.delete(key);
		const evicted = this.queryBatchCache.setMaxEntries(
			this.queryBatchCacheCap(),
		);
		evicted.push(...this.queryBatchCache.set(key, value));
		for (const [, dropped] of evicted) dropped?.query?.delete?.();
	}
	/** Consecutive grammar-load failures per batch key — bounds load retries (#889). */
	private queryBatchLoadFailures = new Map<string, number>();
	private queryLoader = new TreeSitterQueryLoader();
	private verbose: boolean;
	private parserCounters = createParserCounters();
	private parseCacheMeasurement =
		new AsyncLocalStorage<ParseCacheMeasurement>();
	private activeMeasurements = 0;
	private onWasmAbort: (() => void) | undefined;
	private wasmAborted = false;
	private readonly grammarDirResolutionDeps: GrammarDirResolutionDeps;

	constructor(
		verbose = false,
		onWasmAbort?: () => void,
		grammarDirResolutionDeps?: GrammarDirResolutionDeps,
	) {
		this.grammarDirResolutionDeps = grammarDirResolutionDeps ?? {
			resolveAsset: (asset) => this.resolveWebTreeSitterAsset(asset),
			resolvePackage: (specifier) => _require.resolve(specifier),
			cwd: () => process.cwd(),
		};
		this.grammarsDir = this.findGrammarsDir();
		this.verbose = verbose;
		this.onWasmAbort = onWasmAbort;
		this.treeCache = new TreeCache(
			50,
			verbose,
			4096,
			(key, amount) => {
				const measurement = this.parseCacheMeasurement.getStore();
				if (measurement) measurement[key] += amount;
			},
			(error) => this.reportWasmAbort(error),
		);
	}

	private recordParserCounter(
		key: keyof TreeSitterParserCounters,
		amount = 1,
	): void {
		this.parserCounters[key] += amount;
		const measurement = this.parseCacheMeasurement.getStore();
		if (measurement) measurement[key] += amount;
	}

	reportWasmAbort(error: unknown): boolean {
		if (!isTreeSitterWasmAbortError(error)) return false;
		if (!this.wasmAborted) {
			this.wasmAborted = true;
			recordDegradation({
				kind: "wasm-abort",
				subject: "web-tree-sitter",
				reason: error instanceof Error ? error.message : String(error),
			});
			this.onWasmAbort?.();
		}
		return true;
	}

	/**
	 * O(1) runtime footprint counters (#1123 item 2 memory attribution): every
	 * field is a `Map.size` read, never an iteration over the maps' contents.
	 * `wasmMemoryBytes` is deliberately NOT included here — web-tree-sitter
	 * 0.25.10's Emscripten `Module` (which owns the WASM linear memory /
	 * `HEAPU8.buffer`) is a private closure variable in the package's
	 * `bindings.ts` and is not exposed through any public export (`Parser`,
	 * `Language`, `Query`, ...); reaching it would require either reflecting
	 * into the package's internal module state (brittle across web-tree-sitter
	 * versions/bundling) or overriding Emscripten's `wasmMemory` module option
	 * at `Parser.init()` time with a hand-constructed `WebAssembly.Memory`
	 * matching the library's own default page-count math (risks a memory-import
	 * mismatch that would break ALL structural analysis, for an
	 * observability-only feature). `process.memoryUsage().arrayBuffers` is the
	 * process-wide proxy used instead (WASM linear memory backs an ArrayBuffer,
	 * so it is included there) — see clients/memory-sampler.ts.
	 */
	getRuntimeStats(): {
		languagesLoaded: number;
		parsersLoaded: number;
		queryCacheSize: number;
		queryBatchCacheSize: number;
	} {
		return {
			languagesLoaded: this.languages.size,
			parsersLoaded: this.parsers.size,
			queryCacheSize: this.queryCache.size,
			queryBatchCacheSize: this.queryBatchCache.size,
		};
	}

	getParseCacheStats(): TreeSitterParseCacheStats {
		return {
			...this.treeCache.getStats(),
			...this.parserCounters,
		};
	}

	/**
	 * Grow the tree cache to span a full-project scan's working set (#1715).
	 * The interactive default (50 entries) can't hold a mid/large project's
	 * file count, so a second scan re-parses everything the first scan's LRU
	 * evicted — live dogfood evidence showed every miss on a second 110-file
	 * scan was a `capacityMisses` one. Bounded by
	 * `TREE_CACHE_SCAN_CAPACITY_CEILING` (see `deriveScanTreeCacheCapacity`'s
	 * heap-cost note) and monotonic — a smaller scan never shrinks a capacity
	 * an earlier, larger one already grew.
	 */
	ensureTreeCacheCapacity(fileCount: number): void {
		this.treeCache.setMaxSize(
			deriveScanTreeCacheCapacity(fileCount, this.treeCache.getMaxSize()),
		);
	}

	async withParseCacheMeasurement<T>(
		work: () => Promise<T>,
		onComplete: (stats: TreeSitterParseCacheStats) => void,
	): Promise<T> {
		const measurement: ParseCacheMeasurement = {
			...createTreeCacheCounters(),
			...createParserCounters(),
		};
		this.activeMeasurements++;
		try {
			return await this.parseCacheMeasurement.run(measurement, async () => {
				try {
					return await work();
				} finally {
					const cacheStats = this.treeCache.getStats();
					try {
						onComplete({
							...cacheStats,
							...measurement,
							misses: measurement.lookups - measurement.hits,
						});
					} catch {
						// Telemetry must not fail the measured work.
					}
				}
			});
		} finally {
			// On Node 22 an active AsyncLocalStorage keeps an async_hooks init hook
			// enabled for every promise in the process, so release it once the last
			// overlapping measurement is done rather than taxing the whole session.
			if (--this.activeMeasurements === 0) this.parseCacheMeasurement.disable();
		}
	}

	/** Debug logging helper */
	private dbg(msg: string): void {
		if (this.verbose) {
			// #1333: verbose gating is preserved, but the SINK is tree-sitter.log —
			// a raw write would corrupt pi's frame the moment verbose is enabled.
			logTreeSitterDiagnostic({
				subsystem: "tree-sitter-client",
				level: "debug",
				message: msg,
			});
		}
	}

	/**
	 * Resolve a web-tree-sitter asset path using multiple strategies:
	 * 1. Node module resolution via createRequire (handles hoisted installs — issue #20)
	 * 2. Package-root walk from import.meta.url (handles on-the-fly TS compilation by pi)
	 * 3. process.cwd() fallback
	 */
	private resolveWebTreeSitterAsset(asset: string): string | undefined {
		// Strategy 1: Node module resolution (hoisted installs, pnpm workspaces)
		try {
			const resolved = _require.resolve(`web-tree-sitter/${asset}`);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* fall through */
		}

		// Strategy 2: Walk up from this module to find package.json, then into node_modules.
		// This is required when pi compiles TS on-the-fly to a temp directory —
		// createRequire(import.meta.url) resolves from the temp dir and can't find
		// web-tree-sitter, but the package root (where package.json lives) still has
		// the correct node_modules layout.
		try {
			const candidate = resolvePackagePath(
				import.meta.url,
				"node_modules",
				"web-tree-sitter",
				asset,
			);
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* fall through */
		}

		// Strategy 3: cwd fallback
		const cwdCandidate = path.join(
			process.cwd(),
			"node_modules",
			"web-tree-sitter",
			asset,
		);
		if (fs.existsSync(cwdCandidate)) return cwdCandidate;

		return undefined;
	}

	/**
	 * The `grammars/` dir bundled inside the pi-lens package (the core grammars
	 * shipped in the tarball, so common languages parse offline on every package
	 * manager). Resolved from the package root; cached. Absent in a source
	 * checkout where `prepare` hasn't populated it.
	 */
	private _bundledGrammarsDir?: string;
	private bundledGrammarsDir(): string | undefined {
		// Cache only a positive hit; keep re-checking until it exists (prepare may
		// not have populated it yet at first probe).
		if (this._bundledGrammarsDir) return this._bundledGrammarsDir;
		try {
			const dir = resolvePackagePath(import.meta.url, "grammars");
			if (fs.existsSync(dir)) this._bundledGrammarsDir = dir;
			return this._bundledGrammarsDir;
		} catch {
			return undefined;
		}
	}

	private _vendoredGrammarsDir?: string;
	/**
	 * The committed `vendor/grammars` dir, if it exists. Cached only on a hit,
	 * mirroring `bundledGrammarsDir`.
	 */
	private vendoredGrammarsDir(): string | undefined {
		if (this._vendoredGrammarsDir) return this._vendoredGrammarsDir;
		try {
			const dir = vendoredGrammarsDir();
			if (fs.existsSync(dir)) this._vendoredGrammarsDir = dir;
			return this._vendoredGrammarsDir;
		} catch {
			return undefined;
		}
	}

	/**
	 * All directories that may hold grammar wasms, in precedence order: the
	 * committed vendor dir, the bundled core dir, the resolved
	 * `this.grammarsDir`, and the web-tree-sitter grammars dir (the lazy-fetch
	 * write target). Deduped.
	 *
	 * `vendor/grammars` comes first because it is the ONLY source for a grammar
	 * we build ourselves (`VENDORED_GRAMMARS`) — nothing downloads into the
	 * later dirs for it, so a miss here is a miss everywhere.
	 */
	private grammarSourceDirs(): string[] {
		const dirs: string[] = [];
		const push = (d: string | undefined): void => {
			if (d && !dirs.includes(d)) dirs.push(d);
		};
		push(this.vendoredGrammarsDir());
		push(this.bundledGrammarsDir());
		push(this.grammarsDir || undefined);
		push(this.resolveWebTreeSitterAsset("grammars"));
		return dirs;
	}

	/**
	 * Absolute path to `grammarFile` across all source dirs, else undefined.
	 *
	 * Existence is not enough (#1548): a file whose first four bytes aren't the
	 * wasm preamble is not a grammar, and returning it would report the language
	 * as available while every `Language.load` fails — the permanent-poisoning
	 * shape this issue is about. #1548 stops NEW poisoned files from being
	 * written, but a file poisoned before that shipped is already on disk, so
	 * the resolve path has to reject it too: a rejected candidate is treated as
	 * absent, which lets `ensureGrammar` re-download over it.
	 */
	private resolveGrammarFile(grammarFile: string): string | undefined {
		for (const dir of this.grammarSourceDirs()) {
			const candidate = path.join(dir, grammarFile);
			const stamp = grammarFileStamp(candidate);
			if (!stamp) continue;
			// #1564: a file that passed the preamble check but failed
			// `Language.load` at this exact stamp is known-bad — treat it as
			// absent so `ensureGrammar` re-fetches over it, same as the
			// non-wasm-magic case below. A stamp mismatch (the file changed —
			// re-downloaded) falls through to re-examine it fresh.
			if (this.decodeFailedGrammarPaths.get(candidate) === stamp) continue;
			if (this.verifiedGrammarPaths.get(candidate) === stamp) {
				if (this.isGrammarVersionCurrent(candidate, grammarFile, stamp)) {
					return candidate;
				}
				continue;
			}
			if (fileHasWasmMagic(candidate)) {
				this.verifiedGrammarPaths.set(candidate, stamp);
				if (this.isGrammarVersionCurrent(candidate, grammarFile, stamp)) {
					return candidate;
				}
				continue;
			}
			this.verifiedGrammarPaths.delete(candidate);
			this.reportPoisonedGrammarFile(candidate, grammarFile);
		}
		return undefined;
	}

	/**
	 * Clear the once-per-session grammar report gates when the degradation
	 * ledger's own generation has moved (#1536 review F5). Lazy
	 * compare-at-use-time against a monotonic counter, bumped by
	 * `resetDegradationLedger`, which `handleSessionStart` calls first thing —
	 * no listener, no retention. Every gate keyed to a SESSION rather than to
	 * the process lives here, so a new one cannot forget to re-arm: a gate that
	 * outlives the ledger it guards silently swallows the record it was only
	 * ever meant to de-duplicate (#1560 review F1).
	 */
	private refreshGrammarSessionLatches(): void {
		const ledgerGen = getDegradationLedgerGeneration();
		if (ledgerGen === this.grammarNotificationsLedgerGen) return;
		this.grammarNotificationsLedgerGen = ledgerGen;
		this.grammarLastNotifiedDelayMs.clear();
		this.poisonedGrammarPaths.clear();
		this.staleReportedGrammarPaths.clear();
	}

	/**
	 * Log + record a grammar file on disk that isn't a wasm module, once per
	 * path per session. No user notification here: the caller goes on to attempt
	 * a re-download, and `recordGrammarFailure` is what interrupts the user if
	 * that also fails. A silent recovery should stay silent.
	 */
	private reportPoisonedGrammarFile(
		candidate: string,
		grammarFile: string,
	): void {
		// Per SESSION, not per process (#1560 review F1). The file is still
		// poisoned after a session boundary and still degrades the language, so
		// the new session's ledger has to carry the entry — a client-lifetime
		// gate would leave `resetDegradationLedger` with a permanently empty
		// grammar-blocked group and no record of why the language is degraded.
		this.refreshGrammarSessionLatches();
		if (this.poisonedGrammarPaths.has(candidate)) return;
		this.poisonedGrammarPaths.add(candidate);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			level: "warn",
			message:
				`ignoring ${candidate}: the file is not a wasm module (missing the \\0asm preamble) — ` +
				`most likely a captive-portal or proxy page written by an earlier download (#1548). ` +
				`pi-lens will treat the grammar as missing and try to fetch it again.`,
			metadata: { grammarFile, path: candidate, outcome: "not-wasm" },
		});
		incrementDegradationCount({
			kind: "grammar-blocked",
			subject: grammarFile,
			reason:
				"on-disk grammar file is not a wasm module — ignored, re-fetching",
		});
	}

	/**
	 * Is the cached grammar at `candidate` (whose wasm preamble already passed)
	 * still current against the pinned sha256 manifest (#1760)?
	 *
	 * A grammar downloaded once is never revisited when this repo bumps
	 * `TREE_SITTER_WASMS_VERSION` or changes a `SOURCE_OVERRIDES` entry — the
	 * cached file's name carries no version, so a stale build serves forever.
	 * The check is cheap and NEVER touches the network: it compares the
	 * on-disk sha256 (hashed once per `size:mtimeMs` stamp, memoized exactly
	 * like `verifiedGrammarPaths` above so a hot parse loop never re-hashes an
	 * unchanged file) against `pinnedGrammarHash`, which itself is a pure
	 * in-memory manifest lookup. A mismatch also catches on-disk corruption,
	 * which nothing detected before this.
	 *
	 * Vendored grammars (`VENDORED_GRAMMARS`) are skipped: they have no CDN
	 * pin to drift against, and their bytes are already guarded by the
	 * separate build-provenance check (`scripts/check-grammar-provenance.mjs`).
	 * No pinned hash for this filename (manifest missing, or a grammar added
	 * before `--write-manifest` was re-run) is treated as "can't verify" and
	 * trusted, the same fallback `downloadGrammarDetailed`'s own hash check
	 * already uses — never as a forced, unbounded refetch loop.
	 */
	private isGrammarVersionCurrent(
		candidate: string,
		grammarFile: string,
		stamp: string,
	): boolean {
		if (isVendoredGrammar(grammarFile)) return true;
		if (this.staleGrammarVersionAt.get(candidate) === stamp) {
			// #1801 review F1: the hash-verdict memo above is process-lifetime by
			// design (re-hashing an unchanged file on every resolve is the exact
			// cost this whole check exists to avoid), so an early return here must
			// NOT skip the report — a still-stale grammar has to keep showing up
			// in every NEW session's ledger, not just the session that first
			// discovered the mismatch.
			this.reportStaleGrammarVersion(candidate, grammarFile);
			return false;
		}
		if (this.verifiedGrammarVersionAt.get(candidate) === stamp) return true;

		const pinnedHash = pinnedGrammarHash(grammarFile);
		if (!pinnedHash) {
			this.verifiedGrammarVersionAt.set(candidate, stamp);
			return true;
		}
		const actualHash = grammarFileSha256(candidate);
		if (actualHash === pinnedHash) {
			this.verifiedGrammarVersionAt.set(candidate, stamp);
			return true;
		}

		this.verifiedGrammarVersionAt.delete(candidate);
		this.staleGrammarVersionAt.set(candidate, stamp);
		this.reportStaleGrammarVersion(candidate, grammarFile);
		return false;
	}

	/**
	 * Log + record a version-stale (or corrupt) cached grammar, once per path
	 * per SESSION (#1801 review F1). Called from BOTH the memoized-stale path
	 * and the fresh-mismatch path in `isGrammarVersionCurrent`, so the report
	 * gate is independent of `staleGrammarVersionAt`'s own process-lifetime
	 * memo — a grammar that is STILL stale in a later session must still emit
	 * a fresh record into that session's ledger, exactly like
	 * `reportPoisonedGrammarFile` already does for the non-wasm case.
	 */
	private reportStaleGrammarVersion(
		candidate: string,
		grammarFile: string,
	): void {
		this.refreshGrammarSessionLatches();
		if (this.staleReportedGrammarPaths.has(candidate)) return;
		this.staleReportedGrammarPaths.add(candidate);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			level: "warn",
			message:
				`ignoring ${candidate}: its sha256 no longer matches the pinned grammar ` +
				`manifest — the pinned tree-sitter-wasms version (or a SOURCE_OVERRIDES entry) ` +
				`moved since this file was downloaded. pi-lens will treat the grammar as ` +
				`missing and re-fetch the current build (#1760).`,
			metadata: { grammarFile, path: candidate, outcome: "stale-version" },
		});
		incrementDegradationCount({
			kind: "grammar-blocked",
			subject: grammarFile,
			reason:
				"cached grammar no longer matches the pinned manifest hash — ignored, re-fetching",
		});
	}

	/** Find tree-sitter grammar directory */
	private findGrammarsDir(deps = this.grammarDirResolutionDeps): string {
		const grammarsDir = deps.resolveAsset("grammars");
		if (
			grammarsDir &&
			fs.existsSync(path.join(grammarsDir, "tree-sitter-typescript.wasm"))
		) {
			return grammarsDir;
		}

		// Fallback: a real `tree-sitter-wasms` package, if the user installed one
		// (it is not a pi-lens dependency — grammars ship bundled / lazy-fetched).
		try {
			const wasmsOut = path.join(
				path.dirname(deps.resolvePackage("tree-sitter-wasms/package.json")),
				"out",
			);
			if (fs.existsSync(wasmsOut)) return wasmsOut;
		} catch {
			/* fall through */
		}

		const cwdWasms = path.join(
			deps.cwd(),
			"node_modules",
			"tree-sitter-wasms",
			"out",
		);
		if (fs.existsSync(cwdWasms)) return cwdWasms;

		return "";
	}

	/**
	 * The directory where grammars SHOULD live (web-tree-sitter/grammars),
	 * whether or not it exists yet — so we can create + populate it when the
	 * postinstall download was skipped (pnpm/bun). Returns undefined if
	 * web-tree-sitter itself can't be located.
	 */
	private grammarsWriteDir(): string | undefined {
		try {
			let dir = path.dirname(_require.resolve("web-tree-sitter"));
			while (
				path.basename(dir) !== "web-tree-sitter" &&
				dir !== path.dirname(dir)
			) {
				dir = path.dirname(dir);
			}
			if (path.basename(dir) === "web-tree-sitter") {
				return path.join(dir, "grammars");
			}
		} catch {
			/* fall through */
		}
		return undefined;
	}

	/**
	 * Ensure a single grammar wasm is on disk, fetching it at runtime if the
	 * postinstall didn't (pnpm/bun skip lifecycle scripts — the documented
	 * build-scripts gap). Idempotent and de-duplicated per file. Best-effort:
	 * a failed fetch (e.g. offline) degrades to "grammar unavailable", never
	 * throws.
	 */
	private async ensureGrammar(grammarFile: string): Promise<boolean> {
		if (this.resolveGrammarFile(grammarFile)) {
			return true;
		}
		if (!assertInstallAllowed(`tree-sitter grammar fetch: ${grammarFile}`)) {
			const unavailable =
				`tree-sitter grammar '${grammarFile}' is unavailable because the project is not trusted; ` +
				`runtime grammar downloads are disabled until trust is granted.`;
			logTreeSitterDiagnostic({
				subsystem: "tree-sitter-client",
				message: unavailable,
				metadata: { grammarFile, outcome: "trust-gated" },
			});
			recordDegradation({
				kind: "grammar-blocked",
				subject: grammarFile,
				reason: "runtime grammar download blocked because project is untrusted",
			});
			// Lazy clear-on-transition (#1363 review): compare the trust
			// generation at use time -- no listener registration, no retention.
			const generation = getProjectTrustGeneration();
			if (generation !== this.trustNotificationsGeneration) {
				this.trustNotificationsGeneration = generation;
				this.trustBlockedGrammarNotifications.clear();
			}
			if (!this.trustBlockedGrammarNotifications.has(grammarFile)) {
				this.trustBlockedGrammarNotifications.add(grammarFile);
				notifyUserDegradation(`pi-lens: ${unavailable}`);
			}
			return false;
		}
		const inflight = this.grammarEnsurePromises.get(grammarFile);
		if (inflight) return inflight;

		// A failed download only stays refused for its cooldown window (#1536):
		// past that, fall through and retry rather than remembering an offline
		// moment for the life of the process. No download is attempted while the
		// cooldown is live, so a hard-down CDN is not re-hit on every parse. A
		// DURABLE failure (grammarBlockDurable below) sets this to +Infinity,
		// which reads the same as "still cooling down" here — it just never
		// expires, matching the issue's "a genuinely unavailable grammar may
		// still latch" allowance.
		const retryAt = this.grammarRetryAtMs.get(grammarFile);
		if (retryAt !== undefined && Date.now() < retryAt) {
			return false;
		}

		const task = (async (): Promise<boolean> => {
			try {
				return await this.fetchGrammar(grammarFile);
			} catch (err) {
				// Defensive (#1548): nothing in `fetchGrammar` throws today —
				// `downloadGrammarDetailed` catches internally. But a thrown error
				// here used to skip the whole `else` arm, so NO cooldown was armed
				// and the rejection escaped through `task.finally` — the exact
				// pre-#1536 shape (no cooldown, possible unhandled rejection). Funnel
				// it into the same retryable failure path instead, so a future
				// refactor that lets an exception out cannot regress to it.
				const message = err instanceof Error ? err.message : String(err);
				this.recordGrammarFailure(
					grammarFile,
					`The runtime grammar fetch threw an unexpected error (${message}).`,
					/* retryable */ true,
				);
				return false;
			}
		})();
		this.grammarEnsurePromises.set(grammarFile, task);
		// Evict on settle regardless of outcome (#1536): a resolved TRUE is
		// superseded by resolveGrammarFile() finding the file on disk on the
		// next call, and a resolved FALSE must not be remembered as the
		// permanent verdict — only concurrent callers during the SAME in-flight
		// attempt should ever observe this promise.
		//
		// The trailing `.catch` is UNFALSIFIABLE scaffolding, not verified
		// defence (#1560 review F3): `finally` returns a DERIVED promise that
		// rejects whenever `task` does, but the task's own try/catch above means
		// it cannot reject, so no test can make this handler fire and removing it
		// changes nothing today. It is here for the day the try/catch above stops
		// being exhaustive — or the eviction callback itself throws — because at
		// that point the fork becomes an unhandled rejection nobody is awaiting.
		void task
			.finally(() => {
				if (this.grammarEnsurePromises.get(grammarFile) === task) {
					this.grammarEnsurePromises.delete(grammarFile);
				}
			})
			.catch(() => {
				/* see above: the task's own catch is the real handler */
			});
		return task;
	}

	/**
	 * One grammar-fetch attempt: locate a writable dir, download, and record the
	 * outcome. Split out of `ensureGrammar` so the whole body sits under one
	 * try/catch that funnels any throw into `recordGrammarFailure` (#1548).
	 */
	private async fetchGrammar(grammarFile: string): Promise<boolean> {
		// BEFORE resolving a write directory: a vendored grammar is never
		// downloaded, so the write dir has no bearing on its verdict. Resolving
		// first let the "no writable grammars directory" branch below answer
		// RETRYABLE for a missing vendored wasm on any host where
		// web-tree-sitter isn't locatable — reporting a packaging fault as a
		// transient download failure, and arming a cooldown for a fetch that can
		// never happen.
		if (isVendoredGrammar(grammarFile)) {
			const { reason } = vendoredGrammarRefusal(grammarFile);
			this.recordGrammarFailure(
				grammarFile,
				reason ?? `${grammarFile} is missing from vendor/grammars/.`,
				/* retryable */ false,
			);
			return false;
		}
		const dir =
			this.grammarsDir && fs.existsSync(this.grammarsDir)
				? this.grammarsDir
				: this.grammarsWriteDir();
		if (!dir) {
			// No writable grammars directory could be located (e.g. pi compiled
			// this module to a temp dir and web-tree-sitter isn't resolvable
			// from there yet). This is an environment condition, not a CDN
			// verdict — #1536 review F2: it must get the same cooldown +
			// notification treatment as a download failure, not a silent
			// unmemoized `false` that re-does the same failing resolution
			// sweep on every single demand.
			this.recordGrammarFailure(
				grammarFile,
				"No writable grammars directory could be located for the runtime fetch.",
				/* retryable */ true,
			);
			return false;
		}
		// Reuse the shared single-file downloader (same CDN/source as the
		// postinstall) — see clients/grammar-source.ts.
		const { ok, retryable, reason } = await downloadGrammarDetailed(
			dir,
			grammarFile,
		);
		if (ok) {
			if (!this.grammarsDir) this.grammarsDir = dir;
			this.grammarRetryAtMs.delete(grammarFile);
			this.grammarFailureAttempts.delete(grammarFile);
			this.grammarLastNotifiedDelayMs.delete(grammarFile);
			logTreeSitterDiagnostic({
				subsystem: "tree-sitter-client",
				level: "warn",
				message: `fetched missing tree-sitter grammar ${grammarFile} at runtime (install scripts were skipped by the package manager)`,
				metadata: { grammarFile, outcome: "fetched" },
			});
		} else {
			// `retryable` distinguishes a durable CDN verdict (404/410 — a
			// retry hits the same answer) from everything else (offline, DNS,
			// a down CDN, a 5xx, a timeout), which says nothing durable about
			// the grammar (#1536 review F4). Only the retryable case gets the
			// bounded cooldown; a durable failure keeps the pre-#1536 latched
			// behavior, matching the issue's own allowance.
			//
			// `reason`, when the downloader supplies one, names the actual failure
			// shape (#1548: "returned an HTML page, not a wasm module") instead of
			// the generic guess — the difference between a diagnosable log line
			// and one that sends the user to inspect their package manager while a
			// captive portal is the real cause.
			this.recordGrammarFailure(
				grammarFile,
				reason ??
					"The package manager skipped install scripts and the runtime download failed.",
				retryable,
			);
		}
		return ok;
	}

	/**
	 * Record one failed grammar-ensure attempt: arm (or extend) the retry
	 * cooldown, record the degradation, and notify the user at most once per
	 * session per DISTINCT retry delay (#1536 review F1/F2/F4/F5/F6). Shared
	 * by the "no writable directory" and "download failed" arms of
	 * `ensureGrammar` — both are failures of the SAME ensure attempt, just
	 * with a different point of failure.
	 */
	private recordGrammarFailure(
		grammarFile: string,
		detail: string,
		retryable: boolean,
	): void {
		const attempts = (this.grammarFailureAttempts.get(grammarFile) ?? 0) + 1;
		this.grammarFailureAttempts.set(grammarFile, attempts);
		// A durable verdict (404/410) never expires -- matches the issue's "a
		// genuinely unavailable grammar may still latch" allowance. Everything
		// else gets the bounded exponential cooldown.
		const retryDelayMs = retryable
			? transientRetryDelayMs(attempts, "probe-timeout")
			: undefined;
		this.grammarRetryAtMs.set(
			grammarFile,
			retryDelayMs === undefined
				? Number.POSITIVE_INFINITY
				: Date.now() + retryDelayMs,
		);

		const unavailable = retryable
			? `tree-sitter grammar '${grammarFile}' is unavailable — symbol search, ` +
				`module reports and structural rules for this language will be degraded. ` +
				`${detail} pi-lens will retry automatically in ${Math.round((retryDelayMs as number) / 1000)}s; ` +
				`if the problem persists, allow the package manager's build scripts ` +
				`(pnpm approve-builds / bun trustedDependencies) or restore network access.`
			: `tree-sitter grammar '${grammarFile}' is unavailable — symbol search, ` +
				`module reports and structural rules for this language will be degraded. ` +
				`${detail} The grammar source reports it does not exist (not a network problem), so this will not ` +
				`resolve on retry. Fix: reinstall with a manager that runs postinstall, allow its build scripts ` +
				`(pnpm approve-builds / bun trustedDependencies), or restore network access.`;

		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			message: unavailable,
			metadata: {
				grammarFile,
				outcome: "unavailable",
				retryable,
				retryDelayMs,
				attempts,
			},
		});
		// #1536 review F1: incrementDegradationCount keeps ONE ring-buffer slot
		// per subject (bumping its count in place) instead of recordDegradation's
		// one-new-entry-per-call — a grammar retrying every cooldown window would
		// otherwise flood the shared "grammar-blocked" kind's 20-slot ring and
		// evict unrelated entries (e.g. a different grammar's V8-crash block
		// reason from loadLanguage/grammarBlockReason) after ~20 cycles.
		incrementDegradationCount({
			kind: "grammar-blocked",
			subject: grammarFile,
			// #1548: carry `detail` into the RETRYABLE reason too. All retryable
			// failures used to share one string, so the ledger could not tell an
			// offline laptop from a captive portal serving HTML — the two need
			// different user actions, and the ledger is what a bug report shows.
			reason: retryable
				? `runtime grammar download failed — retryable (${detail.trim()})`
				: `runtime grammar download failed — durable (${detail.trim()})`,
		});

		this.refreshGrammarSessionLatches();
		// HUMAN-audience: an offline grammar fetch silently degrades this
		// language's features, so it reaches the user through the HOST's render
		// path (#1333) rather than a raw terminal write. Notify once per DISTINCT
		// retry delay this session (#1536 review F6) -- a fresh failure streak or
		// an escalated backoff is new information worth surfacing; an unchanged
		// repeat during the same cooldown tier is not.
		const notifyKey = retryDelayMs ?? -1;
		if (this.grammarLastNotifiedDelayMs.get(grammarFile) !== notifyKey) {
			this.grammarLastNotifiedDelayMs.set(grammarFile, notifyKey);
			notifyUserDegradation(`pi-lens: ${unavailable}`);
		}
	}

	/**
	 * Record a `Language.load` failure on a file `resolveGrammarFile` had just
	 * vouched for (#1564) — the diagnosis gap #1548 left open: the preamble
	 * check proves the first four bytes are `\0asm`, not that the whole body
	 * decodes. A decode error here (a truncated download, on-disk corruption)
	 * is evidence the FILE is bad, so it gets the exact same treatment as an
	 * ensure-time download failure: invalidate the resolve memo so the next
	 * demand re-fetches instead of reusing the same broken file forever, and
	 * reuse `recordGrammarFailure`'s cooldown/degradation/notification
	 * machinery rather than hand-rolling a parallel one — a persistently
	 * truncated CDN response would otherwise re-download and re-fail on every
	 * single parse.
	 *
	 * A DURABLE decode failure (the bytes are complete and correct, but ABI-
	 * incompatible with the installed `web-tree-sitter` — a version drift, not
	 * a truncation) is classified `retryable` here too, same as everything
	 * else this method sees: there is no way to tell "truncated" from "wrong
	 * ABI" from the error message alone, so it re-downloads and re-fails once
	 * per cooldown tier instead of latching forever. That is bounded by the
	 * cooldown ladder (this never re-fetches faster than #1536's backoff) and
	 * by `BLOCKED_GRAMMARS` for the narrower case that's fatal to the process
	 * rather than just wrong (`grammar-source.ts`). The redownload only helps
	 * if a fresh fetch could actually be a DIFFERENT (compatible) build,
	 * which is exactly what the `grammar-source.test.ts` version/lock sync
	 * guard (`lock.version === TREE_SITTER_WASMS_VERSION`) exists to keep
	 * true — without it, a version bump with a stale lock would make every
	 * redownload land the identical bytes and spin the ladder against a file
	 * that can never pass.
	 */
	private recordGrammarLoadFailure(
		grammarPath: string,
		grammarFile: string,
		err: unknown,
	): void {
		const stamp = grammarFileStamp(grammarPath);
		this.verifiedGrammarPaths.delete(grammarPath);
		if (stamp) this.decodeFailedGrammarPaths.set(grammarPath, stamp);
		const message = err instanceof Error ? err.message : String(err);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			level: "warn",
			message:
				`Language.load failed for ${grammarPath} even though the wasm preamble check ` +
				`passed (${message}) — most likely a truncated download (#1564). Treating the ` +
				`grammar as missing so the next demand re-fetches it.`,
			metadata: { grammarFile, path: grammarPath, outcome: "load-failed" },
		});
		this.recordGrammarFailure(
			grammarFile,
			`Language.load failed on a resolved grammar file (${message}).`,
			/* retryable */ true,
		);
	}

	/** Initialize tree-sitter WASM runtime */
	async init(): Promise<boolean> {
		if (this.wasmAborted) return false;
		if (this.initialized) return true;
		if (this.webTreeSitterLoadFailed) return false;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				let mod: Awaited<ReturnType<typeof loadWebTreeSitter>>;
				try {
					mod = await loadWebTreeSitter();
				} catch (err) {
					// See webTreeSitterLoadFailed's doc: an EVALUATION-shaped
					// rejection is a dead retry, so latch instead of leaving
					// initPromise clearable (the finally below would otherwise let
					// the very next parse call re-import the same doomed URL). A
					// RESOLUTION-shaped rejection is left alone — initPromise still
					// clears below, so the next init() call retries for real.
					const classification = classifyWebTreeSitterLoadFailure(err);
					if (classification === "evaluation") {
						this.webTreeSitterLoadFailed = true;
					}
					recordDegradationOnce({
						kind: "web-tree-sitter-load-failed",
						subject: "web-tree-sitter",
						reason:
							(err instanceof Error ? err.message : String(err)) +
							(classification === "resolution"
								? " (resolution failure — retryable)"
								: " (evaluation failure — latched for the session)"),
					});
					throw err;
				}
				// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter module shape varies (Parser direct / default-wrapped)
				const anyMod = mod as any;
				const ParserClass = anyMod.Parser || anyMod.default || anyMod;
				if (!ParserClass || typeof ParserClass.init !== "function") {
					this.dbg("Parser class not found or missing init method");
					return false;
				}

				// biome-ignore lint/suspicious/noExplicitAny: Parser class type
				this.ParserClass = ParserClass as any;
				// Store Language loader from module (not from Parser)
				this.LanguageLoader = mod.Language;

				// Resolve WASM path using same multi-strategy helper (hoisted installs +
				// on-the-fly compilation by pi).
				const wasmPath = this.resolveWebTreeSitterAsset("tree-sitter.wasm");
				if (!wasmPath) {
					this.dbg("Could not resolve tree-sitter.wasm");
					return false;
				}
				const wasmDir = path.dirname(wasmPath);
				this.dbg(
					`Looking for WASM at: ${wasmPath}, exists: ${fs.existsSync(wasmPath)}`,
				);

				await ParserClass.init({
					locateFile: (scriptName: string) => {
						const fullPath = path.join(wasmDir, scriptName);
						this.dbg(`locateFile: ${scriptName} -> ${fullPath}`);
						return fullPath;
					},
				});
				this.initialized = true;
				return true;
			} catch (err) {
				this.reportWasmAbort(err);
				this.dbg(`Init error: ${err}`);
				return false;
			} finally {
				this.initPromise = null;
			}
		})();

		return this.initPromise;
	}

	/**
	 * Re-arm the web-tree-sitter load latch for a new session (#1592 review
	 * round 2 F2). Deliberately does NOT touch `wasmAborted` or `initialized`
	 * — see `webTreeSitterLoadFailed`'s doc for why the abort case stays
	 * process-lifetime, and a successful init has nothing to re-arm. Called
	 * from `resetTreeSitterClientLoadState()` (tree-sitter-shared.ts), wired
	 * into `resetDispatchBaselines()` beside `resetAstGrepNapiLoadState()`.
	 */
	resetLoadStateForSession(): void {
		this.webTreeSitterLoadFailed = false;
	}

	/** Load language grammar */
	private async loadLanguage(
		languageId: string,
	): Promise<TreeSitterLanguage | null> {
		if (this.wasmAborted) return null;
		this.dbg(`Loading language: ${languageId}`);

		if (this.languages.has(languageId)) {
			this.dbg(`Language ${languageId} already loaded`);
			return this.languages.get(languageId)!;
		}

		if (!this.ParserClass) {
			this.dbg(`ParserClass not initialized`);
			return null;
		}

		const grammarFile = LANGUAGE_TO_GRAMMAR[languageId];
		if (!grammarFile) {
			this.dbg(`No grammar file for ${languageId}`);
			return null;
		}

		// A grammar that fatally crashes this runtime (uncatchable V8 abort) must
		// never be loaded — skip it and degrade to "unavailable" (#423/#432). The
		// grammar-health nightly is what decides membership of BLOCKED_GRAMMARS.
		const blockReason = grammarBlockReason(grammarFile);
		if (blockReason) {
			this.dbg(
				`Grammar ${grammarFile} blocked on this runtime — ${blockReason}`,
			);
			recordDegradation({
				kind: "grammar-blocked",
				subject: grammarFile,
				reason: blockReason,
			});
			return null;
		}

		// Look across the bundled core `grammars/` dir and the postinstall/lazy
		// dir. Lazily fetch only if the grammar is in neither (pnpm/bun skip
		// postinstall; the long-tail grammars aren't bundled). Only the language
		// actually being parsed is fetched.
		let grammarPath = this.resolveGrammarFile(grammarFile);
		if (!grammarPath) {
			if (await this.ensureGrammar(grammarFile)) {
				grammarPath = this.resolveGrammarFile(grammarFile);
			}
		}
		this.dbg(
			`Grammar path: ${grammarPath}, exists: ${grammarPath && fs.existsSync(grammarPath)}`,
		);

		if (!grammarPath || !fs.existsSync(grammarPath)) {
			this.dbg(`Grammar file not found: ${grammarPath}`);
			return null;
		}

		try {
			if (!this.LanguageLoader?.load) {
				this.dbg(`LanguageLoader.load not available`);
				return null;
			}
			this.dbg(`Calling Language.load...`);
			const language = await this.LanguageLoader.load(grammarPath);
			this.dbg(`Language loaded: ${language?.name || "unknown"}`);
			if (language) {
				this.languages.set(languageId, language);
			}
			return language;
		} catch (err) {
			// An uncatchable-shaped WASM abort poisons the whole process (#402) —
			// `reportWasmAbort` already records + handles it. Everything else
			// (#1564) is a DECODE failure on a file `resolveGrammarFile` just
			// vouched for — e.g. "Code section extends past end of the module" on
			// a truncated-but-magic-valid download. That is evidence the file
			// itself is bad, not the runtime, so record it and stop vouching for
			// this exact file so the next demand can re-fetch it.
			if (!this.reportWasmAbort(err)) {
				this.recordGrammarLoadFailure(grammarPath, grammarFile, err);
			}
			this.dbg(`Language load error: ${err}`);
			return null;
		}
	}

	/** Get or create parser for a language */
	private async getParser(
		languageId: string,
	): Promise<TreeSitterParserInstance | null> {
		if (this.wasmAborted) return null;
		if (this.parsers.has(languageId)) {
			return this.parsers.get(languageId)!;
		}

		const language = await this.loadLanguage(languageId);
		if (!language || !this.ParserClass) return null;

		const parser = new this.ParserClass();
		parser.setLanguage(language);
		this.parsers.set(languageId, parser);
		return parser;
	}

	/**
	 * Parse a file and return the AST tree. The tree stays valid only until the
	 * caller's next `await` — prefer `withParsedTree`, which extracts inside the
	 * cache-safe window (#417/#675).
	 */
	async parseFile(
		filePath: string,
		languageId: string,
		contentOverride?: string,
	): Promise<TreeSitterTree | null> {
		const outcome = await this.parseFileAndUse(
			filePath,
			languageId,
			contentOverride,
			(tree) => tree,
		);
		return outcome.parsed ? outcome.value : null;
	}

	async withParsedTree<T>(
		filePath: string,
		languageId: string,
		contentOverride: string | undefined,
		consume: (tree: TreeSitterTree) => T,
	): Promise<ParsedTreeOutcome<T>> {
		return this.parseFileAndUse(filePath, languageId, contentOverride, consume);
	}

	private async parseFileAndUse<T>(
		filePath: string,
		languageId: string,
		contentOverride: string | undefined,
		consume: (tree: TreeSitterTree) => T,
	): Promise<ParsedTreeOutcome<T>> {
		this.dbg(`Parsing ${filePath} with language ${languageId}`);
		const parser = await this.getParser(languageId);
		if (!parser) {
			this.dbg(`Failed to get parser for ${languageId}`);
			return NOT_PARSED;
		}

		let tree: TreeSitterTree;
		try {
			const content = contentOverride ?? fs.readFileSync(filePath, "utf-8");
			this.dbg(`File content length: ${content.length}`);

			const cachedTree = this.treeCache.get(filePath, content, languageId);
			if (cachedTree) {
				this.dbg(`Using cached tree for ${filePath}`);
				tree = cachedTree;
			} else {
				const parseStartedAt = performance.now();
				this.recordParserCounter("parserInvocations");
				try {
					tree = parser.parse(content);
				} catch (err) {
					this.recordParserCounter("parserFailures");
					throw err;
				} finally {
					this.recordParserCounter(
						"parserDurationMs",
						performance.now() - parseStartedAt,
					);
				}
				this.dbg(`Parsed, root node type: ${tree.rootNode.type}`);
				this.treeCache.set(filePath, content, languageId, tree);
			}
		} catch (err) {
			this.reportWasmAbort(err);
			this.dbg(`Parse error: ${err}`);
			return NOT_PARSED;
		}
		try {
			return { parsed: true, value: consume(tree) };
		} catch (error) {
			this.reportWasmAbort(error);
			throw error;
		}
	}

	/**
	 * Detect and extract injected content from template literals
	 * Used for security analysis (SQL injection, unsafe regex, etc.)
	 */
	extractInjections(
		filePath: string,
		content: string,
	): Array<{
		type: "sql" | "css" | "html" | "gql" | "regex";
		content: string;
		line: number;
		column: number;
	}> {
		const injections: Array<{
			type: "sql" | "css" | "html" | "gql" | "regex";
			content: string;
			line: number;
			column: number;
		}> = [];

		// Pattern: sql`SELECT * FROM users` or query`...`
		const sqlPattern = /\b(sql|query|execute)\s*`([^`]+)`/gi;
		let match: RegExpExecArray | null;
		while ((match = sqlPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "sql",
				content: match[2],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		// Pattern: styled.div`color: red;` or css`...`
		const cssPattern = /\b(styled(?:\.\w+)?|css)\s*`([^`]+)`/gi;
		while ((match = cssPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "css",
				content: match[2],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		// Pattern: new RegExp(`pattern`)
		const regexPattern = /new\s+RegExp\s*\(\s*`([^`]+)`/gi;
		while ((match = regexPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "regex",
				content: match[1],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		this.dbg(`Found ${injections.length} injections in ${filePath}`);
		return injections;
	}

	/** Check if tree-sitter is available (a core grammar resolves somewhere). */
	isAvailable(): boolean {
		if (this.wasmAborted) return false;
		// Available if the core TS grammar resolves in ANY source dir — the bundled
		// `grammars/` counts even when web-tree-sitter/grammars is empty (no
		// postinstall on pnpm/bun, or a fresh CI checkout).
		if (this.resolveGrammarFile("tree-sitter-typescript.wasm")) return true;
		// Re-evaluate the legacy dir in case grammars were installed after start.
		const dir = this.findGrammarsDir();
		this.grammarsDir = dir;
		return !!dir && fs.existsSync(dir);
	}

	/** Check if specific language is supported */
	async isLanguageSupported(languageId: string): Promise<boolean> {
		if (this.wasmAborted) return false;
		if (!this.initialized) await this.init();
		const language = await this.loadLanguage(languageId);
		return language !== null;
	}

	/** Get loaded language for symbol extraction */
	getLanguage(languageId: string): TreeSitterLanguage | null {
		if (this.wasmAborted) return null;
		return this.languages.get(languageId) || null;
	}

	// --- Structural Search ---

	/**
	 * Search for a structural pattern in files
	 *
	 * @param pattern - Pattern with metavariables (e.g., "console.log($MSG)")
	 * @param languageId - Language ID (typescript, python, etc.)
	 * @param rootDir - Directory to search
	 * @param options - Search options
	 * @returns Array of matches with captures
	 */
	async structuralSearch(
		pattern: string,
		languageId: string,
		rootDir: string,
		options: {
			maxResults?: number;
			fileFilter?: (path: string) => boolean;
		} = {},
	): Promise<StructuralMatch[]> {
		if (!this.initialized) {
			const ok = await this.init();
			if (!ok) return [];
		}

		try {
			await this.queryLoader.loadQueries(rootDir);
		} catch (err) {
			this.dbg(`Failed to load queries for ${rootDir}: ${err}`);
		}

		// Compile pattern into tree-sitter query
		this.dbg(`Compiling pattern: ${pattern.slice(0, 50)}...`);
		const compiled = await this.compileQuery(pattern, languageId);
		if (!compiled) {
			this.dbg(`Pattern compilation failed`);
			return [];
		}
		this.dbg(`Pattern compiled, metavars: ${compiled.metavars.join(", ")}`);

		// Collect source files
		const files = this.collectFiles(rootDir, languageId, options.fileFilter);
		this.dbg(`Scanning ${files.length} files...`);

		const matches: StructuralMatch[] = [];
		const maxResults = options.maxResults ?? 50;

		for (const file of files) {
			if (matches.length >= maxResults) break;

			const fileMatches = await this.searchFileWithQuery(
				file,
				compiled.query,
				compiled.metavars,
				languageId,
				pattern,
				compiled.postFilter,
				compiled.postFilterParams,
			);
			matches.push(...fileMatches);
		}

		return matches.slice(0, maxResults);
	}

	/**
	 * Run a preloaded query definition against a single file.
	 *
	 * Optimized for dispatch runner usage to avoid per-query directory scans.
	 */
	async runQueryOnFile(
		queryDef: TreeSitterQuery,
		filePath: string,
		languageId: string,
		options: { maxResults?: number } = {},
		contentOverride?: string,
	): Promise<StructuralMatch[]> {
		if (!this.initialized) {
			const ok = await this.init();
			if (!ok) return [];
		}

		// Compile against the language the FILE is parsed as, never the query's
		// own `language:` key. A Query is bound to the grammar it compiled
		// against; run it on a tree from another grammar and tree-sitter returns
		// zero matches forever — which is what the javascript→typescript rule
		// merge had been doing (31 queries per JS file, structurally unable to
		// fire). `getQueryCacheKey` already namespaces by language.
		const compiled = await this.compileRawQuery(
			queryDef.id,
			queryDef.query,
			queryDef.metavars,
			languageId,
			queryDef.post_filter,
			queryDef.post_filter_params,
		);
		if (!compiled) return [];

		const matches = await this.searchFileWithQuery(
			filePath,
			compiled.query,
			compiled.metavars,
			languageId,
			queryDef.id,
			compiled.postFilter,
			compiled.postFilterParams,
			contentOverride,
		);

		const maxResults = options.maxResults ?? 50;
		return matches.slice(0, maxResults);
	}

	/**
	 * Run a whole rule set against one file in a SINGLE tree walk (#675).
	 *
	 * Calling `runQueryOnFile` per rule re-walks the tree once per rule — ~34
	 * walks per file on a project scan, measured at 3.3× the cost of one
	 * combined query for byte-identical matches. Patterns are concatenated in
	 * rule order and `match.patternIndex` maps back to the owning rule, so
	 * per-rule metavars, predicates, post-filters and caps still apply and
	 * results stay grouped in rule order. Rules that don't compile against this
	 * language are dropped individually (never poisoning the batch), and a
	 * combined query that fails to compile falls back to per-rule execution.
	 */
	async runQueriesOnFile(
		queryDefs: TreeSitterQuery[],
		filePath: string,
		languageId: string,
		options: { maxResults?: number } = {},
		contentOverride?: string,
	): Promise<Array<{ queryDef: TreeSitterQuery; match: StructuralMatch }>> {
		if (queryDefs.length === 0) return [];
		if (!this.initialized) {
			const ok = await this.init();
			if (!ok) return [];
		}
		const maxResults = options.maxResults ?? 50;

		const batch = await this.compileQueryBatch(queryDefs, languageId);
		if (!batch) {
			// Fallback: one walk per rule, preserving rule order.
			const results: Array<{
				queryDef: TreeSitterQuery;
				match: StructuralMatch;
			}> = [];
			for (const queryDef of queryDefs) {
				const matches = await this.runQueryOnFile(
					queryDef,
					filePath,
					languageId,
					options,
					contentOverride,
				);
				for (const match of matches) results.push({ queryDef, match });
			}
			return results;
		}

		const perQuery = new Map<number, StructuralMatch[]>();
		await this.parseFileAndUse(
			filePath,
			languageId,
			contentOverride,
			(tree) => {
				try {
					const rootNode = tree.rootNode;
					for (const match of batch.query.matches(rootNode)) {
						const owner = batch.ownerOfPattern[match.patternIndex];
						if (owner === undefined) continue;
						const bucket = perQuery.get(owner) ?? [];
						if (bucket.length >= maxResults) continue;
						const entry = batch.entries[owner];
						const captures: Record<string, TreeSitterNode> = {};
						for (const capture of match.captures) {
							if (entry.metavars.includes(capture.name)) {
								captures[capture.name] = capture.node;
							}
						}
						if (!this.evaluatePredicates(batch.query, match)) continue;
						if (
							entry.postFilter &&
							!this.applyPostFilter(
								entry.postFilter,
								entry.postFilterParams,
								captures,
								rootNode,
							)
						) {
							continue;
						}
						if (match.captures.length === 0) continue;
						const firstNode = match.captures[0].node;
						const textCaptures: Record<string, string> = {};
						for (const [name, node] of Object.entries(captures)) {
							textCaptures[name] = (node as TreeSitterNode).text;
						}
						bucket.push({
							file: filePath,
							line: firstNode.startPosition.row + 1,
							column: firstNode.startPosition.column + 1,
							matchedText: firstNode.text,
							nodeType: firstNode.type as string | undefined,
							captures: textCaptures,
						});
						perQuery.set(owner, bucket);
					}
				} catch (err) {
					this.reportWasmAbort(err);
					this.dbg(`Batched query matching error: ${err}`);
				}
			},
		);

		const results: Array<{
			queryDef: TreeSitterQuery;
			match: StructuralMatch;
		}> = [];
		for (let i = 0; i < batch.entries.length; i++) {
			for (const match of perQuery.get(i) ?? []) {
				results.push({ queryDef: batch.entries[i].queryDef, match });
			}
		}
		return results;
	}

	/**
	 * Compile `queryDefs` into one multi-pattern Query for `languageId`, with a
	 * pattern-index → rule map. Cached per language + rule-set identity.
	 */
	private async compileQueryBatch(
		queryDefs: TreeSitterQuery[],
		languageId: string,
	): Promise<QueryBatch | null> {
		// Key on rule CONTENT, not just ids: the batch stores each queryDef (its
		// message reaches diagnostics) and the compiled patterns. Rule ids are
		// stable across edits, so an id-only key kept serving the pre-edit batch
		// for the process lifetime even after the runner reloaded the rules from
		// disk on a RuleCache miss (#878). sha256 keeps the key bounded without
		// #889's 32-bit collision risk.
		const identity = crypto
			.createHash("sha256")
			.update(JSON.stringify(queryDefs))
			.digest("hex");
		const cacheKey = this.getQueryCacheKey(`batch:${identity}`, languageId);
		const cached = this.queryBatchCache.get(cacheKey);
		if (cached !== undefined) {
			this.queryBatchCache.delete(cacheKey);
			this.queryBatchCache.set(cacheKey, cached);
			return cached;
		}

		// A loadLanguage() failure is transient (offline lazy grammar fetch,
		// transient mid-scan load error) — do NOT cache null for it, or every
		// later scan pays the ~3.3x per-rule fallback for the process lifetime
		// (#889). Retry on the next call, bounded so a grammar that never loads
		// doesn't re-attempt every scan.
		const language = await this.loadLanguage(languageId);
		if (!language) {
			const failures = (this.queryBatchLoadFailures.get(cacheKey) ?? 0) + 1;
			if (failures >= QUERY_BATCH_MAX_LOAD_FAILURES) {
				this.dbg(
					`Batch: grammar for ${languageId} failed to load ${failures} times — caching miss`,
				);
				this.queryBatchLoadFailures.delete(cacheKey);
				this.cacheQueryBatch(cacheKey, null);
			} else {
				this.queryBatchLoadFailures.set(cacheKey, failures);
			}
			return null;
		}
		this.queryBatchLoadFailures.delete(cacheKey);

		const build = async (): Promise<QueryBatch | null> => {
			const Query = (await loadWebTreeSitter()).Query;

			const entries: QueryBatchEntry[] = [];
			const sources: string[] = [];
			const ownerOfPattern: number[] = [];
			for (const queryDef of queryDefs) {
				let patternCount: number;
				try {
					// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
					const probe = new Query(language as any, queryDef.query);
					patternCount = probe.patternCount();
					probe.delete?.();
				} catch (err) {
					if (this.reportWasmAbort(err)) return null;
					// A rule that can't compile against THIS grammar is simply not
					// applicable here (e.g. a `type_annotation` pattern on javascript).
					this.dbg(`Batch: skipping ${queryDef.id} for ${languageId}: ${err}`);
					this.reportQueryCompileFailure(queryDef.id, languageId, err);
					continue;
				}
				const owner = entries.length;
				entries.push({
					queryDef,
					metavars: queryDef.metavars ?? [],
					postFilter: queryDef.post_filter,
					postFilterParams: queryDef.post_filter_params,
				});
				sources.push(queryDef.query);
				for (let i = 0; i < patternCount; i++) ownerOfPattern.push(owner);
			}
			if (entries.length === 0) return null;

			try {
				// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
				const query = new Query(language as any, sources.join("\n"));
				if (query.patternCount() !== ownerOfPattern.length) {
					this.dbg(
						`Batch pattern count mismatch for ${languageId} (${query.patternCount()} vs ${ownerOfPattern.length}) — falling back`,
					);
					return null;
				}
				return { query, entries, ownerOfPattern };
			} catch (err) {
				if (this.reportWasmAbort(err)) return null;
				this.dbg(`Batch compile failed for ${languageId}: ${err}`);
				return null;
			}
		};

		const batch = await build();
		this.cacheQueryBatch(cacheKey, batch);
		return batch;
	}

	/**
	 * Convert pattern to tree-sitter query
	 * First tries to load from query files, then falls back to inline patterns
	 */
	private patternToQuery(
		pattern: string,
		languageId: string,
	): {
		query: string;
		metavars: string[];
		postFilter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any;
		queryDef?: TreeSitterQuery;
	} {
		// Try to find matching query from loaded files
		const loadedQuery = this.queryLoader.findMatchingQuery(pattern, languageId);

		if (loadedQuery) {
			this.dbg(`Using loaded query: ${loadedQuery.id}`);
			return {
				query: loadedQuery.query,
				metavars: loadedQuery.metavars,
				postFilter: loadedQuery.post_filter,
				postFilterParams: loadedQuery.post_filter_params,
				queryDef: loadedQuery,
			};
		}

		// Fallback to inline patterns
		return this.getInlinePattern(pattern);
	}

	/**
	 * Inline patterns as fallback when no query file matches
	 */
	private getInlinePattern(pattern: string): {
		query: string;
		metavars: string[];
		postFilter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any;
	} {
		// Pattern: async function $NAME($$$PARAMS) { $BODY }
		if (pattern.includes("async function") && pattern.includes("$NAME")) {
			return {
				query: `(function_declaration
					"async"
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
				metavars: ["NAME", "PARAMS", "BODY"],
			};
		}

		// Pattern: console.$METHOD($MSG)
		if (pattern.includes("console")) {
			return {
				query: `(call_expression
					function: (member_expression
						object: (identifier) @OBJ (#eq? @OBJ "console")
						property: (property_identifier) @METHOD)
					arguments: (arguments) @ARGS)`,
				metavars: ["OBJ", "METHOD", "ARGS"],
			};
		}

		// Pattern: function $NAME($$$PARAMS) { $BODY } - match long parameter lists
		if (pattern.includes("function $NAME") && pattern.includes("PARAMS")) {
			return {
				query: `(function_declaration
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
				metavars: ["NAME", "PARAMS", "BODY"],
				postFilter: "count_params",
				postFilterParams: { min_params: 6 },
			};
		}

		// Pattern: promise chains with .then().catch().then() - 3+ levels
		if (pattern.includes(".then") && pattern.includes(".catch")) {
			return {
				query: `(call_expression
					function: (member_expression
						object: (call_expression
							function: (member_expression
								object: (call_expression
									function: (member_expression
										property: (property_identifier) @M1)
									arguments: (arguments))
								property: (property_identifier) @M2)
							arguments: (arguments))
						property: (property_identifier) @M3)
					arguments: (arguments))
					(#match? @M1 "^(then|catch)$")
					(#match? @M2 "^(then|catch)$")
					(#match? @M3 "^(then|catch)$")`,
				metavars: ["M1", "M2", "M3"],
			};
		}

		// Fallback: try to create a simple identifier capture
		const simpleMatch = pattern.match(/\$([A-Z_][A-Z0-9_]*)/);
		if (simpleMatch) {
			const name = simpleMatch[1];
			return {
				query: `(identifier) @${name}`,
				metavars: [name],
			};
		}

		// If we can't convert, return empty to trigger fallback
		return { query: "", metavars: [] };
	}

	/**
	 * Inject native tree-sitter predicates into S-expression query
	 * This moves text filtering to WASM for better performance
	 */
	/** Generate cache key for compiled query */
	private getQueryCacheKey(pattern: string, languageId: string): string {
		// Full pattern text as the key. The previous 32-bit hash could collide
		// across rules and permanently poison a cache slot with the wrong
		// compiled query (or a null meant for a different rule set) (#889).
		return `${languageId}:${pattern}`;
	}

	/** Compile a pattern into a tree-sitter Query with caching */
	private async compileQuery(
		pattern: string,
		languageId: string,
	): Promise<{
		query: any;
		metavars: string[];
		postFilter?: string;
		postFilterParams?: unknown;
	} | null> {
		const cacheKey = this.getQueryCacheKey(pattern, languageId);

		// Check cache first
		if (this.queryCache.has(cacheKey)) {
			this.dbg(`Query cache hit: ${cacheKey}`);
			const cached = this.queryCache.get(cacheKey);
			this.queryCache.delete(cacheKey);
			this.queryCache.set(cacheKey, cached);
			return cached;
		}

		const language = await this.loadLanguage(languageId);
		if (!language) {
			this.dbg(`Could not load language ${languageId}`);
			return null;
		}

		const {
			query: queryStr,
			metavars,
			postFilter,
			postFilterParams,
		} = this.patternToQuery(pattern, languageId);
		this.dbg(`Query string: ${queryStr.slice(0, 100)}...`);

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Query constructor
			const Query = (await loadWebTreeSitter()).Query;
			// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
			const query = new Query(language as any, queryStr);
			this.dbg(`Query compiled with ${query.patternCount()} patterns`);

			const result = { query, metavars, postFilter, postFilterParams };
			// Cache the compiled query
			this.cacheQuery(cacheKey, result);
			return result;
		} catch (err) {
			this.reportWasmAbort(err);
			this.dbg(`Query compilation failed: ${err}`);
			return null;
		}
	}

	/** Compile a raw tree-sitter query string with caching */
	private async compileRawQuery(
		queryId: string,
		queryStr: string,
		metavars: string[],
		languageId: string,
		postFilter?: string,
		postFilterParams?: unknown,
	): Promise<{
		query: any;
		metavars: string[];
		postFilter?: string;
		postFilterParams?: unknown;
	} | null> {
		const cacheKey = this.getQueryCacheKey(
			`raw:${queryId}:${queryStr}`,
			languageId,
		);

		if (this.queryCache.has(cacheKey)) {
			const cached = this.queryCache.get(cacheKey);
			this.queryCache.delete(cacheKey);
			this.queryCache.set(cacheKey, cached);
			return cached;
		}

		const language = await this.loadLanguage(languageId);
		if (!language) return null;

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Query constructor from web-tree-sitter
			const Query = (await loadWebTreeSitter()).Query;
			// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
			const query = new Query(language as any, queryStr);
			const result = { query, metavars, postFilter, postFilterParams };
			this.cacheQuery(cacheKey, result);
			return result;
		} catch (err) {
			this.reportWasmAbort(err);
			this.dbg(`Raw query compilation failed (${queryId}): ${err}`);
			this.reportQueryCompileFailure(queryId, languageId, err);
			return null;
		}
	}

	private reportedCompileFailures = new Set<string>();

	/** Warn once per rule+grammar pair whose query fails to compile — a silently-dead rule needs a trail. */
	private reportQueryCompileFailure(
		ruleId: string,
		languageId: string,
		err: unknown,
	): void {
		// Keyed by rule AND language: a rule can be dispatched against more than one
		// grammar (`queriesForLanguage` hands the typescript set to tsx too), and
		// failing on one must not mute the report for the others.
		const key = `${ruleId}:${languageId}`;
		if (this.reportedCompileFailures.has(key)) return;
		this.reportedCompileFailures.add(key);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			languageId,
			message:
				`tree-sitter rule '${ruleId}' failed to compile against '${languageId}' — ` +
				`matches for this rule are silently dropped rather than reported. ` +
				`Fix the query in the rule definition to re-enable it. (${err})`,
			metadata: { ruleId },
		});
	}

	private hasChildToken(node: TreeSitterNode, token: string): boolean {
		return node.children?.some(
			(child) => child.type === token || child.text === token,
		);
	}

	/**
	 * Collect names introduced by a parameter binding pattern.
	 *
	 * Binding-aware: only identifiers in a *binding* position are counted.
	 * Two node shapes hold reference expressions rather than bindings and
	 * must not be descended into:
	 *  - `assignment_pattern` / `object_assignment_pattern` (`pattern = default`,
	 *    e.g. `[a = b]` or `{a = b}`) — the `value`/`right` side is a default
	 *    *expression*, not a new name (`b` in `{a = b}` is a reference).
	 *  - `computed_property_name` (`[expr]:` in a destructuring pattern,
	 *    e.g. `{[key]: a}`) — `expr` is a reference, not a binding.
	 * Nested binding positions (destructured sub-patterns) are still walked
	 * so renamed/duplicate collisions inside them are found.
	 */
	private bindingNames(node: TreeSitterNode | undefined): Set<string> {
		const names = new Set<string>();
		if (!node) return names;
		const stack: TreeSitterNode[] = [node];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current.type === "identifier") names.add(current.text);
			else if (current.type === "shorthand_property_identifier_pattern") {
				names.add(current.text);
			}
			if (
				current.type === "property_identifier" ||
				current.type === "type_identifier" ||
				current.type === "computed_property_name"
			)
				continue;
			if (
				current.type === "assignment_pattern" ||
				current.type === "object_assignment_pattern"
			) {
				const left = current.childForFieldName?.("left");
				if (left) stack.push(left);
				continue;
			}
			stack.push(...(current.children ?? []));
		}
		return names;
	}

	private containsYieldInFunctionBody(
		node: TreeSitterNode,
		root: TreeSitterNode = node,
	): boolean {
		for (const child of node.children ?? []) {
			if (child.type === "yield") return true;
			if (
				child !== root &&
				["function_definition", "class_definition", "lambda"].includes(
					child.type,
				)
			) {
				continue;
			}
			if (this.containsYieldInFunctionBody(child, root)) return true;
		}
		return false;
	}

	/**
	 * The body statements of a `switch_case`, in order. A switch_case's named
	 * children are `[value, ...statements]` (its statements are direct children,
	 * not a wrapping statement_block), so drop the leading `case <value>` and any
	 * comments.
	 */
	private switchCaseBodyStatements(caseNode: TreeSitterNode): TreeSitterNode[] {
		// biome-ignore lint/suspicious/noExplicitAny: AST child iteration
		const named = (caseNode.children ?? []).filter(
			(c: any) => c.isNamed && !c.type.includes("comment"),
		);
		// First named child is the case's value expression (`case <value>`).
		return named.slice(1);
	}

	/**
	 * Whether a case body carries an intentional fallthrough marker comment
	 * (`// fallthrough`, `// falls through`, …). Only a *trailing* marker is
	 * honored: a comment attached to the case node after its body statements
	 * (TypeScript), the case's next sibling in the switch body (JavaScript), or
	 * one inside the trailing body statement's block. A comment in a nested
	 * function or an earlier statement is not a marker for this case and must
	 * not suppress a genuine fall-through. Only comment nodes are checked, never
	 * the case value or statement text.
	 */
	private hasFallthroughMarker(caseNode: TreeSitterNode): boolean {
		const comments: TreeSitterNode[] = [];
		const body = this.switchCaseBodyStatements(caseNode);
		const last = body[body.length - 1];
		const lastEnd = last?.endIndex ?? caseNode.startIndex;
		// TypeScript attaches a trailing `// fallthrough` as a direct child of the
		// case node, after the body statements.
		for (const c of caseNode.children ?? []) {
			if (c.type.includes("comment") && c.startIndex >= lastEnd) {
				comments.push(c);
			}
		}
		// JavaScript attaches it to the switch body as the case's next sibling.
		const siblings = (caseNode.parent?.children ?? []).filter((c) => c.isNamed);
		const index = siblings.findIndex(
			(c) => c.startIndex === caseNode.startIndex,
		);
		const next = index >= 0 ? siblings[index + 1] : undefined;
		if (next?.type.includes("comment")) comments.push(next);
		// A marker inside the trailing body statement's block (e.g. `{ work();
		// /* fallthrough */ }`). Only the trailing statement is walked, and nested
		// functions are not descended into, so a comment in a nested function or
		// an earlier statement can't suppress a genuine fall-through.
		if (last) {
			const NESTED_FN = new Set([
				"function_declaration",
				"function_expression",
				"arrow_function",
				"method_definition",
				"generator_function",
				"generator_function_declaration",
				"class_declaration",
			]);
			const stack: TreeSitterNode[] = [last];
			for (let visited = 0; stack.length > 0 && visited < 500; visited++) {
				const node = stack.pop();
				if (!node) break;
				if (node.type.includes("comment")) comments.push(node);
				if (!NESTED_FN.has(node.type)) {
					stack.push(...(node.children ?? []));
				}
			}
		}
		return comments.some((c) => /falls?\s?through/i.test(c.text));
	}

	/**
	 * Whether a statement terminates control flow (does not fall through to the
	 * next statement). Handles terminators, trailing blocks, try/catch/finally,
	 * and exhaustive if/else. Fail-safe: any unrecognized shape returns false
	 * (falls through), so a blocking rule never under-reports. Depth-bounded so a
	 * pathological nesting cannot blow the stack.
	 */
	private statementTerminates(node: TreeSitterNode, depth = 0): boolean {
		if (depth > 20) return false;
		const t = node.type;
		const TERMINATORS = new Set([
			"break_statement",
			"return_statement",
			"throw_statement",
			"continue_statement",
		]);
		if (TERMINATORS.has(t)) return true;
		// Wrapper nodes whose trailing statement decides termination: a block, an
		// `else` clause, a `catch` clause, or a `finally` clause.
		if (
			t === "statement_block" ||
			t === "else_clause" ||
			t === "catch_clause" ||
			t === "finally_clause"
		) {
			const inner = (node.children ?? []).filter(
				(c) => c.isNamed && !c.type.includes("comment"),
			);
			const last = inner[inner.length - 1];
			if (!last) return false; // empty wrapper falls through
			return this.statementTerminates(last, depth + 1);
		}
		if (t === "try_statement") {
			// The try body is the first statement_block child. A returning/throwing
			// try completes after finally, so only a catch that handles a thrown try
			// and falls through can still reach the end. A try body that completes
			// normally reaches the end unless a finally terminates it.
			const tryBody = (node.children ?? []).find(
				(c) => c.type === "statement_block",
			);
			const tryTerminates = tryBody
				? this.statementTerminates(tryBody, depth + 1)
				: false;
			const catches = (node.children ?? []).filter(
				(c) => c.type === "catch_clause",
			);
			const fin = (node.children ?? []).find(
				(c) => c.type === "finally_clause",
			);
			if (tryTerminates) {
				return catches.every((c) => this.statementTerminates(c, depth + 1));
			}
			return !!fin && this.statementTerminates(fin, depth + 1);
		}
		if (t === "if_statement") {
			// An if only terminates when it has an else and both branches do.
			const named = (node.children ?? []).filter(
				(c) => c.isNamed && !c.type.includes("comment"),
			);
			// named = [condition, consequence, (else_clause)]
			const consequence = named[1];
			const alternative = named[2];
			if (!consequence || !alternative) return false;
			return (
				this.statementTerminates(consequence, depth + 1) &&
				this.statementTerminates(alternative, depth + 1)
			);
		}
		return false;
	}

	/**
	 * Whether a `switch_case`'s next sibling is another label — `case "a": case
	 * "b": handle()` groups two labels onto one body, which is idiomatic, not a
	 * dead case.
	 */
	private nextSiblingIsSwitchLabel(caseNode: TreeSitterNode): boolean {
		const siblings = (caseNode.parent?.children ?? []).filter(
			(c) => c.isNamed && !c.type.includes("comment"),
		);
		// Match by source offset: web-tree-sitter hands out fresh node wrappers per
		// access, so identity comparison against `caseNode` is not reliable.
		const index = siblings.findIndex(
			(c) => c.startIndex === caseNode.startIndex,
		);
		const next = index >= 0 ? siblings[index + 1] : undefined;
		return next?.type === "switch_case" || next?.type === "switch_default";
	}

	/**
	 * Whether a loop body contains a statement that can terminate the loop:
	 * `return`/`throw` anywhere (they unwind past the loop), or a `break` that is
	 * not swallowed by a nested loop/switch. Does not descend into nested
	 * functions, whose `return` exits the function rather than the loop.
	 */
	private bodyHasLoopExit(
		node: TreeSitterNode,
		insideNestedLoop: boolean,
	): boolean {
		const NESTS_BREAK = new Set([
			"for_statement",
			"for_in_statement",
			"while_statement",
			"do_statement",
			"switch_statement",
		]);
		const NESTED_FN = new Set([
			"function_declaration",
			"function_expression",
			"arrow_function",
			"method_definition",
			"generator_function",
			"generator_function_declaration",
			"class_declaration",
		]);
		for (const child of node.children ?? []) {
			const t = child.type;
			if (NESTED_FN.has(t)) continue;
			if (t === "return_statement" || t === "throw_statement") return true;
			// A labeled `break outer;` is not swallowed by the nested loop it sits
			// in. Which label it targets isn't resolved here — counting any labeled
			// break as an exit errs toward not flagging, the safe direction for a
			// blocking rule.
			if (t === "break_statement") {
				const labeled = (child.children ?? []).some((c) => c.isNamed);
				if (!insideNestedLoop || labeled) return true;
			}
			if (this.bodyHasLoopExit(child, insideNestedLoop || NESTS_BREAK.has(t))) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Name of the binding a node's value flows into: the declared name of an
	 * enclosing `variable_declarator`, or the left-hand side of an enclosing
	 * `assignment_expression`. Returns "" if the node is not part of a binding
	 * (the walk stops at function/block/program boundaries so it never reaches
	 * out to an unrelated outer binding).
	 */
	private enclosingBindingName(node: TreeSitterNode | undefined): string {
		let cur: TreeSitterNode | null | undefined = node?.parent;
		for (let depth = 0; cur && depth < 12; depth++) {
			const t = cur.type;
			if (t === "variable_declarator") {
				const name = cur.children?.find((c) => c.isNamed);
				return name?.text ?? "";
			}
			if (t === "assignment_expression") {
				return cur.children?.[0]?.text ?? "";
			}
			if (
				t === "statement_block" ||
				t === "program" ||
				t === "function_declaration" ||
				t === "function_expression" ||
				t === "arrow_function" ||
				t === "method_definition"
			) {
				return "";
			}
			cur = cur.parent;
		}
		return "";
	}

	/**
	 * Resolves `name` (as used in the *same file*) to a provably fixed URL:
	 * a `const` declarator whose initializer is a string literal, or a
	 * template literal with no `${...}` substitutions.
	 *
	 * This is deliberately conservative — naming convention (e.g.
	 * SCREAMING_SNAKE_CASE) proves nothing about provenance, so it is never
	 * consulted here. Any of the following makes resolution fail (and the
	 * caller must then treat the identifier as potentially tainted):
	 *   - no declarator found for `name` in this file;
	 *   - more than one declarator for `name` (ambiguous/shadowed — refuse
	 *     rather than guess which one applies at the use site);
	 *   - declared with `let`/`var` (not `const`);
	 *   - the identifier is reassigned anywhere in the file
	 *     (`name = ...`), even if the declaration itself is `const`-like in
	 *     spirit — this also catches destructuring/compound-assignment
	 *     edge cases conservatively since we only special-case a clean
	 *     assignment_expression;
	 *   - the initializer is not a plain string/no-substitution template
	 *     literal (e.g. `process.env.X`, a function call, a member
	 *     expression, another identifier).
	 */
	private resolvesToFileLiteralConst(
		name: string,
		rootNode: TreeSitterNode,
	): boolean {
		const valueNode = this.resolveFileConstValueNode(name, rootNode);
		if (!valueNode) return false;
		return this.isFixedUrlLiteralExpr(valueNode);
	}

	/**
	 * Resolves `name` to the initializer value node of its *single, clean*
	 * file-local `const` declarator, or `null` when resolution must be refused.
	 *
	 * Refusal (returns `null`) on any of: no declarator; more than one
	 * declarator (shadowed/ambiguous — don't guess); a `let`/`var` binding for
	 * the same name anywhere; or a reassignment (`name = ...`) anywhere in the
	 * file. This is the shared, provenance-safe gate used by every "provably
	 * fixed value" check; callers inspect the returned value node themselves.
	 */
	private resolveFileConstValueNode(
		name: string,
		rootNode: TreeSitterNode,
	): TreeSitterNode | null {
		const constDeclarators: TreeSitterNode[] = [];
		let hasNonConstBinding = false;
		let hasReassignment = false;

		const stack: TreeSitterNode[] = [rootNode];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			if (node.type === "variable_declarator") {
				const nameNode = node.childForFieldName?.("name");
				if (nameNode?.type === "identifier" && nameNode.text === name) {
					const decl = node.parent;
					const isConst =
						decl?.type === "lexical_declaration" &&
						(decl.children ?? []).some((c) => c.type === "const");
					if (isConst) {
						constDeclarators.push(node);
					} else {
						hasNonConstBinding = true;
					}
				}
			} else if (
				node.type === "assignment_expression" ||
				node.type === "augmented_assignment_expression"
			) {
				const left = node.childForFieldName?.("left");
				if (left?.type === "identifier" && left.text === name) {
					hasReassignment = true;
				} else if (
					(left?.type === "member_expression" ||
						left?.type === "subscript_expression") &&
					left.childForFieldName?.("object")?.type === "identifier" &&
					left.childForFieldName?.("object")?.text === name
				) {
					// Property/subscript write to the bound receiver
					// (`name.<prop> = …` / `name[…] = …`). Any origin/host/path/
					// protocol/port/href mutation re-taints the destination after
					// construction, so fail closed and treat it as a reassignment
					// (#1008). The ONE safe exception is a query-string-only write
					// (`name.search = …`), which never alters the origin;
					// `name.searchParams.<method>(…)` is a call_expression (not an
					// assignment) and so never reaches this branch, staying exempt.
					const searchOnly =
						left.type === "member_expression" &&
						left.childForFieldName?.("property")?.text === "search";
					if (!searchOnly) {
						hasReassignment = true;
					}
				}
			}
			for (const child of node.children ?? []) stack.push(child);
		}

		// Ambiguous (shadowed/duplicated), reassigned anywhere, or backed by a
		// non-const binding somewhere in the file: refuse to resolve.
		if (
			hasNonConstBinding ||
			hasReassignment ||
			constDeclarators.length !== 1
		) {
			return null;
		}
		return constDeclarators[0].childForFieldName?.("value") ?? null;
	}

	/**
	 * True when `node` is a self-contained fixed URL string: a plain string
	 * literal, or a template literal with no `${...}` substitutions.
	 */
	private isFixedUrlLiteralExpr(node: TreeSitterNode): boolean {
		if (node.type === "string") return true;
		if (node.type === "template_string") {
			return !(node.children ?? []).some(
				(c) => c.type === "template_substitution",
			);
		}
		return false;
	}

	/**
	 * True when `name` is a binding introduced by an `import` in this file
	 * (named/aliased/default/namespace). An import binding is immutable and its
	 * value is fixed at module-load time from source — it is never request- or
	 * attacker-scoped, so an imported base URL is treated as fixed. (Limitation:
	 * we cannot see the exporting module, so an imported value that is itself
	 * `process.env.X` in another file is not distinguished — an accepted, bounded
	 * gap; direct env/param/request taint at the sink still fires.)
	 */
	private isImportedBinding(name: string, rootNode: TreeSitterNode): boolean {
		return this.importedAs(name, rootNode) !== null;
	}

	/**
	 * If `name` is an import binding, returns the *imported* name (e.g. `URL`
	 * for `import { URL as NodeURL }` → `importedAs("NodeURL") === "URL"`, and
	 * `importedAs("URL") === "URL"`). Returns `null` when `name` is not imported.
	 */
	private importedAs(name: string, rootNode: TreeSitterNode): string | null {
		const stack: TreeSitterNode[] = [rootNode];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			if (node.type === "import_specifier") {
				const nameNode = node.childForFieldName?.("name");
				const aliasNode = node.childForFieldName?.("alias");
				const local = (aliasNode ?? nameNode)?.text;
				if (local === name) return nameNode?.text ?? null;
			} else if (
				node.type === "namespace_import" ||
				node.type === "import_clause"
			) {
				// `import X from …` / `import * as X from …` — default/namespace
				// local binding is a direct identifier child.
				for (const c of node.children ?? []) {
					if (c.type === "identifier" && c.text === name) return name;
				}
			}
			for (const child of node.children ?? []) stack.push(child);
		}
		return null;
	}

	/**
	 * True when `base` (the second argument of `new URL(path, base)`) is a
	 * provably fixed origin: a literal/substitution-free template, an identifier
	 * resolving to a file-local literal `const` or an import binding, or a
	 * template whose every `${…}` substitution is such an identifier. Anything
	 * else (function params, `process.env.X`, member expressions, calls) fails.
	 */
	private isFixedUrlBaseExpr(
		base: TreeSitterNode,
		rootNode: TreeSitterNode,
	): boolean {
		if (base.type === "string") return true;
		if (base.type === "identifier") {
			return this.isFixedBaseIdentifier(base, rootNode);
		}
		if (base.type === "template_string") {
			for (const child of base.children ?? []) {
				if (child.type !== "template_substitution") continue;
				const inner = (child.children ?? []).find((c) => c.isNamed);
				if (
					!inner ||
					inner.type !== "identifier" ||
					!this.isFixedBaseIdentifier(inner, rootNode)
				) {
					return false;
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * True when the identifier `ident` (used as, or inside, a `new URL` base) is
	 * a provably fixed origin AT ITS USE SITE. A file-local literal `const` is
	 * only trusted when no nearer binding shadows it: `resolveFileConstValueNode`
	 * already fails closed on any `let`/`var` of the same name and on multiple
	 * `const` declarators, but function/method PARAMETERS are not variable
	 * declarators and so slip past that gate — a request-tainted parameter base
	 * would otherwise be exempted merely because an unrelated same-named
	 * module-level `const` literal exists (#1008). So we additionally refuse the
	 * file-const path when an enclosing function on the path from the use site to
	 * the module root binds a parameter of the same name. Imported bindings stay
	 * trusted unconditionally (imported-base-as-fixed is sound; see #1000).
	 */
	private isFixedBaseIdentifier(
		ident: TreeSitterNode,
		rootNode: TreeSitterNode,
	): boolean {
		const name = ident.text;
		if (
			!this.isShadowedByEnclosingParam(ident, name) &&
			this.resolvesToFileLiteralConst(name, rootNode)
		) {
			return true;
		}
		return this.isImportedBinding(name, rootNode);
	}

	/**
	 * True when some function/method/arrow on the ancestor chain of `node` (up to
	 * the module root) binds a PARAMETER named `name` — i.e. `name` at `node`'s
	 * location resolves to a parameter, not to an outer `const`. Only binding
	 * positions are inspected (a parameter's `pattern`, including destructured
	 * bindings); default-value expressions (`= expr`) are uses, not bindings, and
	 * are skipped so an outer const referenced in a default is not mistaken for a
	 * shadow. Fail-closed bias: unknown parameter shapes that surface a matching
	 * identifier in a binding position are treated as a shadow.
	 */
	private isShadowedByEnclosingParam(
		node: TreeSitterNode,
		name: string,
	): boolean {
		const FUNCTION_TYPES = new Set([
			"function_declaration",
			"function_expression",
			"generator_function",
			"generator_function_declaration",
			"arrow_function",
			"method_definition",
		]);
		let current: TreeSitterNode | null | undefined = node.parent;
		while (current) {
			if (FUNCTION_TYPES.has(current.type)) {
				// Bare-identifier arrow parameter: `name => …`.
				const bare = current.childForFieldName?.("parameter");
				if (bare?.type === "identifier" && bare.text === name) return true;
				const params = current.childForFieldName?.("parameters");
				if (params && this.paramsBindName(params, name)) return true;
			}
			current = current.parent;
		}
		return false;
	}

	/** True when a `formal_parameters` node binds `name` in any binding position. */
	private paramsBindName(params: TreeSitterNode, name: string): boolean {
		for (const param of params.children ?? []) {
			if (!param.isNamed) continue;
			// required_parameter / optional_parameter carry the binding in `pattern`
			// and the default (a use, not a binding) in `value`.
			const pattern =
				param.type === "required_parameter" ||
				param.type === "optional_parameter"
					? param.childForFieldName?.("pattern")
					: param;
			if (pattern && this.patternBindsName(pattern, name)) return true;
		}
		return false;
	}

	/**
	 * True when a binding pattern (`identifier`, or a destructuring
	 * object/array/rest pattern) introduces `name`. Walks the pattern but skips
	 * `assignment_pattern` default values (`= expr`), which are uses.
	 */
	private patternBindsName(pattern: TreeSitterNode, name: string): boolean {
		if (pattern.type === "identifier") return pattern.text === name;
		const stack: TreeSitterNode[] = [pattern];
		while (stack.length > 0) {
			const n = stack.pop();
			if (!n) continue;
			if (
				(n.type === "identifier" ||
					n.type === "shorthand_property_identifier_pattern") &&
				n.text === name
			) {
				return true;
			}
			if (n.type === "assignment_pattern") {
				// Only the left (binding) side introduces names; skip the default.
				const left = n.childForFieldName?.("left") ?? n.children?.[0];
				if (left) stack.push(left);
				continue;
			}
			for (const c of n.children ?? []) stack.push(c);
		}
		return false;
	}

	/**
	 * True when `name` resolves (same file) to a `const` initialized with
	 * `new URL(<literalPath>, <fixedBase>)` — a fully fixed destination origin
	 * and path. Query parameters added later via `url.searchParams.set(...)` do
	 * not alter origin/path, so they never taint the destination. The `URL`
	 * constructor may be imported under an alias (e.g. `NodeURL`).
	 */
	private resolvesToFixedNewUrlConst(
		name: string,
		rootNode: TreeSitterNode,
	): boolean {
		const value = this.resolveFileConstValueNode(name, rootNode);
		if (!value || value.type !== "new_expression") return false;

		const ctor = value.childForFieldName?.("constructor");
		const ctorName = ctor?.text ?? "";
		const isUrlCtor =
			ctorName === "URL" ||
			(ctor?.type === "identifier" &&
				this.importedAs(ctorName, rootNode) === "URL");
		if (!isUrlCtor) return false;

		const args = (
			value.childForFieldName?.("arguments")?.children ?? []
		).filter((c) => c.isNamed && c.type !== "comment");
		if (args.length === 0) return false;
		// First arg (relative path / full URL) must be a literal.
		if (!this.isFixedUrlLiteralExpr(args[0])) return false;
		// Single-arg form: `new URL("https://host/path")` — already fully fixed.
		if (args.length === 1) return true;
		// Two-arg form: base must resolve to a fixed origin.
		return this.isFixedUrlBaseExpr(args[1], rootNode);
	}

	/**
	 * For a fetch URL argument of the form `u.toString()` (call_expression) or
	 * `u.href` (member_expression), returns the receiver identifier name `u`
	 * (only for the `toString`/`href` accessors a `URL` yields). Returns `null`
	 * for any other shape so the caller falls through to taint heuristics.
	 */
	private newUrlBaseVarName(urlNode: TreeSitterNode): string | null {
		let member: TreeSitterNode | null | undefined;
		if (urlNode.type === "call_expression") {
			member = urlNode.childForFieldName?.("function");
		} else if (urlNode.type === "member_expression") {
			member = urlNode;
		}
		if (!member || member.type !== "member_expression") return null;
		const prop = member.childForFieldName?.("property")?.text;
		if (prop !== "toString" && prop !== "href") return null;
		const object = member.childForFieldName?.("object");
		if (object?.type !== "identifier") return null;
		return object.text;
	}

	/**
	 * Post-filter predicate: returns true if the match should be kept, false to skip.
	 * Each branch is an independent filter identified by name — flat dispatch, no nesting.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: postFilterParams is untyped per-filter config
	private applyPostFilter(
		postFilter: string,
		postFilterParams: any,
		captures: Record<string, TreeSitterNode>,
		rootNode?: TreeSitterNode,
	): boolean {
		/**
		 * Extract the list of declared slot names from a class_definition's
		 * `__slots__` assignment. Returns:
		 *   - `null` if the class has no `__slots__` declaration
		 *   - an array of slot names (strings) otherwise
		 *
		 * Handles both common shapes:
		 *   - string tuple/list: `__slots__ = ("a", "b")` or `['a', 'b']`
		 *   - single string:     `__slots__ = "a"` (Python's quirky single-slot form)
		 *   - parent inheritance: returns null (we don't follow MRO)
		 */
		function extractSlots(classNode: any): string[] | null {
			const classText = classNode.text ?? "";
			if (!classText.includes("__slots__")) return null;
			// biome-ignore lint/suspicious/noExplicitAny: AST iteration
			const body = classNode.children?.find((c: any) => c.type === "block");
			if (!body) return null;
			const slots: string[] = [];
			// biome-ignore lint/suspicious/noExplicitAny: AST iteration
			for (const stmt of body.children ?? []) {
				if (stmt.type !== "expression_statement") continue;
				// biome-ignore lint/suspicious/noExplicitAny: AST traversal
				const assignment = stmt.children?.find(
					(c: any) => c.type === "assignment",
				);
				if (!assignment) continue;
				// biome-ignore lint/suspicious/noExplicitAny: LHS check
				// LHS text may include a leading whitespace token from the AST
				// (tree-sitter separates the space before the LHS identifier).
				const lhsText = (assignment.children?.[0]?.text ?? "").trim();
				if (lhsText !== "__slots__") continue;
				// biome-ignore lint/suspicious/noExplicitAny: RHS extraction
				// children layout: [LHS identifier, `=` operator, RHS expression]
				const rhs = assignment.children?.[2];
				if (!rhs) continue;
				if (rhs.type === "string") {
					// __slots__ = "a" — single string form (Python quirk)
					const s = (rhs.text ?? "").replace(/^["']|["']$/g, "");
					if (s) slots.push(s);
				} else if (rhs.type === "tuple" || rhs.type === "list") {
					// biome-ignore lint/suspicious/noExplicitAny: list element extraction
					for (const el of rhs.children ?? []) {
						if (!el.isNamed) continue; // skip "," punctuation
						if (el.type === "string") {
							slots.push((el.text ?? "").replace(/^["']|["']$/g, ""));
						}
					}
				}
				break; // first __slots__ wins
			}
			return slots;
		}

		/**
		 * Escape a string for safe interpolation into a `RegExp` source —
		 * needed anywhere an identifier's raw text is combined with regex
		 * metacharacters like `\b` word boundaries (see
		 * "not_closed_or_try_with_resources" below; #1089 P2).
		 */
		function escapeRegExp(s: string): string {
			return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}

		switch (postFilter) {
			case "no_nested_anchor_chain": {
				// Tree-sitter queries can express the opening-tag shape, but they
				// cannot express both an arbitrary-depth descendant relationship and
				// an ancestor exclusion. Walk the captured JSX element here so the
				// TSX path agrees with the ast-grep rule: keep exactly the outermost
				// anchor that contains another anchor, including through wrappers.
				// This post-filter runs inside a batched query walk. It must never
				// abort that walk or turn a malformed tree into a false negative.
				try {
					const outer = captures.OUTER_ELEMENT;
					if (!outer) {
						this.reportPostFilterFailure(
							postFilter,
							"missing OUTER_ELEMENT capture",
						);
						return true;
					}
					const isAnchorElement = (node: TreeSitterNode): boolean => {
						if (node.type !== "jsx_element") return false;
						const opening =
							node.childForFieldName?.("open_tag") ??
							node.children?.find(
								(child) => child.type === "jsx_opening_element",
							);
						const name =
							opening?.childForFieldName?.("name") ??
							opening?.children?.find((child) => child.type === "identifier");
						return name?.text === "a";
					};

					let visited = 0;
					let ancestor = outer.parent;
					while (ancestor) {
						if (++visited > NO_NESTED_ANCHOR_VISIT_CAP) {
							this.reportPostFilterFailure(
								postFilter,
								`ancestor walk exceeded ${NO_NESTED_ANCHOR_VISIT_CAP} nodes`,
							);
							return true;
						}
						if (isAnchorElement(ancestor)) return false;
						ancestor = ancestor.parent;
					}

					const pending = [...(outer.children ?? [])];
					while (pending.length > 0) {
						const node = pending.pop();
						if (!node) continue;
						if (++visited > NO_NESTED_ANCHOR_VISIT_CAP) {
							this.reportPostFilterFailure(
								postFilter,
								`descendant walk exceeded ${NO_NESTED_ANCHOR_VISIT_CAP} nodes`,
							);
							return true;
						}
						if (isAnchorElement(node)) return true;
						pending.push(...(node.children ?? []));
					}
					return false;
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					this.reportPostFilterFailure(
						postFilter,
						`tree walk failed${reason ? `: ${reason}` : ""}`,
					);
					return true;
				}
			}
			case "differs_only_by_case": {
				try {
					const field = captures.FIELD?.text ?? "";
					const method = captures.METHOD?.text ?? "";
					return (
						field !== method &&
						field.toLocaleLowerCase() === method.toLocaleLowerCase()
					);
				} catch {
					return true;
				}
			}
			case "in_default_package": {
				try {
					if (!rootNode) return true;
					return !(rootNode.children ?? []).some(
						(node) => node.type === "package_declaration",
					);
				} catch {
					return true;
				}
			}
			case "missing_mimetype_and_download_name": {
				try {
					const firstArg = captures.FIRST_ARG;
					if (!firstArg) return true;
					// Flask can infer a MIME type from a filesystem path. The warning
					// is for file-like objects, where it needs an explicit MIME type or
					// download name.
					if (firstArg.type === "string") return false;
					const args = firstArg.parent;
					if (!args) return true;
					return !(args.children ?? []).some((node) => {
						if (node.type !== "keyword_argument") return false;
						const name = node.childForFieldName?.("name")?.text;
						return name === "mimetype" || name === "download_name";
					});
				} catch {
					return true;
				}
			}
			case "missing_super_call": {
				try {
					const body = captures.BODY;
					const method = captures.METHOD?.text ?? "";
					if (!body || !method) return true;
					const stack = [body];
					for (
						let visited = 0;
						stack.length > 0 && visited < 10_000;
						visited++
					) {
						const node = stack.pop();
						if (!node) break;
						if (
							node.type === "method_invocation" &&
							node.childForFieldName?.("object")?.text === "super" &&
							node.childForFieldName?.("name")?.text === method
						) {
							return false;
						}
						stack.push(...(node.children ?? []));
					}
					return true;
				} catch {
					return true;
				}
			}
			case "no_assertion_call": {
				try {
					const body = captures.BODY;
					if (!body) return true;
					const assertionNames =
						/^(?:assert\w*|fail|verify|expect|check|assume\w*)$/i;
					const stack = [body];
					for (
						let visited = 0;
						stack.length > 0 && visited < 10_000;
						visited++
					) {
						const node = stack.pop();
						if (!node) break;
						if (node.type === "method_invocation") {
							const name = node.childForFieldName?.("name")?.text ?? "";
							if (assertionNames.test(name)) return false;
						}
						stack.push(...(node.children ?? []));
					}
					return true;
				} catch {
					return true;
				}
			}
			case "not_closed_or_try_with_resources": {
				try {
					const declaration = captures.DECL;
					const resource = captures.RESOURCE?.text ?? "";
					if (!declaration || !resource) return true;
					// (#956 review: the old resource_specification ANCESTOR walk was
					// dead code — the query only matches local_variable_declaration,
					// which the Java grammar never places inside a try header. The
					// real try-with-resources shapes are handled in the scope scan
					// below: a `resource` node naming this variable covers both
					// `try (Type x = …)` and the Java 9 `try (x)` form.)
					const scope =
						this.navigator.findParent(declaration, [
							"method_declaration",
							"constructor_declaration",
							"block",
						]) ?? rootNode;
					if (!scope) return true;
					// `\b` in a template literal is the BACKSPACE control char
					// (U+0008), not a regex word-boundary escape — that requires
					// the literal two-character sequence `\\b`. The identifier
					// itself must also be regex-escaped (#1089 P2).
					const resourceWord = new RegExp(`\\b${escapeRegExp(resource)}\\b`);
					const stack = [scope];
					for (
						let visited = 0;
						stack.length > 0 && visited < 10_000;
						visited++
					) {
						const node = stack.pop();
						if (!node) break;
						if (
							node.type === "method_invocation" &&
							node.childForFieldName?.("object")?.text === resource &&
							node.childForFieldName?.("name")?.text === "close"
						) {
							return false;
						}
						if (
							node.type === "resource" &&
							resourceWord.test(node.text ?? "")
						) {
							return false;
						}
						stack.push(...(node.children ?? []));
					}
					return true;
				} catch {
					return true;
				}
			}
			case "same_method_no_base_case": {
				try {
					const method = captures.NAME?.text ?? "";
					if (!method || captures.RECURSE?.text !== method) return false;
					const call = captures.CALL;
					const declaration = call
						? this.navigator.findParent(call, ["method_declaration"])
						: undefined;
					if (!declaration) return true;
					const stack = [declaration];
					for (
						let visited = 0;
						stack.length > 0 && visited < 10_000;
						visited++
					) {
						const node = stack.pop();
						if (!node) break;
						// Any conditional or loop construct is a plausible base-case
						// guard (#956 review: while/for-guarded recursion and ternary
						// base cases are common). This errs toward suppressing a
						// blocking diagnostic, never inventing one.
						if (
							node.type === "if_statement" ||
							node.type === "switch_expression" ||
							node.type === "switch_statement" ||
							node.type === "while_statement" ||
							node.type === "do_statement" ||
							node.type === "for_statement" ||
							node.type === "enhanced_for_statement" ||
							node.type === "ternary_expression"
						) {
							return false;
						}
						stack.push(...(node.children ?? []));
					}
					// Cap exhausted without a verdict: this rule is BLOCKING, so a
					// >10k-node method whose guard sits beyond the budget must not
					// become a silent blocking FP — suppress instead (#956 review;
					// the advisory filters keep their keep-the-diagnostic default).
					return stack.length > 0 ? false : true;
				} catch {
					return true;
				}
			}
			case "memset_for_sensitive_data": {
				try {
					const destination = captures.DEST?.text ?? "";
					const value = captures.VALUE?.text?.trim() ?? "";
					if (!/^(?:0|0x0+|NULL|nullptr)$/.test(value)) return false;
					return /(?:pass(?:word)?|passwd|secret|token|api_?key|private_?key|credential|auth|pin)/i.test(
						destination,
					);
				} catch {
					return true;
				}
			}
			case "unsafe_regex_dynamic_identifier": {
				// unsafe-regex is intentionally a coarse advisory heuristic. When the
				// interpolation is a plain identifier, recover the common safe-before-
				// assignment pattern without pretending to perform whole-program
				// dataflow. #949 review hardening: the LAST write (declarator or
				// assignment) textually BEFORE the use decides — a later reassignment
				// to user input un-suppresses, and an unrelated declaration after the
				// use never suppresses. Initializers come from the "value" field (a
				// type annotation is not an initializer), and bare .replace("a","b")
				// is not escaping — only escape-named callees or .replace(/regex/
				// count. Any internal error keeps the diagnostic: never silently
				// suppress via a filter crash, and a throw here would abort the whole
				// file's batch.
				try {
					const interpolationNode = captures.INTERPOLATION;
					const interpolation = interpolationNode?.text ?? "";
					const identifier = interpolation.match(
						/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/,
					)?.[1];
					if (!identifier || !rootNode || !interpolationNode) return true;
					const useRow = interpolationNode.startPosition.row;

					const hasEscapeSignal = (text: string): boolean =>
						/\b(?:escape|Escape)\w*\s*\(/.test(text) ||
						/\.\s*replace\s*\(\s*\//.test(text);

					// Track the last write to the identifier before the use site.
					let lastWriteRow = -1;
					let lastWriteSafe = false;
					const consider = (
						row: number,
						valueText: string | undefined,
					): void => {
						if (row >= useRow || row < lastWriteRow) return;
						lastWriteRow = row;
						lastWriteSafe =
							valueText !== undefined && hasEscapeSignal(valueText);
					};

					const stack: TreeSitterNode[] = [rootNode];
					while (stack.length > 0) {
						const node = stack.pop();
						if (!node) continue;
						if (node.type === "variable_declarator") {
							const name = node.childForFieldName?.("name");
							if (name?.text === identifier) {
								const initializer = node.childForFieldName?.("value");
								consider(node.startPosition.row, initializer?.text);
							}
						} else if (node.type === "assignment_expression") {
							const left = node.childForFieldName?.("left");
							if (left?.type === "identifier" && left.text === identifier) {
								const right = node.childForFieldName?.("right");
								consider(node.startPosition.row, right?.text);
							}
						}
						stack.push(...node.children);
					}
					return lastWriteRow >= 0 && lastWriteSafe ? false : true;
				} catch {
					return true;
				}
			}
			case "is_generator_with_valued_return": {
				const returnNode = captures.RETURN;
				const functionNode =
					captures.FUNCTION ??
					(returnNode
						? this.navigator.findParent(returnNode, ["function_definition"])
						: undefined);
				if (!functionNode) return false;
				// In the Python grammar, `async def` is also a function_definition with
				// an anonymous `async` child. Coroutines may return values normally;
				// only synchronous generator functions should be flagged.
				if (this.hasChildToken(functionNode, "async")) return false;
				return this.containsYieldInFunctionBody(functionNode);
			}
			case "count_params": {
				const paramsNode = captures.PARAMS;
				if (!paramsNode) return true;
				// Count only truly required params — exclude:
				//   • optional_parameter nodes (foo?: T) if the grammar uses that type
				//   • required_parameter nodes that have a "?" child (same semantic,
				//     different grammar version — web-tree-sitter-typescript collapses
				//     both into required_parameter with a "?" token child)
				//   • params with a default value (text contains "=")
				// biome-ignore lint/suspicious/noExplicitAny: Count parameter nodes
				const paramCount = paramsNode.children.filter((c: any) => {
					if (c.type !== "required_parameter") return false;
					if (c.text.includes("=")) return false;
					// biome-ignore lint/suspicious/noExplicitAny: child node check
					if (c.children?.some((ch: any) => ch.text === "?")) return false;
					return true;
				}).length;
				return paramCount >= (postFilterParams?.min_params ?? 6);
			}
			case "empty_body": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: Check for meaningful statements
				const meaningful = bodyNode.children.filter(
					(c: any) =>
						c.isNamed &&
						c.type !== "comment" &&
						c.type !== "line_comment" &&
						c.type !== "block_comment",
				);
				return meaningful.length === 0;
			}
			case "is_empty_block": {
				// empty-switch-case: keep a `switch_case` that has no body statements.
				// A switch_case's named children are `[value, ...body statements]`
				// (the case's statements are direct children, not a statement_block),
				// so an empty case is one whose only named child is its `case <value>`.
				// An empty case followed by another label is a fall-through group, not
				// a dead case — only the last label of a group carries the body.
				const caseNode = captures.CASE;
				if (!caseNode) return false;
				if (this.switchCaseBodyStatements(caseNode).length > 0) return false;
				return !this.nextSiblingIsSwitchLabel(caseNode);
			}
			case "no_break_or_return_in_body": {
				// infinite-loop: keep a `while(true)`/`for(;;)` whose body contains no
				// statement that can terminate the loop (break/return/throw). `continue`
				// does not count — it keeps the loop running.
				const bodyNode = captures.BODY;
				if (!bodyNode) return false;
				return !this.bodyHasLoopExit(bodyNode, false);
			}
			case "same_param_name": {
				// duplicate-function-arg: keep the pair when the captured binding
				// patterns share any name.
				const first = this.bindingNames(captures.PARAM1);
				const second = this.bindingNames(captures.NAME);
				return [...first].some((name) => second.has(name));
			}
			case "no_terminating_statement": {
				// switch-case-termination: keep a non-empty case (already known to be
				// followed by another case via the query) whose last body statement
				// does not terminate, i.e. it falls through. Empty cases are handled
				// by empty-switch-case, so require at least one body statement here.
				// An intentional `// fallthrough` marker suppresses the finding.
				const caseNode = captures.CASE;
				if (!caseNode) return false;
				if (this.hasFallthroughMarker(caseNode)) return false;
				const body = this.switchCaseBodyStatements(caseNode);
				if (body.length === 0) return false;
				return !this.statementTerminates(body[body.length - 1]);
			}
			case "no_break_or_return": {
				// infinite-loop-java: keep a `while(true)`/`for(;;)` whose body has no
				// break/return/throw reachable in this loop's scope.
				const bodyNode = captures.BODY;
				if (!bodyNode) return false;
				return !this.bodyHasLoopExit(bodyNode, false);
			}
			case "is_double_checked_locking": {
				// no-double-checked-locking: the query pins the if→synchronized→if
				// shape; keep it only when both null-checks test the same field.
				const outer = captures.FIELD?.text;
				const inner = captures.FIELD2?.text;
				return !!outer && outer === inner;
			}
			case "shadows_parent_field": {
				// no-field-shadowing: keep only when the named parent class is
				// declared in the same file and it declares a field with the same
				// name. Cross-file inheritance can't be resolved here — fail closed.
				const parentName = captures.PARENT?.text;
				const fieldName = captures.NAME?.text;
				if (!parentName || !fieldName) return false;
				// biome-ignore lint/suspicious/noExplicitAny: AST traversal
				let root: any = captures.NAME;
				while (root.parent) root = root.parent;
				// biome-ignore lint/suspicious/noExplicitAny: AST traversal
				const stack: any[] = [root];
				while (stack.length) {
					const node = stack.pop();
					if (
						node.type === "class_declaration" &&
						node.childForFieldName?.("name")?.text === parentName
					) {
						const body = node.childForFieldName?.("body");
						for (const member of body?.children ?? []) {
							if (member.type !== "field_declaration") continue;
							for (const declarator of member.children ?? []) {
								if (
									declarator.type === "variable_declarator" &&
									declarator.childForFieldName?.("name")?.text === fieldName
								) {
									return true;
								}
							}
						}
					}
					for (const child of node.children ?? []) stack.push(child);
				}
				return false;
			}
			case "missing_break_between_cases": {
				// switch-fall-through: keep when the labeled statement group contains
				// no terminating statement at all — its control flow reaches the next
				// case. The query already requires a following group.
				const label = captures.LABEL;
				const group = label?.parent;
				if (!group) return false;
				const TERMINATORS = new Set([
					"break_statement",
					"return_statement",
					"throw_statement",
					"continue_statement",
					"yield_statement",
				]);
				for (const child of group.children ?? []) {
					if (TERMINATORS.has(child.type)) return false;
				}
				return true;
			}
			case "scoped_lock_empty_args": {
				// no-scoped-lock-without-args: the query only matches a bare
				// `declarator: (identifier)` — an arg-taking declaration parses as an
				// init/function declarator instead — so a match IS the defect. Keep it
				// as long as the captured declarator has no sibling argument list.
				const decl = captures.DECL;
				if (!decl) return false;
				for (const sibling of decl.parent?.children ?? []) {
					if (sibling.type === "argument_list") return false;
				}
				return true;
			}
			case "calc_missing_spaces": {
				// calc-spacing: keep a calc() whose +/- has an operand directly on
				// both sides (e.g. `100%-20px`). A leading sign after `(` or a comma
				// is legitimate and stays allowed.
				const text = captures.EXPR?.text ?? "";
				return /[\w%)][+-][\w.(]/.test(text);
			}
			case "bare_except_only": {
				const clauseNode = captures.CLAUSE;
				if (!clauseNode) return true;
				// A typed `except` clause has a named child for the exception
				// spec — one of: identifier (e.g. `except ValueError`),
				// attribute (e.g. `except asyncio.TimeoutError` — dotted name),
				// tuple (e.g. `except (E, F)`), as_pattern (e.g. `except E as e`),
				// parenthesized_expression (e.g. `except (E)`), or subscript
				// (e.g. `except dict[str, int]` — #1244, mirrors the ast-grep
				// rule's shape space).
				// Bare `except:` has NO named children (just the `except` keyword,
				// the `:` colon, and the body block).
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const hasExceptionSpec = clauseNode.children.some((c: any) => {
					if (!c.isNamed) return false;
					return c.type !== "block";
				});
				// Fire ONLY when bare (no exception spec)
				return !hasExceptionSpec;
			}
			case "eq_mod_fn": {
				// Belt-and-braces re-check of the #eq? predicates that
				// evaluatePredicates already enforces (clients/tree-sitter-client.ts).
				// This filter re-applies the #eq? checks at post_filter time.
				const mod = captures.MOD?.text ?? "";
				const fn = captures.FN?.text ?? "";
				return mod === "threading" && fn === "Thread";
			}
			case "regex_first_arg_identifier": {
				// Belt-and-braces re-check of the #eq?/#match? predicates that
				// evaluatePredicates already enforces, plus the first-argument
				// check that predicates can't express. This post_filter re-applies
				// both predicate checks AND the first-argument check:
				// 1. MOD must be "re"  (would-be #eq? @MOD "re")
				// 2. FUNC must match the regex method pattern (#match? @FUNC ...)
				// 3. First arg must be an identifier (dynamic pattern)
				//    String literals (r"...", "...") are safe static patterns.
				const mod = captures.MOD?.text ?? "";
				if (mod !== "re") return false;
				const func = captures.FUNC?.text ?? "";
				if (
					!/^(compile|match|search|fullmatch|findall|finditer|sub|subn|split)$/.test(
						func,
					)
				) {
					return false;
				}
				const argsNode = captures.ARGS;
				if (!argsNode) return false;
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const firstNamed = (argsNode.children ?? []).find(
					(c: any) => c.isNamed,
				);
				if (!firstNamed) return false;
				return firstNamed.type === "identifier";
			}
			case "open_mode_invalid": {
				const modeNode = captures.MODE;
				if (!modeNode) return false;
				// Python's open() mode accepts: r, w, a, x (basic), b/t/+ (suffix).
				// Strip surrounding quotes from the string literal text.
				const text = modeNode.text ?? "";
				const stripped = text.replace(/^["']|["']$/g, "");
				// Skip empty mode (defaults to 'r')
				if (stripped.length === 0) return false;
				// Skip single-char modes (r/w/a/x — always valid)
				if (stripped.length === 1) return false;
				// Must contain only valid characters
				if (!/^[rwxabt+]+$/.test(stripped)) return true;
				// Multi-char must be exactly: basic + optional (b|t) + optional +
				// Examples valid: "rb", "rb+", "r+", "ab", "rt"
				// Examples invalid: "rwb", "rrr", "rw", "rbb" (no + between r and w is invalid)
				// The "rw" case (basic mode followed by another basic mode without +) is invalid
				// Allow: [basic][bt]?[+]
				const validShape = /^[rwax][bt]?\+?$/;
				if (!validShape.test(stripped)) return true;
				return false;
			}
			case "status_204_with_value_return": {
				const funcNode = captures.FUNC;
				const valNode = captures.VAL;
				if (!funcNode || !valNode) return false;
				// Only fire if status_code=204
				if (Number(valNode.text ?? 0) !== 204) return false;
				// Walk the function subtree looking for return_statement nodes.
				// Manual BFS because web-tree-sitter doesn't expose
				// descendantsOfType directly.
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node iteration
				const queue: any[] = [funcNode];
				while (queue.length > 0) {
					const node = queue.shift();
					if (node.type === "return_statement") {
						// Has a value child (not just the `return` keyword)
						// biome-ignore lint/suspicious/noExplicitAny: child check
						const hasValue = node.children.some(
							(c: any) => c.isNamed && c.type !== "comment",
						);
						if (hasValue) return true;
					}
					// biome-ignore lint/suspicious/noExplicitAny: child queue
					if (node.children) queue.push(...node.children);
				}
				return false;
			}
			case "has_mixed_async": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				const bodyText = bodyNode.text;
				return (
					bodyText.includes("await") && /\.\s*(then|catch)\s*\(/.test(bodyText)
				);
			}
			case "format_arity_mismatch": {
				const formatNode = captures.FORMAT;
				const argsNode = captures.ARGS;
				if (!formatNode || !argsNode) return false;
				// Strip quotes from format string
				const fmtText = (formatNode.text ?? "").replace(/^["']|["']$/g, "");
				// Don't strip a leading "%" — the format string's contents are
				// intact after stripping only the surrounding quotes. The original
				// code stripped the first "%" thinking it was the operator, but
				// the operator is a separate binary_operator node, not part of
				// the string literal's text.
				const fmt = fmtText;
				// Count placeholders: %s, %d, %f, %(name)s, %i, etc.
				// The simple %s/%d style: each %X counts as 1
				// The %(name)s style: counts as 1 with name
				// The %% escape: doesn't count
				let placeholderCount = 0;
				const namedKeys: string[] = [];
				// biome-ignore lint/suspicious/noExplicitAny: regex match
				const positionalRegex =
					/%(?:\([^)]+\))?[#0\- +]*\d*(?:\.\d+)?[hlL]?[diouxXeEfFgGcrs%]/g;
				// biome-ignore lint/suspicious/noExplicitAny: regex match
				const positionalMatches = fmt.match(positionalRegex) ?? [];
				for (const m of positionalMatches) {
					if (m === "%%") continue;
					placeholderCount++;
					// biome-ignore lint/suspicious/noExplicitAny: capture group
					const namedMatch = m.match(/^%\(([^)]+)\)/);
					if (namedMatch) namedKeys.push(namedMatch[1]);
				}
				// If format uses named placeholders, RHS should be a dict
				if (namedKeys.length > 0) {
					// Check if dict contains all named keys
					if (argsNode.type === "dictionary") {
						// biome-ignore lint/suspicious/noExplicitAny: AST iteration
						const dictKeys: string[] = [];
						for (const child of argsNode.children ?? []) {
							// biome-ignore lint/suspicious/noExplicitAny: child check
							if (child.type === "pair" && child.children?.[0]) {
								// biome-ignore lint/suspicious/noExplicitAny: child text
								// Strip quotes — child is a string literal node,
								// text includes the surrounding "...".
								dictKeys.push(
									(child.children[0].text ?? "").replace(/^["']|["']$/g, ""),
								);
							}
						}
						const missing = namedKeys.filter((k) => !dictKeys.includes(k));
						return missing.length > 0;
					}
					// Format uses named but RHS isn't a dict — definitely wrong
					return true;
				}
				// Positional: count tuple args
				if (argsNode.type === "tuple") {
					const argCount = (argsNode.children ?? []).filter(
						(c: any) => c.isNamed,
					).length;
					if (argCount !== placeholderCount) return true;
				}
				return false;
			}
			case "aws_policy_public": {
				const policyNode = captures.POLICY;
				if (!policyNode) return false;
				const text = policyNode.text ?? "";
				// Match patterns indicating public access
				const patterns = [
					/"Principal"\s*:\s*"\*"/, // direct wildcard
					/"Principal"\s*:\s*\{\s*"AWS"\s*:\s*"\*"\s*\}/, // AWS wildcard
					/"Effect"\s*:\s*"Allow"[\s\S]*?"Action"\s*:\s*"\*"[\s\S]*?"Resource"\s*:\s*"\*"/, // full admin
					/"Principal"\s*:\s*"\*"/,
				];
				return patterns.some((p) => p.test(text));
			}
			case "slots_attribute_mismatch": {
				const selfNode = captures.SELF;
				const attrNode = captures.ATTR;
				const methodNode = captures.METHOD;
				if (!selfNode || !attrNode || !methodNode) return false;
				// Only consider self.X = (not other.X)
				if (selfNode.text !== "self") return false;
				const attrName = attrNode.text ?? "";
				// Find parent class_definition
				// biome-ignore lint/suspicious/noExplicitAny: AST navigation
				let parent = methodNode.parent;
				while (parent && parent.type !== "class_definition") {
					parent = parent.parent;
				}
				if (!parent) return false;
				// Parse the class's __slots__ list and check if attrName is in it.
				// Fires ONLY when self.X = ... assigns to an attribute NOT in __slots__
				// (a real S8494 violation — the assignment will raise AttributeError).
				const slots = extractSlots(parent);
				// null = no __slots__ declared in this class. [] = __slots__ declared
				// but we couldn't parse it (treat as null to avoid FPs on inner-class
				// parent walks where the parent text mentions __slots__ but the
				// direct children don't contain the assignment).
				if (slots === null || slots.length === 0) return false;
				return !slots.includes(attrName);
			}
			case "special_method_arity": {
				const nameNode = captures.NAME;
				const paramsNode = captures.PARAMS;
				if (!nameNode || !paramsNode) return false;
				const name = nameNode.text ?? "";
				// Expected arities: {method_name: expected_arg_count}
				// (excluding `self`/`cls` which is always 1)
				const expected: Record<string, number> = {
					__del__: 0,
					__repr__: 0,
					__str__: 0,
					__hash__: 0,
					__bool__: 0,
					__len__: 0,
					__eq__: 1,
					__lt__: 1,
					__le__: 1,
					__gt__: 1,
					__ge__: 1,
					__ne__: 1,
				};
				const expectedCount = expected[name];
				if (expectedCount === undefined) return false; // not in our list
				// Count required params (excluding defaults)
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const paramCount = (paramsNode.children ?? []).filter((c: any) => {
					if (c.type !== "identifier" && c.type !== "typed_parameter")
						return false;
					if (c.text.includes("=")) return false;
					return true;
				}).length;
				// Expected total = expectedCount + 1 (for self/cls)
				return paramCount !== expectedCount + 1;
			}
			case "no_super_call": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				return !/(?<!\/\/.*)super\s*\(/.test(bodyNode.text);
			}
			case "in_test_block": {
				const first = Object.values(captures)[0];
				return !!first && this.navigator.isInTestBlock(first);
			}
			case "not_in_test_block": {
				const first = Object.values(captures)[0];
				return !first || !this.navigator.isInTestBlock(first);
			}
			case "not_in_try_catch": {
				const first = Object.values(captures)[0];
				return !first || !this.navigator.isInTryCatch(first);
			}
			case "in_try_catch": {
				const first = Object.values(captures)[0];
				return !!first && this.navigator.isInTryCatch(first);
			}
			case "name_matches_param": {
				const nameNode = captures.NAME;
				const paramNode = captures.PARAM;
				return !!nameNode && !!paramNode && nameNode.text === paramNode.text;
			}
			case "not_in_function": {
				const first = Object.values(captures)[0];
				return (
					!first ||
					!this.navigator.isInside(first, [
						"function_definition",
						"function_declaration",
						"method_definition",
						"arrow_function",
					])
				);
			}
			case "check_secret_pattern": {
				const varName = captures.VARNAME?.text ?? "";
				const varNameLower = varName.toLowerCase();
				// Skip UPPER_CASE constants — they're module-level constants
				// (e.g. `GITHUB_TYPE_FOR_PERSONAL_API_KEY = "..."`), not secrets.
				// A constant has no lowercase letters in its name.
				if (varName === varName.toUpperCase() && /[A-Z]/.test(varName)) {
					return false;
				}
				return [
					/api[_-]?key/,
					/api[_-]?secret/,
					/password/,
					/passwd/,
					/secret/,
					/token/,
					/auth/,
					/private[_-]?key/,
					/access[_-]?token/,
					/credentials/,
					/aws[_-]?secret/,
					/github[_-]?token/,
					/client[_-]?secret/,
				].some((p) => p.test(varNameLower));
			}
			case "returns_error": {
				const first = Object.values(captures)[0];
				if (!first) return false;
				const funcNode = this.navigator.findParent(first, [
					"function_declaration",
					"method_declaration",
				]);
				if (!funcNode) return false;
				const signature =
					String(funcNode.text ?? "")
						.split("{", 1)[0]
						?.trim() ?? "";
				const returnPart =
					signature
						.match(
							/func\s*(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^)]*\)\s*(.*)$/s,
						)?.[1]
						?.trim() ?? "";
				return returnPart.length > 0 && /\berror\b/.test(returnPart);
			}
			case "python_empty_except": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
				return !bodyNode.children.some(
					(c: any) =>
						c.isNamed && c.type !== "pass_statement" && c.type !== "comment",
				);
			}
			case "check_in_operator_types": {
				// `in`/`not in` require __contains__, __iter__ or __getitem__. We can't
				// do real type inference from a bare identifier, so only flag when the
				// right-hand side is a literal of a type known NOT to support
				// containment (None, bool, int, float) — identifiers, strings, lists,
				// dicts, sets, tuples etc. are left alone to avoid false positives.
				const target = captures.TARGET;
				if (!target) return false;
				return ["none", "true", "false", "integer", "float"].includes(
					target.type,
				);
			}
			case "torchscript_super_call": {
				// The query only anchors on the `super()` call itself (so it can find
				// it at any nesting depth inside the method body); this filter walks
				// back up to confirm the enclosing method OR its class actually carries
				// a @torch.jit.script / @jit.script decorator.
				const call = captures.CALL;
				if (!call) return false;
				const isTorchScriptDecorated = (
					node: TreeSitterNode | null | undefined,
				): boolean => {
					const decorated = node?.parent;
					if (!decorated || decorated.type !== "decorated_definition")
						return false;
					// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
					return (decorated.children ?? []).some(
						(c: any) =>
							c.type === "decorator" &&
							/^@(torch\.jit\.script|jit\.script)$/.test(c.text ?? ""),
					);
				};
				const methodNode = this.navigator.findParent(call, [
					"function_definition",
				]);
				if (!methodNode) return false;
				const classNode = this.navigator.findParent(methodNode, [
					"class_definition",
				]);
				return (
					isTorchScriptDecorated(methodNode) ||
					isTorchScriptDecorated(classNode)
				);
			}
			case "exit_params_insufficient": {
				// __exit__ must accept (self, exc_type, exc_value, traceback) — 4 named
				// parameters total. The query captures the whole `parameters` node
				// rather than binding each slot individually: tree-sitter's optional
				// (`?`) quantifiers on consecutive anchored siblings match every valid
				// sub-alignment (e.g. self+exc_type alone, or self+exc_type+exc_value),
				// not just the maximal one, so per-slot captures produce spurious
				// duplicate/partial matches for a single, fully-correct signature.
				// Counting named children of the whole node sidesteps that entirely.
				const params = captures.PARAMS;
				if (!params) return true;
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
				const named = (params.children ?? []).filter((c: any) => c.isNamed);
				// `def __exit__(self, *args)` / `(self, *exc_info)` are valid: the splat
				// absorbs the whole exception triple, so it satisfies every remaining
				// slot no matter how few named children the node has.
				if (
					named.some(
						(c) =>
							c.type === "list_splat_pattern" ||
							c.type === "dictionary_splat_pattern",
					)
				) {
					return false;
				}
				return named.length < 4;
			}
			case "ruby_empty_rescue": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
				return !bodyNode.children.some(
					(c: any) =>
						c.isNamed && !["comment", "nil", "nil_literal"].includes(c.type),
				);
			}
			case "ts_command_injection_sink":
				return (
					captures.MOD?.text === "child_process" &&
					/^(exec|execSync)$/.test(captures.FN?.text ?? "")
				);
			case "ts_ssrf_sink": {
				const fn = captures.FN?.text ?? "";
				const obj = captures.OBJ?.text ?? "";
				const urlText = captures.URL?.text ?? "";
				const allowedFns = new Set([
					"fetch",
					"request",
					"get",
					"post",
					"put",
					"patch",
					"delete",
				]);
				if (!allowedFns.has(fn)) return false;
				// A bare identifier that provably resolves (in this file) to a
				// `const` initialized with a fixed string/template literal is a
				// genuinely fixed URL — exempt it regardless of naming
				// convention (SCREAMING_SNAKE_CASE proves nothing about
				// provenance; see #963). Anything we cannot definitively prove
				// falls through to the existing broad heuristic below, so
				// member expressions, non-literal consts, reassigned
				// bindings, and unresolved identifiers all keep being
				// evaluated for taint as before — a false positive here is
				// acceptable, a missed SSRF is not.
				if (
					rootNode &&
					captures.URL?.type === "identifier" &&
					this.resolvesToFileLiteralConst(urlText, rootNode)
				) {
					return false;
				}
				// `fetch(u.toString())` / `fetch(u.href)` where `u` is a file-local
				// `const u = new URL(<literalPath>, <fixedBase>)`. The origin+path are
				// fully fixed; dynamic query params set later via
				// `u.searchParams.set(...)` don't control the destination. Anything we
				// cannot prove fixed (param/env/member/tainted base) falls through to
				// the broad heuristic and still fires. See #1000.
				if (rootNode && captures.URL) {
					const urlVar = this.newUrlBaseVarName(captures.URL);
					if (urlVar && this.resolvesToFixedNewUrlConst(urlVar, rootNode)) {
						return false;
					}
				}
				// Only flag when the URL argument looks like it could carry external
				// input: member expressions (req.url, ctx.query.x) or identifiers
				// whose names suggest user/external provenance. Plain generic names
				// like `url` or `path` in internal download utilities produce too
				// many false positives — those need data-flow analysis to resolve.
				const looksLikeExternalInput =
					urlText.includes(".") ||
					/user|external|remote|input|target|webhook|callback|redirect|untrusted|arbitrary/i.test(
						urlText,
					);
				if (!looksLikeExternalInput) return false;
				if (!obj) return fn === "fetch";
				return new Set([
					"axios",
					"http",
					"https",
					"got",
					"request",
					"superagent",
					"undici",
				]).has(obj);
			}
			case "ts_weak_hash_algorithm":
				return (
					captures.FN?.text === "createHash" &&
					/^(md5|sha1)$/i.test(captures.ALG?.text ?? "")
				);
			case "ts_insecure_random_source": {
				if (captures.OBJ?.text !== "Math" || captures.FN?.text !== "random")
					return false;
				// Only flag when the result flows into a security-sensitive binding.
				// Walk up from the `Math.random()` call so chained forms such as
				// `Math.random().toString(36)` are still attributed to their binding.
				const varName = this.enclosingBindingName(
					captures.CALL ?? captures.VAR,
				);
				return /token|secret|password|key|nonce|salt|csrf|auth|session|credential|hash|otp|pin/i.test(
					varName,
				);
			}
			case "ts_detached_async_call":
				return /(Async$|fetch$|request$)/.test(captures.FN?.text ?? "");
			case "incomplete_assertion": {
				const expectNode = captures.EXPECT;
				if (!expectNode) return false;
				const CHAI_PROPERTY_ASSERTIONS = new Set([
					"true",
					"false",
					"null",
					"undefined",
					"empty",
					"NaN",
					"finite",
					"exist",
					"arguments",
					"extensible",
					"sealed",
					"frozen",
					"locked",
				]);
				// The expect identifier is inside a call_expression. Walk up past that
				// call_expression to the container that determines if it's a complete
				// assertion or an incomplete one.
				let current: TreeSitterNode | null | undefined = expectNode.parent;
				if (!current) return false;
				current = current.parent; // skip the expect(...) call_expression
				if (!current) return false;
				// Bare expect(foo); or return expect(foo);
				if (
					current.type === "expression_statement" ||
					current.type === "return_statement"
				)
					return true;
				let lastPropertyName: string | null = null;
				while (current && current.type === "member_expression") {
					const propNode = current.children?.find(
						(c: any) => c.type === "property_identifier",
					);
					if (propNode) lastPropertyName = propNode.text;
					const parent: TreeSitterNode | null | undefined = current.parent;
					if (!parent) return false;
					if (
						parent.type === "expression_statement" ||
						parent.type === "return_statement"
					) {
						if (
							lastPropertyName &&
							CHAI_PROPERTY_ASSERTIONS.has(lastPropertyName)
						)
							return false;
						return true;
					}
					if (parent.type === "call_expression") return false;
					current = parent;
				}
				return false;
			}
			case "py_command_injection_sink": {
				const mod = captures.MOD?.text ?? "";
				const fn = captures.FN?.text ?? "";
				const kw = captures.KW?.text ?? "";
				return (
					(mod === "os" && /^(system|popen)$/.test(fn)) ||
					(mod === "subprocess" &&
						/^(run|Popen|call|check_output|check_call)$/.test(fn) &&
						kw === "shell")
				);
			}
			case "go_command_injection_sink":
				return (
					captures.PKG?.text === "exec" &&
					/^(Command|CommandContext)$/.test(captures.FN?.text ?? "") &&
					/^"(sh|bash|zsh|cmd|powershell|pwsh)"$/.test(
						captures.SHELL?.text ?? "",
					) &&
					/^"(-c|\/c)"$/.test(captures.FLAG?.text ?? "")
				);
			case "ruby_command_injection_sink":
				return /^(system|exec|spawn|popen|capture3|capture2|capture2e)$/.test(
					captures.FN?.text ?? "",
				);
			case "py_ssrf_sink":
				return (
					captures.MOD?.text === "requests" &&
					/^(get|post|put|patch|delete|request|head|options)$/.test(
						captures.FN?.text ?? "",
					)
				);
			case "py_path_traversal_sink":
				return /^(open|read_text|read_bytes|write_text|write_bytes|remove|unlink|rmdir)$/.test(
					captures.FN?.text ?? "",
				);
			case "go_path_traversal_sink":
				return (
					/^(os|ioutil)$/.test(captures.PKG?.text ?? "") &&
					/^(Open|OpenFile|ReadFile|WriteFile|Create|Remove|RemoveAll)$/.test(
						captures.FN?.text ?? "",
					)
				);
			case "py_hallucinated_import": {
				const moduleName = captures.MODULE?.text ?? "";
				const importedName = captures.NAME?.text ?? "";
				return isKnownPythonHallucinatedImport(moduleName, importedName);
			}
			case "py_sql_injection_sink": {
				const fn = captures.FN?.text ?? "";
				if (!PYTHON_SQL_SINK_METHODS.has(fn)) return false;

				if (
					fn === "query" &&
					isProvenSqlAlchemySessionReceiver(captures.OBJ, rootNode)
				) {
					return false;
				}
				if (isSafePsycopgIdentifierComposition(captures.SQL, rootNode)) {
					return false;
				}
				return true;
			}
			case "go_sql_injection_sink":
				return (
					/^(Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext)$/.test(
						captures.DBFN?.text ?? "",
					) &&
					captures.FMTPKG?.text === "fmt" &&
					captures.FMTFN?.text === "Sprintf"
				);
			case "py_insecure_deserialization_sink":
				return (
					/^(pickle|yaml)$/.test(captures.MOD?.text ?? "") &&
					/^(load|loads|unsafe_load)$/.test(captures.FN?.text ?? "")
				);
			case "ruby_insecure_deserialization_sink":
				return (
					/^(Marshal|YAML|Psych)$/.test(captures.MOD?.text ?? "") &&
					/^(load|unsafe_load)$/.test(captures.FN?.text ?? "")
				);
			case "match_captures": {
				// Generic filter: each key in postFilterParams is a capture name,
				// value is a regex string. All must match.
				for (const [captureName, pattern] of Object.entries(
					postFilterParams ?? {},
				)) {
					const node = captures[captureName];
					if (!node) return false;
					if (!new RegExp(pattern as string).test(node.text)) return false;
				}
				return true;
			}
			case "case_range_single_value": {
				const start = captures.START?.text ?? "";
				const end = captures.END?.text ?? "";
				return start === end;
			}
			case "goto_jumps_backward": {
				const label = captures.LABEL;
				const gotoNode = captures.GOTO;
				if (!label || !gotoNode) return false;
				return label.startIndex < gotoNode.startIndex;
			}
			case "goto_targets_inner_block": {
				const target = captures.TARGET;
				if (!target) return false;
				// A goto targets an inner block if its label is inside a
				// compound_statement that is nested inside another compound_statement.
				let depth = 0;
				let node: TreeSitterNode | null | undefined = target.parent;
				while (node) {
					if (node.type === "compound_statement") depth++;
					node = node.parent;
				}
				return depth >= 2;
			}
			case "c_memset_sensitive_arg": {
				const callNode = captures.CALL;
				if (!callNode || callNode.type !== "call_expression") return false;
				// Find the first argument in the argument_list
				const argList = callNode.children?.find(
					(c: any) => c.type === "argument_list",
				);
				if (!argList) return false;
				// First named child after the opening paren is the first arg
				const firstArg = argList.children?.find((c: any) => c.isNamed);
				if (!firstArg) return false;
				const argName = firstArg.text ?? "";
				return /password|secret|key|token|credential|auth|private|passwd|pin|salt|nonce|iv|seed/i.test(
					argName,
				);
			}
			case "c_stdlib_name": {
				const name = captures.NAME?.text ?? "";
				const STDLIB_NAMES = new Set([
					"malloc",
					"calloc",
					"realloc",
					"free",
					"alloca",
					"printf",
					"fprintf",
					"sprintf",
					"snprintf",
					"vprintf",
					"vfprintf",
					"vsprintf",
					"vsnprintf",
					"scanf",
					"fscanf",
					"sscanf",
					"vscanf",
					"vfscanf",
					"vsscanf",
					"strcpy",
					"strncpy",
					"strcat",
					"strncat",
					"strcmp",
					"strncmp",
					"strlen",
					"strchr",
					"strrchr",
					"strstr",
					"strerror",
					"memcpy",
					"memmove",
					"memset",
					"memcmp",
					"memchr",
					"fopen",
					"fclose",
					"fread",
					"fwrite",
					"fgets",
					"fputs",
					"getc",
					"putc",
					"getchar",
					"putchar",
					"exit",
					"abort",
					"assert",
					"errno",
					"abs",
					"labs",
					"llabs",
					"div",
					"ldiv",
					"lldiv",
					"atoi",
					"atol",
					"atoll",
					"strtol",
					"strtoll",
					"strtoul",
					"strtoull",
					"strtod",
					"strtof",
					"strtold",
					"qsort",
					"bsearch",
					"time",
					"clock",
					"difftime",
					"mktime",
					"strftime",
					"getenv",
					"setenv",
					"putenv",
					"system",
					"isalpha",
					"isdigit",
					"isalnum",
					"isspace",
					"isupper",
					"islower",
					"toupper",
					"tolower",
					"sizeof",
					"offsetof",
					"NULL",
					"EXIT_SUCCESS",
					"EXIT_FAILURE",
				]);
				return STDLIB_NAMES.has(name);
			}
			case "c_octal_literal": {
				const num = captures.NUM?.text ?? "";
				return /^0[0-7]+$/.test(num);
			}
			case "c_noreturn_attr": {
				const attr = captures.ATTR?.text ?? "";
				return attr === "noreturn";
			}
			case "c_label_in_switch": {
				const stmt = captures.STMT;
				if (!stmt) return false;
				let node: TreeSitterNode | null | undefined = stmt.parent;
				while (node) {
					if (node.type === "switch_statement") return true;
					node = node.parent;
				}
				return false;
			}
			default:
				// A rule whose post_filter has no implementation cannot honour its
				// own definition, so DROP the match instead of reporting every raw
				// structural hit. Failing open here made `duplicate-function-arg`
				// (`same_param_name`, unimplemented) fire on 59 of 60 files that
				// contain no duplicate parameter at all.
				this.reportMissingPostFilter(postFilter);
				return false;
		}
	}

	private reportedMissingPostFilters = new Set<string>();
	private reportedPostFilterFailures = new Set<string>();

	/** Keep a failed post-filter match and leave a bounded diagnostic trail. */
	private reportPostFilterFailure(postFilter: string, reason: string): void {
		if (this.reportedPostFilterFailures.has(postFilter)) return;
		this.reportedPostFilterFailures.add(postFilter);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			message:
				`tree-sitter rule post_filter '${postFilter}' failed — ` +
				`keeping the diagnostic (fail-open): ${reason}.`,
			metadata: { postFilter },
		});
	}

	/** Warn once per unimplemented post_filter — a silent rule needs a trail. */
	private reportMissingPostFilter(postFilter: string): void {
		if (this.reportedMissingPostFilters.has(postFilter)) return;
		this.reportedMissingPostFilters.add(postFilter);
		logTreeSitterDiagnostic({
			subsystem: "tree-sitter-client",
			message:
				`tree-sitter rule post_filter '${postFilter}' is not implemented — ` +
				`matches for the rules using it are suppressed rather than reported unfiltered. ` +
				`Implement it in applyPostFilter (clients/tree-sitter-client.ts) to re-enable them.`,
			metadata: { postFilter },
		});
	}

	/**
	 * Latch so the "textPredicates is malformed" diagnostic log line fires once
	 * per `TreeSitterClient` instance for the life of the process (this client is
	 * a process-wide singleton in production — see clients/tree-sitter-shared.ts),
	 * not once per call. This gates ONLY the log line: process-wide log volume is
	 * the concern here, not the user-facing degradation record below, which must
	 * re-arm every session (see recordDegradationOnce) — including for a Query
	 * object the LRU query cache (queryCache/queryBatchCache above) kept alive
	 * across a session boundary, since the cache is evicted, never cleared.
	 */
	private textPredicatesInvalidLogged = false;

	/**
	 * Typed accessor for `query.textPredicates`. If the property is missing or the
	 * wrong shape — e.g. a future web-tree-sitter upgrade renames or removes it —
	 * `query.textPredicates?.[i] ?? []` would silently mean "no predicates for this
	 * pattern," passing every match through unfiltered. That's a silent fail-open on
	 * #match?/#eq? predicates that rules rely on for correctness, and because this
	 * runs for every match of every query, it would zero out ALL structural matches
	 * across every language while pi-lens reports "no issues found." Fail loud (log
	 * once per client instance, record a degradation so it reaches the user) and
	 * closed (report the query has no usable predicates) instead of guessing.
	 *
	 * No WeakSet short-circuit for already-known-bad queries here (#1523 review
	 * R1): `Array.isArray` is O(1), so memoizing it buys nothing, and a
	 * process-lifetime WeakSet would make the SAME cached Query object (the query
	 * cache is LRU-evicted, never cleared) skip straight past
	 * `recordDegradationOnce` on every call after the first — which is exactly
	 * what made the degradation record fail to re-arm across a session boundary
	 * for a query the cache kept warm. `recordDegradationOnce` itself is called
	 * unconditionally on every invalid check; the ledger's own once-per-kind/
	 * subject dedupe (cleared by resetDegradationLedger, which handleSessionStart
	 * calls first thing — clients/runtime-session.ts) is the single source of
	 * truth for "how often does this actually get recorded."
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter Query instances
	private hasValidTextPredicates(query: any): boolean {
		const valid = Array.isArray(query?.textPredicates);
		if (!valid) {
			if (!this.textPredicatesInvalidLogged) {
				this.textPredicatesInvalidLogged = true;
				logTreeSitterDiagnostic({
					subsystem: "tree-sitter-client",
					message:
						"web-tree-sitter Query.textPredicates is missing or not an array — " +
						"#match?/#eq? predicates cannot be evaluated. Failing CLOSED: matches " +
						"for this query are dropped rather than reported unfiltered.",
					metadata: { textPredicatesType: typeof query?.textPredicates },
				});
			}
			// User-facing signal (#1523 review F1). Called unconditionally on every
			// invalid check (not gated by a client-lifetime latch) so it re-arms
			// every session, per the R1 fix above.
			recordDegradationOnce({
				kind: "query-predicates-invalid",
				subject: "web-tree-sitter",
				reason:
					"Query.textPredicates is missing or not an array — #match?/#eq? " +
					"predicates cannot be evaluated; structural matches relying on them " +
					"are dropped fail-closed",
			});
		}
		return valid;
	}

	/**
	 * Evaluate text predicates (#match?, #eq?) for a query match. web-tree-sitter
	 * 0.25's `Query.matches()` DOES apply these predicates itself (probed on the
	 * shipped grammars — see clients/tree-sitter-symbol-extractor.ts), so this is a
	 * belt-and-braces re-filter, not a workaround for missing enforcement. It also
	 * doubles as the fail-closed guard (#1523): if `query.textPredicates` is ever
	 * missing or malformed, this drops the match instead of assuming it already
	 * passed upstream.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter types
	private evaluatePredicates(query: any, match: any): boolean {
		if (!this.hasValidTextPredicates(query)) return false;
		// `?.` guards a post-validation removal of the property (e.g. a later
		// mutation strips it after the first successful check) so the read can't
		// throw here — an uncaught throw would be swallowed by the outer try/catch
		// in searchFileWithQuery and silently zero out matches for the whole file.
		const predicates: Array<(captures: unknown) => boolean> =
			query.textPredicates?.[match.patternIndex] ?? [];
		return predicates.every((fn) => fn(match.captures));
	}

	/** Search a single file using tree-sitter Query */
	private async searchFileWithQuery(
		filePath: string,
		// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
		query: any,
		metavars: string[],
		languageId: string,
		_originalPattern?: string,
		postFilter?: string,
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any,
		contentOverride?: string,
	): Promise<StructuralMatch[]> {
		const matches: StructuralMatch[] = [];

		await this.parseFileAndUse(
			filePath,
			languageId,
			contentOverride,
			(tree) => {
				try {
					const rootNode = tree.rootNode;
					const queryMatches = query.matches(rootNode);

					for (const match of queryMatches) {
						const captures: Record<string, TreeSitterNode> = {};

						for (const capture of match.captures) {
							if (metavars.includes(capture.name)) {
								captures[capture.name] = capture.node;
							}
						}

						// Belt-and-braces re-check of #match?/#eq? predicates (web-tree-sitter
						// 0.25's Query.matches() already applies them) plus the fail-closed
						// guard for a malformed query.textPredicates (see evaluatePredicates).
						if (!this.evaluatePredicates(query, match)) {
							continue;
						}

						if (
							postFilter &&
							!this.applyPostFilter(
								postFilter,
								postFilterParams,
								captures,
								rootNode,
							)
						) {
							continue;
						}

						if (match.captures.length > 0) {
							const firstNode = match.captures[0].node;
							const textCaptures: Record<string, string> = {};
							for (const [name, node] of Object.entries(captures)) {
								textCaptures[name] = (node as TreeSitterNode).text;
							}
							matches.push({
								file: filePath,
								line: firstNode.startPosition.row + 1,
								column: firstNode.startPosition.column + 1,
								matchedText: firstNode.text,
								nodeType: firstNode.type as string | undefined,
								captures: textCaptures,
							});
						}
					}

					if (matches.length > 0) {
						this.dbg(
							`Found ${matches.length} matches in ${path.basename(filePath)}`,
						);
					}
				} catch (err) {
					this.reportWasmAbort(err);
					this.dbg(`Query matching error: ${err}`);
				}
			},
		);

		return matches;
	}

	/** Collect source files for a language */
	private collectFiles(
		dir: string,
		languageId: string,
		fileFilter?: (path: string) => boolean,
	): string[] {
		const files: string[] = [];
		const extensions = this.getExtensionsForLanguage(languageId);
		const rootDir = path.resolve(dir);
		const ignoreMatcher = getProjectIgnoreMatcher(rootDir);

		// Hard cap on the walk itself (not just result collection). The per-file
		// `maxResults` break upstream only stops gathering matches *after* the walk
		// has already enumerated the whole tree — so a misrooted structuralSearch
		// would still synchronously read every directory. Bound the walk (#262).
		const scan = (d: string) => {
			if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
			try {
				const entries = fs.readdirSync(d, { withFileTypes: true });
				for (const entry of entries) {
					if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
					const full = path.join(d, entry.name);
					if (entry.isDirectory()) {
						if (isExcludedDirName(entry.name)) continue;
						if (ignoreMatcher.isIgnored(full, true)) continue;
						scan(full);
					} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
						if (ignoreMatcher.isIgnored(full, false)) continue;
						if (!fileFilter || fileFilter(full)) {
							files.push(full);
						}
					}
				}
			} catch {}
		};

		scan(rootDir);
		return files;
	}

	/** Get file extensions for a language */
	private getExtensionsForLanguage(languageId: string): string[] {
		const mapping: Record<string, string[]> = {
			typescript: [".ts", ".mts", ".cts"],
			tsx: [".tsx"],
			javascript: [".js", ".mjs", ".cjs"],
			python: [".py"],
			rust: [".rs"],
			go: [".go"],
			java: [".java"],
			kotlin: [".kt", ".kts"],
			dart: [".dart"],
			c: [".c", ".h"],
			cpp: [".cpp", ".hpp", ".cc", ".hh"],
			elixir: [".ex", ".exs"],
			ruby: [".rb"],
		};
		return mapping[languageId] || [];
	}
}

// --- Simplified Pattern Search (regex fallback) ---

/**
 * Fallback structural search using regex when tree-sitter unavailable
 * Less accurate but works without WASM dependencies
 */
export function regexStructuralSearch(
	pattern: string,
	files: string[],
	options: { maxResults?: number } = {},
): StructuralMatch[] {
	const matches: StructuralMatch[] = [];
	const maxResults = options.maxResults ?? 50;

	// Extract pattern structure for regex
	// "console.log($MSG)" -> /console\.log\(([^)]+)\)/
	const regexPattern = pattern
		.replace(/\\/g, "\\\\")
		.replace(/\./g, "\\.")
		.replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, "(.*?)") // variadic - non-greedy
		.replace(/\$[A-Z_][A-Z0-9_]*/g, "([^,)]+)"); // single - capture group

	try {
		const regex = new RegExp(regexPattern, "g");

		for (const file of files) {
			if (matches.length >= maxResults) break;

			try {
				const content = fs.readFileSync(file, "utf-8");
				const lines = content.split("\n");

				for (let i = 0; i < lines.length; i++) {
					regex.lastIndex = 0;
					const match = regex.exec(lines[i]);
					if (match) {
						const captures: Record<string, string> = {};
						// Extract captures
						for (let j = 1; j < match.length; j++) {
							captures[`$${j}`] = match[j];
						}

						matches.push({
							file,
							line: i + 1,
							column: match.index + 1,
							matchedText: match[0],
							captures,
						});

						if (matches.length >= maxResults) break;
					}
				}
			} catch {}
		}
	} catch {
		// Invalid regex
	}

	return matches;
}
