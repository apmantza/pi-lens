import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	type GraphSeqHint,
	getLastGraphBuildInfo,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

/**
 * #451: the review-graph seq fast path. A stub GraphSeqHint stands in for
 * RuntimeCoordinator's projectSeq/getFilesChangedSince — the builder only reads
 * those two accessors. The stub tracks a monotonic projectSeq and per-file bump
 * seq exactly like the coordinator, so the builder's `getFilesChangedSince`
 * diffing behaves identically.
 */
function makeSeqHint(): GraphSeqHint & {
	bump: (filePath: string) => void;
} {
	let projectSeq = 0;
	const lastSeq = new Map<string, number>();
	return {
		projectSeq: () => projectSeq,
		getFilesChangedSince: (seq: number) =>
			[...lastSeq.entries()].filter(([, s]) => s > seq).map(([key]) => key),
		bump: (filePath: string) => {
			projectSeq += 1;
			lastSeq.set(normalizeMapKey(filePath), projectSeq);
		},
	};
}

describe("review-graph seq fast path (#451)", () => {
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		delete process.env.PI_LENS_GRAPH_SEQ_FASTPATH;
		// Backstop for the Date.prototype.toISOString spy below: if a test's
		// awaited build rejects before its own try/finally restore runs, this
		// still clears the pin before the next test in the file (#2446 F1).
		vi.restoreAllMocks();
	});

	it("takes the fast path after a hinted build when one file is edited", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() {", "  return 1;", "}", ""].join("\n"),
			);
			createTempFile(
				env.tmpDir,
				"src/b.ts",
				[
					"import { alpha } from './a';",
					"export function beta() {",
					"  return alpha();",
					"}",
					"",
				].join("\n"),
			);

			const facts = new FactStore();
			const hint = makeSeqHint();

			// First hinted build records builtAtProjectSeq (full sweep — no prior entry).
			clearGraphCache();
			const initialGraph = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				facts,
				hint,
			);
			expect(getLastGraphBuildInfo().mode).toBe("full");

			// Edit a.ts on disk AND simulate its coordinator bump.
			fs.writeFileSync(
				aPath,
				[
					"export function alpha() {",
					"  return gamma();",
					"}",
					"function gamma() { return 2; }",
					"",
				].join("\n"),
			);
			hint.bump(aPath);

			// #2441: pin the clock so this rebuild's `builtAt` lands in the SAME
			// millisecond as `initialGraph.builtAt`, deterministically — wall-clock
			// ISO strings are allowed to collide between two builds. `buildGeneration`
			// (`builder.ts`'s process-wide `_graphGenerationCounter`) is bumped only
			// on a real re-extract (#459) and is the field that must move here.
			// #2446 F1: try/finally so a rejecting build still restores the
			// process-global Date.prototype spy instead of leaking it to later
			// tests in this file.
			const isoSpy = vi
				.spyOn(Date.prototype, "toISOString")
				.mockReturnValue(initialGraph.builtAt);
			clearGraphCache();
			try {
				const graph = await buildOrUpdateGraph(
					env.tmpDir,
					[aPath],
					facts,
					hint,
				);
				expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
				// #2446 F2: assert the pin fired rather than the mocked artifact
				// (`graph.builtAt`), so a future clock refactor doesn't red this.
				expect(isoSpy).toHaveBeenCalled();
				expect(graph.buildGeneration).not.toBe(initialGraph.buildGeneration);
				// The edit is reflected: gamma is now a symbol node.
				const hasGamma = [...graph.nodes.values()].some(
					(n) => n.symbolName === "gamma",
				);
				expect(hasGamma).toBe(true);
			} finally {
				vi.restoreAllMocks();
			}
		} finally {
			env.cleanup();
		}
	});

	it("adds a previously-unknown file incrementally via the fast path", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-new-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const facts = new FactStore();
			const hint = makeSeqHint();

			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("full");

			// Create a NEW file the cached graph never saw, and bump it.
			const cPath = createTempFile(
				env.tmpDir,
				"src/c.ts",
				["export function chi() { return 3; }", ""].join("\n"),
			);
			hint.bump(cPath);

			clearGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [cPath], facts, hint);
			// updateGraphFiles' remove-then-add handles adds cleanly, so the fast path
			// ingests the new file rather than falling back.
			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			const hasChi = [...graph.nodes.values()].some(
				(n) => n.symbolName === "chi",
			);
			expect(hasChi).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the sweep for a deleted file", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-del-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const bPath = createTempFile(
				env.tmpDir,
				"src/b.ts",
				["export function beta() { return 2; }", ""].join("\n"),
			);
			const facts = new FactStore();
			const hint = makeSeqHint();

			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);

			// Delete b.ts (a KNOWN file now missing) and bump it.
			fs.rmSync(bPath);
			hint.bump(bPath);

			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [bPath], facts, hint);
			// Deletions aren't handled incrementally here — full sweep.
			expect(getLastGraphBuildInfo().mode).toBe("full");
			expect(getLastGraphBuildInfo().seqFastpathFallback).toBe("removed-file");
		} finally {
			env.cleanup();
		}
	});

	it("kill-switch env forces the full sweep", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-kill-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const facts = new FactStore();
			const hint = makeSeqHint();

			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);

			fs.writeFileSync(
				aPath,
				["export function alpha() { return 2; }", ""].join("\n"),
			);
			hint.bump(aPath);

			process.env.PI_LENS_GRAPH_SEQ_FASTPATH = "0";
			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			// With the kill-switch set, the fast path is never attempted.
			expect(getLastGraphBuildInfo().mode).not.toBe("seq-fastpath");
			expect(getLastGraphBuildInfo().seqFastpathFallback).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// This test drives ~21 real `buildOrUpdateGraph` calls (one seed build plus
	// up to 21 fast-path builds looking for the every-20th re-verify) — a
	// time-budget issue, not a hang, under the default 5000ms timeout: it's
	// comfortably under budget isolated, but under full-suite parallel fork
	// contention that many sequential real builds can tip past 5s. Give it
	// the same kind of generous headroom as `tests/index-integration.test.ts`'s
	// `INTEGRATION_TIMEOUT_MS` — a genuine hang still fails, just later.
	it(
		"periodic re-verify (every 20th build) resumes the full sweep",
		{
			timeout: 30_000,
		},
		async () => {
			const env = setupTestEnvironment("pi-lens-seqfp-verify-");
			try {
				const aPath = createTempFile(
					env.tmpDir,
					"src/a.ts",
					["export function alpha() { return 1; }", ""].join("\n"),
				);
				const facts = new FactStore();
				const hint = makeSeqHint();

				clearGraphCache();
				await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
				expect(getLastGraphBuildInfo().mode).toBe("full");

				// 20 fast-path builds (each a distinct edit+bump) should trip the counter
				// on the 20th, forcing a full re-verify.
				let sawVerifyDue = false;
				for (let i = 0; i < 21; i++) {
					fs.writeFileSync(
						aPath,
						[`export function alpha() { return ${i + 10}; }`, ""].join("\n"),
					);
					hint.bump(aPath);
					clearGraphCache();
					await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
					const info = getLastGraphBuildInfo();
					if (info.seqFastpathFallback === "verify-due") {
						sawVerifyDue = true;
						break;
					}
				}
				expect(sawVerifyDue).toBe(true);
			} finally {
				env.cleanup();
			}
		},
	);

	it("no hint ⇒ mode is unchanged from today (never seq-fastpath)", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-nohint-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const facts = new FactStore();

			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			expect(getLastGraphBuildInfo().mode).toBe("full");
			expect(getLastGraphBuildInfo().seqFastpathFallback).toBeUndefined();

			// A pure re-build with no changes: cached, not seq-fastpath.
			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts);
			expect(getLastGraphBuildInfo().mode).toBe("cached");
		} finally {
			env.cleanup();
		}
	});

	it("same-content seq bumps stay a no-op and keep builtAt stable", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-same-content-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const facts = new FactStore();
			const hint = makeSeqHint();

			clearGraphCache();
			const initial = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				facts,
				hint,
			);
			fs.writeFileSync(
				aPath,
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			hint.bump(aPath);
			clearGraphCache();
			const rebuilt = await buildOrUpdateGraph(
				env.tmpDir,
				[aPath],
				facts,
				hint,
			);

			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			expect(getLastGraphBuildInfo().graphChanged).toBe(false);
			expect(rebuilt.builtAt).toBe(initial.builtAt);
			expect(rebuilt.buildGeneration).toBe(initial.buildGeneration);
		} finally {
			env.cleanup();
		}
	});

	it("buildGeneration: no-op fastpath carries the stamp forward, a real re-extract mints a new one (#459)", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-gen-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				["export function alpha() { return 1; }", ""].join("\n"),
			);
			const facts = new FactStore();
			const hint = makeSeqHint();

			clearGraphCache();
			const g1 = await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("full");
			expect(g1.buildGeneration).toBeDefined();

			// Nothing changed (no bumps, empty changedFiles): no-op fastpath returns
			// a fresh clone carrying the SAME stamp — derived caches may reuse.
			clearGraphCache();
			const g2 = await buildOrUpdateGraph(env.tmpDir, [], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			expect(getLastGraphBuildInfo().graphChanged).toBe(false);
			expect(g2.buildGeneration).toBe(g1.buildGeneration);

			// Real edit + coordinator bump: fastpath re-extracts → NEW stamp.
			fs.writeFileSync(
				aPath,
				["export function alphaRenamed() { return 2; }", ""].join("\n"),
			);
			hint.bump(aPath);
			clearGraphCache();
			const g3 = await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			expect(getLastGraphBuildInfo().graphChanged).toBe(true);
			expect(g3.buildGeneration).toBeDefined();
			expect(g3.buildGeneration).not.toBe(g1.buildGeneration);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3535: the fast path must record each candidate's stat from BEFORE it read
 * the file. A write that lands after the read and before the old re-stat got a
 * signature for bytes the graph never saw, so every later sweep-path build (no
 * seq hint: MCP, CLI, project_report) matched the stat and served the stale
 * graph as `cached`, in this process and from review-graph.json.gz.
 *
 * The gate is a FactStore hook, not a sleep: the external write runs
 * synchronously inside a FactStore call the build makes after it has read the
 * file. `extract` fires on the re-extract read (`setFileFact("file.content")`
 * from the content provider); `noop` fires in the no-op branch's
 * changed-symbol refresh (`getBoundedSessionFact`), which runs after the
 * content hash and before the old re-stat.
 */
class WriteGateFacts extends FactStore {
	arm:
		| { branch: "extract" | "noop"; file: string; write: () => void }
		| undefined;
	private fire(branch: "extract" | "noop", key: string): void {
		const arm = this.arm;
		if (arm?.branch !== branch) return;
		if (!key.endsWith(normalizeMapKey(arm.file))) return;
		this.arm = undefined;
		arm.write();
	}
	override setFileFact(filePath: string, factId: string, value: unknown): void {
		super.setFileFact(filePath, factId, value);
		if (factId === "file.content") {
			this.fire("extract", normalizeMapKey(filePath));
		}
	}
	override getBoundedSessionFact<T>(factId: string): T | undefined {
		this.fire("noop", factId);
		return super.getBoundedSessionFact<T>(factId);
	}
}

const symbolNames = (graph: { nodes: Map<string, { symbolName?: string }> }) =>
	new Set([...graph.nodes.values()].map((node) => node.symbolName));

describe("review-graph seq fast path: a write after the read (#3535)", () => {
	afterEach(() => {
		clearReviewGraphWorkspaceCache();
		vi.unstubAllEnvs();
	});

	it.each([
		["extract", "memory"],
		["extract", "disk"],
		["noop", "memory"],
		["noop", "disk"],
	] as const)(
		"%s branch, %s tier: a hint-less build re-reads the file",
		async (branch, tier) => {
			vi.stubEnv("PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS", "0");
			const env = setupTestEnvironment("pi-lens-seqfp-3535-");
			try {
				const aPath = createTempFile(
					env.tmpDir,
					"src/a.ts",
					"export function alpha() { return 1; }\n",
				);
				const bPath = createTempFile(
					env.tmpDir,
					"src/b.ts",
					"import { alpha } from './a';\nexport function beta() { return alpha(); }\n",
				);
				const facts = new WriteGateFacts();
				const hint = makeSeqHint();
				clearGraphCache();
				await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
				expect(getLastGraphBuildInfo().mode).toBe("full");

				// A pi-observed write: a real edit for the re-extract branch, the
				// same bytes for the no-op branch. Either way it bumps projectSeq.
				if (branch === "extract") {
					fs.writeFileSync(aPath, "export function alphaV2() { return 2; }\n");
				}
				hint.bump(aPath);
				// The external write (an IDE or a formatter) that lands after the
				// fast path read a.ts. A different size, so `size:mtimeMs` moves
				// even on a coarse-mtime filesystem.
				facts.arm = {
					branch,
					file: aPath,
					write: () =>
						fs.writeFileSync(
							aPath,
							"export function alphaV3External() { return 333333; }\n",
						),
				};
				clearGraphCache();
				await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
				expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
				expect(getLastGraphBuildInfo().graphChanged).toBe(branch === "extract");
				expect(facts.arm).toBeUndefined(); // the gate fired

				if (tier === "disk") {
					if (branch === "noop") {
						// The no-op branch does not persist. A later fast-path
						// re-extract of b.ts does, and carries a.ts's entry with it.
						fs.writeFileSync(
							bPath,
							"import { alpha } from './a';\nexport function betaV2() { return alpha(); }\n",
						);
						hint.bump(bPath);
						clearGraphCache();
						await buildOrUpdateGraph(env.tmpDir, [bPath], facts, hint);
						expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
					}
					flushReviewGraphPersistsForTests();
					await waitForReviewGraphPersistsForTests();
					clearReviewGraphWorkspaceCache();
				}

				// No seq hint, no further writes: the sweep path's stat must not
				// match a signature taken after the read.
				clearGraphCache();
				const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
				expect(getLastGraphBuildInfo().mode).not.toBe("cached");
				expect(symbolNames(graph).has("alphaV3External")).toBe(true);
			} finally {
				env.cleanup();
			}
		},
	);
});
