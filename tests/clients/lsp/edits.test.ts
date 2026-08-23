import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyTextEditsToString,
	applyWorkspaceEdit,
	__planWorkspaceEditForTest,
	isSameFsIdentity,
	mergeWorkspaceTextEditsByPriority,
} from "../../../clients/lsp/edits.js";
import { measureMaxSyncBlockMs } from "../../support/perf-harness.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { removeTempDirSync } from "../test-utils.js";
import {
	recordLspMutation,
	type LspMutationContext,
} from "../../../clients/lsp-mutation.js";

function isCaseInsensitiveFs(dir: string): boolean {
	const probe = path.join(dir, "CaseProbe.tmp");
	fs.writeFileSync(probe, "x", "utf-8");
	try {
		return fs.existsSync(path.join(dir, "caseprobe.tmp"));
	} finally {
		fs.rmSync(probe, { force: true });
	}
}

describe("LSP workspace edits", () => {
	it("preserves original array order for inserts at the same position", () => {
		expect(
			applyTextEditsToString("ab", [
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 1 },
					},
					newText: "first",
				},
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 1 },
					},
					newText: "second",
				},
			]),
		).toBe("afirstsecondb");
	});

	it("throws a descriptive error for overlapping text edits", () => {
		expect(() =>
			applyTextEditsToString("abcdef", [
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 4 },
					},
					newText: "X",
				},
				{
					range: {
						start: { line: 0, character: 3 },
						end: { line: 0, character: 5 },
					},
					newText: "Y",
				},
			]),
		).toThrow(/overlapping LSP edits: 1:2-1:5 conflicts with 1:4-1:6/);
	});

	it("merges workspace edits by priority and drops lower-priority overlaps", () => {
		const uri = "file:///tmp/app.ts";
		const result = mergeWorkspaceTextEditsByPriority([
			{
				serverId: "typescript",
				edit: {
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 1 },
									end: { line: 0, character: 4 },
								},
								newText: "primary",
							},
						],
					},
				},
			},
			{
				serverId: "eslint",
				edit: {
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 2 },
									end: { line: 0, character: 5 },
								},
								newText: "secondary",
							},
						],
					},
				},
			},
		]);

		expect(result.droppedConflicts).toBe(1);
		expect(result.edit.changes[uri]).toEqual([
			{
				range: {
					start: { line: 0, character: 1 },
					end: { line: 0, character: 4 },
				},
				newText: "primary",
			},
		]);
	});

	it("merges divergent URI spellings into one conflict bucket", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-uri-bucket-"),
		);
		try {
			const filePath = path.join(tmpDir, "shared.ts");
			fs.writeFileSync(filePath, "abcdef", "utf-8");
			const uri = pathToFileURL(filePath).href;
			const divergentUri = uri.replace(
				/\/([^/]+)$/,
				(_, name: string) =>
					`/%${name.charCodeAt(0).toString(16).padStart(2, "0")}${name.slice(1)}`,
			);
			const edit = (newText: string) => ({
				range: {
					start: { line: 0, character: 1 },
					end: { line: 0, character: 4 },
				},
				newText,
			});
			const result = mergeWorkspaceTextEditsByPriority([
				{ serverId: "primary", edit: { changes: { [uri]: [edit("first")] } } },
				{
					serverId: "secondary",
					edit: { changes: { [divergentUri]: [edit("second")] } },
				},
			]);
			expect(divergentUri).not.toBe(uri);
			expect(result.droppedConflicts).toBe(1);
			expect(result.edit.changes).toEqual({ [uri]: [edit("first")] });
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("collapses byte-identical non-empty duplicate edits", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "duplicate.ts");
		fs.writeFileSync(filePath, "abc", "utf-8");
		const duplicate = {
			range: {
				start: { line: 0, character: 1 },
				end: { line: 0, character: 2 },
			},
			newText: "X",
		};

		try {
			const result = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(filePath).href]: [duplicate, duplicate],
					},
				},
				tmpDir,
				{
					mutationContext: {
						cwd: tmpDir,
						correlationId: "duplicate-edit-1",
						tool: "workspace/applyEdit",
						source: "lsp-edit",
						emitSummary: false,
					},
				},
			);

			expect(fs.readFileSync(filePath, "utf-8")).toBe("aXc");
			expect(result.operationTotal).toBe(1);
			expect(result.appliedOperationTotal).toBe(1);
			expect(result.appliedOperationIndexes).toEqual([0]);
			expect(result.operationCounts.textEdits).toBe(1);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to duplicate.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("validates every text batch before the first filesystem write", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const firstPath = path.join(tmpDir, "first.ts");
		const secondPath = path.join(tmpDir, "second.ts");
		fs.writeFileSync(firstPath, "first", "utf-8");
		fs.writeFileSync(secondPath, "second", "utf-8");

		try {
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[pathToFileURL(firstPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 5 },
									},
									newText: "changed",
								},
							],
							[pathToFileURL(secondPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 4 },
									},
									newText: "A",
								},
								{
									range: {
										start: { line: 0, character: 2 },
										end: { line: 0, character: 6 },
									},
									newText: "B",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/overlapping LSP edits/);
			expect(fs.readFileSync(firstPath, "utf-8")).toBe("first");
			expect(fs.readFileSync(secondPath, "utf-8")).toBe("second");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("records bounded mixed text/resource operations and mutation bookkeeping", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-observe-"),
		);
		const filePath = path.join(tmpDir, "a.ts");
		const createdPath = path.join(tmpDir, "created.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf-8");
		const written: string[] = [];
		const realRuntime = new RuntimeCoordinator();
		realRuntime.projectRoot = tmpDir;
		const ranges: Array<{ filePath: string; start: number; end: number }> = [];
		const context: LspMutationContext = {
			cwd: tmpDir,
			correlationId: "mixed-edit-1",
			tool: "lsp_navigation",
			source: "lsp-edit",
			readGuard: { recordWritten: (file) => written.push(file) },
			// REAL coordinator (#1742 direction): assert the mutation actually
			// landed in the one seam's store, not in a test-local spy.
			runtime: realRuntime,
			cacheManager: {
				addModifiedRange: (file, range) =>
					ranges.push({ filePath: file, ...range }),
			},
		};
		try {
			const result = await applyWorkspaceEdit(
				{
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
					documentChanges: [
						{ kind: "create", uri: pathToFileURL(createdPath).href },
					],
				},
				tmpDir,
				{ mutationContext: context },
			);
			expect(result.operationTotal).toBe(2);
			expect(result.appliedOperationTotal).toBe(2);
			expect(result.appliedOperationIndexes).toEqual([0, 1]);
			expect(written).toEqual([createdPath, filePath]);
			const receipts = realRuntime.getMutationsSince(0);
			expect(receipts.map((r) => r.filePath)).toEqual(
				[createdPath, filePath].map((p) => normalizeMapKey(p)),
			);
			expect(receipts.every((r) => r.source === "lsp-edit")).toBe(true);
			expect(realRuntime.getFilesChangedSince(0)).toEqual(
				[createdPath, filePath].map((p) => normalizeMapKey(p)),
			);
			expect(ranges).toHaveLength(2);
			expect(context.summaryEmitted).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("records a failed terminal state without mutating on preflight rejection", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-partial-"),
		);
		const filePath = path.join(tmpDir, "a.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf-8");
		const context: LspMutationContext = {
			cwd: tmpDir,
			correlationId: "partial-edit-1",
			tool: "workspace/applyEdit",
			source: "lsp-edit",
		};
		try {
			await expect(
				applyWorkspaceEdit(
					{
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
						documentChanges: [
							{
								kind: "rename",
								oldUri: pathToFileURL(path.join(tmpDir, "missing.ts")).href,
								newUri: pathToFileURL(path.join(tmpDir, "new.ts")).href,
							},
						],
					},
					tmpDir,
					{ mutationContext: context },
				),
			).rejects.toThrow(/rename source does not exist/);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("const old = 1;\n");
			expect(context.summaryEmitted).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("bounds operation indexes and sampled paths while preserving totals", () => {
		const files = Array.from({ length: 120 }, (_, index) => `file-${index}.ts`);
		const context: LspMutationContext = {
			cwd: ".",
			correlationId: "bounded-edit-1",
			tool: "workspace/applyEdit",
			source: "lsp-edit",
			emitSummary: false,
		};
		const telemetry = recordLspMutation(context, {
			bookkeep: false,
			results: [
				{
					descriptions: [],
					files,
					operationTotal: 120,
					appliedOperationTotal: 120,
					appliedOperationIndexes: Array.from(
						{ length: 120 },
						(_, index) => index,
					),
					operationCounts: { textEdits: 100, create: 10, rename: 5, delete: 5 },
					fileDetails: files.map((filePath) => ({ filePath })),
				},
			],
		});
		expect(telemetry.operationCounts).toEqual({
			requested: 120,
			applied: 120,
			textEdits: 100,
			create: 10,
			rename: 5,
			delete: 5,
		});
		expect(telemetry.sampledPaths).toHaveLength(100);
		expect(telemetry.sampledPathsTotal).toBe(120);
		expect(telemetry.sampledPathsTruncated).toBe(true);
		expect(telemetry.editBatchSummary.appliedIndexes).toHaveLength(100);
		expect(telemetry.editBatchSummary.appliedTotal).toBe(120);
		expect(telemetry.editBatchSummary.indexesTruncated).toBe(true);
	});

	it("limits solicited mutation summaries to 100 and reports overflow", () => {
		const context: LspMutationContext = {
			cwd: ".",
			correlationId: "summary-cap-1",
			tool: "workspace/applyEdit",
			source: "lsp-edit",
		};
		for (let index = 0; index < 100; index++) {
			recordLspMutation(context, { bookkeep: false });
		}
		expect(context.summaryCount).toBe(100);
		expect(context.summaryOverflowed).toBeUndefined();

		// The 101st solicited request is bounded but not silently represented as
		// another per-request summary: one aggregate overflow marker is emitted.
		recordLspMutation(context, { bookkeep: false });
		expect(context.summaryCount).toBe(100);
		expect(context.summaryOverflowed).toBe(true);
	});

	it("applies text edits before resource renames", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const oldName = 1;\n", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(oldPath).href]: [
							{
								range: {
									start: { line: 0, character: 13 },
									end: { line: 0, character: 20 },
								},
								newText: "newName",
							},
						],
					},
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldPath).href,
							newUri: pathToFileURL(newPath).href,
						},
					],
				},
				tmpDir,
			);

			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const newName = 1;\n",
			);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to old.ts",
				"Renamed old.ts → new.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves declared create-then-text ordering", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "created.ts");
		const uri = pathToFileURL(filePath).href;

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri },
						{
							textDocument: { uri },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "created",
								},
							],
						},
					],
				},
				tmpDir,
			);

			expect(fs.readFileSync(filePath, "utf-8")).toBe("created");
			expect(result.descriptions).toEqual([
				"Created created.ts",
				"Applied 1 edit(s) to created.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes child text edits before a parent directory rename", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const oldChild = path.join(oldDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(oldChild, "old", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(oldChild).href },
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
						{
							kind: "rename",
							oldUri: pathToFileURL(oldDir).href,
							newUri: pathToFileURL(newDir).href,
						},
					],
				},
				tmpDir,
			);

			expect(fs.readFileSync(path.join(newDir, "child.ts"), "utf-8")).toBe(
				"new",
			);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to old/child.ts",
				"Renamed old → new",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("lazily maps text edits under a renamed directory", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const oldChild = path.join(oldDir, "child.ts");
		const newChild = path.join(newDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(oldChild, "old", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldDir).href,
							newUri: pathToFileURL(newDir).href,
						},
						{
							textDocument: { uri: pathToFileURL(newChild).href },
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
				},
				tmpDir,
			);

			expect(fs.readFileSync(newChild, "utf-8")).toBe("new");
			expect(result.descriptions).toEqual([
				"Renamed old → new",
				"Applied 1 edit(s) to new/child.ts",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("rejects edits under a recursively deleted renamed directory", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const childPath = path.join(newDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.writeFileSync(path.join(oldDir, "child.ts"), "old", "utf-8");

		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "rename",
								oldUri: pathToFileURL(oldDir).href,
								newUri: pathToFileURL(newDir).href,
							},
							{
								kind: "delete",
								uri: pathToFileURL(newDir).href,
								options: { recursive: true },
							},
							{
								textDocument: { uri: pathToFileURL(childPath).href },
								edits: [
									{
										range: {
											start: { line: 0, character: 0 },
											end: { line: 0, character: 3 },
										},
										newText: "changed",
									},
								],
							},
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/text edit target is not a file/);
			expect(fs.existsSync(oldDir)).toBe(true);
			expect(fs.existsSync(newDir)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves nested rename chains when deleting the remaining parent subtree", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const movedDir = path.join(tmpDir, "moved");
		const childPath = path.join(movedDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.mkdirSync(path.join(oldDir, "sub"));
		fs.writeFileSync(path.join(oldDir, "sub", "child.ts"), "old", "utf-8");

		try {
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(oldDir).href,
							newUri: pathToFileURL(newDir).href,
						},
						{
							kind: "rename",
							oldUri: pathToFileURL(path.join(newDir, "sub")).href,
							newUri: pathToFileURL(movedDir).href,
						},
						{
							kind: "delete",
							uri: pathToFileURL(newDir).href,
							options: { recursive: true },
						},
						{
							textDocument: { uri: pathToFileURL(childPath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 3 },
									},
									newText: "changed",
								},
							],
						},
					],
				},
				tmpDir,
			);

			expect(fs.readFileSync(childPath, "utf-8")).toBe("changed");
			expect(fs.existsSync(newDir)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes destination-subtree edits before a directory rename", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const oldDir = path.join(tmpDir, "old");
		const newDir = path.join(tmpDir, "new");
		const destinationChild = path.join(newDir, "child.ts");
		fs.mkdirSync(oldDir);
		fs.mkdirSync(newDir);
		fs.writeFileSync(path.join(oldDir, "source.ts"), "source", "utf-8");
		fs.writeFileSync(destinationChild, "old", "utf-8");

		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								textDocument: {
									uri: pathToFileURL(destinationChild).href,
								},
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
							{
								kind: "rename",
								oldUri: pathToFileURL(oldDir).href,
								newUri: pathToFileURL(newDir).href,
							},
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/rename destination already exists/);
			expect(fs.readFileSync(destinationChild, "utf-8")).toBe("old");
			expect(fs.existsSync(path.join(oldDir, "source.ts"))).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("flushes child edits before recursively deleting their directory", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const doomedDir = path.join(tmpDir, "doomed");
		const childPath = path.join(doomedDir, "nested", "child.ts");
		fs.mkdirSync(path.dirname(childPath), { recursive: true });
		fs.writeFileSync(childPath, "old", "utf-8");

		try {
			const result = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(childPath).href },
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
						{
							kind: "delete",
							uri: pathToFileURL(doomedDir).href,
							options: { recursive: true },
						},
					],
				},
				tmpDir,
			);

			expect(fs.existsSync(doomedDir)).toBe(false);
			expect(result.descriptions).toEqual([
				"Applied 1 edit(s) to doomed/nested/child.ts",
				"Deleted doomed",
			]);
			expect(result.files).toEqual([
				childPath.replace(/\\/g, "/"),
				doomedDir.replace(/\\/g, "/"),
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preflights a later missing text document before writing an earlier one", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const firstPath = path.join(tmpDir, "first.ts");
		const missingPath = path.join(tmpDir, "missing.ts");
		fs.writeFileSync(firstPath, "first", "utf-8");
		try {
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[pathToFileURL(firstPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 5 },
									},
									newText: "changed",
								},
							],
							[pathToFileURL(missingPath).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "missing",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/text edit target is not a file/);
			expect(fs.readFileSync(firstPath, "utf-8")).toBe("first");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it.each([
		["utf-8", 1, 5],
		["utf-16", 1, 3],
		["utf-32", 1, 2],
	] as const)(
		"applies astral positions in %s encoding",
		(encoding, start, end) => {
			expect(
				applyTextEditsToString(
					"a😀é",
					[
						{
							range: {
								start: { line: 0, character: start },
								end: { line: 0, character: end },
							},
							newText: "X",
						},
					],
					encoding,
				),
			).toBe("aXé");
		},
	);

	it("rejects malformed, out-of-bounds, and unsupported edits", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "file.ts");
		fs.writeFileSync(filePath, "abc", "utf-8");
		const uri = pathToFileURL(filePath).href;
		try {
			expect(() =>
				applyTextEditsToString("abc", [
					{
						range: {
							start: { line: 0.5, character: 0 },
							end: { line: 0, character: 0 },
						},
						newText: "x",
					},
				]),
			).toThrow(/overlapping|outside|range/);
			// Malformed shapes still throw: a negative character is not a spec-clampable
			// out-of-range position (which now clamps — see the clamp cases below).
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[uri]: [
								{
									range: {
										start: { line: 0, character: -1 },
										end: { line: 0, character: -1 },
									},
									newText: "x",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/malformed text edit/);
			await expect(
				applyWorkspaceEdit(
					{ documentChanges: [{ kind: "watch", uri }] },
					tmpDir,
				),
			).rejects.toThrow(/unsupported workspace resource operation/);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// P2: LSP 3.17 out-of-range clamping (line past EOF → end of document,
	// character past line end → line length). Regression reintroduced in 3.8.74.
	it("clamps out-of-range positions instead of throwing (LSP 3.17)", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-edits-clamp-"),
		);
		try {
			// Whole-document replace via the (0,0)-(9999,0) sentinel idiom.
			const wholeDoc = path.join(tmpDir, "whole.ts");
			fs.writeFileSync(wholeDoc, "line0\nline1", "utf-8");
			await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(wholeDoc).href]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 9999, character: 0 },
								},
								newText: "WHOLE",
							},
						],
					},
				},
				tmpDir,
			);
			expect(fs.readFileSync(wholeDoc, "utf-8")).toBe("WHOLE");

			// Character past the line end clamps to the line length (append).
			const charClamp = path.join(tmpDir, "char.ts");
			fs.writeFileSync(charClamp, "abc", "utf-8");
			await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(charClamp).href]: [
							{
								range: {
									start: { line: 0, character: 99 },
									end: { line: 0, character: 99 },
								},
								newText: "X",
							},
						],
					},
				},
				tmpDir,
			);
			expect(fs.readFileSync(charClamp, "utf-8")).toBe("abcX");

			// Direct string helper clamps the same way under every encoding.
			expect(
				applyTextEditsToString("abc", [
					{
						range: {
							start: { line: 5, character: 0 },
							end: { line: 9, character: 0 },
						},
						newText: "!",
					},
				]),
			).toBe("abc!");

			// CRLF: clamping a char past the line end must land BEFORE the trailing
			// `\r`, not between `\r` and `\n` (P2-1). lineTextAt keeps the `\r`, so a
			// naive clamp to line.length corrupts CRLF files.
			expect(
				applyTextEditsToString("abc\r\ndef", [
					{
						range: {
							start: { line: 0, character: 99 },
							end: { line: 0, character: 99 },
						},
						newText: "X",
					},
				]),
			).toBe("abcX\r\ndef");
			// The whole-line sentinel replace on a CRLF line must preserve the `\r\n`.
			expect(
				applyTextEditsToString("abc\r\ndef", [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 999 },
						},
						newText: "Y",
					},
				]),
			).toBe("Y\r\ndef");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// P3-1: an insert listed AFTER a replace that starts at the same position is
	// LSP-legal (VSCode applies it); result is independent of listing order.
	it("applies an insert at a replace boundary in either listing order", () => {
		const replace = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 2 },
			},
			newText: "X",
		};
		const insert = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
			},
			newText: "Y",
		};
		expect(applyTextEditsToString("abc", [replace, insert])).toBe("YXc");
		expect(applyTextEditsToString("abc", [insert, replace])).toBe("YXc");
	});

	it("rejects stale versioned text document edits before mutation", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "versioned.ts");
		fs.writeFileSync(filePath, "old", "utf-8");
		const versioned = (version: number, current: number) =>
			applyWorkspaceEdit(
				{
					documentChanges: [
						{
							textDocument: { uri: pathToFileURL(filePath).href, version },
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
				},
				tmpDir,
				// Preflight looks the version up via normalizeMapKey; the map MUST be
				// keyed the same way or the rejection passes vacuously (unknown key →
				// "current unknown") rather than on a genuine version mismatch (#1106).
				{ documentVersions: new Map([[normalizeMapKey(filePath), current]]) },
			);
		try {
			// Genuine mismatch (expected 2, live 1) → reject, no mutation.
			await expect(versioned(2, 1)).rejects.toThrow(
				/stale text document version/,
			);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("old");
			// Positive path: a matching version SUCCEEDS (the missing coverage — the
			// old test only asserted the rejection, and only vacuously at that).
			await versioned(1, 1);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("new");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("confines file URIs and rejects duplicate resources", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const outside = path.join(path.dirname(tmpDir), "outside.ts");
		const inside = path.join(tmpDir, "inside.ts");
		fs.writeFileSync(outside, "outside", "utf-8");
		try {
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[pathToFileURL(outside).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "x",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/escapes workspace/);
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "create",
								uri: pathToFileURL(inside).href,
								options: { ignoreIfExists: true },
							},
							{
								kind: "create",
								uri: pathToFileURL(inside).href,
								options: { ignoreIfExists: true },
							},
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/duplicate workspace resource/);
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							https: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "x",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/invalid workspace edit URI/);
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outside);
		}
	});

	it("rejects symlink escapes during workspace-edit preflight", async ({
		skip,
	}) => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-outside-"),
		);
		const outsideFile = path.join(outsideDir, "outside.ts");
		const linkDir = path.join(tmpDir, "linked");
		fs.writeFileSync(outsideFile, "outside", "utf-8");
		try {
			try {
				fs.symlinkSync(
					outsideDir,
					linkDir,
					process.platform === "win32" ? "junction" : "dir",
				);
			} catch (err) {
				skip(
					`symlink/junction setup unavailable: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[pathToFileURL(path.join(linkDir, "outside.ts")).href]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 7 },
									},
									newText: "changed",
								},
							],
						},
					},
					tmpDir,
				),
			).rejects.toThrow(/escapes workspace/);
			expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outsideDir);
		}
	});

	it("coalesces URI spellings after path canonicalization", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-edits-key-"),
		);
		const filePath = path.join(tmpDir, "file.ts");
		fs.writeFileSync(filePath, "old", "utf-8");
		const uri = pathToFileURL(filePath).href;
		const encodedUri = uri.replace("file.ts", "%66ile.ts");
		try {
			expect(
				__planWorkspaceEditForTest({
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 3 },
								},
								newText: "first",
							},
						],
						[encodedUri]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 3 },
								},
								newText: "second",
							},
						],
					},
				}),
			).toBe(1);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// Two budgets, because they catch different regressions and neither subsumes
	// the other (#1081):
	//   - CPU time (user+system) is the signal for a compute/syscall blowup in the
	//     planner. Unlike the sampler gap it does not count time the OS spent
	//     running someone else, so a merely descheduled worker cannot inflate it —
	//     that inflation is what produced the 358-435ms "block" readings in #1081.
	//   - measureMaxSyncBlockMs (tests/support/perf-harness.ts) is the signal for
	//     "blocks the TUI". A synchronous stretch that does NOT burn CPU — an
	//     execSync, a cold or networked readFileSync/realpathSync per path — is
	//     invisible to cpuUsage but shows up as a sampler gap. That shape is live,
	//     not hypothetical: #1091 removed a *second* per-path canonicalization
	//     from pathIndexKey (clients/lsp/edits.ts).
	// Neither number is contention-proof, so vitest.config.ts keeps this file in
	// the phased `timing-sensitive` project. CPU time is NOT immune on Windows:
	// planning this payload is ~400 realpathSync.native calls (normalizeFilePath
	// in clients/path-utils.ts), and that syscall cost is SYSTEM time charged to
	// this process, which does inflate under load. Measured on Windows, same
	// payload: 15-47ms CPU / 37-46ms sampler gap in the quiet phased window, but
	// 47-110ms CPU / 235-259ms gap with 16 CPU+FS loaders running — i.e. phasing
	// is what makes either budget meaningful, and 100ms would already flake.
	// Scaling (Windows, standalone): ~47-78ms at 800 ops, ~0.5-1.2s at 8k,
	// ~1.6-2.0s at 40k — mostly system time — so an O(1k)-scale synchronous
	// regression still trips the 200ms CPU budget by a wide margin.
	it(
		"keeps large text/resource planning occupancy bounded",
		{ timeout: 30_000, retry: 2 },
		async () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-edits-plan-"),
			);
			const changes: Record<string, unknown[]> = {};
			const documentChanges: unknown[] = [];
			const count = 400;
			for (let index = 0; index < count; index++) {
				const filePath = path.join(tmpDir, `file-${index}.ts`);
				fs.writeFileSync(filePath, "old", "utf-8");
				const uri = pathToFileURL(filePath).href;
				changes[uri] = [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 3 },
						},
						newText: "new",
					},
				];
				documentChanges.push({
					kind: "create",
					uri,
					options: { ignoreIfExists: true },
				});
			}
			try {
				let planned = 0;
				let cpuMs = 0;
				const maxBlock = await measureMaxSyncBlockMs(async () => {
					const start = process.cpuUsage();
					planned = __planWorkspaceEditForTest({ changes, documentChanges });
					const { user, system } = process.cpuUsage(start);
					cpuMs = (user + system) / 1000;
				});
				expect(planned).toBe(count * 2);
				expect(cpuMs).toBeLessThan(200);
				expect(maxBlock).toBeLessThan(300);
				// Criterion-4 evidence: the 4-worker full-suite run passed these occupancy
				// assertions, so contention did not breach the 200ms CPU or 300ms sync-block budgets.
			} finally {
				removeTempDirSync(tmpDir);
			}
		},
	);

	it("honors resource operation options", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-edits-"));
		const filePath = path.join(tmpDir, "existing.ts");
		fs.writeFileSync(filePath, "old", "utf-8");
		try {
			const ignored = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "create",
							uri: pathToFileURL(filePath).href,
							options: { ignoreIfExists: true },
						},
					],
				},
				tmpDir,
			);
			expect(ignored.descriptions).toEqual([]);
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "create", uri: pathToFileURL(filePath).href },
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/already exists/);
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "create",
								uri: pathToFileURL(filePath).href,
								options: { recursive: true },
							},
						],
					},
					tmpDir,
				),
			).rejects.toThrow(/invalid create.options.recursive/);
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "create",
							uri: pathToFileURL(filePath).href,
							options: { overwrite: true },
						},
					],
				},
				tmpDir,
			);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});

// P1-1: same-position inserts must apply in ARRAY order through EVERY entry path
// under ALL THREE position encodings. The pipeline previously sorted an even
// number of times on the UTF-16 path (and differed by encoding), reversing
// same-position inserts ("aBAbc" instead of "aABbc").
describe("LSP workspace edits — same-position insert ordering (P1-1)", () => {
	const insertsAt = (line: number, character: number) => [
		{
			range: { start: { line, character }, end: { line, character } },
			newText: "A",
		},
		{
			range: { start: { line, character }, end: { line, character } },
			newText: "B",
		},
	];

	it("applyTextEditsToString applies same-position inserts in array order", () => {
		expect(applyTextEditsToString("abc", insertsAt(0, 1))).toBe("aABbc");
	});

	for (const encoding of ["utf-8", "utf-16", "utf-32"] as const) {
		for (const entry of ["changes", "documentChanges"] as const) {
			it(`applyWorkspaceEdit keeps array order via ${entry} under ${encoding}`, async () => {
				const tmpDir = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-lsp-order-"),
				);
				const filePath = path.join(tmpDir, "order.ts");
				fs.writeFileSync(filePath, "abc", "utf-8");
				const uri = pathToFileURL(filePath).href;
				const edit =
					entry === "changes"
						? { changes: { [uri]: insertsAt(0, 1) } }
						: {
								documentChanges: [
									{ textDocument: { uri }, edits: insertsAt(0, 1) },
								],
							};
				try {
					await applyWorkspaceEdit(edit, tmpDir, {
						positionEncoding: encoding,
					});
					expect(fs.readFileSync(filePath, "utf-8")).toBe("aABbc");
				} finally {
					removeTempDirSync(tmpDir);
				}
			});
		}
	}
});

// P1-2: Windows create/rename must preserve the URI's intended casing; a
// case-only rename is a legitimate refactor. FS-probe-guarded per the #1024
// lesson — assert casing preservation only where the filesystem is actually
// case-insensitive; on a case-sensitive FS the same operations must still
// succeed (never a vacuous pass).
describe("LSP workspace edits — path casing preservation (P1-2)", () => {
	it("create preserves mixed-case file names on disk", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-case-"));
		try {
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "create",
							uri: pathToFileURL(path.join(tmpDir, "NewFile.txt")).href,
						},
					],
				},
				tmpDir,
			);
			const entries = fs.readdirSync(tmpDir);
			// On BOTH FS kinds the name written must be the mixed-case one — the bug
			// lowercased it only on a case-insensitive (win32) FS, so a case-sensitive
			// run asserts the operation still produced exactly the requested name.
			expect(entries).toContain("NewFile.txt");
			expect(entries).not.toContain("newfile.txt");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("rename preserves the destination casing", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-case-"));
		try {
			const src = path.join(tmpDir, "lower.txt");
			fs.writeFileSync(src, "x", "utf-8");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(src).href,
							newUri: pathToFileURL(path.join(tmpDir, "MixedCase.txt")).href,
						},
					],
				},
				tmpDir,
			);
			const entries = fs.readdirSync(tmpDir);
			expect(entries).toContain("MixedCase.txt");
			expect(entries).not.toContain("mixedcase.txt");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// The FS-identity alias check must FAIL-CLOSED on ino-less filesystems
	// (FAT32/exFAT, some SMB redirectors, VirtualBox shared folders — libuv
	// reports ino 0 there). Without the nonzero guard, two DISTINCT files would
	// compare (dev, 0) === (dev, 0) and a rename would silently clobber.
	it("treats ino-0 (ino-less FS) entries as DISTINCT, never aliased", () => {
		// Both sides ino 0 on the same device → must NOT be considered the same entry.
		expect(isSameFsIdentity({ dev: 5n, ino: 0n }, { dev: 5n, ino: 0n })).toBe(
			false,
		);
		// One side ino 0 → distinct.
		expect(isSameFsIdentity({ dev: 5n, ino: 0n }, { dev: 5n, ino: 42n })).toBe(
			false,
		);
		// Genuine same-entry (nonzero, equal ino, same dev) → aliased.
		expect(isSameFsIdentity({ dev: 5n, ino: 42n }, { dev: 5n, ino: 42n })).toBe(
			true,
		);
		// Same nonzero ino but different device → distinct.
		expect(isSameFsIdentity({ dev: 5n, ino: 42n }, { dev: 6n, ino: 42n })).toBe(
			false,
		);
		// Large 64-bit NTFS file IDs (> 2^53) compare exactly as BigInt.
		expect(
			isSameFsIdentity(
				{ dev: 1n, ino: 9007199254740993n },
				{ dev: 1n, ino: 9007199254740993n },
			),
		).toBe(true);
		expect(
			isSameFsIdentity(
				{ dev: 1n, ino: 9007199254740993n },
				{ dev: 1n, ino: 9007199254740992n },
			),
		).toBe(false);
	});

	it("case-only rename succeeds (foo.txt → Foo.txt)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-case-"));
		try {
			const caseInsensitive = isCaseInsensitiveFs(tmpDir);
			const src = path.join(tmpDir, "foo.txt");
			fs.writeFileSync(src, "content", "utf-8");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(src).href,
							newUri: pathToFileURL(path.join(tmpDir, "Foo.txt")).href,
						},
					],
				},
				tmpDir,
			);
			const entries = fs.readdirSync(tmpDir);
			// Case-insensitive FS: the entry is renamed IN PLACE to Foo.txt (no throw).
			// Case-sensitive FS: Foo.txt is a distinct new file; foo.txt is gone.
			expect(entries).toContain("Foo.txt");
			if (caseInsensitive) {
				expect(entries.filter((e) => e.toLowerCase() === "foo.txt")).toEqual([
					"Foo.txt",
				]);
			} else {
				expect(entries).not.toContain("foo.txt");
			}
			expect(fs.readFileSync(path.join(tmpDir, "Foo.txt"), "utf-8")).toBe(
				"content",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});

// #1085 P3 bundle — deferrals from #1120's review rounds (P3-1, the two P1s,
// and the P2 clamp shipped in #1120; P3-5 CRLF-boundary and P3-7 plaintext-
// reopen remain separately deferred, see the PR body).
describe("LSP workspace edits — #1085 P3 bundle", () => {
	it("P3-2: keeps duplicate zero-width inserts from one server's own edit on the renameFile merge path", () => {
		const uri = "file:///tmp/rename-merge.ts";
		const zeroWidthInsert = {
			range: {
				start: { line: 0, character: 1 },
				end: { line: 0, character: 1 },
			},
			newText: "Q",
		};
		const result = mergeWorkspaceTextEditsByPriority([
			{
				serverId: "typescript",
				edit: { changes: { [uri]: [zeroWidthInsert, zeroWidthInsert] } },
			},
		]);
		// Both duplicates from the SAME server's own edit survive (their
		// multiplicity is meaningful — see the doc above `validateTextEdits`).
		expect(result.edit.changes[uri]).toHaveLength(2);
		expect(applyTextEditsToString("abc", result.edit.changes[uri])).toBe(
			"aQQbc",
		);

		// Cross-server exact duplicates are still collapsed to one (unchanged
		// invariant): two DIFFERENT servers proposing the identical non-empty
		// replace should not double-apply.
		const nonEmptyReplace = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 1 },
			},
			newText: "X",
		};
		const crossServer = mergeWorkspaceTextEditsByPriority([
			{
				serverId: "typescript",
				edit: { changes: { [uri]: [nonEmptyReplace] } },
			},
			{ serverId: "eslint", edit: { changes: { [uri]: [nonEmptyReplace] } } },
		]);
		expect(crossServer.edit.changes[uri]).toHaveLength(1);
	});

	it("P3-3: a create at a rename-vacated path establishes new state for a later text edit at that path", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-p3-3-"));
		try {
			const bPath = path.join(tmpDir, "b.txt");
			const cPath = path.join(tmpDir, "c.txt");
			fs.writeFileSync(bPath, "original", "utf-8");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(bPath).href,
							newUri: pathToFileURL(cPath).href,
						},
						{ kind: "create", uri: pathToFileURL(bPath).href },
						{
							textDocument: { uri: pathToFileURL(bPath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "new",
								},
							],
						},
					],
				},
				tmpDir,
			);
			// The rename carried the original content to c.txt...
			expect(fs.readFileSync(cPath, "utf-8")).toBe("original");
			// ...and the vacated b.txt path was re-established by `create`, then
			// received the text edit — not rejected as "text edit target does not
			// exist" (the pre-fix failure mode).
			expect(fs.readFileSync(bPath, "utf-8")).toBe("new");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("P3-4: version:null + a numeric version for the same URI adopts the numeric one (LSP: null means don't check)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-p3-4-"));
		try {
			const filePath = path.join(tmpDir, "versioned-null.ts");
			fs.writeFileSync(filePath, "x", "utf-8");
			const uri = pathToFileURL(filePath).href;
			const edit = {
				documentChanges: [
					{
						textDocument: { uri, version: null },
						edits: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "A",
							},
						],
					},
					{
						textDocument: { uri, version: 1 },
						edits: [
							{
								range: {
									start: { line: 0, character: 1 },
									end: { line: 0, character: 1 },
								},
								newText: "B",
							},
						],
					},
				],
			};
			// Matching numeric version → applies (does NOT throw "conflicting text
			// document versions", the pre-fix failure mode).
			await applyWorkspaceEdit(edit, tmpDir, {
				documentVersions: new Map([[normalizeMapKey(filePath), 1]]),
			});
			expect(fs.readFileSync(filePath, "utf-8")).toBe("AxB");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("P3-4: version:null + a STALE numeric version is still rejected, via the numeric", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-p3-4-stale-"),
		);
		try {
			const filePath = path.join(tmpDir, "versioned-null-stale.ts");
			fs.writeFileSync(filePath, "x", "utf-8");
			const uri = pathToFileURL(filePath).href;
			const edit = {
				documentChanges: [
					{
						textDocument: { uri, version: null },
						edits: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "A",
							},
						],
					},
					{
						textDocument: { uri, version: 1 },
						edits: [
							{
								range: {
									start: { line: 0, character: 1 },
									end: { line: 0, character: 1 },
								},
								newText: "B",
							},
						],
					},
				],
			};
			await expect(
				applyWorkspaceEdit(edit, tmpDir, {
					documentVersions: new Map([[normalizeMapKey(filePath), 2]]),
				}),
			).rejects.toThrow(/stale text document version/);
			expect(fs.readFileSync(filePath, "utf-8")).toBe("x");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("P3-6: importsChanged reflects whether the edit actually changed import lines, not merely their presence", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-p3-6-"));
		try {
			const filePath = path.join(tmpDir, "mod.ts");
			fs.writeFileSync(
				filePath,
				'import { a } from "./a";\nconsole.log(a);\n',
				"utf-8",
			);
			const uri = pathToFileURL(filePath).href;

			// Body-only edit: the file HAS an import, but this edit never touches it.
			const bodyResult = await applyWorkspaceEdit(
				{
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 1, character: 0 },
									end: { line: 1, character: 999 },
								},
								newText: "console.error(a);",
							},
						],
					},
				},
				tmpDir,
			);
			expect(bodyResult.fileDetails[0]?.importsChanged).toBe(false);

			// Import-line edit: actually changes the imported binding.
			const importResult = await applyWorkspaceEdit(
				{
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 0, character: 9 },
									end: { line: 0, character: 10 },
								},
								newText: "b",
							},
						],
					},
				},
				tmpDir,
			);
			expect(importResult.fileDetails[0]?.importsChanged).toBe(true);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				'import { b } from "./a";\nconsole.error(a);\n',
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// P2 (round-2 review): a formatter-wrapped MULTILINE import's specifier
	// lives on a continuation line ("} from \"./old\";") that doesn't itself
	// start with `import`/`export` — the original line-signature regex missed
	// it entirely, so changing the module specifier there under-reported
	// importsChanged: false (a real module-edge change, silently skipped by
	// downstream dependency-graph re-checks). Kept LINE-signature-based (not a
	// blanket conservative fallback): a body-only edit in a file WITH a
	// multiline import still correctly reports false, because only the
	// `from "..."`-matching continuation line is compared, not because the
	// whole file is treated as changed.
	it("P3-6 continuation: importsChanged detects a specifier change on a multiline import's continuation line", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-p3-6-multiline-"),
		);
		try {
			const filePath = path.join(tmpDir, "mod.ts");
			fs.writeFileSync(
				filePath,
				'import {\n\tfoo,\n\tbar,\n} from "./old";\n\nconsole.log(foo, bar);\n',
				"utf-8",
			);
			const uri = pathToFileURL(filePath).href;

			// Body-only edit: none of the import lines (including the continuation
			// "} from ..." line) are touched — still false, not a blanket "file has
			// a multiline import so report changed" fallback.
			const bodyResult = await applyWorkspaceEdit(
				{
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 5, character: 0 },
									end: { line: 5, character: 999 },
								},
								newText: "console.log(bar, foo);",
							},
						],
					},
				},
				tmpDir,
			);
			expect(bodyResult.fileDetails[0]?.importsChanged).toBe(false);

			// Specifier edit on the CONTINUATION line ("./old" → "./new"): a real
			// module-edge change, and the pre-fix regex (anchored on a leading
			// `import`/`export`) would miss it since this line starts with `}`.
			const specifierResult = await applyWorkspaceEdit(
				{
					changes: {
						[uri]: [
							{
								range: {
									start: { line: 3, character: 8 },
									end: { line: 3, character: 13 },
								},
								newText: "./new",
							},
						],
					},
				},
				tmpDir,
			);
			expect(specifierResult.fileDetails[0]?.importsChanged).toBe(true);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(
				'import {\n\tfoo,\n\tbar,\n} from "./new";\n\nconsole.log(bar, foo);\n',
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// FS-probe-guarded per the #1024/P1-2 lesson (see `isCaseInsensitiveFs`
	// above): the virtual-overlay alias hole only manifests on a case-
	// insensitive FS, where the create's and the rename destination's cache
	// keys collapse to the same entry. On a case-sensitive FS `foo.txt` and
	// `Foo.txt` are genuinely distinct paths, so this exercises the ordinary
	// (non-aliased) rename path instead — asserted for real, not skipped.
	it("P3-8: create-then-case-rename within one ordered edit succeeds (virtual overlay, not disk, decides the alias)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-p3-8-"));
		try {
			const fooPath = path.join(tmpDir, "foo.txt");
			const FooPath = path.join(tmpDir, "Foo.txt");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri: pathToFileURL(fooPath).href },
						{
							kind: "rename",
							oldUri: pathToFileURL(fooPath).href,
							newUri: pathToFileURL(FooPath).href,
						},
					],
				},
				tmpDir,
			);
			const entries = fs.readdirSync(tmpDir);
			// The rename always removes the source name, regardless of FS case
			// sensitivity, so exactly one case-folded spelling survives either way.
			expect(entries).toContain("Foo.txt");
			expect(entries.filter((e) => e.toLowerCase() === "foo.txt")).toEqual([
				"Foo.txt",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// P3 (round-2 review): rename(b→c); create(b); rename(b→d) re-vacates the
	// override-backed `b` a SECOND time. `resolveVirtualPath` cannot represent
	// "this purely-virtual entry moved again" (it chases PHYSICAL paths through
	// `virtualMoves`), so without migrating the override entry itself,
	// `virtualOverrides[b]` goes stale — still claiming `exists: true` after
	// `b` is genuinely vacated again.
	it("P3: a re-renamed override-backed entry migrates instead of leaving a stale virtualOverrides entry", async () => {
		// Cross-product cell 1: the migrated content survives to the FINAL
		// destination and a trailing text edit there applies correctly (not lost).
		const tmpDir1 = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-p3-restale-1-"),
		);
		try {
			const bPath = path.join(tmpDir1, "b.txt");
			const cPath = path.join(tmpDir1, "c.txt");
			const dPath = path.join(tmpDir1, "d.txt");
			fs.writeFileSync(bPath, "original", "utf-8");
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: pathToFileURL(bPath).href,
							newUri: pathToFileURL(cPath).href,
						},
						{ kind: "create", uri: pathToFileURL(bPath).href },
						{
							kind: "rename",
							oldUri: pathToFileURL(bPath).href,
							newUri: pathToFileURL(dPath).href,
						},
						{
							textDocument: { uri: pathToFileURL(dPath).href },
							edits: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 0 },
									},
									newText: "hello",
								},
							],
						},
					],
				},
				tmpDir1,
			);
			// The first rename carried the original content to c.txt, untouched.
			expect(fs.readFileSync(cPath, "utf-8")).toBe("original");
			// The re-created-then-re-renamed b.txt's content (migrated to d.txt,
			// not lost) received the trailing text edit.
			expect(fs.readFileSync(dPath, "utf-8")).toBe("hello");
			expect(fs.existsSync(bPath)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir1);
		}

		// Cross-product cell 2: after the second rename re-vacates b, b is
		// genuinely gone — proven via `delete` (not `create`, which would trip
		// the UNRELATED duplicate-resource-operation guard on a second `create`
		// at the same URI within one edit): a stale `virtualOverrides[b]` would
		// make this `delete` (no `ignoreIfNotExists`) wrongly succeed; the fix
		// makes it correctly throw "delete target does not exist".
		const tmpDir2 = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-p3-restale-2-"),
		);
		try {
			const bPath = path.join(tmpDir2, "b.txt");
			const cPath = path.join(tmpDir2, "c.txt");
			const dPath = path.join(tmpDir2, "d.txt");
			fs.writeFileSync(bPath, "original", "utf-8");
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "rename",
								oldUri: pathToFileURL(bPath).href,
								newUri: pathToFileURL(cPath).href,
							},
							{ kind: "create", uri: pathToFileURL(bPath).href },
							{
								kind: "rename",
								oldUri: pathToFileURL(bPath).href,
								newUri: pathToFileURL(dPath).href,
							},
							{ kind: "delete", uri: pathToFileURL(bPath).href },
						],
					},
					tmpDir2,
				),
			).rejects.toThrow(/delete target does not exist/);
		} finally {
			removeTempDirSync(tmpDir2);
		}
	});
});

describe("LSP workspace edits — CRLF boundary class, general (#1147 P3-5)", () => {
	// #1120 fixed the CLAMP-specific member of this class (a char-past-EOL
	// insert / whole-line sentinel replace). These cover the two GENERAL
	// members left open by #1085/#1120's review: a bare `\n` in `newText`
	// applied verbatim into a CRLF file, and a caller-supplied (non-clamped,
	// in-bounds) position that itself resolves between `\r` and `\n`.

	it("normalizes a bare \\n in newText to \\r\\n when applied into a CRLF file", () => {
		const content = "line1\r\nline2\r\n";
		const result = applyTextEditsToString(content, [
			{
				range: {
					start: { line: 0, character: 5 },
					end: { line: 0, character: 5 },
				},
				newText: "\nEXTRA",
			},
		]);
		expect(result).toBe("line1\r\nEXTRA\r\nline2\r\n");
		// No bare \n: every \n in the result is immediately preceded by \r.
		expect(/(?<!\r)\n/.test(result)).toBe(false);
	});

	it("leaves an LF file's newText untouched (no \\r introduced)", () => {
		const content = "line1\nline2\n";
		const result = applyTextEditsToString(content, [
			{
				range: {
					start: { line: 0, character: 5 },
					end: { line: 0, character: 5 },
				},
				newText: "\nEXTRA",
			},
		]);
		expect(result).toBe("line1\nEXTRA\nline2\n");
		expect(result.includes("\r")).toBe(false);
	});

	it("clamps a caller-supplied position that resolves between \\r and \\n in a CRLF file", () => {
		const content = "line1\r\nline2\r\n";
		// Line 0 as `lineTextAt` sees it is "line1\r" (length 6, keeps the trailing
		// \r). character: 6 is IN BOUNDS against that with-\r length (not past it,
		// so #1120's `> wireLength` clamp alone does not catch it) but lands right
		// after the \r and before the \n it was split from — squarely between the
		// CRLF pair.
		const result = applyTextEditsToString(content, [
			{
				range: {
					start: { line: 0, character: 6 },
					end: { line: 0, character: 6 },
				},
				newText: "X",
			},
		]);
		// Must clamp to BEFORE the \r (character 5), landing "X" ahead of the
		// intact \r\n pair — never splitting it.
		expect(result).toBe("line1X\r\nline2\r\n");
		expect(/(?<!\r)\n/.test(result)).toBe(false);
	});

	it("applyWorkspaceEdit preserves CRLF end-to-end for a bare-\\n newText on disk", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-crlf-"));
		try {
			const filePath = path.join(tmpDir, "crlf.ts");
			fs.writeFileSync(filePath, "const a = 1;\r\nconst b = 2;\r\n", "utf-8");
			await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(filePath).href]: [
							{
								range: {
									start: { line: 0, character: 12 },
									end: { line: 0, character: 12 },
								},
								newText: "\nconst z = 0;",
							},
						],
					},
				},
				tmpDir,
			);
			const written = fs.readFileSync(filePath, "utf-8");
			expect(written).toBe("const a = 1;\r\nconst z = 0;\r\nconst b = 2;\r\n");
			expect(/(?<!\r)\n/.test(written)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
