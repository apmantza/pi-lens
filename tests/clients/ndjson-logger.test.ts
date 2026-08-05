import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_exitFlushersForTest,
	createNdjsonLogger,
} from "../../clients/ndjson-logger.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;
let logFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndjson-logger-"));
	logFile = path.join(tmpDir, "test.log");
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
});

function readLines(file: string): string[] {
	return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
}

describe("createNdjsonLogger", () => {
	it("serializes a burst of log() calls in enqueue order", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 50; i++) {
			logger.log({ i });
		}
		await logger.flush();

		const lines = readLines(logFile);
		expect(lines).toHaveLength(50);
		lines.forEach((line, idx) => {
			expect(JSON.parse(line)).toEqual({ i: idx });
		});
		expect(appendFile).toHaveBeenCalledTimes(1);
	});

	it("splits batches at truncate boundaries", async () => {
		const appendFile = vi.spyOn(fs.promises, "appendFile");
		const writeFile = vi.spyOn(fs.promises, "writeFile");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		logger.log({ after: 2 });
		await logger.flush();

		expect(appendFile).toHaveBeenCalledTimes(2);
		expect(writeFile).toHaveBeenCalledTimes(1);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: 1 },
			{ after: 2 },
		]);
	});

	it("flush() resolves only once everything enqueued is on disk", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ a: 1 });
		logger.log({ b: 2 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(2);

		// A second batch after a completed flush drains independently.
		logger.log({ c: 3 });
		await logger.flush();
		expect(readLines(logFile)).toHaveLength(3);
	});

	it("lazily creates the parent directory", async () => {
		const nested = path.join(tmpDir, "a", "b", "c", "deep.log");
		const logger = createNdjsonLogger({ filePath: nested });
		logger.log({ ok: true });
		await logger.flush();
		expect(fs.existsSync(nested)).toBe(true);
	});

	it("rotates to <file>.1 at the byte threshold", async () => {
		const backup = `${logFile}.1`;
		// Keep each line below the threshold. Rotation is checked before a batch,
		// so the second line may take the active file over the limit; the third
		// line is the one that rotates the first two.
		const logger = createNdjsonLogger({ filePath: logFile, maxBytes: 40 });
		const first = '{"entry":"1234567890123456789"}';
		const second = '{"entry":"abcdefghijABCDEFGHIJ"}';
		const third = '{"entry":"third"}';

		logger.append(first);
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);

		logger.append(second);
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);
		expect(readLines(logFile)).toEqual([first, second]);

		logger.append(third);
		await logger.flush();
		expect(readLines(backup)).toEqual([first, second]);
		expect(readLines(logFile)).toEqual([third]);
	});

	it("never rotates when maxBytes is absent", async () => {
		const backup = `${logFile}.1`;
		const logger = createNdjsonLogger({ filePath: logFile });
		for (let i = 0; i < 100; i++) {
			logger.log({ padding: "x".repeat(100), i });
		}
		await logger.flush();
		expect(fs.existsSync(backup)).toBe(false);
		expect(readLines(logFile)).toHaveLength(100);
	});

	it("a truncate op does not race pending writes (clear is serialized)", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: 1 });
		logger.log({ before: 2 });
		logger.truncate();
		logger.log({ after: 1 });
		await logger.flush();

		// Enqueue order: two writes, truncate (empties file), one write. The
		// truncate cannot jump ahead of the earlier writes, so the final file
		// holds exactly the single post-truncate line.
		const lines = readLines(logFile);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ after: 1 });
	});

	it("append() adds the trailing newline itself", async () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.append('{"raw":true}');
		await logger.flush();
		expect(fs.readFileSync(logFile, "utf-8")).toBe('{"raw":true}\n');
	});

	it("redacts secrets from structured and pre-serialized log lines", async () => {
		const githubToken = `ghp_${"a".repeat(36)}`;
		const jwt = [
			"ey",
			"JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value",
		].join("");
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ message: githubToken });
		logger.append(JSON.stringify({ message: jwt }));
		logger.log({ [githubToken]: true });
		logger.append(
			JSON.stringify({
				message: `before ${["-----BEGIN ", "PRIVATE KEY-----"].join("")}\nprivate material`,
			}),
		);
		await logger.flush();

		const lines = readLines(logFile).map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{ message: "[REDACTED:github-token]" },
			{ message: "[REDACTED:jwt]" },
			{ "[REDACTED:github-token]": true },
			{ message: "before [REDACTED:private-key]" },
		]);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(githubToken);
		expect(fs.readFileSync(logFile, "utf-8")).not.toContain(jwt);
	});

	it("flushSync drains buffered lines synchronously (exit-handler path)", () => {
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ buffered: 1 });
		logger.log({ buffered: 2 });
		// Do NOT await drain — call the sync flush directly, as process.on("exit")
		// would. Everything buffered must land on disk.
		logger.flushSync();
		expect(readLines(logFile)).toHaveLength(2);
	});

	it("flushSync writes the in-flight batch (dupes over drops) and never removes newer lines", async () => {
		// #935 review: if the process dies before an in-flight threadpool
		// append issues, a skipped prefix would drop the whole batch. flushSync
		// therefore rewrites the in-flight batch synchronously — a duplicate
		// line when the async write ALSO landed is the accepted cost, a dropped
		// line is not. The async completion handler must still leave the
		// (now-empty) queue alone.
		let release: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await realAppendFile(file, data, options);
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ async: 1 });

		// Let the first append reach disk while keeping its promise unresolved,
		// then enqueue a remainder and flush everything synchronously.
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
		logger.log({ sync: 2 });
		logger.flushSync();
		// The in-flight line appears twice (async write landed AND flushSync
		// rewrote it — never-drops), the newer line exactly once.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);

		release?.();
		await logger.flush();
		// Async completion must not shift the newer items flushSync already
		// wrote, nor re-write anything.
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ async: 1 },
			{ async: 1 },
			{ sync: 2 },
		]);
	});

	it("registers one canonical per-file flusher", () => {
		const before = _exitFlushersForTest().size;
		createNdjsonLogger({ filePath: logFile });
		const second = createNdjsonLogger({
			filePath: path.join(tmpDir, ".", "test.log"),
		});
		// The shared process 'exit' handler owns one flusher per canonical file,
		// not one closure per logger facade.
		expect(_exitFlushersForTest().size).toBe(before + 1);
		second.log({ canonical: true });
		second.flushSync();
		expect(readLines(logFile)).toHaveLength(1);
	});

	it("keeps a single shared process 'exit' listener regardless of logger count", () => {
		const count = process.listenerCount("exit");
		createNdjsonLogger({ filePath: path.join(tmpDir, "a.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "b.log") });
		createNdjsonLogger({ filePath: path.join(tmpDir, "c.log") });
		// No per-logger listener growth — the MaxListeners warning cannot fire.
		expect(process.listenerCount("exit")).toBe(count);
	});

	it("shares the writer and queued operations across module re-evaluation", async () => {
		const count = process.listenerCount("exit");
		let releaseFirstAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseFirstAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const first = createNdjsonLogger({ filePath: logFile, maxBytes: 100 });
		first.log({ source: "before-reload", payload: "x".repeat(20) });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));

		const flusherCount = _exitFlushersForTest().size;
		vi.resetModules();
		const freshModule = await import("../../clients/ndjson-logger.js");
		const second = freshModule.createNdjsonLogger({
			filePath: path.join(tmpDir, ".", "test.log"),
			maxBytes: 100,
		});
		expect(process.listenerCount("exit")).toBe(count);
		expect(freshModule._exitFlushersForTest().size).toBe(flusherCount);

		second.log({ source: "after-reload", payload: "y".repeat(20) });
		expect(appendFile).toHaveBeenCalledTimes(1);
		releaseFirstAppend?.();
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "before-reload", payload: "x".repeat(20) },
			{ source: "after-reload", payload: "y".repeat(20) },
		]);

		// Rotation and truncate are also serialized through the same state. The
		// next write rotates the oversized active batch, preserving every line.
		second.log({ source: "rotated", payload: "z".repeat(20) });
		await second.flush();
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ source: "before-reload", payload: "x".repeat(20) },
			{ source: "after-reload", payload: "y".repeat(20) },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "rotated", payload: "z".repeat(20) },
		]);

		first.truncate();
		second.log({ source: "after-truncate" });
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ source: "after-truncate" },
		]);
	});

	it("preserves the documented late in-flight append after rotation", async () => {
		fs.writeFileSync(logFile, "seed-data\n");
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const logger = createNdjsonLogger({ filePath: logFile, maxBytes: 1 });

		logger.log({ first: true });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));
		logger.log({ afterFlush: true });
		logger.flushSync();

		// maxBytes:1 means each sync line rotates the active file. The second
		// line therefore replaces .1 with the serialized in-flight line; the
		// seed data is not expected to survive a second rotation.
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ first: true },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ afterFlush: true },
		]);

		releaseAppend?.();
		await logger.flush();
		// The in-flight append may still land after the synchronous exit flush.
		// Duplicating that line is the intentional dupes-over-drops tradeoff;
		// rotation itself remains deterministic and the late line is retained.
		expect(readLines(`${logFile}.1`).map((line) => JSON.parse(line))).toEqual([
			{ first: true },
		]);
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ afterFlush: true },
			{ first: true },
		]);
	});

	it("repairs a late append that would otherwise reintroduce pre-truncate data", async () => {
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(
			async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			},
		);
		const logger = createNdjsonLogger({ filePath: logFile });
		logger.log({ before: true });
		await vi.waitFor(() => expect(releaseAppend).toBeDefined());
		logger.truncate();
		logger.log({ after: true });
		logger.flushSync();
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: true },
		]);

		releaseAppend?.();
		await logger.flush();
		expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual([
			{ after: true },
		]);
	});

	it("upgrades a version-1 writer through a parent module graph", async () => {
		let releaseAppend: (() => void) | undefined;
		const realAppendFile = fs.promises.appendFile.bind(fs.promises);
		const appendFile = vi
			.spyOn(fs.promises, "appendFile")
			.mockImplementationOnce(async (file, data, options) => {
				await new Promise<void>((resolve) => {
					releaseAppend = resolve;
				});
				return realAppendFile(file, data, options);
			});
		const oldFacade = createNdjsonLogger({ filePath: logFile });
		oldFacade.log({ queuedBeforeUpgrade: true });
		oldFacade.log({ queuedAfterFirstAppend: true });
		await vi.waitFor(() => expect(appendFile).toHaveBeenCalledTimes(1));

		const key = Symbol.for("pi-lens.ndjson-logger.state");
		const globalHost = globalThis as unknown as Record<symbol, unknown>;
		const globalState = globalHost[key] as {
			schema?: string;
			version: number;
			writers: Map<string, { file: string; exitFlusher: () => void }>;
			exitFlushers: Set<() => void>;
		};
		const writerState = [...globalState.writers.values()].find((state) =>
			path.normalize(state.file).endsWith(path.normalize(logFile)),
		);
		expect(writerState).toBeDefined();
		const staleExitFlusher = writerState?.exitFlusher;
		// 6a8a0994's parent module graph writes version 1. Do not model it by
		// deleting the version marker: that only exercises the 7e4b9120 bridge.
		globalState.version = 1;

		try {
			// Import through a real logger facade, rather than re-evaluating the
			// current module directly. This is the parent-module graph shape that
			// can leave an older child graph's closure in the shared registry.
			vi.resetModules();
			await import("../../clients/sessionstart-logger.js");

			expect(globalState.version).toBe(2);
			expect(writerState?.exitFlusher).not.toBe(staleExitFlusher);
			expect(globalState.exitFlushers).not.toContain(staleExitFlusher);
			expect(globalState.exitFlushers).toContain(writerState?.exitFlusher);
			// Replacing the stale closure must not add a second flusher for this
			// writer, even though importing the parent facade may register other
			// static log paths.
			expect(
				[...globalState.exitFlushers].filter(
					(flush) => flush === writerState?.exitFlusher,
				),
			).toHaveLength(1);
			// The current flusher must drain the old facade's queue, including the
			// item enqueued by the old module graph after its first append started.
			for (const flush of globalState.exitFlushers) flush();
			expect(readLines(logFile).map((line) => JSON.parse(line))).toEqual(
				expect.arrayContaining([
					{ queuedBeforeUpgrade: true },
					{ queuedAfterFirstAppend: true },
				]),
			);
		} finally {
			releaseAppend?.();
			await oldFacade.flush();
		}
	});

	it("fences a pre-7e4b9120 private-queue module graph without dropping its exit flusher", async () => {
		const key = Symbol.for("pi-lens.ndjson-logger.state");
		const globalHost = globalThis as unknown as Record<symbol, unknown>;
		const previous = globalHost[key];
		const legacyFlusher = vi.fn();
		globalHost[key] = {
			exitFlushers: new Set([legacyFlusher]),
			exitHandlerRegistered: true,
			registeredLogFiles: new Set([logFile]),
		};
		try {
			vi.resetModules();
			const freshModule = await import("../../clients/ndjson-logger.js");
			expect(freshModule._exitFlushersForTest()).toContain(legacyFlusher);
			expect(() => freshModule.createNdjsonLogger({ filePath: logFile })).toThrow(
				/pre-7e4b9120.*private queues/,
			);
		} finally {
			globalHost[key] = previous;
			vi.resetModules();
		}
	});

	it("rejects incompatible options for one canonical path", () => {
		createNdjsonLogger({ filePath: logFile, maxBytes: 40 });
		const samePath = path.join(tmpDir, ".", "test.log");

		expect(() =>
			createNdjsonLogger({ filePath: samePath, maxBytes: 80 }),
		).toThrow(/incompatible options.*maxBytes\/backupPath/);
		expect(() =>
			createNdjsonLogger({
				filePath: samePath,
				maxBytes: 40,
				backupPath: path.join(tmpDir, "custom.backup"),
			}),
		).toThrow(/incompatible options.*maxBytes\/backupPath/);
	});

	it("keeps distinct paths isolated", async () => {
		const firstPath = path.join(tmpDir, "first.log");
		const secondPath = path.join(tmpDir, "second.log");
		const first = createNdjsonLogger({ filePath: firstPath });
		const second = createNdjsonLogger({ filePath: secondPath });
		first.log({ path: "first" });
		second.log({ path: "second" });
		await Promise.all([first.flush(), second.flush()]);
		expect(readLines(firstPath).map((line) => JSON.parse(line))).toEqual([
			{ path: "first" },
		]);
		expect(readLines(secondPath).map((line) => JSON.parse(line))).toEqual([
			{ path: "second" },
		]);
	});

	it("swallows write errors (best-effort telemetry)", async () => {
		// Point at a path whose parent is a file, so mkdir/append fail.
		const asFile = path.join(tmpDir, "not-a-dir");
		fs.writeFileSync(asFile, "x");
		const logger = createNdjsonLogger({
			filePath: path.join(asFile, "child.log"),
		});
		logger.log({ nope: true });
		await expect(logger.flush()).resolves.toBeUndefined();
	});
});
