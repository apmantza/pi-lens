/**
 * Auxiliary-diagnostic-LSP capability.
 *
 * Some LSP servers aren't a file's *language* server — they're cross-cutting,
 * diagnostic-only scanners that attach across many languages and run ALONGSIDE
 * the primary (security, spelling, secrets, …). Running them as warm LSP servers
 * compiles their rules/dictionaries once per session instead of paying a
 * cold-start on every file (see #111 — Opengrep's ~8s CLI-per-file → ~1.3s warm).
 *
 * This module is the registry that maps such a server to:
 *   - its enablement gate (default-on with an optional kill-switch flag), and
 *   - how to turn its raw LSP diagnostics into pi-lens diagnostics (tool name +
 *     semantic policy + defect class), since the LSP `source` differs from our
 *     tool id and most auxiliaries should be advisory, not blocking.
 *
 * Adding a new cross-cutting tool = register an `LSPServerInfo` with
 * `role:"auxiliary"` (clients/lsp/server.ts) + one profile entry here.
 */

import type { LSPDiagnostic } from "../lsp/client.js";
import { findLocalOpengrepConfig } from "../opengrep-config.js";
import { findLocalSgconfig } from "../sgconfig.js";
import { classifyDefect } from "./diagnostic-taxonomy.js";
import type { DefectClass, OutputSemantic } from "./types.js";

export interface AuxiliaryLspProfile {
	/** LSPServerInfo.id of the auxiliary server. */
	serverId: string;
	/** pi-lens tool id its diagnostics are tagged with. */
	tool: string;
	/** Matches `LSPDiagnostic.source` the server emits (e.g. Opengrep → "Semgrep"). */
	sourceMatch: RegExp;
	/** Auxiliaries are default-on; this boolean flag turns one off. */
	killSwitchFlag?: string;
	enabledByDefault: boolean;
	/** Whether findings may block in this workspace (e.g. the repo supplies its
	 *  own curated rules). When false, even ERROR-severity findings stay advisory.
	 *  Computed once per dispatch by the lsp runner. Absent ⇒ never blocks. */
	allowBlocking?: (cwd: string) => boolean;
	/** Severity (+ whether blocking is allowed here) → semantic. Most auxiliaries
	 *  are advisory; only high-signal ones block. */
	semantic: (d: LSPDiagnostic, ctx: { blockingAllowed: boolean }) => OutputSemantic;
	defectClass?: (d: LSPDiagnostic) => DefectClass | undefined;
}

export const AUXILIARY_LSP_PROFILES: readonly AuxiliaryLspProfile[] = [
	{
		serverId: "opengrep",
		tool: "opengrep",
		// Opengrep is a Semgrep fork and tags LSP diagnostics `source: "Semgrep"`.
		sourceMatch: /opengrep|semgrep/i,
		killSwitchFlag: "no-opengrep",
		enabledByDefault: true,
		// The LSP diagnostic carries severity + rule id but NOT confidence (the
		// CLI's metadata.confidence is stripped). Opengrep's login-free `auto`
		// Community set is uniformly ERROR/LOW-confidence audit-tier, so blocking on
		// it would be a firehose. We honor ERROR→blocking ONLY when the repo
		// supplies its own curated rules (the author's deliberate severity); the
		// auto set is advisory. Either way, findings surface via lens_diagnostics.
		allowBlocking: (cwd) => Boolean(findLocalOpengrepConfig(cwd)),
		semantic: (d, { blockingAllowed }) =>
			blockingAllowed && d.severity === 1 ? "blocking" : "warning",
		defectClass: (d) =>
			classifyDefect(String(d.code ?? ""), "opengrep", d.message ?? ""),
	},
	{
		serverId: "ast-grep",
		tool: "ast-grep",
		// ast-grep tags its LSP diagnostics `source: "ast-grep"`.
		sourceMatch: /ast[-_]?grep/i,
		killSwitchFlag: "no-ast-grep",
		enabledByDefault: true,
		// The ast-grep LSP server only attaches when the repo has an sgconfig
		// (root-gated), so a finding here always stems from the team's own curated
		// rules — deliberately authored, hence blocking-eligible (mirrors Opengrep's
		// curated-config gate). The check is belt-and-suspenders for the runner.
		allowBlocking: (cwd) => Boolean(findLocalSgconfig(cwd)),
		semantic: (d, { blockingAllowed }) =>
			blockingAllowed && d.severity === 1 ? "blocking" : "warning",
		defectClass: (d) =>
			classifyDefect(String(d.code ?? ""), "ast-grep", d.message ?? ""),
	},
];

export type GetFlag = (flag: string) => boolean | string | undefined;

/** The auxiliary server ids enabled for this turn (the lsp runner passes these
 *  to `touchFile` since it — not the LSP service — owns flag access). */
export function enabledAuxiliaryLspServerIds(getFlag: GetFlag): string[] {
	return AUXILIARY_LSP_PROFILES.filter(
		(p) =>
			p.enabledByDefault &&
			!(p.killSwitchFlag && getFlag(p.killSwitchFlag) === true),
	).map((p) => p.serverId);
}

/** Find the profile whose server emitted a diagnostic with this `source`. */
export function findAuxiliaryProfileForSource(
	source: string | undefined,
): AuxiliaryLspProfile | undefined {
	if (!source) return undefined;
	return AUXILIARY_LSP_PROFILES.find((p) => p.sourceMatch.test(source));
}
