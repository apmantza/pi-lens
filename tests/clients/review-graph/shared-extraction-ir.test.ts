import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import {
	buildOrUpdateGraph,
	captureReviewGraphStructuralIr,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import {
	clearReviewGraphFileIr,
	getFreshReviewGraphFileIr,
	getReviewGraphIrStats,
	publishReviewGraphFileIr,
	resetReviewGraphIrStats,
	reviewGraphIrContentHash,
} from "../../../clients/review-graph/shared-extraction-ir.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

beforeAll(() => {
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});

afterAll(() => {
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
});

afterEach(() => {
	clearGraphCache();
	clearReviewGraphWorkspaceCache();
	clearReviewGraphFileIr();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function fixture(seed: number): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-ir-${seed}-`));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src"));
	for (let i = 0; i < 8; i++) {
		const prior =
			i === 0 ? "" : `import { value${i - 1} } from "./f${i - 1}";\n`;
		fs.writeFileSync(
			path.join(root, "src", `f${i}.ts`),
			`${prior}export function value${i}(input: number) { return input + ${seed + i}; }\n`,
		);
	}
	fs.writeFileSync(
		path.join(root, "src", "worker.py"),
		"class Worker:\n    def run(self):\n        return 1\n",
	);
	return root;
}

function shape(graph: ReviewGraph, root: string): unknown {
	const scrub = (value: string) =>
		value
			.replaceAll("\\", "/")
			.replaceAll(root.replaceAll("\\", "/"), "<root>");
	const nodes = [...graph.nodes.entries()]
		.map(([id, node]) => [
			scrub(id),
			JSON.parse(JSON.stringify(node), (_k, v) =>
				typeof v === "string" ? scrub(v) : v,
			),
		])
		.sort(([a], [b]) => String(a).localeCompare(String(b)));
	const edges = graph.edges
		.map((edge) =>
			JSON.parse(JSON.stringify(edge), (_k, v) =>
				typeof v === "string" ? scrub(v) : v,
			),
		)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return { nodes, edges };
}

describe("scanner to review-graph structural IR (#939)", () => {
	for (const seed of [93911, 93912, 93913]) {
		it(
			`is graph-equivalent to a cold parse for seed ${seed}`,
			{
				timeout: 120_000,
			},
			async () => {
				const coldRoot = fixture(seed);
				const sharedRoot = fixture(seed);
				const cold = await buildOrUpdateGraph(coldRoot, [], new FactStore());

				clearGraphCache();
				await scanProjectDiagnostics({
					cwd: sharedRoot,
					tier: "cheap",
					files: fs
						.readdirSync(path.join(sharedRoot, "src"))
						.map((name) => path.join(sharedRoot, "src", name)),
					maxFiles: 100,
				});
				resetReviewGraphIrStats();
				const shared = await buildOrUpdateGraph(
					sharedRoot,
					[],
					new FactStore(),
				);

				expect(shape(shared, sharedRoot)).toEqual(shape(cold, coldRoot));
				expect(getReviewGraphIrStats().accepted).toBe(9);
			},
		);
	}

	it("rejects stale IR for an edited file and reparses its new content", async () => {
		const root = fixture(93920);
		const files = fs
			.readdirSync(path.join(root, "src"))
			.map((name) => path.join(root, "src", name));
		await scanProjectDiagnostics({
			cwd: root,
			tier: "cheap",
			files,
			maxFiles: 100,
		});
		fs.writeFileSync(
			path.join(root, "src", "f7.ts"),
			'import { value0 } from "./f0";\nexport function changed() { return value0(1); }\n',
		);

		resetReviewGraphIrStats();
		const graph = await buildOrUpdateGraph(root, [], new FactStore());
		const file = path.join(root, "src", "f7.ts").replaceAll("\\", "/");
		expect(
			[...graph.nodes.values()].some(
				(node) => node.filePath === file && node.symbolName === "changed",
			),
		).toBe(true);
		expect(getReviewGraphIrStats()).toEqual({ accepted: 8, rejected: 1 });
	});

	// #3780 (#3746 survivors, builder.ts `sharedIr?.kind === "jsts"`): a graph
	// build that accepts a fresh IR must INGEST it, not re-derive the file. Every
	// other case here is graph-equivalent to a cold parse, so a build that threw
	// the accepted IR away and re-parsed passed them all. The IR is captured from
	// version X by the real capture path and published under the hash of the
	// bytes on disk (version Y): only an ingest shows X's symbol in the graph.
	it("ingests an accepted jsts IR instead of re-deriving the file", async () => {
		const root = fixture(93940);
		const file = path.join(root, "src", "f3.ts");
		const captured = await captureReviewGraphStructuralIr(
			file,
			root,
			'import { fromIr } from "./ir-only";\nexport function sharedSymbol() { return fromIr(); }\n',
			new FactStore(),
		);
		expect(captured.complete).toBe(true);
		expect(captured.structural?.kind).toBe("jsts");
		const onDisk = fs.readFileSync(file, "utf8");
		publishReviewGraphFileIr(root, {
			filePath: file,
			contentHash: reviewGraphIrContentHash(onDisk),
			complete: true,
			structural: captured.structural,
		});

		resetReviewGraphIrStats();
		const graph = await buildOrUpdateGraph(root, [], new FactStore());

		const symbols = [...graph.nodes.values()]
			.filter((node) => node.kind === "symbol")
			.map((node) => node.symbolName);
		expect(getReviewGraphIrStats().accepted).toBe(1);
		expect(symbols).toContain("sharedSymbol");
		expect(symbols).not.toContain("value3");
	});

	it("keeps the no-scan cold path unchanged", async () => {
		const leftRoot = fixture(93930);
		const rightRoot = fixture(93930);
		const left = await buildOrUpdateGraph(leftRoot, [], new FactStore());
		clearGraphCache();
		const right = await buildOrUpdateGraph(rightRoot, [], new FactStore());
		expect(shape(left, leftRoot)).toEqual(shape(right, rightRoot));
	});

	it("registry lifecycle: consume-once, publish guard, stale-only rejection (#955 review)", () => {
		clearReviewGraphFileIr();
		resetReviewGraphIrStats();
		const cwd = path.join(os.tmpdir(), "ir-lifecycle-root");
		const hash = reviewGraphIrContentHash("const a = 1;");
		const structural = {
			kind: "tree-sitter" as const,
			languageId: "python",
			extracted: { symbols: [], refs: [], imports: [] },
		};
		// Incomplete / structural-less entries are never stored.
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: false,
		});
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: true,
		});
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeUndefined();
		// Absence is not "rejected" — only present-but-stale counts.
		expect(getReviewGraphIrStats().rejected).toBe(0);

		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: true,
			structural,
		});
		// A transient failed re-publication must not clobber a valid entry.
		publishReviewGraphFileIr(cwd, {
			filePath: "/p/a.py",
			contentHash: hash,
			complete: false,
		});
		// Stale lookup: present but wrong hash → rejected, entry retained.
		expect(
			getFreshReviewGraphFileIr(cwd, "/p/a.py", "different"),
		).toBeUndefined();
		expect(getReviewGraphIrStats().rejected).toBe(1);
		// Fresh lookup consumes the entry…
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeDefined();
		// …exactly once (consume-once bounds retention and kills aliasing).
		expect(getFreshReviewGraphFileIr(cwd, "/p/a.py", hash)).toBeUndefined();
		expect(getReviewGraphIrStats().accepted).toBe(1);
		clearReviewGraphFileIr();
		resetReviewGraphIrStats();
	});
});

// #2442 review F9: the three clients/review-graph/* eviction sites were
// "deferred" on the first draft, citing an in-flight build-latch fix that has
// since merged (#2446). They are migrated to BoundedFifoMap now; this pins the
// root-axis bound the hand-rolled block used to enforce.
describe("shared extraction IR — bounded roots (#2442)", () => {
	const MAX_ROOTS = 8;
	const structural = {
		kind: "tree-sitter" as const,
		languageId: "python",
		extracted: { symbols: [], refs: [], imports: [] },
	};

	function publish(root: string, file: string, hash: string): void {
		publishReviewGraphFileIr(root, {
			filePath: file,
			contentHash: hash,
			complete: true,
			structural,
		});
	}

	afterEach(() => {
		clearReviewGraphFileIr();
		resetReviewGraphIrStats();
	});

	it("evicts the oldest ROOT once more than MAX_ROOTS are published", () => {
		const hash = reviewGraphIrContentHash("x");
		for (let i = 0; i < MAX_ROOTS; i++) publish(`/root-${i}`, "/p/a.py", hash);
		expect(getFreshReviewGraphFileIr("/root-0", "/p/a.py", hash)).toBeDefined();

		// The read above CONSUMED root-0's only file, so republish to make it
		// resident again — the root itself is still the oldest.
		publish("/root-0", "/p/a.py", hash);
		publish("/root-overflow", "/p/a.py", hash);

		// FIFO on the root axis: root-0 is still the oldest ROOT (republishing a
		// file into an existing root does not move the root), so it is dropped.
		expect(
			getFreshReviewGraphFileIr("/root-0", "/p/a.py", hash),
		).toBeUndefined();
		expect(
			getFreshReviewGraphFileIr("/root-overflow", "/p/a.py", hash),
		).toBeDefined();
	});

	it("a read of the oldest root never reorders eviction order (FIFO, not LRU)", () => {
		const hash = reviewGraphIrContentHash("y");
		for (let i = 0; i < MAX_ROOTS; i++) publish(`/r-${i}`, "/p/a.py", hash);

		// A read that MISSES on the FILE (wrong hash) still performs the roots
		// `get` — the reordering access, if that map were an LRU — while
		// leaving the entry in place for the assertions below.
		for (let i = 0; i < 5; i++) {
			expect(
				getFreshReviewGraphFileIr("/r-0", "/p/a.py", "other-hash"),
			).toBeUndefined();
		}

		publish("/r-overflow", "/p/a.py", hash);

		// FIFO: r-0 is still the oldest root, so it is the one evicted. Under an
		// LRU substitution both assertions flip.
		expect(getFreshReviewGraphFileIr("/r-0", "/p/a.py", hash)).toBeUndefined();
		expect(getFreshReviewGraphFileIr("/r-1", "/p/a.py", hash)).toBeDefined();
	});
});
