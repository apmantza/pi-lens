import type { LSPDiagnostic } from "../../lsp/client.js";
import type { Diagnostic } from "../types.js";

export interface ConvertLspDiagnosticsOptions {
	tool?: string;
	/**
	 * #692: provenance label for a diagnostic reconciled from a SCAN path
	 * (`lens_diagnostics mode=full`'s footer reconcile, `lsp_diagnostics`' own
	 * footer reconcile) rather than the per-edit dispatch pipeline. This used
	 * to be carried in a `source` option that got baked straight into `rule`
	 * (`${source}:${code}`) — which meant the SAME finding got a different
	 * `rule` depending on which path converted it (`ast-grep:<id>` per-edit vs
	 * `lens_diagnostics_full:<id>` from a scan), breaking dedup identity,
	 * inline `pi-lens-ignore` suppression, and tool-provenance re-tagging for
	 * every scan-reconciled entry (#692). Provenance must never leak into an
	 * identity field, so it now lives here instead — a dedicated, purely
	 * informational field on `Diagnostic` (`scanOrigin`) that dedup/suppression
	 * logic must never read. `rule` always derives from the diagnostic's own
	 * `d.source` (falling back to `tool`), regardless of this option.
	 */
	scanOrigin?: string;
	fixSuggestionByIndex?: Map<number, string>;
}

export function convertLspDiagnostics(
	diags: LSPDiagnostic[],
	filePath: string,
	options: ConvertLspDiagnosticsOptions = {},
): Diagnostic[] {
	const tool = options.tool ?? "lsp";
	return diags
		.filter((d) => d.range?.start?.line !== undefined)
		.map((d, idx) => {
			const severityMap: Record<number, "error" | "warning" | "hint"> = { 1: "error", 2: "warning", 4: "hint" };
			const severity: "error" | "warning" | "info" | "hint" = severityMap[d.severity] ?? "info";
			const semantic =
				d.severity === 1 ? "blocking" : (d.severity === 2 ? "warning" : "none");
			const code = String(d.code ?? "unknown");
			// #692: identity ALWAYS derives from the diagnostic's own source — never
			// from a caller-supplied scan label (see `scanOrigin`'s doc comment above).
			const source = d.source ?? tool;
			const hasSuggestion = options.fixSuggestionByIndex?.has(idx) ?? false;
			return {
				id: `${tool}:${code}:${d.range.start.line}`,
				message: d.message,
				filePath,
				line: d.range.start.line + 1,
				column: d.range.start.character + 1,
				severity,
				semantic,
				tool,
				rule: `${source}:${code}`,
				fixable: hasSuggestion,
				autoFixAvailable: false,
				fixKind: hasSuggestion ? "suggestion" : undefined,
				fixSuggestion: options.fixSuggestionByIndex?.get(idx),
				scanOrigin: options.scanOrigin,
			} satisfies Diagnostic;
		});
}
