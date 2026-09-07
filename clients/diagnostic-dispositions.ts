/**
 * Agent+user disposition layer over dispatch diagnostics (#690, unifying #181/
 * #503/#504's discussion). Four dispositions:
 *
 *   false-positive — the rule misfired. Project-persistent, routed nowhere
 *                     special yet (telemetry hookup is a fast-follow).
 *   suppress       — real finding, deliberate policy not to fix. Persistent,
 *                     but the mechanism is an inline `pi-lens-ignore` comment
 *                     written into the source (see suppress-writer.ts), not
 *                     just a store entry — portable, git-visible, discoverable
 *                     without pi-lens's own store. The store entry here is an
 *                     audit-trail mirror, not the enforcement point.
 *   defer          — fix later, not now. Session-ephemeral: held in memory
 *                     only, so it naturally resurfaces on process restart —
 *                     never persisted, never needs pruning.
 *   flagged        — user wants the agent to fix this. Persistent until
 *                     resolved; surfaced through the existing lens_diagnostics
 *                     query (tagged), not a separate file/tool the agent has
 *                     to separately poll.
 *
 * Anchoring: TWO flavors, chosen per-disposition because each one binds to a
 * different thing conceptually:
 *
 *   STRICT ("dd:" prefix) — relativeFile|tool|rule|normalizedMessage|
 *     lineContentHash(diagnostic's own line). Used ONLY for false-positive: a
 *     false-positive judgment is about THIS specific piece of code — if the
 *     line is rewritten, the rule earned a fresh chance to fire on the new
 *     content, so the mark should NOT follow it. Reuses read-guard's
 *     lineContentHash so a no-op formatter/whitespace pass doesn't rot the
 *     anchor, while a semantic edit to the flagged line correctly invalidates
 *     it.
 *   WEAK ("ddw:" prefix) — relativeFile|tool|rule|normalizedMessage, no line
 *     hash at all. Used for defer, flagged, and suppress: these are
 *     intent-level judgments ("I'll get to this", "fix this", "policy says
 *     don't") about a finding identity, not about one exact line's bytes —
 *     they must survive incidental edits elsewhere on the flagged line
 *     (reformatting, a nearby rename) without silently dropping the mark.
 *     suppress's real enforcement is the inline comment (see
 *     suppress-writer.ts) which travels with the code by construction; the
 *     weak-anchored store entry is just an audit mirror plus a second,
 *     belt-and-braces filter.
 *
 * Distinct prefixes ("dd:" vs "ddw:") keep the two id spaces from ever
 * colliding in the same store.
 *
 * Content is hashed only from the diagnostic's own line (for the strict
 * anchor), not a surrounding window as #181's original sketch considered.
 * Two diagnostics on the same file/tool/rule/message whose flagged line
 * happens to have identical content collide on the SAME strict anchor —
 * deliberately: identical content at the same rule/message is a semantically
 * equivalent finding, so marking one intentionally marks all of them (e.g. a
 * copy-pasted line repeated a few times in the same file). If that
 * assumption proves wrong in practice, a surrounding-window hash can be
 * layered on later without changing the store shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { commitDurableStore } from "./durable-store.js";
import { logDispositionEvent } from "./disposition-logger.js";
import { publishDisposition } from "./disposition-publish.js";
import { getProjectDataDir } from "./file-utils.js";
import {
	normalizeMessage as sharedNormalizeMessage,
	relativeFile as sharedRelativeFile,
	stableFindingId,
} from "./finding-identity.js";
import { normalizeMapKey } from "./path-utils.js";
import { lineContentHash } from "./read-guard.js";

/** Minimal shape a diagnostic needs for anchoring/filtering — deliberately
 * narrower than dispatch's `Diagnostic` so this also works over
 * `WidgetDiagnostic` (widget-state.ts), which carries no `id`/`filePath`. */
export interface DispositionCandidate {
	tool?: string;
	rule?: string;
	message: string;
	line?: number;
	/**
	 * Output tier, when the caller has one to give (mirrors dispatch's
	 * `Diagnostic.semantic` / `ProjectDiagnostic.semantic`). Review-round F1
	 * (#1625): a `"blocking"` finding may be dropped ONLY by a STRICT,
	 * content-bound anchor match (false-positive) — never by a WEAK-anchored
	 * suppress/defer. Two distinct secrets sharing the same rule/message (e.g.
	 * two different AWS keys) collapse onto the SAME weak anchor
	 * (`relativeFile|tool|rule|normalizedMessage`, no line-content hash), so a
	 * weak suppress on one silently silenced the other too — unacceptable for
	 * a STOP-tier finding, where "silenced" means "shipped." A missing/
	 * undefined `semantic` is treated as NOT blocking (today's behavior,
	 * unchanged) — this is an opt-in tightening for callers that know their
	 * tier, not a default lockdown of every existing caller. Typed as a plain
	 * `string` (checked against the literal `"blocking"` at the call site)
	 * rather than a narrow union so this interface stays compatible with every
	 * caller's own wider semantic type (dispatch's `OutputSemantic`,
	 * `WidgetDiagnostic`'s `string | undefined`, `ProjectDiagnostic`'s
	 * `ProjectDiagnosticSemantic`) without a cast at every call site.
	 */
	semantic?: string;
}

export type Disposition = "false-positive" | "suppress" | "defer" | "flagged";
type PersistedDisposition = Exclude<Disposition, "defer">;

export interface DispositionEntry {
	disposition: PersistedDisposition;
	reason?: string;
	createdAt: string;
	lastSeenAt: string;
	/** Last-known position/content of the flagged line at mark time. Only
	 * populated for `flagged` — since flagged is weak-anchored (survives line
	 * drift), the agent needs SOME breadcrumb back to where the finding was
	 * when a bare anchor id is no longer enough to relocate it. */
	line?: number;
	lineText?: string;
}

interface DispositionStateFile {
	dispositions?: Record<string, DispositionEntry>;
}

// "defer" is session-ephemeral by design (#690) — held only in memory so it
// resurfaces for free on the next process run, with no expiry/pruning logic
// needed. Stores WEAK anchors (see module doc) so a deferred finding stays
// hidden all session even if the flagged line itself is edited.
//
// Review-round F3 (#1625): this Set is process-GLOBAL, but a weak anchor
// itself only encodes a RELATIVE path (`relativeFile` derives it from
// `path.relative(cwd, filePath)`, never the cwd's own identity) plus
// tool/rule/normalizedMessage — two unrelated projects sharing the same
// relative path/tool/rule/message (e.g. "src/auth.ts" flagged by the same
// eslint rule in project A and project B) collapse onto the IDENTICAL weak
// anchor string. A defer in project A therefore silently suppressed the same
// finding in project B for the rest of the process's life. Every read/write
// below goes through `deferredKey`, which folds the resolved cwd into the Set
// key, so the two projects can no longer collide.
const deferredThisSession = new Set<string>();

function deferredKey(cwd: string, anchor: string): string {
	return `${normalizeMapKey(cwd)}::${anchor}`;
}

/** Exported (#802) so lens-diagnostic-mark's cross-check against live widget
 * diagnostics matches a message the same way anchor derivation does — a
 * second, slightly different normalizer would make a real match invisible.
 * Re-exports the shared `finding-identity.js` normalizer (#1816) so this
 * module keeps its existing public surface. */
export const normalizeMessage = sharedNormalizeMessage;

// Anchor derivation chokepoint (#1024, #210 class): the `dd:`/`ddw:` id builders
// (computeStrictAnchor/computeWeakAnchor) both derive their path component here,
// so a mark and its later lookup diverge whenever the two callers pass different
// path FORMS of the same file. That is exactly the bug: the mark tool
// (lens-diagnostic-mark.ts) passes a RAW cwd / `path.resolve(cwd, arg)`, while
// the dispatch read side (dispatcher.ts createDispatchContext) passes
// `normalizeMapKey`-canonicalized cwd/filePath — so a Windows drive/segment
// case, symlink/realpath, or slash difference between the two forms silently
// orphans the agent's own false-positive/flagged mark (a #533 dropped-signal).
// Canonicalize BOTH inputs through `normalizeMapKey` (the SAME normalizer the
// read side already relies on — realpathSync.native on Windows) BEFORE computing
// the relative path, so write and read produce identical anchors regardless of
// the form the caller held. `normalizeMapKey` is idempotent, so the already-
// canonicalized read side is unaffected; the realpath I/O is acceptable here
// because dispositions are marked/applied far less often than the per-write
// widget hot path, and the read side already pays exactly this cost. Semantics
// are unchanged: the `..`-escape fallback still returns the canonical filePath,
// only now in the same canonical form the non-escape branch uses.
//
// #1816: this used to be a local copy; it is now `finding-identity.js`'s
// `relativeFile` (identical body — canonicalize both inputs through
// `normalizeMapKey` before relativizing), re-exported so the rest of this
// file, and the module doc/comments above referencing `relativeFile`, keep
// working unchanged.
const relativeFile = sharedRelativeFile;

export interface DispositionAnchorArgs {
	cwd: string;
	filePath: string;
	tool?: string;
	rule?: string;
	message: string;
	line?: number;
	/** File content to hash the diagnostic's own line from (strict anchor
	 * only — the weak anchor never looks at this). Omit only when the
	 * content genuinely isn't available — the strict anchor then falls back
	 * to an empty line hash, which is stable but less resistant to another
	 * finding on the same file/rule/message colliding. */
	content?: string;
}

/** Site-specific anchor — see module doc. Used only for false-positive. */
export function computeStrictAnchor(args: DispositionAnchorArgs): string {
	const lines = args.content?.split(/\r?\n/);
	const lineText =
		args.line !== undefined && lines ? (lines[args.line - 1] ?? "") : "";
	return stableFindingId("dd:", {
		cwd: args.cwd,
		filePath: args.filePath,
		parts: [
			args.tool ?? "",
			args.rule ?? "",
			normalizeMessage(args.message),
			lineContentHash(lineText),
		],
	});
}

/** Intent-level anchor — see module doc. Used for defer/flagged/suppress. */
function computeWeakAnchor(args: DispositionAnchorArgs): string {
	return stableFindingId("ddw:", {
		cwd: args.cwd,
		filePath: args.filePath,
		parts: [args.tool ?? "", args.rule ?? "", normalizeMessage(args.message)],
	});
}

/** Both anchors a stored/filtered diagnostic would compute — the one shared
 * derivation both the dispatch-pipeline filter and lens-diagnostics' flagged
 * tag lookup must use so a mark and a fresh diagnostic converge on the same
 * ids. */
export function anchorsForDiagnostic(
	cwd: string,
	filePath: string,
	diagnostic: DispositionCandidate,
	content: string,
): { strict: string; weak: string } {
	const args: DispositionAnchorArgs = {
		cwd,
		filePath,
		tool: diagnostic.tool,
		rule: diagnostic.rule,
		message: diagnostic.message,
		line: diagnostic.line,
		content,
	};
	return { strict: computeStrictAnchor(args), weak: computeWeakAnchor(args) };
}

function statePath(cwd: string): string {
	return path.join(
		getProjectDataDir(cwd),
		"cache",
		"diagnostic-dispositions.json",
	);
}

// mtime+size-keyed memoization: applyDispositions runs on EVERY per-edit
// dispatch (hot path), so re-parsing this JSON file on every call is wasted
// work once a project accumulates any real number of dispositions. Keyed on
// (path, mtimeMs, size) rather than just path so an external edit/write is
// still picked up; `missing` caches the "no state file yet" case too (very
// common — most files never get a disposition) until a write actually
// creates one.
interface StateCache {
	path: string;
	missing: boolean;
	mtimeMs: number;
	size: number;
	state: DispositionStateFile;
}
let stateCache: StateCache | null = null;

const DISPOSITION_LOCK_WAIT_MS = 2_000;
const DISPOSITION_LOCK_RETRY_MS = 10;

let beforeDispositionCommitForTests: (() => void) | null = null;
let beforeDispositionCacheRefreshForTests: (() => void) | null = null;
let dispositionStatSync: typeof fs.statSync = fs.statSync;

/** Test seam after the caller's cached read and before commit lock acquisition. */
export function _setBeforeDispositionCommitForTests(
	hook: (() => void) | null,
): void {
	beforeDispositionCommitForTests = hook;
}

/** Test seam immediately before the committed state refreshes the cache. */
export function _setBeforeDispositionCacheRefreshForTests(
	hook: (() => void) | null,
): void {
	beforeDispositionCacheRefreshForTests = hook;
}

export function _setDispositionStatForTests(
	statSync: typeof fs.statSync | null,
): void {
	dispositionStatSync = statSync ?? fs.statSync;
}

/**
 * Zero-I/O guard for cache-only callers (lens_diagnostics delta/all): true
 * when ANY disposition mark or session defer exists, so a caller can skip its
 * whole strict/weak filter — including every file stat/read the strict branch
 * would need — in the overwhelmingly common no-marks case. Same hoist shape as
 * applyDispositionsMultiFile's #1625 F2 empty-store early return; `readState`
 * is mtime+size stat-cached, so repeated calls cost one stat.
 */
export function hasAnyDispositionMarks(cwd: string): boolean {
	return Boolean(readState(cwd).dispositions) || deferredThisSession.size > 0;
}

/**
 * True when the project's disposition store holds at least one STRICT-anchored
 * `false-positive` mark — the only disposition kind whose immediate application
 * needs file content. A store with only weak suppress/defer marks can never
 * produce a strict-anchor match, so cache-only callers can serve them through
 * the zero-I/O weak filter and skip every stat/read the strict path would
 * charge.
 */
export function hasStrictDispositionMarks(cwd: string): boolean {
	const dispositions = readState(cwd).dispositions;
	if (!dispositions) return false;
	for (const key of Object.keys(dispositions)) {
		if (dispositions[key]?.disposition === "false-positive") return true;
	}
	return false;
}

// Test seam for `applyDispositionsMultiFile`'s per-group content read (#1625
// F2) — Vitest can't `vi.spyOn` a bare ESM `node:fs` named export directly
// ("Module namespace is not configurable in ESM"), so the F2 regression test
// (proving the empty-store hoist means zero reads, not just fast ones)
// swaps this indirection instead, mirroring `dispositionStatSync` above.
let multiFileReadFileSync: typeof fs.readFileSync = fs.readFileSync;

export function _setMultiFileReadForTests(
	readFileSync: typeof fs.readFileSync | null,
): void {
	multiFileReadFileSync = readFileSync ?? fs.readFileSync;
}
function readState(cwd: string): DispositionStateFile {
	const p = statePath(cwd);
	let stat: fs.Stats;
	try {
		stat = dispositionStatSync(p);
	} catch {
		if (stateCache && stateCache.path === p && stateCache.missing) {
			return stateCache.state;
		}
		const empty: DispositionStateFile = {};
		stateCache = {
			path: p,
			missing: true,
			mtimeMs: -1,
			size: -1,
			state: empty,
		};
		return empty;
	}
	if (
		stateCache &&
		stateCache.path === p &&
		!stateCache.missing &&
		stateCache.mtimeMs === stat.mtimeMs &&
		stateCache.size === stat.size
	) {
		return stateCache.state;
	}
	let state: DispositionStateFile;
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
		state =
			parsed && typeof parsed === "object"
				? (parsed as DispositionStateFile)
				: {};
	} catch {
		// Now that writeState is tmp+rename atomic, a torn read (another process
		// mid-write) can no longer land here — this only fires on genuine
		// corruption/wrong-shape content. Caching `{}` against this stat is still
		// correct, not a permanent trap: any future rewrite of the file (a fix,
		// or this process's own next writeState) changes mtime/size, which
		// invalidates the cache below on the next readState call. Only a file
		// that never changes again would serve empty state forever — and
		// reparsing the same invalid bytes every hot-path call would yield the
		// same `{}` anyway, so the cache costs nothing in that case.
		state = {};
	}
	stateCache = {
		path: p,
		missing: false,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		state,
	};
	return state;
}

function deserializeState(contents: string | undefined): DispositionStateFile {
	try {
		const parsed = JSON.parse(contents ?? "") as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as DispositionStateFile)
			: {};
	} catch {
		return {};
	}
}

// Atomic tmp+rename via clients/atomic-write.ts (#762; shared with
// instance-registry.ts / recent-touches.ts / review-graph/builder.ts): a
// cross-process reader must never observe a partially-written file —
// rename() replaces the destination atomically on both POSIX and Windows
// (libuv uses MOVEFILE_REPLACE_EXISTING), so a concurrent readState sees
// either the old JSON or the new JSON, never a torn write that fails to
// parse. Unlike those best-effort writers, `bestEffort: false` here means a
// failure still propagates (matches the pre-atomic writeFileSync's behavior,
// which never swallowed errors either) — a disposition mark silently vanishing
// is a correctness bug for this store, not just a lost observability sample.
function refreshStateCache(p: string, state: DispositionStateFile): void {
	// Refresh the cache from the write we just did instead of invalidating it —
	// avoids an immediate re-stat+re-parse of the file we already have in hand,
	// and guards against coarse filesystem mtime granularity making a
	// read-immediately-after-write look like a cache hit on stale data.
	const stat = fs.statSync(p);
	stateCache = {
		path: p,
		missing: false,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		state,
	};
}

function commitDisposition(
	cwd: string,
	anchor: string,
	entry: DispositionEntry,
): void {
	const p = statePath(cwd);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const hook = beforeDispositionCommitForTests;
	beforeDispositionCommitForTests = null;
	hook?.();
	commitDurableStore({
		path: p,
		deserialize: deserializeState,
		merge: (state) => {
			state.dispositions ??= {};
			state.dispositions[anchor] = entry;
			return state;
		},
		serialize: (state) => JSON.stringify(state, null, 2),
		waitMs: DISPOSITION_LOCK_WAIT_MS,
		retryMs: DISPOSITION_LOCK_RETRY_MS,
		timeoutMessage: "timed out acquiring diagnostic disposition store lock",
		onContention: "throw",
		afterWriteLocked: (state) => {
			const cacheHook = beforeDispositionCacheRefreshForTests;
			beforeDispositionCacheRefreshForTests = null;
			cacheHook?.();
			refreshStateCache(p, state);
		},
	});
}

/** Test-only escape hatch — the state cache is module-level, so tests that
 * write the store file out-of-band (or across separate cwds sharing a stat
 * coincidence) need to reset it between cases. */
export function _resetStateCacheForTests(): void {
	stateCache = null;
}

/** Target diagnostic info for markDisposition/isDeferredThisSession-adjacent
 * calls — a superset of DispositionAnchorArgs (same fields), named
 * separately because the tool site conceptually has "a diagnostic" rather
 * than "anchor args" in hand. */
export type DispositionMarkTarget = DispositionAnchorArgs;

/** Fire-and-forget mark telemetry (see markDisposition's doc): the NDJSON log
 * entry (project-relative path — rule-tuning data, not machine layout) and
 * the bus event (absolute normalized path — in-process consumers navigate).
 * Neither can throw into the mark path; both are already internally
 * fail-safe, but the try/catch keeps a future regression in either from
 * breaking a mark. */
function emitMarkTelemetry(
	cwd: string,
	target: DispositionMarkTarget,
	disposition: Disposition,
	anchor: string,
	reason: string | undefined,
	existing: DispositionEntry | undefined,
	identity: { model?: string; provider?: string } | undefined,
): void {
	try {
		logDispositionEvent({
			event: "mark",
			disposition,
			tool: target.tool,
			rule: target.rule,
			filePath: relativeFile(target.filePath, cwd),
			line: target.line,
			reason,
			anchor,
			previousDisposition: existing?.disposition,
			model: identity?.model || undefined,
			provider: identity?.provider || undefined,
		});
		publishDisposition({
			cwd,
			filePath: target.filePath,
			disposition,
			tool: target.tool,
			rule: target.rule,
			line: target.line,
			anchor,
			reason,
		});
	} catch {
		// never let telemetry break a mark
	}
}

/**
 * Record a disposition. Picks the anchor flavor per-disposition (see module
 * doc): strict for false-positive, weak for everything else. Returns the
 * anchor actually used, so callers (the mark tool) can report/verify it.
 *
 * This is THE single choke point for mark telemetry — the NDJSON log
 * (disposition-logger.ts, #181's FP-rule-tuning signal) and the
 * `pilens:diagnostic:disposition` bus event (disposition-publish.ts) both
 * hang off it, so the agent tool and any future UI caller are covered without
 * per-caller wiring.
 */
export function markDisposition(
	cwd: string,
	target: DispositionMarkTarget,
	disposition: Disposition,
	reason?: string,
	identity?: { model?: string; provider?: string },
): string {
	const anchor =
		disposition === "false-positive"
			? computeStrictAnchor(target)
			: computeWeakAnchor(target);
	// Captured for BOTH branches: a defer never writes the store, but a store
	// entry can already exist at the same weak anchor (a prior flagged/suppress
	// mark) — the log should record what this mark shadowed either way.
	const existing = readState(cwd).dispositions?.[anchor];
	if (disposition === "defer") {
		deferredThisSession.add(deferredKey(cwd, anchor));
		emitMarkTelemetry(
			cwd,
			target,
			disposition,
			anchor,
			reason,
			existing,
			identity,
		);
		return anchor;
	}

	const now = new Date().toISOString();
	const capturesFixContext = disposition === "flagged";
	const lineText = capturesFixContext
		? (
				target.content?.split(/\r?\n/)[
					target.line !== undefined ? target.line - 1 : -1
				] ?? existing?.lineText
			)?.trim()
		: existing?.lineText;
	const entry: DispositionEntry = {
		disposition,
		reason: reason ?? existing?.reason,
		createdAt: existing?.createdAt ?? now,
		lastSeenAt: now,
		line: capturesFixContext ? (target.line ?? existing?.line) : existing?.line,
		lineText,
	};
	commitDisposition(cwd, anchor, entry);
	emitMarkTelemetry(
		cwd,
		target,
		disposition,
		anchor,
		reason,
		existing,
		identity,
	);
	return anchor;
}

export function getDisposition(
	cwd: string,
	anchor: string,
): DispositionEntry | undefined {
	return readState(cwd).dispositions?.[anchor];
}

/** #1625 F3: `anchor` alone is ambiguous across projects — a weak anchor
 * encodes only a RELATIVE path plus tool/rule/message, never the project's
 * own identity, so `cwd` must be supplied to disambiguate which project's
 * defer is being checked. */
export function isDeferredThisSession(cwd: string, anchor: string): boolean {
	return deferredThisSession.has(deferredKey(cwd, anchor));
}

/** Test-only escape hatch — defer state is module-level (one process = one
 * session), so tests need to reset it between cases. */
export function _resetDeferredForTests(): void {
	deferredThisSession.clear();
}

/**
 * Drop diagnostics disposed false-positive/suppress, or deferred this session,
 * from `diagnostics`. `flagged` diagnostics are kept as-is — callers that want
 * to surface the flag (e.g. lens_diagnostics' rendering) look it up separately
 * via getDisposition on the WEAK anchor (anchorsForDiagnostic(...).weak).
 *
 * Computes both anchors per diagnostic (cheap — same hash primitive, twice)
 * since false-positive is keyed strict while defer/suppress are keyed weak;
 * see module doc for why each disposition binds the way it does.
 *
 * Review-round F1 (#1625): a `d.semantic === "blocking"` diagnostic can be
 * dropped ONLY by the STRICT (false-positive) branch — never by a WEAK-
 * anchored suppress or defer. Two distinct secrets sharing the same
 * rule/message (e.g. two different AWS keys on different lines) collapse
 * onto the SAME weak anchor, so a weak suppress/defer on one would silently
 * silence the other too; unacceptable for a STOP-tier finding. `flagged` is
 * unaffected either way — it never drops anything, blocking or not.
 */
export function applyDispositions<T extends DispositionCandidate>(
	diagnostics: T[],
	cwd: string,
	filePath: string,
	content: string,
): T[] {
	if (!diagnostics.length) return diagnostics;
	const dispositions = readState(cwd).dispositions;
	if (!dispositions && deferredThisSession.size === 0) return diagnostics;
	return diagnostics.filter((d) => {
		const { strict, weak } = anchorsForDiagnostic(cwd, filePath, d, content);
		const isBlocking = d.semantic === "blocking";
		if (!isBlocking && deferredThisSession.has(deferredKey(cwd, weak))) {
			return false;
		}
		if (dispositions?.[strict]?.disposition === "false-positive") return false;
		// Belt-and-braces: the inline `pi-lens-ignore` comment is the real
		// suppress enforcement (see suppress-writer.ts) and normally already
		// dropped this finding upstream via applyInlineSuppressions. This is a
		// harmless second cover for the store-only audit trail case — gated
		// off blocking findings per F1 above (the inline comment, unaffected
		// by this gate, remains the real suppress mechanism for those too).
		if (!isBlocking && dispositions?.[weak]?.disposition === "suppress") {
			return false;
		}
		return true;
	});
}

/**
 * WEAK-anchor-only disposition filter for the "instant" (cache-only)
 * lens_diagnostics modes (delta/all). Drops diagnostics disposed `suppress`
 * or deferred this session — both WEAK-anchored (`file|tool|rule|message`, no
 * line-content hash; see module doc), so this needs ZERO file I/O: it computes
 * only the weak anchor and never touches the diagnostic's line content.
 *
 * `false-positive` is deliberately NOT filtered here: it is STRICT-anchored,
 * which requires the flagged line's content to re-derive its hash, and reading
 * every findings file just for that would defeat the instant contract of these
 * cache-only modes. A false-positive mark still filters at the next per-edit
 * dispatch (`dispatcher.ts`) and in `mode=full`'s merge — both of which already
 * have file content in hand and call `applyDispositions` (the full,
 * content-based filter). suppress/defer, being intent-level and weak-anchored,
 * are the marks that must apply the instant a query re-serves cached findings,
 * and they do so here without any read.
 *
 * Review-round F1 (#1625): this filter is ENTIRELY weak-anchored — it has no
 * strict-anchor branch to fall back to — so a `d.semantic === "blocking"`
 * diagnostic is never dropped here at all, regardless of any suppress/defer
 * mark. The full `applyDispositions` (content in hand, at the next per-edit
 * dispatch or mode=full merge) is the only place a blocking finding can ever
 * be suppressed, and only via its STRICT branch.
 */
export function applyWeakDispositions<T extends DispositionCandidate>(
	diagnostics: T[],
	cwd: string,
	filePath: string,
): T[] {
	if (!diagnostics.length) return diagnostics;
	const dispositions = readState(cwd).dispositions;
	if (!dispositions && deferredThisSession.size === 0) return diagnostics;
	return diagnostics.filter((d) => {
		if (d.semantic === "blocking") return true;
		const weak = computeWeakAnchor({
			cwd,
			filePath,
			tool: d.tool,
			rule: d.rule,
			message: d.message,
			line: d.line,
		});
		if (deferredThisSession.has(deferredKey(cwd, weak))) return false;
		if (dispositions?.[weak]?.disposition === "suppress") return false;
		return true;
	});
}

/**
 * Multi-file variant of {@link applyDispositions} for lanes whose findings
 * span many files in ONE report — gitleaks/trivy/govulncheck/opengrep
 * project-wide scans (#1617), unlike the dispatch path's one-`ctx.filePath`-
 * at-a-time shape. Groups by `filePathOf(diagnostic)`, reads each file's
 * CURRENT content once, then delegates to `applyDispositions` per group —
 * same anchor derivation, same strict/weak split, no cloned logic (#1617's
 * single-source-of-truth requirement).
 *
 * Content read is best-effort: a file that no longer exists, or that this
 * process can't read, degrades to `content: ""` for that group rather than
 * dropping its diagnostics outright. `applyDispositions` already treats a
 * missing/empty content argument safely — the STRICT (false-positive) anchor
 * hashes the diagnostic's own line, so an empty content can't collide with a
 * mark made against the file's real content and the finding simply isn't
 * matched (fails OPEN — still reported); the WEAK anchor (suppress/defer)
 * never looks at content at all, so those marks keep applying regardless.
 * This is a deliberate choice, not an oversight: a security finding must
 * never silently vanish just because its file went unreadable at filter
 * time (a security finding staying VISIBLE on a read failure is the safe
 * default; a stale mark quietly reappearing is recoverable, a leaked secret
 * quietly disappearing is not).
 *
 * Review-round F2 (#1625): the empty-store early return is checked HERE,
 * before any per-group file read — not left to `applyDispositions` to notice
 * once already inside the per-group loop. Every mode=full analyzer call
 * (9 lanes) runs through this on every scan, and the overwhelmingly common
 * case is zero marks in the project; measured ~270ms of synchronous
 * `fs.readFileSync` per analyzer per run for that common case before this
 * hoist (reading every finding's file just to discover there was nothing to
 * filter), ~0-1ms after.
 */
export function applyDispositionsMultiFile<T extends DispositionCandidate>(
	diagnostics: T[],
	cwd: string,
	filePathOf: (diagnostic: T) => string,
): T[] {
	if (!diagnostics.length) return diagnostics;
	const dispositions = readState(cwd).dispositions;
	if (!dispositions && deferredThisSession.size === 0) return diagnostics;
	const groups = new Map<string, T[]>();
	for (const d of diagnostics) {
		const filePath = filePathOf(d);
		const group = groups.get(filePath);
		if (group) group.push(d);
		else groups.set(filePath, [d]);
	}
	const kept = new Set<T>();
	for (const [filePath, group] of groups) {
		let content = "";
		try {
			content = multiFileReadFileSync(filePath, "utf-8");
		} catch {
			// Unreadable/missing — fail open, see doc above.
		}
		for (const d of applyDispositions(group, cwd, filePath, content)) {
			kept.add(d);
		}
	}
	// Preserve the caller's original order/dedup by reference rather than the
	// per-group insertion order above.
	return diagnostics.filter((d) => kept.has(d));
}
