import type { FactRule } from "../fact-provider-types.js";
import type { ImportEntry } from "../facts/import-facts.js";
import type { Diagnostic } from "../types.js";

/**
 * high-import-coupling — a file importing from > 15 distinct modules. Fact-based
 * (reads `file.imports` from the tree-sitter import provider, no compiler);
 * formerly QR-003 (#402).
 */

const IMPORT_COUPLING_THRESHOLD = 15;
// Registry/hub files are intentionally wide — they import everything by design
const IMPORT_COUPLING_EXEMPT = /[/\\](index|integration)\.[cm]?tsx?$/;

export const highImportCouplingRule: FactRule = {
	id: "high-import-coupling",
	requires: ["file.imports"],
	appliesTo(ctx) {
		return /\.tsx?$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		if (IMPORT_COUPLING_EXEMPT.test(ctx.filePath)) return [];
		const imports =
			store.getFileFact<ImportEntry[]>(ctx.filePath, "file.imports") ?? [];
		const sources = new Set(imports.map((i) => i.source));
		const count = sources.size;
		if (count <= IMPORT_COUPLING_THRESHOLD) return [];
		return [
			{
				id: `high-import-coupling:${ctx.filePath}:1:1`,
				tool: "high-import-coupling",
				rule: "high-import-coupling",
				filePath: ctx.filePath,
				line: 1,
				column: 1,
				severity: "warning",
				semantic: "warning",
				message: `File imports from ${count} distinct modules (threshold: ${IMPORT_COUPLING_THRESHOLD}) — split responsibilities`,
			} satisfies Diagnostic,
		];
	},
};
