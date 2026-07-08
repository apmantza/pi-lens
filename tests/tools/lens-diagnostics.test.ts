import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

const projectDiagnosticsMocks = vi.hoisted(() => ({
	scanProjectDiagnostics: vi.fn(),
	loadProjectDiagnosticsSnapshot: vi.fn(),
	loadProjectDiagnosticsDeltaReport: vi.fn(),
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
	// Identity passthrough — these tests exercise ignore-filtering, not on-disk
	// staleness (covered in project-diagnostics.test.ts).
	reconcileProjectDiagnosticsSnapshot: (
		snapshot: import("../../clients/project-diagnostics/types.js").ProjectDiagnosticsSnapshot,
	) => ({ snapshot, staleDropped: 0 }),
}));

// ── Mock widget state ─────────────────────────────────────────────────────────

const mockSummaries: ReturnType<
	typeof import("../../clients/widget-state.js")["getFileDiagnosticSummaries"]
> = [];

let mockStaleDropped = 0;

vi.mock("../../clients/widget-state.js", () => ({
	getFileDiagnosticSummaries: () => mockSummaries,
	reconcileStaleWidgetFiles: async () => mockStaleDropped,
}));

beforeEach(() => {
	projectDiagnosticsMocks.scanProjectDiagnostics.mockReset();
	projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReset();
	projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReset();
	mockSummaries.length = 0;
	mockStaleDropped = 0;
	resetProjectLensConfigCache();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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
	cacheData: Record<string, unknown> = {},
	lspService?: unknown,
) {
	return createLensDiagnosticsTool(
		makeCacheManager(cacheData) as any,
		() => "/proj",
		() => lspService as any,
	);
}

function run(
	tool: ReturnType<typeof makeTool>,
	params: Record<string, unknown> = {},
	cwd = "/proj",
) {
	return tool.execute("1", params, new AbortController().signal, null, { cwd });
}

function withIgnoredFixture<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-diag-ignore-"));
	fs.writeFileSync(
		path.join(cwd, ".pi-lens.json"),
		JSON.stringify({
			ignore: ["**/.history/**", "pi-session-*.html", "ignored/**"],
		}),
	);
	resetProjectLensConfigCache();
	return fn(cwd).finally(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		resetProjectLensConfigCache();
	});
}

// ── schema ────────────────────────────────────────────────────────────────────

describe("lens_diagnostics schema", () => {
	it("exposes mode and severity parameters", () => {
		const tool = makeTool();
		const props = (tool.parameters as { properties: Record<string, unknown> })
			.properties;
		expect(props.mode).toBeDefined();
		expect(props.severity).toBeDefined();
		expect(props.refreshRunners).toBeDefined();
	});

	it("defaults to delta mode when no params supplied", async () => {
		const cm = makeCacheManager({});
		const tool = createLensDiagnosticsTool(cm as any, () => "/proj");
		await tool.execute("1", {}, new AbortController().signal, null, {
			cwd: "/proj",
		});
		// readCache should have been called (delta path)
		expect(cm.readCache).toHaveBeenCalled();
	});

	it("mode=all does not call LSP — reads from cache only", async () => {
		const lspService = { runWorkspaceDiagnostics: vi.fn() };
		const result = await run(makeTool({}, lspService), { mode: "all" });
		expect(result).toBeDefined();
		expect(lspService.runWorkspaceDiagnostics).not.toHaveBeenCalled();
	});

	it("exposes full mode in the schema", () => {
		const tool = makeTool();
		const props = (tool.parameters as { properties: Record<string, any> })
			.properties;
		expect(props.mode.enum).toContain("full");
	});
});

// ── delta mode ────────────────────────────────────────────────────────────────

describe("lens_diagnostics mode=delta", () => {
	it("returns clean message when caches are empty", async () => {
		const result = await run(makeTool());
		expect(String(result.content[0].text)).toContain("No");
		expect(result.details).toMatchObject({ mode: "delta" });
		// No carried-over findings → no mode=all hint.
		expect(String(result.content[0].text)).not.toContain("mode=all");
	});

	it("hints at mode=all when delta is empty but findings carried over (#190)", async () => {
		// Simulate a resume: no current-turn delta, but the session-wide view has
		// rehydrated findings.
		mockSummaries.push({
			filePath: "/proj/a.ts",
			blocking: 1,
			errors: 1,
			warnings: 1,
			hasFinalSnapshot: true,
			diagnostics: [
				{ severity: "error", message: "boom", line: 5 },
				{ severity: "warning", message: "meh", line: 9 },
			],
		});

		const result = await run(makeTool(), { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("carried over");
		expect(text).toContain("mode=all");
		expect(text).toContain("2 findings across 1 file");
		expect(result.details).toMatchObject({
			mode: "delta",
			carriedOverFiles: 1,
		});
	});

	it("formats actionable warnings from cache", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath: "/proj/src/foo.ts",
						warnings: [
							{
								line: 10,
								rule: "no-unused-vars",
								tool: "eslint",
								code: undefined,
								message: "x is unused",
							},
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("foo.ts");
		expect(text).toContain("L10");
		expect(text).toContain("x is unused");
	});

	it("formats code quality warnings from cache", async () => {
		const tool = makeTool({
			"code-quality-warnings": {
				files: [
					{
						filePath: "/proj/src/bar.ts",
						warnings: [
							{
								line: 5,
								rule: "high-complexity",
								tool: "complexity",
								code: undefined,
								message: "cyclomatic complexity 20",
							},
						],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("bar.ts");
		expect(text).toContain("high-complexity");
	});

	it("combines actionable and quality warnings from both caches", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath: "/proj/src/foo.ts",
						warnings: [{ line: 1, rule: "r1", tool: "t", message: "fixable" }],
					},
				],
				summary: { warnings: 1 },
			},
			"code-quality-warnings": {
				files: [
					{
						filePath: "/proj/src/foo.ts",
						warnings: [{ line: 2, rule: "r2", tool: "t", message: "quality" }],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("fixable");
		expect(text).toContain("quality");
	});

	it("severity=error excludes warnings in delta mode", async () => {
		const tool = makeTool({
			"actionable-warnings": {
				files: [
					{
						filePath: "/proj/src/foo.ts",
						warnings: [{ line: 1, rule: "r", tool: "t", message: "warn" }],
					},
				],
				summary: { warnings: 1 },
			},
		});
		const result = await run(tool, { mode: "delta", severity: "error" });
		const text = String(result.content[0].text);
		// No actionable warnings (they're warnings, not errors)
		expect(text).toContain("No error");
	});

	it("formats project diagnostics delta records", async () => {
		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue(
			undefined,
		);
		projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReturnValue({
			version: 1,
			cwd: "/proj",
			generatedAt: "2026-01-01T00:00:00.000Z",
			sessionId: "session-1",
			turnIndex: 3,
			diagnostics: [
				{
					filePath: "/proj/src/knip.ts",
					line: 12,
					severity: "error",
					semantic: "blocking",
					tool: "knip",
					runner: "knip",
					rule: "knip:unlisted",
					message: "Unlisted dependency lodash",
					source: "project-scan",
				},
			],
			sources: ["knip"],
		});

		const result = await run(makeTool(), { mode: "delta" });
		const text = String(result.content[0].text);
		expect(text).toContain("knip.ts");
		expect(text).toContain("L12");
		expect(text).toContain("knip:unlisted");
		expect(text).toContain("Unlisted dependency lodash");
		expect(result.details).toMatchObject({ projectDiagnostics: 1 });
	});

	it("filters ignored actionable, quality, and project-delta entries (#279)", async () =>
		withIgnoredFixture(async (cwd) => {
			const ignored = path.join(cwd, ".history", "old.ts");
			const kept = path.join(cwd, "src", "keep.ts");
			const tool = makeTool({
				"actionable-warnings": {
					files: [
						{
							filePath: ignored,
							warnings: [
								{
									line: 1,
									rule: "ignored-a",
									tool: "t",
									message: "ignored actionable",
								},
							],
						},
						{
							filePath: kept,
							warnings: [
								{
									line: 2,
									rule: "kept-a",
									tool: "t",
									message: "kept actionable",
								},
							],
						},
					],
					summary: { warnings: 2 },
				},
				"code-quality-warnings": {
					files: [
						{
							filePath: ignored,
							warnings: [
								{
									line: 3,
									rule: "ignored-q",
									tool: "t",
									message: "ignored quality",
								},
							],
						},
					],
					summary: { warnings: 1 },
				},
			});
			projectDiagnosticsMocks.loadProjectDiagnosticsDeltaReport.mockReturnValue(
				{
					version: 1,
					cwd,
					generatedAt: "2026-01-01T00:00:00.000Z",
					sessionId: "session-1",
					turnIndex: 3,
					diagnostics: [
						{
							filePath: ignored,
							line: 4,
							severity: "warning",
							semantic: "warning",
							tool: "fact-rules",
							runner: "fact-rules",
							rule: "ignored-project",
							message: "ignored project delta",
							source: "project-scan",
						},
					],
					sources: ["fact-rules"],
				},
			);

			const result = await run(tool, { mode: "delta" }, cwd);
			const text = String(result.content[0].text);
			expect(text).toContain("kept actionable");
			expect(text).not.toContain("ignored actionable");
			expect(text).not.toContain("ignored quality");
			expect(text).not.toContain("ignored project delta");
			expect(result.details).toMatchObject({
				actionableWarnings: 1,
				qualityIssues: 0,
				projectDiagnostics: 0,
			});
		}));
});

// ── all mode ──────────────────────────────────────────────────────────────────

type Summary = (typeof mockSummaries)[number];
type Diag = Summary["diagnostics"][number];

function sum(
	filePath: string,
	counts: { blocking?: number; errors?: number; warnings?: number },
	opts: { hasFinalSnapshot?: boolean; diagnostics?: Diag[] } = {},
): Summary {
	return {
		filePath,
		blocking: counts.blocking ?? 0,
		errors: counts.errors ?? 0,
		warnings: counts.warnings ?? 0,
		hasFinalSnapshot: opts.hasFinalSnapshot ?? true,
		diagnostics: opts.diagnostics ?? [],
	};
}

describe("lens_diagnostics mode=full", () => {
	it("runs workspace diagnostics and merges LSP-only files with widget state", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/edited.ts",
				{ warnings: 1 },
				{
					diagnostics: [
						{
							severity: "warning",
							message: "cached runner warning",
							line: 3,
							rule: "runner-rule",
							tool: "tree-sitter",
						},
					],
				},
			),
		);
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
				{
					filePath: "/proj/src/unedited.ts",
					diagnostics: [
						{
							severity: 1,
							message: "project-wide type error",
							range: {
								start: { line: 9, character: 4 },
								end: { line: 9, character: 8 },
							},
							source: "ts",
							code: 2322,
						},
					],
					count: 1,
				},
			]),
		};

		const result = await run(makeTool({}, lspService), { mode: "full" });
		const text = String(result.content[0].text);
		expect(lspService.runWorkspaceDiagnostics).toHaveBeenCalledWith(
			"/proj",
			expect.objectContaining({ signal: expect.anything() }),
		);
		expect(text).toContain("edited.ts");
		expect(text).toContain("cached runner warning");
		expect(text).toContain("unedited.ts");
		expect(text).toContain("project-wide type error");
		expect(text).toContain("ts:2322");
		expect(result.details).toMatchObject({
			mode: "full",
			lspFilesChecked: 1,
			totalBlocking: 1,
			totalWarnings: 1,
		});
	});

	it("honors inline `# pi-lens-ignore` like mode=all (#442)", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-diag-suppress-"));
		resetProjectLensConfigCache();
		try {
			const file = path.join(cwd, "app.py");
			fs.writeFileSync(
				file,
				"value = eval(userInput)  # pi-lens-ignore: no-eval\n",
			);
			mockSummaries.length = 0;
			mockSummaries.push(
				sum(
					file,
					{ blocking: 1 },
					{
						diagnostics: [
							{
								severity: "error",
								semantic: "blocking",
								message: "eval of untrusted input",
								line: 1,
								rule: "no-eval",
								tool: "ast-grep",
							},
						],
					},
				),
			);
			const lspService = {
				runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
			};
			const tool = createLensDiagnosticsTool(
				makeCacheManager({}) as any,
				() => cwd,
				() => lspService as any,
			);
			const result = await tool.execute(
				"1",
				{ mode: "full" },
				new AbortController().signal,
				null,
				{ cwd },
			);
			const text = String(result.content[0].text);
			// The suppressed finding must NOT appear and must NOT count as blocking
			// (a fully-suppressed run reports clean, so totalBlocking is 0/absent).
			expect(text).not.toContain("eval of untrusted input");
			expect(
				(result.details as { totalBlocking?: number }).totalBlocking ?? 0,
			).toBe(0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
			resetProjectLensConfigCache();
		}
	});

	it("forwards maxLspFiles to the LSP workspace sweep as maxFiles (#341)", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		await run(makeTool({}, lspService), { mode: "full", maxLspFiles: 200 });
		expect(lspService.runWorkspaceDiagnostics).toHaveBeenCalledWith(
			"/proj",
			expect.objectContaining({ maxFiles: 200 }),
		);
	});

	it("threads the abort signal to the LSP sweep and flags partial results (#341)", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		const controller = new AbortController();
		controller.abort();
		const tool = makeTool({}, lspService);
		const result = await tool.execute(
			"1",
			{ mode: "full", maxLspFiles: 50 },
			controller.signal,
			null,
			{ cwd: "/proj" },
		);
		const passed = lspService.runWorkspaceDiagnostics.mock.calls[0][1];
		// The sweep receives a COMBINED signal now (tool-call + ctx + wall-clock
		// ceiling), so assert its aborted state, not object identity.
		expect(passed.signal.aborted).toBe(true);
		const text = String(result.content[0].text);
		expect(text).toContain("Scan cancelled before completion");
		expect(result.details).toMatchObject({ mode: "full", partial: true });
	});

	it("refreshRunners=cheap scans cheap project runners and merges their cached snapshot", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		projectDiagnosticsMocks.scanProjectDiagnostics.mockResolvedValue({
			version: 1,
			cwd: "/proj",
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 2,
			runners: ["tree-sitter", "fact-rules", "ast-grep-napi"],
			diagnostics: [
				{
					filePath: "/proj/src/project.ts",
					line: 4,
					column: 2,
					severity: "warning",
					semantic: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: "project-rule",
					message: "project runner warning",
					source: "project-scan",
				},
			],
		});

		const result = await run(makeTool({}, lspService), {
			mode: "full",
			refreshRunners: "cheap",
			maxProjectFiles: 2,
		});
		const text = String(result.content[0].text);
		expect(projectDiagnosticsMocks.scanProjectDiagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/proj",
				tier: "cheap",
				maxFiles: 2,
			}),
		);
		expect(text).toContain("project.ts");
		expect(text).toContain("project runner warning");
		expect(result.details).toMatchObject({
			mode: "full",
			projectDiagnostics: {
				tier: "cheap",
				filesScanned: 2,
				diagnostics: 1,
			},
		});
	});

	it("refreshRunners=cached includes the stored project runner snapshot without scanning", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
			version: 1,
			cwd: "/proj",
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 1,
			runners: ["fact-rules"],
			diagnostics: [
				{
					filePath: "/proj/src/cached.ts",
					line: 8,
					severity: "error",
					semantic: "blocking",
					tool: "fact-rules",
					runner: "fact-rules",
					rule: "cached-rule",
					message: "cached project blocker",
					source: "project-scan",
				},
			],
		});

		const result = await run(makeTool({}, lspService), {
			mode: "full",
			refreshRunners: "cached",
		});
		const text = String(result.content[0].text);
		expect(
			projectDiagnosticsMocks.scanProjectDiagnostics,
		).not.toHaveBeenCalled();
		expect(
			projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot,
		).toHaveBeenCalledWith("/proj");
		expect(text).toContain("cached project blocker");
		expect(result.details).toMatchObject({ totalBlocking: 1 });
	});

	it("folds the CACHED jscpd snapshot into full mode without launching a scan (#adapters)", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		// No scanned snapshot — jscpd must synthesize one from its cache.
		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue(
			undefined,
		);
		const jscpdResult = {
			success: true,
			duplicatedLines: 18,
			totalLines: 100,
			percentage: 18,
			clones: [
				{
					fileA: "src/a.ts",
					startA: 42,
					fileB: "src/b.ts",
					startB: 80,
					lines: 18,
					tokens: 120,
				},
			],
		};

		const result = await run(makeTool({ "jscpd-ts": jscpdResult }, lspService), {
			mode: "full",
			refreshRunners: "cached",
		});

		const text = String(result.content[0].text);
		// Both ends of the clone surface, and no fresh scan was launched.
		expect(text).toContain("Duplicate code (18 lines)");
		expect(
			projectDiagnosticsMocks.scanProjectDiagnostics,
		).not.toHaveBeenCalled();
	});

	it("does not read jscpd cache when refreshRunners is not set (LSP-only full mode)", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		const cm = makeCacheManager({
			"jscpd-ts": {
				success: true,
				duplicatedLines: 1,
				totalLines: 1,
				percentage: 1,
				clones: [
					{ fileA: "src/a.ts", startA: 1, fileB: "src/b.ts", startB: 2, lines: 5, tokens: 9 },
				],
			},
		});
		const tool = createLensDiagnosticsTool(
			cm as any,
			() => "/proj",
			() => lspService as any,
		);

		const result = await tool.execute("1", { mode: "full" }, new AbortController().signal, null, {
			cwd: "/proj",
		});

		expect(String(result.content[0].text)).not.toContain("Duplicate code");
		expect(cm.readCache).not.toHaveBeenCalledWith("jscpd-ts", "/proj");
	});

	it("deduplicates LSP diagnostics already present in widget state by file line and rule", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/dup.ts",
				{ blocking: 1, errors: 1 },
				{
					diagnostics: [
						{
							severity: "error",
							semantic: "blocking",
							message: "cached dispatch message",
							line: 10,
							rule: "ts:2322",
							tool: "lsp",
						},
					],
				},
			),
		);
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
				{
					filePath: "/proj/src/dup.ts",
					diagnostics: [
						{
							severity: 1,
							message: "same diagnostic from workspace scan",
							range: {
								start: { line: 9, character: 0 },
								end: { line: 9, character: 1 },
							},
							source: "ts",
							code: 2322,
						},
					],
					count: 1,
				},
			]),
		};

		const result = await run(makeTool({}, lspService), { mode: "full" });
		const text = String(result.content[0].text);
		expect(text).toContain("cached dispatch message");
		expect(text).not.toContain("same diagnostic from workspace scan");
		expect(result.details).toMatchObject({ totalBlocking: 1, totalErrors: 1 });
	});

	it("dedups the napi project scan against ast-grep LSP findings despite the source prefix (#308)", async () => {
		// The ast-grep LSP keys its findings `ast-grep:<id>`; the napi scan (#308)
		// uses the bare `<id>`. Same violation, same line — must collapse to ONE in
		// mode=full, not double-report once the binary is present.
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/ui.ts",
				{ warnings: 1 },
				{
					diagnostics: [
						{
							severity: "warning",
							message: "Avoid alert()",
							line: 5,
							rule: "ast-grep:no-alert",
							tool: "ast-grep",
						},
					],
				},
			),
		);
		projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
			// cache.js is mocked in this file, so the version constant isn't in scope;
			// the tool path doesn't validate it (loader is mocked, reconcile is identity).
			version: 2,
			cwd: "/proj",
			tier: "cheap",
			scannedAt: "2026-01-01T00:00:00.000Z",
			filesScanned: 1,
			runners: ["tree-sitter", "fact-rules", "ast-grep-napi"],
			diagnostics: [
				{
					filePath: "/proj/src/ui.ts",
					line: 5,
					severity: "warning",
					semantic: "warning",
					tool: "ast-grep-napi",
					runner: "ast-grep-napi",
					rule: "no-alert",
					message: "Avoid alert()",
					source: "project-scan",
				},
			],
		});
		const lspService = { runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]) };

		const result = await run(makeTool({}, lspService), {
			mode: "full",
			refreshRunners: "cached",
		});
		// One warning, not two — the napi scan finding deduped against the LSP one.
		expect(result.details).toMatchObject({ totalWarnings: 1 });
	});

	it("filters ignored cached/widget/project diagnostics when merging full mode (#279)", async () =>
		withIgnoredFixture(async (cwd) => {
			const keep = path.join(cwd, "src", "keep.ts");
			const ignoredWidget = path.join(cwd, ".history", "old.ts");
			const ignoredLsp = path.join(cwd, "pi-session-2026.html");
			const ignoredProject = path.join(cwd, "ignored", "project.ts");
			mockSummaries.push(
				sum(
					keep,
					{ warnings: 1 },
					{ diagnostics: [{ severity: "warning", message: "keep", line: 1 }] },
				),
				sum(
					ignoredWidget,
					{ blocking: 1, errors: 1 },
					{
						diagnostics: [
							{
								severity: "error",
								semantic: "blocking",
								message: "old history",
								line: 2,
							},
						],
					},
				),
			);
			const lspService = {
				runWorkspaceDiagnostics: vi.fn().mockResolvedValue([
					{
						filePath: ignoredLsp,
						diagnostics: [
							{
								severity: 1,
								message: "ignored html parse error",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								source: "html",
							},
						],
					},
				]),
			};
			projectDiagnosticsMocks.loadProjectDiagnosticsSnapshot.mockReturnValue({
				version: 1,
				cwd,
				tier: "cheap",
				scannedAt: "2026-01-01T00:00:00.000Z",
				filesScanned: 1,
				runners: ["fact-rules"],
				diagnostics: [
					{
						filePath: ignoredProject,
						line: 3,
						severity: "error",
						semantic: "blocking",
						tool: "fact-rules",
						runner: "fact-rules",
						rule: "ignored-project",
						message: "ignored project blocker",
						source: "project-scan",
					},
				],
			});

			const result = await run(
				makeTool({}, lspService),
				{ mode: "full", refreshRunners: "cached" },
				cwd,
			);
			const text = String(result.content[0].text);
			expect(text).toContain("keep");
			expect(text).not.toContain("old history");
			expect(text).not.toContain("ignored html parse error");
			expect(text).not.toContain("ignored project blocker");
			expect(result.details).toMatchObject({ totalWarnings: 1 });
		}));
});

describe("lens_diagnostics mode=all", () => {
	it("returns no-files message when widget state is empty", async () => {
		mockSummaries.length = 0;
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("No files diagnosed");
	});

	it("flushes pending dispatches before reading (so just-fixed files refresh)", async () => {
		const flush = vi.fn(async () => {});
		const tool = createLensDiagnosticsTool(
			makeCacheManager({}) as any,
			() => "/proj",
			undefined,
			flush,
		);
		await tool.execute(
			"1",
			{ mode: "all" },
			new AbortController().signal,
			null,
			{
				cwd: "/proj",
			},
		);
		expect(flush).toHaveBeenCalledOnce();
	});

	it("notes stale files dropped by reconciliation (use mode=full)", async () => {
		mockStaleDropped = 2;
		mockSummaries.length = 0;
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("2 changed files omitted as stale");
		expect(text).toContain("mode=full");
		expect(result.details).toMatchObject({ staleDropped: 2 });
	});

	it("returns clean message when all files have zero issues", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/clean.ts", {}));
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("✓");
	});

	it("filters ignored widget summaries in all mode (#279)", async () =>
		withIgnoredFixture(async (cwd) => {
			mockSummaries.push(
				sum(
					path.join(cwd, "src", "keep.ts"),
					{ warnings: 1 },
					{
						diagnostics: [
							{ severity: "warning", message: "keep warning", line: 1 },
						],
					},
				),
				sum(
					path.join(cwd, ".history", "old.ts"),
					{
						blocking: 1,
						errors: 1,
					},
					{
						diagnostics: [
							{
								severity: "error",
								semantic: "blocking",
								message: "ignored history blocker",
								line: 2,
							},
						],
					},
				),
			);

			const result = await run(makeTool(), { mode: "all" }, cwd);
			const text = String(result.content[0].text);
			expect(text).toContain("keep warning");
			expect(text).not.toContain("ignored history blocker");
			expect(result.details).toMatchObject({
				filesWithIssues: 1,
				totalWarnings: 1,
			});
		}));

	it("lists files with blocking errors first", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/warn.ts", { warnings: 2 }));
		mockSummaries.push(sum("/proj/src/error.ts", { blocking: 1, errors: 1 }));
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text.indexOf("error.ts")).toBeLessThan(text.indexOf("warn.ts"));
		expect(text).toContain("🔴");
	});

	it("severity=error filters to only error/blocking files", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/src/clean.ts", { warnings: 3 }));
		mockSummaries.push(sum("/proj/src/broken.ts", { blocking: 1 }));
		const result = await run(makeTool(), { mode: "all", severity: "error" });
		const text = String(result.content[0].text);
		expect(text).toContain("broken.ts");
		expect(text).not.toContain("clean.ts");
	});

	it("shows pending indicator for files without final snapshot", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum("/proj/src/pending.ts", { errors: 1 }, { hasFinalSnapshot: false }),
		);
		const result = await run(makeTool(), { mode: "all" });
		expect(String(result.content[0].text)).toContain("pending");
	});

	it("severity=warning excludes blocking/error-only files", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/a.ts", { blocking: 1 }));
		mockSummaries.push(sum("/proj/b.ts", { warnings: 2 }));
		const result = await run(makeTool(), { mode: "all", severity: "warning" });
		const text = String(result.content[0].text);
		expect(text).toContain("b.ts");
		expect(text).not.toContain("a.ts");
	});

	it("severity=all shows all issue types", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(sum("/proj/a.ts", { blocking: 1, warnings: 2 }));
		const result = await run(makeTool(), { mode: "all", severity: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("a.ts");
		expect(text).toContain("🔴");
	});

	it("summary counts total blocking/errors/warnings", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum("/proj/a.ts", { blocking: 1, errors: 2, warnings: 3 }),
		);
		mockSummaries.push(sum("/proj/b.ts", { errors: 1, warnings: 1 }));
		const result = await run(makeTool(), { mode: "all" });
		expect(result.details).toMatchObject({
			totalBlocking: 1,
			totalErrors: 3,
			totalWarnings: 4,
		});
	});

	// ── actual-message exposure (the point of the tool) ───────────────────────────

	it("lists the actual diagnostic messages, not just counts", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/foo.ts",
				{ blocking: 1, warnings: 1 },
				{
					diagnostics: [
						{
							severity: "error",
							semantic: "blocking",
							message: "Type 'string' is not assignable to 'number'",
							line: 12,
							rule: "ts2322",
							tool: "tsc",
						},
						{
							severity: "warning",
							message: "Unexpected console statement",
							line: 30,
							rule: "no-console",
							tool: "eslint",
						},
					],
				},
			),
		);
		const result = await run(makeTool(), { mode: "all" });
		const text = String(result.content[0].text);
		expect(text).toContain("Type 'string' is not assignable to 'number'");
		expect(text).toContain("L12");
		expect(text).toContain("ts2322");
		expect(text).toContain("Unexpected console statement");
		expect(text).toContain("L30");
	});

	it("shows every provided diagnostic with no truncation note under the budget", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/foo.ts",
				{ warnings: 2 },
				{
					diagnostics: [
						{ severity: "warning", message: "w1", line: 1, rule: "r" },
						{ severity: "warning", message: "w2", line: 2, rule: "r" },
					],
				},
			),
		);
		const text = String(
			(await run(makeTool(), { mode: "all" })).content[0].text,
		);
		expect(text).toContain("w1");
		expect(text).toContain("w2");
		expect(text).not.toMatch(/more in this file/);
	});

	it("applies its own per-file budget (50) and reports the accurate remainder", async () => {
		mockSummaries.length = 0;
		const many = Array.from({ length: 60 }, (_, i) => ({
			severity: "warning" as const,
			message: `w${i}`,
			line: i + 1,
			rule: "r",
		}));
		mockSummaries.push(
			sum("/proj/src/big.ts", { warnings: 60 }, { diagnostics: many }),
		);
		const text = String(
			(await run(makeTool(), { mode: "all" })).content[0].text,
		);
		expect(text).toContain("w0");
		expect(text).toContain("w49"); // 50th shown
		expect(text).not.toContain("w50"); // 51st truncated
		expect(text).toMatch(/10 more in this file \(showing 50 of 60\)/);
	});

	it("orders blocking → error → warning, so a blocker survives the budget and leads", async () => {
		mockSummaries.length = 0;
		// Dispatch order puts the blocker LAST, after 50 warnings.
		const diags = [
			...Array.from({ length: 50 }, (_, i) => ({
				severity: "warning" as const,
				message: `w${i}`,
				line: i + 1,
				rule: "r",
			})),
			{
				severity: "error",
				semantic: "blocking",
				message: "MUSTFIX",
				line: 999,
				rule: "e",
			},
		];
		mockSummaries.push(
			sum("/proj/x.ts", { blocking: 1, warnings: 50 }, { diagnostics: diags }),
		);
		const text = String(
			(await run(makeTool(), { mode: "all" })).content[0].text,
		);
		// The blocker is not truncated by the 50-budget and is listed before the warnings.
		expect(text).toContain("MUSTFIX");
		expect(text.indexOf("MUSTFIX")).toBeLessThan(text.indexOf("w0"));
	});

	it("severity=error hides warning messages but shows error messages", async () => {
		mockSummaries.length = 0;
		mockSummaries.push(
			sum(
				"/proj/src/mix.ts",
				{ blocking: 1, warnings: 1 },
				{
					diagnostics: [
						{
							severity: "error",
							semantic: "blocking",
							message: "BOOM error here",
							line: 1,
							rule: "e",
						},
						{
							severity: "warning",
							message: "minor warning here",
							line: 2,
							rule: "w",
						},
					],
				},
			),
		);
		const result = await run(makeTool(), { mode: "all", severity: "error" });
		const text = String(result.content[0].text);
		expect(text).toContain("BOOM error here");
		expect(text).not.toContain("minor warning here");
	});
});

// ── cancellation via ctx.signal (Escape / turn abort) ──────────────────────────
describe("lens_diagnostics honors the turn abort (ctx.signal)", () => {
	it("aborts a mode=full scan when ctx.signal (Escape) fires, even if the positional signal is live", async () => {
		mockSummaries.length = 0;
		const lspService = {
			runWorkspaceDiagnostics: vi.fn().mockResolvedValue([]),
		};
		// Positional tool-call signal is live (not aborted); the TURN signal is the
		// one Escape fires. Before the fix the tool only read the positional signal,
		// so Escape did nothing.
		const liveCall = new AbortController();
		const turn = new AbortController();
		turn.abort();
		const tool = makeTool({}, lspService);
		const result = await tool.execute(
			"1",
			{ mode: "full", maxLspFiles: 50 },
			liveCall.signal,
			null,
			{ cwd: "/proj", signal: turn.signal },
		);
		const passed = lspService.runWorkspaceDiagnostics.mock.calls[0][1];
		expect(passed.signal.aborted).toBe(true);
		expect(String(result.content[0].text)).toContain(
			"Scan cancelled before completion",
		);
		expect(result.details).toMatchObject({ mode: "full", partial: true });
	});
});


describe("lens_diagnostics wall-clock ceiling (never-hang guarantee)", () => {
	it("stops mode=full and marks timedOut when the wall-clock budget is exceeded", async () => {
		vi.resetModules();
		process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS = "1";
		const { createLensDiagnosticsTool: freshCreate } = await import(
			"../../tools/lens-diagnostics.js"
		);
		const lspService = {
			// Outlast the 1ms ceiling so it fires before the sweep returns.
			runWorkspaceDiagnostics: vi.fn(async () => {
				await new Promise((r) => setTimeout(r, 30));
				return [];
			}),
		};
		const tool = freshCreate(
			makeCacheManager({}) as any,
			() => "/proj",
			() => lspService as any,
		);
		const result = await tool.execute("1", { mode: "full" }, undefined, null, {
			cwd: "/proj",
		});
		expect(String(result.content[0].text)).toContain("time budget");
		expect(result.details).toMatchObject({ mode: "full", timedOut: true });
		delete process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS;
	});
});
