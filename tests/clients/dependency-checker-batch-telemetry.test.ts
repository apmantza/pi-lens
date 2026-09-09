/**
 * #766: `checkFilesBatch` telemetry and spawn bounds.
 *
 * Turn-end logged one whole-phase `phase: "madge"` duration, which cannot
 * distinguish "many files" from "one slow file" from "command resolution" —
 * exactly the attribution the p99 tail needed. The batch now returns
 * `MadgeBatchStats` alongside its results, and turn-end attaches it as the
 * latency entry's metadata (logLatency no-ops under test, so these assert on the
 * returned stats).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const findNodeToolBinary = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync, safeSpawn }));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));
vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	getManagedToolsDir: () => path.join(os.tmpdir(), "pilens-fake-home", "tools"),
	// #1276: the madge staleness check revalidates bare resolved commands via
	// isSpawnableCommand. Not exercised in this file (every resolution here
	// falls through to the unmemoized `npx` fallback), but stubbed so a future
	// bare-command case here doesn't throw on a missing mock export.
	isSpawnableCommand: vi.fn(async () => true),
}));

const VERSION_OK = {
	status: 0,
	error: null,
	stdout: "madge 8.0.0",
	stderr: "",
};

describe("DependencyChecker.checkFilesBatch telemetry (#766)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-stats-"));
		findNodeToolBinary.mockResolvedValue(undefined);
		ensureTool.mockResolvedValue(undefined);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});
	});

	afterEach(() => {
		removeTempDirSync(tmp);
	});

	function writeSource(name: string, imports: string[]): string {
		const file = path.join(tmp, name);
		fs.writeFileSync(
			file,
			`${imports.map((i) => `import { x } from "${i}";`).join("\n")}\nexport const v = 1;\n`,
		);
		return file;
	}

	function madgeCalls(): unknown[][] {
		return safeSpawnAsync.mock.calls.filter(
			(c) => (c[1] as string[])[0] !== "--version",
		);
	}

	it("spawns nothing for a body-only edit", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const f = writeSource("a.ts", ["./b.js"]);
		const checker = new DependencyChecker();

		const first = await checker.checkFilesBatch([f], tmp);
		expect(first.stats.spawned).toBe(1);
		expect(madgeCalls()).toHaveLength(1);

		// Same import set, different body — both mtime and size move, so the
		// #1105 freshness fast path does not decide this; the extracted import
		// set does.
		fs.writeFileSync(
			f,
			'import { x } from "./b.js";\nexport const v = 1;\nexport const w = 2;\n',
		);
		const second = await checker.checkFilesBatch([f], tmp);

		expect(second.stats.spawned).toBe(0);
		expect(second.stats.cacheHits).toBe(1);
		expect(second.results.get(f)?.cacheHit).toBe(true);
		// Nothing to spawn means nothing to resolve, either.
		expect(second.stats.commandKind).toBeUndefined();
		expect(madgeCalls()).toHaveLength(1);
	});

	it("bounds concurrent spawns for a pathological turn", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const files = Array.from({ length: 8 }, (_, i) =>
			writeSource(`f${i}.ts`, [`./dep${i}.js`]),
		);
		let inFlight = 0;
		let peak = 0;

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 15));
			inFlight--;
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const { stats } = await new DependencyChecker().checkFilesBatch(files, tmp);

		expect(stats.spawned).toBe(8);
		// Exactly the cap, not merely under it — a peak below 6 would mean the
		// mock never saturated the pool and the bound went untested.
		expect(peak).toBe(6);
	});

	it("counts hits, misses, missing files and failures separately", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const hit = writeSource("hit.ts", ["./h.js"]);
		const ok = writeSource("ok.ts", ["./o.js"]);
		const bad = writeSource("bad.ts", ["./x.js"]);
		const gone = path.join(tmp, "gone.ts");

		const checker = new DependencyChecker();
		// Seed hit.ts's import cache so the batch classifies it as unchanged.
		expect(checker.importsChanged(hit)).toBe(true);

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			if (args[args.length - 1] === bad) {
				return {
					status: 1,
					error: new Error("madge exploded"),
					stdout: "",
					stderr: "",
				};
			}
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const { results, stats } = await checker.checkFilesBatch(
			[hit, ok, bad, gone],
			tmp,
		);

		expect(stats.requested).toBe(4);
		expect(stats.missing).toBe(1);
		expect(stats.cacheHits).toBe(1);
		expect(stats.spawned).toBe(2);
		expect(stats.failed).toBe(1);
		expect(stats.commandKind).toBe("npx");
		// Fast targets do not widen the shared latency record; aggregate counts
		// above remain exact and slow targets are covered below.
		expect(stats.targets).toEqual([]);
		expect(stats.targetsTruncated).toBe(false);
		expect(results.get(hit)?.cacheHit).toBe(true);
		expect(results.get(gone)?.checked).toBe(false);
	});

	it("counts the whole miss set as failed when madge is unavailable", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return {
					status: 1,
					error: new Error("madge: not found"),
					stdout: "",
					stderr: "",
				};
			}
			throw new Error("must not spawn madge while it is unavailable");
		});

		const hit = writeSource("hit.ts", ["./h.js"]);
		const missA = writeSource("a.ts", ["./a-dep.js"]);
		const missB = writeSource("b.ts", ["./b-dep.js"]);
		const gone = path.join(tmp, "gone.ts");

		const checker = new DependencyChecker();
		expect(checker.importsChanged(hit)).toBe(true);

		const { results, stats } = await checker.checkFilesBatch(
			[hit, missA, missB, gone],
			tmp,
		);

		expect(stats.requested).toBe(4);
		expect(stats.missing).toBe(1);
		expect(stats.cacheHits).toBe(1);
		expect(stats.spawned).toBe(0);
		// The miss set is not silently dropped: 0/0 would read as a clean turn
		// with nothing to do.
		expect(stats.failed).toBe(2);
		expect(stats.commandKind).toBeUndefined();
		expect(results.get(missA)?.checked).toBe(false);
		expect(results.get(hit)?.cacheHit).toBe(true);
	});

	it("does not retain fast per-target timings", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const files = Array.from({ length: 12 }, (_, i) =>
			writeSource(`f${i}.ts`, [`./dep${i}.js`]),
		);

		const { stats } = await new DependencyChecker().checkFilesBatch(files, tmp);

		expect(stats.spawned).toBe(12);
		expect(stats.targets).toHaveLength(0);
		expect(stats.targetsTruncated).toBe(false);
	});

	it("retains only slow target timings and caps them", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const files = Array.from({ length: 14 }, (_, i) =>
			writeSource(`f${i}.ts`, [`./dep${i}.js`]),
		);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			await new Promise((resolve) => setTimeout(resolve, 120));
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const { stats } = await new DependencyChecker().checkFilesBatch(files, tmp);

		expect(stats.spawned).toBe(14);
		expect(stats.targets).toHaveLength(12);
		expect(stats.targetsTruncated).toBe(true);
	});

	it("keeps repeated batch metadata bounded", async () => {
		const { DependencyChecker } =
			await import("../../clients/dependency-checker.js");
		const files = Array.from({ length: 14 }, (_, i) =>
			writeSource(`repeat${i}.ts`, [`./dep${i}.js`]),
		);
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return VERSION_OK;
			await new Promise((resolve) => setTimeout(resolve, 120));
			return { status: 0, error: null, stdout: "[]", stderr: "" };
		});

		const checker = new DependencyChecker();
		const serializedSizes: number[] = [];
		for (let turn = 0; turn < 3; turn++) {
			for (const [i, file] of files.entries()) {
				fs.writeFileSync(file, `import { x } from "./dep${i}-${turn}.js";\n`);
			}
			const { stats } = await checker.checkFilesBatch(files, tmp);
			expect(stats.targets.length).toBeLessThanOrEqual(12);
			serializedSizes.push(JSON.stringify(stats).length);
		}
		expect(Math.max(...serializedSizes)).toBeLessThanOrEqual(
			Math.max(...serializedSizes.slice(0, 1)),
		);
	});
});
