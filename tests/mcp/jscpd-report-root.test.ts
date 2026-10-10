/**
 * #4133: a process killed before a scanner's `finally` removes its
 * `pi-lens-<scanner>-*` report directory leaves it behind. The MCP harness
 * child runs the real scanners for `pilens_diagnostics mode=full`, and
 * `dispose()` SIGKILLs the child tree, so this is a live member of that class.
 *
 * The witness drives a real `McpHarness` child against a fake scanner binary
 * (`tests/fixtures/fake-scanner.mjs`, parked mid-scan) that records the report
 * directory it was handed, kills the child before the scan settles, and
 * asserts the recorded directory is gone. Before the shared scanner temp-root
 * seam the child creates it under the shared tmpdir and it survives; with the
 * seam the harness owns the root and sweeps it. jscpd is the original member;
 * gitleaks is the round-3 fold onto the same seam.
 *
 * The wait is `fs.watchFile` on the marker the fake writes — a poll on the
 * real condition, not a raw `setTimeout`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness, repoRoot } from "./harness.js";

const FAKE_SCANNER = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-scanner.mjs",
);

/** Place a fake scanner shim named after `name` in `binDir`, pointing at the
 *  shared parking fixture. */
function writeFakeScanner(binDir: string, name: string): void {
	fs.writeFileSync(
		path.join(binDir, name),
		`#!/bin/sh\nexec node "${FAKE_SCANNER}" "$@"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(binDir, `${name}.cmd`),
		`@echo off\r\nnode "${FAKE_SCANNER}" %*\r\n`,
	);
}

/**
 * Resolve once `file` exists. `fs.watchFile` polls the real stat; the
 * synchronous first call covers a file created between the caller's check and
 * the watcher's registration, and later callbacks cover creation after it.
 */
function waitForFile(file: string): Promise<void> {
	return new Promise<void>((resolve) => {
		const listener = (): void => {
			if (!fs.existsSync(file)) return;
			fs.unwatchFile(file, listener);
			resolve();
		};
		fs.watchFile(file, { interval: 50, persistent: true }, listener);
		listener();
	});
}

/** Fire the full diagnostics request without awaiting it; the parked scan
 *  cannot resolve before the test kills the child. */
function fireFullDiagnostics(harness: McpHarness): void {
	harness
		.request(2, "tools/call", {
			name: "pilens_diagnostics",
			arguments: { mode: "full", refreshRunners: "cheap" },
		})
		.catch(() => {});
}

interface ScannerCase {
	/** The binary name `mode=full` invokes. */
	name: string;
	/** The directory-name prefix `mkdtempSync` gives the report dir. */
	prefix: string;
	/** Make the scanner a live member of the `mode=full` path. */
	prepareProject(fixture: string): void;
}

const CASES: readonly ScannerCase[] = [
	{
		name: "jscpd",
		prefix: "pi-lens-jscpd-",
		prepareProject() {},
	},
	{
		// mode=full runs gitleaks only on a tracked git repo (#130/#608).
		name: "gitleaks",
		prefix: "pi-lens-gitleaks-",
		prepareProject(fixture) {
			fs.mkdirSync(path.join(fixture, ".git"), { recursive: true });
		},
	},
];

describe("mcp harness scanner report root (#4133)", () => {
	for (const spec of CASES) {
		it(`sweeps a killed ${spec.name} scan's report directory from the harness-owned root`, async () => {
			const { tmpDir } = setupTestEnvironment(`pi-lens-${spec.name}-mcp-`);
			const fixture = path.join(tmpDir, "project");
			const binDir = path.join(fixture, "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(fixture, "src.ts"), "export const a = 1;\n");
			spec.prepareProject(fixture);
			writeFakeScanner(binDir, spec.name);
			const marker = path.join(tmpDir, `${spec.name}-output.txt`);

			const harness = new McpHarness({
				cwd: fixture,
				env: {
					SCANNER_FAKE_MARKER: marker,
					PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
				},
			});
			try {
				await harness.request(1, "initialize", {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: `${spec.name}-report-root`, version: "0" },
				});
				// Fire-and-forget: the parked scan cannot resolve before dispose().
				fireFullDiagnostics(harness);
				await waitForFile(marker);
				const reportDir = fs.readFileSync(marker, "utf8").trim();
				// The child really did create the report directory this test kills.
				expect(fs.existsSync(reportDir)).toBe(true);
				expect(path.basename(reportDir).startsWith(spec.prefix)).toBe(true);
				// The seam pins it inside the root the harness owns.
				expect(path.dirname(reportDir)).toBe(harness.scannerReportRoot());

				harness.dispose();

				// dispose() kills the child mid-scan, so the scan's `finally` never
				// runs; the directory is gone only because the harness owned its root.
				expect(fs.existsSync(reportDir)).toBe(false);
			} finally {
				harness.dispose();
			}
		}, 90_000);
	}
});
