/**
 * Diagnostic Tracker — in-memory tracking for session-level feedback
 *
 * Links diagnostics to resolutions, tracks violation patterns.
 */

export interface TrackerEntry {
	ruleId: string;
	filePath: string;
	line: number;
	shownAt: Date;
	autoFixed: boolean;
	agentFixed: boolean;
}

export interface SessionStats {
	totalShown: number;
	totalAutoFixed: number;
	totalAgentFixed: number;
	totalUnresolved: number;
	topViolations: { ruleId: string; count: number; samplePaths: string[] }[];
	repeatOffenders: {
		key: string;
		ruleId: string;
		filePath: string;
		line: number;
		count: number;
	}[];
}

export interface Diagnostic {
	tool?: string;
	rule?: string;
	id?: string;
	filePath: string;
	line?: number;
}

export interface DiagnosticTracker {
	// Track that a diagnostic was shown to agent
	trackShown(diagnostics: Diagnostic[]): void;
	trackAutoFixed(count: number): void;
	trackAgentFixed(count: number): void;

	// Get session stats for summary
	getStats(): SessionStats;

	// Reset for new session
	reset(): void;
}

// Module-level singleton — persists across all writes
let _tracker: DiagnosticTracker | null = null;

export function getDiagnosticTracker(): DiagnosticTracker {
	if (!_tracker) {
		_tracker = createDiagnosticTracker();
	}
	return _tracker;
}

export function createDiagnosticTracker(): DiagnosticTracker {
	const shown: Map<string, TrackerEntry> = new Map();
	const occurrenceCounts: Map<string, number> = new Map();
	let totalShown = 0;
	let totalAutoFixed = 0;
	let totalAgentFixed = 0;

	const key = (filePath: string, ruleId: string, line: number) =>
		`${filePath}:${ruleId}:${line}`;

	return {
		trackShown(diagnostics: Diagnostic[]) {
			for (const d of diagnostics) {
				const ruleId = d.rule || d.id || "unknown";
				const line = d.line || 1;
				const k = key(d.filePath, ruleId, line);
				occurrenceCounts.set(k, (occurrenceCounts.get(k) ?? 0) + 1);

				// Don't double-count if already tracked
				if (!shown.has(k)) {
					shown.set(k, {
						ruleId,
						filePath: d.filePath,
						line,
						shownAt: new Date(),
						autoFixed: false,
						agentFixed: false,
					});
					totalShown++;
				}
			}
		},

		trackAutoFixed(count: number) {
			if (count > 0) {
				totalAutoFixed += count;
			}
		},

		trackAgentFixed(count: number) {
			if (count > 0) {
				totalAgentFixed += count;
			}
		},

		getStats(): SessionStats {
			const ruleCounts = new Map<string, number>();
			const rulePaths = new Map<string, Set<string>>();
			for (const entry of shown.values()) {
				ruleCounts.set(entry.ruleId, (ruleCounts.get(entry.ruleId) || 0) + 1);
				if (!rulePaths.has(entry.ruleId)) rulePaths.set(entry.ruleId, new Set());
				rulePaths.get(entry.ruleId)?.add(entry.filePath);
			}

			const topViolations = [...ruleCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([ruleId, count]) => ({
					ruleId,
					count,
					samplePaths: [...(rulePaths.get(ruleId) ?? new Set<string>())]
						.sort((a, b) => a.localeCompare(b))
						.slice(0, 3),
				}));

			const repeatOffenders = [...occurrenceCounts.entries()]
				.filter(([, count]) => count >= 2)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([k, count]) => {
					const parts = k.split(":");
					const lineStr = parts.pop() ?? "1";
					const ruleId = parts.pop() ?? "unknown";
					const filePath = parts.join(":");
					return {
						key: k,
						ruleId,
						filePath,
						line: Number.parseInt(lineStr, 10) || 1,
						count,
					};
				});

			return {
				totalShown,
				totalAutoFixed,
				totalAgentFixed,
				totalUnresolved: totalShown - totalAutoFixed - totalAgentFixed,
				topViolations,
				repeatOffenders,
			};
		},

		reset() {
			shown.clear();
			occurrenceCounts.clear();
			totalShown = 0;
			totalAutoFixed = 0;
			totalAgentFixed = 0;
		},
	};
}
