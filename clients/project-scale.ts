/**
 * Single "project scale" knob deriving pi-lens's five independent
 * project-size budgets (#776).
 *
 * Before this module, five subsystems each hardcoded their own file/entry
 * ceiling and degraded independently as a repo grew:
 *
 *   - project-diagnostics scanner: 500 files  (clients/project-diagnostics/scanner.ts)
 *   - review graph:               1,000 files (clients/runtime-config.ts)
 *   - startup scan:               2,500 source files (clients/startup-scan.ts)
 *   - jscpd:                      6,000 dir entries (clients/jscpd-client.ts)
 *   - word index:                 6,000 files (clients/word-index.ts)
 *
 * A large-but-healthy (monorepo-scale) repo would trip these one at a time,
 * silently, with no single lever to say "this repo is big; believe in it".
 *
 * This module centralizes the base value (`maxProjectFiles`, default 2,000 —
 * chosen so every ratio below reproduces today's five defaults exactly) and
 * exposes one `deriveBudget(ratio, cwd)` helper subsystems call instead of
 * declaring their own local constant. Raising `maxProjectFiles` in one place
 * scales all five budgets coherently; startup's calibrated ratio is the one
 * intentional default adjustment recorded here.
 *
 * Ratio table (documents the defaults at the default base of 2,000):
 *
 *   | Subsystem                    | Ratio | Derived @ base 2,000 | Today  |
 *   |-------------------------------|-------|----------------------|--------|
 *   | project-diagnostics scanner   | 0.25× | 500                  | 500    |
 *   | review graph (#775 R1: tapered above 4,000, see below) | 0.5× | 1,000 | 1,000 |
 *   | startup scan (source files)   | 1.25× | 2,500                | 2,000  |
 *   | jscpd (dir entries)           | 3×    | 6,000                | 6,000  |
 *   | word index (files)            | 3×    | 6,000                | 6,000  |
 *
 * The review graph is the ONE budget in this table that stops being a flat
 * ratio above a threshold: {@link getReviewGraphMaxFilesDerived} tapers its
 * growth toward a hard ceiling instead of scaling linearly forever (or
 * cliff-dropping like the pre-#775 flat cap did) — see that function's doc
 * comment for the full rationale. Every OTHER row in this table (and the
 * review graph itself at or below the taper's linear boundary) is still the
 * flat ratio shown.
 *
 * `maxProjectFiles` resolution order (highest priority first) — NOTE this is
 * the base-value chain only; each subsystem's own PRE-EXISTING per-subsystem
 * env override (e.g. `PI_LENS_REVIEW_GRAPH_MAX_FILES`,
 * `PI_LENS_STARTUP_SCAN_MAX_ENTRIES`) is still checked at the call site
 * BEFORE falling back to this module's derived value, so it always wins:
 *
 *   1. `maxProjectFiles` in the project's `.pi-lens.json` (per-project — see
 *      `clients/project-lens-config.ts`). Requires a `cwd`; a call site with
 *      no cwd in hand skips straight to (2).
 *   2. `PI_LENS_MAX_PROJECT_FILES` environment variable.
 *   3. Default: {@link DEFAULT_PROJECT_SCALE_BASE} (2,000).
 *
 * Two entry-UNIT budgets were deliberately left OUT of this derivation:
 * `startup-scan.ts`'s `MAX_STARTUP_SCAN_ENTRIES` (50,000 directory entries)
 * and `source-filter.ts`'s `DEFAULT_MAX_SCAN_ENTRIES` (200,000 directory
 * entries). Both bound directory entries VISITED (a raw tree-walk safety
 * valve, #758/#760), not source files KEPT — a very different quantity whose
 * healthy ratio to file count varies wildly by project shape (a repo with a
 * huge non-source data/asset tree needs a much larger entries budget than its
 * source-file count would suggest). Coupling them to `maxProjectFiles` would
 * risk silently changing behavior on exactly the pathological-tree shapes
 * these ceilings exist to protect, for no behavior-neutral gain; they already
 * have their own env overrides for callers who need to retune them. Left
 * standalone per the issue's "derive or standalone, justify" instruction.
 */

import { lazyEnvNumber, toPositiveFinite } from "./env-utils.js";
import { loadPiLensProjectConfig } from "./project-lens-config.js";

/**
 * Default base value: chosen so every ratio in the table above reproduces
 * today's five hardcoded defaults exactly. Do not change without re-deriving
 * every subsystem's default (that re-tuning is explicitly out of scope here —
 * see #775).
 */
export const DEFAULT_PROJECT_SCALE_BASE = 2_000;

const _envBase = lazyEnvNumber(
	"PI_LENS_MAX_PROJECT_FILES",
	DEFAULT_PROJECT_SCALE_BASE,
);

/** Test-only: clears the memoized `PI_LENS_MAX_PROJECT_FILES` read so a
 * subsequent call re-reads the env var (matching the `_resetForTests`
 * convention used across `env-utils.ts` consumers). */
export function _resetProjectScaleBaseForTests(): void {
	_envBase._resetForTests();
}

/**
 * Resolve the base `maxProjectFiles` value.
 *
 * Pass the caller's project root as `cwd` whenever one is available — that's
 * what lets a per-project `.pi-lens.json` override win. Call sites that only
 * have a bare module-level constant today (no cwd in hand) may omit it; they
 * fall back to the `PI_LENS_MAX_PROJECT_FILES` env var / default chain only
 * (documented per-call-site in each subsystem's own comment).
 */
export function getProjectScaleBase(cwd?: string): number {
	if (cwd) {
		const config = loadPiLensProjectConfig(cwd);
		const configBase = toPositiveFinite(config.maxProjectFiles);
		if (configBase > 0) return Math.floor(configBase);
	}
	return _envBase.get();
}

/**
 * Ratios calibrated against the five hardcoded defaults at
 * {@link DEFAULT_PROJECT_SCALE_BASE}. The unit each budget is expressed in
 * stays subsystem-appropriate (files vs. directory entries); this table is
 * the single place that encodes the relationship between them.
 */
export const PROJECT_SCALE_RATIOS = {
	/** project-diagnostics scanner: files kept. 0.25 * 2,000 = 500. */
	projectDiagnosticsScanner: 0.25,
	/** review graph: files kept. 0.5 * 2,000 = 1,000. */
	reviewGraph: 0.5,
	/** startup scan: source files counted. 1.25 * 2,000 = 2,500. */
	startupScan: 1.25,
	/** jscpd: directory entries visited (its own gate, not source-filter's). 3 * 2,000 = 6,000. */
	jscpd: 3,
	/** word index: files indexed. 3 * 2,000 = 6,000. */
	wordIndex: 3,
} as const;

/**
 * Scale a ratio from {@link PROJECT_SCALE_RATIOS} by the resolved base,
 * rounding to the nearest integer and flooring at 1 (a budget of 0 would
 * degrade every scan to "nothing scanned", never the intent of a large-repo
 * knob).
 */
export function deriveBudget(ratio: number, cwd?: string): number {
	return Math.max(1, Math.round(getProjectScaleBase(cwd) * ratio));
}

/** Derived project-diagnostics scanner budget (files). See {@link deriveBudget}. */
export function getProjectDiagnosticsScannerMaxFiles(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner, cwd);
}

/**
 * Review-graph budget: adaptive taper (#775 R1).
 *
 * At or below {@link REVIEW_GRAPH_LINEAR_CEILING_BASE} this is IDENTICAL to
 * the flat `PROJECT_SCALE_RATIOS.reviewGraph` (0.5x) ratio every other
 * caller of {@link deriveBudget} still uses — every existing small/medium
 * project derivation (including the default-base 1,000-file case) is
 * bit-for-bit unchanged by this function.
 *
 * Above that base, growth SLOWS instead of continuing linearly (a monorepo
 * with a huge `maxProjectFiles` would otherwise get an equally huge,
 * untested review-graph budget) or cutting off at a cliff (today's actual
 * bug: a flat cap truncates the graph to empty above it, per #775's top
 * risk). A hyperbolic taper closes the gap to
 * {@link REVIEW_GRAPH_HARD_CEILING} asymptotically, never reaching or
 * exceeding it: at `base = REVIEW_GRAPH_LINEAR_CEILING_BASE +
 * REVIEW_GRAPH_TAPER_SCALE`, exactly HALF the remaining gap to the ceiling
 * is closed (a standard property of this taper shape) — e.g. base 12,000
 * (6x default) derives ~3,500 files; base 20,000 (10x default) derives
 * ~4,000.
 *
 * {@link REVIEW_GRAPH_HARD_CEILING} (5,000) is grounded FIRST by the
 * strongest real constraint on this number — `review-graph/builder.ts`'s
 * persist circuit-breaker (`GRAPH_PERSIST_MAX_ELEMENTS_DEFAULT`, 500,000
 * graph elements: file/symbol nodes + cross-file edges). Above that element
 * count only a centrality-ranked, honestly-marked partial graph is persisted
 * (#936). Read-only orientation can use it, but the build tier rejects it as
 * a complete incremental base. For symbol-dense repos, element
 * count runs on the order of ~30/file (file node + per-symbol nodes +
 * import/call/reference edges), so a hard ceiling must leave real headroom
 * below 500,000 elements. The file ceiling remains conservative because it
 * also bounds cold-build latency; the persist cap has independent measured
 * headroom through a roughly 420,000-element / 10,000-file graph (#936).
 * 5,000 is also still
 * coherent with the jscpd/wordIndex 3x-ratio precedent (6,000 at the
 * default base) as "the ceiling sits just below that established top
 * tier" rather than an exact match, so it isn't a fresh unrelated
 * constant either.
 *
 * SECOND, independently, the number is consistent with the review graph's
 * own measured per-file BUILD cost: CHANGELOG 3.8.43 ("Persist review graph
 * to disk") documents a full cold tree-sitter + import-fact build taking
 * "2-4 s" at the then-1,000-file cap — roughly 2-4 ms/file. 5,000 files at
 * that rate is a ~10-20 s worst-case cold build — tolerable as a rare
 * one-time cost when the persist cap above is respected (the disk-cached
 * path costs "~20 ms JSON parse + rebuildIndexes" instead, and per-edit
 * builds are incremental — see `diffSignatureMaps`). This build-time
 * argument alone would tolerate a larger ceiling; the persist-cap margin
 * above is the binding constraint.
 */
export const REVIEW_GRAPH_LINEAR_CEILING_BASE = 4_000;

/**
 * At `base = REVIEW_GRAPH_LINEAR_CEILING_BASE + REVIEW_GRAPH_TAPER_SCALE`
 * the taper has closed exactly half the remaining gap to
 * {@link REVIEW_GRAPH_HARD_CEILING} — see {@link taperedReviewGraphMaxFiles}.
 */
export const REVIEW_GRAPH_TAPER_SCALE = 8_000;

/** See the rationale in {@link taperedReviewGraphMaxFiles}'s doc comment. */
export const REVIEW_GRAPH_HARD_CEILING = 5_000;

/**
 * Pure taper function — see {@link getReviewGraphMaxFilesDerived}'s doc
 * comment for the full rationale. Exported standalone so tests can probe
 * the shape (below/at/above the linear boundary, ceiling asymptote)
 * independent of `getProjectScaleBase`'s env/config resolution.
 */
export function taperedReviewGraphMaxFiles(base: number): number {
	const linearValue = base * PROJECT_SCALE_RATIOS.reviewGraph;
	if (base <= REVIEW_GRAPH_LINEAR_CEILING_BASE) {
		return Math.max(1, Math.round(linearValue));
	}
	const boundaryValue =
		REVIEW_GRAPH_LINEAR_CEILING_BASE * PROJECT_SCALE_RATIOS.reviewGraph;
	const excess = base - REVIEW_GRAPH_LINEAR_CEILING_BASE;
	const taperedExtra =
		(REVIEW_GRAPH_HARD_CEILING - boundaryValue) *
		(excess / (excess + REVIEW_GRAPH_TAPER_SCALE));
	return Math.max(1, Math.round(boundaryValue + taperedExtra));
}

/**
 * Derived review-graph budget (files), honoring — in priority order — the
 * project's `.pi-lens.json#reviewGraph.maxFiles` knob (#775 R2, an explicit
 * opt-in for repos that want a bigger graph than the taper would derive;
 * see `project-lens-config.ts`), then {@link taperedReviewGraphMaxFiles} of
 * the resolved `maxProjectFiles` base. Callers still check their own
 * PRE-EXISTING `PI_LENS_REVIEW_GRAPH_MAX_FILES` env override BEFORE calling
 * this (see `review-graph/builder.ts#getReviewGraphMaxFiles`) — that always
 * wins outright, unchanged by this function.
 */
export function getReviewGraphMaxFilesDerived(cwd?: string): number {
	if (cwd) {
		const config = loadPiLensProjectConfig(cwd);
		const configOverride = config.reviewGraph?.maxFiles;
		if (configOverride !== undefined) return configOverride;
	}
	return taperedReviewGraphMaxFiles(getProjectScaleBase(cwd));
}

/** Derived startup-scan budget (source files). See {@link deriveBudget}. */
export function getStartupScanMaxSourceFilesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.startupScan, cwd);
}

/** Derived jscpd budget (directory entries). See {@link deriveBudget}. */
export function getJscpdMaxEntriesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.jscpd, cwd);
}

/** Derived word-index budget (files). See {@link deriveBudget}. */
export function getWordIndexMaxFilesDerived(cwd?: string): number {
	return deriveBudget(PROJECT_SCALE_RATIOS.wordIndex, cwd);
}
