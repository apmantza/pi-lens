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
	const actual =
		await vi.importActual<typeof import("../../clients/lsp/index.js")>(
			"../../clients/lsp/index.js",
		);
	return {
		...actual,
		getLSPService: () => mocked.service,
	};
});

vi.mock("../../clients/widget-state.js", () => ({
	reconcileScanDiagnostics: vi.fn(),
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
		getServersForFileWithConfig.mockReset();
		getServersForFileWithConfig.mockImplementation((fp: string) => {
			const id = serverIdForFile(fp);
			return id === "none" ? [] : [{ id }];
		});

		touchFile = vi.fn().mockResolvedValue([]);
		mocked.service = {
			touchFile,
			getDiagnostics: vi.fn().mockResolvedValue([]),
			getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
			getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
			ensureWarmForSweep: vi.fn().mockResolvedValue({ performedWarmup: false }),
		};
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeFiles(names: string[]): string[] {
		return names.map((name) => {
			const full = path.join(tmpDir, name);
			fs.writeFileSync(full, "x\n");
			return full;
		});
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
		// `.inconclusive` flag set — collectDiagnosticsForFile's `timedOut` reads
		// straight off this, same non-enumerable-flag contract touchFile uses.
		const inconclusive = Object.assign([], { inconclusive: true });
		touchFile.mockResolvedValueOnce(inconclusive);

		await runBatch(files);
		touchFile.mockClear();
		touchFile.mockResolvedValue([]);

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
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			source: "typescript",
		};
		touchFile.mockResolvedValueOnce([diag]);

		const first = await runBatch(files);
		expect(first.details?.totalDiagnostics).toBe(1);

		touchFile.mockClear();
		const second = await runBatch(files);
		expect(touchFile).not.toHaveBeenCalled();
		expect(second.details?.totalDiagnostics).toBe(1);
	});
});
