/**
 * Extractor registry — the single place that turns the heavyweight project
 * analyzers' CACHED results into `ProjectDiagnostic`s for `lens_diagnostics
 * mode=full`.
 *
 * Each analyzer (knip, jscpd, madge, gitleaks, …) runs on its own cadence
 * (session-start / turn-end) and writes a result to `cacheManager`. This module
 * READS those caches and adapts them via the pure `runner-adapters/*` functions.
 * It never launches a scan — so mode=full can't relaunch or contend with the
 * background runs. Adding a new analyzer = write one adapter + one registry row.
 */

import type { CacheManager } from "../cache-manager.js";
import type { DeadCodeResult } from "../dead-code-client.js";
import type { CircularDep } from "../dependency-checker.js";
import type { GitleaksResult } from "../gitleaks-client.js";
import type { GovulncheckResult } from "../govulncheck-client.js";
import type { JscpdResult } from "../jscpd-client.js";
import type { KnipIssue } from "../knip-client.js";
import type { TrivyResult } from "../trivy-client.js";
import { deadCodeResultToProjectDiagnostics } from "./runner-adapters/dead-code.js";
import { gitleaksResultToProjectDiagnostics } from "./runner-adapters/gitleaks.js";
import { govulncheckResultToProjectDiagnostics } from "./runner-adapters/govulncheck.js";
import { jscpdResultToProjectDiagnostics } from "./runner-adapters/jscpd.js";
import { knipIssuesToProjectDiagnostics } from "./runner-adapters/knip.js";
import { circularDepsToProjectDiagnostics } from "./runner-adapters/madge.js";
import { trivyResultToProjectDiagnostics } from "./runner-adapters/trivy.js";
import type { ProjectDiagnostic } from "./types.js";

interface ProjectDiagnosticExtractor<T> {
	/** Runner id recorded on the snapshot (`runners: [...]`). */
	id: string;
	/**
	 * Cache scanner keys to try, in order — first hit wins. (jscpd stores under
	 * `jscpd-ts` for TS projects, else `jscpd`.)
	 */
	cacheKeys: string[];
	/** Map the cached tool result to per-file diagnostics. */
	adapt: (cwd: string, result: T) => ProjectDiagnostic[];
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous result types per row
const EXTRACTORS: ProjectDiagnosticExtractor<any>[] = [
	{
		id: "knip",
		cacheKeys: ["knip"],
		adapt: (cwd, r: { issues?: KnipIssue[] }) =>
			knipIssuesToProjectDiagnostics(cwd, r.issues ?? []),
	},
	{
		id: "jscpd",
		cacheKeys: ["jscpd-ts", "jscpd"],
		adapt: (cwd, r: JscpdResult) => jscpdResultToProjectDiagnostics(cwd, r),
	},
	{
		id: "madge",
		cacheKeys: ["madge"],
		adapt: (cwd, r: { circular?: CircularDep[] }) =>
			circularDepsToProjectDiagnostics(cwd, r.circular ?? []),
	},
	{
		id: "gitleaks",
		cacheKeys: ["gitleaks"],
		adapt: (cwd, r: GitleaksResult) =>
			gitleaksResultToProjectDiagnostics(cwd, r),
	},
	{
		id: "govulncheck",
		cacheKeys: ["govulncheck"],
		adapt: (cwd, r: GovulncheckResult) =>
			govulncheckResultToProjectDiagnostics(cwd, r),
	},
	{
		id: "trivy",
		cacheKeys: ["trivy"],
		adapt: (cwd, r: TrivyResult) => trivyResultToProjectDiagnostics(cwd, r),
	},
	{
		// Per-language cache (`dead-code-<id>`). Only Python (vulture) exists today;
		// add a key here as each new dead-code language lands.
		id: "dead-code",
		cacheKeys: ["dead-code-python"],
		adapt: (cwd, r: DeadCodeResult) =>
			deadCodeResultToProjectDiagnostics(cwd, r),
	},
];

/**
 * Read every registered analyzer's cached result and adapt it to project
 * diagnostics. Returns the merged diagnostics plus the ids of the analyzers that
 * actually contributed (for the snapshot's `runners` list). Cache-only: no scans.
 */
export function extractCachedProjectDiagnostics(
	cacheManager: CacheManager,
	cwd: string,
): { diagnostics: ProjectDiagnostic[]; runners: string[] } {
	const diagnostics: ProjectDiagnostic[] = [];
	const runners: string[] = [];
	for (const extractor of EXTRACTORS) {
		let data: unknown;
		for (const key of extractor.cacheKeys) {
			const entry = cacheManager.readCache<unknown>(key, cwd);
			if (entry?.data) {
				data = entry.data;
				break;
			}
		}
		if (data === undefined) continue;
		const adapted = extractor.adapt(cwd, data);
		if (adapted.length > 0) {
			diagnostics.push(...adapted);
			runners.push(extractor.id);
		}
	}
	return { diagnostics, runners };
}
