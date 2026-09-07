import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensLogDir } from "./probe-home-state.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { normalizeFilePath } from "./path-utils.js";

const AW_LOG_DIR = getGlobalPiLensLogDir();
const AW_LOG_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log");
const AW_LOG_BACKUP_FILE = path.join(AW_LOG_DIR, "actionable-warnings.log.1");
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(process.env.PI_LENS_AW_LOG_MAX_BYTES ?? "1048576", 10) ||
		1048576,
);
const writer = createNdjsonLogger({
	filePath: AW_LOG_FILE,
	maxBytes: MAX_LOG_BYTES,
	backupPath: AW_LOG_BACKUP_FILE,
});

export interface ActionableWarningsLogEntry {
	event: string;
	sessionId?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}

/**
 * #2219 (the #2141 class): `filePath` reaches here from
 * `actionable-warnings.ts`'s raw `path.resolve(cwd, file)` — the file
 * imports `normalizeMapKey` and uses it for map lookups on this same value,
 * but never normalizes what gets logged. `filePath` is optional (several
 * events, e.g. `report_started`/`report_complete`, carry none), so only
 * normalize when present.
 */
export function logActionableWarningsEvent(
	entry: ActionableWarningsLogEntry,
): void {
	if (isTestMode()) {
		return;
	}
	writer.log({
		ts: new Date().toISOString(),
		...entry,
		...(entry.filePath !== undefined
			? { filePath: normalizeFilePath(entry.filePath) }
			: {}),
	});
}
