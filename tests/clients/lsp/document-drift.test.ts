/**
 * #1783 — DocumentDriftTracker: the drift key, the confirmation read, the
 * pacing and the rate limit.
 *
 * The key pairs mtime with size (catalog shape 6). Both halves get their own
 * seeded-collision test: an edit that keeps the size, and an edit that keeps
 * the mtime. Deleting either half of the key reds one of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	DocumentDriftTracker,
	DRIFT_RESYNC_BATCH,
	DRIFT_TRACK_CAP,
	driftCheckIntervalMs,
} from "../../../clients/lsp/document-drift.js";

const SYNCED_AT = 1_000_000;

/** Fake-filesystem keys must match the tracker's own normalized map keys. */
const k = (p: string) => normalizeMapKey(p);

interface FakeFile {
	content: string;
	mtimeMs: number;
}

function makeDeps(files: Map<string, FakeFile>, now: () => number) {
	const resynced: Array<{ filePath: string; content: string }> = [];
	const events: Array<{
		filePath: string;
		disposition: string;
		driftAgeMs: number;
	}> = [];
	return {
		resynced,
		events,
		deps: {
			now,
			resync: async (filePath: string, content: string) => {
				resynced.push({ filePath, content });
				return true;
			},
			onDrift: (event: {
				filePath: string;
				disposition: string;
				driftAgeMs: number;
			}) => {
				events.push({
					filePath: event.filePath,
					disposition: event.disposition,
					driftAgeMs: event.driftAgeMs,
				});
			},
			stat: async (filePath: string) => {
				const file = files.get(filePath);
				if (!file) throw new Error("ENOENT");
				return {
					size: Buffer.byteLength(file.content, "utf8"),
					mtimeMs: file.mtimeMs,
				};
			},
			read: async (filePath: string) => {
				const file = files.get(filePath);
				if (!file) throw new Error("ENOENT");
				return file.content;
			},
		},
	};
}

describe("DocumentDriftTracker (#1783)", () => {
	let clock = SYNCED_AT;
	const now = () => clock;

	beforeEach(() => {
		clock = SYNCED_AT;
	});

	afterEach(() => {
		delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
		vi.restoreAllMocks();
	});

	it("resyncs a same-SIZE edit — the size half alone would miss it", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/a.ts"), { content: "const a = 1;\n", mtimeMs: SYNCED_AT - 10 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/a.ts"), "const a = 1;\n", SYNCED_AT);

		// Same byte length, different bytes, mtime bumped: only the mtime half
		// of the key can see this.
		files.set(k("/repo/a.ts"), {
			content: "const a = 2;\n",
			mtimeMs: SYNCED_AT + 500,
		});
		clock = SYNCED_AT + 1_000;
		const { deps, resynced } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.candidates).toBe(1);
		expect(result.resynced).toBe(1);
		expect(resynced).toEqual([
			{ filePath: k("/repo/a.ts"), content: "const a = 2;\n" },
		]);
	});

	// #3480: a >96-char file edited only in the middle, keeping its length. A
	// length+head+tail fingerprint read the edit as "unchanged" and re-stamped
	// the record, so the server kept the old content until the next touch.
	it("resyncs a same-length middle edit of a long file — the confirmation read hashes the whole text", async () => {
		const head = `// ${"h".repeat(60)}\n`;
		const tail = `// ${"t".repeat(60)}\n`;
		const before = `${head}const x = 1;\n${tail}`;
		const after = `${head}const x = 2;\n${tail}`;
		expect(after.length).toBe(before.length);
		const files = new Map<string, FakeFile>([
			[k("/repo/long.ts"), { content: after, mtimeMs: SYNCED_AT + 500 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/long.ts"), before, SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.unchanged).toBe(0);
		expect(result.resynced).toBe(1);
		expect(resynced).toEqual([
			{ filePath: k("/repo/long.ts"), content: after },
		]);
		expect(events.map((e) => e.disposition)).toEqual(["resynced"]);
	});

	// #3481 round 1: the resync carries a read stamp taken BEFORE the sweep's
	// read, so a read that straddles a write is ordered as the older one.
	it("hands the resync a read stamp taken before its read", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/stamp.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/stamp.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps } = makeDeps(files, now);
		let readStartedAt = Number.NaN;
		let stamp: number | undefined;
		// A clock that ticks on every reading, so "before the read" is a strict
		// order without waiting on real time.
		let tick = 0;
		vi.spyOn(performance, "now").mockImplementation(() => ++tick);

		await tracker.sweep(
			{
				...deps,
				read: async (filePath: string) => {
					readStartedAt = performance.now();
					return deps.read(filePath);
				},
				resync: async (_filePath, _content, _age, readStamp) => {
					stamp = readStamp;
					return true;
				},
			},
			{ force: true },
		);

		expect(stamp).toBeTypeOf("number");
		expect(stamp).toBeLessThan(readStartedAt);
	});

	it("stamps a Git-recovery resync before its read too", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/git.ts"), { content: "v1\n", mtimeMs: SYNCED_AT - 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/git.ts"), "v1\n", SYNCED_AT);
		tracker.enqueueResync([k("/repo/git.ts")]);
		const { deps } = makeDeps(files, now);
		let readStartedAt = Number.NaN;
		let stamp: number | undefined;
		// A clock that ticks on every reading, so "before the read" is a strict
		// order without waiting on real time.
		let tick = 0;
		vi.spyOn(performance, "now").mockImplementation(() => ++tick);

		await tracker.sweep(
			{
				...deps,
				read: async (filePath: string) => {
					readStartedAt = performance.now();
					return deps.read(filePath);
				},
				resync: async (_filePath, _content, _age, readStamp) => {
					stamp = readStamp;
					return true;
				},
			},
			{ force: true },
		);

		expect(stamp).toBeTypeOf("number");
		expect(stamp).toBeLessThan(readStartedAt);
	});

	it("re-stamps a touched-but-identical long file without resyncing it", async () => {
		const same = `// ${"h".repeat(60)}\nconst x = 1;\n// ${"t".repeat(60)}\n`;
		const files = new Map<string, FakeFile>([
			[k("/repo/same.ts"), { content: same, mtimeMs: SYNCED_AT + 500 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/same.ts"), same, SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.unchanged).toBe(1);
		expect(resynced).toEqual([]);
		expect(events.map((e) => e.disposition)).toEqual(["unchanged"]);
	});

	it("resyncs a size change whose mtime was preserved — the mtime half alone would miss it", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/b.ts"), { content: "const b = 1;\n", mtimeMs: SYNCED_AT - 10 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/b.ts"), "const b = 1;\n", SYNCED_AT);

		// `cp -p` / archive extract: content and size move, mtime stays behind
		// the sync. Only the size half of the key can see this.
		files.set(k("/repo/b.ts"), {
			content: "const b = 1;\nconst c = 2;\n",
			mtimeMs: SYNCED_AT - 10,
		});
		clock = SYNCED_AT + 1_000;
		const { deps, resynced } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.candidates).toBe(1);
		expect(result.resynced).toBe(1);
		expect(resynced[0]?.content).toBe("const b = 1;\nconst c = 2;\n");
	});

	it("does not flag a file whose mtime differs only by the sub-ms fraction", async () => {
		// stat.mtimeMs carries a fraction; Date.now() does not. A file written in
		// the same millisecond as its sync must not read as drifted forever.
		const files = new Map<string, FakeFile>([
			[k("/repo/frac.ts"), { content: "same\n", mtimeMs: SYNCED_AT + 0.1006 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/frac.ts"), "same\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.checked).toBe(1);
		expect(result.candidates).toBe(0);
		expect(events).toEqual([]);
	});

	it("sends nothing when the stat moved but the bytes are identical", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/c.ts"), { content: "same\n", mtimeMs: SYNCED_AT + 500 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/c.ts"), "same\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.candidates).toBe(1);
		expect(result.unchanged).toBe(1);
		expect(result.resynced).toBe(0);
		expect(resynced).toEqual([]);
		expect(events.map((e) => e.disposition)).toEqual(["unchanged"]);
	});

	it("leaves an in-sync document untouched", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/d.ts"), { content: "stable\n", mtimeMs: SYNCED_AT - 50 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/d.ts"), "stable\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.checked).toBe(1);
		expect(result.candidates).toBe(0);
		expect(resynced).toEqual([]);
		expect(events).toEqual([]);
	});

	it("paces a bulk edit: at most DRIFT_RESYNC_BATCH resyncs per pass", async () => {
		const files = new Map<string, FakeFile>();
		const tracker = new DocumentDriftTracker();
		for (let i = 0; i < DRIFT_RESYNC_BATCH + 6; i++) {
			const key = k(`/repo/bulk-${i}.ts`);
			files.set(key, { content: `v0-${i}\n`, mtimeMs: SYNCED_AT - 10 });
			tracker.recordSynced(key, `v0-${i}\n`, SYNCED_AT);
		}
		// One bulk operation, identical mtimes — exactly the forensics' shape.
		for (const [key, file] of files) {
			files.set(key, {
				content: `${file.content}changed\n`,
				mtimeMs: SYNCED_AT + 5,
			});
		}
		clock = SYNCED_AT + 2_000;
		const { deps, resynced, events } = makeDeps(files, now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.candidates).toBe(DRIFT_RESYNC_BATCH + 6);
		expect(result.resynced).toBe(DRIFT_RESYNC_BATCH);
		expect(result.deferred).toBe(6);
		expect(resynced).toHaveLength(DRIFT_RESYNC_BATCH);
		expect(events.filter((e) => e.disposition === "deferred")).toHaveLength(6);
	});

	it("heals the deferred remainder on the next pass", async () => {
		const files = new Map<string, FakeFile>();
		const tracker = new DocumentDriftTracker();
		const total = DRIFT_RESYNC_BATCH * 2;
		for (let i = 0; i < total; i++) {
			const key = k(`/repo/round-${i}.ts`);
			files.set(key, { content: `v0-${i}\n`, mtimeMs: SYNCED_AT - 10 });
			tracker.recordSynced(key, `v0-${i}\n`, SYNCED_AT);
		}
		for (const [key, file] of files) {
			files.set(key, {
				content: `${file.content}changed\n`,
				mtimeMs: SYNCED_AT + 5,
			});
		}
		clock = SYNCED_AT + 2_000;
		const { deps, resynced } = makeDeps(files, now);

		await tracker.sweep(deps, { force: true });
		clock = SYNCED_AT + 4_000;
		await tracker.sweep(deps, { force: true });

		expect(new Set(resynced.map((r) => r.filePath)).size).toBe(total);
	});

	it("rate-limits: a second pass inside the interval does no work", async () => {
		process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "10000";
		const files = new Map<string, FakeFile>([
			[k("/repo/e.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/e.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 20_000;
		const { deps, resynced } = makeDeps(files, now);

		const first = await tracker.sweep(deps);
		expect(first.resynced).toBe(1);

		files.set(k("/repo/e.ts"), { content: "v2\n", mtimeMs: clock + 5 });
		clock += 100;
		const second = await tracker.sweep(deps);

		expect(second.checked).toBe(0);
		expect(resynced).toHaveLength(1);
	});

	it("PI_LENS_LSP_DRIFT_CHECK_MS=0 disables the sweep", async () => {
		process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "0";
		expect(driftCheckIntervalMs()).toBe(0);
		const files = new Map<string, FakeFile>([
			[k("/repo/f.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/f.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 60_000;
		const { deps, resynced } = makeDeps(files, now);

		await tracker.sweep(deps);

		expect(resynced).toEqual([]);
	});

	it("drops a record no live client still holds, without statting it", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/g.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/g.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced } = makeDeps(files, now);
		const statSpy = vi.fn(deps.stat);

		const result = await tracker.sweep(
			{ ...deps, stat: statSpy, holdsDocument: () => false },
			{ force: true },
		);

		expect(result.unheld).toBe(1);
		expect(statSpy).not.toHaveBeenCalled();
		expect(resynced).toEqual([]);
		expect(tracker.peek(k("/repo/g.ts"))).toBeUndefined();
	});

	it("drops the record for a file that no longer reads", async () => {
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/gone.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps } = makeDeps(new Map(), now);

		const result = await tracker.sweep(deps, { force: true });

		expect(result.vanished).toBe(1);
		expect(tracker.peek(k("/repo/gone.ts"))).toBeUndefined();
	});

	it("keeps the old record when the resync fails, so the next pass retries", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/h.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/h.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps } = makeDeps(files, now);
		let attempts = 0;

		const failing = {
			...deps,
			resync: async () => {
				attempts += 1;
				throw new Error("notify write timed out");
			},
		};
		const first = await tracker.sweep(failing, { force: true });
		expect(first.resynced).toBe(0);
		expect(first.failed).toBe(1);
		clock += 20_000;
		await tracker.sweep(deps, { force: true });

		expect(attempts).toBe(1);
		expect(tracker.peek(k("/repo/h.ts"))?.fingerprint).toContain("v1");
	});

	it("settles a healed file against the observed mtime, so it is not re-read forever", async () => {
		// A future mtime is the general case of "the stamp must close over the
		// disk state we saw": stamping with the wall clock alone leaves the record
		// behind the mtime, and every later pass re-reads the file for nothing.
		const files = new Map<string, FakeFile>([
			[k("/repo/settle.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5_000 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/settle.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps } = makeDeps(files, now);

		const first = await tracker.sweep(deps, { force: true });
		expect(first.resynced).toBe(1);

		clock = SYNCED_AT + 2_000;
		const second = await tracker.sweep(deps, { force: true });

		expect(second.checked).toBe(1);
		expect(second.candidates).toBe(0);
	});

	it("treats a resync that returns false as failed, not healed", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/j.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/j.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, events } = makeDeps(files, now);

		// The push returned without throwing, but one view never received the
		// content. Recording a heal here is the lie F3 exists to prevent.
		const result = await tracker.sweep(
			{ ...deps, resync: async () => false },
			{ force: true },
		);

		expect(result.resynced).toBe(0);
		expect(result.failed).toBe(1);
		expect(events.map((e) => e.disposition)).toEqual(["failed"]);
		expect(tracker.peek(k("/repo/j.ts"))?.fingerprint).toContain("v0");
	});

	it("emits the resynced record only AFTER the push landed", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/order.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/order.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, events } = makeDeps(files, now);
		const order: string[] = [];

		await tracker.sweep(
			{
				...deps,
				resync: async () => {
					order.push("push");
					return true;
				},
				onDrift: (event) => {
					order.push(`emit:${event.disposition}`);
					events.push({
						filePath: event.filePath,
						disposition: event.disposition,
						driftAgeMs: event.driftAgeMs,
					});
				},
			},
			{ force: true },
		);

		expect(order).toEqual(["push", "emit:resynced"]);
	});

	// #3480 round 1 N1: the caller's fingerprint is stored as given, so the
	// touch that already hashed the content does not hash it again.
	it("stores a fingerprint the caller already computed", () => {
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/fp.ts"), "v0\n", SYNCED_AT, "given-fp");
		expect(tracker.peek(k("/repo/fp.ts"))?.fingerprint).toBe("given-fp");
	});

	it("caps the tracked set and evicts the least recently synced", () => {
		const tracker = new DocumentDriftTracker();
		for (let i = 0; i < DRIFT_TRACK_CAP + 5; i++) {
			tracker.recordSynced(k(`/repo/cap-${i}.ts`), `v${i}\n`, SYNCED_AT + i);
		}
		expect(tracker.size).toBe(DRIFT_TRACK_CAP);
		expect(tracker.peek(k("/repo/cap-0.ts"))).toBeUndefined();
		expect(
			tracker.peek(k(`/repo/cap-${DRIFT_TRACK_CAP + 4}.ts`)),
		).toBeDefined();
	});

	it("joins an in-flight pass instead of doubling the stat load", async () => {
		const files = new Map<string, FakeFile>([
			[k("/repo/i.ts"), { content: "v1\n", mtimeMs: SYNCED_AT + 5 }],
		]);
		const tracker = new DocumentDriftTracker();
		tracker.recordSynced(k("/repo/i.ts"), "v0\n", SYNCED_AT);
		clock = SYNCED_AT + 1_000;
		const { deps, resynced } = makeDeps(files, now);
		let statCalls = 0;
		const slow = {
			...deps,
			stat: async (filePath: string) => {
				statCalls += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return deps.stat(filePath);
			},
		};

		const [a, b] = await Promise.all([
			tracker.sweep(slow, { force: true }),
			tracker.sweep(slow, { force: true }),
		]);

		expect(statCalls).toBe(1);
		expect(resynced).toHaveLength(1);
		expect(a).toBe(b);
	});
});
