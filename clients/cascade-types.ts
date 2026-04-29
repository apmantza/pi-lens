import type { LSPDiagnostic } from "./lsp/client.js";
import type { ImpactCascadeResult } from "./review-graph/types.js";

export interface CascadeNeighborResult {
	filePath: string;
	reason: "imports" | "calls" | "references" | "fallback";
	diagnostics: LSPDiagnostic[];
	lspTouched: boolean;
	durationMs?: number;
}

export interface CascadeResult {
	filePath: string;
	impact: ImpactCascadeResult;
	neighbors: CascadeNeighborResult[];
	formatted: string;
}
