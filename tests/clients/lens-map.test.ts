import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aggregateGraphToFiles,
	computeLayout,
	generateLensMap,
	parseUntrackedIgnoredOutput,
	renderMapHtml,
	type FileMapEdge,
	type FileMapNode,
	type LensMapPayload,
} from "../../clients/lens-map.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import type {
	ReviewGraph,
	ReviewGraphEdge,
	ReviewGraphNode,
} from "../../clients/review-graph/types.js";

// aggregateGraphToFiles keys files via normalizeMapKey (same as the rest of the
// review-graph stack) — on Windows that resolves a relative path like "a.ts"
// against cwd and lowercases it, so tests compare against the SAME
// normalization rather than hardcoding a platform-specific literal.
const idFor = (p: string) => normalizeMapKey(p);

/** Build a minimal ReviewGraph from nodes + edges (mirrors
 * tests/clients/review-graph/transitive-impact.test.ts's makeGraph). */
function makeGraph(
	nodes: ReviewGraphNode[],
	edges: ReviewGraphEdge[],
): ReviewGraph {
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));
	const edgesByTo = new Map<string, ReviewGraphEdge[]>();
	const edgesByFrom = new Map<string, ReviewGraphEdge[]>();
	for (const edge of edges) {
		(edgesByTo.get(edge.to) ?? edgesByTo.set(edge.to, []).get(edge.to))?.push(
			edge,
		);
		(
			edgesByFrom.get(edge.from) ??
			edgesByFrom.set(edge.from, []).get(edge.from)
		)?.push(edge);
	}
	return {
		version: "v4",
		builtAt: new Date().toISOString(),
		nodes: nodeMap,
		edges,
		edgesByFrom,
		edgesByTo,
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

describe("aggregateGraphToFiles", () => {
	it("collapses symbol nodes to file nodes and dedupes/weights symbol edges to file edges", () => {
		const nodes: ReviewGraphNode[] = [
			{ id: "a#file", kind: "file", language: "ts", filePath: "a.ts" },
			{ id: "b#file", kind: "file", language: "ts", filePath: "b.ts" },
			{
				id: "a#foo",
				kind: "symbol",
				language: "ts",
				filePath: "a.ts",
				symbolName: "foo",
			},
			{
				id: "a#bar",
				kind: "symbol",
				language: "ts",
				filePath: "a.ts",
				symbolName: "bar",
			},
			{
				id: "b#baz",
				kind: "symbol",
				language: "ts",
				filePath: "b.ts",
				symbolName: "baz",
			},
		];
		const edges: ReviewGraphEdge[] = [
			// Two distinct symbol-level calls from a.ts's symbols into b.ts's
			// symbol — must collapse to ONE a.ts -> b.ts edge with weight 2.
			{ from: "a#foo", to: "b#baz", kind: "calls" },
			{ from: "a#bar", to: "b#baz", kind: "calls" },
			// Same-file edges (contains/defines) must be dropped, not counted.
			{ from: "a#file", to: "a#foo", kind: "contains" },
			{ from: "a#file", to: "a#bar", kind: "defines" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges));

		expect(result.nodes.map((n) => n.id).sort()).toEqual(
			[idFor("a.ts"), idFor("b.ts")].sort(),
		);
		const aNode = result.nodes.find((n) => n.id === idFor("a.ts"));
		expect(aNode?.symbolCount).toBe(2);
		expect(aNode?.outDegree).toBe(1);
		const bNode = result.nodes.find((n) => n.id === idFor("b.ts"));
		expect(bNode?.inDegree).toBe(1);
		expect(bNode?.symbolCount).toBe(1);

		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			from: idFor("a.ts"),
			to: idFor("b.ts"),
			weight: 2,
		});
		expect(result.truncated).toBe(false);
		expect(result.externalCount).toBe(0);
		expect(result.testFileCount).toBe(0);
		expect(result.compiledTwinCount).toBe(0);
		expect(result.ignoredFileCount).toBe(0);
	});

	it("drops untracked-gitignored files via excludeIds — unless a surviving twin merge rescues them", () => {
		const nodes: ReviewGraphNode[] = [
			// Tracked source — stays (not in excludeIds).
			{ id: "a.ts#file", kind: "file", language: "ts", filePath: "a.ts" },
			// Ignored orphan: gitignored compiled file with NO source twin in
			// the graph — must vanish along with its edges.
			{
				id: "orphan#file",
				kind: "file",
				language: "js",
				filePath: "orphan.js",
			},
			{
				id: "orphan#sym",
				kind: "symbol",
				language: "js",
				filePath: "orphan.js",
				symbolName: "leftover",
			},
			// Ignored compiled file WITH a surviving .ts twin: the twin merge
			// takes precedence — merged (edges preserved), not dropped.
			{ id: "b.js#file", kind: "file", language: "js", filePath: "b.js" },
			{ id: "b.ts#file", kind: "file", language: "ts", filePath: "b.ts" },
			// Tracked vendored .js (matches a .gitignore pattern but is
			// TRACKED, so git never reports it ignored → not in excludeIds).
			{
				id: "vendored#file",
				kind: "file",
				language: "js",
				filePath: "vendored.js",
			},
		];
		const edges: ReviewGraphEdge[] = [
			// Edges touching the ignored orphan — must disappear with it.
			{ from: "a.ts#file", to: "orphan#file", kind: "imports" },
			{ from: "orphan#file", to: "vendored#file", kind: "imports" },
			// The ignored-but-twinned b.js's edge — must survive, remapped to b.ts.
			{ from: "b.js#file", to: "a.ts#file", kind: "imports" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges), {
			excludeIds: new Set([idFor("orphan.js"), idFor("b.js")]),
		});

		const ids = result.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(
			[idFor("a.ts"), idFor("b.ts"), idFor("vendored.js")].sort(),
		);
		expect(result.nodes.some((n) => n.id === idFor("orphan.js"))).toBe(false);
		expect(result.nodes.some((n) => n.id === idFor("b.js"))).toBe(false);

		// Only the orphan counts as ignored; b.js was rescued by the twin
		// merge and counts as a twin instead.
		expect(result.ignoredFileCount).toBe(1);
		expect(result.compiledTwinCount).toBe(1);

		// Both orphan edges are gone; b.js -> a.ts survives remapped.
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			from: idFor("b.ts"),
			to: idFor("a.ts"),
			weight: 1,
		});

		// Ranking inputs reflect the post-exclusion world: a.ts's only degree
		// is the incoming b.ts edge (its edge to the dropped orphan is gone).
		const aNode = result.nodes.find((n) => n.id === idFor("a.ts"));
		expect(aNode?.outDegree).toBe(0);
		expect(aNode?.inDegree).toBe(1);
	});

	it("merges compiled .js twins onto their .ts sources: nodes, symbols, and edges remap; self-edges collapse", () => {
		const nodes: ReviewGraphNode[] = [
			// a.ts is the source, with its own symbol; a.js is the compiled twin.
			{ id: "a.ts#file", kind: "file", language: "ts", filePath: "a.ts" },
			{
				id: "a.ts#foo",
				kind: "symbol",
				language: "ts",
				filePath: "a.ts",
				symbolName: "foo",
			},
			{ id: "a.js#file", kind: "file", language: "js", filePath: "a.js" },
			{
				id: "a.js#foo",
				kind: "symbol",
				language: "js",
				filePath: "a.js",
				symbolName: "foo",
			},
			// b.js is compiled; b.ts exists as its source twin.
			{ id: "b.js#file", kind: "file", language: "js", filePath: "b.js" },
			{ id: "b.ts#file", kind: "file", language: "ts", filePath: "b.ts" },
			// vendored.js has NO source twin — must be kept as-is.
			{
				id: "vendored#file",
				kind: "file",
				language: "js",
				filePath: "vendored.js",
			},
		];
		const edges: ReviewGraphEdge[] = [
			// The compiled-twin import edge: must become b.ts -> a.ts.
			{ from: "b.js#file", to: "a.js#file", kind: "imports" },
			// Becomes self-referential after canonicalization (a.js -> a.ts):
			// must be dropped like any other same-file edge.
			{ from: "a.js#file", to: "a.ts#foo", kind: "imports" },
			// vendored.js -> a.js: endpoint canonicalizes, edge survives remapped.
			{ from: "vendored#file", to: "a.js#file", kind: "imports" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges));

		const ids = result.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(
			[idFor("a.ts"), idFor("b.ts"), idFor("vendored.js")].sort(),
		);
		expect(result.nodes.some((n) => n.id === idFor("a.js"))).toBe(false);
		expect(result.nodes.some((n) => n.id === idFor("b.js"))).toBe(false);
		expect(result.compiledTwinCount).toBe(2); // a.js + b.js merged

		// The b.js -> a.js edge remapped to b.ts -> a.ts; the post-canonical
		// self-edge (a.js -> a.ts) is gone; vendored.js's edge remapped too.
		expect(result.edges).toHaveLength(2);
		expect(result.edges).toContainEqual({
			from: idFor("b.ts"),
			to: idFor("a.ts"),
			weight: 1,
		});
		expect(result.edges).toContainEqual({
			from: idFor("vendored.js"),
			to: idFor("a.ts"),
			weight: 1,
		});

		// Symbol counts merge: a.ts's own symbol + the twin a.js's symbol.
		const aNode = result.nodes.find((n) => n.id === idFor("a.ts"));
		expect(aNode?.symbolCount).toBe(2);
		// The merged node keeps the SOURCE file's language.
		expect(aNode?.language).toBe("ts");
	});

	it("excludes test files (and their edges) from the map, counts them, and keeps ranking untainted", () => {
		const nodes: ReviewGraphNode[] = [
			{ id: "a#file", kind: "file", language: "ts", filePath: "a.ts" },
			{
				id: "foo.test#file",
				kind: "file",
				language: "ts",
				filePath: "foo.test.ts",
			},
			{
				id: "foo.test#sym",
				kind: "symbol",
				language: "ts",
				filePath: "foo.test.ts",
				symbolName: "itWorks",
			},
			// Non-test file with "test" merely in its name/dir — must be KEPT
			// (detectFileRole's ".test."/"/test/" patterns require an exact
			// segment match, not a bare substring).
			{
				id: "contest#file",
				kind: "file",
				language: "ts",
				filePath: "contest.ts",
			},
		];
		const edges: ReviewGraphEdge[] = [
			// a.ts -> foo.test.ts: must disappear along with the excluded node.
			{ from: "a#file", to: "foo.test#file", kind: "imports" },
			{ from: "a#file", to: "contest#file", kind: "imports" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges));

		const ids = result.nodes.map((n) => n.id).sort();
		expect(ids).toEqual([idFor("a.ts"), idFor("contest.ts")].sort());
		expect(result.nodes.some((n) => n.id === idFor("foo.test.ts"))).toBe(
			false,
		);
		expect(result.testFileCount).toBe(1);

		// The edge into the excluded test file is gone; only the a->contest
		// edge survives.
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]).toMatchObject({
			from: idFor("a.ts"),
			to: idFor("contest.ts"),
		});

		// Ranking (degree) must be computed AFTER exclusion: a.ts's outDegree
		// only counts the surviving contest.ts edge, not the dropped test edge.
		const aNode = result.nodes.find((n) => n.id === idFor("a.ts"));
		expect(aNode?.outDegree).toBe(1);
	});

	it("excludes external kind nodes from the map but counts them", () => {
		const nodes: ReviewGraphNode[] = [
			{ id: "a#file", kind: "file", language: "ts", filePath: "a.ts" },
			{
				id: "a#foo",
				kind: "symbol",
				language: "ts",
				filePath: "a.ts",
				symbolName: "foo",
			},
			{ id: "external:lodash", kind: "external", language: "ts" },
			{ id: "external:react", kind: "external", language: "ts" },
		];
		const edges: ReviewGraphEdge[] = [
			{ from: "a#file", to: "external:lodash", kind: "imports" },
			{ from: "a#file", to: "external:react", kind: "imports" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges));

		expect(result.nodes.map((n) => n.id)).toEqual([idFor("a.ts")]);
		expect(result.edges).toHaveLength(0);
		expect(result.externalCount).toBe(2);
	});

	it("computes transitive dependents over the rendered file graph", () => {
		// c.ts -> b.ts -> a.ts (file-level imports chain)
		const nodes: ReviewGraphNode[] = [
			{ id: "a#file", kind: "file", language: "ts", filePath: "a.ts" },
			{ id: "b#file", kind: "file", language: "ts", filePath: "b.ts" },
			{ id: "c#file", kind: "file", language: "ts", filePath: "c.ts" },
		];
		const edges: ReviewGraphEdge[] = [
			{ from: "b#file", to: "a#file", kind: "imports" },
			{ from: "c#file", to: "b#file", kind: "imports" },
		];

		const result = aggregateGraphToFiles(makeGraph(nodes, edges));
		const aNode = result.nodes.find((n) => n.id === idFor("a.ts"));
		// b.ts (direct) + c.ts (transitive) both depend on a.ts.
		expect(aNode?.dependents).toBe(2);
		const cNode = result.nodes.find((n) => n.id === idFor("c.ts"));
		expect(cNode?.dependents).toBe(0);
	});

	it("truncates to the highest-degree files and sets truncated:true", () => {
		// hub.ts is imported by every leaf; leaves have degree 1, hub has degree 5.
		const nodes: ReviewGraphNode[] = [
			{ id: "hub#file", kind: "file", language: "ts", filePath: "hub.ts" },
		];
		const edges: ReviewGraphEdge[] = [];
		for (let i = 0; i < 5; i += 1) {
			const id = `leaf${i}.ts`;
			nodes.push({
				id: `leaf${i}#file`,
				kind: "file",
				language: "ts",
				filePath: id,
			});
			edges.push({ from: `leaf${i}#file`, to: "hub#file", kind: "imports" });
		}

		const result = aggregateGraphToFiles(makeGraph(nodes, edges), {
			maxNodes: 3,
		});

		expect(result.truncated).toBe(true);
		expect(result.nodes).toHaveLength(3);
		// hub.ts has the highest degree (5) and must survive the cut.
		expect(result.nodes.some((n) => n.id === idFor("hub.ts"))).toBe(true);
	});
});

describe("computeLayout", () => {
	const nodes: FileMapNode[] = [
		{
			id: "a.ts",
			path: "a.ts",
			language: "ts",
			symbolCount: 1,
			inDegree: 0,
			outDegree: 1,
			dependents: 0,
		},
		{
			id: "b.ts",
			path: "b.ts",
			language: "ts",
			symbolCount: 1,
			inDegree: 1,
			outDegree: 1,
			dependents: 1,
		},
		{
			id: "c.ts",
			path: "c.ts",
			language: "ts",
			symbolCount: 1,
			inDegree: 1,
			outDegree: 0,
			dependents: 2,
		},
	];
	const edges: FileMapEdge[] = [
		{ from: "a.ts", to: "b.ts", weight: 1 },
		{ from: "b.ts", to: "c.ts", weight: 2 },
	];

	it("is deterministic: identical input produces identical positions", () => {
		const first = computeLayout(nodes, edges, { iterations: 60 });
		const second = computeLayout(nodes, edges, { iterations: 60 });
		expect(second).toEqual(first);
	});

	it("produces only finite coordinates", () => {
		const layout = computeLayout(nodes, edges, { iterations: 60 });
		expect(layout).toHaveLength(3);
		for (const point of layout) {
			expect(Number.isFinite(point.x)).toBe(true);
			expect(Number.isFinite(point.y)).toBe(true);
		}
	});

	it("handles an empty node list without error", () => {
		expect(computeLayout([], [])).toEqual([]);
	});
});

describe("renderMapHtml", () => {
	function payload(overrides: Partial<LensMapPayload> = {}): LensMapPayload {
		return {
			generatedAt: new Date(0).toISOString(),
			projectLabel: "demo",
			fileCount: 1,
			edgeCount: 0,
			externalCount: 0,
			testFileCount: 0,
			compiledTwinCount: 0,
			ignoredFileCount: 0,
			truncated: false,
			maxNodes: 500,
			width: 1600,
			height: 1200,
			nodes: [
				{
					id: "a.ts",
					path: "a.ts",
					language: "ts",
					symbolCount: 1,
					inDegree: 0,
					outDegree: 0,
					dependents: 0,
					x: 100,
					y: 100,
				},
			],
			edges: [],
			...overrides,
		};
	}

	it("escapes a malicious file name so it cannot break out of the JSON script tag", () => {
		const malicious = '</script><img src=x onerror=alert(1)>';
		const html = renderMapHtml(
			payload({
				nodes: [
					{
						id: malicious,
						path: malicious,
						language: "ts",
						symbolCount: 0,
						inDegree: 0,
						outDegree: 0,
						dependents: 0,
						x: 0,
						y: 0,
					},
				],
			}),
		);
		expect(html).not.toContain("</script><img");
		expect(html).toContain("\\u003c/script\\u003e");
	});

	it("contains the strict CSP meta tag and both light/dark accent colors", () => {
		const html = renderMapHtml(payload());
		expect(html).toContain('http-equiv="Content-Security-Policy"');
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("#2563eb");
		expect(html).toContain("#60a5fa");
	});

	it("never string-concatenates the CDN/script-src into an external host", () => {
		const html = renderMapHtml(payload());
		expect(html).not.toMatch(/script-src[^"]*https?:/);
	});

	// Deep interaction testing (typing in the search box, dragging the slider,
	// clicking nodes) is deliberately NOT done here — the viewer script targets
	// a real browser (SVG + pointer events), not jsdom. These assertions pin
	// the static contract: the controls exist exactly once and the script
	// composes visibility through the single recomputeVisibility pass.
	it("renders the four interaction controls exactly once each, wired through one visibility pass", () => {
		const html = renderMapHtml(payload());
		for (const id of [
			"search-input",
			"weight-slider",
			"trace-toggle",
			"trace-status",
		]) {
			expect(html.split(`id="${id}"`).length - 1).toBe(1);
		}
		expect(html).toContain("recomputeVisibility");
	});

	it("emits a syntactically valid viewer script", () => {
		const html = renderMapHtml(payload());
		// indexOf slicing, not a tag regex: we're extracting OUR OWN generated
		// markup (exactly one bare lowercase `<script>` block — asserted below),
		// not filtering untrusted HTML. A regex here trips CodeQL's
		// js/bad-tag-filter (regexes that look like sanitizers must handle
		// `<SCRIPT>`/attributes), which doesn't apply to extraction but is
		// cheap to avoid outright.
		expect(html.split("<script>").length - 1).toBe(1);
		const open = html.indexOf("<script>") + "<script>".length;
		const close = html.indexOf("</script>", open);
		expect(close).toBeGreaterThan(open);
		const body = html.slice(open, close);
		// new Function PARSES the body without executing it — a syntax error
		// (e.g. a stray template-literal escape) throws here.
		expect(() => new Function(body)).not.toThrow();
	});

	it("renders fine for a tiny graph (fewer nodes than the client-side top-25 label set)", () => {
		const tinyNodes = ["x.ts", "y.ts", "z.ts"].map((p, i) => ({
			id: p,
			path: p,
			language: "ts",
			symbolCount: i,
			inDegree: 0,
			outDegree: 0,
			dependents: i,
			x: 100 + i,
			y: 100 + i,
		}));
		const html = renderMapHtml(payload({ fileCount: 3, nodes: tinyNodes }));
		expect(html).toContain("lens-map-payload");
		expect(html).toContain("recomputeVisibility");
	});
});

// The git integration itself (spawn) is deliberately NOT mocked here: a
// module-wide vi.mock of safe-spawn would also intercept the review-graph
// build's own git calls in the end-to-end generateLensMap test below. The
// spawn wrapper is a thin try/catch around safeSpawnAsync; the testable
// logic (line split, excluded-dir pruning, normalization) lives in this
// exported pure helper.
describe("parseUntrackedIgnoredOutput", () => {
	it("parses repo-relative lines into normalized ids, skipping blanks and excluded-dir paths", () => {
		const cwd = process.cwd();
		const stdout = [
			"clients/orphan.js",
			"", // blank line — skipped
			"node_modules/lodash/index.js", // excluded dir — pruned pre-normalize
			"dist/bundle.js", // excluded dir — pruned pre-normalize
			"scripts/tmp-probe.mjs",
		].join("\n");

		const ids = parseUntrackedIgnoredOutput(stdout, cwd);

		// The helper normalizes cwd-joined ABSOLUTE paths — the expectation must
		// do the same. `idFor` on a bare relative path only happened to match on
		// Windows (where normalizeFilePath realpath-resolves relative input
		// against cwd); on POSIX it returns the relative string unchanged, so
		// the two forms never compare equal (the CI-only failure this comment
		// guards against).
		const absIdFor = (p: string) => normalizeMapKey(path.join(cwd, p));
		expect(ids.has(absIdFor("clients/orphan.js"))).toBe(true);
		expect(ids.has(absIdFor("scripts/tmp-probe.mjs"))).toBe(true);
		expect(ids.size).toBe(2);
	});

	it("returns an empty set for empty output", () => {
		expect(parseUntrackedIgnoredOutput("", process.cwd()).size).toBe(0);
	});
});

describe("generateLensMap", () => {
	let tmpDir: string;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-map-"));
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes a self-contained HTML file under the project data dir's reports/ folder", async () => {
		const projectDir = path.join(tmpDir, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "a.ts"),
			"export function foo() { return 1; }\n",
			"utf-8",
		);

		const result = await generateLensMap(projectDir);

		expect(fs.existsSync(result.filePath)).toBe(true);
		expect(result.filePath.replace(/\\/g, "/")).toMatch(
			/\/reports\/lens-map\.html$/,
		);
		const html = fs.readFileSync(result.filePath, "utf-8");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("lens-map-payload");
	});
});
