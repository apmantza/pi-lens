import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProjectDiagnosticsDeltaReport,
	loadProjectDiagnosticsSnapshot,
	saveProjectDiagnosticsSnapshot,
	writeProjectDiagnosticsDeltaReport,
} from "../../clients/project-diagnostics/cache.js";
import { knipIssuesToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/knip.js";
import { scanProjectDiagnostics } from "../../clients/project-diagnostics/scanner.js";
import type {
	ProjectDiagnosticsDeltaReport,
	ProjectDiagnosticsSnapshot,
} from "../../clients/project-diagnostics/types.js";

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-diags-"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmp, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function snapshot(
	overrides: Partial<ProjectDiagnosticsSnapshot> = {},
): ProjectDiagnosticsSnapshot {
	return {
		version: 1,
		cwd: tmp,
		tier: "cheap",
		scannedAt: "2026-01-01T00:00:00.000Z",
		diagnostics: [],
		filesScanned: 0,
		runners: ["fact-rules"],
		...overrides,
	};
}

function deltaReport(
	overrides: Partial<ProjectDiagnosticsDeltaReport> = {},
): ProjectDiagnosticsDeltaReport {
	return {
		version: 1,
		cwd: tmp,
		generatedAt: "2026-01-01T00:00:00.000Z",
		sessionId: "session-1",
		turnIndex: 1,
		diagnostics: [],
		sources: [],
		...overrides,
	};
}

describe("project diagnostics cache", () => {
	it("persists snapshots under the project data dir", () => {
		const saved = snapshot({
			diagnostics: [
				{
					filePath: path.join(tmp, "src/a.ts"),
					line: 1,
					severity: "warning",
					semantic: "warning",
					tool: "fact-rules",
					runner: "fact-rules",
					rule: "pass-through-wrappers",
					message: "wrapper",
					source: "project-scan",
				},
			],
		});
		saveProjectDiagnosticsSnapshot(tmp, saved);
		expect(loadProjectDiagnosticsSnapshot(tmp)).toEqual(saved);
	});

	it("ignores stale cache versions", () => {
		saveProjectDiagnosticsSnapshot(tmp, snapshot({ version: 0 }));
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

	it("persists delta reports", () => {
		const report = {
			version: 1,
			cwd: tmp,
			generatedAt: "2026-01-01T00:00:00.000Z",
			sessionId: "session-1",
			turnIndex: 2,
			diagnostics: [
				{
					filePath: path.join(tmp, "src/a.ts"),
					line: 3,
					severity: "error" as const,
					semantic: "blocking" as const,
					tool: "knip",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency react",
					source: "project-scan" as const,
				},
			],
			sources: ["knip"],
		};
		writeProjectDiagnosticsDeltaReport(tmp, report);
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toEqual(report);
	});

	it("returns undefined when no delta report has been written", () => {
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toBeUndefined();
	});

	it("ignores stale delta report versions", () => {
		writeProjectDiagnosticsDeltaReport(tmp, deltaReport({ version: 0 }));
		expect(loadProjectDiagnosticsDeltaReport(tmp)).toBeUndefined();
	});
});

describe("project diagnostics adapters", () => {
	it("normalizes Knip issues into ProjectDiagnostic records", () => {
		const [unlisted, unusedExport] = knipIssuesToProjectDiagnostics(tmp, [
			{ type: "unlisted", name: "left-pad", file: "src/a.ts", line: 4 },
			{ type: "export", name: "unused", file: "src/b.ts", line: 8 },
		]);

		expect(unlisted).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			severity: "error",
			semantic: "blocking",
			runner: "knip",
			rule: "knip:unlisted",
			message: "Unlisted dependency left-pad",
		});
		expect(unusedExport).toMatchObject({
			filePath: path.join(tmp, "src/b.ts"),
			severity: "warning",
			semantic: "warning",
			rule: "knip:export",
			message: "Unused export unused",
		});
	});
});

describe("scanProjectDiagnostics", () => {
	it("runs cheap project scanners and writes a normalized snapshot", async () => {
		const srcDir = path.join(tmp, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(srcDir, "wrap.ts"),
			[
				"function inner(value: number) { return value; }",
				"function wrap(value: number) {",
				"  return inner(value);",
				"}",
			].join("\n"),
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
		});

		expect(result.tier).toBe("cheap");
		expect(result.filesScanned).toBe(1);
		expect(result.runners).toContain("fact-rules");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: path.join(srcDir, "wrap.ts"),
					runner: "fact-rules",
					rule: "pass-through-wrappers",
					source: "project-scan",
				}),
			]),
		);
		expect(loadProjectDiagnosticsSnapshot(tmp)?.diagnostics.length).toBe(
			result.diagnostics.length,
		);
	});
});
