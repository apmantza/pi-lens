import * as fs from "node:fs";
import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

try {
	if (!fs.existsSync(LATENCY_LOG_DIR)) {
		fs.mkdirSync(LATENCY_LOG_DIR, { recursive: true });
	}
} catch {}

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

export function logLatency(entry: LatencyEntry): void {
	if (isTestMode()) {
		return;
	}
	const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
	try {
		fs.appendFileSync(LATENCY_LOG_FILE, line);
	} catch {}
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

export function readLatencyLog(limit = 100): LatencyEntry[] {
	try {
		const content = fs.readFileSync(LATENCY_LOG_FILE, "utf-8");
		const lines = content.trim().split(/\r?\n/).filter(Boolean);
		return lines
			.slice(-limit)
			.map((line) => JSON.parse(line))
			.reverse();
	} catch {
		return [];
	}
}

export function clearLatencyLog(): void {
	try {
		fs.writeFileSync(LATENCY_LOG_FILE, "");
	} catch {}
}
