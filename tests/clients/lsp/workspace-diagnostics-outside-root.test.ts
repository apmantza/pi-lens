/**
 * #2052 fix round 1 (F3): a sweep over files outside every registered session
 * root must not report them as confirmed clean, and must not persist that
 * false clean into the workspace cache.
 *
 * `runWorkspaceDiagnostics` never read `touchFile`'s `skipReason`. A declined
 * foreign file therefore arrived as `timedOut: false` with an empty
 * `diagnostics` array — indistinguishable from a real clean answer. The record
 * loop then wrote that empty result into
 * `cache/lsp-workspace-diagnostics.json`, so the false clean replayed on every
 * later sweep even after the decline itself was working correctly.
 *
 * The decline now enters the unconfirmed lane as `outside_project_root`, which
 * is the same flag the cache write-back already uses to skip unconfirmed
 * results. One mechanism, not a second parallel filter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cacheKeyFor,
	loadWorkspaceDiagnosticsCache,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { resetWorkspaceDiagnosticsCacheSession } from "../../../clients/lsp/workspace-diagnostics-session.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

// Only server selection is stubbed, so no language server is spawned. The
// session-root registry lives in its own unmocked module, so the REAL
// predicate decides the decline — that is the behavior under test. That
// `initLSPConfig` populates that registry is pinned separately in
// tests/clients/lsp/root-coalescing.test.ts, which mocks nothing.
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: () => undefined,
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

describe("#2052 sweep over a foreign root does not report or cache a clean", () => {
	let sessionDir: string;
	let foreignDir: string;
	let foreignFile: string;

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();

		sessionDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-wsd-2052-session-"),
		);
		fs.mkdirSync(path.join(sessionDir, ".pi-lens"));
		// A sibling worktree with its OWN tsconfig — the exact shape from the
		// issue's evidence (a `pi-agent-*` temp worktree).
		foreignDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-wsd-2052-foreign-"),
		);
		fs.mkdirSync(path.join(foreignDir, ".pi-lens"));
		fs.writeFileSync(path.join(foreignDir, "tsconfig.json"), "{}\n");
		foreignFile = path.join(foreignDir, "app.ts");
		fs.writeFileSync(foreignFile, "export const a: number = 1;\n");

		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			idleEviction: "resident",
			root: async (filePath: string) =>
				filePath.startsWith(sessionDir) ? sessionDir : foreignDir,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			serverId: "typescript",
			root: foreignDir,
			getWorkspaceDiagnosticsSupport: () => ({ advertised: false }),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		});
	});

	/**
	 * Build the module graph for ONE test, then declare the session root inside
	 * it. `vi.resetModules()` gives each test a fresh graph, so the registry
	 * must be populated through the SAME graph that `index.js` closes over —
	 * registering in `beforeEach` instead let a later test reuse an earlier
	 * test's `index.js` instance pointing at a registry that was already reset.
	 */
	async function loadServiceWithSession() {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		// Imported AFTER index.js so both resolve to the same module instance in
		// this test's graph. Registering via a separately-resolved copy (for
		// example through `vi.importActual`) populates a DIFFERENT instance, and
		// the service then reads an empty registry and serves the file.
		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		// Only sessionDir is a session root. foreignDir is not.
		roots.registerSessionRoot(sessionDir);
		return new LSPService();
	}

	afterEach(async () => {
		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		removeTempDirSync(sessionDir);
		removeTempDirSync(foreignDir);
		resetWorkspaceDiagnosticsCacheSession();
	});

	it("marks the foreign file unconfirmed with reason outside_project_root", async () => {
		const service = await loadServiceWithSession();
		const results = await service.runWorkspaceDiagnostics(foreignDir);

		const result = results.find(
			(r) => cacheKeyFor(r.filePath) === cacheKeyFor(foreignFile),
		);
		expect(result).toBeDefined();
		// Pre-fix: timedOut was undefined and unconfirmedReason absent, i.e. a
		// CONFIRMED CLEAN verdict for a file nothing ever examined.
		expect(result?.timedOut).toBe(true);
		expect(result?.unconfirmedReason).toBe("outside_project_root");
	});

	it("does not write the declined file into the workspace cache", async () => {
		const service = await loadServiceWithSession();
		await service.runWorkspaceDiagnostics(foreignDir);

		const cached =
			loadWorkspaceDiagnosticsCache(foreignDir)?.entries[
				cacheKeyFor(foreignFile)
			];
		// Probe for ABSENCE. Pre-fix the record loop persisted `count: 0` here,
		// so every later sweep replayed the false clean from disk.
		expect(cached).toBeUndefined();
	});

	it("serves an inside file and declines a foreign file in one batch", async () => {
		const insideFile = path.join(sessionDir, "inside.ts");
		fs.writeFileSync(insideFile, "export const inside = 1;\n");
		const service = await loadServiceWithSession();
		const results = await service.runWorkspaceDiagnostics(sessionDir, {
			files: [insideFile, foreignFile],
		});

		const inside = results.find((result) => result.filePath === insideFile);
		const foreign = results.find((result) => result.filePath === foreignFile);
		expect(inside).toBeDefined();
		expect(inside?.timedOut).toBeUndefined();
		expect(inside?.unconfirmedReason).toBeUndefined();
		expect(foreign?.timedOut).toBe(true);
		expect(foreign?.unconfirmedReason).toBe("outside_project_root");
	});
});
