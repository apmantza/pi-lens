/**
 * #1782: the workspace-diagnostics cache had no expiry and no revalidation.
 *
 * An entry for a file that no newer pull re-answers survived forever — across
 * sessions — and its diagnostics rendered as current `blocking` errors. Proven
 * live in the 2026-08-20 plegma dogfood: five `typescript:2339` errors carrying
 * `observedAt` 28 hours old, born under inferred settings (#1640), were still
 * served as fresh blockers because a cache HIT skips the touch that would have
 * re-answered the file, so the entry's `scannedAt` never advanced and no gate
 * ever looked at it again.
 *
 * The fix is a serve-time bound in `lookup`: an entry that ASSERTS findings and
 * predates the current session start (or has aged past the in-session ceiling)
 * is dropped instead of served. Clean entries are untouched — see
 * `classifyWorkspaceDiagnosticsCacheExpiry`'s doc comment for why that asymmetry
 * is the policy and not an oversight.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildScopeKey,
	cacheKeyFor,
	classifyWorkspaceDiagnosticsCacheExpiry,
	createWorkspaceDiagnosticsCacheContext,
	loadWorkspaceDiagnosticsCache,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
	WORKSPACE_DIAGNOSTICS_FINDING_MAX_AGE_MS,
	type WorkspaceDiagnosticsCacheEntry,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	resetWorkspaceDiagnosticsCacheSession,
	workspaceDiagnosticsCacheSessionStart,
} from "../../../clients/lsp/workspace-diagnostics-session.js";
import { removeTempDirSync } from "../test-utils.js";

const SCOPE = "all|";

/** One `typescript:2339` error — the exact shape of the #1782 ghost rows. */
function blockingDiagnostic(): LSPDiagnostic {
	return {
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
		severity: 1,
		code: 2339,
		source: "typescript",
		serverId: "typescript",
		message: "Property 'foo' does not exist on type 'Bar'.",
	};
}

let tmp: string;
let sessionStart: number;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cache-expiry-"));
	fs.mkdirSync(path.join(tmp, ".pi-lens"));
	// Every test below runs "inside" a session that started now.
	sessionStart = Date.now();
	resetWorkspaceDiagnosticsCacheSession(sessionStart);
});

afterEach(() => {
	removeTempDirSync(tmp);
	resetWorkspaceDiagnosticsCacheSession();
});

/** Seed the on-disk cache with one entry and return the file it keys. */
function seedEntry(
	name: string,
	entry: Partial<WorkspaceDiagnosticsCacheEntry>,
): string {
	const filePath = path.join(tmp, name);
	fs.writeFileSync(filePath, "export const a = 1;\n");
	const mtimeMs = fs.statSync(filePath).mtimeMs;
	saveWorkspaceDiagnosticsCache(tmp, {
		version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
		entries: {
			[cacheKeyFor(filePath)]: {
				diagnostics: [],
				count: 0,
				mtimeMs,
				scannedAt: Date.now(),
				scopeKey: SCOPE,
				...entry,
			},
		},
	});
	return filePath;
}

describe("classifyWorkspaceDiagnosticsCacheExpiry — the policy, in isolation", () => {
	const now = 1_000_000_000;
	const findingEntry = (scannedAt: number): WorkspaceDiagnosticsCacheEntry => ({
		diagnostics: [blockingDiagnostic()],
		count: 1,
		mtimeMs: 1,
		scannedAt,
		scopeKey: SCOPE,
	});

	it("expires a finding-bearing entry recorded before the session started", () => {
		expect(
			classifyWorkspaceDiagnosticsCacheExpiry(findingEntry(now - 1), now, now),
		).toBe("pre-session");
	});

	it("keeps a finding-bearing entry recorded after the session started", () => {
		expect(
			classifyWorkspaceDiagnosticsCacheExpiry(findingEntry(now), now, now),
		).toBeUndefined();
	});

	it("expires a finding-bearing entry that aged past the in-session ceiling", () => {
		const scannedAt = now - WORKSPACE_DIAGNOSTICS_FINDING_MAX_AGE_MS - 1;
		expect(
			classifyWorkspaceDiagnosticsCacheExpiry(
				findingEntry(scannedAt),
				now,
				scannedAt,
			),
		).toBe("max-age");
	});

	it("never expires a clean entry — its only claim is 'unchanged', which the mtime/dependency gates verify", () => {
		const clean: WorkspaceDiagnosticsCacheEntry = {
			diagnostics: [],
			count: 0,
			mtimeMs: 1,
			scannedAt: 0,
			scopeKey: SCOPE,
		};
		expect(
			classifyWorkspaceDiagnosticsCacheExpiry(clean, now, now),
		).toBeUndefined();
	});
});

describe("lookup() serve-time expiry (#1782)", () => {
	// AC3, red on pre-fix code: the 28-hour-old blocking entry.
	it("does NOT serve a blocking entry whose scan predates the session start", () => {
		const filePath = seedEntry("ghost.ts", {
			diagnostics: [blockingDiagnostic()],
			count: 1,
			// 28 hours before this session began — the dogfood's exact shape.
			scannedAt: sessionStart - 28 * 60 * 60_000,
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, SCOPE)).toBeUndefined();
	});

	it("still serves a blocking entry recorded inside this session", () => {
		const filePath = seedEntry("live.ts", {
			diagnostics: [blockingDiagnostic()],
			count: 1,
			scannedAt: sessionStart + 1,
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		const hit = ctx.lookup(filePath, SCOPE);
		expect(hit?.count).toBe(1);
		// #1093: a hit is still a replay, stamped with its ORIGINAL scan time.
		expect(hit?.scannedAt).toBe(sessionStart + 1);
	});

	it("still serves a CLEAN entry from a previous session (the deliberate asymmetry)", () => {
		const filePath = seedEntry("clean.ts", {
			diagnostics: [],
			count: 0,
			scannedAt: sessionStart - 28 * 60 * 60_000,
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, SCOPE)).toBeDefined();
	});

	it("expires a blocking entry that aged past the in-session ceiling without a session boundary", () => {
		// Session started long ago and is still running: the entry postdates the
		// session start, so only the age ceiling can catch it.
		const longAgo = Date.now() - 3 * WORKSPACE_DIAGNOSTICS_FINDING_MAX_AGE_MS;
		resetWorkspaceDiagnosticsCacheSession(longAgo);
		const filePath = seedEntry("aged.ts", {
			diagnostics: [blockingDiagnostic()],
			count: 1,
			scannedAt: longAgo + 1,
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, SCOPE)).toBeUndefined();
	});

	// AC2, red on pre-fix code: an entry no newer pull re-answers survives
	// unrefreshed. Two later sweeps that only touch OTHER files must not leave it
	// serving; the pre-fix cache carried it forward verbatim, forever.
	it("drops a pre-session blocking entry that later sweeps never re-answer, instead of carrying it forward", () => {
		const ghost = seedEntry("ghost.ts", {
			diagnostics: [blockingDiagnostic()],
			count: 1,
			scannedAt: sessionStart - 28 * 60 * 60_000,
		});
		const other = path.join(tmp, "other.ts");
		fs.writeFileSync(other, "export const b = 2;\n");

		// Two "newer pulls" whose answer sets cover only `other.ts` — exactly the
		// dogfood situation, where the cache file was rewritten hours later and
		// still carried the ghosts.
		for (let i = 0; i < 2; i += 1) {
			const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
			// A real sweep looks the ghost up (it is in the swept file set) and,
			// on a hit, never touches it. Post-fix the lookup misses, so the file
			// goes back through a fresh touch.
			ctx.lookup(ghost, SCOPE);
			ctx.record(other, SCOPE, [], fs.statSync(other).mtimeMs);
			ctx.persist();
		}

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(Object.keys(persisted?.entries ?? {})).not.toContain(
			cacheKeyFor(ghost),
		);
		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(ghost, SCOPE),
		).toBeUndefined();
	});
});

describe("expiry observability (#1782 AC4)", () => {
	it("emits ONE bounded record per sweep carrying the count and the oldest age", async () => {
		vi.resetModules();
		const logLatency = vi.fn();
		vi.doMock("../../../clients/latency-logger.js", async (importOriginal) => ({
			...(await importOriginal<Record<string, unknown>>()),
			logLatency,
		}));
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const sessionModule =
			await import("../../../clients/lsp/workspace-diagnostics-session.js");
		const start = Date.now();
		sessionModule.resetWorkspaceDiagnosticsCacheSession(start);

		const older = path.join(tmp, "older.ts");
		const newer = path.join(tmp, "newer.ts");
		fs.writeFileSync(older, "export const a = 1;\n");
		fs.writeFileSync(newer, "export const b = 2;\n");
		cacheModule.saveWorkspaceDiagnosticsCache(tmp, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(older)]: {
					diagnostics: [blockingDiagnostic()],
					count: 1,
					mtimeMs: fs.statSync(older).mtimeMs,
					scannedAt: start - 30 * 60 * 60_000,
					scopeKey: SCOPE,
				},
				[cacheModule.cacheKeyFor(newer)]: {
					diagnostics: [blockingDiagnostic()],
					count: 1,
					mtimeMs: fs.statSync(newer).mtimeMs,
					scannedAt: start - 60_000,
					scopeKey: SCOPE,
				},
			},
		});

		const ctx = cacheModule.createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.lookup(older, SCOPE);
		ctx.lookup(newer, SCOPE);
		ctx.persist();
		// A second persist() must not double-report.
		ctx.persist();

		const records = logLatency.mock.calls
			.map((call) => call[0])
			.filter(
				(record) => record?.phase === "lsp_workspace_diagnostics_cache_expiry",
			);
		expect(records).toHaveLength(1);
		expect(records[0].metadata.expiredEntries).toBe(2);
		expect(records[0].metadata.preSession).toBe(2);
		expect(records[0].metadata.oldestExpiredAgeMs).toBeGreaterThanOrEqual(
			30 * 60 * 60_000,
		);
		vi.doUnmock("../../../clients/latency-logger.js");
		vi.resetModules();
	});
});

describe("session clock re-arm (#1782)", () => {
	it("an entry recorded in the previous session stops serving once the clock re-arms", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		const first = createWorkspaceDiagnosticsCacheContext(tmp);
		first.record(
			filePath,
			SCOPE,
			[blockingDiagnostic()],
			fs.statSync(filePath).mtimeMs,
		);
		first.persist();
		// Same session: it serves.
		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(filePath, SCOPE),
		).toBeDefined();

		// A new session begins. Without the re-arm, the clock keeps the FIRST
		// session's value for the life of the extension host and the entry keeps
		// serving forever — the process-lifetime-latch shape this guards.
		resetWorkspaceDiagnosticsCacheSession(Date.now() + 1);
		expect(workspaceDiagnosticsCacheSessionStart()).toBeGreaterThan(
			sessionStart,
		);
		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(filePath, SCOPE),
		).toBeUndefined();
	});
});

describe("runWorkspaceDiagnostics honors the expiry bound end to end (#1782 AC3)", () => {
	let tmpSweep: string;

	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmpSweep = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sweep-expiry-"));
		fs.mkdirSync(path.join(tmpSweep, ".pi-lens"));
	});
	afterEach(() => removeTempDirSync(tmpSweep));

	it("re-touches a file whose cached blocking entry predates the session instead of replaying it", async () => {
		const file = path.join(tmpSweep, "ghost.ts");
		fs.writeFileSync(file, "export const a = 1;\n");
		const scopeKey = buildScopeKey("all", ["opengrep"]);
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");
		const sessionModule =
			await import("../../../clients/lsp/workspace-diagnostics-session.js");
		const start = Date.now();
		sessionModule.resetWorkspaceDiagnosticsCacheSession(start);
		cacheModule.saveWorkspaceDiagnosticsCache(tmpSweep, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(file)]: {
					diagnostics: [blockingDiagnostic()],
					count: 1,
					mtimeMs: fs.statSync(file).mtimeMs,
					scannedAt: start - 28 * 60 * 60_000,
					scopeKey,
				},
			},
		});

		const tsServer = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => tmpSweep,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const waitCalls: Array<{ filePath: string }> = [];
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId: "typescript",
			root: tmpSweep,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string) => {
				waitCalls.push({ filePath });
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		});

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const results = await new LSPService().runWorkspaceDiagnostics(tmpSweep);

		// The stale blocker was NOT replayed: the file went through a fresh touch,
		// and the sweep's answer for it is the CURRENT (clean) one, stamped now.
		expect(waitCalls.map((c) => c.filePath)).toContain(file);
		const result = results.find((r) => r.filePath === file);
		expect(result?.count ?? 0).toBe(0);
		// The on-disk entry was rewritten by the fresh touch, so the ghost's
		// 28-hour-old scan time is gone from the cache too.
		const persisted = cacheModule.loadWorkspaceDiagnosticsCache(tmpSweep);
		const entry = persisted?.entries[cacheModule.cacheKeyFor(file)];
		expect(entry?.diagnostics ?? []).toHaveLength(0);
		expect(entry?.scannedAt ?? 0).toBeGreaterThanOrEqual(start);
	});
});

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));
