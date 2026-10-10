import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { claimScratchDir } from "../../scripts/lib/scratch-dir.mjs";
import { removeTempDirSync } from "../clients/test-utils.js";
import { withRealPi } from "../support/real-pi-harness.js";

// flake-shape: real-process-spawn — only a real pi host can prove that its
// tool_result delivery and the provider-visible advisory cross the extension
// process boundary.
// Recurrence prevented: #4218/#4230, where the shipped root classification was
// pinned only through an in-process handler and could drift at the host seam.
describe("real pi: out-of-root write notice and exemptions", () => {
	it("records one adopted-project notice and stays silent for owned paths", async () => {
		const outside = claimScratchDir(os.tmpdir(), "outside-root-project");
		writeFileSync(path.join(outside, "package.json"), "{}\n");
		const piTemp = mkdtempSync(path.join(os.tmpdir(), "pi-lens-real-harness-"));
		const directTmpFile = path.join(
			os.tmpdir(),
			"pi-lens-real-harness-direct.ts",
		);
		mkdirSync(path.join(outside, "node_modules"));
		try {
			await withRealPi(
				{
					fixture: "outside-root",
					script: "script.json",
					args: ["--no-lsp"],
					env: {
						REAL_PI_HARNESS_OUTSIDE_PROJECT: outside,
						REAL_PI_HARNESS_PI_TEMP: piTemp,
						REAL_PI_HARNESS_TMPDIR: os.tmpdir(),
						TMPDIR: os.tmpdir(),
						TMP: os.tmpdir(),
						TEMP: os.tmpdir(),
					},
				},
				async (pi) => {
					writeFileSync(
						path.join(pi.homePath(), "pi-lens-data.ts"),
						"fixture\n",
					);
					for (let turn = 0; turn < 6; turn++) {
						await pi.prompt(`write fixture ${turn}`);
						const result = await pi.awaitToolResult("write");
						expect(result).toMatchObject({ toolName: "write", isError: false });
						await pi.awaitAssistantTurn();
					}
					await expect
						.poll(
							() =>
								pi.lens
									.degradations()
									.filter((row) => row.kind === "tool-result-adopted-project"),
							{ timeout: 5_000 },
						)
						.toHaveLength(1);
					const rows = pi.lens
						.degradations()
						.filter((row) => row.kind === "tool-result-adopted-project");
					expect(rows).toHaveLength(1);
					expect(JSON.stringify(rows)).not.toContain(directTmpFile);
					expect(rows[0]?.subject).toBe(outside);
					const advisories = pi
						.providerObservations()
						.filter((observation) =>
							JSON.stringify(observation).includes("separate project"),
						);
					expect(advisories).toHaveLength(1);
					expect(JSON.stringify(advisories[0])).toContain("separate project");
					expect(JSON.stringify(advisories)).not.toContain(directTmpFile);
				},
			);
		} finally {
			removeTempDirSync(directTmpFile);
			removeTempDirSync(outside);
			removeTempDirSync(piTemp);
		}
	}, 60_000);
});
