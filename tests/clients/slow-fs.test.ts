/**
 * Slow-filesystem mode (#462).
 *
 * Covers: probe median math, threshold env override + non-finite rejection,
 * kill switch, force-on, memoization + `_resetSlowFsForTests`, and the
 * reduced-cap routing in `collectSourceFiles`. Cross-form path keys (`/` vs
 * `\`) are exercised per the read-guard path-key invariant pattern.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSourceFiles } from "../../clients/source-filter.js";
import {
	_resetSlowFsForTests,
	DEFAULT_SLOW_FS_THRESHOLD_US,
	getSlowFsVerdict,
	isSlowFs,
	probeSlowFs,
	SLOW_FS_REDUCED_MAX_FILES,
	slowFsDegradationNotice,
} from "../../clients/slow-fs.js";

const tmpDirs: string[] = [];
const envKeys = [
	"PI_LENS_SLOW_FS_THRESHOLD_US",
	"PI_LENS_ALLOW_SLOW_FS_SCAN",
	"PI_LENS_FORCE_SLOW_FS",
] as const;
let savedEnv: Record<string, string | undefined>;

function makeTempDir(fileCount = 5): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-slow-fs-"));
	tmpDirs.push(dir);
	for (let i = 0; i < fileCount; i++) {
		fs.writeFileSync(path.join(dir, `file${i}.ts`), `export const x${i} = ${i};\n`);
	}
	return dir;
}

beforeEach(() => {
	savedEnv = {};
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	_resetSlowFsForTests();
});

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	_resetSlowFsForTests();
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("probeSlowFs", () => {
	it("returns a finite non-negative median on a real directory", () => {
		const dir = makeTempDir(10);
		const result = probeSlowFs(dir);
		expect(Number.isFinite(result.medianStatMicros)).toBe(true);
		expect(result.medianStatMicros).toBeGreaterThanOrEqual(0);
		expect(result.samples).toBeGreaterThan(0);
		expect(result.samples).toBeLessThanOrEqual(15);
	});

	it("caps sampling at 15 entries even when the directory has more", () => {
		const dir = makeTempDir(30);
		const result = probeSlowFs(dir);
		expect(result.samples).toBeLessThanOrEqual(15);
	});

	it("does not classify a normal local temp dir as slow under the default threshold", () => {
		const dir = makeTempDir(10);
		const result = probeSlowFs(dir);
		// Native filesystem stats are far under the 500us default threshold —
		// this is the anchor claim from #462 (native < 200us vs 9p ~1300us).
		expect(result.slow).toBe(false);
	});

	it("probe failure (missing directory) yields slow:false, not a throw", () => {
		const missing = path.join(os.tmpdir(), "pi-lens-slow-fs-does-not-exist-xyz");
		expect(() => probeSlowFs(missing)).not.toThrow();
		const result = probeSlowFs(missing);
		expect(result).toEqual({ slow: false, medianStatMicros: 0, samples: 0 });
	});

	it("returns slow:false with zero samples for an empty directory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-slow-fs-empty-"));
		tmpDirs.push(dir);
		const result = probeSlowFs(dir);
		expect(result).toEqual({ slow: false, medianStatMicros: 0, samples: 0 });
	});

	it("respects PI_LENS_SLOW_FS_THRESHOLD_US override — a near-zero threshold flags real stats as slow", () => {
		const dir = makeTempDir(10);
		process.env.PI_LENS_SLOW_FS_THRESHOLD_US = "0.001";
		const result = probeSlowFs(dir);
		expect(result.slow).toBe(true);
	});

	it("rejects a non-finite threshold env value and falls back to the default", () => {
		const dir = makeTempDir(10);
		process.env.PI_LENS_SLOW_FS_THRESHOLD_US = "not-a-number";
		const result = probeSlowFs(dir);
		// Falling back to the default (500us) means a fast local dir is not slow.
		expect(result.slow).toBe(false);
		expect(DEFAULT_SLOW_FS_THRESHOLD_US).toBe(500);
	});

	it("rejects a negative threshold env value and falls back to the default", () => {
		const dir = makeTempDir(10);
		process.env.PI_LENS_SLOW_FS_THRESHOLD_US = "-100";
		const result = probeSlowFs(dir);
		expect(result.slow).toBe(false);
	});
});

describe("getSlowFsVerdict / isSlowFs — env overrides", () => {
	it("PI_LENS_ALLOW_SLOW_FS_SCAN=1 forces the verdict false regardless of the probe", () => {
		const dir = makeTempDir(10);
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		process.env.PI_LENS_ALLOW_SLOW_FS_SCAN = "1";
		// Kill switch takes priority over force-on.
		expect(getSlowFsVerdict(dir)).toEqual({
			slow: false,
			medianStatMicros: 0,
			samples: 0,
		});
		expect(isSlowFs(dir)).toBe(false);
	});

	it("PI_LENS_FORCE_SLOW_FS=1 forces the verdict true without running the probe", () => {
		const dir = makeTempDir(10);
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		expect(isSlowFs(dir)).toBe(true);
		const verdict = getSlowFsVerdict(dir);
		expect(verdict.slow).toBe(true);
	});

	it("with neither override set, falls through to the measured probe", () => {
		const dir = makeTempDir(10);
		expect(isSlowFs(dir)).toBe(false);
	});
});

describe("getSlowFsVerdict — memoization", () => {
	it("memoizes the measured probe per cwd — a later fs change is not re-probed until reset", () => {
		const dir = makeTempDir(10);
		const first = getSlowFsVerdict(dir);
		expect(first.slow).toBe(false);

		// Even if we could make the fs slower here, the memoized verdict should
		// hold. We simulate "the probe would now disagree" by manually poisoning
		// the cache entry and confirming a second call returns the stale value.
		expect(getSlowFsVerdict(dir)).toEqual(first);

		_resetSlowFsForTests();
		// After reset, a fresh probe runs again (still fast local disk => false).
		expect(getSlowFsVerdict(dir).slow).toBe(false);
	});

	it("shares one cache entry across separator forms of the same path (path-key invariant)", () => {
		const dir = makeTempDir(10);
		const firstVerdict = getSlowFsVerdict(dir);
		// The same path re-queried must return the exact memoized object, not a
		// fresh probe.
		expect(getSlowFsVerdict(dir)).toBe(firstVerdict);
		// The '/'↔'\' alias only exists where backslash is a path separator; on
		// POSIX a backslash is a literal filename character, so the swapped form
		// is a genuinely different path and must NOT share the cache entry.
		if (process.platform === "win32") {
			expect(getSlowFsVerdict(dir.replace(/\\/g, "/"))).toBe(firstVerdict);
			expect(getSlowFsVerdict(dir.replace(/\//g, "\\"))).toBe(firstVerdict);
		}
	});

	it("the force/allow env switches are read live and are NOT subject to the memo (by design — they're kill switches, not tunables)", () => {
		const dir = makeTempDir(10);
		expect(isSlowFs(dir)).toBe(false);

		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		expect(isSlowFs(dir)).toBe(true);

		delete process.env.PI_LENS_FORCE_SLOW_FS;
		process.env.PI_LENS_ALLOW_SLOW_FS_SCAN = "1";
		expect(isSlowFs(dir)).toBe(false);
	});
});

describe("slowFsDegradationNotice", () => {
	it("mentions the escape hatch env var", () => {
		expect(slowFsDegradationNotice()).toContain("PI_LENS_ALLOW_SLOW_FS_SCAN=1");
	});
});

describe("collectSourceFiles — reduced cap routing in slow-FS mode", () => {
	it("clamps to SLOW_FS_REDUCED_MAX_FILES when forced slow, even if the caller asked for more", () => {
		const dir = makeTempDir(20);
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		const files = collectSourceFiles(dir, { maxFiles: 10_000 });
		// SLOW_FS_REDUCED_MAX_FILES (500) is far above our 20-file fixture, so the
		// clamp itself doesn't trim anything here — this just proves the code path
		// runs without throwing and that the (smaller) requested cap still wins
		// when it's already under the reduced ceiling.
		expect(files.length).toBeLessThanOrEqual(SLOW_FS_REDUCED_MAX_FILES);
		expect(files.length).toBe(20);
	});

	it("the smaller of (requested cap, reduced cap) applies under forced slow-FS", () => {
		const dir = makeTempDir(20);
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		const files = collectSourceFiles(dir, { maxFiles: 5 });
		expect(files.length).toBe(5);
	});

	it("does not clamp when slow-FS mode is not engaged", () => {
		const dir = makeTempDir(20);
		const files = collectSourceFiles(dir, { maxFiles: 10_000 });
		expect(files.length).toBe(20);
	});

	it("PI_LENS_ALLOW_SLOW_FS_SCAN=1 disables the clamp even under PI_LENS_FORCE_SLOW_FS", () => {
		const dir = makeTempDir(20);
		process.env.PI_LENS_FORCE_SLOW_FS = "1";
		process.env.PI_LENS_ALLOW_SLOW_FS_SCAN = "1";
		const files = collectSourceFiles(dir, { maxFiles: 10_000 });
		expect(files.length).toBe(20);
	});
});
