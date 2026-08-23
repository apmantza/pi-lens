import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.js";
import { resolveRunnerPath } from "./dispatch/runner-context.js";
import { freshnessFromMtime } from "./freshness.js";

export type AdvisoryFileRole = "source" | "test" | "affected";

export interface AdvisoryFileProvenance {
	path: string;
	role: AdvisoryFileRole;
	mtimeMs: number;
	size: number;
	sha256: string;
}

export interface AdvisoryProvenance {
	revision: {
		sessionId: string;
		projectSeq: number;
		turnIndex: number;
		generation: number;
		capturedAt: number;
	};
	files: AdvisoryFileProvenance[];
	truncated?: boolean;
}

export interface AdvisoryValidation {
	status: "current" | "superseded" | "unknown";
	reasons: string[];
	allFilesDeleted: boolean;
	changedPathCount: number;
}

export const MAX_ADVISORY_AFFECTED_FILES = 256;

export function advisoryPathKey(filePath: string, cwd: string): string {
	return normalizeMapKey(path.resolve(cwd, filePath));
}

/** Shared with git guard: there is one SHA-256 implementation for advisories. */
export function advisoryFileHash(filePath: string): string {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		return code === "ENOENT" ? "missing" : `unreadable:${code}`;
	}
}

function snapshotOne(
	filePath: string,
	cwd: string,
	role: AdvisoryFileRole,
): AdvisoryFileProvenance {
	const resolved = path.resolve(cwd, filePath);
	try {
		const stat = fs.statSync(resolved);
		return {
			path: resolved,
			role,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			sha256: advisoryFileHash(resolved),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		return {
			path: resolved,
			role,
			mtimeMs: -1,
			size: -1,
			sha256: code === "ENOENT" ? "missing" : `unreadable:${code}`,
		};
	}
}

export function snapshotAdvisoryProvenance(args: {
	cwd: string;
	runtime: Pick<
		RuntimeCoordinator,
		"telemetrySessionId" | "projectSeq" | "turnIndex"
	>;
	generation: number;
	files: Array<{ path: string; role: AdvisoryFileRole }>;
	capturedAt?: number;
	truncated?: boolean;
}): AdvisoryProvenance {
	const seen = new Set<string>();
	const files: AdvisoryFileProvenance[] = [];
	for (const file of args.files) {
		const key = advisoryPathKey(file.path, args.cwd);
		if (seen.has(key)) continue;
		seen.add(key);
		files.push(snapshotOne(file.path, args.cwd, file.role));
	}
	return {
		revision: {
			sessionId: args.runtime.telemetrySessionId,
			projectSeq: args.runtime.projectSeq,
			turnIndex: args.runtime.turnIndex,
			generation: args.generation,
			capturedAt: args.capturedAt ?? Date.now(),
		},
		files,
		...(args.truncated ? { truncated: true } : {}),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCapturedHash(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(/^[a-f0-9]{64}$/.test(value) ||
			value === "missing" ||
			value.startsWith("unreadable:"))
	);
}

function isWellFormed(value: unknown): value is AdvisoryProvenance {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AdvisoryProvenance>;
	const revision = record.revision;
	return (
		!!revision &&
		typeof revision.sessionId === "string" &&
		isFiniteNumber(revision.projectSeq) &&
		isFiniteNumber(revision.turnIndex) &&
		isFiniteNumber(revision.generation) &&
		isFiniteNumber(revision.capturedAt) &&
		Array.isArray(record.files) &&
		record.files.length > 0 &&
		record.files.every(
			(file) =>
				!!file &&
				typeof file.path === "string" &&
				(file.role === "source" ||
					file.role === "test" ||
					file.role === "affected") &&
				isFiniteNumber(file.mtimeMs) &&
				isFiniteNumber(file.size) &&
				isCapturedHash(file.sha256),
		)
	);
}

export function validateAdvisoryProvenance(
	record: { provenance?: unknown },
	cwd: string,
	runtime?: Pick<
		RuntimeCoordinator,
		"telemetrySessionId" | "projectSeq" | "turnIndex"
	>,
): AdvisoryValidation {
	if (!isWellFormed(record.provenance)) {
		return {
			status: "unknown",
			reasons: ["malformed-or-legacy-provenance"],
			allFilesDeleted: false,
			changedPathCount: 0,
		};
	}
	const provenance = record.provenance;
	const reasons: string[] = [];
	let unknown = provenance.truncated === true;
	if (unknown) reasons.push("truncated-provenance");
	if (runtime) {
		if (provenance.revision.sessionId !== runtime.telemetrySessionId)
			reasons.push("session-mismatch");
	}
	let deletedFiles = 0;
	const changedPaths = new Set<string>();
	for (const captured of provenance.files) {
		const resolved = path.resolve(cwd, captured.path);
		const reasonsBefore = reasons.length;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unknown";
			if (code === "ENOENT") {
				if (captured.sha256 !== "missing") {
					deletedFiles += 1;
					reasons.push(`missing:${advisoryPathKey(resolved, cwd)}`);
					changedPaths.add(advisoryPathKey(resolved, cwd));
				}
			} else {
				unknown = true;
				reasons.push(`unreadable:${advisoryPathKey(resolved, cwd)}:${code}`);
				changedPaths.add(advisoryPathKey(resolved, cwd));
			}
			continue;
		}
		if (captured.sha256.startsWith("unreadable:")) {
			unknown = true;
			reasons.push(`capture-unreadable:${advisoryPathKey(resolved, cwd)}`);
			changedPaths.add(advisoryPathKey(resolved, cwd));
			continue;
		}
		if (captured.sha256 === "missing") {
			reasons.push(`created:${advisoryPathKey(resolved, cwd)}`);
			changedPaths.add(advisoryPathKey(resolved, cwd));
			continue;
		}
		if (stat.mtimeMs !== captured.mtimeMs || stat.size !== captured.size) {
			reasons.push(`metadata-changed:${advisoryPathKey(resolved, cwd)}`);
		}
		const currentHash = advisoryFileHash(resolved);
		if (currentHash.startsWith("unreadable:")) {
			unknown = true;
			reasons.push(`${currentHash}:${advisoryPathKey(resolved, cwd)}`);
		} else if (currentHash !== captured.sha256) {
			reasons.push(`content-changed:${advisoryPathKey(resolved, cwd)}`);
		}
		if (reasons.length > reasonsBefore)
			changedPaths.add(advisoryPathKey(resolved, cwd));
	}
	const allFilesDeleted = deletedFiles === provenance.files.length;
	if (unknown)
		return {
			status: "unknown",
			reasons,
			allFilesDeleted,
			changedPathCount: changedPaths.size,
		};
	return reasons.length > 0
		? {
				status: "superseded",
				reasons,
				allFilesDeleted,
				changedPathCount: changedPaths.size,
			}
		: { status: "current", reasons: [], allFilesDeleted, changedPathCount: 0 };
}

// ── Finding-cited path existence (#1461 slice 1) ──────────────────────────────
//
// `validateAdvisoryProvenance` above answers "did the files the agent EDITED
// change since capture?". A cached scanner finding asks a different question:
// "does the file this finding NAMES still exist?". #1460's live case is the gap
// between them — a gitleaks blocker for a directory deleted eleven minutes
// earlier shipped as `current` seven consecutive times, because the edited
// files were all intact and the cited path was never in the envelope.
//
// CONTRACT (the five remaining #1461 slices reuse this verbatim):
//   - Input is any finding shape; the caller supplies `citedPath`, so nothing
//     here knows about gitleaks, trivy, govulncheck, vulture, or delta mode.
//   - A finding whose cited path is absent (ENOENT/ENOTDIR) is DROPPED, not
//     demoted. There is no remediation for a file that is gone — the agent
//     cannot rotate a credential in it or delete a line from it. Content drift
//     on a SURVIVING file stays `validateAdvisoryProvenance`'s job, and that
//     one demotes.
//   - Fail open, never closed: a finding with no cited path, an unreadable
//     path (EACCES/EPERM/EBUSY), or a path past the stat budget is DELIVERED.
//     Unreadable is not absent; a missed drop is noise, a wrong drop is a lost
//     secret.
//   - Bounded cost: findings are deduped by their RAW cited string first —
//     zero filesystem work — before anything pays for `resolveRunnerPath`'s
//     ancestor walk or `normalizeMapKey`'s realpath. A first cut that deduped
//     by the resolved/canonical key instead still ran that expensive step
//     once per FINDING, not once per unique path, because the dedup lookup
//     came after the cost it was meant to avoid: #1461's live 126-finding
//     record measured 72.7ms in that shape, all of it before the first
//     `statSync`. Deduping the raw string first drops the same record to a
//     ~1.6ms median (this repo, Windows, 10-sample bench) — the remaining
//     cost is one canonicalization + one stat per distinct cited string,
//     capped at `MAX_FINDING_PATH_STATS`.
//   - Path identity uses the guard normalizer (`resolveRunnerPath` →
//     `normalizeMapKey`) for the canonical-key dedup and the shape-aware
//     `toProjectRelativePath` for display, so Windows spellings of one path
//     collapse to one stat and one log entry (defect shapes 1 and 2). This
//     helper has no zero-I/O contract of its own to protect — it stats.
//     Slice 3 (delta mode) must find and name its OWN seam before reusing
//     this shape; `formatDeltaMode` (tools/lens-diagnostics.ts) reads only
//     actionable-warnings, code-quality-warnings, and the delta report, none
//     of which any #1461 slice writes yet, so nothing here currently touches
//     it.

/** Stat budget: one per unique cited path, sharing the envelope's own cap. */
export const MAX_FINDING_PATH_STATS = MAX_ADVISORY_AFFECTED_FILES;

/** How many dead paths a single drop record names before it stops. */
const MAX_LOGGED_DEAD_PATHS = 3;

// ── Finding-cited path freshness (#1622) ─────────────────────────────────────
//
// Existence is not authority. #1460's gate answers "does the cited file still
// exist?"; #1622's live case is the next question along: "does the cited file
// still look the way the scan saw it?". A gitleaks blocker cited src:397 for
// ~13 minutes after that file was edited, because the 30-minute TTL says the
// CACHE is young and the existence gate says the FILE is there. Neither says
// the LINE NUMBER is still true.
//
// The verdict is three-way, and the middle arm is the security-critical one:
//   - missing → DROP, as #1460. Nothing to remediate in a file that is gone.
//   - stale (mtimeMs > scannedAt + MTIME_DRIFT_TOLERANCE_MS) → DEMOTE, never drop. The secret may well
//     still be there at a shifted line. Dropping would hand an attacker — or
//     an innocent formatter — a one-touch mute button for a real credential.
//     The caller renders demoted findings out of the blocker tier and WITHOUT
//     the cached line number, which is the part that is now untrustworthy.
//   - live → deliver unchanged, at full severity.
//
// Fail-safe on an unparseable/absent `scannedAt`: no staleness verdict at all,
// so the gate degrades to #1460's existence-only behaviour rather than
// demoting the whole store on a clock or format anomaly. Same rule, same
// reason, as `reconcileProjectDiagnosticsSnapshot`.

/**
 * Freshness verdict for one resolved cited path. `unknown` is the fail-open
 * arm: the path may well be there, we just could not tell.
 */
export type FindingPathFreshness = "live" | "stale" | "missing" | "unknown";

/**
 * Existence-only verdict, kept as the name #1460's callers and tests use. It is
 * the subset of `FindingPathFreshness` that carries no staleness arm.
 */
export type FindingPathExistence = "live" | "missing" | "unknown";

/**
 * What a store means by "the cited file is gone".
 *
 * `drop` is right when the finding IS the file's content: a secret in a deleted
 * file cannot be rotated, and there is nothing left to remediate (#1460).
 *
 * `demote` is right when the cited path is merely EVIDENCE for a finding that
 * lives somewhere else. A govulncheck CVE is pinned by `go.mod`; deleting one
 * traced call site does not un-pin the vulnerable dependency, so dropping the
 * finding would hide a live CVE on the strength of an unrelated deletion. The
 * coordinate goes, the finding stays.
 */
export type FindingMissingPolicy = "drop" | "demote";

/**
 * One stat, one verdict. With `scannedAtMs` supplied, a surviving file whose
 * mtime is newer than the scan reports `stale`.
 *
 * The boundary is `mtime > scannedAt + MTIME_DRIFT_TOLERANCE_MS`: a file
 * scanned AT `scannedAt`, or written within the tolerance window of the scan
 * timestamp being captured, reads live; genuinely past it reads stale.
 *
 * #1708: a bare +1ms tolerance — the convention `reconcileProjectDiagnosticsSnapshot`
 * (clients/project-diagnostics/cache.ts:98) still uses, and the one this gate
 * originally cited-but-withheld ("over-demoting costs a line number,
 * under-demoting replays a false coordinate — the cheaper error wins the
 * tie") — was not enough: on Windows a file's mtime can LEAD the immediately
 * following `Date.now()` read by up to ~11.4ms, the same host skew
 * `MTIME_DRIFT_TOLERANCE_MS` (`blocker-freshness.ts`) was raised to 50ms for
 * (#1491/#1498). At +1ms this gate still demoted a real STOP-blocker (a
 * trivy secret, #1628) to ACTION NEEDED, flaking
 * tests/clients/runtime-turn-secrets-disposition.test.ts. Reusing the shared
 * constant — rather than a second hand-tuned number — keeps one source of
 * truth for the measured skew.
 */
export function findingPathFreshness(
	resolvedPath: string,
	scannedAtMs?: number,
): FindingPathFreshness {
	try {
		const stat = fs.statSync(resolvedPath);
		// No scan timestamp recorded: the pre-kernel behavior treated the
		// path as live (no reference to be stale against) - preserved.
		if (scannedAtMs === undefined) return "live";
		const verdict = freshnessFromMtime({
			mtimeMs: stat.mtimeMs,
			referenceMs: scannedAtMs,
		});
		return verdict.verdict === "stale" ? "stale" : "live";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		// ENOTDIR: an ancestor component is no longer a directory — the cited
		// path cannot exist either, same as ENOENT.
		return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
	}
}

/** Existence-only probe. Retained for callers that have no scan timestamp. */
export function findingPathExistence(
	resolvedPath: string,
): FindingPathExistence {
	return findingPathFreshness(resolvedPath) as FindingPathExistence;
}

/**
 * Parse a scan timestamp into epoch ms, or `undefined` when it cannot be
 * trusted. `undefined` disables the staleness arm — never demote on a bad
 * clock.
 */
export function parseScannedAtMs(
	scannedAt: string | number | undefined,
): number | undefined {
	if (scannedAt === undefined || scannedAt === null || scannedAt === "") {
		return undefined;
	}
	const ms = typeof scannedAt === "number" ? scannedAt : Date.parse(scannedAt);
	return Number.isFinite(ms) ? ms : undefined;
}

export interface FindingPathPartition<T> {
	/** Findings safe to deliver as-is: path exists, is unreadable, or absent. */
	live: T[];
	/** Findings whose cited file was edited after the scan — demote, never drop. */
	stale: T[];
	/** Findings whose cited path is confirmed gone. */
	dropped: T[];
	/** Resolved dead paths, unique and in first-seen order. */
	deadPaths: string[];
	/** Resolved edited-since-scan paths, unique and in first-seen order. */
	stalePaths: string[];
	/** Unique cited paths actually probed. */
	statCount: number;
	/** True when the stat budget was hit and some findings failed open. */
	truncated: boolean;
}

/**
 * Partition findings into `{live, stale, dropped}` by what the path each one
 * names looks like now. Pure apart from the `fs.statSync` probe, which is
 * injectable so the partition rules are unit-testable without a filesystem.
 *
 * The stat memo lives in local `Map`s built fresh on every call — per delivery,
 * never per process. A module-level cache here would be the process-lifetime
 * latch shape: it would pin the first verdict for a path and re-serve it for
 * every later turn, which is the very defect this gate exists to close.
 */
export function partitionFindingsByCitedPath<T>(args: {
	findings: readonly T[];
	cwd: string;
	citedPath: (finding: T) => string | undefined;
	maxUniquePaths?: number;
	/** Scan timestamp of the store being delivered. Omit to skip the stale arm. */
	scannedAt?: string | number;
	/** What a deleted cited path means for this store. See `FindingMissingPolicy`. */
	onMissing?: FindingMissingPolicy;
	existence?: (
		resolvedPath: string,
		scannedAtMs?: number,
	) => FindingPathFreshness;
}): FindingPathPartition<T> {
	const limit = args.maxUniquePaths ?? MAX_FINDING_PATH_STATS;
	const probe = args.existence ?? findingPathFreshness;
	const scannedAtMs = parseScannedAtMs(args.scannedAt);
	const onMissing = args.onMissing ?? "drop";
	// Two dedup layers, cheapest first. `rawVerdicts` collapses findings that
	// cite the IDENTICAL string with zero filesystem work — the dominant case
	// (#1460's live record: 126 findings over a handful of distinct `file`
	// strings). Only a raw string not seen before pays for
	// `resolveRunnerPath`/`advisoryPathKey`, which folds FS-confirmed spelling
	// variants (case, separators, ancestor walk-up) into `verdicts`, the
	// canonical-key map that `statCount` reports. Keying the expensive work by
	// the RESOLVED path instead of the raw one (the pre-#1461-HIGH-2 shape)
	// still called it once per finding, since the dedup lookup came after the
	// cost it was meant to dedupe.
	const rawVerdicts = new Map<string, FindingPathFreshness>();
	const verdicts = new Map<string, FindingPathFreshness>();
	const live: T[] = [];
	const stale: T[] = [];
	const dropped: T[] = [];
	const deadPaths: string[] = [];
	const stalePaths: string[] = [];
	let truncated = false;
	for (const finding of args.findings) {
		const cited = args.citedPath(finding);
		if (!cited) {
			live.push(finding);
			continue;
		}
		let verdict = rawVerdicts.get(cited);
		if (verdict === undefined) {
			// Ancestor-tolerant, same as `toRunnerDisplayPath`'s resolution in
			// runtime-turn.ts — a bare `path.resolve` here would decide the drop
			// against a different root than the one used to render the survivor,
			// dropping findings the display path would have shown correctly
			// (#1461 HIGH-1). `resolveRunnerPath` already runs its result through
			// `normalizeMapKey`, so the resolved path IS the canonical key — a
			// second `advisoryPathKey` pass would re-pay the same realpath cost.
			const resolved = resolveRunnerPath(args.cwd, cited);
			const key = resolved;
			verdict = verdicts.get(key);
			if (verdict === undefined) {
				if (verdicts.size >= limit) {
					// Budget spent on paths we have not seen before — deliver rather
					// than guess. Already-probed paths keep their cached verdict.
					truncated = true;
					verdict = "live";
				} else {
					verdict = probe(resolved, scannedAtMs);
					// A store that treats deletion as evidence-loss rather than
					// remediation-loss folds `missing` into the demote arm here, so
					// every downstream list and record sees one consistent verdict.
					if (verdict === "missing" && onMissing === "demote") {
						verdict = "stale";
					}
					verdicts.set(key, verdict);
					if (verdict === "missing") deadPaths.push(resolved);
					else if (verdict === "stale") stalePaths.push(resolved);
				}
			}
			rawVerdicts.set(cited, verdict);
		}
		if (verdict === "missing") dropped.push(finding);
		else if (verdict === "stale") stale.push(finding);
		else live.push(finding);
	}
	return {
		live,
		stale,
		dropped,
		deadPaths,
		stalePaths,
		statCount: verdicts.size,
		truncated,
	};
}

/**
 * Delivery-seam wrapper: partition, then emit one bounded `finding_dead_path_drop`
 * record when anything was dropped, and return only what is safe to deliver.
 *
 * The record is the #1432 Gap 1 principle applied here — an eviction that logs
 * nothing is only confirmable by the absence of complaints. One record per
 * store per delivery, with a capped path sample; never one per finding.
 */
export function dropFindingsForMissingPaths<T>(args: {
	/** Cache/store name as it appears in telemetry, e.g. `"gitleaks"`. */
	store: string;
	findings: readonly T[];
	cwd: string;
	citedPath: (finding: T) => string | undefined;
	maxUniquePaths?: number;
	existence?: (
		resolvedPath: string,
		scannedAtMs?: number,
	) => FindingPathFreshness;
}): T[] {
	// No `scannedAt` — existence-only, so `partition.stale` is always empty.
	const partition = partitionFindingsByCitedPath(args);
	emitDeadPathDropRecord(args.store, args.cwd, partition);
	return partition.live;
}

/** What a freshness-gated delivery hands back to its caller. */
export interface FindingFreshnessGate<T> {
	/** Deliver at full severity: the cited file is unchanged since the scan. */
	live: T[];
	/**
	 * Deliver DEMOTED: the cited file was edited after the scan, so the finding
	 * may still be real but its cached line number is not. Callers must render
	 * these out of the blocker tier and without the line.
	 */
	stale: T[];
}

/**
 * Delivery-seam wrapper with the #1622 freshness verdict. Emits at most one
 * `finding_dead_path_drop` and one `finding_stale_line_demote` record per store
 * per delivery, each with a capped path sample; never one per finding.
 *
 * Callers that have no scan timestamp keep using `dropFindingsForMissingPaths`.
 */
export function gateFindingsByPathFreshness<T>(args: {
	/** Cache/store name as it appears in telemetry, e.g. `"gitleaks"`. */
	store: string;
	findings: readonly T[];
	cwd: string;
	/** The store envelope's scan timestamp. Absent/unparseable disables demotion. */
	scannedAt?: string | number;
	citedPath: (finding: T) => string | undefined;
	maxUniquePaths?: number;
	/** Defaults to `"drop"`, matching #1460's secrets behaviour. */
	onMissing?: FindingMissingPolicy;
	existence?: (
		resolvedPath: string,
		scannedAtMs?: number,
	) => FindingPathFreshness;
}): FindingFreshnessGate<T> {
	const partition = partitionFindingsByCitedPath(args);
	emitDeadPathDropRecord(args.store, args.cwd, partition);
	emitStaleLineDemoteRecord(args.store, args.cwd, args.scannedAt, partition);
	return { live: partition.live, stale: partition.stale };
}

function emitDeadPathDropRecord<T>(
	store: string,
	cwd: string,
	partition: FindingPathPartition<T>,
): void {
	if (partition.dropped.length === 0) return;
	logLatency({
		type: "phase",
		phase: "finding_dead_path_drop",
		filePath: cwd,
		durationMs: 0,
		metadata: {
			store,
			droppedDeadPaths: partition.dropped.length,
			deadPathCount: partition.deadPaths.length,
			deliveredCount: partition.live.length,
			statCount: partition.statCount,
			samplePaths: partition.deadPaths
				.slice(0, MAX_LOGGED_DEAD_PATHS)
				.map((deadPath) => toProjectRelativePath(deadPath, cwd)),
			...(partition.truncated ? { truncated: true } : {}),
		},
	});
}

/**
 * #1622 criterion 5: the demote path gets the same record shape as the drop
 * path. Before this, a stale-line replay window was reconstructible only by
 * proxy — the blocker payload is written nowhere.
 */
function emitStaleLineDemoteRecord<T>(
	store: string,
	cwd: string,
	scannedAt: string | number | undefined,
	partition: FindingPathPartition<T>,
): void {
	if (partition.stale.length === 0) return;
	logLatency({
		type: "phase",
		phase: "finding_stale_line_demote",
		filePath: cwd,
		durationMs: 0,
		metadata: {
			store,
			demotedStalePaths: partition.stale.length,
			stalePathCount: partition.stalePaths.length,
			deliveredCount: partition.live.length,
			statCount: partition.statCount,
			samplePaths: partition.stalePaths
				.slice(0, MAX_LOGGED_DEAD_PATHS)
				.map((stalePath) => toProjectRelativePath(stalePath, cwd)),
			...(scannedAt === undefined ? {} : { scannedAt: String(scannedAt) }),
			...(partition.truncated ? { truncated: true } : {}),
		},
	});
}

export function provenanceStamp(provenance: unknown): string {
	if (!isWellFormed(provenance))
		return "session unknown / turn unknown / generation unknown";
	return `session ${provenance.revision.sessionId} / turn ${provenance.revision.turnIndex} / generation ${provenance.revision.generation}`;
}
