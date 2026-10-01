/**
 * Tests for the SHARED-SLOT half of scripts/lib/suite-lock.mjs (#2435).
 *
 * The exclusive lock (#1101) is covered by suite-lock.test.ts; this file
 * pins only the slot arithmetic the shared mode adds, because that
 * arithmetic is what decides whether a full `npm test` can end up sharing
 * the box with targeted runs — the exact condition #2435 blames for 27-69
 * unreproducible timeout failures per local full run.
 *
 * Three properties are load-bearing and each has its own case:
 *   1. an EXCLUSIVE acquisition waits until every shared slot has drained;
 *   2. a SHARED acquisition waits while the exclusive lock is held;
 *   3. a slot whose recorded PID is dead is reclaimed immediately.
 * Plus the one failure mode that would poison the machine lock forever: an
 * exclusive holder whose drain times out must not leave its lock file
 * behind.
 *
 * All paths are under `fs.mkdtemp()` with short poll intervals — never the
 * real `~/.pi-lens`, and no environment variable is read or written.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SHARED_SLOTS,
	MAX_SHARED_SLOTS,
	acquireSharedSlot,
	acquireTestLock,
	getSlotPath,
	resolveSharedSlots,
} from "../../scripts/lib/suite-lock.mjs";

let tmpDir: string;
let lockPath: string;

const FAST = { pollIntervalMs: 10, heartbeatIntervalMs: 10_000 } as const;
// A PID this large cannot exist on any real system, so a lock body carrying
// it is unambiguously stale.
const DEAD_PID = 999_999_999;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-shared-slot-"));
	lockPath = path.join(tmpDir, "test-suite.lock");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLock = (file: string, pid: number) =>
	fs.writeFileSync(
		file,
		JSON.stringify({ pid, startedIso: new Date().toISOString() }),
	);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("getSlotPath", () => {
	it("derives slot files from the exclusive lock path", () => {
		expect(getSlotPath(lockPath, 0)).toBe(
			path.join(tmpDir, "test-suite.slot-0.lock"),
		);
		expect(getSlotPath(lockPath, 3)).toBe(
			path.join(tmpDir, "test-suite.slot-3.lock"),
		);
	});

	it("follows a redirected lock directory instead of reading the env again", () => {
		// Single source of truth for the lock directory: a test (or a
		// PI_LENS_HOME override) that redirects lockPath must redirect the
		// slots with it, or a test run would contend with a developer's real
		// slots.
		const other = path.join(tmpDir, "nested", "suite.lock");
		expect(path.dirname(getSlotPath(other, 1))).toBe(path.dirname(other));
	});
});

describe("resolveSharedSlots", () => {
	it("defaults garbage, zero and negatives to the default rather than to 0", () => {
		// 0 slots would mean "a shared run can never acquire" — a silent hang.
		for (const raw of [undefined, null, "", "abc", Number.NaN, 0, -3]) {
			expect(resolveSharedSlots(raw)).toBe(DEFAULT_SHARED_SLOTS);
		}
	});

	it("accepts an explicit count and clamps an absurd one", () => {
		expect(resolveSharedSlots(3)).toBe(3);
		expect(resolveSharedSlots("4")).toBe(4);
		expect(resolveSharedSlots(10_000)).toBe(32);
	});
});

describe("acquireSharedSlot — slot occupancy", () => {
	it("takes the first free slot and releases it", async () => {
		const slot = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		expect(slot.slotIndex).toBe(0);
		expect(fs.existsSync(getSlotPath(lockPath, 0))).toBe(true);
		expect(JSON.parse(fs.readFileSync(slot.slotPath, "utf8")).pid).toBe(
			process.pid,
		);

		await slot.release();
		expect(fs.existsSync(getSlotPath(lockPath, 0))).toBe(false);
	});

	it("hands concurrent acquisitions DISTINCT slots up to the ceiling", async () => {
		const first = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		const second = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		try {
			expect([first.slotIndex, second.slotIndex].sort()).toEqual([0, 1]);
		} finally {
			await first.release();
			await second.release();
		}
	});

	it("waits (and times out legibly) once every slot is busy", async () => {
		const first = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		const second = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		try {
			await expect(
				acquireSharedSlot({ lockPath, slots: 2, ...FAST, timeoutMs: 50 }),
			).rejects.toThrow(
				// The prefix is pinned: pre-push-targeted-tests.mjs greps a
				// caller's stderr for it to tell a lock timeout (push proceeds)
				// from a real test failure (push blocks).
				/timed out after 50ms waiting for test-suite lock: all 2 shared slot\(s\) busy/,
			);
		} finally {
			await first.release();
			await second.release();
		}
	});

	it("reclaims a slot whose recorded PID is dead, with no age wait", async () => {
		writeLock(getSlotPath(lockPath, 0), DEAD_PID);
		const slot = await acquireSharedSlot({ lockPath, slots: 1, ...FAST });
		try {
			expect(slot.slotIndex).toBe(0);
			expect(JSON.parse(fs.readFileSync(slot.slotPath, "utf8")).pid).toBe(
				process.pid,
			);
		} finally {
			await slot.release();
		}
	});
});

describe("shared vs exclusive", () => {
	it("a shared acquisition waits while the exclusive lock is held", async () => {
		const exclusive = await acquireTestLock({ lockPath, slots: 2, ...FAST });
		try {
			await expect(
				acquireSharedSlot({ lockPath, slots: 2, ...FAST, timeoutMs: 50 }),
			).rejects.toThrow(
				/timed out after 50ms waiting for test-suite lock: exclusive test-suite lock held by PID \d+/,
			);
			// And it must not have left a slot file behind while backing off.
			expect(fs.existsSync(getSlotPath(lockPath, 0))).toBe(false);
			expect(fs.existsSync(getSlotPath(lockPath, 1))).toBe(false);
		} finally {
			await exclusive.release();
		}
	});

	it("an exclusive acquisition waits until every shared slot drains", async () => {
		const shared = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		const events: string[] = [];

		let exclusiveHandle: { release: () => Promise<void> } | null = null;
		const exclusivePromise = acquireTestLock({
			lockPath,
			slots: 2,
			...FAST,
		}).then((handle) => {
			events.push("exclusive-acquired");
			exclusiveHandle = handle;
			return handle;
		});

		// Long enough for many poll cycles at 10ms: if the drain were missing,
		// the exclusive acquisition would already have resolved here.
		await sleep(120);
		expect(events).toEqual([]);

		events.push("shared-released");
		await shared.release();

		await exclusivePromise;
		expect(events).toEqual(["shared-released", "exclusive-acquired"]);
		await exclusiveHandle!.release();
	});

	// #3839 review F1 recurrence: the exclusive drain scanned only the slots ITS
	// env resolved (default 2), so a shared run started with `--shared=3` (or
	// PI_LENS_TEST_SHARED_SLOTS=3) in slot 2 was never inspected and a full suite
	// ran beside it. The drain must cover every slot an acquirer can take.
	it("an exclusive acquisition waits for a shared holder in a slot above its own slot count", async () => {
		const held = [
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
		];
		expect(held.map((slot) => slot.slotIndex)).toEqual([0, 1, 2]);
		await held[0].release();
		await held[1].release();
		try {
			await expect(
				acquireTestLock({ lockPath, slots: 2, ...FAST, timeoutMs: 100 }),
			).rejects.toThrow(
				/timed out after 100ms waiting for test-suite lock: 1 of \d+ shared slot\(s\) still busy/,
			);
		} finally {
			await held[2].release();
		}
	});

	it("the exclusive drain covers the last slot an acquirer can take", async () => {
		// resolveSharedSlots clamps to MAX_SHARED_SLOTS, so index MAX - 1 is the
		// highest slot file that can exist; an off-by-one in the scan bound
		// would miss exactly it.
		writeLock(getSlotPath(lockPath, MAX_SHARED_SLOTS - 1), process.pid);
		await expect(
			acquireTestLock({ lockPath, slots: 2, ...FAST, timeoutMs: 100 }),
		).rejects.toThrow(/1 of \d+ shared slot\(s\) still busy/);
	});

	it("reports a denominator that covers every busy slot when more are held than its own count", async () => {
		const held = [
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
			await acquireSharedSlot({ lockPath, slots: 3, ...FAST }),
		];
		try {
			await expect(
				acquireTestLock({ lockPath, slots: 2, ...FAST, timeoutMs: 100 }),
			).rejects.toThrow(/3 of 3 shared slot\(s\) still busy/);
		} finally {
			for (const slot of held) await slot.release();
		}
	});

	it("an exclusive acquisition drains a slot whose PID is dead without waiting", async () => {
		writeLock(getSlotPath(lockPath, 1), DEAD_PID);
		const exclusive = await acquireTestLock({
			lockPath,
			slots: 2,
			...FAST,
			timeoutMs: 2_000,
		});
		try {
			expect(fs.existsSync(getSlotPath(lockPath, 1))).toBe(false);
		} finally {
			await exclusive.release();
		}
	});

	it("releases the exclusive lock file when the drain times out", async () => {
		// Without this, a timed-out full run leaves a lock file owned by a
		// still-LIVE pid — which the #1101 policy never ages out — and every
		// later run on the machine waits forever on a holder that gave up.
		const shared = await acquireSharedSlot({ lockPath, slots: 2, ...FAST });
		try {
			await expect(
				acquireTestLock({ lockPath, slots: 2, ...FAST, timeoutMs: 50 }),
			).rejects.toThrow(
				/timed out after 50ms waiting for test-suite lock: 1 of 2 shared slot\(s\) still busy/,
			);
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			await shared.release();
		}
	});

	it("leaves the pre-#2435 exclusive path unchanged when no slots are in use", async () => {
		const lock = await acquireTestLock({ lockPath, ...FAST });
		expect(fs.existsSync(lockPath)).toBe(true);
		await lock.release();
		expect(fs.existsSync(lockPath)).toBe(false);
		// No slot files are created as a side effect of an exclusive run.
		// Checked per-slot rather than by listing the directory: a readdir +
		// `toEqual([])` pair reads as a population sweep to
		// tests/config/sweep-floor-coverage.test.ts's meta-sweep, and this is
		// a two-slot existence check, not a sweep.
		expect(fs.existsSync(getSlotPath(lockPath, 0))).toBe(false);
		expect(fs.existsSync(getSlotPath(lockPath, 1))).toBe(false);
	});
});
