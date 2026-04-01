import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LATENCY_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

try {
	if (!fs.existsSync(LATENCY_LOG_DIR)) {
		fs.mkdirSync(LATENCY_LOG_DIR, { recursive: true });
	}
} catch {}

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	ts?: string;
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
	metadata?: Record<string, unknown>;
}

export function logLatency(entry: LatencyEntry): void {
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
		const lines = content.trim().split("\n").filter(Boolean);
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
