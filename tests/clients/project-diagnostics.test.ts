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
import { jscpdResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/jscpd.js";
import { circularDepsToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/madge.js";
import { gitleaksResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/gitleaks.js";
import { govulncheckResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/govulncheck.js";
import { trivyResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/trivy.js";
import { opengrepResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/opengrep.js";
import { deadCodeResultToProjectDiagnostics } from "../../clients/project-diagnostics/runner-adapters/dead-code.js";
import { extractCachedProjectDiagnostics } from "../../clients/project-diagnostics/extractors.js";
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

	it("maps a jscpd clone to a diagnostic on BOTH ends, each naming the other", () => {
		const diags = jscpdResultToProjectDiagnostics(tmp, {
			success: true,
			duplicatedLines: 18,
			totalLines: 100,
			percentage: 18,
			clones: [
				{ fileA: "src/a.ts", startA: 42, fileB: "src/b.ts", startB: 80, lines: 18, tokens: 120 },
			],
		});

		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: path.join(tmp, "src/a.ts"),
			line: 42,
			severity: "warning",
			runner: "jscpd",
			rule: "jscpd:duplicate",
			message: `Duplicate code (18 lines) — also at ${path.join("src", "b.ts")}:80`,
		});
		expect(diags[1]).toMatchObject({
			filePath: path.join(tmp, "src/b.ts"),
			line: 80,
			message: `Duplicate code (18 lines) — also at ${path.join("src", "a.ts")}:42`,
		});
	});

	it("returns no jscpd diagnostics on a failed or empty scan", () => {
		expect(
			jscpdResultToProjectDiagnostics(tmp, {
				success: false,
				clones: [],
				duplicatedLines: 0,
				totalLines: 0,
				percentage: 0,
			}),
		).toEqual([]);
		expect(
			jscpdResultToProjectDiagnostics(tmp, {
				success: true,
				clones: [],
				duplicatedLines: 0,
				totalLines: 10,
				percentage: 0,
			}),
		).toEqual([]);
	});

	it("maps a madge cycle to a diagnostic on EACH participating file", () => {
		const diags = circularDepsToProjectDiagnostics(tmp, [
			{ file: "src/a.ts", path: ["src/a.ts", "src/b.ts", "src/c.ts"] },
		]);

		expect(diags.map((d) => d.filePath)).toEqual([
			path.join(tmp, "src/a.ts"),
			path.join(tmp, "src/b.ts"),
			path.join(tmp, "src/c.ts"),
		]);
		for (const d of diags) {
			expect(d).toMatchObject({
				runner: "madge",
				rule: "madge:circular",
				severity: "warning",
				message: "Part of circular dependency: a.ts → b.ts → c.ts → a.ts",
			});
		}
	});

	it("dedupes a madge cycle reported from multiple anchors", () => {
		const diags = circularDepsToProjectDiagnostics(tmp, [
			{ file: "src/a.ts", path: ["src/a.ts", "src/b.ts"] },
			{ file: "src/b.ts", path: ["src/b.ts", "src/a.ts"] }, // same cycle, other anchor
		]);
		// Same member set → emitted once (one diagnostic per file, not per anchor).
		expect(diags).toHaveLength(2);
	});

	it("maps gitleaks secrets to BLOCKING diagnostics", () => {
		const [diag] = gitleaksResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "2026-01-01T00:00:00.000Z",
			findings: [
				{
					ruleId: "aws-access-key",
					description: "AWS Access Key",
					file: "src/config.ts",
					startLine: 12,
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "src/config.ts"),
			line: 12,
			severity: "error",
			semantic: "blocking",
			runner: "gitleaks",
			rule: "gitleaks:aws-access-key",
			message: "Potential secret: AWS Access Key",
		});
	});

	it("maps an opengrep ERROR finding to a BLOCKING diagnostic, with CWE in the message", () => {
		const [diag] = opengrepResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "2026-01-01T00:00:00.000Z",
			findings: [
				{
					checkId: "python.lang.security.audit.subprocess-shell-true",
					path: "src/run.py",
					startLine: 7,
					startCol: 3,
					endLine: 7,
					endCol: 20,
					message: "shell=True is dangerous",
					severity: "ERROR",
					cwe: ["CWE-78: OS Command Injection"],
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "src/run.py"),
			line: 7,
			column: 3,
			severity: "error",
			semantic: "blocking",
			runner: "opengrep",
			rule: "opengrep:python.lang.security.audit.subprocess-shell-true",
			message: "shell=True is dangerous (CWE-78: OS Command Injection)",
		});
	});

	it("maps an opengrep WARNING/INFO finding to a non-blocking diagnostic", () => {
		const diags = opengrepResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			findings: [
				{
					checkId: "generic.warning-rule",
					path: "src/a.ts",
					startLine: 1,
					startCol: 1,
					endLine: 1,
					endCol: 1,
					message: "warn finding",
					severity: "WARNING",
				},
				{
					checkId: "generic.info-rule",
					path: "src/b.ts",
					startLine: 1,
					startCol: 1,
					endLine: 1,
					endCol: 1,
					message: "info finding",
					severity: "INFO",
				},
			],
		});
		expect(diags[0]).toMatchObject({ severity: "warning", semantic: "warning" });
		expect(diags[1]).toMatchObject({ severity: "info", semantic: "warning" });
	});

	it("returns no opengrep diagnostics on a failed or empty scan", () => {
		expect(
			opengrepResultToProjectDiagnostics(tmp, {
				success: false,
				findings: [],
				scannedAt: "",
			}),
		).toEqual([]);
		expect(
			opengrepResultToProjectDiagnostics(tmp, {
				success: true,
				findings: [],
				scannedAt: "",
			}),
		).toEqual([]);
	});

	it("anchors a govulncheck finding at the first traced source frame", () => {
		const [diag] = govulncheckResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			findings: [
				{
					osv: "GO-2024-1",
					packageName: "golang.org/x/net",
					fixedVersion: "0.23.0",
					summary: "HTTP/2 flood",
					trace: [
						{ filename: "internal/server.go", line: 88 },
						{ filename: "vendor/x/net/http2.go", line: 10 },
					],
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "internal/server.go"),
			line: 88,
			severity: "warning",
			runner: "govulncheck",
			rule: "govulncheck:GO-2024-1",
			message: "Vulnerability GO-2024-1: HTTP/2 flood (fixed in 0.23.0)",
		});
	});

	it("anchors a trivy CVE at its manifest target (no line)", () => {
		const [diag] = trivyResultToProjectDiagnostics(tmp, {
			success: true,
			scannedAt: "",
			secrets: [],
			licenses: [],
			findings: [
				{
					vulnerabilityId: "CVE-2024-9",
					pkgName: "lodash",
					installedVersion: "4.17.20",
					fixedVersion: "4.17.21",
					severity: "HIGH",
					target: "package-lock.json",
				},
			],
		});
		expect(diag).toMatchObject({
			filePath: path.join(tmp, "package-lock.json"),
			severity: "warning",
			runner: "trivy",
			rule: "trivy:CVE-2024-9",
			message: "HIGH vulnerability CVE-2024-9 in lodash@4.17.20 (fixed in 4.17.21)",
		});
		expect(diag.line).toBeUndefined();
	});

	it("flattens dead-code buckets; unlisted deps are blocking", () => {
		const diags = deadCodeResultToProjectDiagnostics(tmp, {
			success: true,
			language: "python",
			summary: "",
			unusedExports: [
				{ category: "export", kind: "function", name: "foo", file: "a.py", line: 4 },
			],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [
				{ category: "unlisted", kind: "import", name: "requests", file: "b.py", line: 1 },
			],
		});
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: path.join(tmp, "a.py"),
			line: 4,
			semantic: "warning",
			runner: "dead-code-python",
			rule: "dead-code:export",
			message: "Unused function foo",
		});
		expect(diags[1]).toMatchObject({
			semantic: "blocking",
			rule: "dead-code:unlisted",
			message: "Unlisted dependency requests",
		});
	});
});

describe("extractCachedProjectDiagnostics (registry)", () => {
	function cacheManagerWith(data: Record<string, unknown>) {
		return {
			readCache: (key: string) =>
				data[key] ? { data: data[key] } : null,
		} as unknown as import("../../clients/cache-manager.js").CacheManager;
	}

	it("reads each analyzer's cache and reports which runners contributed", () => {
		const cm = cacheManagerWith({
			"jscpd-ts": {
				success: true,
				duplicatedLines: 5,
				totalLines: 50,
				percentage: 10,
				clones: [
					{ fileA: "a.ts", startA: 1, fileB: "b.ts", startB: 2, lines: 5, tokens: 9 },
				],
			},
			gitleaks: {
				success: true,
				scannedAt: "",
				findings: [{ ruleId: "x", file: "c.ts", startLine: 3 }],
			},
			madge: { circular: [{ file: "d.ts", path: ["d.ts", "e.ts"] }], count: 1 },
			govulncheck: {
				success: true,
				scannedAt: "",
				findings: [{ osv: "GO-1", trace: [{ filename: "m.go", line: 2 }] }],
			},
			trivy: {
				success: true,
				scannedAt: "",
				secrets: [],
				licenses: [],
				findings: [
					{ vulnerabilityId: "CVE-1", pkgName: "p", severity: "LOW", target: "go.sum" },
				],
			},
			"dead-code-python": {
				success: true,
				language: "python",
				summary: "",
				unusedExports: [
					{ category: "export", kind: "func", name: "x", file: "z.py", line: 9 },
				],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
			},
			opengrep: {
				success: true,
				scannedAt: "",
				findings: [
					{
						checkId: "python.lang.security.audit.subprocess-shell-true",
						path: "f.py",
						startLine: 3,
						startCol: 1,
						endLine: 3,
						endCol: 5,
						message: "shell=True is dangerous",
						severity: "ERROR",
					},
				],
			},
		});

		const { diagnostics, runners } = extractCachedProjectDiagnostics(cm, tmp);

		// jscpd 2 + gitleaks 1 + madge 2 + govulncheck 1 + trivy 1 + dead-code 1 + opengrep 1 = 9
		expect(diagnostics).toHaveLength(9);
		expect(runners.sort()).toEqual([
			"dead-code",
			"gitleaks",
			"govulncheck",
			"jscpd",
			"madge",
			"opengrep",
			"trivy",
		]);
	});

	it("prefers jscpd-ts over jscpd, and skips analyzers with no cache", () => {
		const cm = cacheManagerWith({
			jscpd: {
				success: true,
				duplicatedLines: 1,
				totalLines: 1,
				percentage: 1,
				clones: [
					{ fileA: "a.ts", startA: 1, fileB: "b.ts", startB: 2, lines: 5, tokens: 9 },
				],
			},
		});
		const { runners } = extractCachedProjectDiagnostics(cm, tmp);
		expect(runners).toEqual(["jscpd"]);
	});

	it("returns nothing when no analyzer has cached results", () => {
		const { diagnostics, runners } = extractCachedProjectDiagnostics(
			cacheManagerWith({}),
			tmp,
		);
		expect(diagnostics).toEqual([]);
		expect(runners).toEqual([]);
	});

	// #533: a cache-key miss must be reported as `cold`, distinct from an
	// analyzer that ran and legitimately found nothing (which would still have
	// written a cache entry — see runtime-session.ts's writeCache calls, always
	// fired with the full result object even when empty).
	it("reports every unhit analyzer as cold, never silently as clean", () => {
		const { diagnostics, runners, cold } = extractCachedProjectDiagnostics(
			cacheManagerWith({}),
			tmp,
		);
		expect(diagnostics).toEqual([]);
		expect(runners).toEqual([]);
		expect(cold.sort()).toEqual(
			[
				"knip",
				"jscpd",
				"madge",
				"gitleaks",
				"govulncheck",
				"trivy",
				"dead-code",
				"opengrep",
				"test-runner",
			].sort(),
		);
	});

	// #628 item 4: cache-only extractor for the per-edit test-runner findings —
	// same shape as every other row here (readCache, adapt, never relaunch).
	it("adapts cached test-runner findings into per-file diagnostics", () => {
		const cm = cacheManagerWith({
			"test-runner-findings": {
				content: "[Tests] ✗ 1/2 failed — vitest",
				stale: false,
				results: [
					{
						file: "src/foo.test.ts",
						sourceFile: "src/foo.ts",
						runner: "vitest",
						passed: 1,
						failed: 1,
						skipped: 0,
						failures: [
							{ name: "does the thing", message: "expected 1 to be 2" },
						],
						duration: 12,
					},
				],
			},
		});

		const { diagnostics, runners } = extractCachedProjectDiagnostics(cm, tmp);
		expect(runners).toContain("test-runner");
		const testDiag = diagnostics.find((d) => d.tool === "test-runner");
		expect(testDiag).toBeDefined();
		expect(testDiag?.filePath).toBe("src/foo.test.ts");
		expect(testDiag?.message).toContain("does the thing");
		expect(testDiag?.message).toContain("expected 1 to be 2");
		expect(testDiag?.semantic).toBe("blocking");
	});

	it("does not surface a test-runner diagnostic for an all-passing cached result", () => {
		const cm = cacheManagerWith({
			"test-runner-findings": {
				content: "",
				stale: false,
				results: [
					{
						file: "src/foo.test.ts",
						sourceFile: "src/foo.ts",
						runner: "vitest",
						passed: 3,
						failed: 0,
						skipped: 0,
						failures: [],
						duration: 12,
					},
				],
			},
		});

		const { diagnostics, runners } = extractCachedProjectDiagnostics(cm, tmp);
		expect(diagnostics.filter((d) => d.tool === "test-runner")).toEqual([]);
		// No findings contributed, but the cache entry existed — not cold either
		// way (checked implicitly: runners list just doesn't include it here).
		expect(runners).not.toContain("test-runner");
	});

	it("does not mark an analyzer cold once it has a cache entry, clean or not", () => {
		const { cold } = extractCachedProjectDiagnostics(
			cacheManagerWith({
				jscpd: {
					success: true,
					duplicatedLines: 0,
					totalLines: 10,
					percentage: 0,
					clones: [],
				},
			}),
			tmp,
		);
		expect(cold).not.toContain("jscpd");
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
