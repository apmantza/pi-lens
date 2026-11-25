/**
 * The byte caps of `read-guard.log`, `actionable-warnings.log`,
 * `ast-grep-tools.log`, `dispositions.log` and `dead-code.log` go through the
 * same limit reader as the retention and rotation limits (#5771): `0`, `off`
 * or `unlimited` is no cap, and an unusable value is named by
 * `unusableLogLimitEnv()` instead of silently becoming the default.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unusableLogLimitEnv } from "../../clients/log-rotation-limits.js";
import { removeTempDirSync } from "./test-utils.js";

const FLOOR_BYTES = 128 * 1024;
const DEFAULT_BYTES = 1048576;
const LINE_BYTES = 4000;
const FLUSH_EVERY = 10;

const homes: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const home of homes.splice(0)) removeTempDirSync(home);
});

interface Emitter {
	emit: (padding: string) => void;
	logName: string;
	/** Roughly the bytes one emitted line adds; only the 0.5x and 1.5x margins depend on it. */
	lineBytes: number;
}

/** The module's real log call, narrowed to one padded string per line. */
async function loadEmitter(moduleName: string): Promise<Emitter> {
	switch (moduleName) {
		case "read-guard-logger": {
			const { logReadGuardEvent } =
				await import("../../clients/read-guard-logger.js");
			return {
				emit: (symbol) =>
					logReadGuardEvent({
						event: "edit_blocked",
						filePath: "/scratch/file.ts",
						symbol,
					}),
				logName: "read-guard.log",
				lineBytes: LINE_BYTES,
			};
		}
		case "ast-grep-tool-logger": {
			const { logAstGrepToolEvent } =
				await import("../../clients/ast-grep-tool-logger.js");
			// The logger truncates the pattern at 500 characters, so a line is small.
			return {
				emit: (pattern) =>
					logAstGrepToolEvent({
						tool: "ast_grep_search",
						lang: "typescript",
						pattern,
						patternLineCount: 1,
						pathsCount: 1,
						outcome: "success",
						matchCount: 0,
						truncated: false,
						durationMs: 1,
					}),
				logName: "ast-grep-tools.log",
				lineBytes: 700,
			};
		}
		case "disposition-logger": {
			const { logDispositionEvent } =
				await import("../../clients/disposition-logger.js");
			return {
				emit: (reason) =>
					logDispositionEvent({
						event: "mark",
						disposition: "false-positive",
						filePath: "src/file.ts",
						anchor: "anchor",
						reason,
					}),
				logName: "dispositions.log",
				lineBytes: LINE_BYTES,
			};
		}
		case "dead-code-logger": {
			const { logDeadCodeScan } =
				await import("../../clients/dead-code-logger.js");
			return {
				emit: (reason) =>
					logDeadCodeScan({
						language: "typescript",
						success: true,
						cached: false,
						unusedExports: 0,
						unusedFiles: 0,
						unusedDeps: 0,
						unlistedDeps: 0,
						reason,
					}),
				logName: "dead-code.log",
				lineBytes: LINE_BYTES,
			};
		}
		default: {
			const { logActionableWarningsEvent } =
				await import("../../clients/actionable-warnings-logger.js");
			return {
				emit: (padding) =>
					logActionableWarningsEvent({
						event: "scratch",
						metadata: { padding },
					}),
				logName: "actionable-warnings.log",
				lineBytes: LINE_BYTES,
			};
		}
	}
}

/**
 * Writes about `bytes` of log lines through the real logger module and the
 * real ndjson sink, then reports whether the sink rotated the file into its
 * backup. The module reads its cap at import, so it is loaded fresh under the
 * stubbed variable; each call gets its own scratch home, so the sink opens a
 * new file and a second call does not inherit the first one's bytes.
 */
async function rotatesAfter(
	moduleName: string,
	bytes: number,
): Promise<boolean> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-logcap-"));
	homes.push(home);
	vi.stubEnv("PI_LENS_HOME", home);
	// The loggers stay silent in a test process unless test mode is off.
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
	vi.resetModules();
	const padding = "x".repeat(LINE_BYTES);
	const { flushAllNdjsonWriters } =
		await import("../../clients/ndjson-logger.js");
	const { emit, logName, lineBytes } = await loadEmitter(moduleName);
	const lines = Math.ceil(bytes / lineBytes);
	const logFile = path.join(home, logName);
	for (let i = 0; i < lines; i++) {
		emit(padding);
		// The sink plans a rotation per drain, so a batch queued in one tick is
		// written whole; flushing every few lines lets it see the file grow.
		if (i % FLUSH_EVERY === FLUSH_EVERY - 1) await flushAllNdjsonWriters();
	}
	await flushAllNdjsonWriters();
	expect(fs.existsSync(logFile)).toBe(true);
	return fs.existsSync(logFile + ".1");
}

describe.each([
	["read-guard-logger", "PI_LENS_READ_GUARD_MAX_BYTES"],
	["actionable-warnings-logger", "PI_LENS_AW_LOG_MAX_BYTES"],
	["ast-grep-tool-logger", "PI_LENS_AST_GREP_LOG_MAX_BYTES"],
	["disposition-logger", "PI_LENS_DISPOSITION_LOG_MAX_BYTES"],
	["dead-code-logger", "PI_LENS_DEAD_CODE_LOG_MAX_BYTES"],
])("%s byte cap", (moduleName, envName) => {
	it.each(["0", "off", "Unlimited"])(
		"never rotates past the default size when the value is %s",
		async (value) => {
			vi.stubEnv(envName, value);
			expect(await rotatesAfter(moduleName, DEFAULT_BYTES * 1.5)).toBe(false);
		},
	);

	it("keeps the one megabyte default when unset", async () => {
		vi.stubEnv(envName, undefined);
		expect(await rotatesAfter(moduleName, DEFAULT_BYTES / 2)).toBe(false);
		expect(await rotatesAfter(moduleName, DEFAULT_BYTES * 1.5)).toBe(true);
	});

	it("raises a positive value below the floor to the floor", async () => {
		vi.stubEnv(envName, "5");
		expect(await rotatesAfter(moduleName, FLOOR_BYTES / 2)).toBe(false);
		expect(await rotatesAfter(moduleName, FLOOR_BYTES * 2)).toBe(true);
	});

	it("uses the default for an unusable value and names it", async () => {
		vi.stubEnv(envName, "lots");
		expect(await rotatesAfter(moduleName, DEFAULT_BYTES / 2)).toBe(false);
		expect(await rotatesAfter(moduleName, DEFAULT_BYTES * 1.5)).toBe(true);
		expect(unusableLogLimitEnv()).toEqual([envName + "=lots"]);
	});
});

describe("unusableLogLimitEnv", () => {
	it("is empty when every log-limit variable is unset or usable", () => {
		vi.stubEnv("PI_LENS_LOG_RETENTION_DAYS", "30");
		vi.stubEnv("PI_LENS_MAX_LOG_SIZE_MB", "off");
		expect(unusableLogLimitEnv()).toEqual([]);
	});

	it("names each unusable variable once", () => {
		vi.stubEnv("PI_LENS_LOG_RETENTION_DAYS", "seven");
		vi.stubEnv("PI_LENS_MAX_LOG_SIZE_MB", "-1");
		expect(unusableLogLimitEnv()).toEqual([
			"PI_LENS_LOG_RETENTION_DAYS=seven",
			"PI_LENS_MAX_LOG_SIZE_MB=-1",
		]);
	});
});
