/**
 * #3515: the generation lock's lease-refresh primitives.
 *
 * The install lock's lease (the install timeout plus 60s slack, 180s by
 * default) was shorter than a legitimate ERESOLVE npm install, which runs two
 * 120s `runInstallAttempt`s inside one hold — nothing renewed the
 * generation's mtime while that ran, so a second installer could judge the
 * first stale and take over while it was still writing. `generation-lock.ts`
 * now exports two primitives for any async holder whose hold can legitimately
 * outlive its lease:
 * - `startGenerationHeartbeat` refreshes the held generation's mtime on an
 *   unref'd interval, so a contender's own `tryAcquireGeneration` never sees
 *   it go stale.
 * - `ownsTopGeneration` is the belt-and-suspenders check a holder makes right
 *   before a write it cannot safely race with a second holder: true only
 *   while this hold is still the live top generation.
 *
 * These cases test the two primitives directly, at the layer they are
 * declared, rather than only through the installer's own integration test
 * (`tests/clients/installer/tool-discovery.test.ts`), which proves they are
 * wired in correctly but not their own edge cases (both `ownsTopGeneration`
 * branches, `stop()` actually stopping the timer).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type GenerationHold,
	heartbeatIntervalMs,
	ownsTopGeneration,
	releaseGeneration,
	startGenerationHeartbeat,
	tryAcquireGeneration,
} from "../../clients/generation-lock.js";

const tempDirs: string[] = [];
function freshGenerationDir(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-generation-lock-heartbeat-"),
	);
	tempDirs.push(dir);
	return path.join(dir, "locks");
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("heartbeatIntervalMs (#3515)", () => {
	it("is a quarter of the lease", () => {
		expect(heartbeatIntervalMs(180_000)).toBe(45_000);
		expect(heartbeatIntervalMs(4_000)).toBe(1_000);
	});

	it("floors at 1s so a short test lease never thrashes the filesystem", () => {
		expect(heartbeatIntervalMs(1_000)).toBe(1_000);
		expect(heartbeatIntervalMs(0)).toBe(1_000);
	});
});

describe("startGenerationHeartbeat keeps a long hold from going stale (#3515)", () => {
	it("keeps a second acquirer out across a hold that outlives the lease", () => {
		vi.useFakeTimers();
		const genDir = freshGenerationDir();
		const staleMs = 1_000;
		const hold = tryAcquireGeneration(genDir, staleMs);
		expect(hold).toBeDefined();
		const heartbeat = startGenerationHeartbeat(
			hold as GenerationHold,
			heartbeatIntervalMs(staleMs),
		);
		try {
			// 5x the lease — the installer's real ratio (an ERESOLVE install can
			// run ~240s of attempts inside a 180s lease, ~1.3x, but the interval
			// itself is only proven correct if it survives several missed-tick
			// margins too).
			vi.advanceTimersByTime(staleMs * 5);
			const contender = tryAcquireGeneration(genDir, staleMs);
			expect(contender).toBeUndefined();
		} finally {
			heartbeat.stop();
		}
	});

	// Mutation / red-first: this is the pre-#3515 shape — no heartbeat at all —
	// proving the case above is not vacuously green (a `staleMs` too generous,
	// a contender that always backs off for some other reason).
	it("mutation: without the heartbeat the same hold goes stale and a contender takes over", () => {
		vi.useFakeTimers();
		const genDir = freshGenerationDir();
		const staleMs = 1_000;
		const hold = tryAcquireGeneration(genDir, staleMs);
		expect(hold).toBeDefined();
		// No heartbeat started.
		vi.advanceTimersByTime(staleMs * 5);
		const contender = tryAcquireGeneration(genDir, staleMs);
		expect(contender).toBeDefined();
	});

	it("stop() lets the generation go stale again", () => {
		vi.useFakeTimers();
		const genDir = freshGenerationDir();
		const staleMs = 1_000;
		const hold = tryAcquireGeneration(genDir, staleMs) as GenerationHold;
		const heartbeat = startGenerationHeartbeat(
			hold,
			heartbeatIntervalMs(staleMs),
		);
		vi.advanceTimersByTime(staleMs * 2);
		heartbeat.stop();
		vi.advanceTimersByTime(staleMs * 5);
		const contender = tryAcquireGeneration(genDir, staleMs);
		expect(contender).toBeDefined();
	});
});

describe("ownsTopGeneration (#3515)", () => {
	it("is true for the sole holder", () => {
		const genDir = freshGenerationDir();
		const hold = tryAcquireGeneration(genDir, 60_000) as GenerationHold;
		expect(ownsTopGeneration(hold)).toBe(true);
	});

	it("is false once a taker creates a higher generation", () => {
		const genDir = freshGenerationDir();
		const hold = tryAcquireGeneration(genDir, 60_000) as GenerationHold;
		fs.writeFileSync(path.join(genDir, "lock.2"), "999999 0\n", {
			flag: "wx",
		});
		expect(ownsTopGeneration(hold)).toBe(false);
	});

	// Mutation: a check that only ever looked at the released marker (never
	// the higher-generation case) would pass the case above vacuously if
	// `topGeneration` were hard-coded to the hold's own generation — this
	// pins that the CURRENT top, not just "no marker", decides ownership.
	it("mutation: a same-numbered generation with no higher taker still owns", () => {
		const genDir = freshGenerationDir();
		const hold = tryAcquireGeneration(genDir, 60_000) as GenerationHold;
		expect(ownsTopGeneration(hold)).toBe(true);
		fs.writeFileSync(path.join(genDir, "lock.2"), "999999 0\n", {
			flag: "wx",
		});
		expect(ownsTopGeneration(hold)).toBe(false);
	});

	it("is false once this hold's own generation is marked released", () => {
		const genDir = freshGenerationDir();
		const hold = tryAcquireGeneration(genDir, 60_000) as GenerationHold;
		releaseGeneration(hold);
		expect(ownsTopGeneration(hold)).toBe(false);
	});

	it("is false when the generation directory is gone", () => {
		const genDir = freshGenerationDir();
		const hold = tryAcquireGeneration(genDir, 60_000) as GenerationHold;
		fs.rmSync(genDir, { recursive: true, force: true });
		expect(ownsTopGeneration(hold)).toBe(false);
	});
});
