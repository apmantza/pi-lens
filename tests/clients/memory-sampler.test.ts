/**
 * Tests for the periodic memory-attribution sample (#1123 item 2).
 *
 * `shouldEmitMemorySample`/`toMemoryProcessUsage`/`formatMemoryHealthLine` are
 * pure. `collectMemorySampleSubsystems`/`buildMemorySample` touch real
 * process-global singletons (the shared tree-sitter client, the review-graph
 * workspace cache, the dispatch cascade caches) — asserted structurally
 * (fields present, non-negative, `null` when the subsystem hasn't been
 * touched yet) rather than against exact values, since those singletons are
 * shared with the rest of the suite.
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildMemorySample,
	collectMemorySampleSubsystems,
	estimateDispatchCacheBytes,
	formatMemoryHealthLine,
	HEAP_GROWTH_TIGHTEN_RATIO,
	isRapidHeapGrowth,
	MEMORY_SAMPLE_TURN_INTERVAL,
	recordMemorySampleOutcome,
	resetMemorySamplerCadence,
	shouldEmitMemorySample,
	shouldEmitMemorySampleAdaptive,
	toMemoryProcessUsage,
} from "../../clients/memory-sampler.js";
import {
	estimateReviewGraphStoreBytes,
	getReviewGraphWorkspaceCacheSnapshot,
} from "../../clients/review-graph/builder.js";
import { getDispatchCascadeCacheStats } from "../../clients/dispatch/integration.js";
import type { WordIndex } from "../../clients/word-index.js";
import {
	WORD_POSTING_LIST_OVERHEAD_BYTES,
	WordForwardEntry,
	WordIndexFileTable,
	WordPostingList,
} from "../../clients/word-index-store.js";
import { serializeWordIndex } from "../../clients/word-index.js";
import { PathKeyedMap } from "../../clients/path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../../clients/path-utils.js";
import { createLSPClient } from "../../clients/lsp/client.js";
import { stopLSP } from "../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../support/fake-lsp-server.js";

describe("shouldEmitMemorySample (cadence)", () => {
	it("is false on turn 0 (nothing meaningful resident yet)", () => {
		expect(shouldEmitMemorySample(0)).toBe(false);
	});

	it(`is true exactly every ${MEMORY_SAMPLE_TURN_INTERVAL} turns`, () => {
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL)).toBe(true);
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL * 3)).toBe(true);
	});

	it("is false on every other turn", () => {
		for (let t = 1; t < MEMORY_SAMPLE_TURN_INTERVAL; t++) {
			expect(shouldEmitMemorySample(t)).toBe(false);
		}
		expect(shouldEmitMemorySample(MEMORY_SAMPLE_TURN_INTERVAL + 1)).toBe(false);
	});
});

describe("adaptive cadence (#1999 rising edge)", () => {
	beforeEach(() => {
		resetMemorySamplerCadence();
	});

	it("matches the base every-10 cadence when no growth has been recorded", () => {
		expect(shouldEmitMemorySampleAdaptive(0)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(5)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(MEMORY_SAMPLE_TURN_INTERVAL)).toBe(
			true,
		);
		expect(
			shouldEmitMemorySampleAdaptive(MEMORY_SAMPLE_TURN_INTERVAL + 1),
		).toBe(false);
	});

	it(`tightens to every turn after >${HEAP_GROWTH_TIGHTEN_RATIO}x growth between samples, then reverts once stable`, () => {
		recordMemorySampleOutcome(100, 10);
		recordMemorySampleOutcome(130, 20); // +30% — rapid growth
		// Tightened: the turn immediately after the growing sample samples too.
		expect(shouldEmitMemorySampleAdaptive(21)).toBe(true);
		// Stabilized: without another rapid-growth reading the window does not
		// extend past that one tightened turn.
		expect(shouldEmitMemorySampleAdaptive(22)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(29)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(30)).toBe(true);
	});

	it("keeps tightening while growth continues each sampled turn", () => {
		recordMemorySampleOutcome(100, 10);
		recordMemorySampleOutcome(130, 20); // +30% vs 100
		expect(shouldEmitMemorySampleAdaptive(21)).toBe(true);
		recordMemorySampleOutcome(200, 21); // +54% vs 130 — still growing
		expect(shouldEmitMemorySampleAdaptive(22)).toBe(true);
		recordMemorySampleOutcome(210, 22); // +5% vs 200 — stabilized
		expect(shouldEmitMemorySampleAdaptive(23)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(24)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(30)).toBe(true);
	});

	it("does not tighten on sub-threshold growth", () => {
		recordMemorySampleOutcome(100, 10);
		recordMemorySampleOutcome(110, 20); // +10% — below threshold
		expect(shouldEmitMemorySampleAdaptive(21)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(30)).toBe(true);
	});

	it("isRapidHeapGrowth: exactly-at-threshold is not rapid; zero/negative baselines never tighten", () => {
		expect(isRapidHeapGrowth(0, 1_000_000_000)).toBe(false);
		expect(isRapidHeapGrowth(-1, 1_000_000_000)).toBe(false);
		expect(isRapidHeapGrowth(100, 100 * HEAP_GROWTH_TIGHTEN_RATIO)).toBe(false);
		expect(isRapidHeapGrowth(100, 100 * HEAP_GROWTH_TIGHTEN_RATIO + 1)).toBe(
			true,
		);
	});

	it("reset clears the tightened window and baseline (session boundary)", () => {
		recordMemorySampleOutcome(100, 10);
		recordMemorySampleOutcome(130, 20);
		expect(shouldEmitMemorySampleAdaptive(21)).toBe(true);
		resetMemorySamplerCadence();
		expect(shouldEmitMemorySampleAdaptive(21)).toBe(false);
		// Baseline cleared too: the next base-cadence sample has no pre-reset
		// history to grow from, so it records a baseline instead of tightening.
		expect(shouldEmitMemorySampleAdaptive(30)).toBe(true);
		recordMemorySampleOutcome(140, 30);
		expect(shouldEmitMemorySampleAdaptive(31)).toBe(false);
		// ...but a fresh growing pair tightens again.
		recordMemorySampleOutcome(180, 40);
		expect(shouldEmitMemorySampleAdaptive(41)).toBe(true);
	});

	it("never tightens on turn 0 or negative turn indexes", () => {
		recordMemorySampleOutcome(100, 10);
		recordMemorySampleOutcome(130, 20);
		resetMemorySamplerCadence();
		expect(shouldEmitMemorySampleAdaptive(-10)).toBe(false);
		expect(shouldEmitMemorySampleAdaptive(0)).toBe(false);
	});
});

describe("toMemoryProcessUsage (pure reshape)", () => {
	it("maps every process.memoryUsage() field to this module's names", () => {
		const mem: NodeJS.MemoryUsage = {
			rss: 100,
			heapTotal: 80,
			heapUsed: 60,
			external: 20,
			arrayBuffers: 10,
		};
		const { heapSettledBytes, heapSettledMajorGcCount, ...reshaped } =
			toMemoryProcessUsage(mem);
		expect(reshaped).toEqual({
			rssBytes: 100,
			heapTotalBytes: 80,
			heapUsedBytes: 60,
			externalBytes: 20,
			arrayBuffersBytes: 10,
			externalNonBufferBytes: 10,
			peakWorkingSetBytes: null,
		});
		// The settled pair is process-wide GC state, not part of the reshape: a
		// major GC earlier in this fork makes it non-null. The fresh-isolate test
		// below pins its null-until-first-major-GC transition.
		expect(heapSettledBytes === null).toBe(heapSettledMajorGcCount === 0);

		// #1999: OS high-water mark rides along so an idle-moment rss sample can be
		// distinguished from true growth (libuv maps PeakWorkingSetSize → maxRSS in KB).
		expect(
			toMemoryProcessUsage(mem, { maxRSS: 500_000 }).peakWorkingSetBytes,
		).toBe(500_000 * 1024);
		expect(toMemoryProcessUsage(mem, {}).peakWorkingSetBytes).toBeNull();
	});
});

describe("settled heap through the production GC observer (#4129)", () => {
	it("moves from null to a reading after one real major GC in a fresh isolate", async () => {
		// Recurrence (VERIFY_4129 M3): the observer's `observe()`, its callback
		// and the major-kind filter were each mutable without a red, because the
		// only test drove a test seam instead of a GC. A fresh worker isolate
		// loads the built sampler (the production module-load state), forces a
		// real mark-compact through the `--expose-gc` + vm trick, and waits on
		// event-loop ticks, never wall-clock, for the observer's entry.
		const samplerUrl = pathToFileURL(
			path.join(import.meta.dirname, "../../clients/memory-sampler.js"),
		).href;
		const source = `
			const { parentPort } = require("node:worker_threads");
			const v8 = require("node:v8");
			const vm = require("node:vm");
			(async () => {
				const sampler = await import(${JSON.stringify(samplerUrl)});
				const read = () => {
					const usage = sampler.toMemoryProcessUsage(process.memoryUsage());
					return [usage.heapSettledBytes, usage.heapSettledMajorGcCount];
				};
				const before = read();
				v8.setFlagsFromString("--expose-gc");
				vm.runInNewContext("gc")();
				let after = read();
				let ticks = 0;
				while (after[1] === before[1] && ticks < 50) {
					await new Promise((resolve) => setImmediate(resolve));
					ticks += 1;
					after = read();
				}
				parentPort.postMessage({ before, after });
			})().catch((error) => parentPort.postMessage({ error: String(error) }));
		`;
		const worker = new Worker(source, { eval: true });
		try {
			const result = await new Promise<{
				before?: [number | null, number];
				after?: [number | null, number];
				error?: string;
			}>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			expect(result.error).toBeUndefined();
			expect(result.before).toEqual([null, 0]);
			expect(result.after?.[1]).toBe(1);
			expect(result.after?.[0]).toBeGreaterThan(0);
		} finally {
			await worker.terminate();
		}
	});
});

function fakeMem(
	overrides: Partial<NodeJS.MemoryUsage> = {},
): NodeJS.MemoryUsage {
	return {
		rss: 300 * 1024 * 1024,
		heapTotal: 150 * 1024 * 1024,
		heapUsed: 100 * 1024 * 1024,
		external: 20 * 1024 * 1024,
		arrayBuffers: 10 * 1024 * 1024,
		...overrides,
	};
}

describe("collectMemorySampleSubsystems (O(1)/O(bounded-cache-size) live reads)", () => {
	it("estimates graph store bytes from counts without walking graph contents", () => {
		// Independent oracle from the reviewer’s isolated-store measurement:
		// 450.5 bytes per node and 243 bytes per edge.
		expect(estimateReviewGraphStoreBytes(2, 3)).toBe(1630);
	});

	// #2282 review round F4: the session-fact entry count arrived as a
	// count-only field, so `dispatchCaches.estimatedBytes` still omitted the
	// whole sessionFacts footprint. Both counts now carry measured bytes.
	it("attributes bytes to session-fact entries, not just the neighbor cache", () => {
		expect(
			estimateDispatchCacheBytes({
				recentlyCleanNeighborCacheSize: 2,
				sessionFactEntries: 1000,
			}),
		).toBe(440_640);
		expect(
			estimateDispatchCacheBytes({
				recentlyCleanNeighborCacheSize: 0,
				sessionFactEntries: 1000,
			}),
		).toBe(440_000);
	});

	it("wordIndex is null when none is supplied (no word index built yet this session)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.wordIndex).toBeNull();
	});

	it("reports word-index doc/posting/forward counts when a word index is supplied", () => {
		const wordIndex: WordIndex = {
			postings: new Map([["foo", WordPostingList.fromLanes("foo", [0, 1])]]),
			fileTable: (() => {
				const table = new WordIndexFileTable();
				table.intern(normalizeEphemeralMapKey("a.ts"), "a.ts");
				return table;
			})(),
			docLengths: (() => {
				const m = new PathKeyedMap<number>(normalizeEphemeralMapKey);
				m.set("a.ts", 5);
				return m;
			})(),
			forward: (() => {
				const m = new PathKeyedMap<WordForwardEntry>(normalizeEphemeralMapKey);
				m.set("a.ts", WordForwardEntry.fromTally(new Map([["foo", 1]])));
				return m;
			})(),
			totalTokens: 5,
			docCount: 1,
			fileMtimes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
			fileSizes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
		};
		const subsystems = collectMemorySampleSubsystems(wordIndex);
		expect(subsystems.wordIndex).toEqual({
			docs: 1,
			fileTable: 1,
			// `postings` is the DISTINCT TOKEN count and `postingEntries` is the
			// posting count. #1999 read the first as the second and under-counted
			// the subsystem sixtyfold, so both are asserted here (#2069).
			postings: 1,
			postingEntries: 1,
			// One packed posting (8 bytes) plus one packed forward entry (8
			// bytes), each carrying the fixed per-list header charge.
			residentBytes: 2 * (8 + WORD_POSTING_LIST_OVERHEAD_BYTES),
			forwardEntries: 1,
			wireBytes: null,
		});
	});

	it("reports the S1 attribution fields through the real sampler", () => {
		const wordIndex: WordIndex = {
			postings: new Map([["foo", WordPostingList.fromLanes("foo", [0, 1, 2])]]),
			fileTable: new WordIndexFileTable(),
			docLengths: new PathKeyedMap<number>(normalizeEphemeralMapKey),
			forward: new PathKeyedMap<WordForwardEntry>(normalizeEphemeralMapKey),
			totalTokens: 3,
			docCount: 0,
			fileMtimes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
			fileSizes: new PathKeyedMap<number>(normalizeEphemeralMapKey),
		};
		serializeWordIndex(wordIndex);
		const sample = buildMemorySample(null, fakeMem());
		expect(sample.process.externalNonBufferBytes).toBe(
			sample.process.externalBytes - sample.process.arrayBuffersBytes,
		);
		expect(sample.samplerDurationMs).toBeGreaterThanOrEqual(0);
		expect(sample.subsystems.wordIndex).toBeNull();
		// Serializing alone never measures the wire form; the persist does
		// (tests/clients/project-snapshot-persist-transfer.test.ts).
		expect(collectMemorySampleSubsystems(wordIndex).wordIndex?.wireBytes).toBe(
			null,
		);
		expect(sample.subsystems.persistWorkers).toHaveProperty("reviewGraph");
		expect(sample.subsystems.persistWorkers).toHaveProperty("projectSnapshot");
	});

	it("reviewGraph/dispatchCaches mirror the live accessors exactly (no extra reads)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.reviewGraph).toEqual(
			getReviewGraphWorkspaceCacheSnapshot(),
		);
		expect(subsystems.dispatchCaches).toEqual({
			...getDispatchCascadeCacheStats(),
			estimatedBytes: 0,
		});
	});

	it("every numeric field is non-negative and finite (plausibility, not exact values)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.lsp.clients).toBeGreaterThanOrEqual(0);
		expect(subsystems.lsp.incrementalTextEntries).toBeGreaterThanOrEqual(0);
		expect(subsystems.lsp.incrementalTextBytes).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.cacheEntries).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalNodes).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalEdges).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.residentBytes).toBeGreaterThanOrEqual(0);
		expect(
			subsystems.dispatchCaches.recentlyCleanNeighborCacheSize,
		).toBeGreaterThanOrEqual(0);
		expect(subsystems.dispatchCaches.estimatedBytes).toBeGreaterThanOrEqual(0);
		// Registry sweep: every non-null subsystem must expose a byte field, so
		// adding a count-only subsystem cannot silently recur (#2114, #2132
		// criterion 3).
		for (const [name, subsystem] of Object.entries(subsystems)) {
			if (subsystem === null) continue;
			if (name === "persistWorkers") {
				for (const worker of [
					subsystem.reviewGraph,
					subsystem.projectSnapshot,
				]) {
					if (worker === null) continue;
					expect(
						Object.keys(worker).some((key) => /Bytes$/.test(key)),
						"persist worker must expose byte-denominated fields",
					).toBe(true);
				}
				continue;
			}
			expect(
				Object.keys(subsystem).some((key) => /Bytes$/.test(key)),
				`${name} must expose a byte-denominated field`,
			).toBe(true);
		}
		if (subsystems.treeSitter) {
			expect(subsystems.treeSitter.languagesLoaded).toBeGreaterThanOrEqual(0);
			expect(subsystems.treeSitter.treeCacheTotalBytes).toBeGreaterThanOrEqual(
				0,
			);
		}
	});

	it("#2065 fix round 1 F6: reports a REAL client's retained bytes, not just a mock's structural zero (#2065)", async () => {
		// The "non-negative" test above never proves the lsp fields are actually
		// wired: every state it reads from is either freshly booted or a plain
		// mock that never enters `activeLspClients`, so `clients`/
		// `incrementalTextEntries`/`incrementalTextBytes` all read 0 whether or
		// not the plumbing works. A real client with known retained text is the
		// only way to prove a positive value flows through.
		const proc = await spawnFakeLspServer({
			cwd: process.cwd(),
			env: { ...process.env, FAKE_LSP_SYNC_KIND: "2" }, // Incremental
		});
		const client = await createLSPClient({
			serverId: "memory-sample-real",
			process: proc,
			root: process.cwd(),
		});
		try {
			const filePath = path.join(os.tmpdir(), "pi-lens-memory-sample-real.ts");
			const content = "x".repeat(1000);
			await client.notify.open(filePath, content, "typescript");

			const subsystems = collectMemorySampleSubsystems(null);
			expect(subsystems.lsp.clients).toBeGreaterThan(0);
			expect(subsystems.lsp.incrementalTextEntries).toBeGreaterThan(0);
			expect(subsystems.lsp.incrementalTextBytes).toBeGreaterThanOrEqual(
				content.length * 2,
			);
		} finally {
			await client.shutdown().catch(() => {});
			await stopLSP(proc).catch(() => {});
		}
	}, 15_000);
});

describe("buildMemorySample", () => {
	it("assembles process + subsystems from an injected memoryUsage reading", () => {
		const sample = buildMemorySample(null, fakeMem());
		expect(sample.process.rssBytes).toBe(300 * 1024 * 1024);
		expect(sample.subsystems).toBeDefined();
	});

	it("carries an injected peak-working-set reading into process usage (#1999)", () => {
		const sample = buildMemorySample(null, fakeMem(), { maxRSS: 800_000 });
		expect(sample.process.peakWorkingSetBytes).toBe(800_000 * 1024);
	});

	it("session context rides along when supplied (#1999)", () => {
		const sample = buildMemorySample(null, fakeMem(), undefined, {
			sessionAgeMs: 6543,
			sessionStartedAt: 1000,
			turnCount: 12,
		});
		expect(sample.session).toEqual({
			sessionAgeMs: 6543,
			sessionStartedAt: 1000,
			turnCount: 12,
		});
		// Absent context stays absent — /lens-health callers omit it.
		expect(buildMemorySample(null, fakeMem()).session).toBeUndefined();
	});

	it("health line renders peak working set when present (#1999)", () => {
		const sample = buildMemorySample(null, fakeMem(), { maxRSS: 800_000 });
		expect(formatMemoryHealthLine(sample)).toContain("peak WS 781MB");
	});
});

describe("formatMemoryHealthLine (pure)", () => {
	it("renders RSS/heap/external in MB and the review-graph counts", () => {
		const sample = buildMemorySample(null, fakeMem());
		const line = formatMemoryHealthLine(sample);
		expect(line).toContain("Memory: RSS 300MB");
		expect(line).toContain("heap 100/150MB");
		expect(line).toContain("external 20MB");
		expect(line).toMatch(/review-graph \d+n\/\d+e \(\d+ cwd\)/);
	});

	it("renders 'n/a' for tree-sitter when the shared client was never touched (subsystem is null)", () => {
		const sample = buildMemorySample(null, fakeMem());
		// Force the null-subsystem branch directly (doesn't depend on suite ordering
		// of whether some other test already initialized the shared client).
		sample.subsystems.treeSitter = null;
		const line = formatMemoryHealthLine(sample);
		expect(line).toContain("tree-sitter cache n/a");
	});
});
