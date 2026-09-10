/**
 * #671: `lsp_diagnostics`' batch/directory sweep (`collectBatchDiagnostics` /
 * `mapWithConcurrency` in tools/lsp-diagnostics.ts) used to call `touchFile`
 * for every file on every call, with no memory of a prior sweep — same gap
 * `runWorkspaceDiagnostics` (the engine behind `lens_diagnostics mode=full`)
 * had. Both now share ONE on-disk cache
 * (`clients/lsp/workspace-diagnostics-cache.ts`) so a file swept by either
 * tool benefits the other's next sweep under the same scope. This suite
 * drives the real tool (mirroring
 * tests/tools/lsp-diagnostics-per-server-concurrency.test.ts's fixture
 * style) to prove: a second identical batch call skips `touchFile` entirely
 * for unchanged files, an inconclusive/timed-out touch is never cached, and
 * a corrupt cache file fails open (falls back to touching everything).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const mocked = vi.hoisted(() => ({ service: null as unknown }));
const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));
vi.mock("../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
	primaryServerId: (fp: string) => getServersForFileWithConfig(fp)[0]?.id,
}));

vi.mock("../../clients/lsp/index.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/index.js")
	>("../../clients/lsp/index.js");
	return {
		...actual,
		getLSPService: () => mocked.service,
	};
});

const { reconcileScanDiagnostics } = vi.hoisted(() => ({
	// Production returns a boolean (accepted / rejected by the ordering
	// guard); a double returning undefined put every result in this suite on
	// the rejected arm production never takes (#2154 round 3, v3 T3).
	reconcileScanDiagnostics: vi.fn((..._args: unknown[]) => true),
}));
vi.mock("../../clients/widget-state.js", () => ({
	reconcileScanDiagnostics,
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";

function serverIdForFile(file: string): string {
	return file.endsWith(".ts") ? "typescript" : "none";
}

describe("lsp_diagnostics batch — workspace-diagnostics cache (#671)", () => {
	let tmpDir: string;
	let touchFile: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-cache-"));
		// Legacy per-project data dir marker so the cache writes inside tmpDir.
		fs.mkdirSync(path.join(tmpDir, ".pi-lens"));
		reconcileScanDiagnostics.mockClear();
		getServersForFileWithConfig.mockReset();
		getServersForFileWithConfig.mockImplementation((fp: string) => {
			const id = serverIdForFile(fp);
			return id === "none" ? [] : [{ id }];
		});

		touchFile = vi.fn().mockResolvedValue({ diags: [] });
		mocked.service = makeLspServiceDouble({
			touchFile,
			getDiagnostics: vi.fn().mockResolvedValue([]),
			getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
			getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
			ensureWarmForSweep: vi.fn().mockResolvedValue({ performedWarmup: false }),
		});
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
	});

	function writeFiles(names: string[]): string[] {
		return names.map((name) => {
			const full = path.join(tmpDir, name);
			fs.writeFileSync(full, "x\n");
			return full;
		});
	}

	/** The on-disk cache's entry map, or `{}` when nothing was written. */
	function cacheEntries(): Record<
		string,
		{ mtimeMs: number; sizeBytes?: number }
	> {
		const cacheFile = path.join(
			tmpDir,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		if (!fs.existsSync(cacheFile)) return {};
		return (
			(
				JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
					entries?: Record<string, { mtimeMs: number; sizeBytes?: number }>;
				}
			).entries ?? {}
		);
	}

	async function runBatch(paths: string[]) {
		const tool = createLspDiagnosticsTool();
		return tool.execute(
			"diag-cache-test",
			{ paths, severity: "all", concurrency: 8, waitMs: 50 },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		) as Promise<any>;
	}

	// #2300 C1 (verify round): `collectFileDiagnosticResult`'s own `record`
	// call (`tools/lsp-diagnostics.ts`) wires `stat.size` as the `sizeBytes`
	// argument. A unit test against the cache primitive alone
	// (`workspace-diagnostics-cache.test.ts`) cannot see this wiring — it
	// calls `ctx.record` directly with a hand-supplied size, so neutering the
	// PRODUCTION argument to `undefined` would leave that test green. This
	// drives the real tool end to end and reads the persisted entry back.
	it("persists the touched file's real byte size into the cache entry (#2300)", async () => {
		const files = writeFiles(["a.ts"]);

		await runBatch(files);

		const entries = cacheEntries();
		const entry = Object.values(entries)[0];
		expect(entry?.sizeBytes).toBe(fs.statSync(files[0]!).size);
	});

	it("a second identical batch call never touches an unchanged file again", async () => {
		const files = writeFiles(["a.ts", "b.ts"]);

		const first = await runBatch(files);
		expect(first.isError).toBeUndefined();
		expect(touchFile).toHaveBeenCalledTimes(2);

		touchFile.mockClear();
		const second = await runBatch(files);
		expect(second.isError).toBeUndefined();
		expect(second.details?.filesChecked).toBe(2);
		expect(touchFile).not.toHaveBeenCalled();
	});

	it("a changed file is touched again; its unchanged sibling is served from cache", async () => {
		const files = writeFiles(["a.ts", "b.ts"]);
		await runBatch(files);
		touchFile.mockClear();

		const future = new Date(Date.now() + 60_000);
		fs.writeFileSync(files[0]!, "x2\n");
		fs.utimesSync(files[0]!, future, future);

		await runBatch(files);
		expect(touchFile).toHaveBeenCalledTimes(1);
		expect(touchFile).toHaveBeenCalledWith(
			files[0],
			expect.anything(),
			expect.anything(),
		);
	});

	it("never caches an inconclusive (timed-out) touch — the next call still touches it", async () => {
		const files = writeFiles(["a.ts"]);
		// #1179: `inconclusive` is an explicit enumerable field on the touchFile
		// wrapper now; `collectDiagnosticsForFile` reads `timedOut` straight off it.
		const inconclusive = { diags: [], inconclusive: true };
		touchFile.mockResolvedValueOnce(inconclusive);

		await runBatch(files);
		touchFile.mockClear();
		touchFile.mockResolvedValue({ diags: [] });

		await runBatch(files);
		// Not served from cache — an inconclusive result must never be cached.
		expect(touchFile).toHaveBeenCalledTimes(1);
	});

	it("fails open on a corrupt cache file: still touches every file instead of throwing", async () => {
		const files = writeFiles(["a.ts"]);
		const cacheFile = path.join(
			tmpDir,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, "{ not valid json");

		const result = await runBatch(files);
		expect(result.isError).toBeUndefined();
		expect(touchFile).toHaveBeenCalledTimes(1);
	});

	it("cache hit still reports the diagnostics found on the original (uncached) touch", async () => {
		const files = writeFiles(["a.ts"]);
		const diag = {
			severity: 1,
			message: "boom",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			source: "typescript",
			serverId: "typescript",
		};
		touchFile.mockResolvedValueOnce({ diags: [diag] });

		const first = await runBatch(files);
		expect(first.details?.totalDiagnostics).toBe(1);

		touchFile.mockClear();
		const second = await runBatch(files);
		expect(touchFile).not.toHaveBeenCalled();
		expect(second.details?.totalDiagnostics).toBe(1);
	});

	// #1549 review round, coverage gap (a). `collectFileDiagnosticResult` has two
	// independent guards against caching a partially covered answer: it demotes
	// `confirmation` to "unconfirmed" when the result is CLEAN, and the cache
	// write additionally requires `unconfirmedServerIds.length === 0`. Every
	// pre-existing partial fixture in the suite is EMPTY, so the demotion alone
	// carried them and the second guard could be deleted with all tests still
	// green. A NON-EMPTY partial result is the case only the second guard covers:
	// a non-empty answer is confirmed by this function's own doctrine, so nothing
	// demotes it, and without the gate the sweep would persist a snapshot that no
	// scanner vouched for and replay it as complete on every later batch.
	it("never caches a NON-EMPTY result whose auxiliary did not answer — the next call still touches it", async () => {
		const files = writeFiles(["a.ts"]);
		const diag = {
			severity: 1,
			message: "boom",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			source: "typescript",
			serverId: "typescript",
		};
		touchFile.mockResolvedValueOnce({
			diags: [diag],
			confirmation: "partial",
			unconfirmedServerIds: ["opengrep"],
		});

		const first = await runBatch(files);
		// The findings still reach the caller — the gap narrows COVERAGE, it does
		// not discard the primary's answer (#1470's own stated direction).
		expect(first.details?.totalDiagnostics).toBe(1);
		expect(cacheEntries()).toEqual({});

		touchFile.mockClear();
		touchFile.mockResolvedValue({ diags: [] });
		const second = await runBatch(files);
		expect(second.isError).toBeUndefined();
		// Contrast with the fully covered case directly above, where the second
		// call is served from the cache and touchFile is never reached.
		expect(touchFile).toHaveBeenCalledTimes(1);
	});

	// #1549 review round, coverage gap (b): the persistent cache's partial/full
	// transition matrix. Nothing pinned what happens when coverage CHANGES
	// between two sweeps of the same file, in either direction.
	it("partial then full: the partial sweep records nothing, and the later full sweep upgrades the file into the cache", async () => {
		const files = writeFiles(["a.ts"]);
		// Non-empty on purpose, for the same reason as the case above: an empty
		// partial is carried by the clean-demotion rule, so an empty fixture here
		// would pass with the coverage gate deleted.
		touchFile.mockResolvedValueOnce({
			diags: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					source: "typescript",
					serverId: "typescript",
				},
			],
			confirmation: "partial",
			unconfirmedServerIds: ["opengrep"],
		});

		await runBatch(files);
		expect(cacheEntries()).toEqual({});

		// Same file, same bytes, but opengrep answers this time.
		touchFile.mockClear();
		touchFile.mockResolvedValue({ diags: [], confirmation: "confirmed" });
		await runBatch(files);
		expect(touchFile).toHaveBeenCalledTimes(1);
		expect(Object.keys(cacheEntries())).toHaveLength(1);

		// And the upgraded entry now serves the next sweep.
		touchFile.mockClear();
		await runBatch(files);
		expect(touchFile).not.toHaveBeenCalled();
	});

	it("full then partial on a CHANGED file: the stale full entry is not overwritten and stays mtime-ineligible", async () => {
		const files = writeFiles(["a.ts"]);
		await runBatch(files);
		const cachedFull = cacheEntries();
		expect(Object.keys(cachedFull)).toHaveLength(1);
		const key = Object.keys(cachedFull)[0]!;

		// The file changes, so the cached entry is already mtime-ineligible. The
		// re-touch comes back partially covered.
		const future = new Date(Date.now() + 60_000);
		fs.writeFileSync(files[0]!, "x2\n");
		fs.utimesSync(files[0]!, future, future);
		touchFile.mockClear();
		touchFile.mockResolvedValue({
			diags: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					source: "typescript",
					serverId: "typescript",
				},
			],
			confirmation: "partial",
			unconfirmedServerIds: ["opengrep"],
		});
		await runBatch(files);
		expect(touchFile).toHaveBeenCalledTimes(1);

		// The partial answer must not be written over the old entry: the cache
		// still holds the ORIGINAL scan, whose mtime no longer matches disk.
		const after = cacheEntries();
		expect(Object.keys(after)).toEqual([key]);
		expect(after[key]?.mtimeMs).toBe(cachedFull[key]?.mtimeMs);
		expect(after[key]?.mtimeMs).not.toBe(fs.statSync(files[0]!).mtimeMs);

		// So the next sweep still re-touches rather than replaying a snapshot for
		// bytes nobody scanned.
		touchFile.mockClear();
		await runBatch(files);
		expect(touchFile).toHaveBeenCalledTimes(1);
	});

	it("a cache-hit reconcile stamps the footer with the cache's ORIGINAL scan time, not now (#1093/#1092)", async () => {
		const files = writeFiles(["a.ts"]);
		const diag = {
			severity: 1,
			message: "boom",
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			source: "typescript",
			serverId: "typescript",
		};
		touchFile.mockResolvedValueOnce({ diags: [diag] });

		await runBatch(files);
		// The fresh touch was OBSERVED now → no observation-time override.
		const freshCall = reconcileScanDiagnostics.mock.calls.find((c) =>
			String(c[0]).endsWith("a.ts"),
		);
		expect(freshCall).toBeDefined();
		expect(freshCall?.[4]).toBeUndefined();

		// The wall-clock time the cache recorded this scan at.
		const cacheFile = path.join(
			tmpDir,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
			entries: Record<string, { scannedAt: number }>;
		};
		const scannedAt = Object.values(cache.entries)[0]!.scannedAt;

		reconcileScanDiagnostics.mockClear();
		touchFile.mockClear();

		// A second identical sweep is served from the cache — a replay of an OLD
		// observation. The footer reconcile must be stamped with the cache's
		// original scan time so it can't re-arm the widget's mtime-staleness gate.
		const second = await runBatch(files);
		expect(second.isError).toBeUndefined();
		expect(touchFile).not.toHaveBeenCalled();
		const hitCall = reconcileScanDiagnostics.mock.calls.find((c) =>
			String(c[0]).endsWith("a.ts"),
		);
		expect(hitCall).toBeDefined();
		// Pre-fix: the cache-hit branch passed NO observation time (undefined) → the
		// footer re-stamped `touchedAt = Date.now()` on every re-serve, permanently
		// disarming the mtime gate (#1092). Post-fix: it carries the scan time.
		expect(hitCall?.[4]).toBe(scannedAt);
	});
});
