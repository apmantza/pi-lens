import * as fs from "node:fs";
import * as readline from "node:readline";
import {
	flushLatencyLog,
	getLatencyLogPath,
	type LatencyEntry,
} from "./latency-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";

const DEFAULT_PERF_TOP_N = 5;
const MAX_PERF_TOP_N = 50;
export const MAX_PERF_PHASE_SAMPLES = 20_000;
const PARSE_YIELD_EVERY = 500;

// The window follows the same threshold that rotates the log out from under it.
// Exported so a test can size a fixture to the window it means to saturate
// rather than to a second copy of the default that can drift out of agreement.
export function resolveLogByteBudget(): number {
	return getMaxLogSizeMB() * 1024 * 1024;
}

function boundedPositiveInteger(
	value: number,
	maximum: number,
	fallback = maximum,
): number {
	return Number.isFinite(value) && value > 0
		? Math.min(maximum, Math.max(1, Math.floor(value)))
		: fallback;
}

interface PhaseLatencySummary {
	phase: string;
	samples: number;
	p50Ms: number;
	p99Ms: number;
}

export interface PhaseLatencyScope {
	sampleCount: number;
	phaseCount: number;
	oldestTs?: string;
	newestTs?: string;
	slowestByP50: PhaseLatencySummary[];
	slowestByP99: PhaseLatencySummary[];
}

export interface LatencyPerformanceReport {
	logPath: string;
	topN: number;
	windowBytes: number;
	windowTruncated: boolean;
	logSamplesTruncated: boolean;
	sessionSamplesTruncated: boolean;
	totalPhaseSamples: number;
	totalSessionPhaseSamples: number;
	malformedLines: number;
	invalidRecords: number;
	session: PhaseLatencyScope;
	logWindow: PhaseLatencyScope;
}

export interface CollectLatencyPerformanceOptions {
	sessionStartedAt: number;
	processId?: number;
	topN?: number;
	logPath?: string;
	maxBytes?: number;
	maxSamples?: number;
}

interface BoundedPhaseEntries {
	values: LatencyEntry[];
	nextIndex: number;
	total: number;
	limit: number;
}

interface PhaseLogTail {
	logEntries: LatencyEntry[];
	sessionEntries: LatencyEntry[];
	windowTruncated: boolean;
	logSamplesTruncated: boolean;
	sessionSamplesTruncated: boolean;
	totalPhaseSamples: number;
	totalSessionPhaseSamples: number;
	malformedLines: number;
	invalidRecords: number;
}

interface RawPhaseLatencySummary extends PhaseLatencySummary {
	p50RawMs: number;
	p99RawMs: number;
}

function percentile(sorted: readonly number[], quantile: number): number {
	const position = (sorted.length - 1) * quantile;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	return lower === upper
		? sorted[lower]
		: sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function roundedMs(value: number): number {
	return Math.round(value * 10) / 10;
}

function isEntryObject(value: unknown): value is Partial<LatencyEntry> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPhaseRecord(value: unknown): value is LatencyEntry {
	if (!isEntryObject(value)) return false;
	return (
		value.type === "phase" &&
		typeof value.phase === "string" &&
		value.phase.trim().length > 0 &&
		typeof value.durationMs === "number" &&
		Number.isFinite(value.durationMs) &&
		value.durationMs >= 0 &&
		(value.toolName === undefined || typeof value.toolName === "string") &&
		(value.ts === undefined || typeof value.ts === "string") &&
		(value.startedAt === undefined || typeof value.startedAt === "string") &&
		(value.pid === undefined ||
			(typeof value.pid === "number" && Number.isFinite(value.pid)))
	);
}

function isPhaseSample(value: unknown): value is LatencyEntry {
	return isPhaseRecord(value) && value.durationMs > 0;
}

function phaseKey(entry: LatencyEntry): string {
	const phase = entry.phase?.trim() ?? "";
	const toolName = entry.toolName?.trim();
	return toolName ? `${toolName}/${phase}` : phase;
}

function isCurrentSessionSample(
	entry: LatencyEntry,
	processId: number,
	sessionStartedAt: number,
): boolean {
	if (entry.pid !== processId || typeof entry.ts !== "string") return false;
	const finishedAt = Date.parse(entry.ts);
	if (!Number.isFinite(finishedAt) || finishedAt < sessionStartedAt)
		return false;
	if (entry.startedAt === undefined) return true;
	const startedAt = Date.parse(entry.startedAt);
	return Number.isFinite(startedAt) && startedAt >= sessionStartedAt;
}

function createPhaseBuffer(limit: number): BoundedPhaseEntries {
	return { values: [], nextIndex: 0, total: 0, limit };
}

function retainEntry(buffer: BoundedPhaseEntries, entry: LatencyEntry): void {
	buffer.total += 1;
	if (buffer.values.length < buffer.limit) {
		buffer.values.push(entry);
		return;
	}
	buffer.values[buffer.nextIndex] = entry;
	buffer.nextIndex = (buffer.nextIndex + 1) % buffer.limit;
}

function orderedEntries(buffer: BoundedPhaseEntries): LatencyEntry[] {
	return buffer.total > buffer.values.length
		? [
				...buffer.values.slice(buffer.nextIndex),
				...buffer.values.slice(0, buffer.nextIndex),
			]
		: buffer.values;
}

export function summarizePhaseLatency(
	entries: readonly LatencyEntry[],
	topN = DEFAULT_PERF_TOP_N,
): PhaseLatencyScope {
	const durationsByPhase = new Map<string, number[]>();
	let oldestTimestamp: { ms: number; iso: string } | undefined;
	let newestTimestamp: { ms: number; iso: string } | undefined;
	let sampleCount = 0;

	for (const entry of entries) {
		if (!isPhaseSample(entry)) continue;
		const phase = phaseKey(entry);
		const durations = durationsByPhase.get(phase) ?? [];
		durations.push(entry.durationMs);
		durationsByPhase.set(phase, durations);
		sampleCount += 1;

		if (typeof entry.ts === "string") {
			const ms = Date.parse(entry.ts);
			if (Number.isFinite(ms)) {
				if (!oldestTimestamp || ms < oldestTimestamp.ms) {
					oldestTimestamp = { ms, iso: entry.ts };
				}
				if (!newestTimestamp || ms > newestTimestamp.ms) {
					newestTimestamp = { ms, iso: entry.ts };
				}
			}
		}
	}

	const summaries: RawPhaseLatencySummary[] = Array.from(
		durationsByPhase,
		([phase, durations]) => {
			const sorted = [...durations].sort((a, b) => a - b);
			const p50RawMs = percentile(sorted, 0.5);
			const p99RawMs = percentile(sorted, 0.99);
			return {
				phase,
				samples: sorted.length,
				p50Ms: roundedMs(p50RawMs),
				p99Ms: roundedMs(p99RawMs),
				p50RawMs,
				p99RawMs,
			};
		},
	);
	const limit = boundedPositiveInteger(
		topN,
		MAX_PERF_TOP_N,
		DEFAULT_PERF_TOP_N,
	);
	const tieBreak = (a: RawPhaseLatencySummary, b: RawPhaseLatencySummary) =>
		b.samples - a.samples || a.phase.localeCompare(b.phase);
	const toPublic = ({
		phase,
		samples,
		p50Ms,
		p99Ms,
	}: RawPhaseLatencySummary): PhaseLatencySummary => ({
		phase,
		samples,
		p50Ms,
		p99Ms,
	});
	const rankBy = (
		primary: "p50RawMs" | "p99RawMs",
		secondary: "p50RawMs" | "p99RawMs",
	): PhaseLatencySummary[] =>
		[...summaries]
			.sort(
				(a, b) =>
					b[primary] - a[primary] ||
					b[secondary] - a[secondary] ||
					tieBreak(a, b),
			)
			.slice(0, limit)
			.map(toPublic);

	return {
		sampleCount,
		phaseCount: durationsByPhase.size,
		oldestTs: oldestTimestamp?.iso,
		newestTs: newestTimestamp?.iso,
		slowestByP50: rankBy("p50RawMs", "p99RawMs"),
		slowestByP99: rankBy("p99RawMs", "p50RawMs"),
	};
}

async function readPhaseLogTail(
	filePath: string,
	windowBytes: number,
	maxSamples: number,
	processId: number,
	sessionStartedAt: number,
): Promise<PhaseLogTail> {
	const empty = (): PhaseLogTail => ({
		logEntries: [],
		sessionEntries: [],
		windowTruncated: false,
		logSamplesTruncated: false,
		sessionSamplesTruncated: false,
		totalPhaseSamples: 0,
		totalSessionPhaseSamples: 0,
		malformedLines: 0,
		invalidRecords: 0,
	});
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(filePath, "r");
		const stat = await handle.stat();
		if (!stat.isFile()) {
			// POSIX rejects opening a directory with EISDIR, but Windows opens it
			// successfully with size 0 — which would fall into the empty() branch
			// and conflate "unreadable path" with "no data yet". Throw the same
			// error POSIX would so both platforms surface the bad path.
			const notAFile = new Error(
				`EISDIR: illegal operation on a directory, read '${filePath}'`,
			) as NodeJS.ErrnoException;
			notAFile.code = "EISDIR";
			throw notAFile;
		}
		if (stat.size === 0) return empty();

		const sampleLimit = boundedPositiveInteger(
			maxSamples,
			MAX_PERF_PHASE_SAMPLES,
		);
		const start = Math.max(0, stat.size - windowBytes);
		let discardPartialFirstLine = false;
		if (start > 0) {
			const previousByte = Buffer.alloc(1);
			const { bytesRead } = await handle.read(previousByte, 0, 1, start - 1);
			discardPartialFirstLine = bytesRead === 1 && previousByte[0] !== 0x0a;
		}

		const stream = handle.createReadStream({
			start,
			end: stat.size - 1,
			autoClose: false,
			encoding: "utf8",
		});
		const lines = readline.createInterface({
			input: stream,
			crlfDelay: Infinity,
		});
		const logBuffer = createPhaseBuffer(sampleLimit);
		const sessionBuffer = createPhaseBuffer(sampleLimit);
		let malformedLines = 0;
		let invalidRecords = 0;
		let lineCount = 0;

		for await (const line of lines) {
			lineCount += 1;
			if (lineCount % PARSE_YIELD_EVERY === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (discardPartialFirstLine) {
				discardPartialFirstLine = false;
				continue;
			}
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const value: unknown = JSON.parse(trimmed);
				if (isPhaseSample(value)) {
					retainEntry(logBuffer, value);
					if (isCurrentSessionSample(value, processId, sessionStartedAt)) {
						retainEntry(sessionBuffer, value);
					}
				} else if (
					!isPhaseRecord(value) &&
					(!isEntryObject(value) || value.type === "phase")
				) {
					invalidRecords += 1;
				}
			} catch {
				malformedLines += 1;
			}
		}

		return {
			logEntries: orderedEntries(logBuffer),
			sessionEntries: orderedEntries(sessionBuffer),
			windowTruncated: start > 0,
			logSamplesTruncated: logBuffer.total > sampleLimit,
			sessionSamplesTruncated: sessionBuffer.total > sampleLimit,
			totalPhaseSamples: logBuffer.total,
			totalSessionPhaseSamples: sessionBuffer.total,
			malformedLines,
			invalidRecords,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function collectLatencyPerformance(
	options: CollectLatencyPerformanceOptions,
): Promise<LatencyPerformanceReport> {
	await flushLatencyLog();
	const logPath = options.logPath ?? getLatencyLogPath();
	const processId = options.processId ?? process.pid;
	const topN = boundedPositiveInteger(
		options.topN ?? DEFAULT_PERF_TOP_N,
		MAX_PERF_TOP_N,
		DEFAULT_PERF_TOP_N,
	);
	const byteBudget = resolveLogByteBudget();
	const windowBytes = boundedPositiveInteger(
		options.maxBytes ?? byteBudget,
		byteBudget,
	);
	const tail = await readPhaseLogTail(
		logPath,
		windowBytes,
		options.maxSamples ?? MAX_PERF_PHASE_SAMPLES,
		processId,
		options.sessionStartedAt,
	);

	const { logEntries, sessionEntries, ...counters } = tail;

	return {
		logPath,
		topN,
		windowBytes,
		...counters,
		session: summarizePhaseLatency(sessionEntries, topN),
		logWindow: summarizePhaseLatency(logEntries, topN),
	};
}

function formatDuration(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
	if (ms > 0 && ms < 1) return `${ms.toFixed(2)}ms`;
	return `${Number.isInteger(ms) ? ms : ms.toFixed(1)}ms`;
}

function formatByteBudget(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${Number((bytes / (1024 * 1024)).toFixed(1))}MB`;
	}
	if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))}KB`;
	return `${bytes}B`;
}

function formatTimestamp(ts: string): string {
	const parsed = new Date(ts);
	return Number.isFinite(parsed.getTime())
		? `${parsed.toISOString().slice(0, 19).replace("T", " ")}Z`
		: ts;
}

function renderRanking(
	lines: string[],
	label: string,
	phases: readonly PhaseLatencySummary[],
): void {
	lines.push(`  ${label}:`);
	for (const phase of phases) {
		lines.push(
			`    ${phase.phase}: p50 ${formatDuration(phase.p50Ms)}, p99 ${formatDuration(phase.p99Ms)}, n=${phase.samples}`,
		);
	}
}

function renderScope(
	lines: string[],
	label: string,
	scope: PhaseLatencyScope,
): void {
	const range =
		scope.oldestTs && scope.newestTs
			? `, ${formatTimestamp(scope.oldestTs)} to ${formatTimestamp(scope.newestTs)}`
			: "";
	lines.push(
		"",
		`${label} (${scope.sampleCount} samples across ${scope.phaseCount} phases${range})`,
	);
	if (scope.slowestByP99.length === 0) {
		lines.push("  No phase timings yet.");
		return;
	}

	renderRanking(lines, "Highest p50", scope.slowestByP50);
	renderRanking(lines, "Highest p99", scope.slowestByP99);
}

export function renderLatencyPerformanceReport(
	report: LatencyPerformanceReport,
): string {
	const lines = [
		"⏱️ PI-LENS PERFORMANCE",
		`Top ${report.topN} sustained and tail latency phases.`,
	];
	renderScope(lines, "Current process session", report.session);
	renderScope(lines, "Machine-wide active log window", report.logWindow);
	lines.push("", `Source: ${report.logPath}`);
	if (report.windowTruncated) {
		lines.push(
			`Both scopes use only the newest ${formatByteBudget(report.windowBytes)} of the active log.`,
		);
	}
	if (report.sessionSamplesTruncated) {
		lines.push(
			`Session percentiles use the newest ${report.session.sampleCount.toLocaleString("en-US")} of ${report.totalSessionPhaseSamples.toLocaleString("en-US")} phase samples.`,
		);
	}
	if (report.logSamplesTruncated) {
		lines.push(
			`Machine-wide percentiles use the newest ${report.logWindow.sampleCount.toLocaleString("en-US")} of ${report.totalPhaseSamples.toLocaleString("en-US")} phase samples.`,
		);
	}
	if (report.malformedLines > 0 || report.invalidRecords > 0) {
		lines.push(
			`Skipped ${report.malformedLines} malformed line(s) and ${report.invalidRecords} invalid record(s).`,
		);
	}
	return lines.join("\n");
}
