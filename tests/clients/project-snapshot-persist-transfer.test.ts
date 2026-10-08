/**
 * #3789: the worker persist hands the worker serialized bytes, not the object
 * graph. Reported by Renzo Oliveira: dispatchSnapshotPersist structured-cloned
 * the whole snapshot into the worker heap (about an 800 MB RSS jump on a 68 MB
 * snapshot), while the sync path blocked the loop for seconds.
 *
 * Recurrences these tests prevent:
 *  - a dispatch that posts `storedSnapshot(...)` again would put the clone
 *    back. A graph the structured clone cannot carry (here: an own `toJSON`
 *    function) falls to the synchronous main-thread writer when that happens,
 *    and the persist stops being offloaded.
 *  - a transfer list dropped from `postMessage` would copy the bytes instead of
 *    moving them, a second full-body allocation per persist.
 *  - the serialization now runs on the dispatching thread inside a worker
 *    `message` callback (a queued save dispatches from there), so a throw must
 *    free the active slot and be recorded, never strand the key's queue.
 *  - the corpus proves the new writer is byte-identical to the released one:
 *    same JSON, same fingerprint, so a released meta sidecar still dedupes.
 *
 * Fixture corpus: tests/fixtures/snapshot-persist/released-4.3.0 (written by
 * the 4.3.0 worker and sync writers at 846fe4446, identical gz bytes).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reads the real sink's rows: the mock delegates to the real logger (the same
// wrapper project-snapshot-cross-process.test.ts uses).
const latencyRows = vi.hoisted(
	() => [] as Array<{ phase?: string; metadata?: Record<string, unknown> }>,
);
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			latencyRows.push(entry as (typeof latencyRows)[number]);
			actual.logLatency(entry);
		},
	};
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	loadProjectSnapshot,
	readProjectSnapshotMeta,
	resetProjectSnapshotPersistWorkerForTests,
	saveProjectSnapshot,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
	_resetProjectSnapshotParseCacheForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import {
	getProjectSnapshotPersistWorkerHeapStatistics,
	refreshProjectSnapshotPersistWorkerHeapStatistics,
} from "../../clients/project-snapshot.js";
import { collectMemorySampleSubsystems } from "../../clients/memory-sampler.js";
import {
	buildWordIndex,
	serializeWordIndex,
} from "../../clients/word-index.js";
import { fingerprintProjectSnapshotJson } from "../../clients/project-snapshot-fingerprint.js";
// @ts-expect-error -- bare-node script, no declaration file
import { buildSyntheticSnapshot } from "../../scripts/bench-snapshot-persist.mjs";
import { waitFor } from "./interleaving-kit.js";

import { setupTestEnvironment } from "./test-utils.js";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/snapshot-persist/released-4.3.0",
);
const releasedBodyJson = fs.readFileSync(
	path.join(CORPUS, "snapshot.json"),
	"utf-8",
);
const releasedMeta = JSON.parse(
	fs.readFileSync(path.join(CORPUS, "project-snapshot.meta.json"), "utf-8"),
) as {
	fingerprint: string;
	gzBytes: number;
	seq: number;
	timestamp: string;
};

function releasedSnapshot(): ProjectSnapshot {
	return JSON.parse(releasedBodyJson) as ProjectSnapshot;
}

async function withProjectDataDirAsync(
	fn: (cwd: string) => Promise<void>,
): Promise<void> {
	const env = setupTestEnvironment("snapshot-persist-transfer-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		await fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	}
}

/** Wait to idle past waitForProjectSnapshotPersistsForTests's 2 s cap. */
async function settle(cwd: string): Promise<void> {
	await waitFor(
		() => getProjectSnapshotPersistStateForTests(cwd),
		(state) => !state.active && !state.queued,
		{ timeoutMs: 15_000 },
	);
}

function gunzippedBody(cwd: string): string {
	return gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(
		"utf-8",
	);
}

beforeEach(() => {
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	resetProjectSnapshotPersistWorkerForTests();
	_resetProjectSnapshotParseCacheForTests();
	resetDegradationLedger();
	latencyRows.length = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await waitForProjectSnapshotPersistsForTests();
	await terminateProjectSnapshotPersistWorkerForTests();
	resetProjectSnapshotPersistWorkerForTests();
	_resetProjectSnapshotParseCacheForTests();
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
});

describe("worker persist transfers serialized bytes (#3789)", () => {
	it("offloads a snapshot the structured clone cannot carry", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const base = releasedSnapshot();
			// An own function property makes `postMessage` throw DataCloneError.
			// The pre-fix dispatch cloned the object, so this save fell back to the
			// main-thread writer; JSON serialization honours `toJSON` on the
			// dispatching thread and the worker gets plain bytes.
			const uncloneable = {
				...base,
				toJSON: () => ({ ...base }),
			} as unknown as ProjectSnapshot;
			saveProjectSnapshot(cwd, uncloneable);
			await settle(cwd);

			expect(getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites).toBe(
				1,
			);
			expect(JSON.parse(gunzippedBody(cwd))).toEqual(base);
		}));

	it("reports the dispatcher's serialize time on the worker persist record", async () =>
		withProjectDataDirAsync(async (cwd) => {
			// The worker now receives bytes, so its own serialize time is about
			// zero; the record's `serializeMs` must still carry the stringify the
			// main thread paid, or latency.log hides the one cost left on the loop.
			const large = buildSyntheticSnapshot(1500, cwd) as ProjectSnapshot;
			saveProjectSnapshot(cwd, large);
			await settle(cwd);

			const row = latencyRows.find(
				(entry) =>
					entry.phase === "project_snapshot_persist" &&
					entry.metadata?.outcome === "executed",
			);
			expect(row?.metadata).toMatchObject({
				offloaded: true,
				rawBytes: Buffer.byteLength(JSON.stringify(large)),
			});
			expect(row?.metadata?.serializeMs as number).toBeGreaterThan(0.5);
		}));

	it("moves the serialized buffer to the worker instead of copying it", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const posts: Array<{
				isBytes: boolean;
				byteLength: number;
				transferListHoldsBody: boolean;
				detachedAfterPost: boolean;
			}> = [];
			const realPost = Worker.prototype.postMessage;
			vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
				this: Worker,
				message: { data?: unknown },
				transferList?: ArrayBuffer[],
			) {
				const data = message.data;
				const isBytes = data instanceof Uint8Array;
				const byteLength = isBytes ? data.byteLength : 0;
				const transferListHoldsBody =
					isBytes && (transferList ?? []).some((item) => item === data.buffer);
				realPost.call(this, message, transferList);
				posts.push({
					isBytes,
					byteLength,
					transferListHoldsBody,
					detachedAfterPost: isBytes && data.byteLength === 0,
				});
			} as typeof Worker.prototype.postMessage);

			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);

			expect(posts).toEqual([
				{
					isBytes: true,
					byteLength: Buffer.byteLength(releasedBodyJson),
					transferListHoldsBody: true,
					detachedAfterPost: true,
				},
			]);
		}));

	it("records a serialization throw, frees the queue, and persists the next save", async () =>
		withProjectDataDirAsync(async (cwd) => {
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "150";
			const first = releasedSnapshot();
			// Admitted behind an in-flight save, so it dispatches from the worker's
			// `message` callback: a throw there is host-fatal unless it is caught.
			const poisoned = {
				...first,
				seq: first.seq + 1,
				toJSON: () => {
					throw new Error("snapshot-serialize-boom");
				},
			} as unknown as ProjectSnapshot;
			const next: ProjectSnapshot = { ...first, seq: first.seq + 2 };

			saveProjectSnapshot(cwd, first);
			saveProjectSnapshot(cwd, poisoned);
			expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
				active: true,
				queued: true,
			});
			await settle(cwd);

			expect(getProjectSnapshotPersistErrorForTests()).toBe(
				"snapshot-serialize-boom",
			);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "project-snapshot-serialize-failed",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons[0]?.reason).toContain(
				"snapshot-serialize-boom",
			);
			expect(
				latencyRows.filter(
					(entry) =>
						entry.phase === "project_snapshot_persist_failed" &&
						entry.metadata?.error === "snapshot-serialize-boom",
				),
			).toHaveLength(1);

			saveProjectSnapshot(cwd, next);
			await settle(cwd);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(first.seq + 2);
		}));

	it("records a serialization throw on an idle key and leaves it usable", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const poisoned = {
				...releasedSnapshot(),
				toJSON: () => {
					throw new Error("idle-key-boom");
				},
			} as unknown as ProjectSnapshot;
			saveProjectSnapshot(cwd, poisoned);

			expect(getProjectSnapshotPersistStateForTests(cwd)).toMatchObject({
				active: false,
				queued: false,
			});
			expect(
				getDegradationSummary().find(
					(entry) => entry.kind === "project-snapshot-serialize-failed",
				)?.count,
			).toBe(1);

			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);
			expect(gunzippedBody(cwd)).toBe(releasedBodyJson);
		}));
});

describe.each([
	["worker", undefined],
	["sync", "1"],
] as const)("released-writer corpus, %s persist (#3789)", (_mode, syncFlag) => {
	beforeEach(() => {
		if (syncFlag) process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = syncFlag;
	});

	it("writes the released body bytes and the released fingerprint", async () =>
		withProjectDataDirAsync(async (cwd) => {
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);

			expect(gunzippedBody(cwd)).toBe(releasedBodyJson);
			const meta = readProjectSnapshotMeta(cwd);
			expect(meta?.fingerprint).toBe(releasedMeta.fingerprint);
			expect(meta?.gzBytes).toBe(fs.statSync(getProjectSnapshotPath(cwd)).size);
		}));

	it("loads a released body and dedupes a same-content save against its meta", async () =>
		withProjectDataDirAsync(async (cwd) => {
			fs.mkdirSync(path.dirname(getProjectSnapshotPath(cwd)), {
				recursive: true,
			});
			fs.copyFileSync(
				path.join(CORPUS, "project-snapshot.json.gz"),
				getProjectSnapshotPath(cwd),
			);
			fs.copyFileSync(
				path.join(CORPUS, "project-snapshot.meta.json"),
				getProjectSnapshotMetaPath(cwd),
			);
			const bodyBefore = fs.readFileSync(getProjectSnapshotPath(cwd));

			expect(loadProjectSnapshot(cwd)).toMatchObject({
				seq: releasedMeta.seq,
				projectRoot: releasedSnapshot().projectRoot,
			});

			// Same content, newer generatedAt: the released meta's fingerprint must
			// still match, so nothing is rewritten.
			saveProjectSnapshot(cwd, {
				...releasedSnapshot(),
				generatedAt: "2026-10-01T00:00:00.000Z",
			});
			await settle(cwd);

			expect(getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites).toBe(
				0,
			);
			// A rewrite would restamp the meta with the new generatedAt.
			expect(readProjectSnapshotMeta(cwd)?.timestamp).toBe(
				releasedMeta.timestamp,
			);
			expect(fs.readFileSync(getProjectSnapshotPath(cwd))).toEqual(bodyBefore);
		}));
});

describe("word-index wire bytes stay off the main-thread hot path (#4129)", () => {
	/** Documents for a real word index whose wire form is about 2 MB. */
	function wordIndexDocs(): Array<{ path: string; content: string }> {
		return Array.from({ length: 200 }, (_, doc) => ({
			path: `src/m\u00fcdule${doc}.ts`,
			content: Array.from(
				{ length: 300 },
				(_, token) => `tok${(doc * 31 + token * 7) % 5000}`,
			).join(" "),
		}));
	}

	function wordIndexedSnapshot(cwd: string) {
		const index = buildWordIndex(wordIndexDocs());
		const serialized = serializeWordIndex(index);
		const snapshot = {
			...releasedSnapshot(),
			projectRoot: cwd,
			wordIndex: serialized,
		} as ProjectSnapshot;
		return { index, serialized, snapshot };
	}

	/**
	 * Run `body` (an async function body over `data` and `urls`) in a new
	 * worker isolate that imports the built clients, and return its result.
	 */
	async function runInFreshIsolate<T>(body: string, data: unknown): Promise<T> {
		const clientsDir =
			pathToFileURL(path.join(REPO_ROOT, "clients")).href + "/";
		const urls = {
			clientsDir,
			wordIndex: `${clientsDir}word-index.js`,
			projectSnapshot: `${clientsDir}project-snapshot.js`,
		};
		const source = `
			const { parentPort, workerData } = require("node:worker_threads");
			const { data, urls } = workerData;
			(async () => { ${body} })().then(
				(value) => parentPort.postMessage({ value }),
				(error) => parentPort.postMessage({ error: String(error && error.stack || error) }),
			);
		`;
		const worker = new Worker(source, {
			eval: true,
			workerData: { data, urls },
		});
		try {
			const message = await new Promise<{ value?: T; error?: string }>(
				(resolve, reject) => {
					worker.once("message", resolve);
					worker.once("error", reject);
				},
			);
			if (message.error) throw new Error(message.error);
			return message.value as T;
		} finally {
			// Also ends the isolate's own persist worker before the data dir goes.
			await worker.terminate();
		}
	}

	it("dispatches the persist with no JavaScript pass over the body", async () =>
		withProjectDataDirAsync(async (cwd) => {
			// Recurrences: round 1 of #4129 stringified the word index a second
			// time inside its serializer (an extra whole-index stringify per
			// persist); round 2 walked the snapshot string character by character
			// in JavaScript to find the word index's span (+110-160 ms per
			// persist at a 57 MB index, VERIFY_4129). Both are counts, not times:
			// V8 block coverage counts every JavaScript block the dispatch runs,
			// and a scan of the body runs one block per character; the stringify
			// counter sums the characters JSON.stringify produced.
			//
			// The measurement runs in a fresh worker isolate. V8 does not count
			// blocks in code compiled before coverage started, so in this process
			// the earlier persists of this file hid the round-2 scan (measured:
			// green in the whole file, red when run alone).
			const result = await runInFreshIsolate<{
				hottest: { count: number; where: string };
				bodyChars: number;
				stringifiedChars: number;
			}>(
				`
				const { Session } = require("node:inspector/promises");
				const wordIndex = await import(urls.wordIndex);
				const persist = await import(urls.projectSnapshot);
				const index = wordIndex.buildWordIndex(data.docs);
				const snapshot = { ...data.base, projectRoot: data.cwd, wordIndex: wordIndex.serializeWordIndex(index) };
				const bodyChars = JSON.stringify(snapshot).length;
				const session = new Session();
				session.connect();
				await session.post("Profiler.enable");
				await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
				const realStringify = JSON.stringify;
				let stringifiedChars = 0;
				JSON.stringify = (...args) => {
					const out = realStringify(...args);
					if (typeof out === "string") stringifiedChars += out.length;
					return out;
				};
				try {
					persist.saveProjectSnapshot(data.cwd, snapshot);
				} finally {
					JSON.stringify = realStringify;
				}
				const { result } = await session.post("Profiler.takePreciseCoverage");
				session.disconnect();
				let hottest = { count: 0, where: "none" };
				for (const script of result) {
					if (!script.url.startsWith(urls.clientsDir)) continue;
					for (const fn of script.functions) {
						for (const range of fn.ranges) {
							if (range.count > hottest.count) {
								hottest = { count: range.count, where: script.url.slice(urls.clientsDir.length) + "#" + fn.functionName };
							}
						}
					}
				}
				return { hottest, bodyChars, stringifiedChars };
				`,
				{ cwd, base: releasedSnapshot(), docs: wordIndexDocs() },
			);

			expect(result.bodyChars).toBeGreaterThan(1_000_000);
			// Healthy: 788 at most (log redaction over fixed-size records). The
			// round-2 scan: 2,270,838 in skipJsonValue for a 2,271,109-char body.
			expect(result.hottest.count, result.hottest.where).toBeLessThan(
				result.bodyChars / 100,
			);
			// Healthy: 1.000 (the word index once, the rest once, small records).
			// Round 1: about 2 (the serializer stringified the index again).
			expect(result.stringifiedChars / result.bodyChars).toBeLessThan(1.1);
		}));

	it.each([
		["worker", undefined],
		["sync", "1"],
	])(
		"publishes the persisted wire bytes byte-identically (%s writer)",
		async (_mode, syncFlag) =>
			withProjectDataDirAsync(async (cwd) => {
				if (syncFlag) process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = syncFlag;
				const { index, serialized, snapshot } = wordIndexedSnapshot(cwd);
				expect(collectMemorySampleSubsystems(index).wordIndex?.wireBytes).toBe(
					null,
				);
				saveProjectSnapshot(cwd, snapshot);
				await settle(cwd);

				// Independent oracles: the released writer's bytes and the UTF-8
				// length of the index's own JSON.
				expect(gunzippedBody(cwd)).toBe(JSON.stringify(snapshot));
				expect(collectMemorySampleSubsystems(index).wordIndex?.wireBytes).toBe(
					Buffer.byteLength(JSON.stringify(serialized)),
				);
			}),
	);
});

describe("project-snapshot persist-worker heap slot (#4129)", () => {
	it("memory samples observe the real worker and clear on its exit", async () =>
		withProjectDataDirAsync(async (cwd) => {
			// Recurrence (VERIFY_4129 M3): removing this slot's three clears
			// (exit, death, test reset) left every test green; only the
			// review-graph slot was pinned.
			expect(
				collectMemorySampleSubsystems(null).persistWorkers.projectSnapshot,
			).toBeNull();
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);
			await refreshProjectSnapshotPersistWorkerHeapStatistics();
			expect(
				collectMemorySampleSubsystems(null).persistWorkers.projectSnapshot
					?.heapUsedBytes,
			).toBeGreaterThan(0);

			// `terminate()` settles after the worker's `exit` listeners ran.
			await terminateProjectSnapshotPersistWorkerForTests();
			expect(
				collectMemorySampleSubsystems(null).persistWorkers.projectSnapshot,
			).toBeNull();
		}));

	it("clears the reading when the live worker reports an error", async () =>
		withProjectDataDirAsync(async (cwd) => {
			// Fault injection at the host boundary: the real worker object is
			// captured from a pass-through postMessage spy, and an `error` event
			// on it drives the module's own death handler.
			let captured: Worker | undefined;
			const realPost = Worker.prototype.postMessage;
			vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
				this: Worker,
				...args: Parameters<Worker["postMessage"]>
			) {
				captured = this;
				return realPost.apply(this, args);
			});
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);
			await refreshProjectSnapshotPersistWorkerHeapStatistics();
			expect(getProjectSnapshotPersistWorkerHeapStatistics()).not.toBeNull();
			expect(captured).toBeDefined();
			try {
				captured!.emit("error", new Error("injected worker error"));
				expect(getProjectSnapshotPersistWorkerHeapStatistics()).toBeNull();
			} finally {
				await captured!.terminate();
			}
		}));

	it("drops a heap reading that lands after the worker exited", async () =>
		withProjectDataDirAsync(async (cwd) => {
			// Recurrence: 7 of 20 loaded runs (24 busy loops) of the exit case
			// read a non-null slot after terminate(). The sampler's refresh is
			// fire-and-forget, so its answer could land after the exit clear and
			// leave a dead isolate's reading in place with nothing to refresh it.
			// The answer is held here so it lands after the clear every time.
			let captured: Worker | undefined;
			const realPost = Worker.prototype.postMessage;
			vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
				this: Worker,
				...args: Parameters<Worker["postMessage"]>
			) {
				captured = this;
				return realPost.apply(this, args);
			});
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);
			const worker = captured!;
			const reading = await worker.getHeapStatistics();
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			worker.getHeapStatistics = () => held.then(() => reading);
			const refresh = refreshProjectSnapshotPersistWorkerHeapStatistics();
			await terminateProjectSnapshotPersistWorkerForTests();
			release();
			await refresh;
			expect(getProjectSnapshotPersistWorkerHeapStatistics()).toBeNull();
		}));

	it("clears the reading on the test reset", async () =>
		withProjectDataDirAsync(async (cwd) => {
			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);
			await refreshProjectSnapshotPersistWorkerHeapStatistics();
			expect(getProjectSnapshotPersistWorkerHeapStatistics()).not.toBeNull();
			resetProjectSnapshotPersistWorkerForTests();
			expect(getProjectSnapshotPersistWorkerHeapStatistics()).toBeNull();
		}));
});

describe("snapshot fingerprint over bytes (#3789)", () => {
	// Independent oracle: the sentinel form is the same JSON with generatedAt
	// emptied, so a plain sha256 of it must agree (no second scanner involved).
	const oracle = (value: Record<string, unknown>) =>
		createHash("sha256")
			.update(JSON.stringify({ ...value, generatedAt: "" }))
			.digest("hex");

	it("matches the digest the released writer stored in its meta", () => {
		const snapshot = releasedSnapshot();
		expect(
			fingerprintProjectSnapshotJson(
				new TextEncoder().encode(releasedBodyJson),
				snapshot.generatedAt,
			),
		).toBe(releasedMeta.fingerprint);
		expect(
			fingerprintProjectSnapshotJson(releasedBodyJson, snapshot.generatedAt),
		).toBe(releasedMeta.fingerprint);
	});

	// The 4.3.0 string scanner returned the plain JSON digest when the marker
	// was absent: `json.startsWith(marker, index)` is false on a body shorter
	// than the marker, never a throw. A depth-1 quote within the marker's
	// length of the buffer end must still fall through to that digest.
	it.each([
		["a one-key body", { k: 1 }],
		["a two-key body without the marker", { a: "x", b: 1 }],
	])("hashes a marker-absent body without throwing: %s", (_name, value) => {
		const json = JSON.stringify(value);
		const expected = createHash("sha256").update(json).digest("hex");
		const generatedAt = "2026-01-01T00:00:00.000Z";
		expect(fingerprintProjectSnapshotJson(json, generatedAt)).toBe(expected);
		expect(
			fingerprintProjectSnapshotJson(
				new TextEncoder().encode(json),
				generatedAt,
			),
		).toBe(expected);
	});

	it.each([
		["ascii", { generatedAt: "2026-01-01T00:00:00.000Z", n: 1 }],
		["escaped quote in the value", { generatedAt: 'a"b\\c', n: 1 }],
		["non-ASCII everywhere", { generatedAt: "日本é", path: "src/日本語/é.ts" }],
		[
			"a nested key with the same value is not the top-level one",
			{ nested: { generatedAt: "outer" }, generatedAt: "outer" },
		],
		[
			"an escaped quote and brace before the key do not shift the depth",
			{ note: 'say "{" now', generatedAt: "g" },
		],
		[
			"marker text inside a string value is not the key",
			{ note: '"generatedAt":"outer"', generatedAt: "outer" },
		],
	])("agrees with the sentinel oracle: %s", (_name, value) => {
		const json = JSON.stringify(value);
		const expected = oracle(value);
		const generatedAt = value.generatedAt;
		expect(fingerprintProjectSnapshotJson(json, generatedAt)).toBe(expected);

		// A view at a non-zero offset of a bigger buffer (a pooled or sliced body).
		const bytes = new TextEncoder().encode(json);
		const backing = new Uint8Array(bytes.byteLength + 16).fill(0x7b);
		backing.set(bytes, 8);
		expect(
			fingerprintProjectSnapshotJson(
				backing.subarray(8, 8 + bytes.byteLength),
				generatedAt,
			),
		).toBe(expected);
	});
});
