import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const mockFsReadFile = vi.hoisted(() => vi.fn());
const mockFsAccess = vi.hoisted(() => vi.fn());
const mockFsStat = vi.hoisted(() => vi.fn());
const mockFsWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsAppendFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockFsRename = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRandomUUID = vi.hoisted(() => vi.fn(() => "secure-probe-lock-token"));
const mockWriteFileAtomicAsync = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);

vi.mock("node:crypto", () => ({
	randomUUID: mockRandomUUID,
}));

vi.mock("node:fs/promises", () => ({
	default: {
		readFile: mockFsReadFile,
		access: mockFsAccess,
		stat: mockFsStat,
		writeFile: mockFsWriteFile,
		mkdir: mockFsMkdir,
		appendFile: mockFsAppendFile,
		rm: mockFsRm,
		rename: mockFsRename,
	},
	readFile: mockFsReadFile,
	access: mockFsAccess,
	stat: mockFsStat,
	writeFile: mockFsWriteFile,
	mkdir: mockFsMkdir,
	appendFile: mockFsAppendFile,
	rm: mockFsRm,
	rename: mockFsRename,
}));

vi.mock("../../../clients/atomic-write.js", () => ({
	writeFileAtomicAsync: mockWriteFileAtomicAsync,
}));

import { registeredBackgroundWriteDrainsForTests } from "../../../clients/background-write-drains.js";
import {
	checkProbeCache,
	flushProbeCache,
	resetProbeCacheStateForTesting,
	updateProbeCache,
} from "../../../clients/installer/index.js";

const TOOL_ID = "typescript-language-server";
const TOOL_PATH =
	"/home/user/.pi-lens/tools/node_modules/.bin/typescript-language-server";
const MTIME_MS = 1_700_000_000_000;

function makeCacheJson(
	overrides: Partial<{
		cachedAt: number;
		mtimeMs: number;
		sizeBytes: number;
	}> = {},
) {
	return JSON.stringify({
		[TOOL_ID]: {
			path: TOOL_PATH,
			mtimeMs: overrides.mtimeMs ?? MTIME_MS,
			cachedAt: overrides.cachedAt ?? Date.now(),
			...(overrides.sizeBytes !== undefined && {
				sizeBytes: overrides.sizeBytes,
			}),
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFsMkdir.mockResolvedValue(undefined);
	mockFsRm.mockResolvedValue(undefined);
	mockFsRename.mockResolvedValue(undefined);
	mockRandomUUID.mockReturnValue("secure-probe-lock-token");
	mockWriteFileAtomicAsync.mockResolvedValue(undefined);
	resetProbeCacheStateForTesting();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("checkProbeCache", () => {
	it("returns undefined when no entry exists for the tool", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
	});

	it("returns undefined and evicts when TTL has expired", async () => {
		const expiredAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
		mockFsReadFile.mockResolvedValue(makeCacheJson({ cachedAt: expiredAt }));

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		// Entry should be gone from the in-memory cache
		const second = await checkProbeCache(TOOL_ID);
		expect(second).toBeUndefined();
		expect(mockFsAccess).not.toHaveBeenCalled();
	});

	it("returns undefined and evicts when the binary is gone", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson());
		mockFsAccess.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		expect(mockFsAccess).toHaveBeenCalledWith(TOOL_PATH);
	});

	it("returns undefined and evicts when the binary mtime has changed", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS + 1 }); // different mtime

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		expect(mockFsStat).toHaveBeenCalledWith(TOOL_PATH);
	});

	it("returns the cached path when entry is valid", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBe(TOOL_PATH);
	});

	// #2300: a same-mtime-bucket rewrite (coarse filesystem mtime granularity)
	// that changes the binary's byte length must not pass the mtime-only
	// freshness check. Varies SIZE, never same-length content.
	it("returns undefined and evicts when the binary size has changed even though mtime matches", async () => {
		mockFsReadFile.mockResolvedValue(
			makeCacheJson({ mtimeMs: MTIME_MS, sizeBytes: 1000 }),
		);
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS, size: 2000 });

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBeUndefined();
		expect(mockFsStat).toHaveBeenCalledWith(TOOL_PATH);
	});

	it("returns the cached path when both mtime and size match", async () => {
		mockFsReadFile.mockResolvedValue(
			makeCacheJson({ mtimeMs: MTIME_MS, sizeBytes: 1000 }),
		);
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS, size: 1000 });

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBe(TOOL_PATH);
	});

	it("keeps serving a legacy entry with no sizeBytes field when mtime matches (fail open)", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		// Real current size differs, but the legacy entry never asserted a size
		// claim, so this pre-#2300 entry still fails OPEN to mtime-only.
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS, size: 9999 });

		const result = await checkProbeCache(TOOL_ID);

		expect(result).toBe(TOOL_PATH);
	});

	it("skips readFile on the second call (uses in-memory cache)", async () => {
		mockFsReadFile.mockResolvedValue(makeCacheJson({ mtimeMs: MTIME_MS }));
		mockFsAccess.mockResolvedValue(undefined);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await checkProbeCache(TOOL_ID);
		await checkProbeCache(TOOL_ID);

		expect(mockFsReadFile).toHaveBeenCalledTimes(1);
	});
});

describe("updateProbeCache", () => {
	it("populates the in-memory cache so a subsequent checkProbeCache hits without I/O", async () => {
		// No disk cache
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		// stat for updateProbeCache
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });
		// access + stat for the subsequent checkProbeCache
		mockFsAccess.mockResolvedValue(undefined);

		await updateProbeCache(TOOL_ID, TOOL_PATH);

		const result = await checkProbeCache(TOOL_ID);
		expect(result).toBe(TOOL_PATH);
	});

	it("silently ignores a stat failure", async () => {
		mockFsStat.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		await expect(updateProbeCache(TOOL_ID, TOOL_PATH)).resolves.toBeUndefined();
	});

	it("schedules a flush to disk", async () => {
		vi.useFakeTimers();
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await vi.advanceTimersByTimeAsync(400);

		expect(mockWriteFileAtomicAsync).toHaveBeenCalledOnce();
		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[TOOL_ID]).toMatchObject({
			path: TOOL_PATH,
			mtimeMs: MTIME_MS,
		});
	});

	it("persists the resolved binary's size alongside its mtime (#2300)", async () => {
		vi.useFakeTimers();
		mockFsReadFile.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS, size: 4242 });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await vi.advanceTimersByTimeAsync(400);

		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[TOOL_ID]).toMatchObject({
			path: TOOL_PATH,
			mtimeMs: MTIME_MS,
			sizeBytes: 4242,
		});
	});

	it("uses a cryptographically secure UUID in the lock owner token", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();

		const ownerWrite = mockFsWriteFile.mock.calls.find(([file]) =>
			String(file).endsWith("owner.json"),
		) as [string, string] | undefined;
		expect(ownerWrite).toBeDefined();
		expect(JSON.parse(ownerWrite?.[1] ?? "{}").token).toContain(
			"secure-probe-lock-token",
		);
		expect(mockRandomUUID).toHaveBeenCalled();
	});

	it("merges a sibling process's newer entry instead of losing it", async () => {
		const siblingTool = "ruff";
		const siblingEntry = {
			path: "/other/process/ruff",
			mtimeMs: MTIME_MS + 2,
			cachedAt: Date.now(),
		};
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(JSON.stringify({ [siblingTool]: siblingEntry }));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();

		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[siblingTool]).toEqual(siblingEntry);
		expect(written[TOOL_ID]).toMatchObject({ path: TOOL_PATH });
	});

	it("ages expired sibling entries during the authoritative merge", async () => {
		const staleTool = "old-tool";
		const freshTool = "fresh-tool";
		const freshEntry = {
			path: "/other/process/fresh-tool",
			mtimeMs: MTIME_MS + 2,
			cachedAt: Date.now(),
		};
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(
				JSON.stringify({
					[staleTool]: {
						path: "/other/process/old-tool",
						mtimeMs: MTIME_MS,
						cachedAt: Date.now() - 25 * 60 * 60 * 1000,
					},
					[freshTool]: freshEntry,
				}),
			);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();

		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[staleTool]).toBeUndefined();
		expect(written[freshTool]).toEqual(freshEntry);
		expect(written[TOOL_ID]).toMatchObject({ path: TOOL_PATH });
	});

	it("recovers a stale lock using its owner age", async () => {
		mockFsMkdir
			.mockRejectedValueOnce(
				Object.assign(new Error("busy"), { code: "EEXIST" }),
			)
			.mockResolvedValue(undefined);
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now() - 180_001,
					token: "stale-owner",
				}),
			)
			.mockResolvedValueOnce(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now() - 180_001,
					token: "stale-owner",
				}),
			)
			.mockResolvedValueOnce(JSON.stringify({}));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		await flushProbeCache();
		expect(mockWriteFileAtomicAsync).toHaveBeenCalledOnce();
		expect(mockFsRename).toHaveBeenCalled();
		expect(mockFsRm).toHaveBeenCalledWith(
			expect.stringContaining("probe-cache.json.lock.quarantine"),
			expect.objectContaining({ recursive: true, force: true }),
		);
	});

	it("does not remove a replacement owner during a late release", async () => {
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(JSON.stringify({}))
			.mockResolvedValueOnce(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now(),
					token: "replacement-owner",
				}),
			);
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		expect(await flushProbeCache()).toBe("written");

		// The release moved the canonical path aside, observed another owner's
		// token, and restored it. It must not recursively remove that owner.
		expect(mockFsRm).not.toHaveBeenCalledWith(
			expect.stringContaining("probe-cache.json.lock.quarantine"),
			expect.objectContaining({ recursive: true, force: true }),
		);
		expect(mockFsRename).toHaveBeenCalledTimes(2);
	});

	it("does not wait on a busy lock and retries later while the process remains live", async () => {
		vi.useFakeTimers();
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				pid: process.pid,
				createdAt: Date.now(),
				token: "owner",
			}),
		);
		mockFsMkdir.mockRejectedValue(
			Object.assign(new Error("busy"), { code: "EEXIST" }),
		);

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		const flush = flushProbeCache();
		await vi.advanceTimersByTimeAsync(300);
		expect(await flush).toBe("deferred");
		expect(mockWriteFileAtomicAsync).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(700);
		expect(mockFsMkdir.mock.calls.length).toBeGreaterThan(1);
		expect(mockWriteFileAtomicAsync).not.toHaveBeenCalled();
	});

	// Recurrence: #5657. `ensureTool` calls `void updateProbeCache(...)`; the
	// fallow archive test's teardown settled the cache while that update was still
	// awaiting its `stat`, saw nothing dirty, and the update then armed the
	// debounced flush that wrote `probe-cache.json` into the removed fixture root.
	it("the registry settle joins an update that has not marked its change yet", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));
		let releaseStat: (value: {
			mtimeMs: number;
			size: number;
		}) => void = () => {};
		mockFsStat.mockReturnValue(
			new Promise((resolve) => {
				releaseStat = resolve;
			}),
		);

		void updateProbeCache(TOOL_ID, TOOL_PATH);
		// The installer's own drain, by name: running the whole registry would let
		// the other writers' drains hold the call back past the release below.
		const drain = registeredBackgroundWriteDrainsForTests().find(
			(fn) => fn.name === "settleProbeCacheForTests",
		);
		expect(
			drain,
			"the installer registers its probe-cache drain",
		).toBeDefined();
		const settle = (drain as () => Promise<string | undefined>)();
		// A macrotask later: a settle that did not join the update has already
		// answered idle by now, and the release below marks the change after it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		releaseStat({ mtimeMs: MTIME_MS, size: 1 });
		expect(await settle).toBeUndefined();

		expect(mockWriteFileAtomicAsync).toHaveBeenCalledTimes(1);
		expect(await flushProbeCache()).toBe("idle");
	});

	it("retains an update that arrives during the atomic write", async () => {
		mockFsReadFile.mockResolvedValue(JSON.stringify({}));
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });
		let injected = false;
		mockWriteFileAtomicAsync.mockImplementation(async () => {
			if (!injected) {
				injected = true;
				await updateProbeCache("late-tool", "/managed/late-tool");
			}
		});

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		expect(await flushProbeCache()).toBe("written-with-pending");
		const first = JSON.parse(
			(mockWriteFileAtomicAsync.mock.calls[0] as [string, string])[1],
		) as Record<string, unknown>;
		expect(first[TOOL_ID]).toBeDefined();
		expect(first["late-tool"]).toBeUndefined();

		await flushProbeCache();
		const second = JSON.parse(
			(mockWriteFileAtomicAsync.mock.calls[1] as [string, string])[1],
		) as Record<string, unknown>;
		expect(second["late-tool"]).toMatchObject({ path: "/managed/late-tool" });
	});

	// #1359 review: lost-update proof — a commit whose authoritative read sees
	// ANOTHER writer's entry must fold both results, never clobber. The
	// durable-store contract does this via the locked authoritative read; this
	// pins the probe-cache merge callback's side of the bargain.
	it("folds another writer's entry seen at authoritative read (no lost update)", async () => {
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });
		// The other process committed "other-tool" between our update and our
		// flush: the locked authoritative read returns their payload.
		mockFsReadFile.mockResolvedValue(
			JSON.stringify({
				"other-tool": {
					path: "/managed/other-tool",
					mtimeMs: MTIME_MS,
					cachedAt: Date.now(),
				},
			}),
		);

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		expect(await flushProbeCache()).toBe("written");

		const written = JSON.parse(
			(mockWriteFileAtomicAsync.mock.calls[0] as [string, string])[1],
		) as Record<string, unknown>;
		expect(written[TOOL_ID]).toBeDefined();
		expect(written["other-tool"]).toMatchObject({
			path: "/managed/other-tool",
		});
	});

	// #1609 layer b: a process SIGKILLed mid-write can leave a torn
	// probe-cache.json behind. The ordinary session-lookup read path
	// (`checkProbeCache`) already degrades a parse failure to "no cache"; this
	// pins the WRITE-side authoritative read the locked commit performs before
	// merging its own update. Pre-fix, `deserializeProbeCache` re-threw on a
	// parse failure instead of degrading like `checkProbeCache` does, so the
	// locked commit's `merge` step never ran and every flush attempt re-threw
	// on the same torn bytes forever — the corrupt file was never repaired.
	it.each([
		["mid-JSON torn tail", '{"other-tool":{"path":"/x","mtimeMs":1,'],
		["zero-byte file", ""],
		["truncated to an opening brace", "{"],
	])("self-heals a torn write-side read (%s)", async (_label, torn) => {
		mockFsReadFile
			.mockResolvedValueOnce(JSON.stringify({})) // ordinary session read
			.mockResolvedValueOnce(torn); // locked authoritative read, mid-crash torn
		mockFsStat.mockResolvedValue({ mtimeMs: MTIME_MS });

		await updateProbeCache(TOOL_ID, TOOL_PATH);
		const result = await flushProbeCache();

		// No throw escaped, and the flush actually published a repaired file
		// instead of giving up (or looping) on the torn bytes forever.
		expect(result).toBe("written");
		expect(mockWriteFileAtomicAsync).toHaveBeenCalledOnce();
		const [, content] = mockWriteFileAtomicAsync.mock.calls[0] as [
			string,
			string,
		];
		const written = JSON.parse(content) as Record<string, unknown>;
		expect(written[TOOL_ID]).toMatchObject({ path: TOOL_PATH });
		// The torn entry must not survive as a half-trusted partial parse —
		// deserializeProbeCache degrades the whole disk snapshot to `{}` on any
		// parse failure, it does not attempt to salvage partial keys.
		expect(Object.keys(written)).toEqual([TOOL_ID]);
	});
});
