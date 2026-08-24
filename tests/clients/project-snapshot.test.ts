import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readJsonCacheSpy = vi.hoisted(() => vi.fn());
vi.mock("../../clients/json-cache-read.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/json-cache-read.js")>();
	readJsonCacheSpy.mockImplementation(actual.readJsonCache);
	return { ...actual, readJsonCache: readJsonCacheSpy };
});

// #958: intercepts saveProjectSnapshot's writes at the atomic-write boundary
// so a single test can simulate "the process died right after the meta
// write, before the body write" without touching real fs internals — the
// mock defaults to the real implementation and only one test overrides it.
const writeFileAtomicSpy = vi.hoisted(() => vi.fn());
const realWriteFileAtomicHolder = vi.hoisted(() => ({
	current: undefined as unknown as (
		...args: Parameters<
			typeof import("../../clients/atomic-write.js").writeFileAtomic
		>
	) => void,
}));
vi.mock("../../clients/atomic-write.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/atomic-write.js")>();
	realWriteFileAtomicHolder.current = actual.writeFileAtomic;
	writeFileAtomicSpy.mockImplementation(actual.writeFileAtomic);
	return { ...actual, writeFileAtomic: writeFileAtomicSpy };
});

import {
	PROJECT_SNAPSHOT_VERSION,
	_resetProjectSnapshotParseCacheForTests,
	_getAuthoritativeSnapshotCacheKeysForTests,
	_stripTopLevelJsonKeysForTests,
	buildProjectSnapshotFromRuntime,
	flushProjectSnapshotPersistsForTests,
	getProjectSnapshotLegacyPath,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	getLastNarrowParseDigestForTests,
	hydrateRuntimeFromProjectSnapshot,
	hydrateRuntimeFromProjectSnapshotIfIdle,
	isProjectSnapshotFresh,
	isProjectSnapshotMetaStale,
	loadProjectSnapshot,
	loadProjectSnapshotExportsAndRules,
	readProjectSnapshotMeta,
	resetLastNarrowParseDigestForTests,
	resetProjectSnapshotPersistWorkerForTests,
	setProjectSnapshotGenerationGateForTests,
	setProjectSnapshotPromotionSeamForTests,
	saveProjectSnapshot,
	saveRuntimeProjectSnapshot,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import { fingerprintProjectSnapshotJson } from "../../clients/project-snapshot-fingerprint.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { buildWordIndex, searchWordIndex } from "../../clients/word-index.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { suspendAt, waitFor } from "./interleaving-kit.js";

function withProjectDataDir<T>(fn: (cwd: string) => T): T {
	const env = setupTestEnvironment("project-snapshot-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		return fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		env.cleanup();
	}
}

// Async counterpart: the worker-persist tests await in-flight writes, so
// cleanup must run only AFTER the body resolves (the sync variant's `finally`
// would delete the tmp dir mid-write).
async function withProjectDataDirAsync(
	fn: (cwd: string) => Promise<void>,
): Promise<void> {
	const env = setupTestEnvironment("project-snapshot-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		await fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) {
			delete process.env.PILENS_DATA_DIR;
		} else {
			process.env.PILENS_DATA_DIR = previousDataDir;
		}
		env.cleanup();
	}
}

describe("project snapshot", () => {
	// These cover the SAVE/LOAD SEMANTICS, not the worker offload itself, so
	// they force the synchronous main-thread body writer (`PI_LENS_SNAPSHOT_
	// PERSIST_SYNC`) — a save then leaves the gz body on disk immediately, no
	// async drain needed. The worker path (generation gating, fallback,
	// round-trip) is exercised in its own describe block below. #958.
	beforeEach(() => {
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		_resetProjectSnapshotParseCacheForTests();
		resetProjectSnapshotPersistWorkerForTests();
	});
	afterEach(() => {
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	});

	it("fingerprints only the top-level generatedAt field as volatile", () => {
		const first = {
			nested: { generatedAt: "nested-a" },
			generatedAt: "top-a",
			value: 1,
		};
		const topChanged = { ...first, generatedAt: "top-b" };
		const nestedChanged = {
			...topChanged,
			nested: { generatedAt: "nested-b" },
		};
		const digest = (value: typeof first) =>
			fingerprintProjectSnapshotJson(JSON.stringify(value), value.generatedAt);

		expect(digest(topChanged)).toBe(digest(first));
		expect(digest(nestedChanged)).not.toBe(digest(first));
	});

	it("builds, saves, and loads a runtime snapshot", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			runtime.projectRulesScan = {
				hasCustomRules: true,
				rules: [
					{
						source: "root",
						name: "AGENTS.md",
						filePath: path.join(cwd, "AGENTS.md"),
						relativePath: "AGENTS.md",
					},
				],
			};

			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
			expect(fs.existsSync(getProjectSnapshotMetaPath(cwd))).toBe(true);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
			expect(isProjectSnapshotFresh(loaded, 7)).toBe(true);
		}));

	it("skips a same-seq body when only generatedAt changed", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const first = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, first);

			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...first,
				generatedAt: new Date(
					Date.parse(first.generatedAt) + 1000,
				).toISOString(),
			});

			const bodyWrites = writeFileAtomicSpy.mock.calls.filter(
				([filePath]) => filePath === getProjectSnapshotPath(cwd),
			);
			expect(bodyWrites).toHaveLength(0);
			expect(readProjectSnapshotMeta(cwd)?.timestamp).toBe(first.generatedAt);
		}));

	it("writes a same-seq semantic delta and repairs a missing body", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const first = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, first);

			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...first,
				cachedExports: [["newExport", path.join(cwd, "src", "new.ts")]],
			});
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === getProjectSnapshotPath(cwd),
				),
			).toHaveLength(1);

			fs.rmSync(getProjectSnapshotPath(cwd));
			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, first);
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === getProjectSnapshotPath(cwd),
				),
			).toHaveLength(1);
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
		}));

	it("preserves a newer sibling-process body when stale local state replays", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const local = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, local);

			const sibling: ProjectSnapshot = {
				...local,
				cachedExports: [["siblingDelta", path.join(cwd, "src", "sibling.ts")]],
				generatedAt: new Date(
					Date.parse(local.generatedAt) + 1000,
				).toISOString(),
			};
			const siblingJson = JSON.stringify(sibling);
			const siblingFingerprint = fingerprintProjectSnapshotJson(
				siblingJson,
				sibling.generatedAt,
			);
			// #2008: a meta written since the integrity gate carries the on-disk gz
			// size; a sibling process persisting concurrently writes the same shape.
			const siblingGz = gzipSync(siblingJson);
			realWriteFileAtomicHolder.current(
				getProjectSnapshotPath(cwd),
				siblingGz,
				{ bestEffort: false },
			);
			realWriteFileAtomicHolder.current(
				getProjectSnapshotMetaPath(cwd),
				JSON.stringify({
					timestamp: sibling.generatedAt,
					version: sibling.version,
					seq: sibling.seq,
					fingerprint: siblingFingerprint,
					gzBytes: siblingGz.byteLength,
				}),
				{ bestEffort: false },
			);

			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...local,
				generatedAt: new Date(
					Date.parse(local.generatedAt) + 2000,
				).toISOString(),
			});
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === getProjectSnapshotPath(cwd),
				),
			).toHaveLength(0);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.cachedExports).toEqual(
				sibling.cachedExports,
			);
			expect(readProjectSnapshotMeta(cwd)?.fingerprint).toBe(
				siblingFingerprint,
			);
		}));

	it("retries an unchanged body after a failed publication", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			const bodyPath = getProjectSnapshotPath(cwd);
			let failBody = true;
			writeFileAtomicSpy.mockImplementation((targetPath, data, options) => {
				if (targetPath === bodyPath && failBody) {
					failBody = false;
					throw new Error("injected body failure");
				}
				return realWriteFileAtomicHolder.current(targetPath, data, options);
			});
			try {
				saveProjectSnapshot(cwd, snapshot);
				expect(fs.existsSync(bodyPath)).toBe(false);
				expect(getProjectSnapshotPersistErrorForTests()).toContain(
					"injected body failure",
				);

				saveProjectSnapshot(cwd, {
					...snapshot,
					generatedAt: new Date(
						Date.parse(snapshot.generatedAt) + 1000,
					).toISOString(),
				});
				expect(fs.existsSync(bodyPath)).toBe(true);
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.seq).toBe(7);
			} finally {
				writeFileAtomicSpy.mockImplementation(
					realWriteFileAtomicHolder.current,
				);
			}
		}));

	it("does not suppress metadata repair after a same-seq body lands", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const first = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, first);
			const priorFingerprint = readProjectSnapshotMeta(cwd)?.fingerprint;
			const changed: ProjectSnapshot = {
				...first,
				cachedExports: [["changed", path.join(cwd, "src", "changed.ts")]],
			};
			const metaPath = getProjectSnapshotMetaPath(cwd);
			let failMetadata = true;
			writeFileAtomicSpy.mockImplementation((targetPath, data, options) => {
				if (targetPath === metaPath && failMetadata) {
					failMetadata = false;
					throw new Error("injected metadata failure");
				}
				return realWriteFileAtomicHolder.current(targetPath, data, options);
			});
			try {
				saveProjectSnapshot(cwd, changed);
				expect(getProjectSnapshotPersistErrorForTests()).toContain(
					"injected metadata failure",
				);
				expect(readProjectSnapshotMeta(cwd)?.fingerprint).toBe(
					priorFingerprint,
				);

				writeFileAtomicSpy.mockClear();
				saveProjectSnapshot(cwd, changed);
				expect(
					writeFileAtomicSpy.mock.calls.filter(
						([filePath]) => filePath === getProjectSnapshotPath(cwd),
					),
				).toHaveLength(1);
				expect(readProjectSnapshotMeta(cwd)?.fingerprint).not.toBe(
					priorFingerprint,
				);
			} finally {
				writeFileAtomicSpy.mockImplementation(
					realWriteFileAtomicHolder.current,
				);
			}
		}));

	it("seeds unchanged dedupe from persisted metadata after reset", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			resetProjectSnapshotPersistWorkerForTests();
			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...snapshot,
				generatedAt: new Date(
					Date.parse(snapshot.generatedAt) + 1000,
				).toISOString(),
			});

			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === getProjectSnapshotPath(cwd),
				),
			).toHaveLength(0);
			expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
				active: false,
				queued: false,
			});
		}));

	// #2008: a torn/truncated gzip under an INTACT meta used to win same-
	// fingerprint dedupe forever — every unchanged save skipped, leaving the
	// corrupt body canonical until seq advanced. The skip decision now compares
	// the meta's recorded gz size against a live stat and force-publishes on
	// mismatch.
	it("force-publishes when the gz body is torn under an intact meta", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);
			const bodyPath = getProjectSnapshotPath(cwd);
			const intactSize = fs.statSync(bodyPath).size;
			expect(readProjectSnapshotMeta(cwd)?.gzBytes).toBe(intactSize);

			// Simulate the torn write: truncate the canonical gzip in place. The
			// meta sidecar still records the old fingerprint and gz size.
			fs.truncateSync(bodyPath, Math.floor(intactSize / 2));

			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...snapshot,
				generatedAt: new Date(
					Date.parse(snapshot.generatedAt) + 1000,
				).toISOString(),
			});
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === bodyPath,
				),
			).toHaveLength(1);
			// The republished meta re-binds the integrity evidence to the new body
			// (byte length may differ from the torn one: generatedAt is in the JSON).
			const republishedSize = fs.statSync(bodyPath).size;
			expect(republishedSize).toBeGreaterThan(intactSize / 2);
			expect(readProjectSnapshotMeta(cwd)?.gzBytes).toBe(republishedSize);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(7);
		}));

	it("withholds dedupe on a legacy meta until its next write populates gzBytes", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);
			const bodyPath = getProjectSnapshotPath(cwd);
			const metaPath = getProjectSnapshotMetaPath(cwd);

			// Downgrade the sidecar to the legacy shape (no gzBytes).
			const legacyMeta = readProjectSnapshotMeta(cwd);
			expect(legacyMeta?.fingerprint).toBeDefined();
			fs.writeFileSync(
				metaPath,
				JSON.stringify({
					timestamp: legacyMeta?.timestamp,
					version: legacyMeta?.version,
					seq: legacyMeta?.seq,
					fingerprint: legacyMeta?.fingerprint,
				}),
			);

			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...snapshot,
				generatedAt: new Date(
					Date.parse(snapshot.generatedAt) + 1000,
				).toISOString(),
			});
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === bodyPath,
				),
			).toHaveLength(1);
			// Self-healing: this successful write populates the field.
			expect(readProjectSnapshotMeta(cwd)?.gzBytes).toBe(
				fs.statSync(bodyPath).size,
			);

			// …and the next unchanged save dedupes again.
			writeFileAtomicSpy.mockClear();
			saveProjectSnapshot(cwd, {
				...snapshot,
				generatedAt: new Date(
					Date.parse(snapshot.generatedAt) + 2000,
				).toISOString(),
			});
			expect(
				writeFileAtomicSpy.mock.calls.filter(
					([filePath]) => filePath === bodyPath,
				),
			).toHaveLength(0);
		}));

	it("bounds and idles authoritative snapshots", () =>
		withProjectDataDir((cwd) => {
			vi.useFakeTimers();
			vi.stubEnv("PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS", "1000");
			const makeSnapshot = (root: string): ProjectSnapshot => ({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: root,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			for (let i = 0; i < 9; i++)
				saveProjectSnapshot(
					path.join(cwd, `root-${i}`),
					makeSnapshot(path.join(cwd, `root-${i}`)),
				);
			const keys = _getAuthoritativeSnapshotCacheKeysForTests();
			expect(keys).toHaveLength(8);
			expect(keys[0]).toContain("root-1");
			vi.advanceTimersByTime(1001);
			expect(_getAuthoritativeSnapshotCacheKeysForTests()).toHaveLength(0);
			vi.useRealTimers();
		}));

	it("clears the idle timer when an authoritative entry is deleted", () =>
		withProjectDataDir((cwd) => {
			vi.useFakeTimers();
			vi.stubEnv("PI_LENS_PROJECT_SNAPSHOT_IDLE_EVICT_MS", "1000");
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
			const snapshot: ProjectSnapshot = {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			};
			saveProjectSnapshot(cwd, snapshot);
			const bodyPath = getProjectSnapshotPath(cwd);
			const future = new Date(Date.now() + 10_000);
			fs.utimesSync(bodyPath, future, future);
			expect(loadProjectSnapshot(cwd)).not.toBeNull();
			expect(clearTimeoutSpy).toHaveBeenCalled();

			vi.advanceTimersByTime(1001);
			expect(_getAuthoritativeSnapshotCacheKeysForTests()).toEqual([]);
			vi.useRealTimers();
		}));

	it("embeds the derived sequence index in BOTH the body and the meta sidecar (#1019)", () =>
		withProjectDataDir((cwd) => {
			// A runtime with a real per-file sequence state at seq=3.
			const runtime = new RuntimeCoordinator();
			runtime.bumpFileSeq(path.join(cwd, "src", "a.ts")); // seq 1, a:1
			runtime.bumpFileSeq(path.join(cwd, "src", "a.ts")); // seq 2, a:2
			runtime.bumpFileSeq(path.join(cwd, "src", "b.ts")); // seq 3, b:1
			expect(runtime.projectSeq).toBe(3);

			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			// Body carries it, consistent with `seq`.
			expect(snapshot.sequenceIndex?.projectSeq).toBe(3);
			expect(snapshot.sequenceIndex?.projectSeq).toBe(snapshot.seq);
			saveProjectSnapshot(cwd, snapshot);

			// Round-trips through the body...
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.sequenceIndex?.projectSeq).toBe(3);
			// ...and, crucially, through the CHEAP meta sidecar (read without
			// parsing the body) so the interactive path can hydrate the base.
			const meta = readProjectSnapshotMeta(cwd);
			expect(meta?.seq).toBe(3);
			expect(meta?.sequenceIndex?.projectSeq).toBe(3);
			const metaFiles = new Map(meta?.sequenceIndex?.fileSeqByPath ?? []);
			// Keys are the same normalizeMapKey form the change-log replay uses.
			expect([...metaFiles.values()].sort()).toEqual([1, 2]);
		}));

	it("persists the word index and hydrates a searchable copy", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			runtime.wordIndex = buildWordIndex([
				{
					path: path.join(cwd, "src", "auth.ts"),
					content: "export function authenticateUser() {}",
				},
			]);

			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.wordIndex).toBeDefined();

			// Hydrate a fresh runtime → its word index must be searchable.
			const target = new RuntimeCoordinator();
			hydrateRuntimeFromProjectSnapshot(target, loaded!);
			expect(target.wordIndex).not.toBeNull();
			const results = searchWordIndex(target.wordIndex!, "authenticate user");
			expect(results[0]?.file).toBe(path.join(cwd, "src", "auth.ts"));
		}));

	it("preserves a previously-persisted word index when the runtime has none", () =>
		withProjectDataDir((cwd) => {
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function keepMe() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });

			// A later save from a runtime whose word-index task hasn't finished
			// must not clobber the persisted index.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(2);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();
		}));

	describe("loadProjectSnapshotExportsAndRules (#1785 F5)", () => {
		it("returns exports/rules/seq/version but never carries a wordIndex, from a genuine cold disk read", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(0);
				runtime.cachedExports.set("hot", path.join(cwd, "src/hot.ts"));
				runtime.wordIndex = buildWordIndex([
					{
						path: path.join(cwd, "src/hot.ts"),
						content: "export function hot() {}",
					},
				]);
				saveRuntimeProjectSnapshot({ cwd, runtime });
				// Force a genuine disk read (gunzip + the narrow parse), not the
				// in-process authoritative-write shortcut — this is the case the
				// measured cold-read numbers (#1785 F5) are about.
				_resetProjectSnapshotParseCacheForTests();

				const full = loadProjectSnapshot(cwd);
				expect(full?.wordIndex).toBeDefined();

				const narrow = loadProjectSnapshotExportsAndRules(cwd);
				expect(narrow?.seq).toBe(0);
				expect(narrow?.cachedExports).toEqual([
					["hot", path.join(cwd, "src/hot.ts")],
				]);
				// The cost-shaped assertion: the narrow loader must never even
				// construct a wordIndex value, not just omit a defined one — a
				// present-but-undefined key would still mean JSON.parse built (and
				// then discarded) the postings graph, defeating the whole point.
				expect("wordIndex" in (narrow as object)).toBe(false);
				expect("files" in (narrow as object)).toBe(false);
				expect("symbols" in (narrow as object)).toBe(false);
				expect("reverseDeps" in (narrow as object)).toBe(false);
			}));

		it("survives cachedExports paths containing quotes, backslashes, and braces (scanner correctness)", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(0);
				// Adversarial values for the raw-text scanner: an escaped quote, a
				// Windows-style backslash path, and literal braces/brackets — all
				// of which must round-trip through stripTopLevelJsonKeys unharmed.
				runtime.cachedExports.set(
					'weird"name',
					"C:\\Users\\apman\\proj\\{tricky}[file].ts",
				);
				runtime.projectRulesScan = {
					hasCustomRules: true,
					rules: [
						{
							source: "root",
							name: 'AGENTS "quoted" {braced}.md',
							filePath: path.join(cwd, "AGENTS.md"),
							relativePath: "AGENTS.md",
						},
					],
				};
				runtime.wordIndex = buildWordIndex([
					{ path: path.join(cwd, "a.ts"), content: "function f() {}" },
				]);
				saveRuntimeProjectSnapshot({ cwd, runtime });
				_resetProjectSnapshotParseCacheForTests();

				const narrow = loadProjectSnapshotExportsAndRules(cwd);
				expect(narrow?.cachedExports).toEqual([
					['weird"name', "C:\\Users\\apman\\proj\\{tricky}[file].ts"],
				]);
				expect(narrow?.projectRulesScan?.rules[0]?.name).toBe(
					'AGENTS "quoted" {braced}.md',
				);
			}));

		it("matches the full loader's exports/rules/seq/version on a snapshot with no wordIndex at all", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(3);
				runtime.cachedExports.set("plain", path.join(cwd, "plain.ts"));
				saveRuntimeProjectSnapshot({ cwd, runtime });
				_resetProjectSnapshotParseCacheForTests();

				const full = loadProjectSnapshot(cwd);
				const narrow = loadProjectSnapshotExportsAndRules(cwd);
				expect(narrow?.seq).toBe(full?.seq);
				expect(narrow?.version).toBe(full?.version);
				expect(narrow?.cachedExports).toEqual(full?.cachedExports);
			}));

		it("reads its own in-process authoritative write without touching disk (read-your-own-write)", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(0);
				runtime.cachedExports.set("fresh", path.join(cwd, "fresh.ts"));
				saveRuntimeProjectSnapshot({ cwd, runtime });
				// Deliberately NO `_resetProjectSnapshotParseCacheForTests()` here —
				// this exercises the authoritative in-process branch.
				const narrow = loadProjectSnapshotExportsAndRules(cwd);
				expect(narrow?.cachedExports).toEqual([
					["fresh", path.join(cwd, "fresh.ts")],
				]);
			}));

		it("returns null when nothing has ever been saved", () =>
			withProjectDataDir((cwd) => {
				expect(loadProjectSnapshotExportsAndRules(cwd)).toBeNull();
			}));

		// #1785 F5 review follow-up: the tests above assert on the RETURNED
		// shape, which is not, by itself, proof that stripping ever ran —
		// `loadProjectSnapshotExportsAndRules` hand-picks 4 named fields into
		// its return value regardless, so it would omit `wordIndex` from the
		// output even if the strip step were deleted entirely and the FULL text
		// were handed to `JSON.parse`. These two tests instead inspect what
		// actually reaches `JSON.parse` — the only place the postings graph's
		// construction cost is paid — so a mutation that disables stripping
		// (while leaving the return shape untouched) fails them.
		it("stripTopLevelJsonKeys removes the heavy fields from the TEXT itself, not just the parsed result", () => {
			const json = JSON.stringify({
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: "/tmp/proj",
				generatedAt: "2026-01-01T00:00:00.000Z",
				seq: 4,
				files: { "a.ts": { path: "a.ts", mtimeMs: 1, size: 2, lastSeq: 1 } },
				symbols: {
					"a.ts": [{ name: "f", kind: "function", filePath: "a.ts" }],
				},
				reverseDeps: { "a.ts": ["b.ts"] },
				cachedExports: [["x", "/tmp/proj/x.ts"]],
				wordIndex: { docs: ["huge", "postings", "graph"], df: { huge: 1 } },
				projectRulesScan: { hasCustomRules: false, rules: [] },
			});

			const stripped = _stripTopLevelJsonKeysForTests(json, [
				"wordIndex",
				"files",
				"symbols",
				"reverseDeps",
			]);

			// The heavy fields' TEXT is gone — not merely re-labeled or emptied —
			// so JSON.parse on this string never constructs them.
			expect(stripped).not.toContain("wordIndex");
			expect(stripped).not.toContain("postings");
			expect(stripped).not.toContain("reverseDeps");
			expect(stripped).not.toContain('"symbols"');
			// The result is still valid, complete JSON for everything else.
			const parsed = JSON.parse(stripped);
			expect(parsed.seq).toBe(4);
			expect(parsed.cachedExports).toEqual([["x", "/tmp/proj/x.ts"]]);
			expect(parsed.projectRulesScan).toEqual({
				hasCustomRules: false,
				rules: [],
			});
			expect(parsed.wordIndex).toBeUndefined();
			expect(parsed.files).toBeUndefined();
		});

		it("the actual loader never hands wordIndex's text to JSON.parse (mutation-proof cost assertion)", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(0);
				runtime.cachedExports.set("hot", path.join(cwd, "src/hot.ts"));
				runtime.wordIndex = buildWordIndex([
					{
						path: path.join(cwd, "src/hot.ts"),
						content: "export function hot() {}",
					},
				]);
				saveRuntimeProjectSnapshot({ cwd, runtime });
				_resetProjectSnapshotParseCacheForTests();
				resetLastNarrowParseDigestForTests();

				const narrow = loadProjectSnapshotExportsAndRules(cwd);

				expect(narrow?.cachedExports).toEqual([
					["hot", path.join(cwd, "src/hot.ts")],
				]);
				// #1785 F6: a DIGEST, never the retained text itself — see that
				// function's doc comment for why the earlier text-retaining version
				// of this hook was itself a regression.
				const digest = getLastNarrowParseDigestForTests();
				expect(digest).toBeDefined();
				expect(digest?.containsHeavyKey).toBe(false);
				expect(digest?.length).toBeGreaterThan(0);
			}));

		// #1785 F6 (review round 4): the earlier hook retained the FULL
		// narrowed text at module scope — a 28.2MB retention on a production
		// body, in a variable never reset and never bounded. This test proves
		// the REPLACEMENT hook cannot reproduce that class of bug structurally
		// (not by measuring bytes retained, which would need GC-timing-
		// dependent heap probing — exactly the flaky-by-construction shape
		// this repo's test discipline avoids): the only artifact exposed after
		// a load, of ANY body size, is a plain object with two PRIMITIVE
		// fields. A number and a boolean cannot pin a multi-megabyte string no
		// matter how large the body that produced them was.
		it("exposes only a bounded {length, containsHeavyKey} shape after a load — never a value that could itself retain body-sized content", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(0);
				// A body an order of magnitude "larger" in field count than the
				// other tests here, so a retained-text regression would be
				// unmissable if this test's shape check were bypassed.
				for (let i = 0; i < 500; i++) {
					runtime.cachedExports.set(`export${i}`, path.join(cwd, `f${i}.ts`));
				}
				runtime.wordIndex = buildWordIndex(
					Array.from({ length: 200 }, (_, i) => ({
						path: path.join(cwd, `w${i}.ts`),
						content: `export function w${i}() { return ${i}; }`,
					})),
				);
				saveRuntimeProjectSnapshot({ cwd, runtime });
				_resetProjectSnapshotParseCacheForTests();
				resetLastNarrowParseDigestForTests();

				loadProjectSnapshotExportsAndRules(cwd);

				const digest = getLastNarrowParseDigestForTests();
				expect(digest).toBeDefined();
				expect(Object.keys(digest as object).sort()).toEqual([
					"containsHeavyKey",
					"length",
				]);
				expect(typeof digest?.length).toBe("number");
				expect(typeof digest?.containsHeavyKey).toBe("boolean");
			}));
	});

	describe("hydrateRuntimeFromProjectSnapshotIfIdle (#1785 F2/F3)", () => {
		function makeSnapshot(
			cwd: string,
			overrides: Partial<ProjectSnapshot> = {},
		): ProjectSnapshot {
			return {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["fromSnapshot", path.join(cwd, "src/a.ts")]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
				...overrides,
			};
		}

		it("hydrates every field it owns when the runtime is fully idle", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				const snapshot = makeSnapshot(cwd);

				const hydrated = hydrateRuntimeFromProjectSnapshotIfIdle(
					runtime,
					snapshot,
				);

				expect(hydrated).toBe(true);
				expect(runtime.cachedExports.get("fromSnapshot")).toBe(
					path.join(cwd, "src/a.ts"),
				);
				expect(runtime.projectRulesScan.hasCustomRules).toBe(true);
			}));

		// #1785 F5: the function's parameter type is now
		// `Pick<ProjectSnapshot, "cachedExports" | "projectRulesScan">` — there
		// is no `wordIndex` parameter to pass at all, so a live `runtime.wordIndex`
		// can never be nulled by this function BY CONSTRUCTION, not merely by a
		// runtime guard. `tests/clients/runtime-session-retro-hydrate-warmup-race.test.ts`
		// proves the end-to-end F2 shape (a real, warmup-built wordIndex survives
		// the full retroactive-hydration flow) against the actual narrow loader
		// this function is fed from.

		it("does not clobber a live cachedExports map (F3 guard, mutation check: the guard is load-bearing)", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.cachedExports.set("liveOnly", path.join(cwd, "live.ts"));
				const snapshot = makeSnapshot(cwd, {
					cachedExports: [["fromSnapshot", path.join(cwd, "src/a.ts")]],
				});

				hydrateRuntimeFromProjectSnapshotIfIdle(runtime, snapshot);

				expect(runtime.cachedExports.get("liveOnly")).toBe(
					path.join(cwd, "live.ts"),
				);
				expect(runtime.cachedExports.has("fromSnapshot")).toBe(false);
				expect(runtime.cachedExports.size).toBe(1);
			}));

		it("does not clobber a live projectRulesScan", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.projectRulesScan = {
					hasCustomRules: true,
					rules: [
						{
							source: "root",
							name: "LIVE.md",
							filePath: path.join(cwd, "LIVE.md"),
							relativePath: "LIVE.md",
						},
					],
				};
				const snapshot = makeSnapshot(cwd, {
					projectRulesScan: { hasCustomRules: false, rules: [] },
				});

				hydrateRuntimeFromProjectSnapshotIfIdle(runtime, snapshot);

				expect(runtime.projectRulesScan.rules[0]?.name).toBe("LIVE.md");
			}));

		it("returns false and touches nothing when every field already carries live state", () =>
			withProjectDataDir((cwd) => {
				const runtime = new RuntimeCoordinator();
				runtime.cachedExports.set("liveOnly", path.join(cwd, "live.ts"));
				runtime.projectRulesScan = { hasCustomRules: true, rules: [] };
				const snapshot = makeSnapshot(cwd);

				const hydrated = hydrateRuntimeFromProjectSnapshotIfIdle(
					runtime,
					snapshot,
				);

				expect(hydrated).toBe(false);
				expect(runtime.cachedExports.has("fromSnapshot")).toBe(false);
			}));
	});

	it("does NOT launder a stale word index into looking fresh across a seq bump (#348 seq-laundering guard)", () =>
		withProjectDataDir((cwd) => {
			// Persist a word index at seq=2.
			const withIndex = new RuntimeCoordinator();
			withIndex.seedProjectSequence(2);
			withIndex.wordIndex = buildWordIndex([
				{ path: path.join(cwd, "a.ts"), content: "function staleOnly() {}" },
			]);
			saveRuntimeProjectSnapshot({ cwd, runtime: withIndex });
			expect(loadProjectSnapshot(cwd)?.seq).toBe(2);
			expect(loadProjectSnapshot(cwd)?.wordIndex).toBeDefined();

			// A later save at a NEW seq (project moved on), from a runtime whose
			// word-index task hasn't (re)built yet. Without the guard, this save
			// would re-stamp the seq=2 index as seq=3 — making a stale index look
			// fresh to isProjectSnapshotFresh's seq check, even though it predates
			// the seq bump and its rebuild hasn't happened. The guard (existing.seq
			// === snapshot.seq) must instead DROP the stale index here.
			const without = new RuntimeCoordinator();
			without.seedProjectSequence(3);
			saveRuntimeProjectSnapshot({ cwd, runtime: without });

			const laundered = loadProjectSnapshot(cwd);
			expect(laundered?.seq).toBe(3);
			expect(laundered?.wordIndex).toBeUndefined();
		}));

	it("rejects wrong-version, stale, and future snapshots", () =>
		withProjectDataDir((cwd) => {
			const badPath = getProjectSnapshotPath(cwd);
			fs.mkdirSync(path.dirname(badPath), { recursive: true });
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					version: 999,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq: 1,
					cachedExports: [],
				}),
			);
			expect(loadProjectSnapshot(cwd)).toBeNull();

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(3);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			expect(isProjectSnapshotFresh(snapshot, 2)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 4)).toBe(false);
			expect(isProjectSnapshotFresh(snapshot, 3)).toBe(true);
		}));

	it("persists startup scan context and language profile", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(9);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: true,
					sourceFileCount: 2,
				},
				languageProfile: {
					present: { jsts: true } as never,
					configured: { jsts: true },
					counts: { jsts: 2 },
					detectedKinds: ["jsts"],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.startupScan).toMatchObject({
				canWarmCaches: true,
				sourceFileCount: 2,
			});
			expect(loaded?.languageProfile?.detectedKinds).toEqual(["jsts"]);
		}));

	it("roundtrips project conventions through build + save + load", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(11);
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{
							id: "react",
							confidence: "high",
							signals: [
								"package.json:dependencies.react",
								"package.json:dependencies.react-dom",
							],
						},
						{
							id: "vite",
							confidence: "high",
							signals: ["vite.config.ts"],
						},
					],
					testRunners: ["vitest"],
					buildTools: ["vite"],
					agentDocs: [{ filePath: "AGENTS.md", lineCount: 42 }],
				},
			});
			saveProjectSnapshot(cwd, snapshot);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id).sort()).toEqual([
				"react",
				"vite",
			]);
			expect(loaded?.conventions?.testRunners).toEqual(["vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
			expect(loaded?.conventions?.agentDocs).toEqual([
				{ filePath: "AGENTS.md", lineCount: 42 },
			]);
		}));

	it("auto-detects conventions inside saveRuntimeProjectSnapshot when none are passed", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			createTempFile(
				cwd,
				"package.json",
				JSON.stringify({
					dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
					devDependencies: { vite: "^5.0.0", vitest: "^1.0.0" },
				}),
			);
			createTempFile(cwd, "vite.config.ts", "export default {};\n");

			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			const ids = loaded?.conventions?.frameworks.map((f) => f.id).sort();
			expect(ids).toEqual(["react", "vite", "vitest"]);
			expect(loaded?.conventions?.buildTools).toEqual(["vite"]);
		}));

	it("preserves existing conventions across a snapshot rewrite that does not supply them", () =>
		withProjectDataDir((cwd) => {
			fs.mkdirSync(cwd, { recursive: true });
			// First write — explicit conventions object.
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(2);
			const first = buildProjectSnapshotFromRuntime({
				cwd,
				runtime,
				conventions: {
					frameworks: [
						{ id: "next", confidence: "high", signals: ["next.config.js"] },
					],
					testRunners: [],
					buildTools: ["next"],
					agentDocs: [],
				},
			});
			saveProjectSnapshot(cwd, first);

			// Second write via saveRuntimeProjectSnapshot WITHOUT any package.json
			// nor a conventions arg — should inherit the previously-saved value
			// rather than overwriting it with the empty auto-detect result.
			saveRuntimeProjectSnapshot({ cwd, runtime });

			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.conventions?.frameworks.map((f) => f.id)).toEqual([
				"next",
			]);
		}));

	it("hydrates cached exports and rules into a new runtime", () =>
		withProjectDataDir((cwd) => {
			const source = new RuntimeCoordinator();
			source.seedProjectSequence(1);
			source.cachedExports.set("fromSnapshot", path.join(cwd, "src", "a.ts"));
			source.projectRulesScan = { hasCustomRules: true, rules: [] };
			const snapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: source,
			});

			const target = new RuntimeCoordinator();
			target.cachedExports.set("stale", path.join(cwd, "src", "old.ts"));
			hydrateRuntimeFromProjectSnapshot(target, snapshot);

			expect([...target.cachedExports.entries()]).toEqual([
				["fromSnapshot", path.join(cwd, "src", "a.ts")],
			]);
			expect(target.projectRulesScan.hasCustomRules).toBe(true);
		}));

	it("meta sidecar round-trips and drives the staleness gate (#947)", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);

			const meta = readProjectSnapshotMeta(cwd);
			expect(meta).toMatchObject({
				version: PROJECT_SNAPSHOT_VERSION,
				seq: 7,
			});
			expect(typeof meta?.timestamp).toBe("string");
			expect(isProjectSnapshotMetaStale(meta!, 7)).toBe(false);
			// seq mismatch → stale; version mismatch → stale (the exact fields
			// isProjectSnapshotFresh checks on the parsed body).
			expect(isProjectSnapshotMetaStale(meta!, 8)).toBe(true);
			expect(
				isProjectSnapshotMetaStale(
					{ ...meta!, version: PROJECT_SNAPSHOT_VERSION + 1 },
					7,
				),
			).toBe(true);
		}));

	it("meta sidecar reader fails open: missing / corrupt / wrong-shaped meta → null (#947)", () =>
		withProjectDataDir((cwd) => {
			// Missing entirely.
			expect(readProjectSnapshotMeta(cwd)).toBeNull();

			// Corrupt JSON.
			const metaPath = getProjectSnapshotMetaPath(cwd);
			fs.mkdirSync(path.dirname(metaPath), { recursive: true });
			fs.writeFileSync(metaPath, "{ not json");
			expect(readProjectSnapshotMeta(cwd)).toBeNull();

			// Wrong shape (missing seq).
			fs.writeFileSync(metaPath, JSON.stringify({ version: 2 }));
			expect(readProjectSnapshotMeta(cwd)).toBeNull();
		}));

	it("writes a gzip body that round-trips through load (#958)", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, snapshot);

			// The canonical body is gzip (magic bytes 0x1f 0x8b) and decompresses
			// to the exact compact JSON — no pretty-print newlines.
			const gz = fs.readFileSync(getProjectSnapshotPath(cwd));
			expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
			const json = gunzipSync(gz).toString("utf-8");
			expect(json).not.toContain("\n");
			expect(JSON.parse(json).seq).toBe(7);

			// A fresh reader (no authoritative in-process write) must reconstruct
			// the snapshot from disk alone.
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)).toMatchObject({
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
		}));

	it("reads a legacy uncompressed .json body when no .gz is present (#958 one-release fallback)", () =>
		withProjectDataDir((cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });

			// Simulate an install upgraded from the pre-#958 format: only the
			// uncompressed body exists (pretty-printed, as older versions wrote).
			const legacyPath = getProjectSnapshotLegacyPath(cwd);
			fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
			fs.writeFileSync(legacyPath, JSON.stringify(snapshot, null, 2));
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(false);

			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(7);

			// Once a fresh gz body is written, the stale legacy sibling is removed
			// so the two formats never coexist.
			saveProjectSnapshot(cwd, snapshot);
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
			expect(fs.existsSync(legacyPath)).toBe(false);
		}));

	it("a crash between the meta and body writes leaves meta ahead, never behind (#958)", () =>
		withProjectDataDir((cwd) => {
			const seed = new RuntimeCoordinator();
			seed.seedProjectSequence(3);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: seed }),
			);

			// Simulate the process dying right after the meta write lands but
			// before the body write does, by making only the body's
			// writeFileAtomic call fail (the meta call still runs for real).
			const bodyPath = getProjectSnapshotPath(cwd);
			writeFileAtomicSpy.mockImplementation((targetPath, data, options) => {
				if (targetPath === bodyPath) {
					throw new Error("simulated crash before body write");
				}
				return realWriteFileAtomicHolder.current(targetPath, data, options);
			});

			const advanced = new RuntimeCoordinator();
			advanced.seedProjectSequence(4);
			// The body write now happens on the (sync) persist path, whose failure
			// is caught and surfaced via the persist-error hook rather than thrown
			// back to the caller — the meta write above already landed. Honesty
			// (#533): the failure must be recorded, not silently swallowed.
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: advanced }),
			);
			expect(getProjectSnapshotPersistErrorForTests()).toMatch(
				/simulated crash before body write/,
			);
			writeFileAtomicSpy.mockImplementation(realWriteFileAtomicHolder.current);

			// Meta now claims seq 4 (written first, successfully); the body on
			// disk is still the OLD seq-3 body (its rename never completed). The
			// failed write also dropped the authoritative in-process entry, so a
			// load reflects what is ACTUALLY on disk (seq 3), never the seq-4
			// object we failed to persist.
			const meta = readProjectSnapshotMeta(cwd);
			expect(meta?.seq).toBe(4);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.seq).toBe(3);
			// The gate's cheap check (meta alone) says "not proven stale" — it
			// falls through to the body parse, which then correctly rejects the
			// old body against the real current seq. Self-healing: one wasted
			// parse, nothing silently served as fresh.
			expect(isProjectSnapshotMetaStale(meta!, 4)).toBe(false);
			expect(isProjectSnapshotFresh(loaded, 4)).toBe(false);
		}));

	it("meta-first write order: an old-seq meta can never sit over a fresh body (#958)", () =>
		withProjectDataDir((cwd) => {
			// Simulate the exact crash window #958 fixes: a meta write that
			// captures seq 9 lands, but the body write that should follow it
			// never happens (process died first) — reproduced here by writing
			// meta directly for a NEWER seq than the body currently on disk.
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);
			expect(loadProjectSnapshot(cwd)?.seq).toBe(5);

			fs.writeFileSync(
				getProjectSnapshotMetaPath(cwd),
				JSON.stringify({
					timestamp: new Date().toISOString(),
					version: PROJECT_SNAPSHOT_VERSION,
					seq: 9,
				}),
			);

			// The meta now claims seq 9 while the body on disk is still seq 5.
			// This is the "meta races ahead" skew — self-healing by design: the
			// gate's cheap meta check reads this as fresh (so it does NOT skip
			// the body parse), but the body's own embedded seq then correctly
			// fails the real freshness check against seq 9. No caller ever sees
			// the stale body reported as fresh, and nothing was discarded that
			// shouldn't have been.
			const meta = readProjectSnapshotMeta(cwd)!;
			expect(isProjectSnapshotMetaStale(meta, 9)).toBe(false);
			const loaded = loadProjectSnapshot(cwd);
			expect(loaded?.seq).toBe(5);
			expect(isProjectSnapshotFresh(loaded, 9)).toBe(false);

			// Prove the OTHER skew direction — old-seq meta over a fresh body —
			// can no longer be produced by saveProjectSnapshot itself: a full
			// save at a NEW seq must leave the meta at that same new seq, never
			// behind the body it just wrote.
			const advanced = new RuntimeCoordinator();
			advanced.seedProjectSequence(9);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: advanced }),
			);
			const metaAfter = readProjectSnapshotMeta(cwd)!;
			const bodyAfter = loadProjectSnapshot(cwd);
			expect(metaAfter.seq).toBe(9);
			expect(bodyAfter?.seq).toBe(9);
			expect(isProjectSnapshotMetaStale(metaAfter, 9)).toBe(false);
			expect(isProjectSnapshotFresh(bodyAfter, 9)).toBe(true);
		}));

	it("read-your-writes: a load after save serves the in-process object; an external write supersedes it (#947/#958)", () =>
		withProjectDataDir((cwd) => {
			_resetProjectSnapshotParseCacheForTests();
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			const saved = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, saved);

			// Read-your-writes: a load right after our own save (the
			// saveRuntimeProjectSnapshot merge-read pattern) is served from the
			// authoritative in-process entry — the exact object we just saved,
			// even though the gz body was written by the (here sync) persist path.
			const first = loadProjectSnapshot(cwd);
			expect(first).toBe(saved);
			expect(loadProjectSnapshot(cwd)).toBe(saved);

			// An external writer moves the gz body past our own write (newer
			// mtime) → the authoritative entry is abandoned and disk wins.
			const other = new RuntimeCoordinator();
			other.seedProjectSequence(9);
			const gzPath = getProjectSnapshotPath(cwd);
			fs.writeFileSync(
				gzPath,
				gzipSync(
					JSON.stringify(
						buildProjectSnapshotFromRuntime({ cwd, runtime: other }),
					),
				),
			);
			const bumped = new Date(Date.now() + 5000);
			fs.utimesSync(gzPath, bumped, bumped);
			const third = loadProjectSnapshot(cwd);
			expect(third).not.toBe(saved);
			expect(third?.seq).toBe(9);

			// Deleting the body fails open to null.
			fs.unlinkSync(gzPath);
			expect(loadProjectSnapshot(cwd)).toBeNull();
		}));
});

describe("project snapshot worker persist (#958)", () => {
	// This block exercises the ACTUAL worker offload (default production path):
	// no PI_LENS_SNAPSHOT_PERSIST_SYNC, so the body is stringified+gzipped on a
	// worker thread and promoted under a generation gate.
	afterEach(async () => {
		// Unconditional seam/gate hygiene: the lock tests restore these on the
		// happy path, but a mid-body throw must not poison later tests.
		setProjectSnapshotPromotionSeamForTests(undefined);
		setProjectSnapshotGenerationGateForTests(true);
		flushProjectSnapshotPersistsForTests();
		await waitForProjectSnapshotPersistsForTests();
		await terminateProjectSnapshotPersistWorkerForTests();
		resetProjectSnapshotPersistWorkerForTests();
		_resetProjectSnapshotParseCacheForTests();
		delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
	});

	async function waitForFile(p: string, deadlineMs = 10_000): Promise<boolean> {
		// Wall-time bound, not tick-count: the write happens on a WORKER thread,
		// and on a saturated CI runner thousands of main-loop ticks can elapse
		// in ~150ms without the worker ever being scheduled (the pre-fix flake).
		const deadline = Date.now() + deadlineMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(p)) return true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return fs.existsSync(p);
	}

	it("worker gzip round-trips through the load path", async () =>
		withProjectDataDirAsync(async (cwd) => {
			resetProjectSnapshotPersistWorkerForTests();
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			runtime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);

			const gzPath = getProjectSnapshotPath(cwd);
			expect(await waitForFile(gzPath)).toBe(true);
			await waitForProjectSnapshotPersistsForTests();
			// Written by the worker: real gzip magic bytes.
			expect(fs.readFileSync(gzPath).subarray(0, 2)).toEqual(
				Buffer.from([0x1f, 0x8b]),
			);

			// A fresh reader reconstructs the snapshot from the worker-written gz.
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)).toMatchObject({
				seq: 7,
				cachedExports: [["makeThing", path.join(cwd, "src", "a.ts")]],
			});
		}));

	it("keeps one active persist and only the latest queued candidate", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const promotionSpy = vi.fn();
			const suspension = suspendAt(promotionSpy, async () => {}, { calls: 1 });
			try {
				setProjectSnapshotPromotionSeamForTests(() => promotionSpy());
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(7);
				const first = buildProjectSnapshotFromRuntime({ cwd, runtime });
				saveProjectSnapshot(cwd, first);
				await suspension.admitted;

				saveProjectSnapshot(cwd, {
					...first,
					cachedExports: [["middle", path.join(cwd, "middle.ts")]],
				});
				const latest: ProjectSnapshot = {
					...first,
					cachedExports: [["latest", path.join(cwd, "latest.ts")]],
				};
				saveProjectSnapshot(cwd, latest);
				expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
					active: true,
					queued: true,
				});

				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				await suspension.completed;
				await waitForProjectSnapshotPersistsForTests();
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.cachedExports).toEqual(
					latest.cachedExports,
				);
				expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
					active: false,
					queued: false,
				});
			} finally {
				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				suspension.restore();
			}
		}));

	it("promotes one body for concurrent identical same-seq requests", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const promotionSpy = vi.fn();
			const suspension = suspendAt(promotionSpy, async () => {}, { calls: 1 });
			try {
				setProjectSnapshotPromotionSeamForTests(() => promotionSpy());
				const runtime = new RuntimeCoordinator();
				runtime.seedProjectSequence(7);
				const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
				saveProjectSnapshot(cwd, snapshot);
				await suspension.admitted;
				saveProjectSnapshot(cwd, {
					...snapshot,
					generatedAt: new Date(
						Date.parse(snapshot.generatedAt) + 1000,
					).toISOString(),
				});

				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				await suspension.completed;
				await waitForProjectSnapshotPersistsForTests();
				expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
					workerBodyWrites: 1,
				});
			} finally {
				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				suspension.restore();
			}
		}));

	it("rechecks sibling-process state at the unchanged decision seam", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const local = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, local);
			await waitForProjectSnapshotPersistsForTests();

			const promotionSpy = vi.fn();
			const suspension = suspendAt(promotionSpy, async () => {}, { calls: 1 });
			try {
				setProjectSnapshotPromotionSeamForTests(() => promotionSpy());
				saveProjectSnapshot(cwd, {
					...local,
					generatedAt: new Date(
						Date.parse(local.generatedAt) + 1000,
					).toISOString(),
				});
				await suspension.admitted;

				const sibling: ProjectSnapshot = {
					...local,
					cachedExports: [
						["lateSibling", path.join(cwd, "src", "late-sibling.ts")],
					],
					generatedAt: new Date(
						Date.parse(local.generatedAt) + 2000,
					).toISOString(),
				};
				const siblingJson = JSON.stringify(sibling);
				const siblingFingerprint = fingerprintProjectSnapshotJson(
					siblingJson,
					sibling.generatedAt,
				);
				// #2008: same-shape meta as production writes, gz size included.
				const siblingGz = gzipSync(siblingJson);
				realWriteFileAtomicHolder.current(
					getProjectSnapshotPath(cwd),
					siblingGz,
					{ bestEffort: false },
				);
				realWriteFileAtomicHolder.current(
					getProjectSnapshotMetaPath(cwd),
					JSON.stringify({
						timestamp: sibling.generatedAt,
						version: sibling.version,
						seq: sibling.seq,
						fingerprint: siblingFingerprint,
						gzBytes: siblingGz.byteLength,
					}),
					{ bestEffort: false },
				);

				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				await suspension.completed;
				await waitForProjectSnapshotPersistsForTests();
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.cachedExports).toEqual(
					sibling.cachedExports,
				);
				expect(readProjectSnapshotMeta(cwd)?.fingerprint).toBe(
					siblingFingerprint,
				);
			} finally {
				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				suspension.restore();
			}
		}));

	it("worker publication retries when fingerprint metadata fails", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(7);
			const first = buildProjectSnapshotFromRuntime({ cwd, runtime });
			saveProjectSnapshot(cwd, first);
			await waitForProjectSnapshotPersistsForTests();
			const priorFingerprint = readProjectSnapshotMeta(cwd)?.fingerprint;
			const changed: ProjectSnapshot = {
				...first,
				cachedExports: [
					["workerChanged", path.join(cwd, "src", "worker-changed.ts")],
				],
			};
			const metaPath = getProjectSnapshotMetaPath(cwd);
			let failMetadata = true;
			writeFileAtomicSpy.mockImplementation((targetPath, data, options) => {
				if (targetPath === metaPath && failMetadata) {
					failMetadata = false;
					throw new Error("injected worker metadata failure");
				}
				return realWriteFileAtomicHolder.current(targetPath, data, options);
			});
			try {
				saveProjectSnapshot(cwd, changed);
				await waitForProjectSnapshotPersistsForTests();
				const writesAfterFailure =
					getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites;
				expect(readProjectSnapshotMeta(cwd)?.fingerprint).toBe(
					priorFingerprint,
				);

				saveProjectSnapshot(cwd, changed);
				await waitForProjectSnapshotPersistsForTests();
				expect(
					getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites,
				).toBe(writesAfterFailure + 1);
				expect(readProjectSnapshotMeta(cwd)?.fingerprint).not.toBe(
					priorFingerprint,
				);
			} finally {
				writeFileAtomicSpy.mockImplementation(
					realWriteFileAtomicHolder.current,
				);
			}
		}));

	it("a slow generation-N worker write does NOT clobber a newer generation-N+1 body", async () =>
		withProjectDataDirAsync(async (cwd) => {
			resetProjectSnapshotPersistWorkerForTests();
			// Delay every worker write so generation N is still in-flight when
			// generation N+1 is scheduled and lands.
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "150";

			const old = new RuntimeCoordinator();
			old.seedProjectSequence(3);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: old }),
			);

			const fresh = new RuntimeCoordinator();
			fresh.seedProjectSequence(4);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: fresh }),
			);

			// Let BOTH delayed worker writes complete. The generation gate must
			// discard the stale gen-N (seq 3) result and keep only gen-N+1 (seq 4).
			await waitForProjectSnapshotPersistsForTests();
			await waitFor(
				() =>
					fs
						.readdirSync(path.dirname(getProjectSnapshotPath(cwd)))
						.filter((f) => f.includes(".stage-")),
				(stageFiles) => stageFiles.length === 0,
			);

			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(4);
			// No stray stage files left behind.
			const cacheDir = path.dirname(getProjectSnapshotPath(cwd));
			expect(
				fs.readdirSync(cacheDir).filter((f) => f.includes(".stage-")),
			).toEqual([]);
		}));

	it("mutation proof: disabling the generation gate permits a stale promotion", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const promotionSpy = vi.fn();
			const suspension = suspendAt(promotionSpy, async () => {}, { calls: 1 });
			try {
				setProjectSnapshotPromotionSeamForTests(() => promotionSpy());
				const old = new RuntimeCoordinator();
				old.seedProjectSequence(3);
				const fresh = new RuntimeCoordinator();
				fresh.seedProjectSequence(4);

				setProjectSnapshotGenerationGateForTests(false);
				saveProjectSnapshot(
					cwd,
					buildProjectSnapshotFromRuntime({ cwd, runtime: old }),
				);
				await suspension.admitted;
				saveProjectSnapshot(
					cwd,
					buildProjectSnapshotFromRuntime({ cwd, runtime: fresh }),
				);
				// Delay the queued write so the stale promotion is observable on disk.
				process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "1000";
				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				await suspension.completed;
				await waitFor(
					() => {
						_resetProjectSnapshotParseCacheForTests();
						return loadProjectSnapshot(cwd)?.seq;
					},
					(seq) => seq === 3,
				);
				// Mutation RED: disabling the gate permits the superseded generation to
				// reach canonical storage, even though the serialized queue repairs it.
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.seq).toBe(3);
				await waitForProjectSnapshotPersistsForTests();
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.seq).toBe(4);
			} finally {
				setProjectSnapshotPromotionSeamForTests(undefined);
				suspension.release();
				suspension.restore();
				await terminateProjectSnapshotPersistWorkerForTests();
				setProjectSnapshotGenerationGateForTests(true);
			}
		}));

	it("the generation gate prevents stale promotion", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const gatedPromotionSpy = vi.fn();
			const gatedSuspension = suspendAt(gatedPromotionSpy, async () => {}, {
				calls: 1,
			});
			try {
				setProjectSnapshotPromotionSeamForTests(() => gatedPromotionSpy());
				const gatedOld = new RuntimeCoordinator();
				gatedOld.seedProjectSequence(5);
				const gatedFresh = new RuntimeCoordinator();
				gatedFresh.seedProjectSequence(6);
				saveProjectSnapshot(
					cwd,
					buildProjectSnapshotFromRuntime({ cwd, runtime: gatedOld }),
				);
				await gatedSuspension.admitted;
				saveProjectSnapshot(
					cwd,
					buildProjectSnapshotFromRuntime({ cwd, runtime: gatedFresh }),
				);
				setProjectSnapshotPromotionSeamForTests(undefined);
				gatedSuspension.release();
				await gatedSuspension.completed;
				await waitForProjectSnapshotPersistsForTests();
				await waitFor(
					() => {
						_resetProjectSnapshotParseCacheForTests();
						return loadProjectSnapshot(cwd)?.seq;
					},
					(seq) => seq === 6,
				);
				_resetProjectSnapshotParseCacheForTests();
				expect(loadProjectSnapshot(cwd)?.seq).toBe(6);
			} finally {
				setProjectSnapshotPromotionSeamForTests(undefined);
				gatedSuspension.release();
				gatedSuspension.restore();
				setProjectSnapshotGenerationGateForTests(true);
			}
		}));

	it("read-your-writes across the legacy-upgrade window: an in-flight write shadows a stale legacy .json (#958)", async () =>
		withProjectDataDirAsync(async (cwd) => {
			resetProjectSnapshotPersistWorkerForTests();
			// Simulate the one-release upgrade window from a pre-#958 install: only
			// a legacy uncompressed body is on disk (a real, positive mtime); no .gz
			// exists yet. The save baseline must key off THIS body, not gz-only —
			// otherwise the load gate rejects our fresh in-process write and serves
			// the stale legacy body to a merge-consumer, dropping fields.
			const stale = new RuntimeCoordinator();
			stale.seedProjectSequence(3);
			const legacyPath = getProjectSnapshotLegacyPath(cwd);
			fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
			fs.writeFileSync(
				legacyPath,
				JSON.stringify(
					buildProjectSnapshotFromRuntime({ cwd, runtime: stale }),
				),
			);

			// Hold the worker write in-flight so the fresh gz is not promoted yet.
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "300";
			const fresh = new RuntimeCoordinator();
			fresh.seedProjectSequence(8);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime: fresh }),
			);

			// gz not promoted yet — only the legacy body (+ a stage file) on disk.
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(false);
			// A merge-consumer loading now must see our fresh in-process object
			// (seq 8), NOT the stale legacy body (seq 3) it would otherwise re-read.
			expect(loadProjectSnapshot(cwd)?.seq).toBe(8);

			await waitForProjectSnapshotPersistsForTests();
		}));

	it("worker death degrades to a logged main-thread persist (honesty, #533)", async () =>
		withProjectDataDirAsync(async (cwd) => {
			resetProjectSnapshotPersistWorkerForTests();
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "1000";
			const runtime = new RuntimeCoordinator();
			runtime.seedProjectSequence(5);
			saveProjectSnapshot(
				cwd,
				buildProjectSnapshotFromRuntime({ cwd, runtime }),
			);

			// Kill the worker mid-write: the queued body must fall back to the
			// synchronous main-thread writer, not silently vanish.
			await terminateProjectSnapshotPersistWorkerForTests();
			await waitForProjectSnapshotPersistsForTests();

			const gzPath = getProjectSnapshotPath(cwd);
			expect(await waitForFile(gzPath)).toBe(true);
			expect(getProjectSnapshotPersistErrorForTests()).toMatch(
				/exited|unavailable|terminated/i,
			);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(5);
		}));
});
