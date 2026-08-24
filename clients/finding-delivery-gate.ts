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
 * route through this gate in `clients/runtime-turn.ts`.
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
 * mode=full pass; the per-edit dispatch path applies the identical filter
 * before writing into widget-state, so mode=all and the footer inherit
 * disposition state for any file that has gone through a live edit this
 * session WITHOUT re-computing it (kept cache-only and instant, #1634
 * criterion 5's documented exception — see "Explicit lag labels" below).
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
 * ── Retirement (#1944) ────────────────────────────────────────────────────
 * Demote-not-drop assumes the agent CAN re-run to confirm. A past-EOF
 * demotion breaks that assumption: the file shrank past the cited lines, so
 * no re-run can ever speak to them, and the record re-served on every turn
 * end for the life of the session. Such a record is delivered ONCE, degraded,
 * then retired (`RuntimeCoordinator.retireDemotedPastEofBlocker`). The
 * suppression is recorded in the degradation ledger under
 * `demoted-finding-retired`, whose subject keeps the store and file, and the
 * delivered payload says so in its own words — so an empty advisory section
 * can only mean "nothing to say". Dependency-drift demotions keep in-bounds
 * coordinates the agent can act on and are NOT retired.
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
 */

const MS_PER_MINUTE = 60_000;

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

/** How a delivery surface satisfies #1634's "gated or labeled" contract. */
export type DeliveryMode = "gated" | "labeled";

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

export interface GatedDeliverySurface extends DeliverySurfaceBase {
	mode: "gated";
	/** Named gate(s) this surface routes through before rendering. */
	gates: string[];
}

export interface LabeledDeliverySurface extends DeliverySurfaceBase {
	mode: "labeled";
	/** Why this surface cannot take the full gate stack. */
	reason: string;
	/** What supplies the age shown to the agent (a scannedAt field, "live", or "n/a"). */
	ageSource: string;
}

export type DeliverySurfaceEntry =
	| GatedDeliverySurface
	| LabeledDeliverySurface;

/**
 * The enumeration (#1634 criterion 1): every surface that renders findings to
 * the agent. Two DIFFERENT seam shapes, each derived structurally rather than
 * hand-listed (#1634 review round F2):
 *
 *   - `clients/runtime-turn.ts`: every `blockerParts.push`/`advisoryParts.push`/
 *     `staleSecretParts.push` call site carries an `@delivery-surface: <id>`
 *     comment naming its entry here. `tests/clients/finding-delivery-gate.test.ts`
 *     scans the file for every such push call (comments/strings stripped, so a
 *     commented-out or string-embedded false match can't hide a REAL untagged
 *     seam) and fails if one has no tag, or a tag names an id not in this
 *     registry — a brand-new ungated `advisoryParts.push` cannot pass silently.
 *   - `tools/lens-diagnostics.ts`: each `mode=` report is its own function
 *     (`formatFullMode`/`formatAllMode`/`formatDeltaMode`), tagged the same way
 *     immediately above its `function` line.
 *   - `clients/widget-state.ts` (the footer) and `clients/agent-nudge.ts` are
 *     hand-registered below — one surface each, not a push-site pattern the
 *     scan can derive structurally, so a coverage test asserts these two
 *     files are not silently untouched by other tests in the same run.
 *
 * Single source of truth: adding a new render seam without adding/tagging an
 * entry here fails the coverage test, not a human re-reading a hand list.
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
	extra: Partial<Pick<LabeledDeliverySurface, "status" | "partialReason">> = {},
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
	"runtime-turn:secrets-gitleaks": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 secrets blocker, gitleaks cache.",
		["gateFindingsByPathFreshness"],
		['store: "gitleaks"'],
	),
	"runtime-turn:secrets-trivy": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 secrets blocker, trivy secrets cache.",
		["gateFindingsByPathFreshness"],
		['store: "trivy-secrets"'],
	),
	"runtime-turn:govulncheck-advisory": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🛡️ Go CVE advisory (call-site line only).",
		["gateFindingsByPathFreshness"],
		['store: "govulncheck"'],
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
	// Same two gate calls as the live secrets tier — this tier renders their
	// `.stale` arm, so it has no OWN gate call to point at.
	"runtime-turn:stale-secrets-tier": gated(
		RUNTIME_TURN_FILE,
		"Turn-end 🔑 demoted-secrets tier (drifted since scan).",
		["gateFindingsByPathFreshness"],
		['store: "gitleaks"', 'store: "trivy-secrets"'],
	),
	// The evidence below is the literal header FRAGMENT including the
	// interpolation — proves the label is actually rendered, not merely
	// computed and discarded (review round F1's "deleted the age
	// interpolations" attack).
	"runtime-turn:trivy-critical-blocker": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🔴 CRITICAL dependency CVE blocker (trivy).",
		"Package-pinned finding with no cited file:line to stat — freshness has " +
			"nothing to check drift against. The session_start cache can be " +
			"arbitrarily old, so its age is stated instead. Also routes through " +
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
	"runtime-turn:late-auxiliary-findings": gated(
		RUNTIME_TURN_FILE,
		"Turn-end late-auxiliary LSP findings (collect-later probe of aux " +
			"client caches whose grace window expired).",
		["gateFindingsByPathFreshness"],
		['store: "late-auxiliary-findings"'],
	),
	"runtime-turn:cascade-blocker": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end 🧪 cascade neighbor blocker.",
		"Cascade results settle synchronously this turn where possible " +
			"(`settleCascadeRuns`), but an unsettled compute can carry over to a " +
			"later turn (bounded by a carry cap) — this round does not freshness-" +
			"gate that carry-over window.",
		"live",
		[],
		{
			status: "partial",
			partialReason:
				"A carried-over cascade result (run.carriedTurns > 0) is rendered " +
				"without an age label. Follow-up: surface carriedTurns as an explicit " +
				"label when > 0, or route through formatCacheAgeLabel using the run's " +
				"own timestamp.",
		},
	),
	"runtime-turn:cascade-coverage-advisory": labeled(
		RUNTIME_TURN_FILE,
		"Turn-end cascade-coverage-gap advisories (graph/binding/budget).",
		"Explains what the cascade check could NOT confirm this turn — not a " +
			"finding with a cited path, an absence-of-coverage disclosure computed " +
			"from this turn's own indeterminate-run list.",
		"live",
		[],
		{
			status: "partial",
			partialReason:
				"Same cascade carry-over caveat as runtime-turn:cascade-blocker.",
		},
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
	"lens-diagnostics:mode-full": gated(
		LENS_DIAGNOSTICS_FILE,
		"`lens_diagnostics mode=full` report.",
		[
			"applyDispositions",
			"applyRulePolicy",
			"reconcileProjectDiagnosticsSnapshot",
		],
		[
			"applyDispositions(",
			"applyRulePolicy(",
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
			'store: "lens-diagnostics-delta"',
			"applyDeltaFreshnessGate(",
			'store: "lens-diagnostics-delta-project"',
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
			"#1095 content binding.",
		[
			"createWorkspaceDiagnosticsCacheContext",
			"isEntryFresh",
			"cacheCtx.lookup",
		],
		[
			"createWorkspaceDiagnosticsCacheContext(resolvedCwd)",
			"cacheCtx.lookup(file, scopeKey)",
		],
	),
	"git-guard:commit-blocked": labeled(
		"clients/git-guard.ts",
		"Git-guard commit/push 🔴 COMMIT BLOCKED verdict (--lens-guard).",
		"Synchronous preflight rejection returned inline with the failed git " +
			"command — no stored state is delivered, so nothing can go stale between " +
			"detection and delivery.",
		"live",
	),
	"read-guard-tool-lines:preflight-errors": labeled(
		"clients/read-guard-tool-lines.ts",
		"Read-guard hashline BLOCKED / RE-READ REQUIRED preflight errors.",
		"Computed fresh per edit attempt and returned as that attempt's rejection — " +
			"no cached findings are replayed, so there is no staleness window.",
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
