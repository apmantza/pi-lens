/**
 * Regression test for #766: `checkFilesBatch` parallelizes the per-turn
 * madge subprocess spawns that used to run one at a time in a sequential
 * `for…await checkFile(file)` loop.
 *
 * The risk: `DependencyChecker` keeps `lastCircular`/`circularFiles` as
 * shared instance state that each single-file madge run OVERWRITES (not
 * merges). Sequentially, the file processed LAST in array order determines
 * the final shared state. A naive `Promise.all` that mutates that shared
 * state as soon as each spawn's own promise resolves makes the final state
 * depend on subprocess COMPLETION order instead — nondeterministic and not
 * equivalent to the sequential baseline.
 *
 * This test sets up two files whose madge results disagree (one reports a
 * circular dependency, the other doesn't) and deliberately makes the
 * array-first file's subprocess resolve LAST. A correct fix folds results in
 * original array order regardless of completion order, so the final shared
 * state (and `isInCircular`/`getCircularForFile`) must match what the
 * sequential loop would have produced — i.e. the array-LAST file's result —
 * even though its spawn completed FIRST.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary: vi.fn(async () => "/fake/bin/madge"),
}));
// Guard: without this, a `findNodeToolBinary → undefined` fallthrough would load
// the REAL installer, whose named imports from the partially-mocked
// package-manager/safe-spawn modules throw — silently degrading every result to
// `{ok: false}` instead of failing loudly.
vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool: vi.fn(async () => undefined),
	getManagedToolsDir: () => path.join("/fake", "pi-lens", "tools"),
	// #1276: stubbed for the same reason as the sibling madge test files — see
	// dependency-checker-madge-resolution.test.ts.
	isSpawnableCommand: vi.fn(async () => true),
}));

describe("DependencyChecker.checkFilesBatch — concurrency race guard (#766)", () => {
	let tmp: string;
	let aPath: string;
	let cPath: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-batch-"));
		aPath = path.join(tmp, "a.ts");
		cPath = path.join(tmp, "c.ts");
		fs.writeFileSync(
			aPath,
			"import { b } from './b.js';\nexport const a = 1;\n",
		);
		fs.writeFileSync(cPath, "export const c = 1;\n");
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/** Resolve slowly for `a.ts` (reports a circular dep) and fast for `c.ts`
	 * (reports none) — completion order is REVERSED from array order. */
	function mockSpawnDeps() {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			const target = args[args.length - 1];
			if (target === aPath) {
				// Resolves LAST despite being array-FIRST.
				await new Promise((resolve) => setTimeout(resolve, 40));
				return {
					status: 0,
					error: null,
					stdout: JSON.stringify([[aPath, path.join(tmp, "b.ts")]]),
					stderr: "",
				};
			}
			// c.ts resolves immediately with no cycle.
			return {
				status: 0,
				error: null,
				stdout: JSON.stringify([]),
				stderr: "",
			};
		});
	}

	it("folds results in ARRAY order, not completion order, matching the sequential loop", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		mockSpawnDeps();

		const checker = new DependencyChecker();
		// Array order: a (slow, circular) first, then c (fast, clean) last.
		const { results } = await checker.checkFilesBatch([aPath, cPath], tmp);

		// Per-file local results must still be correct and not clobbered by
		// the sibling call: a's own result reports its cycle...
		expect(results.get(aPath)?.hasCircular).toBe(true);
		// ...and c's own result reports none, regardless of completion order.
		expect(results.get(cPath)?.hasCircular).toBe(false);

		// The shared state, however, reflects last-array-order-wins (c),
		// exactly like the sequential `for…await` loop would have left it —
		// NOT last-to-complete-wins (which would be a, since a's spawn
		// resolves after c's).
		expect(checker.isInCircular(aPath)).toBe(false);
		expect(checker.isInCircular(cPath)).toBe(false);
		expect(checker.getCircularForFile(aPath)).toEqual([]);
	});

	it("matches a true sequential for…await run of the same files/mocks", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");

		// --- Sequential baseline ---
		mockSpawnDeps();
		const sequential = new DependencyChecker();
		const seqResults = new Map<string, boolean>();
		for (const file of [aPath, cPath]) {
			const r = await sequential.checkFile(file, tmp);
			seqResults.set(file, r.hasCircular);
		}
		const seqFinalIsInCircularA = sequential.isInCircular(aPath);
		const seqFinalIsInCircularC = sequential.isInCircular(cPath);

		// --- Batch (parallel) run, same mocks/inputs ---
		vi.resetAllMocks();
		mockSpawnDeps();
		const batch = new DependencyChecker();
		const { results: batchResults } = await batch.checkFilesBatch(
			[aPath, cPath],
			tmp,
		);

		expect(batchResults.get(aPath)?.hasCircular).toBe(seqResults.get(aPath));
		expect(batchResults.get(cPath)?.hasCircular).toBe(seqResults.get(cPath));
		expect(batch.isInCircular(aPath)).toBe(seqFinalIsInCircularA);
		expect(batch.isInCircular(cPath)).toBe(seqFinalIsInCircularC);
	});

	it("would fail under a naive completion-order-wins merge (sanity check on the mock setup)", async () => {
		// This test does not exercise DependencyChecker at all — it just proves
		// the mock setup in this file actually produces reversed completion
		// order, which is the precondition the race-guard test above depends on.
		mockSpawnDeps();
		const order: string[] = [];
		const done = Promise.all([
			(async () => {
				const r = await safeSpawnAsync("/fake/bin/madge", [
					"--circular",
					"--json",
					aPath,
				]);
				order.push("a");
				return r;
			})(),
			(async () => {
				const r = await safeSpawnAsync("/fake/bin/madge", [
					"--circular",
					"--json",
					cPath,
				]);
				order.push("c");
				return r;
			})(),
		]);
		await done;
		// c (array-last) completes FIRST; a (array-first) completes LAST.
		expect(order).toEqual(["c", "a"]);
	});
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface
