/**
 * #5400 — a ledger written under an OLD kind name still parses and renders.
 *
 * `DegradationKind` is a compile-time union; `DegradationRecord.kind` is
 * `unknown` and `DegradationGroup.kind` is a plain string, and the durable row
 * keeps whatever text the writing build had. Splitting zizmor's offline
 * fallback out of `"mode-suppression"` and the PowerShell `-File` run failure
 * out of `"grammar-blocked"` therefore migrates nothing: every ledger file
 * written before the split keeps the old names, and the reader that turns the
 * ledger into the `pilens_health` group list must keep showing those rows.
 *
 * Both halves are driven through the real seams here: the record goes in
 * through `incrementDegradationCount` exactly as an older build's call site
 * called it (the old string, no cast — the seam accepts free-form kinds), the
 * durable row is read back off the real rotated NDJSON sink, and the health
 * view is produced by `renderDegradationLines`, the renderer `pilens_health`
 * and `/lens-perf` share (`mcp/server.ts`, `index.ts`).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	incrementDegradationCount,
	renderDegradationLines,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { installBusSinkReader } from "../support/bus-sink-reader.js";

const { latencyRows } = installBusSinkReader();

/** The `degradation_ledger` durable rows, as their metadata. */
async function ledgerRows(): Promise<Array<Record<string, unknown>>> {
	const rows = await latencyRows();
	return rows
		.filter((row) => row.phase === "degradation_ledger")
		.map((row) => (row.metadata ?? {}) as Record<string, unknown>);
}

/** The durable rows a given kind wrote in this window. */
async function rowsFor(kind: string): Promise<Array<Record<string, unknown>>> {
	return (await ledgerRows()).filter((metadata) => metadata.kind === kind);
}

beforeEach(() => {
	resetDegradationLedger();
});

describe("legacy degradation rows survive the #5400 kind split", () => {
	it("parses a durable row written with the old zizmor kind", async () => {
		// Exactly the call `clients/zizmor-config.ts` made before #5400.
		incrementDegradationCount({
			kind: "mode-suppression",
			subject: "zizmor",
			reason:
				"gh auth token probe probe-timeout; running offline until the next zizmor start",
		});

		const rows = await rowsFor("mode-suppression");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ subject: "zizmor", count: 1 });
	});

	it("parses a durable row written with the old PowerShell kind", async () => {
		// Exactly the call `clients/dispatch/runners/psscriptanalyzer.ts` made
		// before #5400.
		incrementDegradationCount({
			kind: "grammar-blocked",
			subject: "psscriptanalyzer",
			reason:
				"PowerShell execution policy blocked -File analysis for pwsh: SecurityError",
		});

		const rows = await rowsFor("grammar-blocked");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ subject: "psscriptanalyzer", count: 1 });
	});

	it("renders both legacy groups in the health view with their subject and reason", () => {
		incrementDegradationCount({
			kind: "mode-suppression",
			subject: "zizmor",
			reason: "gh auth token probe probe-timeout; running offline",
		});
		incrementDegradationCount({
			kind: "grammar-blocked",
			subject: "psscriptanalyzer",
			reason: "PowerShell (pwsh) -File analysis exited with no status",
		});

		const lines = renderDegradationLines(getDegradationSummary());
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("mode-suppression: 1"),
				expect.stringContaining("zizmor"),
				expect.stringContaining("grammar-blocked: 1"),
				expect.stringContaining("psscriptanalyzer"),
			]),
		);
		// Neither legacy kind is in INFORMATIONAL_DEGRADATION_KINDS, so both
		// keep the `⚠` a reader acts on rather than a bare tally.
		expect(
			lines.filter((line) => line.includes("⚠") && line.includes("-blocked:")),
		).toHaveLength(1);
	});

	it("renders a group shaped like a stale on-disk ledger row", () => {
		// The same shape a reader assembles from rows an older build wrote:
		// `droppedCount` set by the ring bound, nothing from today's vocabulary.
		const legacy = [
			{
				kind: "grammar-blocked",
				count: 3,
				droppedCount: 2,
				latestReasons: [
					{
						subject: "psscriptanalyzer",
						reason: "PowerShell -File analysis for pwsh exited 1: no stderr",
					},
				],
			},
		];
		expect(renderDegradationLines(legacy)).toEqual([
			"Degradations:",
			expect.stringContaining("grammar-blocked: 3"),
		]);
	});

	it("keeps a legacy row and its split successor as two separate groups", () => {
		// A session that resumed across an upgrade shows the old zizmor row from
		// the previous ledger and the new kind from this build's own record: two
		// groups, neither one silently relabelled or merged into the other.
		incrementDegradationCount({
			kind: "mode-suppression",
			subject: "zizmor",
			reason: "gh auth token probe probe-timeout (written by an older build)",
		});
		incrementDegradationCount({
			kind: "zizmor-offline",
			subject: "zizmor",
			reason: "gh auth token probe host-stall; running offline",
		});

		const kinds = getDegradationSummary().map((group) => group.kind);
		expect(kinds).toContain("mode-suppression");
		expect(kinds).toContain("zizmor-offline");
		expect(
			getDegradationSummary().find((g) => g.kind === "mode-suppression")?.count,
		).toBe(1);
	});
});
