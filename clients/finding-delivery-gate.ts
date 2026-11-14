/**
 * Single documentation home for the finding-delivery gate stack (#1634).
 *
 * Every store that renders findings to the AGENT — the turn-end blocker/
 * advisory tiers, `lens_diagnostics` mode=full/all/delta, the widget/footer
 * tally, agent nudges, and the persisted project-diagnostics snapshot —
 * invented its own freshness and retirement rules across
 * #1461/#1561/#1622/#1631, so the stores drifted from each other and each new
 * store re-created the class. #1622/#1625/#1627/#1633 converged on two gates;
 * this module names them ONE time so every other file points here instead of
 * re-explaining the contract. `mode=delta` — the tool's DEFAULT mode — was
 * the review round's live catch: it re-served the actionable/quality-warnings
 * caches verbatim, unfixed by the earlier per-store passes because it sits
 * one layer up from any single scanner.
 *
 * ── Freshness (mtime vs scannedAt, onMissing policy) ──────────────────────
 * `gateFindingsByPathFreshness` (advisory-provenance.ts) partitions a cached
 * store's findings by what the cited path looks like NOW versus the scan
 * timestamp (`scannedAt`) the store was captured at:
 *   - missing  → `onMissing: "drop"` (default) removes the finding outright —
 *     right when the finding IS the file's content (a secret in a deleted
 *     file cannot be rotated). `onMissing: "demote"` keeps it — right when the
 *     cited path is only EVIDENCE for a finding pinned elsewhere (a
 *     govulncheck CVE is pinned by go.mod, not by the traced call site).
 *   - stale (mtime > scannedAt + MTIME_DRIFT_TOLERANCE_MS,
 *     `blocker-freshness.ts`) → DEMOTE, never drop. The finding survives,
 *     the now-untrustworthy line number does not.
 *   - live  → deliver unchanged, full authority.
 *   - unknown (unparseable/absent `scannedAt`, unreadable path) → fail OPEN,
 *     deliver unchanged. A missed demotion is noise; a wrong drop can hide a
 *     live credential or CVE.
 * The turn-end secrets (gitleaks/trivy-secrets) and govulncheck advisory both
 * route through this gate in `clients/runtime-turn.ts`, in ONE shared call
 * (#3264) whose arms the secrets LANE (`clients/turn-end/lanes/secrets.ts`,
 * #1892) renders. A lane declares its sources and never gates itself: the
 * pass, its stat budget and its bounded records are per DELIVERY, not per
 * lane.
 *
 * The SAME freshness family, one level up, covers cross-file drift: a cached
 * inline blocker is a verdict about its file *and everything that file
 * imports* — `clients/blocker-freshness.ts` (`sweepInlineBlockerFreshness`,
 * the widget-store counterpart `reconcileStaleWidgetDependencyBlockers`
 * paired with `reconcileStaleWidgetFiles`) stats the file and its forward
 * imports against the verdict's `recordedAtMs` baseline (#1631/#1633). A
 * drifted entry is demoted with the SAME `[stale — re-run to confirm]`
 * marker (`STALE_LINE_MARKER`, `clients/stale-marker.ts` — its own leaf
 * module so `widget-state.ts` can use it without a circular import back
 * through the turn orchestrator, #1631 review V2) and `isBlocking`
 * answers false for it — the one predicate both the footer tally and
 * `mode=all`'s blocking count consult, which is what keeps `mode=all` from
 * contradicting a same-minute `mode=full` sweep on the same paths (#1631
 * criterion 3 / #1634 criterion 4).
 *
 * Two INDEPENDENT gates share this `stale` field, distinguished by
 * `WidgetDiagnostic.staleReason`: `"dependency-drift"` (#1631, above) and
 * `"past-eof"` (#1641 — a cited line beyond the file's current on-disk length,
 * a stale in-memory LSP document diverged from disk). Each gate only HEALS
 * demotions it made itself (`staleReason` defaults to `"past-eof"` for
 * backward compatibility with pre-#1641 records) — composed, not merged into
 * one undifferentiated flag, so a fix for one hazard can never silently clear
 * the other's verdict.
 *
 * ── Dispositions (strict-only for blocking) ───────────────────────────────
 * `applyDispositions` (diagnostic-dispositions.ts) filters false-positive/
 * suppress/defer/flagged judgments the agent or user already recorded for a
 * finding. Anchoring is STRICT (line-content-hashed) only for false-positive
 * — a judgment about one exact piece of code that must NOT survive a rewrite
 * of that line — and WEAK (no line hash) for defer/flagged/suppress, which
 * are intent-level judgments that must survive incidental nearby edits.
 * `formatFullMode` (tools/lens-diagnostics.ts) applies this on every
 * mode=full pass and states how many findings it dropped. Every scan writer
 * hands widget-state the POST-policy set: the per-edit dispatch path, and both
 * mode=full writes (#4459 review F2: its first write used to hand over the raw
 * sweep, so a re-reported marked finding replaced its tagged row under #3158
 * retention rule 2 and the mark's count vanished on the next mode=full). A
 * mark made later is reconciled into the store at mark time
 * (`reconcileWidgetDisposition` tags the row rather than deleting it), and
 * the tagged row survives later scans that no longer report the finding.
 * `mode=all` re-applies the cached dispositions (`applyCachedDispositions`)
 * without a scan, so it stays cache-only and instant. It counts both, the
 * tagged rows (the footer's `suppressed: N`) and what its own filter dropped,
 * and states the count, so a file whose findings were marked after a
 * mode=full reads "No issues" only with that count beside it (#1634
 * criterion 4). A mark made while the store held no row for the finding
 * leaves no tagged row: mode=full states that drop, and mode=all, which lists
 * the same rows, states none.
 *
 * ── Demotion rendering (#1419) ─────────────────────────────────────────────
 * A demoted finding is never silently dropped and never re-asserted at full
 * authority: it renders with `STALE_LINE_MARKER` (or the widget's `[stale]`
 * tag) in place of the coordinate the drift invalidated. This is the one
 * rendering convention every gated surface reuses — a store must not invent
 * its own "stale" wording.
 *
 * #1944 completes the rule: demotion must change the BODY, not only the
 * channel and the coordinate. A demoted body carries no STOP banner and no
 * "must be fixed" imperative, and a cited line the file no longer has renders
 * as `L<n> (line no longer exists)`. `clients/demoted-finding-render.ts`
 * (`degradeDemotedFindingBody`) is the one implementation for surfaces that
 * deliver a RENDERED BODY — the turn-end advisory tier. Per-row surfaces
 * (`clients/widget-state.ts`, `tools/lens-diagnostics.ts`) have no body to
 * degrade; they satisfy the same rule by dropping the authority marker
 * alongside the coordinate.
 *
 * ── Retirement (#1944, #1950, #2275, #4990) ────────────────────────────────
 * Demote-not-drop assumes the agent CAN re-run to confirm. Retirement is what
 * happens when re-serving a demotion forever stops being honest. Every kind
 * of retirement records itself in the degradation ledger under
 * `demoted-finding-retired`, whose subject keeps the store and the file
 * (`inline-blocker:` / `widget-blocker:`), so an empty section can only mean
 * "nothing to say". There are four, and they differ in WHY and in HOW MUCH
 * they remove:
 *
 * 1. Past-EOF, unrecoverable (#1944). The file shrank past the cited lines,
 *    so no re-run can ever speak to them. Delivered ONCE, degraded, then the
 *    record is DROPPED (`RuntimeCoordinator.retireDemotedPastEofBlocker`).
 *
 * 2. Dependency-drift, inline-blocker channel (#1950). The coordinates are
 *    still in bounds and a re-run COULD confirm them, so this is a delivery
 *    cap, not a verdict: after `DEPENDENCY_DRIFT_MAX_DELIVERIES` turn-end
 *    deliveries with no re-run the record is dropped from
 *    `_pendingInlineBlockers`, and the LAST delivery carries a note saying it
 *    will not be shown again and can still be confirmed
 *    (`formatDeliveryCapNote`). Counting is deferred until the turn's content
 *    is known not to be suppressed, so the count is deliveries the agent
 *    actually received (#1950 fix round F1).
 *
 * 3. Self-drift, inline-blocker channel (#4990). The record's own file
 *    changed under it and a re-run COULD still confirm, so this is case 2's
 *    cap on the other drift axis: `SELF_DRIFT_MAX_DELIVERIES` deliveries,
 *    the same last-delivery note, the same ledger kind (reason names the
 *    axis). The count is per demotion EPISODE: this axis re-arms when the
 *    recorded bytes come back, and a heal drops the count with the demotion.
 *
 * 4. Dependency-drift, widget footer (#2275). The same cap number over the
 *    widget store, which unlike the inline-blocker map backs MORE THAN ONE
 *    surface — `lens_diagnostics mode=all` and `lens_diagnostic_mark` read
 *    the same `allDiagnostics` list the footer draws from. So this retirement
 *    HIDES rather than drops: the entry keeps its demotion and its place in
 *    the error tally, gains `WidgetDiagnostic.footerRetired`, and only the
 *    footer stops rendering it; mode=all carries the "capped, no longer shown
 *    in the footer, re-run can still confirm" note in place of the inline
 *    channel's last-delivery note. Its count is RENDERS, not turn ends — the
 *    footer serves one record per pass, so `renderWidget` marks what it drew
 *    and the turn-end step drains those marks. Dropping the record instead
 *    would have made an unconfirmed LSP error read as CLEAN on mode=all.
 *
 * The rule the four share: a retirement may remove a finding from the
 * surface that has re-served it, never from every surface at once, unless no
 * re-run could ever confirm it (case 1).
 *
 * ── Explicit lag labels (the non-gated escape hatch) ──────────────────────
 * A store that cannot afford the freshness/disposition stack — because it
 * has no cited per-file path to stat (a package-pinned finding like a trivy
 * CRITICAL CVE or a license-risk row), or because re-computing dispositions
 * would cost the "instant" cache-only render mode=all/the footer promise —
 * MUST say so explicitly, with the finding's age, rather than presenting as
 * if it were current. `formatCacheAgeLabel` below is the one implementation;
 * every labeled surface in `DELIVERY_SURFACES` calls it instead of hand-
 * rolling an age string. This is the "(b)" arm of #1634's contract: every
 * agent-facing surface is EITHER gated OR explicitly labeled — never neither.
 *
 * ── Per-lane traces ────────────────────────────────────────────────────────
 * Each gate leaves one bounded record per delivery when it changes what the
 * agent sees, never one per finding:
 *   - `finding_dead_path_drop` and `finding_stale_line_demote` (latency phases,
 *     `clients/advisory-provenance.ts`): a freshness gate dropped a finding
 *     for a missing path or demoted one for drift. `quiet: true` judges
 *     without writing them, for a caller that only peeks at an answer
 *     another surface delivers. Pinned by
 *     `tests/clients/advisory-provenance-finding-paths.test.ts` and
 *     `tests/clients/advisory-provenance-finding-freshness.test.ts`.
 *   - `lsp_probe_disposition_filter` (latency phase, `tools/lsp-diagnostics.ts`
 *     `applyProbeFindingPolicy`): one per file whose stored dispositions or
 *     rule policy dropped a finding, on the `lens_diagnostics source=lsp` probe
 *     and on both `lsp_navigation workspaceDiagnostics` arms. A throwing
 *     filter writes the `lsp-probe-finding-policy` degradation instead and
 *     keeps every finding. Pinned by
 *     `tests/tools/lens-diagnostics-lsp-dispositions.test.ts`,
 *     `tests/tools/lens-diagnostics-lsp-policy-fail-open.test.ts` and
 *     `tests/tools/lsp-navigation.test.ts`.
 *   - `late_auxiliary_findings` (latency phase, `clients/runtime-turn.ts`):
 *     the collect-later probe's delivered and dropped counts, one per turn.
 *     Pinned by `tests/clients/lsp/late-auxiliary-findings.test.ts`.
 *   - `demoted-finding-retired` (degradation ledger): every retirement above.
 *     Pinned by `tests/clients/demoted-blocker-render-retirement.test.ts` and
 *     `tests/clients/widget-dependency-drift-delivery-cap.test.ts`.
 *   - What a disposition dropped is also told to the agent, never only
 *     logged: "suppressed by disposition: N finding(s)". The tool results
 *     that filter at delivery word it through `dispositionSuppressedLine`
 *     below: the `lsp_diagnostics` probe, `lsp_navigation`,
 *     `lens_diagnostics` mode=full and mode=all, and `pilens_project_scan`.
 *     The turn-end tiers (`dispositionSuppressedTotal`), the cascade runs
 *     (`clients/cascade-format.ts`, `clients/dispatch/integration.ts`) and the
 *     actionable-warnings advisory keep their own inline forms;
 *     `clients/git-guard.ts` parses the runtime-turn one. Pinned by
 *     `tests/index-3246-turn-end-delivery.test.ts`,
 *     `tests/tools/lsp-navigation.test.ts`,
 *     `tests/tools/lens-diagnostics-mode-all-full-agreement.test.ts` and
 *     `tests/mcp/server.smoke.test.ts`.
 */

const MS_PER_MINUTE = 60_000;

/** Mark retained findings whose replacement result could not be reconciled. */
export function markUnreconciledFindings<T extends { stale?: boolean }>(
	findings: readonly T[],
): T[] {
	return findings.map((finding) => ({ ...finding, stale: true }));
}

/**
 * Render a short, honest age suffix for a store that cannot be freshness-
 * gated per-path (see module doc). `undefined`/unparseable `scannedAt`
 * degrades to a neutral "scan age unknown" label — fail open on WORDING the
 * same way the freshness gate fails open on VERDICT: an unlabeled finding is
 * worse than a vague one, but never fabricate a number from a bad timestamp.
 */
export function formatCacheAgeLabel(
	scannedAt: string | number | undefined,
	nowMs: number = Date.now(),
): string {
	if (scannedAt === undefined || scannedAt === null || scannedAt === "") {
		return "scan age unknown";
	}
	const scannedAtMs =
		typeof scannedAt === "number" ? scannedAt : Date.parse(scannedAt);
	if (!Number.isFinite(scannedAtMs)) return "scan age unknown";
	const ageMs = Math.max(0, nowMs - scannedAtMs);
	const ageMinutes = Math.round(ageMs / MS_PER_MINUTE);
	if (ageMinutes < 1) return "scanned <1m ago";
	if (ageMinutes < 60) return `scanned ${ageMinutes}m ago`;
	// Floor the hour, keep the remainder minutes explicit — a naive
	// `Math.round(ageMinutes / 60)` reported "1h" at 89 minutes (F5), rounding
	// a finding's age UP is the wrong direction to err for a staleness label.
	const ageHours = Math.floor(ageMinutes / 60);
	const remMinutes = ageMinutes % 60;
	return remMinutes === 0
		? `scanned ${ageHours}h ago`
		: `scanned ${ageHours}h ${remMinutes}m ago`;
}

/**
 * #3088/#1634: the rendering of a finding-policy drop shared by the tool
 * results that filter findings at delivery (the `lsp_diagnostics` probe's
 * single-file, batch and directory renders, `lsp_navigation
 * workspaceDiagnostics`, `lens_diagnostics` mode=full and mode=all,
 * `pilens_project_scan`), so none of them words the same fact differently.
 * The turn-end and cascade forms are listed in the module doc above. Returns
 * `undefined` when nothing was dropped: the #1616 rule asks for a count when
 * there IS one, not a "0 suppressed" line on every clean result.
 */
export function dispositionSuppressedLine(
	suppressed: number,
	/** Per-lane attribution, e.g. "analyzer lanes: knip 2" (mode=full, #1625). */
	breakdown?: string,
): string | undefined {
	if (suppressed <= 0) return undefined;
	const lanes = breakdown ? ` (${breakdown})` : "";
	return (
		`suppressed by disposition: ${suppressed} finding(s)${lanes} dropped from this ` +
		"result because they're marked false-positive/won't-fix, disabled by " +
		"`.pi-lens.json` rule policy, or suppressed by an inline `pi-lens-ignore` " +
		"comment. Not a clean verdict for those locations — they were found, " +
		"then intentionally hidden."
	);
}

interface DeliverySurfaceBase {
	/** Human-readable one-line description of what the surface renders. */
	description: string;
	/** Source file the surface's render/gate call lives in. */
	file: string;
	/**
	 * "complete" (default, omit the field) means this round's gate/label fully
	 * covers the surface's known staleness risk. "partial" is an HONEST
	 * admission that this round registered and named the surface without
	 * fully closing a known residual risk — `partialReason` must say what's
	 * left (#1634 review round F3: "gate what's cheap ... say so per-surface,
	 * honest partial beats claimed total").
	 */
	status?: "complete" | "partial";
	/** Required when `status: "partial"`. What residual risk is NOT covered yet. */
	partialReason?: string;
	/**
	 * Literal, comment/string-STRIPPED source substrings that must each occur
	 * at least `evidenceMin` times in `file`. This is the ground-truth proof
	 * that the gate/label call is actually WIRED to this specific surface —
	 * not merely imported, not merely mentioned in a doc comment (#1634 review
	 * round F1: `expect(src).toContain(gateName)` matched the IMPORT line and
	 * a comment; stubbing the three real gate calls to identity and deleting
	 * the age interpolations left the old check green). Evidence strings are
	 * chosen to be SURFACE-specific (e.g. a literal `store: "gitleaks"` gate
	 * argument, or a literal fragment of the rendered header that only exists
	 * once the age is interpolated in) so a stub of a DIFFERENT surface's call
	 * to the same shared gate function cannot satisfy this entry. Empty only
	 * for `ageSource: "live"` labeled surfaces, which call no such helper —
	 * their proof is the `@delivery-surface:` seam tag the coverage scan
	 * requires instead (see `tests/clients/finding-delivery-gate.test.ts`).
	 */
	evidence: string[];
	/**
	 * Minimum occurrences required for EACH string in `evidence`. Default 1.
	 *
	 * For a `clients/runtime-turn.ts` surface, this doubles as the per-
	 * occurrence CLAIM CAPACITY in the exclusive nearest-neighbor assignment
	 * (#1634 review round R1c): when a surface legitimately has more than one
	 * tagged seam sharing the same upstream evidence (e.g.
	 * `unresolved-inline-blocker`'s stale/live render branches both consuming
	 * one `sweepInlineBlockerFreshness` call), `evidenceMin` states how many
	 * seams are EXPECTED to share it, so the coverage test's default
	 * capacity-1 exclusivity doesn't wrongly fail the second legitimate seam.
	 * Set it to the surface's real tagged-seam count whenever seams share one
	 * evidence occurrence — see `tests/clients/finding-delivery-gate.test.ts`.
	 */
	evidenceMin?: number;
}

interface GatedDeliverySurface extends DeliverySurfaceBase {
	mode: "gated";
	/** Named gate(s) this surface routes through before rendering. */
	gates: string[];
}

interface LabeledDeliverySurface extends DeliverySurfaceBase {
	mode: "labeled";
	/** Why this surface cannot take the full gate stack. */
	reason: string;
	/** What supplies the age shown to the agent (a scannedAt field, "live", or "n/a"). */
	ageSource: string;
}

export type DeliverySurfaceEntry =
	| GatedDeliverySurface
	| LabeledDeliverySurface;

/** Project-wide scanner output belongs to the primary session's turn_end. */
export function admitsProjectWideFindings(
	sessionRole: "primary" | "secondary",
): boolean {
	return sessionRole === "primary";
}

/**
 * The enumeration (#1634 criterion 1): every surface that renders findings to
 * the agent. `tests/clients/finding-delivery-gate.test.ts` derives it from the
 * source three ways, so a new surface fails a test instead of waiting for a
 * reader of this list:
 *
 *   - Tagged render seams (#3165). Every production file under clients/,
 *     tools/ and mcp/, plus index.ts, is scanned (comments and strings
 *     blanked) for the seam shapes: a `blockerParts`/`advisoryParts`/
 *     `staleSecretParts` push, a `format*Mode` report function, and a
 *     `formatCascadeNeighborDiagnostics` call. Each one needs an
 *     `@delivery-surface: <id>` tag on the line above, naming an entry here
 *     whose `file` is the seam's own file.
 *   - Sink census. Every production file holding an agent-facing sink (a tool
 *     result text block, a user-role or hook context message, a tool_call
 *     block, a custom entry, a status or widget line) is either some entry's
 *     `file` or classified in the test with the surfaces it carries or why
 *     it carries none.
 *   - Tool census. Every `TOOL_REGISTRY` tool names the surfaces it renders
 *     or why it renders no findings.
 */
/**
 * Factory for a `gated` entry. #1634 review round (SonarCloud): 20+ entries
 * written as multi-line object literals put the SAME `mode`/`file` key
 * sequence on the same relative lines over and over — the TS/JS duplication
 * detector normalizes string literals to a placeholder token, so those
 * literally-different-content blocks still read as duplicate TOKEN STREAMS.
 * Collapsing each entry to one factory call removes the repeating shape
 * instead of the (irreducible) per-entry data.
 */
function gated(
	file: string,
	description: string,
	gates: string[],
	evidence: string[],
	extra: Partial<
		Pick<GatedDeliverySurface, "status" | "partialReason" | "evidenceMin">
	> = {},
): GatedDeliverySurface {
	return { mode: "gated", file, description, gates, evidence, ...extra };
}

/** Factory for a `labeled` entry — see {@link gated}'s doc for why this exists. */
function labeled(
	file: string,
	description: string,
	reason: string,
	ageSource: string,
	evidence: string[] = [],
	extra: Partial<
		Pick<LabeledDeliverySurface, "status" | "partialReason" | "evidenceMin">
	> = {},
): LabeledDeliverySurface {
	return {
		mode: "labeled",
		file,
		description,
		reason,
		ageSource,
		evidence,
		...extra,
	};
}

const RUNTIME_TURN_FILE = "clients/runtime-turn.ts";
const LENS_DIAGNOSTICS_FILE = "tools/lens-diagnostics.ts";

export const DELIVERY_SURFACES: Record<string, DeliverySurfaceEntry> = {
	// #1892 (lane extraction): both secrets tiers are rendered by the secrets
	// LANE (`clients/turn-end/lanes/secrets.ts`), so `clients/runtime-turn.ts`
	// no longer reads `.live`/`.stale` itself — the arm it can still be pinned
	// to is the whole gated store object it hands the lane. That is WEAKER than
	// the previous `gitleaksGate.live,` pin (it no longer says which partition
	// feeds which tier) and the loss is deliberate: the live/stale split is a
	// lane rule now, pinned behaviourally instead, by
	// `tests/clients/runtime-turn-finding-freshness.test.ts` ("keeps an
	// unmodified file's finding as a full-severity blocker" / "DEMOTES a
	// finding whose file was edited after the scan — kept, no line") and the
	// committed witness goldens under `tests/fixtures/witness/`. What the pin
	// still proves is what this registry exists for: the rows the tier renders
	// came out of a real `gateFindingsByPathFreshness` call and not out of a
	// hand-built object (the R2 binding chain in
	// `tests/clients/finding-delivery-gate.test.ts` walks
	// `gitleaksGate` → `scannerGates` → the call).
	"runtime-turn:secrets-gitleaks": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 secrets blocker, gitleaks cache.",
		["gateFindingsByPathFreshness"],
		["gitleaksGate,"],
	),
	"runtime-turn:secrets-trivy": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 secrets blocker, trivy secrets cache.",
		["gateFindingsByPathFreshness"],
		["trivySecretsGate,"],
	),
	"runtime-turn:govulncheck-advisory": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🛡️ Go CVE advisory (call-site line only).",
		["gateFindingsByPathFreshness"],
		["scannerGates.govulncheck"],
	),
	// Two tagged seams (the stale and live render branches below the same
	// `sweepInlineBlockerFreshness` call) legitimately share one evidence
	// occurrence — evidenceMin: 2 tells the exclusive-assignment check both
	// are expected claimants, not a rogue seam contesting the real one.
	"runtime-turn:unresolved-inline-blocker": gated(
		RUNTIME_TURN_FILE,
		"Turn-end re-surfaced unresolved inline blockers.",
		["sweepInlineBlockerFreshness"],
		// #1790: the call now passes `additionalEntries` (widget-store rows) as a
		// third argument, so the literal is the call's opening rather than the
		// whole single-line invocation.
		["sweepInlineBlockerFreshness(runtime, cwd, {"],
		{ evidenceMin: 2 },
	),
	// The same shared gate call and the same two stores as the live secrets
	// tier — one lane renders both tiers, so this surface has no gate call and
	// no arm read of its own; see the note above the live tier for what the pin
	// does and does not prove.
	"runtime-turn:stale-secrets-tier": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔑 demoted-secrets tier (drifted since scan).",
		["gateFindingsByPathFreshness"],
		["gitleaksGate,", "trivySecretsGate,"],
	),
	// The evidence below is the literal header FRAGMENT including the
	// interpolation — proves the label is actually rendered, not merely
	// computed and discarded (review round F1's "deleted the age
	// interpolations" attack).
	"runtime-turn:trivy-critical-blocker": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 CRITICAL dependency CVE blocker (trivy).",
		"Package-pinned finding with no cited file:line to stat — this gate has " +
			"nothing to check drift against. The session_start cache can be " +
			"arbitrarily old, so its age is stated instead. #4617: the advisory " +
			"provenance stamp does have a subject — the dependency declarations the " +
			"scan reported for the rows this report shows (`trivyEvidenceFiles`, " +
			"each result's target resolved against the scan root, falling back to " +
			"`existingDependencyManifests` only when no shown row cites one), so a " +
			"lockfile edit supersedes the message — nested ones included, not only the " +
			"manifests at the scan root — even though a package row cannot be stat'd. " +
			"Also routes through " +
			"`filterFindingsByDisposition` (#1625) first — a suppressed/false-" +
			"positive finding never reaches this render, so the age label and the " +
			"disposition filter compose rather than substitute for each other.",
		"TrivyResult.scannedAt",
		["CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}"],
	),
	"runtime-turn:trivy-cve-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🛡️ non-critical dependency CVE advisory (trivy).",
		"Same package-pinned shape and #1625 disposition composition as the " +
			"CRITICAL blocker above.",
		"TrivyResult.scannedAt",
		["Dependency CVEs (trivy, ${trivyAgeLabel}"],
	),
	"runtime-turn:trivy-license-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 📜 dependency license-risk advisory (trivy).",
		"Same package-pinned shape as the CRITICAL blocker above.",
		"TrivyResult.scannedAt",
		["Dependency license risk (trivy, ${trivyAgeLabel}"],
	),
	"runtime-turn:dead-code-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end dead-code delta advisory (knip/vulture/etc).",
		"The delta shown is computed from THIS turn's own analyze() call, " +
			"diffed against the previous cache — never a replay of a stale cache.",
		"live",
	),
	"runtime-turn:knip-blocker": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 Knip unresolved-imports/deps blocker.",
		"Same shape as the dead-code advisory: `await knipClient.analyze(cwd, " +
			"...)` runs fresh THIS turn, diffed against the previous cache and " +
			"filtered to files edited this turn — never a replay of a stale cache.",
		"live",
	),
	"runtime-turn:knip-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end ⚠️ Knip newly-unused-exports advisory.",
		"Same live-this-turn shape as the Knip blocker above.",
		"live",
	),
	"runtime-turn:actionable-warnings-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end actionable-warnings advisory (ast-grep etc).",
		"`peekActionableWarnings` reads `_actionableWarningsThisTurn` — recorded " +
			"fresh from this turn's own dispatch, never a cross-turn cache.",
		"live",
	),
	"runtime-turn:code-quality-warnings-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end code-quality-warnings advisory.",
		"`peekCodeQualityWarnings` reads `_codeQualityWarningsThisTurn` — the " +
			"same per-turn accumulator shape as actionable-warnings above.",
		"live",
	),
	"runtime-turn:disposition-suppressed-notice": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end running disposition-suppressed-count notice (#1616).",
		"A live running total accumulated from this turn's own gate/disposition " +
			"calls above (`dispositionSuppressedTotal`) — telemetry ABOUT the other " +
			"gated surfaces, not a cache of its own.",
		"live",
	),
	// #2001/#2002 collect-later: findings an auxiliary LSP published AFTER its
	// aux-grace window expired, probed from the client cache at the next
	// turn_end. Gated on the mark timestamp: a cited file deleted or edited
	// since the mark drops its findings (never delivered before, and the
	// drifting edit already re-touched the file — a fresh pending pair
	// supersedes this one), with both drop arms counted in the
	// `late_auxiliary_findings` latency record rather than silenced.
	//
	// #3102: freshness is only half the gate. The survivors also take the shared
	// `clients/dispatch/finding-policy.ts` stack (inline `pi-lens-ignore` →
	// stored dispositions → `.pi-lens.json` rule policy) the per-edit dispatcher,
	// `mode=full` and the `source=lsp` probe lane apply — without it a finding
	// the agent marked `false-positive` re-reported on every drain. Per #3088
	// round-2 F4, the evidence is the CALL TEXT of that filter, which exists
	// nowhere else in this file: a bare `applyFindingPolicy` would also be
	// satisfied by an import line or an unrelated caller.
	"runtime-turn:late-auxiliary-findings": gated(
		RUNTIME_TURN_FILE,
		"Turn-end late-auxiliary LSP findings (collect-later probe of aux " +
			"client caches whose grace window expired).",
		// #3248: the open-coded `applyFindingPolicy(...)` here and the identical
		// one the late-RUNNER lane needed are now one `applyPushedFindingPolicy`
		// call, so the gate and the evidence name that call. Same stack, same
		// identities — only the spelling moved.
		["gateFindingsByPathFreshness", "applyPushedFindingPolicy"],
		['"late-auxiliary-findings": {', "applyPushedFindingPolicy(gate.live, {"],
	),
	"runtime-turn:late-runner-findings": gated(
		RUNTIME_TURN_FILE,
		"Turn-end CLI runner findings collected after the post-write path.",
		// #3248: this lane was the last push surface with no disposition stage;
		// it routes through the same shared policy call as its late-auxiliary
		// twin. #3814: the freshness gate and that policy call now live in ONE
		// verdict, `judgeDeferredRunnerFindings` (clients/deferred-runner-blockers.ts),
		// which the commit gate calls too; this lane's proof is that it asks that
		// verdict. That the verdict itself runs both seams is pinned by behaviour
		// (`tests/index-3814-deferred-blocker-gate.test.ts`: a stale answer and a
		// marked finding each stop blocking, one mutation each).
		["judgeDeferredRunnerFindings"],
		["judgeDeferredRunnerFindings("],
		{ evidenceMin: 2 },
	),
	"runtime-turn:cascade-blocker": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🧪 cascade neighbor blocker.",
		"Cascade results settle synchronously this turn where possible " +
			"(`settleCascadeRuns`), but an unsettled compute can carry over to a " +
			"later turn (bounded by a carry cap) — a carried-over result renders " +
			"with an explicit `(carried N turns · scanned Xm ago)` label (#3167, " +
			"#3168 F3), so the agent can tell it from a fresh observation.",
		"live",
		["cascadeCarrySuffix("],
		{ evidenceMin: 1 },
	),
	// #4487: cascade neighbour errors a cascade showed in an EARLIER turn and
	// no later cascade or edit has shown gone. A cached claim, not a fresh
	// observation, so each entry passes the freshness gate against its own
	// read bound (`checkedAt`) before it renders (#4495 review F1, round 3):
	// a deleted neighbour is forgotten; one written after the check by
	// something pi never saw is named once as changed and not re-checked.
	// Survivors carry the `(scanned Xm ago)` age of that read. The evidence is
	// the two RENDERED lists, so the binding chain walks each back to the gate
	// call's own arms (a render of the ungated candidates reds, #4495 r2
	// verify census note).
	"runtime-turn:cascade-pending-errors": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 📐 list of cascade neighbour errors shown in an earlier turn and not re-checked since.",
		["gateFindingsByPathFreshness"],
		["unresolvedNeighbors", "changedShown"],
	),
	"runtime-turn:cascade-coverage-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end cascade-coverage-gap advisories (graph/binding/budget).",
		"Explains what the cascade check could NOT confirm this turn — not a " +
			"finding with a cited path, an absence-of-coverage disclosure computed " +
			"from this turn's own indeterminate-run list. An advisory computed from " +
			"a carried indeterminate run is labeled `(carried N turns · <age>)` " +
			"(#3167, #3168 F4 — dropped on mixed carried/fresh buckets). The age " +
			"half reads `scan age unknown` on this surface today: no indeterminate-" +
			"run producer stamps `observedAt` (only the resolved-found plumb does, " +
			"`clients/cascade-format.ts`), and one unstamped carried run collapses " +
			"the whole bucket's age rather than claiming the stamped runs' (#3168 " +
			"F13). The carry COUNT is always real.",
		"live",
		["withCarryLabel("],
		{ evidenceMin: 3 },
	),
	// #3102: the cold-neighbour cascade run is BUILT here, in the quiet-window
	// reconcile (`onResolvedFound` in index.ts), a turn earlier than the
	// `runtime-turn:cascade-blocker` render that finally carries it — so it is
	// its own delivery lane, and it was the one that rendered raw LSP findings
	// with no policy filter at all. The evidence is the CALL TEXT of the shared
	// filter (#3088 round-2 F4): a bare `applyFindingPolicy` would also be
	// satisfied by the import line.
	"cascade-format:resolved-found-run": gated(
		"clients/cascade-format.ts",
		"Cold-neighbour ERROR diagnostics formatted into the turn-end cascade " +
			"run by `buildResolvedFoundCascadeRun` (quiet-window reconcile of a " +
			"cascade touch that skipped its in-lane wait).",
		["applyFindingPolicy"],
		["applyFindingPolicy(retained, {"],
	),
	// #3157: the IN-LANE cascade — a different delivery lane from the
	// quiet-window run above, and the one #3102's sweep cleared WRONGLY. Its four
	// display sites (passive cold snapshot, fresh touch, touch-error fallback,
	// degraded fallback) assemble `CascadeNeighborResult.diagnostics` and reach
	// the agent through `formatCascadeNeighborDiagnostics` without ever entering
	// the dispatcher's `applyOutputFilters` pipeline: the sweep's file-level
	// verdict ("the per-edit dispatch path, which already filters in
	// dispatcher.ts") was true only of the per-edit RUNNER output in
	// `runners/lsp.ts`, which is a different call site in a different file.
	//
	// Evidence is the CALL TEXT (#3088 round-2 F4), counted: `cascadeDisplay(` is
	// the one seam all four sites route through, so `evidenceMin: 4` is the count
	// of display sites in the file and dropping ANY of them back to a raw
	// `convertLspDiagnostics` reds this suite. Identity-stubbing the callee
	// instead is caught behaviourally — it reds twelve cases in
	// `tests/clients/inlane-cascade-finding-policy.test.ts`, which is a stronger
	// signal than the R2 proximity heuristic. Residual, stated: a FIFTH display
	// site that open-codes the conversion keeps the count at 4 and is caught by
	// review, not by this row.
	"dispatch-integration:in-lane-cascade": gated(
		"clients/dispatch/integration.ts",
		"In-lane per-edit cascade neighbour ERROR diagnostics, rendered into the " +
			"turn-end cascade block by `computeCascadeForFile`.",
		["applyCascadeDisplayPolicy"],
		["cascadeDisplay("],
		{ evidenceMin: 4 },
	),
	"runtime-turn:call-graph-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 📊 call-graph impact advisory.",
		"`runtime.callGraph` is a session-lifetime in-memory structure; this " +
			"round does not verify or gate ITS OWN freshness policy (how/when it " +
			"incorporates edits made earlier in the session).",
		"live",
		[],
		{
			status: "partial",
			partialReason:
				"call-graph freshness/invalidation policy is out of this PR's scope — " +
				"tracked as a follow-up, not silently assumed fresh.",
		},
	),
	// #3088 round 2 F4: this row used to name `applyDispositions`/`applyRulePolicy`
	// with whole-file evidence literals. Once #3088 folded mode=full's stack onto
	// `applyFindingPolicy`, those two literals survived only in UNRELATED
	// mode=delta helpers in the same file, so deleting the entire policy stack out
	// of `applyInlineSuppressionsToSummaries` left this gate — and the ratchet —
	// green while five behaviour cases redded. The evidence is now the call text
	// of the merge's own filter, which exists nowhere else in the file.
	"lens-diagnostics:mode-full": gated(
		LENS_DIAGNOSTICS_FILE,
		"`lens_diagnostics mode=full` report.",
		["applyFindingPolicy", "reconcileProjectDiagnosticsSnapshot"],
		[
			"applyFindingPolicy(summary.diagnostics, {",
			"reconcileProjectDiagnosticsSnapshot(",
		],
	),
	"lens-diagnostics:mode-all": gated(
		LENS_DIAGNOSTICS_FILE,
		"`lens_diagnostics mode=all` report (widget-state read).",
		["reconcileStaleWidgetFiles", "reconcileStaleWidgetDependencyBlockers"],
		["reconcileStaleWidgetFiles(", "reconcileStaleWidgetDependencyBlockers("],
	),
	// #1634 review round F3: this was the most important gap — the tool's
	// DEFAULT mode rendered cached `file:line` findings with zero freshness
	// check. `applyDeltaFreshnessGate` (this file's sibling in
	// tools/lens-diagnostics.ts) now routes the actionable/quality-warnings
	// caches through the shared gate using each report's own `generatedAt`.
	// Round R3: mode=delta has a THIRD arm — the persisted project-diagnostics
	// delta report, rendered by `appendProjectDiagnosticsDeltaLines` — which
	// carried the identical unfixed shape. It now gates the same way, against
	// its own `generatedAt`.
	"lens-diagnostics:mode-delta": gated(
		LENS_DIAGNOSTICS_FILE,
		"`lens_diagnostics mode=delta` report (the tool's DEFAULT mode) — " +
			"re-serves the actionable-warnings/code-quality-warnings caches AND " +
			"the persisted project-diagnostics delta report.",
		["gateFindingsByPathFreshness"],
		[
			'"lens-diagnostics-delta": {',
			"applyDeltaFreshnessGate(",
			'"lens-diagnostics-delta-project": {',
		],
	),
	"widget-state:footer": gated(
		"clients/widget-state.ts",
		"TUI footer blocking/error/warning tally.",
		["reconcileStaleWidgetFiles", "isBlocking"],
		["isBlocking(diagnostic)", "reconcileStaleWidgetFiles()"],
	),
	"agent-nudge:context-message": labeled(
		"clients/agent-nudge.ts",
		"Post-edit file-touch nudge injected via `context`.",
		"Not a scanner finding store: no severity, no cited line, no cache — the " +
			"accumulator is drained and cleared at the moment of injection, so the " +
			"content IS the current state by construction.",
		"live",
	),
	"test-runner-delivery:custom-entry": labeled(
		"clients/test-runner-delivery.ts",
		"Post-agent test-runner failures in a non-context custom entry.",
		"The cache remains authoritative for pull diagnostics and the commit guard; this surface appends only after provenance validation and an idle recheck.",
		"live",
	),
	"project-diagnostics:persisted-snapshot": gated(
		LENS_DIAGNOSTICS_FILE,
		"Cross-session persisted project-diagnostics snapshot read.",
		["reconcileProjectDiagnosticsSnapshot"],
		["reconcileProjectDiagnosticsSnapshot("],
	),

	// ── #2028: the remaining agent-facing surfaces ──────────────────────────
	// Registered after #2028's root-cause review found the 🔴 STOP block
	// rendering stale/deleted-file blockers because its surface was never in
	// this registry — the exact "gated or labeled, never neither" gap this
	// module exists to close.
	"tool-call:stop-blocker": gated(
		"clients/pipeline.ts",
		"Per-edit 🔴 STOP blocker output appended to the write/edit tool result.",
		["dropFindingsForMissingPaths"],
		['store: "stop-blocker"'],
	),
	// The freshness stack itself (own-file mtime + reverse-dependency mtimes
	// via isEntryFresh, plus the #1095 content binding) lives inside
	// clients/lsp/workspace-diagnostics-cache.ts; the two evidence calls are
	// the tool's literal entry points into that gated path.
	"lsp-diagnostics:tool-output": gated(
		"tools/lsp-diagnostics.ts",
		"`lsp_diagnostics` batch/directory sweep results. Cache hits replay through " +
			"the shared workspace-diagnostics cache: createWorkspaceDiagnosticsCacheContext " +
			"is the tool's entry, and its lookup() applies the #671/#672 freshness stack " +
			"(own-file mtime + reverse-dependency mtimes via isEntryFresh) plus the " +
			"#1095 content binding. #3088: every route out of this tool — fresh, " +
			"cache replay, single file, directory — also passes applyProbeFindingPolicy, " +
			"the stored-disposition / .pi-lens.json rule-policy / inline pi-lens-ignore " +
			"stack the per-edit dispatch path and mode=full apply.",
		[
			"createWorkspaceDiagnosticsCacheContext",
			"isEntryFresh",
			"cacheCtx.lookup",
			"applyProbeFindingPolicy",
		],
		[
			"createWorkspaceDiagnosticsCacheContext(resolvedCwd)",
			"cacheCtx.lookup(file, scopeKey)",
			"applyProbeFindingPolicy(",
		],
	),
	"git-guard:commit-blocked": labeled(
		"clients/git-guard.ts",
		"Git-guard commit/push 🔴 COMMIT BLOCKED verdict (--lens-guard).",
		"Synchronous preflight rejection returned inline with the failed git " +
			"command. The blocker map it reads is refreshed at decision time: the " +
			"gate first judges settled collect-later runner answers through the " +
			"freshness gate and the finding policy (#3814), so a stale answer " +
			"cannot block.",
		"live",
	),
	"staged-delta:commit-blocked": labeled(
		"clients/staged-delta.ts",
		"Staged-delta 🔴 COMMIT BLOCKED verdict (--lens-guard) for blockers the " +
			"commit adds, and the degraded refusal when that read gave no answer (#5553).",
		"Synchronous preflight rejection returned inline with the failed git " +
			"command. The gate lists the staged set and runs the lanes over the " +
			"bytes at decision time, so nothing stored is replayed and a finding " +
			"cannot go stale between detection and delivery.",
		"live",
	),
	"shared-checkout-guard:worktree-mutation-blocked": labeled(
		"clients/shared-checkout-guard.ts",
		"Shared-checkout 🔴 WORKING-TREE CHANGE BLOCKED verdict (--lens-checkout-guard).",
		"Synchronous preflight rejection returned inline with the failed git " +
			"command. Both inputs are read at decision time — the instance registry " +
			"and `git status` — so no stored finding is replayed and nothing can go " +
			"stale between detection and delivery.",
		"live",
	),
	"read-guard-tool-lines:preflight-errors": labeled(
		"clients/read-guard-tool-lines.ts",
		"Read-guard hashline BLOCKED / RE-READ REQUIRED / PARTIAL APPLY / " +
			"ALREADY APPLIED preflight errors (#2402).",
		"Computed fresh per edit attempt and returned as that attempt's rejection — " +
			"no cached findings are replayed, so there is no staleness window. The " +
			"PARTIAL APPLY and ALREADY APPLIED variants describe the same attempt's " +
			"commit outcome; applied-edit recognition reads RuntimeCoordinator's " +
			"session-scoped record, which resets with the session.",
		"live",
	),
	"mutating-tool:adapter-preflight-errors": labeled(
		"clients/mutating-tool.ts",
		"Shape-adapter BLOCKED preflight errors for hashline edit inputs the " +
			"adapter recognized but could not resolve to a range (#2423).",
		"Computed fresh from the tool input on each attempt and returned as that " +
			"attempt's rejection, so there is no staleness window. The adapters " +
			"read only the call's own arguments; nothing cached is replayed.",
		"live",
	),
	"tool-call:duplicate-export-blocker": labeled(
		"clients/runtime-tool-call.ts",
		"Duplicate-export STOP rejection returned inline with the failed edit.",
		"Synchronous preflight rejection computed per edit attempt; no stored state.",
		"live",
	),
	"agent-behavior:thrashing-notice": labeled(
		"clients/agent-behavior-client.ts",
		"In-result thrashing/blind-write detection notice.",
		"Ephemeral notice computed at detection time inside the same tool result — " +
			"no persistence and no cache, so nothing can be stale.",
		"live",
	),

	// ── #1634 enumeration round: the rest of the agent-facing sinks ─────────
	// Found by the sink census in `tests/clients/finding-delivery-gate.test.ts`,
	// which derives every production file holding an agent-facing sink (a tool
	// result's text block, a context or hook message, a tool_call block, a
	// custom entry, a status/widget line) and fails on one that is neither a
	// surface `file` here nor classified there.
	"lsp-navigation:workspace-diagnostics-path": gated(
		"tools/lsp-navigation.ts",
		"`lsp_navigation workspaceDiagnostics` with a path: the server's answer " +
			"for that file, read after a touch that waits for diagnostics.",
		["applyProbeFindingPolicy"],
		// The path read and the tracked snapshot below are the two calls.
		["applyProbeFindingPolicy("],
		{ evidenceMin: 2 },
	),
	"lsp-navigation:tracked-snapshot": labeled(
		"tools/lsp-navigation.ts",
		"`lsp_navigation workspaceDiagnostics` with no path: each tracked file's " +
			"last client publish.",
		"A replay of what each language client last published, with no re-check " +
			"of the file, so every row states its age. The rows also pass the same " +
			"finding policy as the path read (`readFileContent` supplies the " +
			"current content), so the label and the disposition filter compose.",
		"LSP client publish ts",
		["lag: formatCacheAgeLabel(ts)", "readFileContent(trackedFile)"],
	),
	"runtime-context:persisted-findings": gated(
		"clients/runtime-context.ts",
		"Persisted turn-end and test-runner findings replayed into the next " +
			"context message, the MCP turn_end tool and the Stop hook.",
		["validateAdvisoryProvenance"],
		// peekTurnEndFindings, consumeTurnEndFindings, peekTestFindings.
		["validateAdvisoryProvenance(findings.data, cwd, runtime)"],
		{ evidenceMin: 3 },
	),
	"index:turn-summary": labeled(
		"index.ts",
		"One-line turn summary custom entry (`--lens-turn-summary`).",
		"Counts drained from this turn's own accumulator " +
			"(`runtime.turnSummary.consume`) at the quiet window; nothing is " +
			"replayed from a cache.",
		"live",
	),
	"lens-engine:project-scan": gated(
		"clients/lens-engine.ts",
		"`pilens_project_scan` (MCP): a fresh cheap project scan.",
		["applyPushedFindingPolicyByFile"],
		["applyPushedFindingPolicyByFile(scan.diagnostics, cwd)"],
	),
	"mcp-server:analyze": labeled(
		"mcp/server.ts",
		"`pilens_analyze` (MCP): one file's dispatch result.",
		"A dispatch run for this call, warm or in a fresh worker; the " +
			"dispatcher applies the finding policy before it returns.",
		"live",
	),
	"mcp-analyze-cli:post-edit-report": labeled(
		"mcp/analyze-cli.ts",
		"Claude Code PostToolUse hook report (`analyze-cli --hook`).",
		"Same per-call dispatch as `pilens_analyze`; its Stop-hook output is the " +
			"`runtime-context:persisted-findings` replay or a fresh turn-end pass.",
		"live",
	),
};

function assertPartialStatusHasReason(
	id: string,
	entry: DeliverySurfaceEntry,
): void {
	if (entry.status === "partial" && !entry.partialReason) {
		throw new Error(
			`finding-delivery-gate: surface "${id}" is status=partial but names no partialReason`,
		);
	}
}

function assertGatedShapeIsWellFormed(
	id: string,
	entry: GatedDeliverySurface,
): void {
	if (!Array.isArray(entry.gates) || entry.gates.length === 0) {
		throw new Error(
			`finding-delivery-gate: surface "${id}" is mode=gated but names no gate`,
		);
	}
	if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
		throw new Error(
			`finding-delivery-gate: surface "${id}" is mode=gated but names no evidence`,
		);
	}
}

function assertLabeledShapeIsWellFormed(
	id: string,
	entry: LabeledDeliverySurface,
): void {
	if (!entry.reason || !entry.ageSource) {
		throw new Error(
			`finding-delivery-gate: surface "${id}" is mode=labeled but is missing reason/ageSource`,
		);
	}
	// "live" surfaces call no age-formatting helper — nothing to grep for.
	// Every other ageSource claims a real cache, so it must be provable.
	if (entry.ageSource !== "live" && entry.evidence.length === 0) {
		throw new Error(
			`finding-delivery-gate: surface "${id}" claims ageSource "${entry.ageSource}" but names no evidence`,
		);
	}
}

/**
 * Enforce #1634's "no third state" rule: every registered surface is either
 * `gated` (names at least one gate) or `labeled` (names a reason and an age
 * source) — never a malformed/undeclared third shape. Throws naming the
 * offending surface id, so a bad registration fails loudly instead of
 * silently rendering ungated.
 */
export function assertNoDeliveryBypass(
	registry: Record<string, DeliverySurfaceEntry> = DELIVERY_SURFACES,
): void {
	for (const [id, entry] of Object.entries(registry)) {
		assertPartialStatusHasReason(id, entry);
		if (entry.mode === "gated") {
			assertGatedShapeIsWellFormed(id, entry);
			continue;
		}
		if (entry.mode === "labeled") {
			assertLabeledShapeIsWellFormed(id, entry);
			continue;
		}
		throw new Error(
			`finding-delivery-gate: surface "${id}" has unrecognized mode ${JSON.stringify((entry as { mode?: unknown }).mode)} — must be "gated" or "labeled"`,
		);
	}
}
