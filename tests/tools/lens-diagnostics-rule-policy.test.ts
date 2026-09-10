/**
 * Tests for the project-level rule policy integration in `lens_diagnostics`
 * (rules.<id>.disable / rules.<id>.select). The policy filter overlays all
 * three modes (delta, all, full) so a project's `.pi-lens.json` is the
 * single source of truth across the per-edit dispatcher, the cache-only
 * tool reads, and the active scan's merge.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "../clients/test-utils.js";

// Mock the same heavy modules the lens-diagnostics tests already mock, so
// these tests run quickly without spinning up real scanners/analyzers.
const projectDiagnosticsMocks = vi.hoisted(() => ({
	scanProjectDiagnostics: vi.fn(),
	loadProjectDiagnosticsSnapshot: vi.fn(),
	loadProjectDiagnosticsDeltaReport: vi.fn(),
}));

const freshFetchMocks = vi.hoisted(() => ({
	fetchFreshProjectDiagnostics: vi.fn(),
}));

// #1623 fix-round F6: `ANALYZER_IDS` flows through from the real module via
// `importOriginal` rather than a hand-duplicated array — see the sibling
// mock in lens-diagnostics.test.ts for the full rationale.
vi.mock(
	"../../clients/project-diagnostics/fresh-fetch.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../clients/project-diagnostics/fresh-fetch.js")
			>();
		return {
			...actual,
			fetchFreshProjectDiagnostics:
				freshFetchMocks.fetchFreshProjectDiagnostics,
		};
	},
);

vi.mock("../../clients/bootstrap.js", () => ({
	loadBootstrapClients: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../clients/project-diagnostics/scanner.js", () => ({
	scanProjectDiagnostics: projectDiagnosticsMocks.scanProjectDiagnostics,
}));

vi.mock("../../clients/project-diagnostics/cache.js", () => ({
	PROJECT_DIAGNOSTICS_CACHE_VERSION: 2,
	loadProjectDiagnosticsSnapshot:
		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot,
	loadProjectDiagnosticsDeltaReport:
		projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport,
	reconcileProjectDiagnosticsSnapshot: (
		snapshot: import("../../clients/project-diagnostics/types.js").ProjectDiagnosticsSnapshot,
	) => ({ snapshot, staleDropped: 0 }),
}));

const mockSummaries: ReturnType<
	(typeof import("../../clients/widget-state.js"))["getFileDiagnosticSummaries"]
> = [];

// Spread the real module instead of hand-listing its exports. A full-replace
// factory silently rots: `tools/lens-diagnostics.ts` imports a NEW widget-state
// export and every test using this mock dies with "No <name> export is defined
// on the mock", far from the change that caused it. Only the side-effecting
// seams below are stubbed; pure helpers such as `widgetDiagnosticUri` stay real.
vi.mock("../../clients/widget-state.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/widget-state.js")>();
	return {
		...actual,
		getFileDiagnosticSummaries: () => mockSummaries,
		reconcileStaleWidgetFiles: async () => 0,
		reconcileStaleWidgetDependencyBlockers: async () => 0,
		reconcileScanDiagnostics: vi.fn().mockReturnValue(true),
		reconcileCorrelatedScanDiagnostics: vi.fn(),
	};
});

function makeCacheManager(data: Record<string, unknown> = {}) {
	return {
		readCache: vi.fn((key: string) =>
			data[key]
				? { data: data[key], meta: { savedAt: "", scanner: key } }
				: undefined,
		),
	};
}

function makeTool(
	cwd: string,
	cacheData: Record<string, unknown> = {},
	lspService?: unknown,
) {
	return createLensDiagnosticsTool(
		makeCacheManager(cacheData) as any,
		() => cwd,
		() => lspService as any,
	);
}

function run(
	tool: ReturnType<typeof makeTool>,
	params: Record<string, unknown> = {},
	cwd: string,
) {
	return tool.execute("1", params, new AbortController().signal, null, { cwd });
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-policy-diag-"));
	projectDiagnosticsMocks.scanProjectDiagnostics.mockReset();
	projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReset();
	projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReset();
	freshFetchMocks.fetchFreshProjectDiagnostics.mockReset();
	freshFetchMocks.fetchFreshProjectDiagnostics.mockResolvedValue({
		diagnostics: [],
		runners: [],
		cold: [],
		timings: {},
	});
	mockSummaries.length = 0;
	resetProjectLensConfigCache();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	resetProjectLensConfigCache();
});

describe("lens_diagnostics rule policy — delta mode", () => {
	it("drops a disabled rule from the actionable warnings cache", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const tool = makeTool(tmpDir, {
			"actionable-warnings": {
				files: [
					{
						filePath: path.join(tmpDir, "src/foo.ts"),
						warnings: [
							{
								line: 1,
								rule: "no-eval",
								tool: "ast-grep",
								message: "MSG-NO-EVAL",
							},
							{
								line: 2,
								rule: "no-debugger",
								tool: "ast-grep",
								message: "MSG-NO-DEBUGGER",
							},
						],
					},
				],
				summary: { warnings: 2 },
			},
		});

		const result = await run(tool, { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-NO-DEBUGGER");
		expect(text).not.toContain("MSG-NO-EVAL");
		expect(result.details).toMatchObject({ actionableWarnings: 1 });
	});

	it("drops a disabled rule that surfaces under ast-grep: prefix (normalization shared)", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const tool = makeTool(tmpDir, {
			"actionable-warnings": {
				files: [
					{
						filePath: path.join(tmpDir, "src/foo.ts"),
						warnings: [
							{
								line: 1,
								rule: "ast-grep:no-eval",
								tool: "ast-grep",
								message: "MSG-LSP-NO-EVAL",
							},
						],
					},
				],
				summary: { warnings: 1 },
			},
		});

		const result = await run(tool, { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		// The disabled rule's message is dropped — the response renders as
		// "no issues" with the warnings count at 0.
		expect(text).not.toContain("MSG-LSP-NO-EVAL");
		const details = result.details as {
			warnings?: number;
			actionableWarnings?: number;
		};
		expect(details.warnings ?? details.actionableWarnings ?? 0).toBe(0);
	});

	it("drops a disabled rule from the code-quality warnings cache", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-unused-vars": { disable: ["no-unused-vars"] } },
			}),
		);
		const tool = makeTool(tmpDir, {
			"code-quality-warnings": {
				files: [
					{
						filePath: path.join(tmpDir, "src/bar.ts"),
						warnings: [
							{
								line: 1,
								rule: "no-unused-vars",
								tool: "eslint",
								message: "MSG-UNUSED",
							},
							{
								line: 2,
								rule: "high-complexity",
								tool: "complexity",
								message: "MSG-COMPLEXITY",
							},
						],
					},
				],
				summary: { warnings: 2 },
			},
		});

		const result = await run(tool, { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-COMPLEXITY");
		expect(text).not.toContain("MSG-UNUSED");
		expect(result.details).toMatchObject({ qualityIssues: 1 });
	});

	it("a project-wide select narrows the actionable warnings cache", async () => {
		// select is the big hammer — a call site that forgets the filter fails
		// open here, so the cache-only paths need their own coverage, not just
		// mode=full's.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "my-rule-set": { select: ["no-debugger"] } },
			}),
		);
		const tool = makeTool(tmpDir, {
			"actionable-warnings": {
				files: [
					{
						filePath: path.join(tmpDir, "src/foo.ts"),
						warnings: [
							{
								line: 1,
								rule: "no-eval",
								tool: "ast-grep",
								message: "MSG-NO-EVAL",
							},
							{
								line: 2,
								rule: "no-debugger",
								tool: "ast-grep",
								message: "MSG-NO-DEBUGGER",
							},
						],
					},
				],
				summary: { warnings: 2 },
			},
		});

		const result = await run(tool, { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-NO-DEBUGGER");
		expect(text).not.toContain("MSG-NO-EVAL");
		expect(result.details).toMatchObject({ actionableWarnings: 1 });
	});

	it("drops a disabled rule from the project-diagnostics delta report", async () => {
		// filterDeltaReportDispositions is reached only from formatDeltaMode —
		// mode=full's coverage of the same report says nothing about this path.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const filePath = path.join(tmpDir, "src/foo.ts");
		// #1634 review round R3: appendProjectDiagnosticsDeltaLines now
		// freshness-gates against the report's own `generatedAt` — needs a REAL
		// file (a fixed fake path would be dropped as missing), and a
		// `generatedAt` after the file's write so the gate reads it live.
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const x = 1;\n");
		const generatedAt = new Date(Date.now() + 60_000).toISOString();
		projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReturnValue({
			version: 1,
			cwd: tmpDir,
			generatedAt,
			sessionId: "s1",
			turnIndex: 1,
			diagnostics: [
				{
					filePath,
					line: 7,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-eval",
					message: "MSG-DELTA-NO-EVAL",
					source: "project-scan",
				},
				{
					filePath,
					line: 8,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-debugger",
					message: "MSG-DELTA-NO-DEBUGGER",
					source: "project-scan",
				},
			],
			sources: ["tree-sitter"],
		});

		const result = await run(makeTool(tmpDir), { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-DELTA-NO-DEBUGGER");
		expect(text).not.toContain("MSG-DELTA-NO-EVAL");
	});

	it("does not change output when no project rule policy is configured", async () => {
		// No `.pi-lens.json` is written → no policy applies → keep everything.
		const tool = makeTool(tmpDir, {
			"actionable-warnings": {
				files: [
					{
						filePath: path.join(tmpDir, "src/foo.ts"),
						warnings: [{ line: 1, rule: "no-eval", tool: "t", message: "MSG" }],
					},
				],
				summary: { warnings: 1 },
			},
		});

		const result = await run(tool, { mode: "delta" }, tmpDir);
		expect(result.details).toMatchObject({ actionableWarnings: 1 });
	});
});

describe("lens_diagnostics rule policy — delta mode carried-over tally", () => {
	it("excludes a disabled rule from the 'carried over' count when the turn delta is empty", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		// No actionable/quality/project-delta cache data — the delta text falls
		// through to reporting `getFileDiagnosticSummaries()` as "carried over
		// from earlier this session".
		mockSummaries.push({
			filePath: path.join(tmpDir, "src/foo.ts"),
			blocking: 0,
			errors: 0,
			warnings: 2,
			advisories: 0,
			hasFinalSnapshot: true,
			diagnostics: [
				{
					severity: "warning",
					message: "MSG-NO-EVAL",
					line: 1,
					rule: "no-eval",
					tool: "ast-grep",
				},
				{
					severity: "warning",
					message: "MSG-NO-DEBUGGER",
					line: 2,
					rule: "no-debugger",
					tool: "ast-grep",
				},
			],
		});

		const result = await run(makeTool(tmpDir), { mode: "delta" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("1 finding across 1 file carried over");
		expect(text).not.toContain("2 findings across 1 file carried over");
	});
});

describe("lens_diagnostics rule policy — mode=all (cache-only)", () => {
	it("drops a disabled rule from a file's cached widget diagnostics", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		mockSummaries.push({
			filePath: path.join(tmpDir, "src/foo.ts"),
			blocking: 0,
			errors: 0,
			warnings: 2,
			advisories: 0,
			hasFinalSnapshot: true,
			diagnostics: [
				{
					severity: "warning",
					message: "MSG-NO-EVAL",
					line: 1,
					rule: "no-eval",
					tool: "ast-grep",
				},
				{
					severity: "warning",
					message: "MSG-NO-DEBUGGER",
					line: 2,
					rule: "no-debugger",
					tool: "ast-grep",
				},
			],
		});

		const result = await run(makeTool(tmpDir), { mode: "all" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-NO-DEBUGGER");
		expect(text).not.toContain("MSG-NO-EVAL");
		// Counts reflect the policy drop.
		expect(result.details).toMatchObject({ totalWarnings: 1 });
	});

	it("a project-wide select narrows a file's cached widget diagnostics", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "my-rule-set": { select: ["no-debugger"] } },
			}),
		);
		mockSummaries.push({
			filePath: path.join(tmpDir, "src/foo.ts"),
			blocking: 0,
			errors: 0,
			warnings: 2,
			advisories: 0,
			hasFinalSnapshot: true,
			diagnostics: [
				{
					severity: "warning",
					message: "MSG-NO-EVAL",
					line: 1,
					rule: "no-eval",
					tool: "ast-grep",
				},
				{
					severity: "warning",
					message: "MSG-NO-DEBUGGER",
					line: 2,
					rule: "no-debugger",
					tool: "ast-grep",
				},
			],
		});

		const result = await run(makeTool(tmpDir), { mode: "all" }, tmpDir);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-NO-DEBUGGER");
		expect(text).not.toContain("MSG-NO-EVAL");
		expect(result.details).toMatchObject({ totalWarnings: 1 });
	});

	it("does not filter when no policy applies (no project config)", async () => {
		mockSummaries.push({
			filePath: path.join(tmpDir, "src/foo.ts"),
			blocking: 0,
			errors: 0,
			warnings: 1,
			advisories: 0,
			hasFinalSnapshot: true,
			diagnostics: [
				{
					severity: "warning",
					message: "MSG",
					line: 1,
					rule: "no-eval",
					tool: "ast-grep",
				},
			],
		});

		const result = await run(makeTool(tmpDir), { mode: "all" }, tmpDir);
		expect(result.details).toMatchObject({ totalWarnings: 1 });
	});
});

describe("lens_diagnostics rule policy — mode=full (active scan)", () => {
	it("a project-wide select narrows the mode=full gate to the listed rules", async () => {
		// mode=full is the clean gate, so select's project-wide reach has to hold
		// on the active-scan path too, not just the cache-only modes.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "my-rule-set": { select: ["no-debugger"] } },
			}),
		);
		const filePath = path.join(tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "// empty file\n");

		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
				{
					filePath,
					diagnostics: [
						{
							severity: 2,
							message: "MSG-LSP-NO-EVAL",
							range: {
								start: { line: 1, character: 0 },
								end: { line: 1, character: 5 },
							},
							source: "ast-grep",
							code: "no-eval",
						},
						{
							severity: 2,
							message: "MSG-LSP-NO-DEBUGGER",
							range: {
								start: { line: 2, character: 0 },
								end: { line: 2, character: 5 },
							},
							source: "ast-grep",
							code: "no-debugger",
						},
					],
					count: 2,
				},
			]),
		};

		const result = await run(
			makeTool(tmpDir, {}, lspService),
			{ mode: "full" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-LSP-NO-DEBUGGER");
		expect(text).not.toContain("MSG-LSP-NO-EVAL");
	});

	it("drops a disabled rule from a fresh LSP sweep result", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		// mode=full's policy filter runs inside `applyInlineSuppressionsToSummaries`,
		// which reads the file content first. Create the file so the read
		// succeeds and the policy path actually executes.
		const filePath = path.join(tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "// empty file\n");

		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
				{
					filePath,
					diagnostics: [
						{
							severity: 2,
							message: "MSG-LSP-NO-EVAL",
							range: {
								start: { line: 1, character: 0 },
								end: { line: 1, character: 5 },
							},
							source: "ast-grep",
							code: "no-eval",
						},
						{
							severity: 2,
							message: "MSG-LSP-NO-DEBUGGER",
							range: {
								start: { line: 2, character: 0 },
								end: { line: 2, character: 5 },
							},
							source: "ast-grep",
							code: "no-debugger",
						},
					],
					count: 2,
				},
			]),
		};

		const result = await run(
			makeTool(tmpDir, {}, lspService),
			{ mode: "full" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-LSP-NO-DEBUGGER");
		expect(text).not.toContain("MSG-LSP-NO-EVAL");
	});

	it("applies policy even when a fresh full-mode file cannot be reread", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		// The LSP sweep can return a diagnostic for a file that disappears before
		// the content-based suppression pass. Policy filtering must not depend on
		// that second read succeeding.
		const filePath = path.join(tmpDir, "src", "deleted.ts");
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
				{
					filePath,
					diagnostics: [
						{
							severity: 2,
							message: "MSG-LSP-NO-EVAL-DELETED",
							range: {
								start: { line: 1, character: 0 },
								end: { line: 1, character: 5 },
							},
							source: "ast-grep",
							code: "no-eval",
						},
					],
					count: 1,
				},
			]),
		};

		const result = await run(
			makeTool(tmpDir, {}, lspService),
			{ mode: "full" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		expect(text).not.toContain("MSG-LSP-NO-EVAL-DELETED");
	});

	it("drops a disabled rule from the project-diagnostics snapshot", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		// Same reason as above — `applyInlineSuppressionsToSummaries` reads the
		// file first; the merged-snapshot path needs the file to exist for the
		// policy filter to actually run.
		const filePath = path.join(tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "// empty file\n");

		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
			version: 1,
			cwd: tmpDir,
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 1,
			runners: ["tree-sitter", "fact-rules"],
			diagnostics: [
				{
					filePath,
					line: 5,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-eval",
					message: "MSG-PROJECT-NO-EVAL",
					source: "project-scan",
				},
				{
					filePath,
					line: 6,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-debugger",
					message: "MSG-PROJECT-NO-DEBUGGER",
					source: "project-scan",
				},
			],
		});

		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};

		const result = await run(
			makeTool(tmpDir, {}, lspService),
			{ mode: "full", refreshRunners: "cached" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		expect(text).toContain("MSG-PROJECT-NO-DEBUGGER");
		expect(text).not.toContain("MSG-PROJECT-NO-EVAL");
	});

	it("applies policy consistently to code-only project diagnostics", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const filePath = path.join(tmpDir, "src", "foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "// empty file\n");

		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
			version: 1,
			cwd: tmpDir,
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 1,
			runners: ["tree-sitter"],
			diagnostics: [
				{
					filePath,
					line: 5,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					code: "no-eval",
					message: "MSG-CODE-ONLY-NO-EVAL",
					source: "project-scan",
				},
			],
		});

		const result = await run(
			makeTool(
				tmpDir,
				{},
				{ runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]) },
			),
			{ mode: "full", refreshRunners: "cached" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		const details = result.details as {
			projectDiagnostics?: { diagnostics: number };
		};
		expect(details.projectDiagnostics?.diagnostics).toBe(0);
		expect(text).not.toContain("MSG-CODE-ONLY-NO-EVAL");
	});

	it("details.projectDiagnostics/projectDiagnosticsDelta counts reflect the post-policy set", async () => {
		// The structured `details` counts are computed from `projectSnapshot`/
		// `projectDelta` BEFORE the merge into `summaries` — they must already
		// be post-policy, or `details` disagrees with both the rendered text
		// and totalWarnings/totalErrors.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				rules: { "no-eval": { disable: ["no-eval"] } },
			}),
		);
		const filePath = path.join(tmpDir, "src/foo.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "// empty file\n");

		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
			version: 1,
			cwd: tmpDir,
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 1,
			runners: ["tree-sitter"],
			diagnostics: [
				{
					filePath,
					line: 5,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-eval",
					message: "MSG-SNAPSHOT-NO-EVAL",
					source: "project-scan",
				},
				{
					filePath,
					line: 6,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-debugger",
					message: "MSG-SNAPSHOT-NO-DEBUGGER",
					source: "project-scan",
				},
			],
		});
		projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReturnValue({
			version: 1,
			cwd: tmpDir,
			generatedAt: "2026-01-01T00:00:00.000Z",
			sessionId: "s1",
			turnIndex: 1,
			diagnostics: [
				{
					filePath,
					line: 7,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-eval",
					message: "MSG-DELTA-NO-EVAL",
					source: "project-scan",
				},
				{
					filePath,
					line: 8,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "no-debugger",
					message: "MSG-DELTA-NO-DEBUGGER",
					source: "project-scan",
				},
			],
			sources: ["tree-sitter"],
		});

		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};

		const result = await run(
			makeTool(tmpDir, {}, lspService),
			{ mode: "full", refreshRunners: "cached" },
			tmpDir,
		);
		const text = String(result.content[0].text);
		const details = result.details as {
			projectDiagnostics?: { diagnostics: number };
			projectDiagnosticsDelta?: { diagnostics: number };
		};
		expect(details.projectDiagnostics?.diagnostics).toBe(1);
		expect(details.projectDiagnosticsDelta?.diagnostics).toBe(1);
		expect(text).not.toContain("MSG-SNAPSHOT-NO-EVAL");
		expect(text).not.toContain("MSG-DELTA-NO-EVAL");
	});
});
