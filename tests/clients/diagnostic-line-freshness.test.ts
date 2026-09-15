/**
 * Past-EOF validity gate — #1641.
 *
 * Live case: an LSP's in-memory document drifted longer than disk with no
 * disk write at all (402-line file, diagnostics cited lines 407-410). #1622's
 * mtime-based freshness gate cannot catch this — the file's mtime never
 * changed. The orthogonal, cheap check is structural: a cited line beyond the
 * file's CURRENT line count cannot describe current content, full stop.
 *
 * Line-count convention (review round F1): this matches the LSP's own
 * addressing, `range.start.line + 1`, NOT `wc -l`. A document with N newline
 * characters has N+1 ADDRESSABLE lines — the position after the final `\n`,
 * or the single line of an empty document, is real and a server anchors
 * diagnostics there (e.g. TS1005 "'}' expected" at EOF). So `"a\nb\nc\n"` (3
 * newlines, `wc -l` says 3) is 4 lines for this gate's purposes, and a
 * diagnostic citing line 4 is NOT past EOF.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));

import {
	_resetSharedLineCountCacheForTests,
	_seedSharedLineCountCacheForTests,
	createLineCountCache,
	demotePastEofDiagnostics,
	getCachedLineCount,
} from "../../clients/diagnostic-line-freshness.js";
import { setupTestEnvironment } from "./test-utils.js";

interface Diagnostic {
	line?: number;
	stale?: boolean;
	message: string;
}

describe("demotePastEofDiagnostics (#1641)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	function setup(prefix = "pi-lens-past-eof-") {
		const env = setupTestEnvironment(prefix);
		cleanups.push(env.cleanup);
		return env;
	}

	it("RED CASE: demotes a diagnostic citing a line past the file's current EOF", () => {
		const env = setup();
		// 402-line file, matching the live #1641 forensic case's line count.
		// No trailing newline, so wc-l-style and LSP-addressable counts agree.
		const filePath = path.join(env.tmpDir, "kilo.ts");
		fs.writeFileSync(
			filePath,
			Array.from({ length: 402 }, (_, i) => `// line ${i + 1}`).join("\n"),
		);

		const diagnostics: Diagnostic[] = [
			{ line: 396, message: "kilo is defined here — still valid" },
			{ line: 407, message: "stale in-memory citation" },
			{ line: 410, message: "another stale in-memory citation" },
		];

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics,
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(2);
		expect(result.diagnostics.find((d) => d.line === 396)?.stale).toBeFalsy();
		expect(result.diagnostics.find((d) => d.line === 407)?.stale).toBe(true);
		expect(result.diagnostics.find((d) => d.line === 410)?.stale).toBe(true);
	});

	it("F1 BOUNDARY: an EOF diagnostic on the trailing empty line (newlineCount+1) is NOT past EOF", () => {
		// Reviewer's exact repro shape: a file with 2 REAL lines, each newline-
		// terminated (`wc -l` reports 2) — the reviewer's TS1005 "'}' expected"
		// anchors to line 3, the empty line after the final `\n`. Pre-fix (wc-l
		// convention), this file's "line count" was 2 and line 3 wrongly demoted.
		const env = setup();
		const filePath = path.join(env.tmpDir, "boundary-trailing.ts");
		fs.writeFileSync(filePath, "line1\nline2\n"); // 2 newlines → 3 addressable lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 3, message: "'}' expected" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(result.diagnostics[0]?.stale).toBeFalsy();
	});

	it("F1 BOUNDARY: the first genuinely nonexistent line (newlineCount+2) IS past EOF", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "boundary-past.ts");
		fs.writeFileSync(filePath, "line1\nline2\n"); // 3 addressable lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 4, message: "genuinely past EOF" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(1);
		expect(result.diagnostics[0]?.stale).toBe(true);
	});

	it("F1 BOUNDARY: a file with NO trailing newline — last real line is the boundary", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "boundary-no-trailing.ts");
		fs.writeFileSync(filePath, "line1\nline2\nline3"); // 2 newlines → 3 addressable lines

		const ok = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 3, message: "last real line" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});
		expect(ok.diagnostics[0]?.stale).toBeFalsy();

		const past = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 4, message: "past EOF" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});
		expect(past.diagnostics[0]?.stale).toBe(true);
	});

	it("fails OPEN when a zero-byte file is observed mid-write", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "empty.ts");
		fs.writeFileSync(filePath, "");

		const line1 = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [
				{ line: 1, message: "position 0,0 on an empty doc" } as Diagnostic,
			],
			lineCountCache: createLineCountCache(),
		});
		expect(line1.diagnostics[0]?.stale).toBeFalsy();

		expect(line1.demotedCount).toBe(0);
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("does not turn a zero-byte stat into a high-line verdict, then evaluates real content", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "mid-write.ts");
		const content = Array.from(
			{ length: 141 },
			(_, i) => `// line ${i + 1}`,
		).join("\n");
		const diagnostics = [
			{ line: 141, message: "live diagnostic" } as Diagnostic,
		];
		fs.writeFileSync(filePath, "");

		const midWrite = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics,
			lineCountCache: createLineCountCache(),
		});
		expect(midWrite.diagnostics[0]?.stale).toBeFalsy();
		expect(midWrite.demotedCount).toBe(0);

		fs.writeFileSync(filePath, content);
		const realContent = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics,
			lineCountCache: createLineCountCache(),
		});
		expect(realContent.diagnostics[0]?.stale).toBeFalsy();
		expect(realContent.demotedCount).toBe(0);
	});

	it("emits one diagnostic_past_eof record naming file, cited lines, and actual line count", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "short.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // 3 newlines → 4 addressable lines

		demotePastEofDiagnostics({
			store: "lens_diagnostics",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 6, message: "past eof" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(logLatency).toHaveBeenCalledTimes(1);
		const call = logLatency.mock.calls[0][0];
		expect(call.phase).toBe("diagnostic_past_eof");
		expect(call.metadata.store).toBe("lens_diagnostics");
		expect(call.metadata.file).toBe("short.ts");
		expect(call.metadata.sizeBytes).toBe(fs.statSync(filePath).size);
		expect(call.metadata.actualLineCount).toBe(4);
		expect(call.metadata.demotedCount).toBe(1);
		expect(call.metadata.sampleCitedLines).toEqual([6]);
	});

	it("does NOT demote a diagnostic citing a line within the current file", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "ok.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // 5 newlines → 6 addressable lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 5, message: "well within range" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(result.diagnostics[0]?.stale).toBeFalsy();
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("fails OPEN (never demotes) when the file cannot be stat'ed", () => {
		const env = setup();
		const missing = path.join(env.tmpDir, "does-not-exist.ts");

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath: missing,
			diagnostics: [{ line: 999, message: "cannot be verified" } as Diagnostic],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0);
		expect(result.diagnostics[0]?.stale).toBeFalsy();
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("leaves an already-stale-and-still-past-EOF diagnostic untouched (no re-demote / re-log)", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "already-stale.ts");
		fs.writeFileSync(filePath, "a\nb\n"); // 2 newlines → 3 addressable lines

		const result = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [
				{ line: 50, stale: true, message: "still past EOF" } as Diagnostic,
			],
			lineCountCache: createLineCountCache(),
		});

		expect(result.demotedCount).toBe(0); // no RISING edge — already flagged
		expect(result.diagnostics[0]?.stale).toBe(true); // still demoted
		expect(logLatency).not.toHaveBeenCalled();
	});

	it("F3 RE-ARM: a transient shrink demotes, then restoring the file un-demotes on the next call", () => {
		// Red-first shape the review round asked for: truncate-then-write (a
		// formatter pass, a checkout, a transient partial write) must not
		// permanently latch a diagnostic as stale once the file is whole again.
		const env = setup();
		const filePath = path.join(env.tmpDir, "transient-shrink.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // 6 addressable lines
		const cache = createLineCountCache();

		const before = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [
				{ line: 5, message: "a real blocking error" } as Diagnostic,
			],
			lineCountCache: cache,
		});
		expect(before.diagnostics[0]?.stale).toBeFalsy();

		// Transient shrink: the file is truncated to fewer lines than the
		// diagnostic cites. Force the mtime forward explicitly — successive
		// writes within one filesystem timestamp tick can otherwise land on the
		// SAME mtime, which would defeat the mtime-keyed cache for reasons
		// unrelated to what this test verifies.
		fs.writeFileSync(filePath, "a\nb\n"); // 3 addressable lines — line 5 now past EOF
		fs.utimesSync(
			filePath,
			new Date(Date.now() + 1000),
			new Date(Date.now() + 1000),
		);
		const shrunk = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: before.diagnostics,
			lineCountCache: cache,
		});
		expect(shrunk.diagnostics[0]?.stale).toBe(true);
		expect(shrunk.demotedCount).toBe(1);

		// The file is restored (formatter/checkout completes) — same content,
		// mtime moves again.
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // back to 6 addressable lines
		fs.utimesSync(
			filePath,
			new Date(Date.now() + 2000),
			new Date(Date.now() + 2000),
		);
		const restored = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: shrunk.diagnostics,
			lineCountCache: cache,
		});
		// RE-ARMED: blocking status is restored, not permanently latched stale.
		expect(restored.diagnostics[0]?.stale).toBeFalsy();
	});

	it("F3: re-arming does not emit a log record or trigger resync (healing is silent)", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "heal-silent.ts");
		fs.writeFileSync(filePath, "a\nb\n"); // 3 addressable lines
		const resync = vi.fn();
		const cache = createLineCountCache();

		fs.writeFileSync(filePath, "a\n"); // shrink — line 3 now past EOF
		fs.utimesSync(
			filePath,
			new Date(Date.now() + 1000),
			new Date(Date.now() + 1000),
		);
		const shrunk = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 3, message: "x" } as Diagnostic],
			lineCountCache: cache,
			resync,
		});
		expect(shrunk.diagnostics[0]?.stale).toBe(true);
		expect(resync).toHaveBeenCalledTimes(1);
		logLatency.mockClear();
		resync.mockClear();

		fs.writeFileSync(filePath, "a\nb\n"); // restore
		fs.utimesSync(
			filePath,
			new Date(Date.now() + 2000),
			new Date(Date.now() + 2000),
		);
		const restored = demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: shrunk.diagnostics,
			lineCountCache: cache,
			resync,
		});
		expect(restored.diagnostics[0]?.stale).toBeFalsy();
		expect(logLatency).not.toHaveBeenCalled();
		expect(resync).not.toHaveBeenCalled();
	});

	it("triggers the caller-supplied resync exactly once when something demotes", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "resync.ts");
		fs.writeFileSync(filePath, "a\nb\n"); // 3 addressable lines
		const resync = vi.fn();

		demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 99, message: "past eof" } as Diagnostic],
			lineCountCache: createLineCountCache(),
			resync,
		});

		expect(resync).toHaveBeenCalledTimes(1);
		expect(resync).toHaveBeenCalledWith(filePath);
	});

	it("does not trigger resync when nothing demotes", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "clean.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // 4 addressable lines
		const resync = vi.fn();

		demotePastEofDiagnostics({
			store: "test",
			cwd: env.tmpDir,
			filePath,
			diagnostics: [{ line: 2, message: "fine" } as Diagnostic],
			lineCountCache: createLineCountCache(),
			resync,
		});

		expect(resync).not.toHaveBeenCalled();
	});

	it("a resync that throws never propagates out of the gate", () => {
		const env = setup();
		const filePath = path.join(env.tmpDir, "resync-throws.ts");
		fs.writeFileSync(filePath, "a\n");
		const resync = vi.fn(() => {
			throw new Error("boom");
		});

		expect(() =>
			demotePastEofDiagnostics({
				store: "test",
				cwd: env.tmpDir,
				filePath,
				diagnostics: [{ line: 5, message: "past eof" } as Diagnostic],
				lineCountCache: createLineCountCache(),
				resync,
			}),
		).not.toThrow();
	});
});

describe("getCachedLineCount cost discipline (#1641)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		_resetSharedLineCountCacheForTests();
	});

	it("a cache hit (matching mtime) returns the MEMOIZED count, not a fresh recount", () => {
		// Deterministic proof of the memo, without depending on a real write's
		// mtime round-tripping through `fs.utimesSync` at full precision (a
		// platform-specific hazard on its own, not what this test is about):
		// seed the pass-scoped cache with a fabricated entry at the file's REAL
		// current mtime but a count that could only come from the cache, then
		// confirm that's what's returned.
		const env = setupTestEnvironment("pi-lens-past-eof-cache-hit-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "cached.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // really 4 addressable lines
		const stat = fs.statSync(filePath);

		const cache = createLineCountCache();
		cache.set(filePath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			lineCount: 999,
		});
		expect(getCachedLineCount(filePath, cache)).toBe(999);
	});

	it("a cache miss (stale mtime in the memo) recounts from the CURRENT disk content", () => {
		const env = setupTestEnvironment("pi-lens-past-eof-cache-miss-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "cached.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\ne\n"); // 6 addressable lines, current

		const cache = createLineCountCache();
		// A memo entry whose mtime does not match the file's real current mtime
		// must be ignored — it belongs to a PRIOR state of this file.
		cache.set(filePath, { mtimeMs: 1, size: 999, lineCount: 999 });
		expect(getCachedLineCount(filePath, cache)).toBe(6);
	});

	it("V1 RED CASE: a cache entry with matching mtime but MISMATCHED size is a MISS, not a hit", () => {
		// The review-round finding: mtime resolution on this host (~1ms) is
		// coarse enough that a truncate-then-write, a formatter write-back, or
		// our own auto-format immediately followed by the agent's write can
		// land two DIFFERENT contents on the IDENTICAL mtimeMs. A cache keyed
		// on mtime alone serves the FIRST content's line count for the SECOND —
		// measured live at 207/300 shrink/restore cycles. Deterministic proof,
		// no real utimesSync round-trip: seed a matching mtime but a size that
		// does not match the file's real current size.
		const env = setupTestEnvironment("pi-lens-past-eof-v1-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "same-tick.ts");
		fs.writeFileSync(filePath, "a\n"); // 1 newline → really 2 addressable lines
		const stat = fs.statSync(filePath);

		const cache = createLineCountCache();
		// Same mtime as the file's real current mtime, but a size that does NOT
		// match — simulating a same-millisecond write that changed content
		// (and therefore size) without moving mtime forward at this host's
		// resolution. A HIT here would silently serve the WRONG count.
		cache.set(filePath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size + 1,
			lineCount: 999,
		});
		expect(getCachedLineCount(filePath, cache)).toBe(2); // recomputed, not 999
	});

	it("an isolated cache from a fresh test never inherits a prior one's entries", () => {
		const env = setupTestEnvironment("pi-lens-past-eof-cache-fresh-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "pass.ts");
		fs.writeFileSync(filePath, "a\nb\nc\nd\n"); // 5 addressable lines

		const firstCache = createLineCountCache();
		expect(getCachedLineCount(filePath, firstCache)).toBe(5);

		const secondCache = createLineCountCache();
		expect(secondCache.size).toBe(0);
		expect(getCachedLineCount(filePath, secondCache)).toBe(5);
	});

	it("F2: the DEFAULT (shared) cache is genuinely shared across separate calls, not re-created per call", () => {
		// The actual perf fix: without a call-spanning cache, every serving
		// call re-reads every cited file in full — measured at 35.68ms/call
		// across 40 files in the review round. Seed the shared cache
		// deterministically (see `_seedSharedLineCountCacheForTests`'s doc
		// comment for why this avoids a real mtime round-trip) with a count
		// that could only be returned by a HIT, at the file's real current
		// mtime, then confirm a plain call with no `cache` argument returns it.
		const env = setupTestEnvironment("pi-lens-past-eof-shared-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "shared.ts");
		fs.writeFileSync(filePath, "a\nb\nc\n"); // really 4 addressable lines
		const stat = fs.statSync(filePath);

		_seedSharedLineCountCacheForTests(filePath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			lineCount: 999,
		});
		expect(getCachedLineCount(filePath)).toBe(999);
	});

	it("F2: the shared cache still re-arms on a genuine mtime change", () => {
		const env = setupTestEnvironment("pi-lens-past-eof-shared-rearm-");
		cleanups.push(env.cleanup);
		const filePath = path.join(env.tmpDir, "shared-rearm.ts");
		fs.writeFileSync(filePath, "a\nb\n"); // 3 addressable lines
		expect(getCachedLineCount(filePath)).toBe(3);

		const bumped = new Date(Date.now() + 5000);
		fs.writeFileSync(filePath, "a\nb\nc\nd\n"); // 5 addressable lines
		fs.utimesSync(filePath, bumped, bumped);
		expect(getCachedLineCount(filePath)).toBe(5);
	});
});
