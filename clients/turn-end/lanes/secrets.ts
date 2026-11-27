/**
 * The turn-end SECRETS lane (#1892): the gitleaks and trivy-secrets stores,
 * their live 🔴 blocker tier and their demoted 🔑 tier.
 *
 * One lane, two stores, on purpose. The two secret scanners do not have a
 * section each: #131 Mode 3 collapses them (and ast-grep's hardcoded-secret
 * rules) BY LOCATION into one report with combined provenance, because a
 * credential flagged by two tools needs rotating once, not twice — and the
 * demoted tier merges the same two stores for the same reason. So "gitleaks"
 * is not a separable delivery lane: splitting it out would leave every
 * rendering rule (the dedupe, the ast-grep enrichment, the cap, both
 * preambles) in the composer, which is the opposite of the extraction. The
 * lane is the delivery contract; the stores are its sources.
 *
 * Registered surfaces (`clients/finding-delivery-gate.ts`):
 * `runtime-turn:secrets-gitleaks`, `runtime-turn:secrets-trivy`,
 * `runtime-turn:stale-secrets-tier`.
 *
 * History this file must not lose (each line below is a shipped defect):
 *
 * - #1617: these findings never passed through `applyDispositions`, so an
 *   agent-marked false-positive re-reported as a 🔴 STOP blocker every turn.
 * - #1625 review: the disposition filter runs AFTER the freshness gate, over
 *   BOTH arms — an fp-marked finding that later goes stale must not reappear
 *   in the demoted tier.
 * - #1622 review M1: a demoted secret keeps its rule id and source; only the
 *   line is withheld. An agent triages `aws-access-token` differently from a
 *   low-confidence `generic-api-key`, and cannot do that from a bare path.
 * - #1622 review M2: the demoted tier is its OWN tier, never `advisoryParts`
 *   ("no action required this turn" directly above copy telling the agent to
 *   re-scan).
 */

import { recordDegradationOnce } from "../../degradation-ledger.js";
import { bounded } from "../../deadline-utils.js";
import { filterFindingsByDisposition } from "../../dispatch/finding-policy.js";
import { toRunnerDisplayPath } from "../../dispatch/runner-context.js";
import {
	classifyAndFilterFindings,
	type GitleaksFinding,
	type GitleaksResult,
} from "../../gitleaks-client.js";
import { HOOK_WALL_BUDGET_MS } from "../../hook-budgets.js";
import { gitleaksFindingToProjectDiagnostic } from "../../project-diagnostics/runner-adapters/gitleaks.js";
import { trivySecretFindingToProjectDiagnostic } from "../../project-diagnostics/runner-adapters/trivy.js";
import {
	dedupeSecretFindings,
	fromAstGrepWarnings,
	fromGitleaks,
	fromTrivySecrets,
	isSecretWarning,
	secretLocationKey,
	type TrivySecretFinding,
} from "../../secret-findings.js";
import { STALE_LINE_MARKER } from "../../stale-marker.js";
import type { TrivyResult } from "../../trivy-client.js";
import type { FindingFreshnessSource } from "../../advisory-provenance.js";
import type {
	TurnEndLane,
	TurnEndLaneContext,
	TurnEndLaneGates,
	TurnEndLanePart,
	TurnEndLaneParts,
} from "../lane.js";

/**
 * The lane's two stores, keyed by the source identity the gate records.
 * A type alias, not an interface: only an alias gets the implicit index
 * signature `TurnEndLaneSources` (a `Record`) asks for.
 */
export type SecretsLaneSources = {
	gitleaks: FindingFreshnessSource<GitleaksFinding>;
	"trivy-secrets": FindingFreshnessSource<TrivySecretFinding>;
};

/** Post-policy rows, per store and per tier. Read only by `render`. */
export interface SecretsLaneKept {
	gitleaksLive: GitleaksFinding[];
	gitleaksStale: GitleaksFinding[];
	trivyLive: TrivySecretFinding[];
	trivyStale: TrivySecretFinding[];
	suppressed: Record<string, number>;
}

/**
 * Gitleaks deliberately scans gitignored local files and nested repositories
 * so an explicit security audit can still inspect them. The adapter is the
 * source of truth for whether a finding belongs in a blocking delivery lane;
 * filter here before freshness handling so demoted findings cannot leak into
 * either the blocker or the stale-secret turn context.
 */
async function blockingGitleaksFindings(
	data: GitleaksResult | undefined,
	ctx: TurnEndLaneContext,
): Promise<GitleaksFinding[]> {
	const classification = await bounded(
		classifyAndFilterFindings(data?.findings ?? [], ctx.cwd),
		{
			ms: HOOK_WALL_BUDGET_MS.turn_end,
			signal: ctx.signal,
			hook: "turn_end",
			label: "classifyAndFilterFindings",
		},
	);
	if (classification === undefined) {
		recordDegradationOnce({
			kind: "gitleaks_classification_timeout",
			subject: ctx.cwd,
			reason:
				"gitleaks classification exceeded the turn_end budget; retained raw findings to fail open",
		});
	}
	return (classification ?? data?.findings ?? []).filter(
		(finding) =>
			gitleaksFindingToProjectDiagnostic(ctx.cwd, finding).semantic ===
			"blocking",
	);
}

/**
 * #1460/#1622: the gitleaks cache is TTL-only, so a finding for a file deleted
 * after the scan was served as a 🔴 blocker for the rest of the 30-minute
 * window — 119 of 126 findings in pi-lens's own cache. This lane is the single
 * agent-facing consumer of that store (session_start's read only decides
 * whether to re-scan; the project-diagnostics path re-scans fresh and
 * reconciles at load), so the drop belongs here, before the findings enter the
 * shared secret pipeline. A cited file EDITED after the scan keeps its finding
 * but loses its line number: the credential may still be there, just not where
 * the snapshot says. Dropping instead would let any edit — malicious or
 * accidental — mute a real secret. Both stores take the default
 * `onMissing: "drop"`: the finding IS the deleted file's content.
 */
async function collect(ctx: TurnEndLaneContext): Promise<SecretsLaneSources> {
	// One await for both stores: the two reads are independent, and the memo
	// hands each of them the same promise the composer's own trivy read shares.
	const [gitleaksEntry, trivyEntry] = await Promise.all([
		ctx.readScannerCache<GitleaksResult>("gitleaks"),
		ctx.readScannerCache<TrivyResult>("trivy"),
	]);
	const gitleaksData = gitleaksEntry?.data;
	const trivyData = trivyEntry?.data;
	return {
		gitleaks: {
			findings: await blockingGitleaksFindings(gitleaksData, ctx),
			citedPath: (finding) => finding.file,
			scannedAt: gitleaksData?.scannedAt,
		},
		"trivy-secrets": {
			findings: trivyData?.secrets ?? [],
			citedPath: (finding) => finding.file,
			scannedAt: trivyData?.scannedAt,
		},
	};
}

/**
 * #1617/#1625/#1628: filter through the SAME `ProjectDiagnostic` identity
 * `lens_diagnostics mode=full` surfaces (tool="gitleaks",
 * rule="gitleaks:<ruleId>" / tool="trivy", rule="trivy-secret:<ruleId>"), so a
 * mark made against what the agent was SHOWN is honored here too — and over
 * both arms, never live-only.
 *
 * ast-grep secret findings need no filtering here: they already went through
 * dispatch's `applyDispositions` before reaching `peekActionableWarnings()`.
 */
function gate(
	gates: TurnEndLaneGates<SecretsLaneSources>,
	ctx: TurnEndLaneContext,
): SecretsLaneKept {
	const gitleaksLive = filterFindingsByDisposition(
		gates.gitleaks.live,
		ctx.cwd,
		(f) => gitleaksFindingToProjectDiagnostic(ctx.cwd, f),
	);
	const gitleaksStale = filterFindingsByDisposition(
		gates.gitleaks.stale,
		ctx.cwd,
		(f) => gitleaksFindingToProjectDiagnostic(ctx.cwd, f),
	);
	const trivyLive = filterFindingsByDisposition(
		gates["trivy-secrets"].live,
		ctx.cwd,
		(f) => trivySecretFindingToProjectDiagnostic(ctx.cwd, f),
	);
	const trivyStale = filterFindingsByDisposition(
		gates["trivy-secrets"].stale,
		ctx.cwd,
		(f) => trivySecretFindingToProjectDiagnostic(ctx.cwd, f),
	);
	return {
		gitleaksLive: gitleaksLive.kept,
		gitleaksStale: gitleaksStale.kept,
		trivyLive: trivyLive.kept,
		trivyStale: trivyStale.kept,
		suppressed: {
			gitleaks: gitleaksLive.suppressed + gitleaksStale.suppressed,
			"trivy-secrets": trivyLive.suppressed + trivyStale.suppressed,
		},
	};
}

function render(
	kept: SecretsLaneKept,
	ctx: TurnEndLaneContext,
): TurnEndLaneParts {
	const sessionSecrets = dedupeSecretFindings(
		[...fromGitleaks(kept.gitleaksLive), ...fromTrivySecrets(kept.trivyLive)],
		ctx.cwd,
	);
	// Locations already surfaced as session-scan secret blockers — used to
	// enrich provenance where ast-grep agrees, and handed back so the
	// actionable-warnings advisory can suppress its duplicate ast-grep copy.
	const deliveredLocationKeys = new Set(
		sessionSecrets.map((f) => secretLocationKey(f.file, f.line, ctx.cwd)),
	);
	// Lane-local accumulators, deliberately NOT named after the turn's tiers:
	// `blockerParts`/`staleSecretParts` are the composer's arrays, and a lane
	// that pushed into one would be a render seam the `@delivery-surface:` tag
	// scan cannot see (`tests/config/turn-end-lane-boundaries.test.ts`).
	const blockerSections: TurnEndLanePart[] = [];
	if (sessionSecrets.length) {
		// Fold in ast-grep provenance ONLY where it coincides with a session
		// secret — don't promote ast-grep-only findings out of their advisory
		// tier.
		const enriched = dedupeSecretFindings(
			[
				...sessionSecrets,
				...fromAstGrepWarnings(
					ctx.peekActionableWarnings().filter(isSecretWarning),
				).filter((a) =>
					deliveredLocationKeys.has(secretLocationKey(a.file, a.line, ctx.cwd)),
				),
			],
			ctx.cwd,
		);
		const shown = enriched.slice(0, 5);
		let report =
			"🔴 STOP — hardcoded secrets detected. Rotate the credentials and remove them from source:\n";
		for (const f of shown) {
			const where = `${toRunnerDisplayPath(ctx.cwd, f.file)}:${f.line}`;
			report += `  ${where} — ${f.rule} [${f.sources.join(" + ")}]${f.description ? `: ${f.description}` : ""}\n`;
		}
		if (enriched.length > shown.length) {
			report += `  … and ${enriched.length - shown.length} more\n`;
		}
		// #4617: the section reports these files' contents, so it carries them as
		// the stamp's subject (`enriched`, not `shown`: the "and N more" line
		// speaks for every one of them).
		blockerSections.push({ part: report, cites: enriched.map((f) => f.file) });
	}

	// Demoted secrets are addressed by FILE, never by line — the line is the one
	// field the edit invalidated. Deduped on file+rule+source so a file with
	// twenty stale hits of one rule is named once.
	const staleSecretEntries = [
		...kept.gitleaksStale.map((f) => ({
			file: toRunnerDisplayPath(ctx.cwd, f.file),
			filePath: f.file,
			rule: f.ruleId,
			source: "gitleaks",
		})),
		...kept.trivyStale.map((f) => ({
			file: toRunnerDisplayPath(ctx.cwd, f.file),
			filePath: f.file,
			rule: f.ruleId,
			source: "trivy",
		})),
	];
	const staleSecrets = [
		...new Map(
			staleSecretEntries.map((e) => [`${e.file}|${e.rule}|${e.source}`, e]),
		).values(),
	];
	const staleSections: TurnEndLanePart[] = [];
	if (staleSecrets.length) {
		const shown = staleSecrets.slice(0, 5);
		let report =
			`🔑 ACTION NEEDED — secrets were flagged in files that changed after the scan. ${STALE_LINE_MARKER}\n` +
			"The cached line numbers are no longer trustworthy, so they are withheld. Re-run a secrets scan to confirm or clear these:\n";
		for (const entry of shown) {
			report += `  ${entry.file} — ${entry.rule} [${entry.source}]\n`;
		}
		if (staleSecrets.length > shown.length) {
			report += `  … and ${staleSecrets.length - shown.length} more\n`;
		}
		// #4617: the tier names the files whose cached line numbers went stale —
		// every one it reports, the "and N more" set included.
		staleSections.push({
			part: report,
			cites: [...new Set(staleSecrets.map((entry) => entry.filePath))],
		});
	}

	return {
		blockerParts: blockerSections,
		staleSecretParts: staleSections,
		dispositionSuppressed: kept.suppressed,
		deliveredLocationKeys,
	};
}

/** The lane. Stateless — one object, no per-turn state to reset. */
export const secretsLane: TurnEndLane<SecretsLaneSources, SecretsLaneKept> = {
	collect,
	gate,
	render,
};
