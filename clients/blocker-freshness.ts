/**
 * Turn-boundary freshness gate for cached inline blockers (#1631).
 *
 * An inline blocker recorded for a file F is a verdict about F *and everything F
 * imports*. The existing invalidation paths all key on F alone — a later dispatch
 * of the SAME path returning no blockers, the path ceasing to exist (#1245), and a
 * fresh confirmed-clean verdict (#1561/#1573). When only a DEPENDENCY of F changes,
 * none of those events fire, so F's stale verdict re-served at every turn end for
 * the rest of the session. The live instances in #1631 are exactly that shape: the
 * missing export was added to the dependency (one via a bash script, so the
 * dependency was never dispatched at all — even the same-path event was unreachable
 * by construction).
 *
 * The gate here is a READ-time freshness sweep, not the #1561 dependency-axis
 * invalidation (which stays blocked on a maintainer design decision). Before a cached
 * blocking finding is re-served at turn end, stat the file and its forward imports.
 * The file's own import list comes from the parse layer — no reverse-dependency index
 * is needed, sidestepping the tests-free-index blocker that holds #1561's remainder.
 *
 * Drifted entries are DEMOTED, not dropped (#1419 precedent, as applied by sibling
 * issue #1622): a surviving file whose content drifted gets re-served with a
 * `[stale — re-run to confirm]` marker and out of the authoritative blocker channel,
 * rather than being silently deleted or re-asserted at full authority. The gate never
 * re-pulls LSP verdicts on its own — a drifted entry is marked stale and left for an
 * explicit re-run or the next dispatch to resolve. That keeps the sweep bounded and
 * free of the document-resync hazard the issue calls out (re-querying an LSP whose
 * in-memory dependency document is itself stale would regenerate the stale verdict).
 *
 * Scope (#1631 review F4): an inline blocker is not always LSP-only —
 * `dispatcher.ts` builds it from every `semantic === "blocking"` diagnostic across
 * all runners, so an eslint, biome-check, or ast-grep security-rule (hardcoded
 * secret, CVE) finding can land here too. Only a language-server verdict is
 * actually invalidated by an IMPORT changing; an ast-grep secret match doesn't stop
 * being true because a file it imports was edited. The sweep therefore demotes an
 * entry only when its recorded `sources` (`InlineBlockerRecord.sources`) are ALL
 * `"lsp"` — a mixed or non-LSP-sourced blocker is left fully authoritative, the same
 * fail-closed shape `retireInlineBlockerOnConfirmedClean` already uses for
 * provenance it can't yet reason about.
 *
 * Resolution boundary (#1631 review F8): `extractForwardImportPaths` parses static
 * import/require syntax via tree-sitter. It does not, and cannot, resolve a
 * dependency reached only through a dynamic `import()` or `require()` behind a
 * runtime condition — that edge is invisible to this gate, so a blocker whose only
 * stale dependency arrives that way survives a replay. This is an honest boundary,
 * not a silently-closed one.
 */
import * as fs from "node:fs";
import { normalizeEphemeralMapKey } from "./path-utils.js";
import { resolveImportToFiles } from "./review-graph/import-resolvers.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	getSharedTreeSitterClient,
	resolveTreeSitterLanguage,
} from "./tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.js";

/**
 * Per-turn result of the freshness sweep over the cached inline blockers.
 *
 * #1631 review F5: there is deliberately no `retired` count. The gate's whole
 * design is demote-not-drop (#1419) — every branch either leaves an entry alone
 * (`kept`), flips its `stale` bit (`revalidated`/`alreadyStale`), or fails closed
 * and leaves it alone. None of those branches, nor any combination reachable
 * through `RuntimeCoordinator`, ever removes an entry from the map; deletion is
 * `clearInlineBlockers`'/`retireInlineBlockerOnConfirmedClean`'s job, driven by an
 * actual re-dispatch or confirmed-clean check, not by this read-time sweep. A
 * `retired` field on this type would therefore always read 0 — not an
 * under-implemented case, but one this gate cannot reach by design. Dropped
 * rather than kept as permanently-dead API surface.
 */
export interface BlockerFreshnessCounts {
	/** Cached blocker entries present when the sweep ran. */
	total: number;
	/** No drift detected this turn — re-served as an authoritative blocker. */
	kept: number;
	/** Drift detected this turn — demoted to `[stale — re-run to confirm]`. */
	revalidated: number;
	/** Already demoted on a prior turn and still stale — re-served as `[stale]`. */
	alreadyStale: number;
	/**
	 * #1631 review F7: entries whose forward-import list exceeded
	 * {@link MAX_DRIFT_CHECK_IMPORTS} and was truncated before the drift check —
	 * a signal the sweep could have missed drift past the cap, surfaced rather
	 * than folded silently into a clean-looking `kept`/`revalidated` count.
	 */
	truncatedImports: number;
}

/**
 * Resolves a blocker file's forward imports to in-project file paths. Injected in
 * tests; the production default parses the file with the shared tree-sitter client
 * and resolves each import source through the review-graph import resolvers.
 */
export type ForwardImportResolver = (
	cwd: string,
	filePath: string,
) => Promise<string[]> | string[];

/**
 * #1790: a blocking row served by the widget store's `files` map — reached via
 * a live dispatch OR a workspace-diagnostics cache-hit replay
 * (`reconcileScanDiagnostics` in the cache-serve branch of
 * `tools/lsp-diagnostics.ts`) — that has no corresponding entry in
 * `RuntimeCoordinator`'s inline-blocker map. Population is injected from the
 * call site (`runtime-turn.ts`) rather than imported here, because
 * `widget-state.ts` already imports FROM this module
 * (`collectForwardImportMtimes`); importing it back would create a cycle
 * (the exact shape #1631's review round already flagged and fixed once for
 * `STALE_LINE_MARKER`). `demote` closes over the widget store's own write path
 * so the sweep applies its ONE drift check (`detectDrift`, shared with the
 * inline-blocker branch below) without re-implementing the write.
 */
export interface WidgetSweepBlockerEntry {
	filePath: string;
	/** Earliest `observedAt` among this file's non-stale, LSP-sourced blocking
	 * diagnostics — the conservative baseline (using the latest could hide
	 * drift that predates a later diagnostic's own observation). */
	recordedAtMs: number;
	/** Demotes every currently-blocking, LSP-sourced diagnostic for this file
	 * to stale in the widget store. Returns true iff something changed. */
	demote: () => boolean;
}

export interface BlockerFreshnessOptions {
	/** Wall-clock baseline override; defaults to `Date.now()`. Test seam only. */
	now?: number;
	/** Forward-import resolution override; defaults to tree-sitter extraction. */
	resolveForwardImports?: ForwardImportResolver;
	/**
	 * #1790: widget-store blocking rows to widen the sweep's population with,
	 * deduped against the inline-blocker map by file path (one population, no
	 * double-processing a file present in both stores). Defaults to none, so
	 * every existing caller/test that doesn't pass this keeps today's
	 * inline-blockers-only behavior.
	 */
	additionalEntries?: WidgetSweepBlockerEntry[];
}

/**
 * Upper bound on the number of forward imports stat-checked for a single blocker.
 * Blocking entries are rare, but one file can import many modules; the sweep must
 * stay bounded so it cannot inflate a turn end.
 */
const MAX_DRIFT_CHECK_IMPORTS = 128;

// Per-language extractor cache, mirroring review-graph/builder.ts and
// module-report.ts. Memoize failures too: a grammar that fails to load once is not
// re-probed for every blocker of that language within the process.
const extractorCache = new Map<
	string,
	Promise<TreeSitterSymbolExtractor | null>
>();

function getExtractor(
	languageId: string,
): Promise<TreeSitterSymbolExtractor | null> {
	let cached = extractorCache.get(languageId);
	if (!cached) {
		cached = (async () => {
			const client = getSharedTreeSitterClient();
			if (!client) return null;
			const extractor = new TreeSitterSymbolExtractor(languageId, client);
			const ok = await extractor.init();
			return ok ? extractor : null;
		})().catch(() => null);
		extractorCache.set(languageId, cached);
	}
	return cached;
}

/**
 * #1631 review F6: memoized forward-import RESOLUTION (the parse step, not the
 * per-dependency mtime stats — those must always be read fresh so drift is never
 * missed). Reviewer measurement: ~450ms/turn at 8 blockers × 300 imports
 * unmemoized, ~435ms per `mode=all` call, because both the turn-end sweep and the
 * `mode=all` gate independently re-parse the SAME consumer files' import lists.
 *
 * Keyed on (path, own mtime) — a cache hit is safe by construction: if the file's
 * mtime hasn't moved, its parsed import LIST cannot have changed (the imports
 * themselves may still have drifted; that's what the mtime stats after this cache
 * check are for). Scoped PER TURN, not process-lifetime (the latch screen this
 * class of state must pass): `noteImportResolutionMemoTurn` clears it whenever the
 * `RuntimeCoordinator`'s `turnIndex` advances, so a resolver injected for one test
 * or a project whose import graph is edited mid-session is never served a result
 * from a stale earlier turn. When no turn index is available (mode=all called
 * outside a tracked turn, or a test with no runtime), the cache is left alone —
 * still correct because of the mtime key, just not turn-bounded in that case.
 */
const importResolutionMemo = new Map<
	string,
	{ mtimeMs: number; size: number; imports: string[] }
>();
let importResolutionMemoTurnIndex: number | undefined;

function noteImportResolutionMemoTurn(turnIndex: number | undefined): void {
	if (turnIndex === undefined) return;
	if (importResolutionMemoTurnIndex !== turnIndex) {
		importResolutionMemo.clear();
		importResolutionMemoTurnIndex = turnIndex;
	}
}

async function resolveForwardImportsMemoized(
	cwd: string,
	filePath: string,
	resolveForwardImports: ForwardImportResolver,
): Promise<string[]> {
	const sig = await statSignature(filePath);
	if (sig === undefined) {
		// Can't key reliably (deleted/unreadable) — resolve uncached rather than
		// risk serving a memo entry for content that may no longer exist.
		try {
			return await resolveForwardImports(cwd, filePath);
		} catch {
			return [];
		}
	}
	const cached = importResolutionMemo.get(filePath);
	// mtime alone collides for writes within the same timestamp tick (~1ms);
	// size disambiguates the shrink-then-restore case (#1641's measurement).
	if (cached && cached.mtimeMs === sig.mtimeMs && cached.size === sig.size)
		return cached.imports;
	let imports: string[];
	try {
		imports = await resolveForwardImports(cwd, filePath);
	} catch {
		imports = [];
	}
	importResolutionMemo.set(filePath, {
		mtimeMs: sig.mtimeMs,
		size: sig.size,
		imports,
	});
	return imports;
}

/** Test-only: clear the extractor and import-resolution memos. */
export function _resetBlockerFreshnessForTests(): void {
	extractorCache.clear();
	importResolutionMemo.clear();
	importResolutionMemoTurnIndex = undefined;
}

/**
 * Production forward-import resolver. Parses `filePath` with its tree-sitter grammar
 * and resolves every extracted import source to in-project files. Degrades to an
 * empty list (never throws) when the grammar, client, or file is unavailable — the
 * sweep then falls back to checking only the blocker file's own drift.
 */
export async function extractForwardImportPaths(
	cwd: string,
	filePath: string,
): Promise<string[]> {
	const languageId = resolveTreeSitterLanguage(filePath);
	if (!languageId) return [];
	const client = getSharedTreeSitterClient();
	if (!client) return [];
	const extractor = await getExtractor(languageId);
	if (!extractor) return [];

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const outcome = await client.withParsedTree(
		filePath,
		languageId,
		content,
		(tree) => extractor.extract(tree, filePath, content).imports,
	);
	if (!outcome.parsed) return [];

	const resolved = new Set<string>();
	for (const ref of outcome.value) {
		for (const target of resolveImportToFiles(
			cwd,
			filePath,
			languageId,
			ref.source,
		)) {
			resolved.add(target);
		}
	}
	return [...resolved];
}

async function statSignature(
	filePath: string,
): Promise<{ mtimeMs: number; size: number } | undefined> {
	try {
		const stat = await fs.promises.stat(filePath);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return undefined;
	}
}

async function statMtimeMs(filePath: string): Promise<number | undefined> {
	try {
		const stat = await fs.promises.stat(filePath);
		return stat.mtimeMs;
	} catch {
		return undefined;
	}
}

/** Result of {@link collectForwardImportMtimes}. */
export interface ForwardImportMtimes {
	mtimes: Array<{ path: string; mtimeMs: number }>;
	/**
	 * #1631 review F7: true when the resolved import list exceeded
	 * {@link MAX_DRIFT_CHECK_IMPORTS} and was truncated before stat-checking. A
	 * truncated check can miss drift in an import past the cap, so callers fold
	 * this into their latency record rather than reporting a clean sweep silently.
	 */
	truncated: boolean;
}

/**
 * Resolve `filePath`'s forward imports and stat each, returning the imports that
 * exist together with their mtime. Shared by the inline-blocker sweep and the
 * widget-store dependency reconcile so both gates weigh drift identically. A path
 * that cannot be stat'ed (deleted/unreadable) is omitted — a deleted dependency is
 * not a content drift this gate reports.
 */
export async function collectForwardImportMtimes(
	cwd: string,
	filePath: string,
	resolveForwardImports: ForwardImportResolver = extractForwardImportPaths,
	turnIndex?: number,
): Promise<ForwardImportMtimes> {
	noteImportResolutionMemoTurn(turnIndex);
	let imports: string[] = [];
	try {
		imports = await resolveForwardImportsMemoized(
			cwd,
			filePath,
			resolveForwardImports,
		);
	} catch {
		imports = [];
	}
	const truncated = imports.length > MAX_DRIFT_CHECK_IMPORTS;
	const out: Array<{ path: string; mtimeMs: number }> = [];
	for (const dep of imports.slice(0, MAX_DRIFT_CHECK_IMPORTS)) {
		const mtimeMs = await statMtimeMs(dep);
		if (mtimeMs !== undefined) out.push({ path: dep, mtimeMs });
	}
	return { mtimes: out, truncated };
}

/**
 * Detect drift for one blocker entry. Returns the set of paths (the file itself plus
 * any forward import) whose mtime is strictly newer than the verdict baseline. A
 * missing/unstat-able path contributes nothing here — a DELETED blocker file is
 * already dropped by `reconcileInlineBlockers`, and a deleted dependency is not a
 * content drift this gate is responsible for.
 *
 * +50ms tolerance. The verdict baseline is `Date.now()`, but on Windows a file's
 * mtime can LEAD `Date.now()` by a measurable margin — not just sub-millisecond
 * rounding. Reviewer measurement across 200 writes on Windows: 184/200 mtimes read
 * ahead of the immediately-following `Date.now()`, by up to ~11.4ms, the same host
 * skew #1491/#1498 hit for install-probe timestamps. A +1ms tolerance (the
 * convention borrowed from `reconcileStaleWidgetFiles` /
 * `reconcileProjectDiagnosticsSnapshot`, both same-process single-writer paths
 * without this skew) demoted a blocker recorded immediately after its own file
 * write with zero real drift — 42 false demotions in 50 runs, and two of this
 * gate's own tests went host-dependent (red 3/6 runs on Windows, green 6/6 at
 * +50ms). +50ms comfortably clears the measured skew while staying far below the
 * gap between genuinely distinct edits.
 */
// Single implementation lives in the freshness kernel (#1739); this
// re-export preserves every existing importer's path.
export { MTIME_DRIFT_TOLERANCE_MS } from "./freshness.js";
import { freshnessFromMtime } from "./freshness.js";

interface DriftResult {
	drifted: string[];
	truncated: boolean;
}

async function detectDrift(
	cwd: string,
	filePath: string,
	recordedAtMs: number,
	resolveForwardImports: ForwardImportResolver,
	turnIndex: number | undefined,
): Promise<DriftResult> {
	const drifted: string[] = [];
	const ownFreshness = freshnessFromMtime({
		mtimeMs: await statMtimeMs(filePath),
		referenceMs: recordedAtMs,
	});
	if (ownFreshness.verdict === "stale") drifted.push(filePath);
	const { mtimes, truncated } = await collectForwardImportMtimes(
		cwd,
		filePath,
		resolveForwardImports,
		turnIndex,
	);
	for (const { path: depPath, mtimeMs } of mtimes) {
		const verdict = freshnessFromMtime({
			mtimeMs,
			referenceMs: recordedAtMs,
		});
		if (verdict.verdict === "stale") drifted.push(depPath);
	}
	return { drifted, truncated };
}

/**
 * One row of the sweep's unified population, whichever store it came from.
 * `demote` closes over the origin store's own write path (`markInlineBlockerStale`
 * for an inline blocker, the widget store's per-file setter for a widget-only row)
 * so the loop below runs the SAME drift check over every row without caring which
 * store will record the result (#1790).
 */
interface SweepPopulationEntry {
	filePath: string;
	stale: boolean;
	recordedAtMs: number | undefined;
	sources: readonly string[] | undefined;
	demote: () => boolean;
}

/**
 * Whether a population entry is eligible for the drift check at all — the same
 * three gates the main sweep loop applies (not already stale, has a timestamp
 * baseline, all-`"lsp"` sources). Factored out so the #1790 review F5 dedup
 * decision below (chain vs. separate row) asks the IDENTICAL question the main
 * loop will ask, rather than a second hand-written approximation of it that
 * could drift from the real gates.
 */
function isEligibleForDriftCheck(entry: {
	stale: boolean;
	recordedAtMs: number | undefined;
	sources: readonly string[] | undefined;
}): boolean {
	if (entry.stale) return false;
	if (entry.recordedAtMs === undefined) return false;
	return (
		entry.sources !== undefined &&
		entry.sources.length > 0 &&
		entry.sources.every((source) => source === "lsp")
	);
}

/**
 * Freshness sweep over every blocking row the widget currently serves — the cached
 * inline blockers (`RuntimeCoordinator`) AND, since #1790, any widget-store row
 * reached only through a cache-served replay (`options.additionalEntries`, injected
 * by the call site to avoid an import cycle with `widget-state.ts`). Called at turn
 * end before the blockers are re-served. Entries whose own file or forward imports
 * drifted since the verdict are demoted via `demote`; the turn-end renderer then
 * serves them out of the advisory channel with a `[stale — re-run to confirm]`
 * marker instead of as an authoritative blocker.
 *
 * #1790: a file present in BOTH stores — the common case, since a live dispatch
 * writes an inline blocker (`runtime-tool-result.ts`) AND a widget-store record
 * (`pipeline.ts`) for the SAME verdict — is drift-checked ONCE, via its
 * inline-blocker entry, so the sweep's one drift check never runs twice over the
 * same file WHEN that inline entry is itself eligible for the check. But
 * `markInlineBlockerStale` only ever touches `RuntimeCoordinator`'s map, never
 * the widget store; on drift for a duplicated path, the widget demote is
 * CHAINED onto the inline entry's `demote` (both stores write) rather than the
 * widget row being silently dropped — the reviewer's F1 probe caught an earlier
 * revision that discarded it: `revalidated:1` while the widget's own
 * `isBlocking` for the file still read true, the exact ghost #1790 exists to
 * kill.
 *
 * #1790 review F5: chaining is conditional on the inline entry actually being
 * ELIGIBLE for the drift check (`isEligibleForDriftCheck` — not already stale,
 * timestamped, all-LSP sources). An ineligible inline entry never reaches
 * `demote()` in the loop below, so chaining onto one is ALSO a silent drop —
 * just one store removed from F1's. The widget row's eligibility belongs to the
 * WIDGET STORE, not to whatever inline entry happens to share its file path; an
 * ineligible duplicate therefore gets its own separate population row instead
 * of being chained, so a file can legitimately count twice (once per store) when
 * the two stores disagree on eligibility.
 *
 * Never throws: any internal failure leaves the entry untouched (existing re-serve
 * behavior) rather than failing the turn end.
 */
export async function sweepInlineBlockerFreshness(
	runtime: RuntimeCoordinator,
	cwd: string,
	options?: BlockerFreshnessOptions,
): Promise<BlockerFreshnessCounts> {
	const counts: BlockerFreshnessCounts = {
		total: 0,
		kept: 0,
		revalidated: 0,
		alreadyStale: 0,
		truncatedImports: 0,
	};
	const resolveForwardImports =
		options?.resolveForwardImports ?? extractForwardImportPaths;
	let turnIndex: number | undefined;
	try {
		turnIndex = runtime.turnIndex;
	} catch {
		turnIndex = undefined;
	}

	let inlineEntries: Array<{
		filePath: string;
		stale?: boolean;
		recordedAtMs?: number;
		sources?: readonly string[];
	}>;
	try {
		inlineEntries = runtime.getInlineBlockersSnapshot();
	} catch {
		return counts;
	}

	const population: SweepPopulationEntry[] = inlineEntries.map((entry) => ({
		filePath: entry.filePath,
		stale: entry.stale ?? false,
		recordedAtMs: entry.recordedAtMs,
		sources: entry.sources,
		demote: () =>
			runtime.markInlineBlockerStale(entry.filePath, "dependency-drift"),
	}));

	// #1790 review F2: dedup key is `normalizeEphemeralMapKey`, not
	// `normalizeMapKey` — the latter realpaths a live file and walks up the
	// directory tree for a missing one (measured ~313µs per deleted path, exactly
	// the population this sweep processes) on a turn-end hot path. The widget
	// store this population is reconciled against keys on
	// `normalizeEphemeralMapKey` too (see `widget-state.ts`'s module doc on why
	// `normalizeMapKey` is wrong for this in-process, single-walk kind of key),
	// so this also keeps the dedup consistent with the store it is deduping
	// against, not just cheaper.
	const inlineByKey = new Map<string, SweepPopulationEntry>();
	for (const entry of population) {
		inlineByKey.set(normalizeEphemeralMapKey(entry.filePath), entry);
	}
	for (const extra of options?.additionalEntries ?? []) {
		const key = normalizeEphemeralMapKey(extra.filePath);
		const inlineEntry = inlineByKey.get(key);
		// #1790 review F5: chaining onto an INELIGIBLE inline entry is a silent
		// drop, not a merge. The main loop below short-circuits BEFORE ever
		// calling `demote()` for an already-stale entry (the one-way
		// dependency-drift latch — a forever-ghost once it fires once), an
		// unstamped legacy record, or a non-LSP/mixed-sources entry (e.g. an
		// unrelated ast-grep finding on the same file). Any of those swallows a
		// chained widget demote even though the widget row is pure-LSP by
		// construction (`getWidgetBlockingFilesForSweep` only emits LSP-sourced
		// rows) and carries its OWN baseline. Eligibility belongs to the STORE
		// the row came from, not the file path two stores happen to share — so
		// only chain when the inline entry would itself reach `demote()`;
		// otherwise give the widget row its own population entry so its own
		// gates and its own drift check decide its own fate.
		if (inlineEntry && isEligibleForDriftCheck(inlineEntry)) {
			// #1790 review F1: a duplicated path is counted and drift-checked ONCE
			// (via the inline entry above), but BOTH stores must record the
			// verdict — `markInlineBlockerStale` only ever touches
			// `RuntimeCoordinator`'s map, so without this chain the widget store's
			// own diagnostic for this file stays fully blocking (`isBlocking` true)
			// even after the inline entry demotes. Chain, don't replace: either
			// store's own untouched failure path must not suppress the other's
			// write.
			const demoteInline = inlineEntry.demote;
			const demoteWidget = extra.demote;
			inlineEntry.demote = () => {
				const inlineChanged = demoteInline();
				const widgetChanged = demoteWidget();
				return inlineChanged || widgetChanged;
			};
			continue;
		}
		population.push({
			filePath: extra.filePath,
			stale: false,
			recordedAtMs: extra.recordedAtMs,
			sources: ["lsp"],
			demote: extra.demote,
		});
	}

	counts.total = population.length;

	for (const entry of population) {
		try {
			if (entry.stale) {
				counts.alreadyStale += 1;
				continue;
			}
			// No timestamp baseline (legacy/unstamped record) — we cannot order disk
			// mtimes against the verdict, so leave it untouched (fail toward the
			// existing behavior rather than fabricating a drift signal).
			if (entry.recordedAtMs === undefined) {
				counts.kept += 1;
				continue;
			}
			// #1631 review F4: fail-closed on non-LSP (or unknown) provenance. Import
			// drift only invalidates a language-server verdict; a mixed or non-`"lsp"`
			// `sources` list is kept at full authority rather than demoted.
			const isLspSourced =
				entry.sources !== undefined &&
				entry.sources.length > 0 &&
				entry.sources.every((source) => source === "lsp");
			if (!isLspSourced) {
				counts.kept += 1;
				continue;
			}
			const { drifted, truncated } = await detectDrift(
				cwd,
				entry.filePath,
				entry.recordedAtMs,
				resolveForwardImports,
				turnIndex,
			);
			if (truncated) counts.truncatedImports += 1;
			if (drifted.length > 0) {
				entry.demote();
				counts.revalidated += 1;
			} else {
				counts.kept += 1;
			}
		} catch {
			// Per-entry failure: keep the entry as-is.
			counts.kept += 1;
		}
	}
	return counts;
}
