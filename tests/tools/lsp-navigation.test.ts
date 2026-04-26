import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => mocked.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

describe("lsp_navigation tool", () => {
	beforeEach(() => {
		mocked.service = {
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
			openFile: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn().mockResolvedValue([]),
			getOperationSupport: vi.fn().mockResolvedValue(null),
			codeAction: vi
				.fn()
				.mockResolvedValue([
					{ title: "Move to new file", kind: "refactor.move.newFile" },
				]),
			references: vi.fn().mockResolvedValue([
				{
					uri: "file:///tmp/sample.ts",
					range: {
						start: { line: 1, character: 1 },
						end: { line: 1, character: 5 },
					},
				},
			]),
			workspaceSymbol: vi.fn().mockResolvedValue([]),
			incomingCalls: vi.fn().mockResolvedValue([]),
			outgoingCalls: vi.fn().mockResolvedValue([]),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			getWorkspaceDiagnosticsSupport: vi
				.fn()
				.mockResolvedValue({ mode: "push-only" }),
		};
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
});
