import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
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
	// #4292 r5: outside-root overrides TMPDIR; a killed startup jscpd scan
	// must still land inside the removable harness home.
	it("sweeps a killed startup jscpd scan despite caller temp-root overrides", async () => {
		const sharedTmp = os.tmpdir();
		const before = readdirSync(sharedTmp).filter((name) =>
			name.startsWith("pi-lens-jscpd-"),
		);
		const home = claimScratchDir(sharedTmp, "scanner-home");
		const bin = path.join(home, "tools", "node_modules", ".bin");
		const marker = path.join(home, "scanner-marker");
		const fake = path.resolve("tests/fixtures/fake-scanner.mjs");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			path.join(bin, "jscpd"),
			`#!/bin/sh\nexec node "${fake}" "$@"\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			path.join(bin, "jscpd.cmd"),
			`@echo off\r\nnode "${fake}" %*\r\n`,
		);
		let reportDir = "";
		try {
			await withRealPi(
				{
					fixture: "outside-root",
					script: "script.json",
					home,
					args: ["--no-lsp"],
					env: {
						TMPDIR: sharedTmp,
						TMP: sharedTmp,
						TEMP: sharedTmp,
						PI_LENS_TEST_SCANNER_TMPDIR: sharedTmp,
						PI_LENS_TEST_SCANNER_HARNESS: "0",
						PI_LENS_TEST_MODE: "0",
						PI_LENS_ALLOW_SLOW_FS_SCAN: "1",
						PI_LENS_STARTUP_MODE: "full",
						SCANNER_FAKE_MARKER: marker,
					},
				},
				async (pi) => {
					await expect
						.poll(() => existsSync(marker), { timeout: 30_000 })
						.toBe(true);
					reportDir = readFileSync(marker, "utf8").trim();
					expect(existsSync(reportDir)).toBe(true);
					expect(path.basename(reportDir)).toMatch(/^pi-lens-jscpd-/);
					expect(pi.childEnvironment().TMPDIR).toBe(sharedTmp);
					expect(path.dirname(reportDir)).toBe(
						pi.childEnvironment().PI_LENS_TEST_SCANNER_TMPDIR,
					);
					expect(path.dirname(path.dirname(reportDir))).toBe(home);
					pi.killChildForTest();
				},
			);
			// home overrides are caller-owned, so the harness must sweep its
			// scanner root even when it keeps that home for inspection.
			expect(existsSync(reportDir)).toBe(false);
			expect(
				readdirSync(sharedTmp).filter((name) =>
					name.startsWith("pi-lens-jscpd-"),
				),
			).toEqual(before);
		} finally {
			if (reportDir) removeTempDirSync(reportDir);
			removeTempDirSync(home);
		}
	}, 60_000);
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
