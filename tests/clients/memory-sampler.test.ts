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

import { beforeEach, describe, expect, it } from "vitest";
import {
	buildMemorySample,
	collectMemorySampleSubsystems,
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
import { getReviewGraphWorkspaceCacheSnapshot } from "../../clients/review-graph/builder.js";
import { getDispatchCascadeCacheStats } from "../../clients/dispatch/integration.js";
import type { WordIndex } from "../../clients/word-index.js";
import { PathKeyedMap } from "../../clients/path-keyed-map.js";
import { normalizeEphemeralMapKey } from "../../clients/path-utils.js";

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
		expect(toMemoryProcessUsage(mem)).toEqual({
			rssBytes: 100,
			heapTotalBytes: 80,
			heapUsedBytes: 60,
			externalBytes: 20,
			arrayBuffersBytes: 10,
			peakWorkingSetBytes: null,
		});

		// #1999: OS high-water mark rides along so an idle-moment rss sample can be
		// distinguished from true growth (libuv maps PeakWorkingSetSize → maxRSS in KB).
		expect(
			toMemoryProcessUsage(mem, { maxRSS: 500_000 }).peakWorkingSetBytes,
		).toBe(500_000 * 1024);
		expect(toMemoryProcessUsage(mem, {}).peakWorkingSetBytes).toBeNull();
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
	it("wordIndex is null when none is supplied (no word index built yet this session)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.wordIndex).toBeNull();
	});

	it("reports word-index doc/posting/forward counts when a word index is supplied", () => {
		const wordIndex: WordIndex = {
			postings: new Map([["foo", [{ file: "a.ts", line: 1 }]]]),
			docLengths: (() => {
				const m = new PathKeyedMap<number>(normalizeEphemeralMapKey);
				m.set("a.ts", 5);
				return m;
			})(),
			forward: (() => {
				const m = new PathKeyedMap<Map<string, number>>(
					normalizeEphemeralMapKey,
				);
				m.set("a.ts", new Map([["foo", 1]]));
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
			postings: 1,
			forwardEntries: 1,
		});
	});

	it("reviewGraph/dispatchCaches mirror the live accessors exactly (no extra reads)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.reviewGraph).toEqual(
			getReviewGraphWorkspaceCacheSnapshot(),
		);
		expect(subsystems.dispatchCaches).toEqual(getDispatchCascadeCacheStats());
	});

	it("every numeric field is non-negative and finite (plausibility, not exact values)", () => {
		const subsystems = collectMemorySampleSubsystems(null);
		expect(subsystems.reviewGraph.cacheEntries).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalNodes).toBeGreaterThanOrEqual(0);
		expect(subsystems.reviewGraph.totalEdges).toBeGreaterThanOrEqual(0);
		expect(
			subsystems.dispatchCaches.recentlyCleanNeighborCacheSize,
		).toBeGreaterThanOrEqual(0);
		if (subsystems.treeSitter) {
			expect(subsystems.treeSitter.languagesLoaded).toBeGreaterThanOrEqual(0);
			expect(subsystems.treeSitter.treeCacheTotalBytes).toBeGreaterThanOrEqual(
				0,
			);
		}
	});
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
