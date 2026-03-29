/**
 * Metrics History Tracker for pi-lens
 *
 * Persists complexity metrics per commit to track trends over time.
 * Captures snapshots passively (session start) and explicitly (/lens-metrics).
 *
 * Storage: .pi-lens/metrics-history.json
 */

import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface MetricSnapshot {
	commit: string;
	timestamp: string;
	mi: number;
	cognitive: number;
	nesting: number;
	lines: number;
}

export interface FileHistory {
	latest: MetricSnapshot;
	history: MetricSnapshot[];
	trend: "improving" | "stable" | "regressing";
}

export interface MetricsHistory {
	version: number;
	files: Record<string, FileHistory>;
	capturedAt: string;
}

export type TrendDirection = "improving" | "stable" | "regressing";

// --- Constants ---

const HISTORY_FILE = ".pi-lens/metrics-history.json";
const MAX_HISTORY_PER_FILE = 20;

// --- Git Helpers ---

/**
 * Get current git commit hash (short)
 */
function getCurrentCommit(): string {
	try {
		const { execSync } = require("node:child_process");
		return execSync("git rev-parse --short HEAD", {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
	} catch {
		return "unknown";
	}
}

// --- History Management ---

/**
 * Load history from disk (or return empty)
 */
export function loadHistory(): MetricsHistory {
	const historyPath = path.join(process.cwd(), HISTORY_FILE);

	if (!fs.existsSync(historyPath)) {
		return {
			version: 1,
			files: {},
			capturedAt: new Date().toISOString(),
		};
	}

	try {
		const content = fs.readFileSync(historyPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return {
			version: 1,
			files: {},
			capturedAt: new Date().toISOString(),
		};
	}
}

/**
 * Save history to disk
 */
export function saveHistory(history: MetricsHistory): void {
	const historyDir = path.join(process.cwd(), ".pi-lens");
	if (!fs.existsSync(historyDir)) {
		fs.mkdirSync(historyDir, { recursive: true });
	}

	history.capturedAt = new Date().toISOString();
	const historyPath = path.join(historyDir, "metrics-history.json");
	fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

// In-memory cache to avoid loading/saving on every capture
let pendingHistory: MetricsHistory | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 5000; // Save at most every 5 seconds

/**
 * Capture a snapshot for a file's current metrics
 * Auto-saves to disk (debounced) for passive tracking
 */
export function captureSnapshot(
	filePath: string,
	metrics: {
		maintainabilityIndex: number;
		cognitiveComplexity: number;
		maxNestingDepth: number;
		linesOfCode: number;
	},
): void {
	// Use in-memory cache if available, otherwise load from disk
	if (!pendingHistory) {
		pendingHistory = loadHistory();
	}

	const relativePath = path.relative(process.cwd(), filePath);
	const commit = getCurrentCommit();

	const snapshot: MetricSnapshot = {
		commit,
		timestamp: new Date().toISOString(),
		mi: Math.round(metrics.maintainabilityIndex * 10) / 10,
		cognitive: metrics.cognitiveComplexity,
		nesting: metrics.maxNestingDepth,
		lines: metrics.linesOfCode,
	};

	const existing = pendingHistory.files[relativePath];

	if (existing) {
		// Skip if same commit + same MI (no change worth recording)
		const latest = existing.latest;
		if (latest.commit === commit && latest.mi === snapshot.mi) {
			return;
		}
		// Append to history (cap at MAX_HISTORY_PER_FILE)
		existing.history.push(snapshot);
		if (existing.history.length > MAX_HISTORY_PER_FILE) {
			existing.history = existing.history.slice(-MAX_HISTORY_PER_FILE);
		}
		existing.latest = snapshot;
		existing.trend = computeTrend(existing.history);
	} else {
		// New file
		pendingHistory.files[relativePath] = {
			latest: snapshot,
			history: [snapshot],
			trend: "stable",
		};
	}

	// Debounced save to disk
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		if (pendingHistory) {
			saveHistory(pendingHistory);
			pendingHistory = null;
		}
	}, SAVE_DEBOUNCE_MS);
}

/**
 * Capture snapshots for multiple files (explicit, immediate save)
 * Used by /lens-metrics for batch capture
 */
export function captureSnapshots(
	files: Array<{
		filePath: string;
		metrics: {
			maintainabilityIndex: number;
			cognitiveComplexity: number;
			maxNestingDepth: number;
			linesOfCode: number;
		};
	}>,
): MetricsHistory {
	const history = loadHistory();

	for (const file of files) {
		const relativePath = path.relative(process.cwd(), file.filePath);
		const commit = getCurrentCommit();

		const snapshot: MetricSnapshot = {
			commit,
			timestamp: new Date().toISOString(),
			mi: Math.round(file.metrics.maintainabilityIndex * 10) / 10,
			cognitive: file.metrics.cognitiveComplexity,
			nesting: file.metrics.maxNestingDepth,
			lines: file.metrics.linesOfCode,
		};

		const existing = history.files[relativePath];

		if (existing) {
			existing.history.push(snapshot);
			if (existing.history.length > MAX_HISTORY_PER_FILE) {
				existing.history = existing.history.slice(-MAX_HISTORY_PER_FILE);
			}
			existing.latest = snapshot;
			existing.trend = computeTrend(existing.history);
		} else {
			history.files[relativePath] = {
				latest: snapshot,
				history: [snapshot],
				trend: "stable",
			};
		}
	}

	saveHistory(history);
	return history;
}

// --- Trend Analysis ---

/**
 * Compute trend direction from history snapshots
 * Uses last 3 snapshots for stability (or 2 if only 2 available)
 */
export function computeTrend(history: MetricSnapshot[]): TrendDirection {
	if (history.length < 2) return "stable";

	const recent = history.slice(-3);
	const first = recent[0];
	const last = recent[recent.length - 1];

	// Use MI as primary indicator, cognitive as secondary
	const miDelta = last.mi - first.mi;
	const cogDelta = last.cognitive - first.cognitive;

	// Thresholds (MI changes < 2 are noise)
	if (miDelta > 2) return "improving";
	if (miDelta < -2) return "regressing";

	// If MI is stable, check cognitive
	if (cogDelta < -10) return "improving";
	if (cogDelta > 10) return "regressing";

	return "stable";
}

/**
 * Get delta between current snapshot and previous
 */
export function getDelta(history: FileHistory | null): {
	mi: number;
	cognitive: number;
	trend: TrendDirection;
} | null {
	if (!history || history.history.length < 2) return null;

	const current = history.history[history.history.length - 1];
	const previous = history.history[history.history.length - 2];

	return {
		mi: Math.round((current.mi - previous.mi) * 10) / 10,
		cognitive: current.cognitive - previous.cognitive,
		trend: history.trend,
	};
}

/**
 * Get trend emoji for display
 */
export function getTrendEmoji(trend: TrendDirection): string {
	switch (trend) {
		case "improving":
			return "📈";
		case "regressing":
			return "📉";
		default:
			return "➡️";
	}
}

/**
 * Get trend summary across all files
 */
export function getTrendSummary(history: MetricsHistory): {
	improving: number;
	regressing: number;
	stable: number;
	worstRegressions: Array<{ file: string; miDelta: number }>;
} {
	let improving = 0;
	let regressing = 0;
	let stable = 0;
	const regressions: Array<{ file: string; miDelta: number }> = [];

	for (const [file, fileHistory] of Object.entries(history.files)) {
		switch (fileHistory.trend) {
			case "improving":
				improving++;
				break;
			case "regressing": {
				regressing++;
				const delta = getDelta(fileHistory);
				if (delta) {
					regressions.push({ file, miDelta: delta.mi });
				}
				break;
			}
			default:
				stable++;
		}
	}

	// Sort regressions by MI delta (worst first)
	regressions.sort((a, b) => a.miDelta - b.miDelta);

	return {
		improving,
		regressing,
		stable,
		worstRegressions: regressions.slice(0, 5),
	};
}

/**
 * Format trend for metrics table
 */
export function formatTrendCell(
	filePath: string,
	history: MetricsHistory,
): string {
	const relativePath = path.relative(process.cwd(), filePath);
	const fileHistory = history.files[relativePath];

	if (!fileHistory || fileHistory.history.length < 2) {
		return "—"; // No history
	}

	const delta = getDelta(fileHistory);
	if (!delta) return "—";

	const emoji = getTrendEmoji(delta.trend);
	const miSign = delta.mi > 0 ? "+" : "";
	const miColor = delta.mi > 0 ? "🟢" : delta.mi < 0 ? "🔴" : "⚪";

	return `${emoji} ${miColor}${miSign}${delta.mi}`;
}

// --- Technical Debt Index (TDI) ---

export interface ProjectTDI {
	score: number; // 0-100, higher = more debt
	grade: string; // A-F
	avgMI: number;
	totalCognitive: number;
	filesAnalyzed: number;
	filesWithDebt: number;
	byCategory: {
		complexity: number;
		maintainability: number;
		nesting: number;
	};
}

/**
 * Calculate Technical Debt Index for the project.
 * Score: 0 = perfect, 100 = maximum debt.
 */
export function computeTDI(history: MetricsHistory): ProjectTDI {
	const files = Object.values(history.files);
	if (files.length === 0) {
		return {
			score: 0,
			grade: "N/A",
			avgMI: 100,
			totalCognitive: 0,
			filesAnalyzed: 0,
			filesWithDebt: 0,
			byCategory: { complexity: 0, maintainability: 0, nesting: 0 },
		};
	}

	let totalMI = 0;
	let totalCognitive = 0;
	let totalNesting = 0;
	let filesWithDebt = 0;
	let debtFromMI = 0;
	let debtFromCognitive = 0;
	let debtFromNesting = 0;

	for (const file of files) {
		const snap = file.latest;
		totalMI += snap.mi;
		totalCognitive += snap.cognitive;
		totalNesting += snap.nesting;

		// Accumulate debt points
		let fileDebt = 0;

		// MI debt: 0 at MI=100, max at MI=0
		const miDebt = Math.max(0, (100 - snap.mi) / 100);
		debtFromMI += miDebt;

		// Cognitive debt: 0 at 0, max at 500+
		const cogDebt = Math.min(1, snap.cognitive / 200);
		debtFromCognitive += cogDebt;

		// Nesting debt: 0 at 1-3, max at 10+
		const nestDebt = Math.min(1, Math.max(0, snap.nesting - 3) / 7);
		debtFromNesting += nestDebt;

		fileDebt = miDebt + cogDebt + nestDebt;
		if (fileDebt > 1) filesWithDebt++; // File has at least some debt
	}

	const avgMI = totalMI / files.length;

	// Normalize to 0-100 scale
	const avgMIDebt = debtFromMI / files.length; // 0-1
	const avgCogDebt = debtFromCognitive / files.length; // 0-1
	const avgNestDebt = debtFromNesting / files.length; // 0-1

	// Weighted: MI matters most (50%), cognitive (35%), nesting (15%)
	const rawScore = avgMIDebt * 50 + avgCogDebt * 35 + avgNestDebt * 15;
	const score = Math.round(rawScore * 100) / 100;

	// Grade
	let grade: string;
	if (score <= 15) grade = "A";
	else if (score <= 30) grade = "B";
	else if (score <= 50) grade = "C";
	else if (score <= 70) grade = "D";
	else grade = "F";

	return {
		score,
		grade,
		avgMI: Math.round(avgMI * 10) / 10,
		totalCognitive,
		filesAnalyzed: files.length,
		filesWithDebt,
		byCategory: {
			complexity: Math.round(avgCogDebt * 100),
			maintainability: Math.round(avgMIDebt * 100),
			nesting: Math.round(avgNestDebt * 100),
		},
	};
}
