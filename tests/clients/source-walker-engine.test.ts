/**
 * Unit tests for the shared bounded-walk engine (#761) — the three drivers in
 * `source-walker.ts` that the count walks (startup-scan), the presence check
 * (jscpd-client), and the source collectors (source-filter) now share.
 *
 * These pin the driver mechanics directly (traversal order, the `"stop"` /
 * `shouldStop` halting semantics, the async `setImmediate` yield cadence), so a
 * change to the engine that a walker's own equivalence suite happens not to
 * exercise is still caught here. The per-walker behavioral equivalence lives in
 * `source-walker-equivalence.test.ts` and each walker's own budget/ceiling
 * suite; this file is about the driver contract itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	walkTreeRecursiveSync,
	walkTreeStackAsync,
	walkTreeStackSync,
	type WalkDisposition,
} from "../../clients/source-walker.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Builds a small tree:
 *   root/a.txt
 *   root/b.txt
 *   root/dirA/c.txt
 *   root/dirA/deep/e.txt
 *   root/dirB/d.txt
 */
function buildTree(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "walker-engine-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(path.join(root, "a.txt"), "a");
	fs.writeFileSync(path.join(root, "b.txt"), "b");
	fs.mkdirSync(path.join(root, "dirA", "deep"), { recursive: true });
	fs.writeFileSync(path.join(root, "dirA", "c.txt"), "c");
	fs.writeFileSync(path.join(root, "dirA", "deep", "e.txt"), "e");
	fs.mkdirSync(path.join(root, "dirB"));
	fs.writeFileSync(path.join(root, "dirB", "d.txt"), "d");
	return root;
}

/** Visitor that recurses into every directory and records file basenames. */
function recordingVisitor(seen: string[]) {
	return (entry: fs.Dirent, _fullPath: string): WalkDisposition => {
		if (entry.isDirectory()) return "recurse";
		seen.push(entry.name);
		return "skip";
	};
}

describe("walkTreeStackSync / walkTreeStackAsync", () => {
	it("visits every file when nothing stops the walk (sync)", () => {
		const seen: string[] = [];
		const stopped = walkTreeStackSync(buildTree(), recordingVisitor(seen));
		expect(stopped).toBe(false);
		expect(seen.sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
	});

	it("async twin visits the identical set as the sync driver", async () => {
		const root = buildTree();
		const syncSeen: string[] = [];
		walkTreeStackSync(root, recordingVisitor(syncSeen));
		const asyncSeen: string[] = [];
		const stopped = await walkTreeStackAsync(root, recordingVisitor(asyncSeen), {
			yieldEvery: 2,
		});
		expect(stopped).toBe(false);
		expect(asyncSeen.sort()).toEqual(syncSeen.sort());
	});

	it("returns true and halts immediately when the visitor stops", () => {
		let visits = 0;
		const stopped = walkTreeStackSync(buildTree(), (entry) => {
			visits += 1;
			return entry.isFile() ? "stop" : "recurse";
		});
		expect(stopped).toBe(true);
		// Stopped on the very first file it met — did not enumerate the whole tree.
		expect(visits).toBeLessThan(8);
	});

	it("shouldStop halts before popping the next directory but finishes the current one", () => {
		// A per-directory loop guard (jscpd's entry budget shape): once tripped,
		// no further directory is popped, but the in-progress directory's entry
		// loop still runs to completion.
		const seen: string[] = [];
		let entries = 0;
		const stopped = walkTreeStackSync(
			buildTree(),
			(entry, _full) => {
				entries += 1;
				if (entry.isFile()) seen.push(entry.name);
				return entry.isDirectory() ? "recurse" : "skip";
			},
			{ shouldStop: () => entries >= 1 },
		);
		// shouldStop fired (visitor never returned "stop"), so returns false.
		expect(stopped).toBe(false);
		// Only the root directory's entries were processed (guard tripped before
		// popping any subdirectory), so no nested file was seen.
		expect(seen).not.toContain("c.txt");
		expect(seen).not.toContain("e.txt");
	});

	it("yields via setImmediate on the async driver at the configured cadence", async () => {
		const root = buildTree();
		let immediates = 0;
		const realSetImmediate = globalThis.setImmediate;
		// Count setImmediate calls the driver schedules for its yields.
		(globalThis as { setImmediate: typeof setImmediate }).setImmediate = ((
			cb: (...a: unknown[]) => void,
			...args: unknown[]
		) => {
			immediates += 1;
			return realSetImmediate(cb, ...args);
		}) as typeof setImmediate;
		try {
			const seen: string[] = [];
			await walkTreeStackAsync(root, recordingVisitor(seen), { yieldEvery: 1 });
			// 6 entries processed (2 files + 2 dirs at root, then nested), one yield
			// each at cadence 1 — at least one macrotask yield actually happened.
			expect(immediates).toBeGreaterThan(0);
		} finally {
			(globalThis as { setImmediate: typeof setImmediate }).setImmediate =
				realSetImmediate;
		}
	});

	it("runs beforeWalk exactly once before the async walk begins", async () => {
		const root = buildTree();
		const order: string[] = [];
		await walkTreeStackAsync(
			root,
			(entry) => {
				if (entry.isFile()) order.push("visit");
				return entry.isDirectory() ? "recurse" : "skip";
			},
			{
				yieldEvery: 10,
				beforeWalk: async () => {
					order.push("before");
				},
			},
		);
		expect(order[0]).toBe("before");
		expect(order.filter((o) => o === "before")).toHaveLength(1);
	});
});

describe("walkTreeRecursiveSync", () => {
	it("descends depth-first, immediately, in encounter order", () => {
		// dirA is encountered before dirB; immediate descent means dirA's whole
		// subtree (c.txt, deep/e.txt) is visited before dirB's d.txt.
		const order: string[] = [];
		walkTreeRecursiveSync(buildTree(), (entry) => {
			if (entry.isDirectory()) return "recurse";
			order.push(entry.name);
			return "skip";
		});
		// a.txt and b.txt (root files) appear; dirA's files precede dirB's file.
		const idxDeep = order.indexOf("e.txt");
		const idxD = order.indexOf("d.txt");
		expect(idxDeep).toBeGreaterThanOrEqual(0);
		expect(idxD).toBeGreaterThanOrEqual(0);
		// Immediate descent: dirA's deep file is visited before dirB's file.
		expect(idxDeep).toBeLessThan(idxD);
	});

	it("propagates a stop up through every recursion frame", () => {
		let visits = 0;
		const stopped = walkTreeRecursiveSync(buildTree(), (entry) => {
			visits += 1;
			// Stop as soon as we descend into the deepest directory's file.
			if (entry.isFile() && entry.name === "e.txt") return "stop";
			return entry.isDirectory() ? "recurse" : "skip";
		});
		expect(stopped).toBe(true);
	});
});
