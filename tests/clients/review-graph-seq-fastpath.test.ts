import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	type GraphSeqHint,
	getLastGraphBuildInfo,
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
			[...lastSeq.entries()]
				.filter(([, s]) => s > seq)
				.map(([key]) => key),
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
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
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

			clearGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			// The edit is reflected: gamma is now a symbol node.
			const hasGamma = [...graph.nodes.values()].some(
				(n) => n.symbolName === "gamma",
			);
			expect(hasGamma).toBe(true);
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

	it("periodic re-verify (every 20th build) resumes the full sweep", async () => {
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
	});

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
});
