/**
 * Shared progress-streaming helper for the long-running full/batch/directory
 * diagnostic scans (`lens_diagnostics mode=full`, `lsp_diagnostics`). Those runs
 * are opaque for minutes; this streams a throttled progress bar to the tool's
 * `onUpdate` callback so the agent/user sees movement.
 */

/** Streaming update callback the SDK hands tool `execute` (shape mirrors result). */
export type ToolUpdate = (update: {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}) => void;

/**
 * For a tool's `compactRenderResult` summarizer: when the result is a streaming
 * progress partial (`details.phase === "scanning"`, emitted via `onUpdate` during
 * a full scan), return the bar to display — the joined content `text` (which
 * already holds `renderScanProgress` output), or a counts fallback. Returns
 * `null` for a normal (non-progress) result so the caller falls through to its
 * usual summary. Without this, the details-driven summarizer renders "0
 * diagnostics" mid-scan and the bar never shows.
 */
export function scanningSummaryLine(
	details: unknown,
	text: string,
): string | null {
	const d = details as
		| { phase?: string; completed?: number; total?: number }
		| undefined;
	if (d?.phase !== "scanning") return null;
	return text || `Scanning… ${d.completed ?? 0}/${d.total ?? 0}`;
}

/** A ≤20-char ASCII bar + counts, e.g. `Scanning… [████░░░░░░] 45/123 (37%)`. */
export function renderScanProgress(
	completed: number,
	total: number,
	label = "Scanning project diagnostics",
): string {
	const pct =
		total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
	const width = 20;
	const filled = Math.round((pct / 100) * width);
	const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
	return `${label}… [${bar}] ${completed}/${total} (${pct}%)`;
}

/**
 * Build a throttled `(completed, total) => void` that streams the progress bar to
 * `onUpdate` — at most once per `throttleMs` (default 250ms, ~4×/s) plus the
 * final tick so the bar always lands on 100%. Returns `undefined` when the SDK
 * gave no callback, so callers can pass it straight through as an optional.
 */
export function makeProgressReporter(
	onUpdate: unknown,
	label?: string,
	throttleMs = 250,
): ((completed: number, total: number) => void) | undefined {
	const emit = onUpdate as ToolUpdate | undefined;
	if (typeof emit !== "function") return undefined;
	let lastEmit = 0;
	return (completed: number, total: number) => {
		const now = Date.now();
		if (completed < total && now - lastEmit < throttleMs) return;
		lastEmit = now;
		emit({
			content: [
				{ type: "text", text: renderScanProgress(completed, total, label) },
			],
			details: { phase: "scanning", completed, total },
		});
	};
}
