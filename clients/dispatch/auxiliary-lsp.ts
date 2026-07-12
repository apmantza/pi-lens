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
import { findLocalTyposConfig } from "../typos-config.js";
import { findLocalZizmorConfig } from "../zizmor-config.js";
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
	semantic: (
		d: LSPDiagnostic,
		ctx: { blockingAllowed: boolean },
	) => OutputSemantic;
	defectClass?: (d: LSPDiagnostic) => DefectClass | undefined;
	/** Per-diagnostic suppression via the tool's NATIVE inline comment (e.g.
	 *  semgrep's `# nosemgrep`, #441). Given the file content; return true to drop
	 *  the finding. Distinct from pi-lens's own `# pi-lens-ignore` — this honors the
	 *  suppression syntax the tool's own users already know. */
	isSuppressed?: (d: LSPDiagnostic, content: string) => boolean;
}

/**
 * Semgrep/opengrep `# nosemgrep` / `# nosemgrep: <rule-id>[,<rule-id>]` inline
 * suppression (#441). A bare `# nosemgrep` drops every finding on its line; the
 * `: <ids>` form drops only the listed rule ids. `d.code` is the semgrep rule id.
 * Also accepts the `//` comment form.
 *
 * Matches Semgrep placement: honored on the finding's OWN line (inline or not),
 * and on the line ABOVE only when that line is a STANDALONE comment (no code before
 * it) — so `a()  # nosemgrep` suppresses a finding on `a()` but not the next line.
 */
const NOSEMGREP_RE = /(?:#|\/\/)\s*nosemgrep(?::\s*(.+))?/i;
const NOSEMGREP_STANDALONE_RE = /^\s*(?:#|\/\/)\s*nosemgrep(?::\s*(.+))?\s*$/i;
export function isNosemgrepSuppressed(
	d: LSPDiagnostic,
	content: string,
): boolean {
	const startLine = d.range?.start?.line; // 0-based
	if (startLine == null) return false;
	const lines = content.split("\n");
	const ruleId = String(d.code ?? "");
	const checkLine = (text: string | undefined, standaloneOnly: boolean): boolean => {
		if (!text) return false;
		const m = (standaloneOnly ? NOSEMGREP_STANDALONE_RE : NOSEMGREP_RE).exec(text);
		if (!m) return false;
		if (m[1] === undefined) return true; // bare nosemgrep → suppress the line
		return m[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.includes(ruleId);
	};
	// The finding's own line (inline OK), then the line above (standalone comment only).
	return (
		checkLine(lines[startLine], false) ||
		checkLine(lines[startLine - 1], true)
	);
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
		// Honor the canonical Semgrep suppression the user already knows (#441).
		isSuppressed: isNosemgrepSuppressed,
	},
	{
		serverId: "ast-grep",
		tool: "ast-grep",
		// ast-grep tags its LSP diagnostics `source: "ast-grep"`.
		sourceMatch: /ast[-_]?grep/i,
		killSwitchFlag: "no-ast-grep",
		enabledByDefault: true,
		// The ast-grep LSP runs either the repo's own sgconfig (when present) or
		// pi-lens's shipped baseline sgconfig. In both cases the rule severity is
		// deliberate, so preserve ast-grep's severity semantics: ERROR can block,
		// WARNING/INFO stay advisory.
		allowBlocking: () => true,
		semantic: (d, { blockingAllowed }) =>
			blockingAllowed && d.severity === 1 ? "blocking" : "warning",
		defectClass: (d) =>
			classifyDefect(String(d.code ?? ""), "ast-grep", d.message ?? ""),
	},
	{
		serverId: "zizmor",
		tool: "zizmor",
		// zizmor tags its LSP diagnostics `source: "zizmor"`.
		sourceMatch: /zizmor/i,
		killSwitchFlag: "no-zizmor",
		enabledByDefault: true,
		// zizmor's default ("regular") persona is a curated, low-false-positive
		// audit set, but as an always-on advisory we only let it BLOCK when the repo
		// opts in with its own `zizmor.yml` (the author's deliberate severities /
		// ignores). Advisory otherwise — findings still surface via lens_diagnostics.
		// zizmor maps High→ERROR(1), Medium/Low→WARNING(2), Informational→INFO(3).
		allowBlocking: (cwd) => Boolean(findLocalZizmorConfig(cwd)),
		semantic: (d, { blockingAllowed }) =>
			blockingAllowed && d.severity === 1 ? "blocking" : "warning",
		defectClass: (d) =>
			classifyDefect(String(d.code ?? ""), "zizmor", d.message ?? ""),
	},
	{
		serverId: "typos",
		tool: "typos",
		// typos-lsp tags its LSP diagnostics `source: "typos"`.
		sourceMatch: /typos/i,
		killSwitchFlag: "no-typos",
		enabledByDefault: true,
		// typos is allow-list based (only KNOWN misspellings with a known
		// correction), but as an always-on advisory we only let it BLOCK when the
		// repo opts in with its own `typos.toml`/`_typos.toml`/`.typos.toml` (the
		// team's curated dictionary + chosen severity). Advisory otherwise —
		// findings still surface via lens_diagnostics. Note typos-lsp's default
		// severity is WARNING, so even with a config it stays advisory unless the
		// repo raises `diagnostic-severity` to Error.
		allowBlocking: (cwd) => Boolean(findLocalTyposConfig(cwd)),
		semantic: (d, { blockingAllowed }) =>
			blockingAllowed && d.severity === 1 ? "blocking" : "warning",
		// A misspelling is a documentation/quality defect — not security or
		// correctness. "style" is the closest taxonomy class.
		defectClass: () => "style",
	},
];

export type GetFlag = (flag: string) => boolean | string | undefined;

/** The auxiliary server ids enabled for this turn (the lsp runner passes these
 *  to `touchFile` since it — not the LSP service — owns flag access). */
export function enabledAuxiliaryLspServerIds(getFlag: GetFlag): string[] {
	return AUXILIARY_LSP_PROFILES.flatMap((p) =>
		p.enabledByDefault &&
		!(p.killSwitchFlag && getFlag(p.killSwitchFlag) === true)
			? [p.serverId]
			: [],
	);
}

/** Find the profile whose server emitted a diagnostic with this `source`. */
export function findAuxiliaryProfileForSource(
	source: string | undefined,
): AuxiliaryLspProfile | undefined {
	if (!source) return undefined;
	return AUXILIARY_LSP_PROFILES.find((p) => p.sourceMatch.test(source));
}

/**
 * Single-diagnostic suppression check (#586): look up the diagnostic's
 * auxiliary profile by `source` and, if that profile declares an
 * `isSuppressed` callback (currently only opengrep's `# nosemgrep`, #441),
 * apply it. Returns false for diagnostics with no matching profile or whose
 * profile has no native suppression syntax — the common case for plain
 * language-server diagnostics.
 *
 * This is the ONE lookup+apply implementation; every call site that decides
 * whether to drop a diagnostic for its tool's own inline suppression comment
 * should go through this (or `applyAuxiliarySuppressions` below) rather than
 * re-deriving the profile lookup.
 */
export function isAuxiliaryDiagnosticSuppressed(
	d: LSPDiagnostic,
	content: string,
): boolean {
	const profile = findAuxiliaryProfileForSource(d.source);
	return Boolean(profile?.isSuppressed?.(d, content));
}

/**
 * Filter a diagnostic list down to the ones NOT suppressed by their
 * auxiliary profile's native inline-comment syntax (#586). This is the
 * shared helper `tools/lsp-diagnostics.ts` and `clients/lsp/index.ts`'s
 * `runWorkspaceDiagnostics` use so a `// nosemgrep` (or any future profile's
 * equivalent) suppresses a finding identically whether it's seen via the
 * per-edit dispatch runner or a standalone diagnostics query — previously
 * only the former honored it (#586).
 */
export function applyAuxiliarySuppressions(
	diagnostics: readonly LSPDiagnostic[],
	content: string,
): LSPDiagnostic[] {
	return diagnostics.filter((d) => !isAuxiliaryDiagnosticSuppressed(d, content));
}
