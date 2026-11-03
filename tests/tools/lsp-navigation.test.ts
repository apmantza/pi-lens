// flake-shape: in-process-mock — the declaration owner is wrapped, not replaced:
// every other export stays real, and only the resolver is counted so the
// snapshot's per-file walks are observable (#4638 review F10).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	TEST_FIXTURE_ROOT_MARKER,
	pinFixtureHome,
	removeTempDirSync,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import {
	addRenameClient,
	makeRenameClient,
} from "../support/lsp-rename-client-double.js";
import { LSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
} from "../../clients/latency-logger.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

// #4638 review (F10): the declaration owner is wrapped, not replaced — every
// other export stays real — so the snapshot's per-file walks can be counted.
const walkedDeclarations = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock("../../clients/python-environment.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/python-environment.js")
		>();
	return {
		...actual,
		detectPythonTargetVersion: vi.fn(async (filePath: string) => {
			walkedDeclarations.files.push(filePath);
			return actual.detectPythonTargetVersion(filePath);
		}),
	};
});

import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLspNavigationTool as createRawLspNavigationTool } from "../../tools/lsp-navigation.js";
import { LspRequestTimeoutError } from "../../clients/lsp/request-timeout-error.js";
import { installLspService } from "../support/lsp-service-seam.js";

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

/**
 * The contract cases below assert the structured envelope, so they call the
 * tool under the `view:"json"` hatch. The default text rendering has its own
 * suite (`describe("lsp_navigation default text view")`), which builds the raw
 * factory.
 */
function withJsonView(
	tool: ReturnType<typeof createRawLspNavigationTool>,
): ReturnType<typeof createRawLspNavigationTool> {
	return {
		...tool,
		execute: (...args: Parameters<typeof tool.execute>) => {
			const [toolCallId, params, signal, onUpdate, ctx] = args;
			return tool.execute(
				toolCallId,
				{ view: "json", ...params },
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}

const createLspNavigationTool: typeof createRawLspNavigationTool = (
	getFlag,
	deps,
) => withJsonView(createRawLspNavigationTool(getFlag, deps));

describe("lsp_navigation tool", () => {
	beforeEach(() => {
		// #2598: `openFileBestEffort` no longer branches on `touchFile` being
		// present — the real `LSPService` always has it — so the double keeps the
		// factory's `touchFile`, and the scoped-open case below asserts the touch
		// (with its options), which is the call production actually makes.
		mocked.service = installLspService(
			makeLspServiceDouble({
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
				// #3601: a rename edit that writes a file besides its target is applied
				// only to a file the client tracks. These cases are about provenance,
				// not staleness, so every file reads as tracked in sync with the disk,
				// sent long before the rename.
				getTrackedContent: vi.fn((filePath: string) => ({
					hash: hashDiagnosticContent(fs.readFileSync(filePath, "utf-8")),
					changedAtMs: 0,
				})),
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
			}),
		);
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
		expect(result.details?.failureKind).toBe("lsp_disabled");
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

	// #4687: the schema carries callHierarchyItem as an opaque object, so the
	// LSP CallHierarchyItem shape is checked at execute, before any server call
	// (MCP never validates the schema at all). Recurrence: a malformed item
	// reaching `uriToPath` or the server, where it fails as an opaque error or
	// an empty "no callers" answer instead of a refusal naming the field.
	const wellFormedItem = () => ({
		name: "foo",
		kind: 12,
		uri: tmpFileUrl("item.py"),
		range: {
			start: { line: 1, character: 0 },
			end: { line: 1, character: 3 },
		},
		selectionRange: {
			start: { line: 1, character: 0 },
			end: { line: 1, character: 3 },
		},
	});
	it.each([
		[
			"absent",
			(): unknown => undefined,
			"callHierarchyItem parameter required",
		],
		[
			"a string",
			(): unknown => "foo",
			"callHierarchyItem must be the object prepareCallHierarchy returned",
		],
		// #4723 F7: an array is an object to `typeof`; without the array branch
		// it would be reported as a missing `name` instead of the wrong shape.
		[
			"an array",
			(): unknown => [],
			"callHierarchyItem must be the object prepareCallHierarchy returned",
		],
		[
			"no uri",
			(): unknown => ({ ...wellFormedItem(), uri: undefined }),
			"callHierarchyItem.uri must be a string",
		],
		[
			"a string kind",
			(): unknown => ({ ...wellFormedItem(), kind: "Function" }),
			"callHierarchyItem.kind must be a number",
		],
		[
			"no range",
			(): unknown => ({ ...wellFormedItem(), range: undefined }),
			"callHierarchyItem.range must be a range object",
		],
		[
			"a string selectionRange.end.character",
			(): unknown => {
				const item = wellFormedItem();
				return {
					...item,
					selectionRange: {
						...item.selectionRange,
						end: { line: 1, character: "3" },
					},
				};
			},
			"callHierarchyItem.selectionRange.end.character must be a number",
		],
	] satisfies ReadonlyArray<readonly [string, () => unknown, string]>)(
		"refuses a callHierarchyItem that is %s before any server call",
		async (_label, makeItem, message) => {
			for (const operation of ["incomingCalls", "outgoingCalls"] as const) {
				const service = mocked.service as Record<
					string,
					ReturnType<typeof vi.fn>
				>;
				service.getOperationSupport?.mockClear();
				service[operation]?.mockClear();
				const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
				const result = await tool.execute(
					`bad-item-${operation}`,
					{ operation, callHierarchyItem: makeItem() },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				expect(result.isError).toBe(true);
				expect(result.details?.failureKind).toBe("bad_input");
				expect(parseToolJson(result).errors).toEqual([
					`${message} for ${operation}`,
				]);
				expect(service[operation]).not.toHaveBeenCalled();
				expect(service.getOperationSupport).not.toHaveBeenCalled();
			}
		},
	);

	it("passes a call hierarchy item's extra fields (detail, data) to the server unchanged", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const callHierarchyItem = {
			...wellFormedItem(),
			detail: "module a",
			data: { serverToken: 7 },
		};
		await tool.execute(
			"item-extra",
			{ operation: "outgoingCalls", callHierarchyItem },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(
			(mocked.service as { outgoingCalls: ReturnType<typeof vi.fn> })
				.outgoingCalls,
		).toHaveBeenCalledWith(callHierarchyItem);
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
			expect(executeCall).toBeDefined();
			expect(
				(
					executeCall![3] as {
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
		// A server answered: the service has a client for the file. With no
		// client (`null`), an empty answer is no_server (#4403 round 5, V5).
		(
			mocked.service as { getOperationSupport: ReturnType<typeof vi.fn> }
		).getOperationSupport = vi.fn().mockResolvedValue({ declaration: true });

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

	it("reports a navigation timeout as an error, not an empty result", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		(
			mocked.service as { documentSymbol: ReturnType<typeof vi.fn> }
		).documentSymbol = vi
			.fn()
			.mockRejectedValue(
				new LspRequestTimeoutError("textDocument/documentSymbol", 100, 101),
			);

		const result = await tool.execute(
			"document-symbol-timeout",
			{
				operation: "documentSymbol",
				path: path.resolve("tests/tools/lsp-navigation.test.ts"),
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);

		expect(result.isError).toBe(true);
		expect(parseToolJson(result)).toMatchObject({
			ok: false,
			status: "timeout",
			resultCount: 0,
		});
		expect(String(result.content[0]?.text)).toContain("timed out");
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
			).toHaveBeenCalledWith(filePath, undefined, new Set());
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("renders a file diagnostic pull timeout instead of an empty envelope", async () => {
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-nav-"));
		const filePath = path.join(tmpDir, "diag.ts");
		fs.writeFileSync(filePath, "const value = 1;\n");
		const service = mocked.service as {
			getWorkspaceDiagnosticsSupport: ReturnType<typeof vi.fn>;
			getDiagnostics: ReturnType<typeof vi.fn>;
			getDiagnosticsHealth: ReturnType<typeof vi.fn>;
		};
		service.getWorkspaceDiagnosticsSupport = vi
			.fn()
			.mockResolvedValue({ mode: "pull" });
		service.getDiagnostics = vi.fn().mockResolvedValue([]);
		service.getDiagnosticsHealth = vi.fn().mockReturnValue({
			health: "timeout",
			failureKind: "timeout",
		});
		try {
			const result = await tool.execute(
				"diagnostics-timeout",
				{ operation: "workspaceDiagnostics", path: filePath },
				new AbortController().signal,
				null,
				{ cwd: "." },
			);
			const envelope = parseToolJson(result);
			expect(result.isError).toBe(true);
			expect(envelope).toMatchObject({ ok: false, status: "timeout" });
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

	// #4578: the `rename_file` destination is a WRITE target, so it resolves
	// through the same host-path seam pi's own write tool uses
	// (`resolveHostToolPath`, clients/path-utils.ts): `~` expands to `$HOME`, a
	// leading `@` mention prefix is dropped, pi's unicode space class folds to
	// U+0020, and a `file://` URL converts. Pre-fix the destination took a bare
	// `path.resolve(cwd, x)`, so `~/renamed.ts` became `<cwd>/~/renamed.ts`: the
	// rename created a literal `~` directory inside the project and rewrote every
	// importer to point into it. These cells drive the real tool over a real
	// `LSPService`, so the rename, the confinement check, and the importer
	// rewrite are the production ones.
	describe("rename_file destination resolution (#4578)", () => {
		/**
		 * A real `LSPService` rename behind the factory-seeded service double.
		 *
		 * `renameFile` is the PRODUCTION implementation on a real service, so the
		 * destination resolution, the workspace confinement and the importer
		 * rewrite are the shipped ones. Every other member is the double's `vi.fn`,
		 * which is what keeps a language server from starting: the tool resyncs the
		 * renamed file through `openFileBestEffort` -> `touchFile`, and a bare real
		 * service SPAWNS for that call (measured here: `touchFile` on a `.ts` file
		 * left `deno` running, `getAliveClientCount()` 1). This suite is not the
		 * `lsp-spawn-heavy` lane and must start no server.
		 */
		const makeRenameHarness = () => {
			const realService = new LSPService();
			const service = makeLspServiceDouble({
				// The tool's own dispatch gate: a file operation is only reached
				// when the service reports a server for the file (tools/lsp-navigation.ts
				// `supportsLSP` gate). This is the double saying "yes", not a server.
				supportsLSP: vi.fn(() => true),
				hasLSP: vi.fn(async () => true),
				renameFile: (
					oldFilePath: string,
					newFilePath: string,
					options: Parameters<LSPService["renameFile"]>[2],
				) => realService.renameFile(oldFilePath, newFilePath, options),
			});
			return {
				realService,
				service,
				touchFile: service.touchFile as ReturnType<typeof vi.fn>,
				/**
				 * The real service's own `touchFile` is the only call that can
				 * discover and spawn a server, so instrument it (the spy keeps the
				 * implementation) and assert it is never reached.
				 */
				realTouchFile: vi.spyOn(realService, "touchFile"),
				/** Nothing the case started may outlive it, before its fixture goes. */
				stop: async (): Promise<void> => {
					await realService.shutdown();
				},
			};
		};

		type RenameHarness = ReturnType<typeof makeRenameHarness>;

		const renameThroughTool = async (
			harness: RenameHarness,
			cwd: string,
			callId: string,
			sourcePath: string,
			newFilePath: string,
		) => {
			mocked.service = installLspService(harness.service);
			const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
			return tool.execute(
				callId,
				{
					operation: "rename_file",
					path: sourcePath,
					newFilePath,
					apply: true,
				},
				new AbortController().signal,
				null,
				{ cwd },
			);
		};

		/**
		 * No language server was started. Two arms, same claim: the real service
		 * never reached its spawn-capable `touchFile`, and its live clients are
		 * exactly the fixture's — a real spawn adds a `serverId` entry.
		 */
		const expectNoServerStarted = (
			harness: RenameHarness,
			registeredServerIds: string[],
		): void => {
			expect(harness.realTouchFile).not.toHaveBeenCalled();
			expect(
				harness.realService.getStatus().map((entry) => entry.serverId),
			).toEqual(registeredServerIds);
		};

		it("expands a ~ destination to $HOME and rewrites the importer there, never a ~ directory under the cwd", async () => {
			// #4591: this cell needs HOME to CONTAIN the workspace, because a
			// `~/…` destination has to land inside it. Both live under the pinned
			// fixture home, which is outside every root the harness deletes, so a
			// straggler child writing to its inherited HOME cannot re-create one.
			const { home, restore } = pinFixtureHome("lsp-nav-4578-home");
			const workspace = path.join(home, "workspace");
			fs.mkdirSync(path.join(workspace, TEST_FIXTURE_ROOT_MARKER), {
				recursive: true,
			});
			const oldPath = path.join(workspace, "old.ts");
			const importPath = path.join(workspace, "import.ts");
			const renamedPath = path.join(workspace, "renamed.ts");
			fs.writeFileSync(oldPath, "export const value = 1;\n");
			fs.writeFileSync(importPath, "import { value } from './old';\n");
			// #3601: an importer no language client has open is refused when its
			// mtime sits within 2 s of the rename request. An old mtime is the
			// fixture for "the server read these bytes earlier", not a wait.
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(importPath, past, past);

			const harness = makeRenameHarness();
			const client = makeRenameClient(workspace, {
				changes: {
					[pathToFileURL(importPath).href]: [
						{
							range: {
								start: { line: 0, character: 25 },
								end: { line: 0, character: 28 },
							},
							newText: "renamed",
						},
					],
				},
			});
			addRenameClient(harness.realService, "typescript", workspace, client);
			// Prove the pin TOOK: the rename writes at the resolved destination, so
			// a pin that silently fell through would put a test file in the
			// developer's real home.
			expect(os.homedir(), "the fixture HOME did not take effect").toBe(home);

			try {
				const result = await renameThroughTool(
					harness,
					workspace,
					"rename-file-tilde-home",
					oldPath,
					"~/workspace/renamed.ts",
				);

				expect(result.isError).toBeUndefined();
				// The defect: the destination joined onto the cwd as
				// `<cwd>/~/workspace/renamed.ts`.
				expect(fs.existsSync(path.join(workspace, "~"))).toBe(false);
				expect(fs.readFileSync(renamedPath, "utf-8")).toBe(
					"export const value = 1;\n",
				);
				expect(fs.existsSync(oldPath)).toBe(false);
				// The server was asked about the expanded destination, so the importer
				// rewrite it computed names the file that actually landed.
				expect(client.willRenameFiles).toHaveBeenCalledWith(
					oldPath,
					renamedPath,
				);
				expect(fs.readFileSync(importPath, "utf-8")).toBe(
					"import { value } from './renamed';\n",
				);
				// The post-rename resync ran, and it reached the double only.
				expectNoServerStarted(harness, ["typescript"]);
				expect(harness.touchFile).toHaveBeenCalled();
			} finally {
				restore();
				await harness.stop();
			}
		});

		it("expands a ~ destination outside the workspace and refuses it without creating a ~ directory", async () => {
			const { home, restore } = pinFixtureHome("lsp-nav-4578-home-outside");
			const project = setupTestEnvironment("pi-lens-lsp-nav-4578-project-");
			const oldPath = path.join(project.tmpDir, "old.ts");
			fs.writeFileSync(oldPath, "export const value = 1;\n");
			const harness = makeRenameHarness();
			expect(os.homedir(), "the fixture HOME did not take effect").toBe(home);

			try {
				const result = await renameThroughTool(
					harness,
					project.tmpDir,
					"rename-file-tilde-outside",
					oldPath,
					"~/renamed.ts",
				);

				// The existing rename confinement refuses a destination outside the
				// workspace, and its message names the EXPANDED destination: the
				// refusal is about `$HOME/renamed.ts`, not about a `~` under the cwd.
				expect(result.isError).toBe(true);
				expect(String(result.content[0]?.text)).toContain(
					`workspace edit path escapes workspace: ${pathToFileURL(path.join(home, "renamed.ts")).href}`,
				);
				expect(result.details?.failureKind).toBe("lsp_error");
				expect(fs.existsSync(oldPath)).toBe(true);
				expect(fs.existsSync(path.join(project.tmpDir, "~"))).toBe(false);
				expect(fs.existsSync(path.join(home, "renamed.ts"))).toBe(false);
				expectNoServerStarted(harness, []);
			} finally {
				restore();
				await harness.stop();
				project.cleanup();
			}
		});

		it("drops a leading @ mention prefix on the destination, as pi's write path does", async () => {
			const env = setupTestEnvironment("pi-lens-lsp-nav-4578-at-prefix-");
			const oldPath = path.join(env.tmpDir, "old.ts");
			fs.writeFileSync(oldPath, "export const value = 1;\n");
			const harness = makeRenameHarness();

			try {
				// pi's `normalizePath` drops ONE leading `@` (its file-mention prefix),
				// so a destination spelled `@renamed.ts` names the file `renamed.ts`.
				// A file genuinely called `@renamed.ts` stays reachable as
				// `./@renamed.ts`, exactly as it does for pi's own write tool.
				const result = await renameThroughTool(
					harness,
					env.tmpDir,
					"rename-file-at-prefix",
					oldPath,
					"@renamed.ts",
				);

				expect(result.isError).toBeUndefined();
				expect(fs.existsSync(path.join(env.tmpDir, "renamed.ts"))).toBe(true);
				expect(fs.existsSync(path.join(env.tmpDir, "@renamed.ts"))).toBe(false);

				// Only a LEADING `@` is pi's mention prefix, so the `./@…` spelling keeps
				// the character: a file genuinely called `@kept.ts` stays reachable,
				// exactly as it does for pi's own write tool.
				const literal = await renameThroughTool(
					harness,
					env.tmpDir,
					"rename-file-at-literal",
					path.join(env.tmpDir, "renamed.ts"),
					"./@kept.ts",
				);

				expect(literal.isError).toBeUndefined();
				expect(fs.existsSync(path.join(env.tmpDir, "@kept.ts"))).toBe(true);
				expect(fs.existsSync(path.join(env.tmpDir, "kept.ts"))).toBe(false);
				expectNoServerStarted(harness, []);
				expect(harness.touchFile).toHaveBeenCalled();
			} finally {
				await harness.stop();
				env.cleanup();
			}
		});

		it("folds pi's unicode space class on the destination, as pi's write path does", async () => {
			const env = setupTestEnvironment("pi-lens-lsp-nav-4578-nbsp-");
			const oldPath = path.join(env.tmpDir, "old.ts");
			fs.writeFileSync(oldPath, "export const value = 1;\n");
			const foldedPath = path.join(env.tmpDir, "renamed a.ts");
			const harness = makeRenameHarness();

			try {
				// U+00A0 is in pi's unicode space class, which folds to U+0020 before
				// resolution, so a destination typed with it names the plain-space file.
				const result = await renameThroughTool(
					harness,
					env.tmpDir,
					"rename-file-unicode-space",
					oldPath,
					`renamed${String.fromCharCode(0x00a0)}a.ts`,
				);

				expect(result.isError).toBeUndefined();
				expect(fs.existsSync(foldedPath)).toBe(true);
				expect(
					fs.existsSync(
						path.join(env.tmpDir, `renamed${String.fromCharCode(0x00a0)}a.ts`),
					),
				).toBe(false);
				expectNoServerStarted(harness, []);
				expect(harness.touchFile).toHaveBeenCalled();
			} finally {
				await harness.stop();
				env.cleanup();
			}
		});
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

// #1634: every diagnostics read routes through the shared finding policy or
// carries an age label. `lsp_navigation workspaceDiagnostics` did neither: the
// path read rendered raw server findings with no disposition, rule-policy or
// inline `pi-lens-ignore` filter (the stack `lens_diagnostics source=lsp`
// applies since #3088), and the tracked snapshot replayed client-published rows
// of unknown age. Recurrence it prevents: an agent that marked a finding
// `false-positive` saw it again on this route, and a snapshot row published
// before an out-of-band edit read as current.
describe("lsp_navigation workspaceDiagnostics delivery gate (#1634)", () => {
	const MARKED = "Type 'string' is not assignable to type 'number'.";
	const KEPT = "Cannot find name 'other'.";
	let cwd: string;
	let filePath: string;
	let previousDataDir: string | undefined;

	const serverDiagnostics = () => [
		{
			severity: 1,
			message: MARKED,
			source: "typescript",
			code: 2322,
			range: {
				start: { line: 0, character: 6 },
				end: { line: 0, character: 11 },
			},
		},
		{
			severity: 1,
			message: KEPT,
			source: "typescript",
			code: 2304,
			range: {
				start: { line: 1, character: 13 },
				end: { line: 1, character: 18 },
			},
		},
	];

	beforeEach(async () => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1634-nav-"));
		filePath = path.join(cwd, "app.ts");
		fs.writeFileSync(
			filePath,
			"const value: number = 'bad';\nexport const other = 1;\n",
		);
		previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				getDiagnostics: vi.fn().mockResolvedValue([]),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				getWorkspaceDiagnosticsSupport: vi
					.fn()
					.mockResolvedValue({ mode: "push-only" }),
			}),
		);
		_resetDeferredForTests();
		_resetStateCacheForTests();
		// The phase ring is process state: an earlier case's record must not
		// satisfy this case's trace assertion.
		_setRecentPhasesForTest([]);
		const marked = await createLensDiagnosticMarkTool(() => cwd).execute(
			"mark-1634",
			{
				filePath,
				line: 1,
				message: MARKED,
				rule: "typescript:2322",
				tool: "lsp",
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd },
		);
		expect(marked.isError).toBeFalsy();
	});

	afterEach(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetDeferredForTests();
		_resetStateCacheForTests();
		removeTempDirSync(cwd);
	});

	const resultMessages = (envelope: Record<string, unknown>): string[] =>
		(envelope.result as Array<{ diagnostics: Array<{ message: string }> }>)
			.flatMap((entry) => entry.diagnostics)
			.map((diagnostic) => diagnostic.message);

	it("drops a finding marked false-positive from the path read and states the count", async () => {
		(mocked.service as { getDiagnostics: unknown }).getDiagnostics = vi
			.fn()
			.mockResolvedValue(serverDiagnostics());
		(
			mocked.service as { getWorkspaceDiagnosticsSupport: unknown }
		).getWorkspaceDiagnosticsSupport = vi
			.fn()
			.mockResolvedValue({ mode: "pull" });

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"nav-1634-path",
			{ operation: "workspaceDiagnostics", path: filePath },
			new AbortController().signal,
			null,
			{ cwd },
		);
		const envelope = parseToolJson(result);

		expect(resultMessages(envelope)).toEqual([KEPT]);
		expect(result.details?.dispositionSuppressed).toBe(1);
		expect(envelope.notes).toContainEqual(
			expect.stringContaining("suppressed by disposition: 1 finding(s)"),
		);
		// The lane's bounded trace: one record for the file it filtered, named
		// for the tool that rendered it (#4459 review F5).
		expect(getRecentLoggedPhases()).toContainEqual(
			expect.objectContaining({
				phase: "lsp_probe_disposition_filter",
				toolName: "lsp_navigation",
				metadata: expect.objectContaining({ suppressed: 1 }),
			}),
		);
	});

	it("filters the tracked snapshot the same way and labels each file's age", async () => {
		(mocked.service as { getAllDiagnostics: unknown }).getAllDiagnostics = vi
			.fn()
			.mockResolvedValue(
				new Map([
					[
						filePath,
						{ diags: serverDiagnostics(), ts: Date.now() - 5 * 60_000 },
					],
				]),
			);

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"nav-1634-snapshot",
			{ operation: "workspaceDiagnostics" },
			new AbortController().signal,
			null,
			{ cwd },
		);
		const envelope = parseToolJson(result);
		const [entry] = envelope.result as Array<{ lag?: string }>;

		expect(resultMessages(envelope)).toEqual([KEPT]);
		expect(entry?.lag).toBe("scanned 5m ago");
		expect(result.details?.dispositionSuppressed).toBe(1);
		expect(envelope.notes).toContainEqual(
			expect.stringContaining("suppressed by disposition: 1 finding(s)"),
		);
		expect(getRecentLoggedPhases()).toContainEqual(
			expect.objectContaining({
				phase: "lsp_probe_disposition_filter",
				toolName: "lsp_navigation",
			}),
		);
	});

	const COMPILE = "SyntaxError: multiple exception types must be parenthesized";
	const PYRIGHT = 'Cannot access attribute "value" for class "object"';

	const jediCompileRow = () => ({
		severity: 1,
		message: COMPILE,
		source: "compile",
		rule: "compile:unknown",
		semantic: "blocking" as const,
		serverId: "python-jedi",
		range: {
			start: { line: 2, character: 8 },
			end: { line: 2, character: 20 },
		},
	});
	const pyrightRow = () => ({
		severity: 1,
		message: PYRIGHT,
		source: "pyright",
		serverId: "pyright",
		range: { start: { line: 4, character: 4 }, end: { line: 4, character: 9 } },
	});

	async function snapshotWith(
		files: Array<[string, Array<Record<string, unknown>>]>,
	) {
		walkedDeclarations.files.length = 0;
		(mocked.service as { getAllDiagnostics: unknown }).getAllDiagnostics = vi
			.fn()
			.mockResolvedValue(
				new Map(
					files.map(([file, diags]) => [file, { diags, ts: Date.now() }]),
				),
			);
		return parseToolJson(
			await createLspNavigationTool((flag) => flag === "lens-lsp").execute(
				"nav-4638",
				{ operation: "workspaceDiagnostics" },
				new AbortController().signal,
				null,
				{ cwd },
			),
		);
	}

	function snapshotRows(envelope: Record<string, unknown>) {
		return (
			envelope.result as Array<{
				diagnostics: Array<Record<string, unknown>>;
			}>
		).flatMap((entry) => entry.diagnostics);
	}

	it("drops jedi's compile row from the tracked snapshot and names what it withheld (#4638 F10)", async () => {
		const jediFile = path.join(cwd, "jedi_only.py");
		const typedFile = path.join(cwd, "typed.py");
		fs.writeFileSync(jediFile, "def run() -> None:\n\tpass\n");
		fs.writeFileSync(typedFile, "value: int = 1\n");
		fs.writeFileSync(
			path.join(cwd, "pyproject.toml"),
			'[project]\nname = "d"\nrequires-python = ">=3.14"\n',
		);

		const envelope = await snapshotWith([
			[jediFile, [jediCompileRow(), pyrightRow()]],
			[typedFile, [pyrightRow()]],
		]);

		expect(resultMessages(envelope)).not.toContain(COMPILE);
		expect(resultMessages(envelope)).toContain(PYRIGHT);
		expect(envelope.notes).toContainEqual(
			expect.stringContaining("1 python-jedi compile finding withheld"),
		);
		// The filter is what keeps the pyright-only file from paying for a walk.
		expect(walkedDeclarations.files).not.toContain(typedFile);
		expect(walkedDeclarations.files).toContain(jediFile);
	});

	it("cites each project's own declaration when the snapshot spans two (#4638 r4 F3)", async () => {
		// Recurrence: the snapshot printed the FIRST file's count under the first
		// declaration while the details carried the total, so two projects read as
		// one level and the text and the details disagreed.
		const a = path.join(cwd, "a");
		const b = path.join(cwd, "b");
		for (const [dir, level] of [
			[a, "3.14"],
			[b, "3.15"],
		] as const) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "pyproject.toml"),
				`[project]\nname = "d"\nrequires-python = ">=${level}"\n`,
			);
			fs.writeFileSync(
				path.join(dir, "app.py"),
				"def run() -> None:\n\tpass\n",
			);
		}

		const envelope = await snapshotWith([
			[path.join(a, "app.py"), [jediCompileRow()]],
			[path.join(b, "app.py"), [jediCompileRow()]],
		]);

		const note = (envelope.notes as string[]).find((entry) =>
			entry.includes("withheld"),
		);
		expect(note).toContain(
			"2 python-jedi compile findings withheld across 2 declarations",
		);
		expect(note).toContain(
			`1 under Python 3.14 (requires-python) in ${path.join(a, "pyproject.toml")}`,
		);
		expect(note).toContain(
			`1 under Python 3.15 (requires-python) in ${path.join(b, "pyproject.toml")}`,
		);
	});

	it("names the withheld row on the single-file path read (#4638 r3 N2)", async () => {
		// Recurrence: the path route filtered the row and returned a bare empty
		// answer (`empty_result`), indistinguishable from "no findings published".
		const jediFile = path.join(cwd, "jedi_only.py");
		fs.writeFileSync(jediFile, "def run() -> None:\n\tpass\n");
		fs.writeFileSync(
			path.join(cwd, "pyproject.toml"),
			'[project]\nname = "d"\nrequires-python = ">=3.14"\n',
		);
		const service = mocked.service as {
			getWorkspaceDiagnosticsSupport: unknown;
			getDiagnostics: unknown;
		};
		service.getWorkspaceDiagnosticsSupport = vi
			.fn()
			.mockResolvedValue({ mode: "pull" });
		service.getDiagnostics = vi.fn().mockResolvedValue([jediCompileRow()]);

		const result = await createLspNavigationTool(
			(flag) => flag === "lens-lsp",
		).execute(
			"nav-4638-path",
			{ operation: "workspaceDiagnostics", path: jediFile },
			new AbortController().signal,
			null,
			{ cwd },
		);

		const envelope = parseToolJson(result);
		expect(resultMessages(envelope)).not.toContain(COMPILE);
		expect(envelope.notes).toContainEqual(
			expect.stringContaining(
				"1 python-jedi compile finding withheld: the project declares Python 3.14 (requires-python)",
			),
		);
		// One shape on every tool (#4638 r4 F2): the object the other two tools
		// carry, never a bare count.
		expect(result.details?.withheldCompile).toEqual({
			count: 1,
			declared: expect.objectContaining({
				major: 3,
				minor: 14,
				source: "requires-python",
				file: path.join(cwd, "pyproject.toml"),
			}),
		});
	});

	it("still delivers jedi's compile row blocking while the project declares 3.13 (#4638 F10)", async () => {
		const jediFile = path.join(cwd, "jedi_only.py");
		fs.writeFileSync(jediFile, "def run() -> None:\n\tpass\n");
		fs.writeFileSync(
			path.join(cwd, "pyproject.toml"),
			'[project]\nname = "d"\nrequires-python = ">=3.13"\n',
		);

		const envelope = await snapshotWith([
			[jediFile, [jediCompileRow(), pyrightRow()]],
		]);

		expect(snapshotRows(envelope)).toContainEqual(
			expect.objectContaining({ message: COMPILE, semantic: "blocking" }),
		);
	});
});

/**
 * #4577 M2: `path` is a host-supplied tool path, so it resolves through the
 * shared host resolver. A bare `path.resolve(ctx.cwd, path)` turned `~/x` into
 * `<cwd>/~/x`, so the server was asked about a document nothing had opened.
 * The `rename_file` destination (`newFilePath`) keeps its bare join: it is a
 * mutation target, filed as #4578.
 */
describe("lsp_navigation path resolution (#4577 M2)", () => {
	// #4723 F2: this block installs its own service. It used to inherit the
	// last block's double; under --sequence.shuffle (seed 424) that was the
	// delivery-gate double, whose hasLSP is false, so `references` never ran.
	beforeEach(() => {
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
			}),
		);
	});

	it("resolves a ~ path to $HOME, not under the cwd", async () => {
		const { home, restore } = pinFixtureHome("nav-tilde");
		const filePath = path.join(home, "proj", "refs.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "const a = normalizeMapKey('x');\n");
		try {
			expect(os.homedir()).toBe(home);
			const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
			await tool.execute(
				"refs-tilde",
				{
					operation: "references",
					path: "~/proj/refs.ts",
					line: 1,
					character: 12,
				},
				new AbortController().signal,
				null,
				{ cwd: path.join(home, "proj") },
			);
			const references = (
				mocked.service as { references: ReturnType<typeof vi.fn> }
			).references;
			expect(references.mock.calls[0]?.[0]).toBe(filePath);
		} finally {
			restore();
		}
	});
});

describe("lsp_navigation default text view", () => {
	/** An LSP range, 0-based as the server reports it. */
	const span = (line: number, character = 4) => ({
		start: { line, character },
		end: { line, character: character + 5 },
	});
	/**
	 * A `CallHierarchyItem`, the operand the call-hierarchy operations traverse.
	 * `data` is the server's own opaque handle, which the follow-up call must get
	 * back unchanged.
	 */
	const callItem = (name: string, uri: string, line: number) => ({
		name,
		kind: 12,
		uri,
		range: span(line, 0),
		selectionRange: span(line, 6),
		data: { symbolId: 7 },
	});
	type NavParams = Parameters<
		ReturnType<typeof createRawLspNavigationTool>["execute"]
	>[1];
	const runText = async (
		toolCallId: string,
		params: NavParams,
	): Promise<string> => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			toolCallId,
			params,
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		return String(result.content[0]?.text);
	};

	beforeEach(() => {
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				definition: vi.fn().mockResolvedValue([
					{
						uri: tmpFileUrl("sample.ts"),
						range: {
							start: { line: 11, character: 4 },
							end: { line: 11, character: 9 },
						},
					},
				]),
				typeDefinition: vi
					.fn()
					.mockResolvedValue([
						{ uri: tmpFileUrl("types.ts"), range: span(9, 0) },
					]),
				declaration: vi
					.fn()
					.mockResolvedValue([
						{ uri: tmpFileUrl("declared.ts"), range: span(2, 2) },
					]),
				references: vi.fn().mockResolvedValue([
					{ uri: tmpFileUrl("sample.ts"), range: span(2, 4) },
					{ uri: tmpFileUrl("sample.ts"), range: span(7, 8) },
				]),
				implementation: vi
					.fn()
					.mockResolvedValue([
						{ uri: tmpFileUrl("impl.ts"), range: span(20, 4) },
					]),
				hover: vi.fn().mockResolvedValue({
					contents: {
						kind: "markdown",
						value: "```ts\nfunction run(): void\n```",
					},
				}),
				signatureHelp: vi.fn().mockResolvedValue({
					signatures: [
						{
							label: "run(a: number, b: string): void",
							documentation: "Runs the thing.",
							parameters: [{ label: "a" }, { label: "b" }],
						},
					],
					activeSignature: 0,
					activeParameter: 1,
				}),
				documentSymbol: vi.fn().mockResolvedValue([
					{
						name: "run",
						kind: 12,
						range: {
							start: { line: 0, character: 0 },
							end: { line: 4, character: 1 },
						},
						selectionRange: {
							start: { line: 0, character: 9 },
							end: { line: 0, character: 12 },
						},
					},
				]),
				codeAction: vi
					.fn()
					.mockResolvedValue([
						{ title: "Move to new file", kind: "refactor.move.newFile" },
					]),
				prepareCallHierarchy: vi
					.fn()
					.mockResolvedValue([callItem("run", tmpFileUrl("sample.ts"), 11)]),
				incomingCalls: vi.fn().mockResolvedValue([
					{
						from: callItem("caller", tmpFileUrl("caller.ts"), 3),
						fromRanges: [span(4, 6), span(9, 6)],
					},
				]),
				outgoingCalls: vi.fn().mockResolvedValue([
					{
						to: callItem("callee", tmpFileUrl("callee.ts"), 30),
						fromRanges: [span(8, 2)],
					},
				]),
				workspaceSymbol: vi.fn().mockResolvedValue([
					{
						name: "ReportProcessor",
						kind: 12,
						location: {
							uri: tmpFileUrl("sample.ts"),
							range: span(2, 0),
						},
					},
				]),
				rename: vi.fn().mockResolvedValue({
					documentChanges: [
						{
							kind: "rename",
							oldUri: tmpFileUrl("sample.ts"),
							newUri: tmpFileUrl("renamed.ts"),
						},
					],
				}),
				renameFile: vi.fn().mockResolvedValue({
					applied: false,
					serverIds: ["typescript"],
					willRenameFailures: [],
					didRenameFailures: [],
					droppedConflicts: 0,
					inputEditCount: 0,
					summary: ["Renamed src/sample.ts → src/renamed.ts"],
				}),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explain"]),
				executeCommand: vi.fn().mockResolvedValue({ alpha: 1, beta: "two" }),
				getWorkspaceDiagnosticsSupport: vi
					.fn()
					.mockResolvedValue({ mode: "pull" }),
				getDiagnostics: vi.fn().mockResolvedValue([
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 3 },
						},
						severity: 1,
						message: "boom",
						code: "TS1",
					},
				]),
			}),
		);
	});

	it("renders a location list as Neovim path:line:col lines, not JSON", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-definition",
			{
				operation: "definition",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const text = String(result.content[0]?.text);
		expect(text).toContain(`${tmpPath("sample.ts")}:12:5`);
		expect(text.startsWith("{")).toBe(false);
	});

	it("prints a location inside the project relative to it", async () => {
		// The Neovim shape is a project-relative path; only a hit under the cwd
		// can show that the display resolver runs at all (a tmp fixture is
		// outside the cwd and answers its own absolute spelling either way).
		const insideUri = pathToFileURL(
			path.join(process.cwd(), "tools", "lsp-navigation-text.ts"),
		).href;
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				definition: vi
					.fn()
					.mockResolvedValue([{ uri: insideUri, range: span(0, 0) }]),
			}),
		);
		const text = await runText("text-relative", {
			operation: "definition",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text).toBe("tools/lsp-navigation-text.ts:1:1");
	});

	it("builds one display resolver per render and retains none", () => {
		// Nothing a render prints depends on whether a resolver outlives it, so the
		// retention is observable only in the module's own shape: a process that
		// outlived many sessions kept one resolver per project it had rendered
		// (defect shape 51, #5224 review G6).
		const source = fs.readFileSync(
			path.join(process.cwd(), "tools", "lsp-navigation-text.ts"),
			"utf8",
		);
		expect(source).not.toMatch(
			/^(?:const|let) \w*(?:Display|display|Resolver|resolver)\w* = new /m,
		);
	});

	it("renders hover as its markdown", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-hover",
			{
				operation: "hover",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const text = String(result.content[0]?.text);
		expect(text).toContain("function run(): void");
		// The default view must not fall back to the JSON envelope the pre-text
		// default returned.
		expect(text).not.toContain('"tool":"lsp_navigation"');
	});

	it("renders a language-bearing hover snippet as a fenced code block", async () => {
		// A `MarkedString` snippet carries its language; dropping the fence made
		// the snippet read as prose (#5224 review G7).
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				hover: vi.fn().mockResolvedValue({
					contents: { language: "ts", value: "function run(): void" },
				}),
			}),
		);
		const text = await runText("text-hover-snippet", {
			operation: "hover",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text.split("\n")).toEqual(["```ts", "function run(): void", "```"]);
	});

	it("renders documentSymbol as an indented start-end kind name tree", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-document-symbol",
			{ operation: "documentSymbol", path: tmpPath("sample.ts") },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		expect(String(result.content[0]?.text)).toContain("  1-5 function run");
	});

	it("renders codeAction as kind and title lines", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-code-action",
			{
				operation: "codeAction",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
				endLine: 1,
				endCharacter: 2,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const text = String(result.content[0]?.text);
		expect(text).toContain("refactor.move.newFile  Move to new file");
		// The payload's own Note survives the re-render (`lspNavigationTextSurround`).
		expect(text).toContain("no diagnostic quick fixes returned");
	});

	it("keeps the tool's own error text when the operation produced no result", async () => {
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explode"]),
				executeCommand: vi.fn().mockRejectedValue(new Error("server exploded")),
			}),
		);
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-error",
			{ operation: "executeCommand", command: "test.explode", apply: true },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		// No renderer reads an undefined result, so the LSP error keeps the payload's
		// own text instead of reading as a successful run.
		expect(String(result.content[0]?.text)).toContain(
			"LSP error: server exploded",
		);
	});

	it('keeps a multi-line LSP error line and its Note apart under view:"json"', async () => {
		// One prefix parser reads both the envelope and the text view. An error
		// whose own message carries a note keeps the `LSP error:` line in
		// `errors` and the note in `notes`; folding them into one entry would
		// make the envelope's own report unreadable.
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explode"]),
				executeCommand: vi
					.fn()
					.mockRejectedValue(new Error("server exploded\nNote: escalated")),
			}),
		);
		const tool = createLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-error-json",
			{
				operation: "executeCommand",
				command: "test.explode",
				apply: true,
				view: "json",
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const envelope = parseToolJson(result);
		expect(envelope.errors).toEqual(["LSP error: server exploded"]);
		expect(envelope.notes).toEqual(["escalated"]);
	});

	it("keeps the capabilities table, which has no text renderer", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-capabilities",
			{ operation: "capabilities", path: tmpPath("sample.ts") },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		// No renderer reads the capabilities table, so the payload's own text is
		// the default view's answer rather than an empty body.
		expect(String(result.content[0]?.text)).toContain("No active LSP server");
	});

	it('returns the structured envelope under view:"json"', async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-json-hatch",
			{
				operation: "definition",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
				view: "json",
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const envelope = parseToolJson(result);
		expect(envelope.tool).toBe("lsp_navigation");
		expect(envelope.resultCount).toBe(1);
	});
	it("renders typeDefinition as a location line", async () => {
		const text = await runText("text-type-definition", {
			operation: "typeDefinition",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text).toBe(`${tmpPath("types.ts")}:10:1`);
	});

	it("renders declaration as a location line", async () => {
		const text = await runText("text-declaration", {
			operation: "declaration",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text).toBe(`${tmpPath("declared.ts")}:3:3`);
	});

	it("renders references as one line per hit and keeps the payload's hint", async () => {
		const text = await runText("text-references", {
			operation: "references",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text.split("\n")).toContain(`${tmpPath("sample.ts")}:3:5`);
		expect(text.split("\n")).toContain(`${tmpPath("sample.ts")}:8:9`);
		// The operation's own trailing Hint survives the re-render.
		expect(text).toContain("retry from the symbol definition");
	});

	it("renders implementation as a location line", async () => {
		const text = await runText("text-implementation", {
			operation: "implementation",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text).toBe(`${tmpPath("impl.ts")}:21:5`);
	});

	it("renders signatureHelp as the active signature and parameter", async () => {
		const text = await runText("text-signature-help", {
			operation: "signatureHelp",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
		});
		expect(text.split("\n")[0]).toBe("run(a: number, b: string): void");
		expect(text).toContain("Runs the thing.");
		// The active parameter is marked, the other one is aligned under it.
		expect(text).toContain("→ b");
	});

	it("renders prepareCallHierarchy as its symbol line and the reusable item", async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-prepare-call",
			{
				operation: "prepareCallHierarchy",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		const prepared = callItem("run", tmpFileUrl("sample.ts"), 11);
		const lines = String(result.content[0]?.text).split("\n");
		expect(lines[0]).toBe(`${tmpPath("sample.ts")}:12:7  function run`);
		// A display line alone left nothing to pass to the traversal calls, and a
		// second prepare can answer a different item (#5224 review G1).
		expect(lines[1]).toBe(`callHierarchyItem: ${JSON.stringify(prepared)}`);
		expect(result.details?.callHierarchyItems).toEqual([prepared]);

		// The emitted item is the operand: parsing the line and passing it back
		// reaches the caller, `data` included.
		const item = JSON.parse(
			String(lines[1]).slice("callHierarchyItem: ".length),
		);
		const traversal = await runText("text-prepare-then-incoming", {
			operation: "incomingCalls",
			callHierarchyItem: item,
		});
		expect(traversal.split("\n")[0]).toBe(
			`${tmpPath("caller.ts")}:4:7  function caller`,
		);
		expect(
			(
				mocked.service as { incomingCalls: ReturnType<typeof vi.fn> }
			).incomingCalls.mock.calls.at(-1)?.[0],
		).toEqual(prepared);
	});

	it("renders each incoming call site under its caller", async () => {
		const text = await runText("text-incoming", {
			operation: "incomingCalls",
			callHierarchyItem: callItem("run", tmpFileUrl("sample.ts"), 11),
		});
		expect(text.split("\n")).toEqual([
			`${tmpPath("caller.ts")}:4:7  function caller`,
			`  ${tmpPath("caller.ts")}:5:7`,
			`  ${tmpPath("caller.ts")}:10:7`,
		]);
	});

	it("renders each outgoing call site under the callee, in the calling file", async () => {
		// The LSP `fromRanges` of an outgoing call are written in the item the
		// caller asked about, not in `to`; naming `to`'s file would point at the
		// callee's declaration instead of the call site.
		const text = await runText("text-outgoing", {
			operation: "outgoingCalls",
			callHierarchyItem: callItem("run", tmpFileUrl("sample.ts"), 11),
		});
		expect(text.split("\n")).toEqual([
			`${tmpPath("callee.ts")}:31:7  function callee`,
			`  ${tmpPath("sample.ts")}:9:3`,
		]);
	});

	it("renders workspaceSymbol as symbol lines", async () => {
		const text = await runText("text-workspace-symbol", {
			operation: "workspaceSymbol",
			query: "ReportProcessor",
		});
		expect(text).toBe(`${tmpPath("sample.ts")}:3:1  function ReportProcessor`);
	});

	it("renders findSymbol as an indented symbol line under the file", async () => {
		const text = await runText("text-find-symbol", {
			operation: "findSymbol",
			path: tmpPath("sample.ts"),
			query: "run",
		});
		expect(text.split("\n")[0]).toBe(tmpPath("sample.ts"));
		expect(text).toContain(":1:10  function run");
	});

	it("renders rename as its preview summary", async () => {
		const text = await runText("text-rename", {
			operation: "rename",
			path: tmpPath("sample.ts"),
			line: 1,
			character: 1,
			newName: "renamedRun",
		});
		expect(text).toContain("Rename");
		expect(text).toContain("renamed.ts");
		expect(text).toContain(
			"Preview only — pass apply:true to write the edits.",
		);
	});

	it("renders rename_file as its preview summary", async () => {
		const text = await runText("text-rename-file", {
			operation: "rename_file",
			path: tmpPath("sample.ts"),
			newFilePath: tmpPath("renamed.ts"),
		});
		expect(text).toBe(
			[
				"Renamed src/sample.ts → src/renamed.ts",
				"Preview only — pass apply:true to rename.",
			].join("\n"),
		);
	});

	it("prefers the completed rename_file descriptions over its earlier summary", async () => {
		// `summary` is built before the write, so only `descriptions` confirms what
		// landed (#5224 review G3).
		(mocked.service as { renameFile: ReturnType<typeof vi.fn> }).renameFile = vi
			.fn()
			.mockResolvedValue({
				applied: true,
				serverIds: ["typescript"],
				willRenameFailures: [],
				didRenameFailures: [],
				droppedConflicts: 0,
				inputEditCount: 3,
				appliedOperationTotal: 2,
				summary: [
					"Renamed src/sample.ts → src/renamed.ts",
					"Planned before the write",
				],
				descriptions: [
					"src/sample.ts → src/renamed.ts",
					"imports in src/use.ts",
				],
				files: [],
			});
		const text = await runText("text-rename-file-applied", {
			operation: "rename_file",
			path: tmpPath("sample.ts"),
			newFilePath: tmpPath("renamed.ts"),
			apply: true,
		});
		expect(text.split("\n")).toEqual([
			"Applied 2 edits:",
			"  src/sample.ts → src/renamed.ts",
			"  imports in src/use.ts",
		]);
	});

	it("warns when a rename dropped conflicting edits, preview and applied", async () => {
		// A dropped conflict is a partial rename; the completed list must not read
		// as a whole one (#5224 review G4).
		(mocked.service as { renameFile: ReturnType<typeof vi.fn> }).renameFile = vi
			.fn()
			.mockResolvedValue({
				applied: false,
				serverIds: ["typescript"],
				willRenameFailures: [],
				didRenameFailures: [],
				droppedConflicts: 2,
				inputEditCount: 3,
				summary: ["Renamed src/sample.ts → src/renamed.ts"],
			});
		const preview = await runText("text-rename-file-dropped", {
			operation: "rename_file",
			path: tmpPath("sample.ts"),
			newFilePath: tmpPath("renamed.ts"),
		});
		expect(preview.split("\n")).toEqual([
			"Renamed src/sample.ts → src/renamed.ts",
			"Preview only — pass apply:true to rename.",
			"Warning: 2 conflicting edits dropped.",
		]);

		(mocked.service as { renameFile: ReturnType<typeof vi.fn> }).renameFile = vi
			.fn()
			.mockResolvedValue({
				applied: true,
				serverIds: ["typescript"],
				willRenameFailures: [],
				didRenameFailures: [],
				droppedConflicts: 1,
				inputEditCount: 2,
				appliedOperationTotal: 1,
				summary: ["Renamed src/sample.ts → src/renamed.ts"],
				descriptions: ["src/sample.ts → src/renamed.ts"],
				files: [],
			});
		const applied = await runText("text-rename-file-dropped-applied", {
			operation: "rename_file",
			path: tmpPath("sample.ts"),
			newFilePath: tmpPath("renamed.ts"),
			apply: true,
		});
		expect(applied.split("\n")).toEqual([
			"Applied 1 edit:",
			"  src/sample.ts → src/renamed.ts",
			"Warning: 1 conflicting edit dropped.",
		]);
	});

	it("keeps the payload's leading note above the rendered rows", async () => {
		// The path-mode payload is `Note: …\n<json>`: the note is the payload's
		// own header, so it stays above the body it introduces and the rows
		// replace the JSON under it.
		const text = await runText("text-workspace-diagnostics", {
			operation: "workspaceDiagnostics",
			path: tmpPath("sample.ts"),
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe(
			"Note: path mode requests pull diagnostics for this file and returns the aggregated result",
		);
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe(`${tmpPath("sample.ts")}:1:1: error [TS1]: boom`);
	});

	it("prints each snapshot file's scan age above its rows", async () => {
		// The path-less snapshot replays what each client last published; the age
		// label lived only in the envelope, so a replayed row read as current
		// (#1634, #5224 review G5/CR1).
		const scanned = tmpPath("replayed.ts");
		(mocked.service as { getAllDiagnostics: unknown }).getAllDiagnostics = vi
			.fn()
			.mockResolvedValue(
				new Map([
					[
						scanned,
						{
							diags: [
								{
									severity: 1,
									message: "boom",
									code: "TS1",
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 3 },
									},
								},
							],
							ts: Date.now() - 5 * 60_000,
						},
					],
				]),
			);
		const text = await runText("text-workspace-snapshot-age", {
			operation: "workspaceDiagnostics",
		});
		const lines = text.split("\n");
		expect(lines).toContain(`${scanned} (scanned 5m ago)`);
		expect(lines).toContain(`${scanned}:1:1: error [TS1]: boom`);
	});

	it("renders an executed command's value as compact single-line JSON", async () => {
		// The server's value is arbitrary, so this one operation keeps the compact
		// JSON form instead of a line shape (skills/pi-lens-lsp-navigation).
		const text = await runText("text-execute-command", {
			operation: "executeCommand",
			command: "test.explain",
			apply: true,
		});
		expect(text).toBe('{"alpha":1,"beta":"two"}');
	});

	it("renders an executed command's string value as JSON, quotes and all", async () => {
		// `trim()` dropped the quotes, kept the newline, and turned "" into
		// undefined, so the value the server sent was not the value printed
		// (#5224 review CR2).
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explain"]),
				executeCommand: vi.fn().mockResolvedValue("done\n"),
			}),
		);
		const text = await runText("text-execute-command-string", {
			operation: "executeCommand",
			command: "test.explain",
			apply: true,
		});
		expect(text).toBe('"done\\n"');
	});

	it("keeps the dry-run advertisement preview instead of a failure line", async () => {
		const text = await runText("text-execute-command-dry", {
			operation: "executeCommand",
			command: "test.explain",
		});
		expect(text.split("\n")[0]).toBe("test.explain: advertised");
		expect(text).toContain("Re-run with apply:true to execute.");
	});

	it("prints a failed command's reason and the timeout warning", async () => {
		// The client answers `executed:false` plus a `reason` for a timeout or a
		// dead client; reading that as a preview printed the advertisement line
		// and lost the reason (#5224 review G2).
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explain"]),
				executeCommand: vi.fn().mockResolvedValue({
					executed: false,
					reason: "workspace/executeCommand timed out after 60000ms",
				}),
			}),
		);
		const text = await runText("text-execute-command-failed", {
			operation: "executeCommand",
			command: "test.explain",
			apply: true,
		});
		expect(text.split("\n")).toEqual([
			"Not executed: workspace/executeCommand timed out after 60000ms",
			"Warning: the command timed out; the server may still be changing files.",
		]);
	});

	it("prints a failed command's reason without the timeout warning", async () => {
		mocked.service = installLspService(
			makeLspServiceDouble({
				supportsLSP: vi.fn().mockReturnValue(true),
				hasLSP: vi.fn().mockResolvedValue(true),
				getOperationSupport: vi.fn().mockResolvedValue(null),
				getAdvertisedCommands: vi.fn().mockResolvedValue(["test.explain"]),
				executeCommand: vi.fn().mockResolvedValue({
					executed: false,
					reason: "lsp client not alive",
				}),
			}),
		);
		const text = await runText("text-execute-command-dead", {
			operation: "executeCommand",
			command: "test.explain",
			apply: true,
		});
		expect(text).toBe("Not executed: lsp client not alive");
	});
	it('answers view:"json" with the byte-identical pre-text envelope', async () => {
		const tool = createRawLspNavigationTool((flag) => flag === "lens-lsp");
		const result = await tool.execute(
			"text-json-bytes",
			{
				operation: "definition",
				path: tmpPath("sample.ts"),
				line: 1,
				character: 1,
				view: "json",
			},
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
		// Key order is part of the byte contract the pre-text default had, so the
		// expectation is built in the envelope builder's own order.
		const expected = {
			tool: "lsp_navigation",
			operation: "definition",
			ok: true,
			status: "success",
			filePath: tmpPath("sample.ts"),
			resultCount: 1,
			result: [
				{
					uri: tmpFileUrl("sample.ts"),
					range: {
						start: { line: 11, character: 4 },
						end: { line: 11, character: 9 },
					},
				},
			],
			locations: [
				{
					uri: tmpFileUrl("sample.ts"),
					filePath: tmpPath("sample.ts"),
					range: {
						start: { line: 12, character: 5 },
						end: { line: 12, character: 10 },
					},
				},
			],
			metadata: {
				operation: "definition",
				supported: null,
				searchReads: [
					{ file: tmpPath("sample.ts"), startLine: 12, endLine: 12 },
				],
				resultCount: 1,
			},
		};
		expect(String(result.content[0]?.text)).toBe(JSON.stringify(expected));
	});
});
