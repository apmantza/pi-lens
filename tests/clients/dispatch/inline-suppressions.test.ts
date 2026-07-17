import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	applyInlineSuppressions,
	type SuppressibleDiagnostic,
} from "../../../clients/dispatch/inline-suppressions.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";

type D = SuppressibleDiagnostic & { message?: string };

describe("applyInlineSuppressions (#442 — shared by mode=all + mode=full)", () => {
	it("suppresses a finding via a same-line `# pi-lens-ignore` comment", () => {
		const content = "import os\neval(x)  # pi-lens-ignore: no-eval\n";
		const diags: D[] = [{ line: 2, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	it("suppresses via a comment on the line immediately above", () => {
		const content = "# pi-lens-ignore: no-eval\neval(x)\n";
		const diags: D[] = [{ line: 2, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	it("supports the // comment style and multiple comma-separated rules", () => {
		const content = "eval(x); // pi-lens-ignore: no-eval, no-debugger\n";
		const diags: D[] = [
			{ line: 1, rule: "no-eval" },
			{ line: 1, rule: "no-debugger" },
			{ line: 1, rule: "other-rule" },
		];
		expect(applyInlineSuppressions(diags, content).map((d) => d.rule)).toEqual([
			"other-rule",
		]);
	});

	it("does NOT suppress a different rule or an out-of-range line", () => {
		// The comment on line 1 covers line 1 + line 2 (next-line semantics), so the
		// "different line" case uses line 3 to stay out of range.
		const content = "eval(x)  # pi-lens-ignore: no-eval\nalert(1)\neval(y)\n";
		const diags: D[] = [
			{ line: 1, rule: "no-alert" }, // same line, different rule
			{ line: 3, rule: "no-eval" }, // same rule, out-of-range line
		];
		expect(applyInlineSuppressions(diags, content)).toEqual(diags);
	});

	it("matches by the id field when rule is absent", () => {
		const content = "x  # pi-lens-ignore: my-check\n";
		const diags: D[] = [{ line: 1, id: "my-check" }];
		expect(applyInlineSuppressions(diags, content)).toEqual([]);
	});

	// The mode=full parity fix: findings surface as `ast-grep:<id>` / `<id>-js`
	// in some surfaces, but a user writes the bare id — both must suppress (#442).
	it("suppresses a normalized rule id (ast-grep: prefix / -js suffix)", () => {
		const content = "eval(x)  # pi-lens-ignore: no-eval\n";
		expect(
			applyInlineSuppressions([{ line: 1, rule: "ast-grep:no-eval" }], content),
		).toEqual([]);
		expect(
			applyInlineSuppressions([{ line: 1, rule: "no-eval-js" }], content),
		).toEqual([]);
	});

	it("is a no-op when there are no ignore comments", () => {
		const content = "eval(x)\nalert(1)\n";
		const diags: D[] = [{ line: 1, rule: "no-eval" }];
		expect(applyInlineSuppressions(diags, content)).toBe(diags);
	});

	// #692: a scan reconcile (`lens_diagnostics mode=full`, `lsp_diagnostics`)
	// used to bake its scan-provenance label straight into `rule`
	// (`lens_diagnostics_full:no-eval`), which `normalizeSuppressRule` doesn't
	// strip — an inline `pi-lens-ignore: no-eval` comment suppressed the
	// per-edit-written entry but NOT the scan-written one. Now that
	// `scanOrigin` never touches `rule`, a scan conversion produces the exact
	// same `ast-grep:<id>` rule the per-edit path does, so suppression round-
	// trips identically regardless of which path wrote the entry.
	it("suppresses a scan-written entry (convertLspDiagnostics with scanOrigin) exactly like a per-edit one (#692)", () => {
		const content = "eval(x)  # pi-lens-ignore: no-eval\n";
		const raw: LSPDiagnostic[] = [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				message: "no-eval finding",
				severity: 2,
				source: "ast-grep",
				code: "no-eval",
			} as LSPDiagnostic,
		];
		const perEdit = convertLspDiagnostics(raw, "/repo/a.js");
		const scanned = convertLspDiagnostics(raw, "/repo/a.js", {
			scanOrigin: "lens_diagnostics_full",
		});
		expect(applyInlineSuppressions(perEdit, content)).toEqual([]);
		expect(applyInlineSuppressions(scanned, content)).toEqual([]);
	});
});
