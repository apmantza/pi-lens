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
	topViolations: { ruleId: string; count: number }[];
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

		getStats(): SessionStats {
			const ruleCounts = new Map<string, number>();
			for (const entry of shown.values()) {
				ruleCounts.set(entry.ruleId, (ruleCounts.get(entry.ruleId) || 0) + 1);
			}

			const topViolations = [...ruleCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([ruleId, count]) => ({ ruleId, count }));

			return {
				totalShown,
				totalAutoFixed,
				totalAgentFixed,
				totalUnresolved: totalShown - totalAutoFixed - totalAgentFixed,
				topViolations,
			};
		},

		reset() {
			shown.clear();
			totalShown = 0;
			totalAutoFixed = 0;
			totalAgentFixed = 0;
		},
	};
}
