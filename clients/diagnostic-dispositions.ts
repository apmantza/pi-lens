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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logDispositionEvent } from "./disposition-logger.js";
import { publishDisposition } from "./disposition-publish.js";
import { getProjectDataDir } from "./file-utils.js";
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
}

export type Disposition = "false-positive" | "suppress" | "defer" | "flagged";
export type PersistedDisposition = Exclude<Disposition, "defer">;

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
const deferredThisSession = new Set<string>();

function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}

function relativeFile(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") ? rel : normalizeMapKey(filePath);
}

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
	const parts = [
		relativeFile(args.filePath, args.cwd),
		args.tool ?? "",
		args.rule ?? "",
		normalizeMessage(args.message),
		lineContentHash(lineText),
	];
	return `dd:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
}

/** Intent-level anchor — see module doc. Used for defer/flagged/suppress. */
export function computeWeakAnchor(args: DispositionAnchorArgs): string {
	const parts = [
		relativeFile(args.filePath, args.cwd),
		args.tool ?? "",
		args.rule ?? "",
		normalizeMessage(args.message),
	];
	return `ddw:${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
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

function readState(cwd: string): DispositionStateFile {
	const p = statePath(cwd);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(p);
	} catch {
		if (stateCache && stateCache.path === p && stateCache.missing) {
			return stateCache.state;
		}
		const empty: DispositionStateFile = {};
		stateCache = { path: p, missing: true, mtimeMs: -1, size: -1, state: empty };
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
			parsed && typeof parsed === "object" ? (parsed as DispositionStateFile) : {};
	} catch {
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

function writeState(cwd: string, state: DispositionStateFile): void {
	const p = statePath(cwd);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(state, null, 2));
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
): string {
	const anchor =
		disposition === "false-positive"
			? computeStrictAnchor(target)
			: computeWeakAnchor(target);
	// Captured for BOTH branches: a defer never writes the store, but a store
	// entry can already exist at the same weak anchor (a prior flagged/suppress
	// mark) — the log should record what this mark shadowed either way.
	const existing = readState(cwd).dispositions?.[anchor];
	emitMarkTelemetry(cwd, target, disposition, anchor, reason, existing);

	if (disposition === "defer") {
		deferredThisSession.add(anchor);
		return anchor;
	}

	const state = readState(cwd);
	state.dispositions ??= {};
	const now = new Date().toISOString();
	const capturesFixContext = disposition === "flagged";
	const lineText = capturesFixContext
		? (target.content?.split(/\r?\n/)[
				target.line !== undefined ? target.line - 1 : -1
			] ?? existing?.lineText)?.trim()
		: existing?.lineText;
	state.dispositions[anchor] = {
		disposition,
		reason: reason ?? existing?.reason,
		createdAt: existing?.createdAt ?? now,
		lastSeenAt: now,
		line: capturesFixContext ? (target.line ?? existing?.line) : existing?.line,
		lineText,
	};
	writeState(cwd, state);
	return anchor;
}

export function getDisposition(
	cwd: string,
	anchor: string,
): DispositionEntry | undefined {
	return readState(cwd).dispositions?.[anchor];
}

export function isDeferredThisSession(anchor: string): boolean {
	return deferredThisSession.has(anchor);
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
		if (deferredThisSession.has(weak)) return false;
		if (dispositions?.[strict]?.disposition === "false-positive") return false;
		// Belt-and-braces: the inline `pi-lens-ignore` comment is the real
		// suppress enforcement (see suppress-writer.ts) and normally already
		// dropped this finding upstream via applyInlineSuppressions. This is a
		// harmless second cover for the store-only audit trail case.
		if (dispositions?.[weak]?.disposition === "suppress") return false;
		return true;
	});
}
