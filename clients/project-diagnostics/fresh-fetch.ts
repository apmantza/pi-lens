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
 * performs (or joins) an actual run. Every fresh result is written back to
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
	/** Extractor ids skipped this run (not applicable / tool unavailable). */
	cold: string[];
	/** Wall-clock ms spent per extractor id that actually ran (join time
	 *  included when this call joined an already-in-flight scan). */
	timings: Record<string, number>;
}

function pushUnique(list: string[], id: string): void {
	if (!list.includes(id)) list.push(id);
}

/**
 * Trigger (or join, via each client's in-flight de-dupe guard) a fresh run of
 * every heavyweight project analyzer and adapt the results to
 * `ProjectDiagnostic[]`, mirroring `extractCachedProjectDiagnostics`'s return
 * shape. Runs all analyzers in parallel — total wall time is bounded by the
 * single slowest one (trivy's own timeout ceiling) rather than their sum.
 */
export async function fetchFreshProjectDiagnostics(
	cacheManager: CacheManager,
	cwd: string,
	clients: BootstrapClients,
): Promise<FreshProjectDiagnosticsResult> {
	const analysisRoot = path.resolve(cwd);
	const diagnostics: ProjectDiagnostic[] = [];
	const runners: string[] = [];
	const cold: string[] = [];
	const timings: Record<string, number> = {};

	function record(id: string, adapted: ProjectDiagnostic[], elapsedMs: number): void {
		timings[id] = (timings[id] ?? 0) + elapsedMs;
		if (adapted.length > 0) {
			diagnostics.push(...adapted);
			pushUnique(runners, id);
		}
	}

	const tasks: Promise<void>[] = [
		// knip — always applicable to probe (KnipClient.analyze itself no-ops
		// when no project root marker is found, matching session_start).
		(async () => {
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
		})(),

		// jscpd — duplicate code detection. Cache key varies with TS-project
		// detection, exactly mirroring session_start's own logic.
		(async () => {
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
		})(),

		// madge — circular-dependency detection.
		(async () => {
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
		})(),

		// gitleaks — committed-secrets detection. Config-gated per #130.
		(async () => {
			if (!GitleaksClient.hasGitleaksSignal(analysisRoot)) {
				cold.push("gitleaks");
				return;
			}
			if (!(await clients.gitleaksClient.ensureAvailable())) {
				cold.push("gitleaks");
				return;
			}
			const startMs = Date.now();
			const result = await clients.gitleaksClient.scan(analysisRoot);
			cacheManager.writeCache("gitleaks", result, analysisRoot, {
				scanDurationMs: Date.now() - startMs,
			});
			record(
				"gitleaks",
				gitleaksResultToProjectDiagnostics(analysisRoot, result),
				Date.now() - startMs,
			);
		})(),

		// govulncheck — Go module CVE detection. Go-module-gated per #132.
		(async () => {
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
		})(),

		// trivy — dependency CVE detection. Explicit opt-in per #131.
		(async () => {
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
		})(),

		// dead-code — cross-file dead-code for non-JS/TS languages (#127).
		// Each client self-gates via detect(); only matching-language projects
		// incur the whole-tree scan. Run the applicable ones in parallel too.
		(async () => {
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
		})(),
	];

	await Promise.all(tasks);
	return { diagnostics, runners, cold, timings };
}
