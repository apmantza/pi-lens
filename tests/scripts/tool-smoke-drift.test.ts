import { describe, expect, it } from "vitest";
import {
	buildLayer,
	buildToolSmokeDriftBody,
	buildToolSmokeDriftComment,
	decideAction,
	decideToolSmokeAction,
	layersGenuinelyClean,
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
		const log =
			"✓  go           gopls                        3     ok\n36 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)\n";
		expect(parseFailingRows(log)).toEqual([]);
	});

	it("preserves colons/parens inside detail text rather than truncating on the first colon", () => {
		const rows = parseFailingRows(REPLAY_LOG);
		expect(rows[0].detail).toContain(
			"ensureTool(intelephense) failed (npm toolchain present): install failed",
		);
	});

	// #2723 review F2: `report()`'s columns are PADDED (`String.padEnd`) but
	// never TRUNCATED, so a lang > 12 chars or a runner > 28 chars simply
	// runs the column wider than usual — the row is still perfectly valid
	// output, just not fixed-width. 8 of the 76 rows in the real run
	// 34116176046 overflow one column or the other (verbatim from that
	// run's ✓ rows below, converted to ✗ here — a FUTURE red run with any
	// of these exact lang/runner names must still be reported, not silently
	// dropped). The old fixed-width regex (`(.{12}) (.{28}) (?:.{5})`)
	// matched NONE of these — every one of the seven cases below reds
	// against it (proven in the PR body's mutation-proof quote).
	it.each([
		[
			"✗  typescript-clean typescript-language-server (clean file) 0     handshake failed: timeout",
			{
				lang: "typescript-clean",
				runner: "typescript-language-server (clean file)",
				detail: "handshake failed: timeout",
			},
		],
		[
			"✗  typescript7  typescript native (tsc --lsp --stdio, TS7+) 1     handshake failed",
			{
				lang: "typescript7",
				runner: "typescript native (tsc --lsp --stdio, TS7+)",
				detail: "handshake failed",
			},
		],
		[
			"✗  typescript7-clean typescript native (clean file) 0     handshake failed: timeout",
			{
				lang: "typescript7-clean",
				runner: "typescript native (clean file)",
				detail: "handshake failed: timeout",
			},
		],
		[
			"✗  cue          CUE Language Server (cue lsp serve) 1     install failed",
			{
				lang: "cue",
				runner: "CUE Language Server (cue lsp serve)",
				detail: "install failed",
			},
		],
		[
			"✗  powershell   PowerShell Editor Services (pwsh Start-EditorServices.ps1 -Stdio) 0     install failed",
			{
				lang: "powershell",
				runner:
					"PowerShell Editor Services (pwsh Start-EditorServices.ps1 -Stdio)",
				detail: "install failed",
			},
		],
		[
			"✗  ast-grep-baseline ast-grep (no-sgconfig baseline) 1     install failed",
			{
				lang: "ast-grep-baseline",
				runner: "ast-grep (no-sgconfig baseline)",
				detail: "install failed",
			},
		],
		[
			"✗  deno         deno (alternate of typescript) 1     install failed",
			{
				lang: "deno",
				runner: "deno (alternate of typescript)",
				detail: "install failed",
			},
		],
	])("parses an overflowing-column row: %s", (row, expected) => {
		expect(parseFailingRows(row)).toEqual([expected]);
	});

	// The real (✓, non-failing) overflow rows from the same run must stay
	// correctly EXCLUDED — proves the fix didn't loosen the icon gate to
	// compensate for the wider column match.
	it("still excludes ✓ rows even when their columns overflow", () => {
		const log = [
			"✓  typescript-clean typescript-language-server (clean file) 0     handshook — server replied",
			"✓  cue          CUE Language Server (cue lsp serve) 1     served 1 diagnostic matching /expected '\\}'|found 'EOF'/",
			REPLAY_FAILING_ROW,
		].join("\n");
		expect(parseFailingRows(log)).toEqual([
			{
				lang: "php",
				runner: "intelephense",
				detail:
					"ensureTool(intelephense) failed (npm toolchain present): install failed",
			},
		]);
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
		expect(
			parseConsecutiveRedCount("blah\nConsecutive red nights: **3**\nblah"),
		).toBe(3);
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

	it("closes when all four gating layers succeeded", () => {
		const layers = [
			{ name: "Tool layer", outcome: "success" },
			{ name: "LSP handshake layer", outcome: "success" },
			{ name: "LSP diagnostics clean-gate", outcome: "success" },
			{ name: "Format layer", outcome: "success" },
		];
		expect(decideAction({ steps: layers })).toBe("close-if-open");
	});
});

describe("buildToolSmokeDriftBody (#2723 acceptance #4: names both the ✗ row and the summary line)", () => {
	const report = {
		layers: [
			buildLayer(
				"Tool layer",
				"success",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
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
		expect(body).toContain(
			"36 passed · 1 failed · 0 setup-failed · 12 skipped",
		);
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
		expect(body).toContain(
			"closed automatically once a nightly run is fully green",
		);
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

	it("names '(outside the tracked layers)' when the report carries that flag and no layer itself failed", () => {
		const layers = [
			buildLayer("Tool layer", "skipped", null),
			buildLayer("LSP handshake layer", "skipped", null),
			buildLayer("Format layer", "skipped", null),
		];
		expect(
			buildToolSmokeDriftComment({ layers, outsideTrackedLayers: true }),
		).toBe("Still red: failing layer **(outside the tracked layers)**.");
	});
});

// #2723 review F3: a job failure BEFORE the three tracked layers even start
// (checkout, a best-effort setup action, npm install, build:dist) leaves
// Tool/LSP handshake/Format layer all "skipped" — the EXACT SAME shape a
// genuine GitHub Actions cancellation produces (install-smoke-drift.mjs's
// own cancelled-mid-run/before-start attacks). `decideAction` alone cannot
// tell them apart; `decideToolSmokeAction` uses GitHub's `job.status`
// context to disambiguate.
describe("decideToolSmokeAction (#2723 review F3)", () => {
	const allSkipped = [
		{ name: "Tool layer", outcome: "skipped" },
		{ name: "LSP handshake layer", outcome: "skipped" },
		{ name: "LSP diagnostics clean-gate", outcome: "skipped" },
		{ name: "Format layer", outcome: "skipped" },
	];

	it("promotes no-action to file-or-refresh when the job genuinely failed outside the tracked layers", () => {
		expect(decideToolSmokeAction({ layers: allSkipped }, "failure")).toEqual({
			action: "file-or-refresh",
			outsideTrackedLayers: true,
		});
	});

	it("leaves a genuine cancellation as no-action (job.status 'cancelled', not 'failure')", () => {
		expect(decideToolSmokeAction({ layers: allSkipped }, "cancelled")).toEqual({
			action: "no-action",
			outsideTrackedLayers: false,
		});
	});

	it("leaves no-action alone when job.status is missing/empty (mirrors the old decideAction behavior exactly)", () => {
		expect(decideToolSmokeAction({ layers: allSkipped }, "")).toEqual({
			action: "no-action",
			outsideTrackedLayers: false,
		});
	});

	it("does not touch an ALREADY file-or-refresh verdict (a real layer failure) even when job.status is 'failure'", () => {
		const layers = [
			{ name: "Tool layer", outcome: "success" },
			{ name: "LSP handshake layer", outcome: "failure" },
			{ name: "Format layer", outcome: "skipped" },
		];
		expect(decideToolSmokeAction({ layers }, "failure")).toEqual({
			action: "file-or-refresh",
			outsideTrackedLayers: false,
		});
	});

	it("leaves 'unknown' (wiring bug) alone regardless of job.status", () => {
		const layers = [
			{ name: "Tool layer", outcome: "" },
			{ name: "LSP handshake layer", outcome: "" },
			{ name: "Format layer", outcome: "" },
		];
		expect(decideToolSmokeAction({ layers }, "failure")).toEqual({
			action: "unknown",
			outsideTrackedLayers: false,
		});
	});

	// #2723 review F4: the cheap backstop against `set -o pipefail` loss --
	// see layersGenuinelyClean's own describe block for the pure-function
	// proof; this proves it is actually WIRED into the decision.
	it("refuses to close when every outcome says success but a layer's own parsed summary shows a failure", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
			// Outcome says "success" (the pipe's exit code, e.g. from a lost
			// `set -o pipefail`) but the log text it captured still shows a
			// real failure -- the exact discrepancy F4 exists to catch.
			buildLayer(
				"LSP handshake layer",
				"success",
				REPLAY_LOG, // 36 passed · 1 failed · ...
			),
			buildLayer(
				"Format layer",
				"success",
				"10 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
		];
		expect(decideToolSmokeAction({ layers }, "success")).toEqual({
			action: "no-action",
			outsideTrackedLayers: false,
		});
	});

	it("still closes when every outcome AND every parsed summary genuinely agree on clean", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
			buildLayer(
				"LSP handshake layer",
				"success",
				"38 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
			buildLayer(
				"Format layer",
				"success",
				"10 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
		];
		expect(decideToolSmokeAction({ layers }, "success")).toEqual({
			action: "close-if-open",
			outsideTrackedLayers: false,
		});
	});
});

describe("layersGenuinelyClean (#2723 review F4)", () => {
	it("is true when every layer's parsed summary shows zero failed and zero setup-failed", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
			buildLayer(
				"Format layer",
				"success",
				"10 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
		];
		expect(layersGenuinelyClean(layers)).toBe(true);
	});

	it("is false when any layer's parsed summary shows a nonzero failed count", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"40 passed · 0 failed · 0 setup-failed · 0 skipped (tool/config unavailable)",
			),
			buildLayer("LSP handshake layer", "success", REPLAY_LOG),
		];
		expect(layersGenuinelyClean(layers)).toBe(false);
	});

	it("is false when any layer's parsed summary shows a nonzero setup-failed count", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"39 passed · 0 failed · 1 setup-failed · 0 skipped (tool/config unavailable)",
			),
		];
		expect(layersGenuinelyClean(layers)).toBe(false);
	});

	it("treats a layer with NO captured summary as not itself disqualifying (outcome already covers that case)", () => {
		const layers = [buildLayer("Format layer", "success", null)];
		expect(layersGenuinelyClean(layers)).toBe(true);
	});

	// Mutation-proof, dangerous direction: a check that only looks at
	// `failed` and ignores `setupFailed` would wrongly call this clean.
	it("mutation-proof: ignoring setupFailed would wrongly report clean", () => {
		const layers = [
			buildLayer(
				"Tool layer",
				"success",
				"39 passed · 0 failed · 1 setup-failed · 0 skipped (tool/config unavailable)",
			),
		];
		const failedOnly = layers.every(
			(l) => !l.summary || l.summary.failed === 0,
		);
		expect(failedOnly).toBe(true); // the mutated (wrong) check would pass
		expect(layersGenuinelyClean(layers)).toBe(false); // the real one correctly catches it
	});
});
