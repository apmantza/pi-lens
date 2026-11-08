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
	getFileDiagnosticSummaries,
	getFileDiagnostics,
	importWidgetState,
	recordDiagnostics,
	type PersistedWidgetState,
} from "../../clients/widget-state.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { removeTempDirSync } from "./test-utils.js";

const CHART = path.join("chart", "Chart.yaml");
const TEMPLATE = path.join("chart", "templates", "deploy-a.yaml");
// A second chart the SESSION never contains (#5044 r2 F2): #5067's
// `applyFindingPolicyByOwner` refuses to trust a cited owner outside the
// project root on the identity axis, so a cached reader must refuse its marks
// too. It lives beside the project, not under it.
const OUTSIDE_CHART = path.join("..", "outside", "Chart.yaml");
// One line, spelled identically in BOTH files, so a strict anchor's span half
// is equal across the files and ONLY the path component can tell the two
// findings apart.
const SHARED_LINE = "value: identical\n";
const SHARED_MSG = "chart name is required";
// Distinct-identity rows for the staleness / unreadable cells, where two
// marks of DIFFERENT flavors must be observable on two rows at once.
const WEAK_MSG = "missing icon field";
const STRICT_MSG = "deprecated apiVersion";

let baseDir: string;
let cwd: string;
let chartPath: string;
let templatePath: string;
let outsideChartPath: string;
let previousDataDir: string | undefined;

function writeProject(): void {
	fs.mkdirSync(path.join(cwd, "chart", "templates"), { recursive: true });
	fs.mkdirSync(path.dirname(outsideChartPath), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, CHART),
		`# chart\n${SHARED_LINE}apiVersion: v1\n`,
	);
	fs.writeFileSync(
		path.join(cwd, TEMPLATE),
		`# template\n${SHARED_LINE}other: 1\n`,
	);
	fs.writeFileSync(outsideChartPath, `# chart\n${SHARED_LINE}apiVersion: v1\n`);
}

/** The chart-level row helm-lint reports for Chart.yaml while the TEMPLATE is
 *  written — the exact raw shape `clients/pipeline.ts` records. */
function chartRow(
	message = SHARED_MSG,
	line = 2,
	semantic = "warning",
	severity = "warning",
	filePath = chartPath,
) {
	return {
		tool: "helm-lint",
		rule: "error",
		message,
		line,
		severity,
		semantic,
		filePath,
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

/** Move `filePath` past every observation taken before now, past
 *  `freshnessFromMtime`'s 50 ms drift tolerance: its current bytes are then a
 *  revision no cached row was observed against. */
function moveFileIntoFuture(filePath: string): void {
	const future = new Date(Date.now() + 60_000);
	fs.utimesSync(filePath, future, future);
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

async function modeDelta(): Promise<string> {
	const tool = createLensDiagnosticsTool(
		{ readCache: () => undefined } as never,
		() => cwd,
	);
	const out = (await tool.execute(
		"cache-5044-delta",
		{ mode: "delta" },
		new AbortController().signal,
		null,
		{ cwd },
	)) as { content: Array<{ text: string }> };
	return out.content.map((c) => c.text).join("\n");
}

/** How many times `text` rendered `message`. */
function rendered(text: string, message: string): number {
	return text.split(message).length - 1;
}

/** The widget's own projection of the record, the way the footer and the
 *  turn-end delivery read it: `blocking` counts and the LIVE rows only. */
function summaryFor(filePath: string) {
	return getFileDiagnosticSummaries().find((s) => s.filePath === filePath);
}

beforeEach(() => {
	baseDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5044-")),
	);
	cwd = path.join(baseDir, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	chartPath = path.join(cwd, CHART);
	templatePath = path.join(cwd, TEMPLATE);
	outsideChartPath = path.resolve(cwd, OUTSIDE_CHART);
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
	removeTempDirSync(baseDir);
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
		moveFileIntoFuture(chartPath);
		const text = await modeAll();
		expect(rendered(text, WEAK_MSG)).toBe(0);
		expect(rendered(text, STRICT_MSG)).toBe(1);
	});

	it("refuses both marks once the cited Chart.yaml is gone (#5067 parity)", async () => {
		// #5044 r2 (F2): a cited file this process cannot read is never trusted
		// to suppress anything, and the dispatch stack already refuses it —
		// `applyFindingPolicyByOwner` fails the same row closed (its
		// `readFileContent`/`isWithinIdentity` gate yields no content, so only
		// the rule policy applies). A cached reader that kept honoring the weak
		// mark here hid a finding the same agent saw in a full LSP sweep.
		recordDiagnostics(templatePath, [
			chartRow(WEAK_MSG, 1),
			chartRow(STRICT_MSG, 1),
		]);
		mark(chartPath, WEAK_MSG, 1, "suppress");
		mark(chartPath, STRICT_MSG, 1, "false-positive");
		fs.rmSync(chartPath);
		const text = await modeAll();
		expect(rendered(text, WEAK_MSG)).toBe(1);
		expect(rendered(text, STRICT_MSG)).toBe(1);
	});

	it("keeps the weak fallback for the record key's own file when it is unreadable", async () => {
		// The excluded default of the rule above, pinned so the cited-file
		// refusal cannot silently widen: the file the record is keyed on is the
		// file the session WROTE, and #1617 F1's documented fail-open (its rows
		// fall back to the intent-level weak filter when it turns unreadable)
		// still applies to them. A directory stands in for the deleted file, so
		// the record is still served (a missing file drops the whole record) and
		// only the content read fails — the same EACCES-shaped failure.
		recordDiagnostics(templatePath, [
			templateRow("own marked finding", 1),
			templateRow("own unmarked finding", 3),
		]);
		mark(templatePath, "own marked finding", 1, "suppress");
		fs.rmSync(templatePath);
		fs.mkdirSync(templatePath);
		const text = await modeAll();
		// The unmarked row proves the file is still being served at all, so the
		// 0 below cannot pass because the whole record disappeared.
		expect(rendered(text, "own unmarked finding")).toBe(1);
		expect(rendered(text, "own marked finding")).toBe(0);
	});

	it("refuses a mark on a cited file the project does not contain (#5067 parity)", async () => {
		// #5044 r2 (F2), the other half of #5067's owner check: a cited owner
		// outside `cwd` on the IDENTITY axis is not read at all, so its marks are
		// never consulted. The inside-root row is the positive control — same
		// message shape, same line, same file NAME, one path component away from
		// the project — so the outside assertion cannot pass because the mark
		// never matched anything.
		recordDiagnostics(templatePath, [
			chartRow("inside cited finding", 2),
			chartRow(
				"outside cited finding",
				2,
				"warning",
				"warning",
				outsideChartPath,
			),
		]);
		mark(chartPath, "inside cited finding", 2, "false-positive");
		mark(outsideChartPath, "outside cited finding", 2, "false-positive");
		const text = await modeAll();
		expect(rendered(text, "inside cited finding")).toBe(0);
		expect(rendered(text, "outside cited finding")).toBe(1);
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

	it("waits for a cited row's strict mark after its cited file moved", async () => {
		// #5044 r2 (F1): the cached reader has always refused to derive a STRICT
		// anchor from bytes NEWER than the row it matches (the mark hashes line 3
		// of the new revision, the row is line 2 of the superseded one, and two
		// identical line texts across a revision boundary are a coincidence, not
		// a finding's location). The widget reader re-derived the anchor from the
		// cited file's CURRENT bytes with no such gate, so one
		// `lens_diagnostic_mark` made a STOP-tier finding vanish from the footer
		// while `lens_diagnostics mode=all` still listed it. Both readers run the
		// one freshness gate now.
		recordDiagnostics(templatePath, [
			templateRow("template lint", 1, "warning", "warning"),
			chartRow(SHARED_MSG, 2, "blocking", "error"),
		]);
		// Chart.yaml is edited AFTER the row was observed, and its new line 3
		// holds the very text the finding was raised on: today's bytes still
		// contain that text, so a reader that ignores the revision boundary
		// "confirms" the mark against a line the finding never described.
		fs.writeFileSync(chartPath, `# chart\n${SHARED_LINE}${SHARED_LINE}`);
		moveFileIntoFuture(chartPath);
		mark(chartPath, SHARED_MSG, 3, "false-positive");
		// The tag lands on the next reconcile pass over the record that holds
		// the row, i.e. the next mark made on the template itself.
		mark(templatePath, "template lint", 1, "false-positive");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited).toBeDefined();
		expect(cited?.disposition).toBeUndefined();
		expect(summaryFor(templatePath)?.blocking).toBe(1);
		expect(
			summaryFor(templatePath)?.diagnostics.map((d) => d.message),
		).toContain(SHARED_MSG);
		// The cached reader refuses the same mark for the same reason, so the
		// two readers agree on the row the agent is told about.
		expect(rendered(await modeAll(), SHARED_MSG)).toBe(1);
	});

	it("keeps a cited row live under its weak mark once its file is deleted", () => {
		// #5044 r2 (F2): #5067's owner rule — a cited file that cannot be read
		// is never trusted to suppress anything, weak marks included, and
		// `applyFindingPolicyByOwner` fails it closed (kept=1). The widget pass
		// anchored on "" instead, which still let the WEAK suppress mark tag the
		// row and take it out of the footer's live projection. A `warning` row is
		// the population this bites: a weak mark can never hide a STOP-tier
		// finding (#1625 F1), so a blocking row would pass either way.
		recordDiagnostics(templatePath, [
			templateRow("template lint", 1, "warning", "warning"),
			chartRow(SHARED_MSG, 2, "warning", "warning"),
		]);
		mark(chartPath, SHARED_MSG, 2, "suppress");
		fs.rmSync(chartPath);
		mark(templatePath, "template lint", 1, "false-positive");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited).toBeDefined();
		expect(cited?.disposition).toBeUndefined();
		expect(
			summaryFor(templatePath)?.diagnostics.map((d) => d.message),
		).toContain(SHARED_MSG);
	});

	it("refuses a mark on a cited row whose file sits outside the project", () => {
		// #5044 r2 (F2), the identity-axis half of the same rule: `Chart.yaml`
		// beside the project is a file the session never contains, so neither
		// the dispatch stack nor a cached reader may treat its marks as intent
		// about a finding the project reported. The inside-root control above
		// ("tags the cited row from a false-positive mark made on Chart.yaml
		// itself") tags the identical row, so this cannot pass because the mark
		// never matched.
		recordDiagnostics(templatePath, [
			templateRow("template lint", 1, "warning", "warning"),
			chartRow(
				"outside cited finding",
				2,
				"blocking",
				"error",
				outsideChartPath,
			),
		]);
		mark(outsideChartPath, "outside cited finding", 2, "false-positive");
		mark(templatePath, "template lint", 1, "false-positive");
		const rows = getFileDiagnostics(templatePath) ?? [];
		const cited = rows.find((d) => d.citedFile !== undefined);
		expect(cited).toBeDefined();
		expect(cited?.disposition).toBeUndefined();
		expect(summaryFor(templatePath)?.blocking).toBe(1);
	});
});

describe("lens_diagnostics mode=delta counts carried findings on their own file (#5044)", () => {
	it("drops a cited finding its own file marked from the carried-over note", async () => {
		// The `delta` claim in the changelog: mode=delta's empty-delta
		// carried-over note reads the same widget store through the same
		// anchor seam, so a mark on the cited file removes its row from the
		// count the agent is pointed at — a mark on the TEMPLATE's own finding
		// must leave the cited row counted (covered above).
		recordDiagnostics(templatePath, [
			templateRow("own finding", 3),
			chartRow("cited finding", 2),
		]);
		mark(chartPath, "cited finding", 2, "suppress");
		const text = await modeDelta();
		expect(text).toContain("1 finding across 1 file carried over");
	});

	it("keeps a cited finding in the note under a mark on the record's own file", async () => {
		recordDiagnostics(templatePath, [
			templateRow("own finding", 3),
			chartRow("cited finding", 2),
		]);
		mark(templatePath, "own finding", 3, "suppress");
		const text = await modeDelta();
		expect(text).toContain("1 finding across 1 file carried over");
	});
});
