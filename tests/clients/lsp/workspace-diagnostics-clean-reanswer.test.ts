/**
 * #1782 defect C: an explicit clean re-answer could not dislodge a stale cache
 * entry.
 *
 * A `workspace/diagnostic` pull returns a PROJECT-WIDE report. `tryWorkspacePull`
 * mapped that report over `groupFiles` only, so every answer for a file outside
 * the current touch group was discarded — including answers for files this same
 * sweep had just served from cache, which are precisely the files whose entries
 * nothing else can refresh.
 *
 * The 2026-08-20 dogfood caught the consequence: at 23:07 the typescript server
 * re-answered both ghost files with zero diagnostics, and two widget saves later
 * all five stale blocking rows were still in the widget store and in
 * `cache/lsp-workspace-diagnostics.json`. There was no user-reachable way to
 * clear them.
 *
 * The fix routes an explicit zero-diagnostic answer for a cache-served file back
 * through the sweep's ordinary result list, so the cache write overwrites the
 * stale entry and the footer reconcile (`tools/lens-diagnostics.ts`) clears the
 * widget rows. No second eviction path.
 *
 * These entries are deliberately stamped AFTER the session start, so the #1782
 * expiry gate does NOT fire and this suite isolates the clean-re-answer path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildScopeKey,
	cacheKeyFor,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import {
	clearWidgetState,
	getFileDiagnostics,
	reconcileScanDiagnostics,
} from "../../../clients/widget-state.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { resetWorkspaceDiagnosticsCacheSession } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

const SWEEP_SCOPE = buildScopeKey("all", ["opengrep"]);

function ghostDiagnostic() {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1 as const,
		code: 2339,
		source: "typescript",
		serverId: "typescript",
		message: "Property 'foo' does not exist on type 'Bar'.",
	};
}

describe("a clean re-answer evicts a cache-served entry (#1782 defect C)", () => {
	let tmp: string;
	let ghost: string;
	let other: string;

	beforeEach(() => {
		vi.resetModules();
		clearWidgetState();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-clean-reanswer-"));
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";

		ghost = path.join(tmp, "ghost.ts");
		other = path.join(tmp, "other.ts");
		fs.writeFileSync(ghost, "export const a = 1;\n");
		fs.writeFileSync(other, "export const b = 2;\n");
	});

	/**
	 * Seed the ghost entry and arm the session clock on the module instance the
	 * service will actually load. `vi.resetModules()` in `beforeEach` means the
	 * dynamic `import` below is a FRESH copy of the cache module, so arming the
	 * statically imported one would leave the service's copy defaulted to import
	 * time — and the entry would expire under the #1782 age gate instead of
	 * exercising the clean-re-answer path this suite is about.
	 *
	 * The session started an hour ago and the entry was recorded a minute ago, so
	 * it sits inside the session and inside the age ceiling. Only an explicit
	 * clean re-answer can dislodge it.
	 */
	async function seedGhostEntry() {
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const sessionModule =
			await import("../../../clients/lsp/workspace-diagnostics-session.js");
		sessionModule.resetWorkspaceDiagnosticsCacheSession(
			Date.now() - 60 * 60_000,
		);
		cacheModule.saveWorkspaceDiagnosticsCache(tmp, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(ghost)]: {
					diagnostics: [ghostDiagnostic()],
					count: 1,
					mtimeMs: fs.statSync(ghost).mtimeMs,
					scannedAt: Date.now() - 60_000,
					scopeKey: SWEEP_SCOPE,
				},
			},
		});
	}

	afterEach(() => {
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		removeTempDirSync(tmp);
		clearWidgetState();
		resetWorkspaceDiagnosticsCacheSession();
	});

	/** A pull-capable typescript client whose report names BOTH files clean. */
	function mockCleanPull(reportFiles: string[]) {
		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => tmp,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			root: tmp,
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: true,
				mode: "pull" as const,
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			requestWorkspaceDiagnostics: vi.fn(async () =>
				reportFiles.map((filePath) => ({ filePath, diagnostics: [] })),
			),
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});
	}

	it("evicts the stale entry from the persisted cache", async () => {
		await seedGhostEntry();
		mockCleanPull([ghost, other]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(ghost)];
		// Pre-fix: the pull's answer for `ghost` was discarded because `ghost` was
		// not in the touch group, so the entry survived with its blocker intact.
		expect(entry?.diagnostics ?? []).toHaveLength(0);
		expect(entry?.count ?? -1).toBe(0);
	});

	it("returns exactly one result for the file, and it is the clean one", async () => {
		await seedGhostEntry();
		mockCleanPull([ghost, other]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		const forGhost = results.filter(
			(r) => cacheKeyFor(r.filePath) === cacheKeyFor(ghost),
		);
		// Two contradictory results for one file would let the stale one win on
		// ordering downstream, so the cached replay must be dropped, not merely
		// accompanied.
		expect(forGhost).toHaveLength(1);
		expect(forGhost[0]?.count).toBe(0);
	});

	it("clears the file's blocking rows from the widget store", async () => {
		// Seed the widget exactly as the previous session's reconcile left it.
		reconcileScanDiagnostics(
			ghost,
			convertLspDiagnostics([ghostDiagnostic()], ghost, {
				scanOrigin: "lens_diagnostics_full",
			}),
			true,
		);
		expect(getFileDiagnostics(ghost) ?? []).toHaveLength(1);

		await seedGhostEntry();
		mockCleanPull([ghost, other]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		// The footer reconcile in `tools/lens-diagnostics.ts` feeds every confirmed
		// result through `reconcileScanDiagnostics`; replay that here over the
		// sweep's own output. Pre-fix the sweep handed it the cached replay
		// (count 1), which re-cemented the blocker; post-fix it hands it the clean
		// answer and the rows go.
		for (const result of results) {
			reconcileScanDiagnostics(
				result.filePath,
				convertLspDiagnostics(result.diagnostics, result.filePath, {
					scanOrigin: "lens_diagnostics_full",
				}),
				true,
				result.writeIndex,
				result.observedAt,
			);
		}
		expect(getFileDiagnostics(ghost) ?? []).toHaveLength(0);
	});

	it("does NOT evict on mere absence from the report — absence is unknown for a file nobody asked about", async () => {
		// The report names only `other`. `ghost` is absent, which for a file this
		// sweep never asked about is not evidence of anything.
		await seedGhostEntry();
		mockCleanPull([other]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(ghost)];
		expect(entry?.diagnostics ?? []).toHaveLength(1);
	});

	it("does NOT let a pull's non-empty answer for an unasked file overwrite the sweep-scope entry", async () => {
		// The pull covers the PRIMARY server only, while the sweep's scopeKey
		// covers every server minus opengrep. A non-empty primary answer is not a
		// complete answer under that scope, so it must not be written as one.
		await seedGhostEntry();
		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => tmp,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			root: tmp,
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: true,
				mode: "pull" as const,
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			requestWorkspaceDiagnostics: vi.fn(async () => [
				{ filePath: other, diagnostics: [] },
				{
					filePath: ghost,
					diagnostics: [{ ...ghostDiagnostic(), code: 9999 }],
				},
			]),
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(ghost)];
		expect(entry?.diagnostics?.[0]?.code).toBe(2339);
	});
});

/**
 * #1786 review F2: the report builder (`clients/lsp/client.ts`) pushes one
 * output entry per report ITEM with no dedup, so a server that names the same
 * URI twice produces two entries for one file. The harvest must not let a ZERO
 * entry win just because a duplicate exists, and must never emit two results
 * for one file.
 *
 * #1786 review F3: the `reanswerFor` membership filter is load-bearing — a
 * clean report entry for a file that is neither asked about nor served from
 * cache must not enter the sweep's results at all.
 */
describe("duplicate and unrelated report entries (#1786 review F2/F3)", () => {
	let tmp: string;
	let ghost: string;
	let other: string;
	let stranger: string;

	beforeEach(() => {
		vi.resetModules();
		clearWidgetState();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-dup-report-"));
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		process.env.PI_LENS_LSP_WORKSPACE_PULL = "1";
		ghost = path.join(tmp, "ghost.ts");
		other = path.join(tmp, "other.ts");
		// Outside the swept tree, so the sweep never asks about it and it is not
		// in the cache either.
		stranger = path.join(tmp, ".pi-lens", "stranger.ts");
		fs.writeFileSync(ghost, "export const a = 1;\n");
		fs.writeFileSync(other, "export const b = 2;\n");
		fs.writeFileSync(stranger, "export const c = 3;\n");
	});

	afterEach(() => {
		delete process.env.PI_LENS_LSP_WORKSPACE_PULL;
		removeTempDirSync(tmp);
		clearWidgetState();
		resetWorkspaceDiagnosticsCacheSession();
	});

	async function seed() {
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const sessionModule =
			await import("../../../clients/lsp/workspace-diagnostics-session.js");
		sessionModule.resetWorkspaceDiagnosticsCacheSession(
			Date.now() - 60 * 60_000,
		);
		cacheModule.saveWorkspaceDiagnosticsCache(tmp, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(ghost)]: {
					diagnostics: [ghostDiagnostic()],
					count: 1,
					mtimeMs: fs.statSync(ghost).mtimeMs,
					scannedAt: Date.now() - 60_000,
					scopeKey: SWEEP_SCOPE,
				},
			},
		});
	}

	function mockReport(
		report: Array<{ filePath: string; diagnostics: unknown[] }>,
	) {
		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => tmp,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			root: tmp,
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: true,
				mode: "pull" as const,
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			requestWorkspaceDiagnostics: vi.fn(async () => report),
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});
	}

	it("does not evict when the same file also carries a findings entry (findings first)", async () => {
		await seed();
		mockReport([
			{ filePath: other, diagnostics: [] },
			{ filePath: ghost, diagnostics: [ghostDiagnostic()] },
			{ filePath: ghost, diagnostics: [] },
		]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(ghost)];
		expect(entry?.diagnostics ?? []).toHaveLength(1);
	});

	it("does not evict when the same file also carries a findings entry (zero first)", async () => {
		await seed();
		mockReport([
			{ filePath: other, diagnostics: [] },
			{ filePath: ghost, diagnostics: [] },
			{ filePath: ghost, diagnostics: [ghostDiagnostic()] },
		]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		await new LSPService().runWorkspaceDiagnostics(tmp);

		const entry =
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(ghost)];
		expect(entry?.diagnostics ?? []).toHaveLength(1);
	});

	it("emits exactly one result for a file named twice, both times clean", async () => {
		await seed();
		mockReport([
			{ filePath: other, diagnostics: [] },
			{ filePath: ghost, diagnostics: [] },
			{ filePath: ghost, diagnostics: [] },
		]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		const forGhost = results.filter(
			(r) => cacheKeyFor(r.filePath) === cacheKeyFor(ghost),
		);
		expect(forGhost).toHaveLength(1);
		expect(forGhost[0]?.count).toBe(0);
	});

	it("ignores a clean entry for a file that is neither asked about nor cache-served (F3)", async () => {
		await seed();
		mockReport([
			{ filePath: other, diagnostics: [] },
			{ filePath: ghost, diagnostics: [] },
			{ filePath: stranger, diagnostics: [] },
		]);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmp);

		expect(
			results.some((r) => cacheKeyFor(r.filePath) === cacheKeyFor(stranger)),
		).toBe(false);
		// The cache must not gain an entry for it either.
		expect(
			loadWorkspaceDiagnosticsCache(tmp)?.entries[cacheKeyFor(stranger)],
		).toBeUndefined();
	});
});
