/**
 * #1104: the workspace pull-sweep record site (`runWorkspaceDiagnostics` in
 * clients/lsp/index.ts) used to call `workspaceDiagnosticsCacheCtx.record()`
 * with NO contentHash — documented as an honest "unknown" (#1095's own doc
 * comment). That meant every pull-served cache entry could never demote via
 * the #1095 P2-1 service-sweep binding gate (`workspace-diagnostics-cache.
 * test.ts` covers that gate directly with a hand-seeded entry).
 *
 * This suite proves the PRODUCE side end-to-end: a pull's `contentHash` (now
 * threaded from `clients/lsp/client.ts`'s `requestWorkspaceDiagnostics`
 * through `tryWorkspacePull`) actually reaches the persisted cache entry, and
 * composing that with the pre-existing P2-1 CONSUME gate demotes a
 * mtime-preserving content change that previously would have been replayed
 * as confirmed forever.
 *
 * Also covers the sibling per-file touch path (`processFile`): the #1095
 * push-path binding attached to `touchFile`'s returned diagnostics array is a
 * NON-ENUMERABLE property (`Object.defineProperty(collected, "binding", ...)`).
 * `applyAuxiliarySuppressions` rebuilds the array via `.filter()`, which does
 * NOT carry non-enumerable properties on a copy (AGENTS.md shape 5) — so the
 * record site must read the binding off the RAW diagnostics before that
 * filter runs, not off the filtered copy.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import {
	cacheKeyFor,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

describe("runWorkspaceDiagnostics pull-sweep content binding (#1104)", () => {
	let tmp: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-pull-binding-"));
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		removeTempDirSync(tmp);
	});

	it("threads the pull's contentHash into the persisted cache entry (previously always absent)", async () => {
		const file = path.join(tmp, "a.py");
		const content = "x = 1\n";
		fs.writeFileSync(file, content);
		const pyServer = makeServer("python", ".py", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".py") ? [pyServer] : [],
		);
		const contentHash = hashDiagnosticContent(content);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "python",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: true,
				mode: "pull" as const,
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			requestWorkspaceDiagnostics: vi.fn(async () => [
				{
					filePath: file,
					diagnostics: [{ message: "boom", serverId: "python" }],
					contentHash,
				},
			]),
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const cache = loadWorkspaceDiagnosticsCache(tmp);
		const entry = cache?.entries[cacheKeyFor(file)];
		expect(entry).toBeDefined();
		// HEADLINE (fails pre-#1104): the record site never passed a contentHash
		// at all, so this field was always undefined regardless of what the pull
		// returned.
		expect(entry?.contentHash).toBe(contentHash);
	});

	it("HEADLINE fail-then-pass: a pull-recorded entry whose content changed (mtime-preserving) is NOT replayed on the next sweep", async () => {
		const file = path.join(tmp, "a.py");
		const originalContent = "x = 1\n";
		fs.writeFileSync(file, originalContent);
		const pyServer = makeServer("python", ".py", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".py") ? [pyServer] : [],
		);
		const requestWorkspaceDiagnostics = vi.fn(async () => [
			{
				filePath: file,
				diagnostics: [{ message: "boom", serverId: "python" }],
				contentHash: hashDiagnosticContent(originalContent),
			},
		]);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "python",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: true,
				mode: "pull" as const,
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			requestWorkspaceDiagnostics,
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.runWorkspaceDiagnostics(tmp);
		expect(requestWorkspaceDiagnostics).toHaveBeenCalledTimes(1);

		// The file's real bytes changed WITHOUT an mtime bump — corrupt the
		// persisted entry's contentHash the same deterministic way #1095's own
		// P2-1 gate test does (`workspace-diagnostics-cache.test.ts`), avoiding
		// OS mtime-resolution flakiness while representing exactly the same
		// invalidation shape (recorded fingerprint no longer matches disk under
		// a matching mtime).
		const cachePath = path.join(
			tmp,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		const key = cacheKeyFor(file);
		expect(raw.entries[key].contentHash).toBe(
			hashDiagnosticContent(originalContent),
		);
		raw.entries[key].contentHash = hashDiagnosticContent("x = 999\n");
		fs.writeFileSync(cachePath, JSON.stringify(raw, null, 2));

		// A second sweep: pre-#1104 the entry's contentHash was NEVER recorded in
		// the first place, so its binding always read "unknown" (`!== false`) and
		// the cache hit would have been served — zero further pull calls. Post-
		// #1104 the mismatch demotes the entry, so the sweep falls through to a
		// fresh pull.
		await service.runWorkspaceDiagnostics(tmp);
		expect(requestWorkspaceDiagnostics).toHaveBeenCalledTimes(2);
	});

	it("threads a per-file touch's #1095 binding contentHash into the cache, surviving applyAuxiliarySuppressions' .filter() copy (shape 5)", async () => {
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL; // exercise the per-file touch path, not the pull fast path
		const file = path.join(tmp, "a.ts");
		const content = "const z = 1;\n";
		fs.writeFileSync(file, content);
		const tsServer = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const contentHash = hashDiagnosticContent(content);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			// touchFile's real merge logic (index.ts, not mocked) composes each
			// spawned client's `getDiagnosticBinding` into the non-enumerable
			// `.binding` it attaches to the returned diagnostics array.
			getDiagnosticBinding: () => ({ contentHash }),
			getDiagnostics: vi.fn(() => [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			]),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const cache = loadWorkspaceDiagnosticsCache(tmp);
		const entry = cache?.entries[cacheKeyFor(file)];
		expect(entry).toBeDefined();
		// HEADLINE (fails pre-#1104): `processFile` read `.binding` off the
		// FILTERED copy (or didn't read it at all), which never carries the
		// source array's non-enumerable property.
		expect(entry?.contentHash).toBe(contentHash);
	});
});
