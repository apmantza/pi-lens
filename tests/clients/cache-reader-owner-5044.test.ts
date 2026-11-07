/**
 * #5044 remainder — the cache-only readers of the per-file diagnostic stores
 * anchored disposition marks on the STORE KEY (the edited file), not on the
 * file each finding names (`WidgetDiagnostic.citedFile`, stamped by #5020).
 *
 * Recurrence: a chart-wide runner (helm-lint) reports a finding on
 * `chart/Chart.yaml` while `chart/templates/deploy-a.yaml` is written, and
 * `clients/pipeline.ts` records that row under the TEMPLATE's widget record.
 * The PR #5067 reviewer probed the cache side: after a `suppress` mark on
 * Chart.yaml, `applyWeakDispositions` under the template key kept the finding
 * (the weak anchors differ only in the path component), and a mark on the
 * TEMPLATE's finding hid the same finding on Chart.yaml. The same skew tags
 * rows at mark time through `reconcileWidgetDisposition`.
 *
 * Every case here drives the production seams: the real store write
 * (`recordDiagnostics`, the shape `pipeline.ts` hands it), the real
 * `lens_diagnostic_mark` anchor chokepoint (`markDisposition`, which also
 * fires the registered `reconcileWidgetDisposition` mirror), and the real
 * `lens_diagnostics mode=all` reader.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	markDisposition,
	strictAnchorSpan,
} from "../../clients/diagnostic-dispositions.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnostics,
	importWidgetState,
	recordDiagnostics,
	type PersistedWidgetState,
} from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "./test-utils.js";

const CHART = path.join("chart", "Chart.yaml");
const TEMPLATE = path.join("chart", "templates", "deploy-a.yaml");
// One line, spelled identically in BOTH files, so a strict anchor's span half
// is equal across the files and ONLY the path component can tell the two
// findings apart.
const SHARED_LINE = "value: identical\n";
const SHARED_MSG = "chart name is required";
// Distinct-identity rows for the staleness / unreadable cells, where two
// marks of DIFFERENT flavors must be observable on two rows at once.
const WEAK_MSG = "missing icon field";
const STRICT_MSG = "deprecated apiVersion";

let cwd: string;
let chartPath: string;
let templatePath: string;
let previousDataDir: string | undefined;

function writeProject(): void {
	fs.mkdirSync(path.join(cwd, "chart", "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, CHART),
		`# chart\n${SHARED_LINE}apiVersion: v1\n`,
	);
	fs.writeFileSync(
		path.join(cwd, TEMPLATE),
		`# template\n${SHARED_LINE}other: 1\n`,
	);
}

/** The chart-level row helm-lint reports for Chart.yaml while the TEMPLATE is
 *  written — the exact raw shape `clients/pipeline.ts` records. */
function chartRow(
	message = SHARED_MSG,
	line = 2,
	semantic = "warning",
	severity = "warning",
) {
	return {
		tool: "helm-lint",
		rule: "error",
		message,
		line,
		severity,
		semantic,
		filePath: chartPath,
	};
}

function templateRow(
	message = SHARED_MSG,
	line = 2,
	semantic = "warning",
	severity = "warning",
) {
	return {
		tool: "helm-lint",
		rule: "error",
		message,
		line,
		severity,
		semantic,
		filePath: templatePath,
	};
}

function mark(
	filePath: string,
	message: string,
	line: number,
	disposition: "false-positive" | "suppress" | "defer",
): void {
	markDisposition(
		cwd,
		{
			cwd,
			// The mark tool passes `normalizeMapKey(absPath)` (#1024).
			filePath: normalizeMapKey(filePath),
			tool: "helm-lint",
			rule: "error",
			message,
			line,
			content: fs.readFileSync(filePath, "utf8"),
		},
		disposition,
	);
}

async function modeAll(): Promise<string> {
	const tool = createLensDiagnosticsTool(
		{ readCache: () => undefined } as never,
		() => cwd,
	);
	const out = (await tool.execute(
		"cache-5044",
		{ mode: "all" },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }> };
	return out.content.map((c) => c.text).join("\n");
}

/** How many times mode=all rendered `message`. */
function rendered(text: string, message: string): number {
	return text.split(message).length - 1;
}

beforeEach(() => {
	cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5044-")),
	);
	chartPath = path.join(cwd, CHART);
	templatePath = path.join(cwd, TEMPLATE);
	writeProject();
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(cwd, "data");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	_resetDeferredForTests();
	_resetStateCacheForTests();
	clearWidgetState();
	removeTempDirSync(cwd);
});

describe("lens_diagnostics mode=all anchors marks on the finding's own file (#5044)", () => {
	it("control: serves both findings when nothing is marked", async () => {
		recordDiagnostics(templatePath, [templateRow(), chartRow()]);
		const text = await modeAll();
		expect(rendered(text, SHARED_MSG)).toBe(2);
	});

	it("hides the Chart.yaml finding under a suppress mark on Chart.yaml, keeping the template's own", async () => {
		recordDiagnostics(templatePath, [templateRow(), chartRow()]);
		mark(chartPath, SHARED_MSG, 2, "suppress");
		const text = await modeAll();
		expect(rendered(text, SHARED_MSG)).toBe(1);
		expect(text).toContain("L2:");
	});

	it("does not let a suppress mark on the template hide the Chart.yaml finding", async () => {
		recordDiagnostics(templatePath, [templateRow(), chartRow()]);
		mark(templatePath, SHARED_MSG, 2, "suppress");
		const text = await modeAll();
		expect(rendered(text, SHARED_MSG)).toBe(1);
	});

	it("never drops a blocking Chart.yaml finding on a weak suppress mark, wherever it is anchored", async () => {
		recordDiagnostics(templatePath, [
			templateRow(SHARED_MSG, 2, "blocking", "error"),
			chartRow(SHARED_MSG, 2, "blocking", "error"),
		]);
		mark(chartPath, SHARED_MSG, 2, "suppress");
		const text = await modeAll();
		// #1625 F1: a WEAK mark never hides a STOP-tier finding — the gate has
		// to hold on the OWNER path too, so this stays 2.
		expect(rendered(text, SHARED_MSG)).toBe(2);
	});

	it("hides a blocking Chart.yaml finding under a false-positive mark on Chart.yaml's own line", async () => {
		recordDiagnostics(templatePath, [
			templateRow(SHARED_MSG, 2, "blocking", "error"),
			chartRow(SHARED_MSG, 2, "blocking", "error"),
		]);
		mark(chartPath, SHARED_MSG, 2, "false-positive");
		const text = await modeAll();
		// STRICT matches Chart.yaml's anchor only: the template's own row (same
		// message, same line, same line text — only its path differs) survives.
		expect(rendered(text, SHARED_MSG)).toBe(1);
	});

	it("does not let a false-positive mark on the template hide the Chart.yaml finding", async () => {
		recordDiagnostics(templatePath, [
			templateRow(SHARED_MSG, 2, "blocking", "error"),
			chartRow(SHARED_MSG, 2, "blocking", "error"),
		]);
		mark(templatePath, SHARED_MSG, 2, "false-positive");
		const text = await modeAll();
		expect(rendered(text, SHARED_MSG)).toBe(1);
	});

	it("hides the Chart.yaml finding under a session defer on Chart.yaml", async () => {
		recordDiagnostics(templatePath, [templateRow(), chartRow()]);
		mark(chartPath, SHARED_MSG, 2, "defer");
		const text = await modeAll();
		expect(rendered(text, SHARED_MSG)).toBe(1);
	});

	it("matches the strict span against the cited file's content, not the record's", async () => {
		// Same message, same line NUMBER, but the two files hold DIFFERENT text
		// on that line: only a content read of Chart.yaml derives the span the
		// false-positive mark binds to. Reading the record file's line instead
		// leaves the cited row visible.
		recordDiagnostics(templatePath, [
			templateRow("divergent line finding", 3),
			chartRow("divergent line finding", 3),
		]);
		mark(chartPath, "divergent line finding", 3, "false-positive");
		const text = await modeAll();
		// The template's own row differs from the mark in path AND span: 1 left.
		expect(rendered(text, "divergent line finding")).toBe(1);
	});

	it("applies a weak mark on a stale Chart.yaml but waits for its strict mark", async () => {
		recordDiagnostics(templatePath, [
			chartRow(WEAK_MSG, 1),
			chartRow(STRICT_MSG, 1),
		]);
		mark(chartPath, WEAK_MSG, 1, "suppress");
		mark(chartPath, STRICT_MSG, 1, "false-positive");
		// Chart.yaml moves AFTER both findings were observed: the cached lines
		// may no longer align, so the strict anchor waits for the next dispatch
		// while the intent-level weak mark keeps applying.
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(chartPath, future, future);
		const text = await modeAll();
		expect(rendered(text, WEAK_MSG)).toBe(0);
		expect(rendered(text, STRICT_MSG)).toBe(1);
	});

	it("applies a weak mark when Chart.yaml is gone but keeps the strict-marked finding", async () => {
		recordDiagnostics(templatePath, [
			chartRow(WEAK_MSG, 1),
			chartRow(STRICT_MSG, 1),
		]);
		mark(chartPath, WEAK_MSG, 1, "suppress");
		mark(chartPath, STRICT_MSG, 1, "false-positive");
		fs.rmSync(chartPath);
		const text = await modeAll();
		expect(rendered(text, WEAK_MSG)).toBe(0);
		expect(rendered(text, STRICT_MSG)).toBe(1);
	});

	it("restores a master-shape record and honors a mark on the cited file", async () => {
		recordDiagnostics(templatePath, [
			templateRow("own finding", 3),
			chartRow("cited finding", 2),
		]);
		// The master round trip: the store snapshot #190 persists, then a new
		// session rehydrates it.
		const snapshot = JSON.parse(
			JSON.stringify(exportWidgetState()),
		) as PersistedWidgetState;
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);
		mark(chartPath, "cited finding", 2, "suppress");
		mark(templatePath, "own finding", 3, "suppress");
		const text = await modeAll();
		expect(rendered(text, "cited finding")).toBe(0);
		expect(rendered(text, "own finding")).toBe(0);
	});

	it("keeps a pre-citedFile row anchored on its record key after restore", async () => {
		// A record written by a build that predates `citedFile` (#5020): the
		// Chart.yaml row carries no per-entry path. It must parse and behave
		// exactly as today — the record key is its anchor.
		recordDiagnostics(templatePath, [chartRow("legacy finding", 2)]);
		const snapshot = JSON.parse(
			JSON.stringify(exportWidgetState()),
		) as PersistedWidgetState;
		for (const rec of snapshot.files) {
			for (const d of [...rec.diagnostics, ...rec.allDiagnostics]) {
				delete (d as { citedFile?: string }).citedFile;
			}
		}
		clearWidgetState();
		expect(importWidgetState(snapshot)).toBe(true);
		mark(chartPath, "legacy finding", 2, "suppress");
		const markedOtherFile = await modeAll();
		expect(rendered(markedOtherFile, "legacy finding")).toBe(1);
		mark(templatePath, "legacy finding", 2, "suppress");
		const markedRecordKey = await modeAll();
		expect(rendered(markedRecordKey, "legacy finding")).toBe(0);
	});
});

describe("reconcileWidgetDisposition anchors marks on the finding's own file (#5044)", () => {
	beforeEach(() => {
		recordDiagnostics(templatePath, [templateRow(), chartRow()]);
	});

	it("does not let a false-positive mark on the template tag or drop the cited row", () => {
		mark(templatePath, SHARED_MSG, 2, "false-positive");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const own = rows.find((d) => d.citedFile === undefined);
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(own?.disposition).toBe("false-positive");
		expect(cited).toBeDefined();
		expect(cited?.disposition).toBeUndefined();
	});

	it("does not let a suppress mark on the template tag the cited row", () => {
		mark(templatePath, SHARED_MSG, 2, "suppress");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited).toBeDefined();
		expect(cited?.disposition).toBeUndefined();
	});

	it("tags the cited row from a false-positive mark made on Chart.yaml itself", () => {
		// A mark on Chart.yaml finds no Chart.yaml widget record (its row lives
		// in the template's), so the tag lands on the next reconcile pass over
		// the record that actually holds the row.
		mark(chartPath, SHARED_MSG, 2, "false-positive");
		mark(templatePath, "unrelated template lint", 3, "suppress");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited?.disposition).toBe("false-positive");
		expect(cited?.anchorSpan).toBe(
			strictAnchorSpan(fs.readFileSync(chartPath, "utf8"), 2),
		);
		const own = rows.find((d) => d.citedFile === undefined);
		expect(own?.disposition).toBeUndefined();
	});

	it("stamps the cited row's span from the cited file's own content", () => {
		// The two files hold DIFFERENT text on line 3, so the stamped span can
		// only come from a content read of Chart.yaml — reading the record
		// file's line 3 instead derives a span no mark matches.
		recordDiagnostics(templatePath, [
			templateRow("divergent line finding", 3),
			chartRow("divergent line finding", 3),
		]);
		mark(chartPath, "divergent line finding", 3, "false-positive");
		mark(templatePath, "unrelated template lint", 1, "suppress");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited?.disposition).toBe("false-positive");
		expect(cited?.anchorSpan).toBe(
			strictAnchorSpan(fs.readFileSync(chartPath, "utf8"), 3),
		);
	});
});
