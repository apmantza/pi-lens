/**
 * #621: `runWorkspaceDiagnostics`'s #608 pre-open pass fired EVERY file in a
 * server group's `didOpen` back-to-back, in one uninterrupted burst, before
 * the per-file diagnostics-wait loop started. That kept #271's
 * `WatchedFilesQueue` debounce coalescing intent (one flush per burst, not one
 * per file — see workspace-diagnostics-sweep-batch-open.test.ts), but at real
 * project scale (~150 files, one server group is the common single-language
 * case) it also dumped the WHOLE group on the server's single-threaded
 * request queue at once — observed (pi-drykiss dogfooding, ~150 TS files) to
 * collapse a full sweep to near-100% per-file timeouts, because the server
 * has to ingest/typecheck the entire burst before any per-file diagnostics
 * request even gets a turn.
 *
 * The fix chunks the pre-open+process cycle to
 * `WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE` (default 8, matching `lsp_diagnostics`'
 * own bounded-concurrency batch default) instead of the whole group. This
 * test proves BOTH properties hold after chunking:
 *  1. No single burst of opens-without-an-intervening-diagnostics-wait ever
 *     exceeds the chunk size, regardless of total group size (bounds the
 *     server-queue flood that #621 reports).
 *  2. Each chunk's opens still land inside the 100ms debounce window and
 *     coalesce into ONE flush per chunk — i.e. flush count is
 *     ceil(fileCount / chunkSize), not one-per-file (which would mean the
 *     #608 cascade bug reintroduced) and not one total for the whole group
 *     (which would mean chunking did nothing).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchedFilesQueue } from "../../../clients/lsp/watch-queue.js";

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
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics — pre-open is chunked, not whole-group (#621)", () => {
	let tmp: string;
	const ORIGINAL_CHUNK_ENV = process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-preopen-chunk-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		if (ORIGINAL_CHUNK_ENV === undefined) {
			delete process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK;
		} else {
			process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK = ORIGINAL_CHUNK_ENV;
		}
	});

	it("never opens more than the chunk size in a burst, and coalesces one flush per chunk (not per file, not one for the whole group)", async () => {
		process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK = "8";
		const fileNames = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
		for (const n of fileNames) fs.writeFileSync(path.join(tmp, n), "x\n");

		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		let flushCount = 0;
		let notifiedUriCount = 0;
		const openDocuments = new Set<string>();
		const watchQueue = new WatchedFilesQueue((changes) => {
			flushCount += 1;
			notifiedUriCount += changes.length;
		});

		// Track the largest run of NEW (first-time, enqueuing) document opens
		// that happened without an intervening `waitForDiagnostics` call — the
		// actual server-queue burst size the fix is meant to bound. An
		// already-open file's second `notify.open` call (fired by `processFile`'s
		// own `touchFile`) is the cheap already-open didChange branch, not a new
		// enqueue, so it's excluded from this count the same way the real
		// `handleNotifyOpen` treats it.
		let opensSinceLastWait = 0;
		let maxBurst = 0;

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
				open: vi.fn(async (filePath: string) => {
					if (openDocuments.has(filePath)) return;
					openDocuments.add(filePath);
					opensSinceLastWait += 1;
					maxBurst = Math.max(maxBurst, opensSinceLastWait);
					watchQueue.enqueue(`file://${filePath}`, 2);
				}),
			},
			// Slow enough (well past the 100ms debounce) to reproduce the exact
			// condition that used to spread first-opens across separate debounce
			// windows one file at a time (pre-#608).
			waitForDiagnostics: vi.fn(async () => {
				opensSinceLastWait = 0;
				return new Promise((resolve) => setTimeout(resolve, 20));
			}),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(fileNames.length);
		// Bounded burst: never more than the configured chunk size (8), never the
		// whole 40-file group.
		expect(maxBurst).toBeLessThanOrEqual(8);
		// Coalesced per chunk: ceil(40 / 8) = 5 flushes, not 1 (whole-group,
		// pre-fix) and not 40 (per-file, the original #608 bug).
		expect(flushCount).toBe(5);
		expect(notifiedUriCount).toBe(fileNames.length);
	}, 15_000);

	it("a group smaller than the chunk size still coalesces into a single flush (no behavior change for small sweeps)", async () => {
		process.env.PI_LENS_LSP_WORKSPACE_PREOPEN_CHUNK = "8";
		const fileNames = Array.from({ length: 5 }, (_, i) => `f${i}.ts`);
		for (const n of fileNames) fs.writeFileSync(path.join(tmp, n), "x\n");

		const tsServer = makeServer("typescript", ".ts");
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);

		let flushCount = 0;
		const openDocuments = new Set<string>();
		const watchQueue = new WatchedFilesQueue(() => {
			flushCount += 1;
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
				open: vi.fn(async (filePath: string) => {
					if (openDocuments.has(filePath)) return;
					openDocuments.add(filePath);
					watchQueue.enqueue(`file://${filePath}`, 2);
				}),
			},
			waitForDiagnostics: vi.fn(
				() => new Promise((resolve) => setTimeout(resolve, 20)),
			),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(5);
		expect(flushCount).toBe(1);
	}, 10_000);
});
