/**
 * Tests for clients/recent-touches.ts (#492) — the cross-process
 * touched-files record: read/write atomicity, ring-buffer cap, self-pid
 * exclusion, freshness/existence filtering for the child session_start
 * consumer, mtime-gated hot path + dedup cursor for the parent turn_start
 * consumer, cross-form path handling, and the kill switch.
 *
 * `PILENS_DATA_DIR` is pinned to a per-test temp dir so these tests never
 * touch a real project's `.pi-lens`/`~/.pi-lens/projects` state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetProjectDataDirMemoForTests,
	getProjectDataDir,
} from "../../clients/file-utils.js";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;
const FAKE_CWD = "/fake/project";

function recordFilePath(): string {
	const dataDir = getProjectDataDir(FAKE_CWD);
	// The real resolver names the dir; production creates it on first write,
	// so a case that seeds the record by hand creates it here.
	fs.mkdirSync(dataDir, { recursive: true });
	return path.join(dataDir, "recent-touches.json");
}

interface StoredTouch {
	path: string;
	reason: string;
	ts: number;
	pid: number;
	sessionId?: string;
}

/** Read the record straight off disk, as an outside process would see it. */
function readRecordEntries(): StoredTouch[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(recordFilePath(), "utf-8"));
		return Array.isArray(parsed?.entries)
			? (parsed.entries as StoredTouch[])
			: [];
	} catch {
		return [];
	}
}

describe("recent-touches (#492 cross-process touched-files record)", () => {
	const originalEnv = process.env.PI_LENS_AGENT_NUDGE;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-recenttouches-"));
		// The production knob for the data base; the memo is keyed on it, and
		// is cleared so no earlier case's settled dir answers for this one.
		vi.stubEnv("PILENS_DATA_DIR", dir);
		_resetProjectDataDirMemoForTests();
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		_resetProjectDataDirMemoForTests();
		removeTempDirSync(dir);
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_AGENT_NUDGE;
		} else {
			process.env.PI_LENS_AGENT_NUDGE = originalEnv;
		}
	});

	it("appendRecentTouches creates the record with this process's pid", async () => {
		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");
		await appendRecentTouches({
			cwd: FAKE_CWD,
			reason: "autofix",
			paths: ["/fake/project/a.ts"],
		});

		const parsed = JSON.parse(fs.readFileSync(recordFilePath(), "utf-8"));
		expect(parsed.entries).toHaveLength(1);
		expect(parsed.entries[0].pid).toBe(process.pid);
		expect(parsed.entries[0].reason).toBe("autofix");
		expect(parsed.entries[0].path).toContain("a.ts");
	});

	it("writes atomically via tmp-<pid> + rename (no tmp file left behind)", async () => {
		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");
		await appendRecentTouches({
			cwd: FAKE_CWD,
			reason: "format",
			paths: ["/fake/project/b.ts"],
		});

		const entries = fs.readdirSync(getProjectDataDir(FAKE_CWD));
		expect(entries).toContain("recent-touches.json");
		expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
	});

	it("ring buffer caps at RECENT_TOUCHES_MAX_ENTRIES, dropping oldest first", async () => {
		const { appendRecentTouches, RECENT_TOUCHES_MAX_ENTRIES } =
			await import("../../clients/recent-touches.js");
		for (let i = 0; i < RECENT_TOUCHES_MAX_ENTRIES + 10; i++) {
			await appendRecentTouches({
				cwd: FAKE_CWD,
				reason: "autofix",
				paths: [`/fake/project/f${i}.ts`],
			});
		}

		const parsed = JSON.parse(fs.readFileSync(recordFilePath(), "utf-8"));
		expect(parsed.entries).toHaveLength(RECENT_TOUCHES_MAX_ENTRIES);
		// Oldest 10 (f0..f9) dropped; newest survive.
		const paths = parsed.entries.map((e: { path: string }) => e.path);
		expect(paths.some((p: string) => p.includes("f0.ts"))).toBe(false);
		expect(
			paths.some((p: string) =>
				p.includes(`f${RECENT_TOUCHES_MAX_ENTRIES + 9}.ts`),
			),
		).toBe(true);
	});

	it("corrupt JSON in the record is treated as empty, never throws", async () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(recordFilePath(), "{not valid json!!", "utf-8");

		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");
		await expect(
			appendRecentTouches({
				cwd: FAKE_CWD,
				reason: "autofix",
				paths: ["/fake/project/recovered.ts"],
			}),
		).resolves.not.toThrow();

		const parsed = JSON.parse(fs.readFileSync(recordFilePath(), "utf-8"));
		expect(parsed.entries).toHaveLength(1);
	});

	// #5377: the append was an unlocked async read-modify-write, so two
	// publishes in one tick each computed the whole file from the same
	// snapshot and the later rename published state without the earlier
	// entry (the state-machine census lost an entry in 5 of 5 runs on
	// master). RED FIRST on master: this drives the REAL producer seam
	// (`publishFilesTouched`, clients/bus-publish.ts) over real files, with no
	// mock of the store, the lock, or the filesystem.
	it("keeps every entry when four publishes land in one tick", async () => {
		const { publishFilesTouched } =
			await import("../../clients/bus-publish.js");
		const touched: { path: string; reason: "format" | "autofix" }[] = [
			"a.ts",
			"b.ts",
			"c.ts",
			"d.ts",
		].map((name, i) => {
			const p = path.join(dir, name);
			fs.writeFileSync(p, "// touched", "utf-8");
			return { path: p, reason: i % 2 === 0 ? "format" : "autofix" };
		});
		// One tick: every publish is issued before the first append can settle.
		for (const t of touched) {
			publishFilesTouched({
				cwd: FAKE_CWD,
				reason: t.reason,
				paths: [t.path],
				sessionId: "s-5377",
			});
		}

		// The publish is fire-and-forget, so join the record on a real-clock
		// deadline (shape 86: the wait ends on a deadline, never on a turn count).
		const deadline = Date.now() + 2_000;
		let entries = readRecordEntries();
		while (entries.length < touched.length && Date.now() < deadline) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			entries = readRecordEntries();
		}

		expect(
			entries.map((e) => `${path.basename(e.path)}:${e.reason}`).sort(),
		).toEqual(["a.ts:format", "b.ts:autofix", "c.ts:format", "d.ts:autofix"]);
	});

	// The fold onto `clients/durable-store.ts` (#5377) must keep the on-disk
	// shape readable both ways: a record written by a master build is still
	// parsed by the locked commit, and its pre-existing entries survive the
	// append (an old writer's record is a normal merge input, not a reset).
	it("merges onto a record written by the pre-#5377 writer", async () => {
		const legacyTs = Date.now() - 1000;
		fs.writeFileSync(
			recordFilePath(),
			JSON.stringify({
				entries: [
					{
						path: "/fake/project/legacy.ts",
						reason: "autofix",
						ts: legacyTs,
						pid: 999999,
					},
				],
			}),
			"utf-8",
		);

		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");
		await appendRecentTouches({
			cwd: FAKE_CWD,
			reason: "format",
			paths: ["/fake/project/newer.ts"],
			sessionId: "s-5377",
		});

		const entries = readRecordEntries();
		expect(entries.map((e) => path.basename(e.path))).toEqual([
			"legacy.ts",
			"newer.ts",
		]);
		expect(entries[0]).toMatchObject({
			pid: 999999,
			reason: "autofix",
			ts: legacyTs,
		});
		expect(entries[1]).toMatchObject({ pid: process.pid, reason: "format" });
	});

	// The record's ONE parse (#5377) is also the locked commit's `deserialize`,
	// so a body that parses but has no `entries` array must still read as an
	// empty record: the merge spreads `disk.entries`, and a non-array there
	// throws inside the lock instead of appending.
	it("treats a record body without an entries array as empty", async () => {
		fs.writeFileSync(
			recordFilePath(),
			JSON.stringify({ version: 2, entries: { not: "an array" } }),
			"utf-8",
		);

		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");
		await appendRecentTouches({
			cwd: FAKE_CWD,
			reason: "format",
			paths: ["/fake/project/recovered.ts"],
		});

		expect(readRecordEntries().map((e) => path.basename(e.path))).toEqual([
			"recovered.ts",
		]);
	});

	// #5377's failure policy: the seam publishes through a THROWING atomic
	// write, so a commit that cannot finish surfaces as a rejection with the
	// lock's own timeout reason instead of a silent lost append. The lock path
	// is occupied by a regular file, so `mkdir` answers EEXIST and the owner
	// probe cannot date the holder, which leaves it live: the append waits out
	// RECENT_TOUCHES_LOCK_WAIT_MS and rejects.
	it("rejects with the lock timeout when the record lock cannot be taken", async () => {
		fs.writeFileSync(
			`${recordFilePath()}.lock`,
			"not a lock directory",
			"utf-8",
		);

		const { appendRecentTouches } =
			await import("../../clients/recent-touches.js");

		await expect(
			appendRecentTouches({
				cwd: FAKE_CWD,
				reason: "format",
				paths: ["/fake/project/held.ts"],
			}),
		).rejects.toThrow("Timed out waiting for recent-touches record lock");
		expect(fs.existsSync(recordFilePath())).toBe(false);
	});

	it("missing record file on first read does not throw", async () => {
		const { readCrossProcessTouchesForSessionStart } =
			await import("../../clients/recent-touches.js");
		expect(fs.existsSync(recordFilePath())).toBe(false);
		await expect(
			readCrossProcessTouchesForSessionStart({ cwd: FAKE_CWD }),
		).resolves.toEqual([]);
	});

	describe("child at session_start", () => {
		it("excludes entries from this process's own pid (self-exclusion)", async () => {
			const { appendRecentTouches, readCrossProcessTouchesForSessionStart } =
				await import("../../clients/recent-touches.js");
			// Own pid write.
			await appendRecentTouches({
				cwd: FAKE_CWD,
				reason: "autofix",
				paths: [__filename],
			});

			const seen = await readCrossProcessTouchesForSessionStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toEqual([]);
		});

		it("surfaces a foreign pid's fresh entry whose file exists", async () => {
			const { readCrossProcessTouchesForSessionStart } =
				await import("../../clients/recent-touches.js");
			// Simulate a write from a different pid by writing the file directly
			// (appendRecentTouches always stamps process.pid).
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							path: __filename,
							reason: "autofix",
							ts: Date.now(),
							pid: 999999,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForSessionStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toHaveLength(1);
			expect(seen[0].pid).toBe(999999);
		});

		it("drops entries older than the freshness window", async () => {
			const { readCrossProcessTouchesForSessionStart } =
				await import("../../clients/recent-touches.js");
			const now = Date.now();
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							path: __filename,
							reason: "autofix",
							ts: now - 16 * 60 * 1000, // 16 minutes ago — stale
							pid: 999999,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForSessionStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
				now,
			});
			expect(seen).toEqual([]);
		});

		it("drops entries whose file no longer exists on disk", async () => {
			const { readCrossProcessTouchesForSessionStart } =
				await import("../../clients/recent-touches.js");
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							path: "/fake/project/definitely-does-not-exist-492.ts",
							reason: "autofix",
							ts: Date.now(),
							pid: 999999,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForSessionStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toEqual([]);
		});

		it("cross-form paths: an alternate-but-genuine alias of the same file still passes the existsSync probe", async () => {
			const { readCrossProcessTouchesForSessionStart } =
				await import("../../clients/recent-touches.js");
			// __filename is the real absolute path to this test file. Record it in
			// an alternate form that is a GENUINE alias of the same file ON THIS
			// PLATFORM (the #491 postmortem rule: cross-form tests must only use
			// forms that actually alias on the platform they run on):
			//   - win32: backslash-separated (as a Windows Read-tool-originated
			//     path would arrive) — a true alias only where drive-letter paths
			//     exist; a backslashed POSIX path is NOT the same file on Linux,
			//     which is exactly the trap that turned CI red.
			//   - POSIX: redundant separators + a `.` segment (`/dir//./file`) —
			//     the kernel resolves these to the same inode.
			const aliasForm =
				process.platform === "win32"
					? __filename.replace(/\//g, "\\")
					: `${path.dirname(__filename)}//./${path.basename(__filename)}`;
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							path: aliasForm,
							reason: "format",
							ts: Date.now(),
							pid: 999999,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForSessionStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toHaveLength(1);
		});
	});

	describe("parent at turn_start (mtime-gated hot path)", () => {
		it("returns [] with no record file yet (no stat throw)", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			await expect(
				readCrossProcessTouchesForTurnStart({ cwd: FAKE_CWD }),
			).resolves.toEqual([]);
		});

		it("surfaces a foreign pid's entry on first read after the file appears", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: __filename, reason: "autofix", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toHaveLength(1);
			expect(seen[0].pid).toBe(777);
		});

		it("second read with unchanged mtime returns [] without re-parsing (dedup)", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: __filename, reason: "autofix", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);

			const first = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(first).toHaveLength(1);

			// No new write — mtime unchanged — must not re-surface the same entry.
			const second = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(second).toEqual([]);
		});

		// #2300: a same-mtime-bucket rewrite (coarse filesystem mtime
		// granularity; #2287 N1) that changes the file's byte length must not
		// be masked by the mtime-only equality memo. Varies SIZE, never
		// same-length content, and never a real timing race — the mtime is
		// forced back with `utimesSync` so the test is deterministic.
		it("a same-mtime-bucket rewrite with a different size is not dropped by the mtime-only memo", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			const firstFile = path.join(dir, "first.ts");
			const secondFile = path.join(dir, "second.ts");
			fs.writeFileSync(firstFile, "// first", "utf-8");
			fs.writeFileSync(secondFile, "// second", "utf-8");

			// Pin the mtime up front so the rewrite below can be forced back to
			// it. The pinned value is read BACK before it is asserted on:
			// `mtimeMs` is derived from a nanosecond timestamp, so a whole-ms
			// Date can come back as e.g. 1787865854006.999 on ext4. Only the
			// round-tripped value is stable across two identical `utimesSync`
			// calls, and it is what the memo actually caches.
			const pinnedMtimeMs = Date.now();
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: firstFile, reason: "autofix", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);
			fs.utimesSync(
				recordFilePath(),
				new Date(pinnedMtimeMs),
				new Date(pinnedMtimeMs),
			);
			const observedMtimeMs = fs.statSync(recordFilePath()).mtimeMs;
			const first = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(first).toHaveLength(1);

			// Real gap so the second entry's `ts` is strictly newer than the
			// cursor advanced by the first read (avoids a same-millisecond tie).
			await new Promise((r) => setTimeout(r, 5));

			// A second, strictly LONGER JSON body (an extra entry) forced back to
			// the SAME mtime the memo already saw. A mtime-only memo would treat
			// this as "nothing new" and drop the second entry.
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: firstFile, reason: "autofix", ts: Date.now(), pid: 777 },
						{ path: secondFile, reason: "format", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);
			fs.utimesSync(
				recordFilePath(),
				new Date(pinnedMtimeMs),
				new Date(pinnedMtimeMs),
			);
			expect(fs.statSync(recordFilePath()).mtimeMs).toBe(observedMtimeMs);

			const second = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(second.some((e) => e.path.includes("second.ts"))).toBe(true);
		});

		it("a new append after a prior consume only surfaces the NEW entry (cursor dedup, not full re-read)", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			// Real files on disk — the turn_start reader applies the shared
			// existence filter, so fabricated paths would be (correctly) dropped.
			const firstFile = path.join(dir, "first.ts");
			const secondFile = path.join(dir, "second.ts");
			fs.writeFileSync(firstFile, "// first", "utf-8");
			fs.writeFileSync(secondFile, "// second", "utf-8");

			const t0 = Date.now();
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [{ path: firstFile, reason: "autofix", ts: t0, pid: 777 }],
				}),
				"utf-8",
			);
			const first = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(first).toHaveLength(1);

			// Append a second entry — full read-modify-write, so mtime changes and
			// the whole file is re-read, but the cursor must suppress the already-
			// consumed first entry.
			await new Promise((r) => setTimeout(r, 5));
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: firstFile, reason: "autofix", ts: t0, pid: 777 },
						{ path: secondFile, reason: "format", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);
			const second = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(second).toHaveLength(1);
			expect(second[0].path).toContain("second.ts");
		});

		it("regression (#492 review): first turn_start of a fresh process drops stale and deleted-file entries, surfaces only the fresh existing one", async () => {
			const {
				readCrossProcessTouchesForTurnStart,
				_resetRecentTouchesForTests,
			} = await import("../../clients/recent-touches.js");
			// Model a brand-new process: unset mtime watermark, cursor 0 — the
			// exact state where the original implementation surfaced EVERY foreign
			// entry in the record, however old, existing or not.
			_resetRecentTouchesForTests();

			const freshFile = path.join(dir, "fresh.ts");
			fs.writeFileSync(freshFile, "// fresh", "utf-8");
			const now = Date.now();
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							// Days old — the ring buffer caps count, not age; without a
							// freshness filter this would nudge about an ancient touch.
							path: freshFile,
							reason: "autofix",
							ts: now - 3 * 24 * 60 * 60 * 1000,
							pid: 777,
						},
						{
							// Fresh, but the file no longer exists on disk.
							path: path.join(dir, "deleted-since.ts"),
							reason: "format",
							ts: now - 1000,
							pid: 777,
						},
						{
							// Fresh AND existing — the only one that should surface.
							path: freshFile,
							reason: "format",
							ts: now - 2000,
							pid: 777,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
				now,
			});
			expect(seen).toHaveLength(1);
			expect(seen[0].path).toBe(freshFile);
			expect(seen[0].reason).toBe("format");
			expect(seen[0].ts).toBe(now - 2000);
		});

		it("excludes entries from this process's own pid (self-exclusion)", async () => {
			const { readCrossProcessTouchesForTurnStart } =
				await import("../../clients/recent-touches.js");
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{
							path: "/fake/project/own.ts",
							reason: "autofix",
							ts: Date.now(),
							pid: process.pid,
						},
					],
				}),
				"utf-8",
			);

			const seen = await readCrossProcessTouchesForTurnStart({
				cwd: FAKE_CWD,
				selfPid: process.pid,
			});
			expect(seen).toEqual([]);
		});
	});

	describe("kill switch (PI_LENS_AGENT_NUDGE=0)", () => {
		it("disables the producer: appendRecentTouches becomes a no-op", async () => {
			process.env.PI_LENS_AGENT_NUDGE = "0";
			const { appendRecentTouches, _resetRecentTouchesForTests } =
				await import("../../clients/recent-touches.js");
			_resetRecentTouchesForTests();

			await appendRecentTouches({
				cwd: FAKE_CWD,
				reason: "autofix",
				paths: ["/fake/project/a.ts"],
			});

			expect(fs.existsSync(recordFilePath())).toBe(false);
		});

		it("disables both consumers", async () => {
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: __filename, reason: "autofix", ts: Date.now(), pid: 777 },
					],
				}),
				"utf-8",
			);
			process.env.PI_LENS_AGENT_NUDGE = "0";
			const {
				readCrossProcessTouchesForSessionStart,
				readCrossProcessTouchesForTurnStart,
				_resetRecentTouchesForTests,
			} = await import("../../clients/recent-touches.js");
			_resetRecentTouchesForTests();

			await expect(
				readCrossProcessTouchesForSessionStart({
					cwd: FAKE_CWD,
					selfPid: process.pid,
				}),
			).resolves.toEqual([]);
			await expect(
				readCrossProcessTouchesForTurnStart({
					cwd: FAKE_CWD,
					selfPid: process.pid,
				}),
			).resolves.toEqual([]);
		});
	});
});
