/**
 * The turn-end GOVULNCHECK lane (#1892): the session_start-cached Go CVE
 * store, rendered as ONE advisory tier.
 *
 * One lane, one store, one tier — the straight second extraction against the
 * `TurnEndLane` interface, and the first lane that renders an ADVISORY
 * section (see `TurnEndLaneParts.advisoryParts` and ADR 0008's amendment for
 * why that field arrives with this lane rather than with the interface).
 *
 * Registered surface (`clients/finding-delivery-gate.ts`):
 * `runtime-turn:govulncheck-advisory` — mode `gated`, evidence
 * `scannerGates.govulncheck` (the composer's own binding of the shared pass's
 * result, unchanged by this extraction).
 *
 * History this file must not lose (each line below is a shipped defect or a
 * review finding):
 *
 * - #1622 sibling sweep: govulncheck renders a call site as `file:line` off a
 *   session_start snapshot — the same stale-line shape as gitleaks, one tier
 *   lower. A file edited after the scan keeps its CVE and loses its line,
 *   plus the `STALE_LINE_MARKER`.
 * - #1622 review H1: a CVE is pinned by `go.mod`, NOT by the call site, so a
 *   DELETED traced file may not drop it — `onMissing: "demote"` routes a
 *   vanished path into the same arm as an edited one. The first cut dropped
 *   it, and `citedPath` reads only the FIRST filename frame, so one deleted
 *   file in a long trace silently killed a CVE go.mod still pins.
 * - #1694 F1: these findings pass through `filterFindingsByDisposition` with
 *   the SAME `ProjectDiagnostic` identity `lens_diagnostics mode=full`
 *   surfaces, over BOTH freshness arms — a mark made against what the agent
 *   was SHOWN is honoured here too.
 * - #1627 + #1625 review: the post-gate row guard and the post-disposition
 *   row guard are the SAME guard — `render` tests the list it is about to
 *   print, never the raw cache length, or the header prints with zero rows
 *   beneath it whenever either filter empties the list.
 */

import { filterFindingsByDisposition } from "../../dispatch/finding-policy.js";
import { toRunnerDisplayPath } from "../../dispatch/runner-context.js";
import type {
	GovulncheckFinding,
	GovulncheckResult,
} from "../../govulncheck-client.js";
import { govulncheckFindingToProjectDiagnostic } from "../../project-diagnostics/runner-adapters/govulncheck.js";
import { STALE_LINE_MARKER } from "../../stale-marker.js";
import { existingDependencyManifests } from "../../trivy-client.js";
import type { FindingFreshnessSource } from "../../advisory-provenance.js";
import type {
	TurnEndLane,
	TurnEndLaneContext,
	TurnEndLaneGates,
	TurnEndLanePart,
	TurnEndLaneParts,
} from "../lane.js";

/**
 * The lane's one store, keyed by the source identity the gate's bounded
 * records carry. A type alias, not an interface: only an alias gets the
 * implicit index signature `TurnEndLaneSources` (a `Record`) asks for.
 */
export type GovulncheckLaneSources = {
	govulncheck: FindingFreshnessSource<GovulncheckFinding>;
};

/** Post-policy rows. Read only by `render`. */
export interface GovulncheckLaneKept {
	/** Live + demoted, in that order — the tier renders one list. */
	findings: GovulncheckFinding[];
	/**
	 * Which of `findings` came out of the gate's stale arm. A Set of the very
	 * objects the gate partitioned (`filterFindingsByDisposition` filters, it
	 * does not copy), because the demotion is a per-FINDING verdict and the
	 * two arms are rendered as one list.
	 */
	stale: ReadonlySet<GovulncheckFinding>;
	suppressed: number;
}

/**
 * #1622 H1: `onMissing: "demote"`, not the default `"drop"`. A Go CVE is
 * pinned by `go.mod`; the traced call site is only where it is reachable
 * FROM, so a deleted trace file means "the line is unusable", never "the
 * vulnerability is gone". `citedPath` reads the first filename frame, which
 * is also the frame `render` prints — the path the verdict is about is the
 * path the agent is shown.
 */
async function collect(
	ctx: TurnEndLaneContext,
): Promise<GovulncheckLaneSources> {
	const data = (await ctx.readScannerCache<GovulncheckResult>("govulncheck"))
		?.data;
	return {
		govulncheck: {
			findings: data?.findings ?? [],
			scannedAt: data?.scannedAt,
			citedPath: (finding: GovulncheckFinding) =>
				finding.trace.find((frame) => frame.filename)?.filename,
			onMissing: "demote",
		},
	};
}

/**
 * #1694 F1/#1625 review round: the freshness gate runs FIRST, so the
 * disposition anchor is derived from each finding's post-demotion identity —
 * this list is already the gate's live+stale partition, never the raw
 * pre-gate cache.
 */
function gate(
	gates: TurnEndLaneGates<GovulncheckLaneSources>,
	ctx: TurnEndLaneContext,
): GovulncheckLaneKept {
	const stale = new Set(gates.govulncheck.stale);
	const filtered = filterFindingsByDisposition(
		[...gates.govulncheck.live, ...gates.govulncheck.stale],
		ctx.cwd,
		(f) => govulncheckFindingToProjectDiagnostic(ctx.cwd, f),
	);
	return {
		findings: filtered.kept,
		stale,
		suppressed: filtered.suppressed,
	};
}

function render(
	kept: GovulncheckLaneKept,
	ctx: TurnEndLaneContext,
): TurnEndLaneParts {
	// Lane-local accumulator, deliberately NOT named after the turn's tier:
	// `advisoryParts` is the composer's array, and a lane that pushed into one
	// would be a render seam the `@delivery-surface:` tag scan cannot see
	// (`tests/config/turn-end-lane-boundaries.test.ts`).
	const advisorySections: TurnEndLanePart[] = [];
	// #1627/#1625: guard the list that is about to be printed, never the raw
	// cache length — the header must not print with zero rows beneath it.
	if (kept.findings.length) {
		const findings = kept.findings.slice(0, 5);
		let report =
			"🛡️ Go CVEs reachable from this code (govulncheck) — upgrade where possible:\n";
		for (const f of findings) {
			const callSite = f.trace.find((t) => t.filename);
			const stale = kept.stale.has(f);
			const where = callSite?.filename
				? `${toRunnerDisplayPath(ctx.cwd, callSite.filename)}${!stale && callSite.line ? `:${callSite.line}` : ""}${stale ? ` ${STALE_LINE_MARKER}` : ""}`
				: (f.module ?? f.packageName ?? "(module)");
			const fix = f.fixedVersion
				? ` — upgrade to ${f.fixedVersion} or later`
				: " — no fix yet, track upstream";
			report += `  ${f.osv} (${where})${fix}\n`;
		}
		if (kept.findings.length > findings.length) {
			report += `  … and ${kept.findings.length - findings.length} more\n`;
		}
		// #4617: the section reports the call sites it printed, so those files are
		// the stamp's subject. A Go CVE is pinned by go.mod, not by the call site
		// (#1622 H1), and a module- or package-level finding has no call site at
		// all, so the Go module files at the scan root are a subject of every
		// section, as a trivy row cites its manifests. A bump that fixes the
		// module supersedes the text. With no go.mod on disk the module-only rows
		// cite nothing and the composer fails closed (the evidence is gone, so
		// the label is historical).
		const callSites = kept.findings.flatMap((f) => {
			const callSite = f.trace.find((t) => t.filename)?.filename;
			return callSite === undefined ? [] : [callSite];
		});
		advisorySections.push({
			part: report,
			cites: [...new Set([...callSites, ...goModuleFiles(ctx.cwd)])],
		});
	}
	return {
		advisoryParts: advisorySections,
		dispositionSuppressed: { govulncheck: kept.suppressed },
	};
}

/**
 * The Go module files a module-level CVE is pinned by: the one manifest probe
 * (`existingDependencyManifests`), narrowed to Go's two files so another
 * ecosystem's manifest moving on does not supersede a Go finding.
 */
function goModuleFiles(cwd: string): string[] {
	return existingDependencyManifests(cwd).flatMap((file) =>
		/[\\/]go\.(?:mod|sum)$/.test(file) ? [file] : [],
	);
}

/** The lane. Stateless — one object, no per-turn state to reset. */
export const govulncheckLane: TurnEndLane<
	GovulncheckLaneSources,
	GovulncheckLaneKept
> = {
	collect,
	gate,
	render,
};
