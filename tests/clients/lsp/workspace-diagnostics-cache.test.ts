/**
 * #671: `runWorkspaceDiagnostics` (`lens_diagnostics mode=full`'s engine) and
 * `tools/lsp-diagnostics.ts`'s batch/directory sweep used to re-touch every
 * swept file through the language server(s) on every single call — even a
 * repeat sweep with zero intervening edits paid the full LSP round-trip cost
 * for every file both times. This suite covers the persisted per-file cache
 * (`clients/lsp/workspace-diagnostics-cache.ts`) that fixes that: pure
 * load/save/freshness unit tests here, plus an end-to-end
 * `runWorkspaceDiagnostics`-level proof (mirroring
 * `tests/clients/lsp/sweep-warmup.test.ts`'s fixture style) that a second,
 * unchanged sweep performs zero fresh `touchFile`/diagnostics-wait calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildScopeKey,
	cacheKeyFor,
	createWorkspaceDiagnosticsCacheContext,
	isEntryFresh,
	loadWorkspaceDiagnosticsCache,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
	type WorkspaceDiagnosticsCacheEntry,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-cache-"));
	// Legacy per-project data dir marker so the cache file writes INSIDE tmp
	// (cleaned up by afterEach) instead of the real global ~/.pi-lens dir.
	fs.mkdirSync(path.join(tmp, ".pi-lens"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(
	overrides: Partial<WorkspaceDiagnosticsCacheEntry> = {},
): WorkspaceDiagnosticsCacheEntry {
	return {
		diagnostics: [],
		count: 0,
		mtimeMs: 0,
		scannedAt: Date.now(),
		scopeKey: "all|",
		...overrides,
	};
}

describe("loadWorkspaceDiagnosticsCache / saveWorkspaceDiagnosticsCache (#671)", () => {
	it("round-trips a saved cache", () => {
		const entry = makeEntry({ mtimeMs: 123, count: 1, diagnostics: [] });
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: { "/a.ts": entry },
		});
		const loaded = loadWorkspaceDiagnosticsCache(tmp);
		expect(loaded?.entries["/a.ts"]).toEqual(entry);
	});

	it("fails open (undefined) when nothing has been cached yet", () => {
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("fails open on a corrupt cache file", () => {
		const cacheFile = path.join(tmp, ".pi-lens", "cache", "lsp-workspace-diagnostics.json");
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, "{ not json");
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("fails open on a version mismatch (future/older cache format)", () => {
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION + 1,
			entries: { "/a.ts": makeEntry() },
		});
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("fails open when entries is missing/malformed", () => {
		const cacheFile = path.join(tmp, ".pi-lens", "cache", "lsp-workspace-diagnostics.json");
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION }),
		);
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});
});

describe("isEntryFresh (#671)", () => {
	let filePath: string;

	beforeEach(() => {
		filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
	});

	it("is fresh when the file's mtime exactly matches the entry and there's no dep graph", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({ mtimeMs, scannedAt: Date.now() });
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(true);
	});

	it("is stale when the file's mtime has moved since the entry was recorded", () => {
		const entry = makeEntry({ mtimeMs: 1, scannedAt: Date.now() });
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(false);
	});

	it("is stale when the file no longer exists", () => {
		const entry = makeEntry({ mtimeMs: 1 });
		expect(
			isEntryFresh(path.join(tmp, "missing.ts"), entry, () => undefined),
		).toBe(false);
	});

	it("is stale when a dependency changed after the entry's scannedAt, even though the file's own mtime is unchanged (cross-file blind spot fix)", () => {
		const depPath = path.join(tmp, "dep.ts");
		fs.writeFileSync(depPath, "export const x = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const scannedAt = Date.now() - 10_000; // entry recorded 10s ago
		const entry = makeEntry({ mtimeMs, scannedAt });
		// Dependency's current mtime is "now" — after scannedAt.
		expect(
			isEntryFresh(filePath, entry, () => [depPath]),
		).toBe(false);
	});

	it("stays fresh when every dependency is older than the entry's scannedAt", () => {
		const depPath = path.join(tmp, "dep.ts");
		fs.writeFileSync(depPath, "export const x = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const scannedAt = Date.now() + 10_000; // entry "recorded" after the dep's mtime
		const entry = makeEntry({ mtimeMs, scannedAt });
		expect(isEntryFresh(filePath, entry, () => [depPath])).toBe(true);
	});

	it("is stale when a dependency has been deleted (fail closed)", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({ mtimeMs, scannedAt: Date.now() });
		expect(
			isEntryFresh(filePath, entry, () => [path.join(tmp, "gone.ts")]),
		).toBe(false);
	});
});

describe("buildScopeKey / cacheKeyFor (#671)", () => {
	it("produces a stable key independent of exclude-list ordering", () => {
		expect(buildScopeKey("all", ["b", "a"])).toBe(buildScopeKey("all", ["a", "b"]));
	});

	it("distinguishes scopes that differ in clientScope or exclusions", () => {
		expect(buildScopeKey("all")).not.toBe(buildScopeKey("primary"));
		expect(buildScopeKey("all", ["opengrep"])).not.toBe(buildScopeKey("all"));
	});

	it("normalizes path separators/casing the same way for repeated calls", () => {
		const a = cacheKeyFor("C:/tmp/Foo.ts");
		const b = cacheKeyFor("C:/tmp/Foo.ts");
		expect(a).toBe(b);
	});
});

describe("WorkspaceDiagnosticsCacheContext (#671)", () => {
	it("lookup misses when nothing has been recorded", () => {
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(path.join(tmp, "a.ts"), "all|")).toBeUndefined();
	});

	it("record then lookup (same scopeKey) hits within the SAME context instance", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		ctx.record(filePath, "all|", [], mtimeMs);
		expect(ctx.lookup(filePath, "all|")).toEqual({ diagnostics: [], count: 0 });
	});

	it("a lookup under a DIFFERENT scopeKey never sees an entry recorded under another scope", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		// Recorded under the workspace-sweep scope (excludes opengrep)...
		ctx.record(filePath, buildScopeKey("all", ["opengrep"]), [], mtimeMs);
		// ...must not satisfy a lookup under the lsp_diagnostics batch scope
		// (no exclusions) — different coverage, must not cross-serve.
		expect(ctx.lookup(filePath, buildScopeKey("all"))).toBeUndefined();
	});

	it("persists across context instances (round-trips through disk)", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const diag = [
			{
				severity: 1 as const,
				message: "boom",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			},
		];

		const first = createWorkspaceDiagnosticsCacheContext(tmp);
		first.record(filePath, "all|", diag, mtimeMs);
		first.persist();

		const second = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(second.lookup(filePath, "all|")).toEqual({
			diagnostics: diag,
			count: 1,
		});
	});

	it("persist() is a no-op (never throws, never writes) when nothing was recorded", () => {
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(() => ctx.persist()).not.toThrow();
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("carries over untouched pre-existing entries when a later context only records a different file", () => {
		const fileA = path.join(tmp, "a.ts");
		const fileB = path.join(tmp, "b.ts");
		fs.writeFileSync(fileA, "const a = 1;\n");
		fs.writeFileSync(fileB, "const b = 1;\n");

		const first = createWorkspaceDiagnosticsCacheContext(tmp);
		first.record(fileA, "all|", [], fs.statSync(fileA).mtimeMs);
		first.persist();

		const second = createWorkspaceDiagnosticsCacheContext(tmp);
		second.record(fileB, "all|", [], fs.statSync(fileB).mtimeMs);
		second.persist();

		const third = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(third.lookup(fileA, "all|")).toBeDefined();
		expect(third.lookup(fileB, "all|")).toBeDefined();
	});
});

// --- runWorkspaceDiagnostics end-to-end cache behavior ---
// Mirrors tests/clients/lsp/sweep-warmup.test.ts's fixture style: a fake
// single-server client whose `waitForDiagnostics` calls are countable, so a
// second sweep's call count directly proves whether the cache short-circuited
// the per-file touch loop.

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeTsServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

function makeFakeClient(root: string) {
	const waitCalls: Array<{ filePath: string; ms: number }> = [];
	return {
		client: {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
		waitCalls,
	};
}

describe("runWorkspaceDiagnostics cache integration (#671)", () => {
	let tmpSweep: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmpSweep = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sweep-cache-"));
		fs.mkdirSync(path.join(tmpSweep, ".pi-lens"));
	});
	afterEach(() => fs.rmSync(tmpSweep, { recursive: true, force: true }));

	it("a second identical sweep performs zero fresh diagnostics-wait calls (full cache hit)", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) {
			fs.writeFileSync(path.join(tmpSweep, n), "const z = 1;\n");
		}
		const tsServer = makeTsServer(tmpSweep);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmpSweep);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const first = await service.runWorkspaceDiagnostics(tmpSweep);
		expect(first.length).toBe(3);
		const callsAfterFirstSweep = waitCalls.length;
		expect(callsAfterFirstSweep).toBeGreaterThan(0);

		const second = await service.runWorkspaceDiagnostics(tmpSweep);
		expect(second.length).toBe(3);
		// No new diagnostics-wait round trips — every file was served from cache.
		expect(waitCalls.length).toBe(callsAfterFirstSweep);
	});

	it("a changed file still gets a fresh touch on the second sweep; unchanged siblings stay cached", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) {
			fs.writeFileSync(path.join(tmpSweep, n), "const z = 1;\n");
		}
		const tsServer = makeTsServer(tmpSweep);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmpSweep);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.runWorkspaceDiagnostics(tmpSweep);
		const callsAfterFirstSweep = waitCalls.length;

		// Mutate one file — bump its mtime forward so the cache treats it as
		// changed regardless of filesystem mtime-resolution granularity.
		const changed = path.join(tmpSweep, "a.ts");
		fs.writeFileSync(changed, "const z = 2;\n");
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(changed, future, future);

		await service.runWorkspaceDiagnostics(tmpSweep);
		// Exactly one new wait call (for the single changed file) — the other
		// two unchanged files were served from cache again.
		expect(waitCalls.length).toBe(callsAfterFirstSweep + 1);
		expect(waitCalls[waitCalls.length - 1]?.filePath).toBe(changed);
	});
});
