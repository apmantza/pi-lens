import { describe, expect, it } from "vitest";
import {
	collectInstallDiagnostics,
	formatInstallDiagnostics,
} from "../../clients/install-diagnostics.js";

describe("install-diagnostics", () => {
	it("collects an environment fingerprint without throwing", () => {
		const d = collectInstallDiagnostics();
		expect(d.piLensVersion).toBeTruthy();
		expect(d.runtime).toMatch(/node|bun/);
		expect(d.platform).toContain("-");
		expect(d.deps.map((x) => x.name)).toContain("typescript");
		// In this repo's flat node_modules everything resolves.
		expect(d.deps.find((x) => x.name === "typescript")?.resolved).toBe(true);
	});

	it("formats a paste-able block with the cause and a report URL", () => {
		const out = formatInstallDiagnostics(
			collectInstallDiagnostics(),
			new Error("ResolveMessage: Cannot find package 'typescript'"),
		);
		expect(out).toContain("pi-lens install diagnostics");
		expect(out).toContain("LOAD ERROR: ResolveMessage");
		expect(out).toContain("runtime:");
		expect(out).toContain("install:");
		expect(out).toMatch(/github\.com\/apmantza\/pi-lens\/issues/);
	});

	it("flags a missing dep as FAIL in the rendered block", () => {
		const diag = collectInstallDiagnostics();
		diag.deps = [
			{ name: "typescript", resolved: false, error: "ERR_MODULE_NOT_FOUND ..." },
		];
		diag.notes = ["unresolved deps note"];
		const out = formatInstallDiagnostics(diag);
		expect(out).toContain("FAIL typescript");
		expect(out).toContain("note: unresolved deps note");
	});
});
