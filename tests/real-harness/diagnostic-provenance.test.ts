import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — this sequence must cross the registered pi tool boundary
describe("real pi harness: diagnostic provenance", () => {
	it("retires a clean runner finding after an out-of-band line shift", async () => {
		await withRealPi(
			{ fixture: "diagnostic-provenance", script: "script.json" },
			async (pi) => {
				await pi.prompt("record the diagnostic");
				const before = await pi.awaitToolResult("lens_diagnostics");
				const beforeText = JSON.stringify(before);
				expect(beforeText).toContain("staleExport");
				expect(beforeText).toContain("L41");

				const file = path.join(pi.projectPath(), "src", "moved.ts");
				const source = readFileSync(file, "utf8");
				writeFileSync(
					file,
					`// out-of-band 01\n// out-of-band 02\n// out-of-band 03\n${source.replace("export const staleExport = 2;\n", "")}`,
				);

				await pi.awaitAssistantTurn();
				await pi.prompt("recheck after the external clean edit");
				const after = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(after)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare delta");
				const delta = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(delta)).not.toContain("staleExport");

				await pi.awaitAssistantTurn();
				await pi.prompt("compare session view");
				const all = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(all)).not.toContain("staleExport");
			},
		);
	}, 60_000);

	it("keeps two real project roots isolated during diagnostic provenance", async () => {
		await withRealPi(
			{ fixture: "diagnostic-provenance", script: "two-root-script.json" },
			async (pi) => {
				await pi.prompt("check both project roots");
				const outer = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(outer)).toContain("moved.ts");

				await pi.awaitAssistantTurn();
				await pi.prompt("check the nested root separately");
				const nested = await pi.awaitToolResult("lens_diagnostics");
				expect(JSON.stringify(nested)).toContain("nested/src/nested.ts");
				expect(JSON.stringify(nested)).not.toContain("staleExport");
			},
		);
	}, 60_000);
});
