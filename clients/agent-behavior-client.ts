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

import { createHash } from "node:crypto";
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

/**
 * What one tool result says about its own progress, as its caller can see it
 * (#5429). The tracker never sees the event, so the `tool_result` path hands
 * down these two fields and this module owns the reading of them.
 */
export interface ToolCallProgress {
	/** The host reported this call's result as a failed result. */
	readonly failed?: boolean;
	/**
	 * Identity of the arguments the call ran with, from {@link toolCallProgress}.
	 * Two calls that share a key are the same call; a call whose key the caller
	 * could not derive leaves this out, and the tracker has no evidence that it
	 * moved.
	 */
	readonly argsKey?: string;
}

/**
 * Derive the progress signal for one tool result (#5429).
 *
 * Only the two fields the `tool_result` path already holds are read, so this
 * costs no file access: the failure flag is the host's own `isError`, and the
 * argument identity is a digest of the `input` the host already parsed. The key
 * is the host's JSON key order, so a retry that reordered the same fields reads
 * as a different call — a missed warning, deliberately chosen over the false
 * positive this replaces (three successful edits warning as "no progress").
 */
export function toolCallProgress(event: {
	isError?: unknown;
	input?: unknown;
}): ToolCallProgress {
	const failed = event.isError === true;
	if (event.input === undefined || event.input === null) {
		return failed ? { failed: true } : {};
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(event.input);
	} catch {
		// A circular or throwing getter: no argument identity, so the tracker
		// keeps its pre-#5429 conservative reading for this call.
		return failed ? { failed: true } : {};
	}
	const argsKey = createHash("sha256").update(serialized).digest("hex");
	return failed ? { failed: true, argsKey } : { argsKey };
}

// --- Constants ---

// #2423: mutating-tool membership comes from the seam
// (`clients/mutating-tool.ts`), the single source of truth for the built-in
// table. The hand-maintained set this replaced also carried a dead
// `"multiedit"` entry that no host emits.
//
// Known gap, stated rather than hidden: this client is handed a tool NAME, a
// path, and the caller's two-field progress signal, never the event, so it
// cannot see a third-party mutating tool the way the shape adapters can.
// Blind-write and thrash detection covers pi's built-ins only.
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
	private lastArgsKey: string | null = null;

	// Per-file tracking
	private fileEditCount = new Map<
		string,
		{ count: number; lastUsedAt: number }
	>();
	private static readonly FILE_EDIT_IDLE_MS = 30 * 60_000;

	/**
	 * Record a tool call and return any warnings triggered.
	 * Called from tool_result handler.
	 *
	 * `progress` is the caller's evidence that the call moved anything (#5429).
	 * Omit it (or give it no argument key) and the call carries no evidence of
	 * progress, so it counts toward thrashing as it did before the signal.
	 */
	recordToolCall(
		toolName: string,
		filePath?: string,
		progress: ToolCallProgress = {},
	): BehaviorWarning[] {
		const warnings: BehaviorWarning[] = [];
		const now = Date.now();

		// Track consecutive identical tool+file pairs (thrashing).
		// Editing different files in sequence is normal agent behaviour — only flag
		// when the same tool is called on the same file N times without making
		// progress on anything else. A call makes progress when it succeeded and
		// ran with different arguments than the one before it (#5429): three edits
		// that each change the file are the agent working, not a stuck loop, while
		// a failed result or a retried argument set is the stuck loop the doc names.
		const normalizedPath = filePath ? normalizeMapKey(filePath) : null;
		const samePair =
			toolName === this.lastToolName &&
			normalizedPath === this.lastToolFilePath &&
			now - this.lastToolTimestamp < THRASH_TIMEOUT_MS;
		const noProgress =
			progress.failed === true ||
			progress.argsKey === undefined ||
			progress.argsKey === this.lastArgsKey;
		if (samePair && noProgress) {
			this.consecutiveCount++;
		} else {
			this.consecutiveCount = 1;
		}
		this.lastToolName = toolName;
		this.lastToolFilePath = normalizedPath;
		this.lastToolTimestamp = now;
		this.lastArgsKey = progress.argsKey ?? null;

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
		this.lastArgsKey = null;
		this.fileEditCount.clear();
	}
}

/** Process-wide behaviour history, independent of analyzer bootstrap residency. */
export const agentBehaviorClient = new AgentBehaviorClient();
