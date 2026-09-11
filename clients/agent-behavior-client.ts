/**
 * AgentBehaviorClient for pi-lens
 *
 * Tracks tool call sequences and flags anti-patterns in real-time:
 * - Blind writes: editing or writing without reading first (a same-session
 *   write/edit of the same path counts as file knowledge)
 * - Thrashing: repeated identical tool calls with no progress
 *
 * No external dependencies — purely tracks tool call history.
 */

import { isMutatingToolName } from "./mutating-tool.js";
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

// #2423: mutating-tool membership comes from the seam
// (`clients/mutating-tool.ts`), the single source of truth for the built-in
// table. The hand-maintained set this replaced also carried a dead
// `"multiedit"` entry that no host emits.
//
// Known gap, stated rather than hidden: this client is handed a tool NAME and a
// path, never the event, so it cannot see a third-party mutating tool the way
// the shape adapters can. Blind-write and thrash detection covers pi's
// built-ins only.
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
	private fileEditCount = new Map<
		string,
		{ count: number; lastUsedAt: number }
	>();
	private static readonly FILE_EDIT_IDLE_MS = 30 * 60_000;

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
		if (isMutatingToolName(toolName)) {
			const recentWindow = this.toolHistory.slice(-BLIND_WRITE_WINDOW);
			// A read in the window proves file knowledge; so does a same-session
			// write/edit of THIS path — the agent authored the content, so the
			// write-then-edit loop on a self-authored file is not a blind write.
			const hasRecentRead = recentWindow.some(
				(r) =>
					READ_OPS.has(r.toolName) ||
					(isMutatingToolName(r.toolName) &&
						r.filePath !== undefined &&
						normalizedPath !== null &&
						normalizeMapKey(r.filePath) === normalizedPath),
			);

			if (!hasRecentRead && recentWindow.length > 0) {
				// Count how many writes in the window without reads
				const writesWithoutRead = recentWindow.filter((r) =>
					isMutatingToolName(r.toolName),
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
				this.fileEditCount.set(key, {
					count: (this.fileEditCount.get(key)?.count ?? 0) + 1,
					lastUsedAt: now,
				});
				for (const [pathKey, entry] of this.fileEditCount) {
					if (now - entry.lastUsedAt > AgentBehaviorClient.FILE_EDIT_IDLE_MS) {
						this.fileEditCount.delete(pathKey);
					}
				}
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
		return this.fileEditCount.get(normalizeMapKey(filePath))?.count ?? 0;
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

/** Process-wide behaviour history, independent of analyzer bootstrap residency. */
export const agentBehaviorClient = new AgentBehaviorClient();
