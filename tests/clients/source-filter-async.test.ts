/**
 * Regression guards for the chunked-yield source collector and the
 * generated-header read memo (PERF-AUDIT.md).
 *
 * Two invariants are guarded here:
 *
 *   1. Correctness / no-detection-loss — `collectSourceFilesAsync` returns the
 *      EXACT same file set as the synchronous `collectSourceFiles`. The async
 *      variant exists purely to spread the walk across event-loop ticks; it
 *      must never change which files are kept.
 *
 *   2. Event-loop budget — on a multi-hundred-file tree the async walk yields
 *      often enough that no single synchronous chunk between yields exceeds the
 *      ~50ms typing-window budget. The previously-synchronous `collectSourceFiles`
 *      held the loop for ~1.5s on a 2k-file project; the async variant must not
 *      reintroduce a comparable burst.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetGeneratedArtifactCaches } from "../../clients/generated-artifacts.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
	DEFAULT_MAX_SOURCE_FILES,
} from "../../clients/source-filter.js";
import {
	generateSourceTree,
	measureMaxSyncBlockMs,
} from "../support/perf-harness.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sf-async-"));
	_resetGeneratedArtifactCaches();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	_resetGeneratedArtifactCaches();
});

describe("collectSourceFilesAsync — correctness", () => {
	it("returns the same file set as the synchronous collector", async () => {
		generateSourceTree(tmpDir, 200);
		const sync = collectSourceFiles(tmpDir);
		_resetGeneratedArtifactCaches();
		const async = await collectSourceFilesAsync(tmpDir);

		expect(async.length).toBe(sync.length);
		expect(new Set(async)).toEqual(new Set(sync));
	});

	it("filters build artifacts and ignored dirs identically", async () => {
		generateSourceTree(tmpDir, 120);
		const result = await collectSourceFilesAsync(tmpDir);
		// No shadowed .js (a .ts sibling exists), no node_modules.
		expect(result.some((f) => f.includes("node_modules"))).toBe(false);
		expect(
			result.some(
				(f) => f.endsWith(".js") && fs.existsSync(f.replace(/\.js$/, ".ts")),
			),
		).toBe(false);
	});

	it("respects the extensions option the same way as sync", async () => {
		generateSourceTree(tmpDir, 150);
		const opts = { extensions: [".py"] };
		const sync = collectSourceFiles(tmpDir, opts);
		_resetGeneratedArtifactCaches();
		const async = await collectSourceFilesAsync(tmpDir, opts);
		expect(new Set(async)).toEqual(new Set(sync));
		expect(async.every((f) => f.endsWith(".py"))).toBe(true);
	});
});

describe("collectSourceFilesAsync — event-loop budget", () => {
	// Budget guard: the longest synchronous stretch between yields must stay
	// well under pi's typing window. Generous ceiling + retry so this is a
	// regression trip-wire (the catastrophic non-yielding case is ~400ms+ at
	// this fixture size, ≫ budget), not a flaky micro-benchmark — the loop-lag
	// sampler also picks up ambient load when the suite runs files in parallel.
	const MAX_SYNC_CHUNK_MS = 300;

	it("never blocks the loop longer than the budget between yields", { retry: 2 }, async () => {
		generateSourceTree(tmpDir, 600);
		_resetGeneratedArtifactCaches(); // force cold header reads (worst case)

		// Independent loop-lag sampler (perf-harness): unlike wrapping the
		// collector's own setImmediate, this still catches a regression that
		// stops yielding entirely (the catastrophic case) — that would surface
		// as one large block, not a missed measurement.
		const maxBlock = await measureMaxSyncBlockMs(async () => {
			const files = await collectSourceFilesAsync(tmpDir, { yieldEvery: 50 });
			expect(files.length).toBeGreaterThan(0);
		});

		expect(maxBlock).toBeLessThan(MAX_SYNC_CHUNK_MS);
	});
});

describe("maxFiles cap (#250) — bounds the walk", () => {
	it("collectSourceFilesAsync stops at maxFiles", async () => {
		generateSourceTree(tmpDir, 300);
		const uncapped = await collectSourceFilesAsync(tmpDir);
		// Sanity: the fixture must have more files than the cap, or the test
		// proves nothing.
		expect(uncapped.length).toBeGreaterThan(10);

		const capped = await collectSourceFilesAsync(tmpDir, { maxFiles: 10 });
		expect(capped.length).toBe(10);
	});

	it("collectSourceFiles (sync) stops at maxFiles", () => {
		generateSourceTree(tmpDir, 300);
		const uncapped = collectSourceFiles(tmpDir);
		expect(uncapped.length).toBeGreaterThan(10);

		const capped = collectSourceFiles(tmpDir, { maxFiles: 10 });
		expect(capped.length).toBe(10);
	});

	it("treats a non-positive / non-finite maxFiles as the finite default cap (#747)", async () => {
		generateSourceTree(tmpDir, 120);
		const uncapped = await collectSourceFilesAsync(tmpDir);
		// 0, negative, and NaN must NOT cap to zero — they fall back to the finite
		// structural default (never `Infinity`), which on a small tree returns
		// everything just like an omitted cap.
		for (const bad of [0, -5, Number.NaN]) {
			const result = await collectSourceFilesAsync(tmpDir, { maxFiles: bad });
			expect(result.length).toBe(uncapped.length);
		}
	});

	it("the default cap is finite, not unbounded (#747/#250)", () => {
		// The structural safety net: an omitted `maxFiles` must never mean an
		// unbounded walk — a misrooted cwd could otherwise enumerate all of $HOME.
		expect(Number.isFinite(DEFAULT_MAX_SOURCE_FILES)).toBe(true);
		expect(DEFAULT_MAX_SOURCE_FILES).toBeGreaterThan(0);
	});

	it("a cap larger than the tree returns everything (cap is a ceiling)", async () => {
		generateSourceTree(tmpDir, 80);
		const uncapped = await collectSourceFilesAsync(tmpDir);
		const capped = await collectSourceFilesAsync(tmpDir, {
			maxFiles: uncapped.length + 1000,
		});
		expect(new Set(capped)).toEqual(new Set(uncapped));
	});
});

describe("generated-header read memo", () => {
	it("reuses the header verdict on a repeat scan of unchanged files", async () => {
		generateSourceTree(tmpDir, 400);

		// Cold scan: every kept file pays the 4 KB header read.
		_resetGeneratedArtifactCaches();
		const c0 = process.hrtime.bigint();
		const first = collectSourceFiles(tmpDir);
		const coldMs = Number(process.hrtime.bigint() - c0) / 1e6;

		// Warm scan: same files, memo hit → stat replaces open+read+close.
		const w0 = process.hrtime.bigint();
		const second = collectSourceFiles(tmpDir);
		const warmMs = Number(process.hrtime.bigint() - w0) / 1e6;

		// Behavior is unchanged.
		expect(new Set(second)).toEqual(new Set(first));
		// The memo must make the repeat scan meaningfully cheaper. Loose factor
		// (the cold read dominates) so this is a trip-wire, not a flaky bench.
		expect(warmMs).toBeLessThan(coldMs * 0.85);
	});

	it("re-reads the header after a file is modified (memo self-invalidates)", async () => {
		generateSourceTree(tmpDir, 60);
		_resetGeneratedArtifactCaches();

		// First scan keeps a plain source file.
		const target = collectSourceFiles(tmpDir).find((f) => f.endsWith(".ts"));
		expect(target).toBeDefined();
		if (!target) return;
		expect(collectSourceFiles(tmpDir)).toContain(target);

		// Rewrite it with a generated banner + a fresh mtime. The memo key
		// includes mtime+size, so the new verdict (artifact) must take effect.
		await new Promise((r) => setTimeout(r, 12));
		fs.writeFileSync(
			target,
			`// @generated by codegen — do not edit\nexport const x = 1;\n`,
		);
		const after = collectSourceFiles(tmpDir);
		expect(after).not.toContain(target);
	});
});
