/**
 * `/lens-map` (#679) — a human-facing, self-contained interactive HTML project
 * map rendered from the existing review graph. Zero external dependencies: the
 * force-directed layout is computed here in Node at generation time (a simple
 * deterministic simulation), and the client side is just an embedded JSON
 * payload rendered by vanilla JS into an SVG (pan/zoom/hover/click) — no CDN
 * script, no npm deps, nothing fetched at view time.
 *
 * The review graph is symbol-level; this file aggregates it to FILE-level
 * nodes (the unit humans actually want to see on a map) and file→file edges
 * (deduped, weighted by how many underlying symbol edges they represent).
 * "external" kind nodes (third-party/stdlib import targets) are excluded from
 * the map outright — their count is surfaced in the header instead.
 *
 * Human-only surface: no agent tool, no MCP mirror. See index.ts's `lens-map`
 * command registration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { FactStore } from "./dispatch/fact-store.js";
import { getProjectDataDir } from "./file-utils.js";
import { normalizeMapKey } from "./path-utils.js";
import { buildOrUpdateGraph } from "./review-graph/service.js";
import type { ReviewGraph } from "./review-graph/types.js";
import { detectFileRole } from "./file-role.js";

// ── Aggregation: symbol-level review graph -> file-level map ────────────────

export interface FileMapNode {
	/** Normalized (forward-slashed) file path — stable identity across nodes/edges. */
	id: string;
	/** Display path; cwd-relative when generated via `generateLensMap`, else the raw id. */
	path: string;
	language: string;
	symbolCount: number;
	/** Count of DISTINCT files this file has an outgoing edge to (post-truncation). */
	outDegree: number;
	/** Count of DISTINCT files that have an outgoing edge to this file (post-truncation). */
	inDegree: number;
	/** Transitive dependents (files that depend on this one, directly or indirectly),
	 * computed over the (possibly truncated) rendered file graph — "how load-bearing". */
	dependents: number;
}

export interface FileMapEdge {
	from: string;
	to: string;
	/** Number of underlying symbol-level edges this file→file edge aggregates. */
	weight: number;
}

export interface AggregatedFileGraph {
	nodes: FileMapNode[];
	edges: FileMapEdge[];
	/** Count of "external" kind nodes in the source graph (excluded from the map). */
	externalCount: number;
	/** Count of distinct test files (per `detectFileRole`) excluded from the map. */
	testFileCount: number;
	/** True when the source graph had more files than the node cap and the lowest-degree ones were dropped. */
	truncated: boolean;
}

export interface AggregateOptions {
	/** Cap on rendered file nodes; default resolved by the caller (env PI_LENS_MAP_MAX_NODES, else 500). */
	maxNodes?: number;
}

export const DEFAULT_MAX_MAP_NODES = 500;

interface MutableFileEntry {
	id: string;
	path: string;
	language: string;
	symbolCount: number;
}

/**
 * Aggregates a symbol-level {@link ReviewGraph} into file-level nodes/edges.
 * Pure and side-effect-free — no graph build here, no filesystem access — so
 * it's directly unit-testable against a synthetic graph.
 */
export function aggregateGraphToFiles(
	graph: ReviewGraph,
	options?: AggregateOptions,
): AggregatedFileGraph {
	const maxNodes = Math.max(1, options?.maxNodes ?? DEFAULT_MAX_MAP_NODES);

	const files = new Map<string, MutableFileEntry>();
	let externalCount = 0;
	const testFileIds = new Set<string>();

	// A node resolves to the file it belongs to: a "file" kind node IS the
	// file; a "symbol" kind node belongs to its `filePath`. Anything else
	// ("external" — third-party/stdlib import targets, or "module" —
	// unresolved same-project import placeholders with no real file on disk)
	// has no file identity and is excluded from the map. Only "external" is
	// counted (per #679's spec); "module" placeholders are silently dropped —
	// they're not real files and there's nothing useful to show for them.
	// Test files (per `detectFileRole`) are ALSO excluded (#679 follow-up):
	// they pollute the file-level map and, left in, would dominate the
	// truncation ranking on test-heavy repos. Excluding at nodeToFile
	// construction time means their edges are dropped for free below (an
	// edge whose endpoint never resolves to a file is skipped) and they can
	// never influence degree/dependents/truncation ranking, which is
	// computed entirely from the (post-exclusion) nodeToFile map.
	const nodeToFile = new Map<string, string>();

	for (const node of graph.nodes.values()) {
		if (node.kind === "external") {
			externalCount += 1;
			continue;
		}
		if (node.kind === "file" && node.filePath) {
			const id = normalizeMapKey(node.filePath);
			if (detectFileRole(node.filePath) === "test") {
				testFileIds.add(id);
				continue;
			}
			nodeToFile.set(node.id, id);
			const existing = files.get(id);
			if (existing) {
				existing.language = node.language || existing.language;
			} else {
				files.set(id, { id, path: id, language: node.language || "", symbolCount: 0 });
			}
			continue;
		}
		if (node.kind === "symbol" && node.filePath) {
			const id = normalizeMapKey(node.filePath);
			if (detectFileRole(node.filePath) === "test") {
				testFileIds.add(id);
				continue;
			}
			nodeToFile.set(node.id, id);
			const existing = files.get(id);
			if (existing) {
				existing.symbolCount += 1;
			} else {
				files.set(id, {
					id,
					path: id,
					language: node.language || "",
					symbolCount: 1,
				});
			}
			continue;
		}
		// "module" (or any future kind) — no file identity, drop silently.
	}

	// Aggregate edges to file->file, deduped with a weight (#679: "keep a
	// count as edge weight"). Same-file edges (a symbol's own `contains`/
	// `defines` edge back to its file, or an intra-file call) are dropped —
	// they're not informative at the file-map altitude.
	const edgeWeights = new Map<string, number>();
	for (const edge of graph.edges) {
		const fromFile = nodeToFile.get(edge.from);
		const toFile = nodeToFile.get(edge.to);
		if (!fromFile || !toFile || fromFile === toFile) continue;
		// NUL separator (same idiom as review-graph/builder.ts): the one byte
		// that can never appear in a file path, written as an escape sequence so
		// this source file stays text for grep (a literal NUL makes ripgrep
		// treat the file as binary).
		const key = `${fromFile}\u0000${toFile}`;
		edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
	}

	function buildEdgeList(keepIds: Set<string> | undefined): FileMapEdge[] {
		const out: FileMapEdge[] = [];
		for (const [key, weight] of edgeWeights) {
			const sep = key.indexOf("\u0000");
			const from = key.slice(0, sep);
			const to = key.slice(sep + 1);
			if (keepIds && (!keepIds.has(from) || !keepIds.has(to))) continue;
			out.push({ from, to, weight });
		}
		return out;
	}

	function degreesFor(edges: FileMapEdge[]): {
		inNeighbors: Map<string, Set<string>>;
		outNeighbors: Map<string, Set<string>>;
	} {
		const inNeighbors = new Map<string, Set<string>>();
		const outNeighbors = new Map<string, Set<string>>();
		for (const edge of edges) {
			if (!outNeighbors.has(edge.from)) outNeighbors.set(edge.from, new Set());
			outNeighbors.get(edge.from)?.add(edge.to);
			if (!inNeighbors.has(edge.to)) inNeighbors.set(edge.to, new Set());
			inNeighbors.get(edge.to)?.add(edge.from);
		}
		return { inNeighbors, outNeighbors };
	}

	// Truncation (#679): keep the highest-degree files when the graph exceeds
	// the cap, ranked over the FULL (pre-truncation) edge set so the ranking
	// isn't self-referentially biased by an arbitrary earlier cut.
	let keepIds: Set<string> | undefined;
	let truncated = false;
	if (files.size > maxNodes) {
		const fullEdges = buildEdgeList(undefined);
		const { inNeighbors, outNeighbors } = degreesFor(fullEdges);
		const ranked = [...files.keys()].sort((a, b) => {
			const degA = (inNeighbors.get(a)?.size ?? 0) + (outNeighbors.get(a)?.size ?? 0);
			const degB = (inNeighbors.get(b)?.size ?? 0) + (outNeighbors.get(b)?.size ?? 0);
			if (degA !== degB) return degB - degA;
			return a.localeCompare(b);
		});
		keepIds = new Set(ranked.slice(0, maxNodes));
		truncated = true;
	}

	const finalEdges = buildEdgeList(keepIds);
	const { inNeighbors, outNeighbors } = degreesFor(finalEdges);

	// Transitive dependents (#679: "node radius scales with transitive
	// dependents") — BFS over incoming (reverse) edges of the RENDERED file
	// graph: "who depends on this file, directly or indirectly".
	function transitiveDependents(seed: string): number {
		const visited = new Set<string>([seed]);
		let frontier = [seed];
		while (frontier.length > 0) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const dependent of inNeighbors.get(id) ?? []) {
					if (visited.has(dependent)) continue;
					visited.add(dependent);
					next.push(dependent);
				}
			}
			frontier = next;
		}
		visited.delete(seed);
		return visited.size;
	}

	const keptEntries = [...files.values()].filter(
		(entry) => !keepIds || keepIds.has(entry.id),
	);
	const nodes: FileMapNode[] = keptEntries
		.map((entry) => ({
			id: entry.id,
			path: entry.path,
			language: entry.language,
			symbolCount: entry.symbolCount,
			outDegree: outNeighbors.get(entry.id)?.size ?? 0,
			inDegree: inNeighbors.get(entry.id)?.size ?? 0,
			dependents: transitiveDependents(entry.id),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));

	return { nodes, edges: finalEdges, externalCount, testFileCount: testFileIds.size, truncated };
}

// ── Layout: deterministic force-directed simulation ─────────────────────────

export interface LayoutOptions {
	width?: number;
	height?: number;
	/** Simulation iterations (~100-300 typical; more = more settled, slower to generate). */
	iterations?: number;
}

export interface LayoutPoint {
	id: string;
	x: number;
	y: number;
}

const DEFAULT_LAYOUT_WIDTH = 1600;
const DEFAULT_LAYOUT_HEIGHT = 1200;
const DEFAULT_ITERATIONS = 200;
const LAYOUT_MARGIN = 40;
const GRAVITY_STRENGTH = 0.02;
const ATTRACTION_SCALE = 0.02;

// FNV-1a 32-bit — cheap, deterministic, no external dep. Used purely to seed
// initial node positions from a hash of the file path (#679: "seed initial
// positions from a hash of the file path so two runs on the same project give
// the same map") — never as a source of real randomness.
function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function seededPosition(
	id: string,
	width: number,
	height: number,
): { x: number; y: number } {
	const hx = fnv1a(id);
	const hy = fnv1a(`${id}\u0000y`);
	return {
		x: (hx % 10000) / 10000 * width,
		y: (hy % 10000) / 10000 * height,
	};
}

/**
 * Simple deterministic force-directed layout: pairwise repulsion + edge-spring
 * attraction + center gravity, run for a fixed number of iterations with a
 * linear cooling schedule. Not a physically exact Fruchterman-Reingold
 * implementation — good enough for a human-facing project map, computed once
 * at generation time (never re-run client-side). Pure: same nodes/edges/opts
 * always produce identical output (no Math.random, no wall-clock).
 */
export function computeLayout(
	nodes: readonly { id: string }[],
	edges: readonly { from: string; to: string; weight: number }[],
	options?: LayoutOptions,
): LayoutPoint[] {
	const width = Math.max(1, options?.width ?? DEFAULT_LAYOUT_WIDTH);
	const height = Math.max(1, options?.height ?? DEFAULT_LAYOUT_HEIGHT);
	const iterations = Math.max(1, options?.iterations ?? DEFAULT_ITERATIONS);
	if (nodes.length === 0) return [];

	const ids = nodes.map((n) => n.id);
	const pos = new Map<
		string,
		{ x: number; y: number; dx: number; dy: number }
	>();
	for (const id of ids) {
		const seed = seededPosition(id, width, height);
		pos.set(id, { x: seed.x, y: seed.y, dx: 0, dy: 0 });
	}
	if (ids.length === 1) {
		const only = pos.get(ids[0]);
		if (only) {
			only.x = width / 2;
			only.y = height / 2;
		}
	}

	const relevantEdges = edges.filter(
		(e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to,
	);
	const area = width * height;
	const k = Math.sqrt(area / Math.max(1, ids.length));
	const center = { x: width / 2, y: height / 2 };

	for (let iter = 0; iter < iterations; iter += 1) {
		for (const id of ids) {
			const p = pos.get(id);
			if (p) {
				p.dx = 0;
				p.dy = 0;
			}
		}

		// Pairwise repulsion (Coulomb-like: force ~ k^2 / dist).
		for (let i = 0; i < ids.length; i += 1) {
			const a = pos.get(ids[i]);
			if (!a) continue;
			for (let j = i + 1; j < ids.length; j += 1) {
				const b = pos.get(ids[j]);
				if (!b) continue;
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let distSq = dx * dx + dy * dy;
				if (distSq < 0.0001) {
					dx = 0.1;
					dy = 0.1;
					distSq = 0.02;
				}
				const dist = Math.sqrt(distSq);
				const force = (k * k) / dist;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				a.dx += fx;
				a.dy += fy;
				b.dx -= fx;
				b.dy -= fy;
			}
		}

		// Edge-spring attraction (Hooke-like: force ~ dist^2 / k), scaled up
		// slightly by edge weight so heavily-aggregated edges pull tighter.
		for (const edge of relevantEdges) {
			const a = pos.get(edge.from);
			const b = pos.get(edge.to);
			if (!a || !b) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
			const weightFactor = Math.min(4, 1 + Math.log2(edge.weight + 1));
			const force = ((dist * dist) / k) * weightFactor * ATTRACTION_SCALE;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.dx += fx;
			a.dy += fy;
			b.dx -= fx;
			b.dy -= fy;
		}

		// Center gravity — keeps disconnected components from drifting off canvas.
		for (const id of ids) {
			const p = pos.get(id);
			if (!p) continue;
			p.dx += (center.x - p.x) * GRAVITY_STRENGTH;
			p.dy += (center.y - p.y) * GRAVITY_STRENGTH;
		}

		// Cooling schedule: max displacement per step shrinks linearly to ~0.
		const temperature = Math.max(0.5, width * 0.05 * (1 - iter / iterations));
		for (const id of ids) {
			const p = pos.get(id);
			if (!p) continue;
			const dispLen = Math.max(0.0001, Math.sqrt(p.dx * p.dx + p.dy * p.dy));
			const capped = Math.min(dispLen, temperature);
			p.x += (p.dx / dispLen) * capped;
			p.y += (p.dy / dispLen) * capped;
			p.x = Math.min(width - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, p.x));
			p.y = Math.min(height - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, p.y));
		}
	}

	return nodes.map((n) => {
		const p = pos.get(n.id);
		const x = p && Number.isFinite(p.x) ? p.x : width / 2;
		const y = p && Number.isFinite(p.y) ? p.y : height / 2;
		return { id: n.id, x, y };
	});
}

// ── Rendering: self-contained HTML (embedded JSON + vanilla JS/SVG) ─────────

export interface LensMapPayloadNode extends FileMapNode {
	x: number;
	y: number;
}

export interface LensMapPayload {
	generatedAt: string;
	projectLabel: string;
	fileCount: number;
	edgeCount: number;
	externalCount: number;
	testFileCount: number;
	truncated: boolean;
	maxNodes: number;
	width: number;
	height: number;
	nodes: LensMapPayloadNode[];
	edges: FileMapEdge[];
}

// Escape the embedded JSON payload so it can never break out of its
// <script type="application/json"> block — #504-spike XSS-from-repo-content
// mitigation (repo file names/paths are attacker-influenceable in cloned
// repos). Replacing every `<` with its unicode escape is a strictly stronger
// guarantee than just escaping "</script": no "<" survives at all, so no
// substring of the payload can ever open a tag, script or otherwise.
function escapeJsonForScriptTag(json: string): string {
	return json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

/**
 * Renders the self-contained lens-map HTML page. Pure string building — the
 * ONLY dynamic content that reaches the page is the JSON payload (embedded via
 * `escapeJsonForScriptTag`, read back out and rendered through DOM text APIs
 * client-side). No graph-derived string (file path, project label) is ever
 * concatenated directly into HTML markup — see the client script below, which
 * populates every visible label via `textContent`.
 */
export function renderMapHtml(payload: LensMapPayload): string {
	const json = escapeJsonForScriptTag(JSON.stringify(payload));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'" />
<title>pi-lens project map</title>
<style>
  :root {
    color-scheme: light;
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Inter", "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    --bg: #ffffff;
    --panel: #ffffff;
    --panel-recessed: #f4f5f7;
    --fg: #0f172a;
    --muted: #64748b;
    --line: #e2e8f0;
    --line-strong: #cbd5e1;
    --accent: #2563eb;
    --accent-soft: #dbeafe;
    --warn: #d97706;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0a0a0b; --panel: #16161a; --panel-recessed: #1f1f25;
      --fg: #f1f5f9; --muted: #94a3b8; --line: #26262c; --line-strong: #36363d;
      --accent: #60a5fa; --accent-soft: rgba(96, 165, 250, 0.16); --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
  header { padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: baseline; }
  header h1 { margin: 0; font-size: 1.15rem; letter-spacing: -0.01em; }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 0.85rem; }
  .stats strong { color: var(--fg); font-family: var(--font-mono); }
  #truncation-note { width: 100%; margin-top: 4px; color: var(--warn); font-size: 0.82rem; }
  #truncation-note[hidden] { display: none; }
  #stage { position: relative; height: calc(100vh - 76px); overflow: hidden; }
  #graph-svg { width: 100%; height: 100%; display: block; cursor: grab; background: var(--panel-recessed); }
  #graph-svg:active { cursor: grabbing; }
  .node-circle { stroke: var(--panel); stroke-width: 1.5px; cursor: pointer; transition: opacity 120ms ease; }
  .node text { font-family: var(--font-mono); font-size: 9px; fill: var(--muted); pointer-events: none; }
  .edge { stroke: var(--line-strong); stroke-opacity: 0.55; transition: opacity 120ms ease, stroke 120ms ease; }
  .edge.active { stroke: var(--accent); stroke-opacity: 0.9; }
  .dimmed { opacity: 0.12; }
  #detail-panel { position: fixed; right: 16px; bottom: 16px; width: 300px; max-width: calc(100% - 32px); border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: 0 12px 34px rgba(0,0,0,0.18); padding: 14px 16px; font-size: 0.85rem; }
  #detail-panel[hidden] { display: none; }
  #detail-panel h2 { margin: 0 0 8px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  #detail-path { display: block; word-break: break-word; font-family: var(--font-mono); color: var(--fg); margin-bottom: 10px; }
  #detail-panel dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
  #detail-panel dt { color: var(--muted); }
  #detail-panel dd { margin: 0; font-family: var(--font-mono); text-align: right; }
  #detail-close { position: absolute; top: 8px; right: 10px; border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 0.95rem; }
  #detail-close:hover { color: var(--fg); }
  #empty-note { padding: 40px 20px; color: var(--muted); }
  noscript { display: block; padding: 20px; color: var(--muted); }
</style>
</head>
<body>
<noscript>This project map needs JavaScript to render the interactive graph.</noscript>
<header>
  <h1>pi-lens project map</h1>
  <div class="stats">
    <span><strong id="stat-files">-</strong> files</span>
    <span><strong id="stat-edges">-</strong> edges</span>
    <span><strong id="stat-external">-</strong> external deps (excluded)</span>
    <span id="stat-testfiles-wrap" hidden><strong id="stat-testfiles">-</strong> test files (excluded)</span>
    <span>generated <strong id="stat-generated">-</strong></span>
    <span id="stat-project"></span>
  </div>
  <p id="truncation-note" hidden></p>
</header>
<div id="stage">
  <svg id="graph-svg" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="detail-panel" hidden>
    <button id="detail-close" type="button" aria-label="Close">&times;</button>
    <h2>File</h2>
    <span id="detail-path"></span>
    <dl>
      <dt>Symbols</dt><dd id="detail-symbols"></dd>
      <dt>In-degree</dt><dd id="detail-in"></dd>
      <dt>Out-degree</dt><dd id="detail-out"></dd>
      <dt>Dependents</dt><dd id="detail-dependents"></dd>
    </dl>
  </div>
</div>
<script type="application/json" id="lens-map-payload">${json}</script>
<script>
(function () {
  "use strict";
  var payloadEl = document.getElementById("lens-map-payload");
  var payload = JSON.parse(payloadEl.textContent || "{}");
  var nodes = payload.nodes || [];
  var edges = payload.edges || [];

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  setText("stat-files", String(payload.fileCount || 0));
  setText("stat-edges", String(payload.edgeCount || 0));
  setText("stat-external", String(payload.externalCount || 0));
  // The review graph itself excludes test files by role since #260, so this
  // count is normally 0 — only show the stat when the exclusion actually did
  // something (belt-and-braces against a future graph-scope change).
  if (payload.testFileCount > 0) {
    setText("stat-testfiles", String(payload.testFileCount));
    var tfWrap = document.getElementById("stat-testfiles-wrap");
    if (tfWrap) tfWrap.hidden = false;
  }
  setText("stat-generated", payload.generatedAt || "");
  setText("stat-project", payload.projectLabel || "");

  var truncationNote = document.getElementById("truncation-note");
  if (payload.truncated) {
    truncationNote.textContent =
      "Showing the " + payload.fileCount + " highest-degree files " +
      "(project exceeds the " + payload.maxNodes + "-file map cap).";
    truncationNote.hidden = false;
  }

  var svg = document.getElementById("graph-svg");
  if (nodes.length === 0) {
    var stage = document.getElementById("stage");
    var empty = document.createElement("div");
    empty.id = "empty-note";
    empty.textContent = "No files to map yet.";
    stage.replaceChild(empty, svg);
    return;
  }

  var svgNS = "http://www.w3.org/2000/svg";
  var width = payload.width || 1600;
  var height = payload.height || 1200;
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);

  var world = document.createElementNS(svgNS, "g");
  world.setAttribute("id", "world");
  svg.appendChild(world);
  var edgeGroup = document.createElementNS(svgNS, "g");
  world.appendChild(edgeGroup);
  var nodeGroup = document.createElementNS(svgNS, "g");
  world.appendChild(nodeGroup);

  var nodeById = {};
  nodes.forEach(function (n) { nodeById[n.id] = n; });

  var neighbors = {};
  nodes.forEach(function (n) { neighbors[n.id] = {}; });
  edges.forEach(function (e) {
    if (neighbors[e.from]) neighbors[e.from][e.to] = true;
    if (neighbors[e.to]) neighbors[e.to][e.from] = true;
  });

  var edgeEls = [];
  edges.forEach(function (e) {
    var a = nodeById[e.from];
    var b = nodeById[e.to];
    if (!a || !b) return;
    var line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.setAttribute("class", "edge");
    line.setAttribute("stroke-width", String(Math.min(4, 0.6 + Math.log2(e.weight + 1))));
    line.dataset.from = e.from;
    line.dataset.to = e.to;
    edgeGroup.appendChild(line);
    edgeEls.push(line);
  });

  // Node fill: neutral brand-blue intensity scale by transitive dependents
  // ONLY (light #2563eb family / dark #60a5fa family) — NOT complexity-based.
  // Calibrated complexity-aware coloring is deferred to #306; wiring a second
  // color dimension here would guess at a scale nobody has validated yet.
  var isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var loStop = isDark ? [30, 41, 59] : [219, 234, 254];
  var hiStop = isDark ? [96, 165, 250] : [37, 99, 235];
  function blueForRatio(ratio) {
    var t = Math.max(0, Math.min(1, ratio));
    var r = Math.round(loStop[0] + (hiStop[0] - loStop[0]) * t);
    var g = Math.round(loStop[1] + (hiStop[1] - loStop[1]) * t);
    var b = Math.round(loStop[2] + (hiStop[2] - loStop[2]) * t);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  var maxDependents = nodes.reduce(function (m, n) { return Math.max(m, n.dependents || 0); }, 0) || 1;
  var minRadius = 5, maxRadius = 22;
  var nodeEls = {};
  nodes.forEach(function (n) {
    var g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "node");
    g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
    g.dataset.id = n.id;

    var ratio = (n.dependents || 0) / maxDependents;
    var radius = minRadius + (maxRadius - minRadius) * Math.sqrt(ratio);

    var circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", blueForRatio(ratio));
    circle.setAttribute("class", "node-circle");
    g.appendChild(circle);

    var title = document.createElementNS(svgNS, "title");
    title.textContent = n.path + " — " + n.symbolCount + " symbols, " + n.dependents + " dependents";
    g.appendChild(title);

    g.addEventListener("mouseenter", function () { highlight(n.id); });
    g.addEventListener("mouseleave", clearHighlight);
    g.addEventListener("click", function (ev) { ev.stopPropagation(); showDetail(n); });

    nodeGroup.appendChild(g);
    nodeEls[n.id] = g;
  });

  function highlight(id) {
    var related = neighbors[id] || {};
    Object.keys(nodeEls).forEach(function (nid) {
      var isRelated = nid === id || related[nid];
      nodeEls[nid].classList.toggle("dimmed", !isRelated);
    });
    edgeEls.forEach(function (line) {
      var isRelated = line.dataset.from === id || line.dataset.to === id;
      line.classList.toggle("active", isRelated);
      line.classList.toggle("dimmed", !isRelated);
    });
  }
  function clearHighlight() {
    Object.keys(nodeEls).forEach(function (nid) { nodeEls[nid].classList.remove("dimmed"); });
    edgeEls.forEach(function (line) { line.classList.remove("active", "dimmed"); });
  }

  var detailPanel = document.getElementById("detail-panel");
  function showDetail(n) {
    setText("detail-path", n.path);
    setText("detail-symbols", String(n.symbolCount));
    setText("detail-in", String(n.inDegree));
    setText("detail-out", String(n.outDegree));
    setText("detail-dependents", String(n.dependents));
    detailPanel.hidden = false;
  }
  document.getElementById("detail-close").addEventListener("click", function () {
    detailPanel.hidden = true;
  });
  svg.addEventListener("click", function () { detailPanel.hidden = true; });

  // Pan (drag background) + zoom (wheel).
  var view = { x: 0, y: 0, scale: 1 };
  var dragging = false, lastX = 0, lastY = 0;
  function applyTransform() {
    world.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.scale + ")");
  }
  svg.addEventListener("pointerdown", function (ev) {
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", function (ev) {
    if (!dragging) return;
    view.x += ev.clientX - lastX;
    view.y += ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    applyTransform();
  });
  svg.addEventListener("pointerup", function () { dragging = false; });
  svg.addEventListener("pointercancel", function () { dragging = false; });
  svg.addEventListener("wheel", function (ev) {
    ev.preventDefault();
    var delta = ev.deltaY > 0 ? 0.9 : 1.1;
    view.scale = Math.max(0.15, Math.min(6, view.scale * delta));
    applyTransform();
  }, { passive: false });
  applyTransform();
})();
</script>
</body>
</html>
`;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface GenerateLensMapResult {
	filePath: string;
	fileCount: number;
	edgeCount: number;
	truncated: boolean;
	externalCount: number;
	testFileCount: number;
}

function resolveMaxNodes(): number {
	const raw = process.env.PI_LENS_MAP_MAX_NODES?.trim();
	if (!raw) return DEFAULT_MAX_MAP_NODES;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_MAX_MAP_NODES;
}

// Human-facing display path: cwd-relative + forward-slashed when the file
// sits under the project root, else the absolute (slash-normalized) path.
// Mirrors module-report.ts's toDisplayPath convention.
function toDisplayPath(p: string, projectRoot: string): string {
	if (!path.isAbsolute(p)) return p.replace(/\\/g, "/");
	const rel = path.relative(projectRoot, p);
	return rel && !rel.startsWith("..")
		? rel.replace(/\\/g, "/")
		: p.replace(/\\/g, "/");
}

/**
 * Builds (or refreshes) the review graph, aggregates it to a file-level map,
 * lays it out, renders the self-contained HTML page, and writes it to disk
 * under `<project data dir>/reports/lens-map.html`. Unlike module_report's
 * read-only #256 contract, this path DOES build the graph on a cold cache —
 * the user explicitly asked for a map via `/lens-map`, so taking a few seconds
 * to build is an acceptable, expected cost (this is not a hot per-edit path).
 */
export async function generateLensMap(
	cwd: string,
): Promise<GenerateLensMapResult> {
	const facts = new FactStore();
	const graph = await buildOrUpdateGraph(cwd, [], facts);

	const maxNodes = resolveMaxNodes();
	const aggregated = aggregateGraphToFiles(graph, { maxNodes });

	const displayNodes: FileMapNode[] = aggregated.nodes.map((node) => ({
		...node,
		path: toDisplayPath(node.path, cwd),
	}));

	const width = DEFAULT_LAYOUT_WIDTH;
	const height = DEFAULT_LAYOUT_HEIGHT;
	const layout = computeLayout(displayNodes, aggregated.edges, {
		width,
		height,
	});
	const positionById = new Map(layout.map((p) => [p.id, p]));

	const payloadNodes: LensMapPayloadNode[] = displayNodes.map((node) => {
		const point = positionById.get(node.id);
		return { ...node, x: point?.x ?? width / 2, y: point?.y ?? height / 2 };
	});

	const payload: LensMapPayload = {
		generatedAt: new Date().toISOString(),
		projectLabel: path.basename(path.resolve(cwd)),
		fileCount: aggregated.nodes.length,
		edgeCount: aggregated.edges.length,
		externalCount: aggregated.externalCount,
		testFileCount: aggregated.testFileCount,
		truncated: aggregated.truncated,
		maxNodes,
		width,
		height,
		nodes: payloadNodes,
		edges: aggregated.edges,
	};

	const html = renderMapHtml(payload);
	const outDir = path.join(getProjectDataDir(cwd), "reports");
	fs.mkdirSync(outDir, { recursive: true });
	const filePath = path.join(outDir, "lens-map.html");
	fs.writeFileSync(filePath, html, "utf-8");

	return {
		filePath,
		fileCount: aggregated.nodes.length,
		edgeCount: aggregated.edges.length,
		truncated: aggregated.truncated,
		externalCount: aggregated.externalCount,
		testFileCount: aggregated.testFileCount,
	};
}
