/**
 * #4133: a process killed before `JscpdClient.runScan`'s `finally` leaves its
 * `pi-lens-jscpd-*` report directory behind. The MCP harness child runs the
 * real jscpd client for `pilens_diagnostics mode=full`, and `dispose()` SIGKILLs
 * the child tree, so this is a live member of that class.
 *
 * The witness drives a real `McpHarness` child against a fake jscpd that parks
 * mid-scan, records the report directory it was handed (jscpd's `--output`),
 * kills the child before the scan settles, and asserts the recorded directory
 * is gone. Before the jscpd-only root seam the child creates it under the shared
 * tmpdir and it survives; with the seam the harness owns the root and sweeps it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

const JSCPD_PREFIX = "pi-lens-jscpd-";

/** A fake jscpd: instant `--version`, then parked until killed. It writes the
 *  `--output` directory it was handed to the marker file, so the parent knows
 *  exactly which report directory to check. */
function writeFakeJscpd(binDir: string): void {
	const script = [
		'const fs = require("node:fs");',
		"const args = process.argv.slice(2);",
		'if (args.includes("--version")) { process.stdout.write("5.4.0\\n"); process.exit(0); }',
		'const outIndex = args.indexOf("--output");',
		'const outDir = outIndex >= 0 ? args[outIndex + 1] : "";',
		"try { fs.writeFileSync(process.env.JSCPD_FAKE_MARKER, outDir); } catch {}",
		"setTimeout(() => process.exit(0), 60000);",
		"",
	].join("\n");
	fs.writeFileSync(path.join(binDir, "jscpd-fake.js"), script);
	fs.writeFileSync(
		path.join(binDir, "jscpd"),
		'#!/bin/sh\nexec node "$(dirname "$0")/jscpd-fake.js" "$@"\n',
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(binDir, "jscpd.cmd"),
		'@echo off\r\nnode "%~dp0jscpd-fake.js" %*\r\n',
	);
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return fs.existsSync(file);
}

/** Fire the full diagnostics request without awaiting it; the parked scan cannot
 *  resolve before the test kills the child. */
function fireFullDiagnostics(harness: McpHarness): void {
	harness
		.request(2, "tools/call", {
			name: "pilens_diagnostics",
			arguments: { mode: "full", refreshRunners: "cheap" },
		})
		.catch(() => {});
}

describe("mcp harness jscpd report root (#4133)", () => {
	it("sweeps a killed scan's report directory from the harness-owned root", async () => {
		const { tmpDir } = setupTestEnvironment("pi-lens-jscpd-mcp-");
		const fixture = path.join(tmpDir, "project");
		const binDir = path.join(fixture, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(fixture, "src.ts"), "export const a = 1;\n");
		writeFakeJscpd(binDir);
		const marker = path.join(tmpDir, "jscpd-output.txt");

		const harness = new McpHarness({
			cwd: fixture,
			env: {
				JSCPD_FAKE_MARKER: marker,
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
		});
		try {
			await harness.request(1, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "jscpd-report-root", version: "0" },
			});
			// Fire-and-forget: the parked scan cannot resolve before dispose().
			fireFullDiagnostics(harness);
			expect(await waitForFile(marker, 30_000)).toBe(true);
			const reportDir = fs.readFileSync(marker, "utf8").trim();
			// The child really did create the report directory this test kills.
			expect(fs.existsSync(reportDir)).toBe(true);
			expect(path.basename(reportDir).startsWith(JSCPD_PREFIX)).toBe(true);
			// The seam pins it inside the root the harness owns.
			expect(path.dirname(reportDir)).toBe(harness.jscpdReportRoot());

			harness.dispose();

			// dispose() kills the child mid-scan, so the scan's `finally` never
			// runs; the directory is gone only because the harness owned its root.
			expect(fs.existsSync(reportDir)).toBe(false);
		} finally {
			harness.dispose();
		}
	}, 90_000);
});
