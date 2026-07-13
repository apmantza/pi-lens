/**
 * Fresh-fetch counterpart to `extractCachedProjectDiagnostics` (./extractors.ts)
 * for `lens_diagnostics mode=full` (#585).
 *
 * `extractCachedProjectDiagnostics` is deliberately cache-only — see its own
 * header comment — because historically mode=full had no safe way to trigger
 * a scan itself: relaunching knip/jscpd/gitleaks/govulncheck/trivy/dead-code
 * concurrently with the session_start background pass over the SAME project
 * root could double-spawn a CPU-bound analyzer (the exact TUI-freeze/zombie-
 * process pathology `KnipClient.inFlight`'s docstring describes).
 *
 * That pathology is now closed for every one of these analyzers:
 * `KnipClient`, `JscpdClient`, and the `DeadCodeClient`s each carry their own
 * `inFlight` de-dupe map, and `GitleaksClient`/`GovulncheckClient`/
 * `TrivyClient` share `SecurityScanClient.dedupeScan` (landed in #313, well
 * before this issue — verified before writing this module). So mode=full can
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
 * Refs: #585, #313 (the SecurityScanClient de-dupe prerequisite)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BootstrapClients } from "../bootstrap.js";
import type { CacheManager } from "../cache-manager.js";
import { getKnipIgnorePatterns } from "../file-utils.js";
import { GitleaksClient } from "../gitleaks-client.js";
import { GovulncheckClient } from "../govulncheck-client.js";
import { TrivyClient } from "../trivy-client.js";
import { deadCodeResultToProjectDiagnostics } from "./runner-adapters/dead-code.js";
import { gitleaksResultToProjectDiagnostics } from "./runner-adapters/gitleaks.js";
import { govulncheckResultToProjectDiagnostics } from "./runner-adapters/govulncheck.js";
import { jscpdResultToProjectDiagnostics } from "./runner-adapters/jscpd.js";
import { knipIssuesToProjectDiagnostics } from "./runner-adapters/knip.js";
import { circularDepsToProjectDiagnostics } from "./runner-adapters/madge.js";
import { trivyResultToProjectDiagnostics } from "./runner-adapters/trivy.js";
import type { ProjectDiagnostic } from "./types.js";

export interface FreshProjectDiagnosticsResult {
	diagnostics: ProjectDiagnostic[];
	/** Extractor ids that actually contributed findings this run. */
	runners: string[];
	/** Extractor ids skipped this run (not applicable / tool unavailable, OR
	 *  aborted before settling — see `abortedIds`). */
	cold: string[];
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
}

/** Registry order mirrors `extractors.ts`'s `EXTRACTORS` ids — kept in sync by
 *  hand since this module intentionally doesn't share that table (additive,
 *  not a registry restructure — see the module header). */
const ANALYZER_IDS = [
	"knip",
	"jscpd",
	"madge",
	"gitleaks",
	"govulncheck",
	"trivy",
	"dead-code",
] as const;

function pushUnique(list: string[], id: string): void {
	if (!list.includes(id)) list.push(id);
}

/**
 * Trigger (or join, via each client's in-flight de-dupe guard) a fresh run of
 * every heavyweight project analyzer and adapt the results to
 * `ProjectDiagnostic[]`, mirroring `extractCachedProjectDiagnostics`'s return
 * shape. Runs all analyzers in parallel — total wall time is bounded by the
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
): Promise<FreshProjectDiagnosticsResult> {
	const analysisRoot = path.resolve(cwd);
	const diagnostics: ProjectDiagnostic[] = [];
	const runners: string[] = [];
	const cold: string[] = [];
	const timings: Record<string, number> = {};
	const settledIds = new Set<string>();

	function record(id: string, adapted: ProjectDiagnostic[], elapsedMs: number): void {
		timings[id] = (timings[id] ?? 0) + elapsedMs;
		if (adapted.length > 0) {
			diagnostics.push(...adapted);
			pushUnique(runners, id);
		}
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
			cacheManager.writeCache("knip", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"knip",
				knipIssuesToProjectDiagnostics(analysisRoot, result.issues ?? []),
				Date.now() - startMs,
			);
		}),

		// jscpd — duplicate code detection. Cache key varies with TS-project
		// detection, exactly mirroring session_start's own logic.
		task("jscpd", async () => {
			if (!(await clients.jscpdClient.ensureAvailable())) {
				cold.push("jscpd");
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
			cacheManager.writeCache(scannerKey, result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"jscpd",
				jscpdResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
			);
		}),

		// madge — circular-dependency detection.
		task("madge", async () => {
			if (!(await clients.depChecker.ensureAvailable())) {
				cold.push("madge");
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
				cold.push("gitleaks");
				return;
			}
			if (!(await clients.gitleaksClient.ensureAvailable())) {
				cold.push("gitleaks");
				return;
			}
			const startMs = Date.now();
			const result = await clients.gitleaksClient.scan(analysisRoot, {
				requireSignal: false,
			});
			cacheManager.writeCache("gitleaks", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"gitleaks",
				gitleaksResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
			);
		}),

		// govulncheck — Go module CVE detection. Go-module-gated per #132.
		task("govulncheck", async () => {
			if (!GovulncheckClient.hasGoModule(analysisRoot)) {
				cold.push("govulncheck");
				return;
			}
			if (!(await clients.govulncheckClient.ensureAvailable())) {
				cold.push("govulncheck");
				return;
			}
			const startMs = Date.now();
			const result = await clients.govulncheckClient.analyze(analysisRoot);
			cacheManager.writeCache("govulncheck", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"govulncheck",
				govulncheckResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
			);
		}),

		// trivy — dependency CVE detection. Explicit opt-in per #131.
		task("trivy", async () => {
			if (!TrivyClient.shouldScan(analysisRoot)) {
				cold.push("trivy");
				return;
			}
			if (!(await clients.trivyClient.ensureAvailable())) {
				cold.push("trivy");
				return;
			}
			const startMs = Date.now();
			const result = await clients.trivyClient.scan(analysisRoot);
			cacheManager.writeCache("trivy", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"trivy",
				trivyResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
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
				cold.push("dead-code");
				return;
			}
			await Promise.all(
				applicable.map(async (client) => {
					const cacheKey = `dead-code-${client.id}`;
					const startMs = Date.now();
					const result = await client.analyze(analysisRoot);
					cacheManager.writeCache(cacheKey, result, analysisRoot, {
						scanDurationMs: Date.now() - startMs,
					});
					record(
						"dead-code",
						deadCodeResultToProjectDiagnostics(analysisRoot, result),
						Date.now() - startMs,
					);
				}),
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
		return { diagnostics, runners, cold, timings, aborted: true, abortedIds };
	}

	return { diagnostics, runners, cold, timings };
}
