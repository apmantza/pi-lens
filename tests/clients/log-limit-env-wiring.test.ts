/**
 * The byte caps of `read-guard.log` and `actionable-warnings.log` go through the
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

/** The module's real log call, narrowed to one padded string per line. */
async function loadEmitter(
	moduleName: string,
): Promise<(padding: string) => void> {
	if (moduleName === "read-guard-logger") {
		const { logReadGuardEvent } =
			await import("../../clients/read-guard-logger.js");
		return (symbol) =>
			logReadGuardEvent({
				event: "edit_blocked",
				filePath: "/scratch/file.ts",
				symbol,
			});
	}
	const { logActionableWarningsEvent } =
		await import("../../clients/actionable-warnings-logger.js");
	return (padding) =>
		logActionableWarningsEvent({ event: "scratch", metadata: { padding } });
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
	const lines = Math.ceil(bytes / LINE_BYTES);
	const { flushAllNdjsonWriters } =
		await import("../../clients/ndjson-logger.js");
	const emit = await loadEmitter(moduleName);
	const logFile = path.join(
		home,
		moduleName === "read-guard-logger"
			? "read-guard.log"
			: "actionable-warnings.log",
	);
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
