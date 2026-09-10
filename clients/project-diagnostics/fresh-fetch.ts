/**
 * THE heavyweight-analyzer reader for `lens_diagnostics mode=full` (#585).
 *
 * It superseded a cache-ONLY reader (`extractCachedProjectDiagnostics`, since
 * removed from ./extractors.ts as a #585-class dead parallel path — see that
 * file's header). That reader was deliberately cache-only because historically
 * mode=full had no safe way to trigger a scan itself: relaunching knip/jscpd/
 * gitleaks/govulncheck/opengrep/trivy/dead-code concurrently with the
 * session_start background pass over the SAME project root could double-spawn a
 * CPU-bound analyzer (the exact TUI-freeze/zombie-process pathology
 * `KnipClient.inFlight`'s docstring describes).
 *
 * That pathology is now closed for every one of these analyzers:
 * `KnipClient`, `JscpdClient`, and the `DeadCodeClient`s each carry their own
 * `inFlight` de-dupe map, and `GitleaksClient`/`GovulncheckClient`/
 * `TrivyClient`/`OpengrepClient` share `SecurityScanClient.dedupeScan` (landed
 * in #313, well before this issue — verified before writing this module). So
 * a mode=full opengrep run that races the session_start whole-tree scan of the
 * same root JOINS it rather than spawning a second (heavy) scan. So mode=full can
 * now safely trigger — or, via the de-dupe guard, *join* — a fresh run of
 * each analyzer instead of settling for a session_start-only snapshot that
 * can be hours stale in a long session.
 *
 * Mirrors the gating each analyzer already applies at session_start
 * (`clients/runtime-session.ts`) — same "not applicable to this project" /
 * "not installed" skip conditions — but never skips on a cache hit; it always
 * performs (or joins) an actual run. One deliberate exception: gitleaks (#608)
 * uses a looser "smart-default" gate here (any tracked git repo) than
 * session_start's strict opt-in-config gate, since mode=full is an
 * explicitly-requested comprehensive review and gitleaks is cheap/advisory —
 * see its own task below. Every fresh result is written back to
 * cache via the same `cacheManager.writeCache` session_start/turn_end use, so
 * a background pass racing in afterward reads a result at least as fresh as
 * its own.
 *
 * No extra write-ordering guard (`clients/write-ordering-guard.ts`) is
 * layered on top of this: an overlapping call to the same analyzer for the
 * same root always resolves to the exact same in-flight promise (the de-dupe
 * guard above), so concurrent writers here are always writing IDENTICAL
 * data — there is no "stale write lands after a fresher one" race to guard
 * against. A guard would only earn its keep if two *different* result
 * objects for the same key could race; that can't happen while every caller
 * for a given root shares one in-flight run.
 *
 * Does NOT change session_start's or turn_end's own scheduling (both remain
 * skip-if-cached) — this module is additive and mode=full-only.
 *
 * Abort handling: `formatFullMode` (`tools/lens-diagnostics.ts`) already
 * threads a combined signal (Escape/turn-abort OR'd with a hard wall-clock
 * ceiling, `FULL_SCAN_WALL_CLOCK_MS`) into the LSP sweep and the cheap
 * project-runner scan — this module accepts the SAME signal so a `mode=full`
 * abort also bounds the fresh-fetch instead of letting it run uncancelled for
 * up to trivy's own ~180s ceiling after the rest of the scan already stopped.
 * None of the six analyzer clients accept a cancellation token today (checked
 * each `analyze()`/`scan()` signature before assuming otherwise — none does),
 * so true in-flight cancellation isn't available at the client level. Instead
 * this races the overall `Promise.all(tasks)` against the abort signal and
 * returns whatever has already settled — the same "partial is OK, a hang is
 * not" shape `clients/deadline-utils.ts`'s `withDeadline(..., onTimeout:
 * "undefined")` and `clients/lsp/index.ts`'s `runWorkspaceDiagnostics` already
 * use. Already-spawned analyzer processes are NOT killed: they keep running in
 * the background (bounded by their own `SCAN_TIMEOUT_MS`/`ANALYSIS_TIMEOUT_MS`)
 * and still write their result to cache when they finish, so nothing already
 * in flight is wasted — the NEXT caller (or a background session_start/
 * turn_end pass) benefits from it. Analyzers that hadn't settled yet when the
 * abort fired are reported in both `cold` (so they don't silently read as
 * "ran clean") and `abortedIds` (so a caller can render a more honest reason
 * than "not applicable").
 *
 * One analyzer does NOT follow the trigger-or-join shape above: `test-runner`
 * (#1004). Its "scan" is the per-edit turn_end test fire (`runtime-turn.ts`),
 * which only ever runs the targeted/cascade-aware test files touched by a
 * turn's edits — there is no whole-project run to trigger here, and forcing
 * one on every mode=full call would be exactly the double-spawn-a-heavy-
 * analyzer cost the de-dupe guards above exist to avoid. Its task is a plain
 * cache-read of the `"test-runner-findings"` key turn_end already wrote,
 * mirroring the pre-#585 `extractCachedProjectDiagnostics` registry's
 * "test-runner" row (cache-only, never triggers a run) rather than the
 * fresh-run pattern every other task here uses — see that task's own comment.
 *
 * Refs: #585, #313 (the SecurityScanClient de-dupe prerequisite), #1004
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BootstrapClients } from "../bootstrap.js";
import type { CacheManager } from "../cache-manager.js";
import type { RuntimeCoordinator } from "../runtime-coordinator.js";
import { applyDispositionsMultiFile } from "../diagnostic-dispositions.js";
import { getKnipIgnorePatterns } from "../file-utils.js";
import { isAtOrAboveHomeDir } from "../path-utils.js";
import { GitleaksClient } from "../gitleaks-client.js";
import { GovulncheckClient } from "../govulncheck-client.js";
import {
	isToolInstallAllowedByTrust,
	projectTrustDenialReason,
} from "../project-trust.js";
import { TrivyClient } from "../trivy-client.js";
import { reasonFromAvailabilityVerdict } from "./extractors.js";
import { deadCodeResultToProjectDiagnostics } from "./runner-adapters/dead-code.js";
import { gitleaksResultToProjectDiagnostics } from "./runner-adapters/gitleaks.js";
import { govulncheckResultToProjectDiagnostics } from "./runner-adapters/govulncheck.js";
import { jscpdResultToProjectDiagnostics } from "./runner-adapters/jscpd.js";
import { knipIssuesToProjectDiagnostics } from "./runner-adapters/knip.js";
import { circularDepsToProjectDiagnostics } from "./runner-adapters/madge.js";
import { opengrepResultToProjectDiagnostics } from "./runner-adapters/opengrep.js";
import type { TestRunnerFindingsCache } from "./runner-adapters/runner-findings.js";
import { testRunnerFindingsToProjectDiagnostics } from "./runner-adapters/runner-findings.js";
import { trivyResultToProjectDiagnostics } from "./runner-adapters/trivy.js";
import type { ProjectDiagnostic } from "./types.js";
import type { FailedProjectAnalyzer } from "./extractors.js";

export interface FreshProjectDiagnosticsResult {
	diagnostics: ProjectDiagnostic[];
	/** Extractor ids that actually contributed findings this run. */
	runners: string[];
	/**
	 * Extractor ids whose result is the parsed output of a scan THIS call ran
	 * over the analysis root — the opt-in `AnalysedRootSignal` each client
	 * sets at its own parse site (#2154). `lens_diagnostics mode=full` retires
	 * retained findings only for these ids, so a runner that reported
	 * `success: true` without running (skipped, crashed before writing its
	 * report, served from a memo) is deliberately absent.
	 */
	analyzed: string[];
	/**
	 * File-level authority established by this fetch. A complete entry covers
	 * every file below `root`; a file-set entry covers only its listed files.
	 * The legacy `analyzed` list remains the conservative fallback for callers
	 * that have no coverage entry yet (#2887).
	 */
	authoritativeCoverage?: ProjectRunnerCoverage[];
	/** Extractor ids skipped this run (not applicable / tool unavailable, OR
	 *  aborted before settling — see `abortedIds`). */
	cold: string[];
	/**
	 * #1623: the SPECIFIC reason each `cold` id was skipped, captured at the
	 * exact gate that made the decision (e.g. "not a git repository" vs
	 * "gitleaks binary unavailable" — both render as bare "gitleaks" in
	 * `cold` alone). Single source of truth for the render layer's "not run
	 * (<reason>)" note — the render side must read this map rather than
	 * re-deriving a generic guess (that anti-pattern is what `warmTriggerFor`,
	 * extractors.ts, used to be the ONLY option for; kept there as a
	 * fallback for ids this map doesn't cover, e.g. a caller-supplied cold
	 * list from an older cache). Not populated for `abortedIds` — those get
	 * their own distinct "stopped mid-scan" reason at the render layer.
	 */
	coldReasons?: Record<string, string>;
	/**
	 * #1623: ms-old each id's data was when this call read it, keyed by
	 * extractor id — present only for lanes that are a cache-read BY DESIGN
	 * (today, only "test-runner"), so a caller can render "(cached, Xm old —
	 * not re-run)" instead of implying the data came from a fresh scan this
	 * call. A lane triggers-or-joins a genuine run whenever it's attempted
	 * (see the module header), so this stays empty for every other id.
	 */
	cachedAgeMs?: Record<string, number>;
	/** Analyzers that ran but explicitly reported failure. */
	failed: FailedProjectAnalyzer[];
	/** Wall-clock ms spent per extractor id that actually ran (join time
	 *  included when this call joined an already-in-flight scan). */
	timings: Record<string, number>;
	/** True when `signal` fired before every analyzer settled — the result is
	 *  partial by construction, not a confirmed "these ran clean". */
	aborted?: boolean;
	/** Extractor ids still in flight (or not yet started) when aborted. A
	 *  subset of `cold` — kept separate so a caller can render a distinct
	 *  "stopped mid-scan" reason instead of "not applicable to this project". */
	abortedIds?: string[];
	/** True when the fetch refused to run because `cwd` resolved at or above
	 *  the home directory (#747) — every analyzer is listed in `cold`, and
	 *  nothing was spawned. Kept separate from the per-analyzer skip reasons so
	 *  a caller can render "unsafe root" instead of "not applicable". */
	unsafeRoot?: boolean;
	/**
	 * Count of findings dropped by an agent/user disposition (false-positive
	 * or suppress mark — #1617) before landing in `diagnostics`. Every
	 * analyzer here previously had ZERO disposition wiring — a mark never
	 * suppressed a project-scan finding, only a dispatch (per-edit) one. Kept
	 * as a count, not silently dropped: the #1616 suppressed-bucket rule — a
	 * finding must never vanish with no trace, even when the disposition that
	 * dropped it is working exactly as intended.
	 */
	dispositionSuppressed?: number;
	/**
	 * Review-round F4 (#1617/#1625): the same count as `dispositionSuppressed`,
	 * broken down per analyzer id — "gitleaks: 2, knip: 1" is actionable in a
	 * way a bare total isn't (a caller can tell WHICH lane's marks are doing
	 * the suppressing). Does not attempt to also flag a lane that is 100%
	 * suppressed (so absent from both `runners` and `cold`) as distinct from
	 * "ran clean" — that gap is #1623's lane-status territory, not this one.
	 */
	dispositionSuppressedByLane?: Record<string, number>;
}

export interface ProjectRunnerCoverage {
	runnerId: string;
	root: string;
	files?: string[];
	complete: boolean;
}

/** The heavyweight analyzers surfaced in `lens_diagnostics mode=full` — this is
 *  now the single source of truth for that list (#585 removed the parallel
 *  cache-only `EXTRACTORS` registry that used to shadow it). `warmTriggerFor`
 *  (extractors.ts) is keyed by these same ids for the "cold" honesty note.
 *  Exported so `tests/clients/project-diagnostics/analyzer-coverage.test.ts`
 *  (#1004's guardrail) can assert every session-start/turn-end analyzer cache
 *  writer id is a member — the exact #585-class check that would have caught
 *  opengrep's (and then test-runner's, #1004) omission before it shipped. */
export const ANALYZER_IDS = [
	"knip",
	"jscpd",
	"madge",
	"gitleaks",
	"govulncheck",
	"opengrep",
	"trivy",
	"dead-code",
	"test-runner",
] as const;

function pushUnique(list: string[], id: string): void {
	if (!list.includes(id)) list.push(id);
}

/**
 * Trigger (or join, via each client's in-flight de-dupe guard) a fresh run of
 * every heavyweight project analyzer and adapt the results to
 * `ProjectDiagnostic[]`. Runs all analyzers in parallel — total wall time is bounded by the
 * single slowest one (trivy's own timeout ceiling) rather than their sum.
 *
 * `signal`, when provided and it fires before every analyzer has settled,
 * makes this return immediately with whatever partial results are available
 * (see the module header for why this races rather than cancels in-flight
 * spawns).
 */
export async function fetchFreshProjectDiagnostics(
	cacheManager: CacheManager,
	cwd: string,
	clients: BootstrapClients,
	signal?: AbortSignal,
	options: { homeDir?: string; runtime?: RuntimeCoordinator } = {},
): Promise<FreshProjectDiagnosticsResult> {
	const analysisRoot = path.resolve(cwd);
	// #747: refuse to spawn any heavyweight analyzer when the analysis root is
	// at — or above — the home directory (the #250/#253 escape class). Every
	// analyzer here treats `analysisRoot` as a whole tree to walk; from $HOME
	// that means scanning every unrelated repo under it (observed: a jscpd run
	// from a WSL home reached 44 GB RSS and OOM-killed the whole instance).
	// Same ceiling as startup-scan.ts / runtime-session.ts's resolveSnapshotRoot
	// / review-graph's buildOrUpdateGraph; like the latter, there is no safe
	// substitute root to fall back to — the caller's `paths` scope only filters
	// REPORTED results, it never narrows what these analyzers walk.
	const unsafeRootReason =
		"the working directory resolves at or above the home directory; heavyweight analyzers refuse to walk from there (#747)";
	if (isAtOrAboveHomeDir(analysisRoot, options.homeDir)) {
		return {
			diagnostics: [],
			runners: [],
			analyzed: [],
			authoritativeCoverage: [],
			cold: [...ANALYZER_IDS],
			coldReasons: Object.fromEntries(
				ANALYZER_IDS.map((id) => [id, unsafeRootReason]),
			),
			failed: [],
			timings: {},
			unsafeRoot: true,
		};
	}
	const diagnostics: ProjectDiagnostic[] = [];
	const runners: string[] = [];
	const analyzed: string[] = [];
	const authoritativeCoverage: ProjectRunnerCoverage[] = [];
	const cold: string[] = [];
	// #1623: the specific reason each `cold` id was skipped, captured at the
	// gate that decided it — see FreshProjectDiagnosticsResult.coldReasons.
	const coldReasons: Record<string, string> = {};
	const failed: FailedProjectAnalyzer[] = [];
	const timings: Record<string, number> = {};
	// #1623: ms-old each id's data was when this call read it, for lanes that
	// are cache-reads by design (currently only test-runner — see its task
	// below) rather than a fresh execution this call. Absent for every other
	// key: this module's other lanes always trigger-or-join a genuine run
	// when attempted (see the module header), so there is nothing to date.
	const cachedAgeMs: Record<string, number> = {};
	const settledIds = new Set<string>();
	let dispositionSuppressed = 0;
	const dispositionSuppressedByLane: Record<string, number> = {};

	// #1617: this is the ONE choke point every analyzer's findings pass
	// through on the way into `diagnostics`, so applying the agent/user
	// disposition filter HERE covers the whole mode=full class (knip/jscpd/
	// madge/gitleaks/govulncheck/opengrep/trivy/dead-code) in one place — the
	// same anchor derivation `dispatcher.ts:924` uses, via
	// `applyDispositionsMultiFile` (`diagnostic-dispositions.ts`), not a
	// second cloned filter. Unlike the dispatch path's one-file-at-a-time
	// shape, a project-wide scan's findings span many files, so this groups by
	// each diagnostic's own `filePath` and reads each file's current content
	// once — see that function's doc for the fail-open contract when a file
	// can't be read.
	function markCold(id: string, reason: string): void {
		pushUnique(cold, id);
		coldReasons[id] = reason;
	}

	/**
	 * `analysedRoot` is the client's own opt-in `AnalysedRootSignal` (#2154),
	 * never a property of reaching this function: `success: true` is also what
	 * a skipped, crashed-before-reporting or memoised run returns, and only the
	 * client knows which of those it is. Findings are recorded either way — an
	 * id that did not analyse the root simply carries no authority to retire a
	 * retained finding.
	 */
	function record(
		id: string,
		adapted: ProjectDiagnostic[],
		elapsedMs: number,
		analysedRoot: boolean,
		coverageRunnerId = id,
	): void {
		if (analysedRoot) {
			pushUnique(analyzed, id);
			authoritativeCoverage.push({
				runnerId: coverageRunnerId,
				root: analysisRoot,
				complete: true,
			});
		}
		timings[id] = (timings[id] ?? 0) + elapsedMs;
		const kept = applyDispositionsMultiFile(
			adapted,
			analysisRoot,
			(d) => d.filePath,
		);
		const suppressedHere = adapted.length - kept.length;
		dispositionSuppressed += suppressedHere;
		if (suppressedHere > 0) {
			dispositionSuppressedByLane[id] =
				(dispositionSuppressedByLane[id] ?? 0) + suppressedHere;
		}
		if (kept.length > 0) {
			diagnostics.push(...kept);
			pushUnique(runners, id);
		}
	}

	function recordFailed(
		id: string,
		result: { summary?: string } | object,
	): void {
		failed.push({
			id,
			summary:
				"summary" in result && typeof result.summary === "string"
					? result.summary
					: "analyzer reported an unsuccessful run",
		});
	}

	function task(id: string, run: () => Promise<void>): Promise<void> {
		return run().finally(() => settledIds.add(id));
	}

	const tasks: Promise<void>[] = [
		// knip — always applicable to probe (KnipClient.analyze itself no-ops
		// when no project root marker is found, matching session_start).
		task("knip", async () => {
			const startMs = Date.now();
			const result = await clients.knipClient.analyze(
				analysisRoot,
				getKnipIgnorePatterns(),
			);
			if (!result.success) {
				recordFailed("knip", result);
				return;
			}
			// knip reports `success: true` for a run that never happened (no
			// project root, a memo hit, an unparseable exit-0). Those belong in
			// the honest `cold` channel, not in "fetched fresh this call".
			if (result.analyzed !== true) {
				markCold("knip", result.summary ?? "knip did not analyse this root");
				return;
			}
			cacheManager.writeCache("knip", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"knip",
				knipIssuesToProjectDiagnostics(analysisRoot, result.issues ?? []),
				Date.now() - startMs,
				true,
			);
		}),

		// jscpd — duplicate code detection. Cache key varies with TS-project
		// detection, exactly mirroring session_start's own logic.
		task("jscpd", async () => {
			if (!(await clients.jscpdClient.ensureAvailable())) {
				markCold(
					"jscpd",
					reasonFromAvailabilityVerdict(
						"jscpd",
						clients.jscpdClient.getAvailabilityVerdict?.(),
					),
				);
				return;
			}
			const isTsProject = fs.existsSync(
				path.join(analysisRoot, "tsconfig.json"),
			);
			const scannerKey = isTsProject ? "jscpd-ts" : "jscpd";
			const startMs = Date.now();
			const result = await clients.jscpdClient.scan(
				analysisRoot,
				undefined,
				undefined,
				isTsProject,
			);
			if (!result.success) {
				recordFailed("jscpd", result);
				return;
			}
			if (result.analyzed !== true) {
				markCold(
					"jscpd",
					"jscpd did not analyse this root (no source files, or the scan produced no report)",
				);
				return;
			}
			cacheManager.writeCache(scannerKey, result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"jscpd",
				jscpdResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
				true,
			);
		}),

		// madge — circular-dependency detection.
		task("madge", async () => {
			if (!(await clients.depChecker.ensureAvailable())) {
				markCold(
					"madge",
					reasonFromAvailabilityVerdict(
						"madge",
						clients.depChecker.getAvailabilityVerdict?.(),
					),
				);
				return;
			}
			const startMs = Date.now();
			const result = await clients.depChecker.scanProject(analysisRoot);
			cacheManager.writeCache("madge", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"madge",
				circularDepsToProjectDiagnostics(analysisRoot, result.circular ?? []),
				Date.now() - startMs,
				result.analyzed === true,
			);
		}),

		// gitleaks — committed-secrets detection. session_start/per-edit stay
		// config-gated per #130's strict default (GitleaksClient.hasGitleaksSignal),
		// but mode=full is an explicitly-requested comprehensive review — use
		// #130's own considered-but-unshipped "smart-default" tier instead (any
		// tracked git repo, GitleaksClient.hasGitRepo): gitleaks is cheap (~10MB
		// binary, no external DB pull) and findings are advisory-only, so the
		// stricter opt-in gate is needlessly conservative for this call. Refs #608
		// dogfooding finding that flagged gitleaks/trivy/govulncheck/dead-code as
		// "cold" on a project with no explicit gitleaks config.
		task("gitleaks", async () => {
			if (!GitleaksClient.hasGitRepo(analysisRoot)) {
				markCold("gitleaks", "not a git repository (no .git found)");
				return;
			}
			if (!(await clients.gitleaksClient.ensureAvailable())) {
				markCold(
					"gitleaks",
					reasonFromAvailabilityVerdict(
						"gitleaks",
						clients.gitleaksClient.getAvailabilityVerdict?.(),
					),
				);
				return;
			}
			const startMs = Date.now();
			const result = await clients.gitleaksClient.scan(analysisRoot, {
				requireSignal: false,
			});
			if (!result.success) {
				recordFailed("gitleaks", result);
				return;
			}
			cacheManager.writeCache("gitleaks", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"gitleaks",
				gitleaksResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
				result.analyzed === true,
			);
		}),

		// govulncheck — Go module CVE detection. Go-module-gated per #132.
		task("govulncheck", async () => {
			if (!GovulncheckClient.hasGoModule(analysisRoot)) {
				markCold("govulncheck", "no go.mod found (not a Go module)");
				return;
			}
			if (!(await clients.govulncheckClient.ensureAvailable())) {
				// #1623 fix-round F1: `GovulncheckClient.doEnsureAvailable` has a
				// branch (`assertInstallAllowed`, govulncheck-client.ts) that returns
				// false WITHOUT ever touching its availability latch — a
				// project-trust install denial, deliberately not latched so a later
				// trust grant can retry (see that file's own comment). The latch's
				// verdict is genuinely absent in that case, not merely unread, so
				// check trust denial FIRST via the same taxonomy project-trust.ts
				// already exposes, and only fall back to the probe-based verdict
				// (a real timeout/absence) when trust isn't the reason.
				markCold(
					"govulncheck",
					isToolInstallAllowedByTrust()
						? reasonFromAvailabilityVerdict(
								"govulncheck",
								clients.govulncheckClient.getAvailabilityVerdict?.(),
							)
						: (projectTrustDenialReason() ?? "govulncheck binary unavailable"),
				);
				return;
			}
			const startMs = Date.now();
			const result = await clients.govulncheckClient.analyze(analysisRoot);
			if (!result.success) {
				recordFailed("govulncheck", result);
				return;
			}
			cacheManager.writeCache("govulncheck", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"govulncheck",
				govulncheckResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
				result.analyzed === true,
			);
		}),

		// opengrep — full-workspace semgrep-grade security/quality findings via a
		// single project-wide CLI scan (#584). Structurally always-on: mirrors
		// session_start (`runtime-session.ts`) and the LSP auxiliary's own
		// enablement (`OpengrepClient.resolveConfig` only picks WHICH rules run,
		// never whether opengrep runs at all), so unlike gitleaks/govulncheck/trivy
		// it carries NO static project-type gate — only an availability probe.
		// Re-entrancy-safe like the other SecurityScanClient-family analyzers:
		// `OpengrepClient.scan` routes through `SecurityScanClient.dedupeScan`, so a
		// call here that races the session_start whole-tree scan of the same root
		// JOINS the in-flight run instead of paying a second heavy scan (#883 single
		// source of truth — the exact wiring gitleaks/trivy use above). #585: this
		// was the one extractor registered in `extractors.ts` but MISSING here, so
		// opengrep scanned+cached yet nothing production read it back into
		// `lens_diagnostics mode=full` — the honesty gap (#533) this task closes.
		task("opengrep", async () => {
			if (!(await clients.opengrepClient.ensureAvailable())) {
				markCold(
					"opengrep",
					reasonFromAvailabilityVerdict(
						"opengrep",
						clients.opengrepClient.getAvailabilityVerdict?.(),
					),
				);
				return;
			}
			const startMs = Date.now();
			const result = await clients.opengrepClient.scan(analysisRoot);
			if (!result.success) {
				recordFailed("opengrep", result);
				return;
			}
			cacheManager.writeCache("opengrep", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"opengrep",
				opengrepResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
				result.analyzed === true,
			);
		}),

		// trivy — dependency CVE detection. Explicit opt-in per #131.
		task("trivy", async () => {
			if (!TrivyClient.shouldScan(analysisRoot)) {
				markCold(
					"trivy",
					"not opted in (.pi-lens.json trivy.enabled) or no dependency manifest found",
				);
				return;
			}
			if (!(await clients.trivyClient.ensureAvailable())) {
				markCold(
					"trivy",
					reasonFromAvailabilityVerdict(
						"trivy",
						clients.trivyClient.getAvailabilityVerdict?.(),
					),
				);
				return;
			}
			const startMs = Date.now();
			const result = await clients.trivyClient.scan(analysisRoot);
			if (!result.success) {
				recordFailed("trivy", result);
				return;
			}
			cacheManager.writeCache("trivy", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"trivy",
				trivyResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
				result.analyzed === true,
			);
		}),

		// dead-code — cross-file dead-code for non-JS/TS languages (#127).
		// Each client self-gates via detect(); only matching-language projects
		// incur the whole-tree scan. Run the applicable ones in parallel too.
		task("dead-code", async () => {
			const applicable = clients.deadCodeClients.filter((c) =>
				c.detect(analysisRoot),
			);
			if (applicable.length === 0) {
				markCold(
					"dead-code",
					"no dead-code client detected an applicable language for this project",
				);
				return;
			}
			await Promise.all(
				applicable.map(async (client) => {
					const cacheKey = `dead-code-${client.id}`;
					const startMs = Date.now();
					const result = await client.analyze(analysisRoot);
					if (!result.success) {
						recordFailed("dead-code", result);
						return;
					}
					cacheManager.writeCache(cacheKey, result, analysisRoot, {
						scanDurationMs: Date.now() - startMs,
					});
					const adapted = deadCodeResultToProjectDiagnostics(
						analysisRoot,
						result,
					);
					record(
						"dead-code",
						adapted,
						Date.now() - startMs,
						result.analyzed === true,
						`dead-code-${result.language}`,
					);
				}),
			);
		}),

		// test-runner — CACHE-READ only, unlike every task above (#1004). Its
		// session cadence doesn't fit the "trigger-or-join a fresh run" shape the
		// rest of this module uses: the actual scan is the per-edit turn_end fire
		// in `runtime-turn.ts`, which only ever runs the (targeted, cascade-aware)
		// test files touched by THIS turn's edits — there is no "whole project"
		// test run to (re-)trigger here, and unconditionally spawning a full suite
		// on every mode=full call would be the exact "heavy re-run on every call"
		// cost this module's other tasks avoid via de-dupe/gating. So this task
		// instead peeks at the `"test-runner-findings"` cache turn_end already
		// wrote — the same cache key, the same adapter
		// (`testRunnerFindingsToProjectDiagnostics`), and the same cache-only
		// contract the pre-#585 `extractCachedProjectDiagnostics` registry's
		// "test-runner" row used (see extractors.ts's removal note) — before #585
		// dropped that reader without replacing this one row's semantics here.
		// Deliberately never calls `writeCache`: there is nothing fresher to write
		// back, only what turn_end already produced.
		//
		// No double-count / honesty gap (#533): explicit `pilens_turn_end`
		// delivery may call `consumeTestFindings` (`runtime-context.ts`) to
		// read-and-clear this SAME cache key once. Automatic Pi delivery uses a
		// non-context custom entry and never consumes this pull-diagnostics cache.
		// This task only ever reads (never clears) it, so it can't race that
		// consumption into re-delivering a message twice — at most it surfaces
		// the same underlying failures a second time, through a different
		// surface (the mode=full project snapshot) that was previously silently
		// empty for this analyzer. If `consumeTestFindings` already cleared the
		// cache before this runs, this task correctly sees nothing and reports
		// `cold` rather than inventing stale data.
		task("test-runner", async () => {
			const startMs = Date.now();
			const cached = cacheManager.readCache<TestRunnerFindingsCache>(
				"test-runner-findings",
				analysisRoot,
			);
			if (!cached?.data) {
				markCold(
					"test-runner",
					"no turn_end test-runner cache entry yet this session",
				);
				return;
			}
			// #1623: unlike every other lane in this module, test-runner is a
			// cache-read BY DESIGN (see the task's own header comment above) — it
			// never performs a fresh run this call, so its age must be surfaced
			// the same way a genuinely-stale cache read would be, rather than
			// looking indistinguishable from a lane that just executed.
			cachedAgeMs["test-runner"] =
				Date.now() - new Date(cached.meta.timestamp).getTime();
			record(
				"test-runner",
				testRunnerFindingsToProjectDiagnostics(
					cached.data,
					analysisRoot,
					options.runtime,
				),
				Date.now() - startMs,
				// Never authoritative: this lane reads the cache turn_end wrote,
				// it never runs a suite over the root this call (#2154).
				false,
			);
		}),
	];

	// Swallow any later rejection so an aborted-and-abandoned task can never
	// surface as an unhandled rejection once this function has already
	// returned partial results below.
	const allSettled = Promise.all(tasks)
		.then(() => "completed" as const)
		.catch(() => "completed" as const);

	const outcome = signal
		? await Promise.race([
				allSettled,
				new Promise<"aborted">((resolve) => {
					if (signal.aborted) {
						resolve("aborted");
						return;
					}
					signal.addEventListener("abort", () => resolve("aborted"), {
						once: true,
					});
				}),
			])
		: await allSettled;

	if (outcome === "aborted") {
		const abortedIds = ANALYZER_IDS.filter((id) => !settledIds.has(id));
		for (const id of abortedIds) pushUnique(cold, id);
		return {
			diagnostics,
			runners,
			analyzed,
			authoritativeCoverage,
			cold,
			coldReasons,
			failed,
			timings,
			cachedAgeMs,
			aborted: true,
			abortedIds,
			dispositionSuppressed,
			dispositionSuppressedByLane,
		};
	}

	return {
		diagnostics,
		runners,
		analyzed,
		authoritativeCoverage,
		cold,
		coldReasons,
		failed,
		timings,
		cachedAgeMs,
		dispositionSuppressed,
		dispositionSuppressedByLane,
	};
}
