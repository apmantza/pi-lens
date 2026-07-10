/**
 * Tests for clients/recent-touches.ts (#492) — the cross-process
 * touched-files record: read/write atomicity, ring-buffer cap, self-pid
 * exclusion, freshness/existence filtering for the child session_start
 * consumer, mtime-gated hot path + dedup cursor for the parent turn_start
 * consumer, cross-form path handling, and the kill switch.
 *
 * `getProjectDataDir` is mocked to point at a per-test temp dir so these
 * tests never touch a real project's `.pi-lens`/`~/.pi-lens/projects` state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
const FAKE_CWD = "/fake/project";

vi.mock("../../clients/file-utils.js", () => ({
	getProjectDataDir: () => dir,
}));

function recordFilePath(): string {
	return path.join(dir, "recent-touches.json");
}

describe("recent-touches (#492 cross-process touched-files record)", () => {
	const originalEnv = process.env.PI_LENS_AGENT_NUDGE;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-recenttouches-"));
		vi.resetModules();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_AGENT_NUDGE;
		} else {
			process.env.PI_LENS_AGENT_NUDGE = originalEnv;
		}
	});

	it("appendRecentTouches creates the record with this process's pid", async () => {
		const { appendRecentTouches } = await import(
			"../../clients/recent-touches.js"
		);
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
		const { appendRecentTouches } = await import(
			"../../clients/recent-touches.js"
		);
		await appendRecentTouches({
			cwd: FAKE_CWD,
			reason: "format",
			paths: ["/fake/project/b.ts"],
		});

		const entries = fs.readdirSync(dir);
		expect(entries).toContain("recent-touches.json");
		expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
	});

	it("ring buffer caps at RECENT_TOUCHES_MAX_ENTRIES, dropping oldest first", async () => {
		const { appendRecentTouches, RECENT_TOUCHES_MAX_ENTRIES } = await import(
			"../../clients/recent-touches.js"
		);
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

		const { appendRecentTouches } = await import(
			"../../clients/recent-touches.js"
		);
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

	it("missing record file on first read does not throw", async () => {
		const { readCrossProcessTouchesForSessionStart } = await import(
			"../../clients/recent-touches.js"
		);
		expect(fs.existsSync(recordFilePath())).toBe(false);
		await expect(
			readCrossProcessTouchesForSessionStart({ cwd: FAKE_CWD }),
		).resolves.toEqual([]);
	});

	describe("child at session_start", () => {
		it("excludes entries from this process's own pid (self-exclusion)", async () => {
			const {
				appendRecentTouches,
				readCrossProcessTouchesForSessionStart,
			} = await import("../../clients/recent-touches.js");
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
			const { readCrossProcessTouchesForSessionStart } = await import(
				"../../clients/recent-touches.js"
			);
			// Simulate a write from a different pid by writing the file directly
			// (appendRecentTouches always stamps process.pid).
			fs.writeFileSync(
				recordFilePath(),
				JSON.stringify({
					entries: [
						{ path: __filename, reason: "autofix", ts: Date.now(), pid: 999999 },
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
			const { readCrossProcessTouchesForSessionStart } = await import(
				"../../clients/recent-touches.js"
			);
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
			const { readCrossProcessTouchesForSessionStart } = await import(
				"../../clients/recent-touches.js"
			);
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
			const { readCrossProcessTouchesForSessionStart } = await import(
				"../../clients/recent-touches.js"
			);
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
			const { readCrossProcessTouchesForTurnStart } = await import(
				"../../clients/recent-touches.js"
			);
			await expect(
				readCrossProcessTouchesForTurnStart({ cwd: FAKE_CWD }),
			).resolves.toEqual([]);
		});

		it("surfaces a foreign pid's entry on first read after the file appears", async () => {
			const { readCrossProcessTouchesForTurnStart } = await import(
				"../../clients/recent-touches.js"
			);
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
			const { readCrossProcessTouchesForTurnStart } = await import(
				"../../clients/recent-touches.js"
			);
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

		it("a new append after a prior consume only surfaces the NEW entry (cursor dedup, not full re-read)", async () => {
			const { readCrossProcessTouchesForTurnStart } = await import(
				"../../clients/recent-touches.js"
			);
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
			const { readCrossProcessTouchesForTurnStart } = await import(
				"../../clients/recent-touches.js"
			);
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
