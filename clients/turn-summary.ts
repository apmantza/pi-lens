/**
 * Turn-summary collector (#484).
 *
 * Opt-in, transcript-persistent record of what pi-lens did: diagnostics
 * found, autofixes applied, autoformats applied. Accumulated per-file across
 * the RUN's write/edit pipeline runs + the agent_end deferred-format pass,
 * then emitted as ONE `pi.sendMessage` custom entry at the `agent_settled`
 * quiet window (never per-file, and per-RUN not per-turn — see the #484
 * discussion + PR #500 review). The quiet-window emit point is load-bearing,
 * not cosmetic (verified in the installed pi 0.80.6 SDK):
 *
 *   1. `sendCustomMessage` STEERS the live model conversation when the
 *      session `isStreaming` (dist/core/agent-session.js), and turn_end can
 *      fire mid-stream — a passive summary must never steer a working agent.
 *      At settle the session is idle, so sendMessage takes the safe append
 *      branch (persisted + rendered immediately, no steer).
 *   2. A CustomMessageEntry DOES participate in LLM context: `display` only
 *      controls TUI rendering, and `buildSessionContext` converts every such
 *      entry into a `role: "user"` message on later context builds
 *      (dist/core/session-manager.js). Only `content` reaches the model —
 *      `details` never does — so the entry `content` must stay ONE short
 *      line; the model's exposure is that ~80-char collapsed line, an
 *      accepted residue (largely redundant with the #493 agent nudge).
 *
 * Collapsed rendering is tool-grouped; expanded rendering (from `details`,
 * human-only) is file-major.
 *
 * All map keys go through `normalizeMapKey` — never a hand-rolled path
 * comparison (see the two red CI rounds on PR #491 the raw-key trap cost).
 */

import { normalizeMapKey } from "./path-utils.js";

export type TurnSummaryEventKind = "diagnostic" | "autofix" | "format";

export interface TurnSummaryEvent {
	kind: TurnSummaryEventKind;
	/** Tool or LSP server id that produced this event (eslint, tsserver, ruff, prettier, ...). */
	tool: string;
	/** Rule/category id, when applicable (diagnostics only). */
	ruleId?: string;
	severity?: "error" | "warning" | "info" | "hint";
	line?: number;
	description?: string;
}

export interface TurnSummaryFileEntry {
	/** Absolute file path. */
	filePath: string;
	/** Project-relative display path, resolved at emit time (cwd known there; the renderer has no cwd). */
	displayPath: string;
	events: TurnSummaryEvent[];
}

export interface TurnSummaryCounts {
	diagnostics: number;
	autofixes: number;
	formats: number;
	/** Per-tool counts for the collapsed, tool-grouped line — keyed by event kind then tool. */
	byTool: {
		diagnostic: Record<string, number>;
		autofix: Record<string, number>;
		format: Record<string, number>;
	};
}

/** Structured payload persisted as the CustomMessage `details` (#484). File-major. */
export interface TurnSummaryDetails {
	version: 1;
	/**
	 * The run's LAST completed turn index at consume time (the collector
	 * accumulates across the whole run and is consumed once at the
	 * agent_settled quiet window, so this marks where the run ended — not a
	 * single turn the events belong to).
	 */
	turnIndex: number;
	files: TurnSummaryFileEntry[];
	counts: TurnSummaryCounts;
}

/**
 * Per-RUN accumulator. One instance lives on the runtime coordinator; it
 * survives turn boundaries (NOT cleared in beginTurn) and is cleared only by
 * `consume()` at the quiet-window emit and by `resetForSession()`.
 */
export class TurnSummaryCollector {
	private readonly filesByKey = new Map<string, TurnSummaryFileEntry>();

	private getOrCreate(filePath: string): TurnSummaryFileEntry {
		const key = normalizeMapKey(filePath);
		let entry = this.filesByKey.get(key);
		if (!entry) {
			// displayPath is resolved at consume() time (cwd known there); the
			// accumulation phase only has the absolute path.
			entry = { filePath, displayPath: filePath, events: [] };
			this.filesByKey.set(key, entry);
		}
		return entry;
	}

	record(filePath: string, event: TurnSummaryEvent): void {
		this.getOrCreate(filePath).events.push(event);
	}

	recordDiagnostic(
		filePath: string,
		args: {
			tool: string;
			ruleId?: string;
			severity?: "error" | "warning" | "info" | "hint";
			line?: number;
			description?: string;
		},
	): void {
		this.record(filePath, { kind: "diagnostic", ...args });
	}

	recordAutofix(
		filePath: string,
		args: { tool: string; description?: string; line?: number },
	): void {
		this.record(filePath, { kind: "autofix", ...args });
	}

	recordFormat(filePath: string, args: { tool: string }): void {
		this.record(filePath, { kind: "format", ...args });
	}

	isEmpty(): boolean {
		return this.filesByKey.size === 0;
	}

	/** Snapshot without clearing — used for tests/observability. */
	peek(): TurnSummaryFileEntry[] {
		return [...this.filesByKey.values()];
	}

	clear(): void {
		this.filesByKey.clear();
	}

	/** Consume (snapshot + clear) the run's collection, building the details payload. */
	consume(
		turnIndex: number,
		toDisplayPath?: (filePath: string) => string,
	): TurnSummaryDetails {
		const files = [...this.filesByKey.values()].map((entry) => ({
			...entry,
			displayPath: toDisplayPath
				? toDisplayPath(entry.filePath)
				: entry.filePath,
		}));
		this.filesByKey.clear();

		const counts: TurnSummaryCounts = {
			diagnostics: 0,
			autofixes: 0,
			formats: 0,
			byTool: { diagnostic: {}, autofix: {}, format: {} },
		};
		for (const file of files) {
			for (const event of file.events) {
				if (event.kind === "diagnostic") counts.diagnostics++;
				else if (event.kind === "autofix") counts.autofixes++;
				else counts.formats++;
				const bucket = counts.byTool[event.kind];
				bucket[event.tool] = (bucket[event.tool] ?? 0) + 1;
			}
		}

		return { version: 1, turnIndex, files, counts };
	}
}

function formatToolCounts(byTool: Record<string, number>): string {
	return Object.entries(byTool)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tool, count]) => `${tool} ${count}`)
		.join(", ");
}

/**
 * Build the collapsed, tool-grouped one-line fallback text (also used as the
 * plain-text `content` for hosts without the custom renderer).
 * Example: "pi-lens: 3 diagnostics (eslint 2, tsserver 1) · 2 autofixed (ruff) · 1 reformatted (prettier)"
 */
export function formatTurnSummaryLine(details: TurnSummaryDetails): string {
	const parts: string[] = [];
	const { counts } = details;
	if (counts.diagnostics > 0) {
		const byTool = formatToolCounts(counts.byTool.diagnostic);
		parts.push(
			`${counts.diagnostics} diagnostic${counts.diagnostics === 1 ? "" : "s"}${byTool ? ` (${byTool})` : ""}`,
		);
	}
	if (counts.autofixes > 0) {
		const byTool = formatToolCounts(counts.byTool.autofix);
		parts.push(`${counts.autofixes} autofixed${byTool ? ` (${byTool})` : ""}`);
	}
	if (counts.formats > 0) {
		const byTool = formatToolCounts(counts.byTool.format);
		parts.push(`${counts.formats} reformatted${byTool ? ` (${byTool})` : ""}`);
	}
	if (parts.length === 0) return "pi-lens: turn summary (empty)";
	return `pi-lens: ${parts.join(" · ")}`;
}

export const TURN_SUMMARY_CUSTOM_TYPE = "pilens:turn-summary";
