import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, afterEach, expect, vi } from "vitest";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import { getGlobalPiLensLogDir } from "../../clients/probe-home-state.js";
import { readNdjsonRows } from "./ndjson-rows.js";

/** Read the real sink instead of replacing the private writer (#5179). */
export function installBusSinkReader() {
	const file = path.join(getGlobalPiLensLogDir(), "bus-events.log");
	let offset = 0;
	const latencyFile = path.join(getGlobalPiLensLogDir(), "latency.log");
	let latencyOffset = 0;
	const clearBusRows = async () => {
		await flushAllNdjsonWriters();
		offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
		latencyOffset = fs.existsSync(latencyFile)
			? fs.statSync(latencyFile).size
			: 0;
	};
	beforeEach(async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		await clearBusRows();
	});
	afterEach(async () => {
		await flushAllNdjsonWriters();
		vi.unstubAllEnvs();
	});
	return {
		clearBusRows,
		latencyRows: async () => {
			await flushAllNdjsonWriters();
			const result = readNdjsonRows(latencyFile, latencyOffset);
			expect(result.skipped).toBe(0);
			return result.rows;
		},
		busRows: async () => {
			await flushAllNdjsonWriters();
			const result = readNdjsonRows(file, offset);
			expect(result.skipped).toBe(0);
			return result.rows;
		},
	};
}
