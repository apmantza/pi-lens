/**
 * AgentBehaviorClient for pi-lens
 *
 * Tracks tool call sequences and flags anti-patterns in real-time:
 * - Blind writes: editing or writing without reading first
 * - Thrashing: repeated identical tool calls with no progress
 *
 * No external dependencies — purely tracks tool call history.
 */

import { normalizeMapKey } from "./path-utils.js";

// --- Types ---

export type BehaviorWarning = {
	type: "blind-write" | "thrashing";
	message: string;
	severity: "warning" | "error";
	details: {
		filePath?: string;
		callCount?: number;
		toolName?: string;
		windowSize?: number;
	};
};

interface ToolCallRecord {
	toolName: string;
	filePath?: string;
	timestamp: number;
}

// --- Constants ---

const WRITE_OPS = new Set(["edit", "write", "multiedit"]);
const READ_OPS = new Set(["read", "bash", "grep", "glob", "find", "rg"]);

const BLIND_WRITE_WINDOW = 5; // Check last N tool calls for a read
const THRASH_THRESHOLD = 3; // Flag after N consecutive identical tool+file pairs
const THRASH_TIMEOUT_MS = 30_000; // Reset thrash counter if gap > 30s

// --- Client ---

export class AgentBehaviorClient {
	private toolHistory: ToolCallRecord[] = [];
	private consecutiveCount = 0;
	private lastToolName: string | null = null;
	private lastToolFilePath: string | null = null;
	private lastToolTimestamp = 0;

	// Per-file tracking
	private fileEditCount = new Map<string, number>();

	/**
	 * Record a tool call and return any warnings triggered.
	 * Called from tool_result handler.
	 */
	recordToolCall(toolName: string, filePath?: string): BehaviorWarning[] {
		const warnings: BehaviorWarning[] = [];
		const now = Date.now();

		// Track consecutive identical tool+file pairs (thrashing).
		// Editing different files in sequence is normal agent behaviour — only flag
		// when the same tool is called on the same file N times without making
		// progress on anything else.
		const normalizedPath = filePath ? normalizeMapKey(filePath) : null;
		if (
			toolName === this.lastToolName &&
			normalizedPath === this.lastToolFilePath &&
			now - this.lastToolTimestamp < THRASH_TIMEOUT_MS
		) {
			this.consecutiveCount++;
		} else {
			this.consecutiveCount = 1;
		}
		this.lastToolName = toolName;
		this.lastToolFilePath = normalizedPath;
		this.lastToolTimestamp = now;

		// Check for thrashing
		if (this.consecutiveCount === THRASH_THRESHOLD) {
			const fileLabel = filePath ? ` on \`${filePath}\`` : "";
			warnings.push({
				type: "thrashing",
				message: `🔴 THRASHING — ${THRASH_THRESHOLD} consecutive \`${toolName}\`${fileLabel} calls with no progress. Consider fixing the root cause instead of re-running.`,
				severity: "error",
				details: {
					toolName,
					filePath,
					callCount: this.consecutiveCount,
				},
			});
		}

		// Check for blind writes
		if (WRITE_OPS.has(toolName)) {
			const recentWindow = this.toolHistory.slice(-BLIND_WRITE_WINDOW);
			const hasRecentRead = recentWindow.some((r) => READ_OPS.has(r.toolName));

			if (!hasRecentRead && recentWindow.length > 0) {
				// Count how many writes in the window without reads
				const writesWithoutRead = recentWindow.filter((r) =>
					WRITE_OPS.has(r.toolName),
				).length;

				if (writesWithoutRead >= 2) {
					warnings.push({
						type: "blind-write",
						message: `⚠ BLIND WRITE — editing \`${filePath ?? "file"}\` without reading in the last ${BLIND_WRITE_WINDOW} tool calls. Read the file first to avoid assumptions.`,
						severity: "warning",
						details: {
							filePath,
							windowSize: recentWindow.length,
						},
					});
				}
			}

			// Track edits per file
			if (filePath) {
				const key = normalizeMapKey(filePath);
				this.fileEditCount.set(
					key,
					(this.fileEditCount.get(key) ?? 0) + 1,
				);
			}
		}

		// Add to history (keep last 50 entries)
		this.toolHistory.push({ toolName, filePath, timestamp: now });
		if (this.toolHistory.length > 50) {
			this.toolHistory = this.toolHistory.slice(-50);
		}

		return warnings;
	}

	/**
	 * Format warnings for LLM consumption.
	 */
	formatWarnings(warnings: BehaviorWarning[]): string {
		if (warnings.length === 0) return "";

		return warnings.map((w) => w.message).join("\n");
	}

	/**
	 * Get edit count for a file in this session.
	 */
	getEditCount(filePath: string): number {
		return this.fileEditCount.get(filePath) ?? 0;
	}

	/**
	 * Reset state (e.g., on session start).
	 */
	reset(): void {
		this.toolHistory = [];
		this.consecutiveCount = 0;
		this.lastToolName = null;
		this.lastToolTimestamp = 0;
		this.fileEditCount.clear();
	}
}
