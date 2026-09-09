import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => mocked.service,
}));

import { createLspNavigationTool } from "../../tools/lsp-navigation.js";

const tmpPath = (name: string): string => path.join(os.tmpdir(), name);
const tmpFileUrl = (name: string): string => pathToFileURL(tmpPath(name)).href;
const parseToolJson = (result: {
	content: Array<{ text?: string }>;
}): Record<string, unknown> => {
	try {
		return JSON.parse(String(result.content[0]?.text)) as Record<
			string,
			unknown
		>;
	} catch (error) {
		throw new Error(
			`Expected parseable lsp_navigation JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

describe("lsp_navigation tool", () => {
	beforeEach(() => {
		// #2598: `openFileBestEffort` no longer branches on `touchFile` being
		// present — the real `LSPService` always has it — so the double keeps the
		// factory's `touchFile`, and the scoped-open case below asserts the touch
		// (with its options), which is the call production actually makes.
		mocked.service = makeLspServiceDouble({
			supportsLSP: vi.fn().mockReturnValue(true),
			hasLSP: vi.fn().mockResolvedValue(true),
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
		});
	});

	it("reports cached LSP capabilities without requiring path", async () => {
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
					codeActionResolve: false,
					rename: true,
					willRenameFiles: false,
					didRenameFiles: false,
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
		const envelope = parseToolJson(result);
		expect(envelope).toMatchObject({
			tool: "lsp_navigation",
			operation: "capabilities",
			ok: true,
			status: "success",
			resultCount: 1,
		});
		expect(String(result.content[0]?.text)).toContain(
			"typescript (/workspace)",
		);
		expect(String(result.content[0]?.text)).toContain("definition ✓");
		expect(String(result.content[0]?.text)).toContain("signatureHelp ✗");
		expect(String(result.content[0]?.text)).toContain("codeAction/resolve ✗");
		expect(String(result.content[0]?.text)).toContain(
			"workspace/willRenameFiles ✗",
		);
		expect(String(result.content[0]?.text)).toContain(
			"rename_file ✓ (filesystem rename; preflight support shown above)",
		);
		expect(result.details?.servers).toEqual(["typescript"]);
	});

	it("reports no active server for file-scoped capabilities", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"capabilities-empty",
			{ operation: "capabilities", path: "missing.ts" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(String(result.content[0]?.text)).toContain("No active LSP server");
		expect(result.details?.resultCount).toBe(0);
	});

	it("returns structured JSON for LSP-disabled errors", async () => {
		const tool = createLspNavigationTool((flag) => flag === "no-lsp");
		const result = await tool.execute(
			"disabled",
			{ operation: "definition", path: "x.ts", line: 1, character: 1 },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(parseToolJson(result)).toMatchObject({
			tool: "lsp_navigation",
			operation: "precheck",
			ok: false,
			status: "lsp_disabled",
			resultCount: 0,
		});
	});

	it("passes the call's ctx.cwd to getFlag (#792 — MCP host must resolve per-request project config, not the process's launch cwd)", async () => {
		const calls: Array<{ name: string; cwd: string | undefined }> = [];
		const tool = createLspNavigationTool((name, cwd) => {
			calls.push({ name, cwd });
			return false;
		});

		await tool.execute(
			"call-1",
			{ operation: "capabilities" },
			new AbortController().signal,
			null,
			{ cwd: "/some/other/project" },
		);

		expect(calls).toEqual([{ name: "no-lsp", cwd: "/some/other/project" }]);
	});

	it("allows incomingCalls without path when callHierarchyItem exists", async () => {
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

	it("adds workspaceSymbol hint when path is omitted and empty", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");

		const result = await tool.execute(
			"2",
			{ operation: "workspaceSymbol", query: "ReportProcessor" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		const envelope = parseToolJson(result);
		expect(envelope.status).toBe("empty");
		expect(envelope.hints).toEqual([
			"provide path to scope workspaceSymbol to the active language server/root.",
		]);
		expect(String(result.content[0]?.text)).toContain(
			"provide path to scope workspaceSymbol",
		);
		expect(
			(mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> })
				.workspaceSymbol,
		).toHaveBeenCalledWith("ReportProcessor", undefined, expect.any(Object));
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
		const executeCall = (
			mocked.service as { executeCommand: ReturnType<typeof vi.fn> }
		).executeCommand.mock.calls[0];
		expect(executeCall?.slice(0, 3)).toEqual([
			undefined,
			"_typescript.organizeImports",
			["file:///x.ts"],
		]);
		// #2450: the mutation context names the specific LSP operation
		// (executeCommand vs rename) instead of a generic "lsp-edit" tag, so the
		// eventual change-log receipt tells them apart.
		expect(executeCall?.[3]).toMatchObject({
			correlationId: "exec-apply",
			tool: "lsp_navigation:executeCommand",
			source: "lsp-execute-command",
		});
	});

	// #2450 fix round 5 (F1): pin the PRODUCTION `isRecordable` closure built
	// at tools/lsp-navigation.ts:1126-1131 — not a hand-mirrored stand-in.
	// `runtime.projectRoot` is the parent of the request `cwd` (a sub-package),
	// so a sibling package's file must still judge as recordable against the
	// project root rather than the narrower request `cwd`. Plain `cwd` (the
	// round-4 regression this guards) makes the sibling path read as outside
	// the (sub-package) root and `isRecordable` wrongly returns false.
	it("#2450 fix round 5 (F1): the production isRecordable closure judges a sibling-package path against runtime.projectRoot, not the sub-package ctx.cwd", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nav-2450-f1-"),
		);
		const subPackageDir = path.join(tmpDir, "packages", "sub");
		const siblingDir = path.join(tmpDir, "packages", "sibling");
		fs.mkdirSync(subPackageDir, { recursive: true });
		fs.mkdirSync(siblingDir, { recursive: true });
		const siblingPath = path.join(siblingDir, "foo.ts");
		fs.writeFileSync(siblingPath, "export const foo = 1;\n");

		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-f1-root" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);

		const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
			runtime: runtime as never,
			cacheManager,
			readGuard: { recordWritten: () => {} },
			dbg: () => {},
		});

		try {
			const result = await tool.execute(
				"exec-apply-f1-root",
				{
					operation: "executeCommand",
					command: "_typescript.organizeImports",
					commandArguments: ["file:///x.ts"],
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: subPackageDir },
			);

			expect(result.isError).toBeUndefined();
			const executeCall = (
				mocked.service as { executeCommand: ReturnType<typeof vi.fn> }
			).executeCommand.mock.calls[0];
			expect(
				(
					executeCall?.[3] as {
						isRecordable: (filePath: string) => boolean;
					}
				).isRecordable(siblingPath),
			).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
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
				path: path.resolve("tests/tools/lsp-navigation.test.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBeUndefined();
		expect(result.details?.operation).toBe("typeDefinition");
		expect(parseToolJson(result).locations).toEqual([
			{
				uri: tmpFileUrl("types.ts"),
				filePath: tmpPath("types.ts"),
				range: {
					start: { line: 10, character: 1 },
					end: { line: 10, character: 5 },
				},
			},
		]);
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
				path: path.resolve("tests/tools/lsp-navigation.test.ts"),
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
				path: path.resolve("tests/tools/lsp-navigation.test.ts"),
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

	// #1803 fix round F1: needsFilePath is false for call-hierarchy traversal,
	// so the shared capability pre-check (which every path-based operation
	// gets) never ran for incomingCalls/outgoingCalls — a server that never
	// advertised callHierarchyProvider produced an INDISTINGUISHABLE-from-
	// "no callers found" empty array, an error swallowed into a false clean
	// signal (the empty-distinguishes-clean-from-errored screen). This probe
	// pair proves both directions: unsupported reports the discriminator,
	// and a genuinely supporting server with zero callers still reports a
	// clean empty (not a false "unsupported").
	it.each(["incomingCalls", "outgoingCalls"] as const)(
		"reports the unsupported discriminator for %s when the server never advertised callHierarchyProvider",
		async (operation) => {
			const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
			(
				mocked.service as { getOperationSupport: ReturnType<typeof vi.fn> }
			).getOperationSupport = vi.fn().mockResolvedValue({
				definition: false,
				typeDefinition: false,
				declaration: false,
				references: false,
				hover: false,
				signatureHelp: false,
				documentSymbol: false,
				workspaceSymbol: false,
				codeAction: false,
				codeActionResolve: false,
				rename: false,
				willRenameFiles: false,
				didRenameFiles: false,
				implementation: false,
				callHierarchy: false,
			});
			const operationSpy = (
				mocked.service as Record<typeof operation, ReturnType<typeof vi.fn>>
			)[operation];
			const callHierarchyItem = {
				name: "foo",
				kind: 12,
				uri: tmpFileUrl("unsupported.py"),
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
				`unsupported-${operation}`,
				{ operation, callHierarchyItem },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(operationSpy).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			expect(result.details?.emptyReason).toBe("unsupported");
			expect(String(result.content[0]?.text)).toContain(
				`does not advertise support for ${operation}`,
			);
		},
	);

	it.each(["incomingCalls", "outgoingCalls"] as const)(
		"reports a clean empty (not unsupported) when %s finds zero calls",
		async (operation) => {
			const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
			(
				mocked.service as { getOperationSupport: ReturnType<typeof vi.fn> }
			).getOperationSupport = vi.fn().mockResolvedValue({
				definition: false,
				typeDefinition: false,
				declaration: false,
				references: false,
				hover: false,
				signatureHelp: false,
				documentSymbol: false,
				workspaceSymbol: false,
				codeAction: false,
				codeActionResolve: false,
				rename: false,
				willRenameFiles: false,
				didRenameFiles: false,
				implementation: false,
				callHierarchy: true,
			});
			(mocked.service as Record<typeof operation, ReturnType<typeof vi.fn>>)[
				operation
			] = vi.fn().mockResolvedValue([]);
			const callHierarchyItem = {
				name: "leaf",
				kind: 12,
				uri: tmpFileUrl("supported.py"),
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
				`supported-empty-${operation}`,
				{ operation, callHierarchyItem },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as Record<typeof operation, ReturnType<typeof vi.fn>>)[
					operation
				],
			).toHaveBeenCalledWith(callHierarchyItem);
			expect(result.isError).toBeUndefined();
			expect(result.details?.emptyReason).toBe("no-call-hierarchy-results");
		},
	);

	it("touches the scoped file, diagnostics off, before a workspaceSymbol query", async () => {
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
				{
					operation: "workspaceSymbol",
					path: filePath,
					query: "normalizeMapKey",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			// #2598: the scoped pre-open is a `touchFile`, and the OPTIONS are the
			// point — a `workspaceSymbol` pre-open must not pay for a diagnostics
			// wait, and must stay on the primary server.
			expect(
				(mocked.service as { touchFile: ReturnType<typeof vi.fn> }).touchFile,
			).toHaveBeenCalledWith(
				filePath,
				expect.stringContaining("normalizeMapKey"),
				{
					diagnostics: "none",
					source: "lsp_navigation",
					clientScope: "primary",
				},
			);
			expect(
				(mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> })
					.workspaceSymbol,
			).toHaveBeenCalledWith("normalizeMapKey", filePath);
		} finally {
			removeTempDirSync(tmpDir);
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
				{ operation: "workspaceSymbol", path: filePath, query: "projected" },
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
			removeTempDirSync(tmpDir);
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
					path: filePath,
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
			expect(String(result.content[0]?.text)).toContain('"kind":"method"');
		} finally {
			removeTempDirSync(tmpDir);
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
				{ operation: "references", path: filePath, line: 1, symbol: "myFunc" },
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
			removeTempDirSync(tmpDir);
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
				{
					operation: "references",
					path: filePath,
					line: 1,
					symbol: "myFunc#2",
				},
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, 17);
		} finally {
			removeTempDirSync(tmpDir);
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
				{ operation: "references", path: filePath, line: 1, symbol: "myfunc" },
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
			removeTempDirSync(tmpDir);
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
				{ operation: "references", path: filePath, line: 1, symbol: "myFunc" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			const expectedCharacter0 = source.indexOf("myFunc;");
			expect(
				(mocked.service as { references: ReturnType<typeof vi.fn> }).references,
			).toHaveBeenCalledWith(filePath, 0, expectedCharacter0);
		} finally {
			removeTempDirSync(tmpDir);
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
				{ operation: "references", path: filePath, line: 1, symbol: "myFunc" },
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
			removeTempDirSync(tmpDir);
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
					path: filePath,
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
			removeTempDirSync(tmpDir);
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
				{ operation: "references", path: filePath, line: 1, character: 12 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			expect(String(result.content[0]?.text)).toContain(
				"references from usage sites can be partial",
			);
		} finally {
			removeTempDirSync(tmpDir);
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
					path: filePath,
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
			removeTempDirSync(tmpDir);
		}
	});

	it("collects file diagnostics when workspaceDiagnostics gets path", async () => {
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
				{ operation: "workspaceDiagnostics", path: filePath },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);

			expect(result.isError).toBeUndefined();
			const envelope = parseToolJson(result);
			expect(envelope.status).toBe("success");
			expect(envelope.notes).toEqual([
				"path mode requests pull diagnostics for this file and returns the aggregated result",
			]);
			expect(result.details?.coverage).toBe("requested-file");
			expect(result.details?.resultCount).toBe(1);
			expect(
				(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
					.getDiagnostics,
			).toHaveBeenCalledWith(filePath);
		} finally {
			removeTempDirSync(tmpDir);
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
					path: filePath,
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
			removeTempDirSync(tmpDir);
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
					path: filePath,
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
			expect(String(result.content[0]?.text)).toContain('"applied":true');
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				"const newName = 1;\nconsole.log(newName);\n",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("returns an error and terminal failed mutation outcome when apply is true cannot write", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nav-fail-"),
		);
		const filePath = path.join(tmpDir, "missing.ts");
		(mocked.service as { rename: ReturnType<typeof vi.fn> }).rename = vi
			.fn()
			.mockResolvedValue({
				changes: {
					[pathToFileURL(filePath).href]: [
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 0 },
							},
							newText: "new",
						},
					],
				},
			});
		try {
			const result = await tool.execute(
				"rename-fail",
				{
					operation: "rename",
					path: filePath,
					line: 1,
					character: 1,
					newName: "new",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);
			expect(result.isError).toBe(true);
			expect(result.details?.failureKind).toBe("lsp_error");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("#2450: a two-file rename leaves both files in turn-state.json with LSP-rename provenance", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nav-2450-"),
		);
		const fileA = path.join(tmpDir, "a.ts");
		const fileB = path.join(tmpDir, "b.ts");
		// #2450 review round 2 (F2): the renamed identifier sits on line 6
		// (1-based) in both files, not line 1 — a line-1 edit's real 1-based
		// range ({1,1}) is indistinguishable from the {1,1} resource-op/
		// whole-file-fallback default, so a test asserting {1,1} stays green
		// even with every range-plumbing step between the mocked WorkspaceEdit
		// and the turn-state entry neutered.
		const filler = "// filler line\n".repeat(5);
		fs.writeFileSync(fileA, `${filler}const oldName = 1;\n`);
		fs.writeFileSync(fileB, `${filler}import { oldName } from './a';\n`);

		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-rename" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);

		const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
			runtime: runtime as never,
			cacheManager,
			readGuard: { recordWritten: () => {} },
			dbg: () => {},
		});

		(mocked.service as { rename: ReturnType<typeof vi.fn> }).rename = vi
			.fn()
			.mockResolvedValue({
				changes: {
					[pathToFileURL(fileA).href]: [
						{
							range: {
								start: { line: 5, character: 6 },
								end: { line: 5, character: 13 },
							},
							newText: "newName",
						},
					],
					[pathToFileURL(fileB).href]: [
						{
							range: {
								start: { line: 5, character: 9 },
								end: { line: 5, character: 16 },
							},
							newText: "newName",
						},
					],
				},
			});

		try {
			const result = await tool.execute(
				"rename-two-files",
				{
					operation: "rename",
					path: fileA,
					line: 6,
					character: 7,
					newName: "newName",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(result.isError).toBeUndefined();
			expect(fs.readFileSync(fileA, "utf-8")).toBe(
				`${filler}const newName = 1;\n`,
			);
			expect(fs.readFileSync(fileB, "utf-8")).toBe(
				`${filler}import { newName } from './a';\n`,
			);

			// Both files land in turn-state.json — not just whichever one the
			// agent had already read/written — BEFORE any turn-boundary sweep.
			const turnFiles = cacheManager.readTurnState(tmpDir).files ?? {};
			const keys = Object.keys(turnFiles);
			expect(keys).toHaveLength(2);
			for (const file of [fileA, fileB]) {
				const key = keys.find(
					(k) =>
						normalizeMapKey(file).endsWith(k) || k === normalizeMapKey(file),
				);
				expect(key, `expected a turn-state entry for ${file}`).toBeDefined();
				const entry = turnFiles[key as string];
				// Real ranges from the computed fileDetails (line 6, 1-based) —
				// never the {1,1} resource-op default a text edit should never
				// fall back to.
				expect(entry.modifiedRanges).toEqual([{ start: 6, end: 6 }]);
			}

			// The receipt names the LSP operation — "lsp-rename" — instead of the
			// generic "lsp-edit" tag every LSP mutation used to collapse onto.
			const changes = readChangesSince(tmpDir, 0);
			expect(changes).toHaveLength(2);
			expect(changes.map((c) => c.source)).toEqual([
				"lsp-rename",
				"lsp-rename",
			]);
			expect(new Set(changes.map((c) => c.filePath))).toEqual(
				new Set([fileA, fileB].map((f) => path.resolve(f))),
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #2450 review round 2 (F4). Before this round, the direct (deps-threaded)
	// path had NO recordability gate at all — only the mutation-bridge
	// fallback applied `no-read-guard`/ignored/vendor filtering internally.
	// Reconciled: the SAME gate (`isRecordableProjectPath`, shared with
	// `index.ts`'s bridge registrations) now applies to the direct path too,
	// via `LspMutationContext.isRecordable`, threaded here.
	it("#2450 review round 2 (F4): a rename touching a vendor-directory file records only the non-vendor file", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nav-2450-vendor-"),
		);
		const fileA = path.join(tmpDir, "a.ts");
		const vendorDir = path.join(tmpDir, "node_modules", "some-pkg");
		fs.mkdirSync(vendorDir, { recursive: true });
		const fileVendor = path.join(vendorDir, "vendored.ts");
		const filler = "// filler line\n".repeat(5);
		fs.writeFileSync(fileA, `${filler}const oldName = 1;\n`);
		fs.writeFileSync(fileVendor, `${filler}const oldName = 2;\n`);

		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-vendor-gate" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);

		const tool = createLspNavigationTool((flag) => flag === "lens-lsp", {
			runtime: runtime as never,
			cacheManager,
			readGuard: { recordWritten: () => {} },
			dbg: () => {},
		});

		(mocked.service as { rename: ReturnType<typeof vi.fn> }).rename = vi
			.fn()
			.mockResolvedValue({
				changes: {
					[pathToFileURL(fileA).href]: [
						{
							range: {
								start: { line: 5, character: 6 },
								end: { line: 5, character: 13 },
							},
							newText: "newName",
						},
					],
					[pathToFileURL(fileVendor).href]: [
						{
							range: {
								start: { line: 5, character: 6 },
								end: { line: 5, character: 13 },
							},
							newText: "newName",
						},
					],
				},
			});

		try {
			const result = await tool.execute(
				"rename-skips-vendor",
				{
					operation: "rename",
					path: fileA,
					line: 6,
					character: 7,
					newName: "newName",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(result.isError).toBeUndefined();
			// The write itself still lands on disk for both files — the gate is a
			// BOOKKEEPING filter, not an edit-application one.
			expect(fs.readFileSync(fileA, "utf-8")).toBe(
				`${filler}const newName = 1;\n`,
			);
			expect(fs.readFileSync(fileVendor, "utf-8")).toBe(
				`${filler}const newName = 2;\n`,
			);

			const turnFiles = cacheManager.readTurnState(tmpDir).files ?? {};
			const keys = Object.keys(turnFiles);
			expect(keys).toHaveLength(1);
			expect(keys[0]).toContain("a.ts");
			expect(keys.some((k) => k.includes("vendored.ts"))).toBe(false);

			const changes = readChangesSince(tmpDir, 0);
			expect(changes).toHaveLength(1);
			expect(changes[0].filePath).toBe(path.resolve(fileA));
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #2450 fix round 3 (F2): no-read-guard must gate ONLY the read-guard
	// stamp (clients/runtime-tool-result.ts:1120,:1485 — the canonical
	// semantics), never bookkeeping (turn-state / receipts). Before this
	// round, isRecordable short-circuited to false whenever no-read-guard
	// was set, so a rename under --no-read-guard recorded NOTHING at all
	// instead of just skipping the read-guard stamp.
	it("#2450 fix round 3 (F2): a rename under --no-read-guard still records turn-state and receipts, but skips the read-guard stamp", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-nav-2450-no-read-guard-"),
		);
		const fileA = path.join(tmpDir, "a.ts");
		const fileB = path.join(tmpDir, "b.ts");
		const filler = "// filler line\n".repeat(5);
		fs.writeFileSync(fileA, `${filler}const oldName = 1;\n`);
		fs.writeFileSync(fileB, `${filler}import { oldName } from './a';\n`);

		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = tmpDir;
		runtime.setTelemetryIdentity({ sessionId: "s-2450-no-read-guard" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);

		const recordWritten = vi.fn();
		const tool = createLspNavigationTool((flag) => flag === "no-read-guard", {
			runtime: runtime as never,
			cacheManager,
			readGuard: { recordWritten },
			dbg: () => {},
		});

		(mocked.service as { rename: ReturnType<typeof vi.fn> }).rename = vi
			.fn()
			.mockResolvedValue({
				changes: {
					[pathToFileURL(fileA).href]: [
						{
							range: {
								start: { line: 5, character: 6 },
								end: { line: 5, character: 13 },
							},
							newText: "newName",
						},
					],
					[pathToFileURL(fileB).href]: [
						{
							range: {
								start: { line: 5, character: 9 },
								end: { line: 5, character: 16 },
							},
							newText: "newName",
						},
					],
				},
			});

		try {
			const result = await tool.execute(
				"rename-no-read-guard",
				{
					operation: "rename",
					path: fileA,
					line: 6,
					character: 7,
					newName: "newName",
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);

			expect(result.isError).toBeUndefined();

			const turnFiles = cacheManager.readTurnState(tmpDir).files ?? {};
			expect(Object.keys(turnFiles)).toHaveLength(2);

			const changes = readChangesSince(tmpDir, 0);
			expect(changes).toHaveLength(2);

			// no-read-guard gates ONLY the read-guard stamp, never bookkeeping.
			expect(recordWritten).not.toHaveBeenCalled();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #2450 fix round 3 (F4) note: `isRecordable`'s cwd-vs-projectRoot
	// divergence is NOT reachable through this file's mocked-service harness.
	// `rename`'s real (unmocked) `applyWorkspaceEdit(edit, ctx.cwd, ...)`
	// confines every touched file to `ctx.cwd` itself (clients/lsp/edits.ts
	// `createWorkspaceUriConfiner`) — a file outside `ctx.cwd` throws
	// "workspace edit path escapes workspace" before bookkeeping ever runs,
	// so a cross-package edit can't reach `isRecordable` this way at all.
	// `executeCommand`'s edit application is fully mocked at the service
	// layer here (`mocked.service.executeCommand`), so it never exercises the
	// real `bookkeepLspMutation`/`isRecordable` path either. The actually
	// reachable production shape — a single executeCommand's server-initiated
	// `workspace/applyEdit`, confined to `state.root` (the LSP CLIENT's
	// launch root, which can span multiple packages) rather than `ctx.cwd` —
	// is covered against the real wire protocol in
	// tests/clients/lsp/integration.test.ts ("records a server-initiated
	// edit on a sibling package when the mutation context's isRecordable
	// judges against the project root, not cwd").
});
