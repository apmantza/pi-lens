import { describe, expect, it } from "vitest";
import {
	buildLayer,
	buildToolSmokeDriftBody,
	buildToolSmokeDriftComment,
	decideAction,
	nextConsecutiveRedCount,
	parseConsecutiveRedCount,
	parseFailingRows,
	parseLayerSummary,
} from "../../scripts/lib/tool-smoke-drift.mjs";

// Acceptance #4: a byte-verified replay of the LSP handshake layer step's
// raw log text from run 34116176046, job 101723408154 (apmantza/pi-lens) —
// not paraphrased. `smoke-tools.mjs`'s own `report()` (pad = String.padEnd)
// produces this exact row/summary shape; see scripts/smoke-tools.mjs's
// `report()` for the format string this pins.
const REPLAY_FAILING_ROW =
	"✗  php          intelephense                 0     ensureTool(intelephense) failed (npm toolchain present): install failed";
const REPLAY_SUMMARY_LINE =
	"36 passed · 1 failed · 0 setup-failed · 12 skipped (tool/config unavailable)";
const REPLAY_LOG = [
	"Live tool-smoke (#209) — LSP handshake (install → spawn → initialize)",
	"",
	"   LANG         RUNNER/SERVER                DIAG  DETAIL",
	REPLAY_FAILING_ROW,
	"",
	REPLAY_SUMMARY_LINE,
	"Legend: ✓ ok  ✗ failure/setup-failed  ⚠ unavailable (not a failure)",
	"",
].join("\n");

describe("parseLayerSummary (#2723)", () => {
	it("parses the real run 34116176046 summary line", () => {
		expect(parseLayerSummary(REPLAY_LOG)).toEqual({
			passed: 36,
			failed: 1,
			setupFailed: 0,
			skipped: 12,
		});
	});

	it("returns null when the log has no summary line (step never produced a report)", () => {
		expect(parseLayerSummary("some unrelated crash output\n")).toBeNull();
		expect(parseLayerSummary(null)).toBeNull();
		expect(parseLayerSummary(undefined)).toBeNull();
	});
});

describe("parseFailingRows (#2723)", () => {
	it("parses the real run 34116176046 ✗ row (lang/runner/detail), positionally not by whitespace split", () => {
		expect(parseFailingRows(REPLAY_LOG)).toEqual([
			{
				lang: "php",
				runner: "intelephense",
				detail:
					"ensureTool(intelephense) failed (npm toolchain present): install failed",
			},
		]);
	});

	it("ignores ✓ and ⚠ rows, only ✗ rows", () => {
		const log = [
			"✓  go           gopls                        3     ok",
			"⚠  zig          zls                          0     unavailable (toolchain missing)",
			REPLAY_FAILING_ROW,
		].join("\n");
		expect(parseFailingRows(log)).toHaveLength(1);
		expect(parseFailingRows(log)[0].lang).toBe("php");
	});

	it("returns an empty array for a clean log with no ✗ rows", () => {
		const log = "✓  go           gopls                        3     ok\n36 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n";
		expect(parseFailingRows(log)).toEqual([]);
	});

	it("preserves colons/parens inside detail text rather than truncating on the first colon", () => {
		const rows = parseFailingRows(REPLAY_LOG);
		expect(rows[0].detail).toContain(
			"ensureTool(intelephense) failed (npm toolchain present): install failed",
		);
	});
});

describe("buildLayer (#2723)", () => {
	it("combines outcome + parsed summary + parsed rows from raw log text", () => {
		const layer = buildLayer("LSP handshake layer", "failure", REPLAY_LOG);
		expect(layer).toEqual({
			name: "LSP handshake layer",
			outcome: "failure",
			summary: { passed: 36, failed: 1, setupFailed: 0, skipped: 12 },
			failingRows: [
				{
					lang: "php",
					runner: "intelephense",
					detail:
						"ensureTool(intelephense) failed (npm toolchain present): install failed",
				},
			],
		});
	});

	it("reports null summary and no rows for a step that never ran (no log captured)", () => {
		const layer = buildLayer("Format layer", "skipped", null);
		expect(layer.summary).toBeNull();
		expect(layer.failingRows).toEqual([]);
	});
});

describe("parseConsecutiveRedCount / nextConsecutiveRedCount (#2723 acceptance #1)", () => {
	it("reads back the count this module's own body builder writes", () => {
		expect(parseConsecutiveRedCount("blah\nConsecutive red nights: **3**\nblah")).toBe(3);
	});

	it("reads 0 when the line is absent (first red night)", () => {
		expect(parseConsecutiveRedCount("no such line here")).toBe(0);
		expect(parseConsecutiveRedCount(null)).toBe(0);
		expect(parseConsecutiveRedCount(undefined)).toBe(0);
	});

	it("increments by exactly one from the prior body's count", () => {
		expect(nextConsecutiveRedCount(null)).toBe(1);
		expect(nextConsecutiveRedCount("Consecutive red nights: **1**")).toBe(2);
		expect(nextConsecutiveRedCount("Consecutive red nights: **12**")).toBe(13);
	});
});

describe("decideAction reused from install-smoke-drift.mjs, applied to tool-smoke's 3-layer shape (#2723)", () => {
	it("files/refreshes when a gating layer failed", () => {
		const layers = [
			{ name: "Tool layer", outcome: "success" },
			{ name: "LSP handshake layer", outcome: "failure" },
			{ name: "Format layer", outcome: "skipped" },
		];
		expect(decideAction({ steps: layers })).toBe("file-or-refresh");
	});

	it("closes when all three gating layers succeeded", () => {
		const layers = [
			{ name: "Tool layer", outcome: "success" },
			{ name: "LSP handshake layer", outcome: "success" },
			{ name: "Format layer", outcome: "success" },
		];
		expect(decideAction({ steps: layers })).toBe("close-if-open");
	});
});

describe("buildToolSmokeDriftBody (#2723 acceptance #4: names both the ✗ row and the summary line)", () => {
	const report = {
		layers: [
			buildLayer("Tool layer", "success", "40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)"),
			buildLayer("LSP handshake layer", "failure", REPLAY_LOG),
			buildLayer("Format layer", "skipped", null),
		],
		consecutiveRed: 1,
	};
	const body = buildToolSmokeDriftBody(report, {
		runUrl: "https://github.com/apmantza/pi-lens/actions/runs/34116176046",
	});

	it("names the failing layer", () => {
		expect(body).toContain("Failing layer: **LSP handshake layer**");
	});

	it("names php intelephense's failing row verbatim", () => {
		expect(body).toContain(
			"`php` / `intelephense` — ensureTool(intelephense) failed (npm toolchain present): install failed",
		);
	});

	it("includes the replayed summary line's counts for the failing layer", () => {
		expect(body).toContain("36 passed · 1 failed · 0 setup-failed · 12 skipped");
	});

	it("includes the consecutive-red count", () => {
		expect(body).toContain("Consecutive red nights: **1**");
	});

	it("includes the run link", () => {
		expect(body).toContain(
			"https://github.com/apmantza/pi-lens/actions/runs/34116176046",
		);
	});

	it("says the tracking issue auto-closes on green", () => {
		expect(body).toContain("closed automatically once a nightly run is fully green");
	});
});

describe("buildToolSmokeDriftComment (#2723)", () => {
	it("names the failing layer in the refresh comment", () => {
		const layers = [
			buildLayer("Tool layer", "success", null),
			buildLayer("LSP handshake layer", "failure", REPLAY_LOG),
			buildLayer("Format layer", "skipped", null),
		];
		expect(buildToolSmokeDriftComment({ layers })).toBe(
			"Still red: failing layer **LSP handshake layer**.",
		);
	});
});
