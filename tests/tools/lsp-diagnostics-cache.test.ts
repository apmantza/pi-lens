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
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	ENVIRONMENT_GAP_MARKER,
	hasResolvableNodeModules,
} from "../../clients/lsp/environment-gap.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { INFERRED_PROJECT_MARKER } from "../../clients/lsp/inferred-project.js";
import {
	boundUnixSocketPath,
	createWarmIpcLineReader,
	diagnosticsIpcPathForCwd,
} from "../../clients/mcp/ipc.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import {
	_resetWarmAttachForTests,
	_serveWarmRequestForTests,
	_setWarmAttachForTests,
	isWarmAttached,
} from "../../clients/warm-attach.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const mocked = vi.hoisted(() => ({ service: null as unknown }));
const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

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
import { installLspService } from "../support/lsp-service-seam.js";
import { _setServersForFileForTests } from "../../clients/lsp/config.js";

function serverIdForFile(file: string): string {
	return file.endsWith(".ts") ? "typescript" : "none";
}

describe("lsp_diagnostics batch — workspace-diagnostics cache (#671)", () => {
	let tmpDir: string;
	let touchFile: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		_setServersForFileForTests(getServersForFileWithConfig);
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-cache-"));
		// Legacy per-project data dir marker: with no PILENS_DATA_DIR override this
		// makes `getProjectDataDir` resolve the cache INSIDE tmpDir (cleaned up by
		// afterEach) instead of the real global ~/.pi-lens dir. Under a relocated
		// PILENS_DATA_DIR the production owner wins, and every fixture path below
		// is built from `getProjectDataDir(tmpDir)`, so the write and read never
		// disagree about which data root owns the cache.
		fs.mkdirSync(path.join(tmpDir, ".pi-lens"));
		reconcileScanDiagnostics.mockClear();
		getServersForFileWithConfig.mockReset();
		getServersForFileWithConfig.mockImplementation((fp: string) => {
			const id = serverIdForFile(fp);
			// `root` is what production servers carry: the injected list now reaches
			// `resolveLspCwdForFile` too, which the old module mock never did.
			return id === "none" ? [] : [{ id, root: async () => tmpDir }];
		});

		touchFile = vi.fn().mockResolvedValue({ diags: [] });
		mocked.service = installLspService(
			makeLspServiceDouble({
				touchFile,
				getDiagnostics: vi.fn().mockResolvedValue([]),
				getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
				getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
				ensureWarmForSweep: vi
					.fn()
					.mockResolvedValue({ performedWarmup: false }),
			}),
		);
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
			getProjectDataDir(tmpDir),
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

	async function runBatch(paths: string[], waitMs = 50) {
		const tool = createLspDiagnosticsTool();
		return tool.execute(
			"diag-cache-test",
			{ paths, severity: "all", concurrency: 8, waitMs },
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

	// #3505 class sweep: this path's own-file stat already precedes its read,
	// but its `scannedAt` (the reference the entry's dependency mtimes are
	// compared against) was stamped when the entry was recorded, after the
	// touch. A dependency written during the touch predated the entry.
	it("stamps the entry's scannedAt before the touch, not when it records (#3505)", async () => {
		const T_READ = 1_900_000_000_000;
		const files = writeFiles(["a.ts"]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(T_READ);
			touchFile.mockImplementation(async () => {
				// The touch takes 1.5 s; the entry is recorded after it.
				vi.setSystemTime(T_READ + 1500);
				return { diags: [] };
			});
			await runBatch(files);
		} finally {
			vi.useRealTimers();
		}
		const entry = Object.values(cacheEntries())[0] as
			| { scannedAt?: number }
			| undefined;
		expect(entry?.scannedAt).toBe(T_READ);
	});

	// #3505 r1 F1: the fresh result's widget row must carry the same read
	// stamp as its cache entry. Stamped after the touch, a file or dependency
	// written during the touch predates the row, and the widget's own
	// mtime gates keep the pre-edit finding.
	it("observes the fresh widget row at the read, not after the touch (#3505)", async () => {
		const T_READ = 1_900_000_000_000;
		const files = writeFiles(["a.ts"]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(T_READ);
			touchFile.mockImplementation(async () => {
				vi.setSystemTime(T_READ + 1500);
				return {
					diags: [
						{
							severity: 1,
							message: "computed on the bytes read at T_READ",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					],
				};
			});
			await runBatch(files);
		} finally {
			vi.useRealTimers();
		}
		expect(reconcileScanDiagnostics).toHaveBeenCalledTimes(1);
		// (file, diagnostics, confirmed, writeIndex, observedAt)
		expect(reconcileScanDiagnostics.mock.calls[0]?.[4]).toBe(T_READ);
	});

	// #3505 r2: the single-file mode (`path`, not `paths`) writes the same
	// widget row through its own reconcile, and had the same late stamp.
	it("observes the single-file widget row at the read, not after the touch (#3505)", async () => {
		const T_READ = 1_900_000_000_000;
		const [file] = writeFiles(["a.ts"]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(T_READ);
			touchFile.mockImplementation(async () => {
				vi.setSystemTime(T_READ + 1500);
				return {
					diags: [
						{
							severity: 1,
							message: "computed on the bytes read at T_READ",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					],
				};
			});
			const tool = createLspDiagnosticsTool();
			await tool.execute(
				"diag-single-file-test",
				{ path: file, severity: "all", waitMs: 50 },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);
		} finally {
			vi.useRealTimers();
		}
		expect(reconcileScanDiagnostics).toHaveBeenCalledTimes(1);
		// (file, diagnostics, confirmed, writeIndex, observedAt)
		expect(reconcileScanDiagnostics.mock.calls[0]?.[4]).toBe(T_READ);
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
			getProjectDataDir(tmpDir),
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
		const freshCall = reconcileScanDiagnostics.mock.calls.find((c) =>
			String(c[0]).endsWith("a.ts"),
		);
		expect(freshCall).toBeDefined();

		// The wall-clock time the cache recorded this scan at.
		const cacheFile = path.join(
			getProjectDataDir(tmpDir),
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as {
			entries: Record<string, { scannedAt: number }>;
		};
		const scannedAt = Object.values(cache.entries)[0]!.scannedAt;
		// #3505 r1 F1: the fresh touch's row is observed at its read, the same
		// instant the cache entry is stamped with (it was `undefined`, i.e.
		// now(), after the touch).
		expect(freshCall?.[4]).toBe(scannedAt);

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

	// #4532 round 5 (review F4 and F5). `lsp_diagnostics` is the route the user
	// runs by hand, and deleting its environment-gap demotion left every test of
	// the tool green. The fresh touch, the cache replay and the single-file mode
	// each render the rows through the demotion, so each has a cell here.
	describe("environment-gap demotion on the lsp_diagnostics route (#4532)", () => {
		/** TS2307 for a package the root DECLARES: an environment gap. */
		const declaredGap = {
			severity: 1,
			message:
				"Cannot find module 'left-pad' or its corresponding type declarations.",
			code: 2307,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			source: "typescript",
			serverId: "typescript",
		};

		/** The widget rows the last reconcile wrote for `file`. */
		function writtenFor(
			file: string,
		): Array<{ semantic: string; message: string }> {
			const call = reconcileScanDiagnostics.mock.calls
				.filter((c) => c[0] === file)
				.at(-1);
			return (call?.[1] ?? []) as Array<{ semantic: string; message: string }>;
		}

		beforeEach(() => {
			fs.writeFileSync(
				path.join(tmpDir, "package.json"),
				JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
			);
			// Shape 73 (fixture adopts an ancestor root): an install anywhere above
			// the fixture would make every demotion cell red and every blocking
			// cell vacuous, so the premise is asserted, not assumed.
			expect(hasResolvableNodeModules(tmpDir)).toBe(false);
			touchFile.mockResolvedValue({ diags: [{ ...declaredGap }] });
		});

		it("demotes a declared-package gap on a fresh touch and on its cache replay", async () => {
			const [file] = writeFiles(["a.ts"]);

			await runBatch([file!]);
			expect(writtenFor(file!)).toHaveLength(1);
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "warning" });
			expect(writtenFor(file!)[0]?.message).toContain(ENVIRONMENT_GAP_MARKER);

			reconcileScanDiagnostics.mockClear();
			touchFile.mockClear();
			await runBatch([file!]);
			// A replay, never a second touch: the demotion holds on the cache too.
			expect(touchFile).not.toHaveBeenCalled();
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "warning" });
		});

		it("demotes a declared-package gap in single-file mode", async () => {
			const [file] = writeFiles(["a.ts"]);
			await createLspDiagnosticsTool().execute(
				"diag-env-gap-single",
				{ path: file, severity: "all", waitMs: 50 },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "warning" });
			expect(writtenFor(file!)[0]?.message).toContain(ENVIRONMENT_GAP_MARKER);
		});

		// Review F5 (shape 6, a cache entry missing one input): the entry used to
		// store the DEMOTED rows, and the demotion only reads severity-1 rows, so
		// once an install landed and the package stayed unresolved the replay kept
		// a real missing-module error at warning authority with nothing to re-promote
		// it. The entry now holds the server's own rows and the replay demotes them
		// against the install state of the serve.
		//
		// #5005 F1: the install is a PACKAGE-local install (`pkg/node_modules`),
		// because the answer route's pre-answer look stamps the ROOT's own install
		// and would (correctly) force a fresh touch there — that behaviour is the
		// sibling cell below. A package's own install is outside the root's stamp,
		// so this replay still replays, and the re-promotion rule it pins stays
		// reachable on the real path.
		it("re-promotes a cached gap once an install resolves and the package is still missing", async () => {
			fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
			const [file] = writeFiles(["pkg/a.ts"]);
			await runBatch([file!]);
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "warning" });

			// The install lands from outside (no project file changes, so the entry
			// stays fresh) but does not provide `left-pad`.
			fs.mkdirSync(path.join(tmpDir, "pkg", "node_modules", "other"), {
				recursive: true,
			});
			reconcileScanDiagnostics.mockClear();
			touchFile.mockClear();
			await runBatch([file!]);
			expect(touchFile).not.toHaveBeenCalled();
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "blocking" });
			expect(writtenFor(file!)[0]?.message).not.toContain(
				ENVIRONMENT_GAP_MARKER,
			);
		});

		// #5005 F1: the sibling of the cell above. An install at the call's own
		// root IS what the answer route's pre-answer look publishes (#4532 gap 5),
		// so the next call must touch again rather than replay the pre-install
		// entry — the freshness property the replay cell must not encode as
		// "never a second touch".
		it("touches again once an install lands at the call's own root (#4532 gap 5)", async () => {
			const [file] = writeFiles(["a.ts"]);
			await runBatch([file!]);
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "warning" });

			fs.mkdirSync(path.join(tmpDir, "node_modules", "other"), {
				recursive: true,
			});
			reconcileScanDiagnostics.mockClear();
			touchFile.mockClear();
			await runBatch([file!]);
			// A fresh touch, not a replay: the look published the install and the
			// cache refused the entry it had scanned before it.
			expect(touchFile).toHaveBeenCalledTimes(1);
			// The fresh touch re-applies the environment rule at the current install
			// state, so the row is blocking again with no install advice.
			expect(writtenFor(file!)[0]).toMatchObject({ semantic: "blocking" });
			expect(writtenFor(file!)[0]?.message).not.toContain(
				ENVIRONMENT_GAP_MARKER,
			);
		});
	});

	// #4532 round 6 (r5 verify NEW-1, shape 6). Round 5 stored the server's rows
	// for BOTH demotion rules, so a replay re-asked tsserver for the file's
	// project. A replay often has no live client to ask: a new session replaying
	// the on-disk cache, an idle-evicted server, a file tsserver never opened.
	// The unknown answer then re-cemented an inferred-project file as blocking,
	// the #1645 F3 contract this cache must keep. The entry now keeps the
	// membership verdict and leaves only the environment rule to the replay.
	describe("membership verdict on a cache replay (#4532 round 6)", () => {
		const inferredError = {
			severity: 1,
			message: "Cannot find name 'describe'.",
			code: 2582,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 8 },
			},
			source: "typescript",
			serverId: "typescript",
		};
		const declaredGap = {
			...inferredError,
			message:
				"Cannot find module 'left-pad' or its corresponding type declarations.",
			code: 2307,
		};
		type ProbeAnswer = { executed: boolean; result?: unknown; reason?: string };
		const inferred: ProbeAnswer = {
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		};
		const noLiveClient: ProbeAnswer = {
			executed: false,
			reason: "no live LSP server for file",
		};
		const notOpened: ProbeAnswer = {
			executed: true,
			result: { success: false },
		};
		let probe: ReturnType<typeof vi.fn>;

		function semanticsFor(file: string): string[] {
			const call = reconcileScanDiagnostics.mock.calls
				.filter((c) => c[0] === file)
				.at(-1);
			return ((call?.[1] ?? []) as Array<{ semantic: string }>).map(
				(row) => row.semantic,
			);
		}

		/** One fresh serve, then one replay with the probe answering `replay`. */
		async function serveThenReplay(
			rows: unknown[],
			serve: ProbeAnswer,
			replay: ProbeAnswer,
			beforeReplay?: () => void,
			filePath: string = path.join(tmpDir, "spawn.test.ts"),
		): Promise<{ fresh: string[]; replayed: string[] }> {
			const file = filePath;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "describe('x', () => {});\n");
			touchFile.mockResolvedValue({
				diags: rows.map((row) => ({ ...(row as object) })),
			});
			probe.mockResolvedValue(serve);
			await runBatch([file]);
			const fresh = semanticsFor(file);
			beforeReplay?.();
			probe.mockResolvedValue(replay);
			reconcileScanDiagnostics.mockClear();
			touchFile.mockClear();
			await runBatch([file], 15_000);
			// A replay, never a second touch.
			expect(touchFile).not.toHaveBeenCalled();
			return { fresh, replayed: semanticsFor(file) };
		}

		beforeEach(() => {
			fs.writeFileSync(
				path.join(tmpDir, "package.json"),
				JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
			);
			// Shape 73: an install above the fixture would make the gap cells vacuous.
			expect(hasResolvableNodeModules(tmpDir)).toBe(false);
			probe = vi.fn();
			mocked.service = installLspService(
				makeLspServiceDouble({
					touchFile,
					getDiagnostics: vi.fn().mockResolvedValue([]),
					getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
					getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
					ensureWarmForSweep: vi
						.fn()
						.mockResolvedValue({ performedWarmup: false }),
					executeReadOnlyCommandOnLiveClient: probe,
				}),
			);
		});

		it.each([
			["no live client", noLiveClient],
			["a file tsserver has not opened", notOpened],
		])(
			"keeps an inferred-project demotion when the replay's probe finds %s",
			async (_label, replay) => {
				const { fresh, replayed } = await serveThenReplay(
					[inferredError],
					inferred,
					replay,
				);
				expect(fresh).toEqual(["warning"]);
				expect(replayed).toEqual(["warning"]);
			},
		);

		// State table cell 8: an environment gap in an inferred-project file. The
		// environment rule demotes it first, so the displayed pass never asks for
		// membership; the entry must still carry the file's membership verdict, or
		// an install that leaves the package missing turns it blocking on a replay
		// that cannot ask, though a live fresh touch would answer inferred.
		//
		// #5005 F1: the install is a PACKAGE-local one, because the answer route's
		// pre-answer look stamps the root's own install and correctly forces a
		// fresh touch there (the root case has its own cell in the environment-gap
		// suite). This cell's replay is the property under test, so its install
		// must be one the root's look does not claim.
		it("keeps an inferred file's gap demoted after an install, when the replay cannot ask", async () => {
			const file = path.join(tmpDir, "pkg", "spawn.test.ts");
			const { fresh, replayed } = await serveThenReplay(
				[declaredGap],
				inferred,
				noLiveClient,
				() =>
					fs.mkdirSync(path.join(tmpDir, "pkg", "node_modules", "other"), {
						recursive: true,
					}),
				file,
			);
			expect(fresh).toEqual(["warning"]);
			expect(replayed).toEqual(["warning"]);
		});

		// The replayable form's extra membership pass shares the rendered pass's
		// identity memo. Without it, every file holding both a gap and another
		// TypeScript error would send tsserver two `projectInfo` requests per serve.
		it("asks tsserver once per serve when the cache form needs its own membership pass", async () => {
			const file = path.join(tmpDir, "spawn.test.ts");
			fs.writeFileSync(file, "describe('x', () => {});\n");
			touchFile.mockResolvedValue({
				diags: [{ ...declaredGap }, { ...inferredError }],
			});
			probe.mockResolvedValue(inferred);
			await runBatch([file]);
			expect(semanticsFor(file)).toEqual(["warning", "warning"]);
			expect(probe).toHaveBeenCalledTimes(1);
		});

		// Cells 10 and 11: a verdict unknown at the serve is not baked as one.
		it("demotes on replay when membership was unknown at the serve and is answered now", async () => {
			const { fresh, replayed } = await serveThenReplay(
				[inferredError],
				noLiveClient,
				inferred,
			);
			expect(fresh).toEqual(["blocking"]);
			expect(replayed).toEqual(["warning"]);
		});

		it("keeps a row blocking when membership is unknown at the serve and on the replay", async () => {
			const { fresh, replayed } = await serveThenReplay(
				[inferredError],
				noLiveClient,
				noLiveClient,
			);
			expect(fresh).toEqual(["blocking"]);
			expect(replayed).toEqual(["blocking"]);
		});
	});

	// #4645 F5 recurrence (Greptile thread 2). The warm incumbent sent rows it had
	// already run the environment rule over, so an attached batch stored that
	// install-state verdict in this cache: after `npm ci` the replay still served
	// the install advice and a real error stayed a warning. Now the incumbent
	// sends the server's raw rows and its membership answer, and this reader runs
	// the one pipeline, so the entry holds the replayable form a local read
	// stores. Real path: the batch tool, the real IPC client over a real socket,
	// and the real incumbent handler serving from the same service double.
	describe("warm-attached batch cache (#4645)", () => {
		const declaredGap = {
			severity: 1,
			message:
				"Cannot find module 'left-pad' or its corresponding type declarations.",
			code: 2307,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			source: "typescript",
			serverId: "typescript",
		};
		const configured = (root: string) => ({
			executed: true,
			result: {
				success: true,
				body: { configFileName: path.join(root, "tsconfig.json") },
			},
		});
		const inferred = {
			executed: true,
			result: {
				success: true,
				body: { configFileName: "/dev/null/inferredProject1*" },
			},
		};
		let home: string;
		let priorHome: string | undefined;
		let incumbent: net.Server;
		let probe: ReturnType<typeof vi.fn>;
		// Set while the in-process incumbent serves a request: only it has a live
		// tsserver to ask, so only its probe is answered.
		let incumbentServing = false;
		let incumbentProbes = 0;

		function writtenFor(
			file: string,
		): Array<{ semantic: string; message: string }> {
			const call = reconcileScanDiagnostics.mock.calls
				.filter((c) => c[0] === file)
				.at(-1);
			return (call?.[1] ?? []) as Array<{ semantic: string; message: string }>;
		}

		beforeEach(async () => {
			fs.writeFileSync(
				path.join(tmpDir, "package.json"),
				JSON.stringify({ dependencies: { "left-pad": "1.3.0" } }),
			);
			// Shape 73: an install above the fixture would make the gap cells vacuous.
			expect(hasResolvableNodeModules(tmpDir)).toBe(false);
			probe = vi.fn();
			touchFile.mockResolvedValue({
				diags: [{ ...declaredGap }],
				confirmation: "confirmed",
			});
			mocked.service = installLspService(
				makeLspServiceDouble({
					touchFile,
					getDiagnostics: vi.fn().mockResolvedValue([]),
					getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
					getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
					ensureWarmForSweep: vi
						.fn()
						.mockResolvedValue({ performedWarmup: false }),
					executeReadOnlyCommandOnLiveClient: probe,
				}),
			);
			// A live incumbent the registry confirms: the parent pid, since the
			// liveness rule excludes this process by definition.
			home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-cache-"));
			priorHome = process.env.PI_LENS_HOME;
			process.env.PI_LENS_HOME = home;
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(home, "instances.json"),
				JSON.stringify({
					instances: [
						{
							pid: process.ppid,
							startedAt: now,
							projectRoot: normalizeFilePath(tmpDir),
							lspChildren: [],
							lspChildCount: 0,
							rssBytes: 1,
							heartbeatAt: now,
						},
					],
				}),
			);
			const endpoint = diagnosticsIpcPathForCwd(tmpDir, process.ppid);
			if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
			incumbent = net.createServer((socket) => {
				socket.setEncoding("utf8");
				socket.on("error", () => undefined);
				socket.on(
					"data",
					createWarmIpcLineReader(
						(line) => {
							incumbentServing = true;
							void _serveWarmRequestForTests(JSON.parse(line)).then((reply) => {
								incumbentServing = false;
								socket.end(`${JSON.stringify(reply)}\n`);
							});
						},
						{ label: "test-incumbent", onOverflow: () => socket.end() },
					),
				);
			});
			await new Promise<void>((resolve) =>
				incumbent.listen(boundUnixSocketPath(endpoint), resolve),
			);
			_setWarmAttachForTests(tmpDir, process.ppid);
		});

		afterEach(async () => {
			_resetWarmAttachForTests();
			(
				incumbent as net.Server & { closeAllConnections?: () => void }
			).closeAllConnections?.();
			await new Promise<void>((resolve) => incumbent.close(() => resolve()));
			if (priorHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = priorHome;
			removeTempDirSync(home);
		});

		/**
		 * One attached serve, an install landing from outside, one replay. The
		 * double serves both processes' calls, so it answers the probe only while
		 * the incumbent serves, and otherwise reports what an attached process
		 * always finds: no live client. A reader that probed for itself would see
		 * that answer. The budget is the production default (15 s) because the
		 * file's 50 ms leaves the incumbent no time before its send reserve, and
		 * then no answer is asked or carried.
		 *
		 * #5005 F1: the install lands in the FILE's own package directory, not at
		 * the root the answer route's pre-answer look stamps. That keeps this
		 * helper's replay a replay (the root-stamp case is the sibling cell in the
		 * environment-gap suite) while still exercising the re-promotion rule.
		 */
		async function serveInstallReplay(file: string, incumbentAnswer: unknown) {
			incumbentProbes = 0;
			probe.mockImplementation(async () => {
				if (!incumbentServing)
					return { executed: false, reason: "no live client" };
				incumbentProbes += 1;
				return incumbentAnswer;
			});
			await runBatch([file], 15_000);
			expect(isWarmAttached()).toBe(true);
			expect(touchFile).toHaveBeenCalledTimes(1);
			const probeCallsOnServe = incumbentProbes;
			const fresh = writtenFor(file)[0];
			fs.mkdirSync(path.join(path.dirname(file), "node_modules", "other"), {
				recursive: true,
			});
			reconcileScanDiagnostics.mockClear();
			touchFile.mockClear();
			await runBatch([file]);
			// A replay, never a second touch.
			expect(touchFile).not.toHaveBeenCalled();
			return { fresh, replayed: writtenFor(file)[0], probeCallsOnServe };
		}

		it("re-promotes an attached gap row once an install resolves (configured project)", async () => {
			fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
			const [file] = writeFiles(["pkg/a.ts"]);

			const { fresh, replayed, probeCallsOnServe } = await serveInstallReplay(
				file!,
				configured(tmpDir),
			);

			expect(fresh).toMatchObject({ semantic: "warning" });
			expect(fresh?.message).toContain(ENVIRONMENT_GAP_MARKER);
			expect(replayed).toMatchObject({ semantic: "blocking" });
			expect(replayed?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
			// The incumbent asked once; a reader's own probe finds no live client,
			// so the verdicts above came from the carried answer.
			expect(probeCallsOnServe).toBe(1);
		});

		// The single-`path` entry reads the attached reply through its own
		// demotion call (`runFileDiagnostics`), so it seeds the carried answer
		// separately from the batch.
		it("renders the incumbent's membership verdict for a single path (inferred project)", async () => {
			const [file] = writeFiles(["a.ts"]);
			touchFile.mockResolvedValue({
				diags: [
					{
						...declaredGap,
						message: "Type 'number' is not assignable to type 'string'.",
						code: 2322,
					},
				],
				confirmation: "confirmed",
			});
			incumbentProbes = 0;
			probe.mockImplementation(async () => {
				if (!incumbentServing)
					return { executed: false, reason: "no live client" };
				incumbentProbes += 1;
				return inferred;
			});

			await createLspDiagnosticsTool().execute(
				"diag-cache-test",
				{ path: file!, severity: "all", waitMs: 15_000 },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(isWarmAttached()).toBe(true);
			const [written] = writtenFor(file!);
			expect(written).toMatchObject({ semantic: "warning" });
			expect(written?.message).toContain(INFERRED_PROJECT_MARKER);
			expect(incumbentProbes).toBe(1);
		});

		it("keeps the incumbent's membership verdict on the replay after an install (inferred project)", async () => {
			fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
			const [file] = writeFiles(["pkg/a.ts"]);

			const { fresh, replayed, probeCallsOnServe } = await serveInstallReplay(
				file!,
				inferred,
			);

			// Environment rule first on the serve, as a local read gives it…
			expect(fresh?.message).toContain(ENVIRONMENT_GAP_MARKER);
			expect(fresh?.message).not.toContain(INFERRED_PROJECT_MARKER);
			// …and the replay keeps the membership verdict it cannot re-ask, with
			// no stale install advice.
			expect(replayed).toMatchObject({ semantic: "warning" });
			expect(replayed?.message).toContain(INFERRED_PROJECT_MARKER);
			expect(replayed?.message).not.toContain(ENVIRONMENT_GAP_MARKER);
			expect(probeCallsOnServe).toBe(1);
		});
	});
});
