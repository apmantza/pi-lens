/**
 * NDJSON telemetry log for diagnostic disposition marks (#690). Same shape as
 * clients/actionable-warnings-logger.ts: machine-global (getGlobalPiLensDir),
 * size-capped with a single `.log.1` backup, isTestMode no-op.
 *
 * Why a log at all: #181 identified false-positive marks flowing to telemetry
 * as THE highest-value rule-tuning signal — which shipped rules misfire, on
 * what tools, how often — and this is that hookup. The disposition store
 * itself is not enough: it keeps only the LATEST entry per anchor (a re-mark
 * overwrites), and `defer` marks never touch the store at all (in-memory by
 * design), so this log is the only durable trace of both re-mark history and
 * defer activity.
 */
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const DISPOSITION_LOG_DIR = getGlobalPiLensDir();
const DISPOSITION_LOG_FILE = path.join(DISPOSITION_LOG_DIR, "dispositions.log");
const DISPOSITION_LOG_BACKUP_FILE = path.join(
	DISPOSITION_LOG_DIR,
	"dispositions.log.1",
);
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(
		process.env.PI_LENS_DISPOSITION_LOG_MAX_BYTES ?? "1048576",
		10,
	) || 1048576,
);
const writer = createNdjsonLogger({
	filePath: DISPOSITION_LOG_FILE,
	maxBytes: MAX_LOG_BYTES,
	backupPath: DISPOSITION_LOG_BACKUP_FILE,
});

export interface DispositionLogEntry {
	event: "mark";
	disposition: string;
	tool?: string;
	rule?: string;
	/** Project-relative, forward slashes — file identity without leaking the
	 * machine's absolute layout into a log that may be shared for rule tuning. */
	filePath: string;
	line?: number;
	reason?: string;
	anchor: string;
	/** The store entry's disposition this mark overwrote, when it did — the
	 * re-mark history the latest-wins store loses. */
	previousDisposition?: string;
}

export function logDispositionEvent(entry: DispositionLogEntry): void {
	if (isTestMode()) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getDispositionLogPath(): string {
	return DISPOSITION_LOG_FILE;
}

/** Resolve once all enqueued disposition writes are on disk. */
export function flushDispositionLog(): Promise<void> {
	return writer.flush();
}
