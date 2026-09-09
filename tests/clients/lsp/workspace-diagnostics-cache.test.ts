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
	clearAllWorkspaceDiagnosticsCaches,
	clearWorkspaceDiagnosticsCache,
	createWorkspaceDiagnosticsCacheContext,
	isEntryFresh,
	loadWorkspaceDiagnosticsCache,
	saveWorkspaceDiagnosticsCache,
	WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
	type WorkspaceDiagnosticsCacheEntry,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { MTIME_DRIFT_TOLERANCE_MS } from "../../../clients/blocker-freshness.js";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import {
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../../clients/project-snapshot.js";
import { removeTempDirSync } from "../test-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";

let tmp: string;

beforeEach(() => {
	resetDegradationLedger();
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-cache-"));
	// Legacy per-project data dir marker so the cache file writes INSIDE tmp
	// (cleaned up by afterEach) instead of the real global ~/.pi-lens dir.
	fs.mkdirSync(path.join(tmp, ".pi-lens"));
});

afterEach(() => {
	removeTempDirSync(tmp);
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
		const cacheFile = path.join(
			tmp,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
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

	it("fails open on a v2 cache so provenance-less diagnostics are re-collected (#2776)", () => {
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION - 1,
			entries: { "/a.ts": makeEntry() },
		});
		// Old records still parse safely, but the strict cache consumer refuses
		// to serve them because their diagnostics have no serverId provenance.
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("fails open when entries is missing/malformed", () => {
		const cacheFile = path.join(
			tmp,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION }),
		);
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
	});

	it("rejects only a v3 entry whose diagnostic lacks serverId (#2776)", () => {
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				bad: makeEntry({
					diagnostics: [
						{
							severity: 1,
							message: "missing provenance",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					],
				}),
				good: makeEntry({
					diagnostics: [
						{
							severity: 1,
							message: "kept",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
							serverId: "typescript",
						},
					],
				}),
			},
		});

		expect(loadWorkspaceDiagnosticsCache(tmp)?.entries).toEqual(
			expect.objectContaining({ good: expect.anything() }),
		);
		expect(loadWorkspaceDiagnosticsCache(tmp)?.entries.bad).toBeUndefined();
	});

	it("records one bounded migration degradation with the old version and entry count (#2776)", () => {
		saveWorkspaceDiagnosticsCache(tmp, {
			version: 2,
			entries: { a: makeEntry(), b: makeEntry() },
		});
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "lsp-workspace-cache-migration",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.reason).toContain("v2");
		expect(group?.latestReasons[0]?.reason).toContain("2 entries");
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

	// #2300: a same-mtime-bucket external rewrite (coarse mtime granularity;
	// #2287 N1) that changes the file's byte length must not be masked by the
	// mtime-only equality check. Varies SIZE, never same-length content.
	it("is stale when size differs even though mtime is unchanged (entry carries sizeBytes)", () => {
		const stat = fs.statSync(filePath);
		const entry = makeEntry({
			mtimeMs: stat.mtimeMs,
			sizeBytes: stat.size + 1,
			scannedAt: Date.now(),
		});
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(false);
	});

	it("stays fresh when both mtime and size match the entry", () => {
		const stat = fs.statSync(filePath);
		const entry = makeEntry({
			mtimeMs: stat.mtimeMs,
			sizeBytes: stat.size,
			scannedAt: Date.now(),
		});
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(true);
	});

	it("keeps failing OPEN to mtime-only for a legacy entry with no sizeBytes field at all", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({ mtimeMs, scannedAt: Date.now() });
		expect(entry.sizeBytes).toBeUndefined();
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(true);
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
		expect(isEntryFresh(filePath, entry, () => [depPath])).toBe(false);
	});

	it("stays fresh when every dependency is older than the entry's scannedAt", () => {
		const depPath = path.join(tmp, "dep.ts");
		fs.writeFileSync(depPath, "export const x = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const scannedAt = Date.now() + 10_000; // entry "recorded" after the dep's mtime
		const entry = makeEntry({ mtimeMs, scannedAt });
		expect(isEntryFresh(filePath, entry, () => [depPath])).toBe(true);
	});

	// #1708 sweep: same defect shape as `findingPathFreshness` — a strict
	// `mtimeMs > scannedAt` against a captured scan timestamp. Fabricates the
	// mtime/scannedAt pair directly (no real write race) so the boundary is
	// deterministic and pins both edges against a `>` / tolerance-widening
	// mutation.
	it("stays fresh when a dependency's mtime lands within MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const depPath = path.join(tmp, "dep-tolerance.ts");
		fs.writeFileSync(depPath, "export const x = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const scannedAt = fs.statSync(depPath).mtimeMs - MTIME_DRIFT_TOLERANCE_MS;
		const entry = makeEntry({ mtimeMs, scannedAt });
		expect(isEntryFresh(filePath, entry, () => [depPath])).toBe(true);
	});

	it("is stale when a dependency's mtime lands past MTIME_DRIFT_TOLERANCE_MS of scannedAt", () => {
		const depPath = path.join(tmp, "dep-past-tolerance.ts");
		fs.writeFileSync(depPath, "export const x = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const scannedAt =
			fs.statSync(depPath).mtimeMs - MTIME_DRIFT_TOLERANCE_MS - 1;
		const entry = makeEntry({ mtimeMs, scannedAt });
		expect(isEntryFresh(filePath, entry, () => [depPath])).toBe(false);
	});

	it("is stale when a dependency has been deleted (fail closed)", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({ mtimeMs, scannedAt: Date.now() });
		expect(
			isEntryFresh(filePath, entry, () => [path.join(tmp, "gone.ts")]),
		).toBe(false);
	});

	// #1793: the one remaining path a stale CLEAN verdict survives #1786's
	// serve-time expiry gate on — an entry recorded WITH dependency knowledge
	// (a warm session, reverse-deps index built) replayed on a LATER, cold
	// session (no index this time) used to fall back to mtime-only, so a
	// dependency edit that flipped the file from clean to failing stayed
	// invisible for as long as the file's own bytes were untouched.
	it("is stale (fails closed) when the entry was recorded WITH dependency knowledge but this session has none", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({
			mtimeMs,
			scannedAt: Date.now(),
			depIndexAtScan: true,
		});
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(false);
	});

	it("keeps failing OPEN to mtime-only when the entry itself was recorded without dependency knowledge (unchanged residual)", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({
			mtimeMs,
			scannedAt: Date.now(),
			depIndexAtScan: false,
		});
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(true);
	});

	it("keeps failing OPEN to mtime-only for a legacy entry with no depIndexAtScan field at all", () => {
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const entry = makeEntry({ mtimeMs, scannedAt: Date.now() });
		expect(entry.depIndexAtScan).toBeUndefined();
		expect(isEntryFresh(filePath, entry, () => undefined)).toBe(true);
	});
});

describe("buildScopeKey / cacheKeyFor (#671)", () => {
	it("produces a stable key independent of exclude-list ordering", () => {
		expect(buildScopeKey("all", ["b", "a"])).toBe(
			buildScopeKey("all", ["a", "b"]),
		);
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
		// #1093: lookup surfaces the entry's original `scannedAt` so a cache-hit
		// footer reconcile can stamp `touchedAt` at observation time. #1095: it also
		// surfaces the content `binding`.
		expect(ctx.lookup(filePath, "all|")).toMatchObject({
			diagnostics: [],
			count: 0,
			scannedAt: expect.any(Number),
		});
	});

	// #2300: an end-to-end proof that `record`'s sizeBytes reaches
	// `isEntryFresh` through `lookup` — a same-mtime-bucket external rewrite
	// that changes the file's length must invalidate a real context's cache.
	it("a same-mtime-bucket external rewrite with a different size invalidates the recorded entry", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		// Pin the mtime up front so the rewrite below can be forced back to it.
		// `stat.mtimeMs` below is the round-tripped value, not the nominal one:
		// `mtimeMs` is derived from a nanosecond timestamp, so a whole-ms Date
		// can come back as e.g. 1787865854006.999 on ext4.
		const pinnedMtimeMs = Date.now();
		fs.utimesSync(filePath, new Date(pinnedMtimeMs), new Date(pinnedMtimeMs));
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		const stat = fs.statSync(filePath);
		ctx.record(filePath, "all|", [], stat.mtimeMs, undefined, stat.size);
		expect(ctx.lookup(filePath, "all|")).toBeDefined();

		// Rewrite with different-length content, forced back to the SAME mtime
		// the entry was recorded against.
		fs.writeFileSync(filePath, "const a = 22222222222;\n");
		fs.utimesSync(filePath, new Date(pinnedMtimeMs), new Date(pinnedMtimeMs));
		expect(fs.statSync(filePath).mtimeMs).toBe(stat.mtimeMs);
		expect(fs.statSync(filePath).size).not.toBe(stat.size);

		expect(ctx.lookup(filePath, "all|")).toBeUndefined();
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
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
				serverId: "typescript",
			},
		];

		const first = createWorkspaceDiagnosticsCacheContext(tmp);
		first.record(filePath, "all|", diag, mtimeMs);
		first.persist();

		const second = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(second.lookup(filePath, "all|")).toMatchObject({
			diagnostics: diag,
			count: 1,
			scannedAt: expect.any(Number),
		});
	});

	// #1095: the lookup surfaces a content binding — a recorded fingerprint lets a
	// later lookup verify against disk beyond the mtime proxy.
	it("lookup binding is 'unknown' for an entry recorded without a contentHash", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], fs.statSync(filePath).mtimeMs);
		expect(ctx.lookup(filePath, "all|")?.binding.boundToCurrentDisk).toBe(
			"unknown",
		);
	});

	it("lookup binding is 'true' when the recorded contentHash matches current disk bytes", () => {
		const filePath = path.join(tmp, "a.ts");
		const content = "const a = 1;\n";
		fs.writeFileSync(filePath, content);
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(
			filePath,
			"all|",
			[],
			fs.statSync(filePath).mtimeMs,
			hashDiagnosticContent(content),
		);
		expect(ctx.lookup(filePath, "all|")?.binding.boundToCurrentDisk).toBe(true);
	});

	it("lookup binding is 'false' when the recorded contentHash does not match current disk (content check beats mtime)", () => {
		const filePath = path.join(tmp, "a.ts");
		const onDisk = "const a = 1;\n";
		fs.writeFileSync(filePath, onDisk);
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		// Record at the CURRENT mtime (so the exact-mtime freshness gate passes) but
		// with a fingerprint of DIFFERENT bytes — modelling a file whose content
		// diverged from what the cached diagnostics were computed against without an
		// mtime bump the freshness gate would otherwise catch. The binding is then
		// the only signal that catches the divergence.
		ctx.record(
			filePath,
			"all|",
			[],
			mtimeMs,
			hashDiagnosticContent("const a = 999;\n"),
		);
		const hit = ctx.lookup(filePath, "all|");
		expect(hit).toBeDefined();
		expect(hit?.binding.boundToCurrentDisk).toBe(false);
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

// #1793: the #1786 review's F4 residual — a CLEAN entry recorded while a
// reverse-dependency index was available replayed on a later, index-less
// session used to fall back to mtime-only with no dependency check at all.
// Persisting whether dependency knowledge was available AT RECORD TIME lets
// `isEntryFresh` refuse to serve such an entry via the weaker check just
// because the CURRENT session happens to be cold.
describe("dependency-index availability persisted on the entry (#1793)", () => {
	// A snapshot with `files[key].imports` defined makes
	// `loadReverseDependencyIndexFromSnapshot` resolve non-null AND puts THIS
	// key into `index.imports` (see `buildReverseDependencyIndexFromSnapshot`)
	// — the file is actually covered by the index, not merely "an index of
	// some kind exists this session".
	function seedProjectSnapshotCoveringFile(
		cwd: string,
		filePath: string,
	): void {
		const key = cacheKeyFor(filePath);
		saveProjectSnapshot(cwd, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: cwd,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				[key]: { path: key, mtimeMs: 0, size: 0, imports: [], lastSeq: 0 },
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
	}

	// #1793 review F2: an index exists this session (some OTHER file is
	// covered), but NOT for the file under test — the out-of-snapshot shape
	// the review flagged. `getImports` masks this with `?? []`, so a
	// context-level ("was ANY index loaded") stamp would wrongly claim
	// dependency knowledge for a file the index never actually saw.
	function seedProjectSnapshotNotCoveringFile(cwd: string): void {
		saveProjectSnapshot(cwd, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: cwd,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				"/some/other/file.ts": {
					path: "/some/other/file.ts",
					mtimeMs: 0,
					size: 0,
					imports: [],
					lastSeq: 0,
				},
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
	}

	it("record() stamps depIndexAtScan=true when THIS FILE is covered by the reverse-deps index", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		seedProjectSnapshotCoveringFile(tmp, filePath);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], fs.statSync(filePath).mtimeMs);
		ctx.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(filePath)]?.depIndexAtScan).toBe(
			true,
		);
	});

	// Red on the context-level-stamp version of the fix (#1793 review F2): a
	// whole-cwd index existing does NOT mean this specific file's clean claim
	// was ever cross-checked against dependencies.
	it("record() stamps depIndexAtScan=false when an index exists but does not cover this file", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		seedProjectSnapshotNotCoveringFile(tmp);

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], fs.statSync(filePath).mtimeMs);
		ctx.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(filePath)]?.depIndexAtScan).toBe(
			false,
		);
	});

	it("record() stamps depIndexAtScan=false when no reverse-deps index is available this session", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		// No project snapshot seeded: this session is cold, same as today.

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], fs.statSync(filePath).mtimeMs);
		ctx.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(filePath)]?.depIndexAtScan).toBe(
			false,
		);
	});

	// Red on pre-fix code: a clean entry recorded WITH dependency knowledge
	// used to serve on a later, index-less session via the mtime-only
	// fallback with no dependency check at all.
	it("a CLEAN entry recorded WITH dependency knowledge does not serve on a later dep-index-less session", () => {
		const filePath = path.join(tmp, "clean.ts");
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
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});

		// This session has no project snapshot: cold, so getImports() is
		// undefined for every file — the exact state the entry's depIndexAtScan
		// says it should NOT be trusted to serve through.
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, "all|")).toBeUndefined();
	});

	it("a CLEAN entry recorded WITHOUT dependency knowledge keeps serving via mtime-only (unchanged residual)", () => {
		const filePath = path.join(tmp, "clean.ts");
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
					scopeKey: "all|",
					depIndexAtScan: false,
				},
			},
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, "all|")).toBeDefined();
	});

	it("emits a bounded record when a dep-index-cold refusal fires", async () => {
		vi.resetModules();
		const logLatency = vi.fn();
		vi.doMock("../../../clients/latency-logger.js", async (importOriginal) => ({
			...(await importOriginal<Record<string, unknown>>()),
			logLatency,
		}));
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");

		const filePath = path.join(tmp, "clean.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;
		cacheModule.saveWorkspaceDiagnosticsCache(tmp, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(filePath)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});

		const ctx = cacheModule.createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.lookup(filePath, "all|");
		ctx.persist();
		// A second persist() must not double-report.
		ctx.persist();

		const records = logLatency.mock.calls
			.map((call) => call[0])
			.filter(
				(record: any) =>
					record?.phase === "lsp_workspace_diagnostics_cache_expiry",
			);
		expect(records).toHaveLength(1);
		expect(records[0].metadata.depIndexColdRefusals).toBe(1);
		vi.doUnmock("../../../clients/latency-logger.js");
		vi.resetModules();
	});

	// #1793 review F3 (Probe D shape): both `record()` call sites
	// (`clients/lsp/index.ts`, `tools/lsp-diagnostics.ts`) skip recording an
	// UNCONFIRMED (timed-out/errored) touch result. A refusal that only
	// REFUSES without evicting the entry would leave that same stale,
	// depIndexAtScan:true entry sitting in the persisted cache forever, to be
	// refused (and its file force-re-touched) again on every later cold
	// sweep — paying the touch's timeout budget every single time, when
	// pre-fix it served instantly. Simulates that exact caller behavior: look
	// up (refused), then persist WITHOUT ever calling `record()` for the file
	// (the caller's `continue` on `timedOut`/`error`).
	it("deletes a cold-refused entry so an UNCONFIRMED forced re-touch does not leave it to be refused forever", () => {
		const filePath = path.join(tmp, "clean.ts");
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
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});

		const first = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(first.lookup(filePath, "all|")).toBeUndefined();
		// The caller's forced re-touch "times out": it never calls record()
		// for this file, exactly like the `continue` on `result.timedOut` in
		// both real call sites.
		first.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(filePath)]).toBeUndefined();

		// A second, later cold sweep sees a plain cache miss (genuinely
		// uncached), not a refusal — same one-touch-per-sweep cost an
		// always-uncached file already pays, not a compounding cost.
		const second = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(second.lookup(filePath, "all|")).toBeUndefined();
	});

	it("heals once a re-touch DOES confirm, even under the same cold session", () => {
		const filePath = path.join(tmp, "clean.ts");
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
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(filePath, "all|")).toBeUndefined();
		// This time the forced re-touch DOES confirm — the caller calls
		// record() with a fresh result, same as a successful touchFile.
		ctx.record(filePath, "all|", [], mtimeMs);
		ctx.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		// Re-recorded under THIS (still cold) session's own knowledge: false,
		// not the stale true it replaced — so the next lookup fails open to
		// mtime-only again instead of refusing, and serves instantly.
		expect(persisted?.entries[cacheKeyFor(filePath)]?.depIndexAtScan).toBe(
			false,
		);
		expect(
			createWorkspaceDiagnosticsCacheContext(tmp).lookup(filePath, "all|"),
		).toBeDefined();
	});
});

// #1814: the #1800/#1793 review's probe F — a narrower, per-file gap
// `isEntryFresh`'s own dependency loop left open, distinct from the
// whole-session-absent case #1793/#1800 closed. `getImports` used to mask
// "this file is absent from an otherwise-present reverse-deps index" with
// `?? []`, so `isEntryFresh`'s loop iterated zero times over the coerced
// empty array and returned fresh — indistinguishable from a file the index
// actually confirmed has zero imports. A session WITH a warm index
// (`hasDepKnowledge` true for SOME file, so #1793's whole-session refusal
// never fires) could still fail-open per-file for a file outside that
// index's own coverage, with no signal at all.
describe("per-file dependency-index coverage in isEntryFresh (#1814)", () => {
	function seedSnapshotCovering(cwd: string, coveredKey: string): void {
		saveProjectSnapshot(cwd, {
			version: PROJECT_SNAPSHOT_VERSION,
			projectRoot: cwd,
			generatedAt: new Date().toISOString(),
			seq: 1,
			files: {
				[coveredKey]: {
					path: coveredKey,
					mtimeMs: 0,
					size: 0,
					imports: [],
					lastSeq: 0,
				},
			},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		});
	}

	// Probe F shape: a warm session's index covered g.ts, stamping
	// depIndexAtScan: true. A LATER session's index exists (so
	// `hasDepKnowledge` is true for other.ts and #1793's whole-session
	// refusal doesn't fire) but covers only other.ts, not g.ts.
	it("does not serve a CLEAN entry whose file is absent from an otherwise-present index (probe F)", () => {
		const gPath = path.join(tmp, "g.ts");
		fs.writeFileSync(gPath, "export const g = 1;\n");
		const mtimeMs = fs.statSync(gPath).mtimeMs;
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(gPath)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});
		seedSnapshotCovering(tmp, cacheKeyFor(path.join(tmp, "other.ts")));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(gPath, "all|")).toBeUndefined();
	});

	// Mutation-proof the accepted, unchanged case: a file the CURRENT index
	// actually covers, with zero imports recorded, still serves — the fix
	// must distinguish "uncovered" from "covered, zero imports", not just
	// refuse every depIndexAtScan:true entry outright.
	it("still serves a CLEAN entry whose file the CURRENT index confirms has zero imports", () => {
		const gPath = path.join(tmp, "g.ts");
		fs.writeFileSync(gPath, "export const g = 1;\n");
		const mtimeMs = fs.statSync(gPath).mtimeMs;
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(gPath)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});
		seedSnapshotCovering(tmp, cacheKeyFor(gPath));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(gPath, "all|")).toBeDefined();
	});

	// Mutation-proof the eviction extension: a refusal-without-eviction fix
	// (returning undefined from isEntryFresh alone, without widening the
	// `lookup` eviction condition) leaves the stale entry on disk to be
	// refused — and its file force-re-touched — again on every later cold
	// sweep, exactly the repeat-cost #1793 review F3 flagged for the
	// whole-session case. This proves the SAME idiom applies here.
	it("evicts (not just refuses) a per-file-uncovered depIndexAtScan:true entry", () => {
		const gPath = path.join(tmp, "g.ts");
		fs.writeFileSync(gPath, "export const g = 1;\n");
		const mtimeMs = fs.statSync(gPath).mtimeMs;
		saveWorkspaceDiagnosticsCache(tmp, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(gPath)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});
		seedSnapshotCovering(tmp, cacheKeyFor(path.join(tmp, "other.ts")));

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		expect(ctx.lookup(gPath, "all|")).toBeUndefined();
		ctx.persist();

		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(gPath)]).toBeUndefined();
	});

	// The refusal population widens (same `depIndexColdRefusals` metric,
	// same latency.log record #1800 introduced) to also count the per-file
	// case, not just the whole-session-absent one.
	it("counts a per-file-uncovered refusal in the same depIndexColdRefusals telemetry as a whole-session refusal", async () => {
		vi.resetModules();
		const logLatency = vi.fn();
		vi.doMock("../../../clients/latency-logger.js", async (importOriginal) => ({
			...(await importOriginal<Record<string, unknown>>()),
			logLatency,
		}));
		const cacheModule =
			await import("../../../clients/lsp/workspace-diagnostics-cache.js");

		const gPath = path.join(tmp, "g.ts");
		fs.writeFileSync(gPath, "export const g = 1;\n");
		const mtimeMs = fs.statSync(gPath).mtimeMs;
		cacheModule.saveWorkspaceDiagnosticsCache(tmp, {
			version: cacheModule.WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheModule.cacheKeyFor(gPath)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey: "all|",
					depIndexAtScan: true,
				},
			},
		});
		seedSnapshotCovering(
			tmp,
			cacheModule.cacheKeyFor(path.join(tmp, "other.ts")),
		);

		const ctx = cacheModule.createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.lookup(gPath, "all|");
		ctx.persist();

		const records = logLatency.mock.calls
			.map((call) => call[0])
			.filter(
				(record: any) =>
					record?.phase === "lsp_workspace_diagnostics_cache_expiry",
			);
		expect(records).toHaveLength(1);
		expect(records[0].metadata.depIndexColdRefusals).toBe(1);
		vi.doUnmock("../../../clients/latency-logger.js");
		vi.resetModules();
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
	afterEach(() => removeTempDirSync(tmpSweep));

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

	// #1095 (P2-1): the SERVICE sweep must apply the same content-binding gate the
	// tools/lsp-diagnostics.ts sibling site does — both share cache entries under
	// the same scopeKey, so a hash-bearing entry whose bytes diverged WITHOUT an
	// mtime bump (exactly what contentHash exists to catch) must not be replayed as
	// confirmed via mode=full.
	it("does NOT serve a cached entry whose contentHash mismatches disk under a matching mtime (P2-1 binding gate)", async () => {
		const file = path.join(tmpSweep, "a.ts");
		fs.writeFileSync(file, "const z = 1;\n");
		const mtimeMs = fs.statSync(file).mtimeMs;
		// Pre-seed a v2 cache entry under the SERVICE sweep scope with a fingerprint
		// of DIFFERENT bytes but the CURRENT mtime: the exact-mtime freshness gate
		// passes, so only the content binding can catch the divergence.
		const scopeKey = buildScopeKey("all", ["opengrep"]);
		saveWorkspaceDiagnosticsCache(tmpSweep, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
			entries: {
				[cacheKeyFor(file)]: {
					diagnostics: [],
					count: 0,
					mtimeMs,
					scannedAt: Date.now(),
					scopeKey,
					contentHash: hashDiagnosticContent("const z = 999;\n"),
				},
			},
		});

		const tsServer = makeTsServer(tmpSweep);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmpSweep);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.runWorkspaceDiagnostics(tmpSweep);
		// The mismatched entry was NOT served — a.ts (the only file) fell through to
		// a fresh touch. A served cache hit would have produced zero wait calls.
		expect(waitCalls.length).toBeGreaterThan(0);
	});

	it("re-collects a provenance-less v2 entry instead of replaying it (#2776)", async () => {
		const file = path.join(tmpSweep, "a.ts");
		fs.writeFileSync(file, "const z = 1;\n");
		const stat = fs.statSync(file);
		saveWorkspaceDiagnosticsCache(tmpSweep, {
			version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION - 1,
			entries: {
				[cacheKeyFor(file)]: {
					diagnostics: [
						{
							severity: 1,
							message: "old primary finding",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					],
					count: 1,
					mtimeMs: stat.mtimeMs,
					scannedAt: Date.now(),
					scopeKey: buildScopeKey("all", ["opengrep"]),
				},
			},
		});

		const tsServer = makeTsServer(tmpSweep);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmpSweep);
		createLSPClient.mockResolvedValue(client);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		await service.runWorkspaceDiagnostics(tmpSweep);

		expect(waitCalls.length).toBeGreaterThan(0);
		const callsAfterMigration = waitCalls.length;
		expect(loadWorkspaceDiagnosticsCache(tmpSweep)?.version).toBe(
			WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
		);
		await service.runWorkspaceDiagnostics(tmpSweep);
		expect(waitCalls.length).toBe(callsAfterMigration);
	});
});

// #1239: the save path routes through writeFileAtomic. Its bestEffort default
// swallows write failures, which would silently break persist()'s contract
// that a failed write leaves `dirty` set so the NEXT sweep retries — the
// save must pass bestEffort: false so the failure reaches persist()'s catch.
describe("persist() write-failure retry (#1239)", () => {
	it("a failed atomic write keeps the entry dirty and the next persist() retries it", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		// Occupy the cache file's target path with a DIRECTORY: the atomic
		// tmp-write-then-rename cannot replace a directory on any OS, so the
		// save deterministically fails without mocks.
		const target = path.join(
			tmp,
			".pi-lens",
			"cache",
			"lsp-workspace-diagnostics.json",
		);
		fs.mkdirSync(target, { recursive: true });

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], mtimeMs);
		// The failure is contained (sweeps never fail on cache writes)...
		expect(() => ctx.persist()).not.toThrow();
		expect(loadWorkspaceDiagnosticsCache(tmp)).toBeUndefined();

		// ...but it must NOT count as success: clear the obstruction and the
		// SAME context's next persist() must still write the entry. Pre-fix,
		// bestEffort swallowed the failure, `dirty` was cleared, and this
		// second persist() was a silent no-op.
		fs.rmdirSync(target);
		ctx.persist();
		const persisted = loadWorkspaceDiagnosticsCache(tmp);
		expect(persisted?.entries[cacheKeyFor(filePath)]).toMatchObject({
			mtimeMs,
			scopeKey: "all|",
		});
	});
});

// #1669 review F1: `workspace/diagnostic/refresh` used to clear the cache at
// the per-LSP-server `state.root`, which a monorepo/multi-root project can
// nest BELOW the real sweep cwd — the clear missed the actual cache file.
// `clearAllWorkspaceDiagnosticsCaches` instead drops every cwd this process
// has ever created a `createWorkspaceDiagnosticsCacheContext` for.
describe("clearAllWorkspaceDiagnosticsCaches (#1669 review F1)", () => {
	it("clears every cwd a sweep has registered, not just one", () => {
		const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cache-a-"));
		const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cache-b-"));
		fs.mkdirSync(path.join(projectA, ".pi-lens"));
		fs.mkdirSync(path.join(projectB, ".pi-lens"));
		try {
			const fileA = path.join(projectA, "a.ts");
			const fileB = path.join(projectB, "b.ts");
			// Two independent sweeps, mirroring two projects a single LSP process
			// might route files through (e.g. two roots resolved by the SAME
			// language server key in a multi-root workspace).
			const ctxA = createWorkspaceDiagnosticsCacheContext(projectA);
			ctxA.record(fileA, "all|", [], 1);
			ctxA.persist();
			const ctxB = createWorkspaceDiagnosticsCacheContext(projectB);
			ctxB.record(fileB, "all|", [], 1);
			ctxB.persist();

			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(projectA)?.entries ?? {}),
			).toHaveLength(1);
			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(projectB)?.entries ?? {}),
			).toHaveLength(1);

			// A refresh at a THIRD root (e.g. `state.root` for a per-server
			// identity that is neither project's cwd) must still clear both —
			// clearing only `state.root` (the pre-fix behavior) would clear
			// nothing here at all.
			clearAllWorkspaceDiagnosticsCaches();

			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(projectA)?.entries ?? {}),
			).toHaveLength(0);
			expect(
				Object.keys(loadWorkspaceDiagnosticsCache(projectB)?.entries ?? {}),
			).toHaveLength(0);
		} finally {
			removeTempDirSync(projectA);
			removeTempDirSync(projectB);
		}
	});
});

// #1669 review F2: `createWorkspaceDiagnosticsCacheContext` loads the cache
// ONCE at the start of a sweep, and `persist()` blind-overwrites the whole
// map at the end. A `workspace/diagnostic/refresh` landing mid-sweep used to
// be silently undone the moment that sweep's own (now-stale) in-memory copy
// was written back — the exact staleness class #1669 exists to close.
describe("createWorkspaceDiagnosticsCacheContext persist() vs. a mid-sweep clear (#1669 review F2)", () => {
	it("drops a stale persist() once clearWorkspaceDiagnosticsCache raced it, instead of resurrecting the cleared entries", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		// A sweep starts and loads the (currently empty) cache.
		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		// Mid-sweep, a server-initiated refresh clears the on-disk cache —
		// e.g. because a project-wide config change made everything the sweep
		// is about to record stale.
		clearWorkspaceDiagnosticsCache(tmp);
		// The sweep, unaware of the refresh, finishes and writes back what it
		// computed BEFORE the refresh landed.
		ctx.record(filePath, "all|", [], mtimeMs);
		ctx.persist();

		// The refresh's clear must win: nothing from the stale in-memory copy
		// may resurrect on disk. Pre-fix, this assertion would see 1 entry —
		// the sweep's persist() overwrote the clear.
		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(tmp)?.entries ?? {}),
		).toHaveLength(0);
	});

	it("still persists normally when no clear raced the sweep", () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const a = 1;\n");
		const mtimeMs = fs.statSync(filePath).mtimeMs;

		const ctx = createWorkspaceDiagnosticsCacheContext(tmp);
		ctx.record(filePath, "all|", [], mtimeMs);
		ctx.persist();

		expect(
			Object.keys(loadWorkspaceDiagnosticsCache(tmp)?.entries ?? {}),
		).toHaveLength(1);
	});
});
