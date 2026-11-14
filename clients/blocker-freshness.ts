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
 * being true because a file it imports was edited.
 *
 * Self-drift axis (#1561 remainder). That reasoning covers the import axis and
 * nothing else, but the original gate discarded BOTH axes for a non-LSP record:
 * entries whose `sources` were not all `"lsp"` skipped the check entirely. A
 * tree-sitter verdict about F's own syntax is emphatically invalidated by F's own
 * bytes changing, and no other path could clear it —
 * `retireInlineBlockerOnConfirmedClean` retires only the rows whose source the
 * verdict's `coveredSources` covers (per row since #4990; a superset of the
 * record's sources was required before), `coveredSourcesForCheck` builds that set
 * from the LSP server registry, and no registered server has id `"tree-sitter"`,
 * so a tree-sitter row could never retire however many clean checks ran. Live
 * shape: a
 * `ts-incomplete-assertion` blocker re-served every turn for the rest of a session
 * against a file already proven clean by grep, LSP, and a passing test.
 *
 * So the sweep now runs over every entry that HAS recorded provenance, and picks
 * the axis from the sources: all-`"lsp"` gets the own-file-plus-forward-imports
 * walk, anything else (tree-sitter, ast-grep, mixed, or `"unknown"`) gets an
 * own-file-only check. A record with NO recorded sources stays fail-closed and
 * untouched, matching the test `retireInlineBlockerOnConfirmedClean` applies before
 * it will retire.
 *
 * The self axis is CONTENT-CONFIRMED and RE-ARMING, and those two properties are
 * why it carries its own `"self-drift"` reason rather than reusing
 * `"dependency-drift"` (#2982 review).
 *
 * Content-confirmed: mtime moving is not evidence a byte moved. A `touch`, a
 * `git checkout` restoring identical bytes, or a no-op formatter pass all move
 * it. #2449 round 2 F7 settled this for `observed-mutation.ts` ("mtime-only
 * drift has to be confirmed against content before anything is replayed"), and
 * it binds harder here, where an unconfirmed demotion walks a finding out of the
 * authoritative channel. `detectSelfDrift` applies that rule at both tiers:
 * `size` first, then a sha256 of the bytes when size cannot separate a
 * one-character edit from a `touch`. A same-LENGTH change is the common shape,
 * not an exotic one (a renamed identifier of equal length, a flipped comparison,
 * a changed digit), so a size-only tier would leave a genuinely changed record
 * authoritative, which is #2982 arriving from the other side. The baseline is
 * carried by `PipelineResult` beside the inline-blocker evidence and stamped
 * synchronously by `recordInlineBlockers`. Every bound that expires, and every missing baseline, yields
 * `unverifiable`, which changes no state in either direction and is counted so
 * it is visible rather than silent.
 *
 * Re-arming: `setInlineBlockerSelfDriftStale` re-derives the verdict every turn
 * and un-demotes a record whose bytes come back, exactly as
 * `setInlineBlockerPastEofStale` does for a transient shrink-then-restore. That
 * re-arm covers the shape where the file returns to its recorded bytes (a
 * checkout, a revert, an editor undo). It does NOT cover the ordinary shape an
 * agent produces: the file was rewritten to fix the code the finding named and
 * never returns to the recorded bytes. Such a record cannot heal, so it re-served
 * dead coordinates on every turn end for the rest of the session (#4990).
 * `SELF_DRIFT_MAX_DELIVERIES` therefore caps it, on the same count-of-deliveries
 * rule as #1950's dependency cap; a record that heals before the cap still
 * un-demotes and is never retired. The cap's ledger reason says a re-run can
 * still confirm, as #1950's does, so it reads distinctly from #1944's
 * "retired, unrecoverable". The security-provenance concern that kept this axis
 * uncapped is answered by the re-arm and by the fact that a fresh dispatch of
 * the file re-raises a finding that is still there; what the cap stops is the
 * free re-serve of a verdict the record itself says may be dead.
 *
 * Defect shape 24 is satisfied by composition, not by reusing a string: the new
 * reason has per-writer semantics (re-arm, no cap), and like every sibling gate
 * it never touches a demotion another gate made and never heals one it did not
 * make. The commit gate is unaffected either way. `updateGitGuardStatus` counts
 * the unsuppressed records with no `stale` filter, so a demoted record still
 * gates a commit; `tests/clients/blocker-freshness.test.ts` pins that, because
 * it is what makes widening this sweep to security provenance safe at all. The
 * one exception is the agent's own disposition: since #4990 the demoted channel
 * runs the same policy pass as the live one, so a record whose every finding is
 * marked is stamped `policySuppressed` (out of the gate, out of the advisory)
 * like any other fully suppressed record.
 *
 * Resolution boundary (#1631 review F8, narrowed by #4438): `extractForwardImportPaths`
 * parses import and export statements and, since #4438, `import("x")` and
 * `require("x")` calls with a string argument. A computed specifier
 * (`import(name)`, a template literal) is still invisible to this gate, so a
 * blocker whose only stale dependency arrives that way survives a replay.
 *
 * Implicit scope (#4438). An LSP verdict also depends on files no import names:
 * a Go file's package peers and, for a JS/TS file, every file that feeds the
 * global scope (`clients/lsp/implicit-scope.ts`, the diagnostics cache's scope).
 * A blocker is demoted when a mutation receipt after the verdict, under the
 * sweep's root, names such a file: for a Go blocker a same-package, non-test
 * peer in the host build (its own file is left to the content axis), for a
 * JS/TS blocker a file whose role reads as feeding the global scope. Only
 * positive evidence demotes (#4438 r2): a file whose role cannot be read is a
 * cut counted in `truncatedImports`. The receipts are the writes pi-lens
 * observed (every tool, bash included); a writer pi-lens never sees, and a
 * deletion, leave the blocker as it is (#4476).
 *
 * Delivery cap (#1950, widened to the self axis by #4990). A
 * demoted-but-confirmable entry (`alreadyStale` above) is deliberately NOT
 * retired after its past-EOF sibling's one-delivery rule (#1944,
 * `blocker-past-eof.ts`) — its coordinates are still in bounds, so a fresh
 * dispatch can genuinely confirm or clear it, and retiring on delivery one
 * would discard a recoverable finding. But nothing capped how many times the
 * SAME demoted record re-serves: incident data (#1944's lane sweep) showed 18
 * `alreadyStale` re-serves in one window, with repeat deliveries carrying
 * near-zero information after the first. `runtime-turn.ts` counts each
 * delivery (`InlineBlockerRecord.staleDeliveryCount`) and retires the record
 * via `RuntimeCoordinator.retireDemotedDriftBlocker` once it reaches the cap
 * for its own reason — `DEPENDENCY_DRIFT_MAX_DELIVERIES` for the import axis,
 * `SELF_DRIFT_MAX_DELIVERIES` for the own-file axis. A count, not a TTL or a
 * session boundary, because "how many times has the agent already been told"
 * is the quantity that actually went to zero information, not "how much time
 * has passed". The ledger reason says "capped, re-run can still confirm" so it
 * reads distinctly from #1944's "retired, unrecoverable" — a capped record
 * COULD still resolve a fresh dispatch; it just stopped being handed one for
 * free.
 *
 * Widget-footer sibling (#2275). The turn-end blocker channel above is not
 * the only surface that demotes on dependency drift — `widget-state.ts`'s
 * own `files` map carries the identical demotion shape
 * (`markWidgetFileBlockersStale`) through a completely separate store, with
 * its own `WidgetDiagnostic.staleDeliveryCount` and its own retire helpers
 * (`incrementWidgetDependencyDriftDelivery`,
 * `retireWidgetDependencyDriftBlockers`). It counts RENDERS rather than
 * turn ends — the footer draws one record per pass, so `renderWidget` marks
 * what it served and the turn-end step drains those marks — and it retires
 * by HIDING the row from the footer rather than dropping the record, since
 * the widget store also backs `lens_diagnostics mode=all`. What it shares
 * with this module is the one number both caps retire against,
 * `DEPENDENCY_DRIFT_MAX_DELIVERIES`, rather than inventing a second one.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { BoundedLruCache } from "./bounded-cache.js";
import { hashContentBytes } from "./content-stamp.js";
import { bounded } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { HOOK_WALL_BUDGET_MS } from "./hook-budgets.js";
import {
	classifyJsTsGlobalScope,
	globalScopeRoleByName,
	globalScopeRoleByText,
	goPackagePeersOf,
	implicitScopeOf,
	isGoSourceFile,
	type GlobalScopeRole,
} from "./lsp/implicit-scope.js";
import { notePathAppeared } from "./path-birth.js";
import {
	isWithinForm,
	normalizeEphemeralMapKey,
	normalizeMapKey,
} from "./path-utils.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { resolveImportToFiles } from "./review-graph/import-resolvers.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import {
	getSharedTreeSitterClient,
	resolveTreeSitterLanguage,
} from "./tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.js";

/** See the module doc's "Delivery cap (#1950)" section above. */
export const DEPENDENCY_DRIFT_MAX_DELIVERIES = 3;

/**
 * #4990: deliveries a `"self-drift"` demotion may re-serve before
 * `runtime-turn.ts` retires it, the self axis's sibling of
 * {@link DEPENDENCY_DRIFT_MAX_DELIVERIES}.
 *
 * The self axis is re-arming, so a record whose bytes come back is un-demoted
 * and never reaches this cap. A record the agent fixed by rewriting the file
 * does not come back, and re-served dead coordinates on every turn end for the
 * rest of the session; the cap's ledger reason keeps #1950's distinction
 * ("capped, a re-run can still confirm") rather than #1944's "unrecoverable".
 */
export const SELF_DRIFT_MAX_DELIVERIES = 3;

/**
 * #2982: total bytes the self-drift axis may hash in ONE sweep.
 *
 * Each read is individually bounded by `bounded()`, but a turn with many
 * non-LSP blockers would still issue many whole-file reads on a hook path, which
 * is defect shape 9 (bounded on one axis, growing on another). Once a sweep has
 * spent this budget the remaining same-size records are reported `unverifiable`
 * and left exactly as they are, the same fail-closed direction as a read that
 * times out.
 */
const SELF_DRIFT_HASH_BUDGET_BYTES = 8 * 1024 * 1024;

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
	 * #4438: also entries whose implicit-scope check stopped short: the
	 * per-sweep parse budget ({@link MAX_IMPLICIT_SCOPE_PARSES}) ran out, or
	 * the receipt ring evicted receipts newer than the verdict.
	 */
	truncatedImports: number;
	/**
	 * #2982: self-drift demotions UN-done this turn because the record's bytes
	 * came back to their recorded size. The self axis re-arms
	 * (`setInlineBlockerSelfDriftStale`), so this is a real state transition
	 * and not reachable by the latching `"dependency-drift"` axis, whose
	 * counts above can never include a heal.
	 */
	selfHealed: number;
	/**
	 * #2982: self-axis entries whose mtime moved but whose content tier could
	 * not decide (no recorded size, or an unreadable file now). Those are left
	 * authoritative rather than demoted on the mtime signal alone. Surfaced so
	 * a rise in "we could not tell" is visible instead of folded into `kept`.
	 */
	selfUnverifiable: number;
	/** Same sweep-level signal when the aggregate hash budget is exhausted. */
	hashBudgetExhausted: number;
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
interface WidgetSweepBlockerEntry {
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
	/**
	 * #4921: the turn session whose inline records this sweep covers (omitted:
	 * the coordinator's). Another session's are swept at its own turn end,
	 * against its own cwd.
	 */
	sessionId?: string | undefined;
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
	/**
	 * #2982: the HOOK's abort signal, threaded from `TurnEndDeps.signal`, so the
	 * self axis's filesystem work runs under `bounded()` rather than as an
	 * unbounded await on a hook path. Optional because several callers (tests,
	 * and any future non-hook driver) have none; `bounded()`'s own type admits
	 * `undefined` for exactly that reason, and a wall-clock bound still applies.
	 */
	signal?: AbortSignal;
}

/**
 * #4438: files one sweep may parse to classify their TS/JS global-scope role
 * (`classifyJsTsGlobalScope` reads and parses a JS/TS file its name does not
 * decide). The receipts after a long-lived verdict can name hundreds of
 * files; past this budget a receipt is not classified, the entry stays as it
 * is, and the cut is counted in `truncatedImports`. A role the name decides
 * (a declaration file, a file that is not JS/TS) or the text decides (a
 * module with no ambient declaration) spends nothing (#4438 r2).
 */
const MAX_IMPLICIT_SCOPE_PARSES = 32;

/**
 * #4438: global-scope roles kept across sweeps, keyed by the file's stat
 * identity (mtime, ctime and size, as {@link forwardImportSources} keys its
 * parses), so a file the receipts keep naming is parsed once per version,
 * not once per turn.
 */
const GLOBAL_SCOPE_ROLE_MEMO_ENTRIES = 1024;
interface GlobalScopeRoleEntry {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	role: GlobalScopeRole;
}
const globalScopeRoleMemo = new BoundedLruCache<string, GlobalScopeRoleEntry>(
	GLOBAL_SCOPE_ROLE_MEMO_ENTRIES,
);

interface ImplicitScopeDrift {
	/** Files in the entry's implicit scope that changed after the verdict. */
	drifted: string[];
	/** The check stopped short (an unknown role, the parse budget, or receipts evicted). */
	truncated: boolean;
}

type ImplicitScopeCheck = (
	filePath: string,
	recordedAtMs: number,
) => ImplicitScopeDrift;

/**
 * #4438 r2: a receipt file's role from its text alone
 * (`globalScopeRoleByText`), or `undefined` when a parse must decide or the
 * file does not read. Most JS/TS files open a line with `import` or
 * `export`, so most receipts cost a read and no parse: 32 parses cost
 * ~80 ms on pi-lens's own files.
 */
function roleByTextOf(filePath: string): GlobalScopeRole | undefined {
	try {
		return globalScopeRoleByText(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * #4438: one sweep's implicit-scope check (see the module doc). The receipts
 * are read once, at the first eligible entry; each file's role is read at
 * most once per sweep.
 *
 * #4438 r2: only positive evidence demotes. A receipt counts when it names
 * a file in the entry's scope: for a JS/TS entry a file under `cwd` whose
 * role reads `"feeds"`, for a Go entry a peer `goPackagePeersOf` admits (a
 * peer shares the blocker's directory). A file that no longer stats is no evidence and no cut (a deleted
 * dependency is not drift, #1631); an `"unknown"` role or a spent budget is
 * a cut.
 */
function createImplicitScopeCheck(
	runtime: RuntimeCoordinator,
	cwd: string,
): ImplicitScopeCheck {
	let receipts: Array<{ filePath: string; ts: number }> | undefined;
	let receiptsDropped = false;
	const roles = new Map<string, GlobalScopeRole>();
	let parses = 0;
	const roleOf = (other: string): GlobalScopeRole => {
		const known = roles.get(other);
		if (known !== undefined) return known;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(other);
		} catch {
			roles.set(other, "none");
			return "none";
		}
		// A receipt path is a `normalizeMapKey` spelling already.
		const memo = globalScopeRoleMemo.get(other);
		let role: GlobalScopeRole;
		if (
			memo?.mtimeMs === stat.mtimeMs &&
			memo.ctimeMs === stat.ctimeMs &&
			memo.size === stat.size
		) {
			role = memo.role;
		} else {
			const byName = globalScopeRoleByName(other);
			const byText = byName ? undefined : roleByTextOf(other);
			if (byName ?? byText) {
				role = (byName ?? byText)!;
			} else if (parses >= MAX_IMPLICIT_SCOPE_PARSES) {
				return "unknown";
			} else {
				parses += 1;
				role = classifyJsTsGlobalScope(other);
			}
			globalScopeRoleMemo.set(other, {
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				size: stat.size,
				role,
			});
		}
		roles.set(other, role);
		return role;
	};
	// Receipt paths are `normalizeMapKey` spellings already
	// (`MutationReceipt.filePath`), so the root is spelled once and compared
	// by prefix: `isUnderDir` normalizing both sides cost ~2.4 ms per 459
	// receipts per sweep.
	const rootKey = normalizeMapKey(nodePath.resolve(cwd));
	const inRoot = (file: string): boolean => isWithinForm(file, rootKey);
	// JS/TS entries share one newest-first scan: a receipt's role does not
	// depend on the entry, so each receipt is classified once per sweep, and
	// the scan reaches back only as far as the oldest JS/TS verdict asked.
	let scanned: number | undefined;
	const feeding: Array<{ filePath: string; ts: number }> = [];
	let newestUnknownTs = Number.NEGATIVE_INFINITY;
	const scanBackTo = (
		all: ReadonlyArray<{ filePath: string; ts: number }>,
		recordedAtMs: number,
	): void => {
		scanned ??= all.length;
		while (scanned > 0 && all[scanned - 1]!.ts > recordedAtMs) {
			const receipt = all[--scanned]!;
			if (!inRoot(receipt.filePath)) continue;
			const role = roleOf(receipt.filePath);
			if (role === "feeds") feeding.push(receipt);
			else if (role === "unknown") {
				newestUnknownTs = Math.max(newestUnknownTs, receipt.ts);
			}
		}
	};
	const feedsGlobalScope = (other: string): boolean =>
		roles.get(other) === "feeds";
	return (filePath, recordedAtMs) => {
		const key = normalizeMapKey(filePath);
		const goFile = isGoSourceFile(key);
		const inScope = goFile
			? goPackagePeersOf(key)
			: implicitScopeOf(key, feedsGlobalScope);
		if (!inScope) return { drifted: [], truncated: false };
		if (receipts === undefined) {
			const coordinator = runtime as Partial<RuntimeCoordinator>;
			receipts = coordinator.getMutationsSince?.(0) ?? [];
			receiptsDropped = (coordinator.droppedMutationReceiptCount ?? 0) > 0;
		}
		let drifted: string | undefined;
		let unknownAfter = false;
		if (goFile) {
			// Newest first: the fix that landed last is the likeliest one.
			for (let i = receipts.length - 1; i >= 0; i--) {
				const receipt = receipts[i]!;
				if (receipt.ts <= recordedAtMs) break;
				// A peer shares the blocker's directory, so its root too.
				if (inScope(receipt.filePath)) {
					drifted = receipt.filePath;
					break;
				}
			}
		} else {
			scanBackTo(receipts, recordedAtMs);
			drifted = feeding.find(
				(receipt) => receipt.ts > recordedAtMs && inScope(receipt.filePath),
			)?.filePath;
			unknownAfter = newestUnknownTs > recordedAtMs;
		}
		if (drifted) return { drifted: [drifted], truncated: false };
		// The ring evicted receipts that may be newer than the verdict.
		const evictedAfter =
			receiptsDropped &&
			(receipts.length === 0 || receipts[0]!.ts > recordedAtMs);
		return { drifted: [], truncated: unknownAfter || evictedAfter };
	};
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

/**
 * #4346: one file's parsed import sources, kept while its mtime, ctime and
 * size are unchanged, so a caller that asks on every diagnostics call (the
 * LSP created-module producer, `clients/lsp/created-import-targets.ts`)
 * parses each file version once. #4368 r1: ctime is in the key because a
 * rewrite that keeps the size and restores the mtime (`utimes`) is otherwise
 * invisible; every write and every `utimes` moves ctime. Only the parse is kept: `extractForwardImportPaths`
 * resolves the sources on every call, because a module created since can
 * answer one without the importer changing. The stat is taken before the read,
 * so a write racing the parse leaves a key that no longer matches the disk.
 *
 * #4368 r1 row 13: `unresolved` holds the sources that resolved to nothing at
 * the last call, carried across the file's versions, so a later call that
 * resolves one sees a path that appeared in between (`notePathAppeared`).
 *
 * #4346 r3: `uncaptured` is set when a JS/TS file's sources may not be all of
 * its dependencies ({@link holdsUncapturedDependency}).
 */
const FORWARD_IMPORT_SOURCE_MEMO_ENTRIES = 1024;
interface ForwardImportSourceEntry {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	sources: string[];
	unresolved: ReadonlySet<string>;
	uncaptured: boolean;
}

/** The JS/TS grammars, whose import query captures `import`/`export`
 * statement sources and, since #4438, `import("x")` and `require("x")` with a
 * string argument, never a computed one. Go captures every import spec, and
 * `import (` is its grouped import. */
const JS_TS_LANGUAGES = new Set(["typescript", "tsx", "javascript"]);
/**
 * A relative specifier string: quoted, starting `./` or `../`. A backtick
 * specifier is valid only in an `import(` or `require(` call, which
 * `DEPENDENCY_CALL` already counts.
 */
const RELATIVE_SPECIFIER = /(["'])(\.{1,2}\/(?:(?!\1)[^\n])*)\1/g;
/**
 * Dependency forms whose specifiers need not start with `./` or `../`.
 * Even when captured, keep their scope conservative: an alias, package or
 * triple-slash reference can name a newly created module (#4477).
 */
const DEPENDENCY_CALL =
	/\bimport\s*\(|\brequire\s*\(|@import\b|\bdeclare\s+module\s*["']|\/\/\/\s*<reference\s+(?:path|types)/;

/**
 * #4346 r3: whether a JS/TS file's captured sources may miss a dependency.
 * Uncaptured relative strings and non-relative dependency forms fail closed;
 * a false positive costs a cache refusal and a re-touch, not stale findings.
 */
function holdsUncapturedDependency(
	content: string,
	sources: readonly string[],
): boolean {
	if (DEPENDENCY_CALL.test(content)) return true;
	const captured = new Set(sources);
	for (const match of content.matchAll(RELATIVE_SPECIFIER)) {
		if (!captured.has(match[2]!)) return true;
	}
	return false;
}
const forwardImportSourceMemo = new BoundedLruCache<
	string,
	ForwardImportSourceEntry
>(FORWARD_IMPORT_SOURCE_MEMO_ENTRIES);
let forwardImportParses = 0;

/** #4346: parses `forwardImportSources` has run (memo misses), for tests. */
export function _getForwardImportParsesForTests(): number {
	return forwardImportParses;
}

async function forwardImportSources(
	filePath: string,
	languageId: string,
): Promise<ForwardImportSourceEntry | undefined> {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	const key = normalizeMapKey(filePath);
	const memo = forwardImportSourceMemo.get(key);
	if (
		memo?.mtimeMs === stat.mtimeMs &&
		memo.ctimeMs === stat.ctimeMs &&
		memo.size === stat.size
	) {
		return memo;
	}
	const client = getSharedTreeSitterClient();
	if (!client) return undefined;
	const extractor = await getExtractor(languageId);
	if (!extractor) return undefined;

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const outcome = await client.withParsedTree(
		filePath,
		languageId,
		content,
		// Imports only (#4368 r1 F2): the definitions pass of a full extract is
		// what made a large file cost seconds.
		(tree) => extractor.extractImports(tree),
		"blocker-freshness",
	);
	if (!outcome.parsed) return undefined;
	forwardImportParses++;
	const sources = [...new Set(outcome.value.map((ref) => ref.source))];
	const entry: ForwardImportSourceEntry = {
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		sources,
		unresolved: memo?.unresolved ?? new Set(),
		uncaptured:
			JS_TS_LANGUAGES.has(languageId) &&
			holdsUncapturedDependency(content, sources),
	};
	forwardImportSourceMemo.set(key, entry);
	return entry;
}

/** #4346: one file's imports now: the files they resolve to, and the sources
 * that resolve to nothing. */
export interface ForwardImports {
	targets: string[];
	unresolved: string[];
	/**
	 * #4346 r2 F1: whether the sources are all of the file's dependencies:
	 * false when it could not be parsed (no grammar, client or read) or holds
	 * a form the query does not capture.
	 */
	complete: boolean;
}

/**
 * Production forward-import resolver. Parses `filePath` with its tree-sitter grammar
 * and resolves every extracted import source to in-project files. Degrades to an
 * empty answer (never throws) when the grammar, client, or file is unavailable —
 * the sweep then falls back to checking only the blocker file's own drift.
 */
export async function extractForwardImports(
	cwd: string,
	filePath: string,
): Promise<ForwardImports> {
	const languageId = resolveTreeSitterLanguage(filePath);
	if (!languageId) return { targets: [], unresolved: [], complete: false };
	const entry = await forwardImportSources(filePath, languageId);
	if (!entry) return { targets: [], unresolved: [], complete: false };
	const resolved = new Set<string>();
	const unresolved = new Set<string>();
	for (const source of entry.sources) {
		const targets = resolveImportToFiles(cwd, filePath, languageId, source);
		if (targets.length === 0) unresolved.add(source);
		for (const target of targets) {
			// #4368 r1 row 13: resolved to nothing last time, to `target` now.
			if (entry.unresolved.has(source)) notePathAppeared(target);
			resolved.add(target);
		}
	}
	entry.unresolved = unresolved;
	return {
		targets: [...resolved],
		unresolved: [...unresolved],
		complete: !entry.uncaptured,
	};
}

/** The files `filePath`'s imports resolve to now ({@link extractForwardImports}). */
export function extractForwardImportPaths(
	cwd: string,
	filePath: string,
): Promise<string[]> {
	return extractForwardImports(cwd, filePath).then(({ targets }) => targets);
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

/**
 * #2982: the self axis's verdict about a record's OWN file.
 *
 * `"drift"` means the bytes are confirmed different from the recorded verdict's.
 * `"unchanged"` means no drift was confirmed, which is the non-demoting
 * direction and covers both "mtime never moved" and "mtime moved but the size
 * tier matches". `"unverifiable"` means the tier had no baseline to compare
 * and the record's state is left exactly as it is.
 */
type SelfDriftVerdict = "drift" | "unchanged" | "unverifiable";
type SelfDriftUnverifiableReason =
	| "bound-expired"
	| "stat-unavailable"
	| "missing-baseline"
	| "hash-budget-exhausted"
	| "hash-unavailable";

/**
 * Confirm a self-axis record against content, not mtime alone.
 *
 * mtime moving is not evidence that content changed: a `touch`, a `git
 * checkout` restoring identical bytes, a no-op formatter pass, or a `chmod`
 * all move it while every byte stays put. #2449 round 2 F7 settled this for
 * `observed-mutation.ts` ("a `touch` bumps it without a byte moving, so
 * mtime-only drift has to be confirmed against content before anything is
 * replayed"), and the same reasoning governs here, where an unconfirmed
 * demotion would walk a finding out of the authoritative channel.
 *
 * Two gates, in cost order. `size` decides most cases from the stat already
 * taken, with no mtime gate before it: an out-of-band write (a formatter,
 * a checkout) can land at-or-before the `recordedAtMs` baseline, so mtime alone
 * is blind to the own-file drift this axis exists to catch — the size gate fires
 * regardless of the mtime relationship. When the size matches, the hash tier
 * decides (#3504): an mtime fast path that skipped it for non-LSP records kept
 * a same-size rewrite that landed at-or-before the baseline, or inside its
 * tolerance, authoritative for the session. The hash separates a one-character
 * edit from a `touch`, reading the bytes and comparing against the baseline
 * the pipeline captured from the bytes it analysed.
 *
 * Both tiers fail toward `"unverifiable"`, never toward `"drift"`: a bound that
 * expires, a baseline that never landed, or a file past the per-sweep hash
 * budget all leave the record exactly as it is. Demoting on a verdict the tier
 * could not actually reach is the failure this function exists to prevent, and
 * `bounded()` returning `undefined` on timeout makes that an easy mistake to
 * write, so every bound's result is checked explicitly.
 */
async function detectSelfDrift(args: {
	filePath: string;
	recordedSize: number | undefined;
	recordedHash: string | undefined;
	signal: AbortSignal | undefined;
	/** Mutable per-sweep hash budget. See {@link SELF_DRIFT_HASH_BUDGET_BYTES}. */
	budget: { bytesLeft: number; exhausted: boolean };
}): Promise<{
	verdict: SelfDriftVerdict;
	unverifiableReason?: SelfDriftUnverifiableReason;
}> {
	const boundOptions = (label: string) =>
		({
			ms: HOOK_WALL_BUDGET_MS.turn_end,
			signal: args.signal,
			hook: "turn_end" as const,
			label,
		}) satisfies Parameters<typeof bounded>[1];

	// EVERY bound that expires yields `undefined`, and every one of those maps to
	// `unverifiable`, never to drift. A timed-out stat compared against the
	// recorded size would read as a size change and demote the record, which is
	// the exact failure this tier exists to prevent.
	const stat = await bounded(
		fs.promises.stat(args.filePath),
		boundOptions("selfDriftStat"),
	);
	if (stat === undefined)
		return { verdict: "unverifiable", unverifiableReason: "stat-unavailable" };
	// Size gate FIRST, and no mtime gate at all. mtime is a blind signal for the
	// out-of-band-rewrite case: an external write (a formatter, a checkout) can
	// land at-or-before the `recordedAtMs` baseline, so `freshnessFromMtime`
	// reports the own file unchanged even though its bytes differ. Size is cheap
	// content confirmation from the same stat, and it fires regardless of the
	// mtime relationship — the all-LSP own-file case the mtime gate alone misses.
	if (args.recordedSize === undefined)
		return { verdict: "unverifiable", unverifiableReason: "missing-baseline" };
	if (stat.size !== args.recordedSize) return { verdict: "drift" };
	// Same length. Only the hash can separate a one-character edit from a
	// `touch`, and a same-length edit is the common shape, not an exotic one.
	// Whatever the mtime says (#3504): a same-size rewrite can land at-or-before
	// the baseline, or inside its tolerance.
	if (args.recordedHash === undefined)
		return { verdict: "unverifiable", unverifiableReason: "missing-baseline" };
	// Defect shape 9: each read is individually bounded, but N blockers in one
	// turn is an unbounded AGGREGATE read on a hook path. The per-sweep byte
	// budget bounds the other axis; past it the record is unverifiable, not
	// drifted.
	if (stat.size > args.budget.bytesLeft) {
		args.budget.exhausted = true;
		return {
			verdict: "unverifiable",
			unverifiableReason: "hash-budget-exhausted",
		};
	}
	const content = await bounded(
		fs.promises.readFile(args.filePath),
		boundOptions("selfDriftHash"),
	);
	if (content === undefined)
		return { verdict: "unverifiable", unverifiableReason: "hash-unavailable" };
	args.budget.bytesLeft -= content.byteLength;
	const hash = hashContentBytes(content);
	return { verdict: hash === args.recordedHash ? "unchanged" : "drift" };
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
	implicitScope: ImplicitScopeCheck,
	/** Skip the own-file mtime tier after content confirms it is unchanged. */
	skipOwnFile = false,
): Promise<DriftResult> {
	const drifted: string[] = [];
	if (!skipOwnFile) {
		const ownFreshness = freshnessFromMtime({
			mtimeMs: await statMtimeMs(filePath),
			referenceMs: recordedAtMs,
		});
		if (ownFreshness.verdict === "stale") drifted.push(filePath);
	}
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
	const implicit = implicitScope(filePath, recordedAtMs);
	drifted.push(...implicit.drifted);
	return { drifted, truncated: truncated || implicit.truncated };
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
	/**
	 * #2982: which gate owns an existing demotion, so the loop can tell a
	 * latched demotion it must not touch from this gate's own re-armable one,
	 * which it re-evaluates every turn.
	 */
	staleReason: "dependency-drift" | "past-eof" | "self-drift" | undefined;
	/** #2982: the content tier's baselines. See `InlineBlockerRecord.recordedSize`. */
	recordedSize: number | undefined;
	recordedHash: string | undefined;
	/**
	 * #2982: the re-arming self-drift setter for the origin store, or undefined
	 * for a store that has none. Absent means the entry is not eligible for the
	 * self axis at all and stays authoritative, which is the fail-closed
	 * direction. Only the inline-blocker map supplies one; widget rows are
	 * pure-LSP by construction and take the import axis.
	 */
	setSelfDrift?: (isSelfDrift: boolean) => boolean;
}

/**
 * Whether a population entry is eligible for the drift check at all — the same
 * three gates the main sweep loop applies (not already stale, has a timestamp
 * baseline, HAS recorded provenance). Factored out so the #1790 review F5 dedup
 * decision below (chain vs. separate row) asks the IDENTICAL question the main
 * loop will ask, rather than a second hand-written approximation of it that
 * could drift from the real gates.
 *
 * The third gate reads "has provenance", not "is all-`lsp`": a non-LSP record is
 * now eligible for the self-drift axis (own file only, no import walk). Widening
 * it here and in the loop together is the point of the shared predicate — the
 * loop still decides WHICH axis each eligible entry gets.
 */
function isEligibleForDriftCheck(entry: {
	stale: boolean;
	recordedAtMs: number | undefined;
	sources: readonly string[] | undefined;
}): boolean {
	if (entry.stale) return false;
	if (entry.recordedAtMs === undefined) return false;
	return entry.sources !== undefined && entry.sources.length > 0;
}

/**
 * All recorded sources are `"lsp"` — the record gets the full own-file PLUS
 * forward-import walk. Anything else (tree-sitter, ast-grep, mixed, `"unknown"`)
 * gets the self-only axis. One spelling, shared by the sweep loop and the
 * chain decision below so the two can never disagree about which axis an entry
 * is on.
 */
function isAllLspSourced(sources: readonly string[] | undefined): boolean {
	return (
		sources !== undefined &&
		sources.length > 0 &&
		sources.every((source) => source === "lsp")
	);
}

/**
 * Whether a duplicated widget row may be CHAINED onto this inline entry's single
 * drift check instead of being given its own population row (#1790 review F5).
 *
 * Strictly stronger than {@link isEligibleForDriftCheck} since the self-drift
 * axis landed, and deliberately so. A widget row from
 * `getWidgetBlockingFilesForSweep` is pure-LSP by construction, so the check that
 * speaks for it must walk forward imports. An inline entry on the self-only axis
 * never consults imports, so chaining a widget row onto it would silently drop
 * that row's import axis — the #1790 ghost, in a new disguise: the inline entry
 * reports `kept`, the widget row is never independently checked, and its
 * `isBlocking` stays true for a dependency that drifted.
 *
 * Such an inline entry is still drift-checked on its own axis. It just cannot
 * answer another store's question.
 */
function canSubsumeLspWidgetRow(entry: {
	stale: boolean;
	recordedAtMs: number | undefined;
	sources: readonly string[] | undefined;
}): boolean {
	return isEligibleForDriftCheck(entry) && isAllLspSourced(entry.sources);
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
		selfHealed: 0,
		selfUnverifiable: 0,
		hashBudgetExhausted: 0,
	};
	const resolveForwardImports =
		options?.resolveForwardImports ?? extractForwardImportPaths;
	const implicitScope = createImplicitScopeCheck(runtime, cwd);
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
		staleReason?: "dependency-drift" | "past-eof" | "self-drift";
		recordedSize?: number;
		recordedHash?: string;
	}>;
	try {
		inlineEntries = runtime.getInlineBlockersSnapshot({
			sessionId: options?.sessionId,
		});
	} catch {
		return counts;
	}

	const population: SweepPopulationEntry[] = inlineEntries.map((entry) => ({
		filePath: entry.filePath,
		stale: entry.stale ?? false,
		recordedAtMs: entry.recordedAtMs,
		sources: entry.sources,
		staleReason: entry.staleReason,
		recordedSize: entry.recordedSize,
		recordedHash: entry.recordedHash,
		demote: () =>
			runtime.markInlineBlockerStale(entry.filePath, "dependency-drift"),
		setSelfDrift: (isSelfDrift: boolean) =>
			runtime.setInlineBlockerSelfDriftStale(entry.filePath, isSelfDrift),
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
		// unstamped legacy record, or a record with no provenance at all. Any of
		// those swallows a chained widget demote even though the widget row is
		// pure-LSP by construction (`getWidgetBlockingFilesForSweep` only emits
		// LSP-sourced rows) and carries its OWN baseline. Eligibility belongs to
		// the STORE the row came from, not the file path two stores happen to
		// share — so only chain when the inline entry would itself reach
		// `demote()`; otherwise give the widget row its own population entry so
		// its own gates and its own drift check decide its own fate.
		//
		// Since the self-drift axis landed, "would reach `demote()`" is no longer
		// enough: a non-LSP inline entry IS drift-checked now, but only against
		// its own file. It never consults imports, so it cannot speak for a
		// pure-LSP widget row whose dependency drifted. `canSubsumeLspWidgetRow`
		// carries that stronger test; the unrelated-ast-grep-finding case in the
		// paragraph above is now excluded by the axis, not by ineligibility.
		if (inlineEntry && canSubsumeLspWidgetRow(inlineEntry)) {
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
			// A widget row is pure-LSP by construction, so it takes the import
			// axis and never reaches the self axis. No `setSelfDrift` (#2982):
			// the widget store has no re-arming self-drift setter, and an entry
			// without one is not eligible for that axis.
			staleReason: undefined,
			recordedSize: undefined,
			recordedHash: undefined,
		});
	}

	counts.total = population.length;

	// One budget for the whole sweep (defect shape 9), consumed by the self
	// axis's hash tier as it goes.
	const hashBudget = {
		bytesLeft: SELF_DRIFT_HASH_BUDGET_BYTES,
		exhausted: false,
	};

	for (const entry of population) {
		try {
			// #2982: a latched demotion belongs to the gate that made it and this
			// loop leaves it alone. Its OWN self-drift demotion is re-armable, so
			// it is re-derived every turn instead: bytes that come back must
			// un-demote the record, which is what lets the self axis skip the
			// #1950 delivery cap rather than retire a security finding for good.
			const selfDriftDemoted =
				entry.stale && entry.staleReason === "self-drift";
			if (entry.stale && !selfDriftDemoted) {
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
			// #1631 review F4 kept every non-`"lsp"` record at full authority. Its
			// stated reason is about the IMPORT axis only — "an ast-grep secret match
			// doesn't stop being true because a file it imports was edited" — but the
			// gate discarded the self axis with it. A record with NO provenance at all
			// stays fail-closed here, the same test
			// `retireInlineBlockerOnConfirmedClean` applies before it will retire.
			const recordedSources =
				entry.sources !== undefined && entry.sources.length > 0
					? entry.sources
					: undefined;
			if (recordedSources === undefined) {
				counts.kept += 1;
				continue;
			}
			// #2982 remainder: the record's OWN file is checked via the content-
			// confirmed self-drift axis (size → hash, re-arming) for records that
			// have a re-arming setter — shared by the non-LSP self axis below and
			// the all-LSP axis. The mtime-only own-file check in `detectDrift` is
			// blind to the out-of-band-rewrite case (an external write can land at-
			// or-before the `recordedAtMs` baseline), so the content axis owns the
			// own-file verdict when it can decide. One bounded() call site for both
			// axes — the #2523 registry requires a single occurrence, so the two
			// branches must not each wrap the identical call. Demotion, not deletion
			// (#1419): a demoted entry is re-served in the advisory channel marked
			// `[stale — re-run to confirm]` and retires through the existing #1950
			// delivery cap.
			const setSelfDrift = entry.setSelfDrift;
			const isLspSourced = isAllLspSourced(recordedSources);
			let ownVerdict: SelfDriftVerdict | undefined;
			if (setSelfDrift) {
				// The outer bound too: an expired one yields `undefined`, and that
				// means "could not decide", never "changed".
				const hashBudgetWasExhausted = hashBudget.exhausted;
				const selfDrift = (await bounded(
					(signal) =>
						detectSelfDrift({
							filePath: entry.filePath,
							recordedSize: entry.recordedSize,
							recordedHash: entry.recordedHash,
							signal,
							budget: hashBudget,
						}),
					{
						ms: HOOK_WALL_BUDGET_MS.turn_end,
						signal: options?.signal,
						hook: "turn_end",
						label: "detectSelfDrift",
					},
				)) ?? {
					verdict: "unverifiable" as const,
					unverifiableReason: "bound-expired" as const,
				};
				ownVerdict = selfDrift.verdict;
				if (ownVerdict === "unverifiable") {
					// Decide nothing. Leave the record in whatever state it holds.
					counts.selfUnverifiable += 1;
					const reason =
						selfDrift.unverifiableReason ??
						(hashBudgetWasExhausted || hashBudget.exhausted
							? "hash-budget-exhausted"
							: "hash-unavailable");
					recordDegradationOnce({
						kind: "self-drift-unverifiable",
						subject: `inline-blocker:${toRunnerDisplayPath(cwd, entry.filePath)}#${reason}`,
						reason: `the self-drift check was unverifiable: ${reason}`,
					});
					if (reason === "hash-budget-exhausted") {
						recordDegradationOnce({
							kind: "self-drift-hash-budget-exhausted",
							subject: `inline-blocker:${toRunnerDisplayPath(cwd, entry.filePath)}`,
							reason: "the aggregate self-drift hash budget was exhausted",
						});
					}
				}
			}
			if (!isLspSourced) {
				// The self axis. Content-confirmed, re-arming, and outside the
				// #1950 delivery cap. A store with no re-arming setter is not
				// eligible for it and stays authoritative (fail-closed).
				if (!setSelfDrift || ownVerdict === undefined) {
					counts.kept += 1;
					continue;
				}
				if (ownVerdict === "unverifiable") {
					if (selfDriftDemoted) counts.alreadyStale += 1;
					else counts.kept += 1;
					continue;
				}
				const shouldDemote = ownVerdict === "drift";
				const transitioned = setSelfDrift(shouldDemote);
				if (shouldDemote) {
					if (transitioned) counts.revalidated += 1;
					else counts.alreadyStale += 1;
				} else if (transitioned) {
					counts.selfHealed += 1;
				} else {
					counts.kept += 1;
				}
				continue;
			}
			// The LSP axis (#1618). The own file is checked by the content axis
			// above when a baseline was captured; without one it falls back to the
			// mtime check (the pre-#2982 behavior, fail-open). The forward-import
			// walk stays on the one-way dependency-drift axis.
			let contentDecidedOwnFile = false;
			if (
				setSelfDrift !== undefined &&
				ownVerdict !== undefined &&
				entry.recordedSize !== undefined
			) {
				if (ownVerdict === "drift") {
					const transitioned = setSelfDrift(true);
					if (transitioned) counts.revalidated += 1;
					else counts.alreadyStale += 1;
					// Own file drifted; the record is out of the authoritative
					// channel, so the import walk is moot this turn.
					continue;
				}
				if (ownVerdict === "unchanged") {
					// Content confirms the own file is unchanged: skip the mtime check
					// below (a `touch` must not demote a still-valid record), and
					// un-demote a record self-drifted last turn.
					contentDecidedOwnFile = true;
					const transitioned = setSelfDrift(false);
					if (transitioned) counts.selfHealed += 1;
				} else {
					// "unverifiable": the content axis could not decide (a stat that
					// failed, or a size that matched but whose hash never landed). Fall
					// back to the mtime check below.
					if (selfDriftDemoted) {
						counts.alreadyStale += 1;
						continue;
					}
				}
			}
			// Forward-import walk (one-way dependency-drift). Skip the own file ONLY
			// when the content axis decided it "unchanged" — the one case where the
			// mtime check would wrongly demote on a `touch`. A widget row (no setter)
			// and an inline entry without a baseline never reach the content axis, so
			// they still get the mtime own-file check (fail-open).
			const skipOwnFile = contentDecidedOwnFile;
			const { drifted, truncated } = await detectDrift(
				cwd,
				entry.filePath,
				entry.recordedAtMs,
				resolveForwardImports,
				turnIndex,
				implicitScope,
				skipOwnFile,
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
	counts.hashBudgetExhausted = hashBudget.exhausted ? 1 : 0;
	return counts;
}
