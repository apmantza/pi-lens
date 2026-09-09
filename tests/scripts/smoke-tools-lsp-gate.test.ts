import { describe, expect, it } from "vitest";
import { classifyLspGateResult } from "../../scripts/smoke-tools.mjs";

const fixture = { lang: "lua", serverHint: "probe-primary" };

describe("LSP diagnostics clean-gate classification (#2780/#2776)", () => {
	it("passes only when the real handler reports a primary finding", () => {
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 1,
						auxiliaryDiagnosticsCount: 0,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds diagnostics delivered only outside the primary bucket", () => {
		// #2776 recurrence: a custom primary pushed a finding whose source differed
		// from its server id, so the handler returned a diagnostic but rendered zero
		// primary findings. The nightly gate must catch that provenance drift.
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 0,
						auxiliaryDiagnosticsCount: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("skips a server whose declared tool is unavailable", () => {
		expect(classifyLspGateResult(undefined, fixture, true)).toMatchObject({
			state: "skip",
		});
	});
});
