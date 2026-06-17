import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => mocked.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

const tmpPath = (name: string): string => path.join(os.tmpdir(), name);
const tmpFileUrl = (name: string): string => pathToFileURL(tmpPath(name)).href;

describe("lsp_navigation tool", () => {
	beforeEach(() => {
		mocked.service = {
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
			openFile: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn().mockResolvedValue([]),
			getOperationSupport: vi.fn().mockResolvedValue(null),
			getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
			codeAction: vi
				.fn()
				.mockResolvedValue([
					{ title: "Move to new file", kind: "refactor.move.newFile" },
				]),
			rename: vi.fn().mockResolvedValue(null),
			renameFile: vi.fn().mockResolvedValue({
				applied: false,
				serverIds: [],
				willRenameFailures: [],
				didRenameFailures: [],
				droppedConflicts: 0,
				inputEditCount: 0,
				summary: [],
			}),
			references: vi.fn().mockResolvedValue([
				{
					uri: tmpFileUrl("sample.ts"),
					range: {
						start: { line: 1, character: 1 },
						end: { line: 1, character: 5 },
					},
				},
			]),
			typeDefinition: vi.fn().mockResolvedValue([
				{
					uri: tmpFileUrl("types.ts"),
					range: {
						start: { line: 9, character: 0 },
						end: { line: 9, character: 4 },
					},
				},
			]),
			declaration: vi.fn().mockResolvedValue([]),
			workspaceSymbol: vi.fn().mockResolvedValue([]),
			getAdvertisedCommands: vi
				.fn()
				.mockResolvedValue(["_typescript.organizeImports"]),
			executeCommand: vi
				.fn()
				.mockResolvedValue({ executed: true, result: null }),
			documentSymbol: vi.fn().mockResolvedValue([]),
			incomingCalls: vi.fn().mockResolvedValue([]),
			outgoingCalls: vi.fn().mockResolvedValue([]),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			getWorkspaceDiagnosticsSupport: vi
				.fn()
				.mockResolvedValue({ mode: "push-only" }),
		};
	});

	it("reports cached LSP capabilities without requiring filePath", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		(
			mocked.service as { getCapabilitySnapshots: ReturnType<typeof vi.fn> }
		).getCapabilitySnapshots = vi.fn().mockResolvedValue([
			{
				serverId: "typescript",
				root: "/workspace",
				operationSupport: {
					definition: true,
					typeDefinition: true,
					declaration: false,
					references: true,
					hover: true,
					signatureHelp: false,
					documentSymbol: true,
					workspaceSymbol: true,
					codeAction: true,
					rename: true,
					implementation: false,
					callHierarchy: true,
				},
				workspaceDiagnosticsSupport: { mode: "pull" },
				advertisedCommands: ["_typescript.organizeImports"],
			},
		]);

		const result = await tool.execute(
			"capabilities",
			{ operation: "capabilities" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(String(result.content[0]?.text)).toContain(
			"typescript (/workspace)",
		);
		expect(String(result.content[0]?.text)).toContain(
			"definition             ✓",
		);
		expect(String(result.content[0]?.text)).toContain(
			"signatureHelp          ✗",
		);
		expect(String(result.content[0]?.text)).toContain(
			"rename_file            ✓  (willRenameFiles/didRenameFiles helper available)",
		);
		expect(result.details?.servers).toEqual(["typescript"]);
	});

	it("reports no active server for file-scoped capabilities", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"capabilities-empty",
			{ operation: "capabilities", filePath: "missing.ts" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(String(result.content[0]?.text)).toContain("No active LSP server");
		expect(result.details?.resultCount).toBe(0);
	});

	it("allows incomingCalls without filePath when callHierarchyItem exists", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const callHierarchyItem = {
			name: "foo",
			kind: 12,
			uri: "file:///tmp/a.py",
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 3 },
			},
			selectionRange: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 3 },
			},
		};

		const result = await tool.execute(
			"1",
			{ operation: "incomingCalls", callHierarchyItem },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(
			(mocked.service as { incomingCalls: ReturnType<typeof vi.fn> })
				.incomingCalls,
		).toHaveBeenCalledOnce();
		expect(result.details?.operation).toBe("incomingCalls");
	});

	it("adds workspaceSymbol hint when filePath is omitted and empty", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"2",
			{ operation: "workspaceSymbol", query: "ReportProcessor" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(String(result.content[0]?.text)).toContain(
			"Hint: provide filePath to scope workspaceSymbol",
		);
		expect(
			(mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> })
				.workspaceSymbol,
		).toHaveBeenCalledWith("ReportProcessor", undefined);
	});

	it("executeCommand dry-runs by default and does NOT execute", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"exec-dry",
			{ operation: "executeCommand", command: "_typescript.organizeImports" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		const svc = mocked.service as {
			executeCommand: ReturnType<typeof vi.fn>;
			getAdvertisedCommands: ReturnType<typeof vi.fn>;
		};
		expect(svc.executeCommand).not.toHaveBeenCalled();
		expect(svc.getAdvertisedCommands).toHaveBeenCalled();
		expect(String(result.content[0]?.text)).toContain("apply:true");
	});

	it("executeCommand with apply:true runs an advertised command", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"exec-apply",
			{
				operation: "executeCommand",
				command: "_typescript.organizeImports",
				commandArguments: ["file:///x.ts"],
				apply: true,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(
			(mocked.service as { executeCommand: ReturnType<typeof vi.fn> })
				.executeCommand,
		).toHaveBeenCalledWith(undefined, "_typescript.organizeImports", [
			"file:///x.ts",
		]);
	});

	it("executeCommand refuses a command the server did not advertise", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"exec-unadvertised",
			{ operation: "executeCommand", command: "evil.command", apply: true },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("not advertised");
		expect(
			(mocked.service as { executeCommand: ReturnType<typeof vi.fn> })
				.executeCommand,
		).not.toHaveBeenCalled();
	});

	it("resolves typeDefinition and attaches location searchReads", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"type-definition",
			{
				operation: "typeDefinition",
				filePath: path.resolve("tests/tools/lsp-navigation.test.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.operation).toBe("typeDefinition");
		expect(
			(mocked.service as { typeDefinition: ReturnType<typeof vi.fn> })
				.typeDefinition,
		).toHaveBeenCalledOnce();
		expect(result.details?.searchReads).toEqual([
			{ file: tmpPath("types.ts"), startLine: 10, endLine: 10 },
		]);
	});

	it("reports an empty declaration result with the no-results reason", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"declaration-empty",
			{
				operation: "declaration",
				filePath: path.resolve("tests/tools/lsp-navigation.test.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.operation).toBe("declaration");
		expect(result.details?.emptyReason).toBe("no-results");
		expect(
			(mocked.service as { declaration: ReturnType<typeof vi.fn> }).declaration,
		).toHaveBeenCalled();
	});

	it("attaches searchReads for reference locations", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"references-search-reads",
			{
				operation: "references",
				filePath: path.resolve("tests/tools/lsp-navigation.test.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.searchReads).toEqual([
			{
				file: tmpPath("sample.ts"),
				startLine: 2,
				endLine: 2,
			},
		]);
	});

	it("deduplicates workspaceSymbol results", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		(
			mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> }
		).workspaceSymbol = vi.fn().mockResolvedValue([
			{
				name: "ReportProcessor",
				kind: 12,
				location: {
					uri: "file:///tmp/report.ts",
					range: {
						start: { line: 1, character: 2 },
						end: { line: 1, character: 17 },
					},
				},
			},
			{
				name: "ReportProcessor",
				kind: 12,
				location: {
					uri: "file:///tmp/report.ts",
					range: {
						start: { line: 1, character: 2 },
						end: { line: 1, character: 17 },
					},
				},
			},
		]);

		const result = await tool.execute(
			"workspace-symbol-dedupe",
			{ operation: "workspaceSymbol", query: "ReportProcessor" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.resultCount).toBe(1);
	});

	it("attaches searchReads for workspaceSymbol locations", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		(
			mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> }
		).workspaceSymbol = vi.fn().mockResolvedValue([
			{
				name: "ReportProcessor",
				kind: 12,
				location: {
					uri: tmpFileUrl("report.ts"),
					range: {
						start: { line: 4, character: 2 },
						end: { line: 6, character: 17 },
					},
				},
			},
		]);

		const result = await tool.execute(
			"workspace-symbol-search-reads",
			{ operation: "workspaceSymbol", query: "ReportProcessor" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.searchReads).toEqual([
			{
				file: tmpPath("report.ts"),
				startLine: 5,
				endLine: 7,
			},
		]);
	});

	it("attaches searchReads for call hierarchy incoming and outgoing ranges", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const sourceItem = {
			name: "source",
			kind: 12,
			uri: tmpFileUrl("source.ts"),
			range: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 6 },
			},
			selectionRange: {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 6 },
			},
		};
		(
			mocked.service as { incomingCalls: ReturnType<typeof vi.fn> }
		).incomingCalls = vi.fn().mockResolvedValue([
			{
				from: {
					name: "caller",
					kind: 12,
					uri: tmpFileUrl("caller.ts"),
					range: {
						start: { line: 9, character: 0 },
						end: { line: 9, character: 6 },
					},
					selectionRange: {
						start: { line: 9, character: 0 },
						end: { line: 9, character: 6 },
					},
				},
				fromRanges: [
					{
						start: { line: 12, character: 2 },
						end: { line: 12, character: 8 },
					},
				],
			},
		]);

		const incoming = await tool.execute(
			"incoming-search-reads",
			{ operation: "incomingCalls", callHierarchyItem: sourceItem },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(incoming.details?.searchReads).toEqual([
			{
				file: tmpPath("caller.ts"),
				startLine: 10,
				endLine: 10,
			},
			{
				file: tmpPath("caller.ts"),
				startLine: 13,
				endLine: 13,
			},
		]);

		(
			mocked.service as { outgoingCalls: ReturnType<typeof vi.fn> }
		).outgoingCalls = vi.fn().mockResolvedValue([
			{
				to: {
					name: "callee",
					kind: 12,
					uri: tmpFileUrl("callee.ts"),
					range: {
						start: { line: 19, character: 0 },
						end: { line: 19, character: 6 },
					},
				},
				fromRanges: [
					{
						start: { line: 3, character: 2 },
						end: { line: 3, character: 8 },
					},
				],
			},
		]);

		const outgoing = await tool.execute(
			"outgoing-search-reads",
			{ operation: "outgoingCalls", callHierarchyItem: sourceItem },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(outgoing.details?.searchReads).toEqual([
			{
				file: tmpPath("callee.ts"),
				startLine: 20,
				endLine: 20,
			},
			{
				file: tmpPath("source.ts"),
				startLine: 4,
				endLine: 4,
			},
		]);
	});

	it("opens scoped file before workspaceSymbol query", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "sample.ts");
		fs.writeFileSync(
			filePath,
			"export const normalizeMapKey = (x: string) => x;\n",
		);

		try {
			const result = await tool.execute(
				"3",
				{ operation: "workspaceSymbol", filePath, query: "normalizeMapKey" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(
				(mocked.service as { openFile: ReturnType<typeof vi.fn> }).openFile,
			).toHaveBeenCalledWith(
				filePath,
				expect.stringContaining("normalizeMapKey"),
			);
			expect(
				(mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> })
					.workspaceSymbol,
			).toHaveBeenCalledWith("normalizeMapKey", filePath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("retries workspaceSymbol once after No Project", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "projected.ts");
		fs.writeFileSync(filePath, "export const projected = 1;\n");

		(
			mocked.service as {
				workspaceSymbol: ReturnType<typeof vi.fn>;
			}
		).workspaceSymbol = vi
			.fn()
			.mockRejectedValueOnce(new Error("TypeScript Server Error: No Project"))
			.mockResolvedValueOnce([{ name: "projected" }]);

		try {
			const result = await tool.execute(
				"4",
				{ operation: "workspaceSymbol", filePath, query: "projected" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(result.details?.resultCount).toBe(1);
			expect(
				(mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> })
					.workspaceSymbol,
			).toHaveBeenCalledTimes(2);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("filters document symbols with findSymbol", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbols.ts");
		fs.writeFileSync(
			filePath,
			"class ReportProcessor { normalizeReport() { return 1; } }\n",
		);
		(
			mocked.service as { documentSymbol: ReturnType<typeof vi.fn> }
		).documentSymbol = vi.fn().mockResolvedValue([
			{
				name: "ReportProcessor",
				kind: 5,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 55 },
				},
				children: [
					{
						name: "normalizeReport",
						kind: 6,
						range: {
							start: { line: 0, character: 24 },
							end: { line: 0, character: 39 },
						},
					},
				],
			},
		]);

		try {
			const result = await tool.execute(
				"find-symbol",
				{
					operation: "findSymbol",
					filePath,
					query: "normalize",
					kinds: ["method"],
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(result.details?.resultCount).toBe(1);
			expect(String(result.content[0]?.text)).toContain("normalizeReport");
			expect(String(result.content[0]?.text)).toContain('"kind": "method"');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("resolves omitted character from symbol word-boundary match", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-column.ts");
		fs.writeFileSync(filePath, "const x = myFunc();\n");

		try {
			const result = await tool.execute(
				"symbol-column",
				{ operation: "references", filePath, line: 1, symbol: "myFunc" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 10);
			expect(result.details?.columnResolution).toMatchObject({
				character: 11,
				strategy: "word-boundary",
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("supports symbol occurrence selectors", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-occurrence.ts");
		fs.writeFileSync(filePath, "const x = myFunc(myFunc);\n");

		try {
			await tool.execute(
				"symbol-occurrence",
				{ operation: "references", filePath, line: 1, symbol: "myFunc#2" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 17);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("uses case-insensitive symbol-column fallback", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-case.ts");
		fs.writeFileSync(filePath, "const x = MyFunc();\n");

		try {
			const result = await tool.execute(
				"symbol-case",
				{ operation: "references", filePath, line: 1, symbol: "myfunc" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 10);
			expect(result.details?.columnResolution).toMatchObject({
				strategy: "case-insensitive",
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not match symbol substrings inside longer identifiers", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-boundary.ts");
		const source = "const x = myFuncHelper + myFunc;\n";
		fs.writeFileSync(filePath, source);

		try {
			await tool.execute(
				"symbol-boundary",
				{ operation: "references", filePath, line: 1, symbol: "myFunc" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			const expectedCharacter0 = source.indexOf("myFunc;");
			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, expectedCharacter0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("falls back to first non-whitespace when symbol is not found", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-missing.ts");
		fs.writeFileSync(filePath, "   const x = other();\n");

		try {
			const result = await tool.execute(
				"symbol-missing",
				{ operation: "references", filePath, line: 1, symbol: "myFunc" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 3);
			expect(result.details?.columnResolution).toMatchObject({
				character: 4,
				strategy: "fallback",
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps explicit character precedence over symbol-column resolution", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "symbol-explicit.ts");
		fs.writeFileSync(filePath, "const x = myFunc();\n");

		try {
			const result = await tool.execute(
				"symbol-explicit",
				{
					operation: "references",
					filePath,
					line: 1,
					character: 3,
					symbol: "myFunc",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 2);
			expect(result.details?.columnResolution).toBeUndefined();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("adds low-count references hint for usage-side calls", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "refs.ts");
		fs.writeFileSync(filePath, "const a = normalizeMapKey('x');\n");

		try {
			const result = await tool.execute(
				"5",
				{ operation: "references", filePath, line: 1, character: 12 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain(
				"references from usage sites can be partial",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("marks refactor-only codeAction results as non-quickfix", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "actions.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");

		try {
			const result = await tool.execute(
				"6",
				{
					operation: "codeAction",
					filePath,
					line: 1,
					character: 1,
					endLine: 1,
					endCharacter: 5,
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain(
				"no diagnostic quick fixes returned; refactor-only actions available",
			);
			expect(result.details?.codeActionKinds).toEqual({
				quickfix: 0,
				refactor: 1,
				other: 0,
			});
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("collects file diagnostics when workspaceDiagnostics gets filePath", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "diag.rs");
		fs.writeFileSync(filePath, 'fn main() { let x: i32 = "oops"; }\n');
		(
			mocked.service as {
				getWorkspaceDiagnosticsSupport: ReturnType<typeof vi.fn>;
				getDiagnostics: ReturnType<typeof vi.fn>;
			}
		).getWorkspaceDiagnosticsSupport = vi
			.fn()
			.mockResolvedValue({ mode: "pull" });
		(
			mocked.service as {
				getDiagnostics: ReturnType<typeof vi.fn>;
			}
		).getDiagnostics = vi.fn().mockResolvedValue([
			{
				severity: 1,
				message: "mismatched types",
				range: {
					start: { line: 0, character: 20 },
					end: { line: 0, character: 26 },
				},
			},
		]);

		try {
			const result = await tool.execute(
				"7",
				{ operation: "workspaceDiagnostics", filePath },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(result.details?.coverage).toBe("requested-file");
			expect(result.details?.resultCount).toBe(1);
			expect(
				(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
					.getDiagnostics,
			).toHaveBeenCalledWith(filePath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("previews LSP-aware file renames", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "old.ts");
		const newFilePath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(filePath, "export const value = 1;\n");
		(mocked.service as { renameFile: ReturnType<typeof vi.fn> }).renameFile = vi
			.fn()
			.mockResolvedValue({
				applied: false,
				serverIds: ["typescript", "eslint"],
				willRenameFailures: [],
				didRenameFailures: [],
				droppedConflicts: 1,
				inputEditCount: 2,
				summary: ["Apply 1 edit(s) to import.ts"],
			});

		try {
			const result = await tool.execute(
				"rename-file-preview",
				{
					operation: "rename_file",
					filePath,
					newFilePath,
					apply: false,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(result.isError).toBeUndefined();
			expect(
				(mocked.service as { renameFile: ReturnType<typeof vi.fn> }).renameFile,
			).toHaveBeenCalledWith(filePath, newFilePath, {
				cwd: tmpDir,
				apply: false,
			});
			expect(String(result.content[0]?.text)).toContain("typescript");
			expect(result.details?.resultCount).toBe(1);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("applies rename workspace edits when apply is true", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "rename.ts");
		fs.writeFileSync(filePath, "const oldName = 1;\nconsole.log(oldName);\n");
		(
			mocked.service as {
				rename: ReturnType<typeof vi.fn>;
			}
		).rename = vi.fn().mockResolvedValue({
			changes: {
				[pathToFileURL(filePath).href]: [
					{
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 13 },
						},
						newText: "newName",
					},
					{
						range: {
							start: { line: 1, character: 12 },
							end: { line: 1, character: 19 },
						},
						newText: "newName",
					},
				],
			},
		});

		try {
			const result = await tool.execute(
				"rename-apply",
				{
					operation: "rename",
					filePath,
					line: 1,
					character: 8,
					newName: "newName",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(result.isError).toBeUndefined();
			expect(result.details?.resultCount).toBe(1);
			expect(String(result.content[0]?.text)).toContain('"applied": true');
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const newName = 1;\nconsole.log(newName);\n",
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
