import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProjectDiagnosticsDeltaReport,
	loadProjectDiagnosticsSnapshot,
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	reconcileProjectDiagnosticsSnapshot,
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
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
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
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
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
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
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

describe("reconcileProjectDiagnosticsSnapshot (#298 staleness)", () => {
	function diag(filePath: string) {
		return {
			filePath,
			line: 1,
			severity: "error" as const,
			semantic: "blocking" as const,
			tool: "typescript",
			runner: "lsp",
			code: "2307",
			message: "Cannot find module './reader.ts'",
			source: "project-scan" as const,
		};
	}

	it("drops a diagnostic for a file edited after the scan", () => {
		const f = path.join(tmp, "reader.ts");
		fs.writeFileSync(f, "export const countTotal = 1;\n");
		const snap = snapshot({
			scannedAt: "2026-01-01T00:00:00.000Z",
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		// Edit the file now (mtime >> scannedAt) — the recorded error is stale.
		fs.writeFileSync(f, "export const countTotal = 2;\nexport const x = 3;\n");
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(0);
		expect(staleDropped).toBe(1);
	});

	it("drops a diagnostic for a deleted file", () => {
		const f = path.join(tmp, "gone.ts");
		const snap = snapshot({
			scannedAt: new Date().toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		// File never existed on disk (or was deleted after the scan).
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(0);
		expect(staleDropped).toBe(1);
	});

	it("keeps a diagnostic for an unchanged file (and returns the same object)", () => {
		const f = path.join(tmp, "stable.ts");
		fs.writeFileSync(f, "export const a = 1;\n");
		// Scan AFTER writing the file, so mtime <= scannedAt → not stale.
		const snap = snapshot({
			scannedAt: new Date(Date.now() + 1000).toISOString(),
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(1);
		expect(staleDropped).toBe(0);
		expect(reconciled).toBe(snap); // no-op returns the original reference
	});

	it("is fail-safe on an unparseable scannedAt (keeps everything)", () => {
		const f = path.join(tmp, "missing.ts");
		const snap = snapshot({
			scannedAt: "not-a-date",
			diagnostics: [diag(f)],
			filesScanned: 1,
		});
		const { snapshot: reconciled, staleDropped } =
			reconcileProjectDiagnosticsSnapshot(snap);
		expect(reconciled.diagnostics).toHaveLength(1);
		expect(staleDropped).toBe(0);
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
	it("caps source collection before scanning", async () => {
		const srcDir = path.join(tmp, "src-cap");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(path.join(srcDir, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(srcDir, "b.ts"), "export const b = 1;\n");
		fs.writeFileSync(path.join(srcDir, "c.ts"), "export const c = 1;\n");

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 2,
		});

		expect(result.filesScanned).toBe(2);
	});

	it("returns a partial snapshot without persisting it when aborted (#341)", async () => {
		const srcDir = path.join(tmp, "src-abort");
		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(
			path.join(srcDir, "ui.ts"),
			'export function notify() { alert("hi"); }\n',
		);

		const controller = new AbortController();
		controller.abort();
		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
			signal: controller.signal,
		});

		// All phases were skipped (no runners ran) and the partial snapshot was
		// NOT written to the cross-session cache.
		expect(result.runners).toEqual([]);
		expect(result.diagnostics).toEqual([]);
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

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

	it("runs ast-grep-napi project-wide without the ast-grep binary (#308)", async () => {
		const srcDir = path.join(tmp, "src");
		fs.mkdirSync(srcDir, { recursive: true });
		// `alert($$$ARGS)` is the shipped `no-alert` rule — a clean, suppression-free
		// match that exercises the bundled napi engine (no binary involved).
		fs.writeFileSync(
			path.join(srcDir, "ui.ts"),
			'export function notify() { alert("hi"); }\n',
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 10,
		});

		expect(result.runners).toContain("ast-grep-napi");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					filePath: path.join(srcDir, "ui.ts"),
					runner: "ast-grep-napi",
					tool: "ast-grep-napi",
					rule: "no-alert",
					source: "project-scan",
				}),
			]),
		);
	});

	it("excludes ignored/excluded files from the ast-grep scan (#308)", async () => {
		// node_modules is a canonical excluded dir — its violations must not surface.
		const vendored = path.join(tmp, "node_modules", "pkg");
		fs.mkdirSync(vendored, { recursive: true });
		fs.writeFileSync(
			path.join(vendored, "index.ts"),
			'export function n() { alert("vendored"); }\n',
		);

		const result = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			maxFiles: 50,
		});

		expect(
			result.diagnostics.filter((d) => d.filePath.includes("node_modules")),
		).toHaveLength(0);
	});
});
