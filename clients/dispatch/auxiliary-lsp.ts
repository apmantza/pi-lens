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
import { lineTextAt } from "../lsp/content-scan.js";
import { shouldDegradeAuxiliaryLsp } from "../lsp-budget.js";
import { isSubagentSession } from "../subagent-mode.js";
import type { FileRole } from "../file-role.js";
import { findLocalOpengrepConfig } from "../opengrep-config.js";
import { findLocalTyposConfig } from "../typos-config.js";
import { findLocalZizmorConfig } from "../zizmor-config.js";
import { classifyDefect } from "./diagnostic-taxonomy.js";
import {
	isRuleIgnoredForPath,
	loadRuleIgnorePatterns,
} from "./rule-ignores.js";
import type { DefectClass, Diagnostic, OutputSemantic } from "./types.js";
import { semanticFor } from "./types.js";

export interface AuxiliaryLspProfile {
	/** LSPServerInfo.id of the auxiliary server. */
	serverId: string;
	/** pi-lens tool id its diagnostics are tagged with. */
	tool: string;
	/** Matches `LSPDiagnostic.source` the server emits (e.g. Opengrep → "Semgrep"). */
	sourceMatch: RegExp;
	/** Default-on auxiliaries: this boolean flag turns one off. */
	killSwitchFlag?: string;
	enabledByDefault: boolean;
	/**
	 * Opt-in auxiliaries (`enabledByDefault: false`): the lens flag that turns
	 * one ON. The gate fails closed (#4929): only a flag value that is exactly
	 * `true` enables the server; an absent, unknown or malformed value, and a
	 * profile that names no flag, mean off. Read per touch through `getFlag`,
	 * never at factory time (shape 87).
	 */
	optInFlag?: string;
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
	/** Drop this profile's findings on files with `fileRole: "test"` (#687).
	 *  Mirrors a runner's own `skipTestFiles` — needed here too because a
	 *  profile's diagnostics may arrive via the auxiliary LSP surface instead
	 *  of (or as well as) an in-process runner, and that surface has no
	 *  per-runner test-file gating of its own. */
	skipTestFiles?: boolean;
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
	const ruleId = String(d.code ?? "");
	const checkLine = (
		text: string | undefined,
		standaloneOnly: boolean,
	): boolean => {
		if (!text) return false;
		const m = (standaloneOnly ? NOSEMGREP_STANDALONE_RE : NOSEMGREP_RE).exec(
			text,
		);
		if (!m) return false;
		if (m[1] === undefined) return true; // bare nosemgrep → suppress the line
		return m[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.includes(ruleId);
	};
	// The finding's own line (inline OK), then the line above (standalone comment only).
	// #2066: both lines come from `lineTextAt`, which walks to them instead of
	// splitting the whole document — this runs once per auxiliary finding, so
	// the split was a full-document allocation per finding.
	return (
		checkLine(lineTextAt(content, startLine), false) ||
		checkLine(lineTextAt(content, startLine - 1), true)
	);
}

/**
 * zizmor's own native inline suppression: `# zizmor: ignore[audit-id[,audit-id]]`
 * on the finding's own line (https://docs.zizmor.sh/usage/#ignoring-results —
 * zizmor calls this "inline ignores"). Honoring it here mirrors
 * `isNosemgrepSuppressed` for Opengrep — a per-finding suppression path a repo
 * can reach for even without its own `zizmor.yml` (#971): e.g. a `# zizmor:
 * ignore[artipacked]` on a checkout-only job's `actions/checkout` step, or
 * `# zizmor: ignore[adhoc-packages]` on a `npm pack` tarball's local install
 * line, both cases the audit has no way to tell "checkout-only, no artifact
 * upload" or "this is testing our own just-built tarball" apart from a
 * remote-package install without this local, human-authored signal.
 */
const ZIZMOR_IGNORE_RE = /#\s*zizmor:\s*ignore\[([^\]]+)\]/i;
export function isZizmorIgnoreSuppressed(
	d: LSPDiagnostic,
	content: string,
): boolean {
	const startLine = d.range?.start?.line; // 0-based
	if (startLine == null) return false;
	// #2066: `lineTextAt` reads the one line this needs; the split it replaces
	// built every line of the document for the finding's own.
	const line = lineTextAt(content, startLine);
	if (!line) return false;
	const match = ZIZMOR_IGNORE_RE.exec(line);
	if (!match) return false;
	const ruleId = String(d.code ?? "").toLowerCase();
	return match[1]
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.includes(ruleId);
}

// #277 R7: every profile below used this exact same rule (ERROR-severity
// findings block only when the workspace opted into curated/authored rules;
// everything else stays advisory) — shared here instead of copy-pasted per
// profile so a future policy change (e.g. a WARNING-blocking tier) is one edit.
const blockOnErrorWhenAllowed = (
	d: LSPDiagnostic,
	{ blockingAllowed }: { blockingAllowed: boolean },
): OutputSemantic =>
	semanticFor(blockingAllowed && d.severity === 1 ? "error" : "warning");

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
		semantic: blockOnErrorWhenAllowed,
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
		// Matches the in-process ast-grep-napi runner's own `skipTestFiles: true`
		// (#687) — that flag stops applying the moment the ast-grep binary is
		// present, since the napi runner then skips entirely in favor of this
		// LSP surface, which had no test-file gating of its own.
		skipTestFiles: true,
		// The ast-grep LSP runs either the repo's own sgconfig (when present) or
		// pi-lens's shipped baseline sgconfig. In both cases the rule severity is
		// deliberate, so preserve ast-grep's severity semantics: ERROR can block,
		// WARNING/INFO stay advisory.
		allowBlocking: () => true,
		semantic: blockOnErrorWhenAllowed,
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
		semantic: blockOnErrorWhenAllowed,
		defectClass: (d) =>
			classifyDefect(String(d.code ?? ""), "zizmor", d.message ?? ""),
		// Honor zizmor's own native per-finding suppression (#971) — a documented
		// escape hatch for a workflow-context judgment call the audit itself has no
		// way to make (checkout-only vs. artifact-uploading job; a locally-built
		// tarball install vs. an arbitrary remote package).
		isSuppressed: isZizmorIgnoreSuppressed,
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
		semantic: blockOnErrorWhenAllowed,
		// A misspelling is a documentation/quality defect — not security or
		// correctness. "style" is the closest taxonomy class.
		defectClass: () => "style",
	},
	{
		serverId: "fallow",
		tool: "fallow",
		// fallow-lsp tags its LSP diagnostics `source: "fallow"`.
		sourceMatch: /fallow/i,
		// #4929: opt-in. Off unless `--lens-fallow` / `fallow.enabled=true` is set;
		// it overlaps knip, jscpd and madge, which keep running either way.
		enabledByDefault: false,
		optInFlag: "lens-fallow",
		// Advisory in this cut: no `allowBlocking`, so even an ERROR-severity
		// finding stays a warning. fallow publishes unused-code findings as LSP
		// HINT (severity 4, the editor's greyed-out tag); those stay advisory too.
		semantic: () => "warning",
		defectClass: (d) => {
			const code = String(d.code ?? "");
			if (code.startsWith("unused-")) return "unused-value";
			if (
				/^(security-|tainted-sink|dangerous-html|client-server-leak)/.test(code)
			)
				return "safety";
			return undefined;
		},
	},
];

/**
 * #4929: whether this server id is an opt-in auxiliary (`enabledByDefault:
 * false`). The LSP service's aggregate `clientScope: "all"` door reads it to
 * leave such a server unstarted: that door takes its exclusions from the
 * caller, and a caller with no flag access (or one that never asked) would
 * otherwise start a scanner the operator never turned on.
 */
export function isOptInAuxiliaryServerId(serverId: string): boolean {
	return AUXILIARY_LSP_PROFILES.some(
		(p) => p.serverId === serverId && !p.enabledByDefault,
	);
}

export type GetFlag = (flag: string) => boolean | string | undefined;

/** The auxiliary server ids enabled for this turn (the lsp runner passes these
 *  to `touchFile` since it — not the LSP service — owns flag access).
 *
 * #449 slice 2 (prototype): when this process decided at `session_start` that
 * the machine-wide LSP budget is exceeded (`clients/lsp-budget.ts`), auxiliary
 * servers are skipped entirely for the rest of the session — the primary
 * language server per file is unaffected. This is a per-SESSION degrade, not
 * per-file: once over budget, this session never spawns its auxiliary fleet,
 * rather than flip-flopping file to file. */
export function enabledAuxiliaryLspServerIds(getFlag: GetFlag): string[] {
	// #449 slice 2 (budget): skip auxiliaries when machine-wide LSP budget is
	// exceeded. #713 (subagent light mode): reuse the same seam — a subagent
	// session also skips auxiliaries; the parent session already runs them on
	// the same cwd. PI_LENS_SUBAGENT_FULL=1 restores full behavior via
	// isSubagentSession() returning false.
	if (shouldDegradeAuxiliaryLsp() || isSubagentSession()) return [];
	return AUXILIARY_LSP_PROFILES.flatMap((p) =>
		isEnabledByConfiguration(p, getFlag) ? [p.serverId] : [],
	);
}

/**
 * #4323: the auxiliary server ids the operator's configuration turns off: a
 * default-on profile whose kill switch is set (`--no-opengrep` or
 * `opengrep.enabled=false` in the global config, resolved by `getFlag`).
 *
 * An opt-in profile (#4929) that is not enabled is not listed: nothing was
 * switched off, naming a scanner the operator never asked for would change
 * every diagnostics report, and the service's aggregate door leaves opt-in
 * servers unstarted by its own filter (`aggregateServersForFile`).
 *
 * An explicit all-server check (`lens_diagnostics source=lsp`) passes these to
 * the LSP service as `excludeServerIds`, so it never starts a scanner the
 * write-time runner would not start. The session's resource degrade (the LSP
 * budget, subagent light mode) is deliberately not part of this answer: it is
 * not a configuration decision, and an explicit request still asks those
 * scanners.
 */
export function configDisabledAuxiliaryLspServerIds(
	getFlag: GetFlag,
): ReadonlySet<string> {
	return new Set(
		AUXILIARY_LSP_PROFILES.flatMap((p) =>
			p.enabledByDefault && !isEnabledByConfiguration(p, getFlag)
				? [p.serverId]
				: [],
		),
	);
}

/**
 * #4956 F2: the opt-in auxiliary ids the operator turned on. The aggregate
 * `clientScope: "all"` door never starts them (`aggregateServersForFile`), so
 * an explicit all-server check must name them as not run instead of letting its
 * "No auxiliary findings." line read as their clean answer. Empty while no
 * opt-in is enabled: a report for an operator who never asked is unchanged.
 */
export function enabledOptInAuxiliaryLspServerIds(
	getFlag: GetFlag,
): ReadonlySet<string> {
	return new Set(
		AUXILIARY_LSP_PROFILES.flatMap((p) =>
			!p.enabledByDefault && isEnabledByConfiguration(p, getFlag)
				? [p.serverId]
				: [],
		),
	);
}

/**
 * #4956 F2 / #5287: every auxiliary an all-server check leaves unstarted: the
 * ones the operator switched off and the opt-in ones they turned on. One
 * answer for `lsp_diagnostics` and the `lens_diagnostics` mode=full sweep, so
 * the two never name different sets.
 */
export function auxiliaryServersNotRun(getFlag: GetFlag): ReadonlySet<string> {
	return new Set([
		...configDisabledAuxiliaryLspServerIds(getFlag),
		...enabledOptInAuxiliaryLspServerIds(getFlag),
	]);
}

/**
 * The sentences that name the servers a check did not run, switched-off ones
 * first, then enabled opt-in ones (an opt-in is not "switched off": the
 * all-server door simply does not start it, #4956 F2). `switchedOffLabel`
 * lets a surface qualify its own noun ("Switched off, not run (auxiliary
 * LSP)"). Empty when nothing was left out.
 */
export function auxiliaryNotRunSentences(
	notRunServerIds: Iterable<string>,
	switchedOffLabel = "Switched off, not run",
): string[] {
	const ids = [...notRunServerIds];
	const switchedOff = ids.filter((id) => !isOptInAuxiliaryServerId(id));
	const optIn = ids.filter((id) => isOptInAuxiliaryServerId(id));
	return [
		...(switchedOff.length > 0
			? [`${switchedOffLabel}: ${switchedOff.join(", ")}.`]
			: []),
		...(optIn.length > 0
			? [`Opt-in, not run by this check: ${optIn.join(", ")}.`]
			: []),
	];
}

function isEnabledByConfiguration(
	profile: AuxiliaryLspProfile,
	getFlag: GetFlag,
): boolean {
	// #4929: an opt-in profile admits exactly one value, `true`, from its own
	// flag. Everything else (absent, a string, a number, a flag the registry
	// does not know) is off; the kill switch is not consulted for it.
	if (!profile.enabledByDefault) {
		return (
			profile.optInFlag !== undefined && getFlag(profile.optInFlag) === true
		);
	}
	return !(profile.killSwitchFlag && getFlag(profile.killSwitchFlag) === true);
}

// #277 R7: `findAuxiliaryProfileForSource` is called once per diagnostic, and a
// file's diagnostics are typically dominated by a handful of distinct `source`
// strings (one per tool that fired). Memoizing by exact `source` turns an
// O(profiles) regex scan per diagnostic into one scan per distinct source seen
// — safe because `AUXILIARY_LSP_PROFILES` is a fixed module-level const, never
// mutated at runtime, so a source's matching profile never changes.
const profileForSourceCache = new Map<
	string,
	AuxiliaryLspProfile | undefined
>();

/** Find the profile whose server emitted a diagnostic with this `source`. */
export function findAuxiliaryProfileForSource(
	source: string | undefined,
): AuxiliaryLspProfile | undefined {
	if (!source) return undefined;
	const cached = profileForSourceCache.get(source);
	if (cached !== undefined || profileForSourceCache.has(source)) return cached;
	const found = AUXILIARY_LSP_PROFILES.find((p) => p.sourceMatch.test(source));
	profileForSourceCache.set(source, found);
	return found;
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
 * #4944: drop everything a switched-off server contributed to an answer: its
 * rows and its name in the answer's coverage gap. A warm-attached peer answers
 * every auxiliary (`clientScope: "with-auxiliary"`) whatever this process's
 * `excludeServerIds` says, so each receipt filters the peer's answer once and
 * reads every field from the copy. A local touch never asks an excluded server
 * and never lists it as unconfirmed (`LSPService.touchFile`'s gap loop); the
 * filtered answer reads the same. A row with no `serverId` is mapped through
 * its `source`; a row neither names stays, because nothing says it came from an
 * excluded server.
 */
export function dropExcludedServers<
	A extends {
		readonly diagnostics: readonly LSPDiagnostic[];
		readonly unconfirmedServerIds?: readonly string[];
	},
>(answer: A, excludeServerIds: ReadonlySet<string> | undefined): A {
	const kept = (serverId: string | undefined): boolean =>
		!excludeServerIds?.has(serverId ?? "");
	return {
		...answer,
		diagnostics: answer.diagnostics.filter((d) =>
			kept(d.serverId ?? findAuxiliaryProfileForSource(d.source)?.serverId),
		),
		...(answer.unconfirmedServerIds !== undefined && {
			unconfirmedServerIds: answer.unconfirmedServerIds.filter(kept),
		}),
	};
}

/**
 * Filter a diagnostic list down to the ones NOT suppressed by their
 * auxiliary profile's native inline-comment syntax (#586). This is the
 * shared helper `tools/lsp-diagnostics.ts` and `clients/lsp/index.ts`'s
 * `runWorkspaceDiagnostics` use so a `// nosemgrep` (or any future profile's
 * equivalent) suppresses a finding identically whether it's seen via the
 * per-edit dispatch runner or a standalone diagnostics query — previously
 * only the former honored it (#586).
 *
 * #692: `opts.fileRole` additionally drops a diagnostic whose auxiliary
 * profile declares `skipTestFiles` (e.g. ast-grep, #687) when the file is a
 * test file — the per-edit dispatch runner (`clients/dispatch/runners/lsp.ts`)
 * has applied this gate since #687/#688 via its own inline check; the
 * `runWorkspaceDiagnostics` workspace sweep (`clients/lsp/index.ts`) called
 * this function WITHOUT ever passing a fileRole, so ast-grep findings on test
 * files that are suppressed per-edit reappeared wholesale in every
 * `mode=full` sweep. Omitting `opts` (or `opts.fileRole`) keeps every existing
 * 2-arg call site's behavior byte-for-byte unchanged.
 *
 * #3041: `opts.filePath` + `opts.scanRoot` additionally apply each rule's own
 * `ignores` path carve-out (#965) — the THIRD member of the same defect class
 * as #586 and #692 above. `ast-grep scan` applies `ignores` during its own
 * project walk, but `ast-grep lsp` publishes per-document diagnostics WITHOUT
 * applying them (measured against ast-grep 0.45.3), so a rule the NAPI runner
 * correctly skips on `scripts/**` came back over LSP on every `source=lsp`
 * query and every `mode=full` sweep. Both routes reach this function, so the
 * carve-out belongs here rather than in either route's own output merge.
 */
export function applyAuxiliarySuppressions(
	diagnostics: readonly LSPDiagnostic[],
	content: string,
	opts?: { fileRole?: FileRole; filePath?: string; scanRoot?: string },
): LSPDiagnostic[] {
	// One catalog read per call, not per diagnostic. Both rule loaders behind it
	// are cached (~0.09 ms per call on pi-lens's own catalog), so a per-file call
	// from a sweep costs the same order as the NAPI runner's own per-file load.
	const { filePath, scanRoot } = opts ?? {};
	const ruleIgnores =
		filePath && scanRoot ? loadRuleIgnorePatterns(scanRoot) : undefined;
	return diagnostics.filter((d) => {
		if (isAuxiliaryDiagnosticSuppressed(d, content)) return false;
		if (opts?.fileRole === "test") {
			const profile = findAuxiliaryProfileForSource(d.source);
			if (profile?.skipTestFiles) return false;
		}
		// Keyed by the diagnostic's own rule id — ast-grep's LSP reports the bare
		// catalog id as `code`. Gated on the producing tool as well: the map is
		// built from the AST-GREP catalog, so without the gate any auxiliary whose
		// own rule id happened to collide with a catalog id (several are generic —
		// `no-raw-types`, `no-string-concat-in-loop`) would be silently dropped on
		// a path an unrelated rule carved out. Losing a finding silently is the
		// harm this whole change exists to stop, so the collision is gated, not
		// accepted (#3041 r2 F4).
		if (
			ruleIgnores !== undefined &&
			findAuxiliaryProfileForSource(d.source)?.tool === "ast-grep" &&
			isRuleIgnoredForPath(
				filePath as string,
				scanRoot as string,
				ruleIgnores.get(String(d.code)),
			)
		) {
			return false;
		}
		return true;
	});
}

/**
 * #692: shared aux re-tag implementation — extracted from the per-edit
 * dispatch runner (`clients/dispatch/runners/lsp.ts`) so a scan/sweep path
 * that reconciles LSP diagnostics into widget state (`lens_diagnostics
 * mode=full`, `lsp_diagnostics`) gives its auxiliary-sourced findings
 * (ast-grep, opengrep, zizmor, typos) the SAME tool re-tag, semantic policy,
 * and defect-class classification the per-edit path always has — previously
 * only the per-edit runner ran this loop, so a scan-reconciled aux finding
 * kept `tool: "lsp"` and lost its curated-repo-rules `blockingAllowed`
 * context entirely (#692).
 *
 * `diagnostics` and `rawLspDiags` must be the SAME length and index-aligned —
 * `convertLspDiagnostics` maps its input 1:1, so this holds for every caller
 * that passes it the same array it just converted. Mutates and returns the
 * SURVIVING subset of `diagnostics` (native-inline-suppressed and
 * `skipTestFiles`-dropped entries removed), mirroring the per-edit runner's
 * prior inline behavior exactly.
 */
export function retagAuxiliaryDiagnostics(
	diagnostics: Diagnostic[],
	rawLspDiags: readonly LSPDiagnostic[],
	content: string,
	ctx: { cwd: string; fileRole: FileRole },
): Diagnostic[] {
	const blockingAllowedByProfile = new Map<AuxiliaryLspProfile, boolean>();
	const suppressedIndices = new Set<number>();
	for (let i = 0; i < diagnostics.length; i++) {
		const profile = findAuxiliaryProfileForSource(rawLspDiags[i]?.source);
		if (!profile) continue;
		if (profile.skipTestFiles && ctx.fileRole === "test") {
			suppressedIndices.add(i);
			continue;
		}
		if (isAuxiliaryDiagnosticSuppressed(rawLspDiags[i], content)) {
			suppressedIndices.add(i);
			continue;
		}
		let blockingAllowed = blockingAllowedByProfile.get(profile);
		if (blockingAllowed === undefined) {
			blockingAllowed = profile.allowBlocking?.(ctx.cwd) ?? false;
			blockingAllowedByProfile.set(profile, blockingAllowed);
		}
		const d = diagnostics[i];
		d.tool = profile.tool;
		d.semantic = profile.semantic(rawLspDiags[i], { blockingAllowed });
		if (d.semantic !== "blocking" && d.severity === "error") {
			d.severity = "warning";
		}
		const defectClass = profile.defectClass?.(rawLspDiags[i]);
		if (defectClass) d.defectClass = defectClass;
	}
	return suppressedIndices.size
		? diagnostics.filter((_, i) => !suppressedIndices.has(i))
		: diagnostics;
}
