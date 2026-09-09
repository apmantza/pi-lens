/**
 * LSP Client Internals Tests
 *
 * Tests clientWaitForDiagnostics, handleNotifyOpen, and handleNotifyChange
 * directly with mock LSPClientState to avoid spawning real language servers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
// #1639: capture `lsp_typescript_diagnostic_sequence` phase records so the
// pull-settle regression tests below can assert on durationMs/version/
// settleSource without spinning up a real logging sink.
//
// #1641 F4: ALSO record every logLatency call (any phase) into
// `logLatencyMock` so `recordSentContent`'s `lsp_document_send` calls are
// inspectable too, without needing the real (test-mode-suppressed) writer.
const { pullSequenceEvents, logLatencyMock } = vi.hoisted(() => ({
	pullSequenceEvents: [] as Array<Record<string, unknown>>,
	logLatencyMock: vi.fn(),
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: vi.fn((event: Record<string, unknown>) => {
			logLatencyMock(event);
			if (event.phase === "lsp_typescript_diagnostic_sequence") {
				pullSequenceEvents.push(event);
			}
		}),
	};
});

import {
	applyDynamicCapabilities,
	bumpDiagnosticsVersion,
	CLIENT_CAPABILITIES,
	clientRequestWorkspaceDiagnostics,
	clearDiagnosticsForPath,
	clientShutdown,
	clientWaitForDiagnostics,
	closeDocument,
	diagnosticsVersionForPath,
	normalizeClientWorkspaceEdit,
	handleNotifyChange,
	handleNotifyExternalChange,
	navRequest,
	resolveConfigurationSection,
	runServerCommand,
	setupIncomingHandlers,
	stripDiagnosticNoiseLines,
	handleNotifyOpen,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import { applyWorkspaceEdit } from "../../../clients/lsp/edits.js";
import type { LspMutationContext } from "../../../clients/lsp-mutation.js";
// #1667: the LSPClientState fixture moved to a shared module so the
// multi-identifier pull tests reuse it instead of maintaining a copy.
import { createMockLspProcess, createMockState } from "./mock-client-state.js";
import { gatedPromise } from "../../support/fault-injection.js";
import { waitFor } from "../interleaving-kit.js";

const TEST_FILE = "/project/app.ts";
const TEST_KEY = normalizeMapKey(TEST_FILE);

describe("CLIENT_CAPABILITIES (#278 regression)", () => {
	// PowerShell Editor Services (OmniSharp.Extensions.LanguageServer) NPEs during
	// `initialize` when textDocument sub-capabilities it dereferences are absent —
	// a partial object hangs the handshake. Keep the set COMPLETE so PSES (and any
	// OmniSharp-based server) initializes.
	it("advertises a complete, spec-compliant textDocument capability set", () => {
		const td = CLIENT_CAPABILITIES.textDocument as Record<string, unknown>;
		for (const key of [
			"synchronization",
			"completion",
			"hover",
			"signatureHelp",
			"definition",
			"typeDefinition",
			"implementation",
			"references",
			"documentSymbol",
			"codeAction",
			"rename",
			"publishDiagnostics",
		]) {
			expect(td[key], `textDocument.${key} present`).toBeTypeOf("object");
		}
		// The old NON-STANDARD shape that triggered the NPE must not return:
		// didOpen/didChange are not TextDocumentSyncClientCapabilities fields.
		const sync = td.synchronization as Record<string, unknown>;
		expect(sync).not.toHaveProperty("didOpen");
		expect(sync).not.toHaveProperty("didChange");
		// Version-aware diagnostics (#240/#276) must stay advertised.
		expect(
			(
				CLIENT_CAPABILITIES.textDocument.publishDiagnostics as {
					versionSupport?: boolean;
				}
			).versionSupport,
		).toBe(true);
		expect(CLIENT_CAPABILITIES.workspace.fileOperations).toMatchObject({
			dynamicRegistration: false,
			willRename: true,
			didRename: true,
		});
		expect(CLIENT_CAPABILITIES.textDocument.codeAction).toMatchObject({
			dataSupport: true,
			resolveSupport: { properties: ["edit", "command"] },
			// #1971: LSP 3.17 restricts codeAction responses to Command[] unless
			// literal support is advertised; resolve-of-edit is protocol-invalid
			// without it.
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: expect.arrayContaining(["quickfix"]),
				},
			},
		});
	});
});

describe("client workspace edit normalization", () => {
	it("normalizes a rename-then-descendant edit against virtual post-resource content", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-client-edit-"));
		const oldDir = path.join(root, "oldDir");
		const newDir = path.join(root, "newDir");
		const oldFile = path.join(oldDir, "file.ts");
		const newFile = path.join(newDir, "file.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(oldFile, "const café = 1;\n", "utf-8");
		const state = createMockState({ root, positionEncoding: "utf-8" });
		const edit = {
			documentChanges: [
				{
					kind: "rename",
					oldUri: pathToFileURL(oldDir).href,
					newUri: pathToFileURL(newDir).href,
				},
				{
					textDocument: { uri: pathToFileURL(newFile).href },
					edits: [
						{
							range: {
								start: { line: 0, character: 14 },
								end: { line: 0, character: 15 },
							},
							newText: "2",
						},
					],
				},
			],
		};

		try {
			const normalized = await normalizeClientWorkspaceEdit(state, edit);
			const textChange = (
				normalized.documentChanges?.[1] as {
					edits: Array<{
						range: { start: { character: number }; end: { character: number } };
					}>;
				}
			).edits[0];
			expect(textChange.range.start.character).toBe(13);
			expect(textChange.range.end.character).toBe(14);
			await applyWorkspaceEdit(normalized, root);
			expect(fs.readFileSync(newFile, "utf-8")).toBe("const café = 2;\n");
			expect(fs.existsSync(oldDir)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["utf-8", "utf-32"] as const)(
		"preserves duplicate zero-width edits during %s normalization",
		async (positionEncoding) => {
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-client-edit-"),
			);
			const filePath = path.join(root, "file.ts");
			fs.writeFileSync(filePath, "a\n", "utf-8");
			const state = createMockState({ root, positionEncoding });
			try {
				const normalized = await normalizeClientWorkspaceEdit(state, {
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(filePath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "x",
								},
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "x",
								},
							],
						},
					],
				});
				const textChange = normalized.documentChanges?.[0] as {
					edits: unknown[];
				};
				expect(textChange.edits).toHaveLength(2);
				await applyWorkspaceEdit(normalized, root);
				expect(fs.readFileSync(filePath, "utf-8")).toBe("xxa\n");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it.each(["utf-8", "utf-32"] as const)(
		"supports delete-create-text ordering during %s normalization",
		async (positionEncoding) => {
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-client-edit-"),
			);
			const filePath = path.join(root, "file.ts");
			fs.writeFileSync(filePath, "old\n", "utf-8");
			const state = createMockState({ root, positionEncoding });
			try {
				const normalized = await normalizeClientWorkspaceEdit(state, {
					documentChanges: [
						{ kind: "delete", uri: pathToFileURL(filePath).href },
						{ kind: "create", uri: pathToFileURL(filePath).href },
						{
							textDocument: { uri: pathToFileURL(filePath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "new\n",
								},
							],
						},
					],
				});
				await applyWorkspaceEdit(normalized, root);
				expect(fs.readFileSync(filePath, "utf-8")).toBe("new\n");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	// P1-3: the tool apply paths (rename apply:true, code-action autofix) call
	// applyWorkspaceEdit WITHOUT a documentVersions map. normalizeClientWorkspaceEdit
	// must validate the version against the live map and then STRIP it (spec null =
	// don't check), so the downstream apply succeeds for version-stamping servers
	// (gopls) instead of failing 100% on "stale text document version".
	it("strips versions after validating them so tool apply paths succeed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-client-edit-"));
		const filePath = path.join(root, "file.ts");
		fs.writeFileSync(filePath, "old\n", "utf-8");
		const state = createMockState({ root, positionEncoding: "utf-16" });
		state.documentVersions.set(normalizeMapKey(filePath), 7);
		try {
			const normalized = await normalizeClientWorkspaceEdit(state, {
				documentChanges: [
					{
						textDocument: { uri: pathToFileURL(filePath).href, version: 7 },
						edits: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 3 },
								},
								newText: "new",
							},
						],
					},
				],
			});
			const textDocument = (
				normalized.documentChanges?.[0] as {
					textDocument: { version: unknown };
				}
			).textDocument;
			expect(textDocument.version).toBeNull();
			// No documentVersions passed — mirrors the real tool apply sites.
			await applyWorkspaceEdit(normalized, root);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("new\n");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still rejects a stale version at normalize time (validation intact)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-client-edit-"));
		const filePath = path.join(root, "file.ts");
		fs.writeFileSync(filePath, "old\n", "utf-8");
		const state = createMockState({ root, positionEncoding: "utf-16" });
		state.documentVersions.set(normalizeMapKey(filePath), 1);
		try {
			await expect(
				normalizeClientWorkspaceEdit(state, {
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(filePath).href, version: 9 },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 3 },
									},
									newText: "new",
								},
							],
						},
					],
				}),
			).rejects.toThrow(/stale workspace edit document version/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid UTF-8 range after a virtual rename without mutation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-client-edit-"));
		const oldDir = path.join(root, "oldDir");
		const newDir = path.join(root, "newDir");
		const oldFile = path.join(oldDir, "file.ts");
		const newFile = path.join(newDir, "file.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(oldFile, "const café = 1;\n", "utf-8");
		const state = createMockState({ root, positionEncoding: "utf-8" });

		try {
			// UTF-8 offset 10 falls in the MIDDLE of the two-byte `é` (bytes 9-10 of
			// "const café ..."), a genuinely invalid boundary that must still reject.
			// (A position merely PAST the line end now clamps per LSP 3.17 — see the
			// clamp coverage in edits.test.ts — so this exercises the boundary check,
			// not the removed past-end throw.)
			await expect(
				normalizeClientWorkspaceEdit(state, {
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldDir).href,
							newUri: pathToFileURL(newDir).href,
						},
						{
							textDocument: { uri: pathToFileURL(newFile).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 10 },
										end: { line: 0, character: 10 },
									},
									newText: "x",
								},
							],
						},
					],
				}),
			).rejects.toThrow(/boundary/);
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(fs.existsSync(newFile)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("solicited workspace/applyEdit observability", () => {
	it("applies and correlates solicited edits, but refuses unsolicited edits", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-apply-edit-"));
		const filePath = path.join(root, "app.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		const state = createMockState({ root });
		const written: string[] = [];
		state.serverEditsAllowed = 1;
		state.activeMutationDepth = 1;
		state.activeMutationContext = {
			cwd: root,
			correlationId: "apply-edit-1",
			tool: "workspace/applyEdit",
			source: "lsp-edit",
			readGuard: { recordWritten: (file) => written.push(file) },
		};
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = calls.find(
			(call) => call[0] === "workspace/applyEdit",
		)?.[1];
		expect(handler).toBeDefined();
		await expect(
			handler!({
				edit: {
					changes: {
						[pathToFileURL(filePath).href]: [
							{
								range: {
									start: { line: 0, character: 6 },
									end: { line: 0, character: 9 },
								},
								newText: "new",
							},
						],
					},
				},
			}),
		).resolves.toMatchObject({ applied: true });
		expect(fs.readFileSync(filePath, "utf8")).toBe("const new = 1;\n");
		expect(written).toEqual([filePath]);
		expect(state.activeMutationContext?.summaryEmitted).toBe(true);
		expect(state.activeMutationContext?.summaryCount).toBe(1);

		// A later solicited request must retain its own terminal summary even
		// when the first request already emitted an empty/success summary.
		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		const second = await handler!({
			edit: {
				changes: {
					[pathToFileURL(filePath).href]: [
						{
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 9 },
							},
							newText: "second",
						},
					],
				},
			},
		});
		await expect(Promise.resolve(second)).resolves.toMatchObject({
			applied: true,
		});
		expect(fs.readFileSync(filePath, "utf8")).toBe("const second = 1;\n");
		expect(state.activeMutationContext?.summaryCount).toBe(2);

		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		state.serverEditsAllowed = 0;
		const refused = await handler!({
			edit: {
				changes: {
					[pathToFileURL(filePath).href]: [],
				},
			},
		});
		expect(refused).toEqual({
			applied: false,
			failureReason: "edit not solicited",
		});
		expect(fs.readFileSync(filePath, "utf8")).toBe("const old = 1;\n");
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("workDoneProgress capability (#974)", () => {
	// pi-lens never consumes `$/progress` notifications, so advertising
	// window.workDoneProgress only invites servers to open progress tokens
	// that go nowhere — and opengrep's `--experimental` LSP mode crash-loops
	// when it can't parse pi-lens's spec-correct `{"result": null}` reply to
	// the `window/workDoneProgress/create` request that capability solicits.
	it("does not advertise window.workDoneProgress", () => {
		expect(CLIENT_CAPABILITIES.window).not.toHaveProperty("workDoneProgress");
	});

	it("still answers an unsolicited window/workDoneProgress/create request without throwing", async () => {
		const state = createMockState();
		setupIncomingHandlers(state, {});

		const onRequest = vi.mocked(state.connection.onRequest);
		const calls = onRequest.mock.calls as unknown as Array<
			[string, (...args: unknown[]) => unknown]
		>;
		const registered = calls.find(
			(c) => c[0] === "window/workDoneProgress/create",
		);
		expect(registered, "handler registered as a defensive no-op").toBeDefined();

		const handler = registered![1];
		await expect(
			handler({ token: "some-progress-token" }),
		).resolves.toBeUndefined();
	});
});

describe("resolveConfigurationSection (#983)", () => {
	const initialization = {
		scan: { configuration: ["auto"], onlyGitDirty: false, jobs: 16 },
		metrics: { enabled: false },
		doHover: false,
	};

	it("returns the whole blob for an item with no section", () => {
		expect(resolveConfigurationSection(initialization, undefined)).toBe(
			initialization,
		);
	});

	it("resolves a top-level section", () => {
		expect(resolveConfigurationSection(initialization, "metrics")).toEqual({
			enabled: false,
		});
	});

	it("resolves a nested dot-path section", () => {
		expect(resolveConfigurationSection(initialization, "scan.jobs")).toBe(16);
	});

	it("returns null for an unknown section instead of the whole blob", () => {
		expect(resolveConfigurationSection(initialization, "unknown.section")).toBe(
			null,
		);
		expect(resolveConfigurationSection(initialization, "scan.nope")).toBe(null);
	});

	it("returns null for an unknown section when initialization is undefined", () => {
		expect(resolveConfigurationSection(undefined, "anything")).toBe(null);
	});
});

describe("workspace/configuration handler (#983)", () => {
	// Per the LSP spec the response array's length MUST equal
	// params.items.length, one resolved value per requested item — not a
	// fixed single-element array duplicating the whole blob for every item.
	it("returns one resolved entry per requested item, mixing known and unknown sections", async () => {
		const initialization = {
			scan: { jobs: 16 },
			metrics: { enabled: false },
		};
		const state = createMockState();
		setupIncomingHandlers(state, initialization);

		const onRequest = vi.mocked(state.connection.onRequest);
		const calls = onRequest.mock.calls as unknown as Array<
			[string, (params: unknown) => Promise<unknown[]>]
		>;
		const registered = calls.find((c) => c[0] === "workspace/configuration");
		expect(registered).toBeDefined();
		const handler = registered![1];

		const result = await handler({
			items: [
				{ section: "scan" },
				{ section: "metrics.enabled" },
				{ section: "nonexistent.section" },
				{},
			],
		});

		expect(result).toEqual([{ jobs: 16 }, false, null, initialization]);
	});

	it("returns an empty array when the server requests zero items", async () => {
		const state = createMockState();
		setupIncomingHandlers(state, { scan: { jobs: 16 } });

		const onRequest = vi.mocked(state.connection.onRequest);
		const calls = onRequest.mock.calls as unknown as Array<
			[string, (params: unknown) => Promise<unknown[]>]
		>;
		const registered = calls.find((c) => c[0] === "workspace/configuration");
		const handler = registered![1];

		expect(await handler({ items: [] })).toEqual([]);
	});
});

describe("stripDiagnosticNoiseLines", () => {
	it("removes bare URL and further-information diagnostic lines", () => {
		expect(
			stripDiagnosticNoiseLines(
				"actual error\nfor further information visit https://example.test\nhttps://example.test/docs",
			),
		).toBe("actual error");
	});
});

describe("clientShutdown", () => {
	it("settles superseded callers and cancels unwritten work without running it (#2357)", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		const writeGate = gatedPromise<void>();
		let didChangeCalls = 0;
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method) => {
				if (method === "textDocument/didChange") {
					didChangeCalls++;
					await writeGate.promise;
				}
			},
		);

		try {
			const first = handleNotifyChange(state, TEST_FILE, "v1");
			await waitFor(
				() => didChangeCalls,
				(calls) => calls === 1,
			);
			let pendingSettled = 0;
			const second = handleNotifyChange(state, TEST_FILE, "v2").finally(
				() => pendingSettled++,
			);
			const newest = handleNotifyChange(state, TEST_FILE, "v3").finally(
				() => pendingSettled++,
			);

			await clientShutdown(state, { fast: true });
			expect(state.notifyChangeQueues.size).toBe(0);
			expect(didChangeCalls).toBe(1);
			await waitFor(
				() => pendingSettled,
				(count) => count === 2,
				{ timeoutMs: 1_000 },
			);
			await expect(second).resolves.toBeUndefined();
			await expect(newest).resolves.toBeUndefined();

			writeGate.resolve();
			await expect(first).resolves.toBeUndefined();
		} finally {
			writeGate.resolve();
		}
	});

	it("skips LSP protocol handshake in fast mode", async () => {
		const process = {
			killed: false,
			kill: vi.fn(() => true),
			unref: vi.fn(),
		};
		const state = createMockState({
			lspProcess: {
				...createMockLspProcess(),
				pid: 0,
				process,
			} as any,
		});

		await clientShutdown(state, { fast: true });

		expect(state.connection.sendRequest).not.toHaveBeenCalled();
		expect(state.connection.sendNotification).not.toHaveBeenCalled();
		expect(state.connection.dispose).toHaveBeenCalledTimes(1);
		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
		expect(process.unref).toHaveBeenCalledTimes(1);
	});

	// #1412 L1: projectIdentityProbedFiles is unbounded without lifecycle
	// cleanup — mirror openDocuments' own clear on shutdown/eviction.
	it("clears projectIdentityProbedFiles (#1412 L1)", async () => {
		const process = {
			killed: false,
			kill: vi.fn(() => true),
			unref: vi.fn(),
		};
		const state = createMockState({
			lspProcess: { ...createMockLspProcess(), pid: 0, process } as any,
			projectIdentityProbedFiles: new Set([TEST_KEY, "/project/other.ts"]),
		});

		await clientShutdown(state, { fast: true });

		expect(state.projectIdentityProbedFiles?.size).toBe(0);
	});
});

describe("closeDocument", () => {
	// #1412 L1: a claim-once probe memo scoped to the open lifetime — a closed
	// document's entry must not linger forever across a long session's worth of
	// open/close churn, mirroring openDocuments' own per-close cleanup.
	it("clears the closed file's projectIdentityProbedFiles entry (#1412 L1)", async () => {
		const state = createMockState({
			projectIdentityProbedFiles: new Set([TEST_KEY, "/project/other.ts"]),
		});
		state.openDocuments.add(TEST_KEY);
		state.openDocumentUris?.set(TEST_KEY, pathToFileURL(TEST_FILE).href);

		await closeDocument(state, TEST_FILE);

		expect(state.projectIdentityProbedFiles?.has(TEST_KEY)).toBe(false);
		expect(state.projectIdentityProbedFiles?.has("/project/other.ts")).toBe(
			true,
		);
	});
});

describe("handleNotifyOpen", () => {
	it("sends didOpen on first open", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpenCall = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpenCall).toBeDefined();
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("coalesces same-file didOpen bursts to the newest content (#2357)", async () => {
		const state = createMockState();
		const first = handleNotifyOpen(state, TEST_FILE, "v1", "typescript");
		const second = handleNotifyOpen(state, TEST_FILE, "v2", "typescript");
		const newest = handleNotifyOpen(state, TEST_FILE, "v3", "typescript");
		await Promise.all([first, second, newest]);

		const opens = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter(([method]) => method === "textDocument/didOpen");
		expect(opens).toHaveLength(1);
		expect(
			(opens[0][1] as { textDocument: { text: string } }).textDocument.text,
		).toBe("v3");
	});

	it("#1641 F4: lsp_document_send's contentLineCount matches the gate's LSP-addressable convention (newlines + 1), not wc -l", async () => {
		logLatencyMock.mockClear();
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "a\nb\nc\n", "typescript"); // 3 newlines

		const sendCall = logLatencyMock.mock.calls.find(
			(c) => c[0]?.phase === "lsp_document_send",
		);
		expect(sendCall).toBeDefined();
		expect(sendCall?.[0].metadata.contentLineCount).toBe(4);
		expect(sendCall?.[0].metadata.contentLength).toBe(6);
	});

	it("#1641 F4: an empty document logs contentLineCount 1, not 0 (a doc always has ≥1 addressable line)", async () => {
		logLatencyMock.mockClear();
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "", "typescript");

		const sendCall = logLatencyMock.mock.calls.find(
			(c) => c[0]?.phase === "lsp_document_send",
		);
		expect(sendCall?.[0].metadata.contentLineCount).toBe(1);
	});

	it("#2066: a CRLF document counts its LF terminators, so two CRLFs are 3 lines", async () => {
		logLatencyMock.mockClear();
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "a\r\nb\r\n", "typescript");

		const sendCall = logLatencyMock.mock.calls.find(
			(c) => c[0]?.phase === "lsp_document_send",
		);
		expect(sendCall?.[0].metadata.contentLineCount).toBe(3);
		expect(sendCall?.[0].metadata.contentLength).toBe(6);
	});

	it("#2066: a lone-CR document is 1 line to contentLineCount and 3 to the didChange range", async () => {
		logLatencyMock.mockClear();
		const state = createMockState({ syncKind: 2 });
		await handleNotifyOpen(state, TEST_FILE, "a\rb\rc", "typescript");

		const sendCall = logLatencyMock.mock.calls.find(
			(c) => c[0]?.phase === "lsp_document_send",
		);
		// `contentLineCount` exists to pair with `diagnostic_past_eof`, whose gate
		// counts `\n` BYTES (clients/diagnostic-line-freshness.ts). A lone-CR
		// document has none, so it is one addressable line to BOTH records.
		expect(sendCall?.[0].metadata.contentLineCount).toBe(1);

		await handleNotifyChange(state, TEST_FILE, "a\rb\rd");

		const didChange = [
			...vi.mocked(state.connection.sendNotification).mock.calls,
		]
			.reverse()
			.find((c) => c[0] === "textDocument/didChange");
		const params = didChange?.[1] as {
			contentChanges: Array<{
				range?: { end: { line: number; character: number } };
			}>;
		};
		// LSP line addressing treats a lone `\r` as a terminator, so the SAME
		// document is 3 addressable lines here. The two numbers diverge on
		// purpose; folding them into one would break one consumer or the other.
		expect(params.contentChanges[0].range?.end).toEqual({
			line: 2,
			character: 1,
		});
	});

	it("detaches the classic TypeScript projectInfo probe after didOpen", async () => {
		const state = createMockState({
			serverId: "typescript",
			launchVariant: "classic",
			advertisedCommands: new Set(["typescript.tsserverRequest"]),
		});
		vi.mocked(state.connection.sendRequest).mockResolvedValue({
			success: true,
			body: { configFileName: "/project/tsconfig.json" },
		});

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");
		await vi.waitFor(() => {
			expect(state.connection.sendRequest).toHaveBeenCalledWith(
				"workspace/executeCommand",
				{
					command: "typescript.tsserverRequest",
					arguments: [
						"projectInfo",
						{ file: TEST_FILE, needFileNameList: false },
					],
				},
			);
		});
	});

	// #1412 H1: the projectInfo probe must route through the READ-ONLY
	// runReadOnlyServerCommand path, never runServerCommand — it must not open
	// the workspace/applyEdit acceptance window (serverEditsAllowed > 0) for the
	// whole 30s EXECUTE_COMMAND_TIMEOUT_MS on every classic-TS first open. This
	// reproduces the reviewer's red case: gate the probe's sendRequest so it is
	// still in flight, and assert the mutation-acceptance state never moved.
	it("keeps serverEditsAllowed and activeMutationDepth at 0 while the classic projectInfo probe is in flight (#1412 H1)", async () => {
		const state = createMockState({
			serverId: "typescript",
			launchVariant: "classic",
			advertisedCommands: new Set(["typescript.tsserverRequest"]),
			// Mirror production's real initial values (createLSPClientState sets
			// both to 0) — the mock factory leaves these fields undefined by
			// default since most tests never touch mutation bookkeeping.
			activeMutationDepth: 0,
			activeMutationContext: undefined,
		});
		let resolveProbe!: (value: unknown) => void;
		const gate = new Promise((resolve) => {
			resolveProbe = resolve;
		});
		vi.mocked(state.connection.sendRequest).mockImplementation(() => gate);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");
		await vi.waitFor(() => {
			expect(state.connection.sendRequest).toHaveBeenCalledWith(
				"workspace/executeCommand",
				expect.objectContaining({ command: "typescript.tsserverRequest" }),
			);
		});

		// The probe's executeCommand is still unresolved (gated) — if it were
		// routed through runServerCommand this would read 1, not 0.
		expect(state.serverEditsAllowed).toBe(0);
		expect(state.activeMutationDepth).toBe(0);
		expect(state.activeMutationContext).toBeUndefined();

		resolveProbe({ success: true, body: {} });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(state.serverEditsAllowed).toBe(0);
	});

	// #1412 H2: a probe firing mid-flight must not clobber a concurrent REAL
	// executeCommand's activeMutationContext — the two must be fully isolated
	// since the probe no longer touches the mutation-bookkeeping fields at all.
	it("does not disturb a concurrent real executeCommand's activeMutationContext when a probe fires mid-flight (#1412 H2)", async () => {
		const state = createMockState({
			serverId: "typescript",
			launchVariant: "classic",
			advertisedCommands: new Set([
				"typescript.tsserverRequest",
				"real.command",
			]),
		});
		let resolveProbe!: (value: unknown) => void;
		const probeGate = new Promise((resolve) => {
			resolveProbe = resolve;
		});
		let resolveReal!: (value: unknown) => void;
		const realGate = new Promise((resolve) => {
			resolveReal = resolve;
		});
		vi.mocked(state.connection.sendRequest).mockImplementation(((
			method: string,
			params: { command?: string },
		) => {
			if (method === "workspace/executeCommand") {
				if (params?.command === "typescript.tsserverRequest") {
					return probeGate;
				}
				if (params?.command === "real.command") {
					return realGate;
				}
			}
			return Promise.resolve({ ok: true });
		}) as never);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");
		await vi.waitFor(() => {
			expect(state.connection.sendRequest).toHaveBeenCalledWith(
				"workspace/executeCommand",
				expect.objectContaining({ command: "typescript.tsserverRequest" }),
			);
		});

		// A real mutation starts WHILE the probe is still in flight. Both are
		// gated so neither settles until this test drives them explicitly.
		const realContext = {
			cwd: state.root,
			correlationId: "real-command-1",
			tool: "rename",
			source: "lsp-edit" as const,
		};
		const realPromise = runServerCommand(
			state,
			"real.command",
			[],
			5000,
			realContext,
		);
		await vi.waitFor(() => {
			expect(state.connection.sendRequest).toHaveBeenCalledWith(
				"workspace/executeCommand",
				expect.objectContaining({ command: "real.command" }),
			);
		});
		expect(state.activeMutationContext).toBe(realContext);
		expect(state.serverEditsAllowed).toBe(1);

		// Let the probe resolve while the real command is still pending.
		resolveProbe({ success: true, body: {} });
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The probe resolving must not have touched the real command's context.
		expect(state.activeMutationContext).toBe(realContext);
		expect(state.serverEditsAllowed).toBe(1);

		resolveReal({ ok: true });
		await realPromise;
		expect(state.serverEditsAllowed).toBe(0);
		expect(state.activeMutationContext).toBeUndefined();
	});

	it("suppresses didChangeWatchedFiles in silent open mode", async () => {
		const state = createMockState();
		await handleNotifyOpen(
			state,
			TEST_FILE,
			"const x = 1;",
			"typescript",
			false,
			true,
		);

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		expect(calls.some((c) => c[0] === "workspace/didChangeWatchedFiles")).toBe(
			false,
		);
		expect(calls.some((c) => c[0] === "textDocument/didOpen")).toBe(true);
	});

	it("batches didChangeWatchedFiles via the watch queue in normal open mode (#271)", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		// #271: the notify is now enqueued, not sent inline — not yet on the wire.
		let calls = vi.mocked(state.connection.sendNotification).mock.calls;
		expect(calls.some((c) => c[0] === "workspace/didChangeWatchedFiles")).toBe(
			false,
		);
		expect(state.watchQueue.size).toBe(1);

		// flushing the debounce window emits a single batched notification.
		state.watchQueue.flush();
		calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const watched = calls.find(
			(c) => c[0] === "workspace/didChangeWatchedFiles",
		);
		expect(watched).toBeDefined();
		expect((watched?.[1] as { changes: unknown[] }).changes).toHaveLength(1);
	});

	it("coalesces multiple file opens into ONE didChangeWatchedFiles (#271)", async () => {
		const state = createMockState();
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");
		await handleNotifyOpen(
			state,
			`${TEST_FILE}.other.ts`,
			"const y = 2;",
			"typescript",
		);
		expect(state.watchQueue.size).toBe(2);

		state.watchQueue.flush();
		const watchedCalls = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter((c) => c[0] === "workspace/didChangeWatchedFiles");
		// one notification for the whole burst, carrying both URIs
		expect(watchedCalls).toHaveLength(1);
		expect((watchedCalls[0][1] as { changes: unknown[] }).changes).toHaveLength(
			2,
		);
	});

	it("sends didChange on re-open", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyOpen(state, TEST_FILE, "const y = 2;", "typescript");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didChangeCall = calls.find((c) => c[0] === "textDocument/didChange");
		expect(didChangeCall).toBeDefined();
		expect(state.documentVersions.get(TEST_KEY)).toBe(1);
	});

	it("does nothing when client is not alive", async () => {
		const state = createMockState({ isConnected: false });
		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.connection.sendNotification).not.toHaveBeenCalled();
	});

	it("tracks pending opens until didOpen completes", async () => {
		const state = createMockState();
		expect(state.pendingOpens.has(TEST_KEY)).toBe(false);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.pendingOpens.has(TEST_KEY)).toBe(false);
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("clears diagnostics on open", async () => {
		const state = createMockState();
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		await handleNotifyOpen(state, TEST_FILE, "const x = 1;", "typescript");

		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
	});
});

/**
 * #1668 — external (bash-authored) file changes that never went through
 * textDocument/didOpen/didChange. Reproduces the server-side stale view: a
 * bash-deleted file left NO trace in the fixture client's outbound traffic
 * before this fix (`handleNotifyExternalChange` did not exist), so a server
 * given only didOpen/didChange would keep the file in its index/vfs forever.
 */
describe("handleNotifyExternalChange (#1668)", () => {
	it("queues a type-3 (Deleted) change and flushes it as one notification", () => {
		const state = createMockState();
		handleNotifyExternalChange(state, TEST_FILE, 3);

		// Not on the wire yet — routed through the #271 debounce queue.
		let calls = vi.mocked(state.connection.sendNotification).mock.calls;
		expect(calls.some((c) => c[0] === "workspace/didChangeWatchedFiles")).toBe(
			false,
		);
		expect(state.watchQueue.size).toBe(1);

		state.watchQueue.flush();
		calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const watched = calls.find(
			(c) => c[0] === "workspace/didChangeWatchedFiles",
		);
		expect(watched).toBeDefined();
		const changes = (
			watched?.[1] as { changes: Array<{ uri: string; type: number }> }
		).changes;
		expect(changes).toEqual([{ uri: pathToFileURL(TEST_FILE).href, type: 3 }]);
	});

	it("a burst of N distinct external deletes coalesces into ONE flush (flood control)", () => {
		const state = createMockState();
		const files = Array.from({ length: 25 }, (_, i) => `/project/gen-${i}.ts`);
		for (const f of files) handleNotifyExternalChange(state, f, 3);

		expect(state.watchQueue.size).toBe(25);
		expect(state.connection.sendNotification).not.toHaveBeenCalledWith(
			"workspace/didChangeWatchedFiles",
			expect.anything(),
		);

		state.watchQueue.flush();
		const watchedCalls = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter((c) => c[0] === "workspace/didChangeWatchedFiles");
		expect(watchedCalls).toHaveLength(1);
		expect((watchedCalls[0][1] as { changes: unknown[] }).changes).toHaveLength(
			25,
		);
	});

	it("uses the tracked open-document URI when the path is already open", () => {
		const state = createMockState({ openDocumentUris: new Map() });
		const uri = "file:///project/app.ts?variant=1";
		state.openDocumentUris?.set(TEST_KEY, uri);

		handleNotifyExternalChange(state, TEST_FILE, 1);
		state.watchQueue.flush();

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const watched = calls.find(
			(c) => c[0] === "workspace/didChangeWatchedFiles",
		);
		expect(
			(watched?.[1] as { changes: Array<{ uri: string }> }).changes,
		).toEqual([{ uri, type: 1 }]);
	});

	it("does nothing when the client is not alive", () => {
		const state = createMockState({ isConnected: false });
		handleNotifyExternalChange(state, TEST_FILE, 3);

		expect(state.watchQueue.size).toBe(0);
		expect(state.connection.sendNotification).not.toHaveBeenCalled();
	});
});

describe("handleNotifyChange", () => {
	it("sends didChange when document is open", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didChangeCall = calls.find((c) => c[0] === "textDocument/didChange");
		expect(didChangeCall).toBeDefined();
		expect(state.documentVersions.get(TEST_KEY)).toBe(1);
	});

	it("falls back to didOpen when document not yet open", async () => {
		const state = createMockState();

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		const calls = vi.mocked(state.connection.sendNotification).mock.calls;
		const didOpenCall = calls.find((c) => c[0] === "textDocument/didOpen");
		expect(didOpenCall).toBeDefined();
		expect(state.openDocuments.has(TEST_KEY)).toBe(true);
	});

	it("clears stale diagnostics before sending change", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old push",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);
		state.documentPullDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "old pull",
				range: {
					start: { line: 0, character: 1 },
					end: { line: 0, character: 1 },
				},
			},
		]);

		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.documentPullDiagnostics.has(TEST_KEY)).toBe(false);
	});

	it("does nothing when client is not alive", async () => {
		const state = createMockState({ isConnected: false });
		await handleNotifyChange(state, TEST_FILE, "const y = 2;");

		expect(state.connection.sendNotification).not.toHaveBeenCalled();
	});

	it("coalesces a same-file burst before a non-draining write starts (#2357)", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		const writeGate = gatedPromise<void>();
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async () => writeGate.promise,
		);
		logLatencyMock.mockClear();

		try {
			let settled = 0;
			const first = handleNotifyChange(state, TEST_FILE, "v1").finally(
				() => settled++,
			);
			const second = handleNotifyChange(state, TEST_FILE, "v2").finally(
				() => settled++,
			);
			const newest = handleNotifyChange(state, TEST_FILE, "v3").finally(
				() => settled++,
			);
			await Promise.resolve();

			const writes = vi
				.mocked(state.connection.sendNotification)
				.mock.calls.filter(([method]) => method === "textDocument/didChange");
			expect(writes).toHaveLength(1);
			expect(
				(writes[0][1] as { contentChanges: Array<{ text: string }> })
					.contentChanges[0].text,
			).toBe("v3");
			writeGate.resolve();
			await waitFor(
				() => settled,
				(count) => count === 3,
				{
					timeoutMs: 1_000,
				},
			);
			await Promise.all([first, second, newest]);

			const sendRecord = logLatencyMock.mock.calls.find(
				([entry]) => entry?.phase === "lsp_document_send",
			);
			expect(sendRecord?.[0].metadata.coalescedCount).toBe(2);
		} finally {
			writeGate.resolve();
		}
	});

	it("rejects a started write while continuing with the newer pending entry (#2357)", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 0);
		const firstWrite = gatedPromise<void>();
		let didChangeCalls = 0;
		vi.mocked(state.connection.sendNotification).mockImplementation(
			async (method) => {
				if (method !== "textDocument/didChange") return;
				didChangeCalls++;
				if (didChangeCalls === 1) {
					await firstWrite.promise;
					throw new Error("first didChange failed");
				}
			},
		);

		try {
			const first = handleNotifyChange(state, TEST_FILE, "v1");
			await waitFor(
				() => didChangeCalls,
				(calls) => calls === 1,
			);
			const newer = handleNotifyChange(state, TEST_FILE, "v2");
			firstWrite.resolve();

			await expect(first).rejects.toThrow("first didChange failed");
			await waitFor(
				() => didChangeCalls,
				(calls) => calls === 2,
				{ timeoutMs: 1_000 },
			);
			await expect(newer).resolves.toBeUndefined();
			expect(state.notifyChangeQueues.size).toBe(0);
		} finally {
			firstWrite.resolve();
		}
	});

	it("keeps different files independent while coalescing each file (#2357)", async () => {
		const state = createMockState();
		const otherFile = "/project/other.ts";
		state.openDocuments.add(TEST_KEY);
		state.openDocuments.add(normalizeMapKey(otherFile));
		state.documentVersions.set(TEST_KEY, 0);
		state.documentVersions.set(normalizeMapKey(otherFile), 0);

		const a1 = handleNotifyChange(state, TEST_FILE, "a1");
		const a2 = handleNotifyChange(state, TEST_FILE, "a2");
		const b1 = handleNotifyChange(state, otherFile, "b1");
		const b2 = handleNotifyChange(state, otherFile, "b2");
		await Promise.all([a1, a2, b1, b2]);

		const writes = vi
			.mocked(state.connection.sendNotification)
			.mock.calls.filter(([method]) => method === "textDocument/didChange");
		expect(writes).toHaveLength(2);
		expect(
			writes.map(
				([, params]) =>
					(params as { contentChanges: Array<{ text: string }> })
						.contentChanges[0].text,
			),
		).toEqual(["a2", "b2"]);
	});
});

describe("clientWaitForDiagnostics", () => {
	it("resolves immediately if diagnostics already cached", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "error",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		// Should resolve immediately without waiting
	});

	it("does not accept cached diagnostics at or below minVersion", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "stale error",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				},
			},
		]);

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 50, { minVersion: 1 });
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40);
	});

	it("resolves when diagnostics advance past minVersion", async () => {
		const state = createMockState();
		state.diagnosticsVersion = 1;

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000, {
			minVersion: 1,
		});

		setTimeout(() => {
			// #1531: advance through the production seam. Assigning the global counter
			// alone no longer satisfies the gate, which now reads the per-path stamp —
			// and a test that hand-rolls the bump would stop modelling a real publish.
			bumpDiagnosticsVersion(state, TEST_KEY);
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 50);

		await waitPromise;
	});

	// #1531: a SIBLING file's publication must not satisfy this file's freshness
	// gate. The exposure is the early-return: a resync that preserves diagnostics
	// (format-only touches) leaves this path's cache populated, and pre-fix the gate
	// asked only whether the client-GLOBAL counter had advanced past the baseline —
	// which a sibling's publication does. The wait then returned instantly, serving
	// the file's PREVIOUS diagnostics as fresh for this touch, and downstream the
	// outcome row read `silent` (a label reserved for "this server's own budget
	// lapsed with nothing published") rather than the truth.
	it("does not treat a SIBLING path's publication as fresh diagnostics for this file", async () => {
		const state = createMockState();
		const siblingKey = normalizeMapKey("/project/other.ts");
		// This path's cache holds diagnostics from an EARLIER touch, preserved
		// across the resync.
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "previous finding",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			},
		]);
		bumpDiagnosticsVersion(state, TEST_KEY);
		const baseline = state.diagnosticsVersion;

		// A publication for the SIBLING advances the client-global counter past the
		// baseline. Nothing new landed for this file.
		bumpDiagnosticsVersion(state, siblingKey);
		expect(state.diagnosticsVersion).toBeGreaterThan(baseline);
		expect(diagnosticsVersionForPath(state, TEST_KEY)).toBeLessThanOrEqual(
			baseline,
		);

		const startedAt = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 120, {
			minVersion: baseline,
		});
		// Pre-fix this returned in ~0ms on the sibling's bump. The wait must instead
		// run to its own timeout, because no publication landed for THIS file.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
	});

	it("still resolves immediately when THIS file's own publication is fresh", async () => {
		const state = createMockState();
		const baseline = state.diagnosticsVersion;
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "own fresh finding",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			},
		]);
		bumpDiagnosticsVersion(state, TEST_KEY);

		const startedAt = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 500, {
			minVersion: baseline,
		});
		expect(Date.now() - startedAt).toBeLessThan(100);
	});

	it("resolves when diagnostics arrive via emitter", async () => {
		const state = createMockState();

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000);

		// Simulate diagnostics arriving after a short delay
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 50);

		await waitPromise;
	});

	it("resolves after timeout if no diagnostics arrive", async () => {
		const state = createMockState();

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 100);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(90);
	});

	it("ignores diagnostics for other files", async () => {
		const state = createMockState();

		const waitPromise = clientWaitForDiagnostics(state, TEST_FILE, 5000);

		// Emit diagnostics for a different file
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", "/project/other.ts");
		}, 50);

		// Emit for the right file after a bit longer
		setTimeout(() => {
			state.diagnosticEmitter.emit("diagnostics", TEST_FILE);
		}, 100);

		await waitPromise;
	});
});

describe("publishDiagnostics handler — superseded push guard (cache-poisoning fix)", () => {
	// The handler is registered via connection.onNotification during
	// setupIncomingHandlers; the mock connection's onNotification is a vi.fn(),
	// so we capture the callback it's invoked with to drive the handler
	// directly, the same way the real vscode-jsonrpc connection would.
	type PublishDiagnosticsParams = {
		uri: string;
		diagnostics?: LSPDiagnostic[];
		version?: number;
	};

	function createCapturingState(overrides: Partial<LSPClientState> = {}): {
		state: LSPClientState;
		emitPublishDiagnostics: (params: PublishDiagnosticsParams) => void;
	} {
		const state = createMockState({ serverId: "test-server", ...overrides });
		let handler: ((params: PublishDiagnosticsParams) => void) | undefined;
		(
			state.connection.onNotification as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(
			(method: string, cb: (params: PublishDiagnosticsParams) => void) => {
				if (method === "textDocument/publishDiagnostics") handler = cb;
			},
		);
		setupIncomingHandlers(state, undefined);
		if (!handler) {
			throw new Error("publishDiagnostics handler was not registered");
		}
		return {
			state,
			emitPublishDiagnostics: (params) => handler?.(params),
		};
	}

	// "test-server" doesn't match any known strategy id, so it falls to the
	// DEFAULT_STRATEGY (seedFirstPush: false, debounceMs: 150) — the debounced
	// cache-write path exercised here is the common one across real servers.
	const DEBOUNCE_WAIT_MS = 220;

	function diagnostic(message: string, code?: string): LSPDiagnostic {
		return {
			severity: 1,
			message,
			code,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		};
	}

	it("waits for native TS7's versionless push burst to stabilize", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		Object.defineProperty(state, "serverId", { value: "typescript" });
		Object.defineProperty(state, "launchVariant", { value: "native-ts7" });
		const wait = clientWaitForDiagnostics(state, TEST_FILE, 500);

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			diagnostics: [diagnostic("bogus partial-program error", "2345")],
		});
		setTimeout(() => {
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				diagnostics: [],
			});
		}, 20);

		await wait;
		expect(state.pushDiagnostics.get(TEST_KEY)).toEqual([]);
	});

	it("demotes a pull declaration after the first observed push", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			diagnostics: [diagnostic("push-only result")],
		});

		await vi.waitFor(() => {
			expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
			expect(state.pushDiagnostics.get(TEST_KEY)).toHaveLength(1);
		});
	});

	it("keeps classic TypeScript's first publication authoritative", () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		Object.defineProperty(state, "serverId", { value: "typescript" });
		Object.defineProperty(state, "launchVariant", { value: "classic" });

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			diagnostics: [diagnostic("classic result", "2322")],
		});

		expect(state.pushDiagnostics.get(TEST_KEY)?.[0]?.message).toBe(
			"classic result",
		);
	});

	it("surfaces an intentional native TS7 error present across the burst", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		Object.defineProperty(state, "serverId", { value: "typescript" });
		Object.defineProperty(state, "launchVariant", { value: "native-ts7" });
		const wait = clientWaitForDiagnostics(state, TEST_FILE, 500);

		for (const delay of [0, 20]) {
			setTimeout(() => {
				emitPublishDiagnostics({
					uri: pathToFileURL(TEST_FILE).href,
					diagnostics: [diagnostic("real error", "2322")],
				});
			}, delay);
		}

		await wait;
		expect(state.pushDiagnostics.get(TEST_KEY)?.[0]?.message).toBe(
			"real error",
		);
	});

	it("settles a single native TS7 publication within the bounded quiet window", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		Object.defineProperty(state, "serverId", { value: "typescript" });
		Object.defineProperty(state, "launchVariant", { value: "native-ts7" });
		const startedAt = Date.now();
		const wait = clientWaitForDiagnostics(state, TEST_FILE, 500);

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			diagnostics: [diagnostic("single result", "2322")],
		});
		await wait;

		expect(Date.now() - startedAt).toBeLessThan(300);
		expect(state.pushDiagnostics.get(TEST_KEY)?.[0]?.message).toBe(
			"single result",
		);
	});

	it("cancels a pending native TS7 quiet-window timer on clear/resync", async () => {
		// The headline #1412 safety property: a versionless publication armed
		// BEFORE a resync must never land its (stale) diagnostics AFTER the
		// document content changed. clearDiagnosticsForPath is what every
		// didChange/resync/initial-open path calls — deleting its clearTimeout
		// must turn this test red.
		const { state, emitPublishDiagnostics } = createCapturingState();
		Object.defineProperty(state, "serverId", { value: "typescript" });
		Object.defineProperty(state, "launchVariant", { value: "native-ts7" });

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			diagnostics: [diagnostic("stale pre-resync error", "2345")],
		});
		expect(state.pendingDiagnostics.has(TEST_KEY)).toBe(true);

		clearDiagnosticsForPath(state, TEST_KEY);
		expect(state.pendingDiagnostics.has(TEST_KEY)).toBe(false);

		// Wait past the quiet window: the canceled timer must not fire and
		// resurrect the pre-resync diagnostics.
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));
		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
	});

	it("drops a late push whose version lags the current document version, without poisoning the cache", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		// Simulate two edits having already landed (didChange bumped this twice).
		state.documentVersions.set(TEST_KEY, 2);

		// A push that arrives late, still reporting analysis of the FIRST edit.
		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: 1,
			diagnostics: [
				{
					severity: 1,
					message: "stale diagnostic from edit #1",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		// The superseded push must never reach the cache — this is the actual
		// bug: getDiagnostics()/getAllDiagnostics()/pruneDiagnostics() read
		// pushDiagnostics directly and don't consult isVersionStale (that check
		// only gates clientWaitForDiagnostics), so a cached stale push would be
		// served as current until the next fresh push overwrites it.
		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticDocVersions.has(TEST_KEY)).toBe(false);
	});

	it("caches a push whose version matches the current document version (no false-positive drops)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		state.documentVersions.set(TEST_KEY, 2);

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: 2,
			diagnostics: [
				{
					severity: 1,
					message: "current diagnostic",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		const cached = state.pushDiagnostics.get(TEST_KEY);
		expect(cached).toBeDefined();
		expect(cached?.[0]?.message).toBe("current diagnostic");
		expect(state.diagnosticDocVersions.get(TEST_KEY)).toBe(2);
	});

	it("still caches a push when the document version is unknown (version-less servers unaffected)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		// No entry in documentVersions for this path — server never reports one.

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: undefined,
			diagnostics: [
				{
					severity: 1,
					message: "version-less diagnostic",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		const cached = state.pushDiagnostics.get(TEST_KEY);
		expect(cached).toBeDefined();
		expect(cached?.[0]?.message).toBe("version-less diagnostic");
	});

	// #1095: content binding capture on the publish path.
	it("binds the stored diagnostics to the sent content fingerprint when the publish version matches (T1)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		const content = "const x = 1;\n";
		// Mirror production: the document is open and a didChange sends version 2,
		// fingerprinting the exact payload text at send time (never a disk read).
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 1);
		await handleNotifyChange(state, TEST_FILE, content);
		expect(state.documentContentHashes.get(TEST_KEY)).toEqual({
			version: 2,
			hash: hashDiagnosticContent(content),
		});

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: 2,
			diagnostics: [
				{
					severity: 1,
					message: "current diagnostic",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		expect(state.diagnosticBindings.get(TEST_KEY)).toEqual({
			version: 2,
			contentHash: hashDiagnosticContent(content),
		});
	});

	it("records NO binding for a superseded push — server lags a didChange (T2)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		// Two edits landed; the latest sent version is 2 with its own fingerprint.
		state.documentVersions.set(TEST_KEY, 2);
		state.documentContentHashes.set(TEST_KEY, {
			version: 2,
			hash: hashDiagnosticContent("const x = 2;\n"),
		});

		// A late push still analyzing edit #1 (version 1 < 2) — dropped before cache.
		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: 1,
			diagnostics: [
				{
					severity: 1,
					message: "stale diagnostic from edit #1",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		// No diagnostics cached AND no binding recorded for the superseded push.
		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
	});

	it("records NO contentHash when the server omits version — version-less binding stays unknown (T3)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		// Even with a sent fingerprint on record, a version-less publish must not
		// bind — otherwise version-less servers would change behavior.
		state.documentContentHashes.set(TEST_KEY, {
			version: 0,
			hash: hashDiagnosticContent("const x = 1;\n"),
		});

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: undefined,
			diagnostics: [
				{
					severity: 1,
					message: "version-less diagnostic",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(true);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
	});

	it("binds version but no contentHash when the sent fingerprint is for a different version (I3 fallback → unknown)", async () => {
		const { state, emitPublishDiagnostics } = createCapturingState();
		state.documentVersions.set(TEST_KEY, 2);
		// The only fingerprint we hold is for an OLDER version (1) — cannot bind
		// version 2's content, so contentHash is left undefined → verifier "unknown".
		state.documentContentHashes.set(TEST_KEY, {
			version: 1,
			hash: hashDiagnosticContent("old"),
		});

		emitPublishDiagnostics({
			uri: pathToFileURL(TEST_FILE).href,
			version: 2,
			diagnostics: [
				{
					severity: 1,
					message: "current diagnostic",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

		const binding = state.diagnosticBindings.get(TEST_KEY);
		expect(binding?.version).toBe(2);
		expect(binding?.contentHash).toBeUndefined();
	});

	// #1095 (P2-3): reopenOnResync servers (opengrep) close+reopen on every
	// resync. Resetting the version to 0 each time made a late publish for an
	// EARLIER resync's content echo the SAME 0 as the current send, so the
	// superseded guard accepted it and bound STALE diagnostics to the CURRENT
	// content's fingerprint (an affirmative false-TRUE). Monotonic versions across
	// reopen make the late echo strictly older → dropped → never bound.
	it("does not bind a late publish from an earlier reopen-resync as current (monotonic reopen)", async () => {
		const state = createMockState({ serverId: "opengrep" });
		let handler: ((params: PublishDiagnosticsParams) => void) | undefined;
		(
			state.connection.onNotification as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(
			(method: string, cb: (params: PublishDiagnosticsParams) => void) => {
				if (method === "textDocument/publishDiagnostics") handler = cb;
			},
		);
		setupIncomingHandlers(state, undefined);

		// The document is already open (an earlier resync established it at v3).
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 3);

		// Resync #1 (content_A): opengrep reopen path carries the version FORWARD.
		await handleNotifyOpen(state, TEST_FILE, "const a = 1;\n", "plaintext");
		expect(state.documentVersions.get(TEST_KEY)).toBe(4);
		// Resync #2 (content_B): version advances again — no reuse of 0.
		await handleNotifyOpen(state, TEST_FILE, "const a = 2;\n", "plaintext");
		expect(state.documentVersions.get(TEST_KEY)).toBe(5);

		// opengrep's LATE publish still analyzing resync #1 echoes the stale v4.
		handler?.({
			uri: pathToFileURL(TEST_FILE).href,
			version: 4,
			diagnostics: [
				{
					severity: 1,
					message: "stale finding from resync #1",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		// opengrep debounceMs is 250 — wait past it for the (dropped) timer.
		await new Promise((resolve) => setTimeout(resolve, 350));

		// v4 < current v5 → superseded → dropped: no stale diagnostics cached and,
		// critically, NO binding of resync #1's diagnostics to resync #2's content.
		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
	});

	// #1639: `logSequence` — the PUSH-path producer of
	// `lsp_typescript_diagnostic_sequence` — is the actual source of the
	// issue's cited evidence. It had the same durationMs-as-document-age and
	// version:null bugs as the pull path, PLUS its raw per-publication receipt
	// (`logSequence(false)`) logged with no `settleSource` at all — the
	// "unsettled-then-settled" pair (~61ms apart, near-identical document age)
	// the issue described as a double-emit is this function's own designed
	// shape, not `ensureWarmForSweep`'s pull path.
	describe("logSequence — push-path pull-settle record shape (#1639)", () => {
		it("a quiet-window settle's durationMs times the debounce wait, not document age", async () => {
			const { state, emitPublishDiagnostics } = createCapturingState();
			// native-ts7 → seedFirstPush false, so every publish goes through the
			// debounce/quiet-window path (never the immediate first-push seed).
			Object.defineProperty(state, "serverId", { value: "typescript" });
			Object.defineProperty(state, "launchVariant", { value: "native-ts7" });
			// Document opened 90s ago — pre-fix, durationMs on the SETTLED record
			// was hardcoded to this age.
			state.documentOpenedAt.set(TEST_KEY, Date.now() - 90_000);

			pullSequenceEvents.length = 0;
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				diagnostics: [diagnostic("real error", "2322")],
			});
			await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

			const settled = pullSequenceEvents.find(
				(event) =>
					event.metadata &&
					(event.metadata as Record<string, unknown>).settledReturn === true,
			);
			expect(settled).toBeDefined();
			// The debounce wait is ~50ms (typescript's own debounceMs) — nowhere
			// near the 90s document age.
			expect(settled!.durationMs as number).toBeLessThan(1000);
			const metadata = settled!.metadata as Record<string, unknown>;
			expect(metadata.elapsedSinceDidOpenMs as number).toBeGreaterThanOrEqual(
				89_000,
			);
			expect(metadata.settleSource).toBe("quiet-window");
		});

		it("tags the raw per-publication receipt distinctly from the settle it precedes", async () => {
			const { state, emitPublishDiagnostics } = createCapturingState();
			Object.defineProperty(state, "serverId", { value: "typescript" });
			Object.defineProperty(state, "launchVariant", { value: "native-ts7" });

			pullSequenceEvents.length = 0;
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				diagnostics: [diagnostic("real error", "2322")],
			});
			await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));

			// The exact "double-emit" pair the issue described: one unsettled
			// receipt immediately followed by one settle, for the same file.
			expect(pullSequenceEvents).toHaveLength(2);
			const [unsettled, settled] = pullSequenceEvents.map(
				(event) => event.metadata as Record<string, unknown>,
			);
			expect(unsettled.settledReturn).toBe(false);
			expect(unsettled.settleSource).toBe("publication");
			expect(unsettled).toMatchObject({
				serverId: "typescript",
				outcome: "published",
			});
			expect(pullSequenceEvents[0].durationMs).toBe(0);
			expect(settled.settledReturn).toBe(true);
			expect(settled.settleSource).toBe("quiet-window");
			expect(settled).toMatchObject({
				serverId: "typescript",
				outcome: "settled",
			});
		});

		it("a first-push settle's durationMs is 0 (no debounce wait), not document age", async () => {
			const { state, emitPublishDiagnostics } = createCapturingState();
			// serverId "typescript" alone (no native-ts7 launchVariant) →
			// seedFirstPush true — the very first publish settles immediately.
			Object.defineProperty(state, "serverId", { value: "typescript" });
			state.documentOpenedAt.set(TEST_KEY, Date.now() - 90_000);

			pullSequenceEvents.length = 0;
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				diagnostics: [diagnostic("first push", "2322")],
			});

			expect(pullSequenceEvents).toHaveLength(1);
			expect(pullSequenceEvents[0].durationMs).toBe(0);
			const metadata = pullSequenceEvents[0].metadata as Record<
				string,
				unknown
			>;
			expect(metadata.settleSource).toBe("first-push");
			expect(metadata.elapsedSinceDidOpenMs as number).toBeGreaterThanOrEqual(
				89_000,
			);
		});

		it("marks a settle with no server-reported version as push-unversioned, never null", async () => {
			const { state, emitPublishDiagnostics } = createCapturingState();
			Object.defineProperty(state, "serverId", { value: "typescript" });

			pullSequenceEvents.length = 0;
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				diagnostics: [diagnostic("no version", "2322")],
				// version omitted — the server never reported one.
			});

			expect(pullSequenceEvents).toHaveLength(1);
			const metadata = pullSequenceEvents[0].metadata as Record<
				string,
				unknown
			>;
			expect(metadata.version).toBe("push-unversioned");
		});

		it("keeps the real server-reported version when present", async () => {
			const { state, emitPublishDiagnostics } = createCapturingState();
			Object.defineProperty(state, "serverId", { value: "typescript" });

			pullSequenceEvents.length = 0;
			emitPublishDiagnostics({
				uri: pathToFileURL(TEST_FILE).href,
				version: 7,
				diagnostics: [diagnostic("versioned", "2322")],
			});

			expect(pullSequenceEvents).toHaveLength(1);
			const metadata = pullSequenceEvents[0].metadata as Record<
				string,
				unknown
			>;
			expect(metadata.version).toBe(7);
		});
	});
});

describe("clientWaitForDiagnostics — pull mode (#240)", () => {
	// serverId "typescript" → pullRetryBudgetMs 0, so no incremental retry loop;
	// the first pull outcome is decisive. mode "pull" routes through the pull
	// branch. diagnosticProviderKind "object" = an advertised pull provider.
	const pullState = (): LSPClientState =>
		createMockState({
			serverId: "typescript",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});

	it("resolves immediately on an authoritative empty (clean) pull report", async () => {
		const state = pullState();
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "full", items: [] });

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		expect(Date.now() - start).toBeLessThan(80);
	});

	it("resolves immediately when the pull returns diagnostics (found)", async () => {
		const state = pullState();
		state.connection.sendRequest = vi.fn().mockResolvedValue({
			kind: "full",
			items: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);
		expect(Date.now() - start).toBeLessThan(80);
	});

	it("does NOT treat a failed/unavailable pull as clean — waits the budget rather than short-circuiting", async () => {
		const state = pullState();
		// undefined reply → safeSendRequest returns undefined → outcome
		// "unavailable". With no minVersion baseline the OLD code returned
		// immediately via `|| hasFreshDiagnostics()` (a false clean); the fix must
		// instead fall through to the push-wait/timeout backstop.
		state.connection.sendRequest = vi.fn().mockResolvedValue(undefined);

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 120);
		expect(Date.now() - start).toBeGreaterThanOrEqual(100);
	});

	it("bounds a hung pull request instead of hanging forever", async () => {
		const state = pullState();
		// A pull-mode server that accepts textDocument/diagnostic but NEVER
		// replies (stream stays alive). safeSendRequest only settles on a reply or
		// a destroyed stream, so pre-fix this await never resolves and hangs the
		// whole diagnostics wait (→ pipeline → flush → lens_diagnostics). The
		// per-request withTimeout must bound it: time out → unavailable → fall
		// through to the push backstop and resolve within the caller's budget.
		state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

		const start = Date.now();
		await clientWaitForDiagnostics(state, TEST_FILE, 120);
		const elapsed = Date.now() - start;
		// Went through the timeout→backstop path (not a false early clean)...
		expect(elapsed).toBeGreaterThanOrEqual(100);
		// ...and did NOT hang on the never-resolving request.
		expect(elapsed).toBeLessThan(2000);
	});
});

// #1639: `logTypeScriptPullSettle` (the `lsp_typescript_diagnostic_sequence`
// phase's pull-path producer) misused durationMs as document age, hardcoded
// version:null, and double-emitted indistinguishably for two legitimate call
// paths (a real touch vs `ensureWarmForSweep`'s warm-up probe). Mirrors the
// "pull mode (#240)" describe block's state shape.
describe("logTypeScriptPullSettle — pull-settle record shape (#1639)", () => {
	const pullState = (): LSPClientState =>
		createMockState({
			serverId: "typescript",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});

	it("durationMs measures the settle operation, not time-since-didOpen (document age stays in metadata)", async () => {
		const state = pullState();
		// Document opened 90s ago — pre-fix, durationMs was hardcoded to this
		// age, so a settle that actually took milliseconds read as a >60s
		// "duration" (the session evidence: 147/239 records read this way).
		state.documentOpenedAt.set(TEST_KEY, Date.now() - 90_000);
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "full", items: [] });

		pullSequenceEvents.length = 0;
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);

		expect(pullSequenceEvents).toHaveLength(1);
		const event = pullSequenceEvents[0];
		// The settle itself took milliseconds (an in-memory mocked reply) —
		// nowhere near the 90s document age.
		expect(event.durationMs as number).toBeLessThan(1000);
		const metadata = event.metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			serverId: "typescript",
			outcome: "settled",
		});
		// The document age is still recorded, honestly named, in metadata.
		expect(metadata.elapsedSinceDidOpenMs as number).toBeGreaterThanOrEqual(
			89_000,
		);
	});

	it("carries the real tracked version instead of a hardcoded null", async () => {
		const state = pullState();
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "full", items: [] });
		// Mirror production: a prior publication already bumped the per-path
		// version stamp before this pull settles.
		bumpDiagnosticsVersion(state, TEST_KEY);
		bumpDiagnosticsVersion(state, TEST_KEY);

		pullSequenceEvents.length = 0;
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);

		expect(pullSequenceEvents).toHaveLength(1);
		const metadata = pullSequenceEvents[0].metadata as Record<string, unknown>;
		expect(metadata.version).toBe(diagnosticsVersionForPath(state, TEST_KEY));
		expect(metadata.version).not.toBeNull();
	});

	it("marks a settle with no tracked version as pull-unversioned, never null", async () => {
		const state = pullState();
		// A "kind: unchanged" report never calls `bumpDiagnosticsVersion` (see
		// the #1104 comment on that branch) — it inherits the PRIOR resultId
		// basis unchanged. Pre-populate that basis directly (rather than via a
		// real prior pull) so this settle is the first thing to ever touch
		// `diagnosticsVersionsByPath` for this path: nothing is tracked yet.
		state.pullResultIds.set(TEST_KEY, "r1");
		state.documentPullDiagnostics.set(TEST_KEY, []);
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "unchanged" });

		pullSequenceEvents.length = 0;
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);

		expect(pullSequenceEvents).toHaveLength(1);
		const metadata = pullSequenceEvents[0].metadata as Record<string, unknown>;
		expect(diagnosticsVersionForPath(state, TEST_KEY)).toBe(0);
		expect(metadata.version).toBe("pull-unversioned");
	});

	it("tags a warm-up-only settle distinctly from a real touch's settle (double-emit fix)", async () => {
		// #1639: `ensureWarmForSweep`'s readiness probe and the sweep's real
		// touch both run a genuine pull round trip for the SAME file, close
		// together — two legitimate settle observations, not a duplicate.
		// Pre-fix both logged identically as settleSource "pull" (239 records
		// vs 145 touches in the session evidence); the fix must tag them
		// distinctly so a consumer can tell them apart.
		const state = pullState();
		state.connection.sendRequest = vi
			.fn()
			.mockResolvedValue({ kind: "full", items: [] });

		pullSequenceEvents.length = 0;
		await clientWaitForDiagnostics(state, TEST_FILE, 1000, {
			pullSettleSource: "pull-warmup",
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 1000);

		expect(pullSequenceEvents).toHaveLength(2);
		const sources = pullSequenceEvents.map(
			(event) => (event.metadata as Record<string, unknown>).settleSource,
		);
		expect(sources).toEqual(["pull-warmup", "pull"]);
	});
});

// #1104: thread resultId + the request-time content fingerprint through the
// PULL protocol (textDocument/diagnostic + workspace/diagnostic) so pull-
// served diagnostics get the SAME content binding push-served ones have had
// since #1095, instead of reading "unknown" forever. Mirrors #1095's own
// client-internals binding tests in shape.
describe("pull-diagnostics content binding (#1104)", () => {
	const pullState = (): LSPClientState =>
		createMockState({
			serverId: "typescript",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});

	it("binds a 'full' textDocument/diagnostic report to the sent-content fingerprint and records its resultId", async () => {
		const state = pullState();
		const content = "const x = 1;\n";
		// Mirror production: the document was opened/changed before the pull, so
		// `documentContentHashes` already holds the exact fingerprint the pull's
		// answer is presumed to describe — no extra disk read needed.
		state.openDocuments.add(TEST_KEY);
		state.documentContentHashes.set(TEST_KEY, {
			version: 1,
			hash: hashDiagnosticContent(content),
		});
		state.connection.sendRequest = vi.fn().mockResolvedValue({
			kind: "full",
			resultId: "r1",
			items: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});

		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });

		expect(state.diagnosticBindings.get(TEST_KEY)).toEqual({
			contentHash: hashDiagnosticContent(content),
		});
		expect(state.pullResultIds.get(TEST_KEY)).toBe("r1");
	});

	it("an 'unchanged' report (same resultId) inherits the prior diagnostics AND binding instead of reading as clean", async () => {
		const state = pullState();
		const content = "const x = 1;\n";
		state.openDocuments.add(TEST_KEY);
		state.documentContentHashes.set(TEST_KEY, {
			version: 1,
			hash: hashDiagnosticContent(content),
		});
		const sendRequest = vi.fn().mockResolvedValueOnce({
			kind: "full",
			resultId: "r1",
			items: [
				{
					severity: 1,
					message: "boom",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				},
			],
		});
		state.connection.sendRequest = sendRequest;
		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });
		const bindingAfterFull = state.diagnosticBindings.get(TEST_KEY);
		expect(bindingAfterFull?.contentHash).toBe(hashDiagnosticContent(content));

		// Second pull: server confirms nothing changed (no `items`). Pre-#1104 this
		// codepath always overwrote with `report.items ?? []` — an empty array —
		// which would WRONGLY read as a confirmed-clean touch and silently wipe
		// the still-live "boom" diagnostic (the #570/#571 false-clean shape).
		sendRequest.mockResolvedValueOnce({ kind: "unchanged", resultId: "r1" });
		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });

		// The prior finding AND its binding both survived the unchanged report.
		expect(state.documentPullDiagnostics.get(TEST_KEY)?.length).toBe(1);
		expect(state.diagnosticBindings.get(TEST_KEY)).toEqual(bindingAfterFull);
		// The second request echoed the resultId from the first.
		expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
			previousResultId: "r1",
		});
	});

	it("clearDiagnosticsForPath (a resync) drops the pull resultId basis so a later pull cannot inherit stale content", async () => {
		const state = pullState();
		state.openDocuments.add(TEST_KEY);
		state.documentContentHashes.set(TEST_KEY, {
			version: 1,
			hash: hashDiagnosticContent("const x = 1;\n"),
		});
		state.connection.sendRequest = vi.fn().mockResolvedValue({
			kind: "full",
			resultId: "r1",
			items: [],
		});
		await clientWaitForDiagnostics(state, TEST_FILE, 1000, { pullOnly: true });
		expect(state.pullResultIds.get(TEST_KEY)).toBe("r1");

		// A resync (didChange) clears diagnostic state for the path.
		await handleNotifyChange(state, TEST_FILE, "const x = 2;\n");

		expect(state.pullResultIds.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
	});
});

describe("clientRequestWorkspaceDiagnostics content binding (#1104)", () => {
	function pullSupportState(): LSPClientState {
		return createMockState({
			serverId: "typescript",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
	}

	it("fingerprints disk bytes at request time for a 'full' item and returns the hash", async () => {
		const state = pullSupportState();
		const filePath = path.join(os.tmpdir(), `pi-lens-1104-${Date.now()}.ts`);
		const content = "const y = 2;\n";
		fs.writeFileSync(filePath, content);
		try {
			const uri = pathToFileURL(filePath).href;
			state.connection.sendRequest = vi.fn().mockResolvedValue({
				items: [{ uri, kind: "full", resultId: "wr1", items: [] }],
			});

			const report = await clientRequestWorkspaceDiagnostics(state, 1000);

			expect(report?.[0]?.contentHash).toBe(hashDiagnosticContent(content));
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	it("an 'unchanged' item inherits the prior pull's diagnostics + contentHash and echoes previousResultIds on the next request", async () => {
		const state = pullSupportState();
		const filePath = path.join(os.tmpdir(), `pi-lens-1104b-${Date.now()}.ts`);
		fs.writeFileSync(filePath, "const y = 2;\n");
		try {
			const uri = pathToFileURL(filePath).href;
			const sendRequest = vi.fn().mockResolvedValueOnce({
				items: [
					{
						uri,
						kind: "full",
						resultId: "wr1",
						items: [
							{
								severity: 1,
								message: "boom",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
							},
						],
					},
				],
			});
			state.connection.sendRequest = sendRequest;
			const first = await clientRequestWorkspaceDiagnostics(state, 1000);
			const firstHash = first?.[0]?.contentHash;
			expect(first?.[0]?.diagnostics.length).toBe(1);

			sendRequest.mockResolvedValueOnce({
				items: [{ uri, kind: "unchanged", resultId: "wr1" }],
			});
			const second = await clientRequestWorkspaceDiagnostics(state, 1000);

			expect(second?.[0]?.diagnostics.length).toBe(1);
			expect(second?.[0]?.contentHash).toBe(firstHash);
			expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
				previousResultIds: [{ uri, value: "wr1" }],
			});
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});
});

describe("pull fallback honesty + failure telemetry (#1292)", () => {
	it("keeps push diagnostics visible after an operational pull failure", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "boolean",
			},
		});
		state.pushDiagnostics.set(TEST_KEY, [
			{
				severity: 1,
				message: "push result",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			},
		]);
		state.connection.sendRequest = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("server unavailable"), { code: 500 }),
			);

		await clientWaitForDiagnostics(state, TEST_FILE, 50);

		expect(state.pushDiagnostics.get(TEST_KEY)?.[0]?.message).toBe(
			"push result",
		);
		expect(state.pullFailureHistory.length).toBeGreaterThanOrEqual(1);
		expect(state.pullFailureHistory[0]).toMatchObject({
			method: "textDocument/diagnostic",
			code: 500,
			message: "server unavailable",
		});
	});

	it.each([
		[-32601, "server-specific text"],
		[undefined, "Method not found: textDocument/diagnostic"],
	])(
		"does not record an unsupported-method response as an operational failure (%s)",
		async (code, message) => {
			const state = createMockState({
				workspaceDiagnosticsSupport: {
					advertised: true,
					mode: "pull",
					workspaceDiagnostics: false,
					diagnosticProviderKind: "boolean",
				},
			});
			const error = new Error(message);
			if (code !== undefined) Object.assign(error, { code });
			state.connection.sendRequest = vi.fn().mockRejectedValue(error);

			await clientWaitForDiagnostics(state, TEST_FILE, 20);

			expect(state.pullFailureHistory).toHaveLength(0);
		},
	);

	it.each([
		[new Error("Timeout after 20ms")],
		[Object.assign(new Error("Internal error"), { code: -32603 })],
	])("records genuine operational pull failures", async (error) => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "boolean",
			},
		});
		state.connection.sendRequest = vi.fn().mockRejectedValue(error);

		await clientWaitForDiagnostics(state, TEST_FILE, 20);

		expect(state.pullFailureHistory.length).toBeGreaterThan(0);
	});
});

describe("shutdown protocol race fixture (#1292)", () => {
	it("handles dynamic registration and ignores a late publish after didClose", async () => {
		const state = createMockState();
		state.openDocuments.add(TEST_KEY);
		state.documentVersions.set(TEST_KEY, 1);
		state.diagnosticBindings.set(TEST_KEY, {
			version: 1,
			contentHash: "existing",
		});
		setupIncomingHandlers(state, {});
		const notifications = vi.mocked(state.connection.onNotification).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const publish = notifications.find(
			([method]) => method === "textDocument/publishDiagnostics",
		)?.[1] as ((params: unknown) => void) | undefined;
		const requests = vi.mocked(state.connection.onRequest).mock
			.calls as unknown as Array<[string, (...args: unknown[]) => unknown]>;
		const register = requests.find(
			([method]) => method === "client/registerCapability",
		)?.[1] as ((params: unknown) => Promise<void>) | undefined;
		await register?.({
			registrations: [{ id: "pull", method: "textDocument/diagnostic" }],
		});
		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		const folders = requests.find(
			([method]) => method === "workspace/workspaceFolders",
		)?.[1] as (() => unknown) | undefined;
		await closeDocument(state, TEST_FILE);
		expect(state.openDocuments.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
		state.isDestroyed = true;
		expect(() => folders?.()).not.toThrow();

		publish?.({
			uri: pathToFileURL(TEST_FILE).href,
			version: 1,
			diagnostics: [
				{
					severity: 1,
					message: "late",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
				},
			],
		});
		await Promise.resolve();
		expect(state.pushDiagnostics.has(TEST_KEY)).toBe(false);
		expect(state.diagnosticBindings.has(TEST_KEY)).toBe(false);
	});
});

describe("navRequest — per-request timeout ceiling (#365)", () => {
	// workspaceSymbol and codeAction now route through navRequest, so its
	// withTimeout ceiling is what stops a hung server (a request the server
	// accepts but never replies to — safeSendRequest only settles on a reply or
	// a destroyed stream) from hanging those tools forever.
	const TEST_FILE = "/proj/file.ts";

	it.each(["workspace/symbol", "textDocument/codeAction"])(
		"bounds a hung %s request instead of hanging forever",
		async (method) => {
			const state = createMockState();
			state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

			const start = Date.now();
			const result = await navRequest(state, method, {}, undefined, 120);
			const elapsed = Date.now() - start;

			expect(result).toBeUndefined();
			// Went through the timeout, not an instant error return...
			expect(elapsed).toBeGreaterThanOrEqual(100);
			// ...and did not hang on the never-resolving request.
			expect(elapsed).toBeLessThan(2000);
		},
	);

	it("returns the server result unchanged on a normal reply", async () => {
		const state = createMockState();
		const payload = [{ name: "sym", kind: 12 }];
		state.connection.sendRequest = vi.fn().mockResolvedValue(payload);

		const result = await navRequest(
			state,
			"workspace/symbol",
			{},
			undefined,
			120,
		);
		expect(result).toEqual(payload);
	});

	it("drops a single-file result when the document version advances mid-request", async () => {
		const state = createMockState();
		const key = normalizeMapKey(TEST_FILE);
		state.documentVersions.set(key, 1);
		// An edit lands while the request is in flight → the reply is stale.
		state.connection.sendRequest = vi.fn(async () => {
			state.documentVersions.set(key, 2);
			return [{ title: "stale action" }];
		});

		const result = await navRequest(
			state,
			"textDocument/codeAction",
			{},
			TEST_FILE,
			120,
		);
		expect(result).toBeUndefined();
	});
});

describe("navRequest — $/cancelRequest on abort (#238 Item 1)", () => {
	it("does not send at all when the signal is already aborted", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn().mockResolvedValue([{ name: "x" }]);
		const controller = new AbortController();
		controller.abort();

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			120,
			controller.signal,
		);

		expect(result).toBeUndefined();
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
	});

	it("passes a CancellationToken when a signal is provided, none otherwise", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn().mockResolvedValue([]);

		await navRequest(state, "workspace/symbol", {}, undefined, 120);
		// No ambient signal in tests → third arg (token) is undefined.
		expect(
			vi.mocked(state.connection.sendRequest).mock.calls[0]?.[2],
		).toBeUndefined();

		await navRequest(
			state,
			"workspace/symbol",
			{},
			undefined,
			120,
			new AbortController().signal,
		);
		// Signal provided → a real CancellationToken is threaded to the server.
		const token = vi.mocked(state.connection.sendRequest).mock
			.calls[1]?.[2] as {
			onCancellationRequested?: unknown;
		};
		expect(token?.onCancellationRequested).toBeTypeOf("function");
	});

	it("cancels an in-flight request when the turn is abandoned mid-request", async () => {
		const state = createMockState();
		// Mock a server that only settles when its request token is cancelled —
		// exactly what vscode-jsonrpc does after emitting `$/cancelRequest`.
		state.connection.sendRequest = vi.fn(
			(_method: unknown, _params: unknown, token: any) =>
				new Promise((_resolve, reject) => {
					token?.onCancellationRequested(() => {
						const err = new Error("Request cancelled") as Error & {
							code: number;
						};
						err.code = -32800; // RequestCancelled
						reject(err);
					});
				}),
		) as unknown as typeof state.connection.sendRequest;

		const controller = new AbortController();
		const pending = navRequest(
			state,
			"textDocument/references",
			{},
			undefined,
			5000,
			controller.signal,
		);
		// Abort after the request is in flight → token cancels → server rejects.
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();

		expect(await pending).toBeUndefined();
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});
});

describe("navRequest — ContentModified retry (#238 Item 2)", () => {
	const modified = (): Error => {
		const err = new Error("content modified") as Error & { code: number };
		err.code = -32801;
		return err;
	};

	it("retries once on ContentModified and returns the retried result", async () => {
		const state = createMockState();
		let calls = 0;
		state.connection.sendRequest = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw modified();
			return [{ name: "fresh" }];
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
		);

		expect(result).toEqual([{ name: "fresh" }]);
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(2);
	});

	it("returns empty (not a throw) when ContentModified persists after the retry", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn(async () => {
			throw modified();
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
		);

		expect(result).toBeUndefined();
		// One retry only — not an unbounded loop.
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(2);
	});

	it("does not retry a permanent RequestFailed (-32803)", async () => {
		const state = createMockState();
		state.connection.sendRequest = vi.fn(async () => {
			const err = new Error("request failed") as Error & { code: number };
			err.code = -32803;
			throw err;
		}) as unknown as typeof state.connection.sendRequest;

		await expect(
			navRequest(state, "textDocument/definition", {}, undefined, 500),
		).rejects.toThrow();
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});

	it("does not retry when the signal aborts between attempts", async () => {
		const state = createMockState();
		const controller = new AbortController();
		state.connection.sendRequest = vi.fn(async () => {
			controller.abort(); // turn abandoned exactly as the first attempt fails
			throw modified();
		}) as unknown as typeof state.connection.sendRequest;

		const result = await navRequest(
			state,
			"textDocument/definition",
			{},
			undefined,
			500,
			controller.signal,
		);

		expect(result).toBeUndefined();
		// Aborted → no second attempt.
		expect(state.connection.sendRequest).toHaveBeenCalledTimes(1);
	});
});

describe("runServerCommand — executeCommand timeout backstop (#365)", () => {
	const advertised = (): LSPClientState => {
		const state = createMockState();
		state.advertisedCommands.add("test.command");
		return state;
	};

	it("bounds a hung command with the generous backstop and surfaces it honestly", async () => {
		const state = advertised();
		state.connection.sendRequest = vi.fn(() => new Promise<never>(() => {}));

		const start = Date.now();
		const outcome = await runServerCommand(state, "test.command", [], 120);
		const elapsed = Date.now() - start;

		expect(outcome.executed).toBe(false);
		expect(outcome.reason).toMatch(/timed out.*may still be applying/i);
		expect(elapsed).toBeGreaterThanOrEqual(100);
		expect(elapsed).toBeLessThan(2000);
		// The serverEditsAllowed window must close even on timeout.
		expect(state.serverEditsAllowed).toBe(0);
	});

	it("returns the command result on a normal reply", async () => {
		const state = advertised();
		state.connection.sendRequest = vi.fn().mockResolvedValue({ applied: true });

		const outcome = await runServerCommand(state, "test.command", [], 120);
		expect(outcome).toEqual({ executed: true, result: { applied: true } });
		expect(state.serverEditsAllowed).toBe(0);
	});

	it("refuses a command the server never advertised (hardening preserved)", async () => {
		const state = createMockState(); // advertisedCommands empty
		state.connection.sendRequest = vi.fn().mockResolvedValue({ applied: true });

		const outcome = await runServerCommand(state, "evil.command", [], 120);
		expect(outcome.executed).toBe(false);
		expect(outcome.reason).toMatch(/not advertised/i);
		// Never sent, and the edit window never opened.
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
		expect(state.serverEditsAllowed).toBe(0);
	});
});

describe("applyDynamicCapabilities", () => {
	it("upgrades to pull mode when textDocument/diagnostic is registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("diag-1", {
			method: "textDocument/diagnostic",
		});

		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.advertised).toBe(true);
		expect(state.workspaceDiagnosticsSupport.diagnosticProviderKind).toBe(
			"dynamic",
		);
	});

	it("keeps observed push mode when a pull registration arrives later", () => {
		const state = createMockState({ observedDiagnosticsChannel: "push" });
		state.dynamicRegistrations.set("diag-1", {
			method: "textDocument/diagnostic",
		});

		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
	});

	it("upgrades to pull mode when workspace/diagnostic is registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("ws-diag-1", {
			method: "workspace/diagnostic",
		});

		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
	});

	it("reverts to push-only when dynamic pull registration is removed", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("diag-1", {
			method: "textDocument/diagnostic",
		});
		applyDynamicCapabilities(state);
		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");

		state.dynamicRegistrations.delete("diag-1");
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
		expect(state.workspaceDiagnosticsSupport.advertised).toBe(false);
	});

	it("does not revert pull mode when statically advertised", () => {
		const state = createMockState({
			staticDiagnosticsMode: "pull",
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: false,
				diagnosticProviderKind: "object",
			},
		});
		// Even with no dynamic registrations, static pull should remain
		applyDynamicCapabilities(state);

		expect(state.workspaceDiagnosticsSupport.mode).toBe("pull");
		expect(state.workspaceDiagnosticsSupport.diagnosticProviderKind).toBe(
			"object",
		);
	});

	it("upgrades operation capabilities when methods are registered", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("def-1", {
			method: "textDocument/definition",
		});
		state.dynamicRegistrations.set("ref-1", {
			method: "textDocument/references",
		});
		state.dynamicRegistrations.set("hover-1", {
			method: "textDocument/hover",
		});

		applyDynamicCapabilities(state);

		expect(state.operationSupport.definition).toBe(true);
		expect(state.operationSupport.references).toBe(true);
		expect(state.operationSupport.hover).toBe(true);
		expect(state.operationSupport.rename).toBe(false); // not registered
	});

	it("does not downgrade already-true operation capabilities on unregister", () => {
		const state = createMockState({
			operationSupport: {
				definition: true,
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
			},
		});
		// No dynamic registrations — definition was statically true
		applyDynamicCapabilities(state);

		expect(state.operationSupport.definition).toBe(true);
	});

	it("ignores unknown registration methods without throwing", () => {
		const state = createMockState();
		state.dynamicRegistrations.set("unknown-1", {
			method: "some/unknownMethod",
		});

		expect(() => applyDynamicCapabilities(state)).not.toThrow();
		expect(state.workspaceDiagnosticsSupport.mode).toBe("push-only");
	});
});

describe("clientRequestWorkspaceDiagnostics — real report parsing", () => {
	function reportItem(absPath: string, kind: string, diags: unknown[] = []) {
		return { uri: pathToFileURL(absPath).href, version: 1, kind, items: diags };
	}
	function diag(message: string) {
		return {
			severity: 1,
			message,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 3 },
			},
		};
	}

	it("parses a WorkspaceDiagnosticReport into per-file diagnostics", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockResolvedValue({
			items: [
				reportItem("/project/a.ts", "full", [diag("boom"), diag("bang")]),
				reportItem("/project/b.ts", "full", []),
				// "unchanged" carries no items — must be skipped, not returned empty.
				reportItem("/project/c.ts", "unchanged"),
			],
		});

		const out = await clientRequestWorkspaceDiagnostics(state, 1000);

		expect(state.connection.sendRequest).toHaveBeenCalledWith(
			"workspace/diagnostic",
			{ previousResultIds: [] },
			expect.anything(),
		);
		expect(out).toBeDefined();
		const byName = (name: string) =>
			out?.find((r) => r.filePath.split("\\").join("/").endsWith(name));
		expect(byName("a.ts")?.diagnostics).toHaveLength(2);
		expect(byName("b.ts")?.diagnostics).toHaveLength(0);
		expect(byName("c.ts")).toBeUndefined(); // unchanged → skipped
	});

	it("returns undefined without sending when the server doesn't advertise workspace pull", async () => {
		const state = createMockState(); // workspaceDiagnostics: false by default
		const out = await clientRequestWorkspaceDiagnostics(state, 1000);
		expect(out).toBeUndefined();
		expect(state.connection.sendRequest).not.toHaveBeenCalled();
	});

	it("returns undefined on a malformed report (no items array)", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockResolvedValue({ nope: true });
		expect(
			await clientRequestWorkspaceDiagnostics(state, 1000),
		).toBeUndefined();
	});

	it("returns undefined when the request throws or yields nothing (dead/timeout)", async () => {
		const state = createMockState({
			workspaceDiagnosticsSupport: {
				advertised: true,
				mode: "pull",
				workspaceDiagnostics: true,
				diagnosticProviderKind: "object",
			},
		});
		vi.mocked(state.connection.sendRequest).mockRejectedValue(
			new Error("dead"),
		);
		expect(
			await clientRequestWorkspaceDiagnostics(state, 1000),
		).toBeUndefined();
	});
});

describe("per-path diagnostics versions (#1531)", () => {
	const FILE_A = "/project/a.ts";
	const FILE_B = "/project/b.ts";
	const KEY_A = normalizeMapKey(FILE_A);
	const KEY_B = normalizeMapKey(FILE_B);

	/** Drive the REAL `textDocument/publishDiagnostics` handler, so the per-path
	 * stamp is proven to be written by the same code path that stores
	 * `pushDiagnostics` — not by a helper the production push path might skip.
	 * `typos` is used because its strategy seeds the first push (no debounce
	 * timer), which keeps the store synchronous. */
	function publishHandlerFor(state: LSPClientState) {
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onNotification).mock
			.calls as unknown as Array<[string, (params: unknown) => void]>;
		const entry = calls.find((c) => c[0] === "textDocument/publishDiagnostics");
		expect(entry, "publishDiagnostics handler registered").toBeDefined();
		return entry![1];
	}

	function diagnostic(message: string): LSPDiagnostic {
		return {
			severity: 1,
			message,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
		};
	}

	it("stamps only the published path, never a sibling", () => {
		const state = createMockState({ serverId: "typos" });
		const publish = publishHandlerFor(state);

		expect(diagnosticsVersionForPath(state, KEY_A)).toBe(0);
		expect(diagnosticsVersionForPath(state, KEY_B)).toBe(0);

		publish({
			uri: pathToFileURL(FILE_A).href,
			diagnostics: [diagnostic("typo in A")],
		});

		// The client-global counter advanced — which is exactly why it cannot
		// answer "did this server report on B?".
		expect(state.diagnosticsVersion).toBe(1);
		expect(state.pushDiagnostics.has(KEY_A)).toBe(true);
		expect(diagnosticsVersionForPath(state, KEY_A)).toBe(1);
		// The regression this pins: B never got a publication, so its per-path
		// version must stay at its baseline. Reading the global counter here
		// (pre-#1531 behavior) reports 1 > 0 and manufactures evidence.
		expect(state.pushDiagnostics.has(KEY_B)).toBe(false);
		expect(diagnosticsVersionForPath(state, KEY_B)).toBe(0);
	});

	it("keeps stamps globally monotonic so a cleared path cannot look answered", () => {
		const state = createMockState({ serverId: "typos" });
		const publish = publishHandlerFor(state);

		publish({
			uri: pathToFileURL(FILE_A).href,
			diagnostics: [diagnostic("typo in A")],
		});
		const baselineA = diagnosticsVersionForPath(state, KEY_A);

		// A resync drops A's stamp along with the diagnostics it described.
		clearDiagnosticsForPath(state, KEY_A);
		expect(diagnosticsVersionForPath(state, KEY_A)).toBe(0);

		// A publication for B while A's touch is in flight must not lift A back
		// above its captured baseline.
		publish({
			uri: pathToFileURL(FILE_B).href,
			diagnostics: [diagnostic("typo in B")],
		});
		expect(diagnosticsVersionForPath(state, KEY_A)).toBeLessThanOrEqual(
			baselineA,
		);

		// A's own next publication does clear the baseline — the stamps carry the
		// global counter's value, so they never restart below an earlier one.
		publish({
			uri: pathToFileURL(FILE_A).href,
			diagnostics: [diagnostic("typo in A again")],
		});
		expect(diagnosticsVersionForPath(state, KEY_A)).toBeGreaterThan(baselineA);
	});
});

// #2479 review round 2. The frames of `runServerCommand` are NOT guaranteed
// to be nested: `LSPClient.executeCommand` (clients/lsp/index.ts) and
// `LSPService.executeCommand` fan out with no mutex, parallel
// `lsp_navigation` calls with `apply: true` overlap freely, and #449
// light-mode shares one client across agents. So three frames can OVERLAP and
// settle out of order, and a per-frame save/restore stack then re-installs the
// context of a call that has already SETTLED. `LspMutationContext` carries a
// `cwd` plus a directly-threaded `runtime`/`cacheManager`, and
// `readTurnState`/`appendProjectChange` are cwd-scoped, so a wrong owner does
// not merely mislabel a receipt — it can route a live edit's bookkeeping into
// ANOTHER project's change log. The remedy is neither a stack nor a
// liveness flag but a DERIVED slot: the context of the frame that took the
// depth to 1, exposed only while that frame is the sole one in flight, and
// recomputed on every entry and unwind (round 3).
describe("runServerCommand mutation-context ownership across overlapping frames (#2479 rounds 2/3)", () => {
	const OVERLAP_CONTEXT_BASE = {
		tool: "lsp_navigation:executeCommand",
		source: "lsp-execute-command" as const,
	};

	function gateExecuteCommands(
		state: LSPClientState,
		gates: Record<string, { promise: Promise<unknown> }>,
	): void {
		vi.mocked(state.connection.sendRequest).mockImplementation(((
			method: string,
			params: { command?: string },
		) => {
			if (method === "workspace/executeCommand") {
				const gate = gates[params?.command ?? ""];
				if (gate) return gate.promise;
			}
			return Promise.resolve({ ok: true });
		}) as never);
	}

	// F1. Three OVERLAPPING frames A, B, C. A settles first (3 → 2), then B
	// (2 → 1). Only C is still in flight, but a naive save/restore stack has B
	// putting back the context it saved on entry — A's — even though A has
	// already returned. The window is still open (`serverEditsAllowed === 1`,
	// C's), and the `workspace/applyEdit` handler reads the bare slot, so every
	// edit C solicits from that point on would be bookkept through A's
	// runtime/cacheManager/correlationId/source and into A's cwd. Before #2479
	// this read `undefined` — an honest fallback; a wrong owner is strictly
	// worse, which is why this is a regression bar and not merely a gap.
	it("does not re-install a settled frame's context when an overlapping middle frame unwinds (#2479 F1)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2479-owner-"));
		const filePath = path.join(root, "app.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		try {
			const state = createMockState({
				root,
				advertisedCommands: new Set(["cmd.a", "cmd.b", "cmd.c"]),
				// Mirror the real initial values of `createLSPClientState`.
				activeMutationDepth: 0,
				activeMutationContext: undefined,
			});
			const gateA = gatedPromise<unknown>();
			const gateB = gatedPromise<unknown>();
			const gateC = gatedPromise<unknown>();
			gateExecuteCommands(state, {
				"cmd.a": gateA,
				"cmd.b": gateB,
				"cmd.c": gateC,
			});

			// A carries a `readGuard` so "which context did the applyEdit
			// handler actually bookkeep through" is directly observable, not
			// inferred from the slot alone.
			const writtenThroughA: string[] = [];
			const contextA: LspMutationContext = {
				...OVERLAP_CONTEXT_BASE,
				cwd: path.join(root, "project-a"),
				correlationId: "overlap-a",
				readGuard: { recordWritten: (file) => writtenThroughA.push(file) },
			};
			const contextB: LspMutationContext = {
				...OVERLAP_CONTEXT_BASE,
				cwd: path.join(root, "project-b"),
				correlationId: "overlap-b",
			};
			const contextC: LspMutationContext = {
				...OVERLAP_CONTEXT_BASE,
				cwd: path.join(root, "project-c"),
				correlationId: "overlap-c",
			};

			// The depth bump and the slot write are synchronous — they run
			// before the first `await` inside `runServerCommand` — so each
			// frame is established the moment its promise is created.
			const promiseA = runServerCommand(state, "cmd.a", [], 5000, contextA);
			expect(state.activeMutationDepth).toBe(1);
			expect(state.activeMutationContext).toBe(contextA);
			const promiseB = runServerCommand(state, "cmd.b", [], 5000, contextB);
			const promiseC = runServerCommand(state, "cmd.c", [], 5000, contextC);
			expect(state.activeMutationDepth).toBe(3);
			expect(state.serverEditsAllowed).toBe(3);
			// Deeper frames deliberately do not cross-correlate.
			expect(state.activeMutationContext).toBeUndefined();

			// A settles FIRST (3 → 2). Its own window is closed from here on.
			gateA.resolve({ ok: true });
			await promiseA;
			expect(state.activeMutationDepth).toBe(2);
			expect(state.activeMutationContext).toBeUndefined();

			// B settles (2 → 1). Only C is in flight now, so the slot must not
			// name A, whose call has already returned.
			gateB.resolve({ ok: true });
			await promiseB;
			expect(state.activeMutationDepth).toBe(1);
			expect(state.serverEditsAllowed).toBe(1);
			expect(state.activeMutationContext).toBeUndefined();

			// And an edit C solicits inside its still-open window must take the
			// honest fallback receipt of the handler, never the identity or the
			// cwd of A.
			setupIncomingHandlers(state, {});
			const applyEditHandler = (
				vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
					[string, (...args: unknown[]) => unknown]
				>
			).find((call) => call[0] === "workspace/applyEdit")?.[1];
			expect(applyEditHandler).toBeDefined();
			await expect(
				applyEditHandler!({
					edit: {
						changes: {
							[pathToFileURL(filePath).href]: [
								{
									range: {
										start: { line: 0, character: 6 },
										end: { line: 0, character: 9 },
									},
									newText: "new",
								},
							],
						},
					},
				}),
			).resolves.toMatchObject({ applied: true });
			expect(fs.readFileSync(filePath, "utf8")).toBe("const new = 1;\n");
			// Nothing was bookkept through the already-returned A.
			expect(writtenThroughA).toEqual([]);
			expect(contextA.summaryEmitted).toBeUndefined();
			expect(contextA.summaryCount).toBeUndefined();

			gateC.resolve({ ok: true });
			await promiseC;
			expect(state.activeMutationDepth).toBe(0);
			expect(state.serverEditsAllowed).toBe(0);
			expect(state.activeMutationContext).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// F2. The minimal two-frame out-of-order settle, pinning the half the PR
	// body previously claimed was already covered by the #1412 H2 case and the
	// #2450 nested-fallback case. It is not: in every one of those, the frame
	// that unwinds to 0 had saved `undefined`, so an UNCONDITIONAL restore with
	// no owner check leaves them all green. Here A (the owner) settles first
	// and B — which saved the context of A on entry — unwinds to 0 last: the
	// slot must be empty, so no `runtime`/`cacheManager` belonging to a call
	// that has already returned stays reachable from client state once no
	// command is in flight.
	it("leaves no context behind when the owner settles before an overlapping frame unwinds to 0 (#2479 F2)", async () => {
		const state = createMockState({
			advertisedCommands: new Set(["cmd.a", "cmd.b"]),
			activeMutationDepth: 0,
			activeMutationContext: undefined,
		});
		const gateA = gatedPromise<unknown>();
		const gateB = gatedPromise<unknown>();
		gateExecuteCommands(state, { "cmd.a": gateA, "cmd.b": gateB });

		const contextA: LspMutationContext = {
			...OVERLAP_CONTEXT_BASE,
			cwd: path.join(os.tmpdir(), "pi-lens-2479-unwind-a"),
			correlationId: "unwind-a",
		};
		const contextB: LspMutationContext = {
			...OVERLAP_CONTEXT_BASE,
			cwd: path.join(os.tmpdir(), "pi-lens-2479-unwind-b"),
			correlationId: "unwind-b",
		};

		const promiseA = runServerCommand(state, "cmd.a", [], 5000, contextA);
		const promiseB = runServerCommand(state, "cmd.b", [], 5000, contextB);
		expect(state.activeMutationDepth).toBe(2);
		expect(state.activeMutationContext).toBeUndefined();

		gateA.resolve({ ok: true });
		await promiseA;
		expect(state.activeMutationDepth).toBe(1);

		gateB.resolve({ ok: true });
		await promiseB;
		// No command in flight == no context, exactly — the invariant the
		// `serverEditsAllowed` gate is paired with.
		expect(state.activeMutationDepth).toBe(0);
		expect(state.serverEditsAllowed).toBe(0);
		expect(state.activeMutationContext).toBeUndefined();
	});

	// #2479 review round 3 (P1). The round-2 owner-live flag proves that an
	// owner is LIVE — not that the slot's context belongs to the frame whose
	// window an incoming edit is arriving in. Those are different claims the
	// moment the MIDDLE frame settles first, with the owner still running:
	//
	//   A (owner, 0→1) → B (1→2) → C (2→3) → B settles (3→2) → C settles (2→1)
	//
	// A per-frame save/restore hands B's saved predecessor — A's context —
	// back while A is live but only C's window is the innermost one open, so
	// every edit C solicits is bookkept through A's readGuard/runtime/
	// cacheManager/cwd and consumes A's one-shot `summaryEmitted` latch (a
	// NEW mis-attribution: pre-#2479 that read `undefined`). C's own unwind
	// then puts back the `undefined` IT saved while A, the owner, is STILL in
	// flight — so A's remaining applyEdits take the fallback receipt and
	// #2479 itself is resurrected. The slot is not a stack and not a
	// liveness flag: it is DERIVED from the current frame set — the owner's
	// context while exactly one frame is in flight, nothing otherwise. One
	// case per half.
	function stageMiddleSettlesFirst(
		state: LSPClientState,
		contexts: {
			a: LspMutationContext;
			b: LspMutationContext;
			c: LspMutationContext;
		},
	) {
		const gateA = gatedPromise<unknown>();
		const gateB = gatedPromise<unknown>();
		const gateC = gatedPromise<unknown>();
		gateExecuteCommands(state, {
			"cmd.a": gateA,
			"cmd.b": gateB,
			"cmd.c": gateC,
		});
		// Every frame is established synchronously: the depth bump and the
		// slot write both run before the first `await` in `runServerCommand`.
		const promiseA = runServerCommand(state, "cmd.a", [], 5000, contexts.a);
		const promiseB = runServerCommand(state, "cmd.b", [], 5000, contexts.b);
		const promiseC = runServerCommand(state, "cmd.c", [], 5000, contexts.c);
		return { gateA, gateB, gateC, promiseA, promiseB, promiseC };
	}

	// The REAL `workspace/applyEdit` handler, driven against a real on-disk
	// file exactly as a server soliciting an edit inside an open window does.
	function applyEditSolicitorFor(
		state: LSPClientState,
	): (filePath: string, newText: string) => Promise<{ applied: boolean }> {
		setupIncomingHandlers(state, {});
		const applyEditHandler = (
			vi.mocked(state.connection.onRequest).mock.calls as unknown as Array<
				[string, (...args: unknown[]) => unknown]
			>
		).find((call) => call[0] === "workspace/applyEdit")?.[1];
		expect(applyEditHandler).toBeDefined();
		return (filePath, newText) =>
			applyEditHandler!({
				edit: {
					changes: {
						[pathToFileURL(filePath).href]: [
							{
								range: {
									start: { line: 0, character: 6 },
									end: { line: 0, character: 9 },
								},
								newText,
							},
						],
					},
				},
			}) as Promise<{ applied: boolean }>;
	}

	function overlapContext(
		root: string,
		name: string,
		readGuard?: LspMutationContext["readGuard"],
	): LspMutationContext {
		return {
			...OVERLAP_CONTEXT_BASE,
			cwd: path.join(root, `project-${name}`),
			correlationId: `middle-first-${name}`,
			...(readGuard ? { readGuard } : {}),
		};
	}

	it("does not lend the owner's context to a deeper frame's window when the middle frame settles first (#2479 P1a)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2479-p1a-"));
		const filePath = path.join(root, "app.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		try {
			const state = createMockState({
				root,
				advertisedCommands: new Set(["cmd.a", "cmd.b", "cmd.c"]),
				// Mirror the real initial values of `createLSPClientState`.
				activeMutationDepth: 0,
				activeMutationContext: undefined,
			});
			// A carries the `readGuard`, so "which context did the handler
			// actually bookkeep through" is observed at the receipt, not
			// inferred from the slot.
			const writtenThroughA: string[] = [];
			const contextA = overlapContext(root, "a", {
				recordWritten: (file) => writtenThroughA.push(file),
			});
			const frames = stageMiddleSettlesFirst(state, {
				a: contextA,
				b: overlapContext(root, "b"),
				c: overlapContext(root, "c"),
			});
			expect(state.activeMutationDepth).toBe(3);
			expect(state.activeMutationContext).toBeUndefined();

			// B — the MIDDLE frame — settles first (3 → 2). A (the owner) and C
			// are BOTH still in flight, so no single frame owns the window and
			// the slot must name none of them.
			frames.gateB.resolve({ ok: true });
			await frames.promiseB;
			expect(state.activeMutationDepth).toBe(2);
			expect(state.serverEditsAllowed).toBe(2);

			// An edit solicited now belongs to C's window, not A's. It must
			// take the handler's honest fallback receipt: nothing stamped
			// through A's read guard, and A's one-shot summary latch not
			// consumed by another frame's edit.
			const solicit = applyEditSolicitorFor(state);
			await expect(solicit(filePath, "mid")).resolves.toMatchObject({
				applied: true,
			});
			expect(fs.readFileSync(filePath, "utf8")).toBe("const mid = 1;\n");
			expect(writtenThroughA).toEqual([]);
			expect(contextA.summaryEmitted).toBeUndefined();
			expect(contextA.summaryCount).toBeUndefined();
			expect(state.activeMutationContext).toBeUndefined();

			frames.gateC.resolve({ ok: true });
			await frames.promiseC;
			frames.gateA.resolve({ ok: true });
			await frames.promiseA;
			expect(state.activeMutationDepth).toBe(0);
			expect(state.serverEditsAllowed).toBe(0);
			expect(state.activeMutationContext).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("gives the slot back to the still-live owner once the deeper frames unwind (#2479 P1b)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2479-p1b-"));
		const filePath = path.join(root, "app.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf8");
		try {
			const state = createMockState({
				root,
				advertisedCommands: new Set(["cmd.a", "cmd.b", "cmd.c"]),
				activeMutationDepth: 0,
				activeMutationContext: undefined,
			});
			const writtenThroughA: string[] = [];
			const contextA = overlapContext(root, "a", {
				recordWritten: (file) => writtenThroughA.push(file),
			});
			const frames = stageMiddleSettlesFirst(state, {
				a: contextA,
				b: overlapContext(root, "b"),
				c: overlapContext(root, "c"),
			});

			// B settles (3 → 2), then C (2 → 1). A — the owner — never stopped
			// running, and it is the only frame left, so its window is whole
			// again: this is exactly the #2479 report (a deeper frame
			// unwinding must not cost the outer call its own context for the
			// rest of its life).
			frames.gateB.resolve({ ok: true });
			await frames.promiseB;
			frames.gateC.resolve({ ok: true });
			await frames.promiseC;
			expect(state.activeMutationDepth).toBe(1);
			expect(state.serverEditsAllowed).toBe(1);

			const solicit = applyEditSolicitorFor(state);
			await expect(solicit(filePath, "own")).resolves.toMatchObject({
				applied: true,
			});
			expect(writtenThroughA).toEqual([path.resolve(filePath)]);
			expect(contextA.summaryEmitted).toBe(true);
			expect(state.activeMutationContext).toBe(contextA);

			frames.gateA.resolve({ ok: true });
			await frames.promiseA;
			expect(state.activeMutationDepth).toBe(0);
			expect(state.serverEditsAllowed).toBe(0);
			expect(state.activeMutationContext).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
