import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../../clients/lsp/client.js";
import { convertLspDiagnostics } from "../../../../clients/dispatch/utils/lsp-diagnostics.js";

const astGrepDiag = (over: Partial<LSPDiagnostic> = {}): LSPDiagnostic =>
	({
		range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
		message: "no-eval finding",
		severity: 2,
		source: "ast-grep",
		code: "no-eval",
		...over,
	}) as LSPDiagnostic;

describe("convertLspDiagnostics — scan-provenance identity (#692)", () => {
	it("produces the SAME `rule` for the per-edit path (no scanOrigin) and a scan-origin conversion", () => {
		const diag = astGrepDiag();
		const perEdit = convertLspDiagnostics([diag], "/repo/a.ts");
		const scanned = convertLspDiagnostics([diag], "/repo/a.ts", {
			scanOrigin: "lens_diagnostics_full",
		});
		expect(perEdit[0].rule).toBe("ast-grep:no-eval");
		expect(scanned[0].rule).toBe("ast-grep:no-eval");
		expect(scanned[0].rule).toBe(perEdit[0].rule);
		// A dedup key is a deterministic function of (filePath, line, rule) —
		// identical `rule` (not merely equal after normalization) guarantees an
		// identical dedup key regardless of which normalizer computes it.
		const dedupKey = (r: (typeof perEdit)[number]) =>
			[r.filePath, r.line, r.rule].join(":");
		expect(dedupKey(scanned[0])).toBe(dedupKey(perEdit[0]));
	});

	it("also holds for the lsp_diagnostics scan label", () => {
		const diag = astGrepDiag();
		const perEdit = convertLspDiagnostics([diag], "/repo/a.ts");
		const scanned = convertLspDiagnostics([diag], "/repo/a.ts", {
			scanOrigin: "lsp_diagnostics",
		});
		expect(scanned[0].rule).toBe(perEdit[0].rule);
	});

	it("populates `scanOrigin` on a scan conversion and leaves it absent per-edit", () => {
		const diag = astGrepDiag();
		const perEdit = convertLspDiagnostics([diag], "/repo/a.ts");
		const scanned = convertLspDiagnostics([diag], "/repo/a.ts", {
			scanOrigin: "lens_diagnostics_full",
		});
		expect(perEdit[0].scanOrigin).toBeUndefined();
		expect(scanned[0].scanOrigin).toBe("lens_diagnostics_full");
	});

	it("never bakes `scanOrigin` into `rule` or `id`", () => {
		const diag = astGrepDiag();
		const scanned = convertLspDiagnostics([diag], "/repo/a.ts", {
			scanOrigin: "lens_diagnostics_full",
		});
		expect(scanned[0].rule).not.toContain("lens_diagnostics_full");
		expect(scanned[0].id).not.toContain("lens_diagnostics_full");
	});

	it("falls back to `tool` for `rule` when the diagnostic has no own source, regardless of scanOrigin", () => {
		const diag = astGrepDiag({ source: undefined });
		const perEdit = convertLspDiagnostics([diag], "/repo/a.ts", { tool: "lsp" });
		const scanned = convertLspDiagnostics([diag], "/repo/a.ts", {
			tool: "lsp",
			scanOrigin: "lens_diagnostics_full",
		});
		expect(perEdit[0].rule).toBe("lsp:no-eval");
		expect(scanned[0].rule).toBe("lsp:no-eval");
	});
});
