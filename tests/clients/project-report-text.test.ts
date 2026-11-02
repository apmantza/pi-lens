import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	_resetProjectReportBuildGuardForTests,
	collectLeafPaths,
	projectReport,
	renderTextProjectReport,
	type ProjectReport,
} from "../../clients/project-report.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	_setReviewGraphEntryBudgetForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// #5150 Round 2 (text-first project_report): strict per-section census for the
// default text cell. Every assertion below reads only the lines of the section
// it names — a directories/edges expectation matched against a file-path
// substring elsewhere in the text (the R1 weakness) cannot pass here, because
// each section contributes an exact line set that must equal the artifact's
// own rows in count and content.

const cleanups: Array<() => void> = [];
let previousDataDir: string | undefined;
beforeEach(() => {
	previousDataDir = process.env.PILENS_DATA_DIR;
});
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphBuildAttemptsForTests();
	_resetProjectReportBuildGuardForTests();
	_setReviewGraphEntryBudgetForTests();
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
});

function makeEnv(prefix = "pi-lens-preport-text2-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

/** Minimal hand-built `.git` — no git binary needed (mirrors
 * tests/clients/module-report-revision-drift.test.ts). */
function makeFakeRepo(root: string, headSha: string, branch = "main"): void {
	const gitDir = path.join(root, ".git");
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), `${headSha}\n`);
}

function setHead(root: string, headSha: string, branch = "main"): void {
	fs.writeFileSync(
		path.join(root, ".git", "refs", "heads", branch),
		`${headSha}\n`,
	);
}

async function buildCensusFixture(cwd: string) {
	createTempFile(
		cwd,
		"clients/hub.ts",
		[
			"export function hubFn(x) {",
			"  if (x > 0) {",
			"    return 1;",
			"  } else if (x < 0) {",
			"    return -1;",
			"  } else {",
			"    return 0;",
			"  }",
			"}",
		].join("\n"),
	);
	createTempFile(
		cwd,
		"clients/consumer.ts",
		"import { hubFn } from './hub';\nexport function run() { return hubFn(1); }\n",
	);
	createTempFile(
		cwd,
		"entry/main.ts",
		"import { run } from '../clients/consumer';\nexport function main() { return run(); }\n",
	);
	createTempFile(cwd, "isolated/dead.ts", "export const dead = 1;\n");
	// Asymmetric directory pair: dirA -> dirB carries two import edges,
	// dirB -> dirA one, so the census covers both a cycle and a violation row.
	createTempFile(
		cwd,
		"dirA/a.ts",
		"import { b } from '../dirB/b';\nexport const a = b;\n",
	);
	createTempFile(
		cwd,
		"dirA/a2.ts",
		"import { b } from '../dirB/b';\nexport const a2 = b;\n",
	);
	createTempFile(
		cwd,
		"dirB/b.ts",
		"import { a } from '../dirA/a';\nexport const b = a;\n",
	);
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

/** Lines under an exact header line, up to (excluding) the next header line.
 * A header is `NAME:` at column 0 or two-space-indented `  NAME:`; item lines
 * always start with `- ` (after indent), so no item can read as a header. */
function linesUnder(text: string, header: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(header);
	expect(
		start,
		`missing section header ${JSON.stringify(header)}`,
	).toBeGreaterThanOrEqual(0);
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^(  )?[A-Z][A-Z \-/]+:$/.test(line)) break;
		out.push(line);
	}
	return out;
}

function itemLines(sectionLines: string[], indent: string): string[] {
	return sectionLines.filter((line) => line.startsWith(`${indent}- `));
}

/** Top-level section body: breaks only on a column-0 header, so nested
 * subsections (indented headers) stay inside their parent. */
function topSectionLines(text: string, header: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(header);
	expect(
		start,
		`missing section header ${JSON.stringify(header)}`,
	).toBeGreaterThanOrEqual(0);
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^[A-Z][A-Z \-/]+:$/.test(line)) break;
		out.push(line);
	}
	return out;
}

// Checked-in census of artifact leaves the text cell renders (per-section
// assertions below prove the rendering; this list proves the totality). A new
// report field reds here until it is rendered or declared under UNRENDERED.
const RENDERED_LEAVES = new Set([
	"report.available",
	"report.hint",
	"report.lastBuildAttempt.when",
	"report.lastBuildAttempt.outcome",
	"report.lastBuildAttempt.reason",
	"report.lastBuildAttempt.buildId",
	"report.trust.graphBuiltAt",
	"report.trust.filesCovered",
	"report.trust.filesTotal",
	"report.trust.coverage",
	"report.trust.resolution.exact",
	"report.trust.resolution.import",
	"report.trust.resolution.receiverType",
	"report.trust.resolution.nameOnly",
	"report.trust.resolution.sampleSize",
	"report.trust.stale",
	"report.trust.revisionDrift",
	"report.trust.lowCoverage",
	"report.trust.persistCoverage",
	"report.trust.notes[]",
	"report.hubs[].file",
	"report.hubs[].fanIn",
	"report.hubs[].blastRadius",
	"report.hubs[].role",
	"report.entryPoints[].file",
	"report.entryPoints[].fanIn",
	"report.entryPoints[].fanOut",
	"report.subsystems.directories[]",
	"report.subsystems.edges[].from",
	"report.subsystems.edges[].to",
	"report.subsystems.edges[].count",
	"report.subsystems.cycles[].dirs[]",
	"report.subsystems.cycles[].edgeCount",
	"report.subsystems.violations[].from",
	"report.subsystems.violations[].to",
	"report.subsystems.violations[].count",
	"report.subsystems.violations[].dominantCount",
	"report.riskHotspots[].file",
	"report.riskHotspots[].fanIn",
	"report.riskHotspots[].maxComplexity",
	"report.riskHotspots[].score",
	"report.deadWeight.files[].file",
	"report.deadWeight.disclaimer",
]);

describe("projectReport — default text cell strict census (#5150 R2)", () => {
	it("renders every section from its own artifact rows", async () => {
		const env = makeEnv();
		await buildCensusFixture(env.tmpDir);
		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);

		const text = renderTextProjectReport(report);
		const lines = text.split("\n");
		expect(lines[0]).toBe(
			`project_report — ${report.trust!.filesCovered}/${report.trust!.filesTotal} ` +
				`files (${Math.round(report.trust!.coverage * 100)}% coverage), ` +
				`built ${report.trust!.graphBuiltAt}`,
		);

		// TRUST: exact header lines plus every non-staleness note.
		const trustLines = linesUnder(text, "TRUST:");
		const trust = report.trust!;
		expect(trustLines).toContain(`  built: ${trust.graphBuiltAt}`);
		expect(trustLines).toContain(
			`  coverage: ${trust.filesCovered}/${trust.filesTotal} ` +
				`(${Math.round(trust.coverage * 100)}%)`,
		);
		if (trust.resolution.sampleSize > 0) {
			expect(trustLines).toContain(
				`  resolution: exact ${Math.round(trust.resolution.exact * 100)}%, ` +
					`import ${Math.round(trust.resolution.import * 100)}%, ` +
					`receiver-type ${Math.round(trust.resolution.receiverType * 100)}%, ` +
					`name-only ${Math.round(trust.resolution.nameOnly * 100)}% ` +
					`(${trust.resolution.sampleSize} tagged edges)`,
			);
		}
		for (const note of trust.notes) {
			if (/^Graph is stale:/.test(note)) continue; // owned by STALENESS
			expect(trustLines).toContain(`  note: ${note}`);
		}

		// HUBS: one exact line per hub, and no more.
		const hubLines = itemLines(linesUnder(text, "HUBS:"), "  ");
		expect(hubLines).toHaveLength(report.hubs!.length);
		for (const h of report.hubs!) {
			const role = h.role ? ` — ${h.role}` : "";
			expect(hubLines).toContain(
				`  - ${h.file}${role}; ${h.fanIn} importer(s), blast radius ${h.blastRadius}`,
			);
		}

		// ENTRY POINTS: one exact line per entry point, and no more.
		const entryLines = itemLines(linesUnder(text, "ENTRY POINTS:"), "  ");
		expect(entryLines).toHaveLength(report.entryPoints!.length);
		for (const e of report.entryPoints!) {
			expect(entryLines).toContain(`  - ${e.file}; fan-out ${e.fanOut}`);
		}

		// SUBSYSTEMS: directories list and edges list are their own
		// subsections — membership is proven here, not via substrings.
		const subsystems = topSectionLines(text, "SUBSYSTEMS:");
		expect(subsystems).toContain("  DIRECTORIES:");
		expect(subsystems).toContain("  EDGES:");
		const dirLines = itemLines(linesUnder(text, "  DIRECTORIES:"), "    ");
		expect(dirLines.map((l) => l.slice("    - ".length)).sort()).toEqual(
			[...report.subsystems!.directories].sort(),
		);
		const edgeLines = itemLines(linesUnder(text, "  EDGES:"), "    ");
		expect(edgeLines).toHaveLength(report.subsystems!.edges.length);
		for (const edge of report.subsystems!.edges) {
			expect(edgeLines).toContain(
				`    - ${edge.from} -> ${edge.to} (${edge.count} edge(s))`,
			);
		}
		const cycleLines = itemLines(linesUnder(text, "  CYCLES:"), "    ");
		expect(cycleLines).toHaveLength(report.subsystems!.cycles.length);
		for (const cycle of report.subsystems!.cycles) {
			expect(cycleLines).toContain(
				`    - ${cycle.dirs.join(" <-> ")} (${cycle.edgeCount} edges)`,
			);
		}
		const violationLines = itemLines(
			linesUnder(text, "  LAYERING VIOLATIONS:"),
			"    ",
		);
		expect(violationLines).toHaveLength(report.subsystems!.violations.length);
		for (const v of report.subsystems!.violations) {
			expect(violationLines).toContain(
				`    - ${v.from} -> ${v.to} (${v.count} edge(s), ` +
					`against ${v.to} -> ${v.from} ${v.dominantCount} edge(s))`,
			);
		}
		// The asymmetric dirA/dirB pair must produce both a cycle and a
		// violation — otherwise the subsections above assert over empty lists.
		expect(report.subsystems!.cycles.length).toBeGreaterThan(0);
		expect(report.subsystems!.violations.length).toBeGreaterThan(0);

		// RISK HOTSPOTS: one exact line per hotspot, and no more.
		const hotspotLines = itemLines(linesUnder(text, "RISK HOTSPOTS:"), "  ");
		expect(hotspotLines).toHaveLength(report.riskHotspots!.length);
		for (const r of report.riskHotspots!) {
			expect(hotspotLines).toContain(
				`  - ${r.file}; fan-in ${r.fanIn} x max complexity ` +
					`${r.maxComplexity} = ${r.score}`,
			);
		}

		// DEAD WEIGHT: disclaimer line plus one exact line per file.
		const deadLines = linesUnder(text, "DEAD WEIGHT:");
		expect(deadLines).toContain(
			`  disclaimer: ${report.deadWeight!.disclaimer}`,
		);
		const deadFiles = itemLines(deadLines, "  ");
		expect(deadFiles).toHaveLength(report.deadWeight!.files.length);
		for (const d of report.deadWeight!.files) {
			expect(deadFiles).toContain(`  - ${d.file}`);
		}

		// LAST BUILD: outcome, stamp, and reason travel when recorded.
		const buildLines = linesUnder(text, "LAST BUILD:");
		const attempt = report.lastBuildAttempt!;
		expect(attempt).toBeDefined();
		const reason = attempt.reason ? ` — ${attempt.reason}` : "";
		const buildId =
			attempt.buildId !== undefined ? ` (build ${attempt.buildId})` : "";
		expect(buildLines).toContain(
			`  ${attempt.outcome} ${attempt.when}${reason}${buildId}`,
		);

		// Fresh graph: no STALENESS block, and no stale sentence anywhere.
		expect(lines).not.toContain("STALENESS:");
		expect(text).not.toMatch(/^Graph is stale:/m);
	});

	it("partitions staleness into its own trailing block", () => {
		const staleNote =
			"Graph is stale: built 99m ago. Sections below may miss it.";
		const report = {
			available: true,
			trust: {
				graphBuiltAt: "2026-01-01T00:00:00.000Z",
				filesCovered: 2,
				filesTotal: 2,
				coverage: 1,
				resolution: {
					exact: 1,
					import: 0,
					receiverType: 0,
					nameOnly: 0,
					sampleSize: 4,
				},
				stale: true,
				lowCoverage: false,
				notes: ["a coverage note", staleNote],
			},
			hubs: [],
			entryPoints: [],
			subsystems: { directories: [], edges: [], cycles: [], violations: [] },
			riskHotspots: [],
			deadWeight: { files: [], disclaimer: "low confidence" },
		} as unknown as ProjectReport;
		const text = renderTextProjectReport(report);
		const trustLines = linesUnder(text, "TRUST:");
		expect(trustLines).toContain("  note: a coverage note");
		expect(trustLines.find((l) => l.includes("99m ago"))).toBeUndefined();
		const stalenessLines = linesUnder(text, "STALENESS:");
		expect(stalenessLines).toContain(`  - ${staleNote}`);
		// Trailing block: after LAST BUILD, with only UNRENDERED following it.
		const all = text.split("\n");
		expect(all.indexOf("STALENESS:")).toBeGreaterThan(
			all.indexOf("LAST BUILD:"),
		);
		expect(all[all.length - 1].startsWith("UNRENDERED:")).toBe(true);
	});

	it("routes the real stale producer's note into the STALENESS block", async () => {
		// #5150 R2 hardening: drive the real computeTrust producer (a graph whose
		// builtAt is past the staleness threshold) instead of hand-planting the
		// note, so a producer-wording edit cannot silently move staleness back
		// inline into TRUST with no red.
		const env = makeEnv();
		await buildCensusFixture(env.tmpDir);
		const graph = getCachedReviewGraph(env.tmpDir);
		expect(graph).toBeDefined();
		graph!.builtAt = new Date(Date.now() - 99 * 60_000).toISOString();

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.trust!.stale).toBe(true);
		const staleNote = report.trust!.notes.find((note) =>
			note.startsWith("Graph is stale:"),
		);
		expect(staleNote, "producer emitted no stale note").toBeDefined();

		const text = renderTextProjectReport(report);
		expect(linesUnder(text, "TRUST:")).not.toContain(`  note: ${staleNote}`);
		expect(linesUnder(text, "STALENESS:")).toContain(`  - ${staleNote}`);
		expect(text.split("\n").at(-1)?.startsWith("UNRENDERED:")).toBe(true);
	});

	it("routes revision drift into the STALENESS block, not TRUST", async () => {
		// #1961 drift: a served snapshot stamped at another HEAD gets its own
		// note. The census above lists `report.trust.revisionDrift`, so drive the
		// real producer here (fake repo + HEAD move, as
		// tests/clients/module-report-revision-drift.test.ts does) instead of
		// leaving the leaf named but never rendered.
		const env = makeEnv("pi-lens-preport-text2-drift-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		makeFakeRepo(env.tmpDir, "a".repeat(40));
		await buildCensusFixture(env.tmpDir);
		flushReviewGraphPersistsForTests();
		await waitForReviewGraphPersistsForTests();
		expect(
			fs.existsSync(
				path.join(
					getProjectDataDir(env.tmpDir),
					"cache",
					"review-graph.json.gz",
				),
			),
		).toBe(true);

		// A plain commit: HEAD moves, files are untouched. The snapshot is served
		// (that is #1961's fix) and the caveat must travel with it.
		setHead(env.tmpDir, "b".repeat(40));
		clearReviewGraphWorkspaceCache();

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.trust!.revisionDrift).toEqual({
			stampedHead: "a".repeat(40),
			currentHead: "b".repeat(40),
		});
		const driftNote = report.trust!.notes.find((note) =>
			note.startsWith("Graph was built at commit"),
		);
		expect(driftNote, "producer emitted no drift note").toBeDefined();

		const text = renderTextProjectReport(report);
		expect(linesUnder(text, "TRUST:")).not.toContain(`  note: ${driftNote}`);
		expect(linesUnder(text, "STALENESS:")).toContain(`  - ${driftNote}`);
	});

	it("declares every unrendered leaf in UNRENDERED and renders the rest", async () => {
		const env = makeEnv();
		await buildCensusFixture(env.tmpDir);
		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		const text = renderTextProjectReport(report);

		const leaves: string[] = [];
		collectLeafPaths(report, "report", leaves);
		const unrendered = leaves.filter((leaf) => !RENDERED_LEAVES.has(leaf));
		// Only navigation-hint repeats and the rendering echo may stay unnamed
		// in the sections above.
		expect(unrendered.sort()).toEqual(
			leaves
				.filter(
					(leaf) =>
						/(^|\.)suggestedNext\.(tool|path)$/.test(leaf) ||
						leaf === "report.view",
				)
				.sort(),
		);

		const unrenderedLine = text
			.split("\n")
			.find((line) => line.startsWith("UNRENDERED:"));
		expect(unrenderedLine).toBeDefined();
		const declared = unrenderedLine!
			.replace(/^UNRENDERED:\s*/, "")
			.split(" (")[0]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.sort();
		const expand = (token: string): string[] =>
			token === "view"
				? ["report.view"]
				: leaves.filter((leaf) => leaf.endsWith(`.${token}`));
		expect(declared.flatMap(expand).sort()).toEqual(unrendered);
	});

	it("renders the entry-budget-truncated graph as a partial note under TRUST", async () => {
		const env = makeEnv("pi-lens-preport-text-partial-");
		// The `.git` marker and `src` spend two entries, so 4 leaves room for two
		// files; at 2 both counts were 0 and a note dropping one still passed.
		_setReviewGraphEntryBudgetForTests(4);
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
		createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;\n");
		createTempFile(env.tmpDir, "src/c.ts", "export const c = 3;\n");
		await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.trust?.persistCoverage?.sourceFilesTruncated).toBe(true);
		const text = renderTextProjectReport(report);
		const note = linesUnder(text, "TRUST:").find((line) =>
			line.includes("Partial source walk"),
		);
		expect(note).toBe(
			"  note: Partial source walk: at least 2 source files were represented " +
				"before the visited-entry budget stopped enumeration; 2 files are in this graph.",
		);
	});

	it("ignores unknown fields instead of breaking (planted-key control)", async () => {
		const env = makeEnv();
		await buildCensusFixture(env.tmpDir);
		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);

		const baseline = renderTextProjectReport(report);
		const planted = renderTextProjectReport({
			...report,
			bogusField: "zz-planted-unknown-key",
		} as typeof report);
		expect(planted).toBe(baseline);
		expect(planted).not.toContain("zz-planted-unknown-key");
	});

	it("renders an unavailable report without throwing", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		const cold = await projectReport(env.tmpDir);
		expect(cold.available).toBe(false);
		const text = renderTextProjectReport(cold);
		expect(text).toContain("unavailable");
		if (cold.hint) expect(text).toContain(cold.hint);
	});
});
