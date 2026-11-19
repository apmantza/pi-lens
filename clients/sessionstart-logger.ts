import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { getMaxLogSizeMB } from "./log-rotation-limits.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

export const SESSIONSTART_LOG_FILE = path.join(
	getGlobalPiLensLogDir(),
	"sessionstart.log",
);

// All ordinary writers share this queue, preserving their in-process order.
// Bounded like every other global sink (#2505): an unbounded sink has no
// size check on the write path at all, so it grows until the
// once-per-process session-start sweep happens to look at it — which, in a
// long-lived process (the warm MCP server), may be never.
const writer = createNdjsonLogger({
	filePath: SESSIONSTART_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
	backupPath: `${SESSIONSTART_LOG_FILE}.1`,
});

export function logSessionStart(message: string): void {
	if (isTestMode()) return;
	writer.append(`[${new Date().toISOString()}] ${message}`);
}

export function flushSessionStartLog(): Promise<void> {
	return writer.flush();
}

export function flushSessionStartLogSync(): void {
	writer.flushSync();
}
