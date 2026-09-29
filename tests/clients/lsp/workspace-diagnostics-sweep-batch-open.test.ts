/**
 * #608: a full-workspace sweep (`runWorkspaceDiagnostics`) over files that
 * aren't already open in the client's document set used to defeat #271's
 * `WatchedFilesQueue` debounce batching. `WatchedFilesQueue.enqueue` only arms
 * its flush timer on the FIRST call and just accumulates on every call after
 * that until the 100ms debounce window elapses (see watch-queue.ts) — a
 * mechanism built so a burst of file-opens coalesces into ONE project-wide
 * recheck notification instead of N.
 *
 * The sweep's per-file loop processes files SERIALLY, waiting up to several
 * seconds for each file's own diagnostics before moving to the next one. The
 * gap between consecutive first-opens during a sweep is always far longer
 * than the 100ms window, so the debounce never actually coalesced anything —
 * every previously-unopened file fired its own individual watched-files
 * notification, each independently triggering a project-wide recheck on a
 * single-threaded push-diagnostics server (classic tsserver). Later files
 * then timed out purely from queueing behind those rechecks.
 *
 * The fix pre-opens every swept file's document (in one fast, un-gated pass,
 * per server group) BEFORE the diagnostics-wait loop starts, so all the
 * watched-files enqueue calls land inside the SAME 100ms debounce window and
 * coalesce into one flush — restoring #271's "once per burst" intent for a
 * full sweep, not just per-edit dispatch bursts.
 *
 * #621 follow-up: the pre-open pass is now CHUNKED (default width 8, see
 * `WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE` and
 * workspace-diagnostics-sweep-preopen-chunk.test.ts) instead of firing the
 * WHOLE group's opens in one uninterrupted burst — a whole-group burst at
 * real project scale (~150 files) was found to overwhelm a single-threaded
 * server's request queue before any per-file diagnostics request got a turn.
 * This test's 12 files span 2 chunks (8+4), so it now expects 2 flushes
 * (one per chunk) instead of 1 (one for the whole group) — still far short of
 * 12 (one per file, the original #608 bug this test guards against).
 *
 * This test fakes the client's `notify.open` to reproduce the real
 * `WatchedFilesQueue` coalescing behavior (imported from source, not
 * reimplemented) plus a deliberately SLOW `waitForDiagnostics` (150ms, well
 * past the 100ms debounce) standing in for tsserver's real per-file
 * recompute latency — the exact condition that used to spread first-opens
 * past the debounce window one file at a time. If the pre-open batching
 * regressed back to "open lazily inside the per-file touch", this slow wait
 * would cause N flushes instead of one-per-chunk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident",
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics — batch-open restores #271 coalescing for a full sweep (#608)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-batchopen-"));
	});

	afterEach(() => removeTempDirSync(tmp));

	it("fires the watched-files notification once for a sweep over N previously-unopened files, not once per file", async () => {
		const fileNames = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
		for (const n of fileNames) fs.writeFileSync(path.join(tmp, n), "x\n");

		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		let flushCount = 0;
		let notifiedUriCount = 0;
		const openDocuments = new Set<string>();
		// The real coalescing primitive (#271) — not reimplemented, imported
		// from source — so this test exercises its actual debounce semantics.
		const watchQueue = new WatchedFilesQueue((changes) => {
			flushCount += 1;
			notifiedUriCount += changes.length;
		});

		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			notify: {
				// Mirrors `handleNotifyOpen`'s real branch structure closely enough
				// to reproduce the bug/fix: first open of a path enqueues a
				// watched-files change; a later call for an already-open path is
				// just a didChange (no further enqueue).
				open: vi.fn(async (filePath: string) => {
					if (openDocuments.has(filePath)) return;
					openDocuments.add(filePath);
					watchQueue.enqueue(`file://${filePath}`, 2);
				}),
			},
			// Deliberately slower than the 100ms debounce window — stands in for
			// tsserver's real per-file diagnostics latency. Without pre-opening
			// up front, serially awaiting this between each file's `notify.open`
			// would let the debounce timer fire and flush after every single
			// file, reproducing the pre-#608 bug.
			waitForDiagnostics: vi.fn(
				() => new Promise((resolve) => setTimeout(resolve, 150)),
			),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(fileNames.length);
		// Each file's document is opened once in the #608 pre-open pass (the
		// call that actually enqueues a watched-files change) and touched a
		// second time by the main per-file loop's own `touchFile` — which by
		// then finds the document already open and only sends the
		// already-open didChange equivalent (no further enqueue, mirrored by
		// this mock's early return). Plus exactly ONE extra `notify.open` from
		// the #667 pre-sweep warm-up touch, which runs against the group's
		// first file (f0.ts) BEFORE the #608 pre-open pass even starts — the
		// warm-up call is the one that actually opens f0.ts first; the pre-open
		// pass then finds it already open. One warm-up per GROUP (one server
		// here), not one per file.
		expect(client.notify.open).toHaveBeenCalledTimes(fileNames.length * 2 + 1);
		// The watched-files queue coalesces each CHUNK's first-opens into its
		// own single flush — 12 files at the default chunk width of 8 is 2
		// chunks (8+4), so 2 flushes from the #608 pre-open pass itself. The
		// #667 warm-up touch above runs BEFORE that pass and pays its own
		// (slow, 150ms) `waitForDiagnostics` wait standing alone against just
		// f0.ts — well past the 100ms debounce window on its own, so it closes
		// out its own flush before the pre-open pass's first chunk even starts
		// enqueuing. That predicts 3 flushes total (2 chunks + 1 warm-up),
		// still nowhere near one flush per file (12) — the #608 regression
		// this test guards against.
		//
		// The EXACT count is not pinned, though: `preOpenGroupFiles` (product
		// code) does a real `await nodeFs.promises.readFile` per file ahead of
		// each `notify.open`, racing the real 100ms debounce timer. Under
		// scheduler contention (full test-suite parallelism) that real I/O can
		// occasionally spread a single chunk's opens fractionally past the
		// window (one extra flush) — legitimate scheduling variance, not a
		// product bug (#902). So assert the invariant this test actually
		// guards — coalescing happened (not one flush for the whole sweep,
		// and nowhere near one per file) — with headroom for that jitter,
		// rather than the single exact number.
		expect(flushCount).toBeGreaterThan(1);
		expect(flushCount).toBeLessThanOrEqual(5); // 3 expected + jitter headroom
		expect(flushCount).toBeLessThan(fileNames.length); // never one-per-file (#608)
		expect(notifiedUriCount).toBe(fileNames.length); // no lost/duplicated URIs
	}, 10_000);
});

/**
 * #615: `preOpenGroupFiles` (the #608 fix above) had NO bound at all — unlike
 * every other per-file step in the sweep (`processFile`'s `touchFile` call is
 * `withDeadline`-wrapped). A real dogfooding incident hung an entire sweep
 * with no heartbeat, no progress, and no escape (pressing Escape didn't even
 * help, since the per-iteration `signal?.aborted` check never gets a turn
 * while stuck inside one file's await). Two bounds were added: a time-based
 * `withDeadline`, and a race against the abort signal so an explicit Escape
 * unblocks immediately rather than waiting out the rest of the per-file
 * budget.
 */
describe("runWorkspaceDiagnostics — pre-open is bounded, not just fast (#615)", () => {
	let tmp: string;
	const ORIGINAL_PER_FILE_MS = process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS;
	const ORIGINAL_NOTIFY_BUDGET_MS = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	const ORIGINAL_WARMUP_RETRY_BACKOFF_MS =
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsd-preopen-bound-"));
		// These tests' fake client's notify.open never resolves, so the #667
		// pre-sweep warm-up touch pays the full notify-write budget on both its
		// initial attempt and its retry, plus the backoff between them — flatten
		// both to near-zero so that dead time doesn't dominate the run. The
		// perFileMs bound actually under test is untouched: preOpenGroupFiles
		// bounds notify.open only via withDeadline(perFileMs) (index.ts:3610).
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
	});

	afterEach(() => {
		removeTempDirSync(tmp);
		if (ORIGINAL_PER_FILE_MS === undefined) {
			delete process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS;
		} else {
			process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS = ORIGINAL_PER_FILE_MS;
		}
		if (ORIGINAL_NOTIFY_BUDGET_MS === undefined) {
			delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		} else {
			process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = ORIGINAL_NOTIFY_BUDGET_MS;
		}
		if (ORIGINAL_WARMUP_RETRY_BACKOFF_MS === undefined) {
			delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		} else {
			process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS =
				ORIGINAL_WARMUP_RETRY_BACKOFF_MS;
		}
	});

	it("a pre-open call that never resolves does not hang the whole sweep — the per-file deadline unblocks it", async () => {
		process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS = "150";
		fs.writeFileSync(path.join(tmp, "a.ts"), "x\n");

		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			notify: {
				// Deliberately never resolves — reproduces a stuck notification
				// write / hung server. Before #615 this hung `preOpenGroupFiles`
				// forever, with no heartbeat and no way for the sweep to move on.
				open: vi.fn(() => new Promise<void>(() => {})),
			},
			waitForDiagnostics: vi.fn(async () => []),
			getDiagnostics: vi.fn(() => []),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const start = Date.now();
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);
		const elapsedMs = Date.now() - start;

		expect(results.length).toBe(1);
		// Should resolve close to the 150ms per-file deadline, not hang forever
		// (or for anywhere near the default 15s budget). With the warm-up dead
		// time flattened above, 1s still leaves ample margin over the deadline.
		expect(elapsedMs).toBeLessThan(1_000);
	}, 10_000);

	it("aborting mid-pre-open unblocks immediately, without waiting out the full per-file deadline", async () => {
		process.env.PI_LENS_LSP_WORKSPACE_PER_FILE_MS = "5000";
		fs.writeFileSync(path.join(tmp, "a.ts"), "x\n");

		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			notify: {
				open: vi.fn(() => new Promise<void>(() => {})),
			},
			waitForDiagnostics: vi.fn(async () => []),
			getDiagnostics: vi.fn(() => []),
		};
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await new LSPService().runWorkspaceDiagnostics(tmp, {
			signal: controller.signal,
		});
		const elapsedMs = Date.now() - start;

		// Aborted at ~50ms; must return well before the 5000ms per-file deadline
		// would have — proving the abort signal itself unblocks the stuck
		// pre-open, not just the timeout.
		expect(elapsedMs).toBeLessThan(2_000);
	}, 10_000);
});
