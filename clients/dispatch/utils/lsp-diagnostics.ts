import type { LSPDiagnostic } from "../../lsp/client.js";
import type { Diagnostic } from "../types.js";

export interface ConvertLspDiagnosticsOptions {
	tool?: string;
	source?: string;
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
			const severity =
				d.severity === 1
					? "error"
					: d.severity === 2
						? "warning"
						: d.severity === 4
							? "hint"
							: "info";
			const semantic =
				d.severity === 1 ? "blocking" : d.severity === 2 ? "warning" : "none";
			const code = String(d.code ?? "unknown");
			const source = options.source ?? d.source ?? tool;
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
			} satisfies Diagnostic;
		});
}
