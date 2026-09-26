/**
 * #3535: the seq fast path's no-op branch must record the stat it took BEFORE
 * the content-hash read in `confirmContentChanged`, not merely before
 * re-extraction. A write that lands right after the hash read leaves the
 * graph (unchanged, since the hash matched) older than the disk. A stat taken
 * after that read signs the new bytes, and the next hint-less build serves
 * the old graph as `cached`.
 *
 * The gate is the hash read itself: `readFileSync` keeps the real
 * implementation and, once armed, performs the external write right after it
 * returns the file's bytes. `vi.spyOn(fs, "readFileSync")` cannot redefine
 * node:fs's ESM namespace export (see hashline-anchor-index-cache.test.ts),
 * so it is wrapped through `vi.mock` with the original spread in.
 */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
	arm: undefined as { file: string; write: () => void } | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
		const out = actual.readFileSync(...args);
		const arm = gate.arm;
		if (arm && String(args[0]) === arm.file) {
			gate.arm = undefined;
			arm.write();
		}
		return out;
	}) as typeof actual.readFileSync;
	return { ...actual, readFileSync };
});

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

function makeSeqHint(): GraphSeqHint & { bump: (filePath: string) => void } {
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

describe("review-graph seq fast path: a write after the hash read (#3535)", () => {
	afterEach(() => {
		gate.arm = undefined;
		clearReviewGraphWorkspaceCache();
	});

	it("no-op branch: a hint-less build re-reads a file written after its hash", async () => {
		const env = setupTestEnvironment("pi-lens-seqfp-hash-3535-");
		try {
			const aPath = createTempFile(
				env.tmpDir,
				"src/a.ts",
				"export function alpha() { return 1; }\n",
			);
			const facts = new FactStore();
			const hint = makeSeqHint();
			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("full");

			// A pi-observed save with the same bytes: the fast path hashes a.ts,
			// finds it unchanged, and takes the no-op branch.
			hint.bump(aPath);
			gate.arm = {
				file: normalizeMapKey(aPath),
				write: () =>
					fs.writeFileSync(
						aPath,
						"export function alphaV3External() { return 333333; }\n",
					),
			};
			clearGraphCache();
			await buildOrUpdateGraph(env.tmpDir, [aPath], facts, hint);
			expect(getLastGraphBuildInfo().mode).toBe("seq-fastpath");
			expect(getLastGraphBuildInfo().graphChanged).toBe(false);
			expect(gate.arm).toBeUndefined(); // the gate fired

			clearGraphCache();
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			expect(getLastGraphBuildInfo().mode).not.toBe("cached");
			expect(
				[...graph.nodes.values()].some(
					(node) => node.symbolName === "alphaV3External",
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
