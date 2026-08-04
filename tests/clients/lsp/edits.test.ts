import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyTextEditsToString,
	applyWorkspaceEdit,
	mergeWorkspaceTextEditsByPriority,
} from "../../../clients/lsp/edits.js";
import { removeTempDirSync } from "../test-utils.js";
import {
	recordLspMutation,
	type LspMutationContext,
} from "../../../clients/lsp-mutation.js";

describe("LSP workspace edits", () => {
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

	it("records bounded mixed text/resource operations and mutation bookkeeping", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-observe-"));
		const filePath = path.join(tmpDir, "a.ts");
		const createdPath = path.join(tmpDir, "created.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf-8");
		const written: string[] = [];
		const bumped: string[] = [];
		const ranges: Array<{ filePath: string; start: number; end: number }> = [];
		const context: LspMutationContext = {
			cwd: tmpDir,
			correlationId: "mixed-edit-1",
			tool: "lsp_navigation",
			source: "lsp-edit" as const,
			readGuard: { recordWritten: (file: string) => written.push(file) },
			runtime: {
				telemetrySessionId: "session",
				turnIndex: 3,
				bumpFileSeq: (file: string) => {
					bumped.push(file);
					return { projectSeq: bumped.length, fileSeq: 1 };
				},
			},
			cacheManager: {
				addModifiedRange: (file: string, range: { start: number; end: number }) => {
					ranges.push({ filePath: file, ...range });
				},
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
			expect(result.operationCounts).toEqual({
				textEdits: 1,
				create: 1,
				rename: 0,
				delete: 0,
			});
			expect(result.appliedOperationIndexes).toEqual([0, 1]);
			expect(written).toEqual([filePath, createdPath]);
			expect(bumped).toEqual([filePath, createdPath]);
			expect(ranges).toHaveLength(2);
			expect(context.summaryEmitted).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("emits failed terminal state after partial workspace mutation", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-partial-"));
		const filePath = path.join(tmpDir, "a.ts");
		fs.writeFileSync(filePath, "const old = 1;\n", "utf-8");
		const written: string[] = [];
		const context: LspMutationContext = {
			cwd: tmpDir,
			correlationId: "partial-edit-1",
			tool: "workspace/applyEdit",
			source: "lsp-edit" as const,
			readGuard: { recordWritten: (file: string) => written.push(file) },
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
			).rejects.toThrow(/already written/);
			expect(written).toEqual([filePath]);
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
					appliedOperationIndexes: Array.from({ length: 120 }, (_, index) => index),
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
});
