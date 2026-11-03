import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { LspRequestTimeoutError } from "../../../clients/lsp/request-timeout-error.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import type { RenameClientDouble } from "../../support/lsp-rename-client-double.js";
import {
	addRenameClient,
	makeRenameClient,
} from "../../support/lsp-rename-client-double.js";
import { removeTempDirSync } from "../test-utils.js";

/**
 * #3734: a file no client has open is refused when its mtime sits within 2 s
 * of the rename request (`captureRenameExpectedContent`'s margin). These cells
 * are about the merged edit, not staleness, so the importer stands for one the
 * server read earlier: aging its mtime is the fixture, not a wait.
 */
function ageFile(file: string): void {
	const past = new Date(Date.now() - 60_000);
	fs.utimesSync(file, past, past);
}

describe("LSPService.renameFile", () => {
	it("merges willRenameFiles edits by client priority, renames, and notifies all active clients", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");
		ageFile(importPath);
		const importUri = pathToFileURL(importPath).href;

		const primary = makeRenameClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const secondary = makeRenameClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 23 },
							end: { line: 0, character: 28 },
						},
						newText: "./new",
					},
				],
			},
		});

		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, primary);
		addRenameClient(service, "eslint", tmpDir, secondary);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.droppedConflicts).toBe(1);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const value = 1;\n",
			);
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect(primary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(primary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #5013: the rename description folds each `path.relative` result through
	// `toPosix`, so a backslash-spelled relative path is reported with forward
	// slashes. Two on-disk spellings of the same logical file are created for
	// one reason: the preflight decodes the URI through `uriToPath` ->
	// `normalizeFilePath`, which folds the separator before it stats the source,
	// while the apply step renames the caller's raw spelling verbatim. Neither
	// reads the other's path, and both behaviours predate the fold; only the
	// description under test folds. On win32 the two spellings are the same path
	// and `path.relative` hands back a backslash on its own.
	it("describes the rename with a folded relative path (lsp/index.ts fold)", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-fold-"),
		);
		const physicalDir = path.join(tmpDir, "sub", "dir");
		const spelledDir = path.join(tmpDir, "sub\\dir");
		for (const dir of [physicalDir, spelledDir]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "old.ts"),
				"export const value = 1;\n",
				"utf-8",
			);
		}
		const oldPath = path.join(spelledDir, "old.ts");
		const newPath = path.join(spelledDir, "new.ts");

		const service = new LSPService();
		addRenameClient(
			service,
			"typescript",
			tmpDir,
			makeRenameClient(tmpDir, null),
		);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.descriptions).toContain(
				"Renamed sub/dir/old.ts → sub/dir/new.ts",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("records malformed registration skips at both service gates", async () => {
		resetDegradationLedger();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const malformed = makeRenameClient(tmpDir, null);
		malformed.getOperationSupport.mockReturnValue({
			willRenameFiles: false,
			didRenameFiles: false,
		});
		malformed.getMalformedFileOperationRegistrations.mockReturnValue(
			new Set(["willRename", "didRename"]),
		);
		const service = new LSPService();
		addRenameClient(service, "malformed", tmpDir, malformed);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});
			expect(result.applied).toBe(true);
			expect(malformed.willRenameFiles).not.toHaveBeenCalled();
			expect(malformed.didRenameFiles).not.toHaveBeenCalled();
			const reasons = getDegradationSummary()
				.find((group) => group.kind === "lsp-capability-skip")
				?.latestReasons.map((entry) => entry.reason);
			expect(reasons).toEqual([
				"malformed-registration",
				"malformed-registration",
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("connects initialize registration parsing to the real service gates", async () => {
		const cases = [
			{
				name: "malformed willRename",
				env: { FAKE_LSP_WILL_RENAME: "malformed" },
				expected: ["malformed-registration", "no-registration"],
			},
			{
				name: "malformed didRename",
				env: {
					FAKE_LSP_WILL_RENAME: "true",
					FAKE_LSP_DID_RENAME: "true",
					FAKE_LSP_DID_RENAME_FILTERS: JSON.stringify([{ scheme: "" }]),
				},
				expected: ["malformed-registration"],
			},
			{
				name: "capability absent",
				env: {},
				expected: ["no-registration", "no-registration"],
			},
			{
				name: "well-formed non-matching filters",
				env: {
					FAKE_LSP_WILL_RENAME: "true",
					FAKE_LSP_DID_RENAME: "true",
					FAKE_LSP_WILL_RENAME_GLOB: "**/*.go",
					FAKE_LSP_DID_RENAME_GLOB: "**/*.go",
				},
				expected: ["filter-mismatch", "filter-mismatch"],
			},
		] as const;

		for (const testCase of cases) {
			resetDegradationLedger();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-real-rename-"),
			);
			const oldPath = path.join(tmpDir, "old.ts");
			const newPath = path.join(tmpDir, "new.ts");
			fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
			const proc = await spawnFakeLspServer({
				cwd: process.cwd(),
				env: { ...process.env, ...testCase.env },
			});
			const client = await createLSPClient({
				serverId: `real-${testCase.name}`,
				process: proc,
				root: tmpDir,
			});
			const service = new LSPService();
			addRenameClient(
				service,
				`real-${testCase.name}`,
				tmpDir,
				client as unknown as RenameClientDouble,
			);
			try {
				await service.renameFile(oldPath, newPath, {
					cwd: tmpDir,
					apply: true,
				});
				const reasons = getDegradationSummary()
					.find((group) => group.kind === "lsp-capability-skip")
					?.latestReasons.map((entry) => entry.reason);
				expect(reasons, testCase.name).toEqual([...testCase.expected]);
			} finally {
				await client.shutdown().catch(() => {});
				await stopLSP(proc).catch(() => {});
				removeTempDirSync(tmpDir);
			}
		}
	}, 30_000);

	it("skips unsupported willRenameFiles clients while retaining supporting edits", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");
		ageFile(importPath);
		const supporting = makeRenameClient(tmpDir, {
			changes: {
				[pathToFileURL(importPath).href]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const unsupported = makeRenameClient(tmpDir, {
			changes: { [pathToFileURL(importPath).href]: [] },
		});
		unsupported.getOperationSupport.mockReturnValue({
			willRenameFiles: false,
			didRenameFiles: false,
		});
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, supporting);
		addRenameClient(service, "eslint", tmpDir, unsupported);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});
			expect(result.applied).toBe(true);
			expect(supporting.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(unsupported.willRenameFiles).not.toHaveBeenCalled();
			expect(unsupported.didRenameFiles).not.toHaveBeenCalled();
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("applies and notifies when every active client skips willRenameFiles", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const first = makeRenameClient(tmpDir, null);
		const second = makeRenameClient(tmpDir, null);
		first.getOperationSupport.mockReturnValue({
			willRenameFiles: false,
			didRenameFiles: true,
		});
		second.getOperationSupport.mockReturnValue({
			willRenameFiles: false,
			didRenameFiles: true,
		});
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, first);
		addRenameClient(service, "eslint", tmpDir, second);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});
			expect(result.applied).toBe(true);
			expect(result.serverIds).toEqual(["typescript", "eslint"]);
			expect(first.willRenameFiles).not.toHaveBeenCalled();
			expect(second.willRenameFiles).not.toHaveBeenCalled();
			expect(first.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(second.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			// #4320 r2 (F2): what a file watcher reports for the move, so a server
			// without didRenameFiles drops a failed lookup for the destination.
			expect(first.notify.watchedFileChange.mock.calls).toEqual([
				[oldPath, 3],
				[newPath, 1],
			]);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const value = 1;\n",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("previews with no active clients without touching the filesystem", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		try {
			const result = await new LSPService().renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: false,
			});

			expect(result).toMatchObject({
				applied: false,
				serverIds: [],
				droppedConflicts: 0,
				inputEditCount: 0,
				summary: [],
			});
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("applies a plain filesystem rename when no clients are active", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");

		try {
			const result = await new LSPService().renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.serverIds).toEqual([]);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe(
				"export const value = 1;\n",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("records a willRenameFiles failure while still using successful server edits", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");
		ageFile(importPath);

		const success = makeRenameClient(tmpDir, {
			changes: {
				[pathToFileURL(importPath).href]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const failing = makeRenameClient(tmpDir, null);
		failing.willRenameFiles.mockRejectedValueOnce(new Error("eslint down"));
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, success);
		addRenameClient(service, "eslint", tmpDir, failing);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.willRenameFailures).toEqual([
				{ serverId: "eslint", error: "eslint down" },
			]);
			expect(fs.readFileSync(importPath, "utf-8")).toBe(
				"import { value } from './new';\n",
			);
			expect(success.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(failing.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("rejects and leaves files untouched when every willRenameFiles request fails", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const failing = makeRenameClient(tmpDir, null);
		failing.willRenameFiles.mockRejectedValueOnce(new Error("server down"));
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, failing);

		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toThrow(
				/workspace\/willRenameFiles failed for all active LSP servers/,
			);
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
			expect(failing.didRenameFiles).not.toHaveBeenCalled();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves a typed willRenameFiles timeout through the aggregate", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-timeout-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const failing = makeRenameClient(tmpDir, null);
		failing.willRenameFiles.mockRejectedValueOnce(
			new LspRequestTimeoutError("workspace/willRenameFiles", 100, 101),
		);
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, failing);
		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toBeInstanceOf(LspRequestTimeoutError);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("closes an open old URI before notifying the client about the rename", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(client.closeDocument).toHaveBeenCalledWith(oldPath);
			expect(client.closeDocument.mock.invocationCallOrder[0]).toBeLessThan(
				client.didRenameFiles.mock.invocationCallOrder[0] ?? 0,
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("aborts and resynchronizes when document close fails, reopening with the document's real language ID", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		client.closeDocument.mockRejectedValueOnce(new Error("close failed"));
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			const failure = await service
				.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true })
				.then(
					() => undefined,
					(error: Error) => error.message,
				);
			expect(failure).toMatch(/didClose failed; rename aborted/);
			// The re-open landed, so no resync failure is claimed (#3477 round 1).
			expect(failure).not.toContain("resync also failed");
			expect(fs.existsSync(oldPath)).toBe(true);
			expect(fs.existsSync(newPath)).toBe(false);
			expect(client.didRenameFiles).not.toHaveBeenCalled();
			// Reopen must use the document's ACTUAL language ID (derived the same
			// way every genuine open does), not a hardcoded "plaintext" fallback
			// that would degrade this server's diagnostics until the next genuine
			// open (#1147 P3-7).
			expect(client.notify.open).toHaveBeenCalledWith(
				oldPath,
				expect.any(String),
				"typescript",
				true,
				true,
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #3477 round 1 S1: a timed-out close is still queued, and the queue refuses
	// the re-open behind it (`notify.open` resolves false). That is a failed
	// resync, not a landed one: the rename reports it (and logs
	// lsp_rename_resync_failed) instead of claiming the document was restored.
	it("reports a re-open the queue refused as a failed resync", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		client.closeDocument.mockRejectedValueOnce(new Error("close timed out"));
		client.notify.open.mockResolvedValueOnce(false);
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toThrow(
				/resync also failed: typescript \(rejected\): re-open not sent: the close is still queued/,
			);
			expect(fs.existsSync(oldPath)).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #3543: a client that died after its close failed also resolves the
	// re-open false (nothing went on the wire). The resync failure names the
	// death, not a queued close.
	it("names a dead client, not a queued close, when the re-open was not sent", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		client.closeDocument.mockRejectedValueOnce(new Error("close timed out"));
		client.notify.open.mockImplementationOnce(async () => {
			client.isAlive.mockReturnValue(false);
			return false;
		});
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toThrow(
				/resync also failed: typescript \(rejected\): re-open not sent: the client is dead/,
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("falls back to plaintext on close-failure reopen only for an unrecognized extension", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.unrecognized-ext");
		const newPath = path.join(tmpDir, "new.unrecognized-ext");
		fs.writeFileSync(oldPath, "content\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		client.closeDocument.mockRejectedValueOnce(new Error("close failed"));
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			await expect(
				service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true }),
			).rejects.toThrow(/didClose failed; rename aborted/);
			expect(client.notify.open).toHaveBeenCalledWith(
				oldPath,
				expect.any(String),
				"plaintext",
				true,
				true,
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves the URI spelling used to open the old document", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "value\n", "utf-8");
		const originalUri = `file://localhost/${tmpDir.replace(/\\/g, "/")}/OLD%2Ets`;
		const client = makeRenameClient(tmpDir, null);
		client.isDocumentOpen.mockReturnValue(true);
		client.getDocumentUri.mockReturnValue(originalUri);
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);
		try {
			await service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true });
			expect(client.didRenameFiles).toHaveBeenCalledWith(
				oldPath,
				newPath,
				originalUri,
				`file://localhost/${tmpDir.replace(/\\/g, "/")}/new%2Ets`,
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	// #3734 r3 class sweep: the open-document lookup was joined by server id, so
	// a second root of the same server that never opened the file was told the
	// first root's URI spelling, which names a document it does not hold.
	it("gives each root of one server its own old URI spelling, not another root's", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "value\n", "utf-8");
		const originalUri = `file://localhost/${tmpDir.replace(/\\/g, "/")}/OLD%2Ets`;
		const opener = makeRenameClient(tmpDir, null);
		opener.isDocumentOpen.mockReturnValue(true);
		opener.getDocumentUri.mockReturnValue(originalUri);
		const otherRoot = path.join(tmpDir, "package");
		fs.mkdirSync(otherRoot);
		const other = makeRenameClient(otherRoot, null);
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, opener);
		addRenameClient(service, "typescript", otherRoot, other);
		try {
			await service.renameFile(oldPath, newPath, { cwd: tmpDir, apply: true });
			expect(opener.didRenameFiles).toHaveBeenCalledWith(
				oldPath,
				newPath,
				originalUri,
				`file://localhost/${tmpDir.replace(/\\/g, "/")}/new%2Ets`,
			);
			expect(other.didRenameFiles.mock.calls).toEqual([[oldPath, newPath]]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("rejects a rename source outside the workspace", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-outside-"),
		);
		const outsidePath = path.join(outsideDir, "outside.ts");
		const destination = path.join(tmpDir, "inside.ts");
		fs.writeFileSync(outsidePath, "outside", "utf-8");
		try {
			await expect(
				new LSPService().renameFile(outsidePath, destination, {
					cwd: tmpDir,
					apply: true,
				}),
			).rejects.toThrow(/escapes workspace/);
			expect(fs.existsSync(outsidePath)).toBe(true);
			expect(fs.existsSync(destination)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outsideDir);
		}
	});

	it("validates both rename resources before soliciting server edits, including previews", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-outside-"),
		);
		const source = path.join(tmpDir, "inside.ts");
		const importPath = path.join(tmpDir, "import.ts");
		const outsideSource = path.join(outsideDir, "outside.ts");
		const outsideDestination = path.join(outsideDir, "moved.ts");
		fs.writeFileSync(source, "inside", "utf-8");
		fs.writeFileSync(outsideSource, "outside", "utf-8");
		fs.writeFileSync(importPath, "import './inside';", "utf-8");
		const client = makeRenameClient(tmpDir, {
			changes: {
				[pathToFileURL(importPath).href]: [
					{
						range: {
							start: { line: 0, character: 8 },
							end: { line: 0, character: 15 },
						},
						newText: "./moved",
					},
				],
			},
		});
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);
		try {
			for (const apply of [false, true]) {
				await expect(
					service.renameFile(source, outsideDestination, {
						cwd: tmpDir,
						apply,
					}),
				).rejects.toThrow(/escapes workspace/);
				expect(fs.readFileSync(importPath, "utf-8")).toBe("import './inside';");
			}
			await expect(
				service.renameFile(outsideSource, path.join(tmpDir, "inside-dest.ts"), {
					cwd: tmpDir,
					apply: false,
				}),
			).rejects.toThrow(/escapes workspace/);
			expect(client.willRenameFiles).not.toHaveBeenCalled();
			expect(fs.existsSync(source)).toBe(true);
			expect(fs.existsSync(outsideSource)).toBe(true);
			expect(fs.existsSync(outsideDestination)).toBe(false);
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outsideDir);
		}
	});

	it("rejects a rename destination outside the workspace, including traversal", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-outside-"),
		);
		const source = path.join(tmpDir, "inside.ts");
		const outsideDestination = path.join(
			tmpDir,
			"..",
			path.basename(outsideDir),
			"moved.ts",
		);
		fs.writeFileSync(source, "inside", "utf-8");
		try {
			await expect(
				new LSPService().renameFile(source, outsideDestination, {
					cwd: tmpDir,
					apply: true,
				}),
			).rejects.toThrow(/escapes workspace/);
			expect(fs.readFileSync(source, "utf-8")).toBe("inside");
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outsideDir);
		}
	});

	it("rejects a rename through a symlinked workspace directory", async ({
		skip,
	}) => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-outside-"),
		);
		const source = path.join(tmpDir, "inside.ts");
		const linkedDestination = path.join(tmpDir, "linked", "moved.ts");
		fs.writeFileSync(source, "inside", "utf-8");
		try {
			try {
				fs.symlinkSync(
					outsideDir,
					path.join(tmpDir, "linked"),
					process.platform === "win32" ? "junction" : "dir",
				);
			} catch (err) {
				skip(
					`symlink/junction setup unavailable: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
			await expect(
				new LSPService().renameFile(source, linkedDestination, {
					cwd: tmpDir,
					apply: true,
				}),
			).rejects.toThrow(/escapes workspace/);
			expect(fs.existsSync(source)).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(outsideDir);
		}
	});

	it("records didRenameFiles failures after a successful disk rename", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"),
		);
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		const client = makeRenameClient(tmpDir, null);
		client.didRenameFiles.mockRejectedValueOnce(new Error("notify failed"));
		const service = new LSPService();
		addRenameClient(service, "typescript", tmpDir, client);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.didRenameFailures).toEqual([
				{
					serverId: "typescript",
					error: "notify failed",
					disposition: "rejected",
				},
			]);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.existsSync(newPath)).toBe(true);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});

describe("LSPService.getTrackedContent (#3601)", () => {
	// `lsp_navigation`'s rename binds each touched file to what a live client
	// last sent for it. The lookup must skip a dead client, a client rooted
	// elsewhere, and one that does not track the document, and must report
	// nothing when no client does (the caller refuses such a file).
	it("returns the send of the first live in-root client that tracks the document", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tracked-"));
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tracked-o-"));
		try {
			const filePath = path.join(tmpDir, "a.ts");
			const service = new LSPService();
			const untracking = {
				...makeRenameClient(tmpDir, null),
				getSentContent: vi.fn(() => undefined),
			};
			const tracking = {
				...makeRenameClient(tmpDir, null),
				getSentContent: vi.fn(
					(): { hash: string; changedAtMs?: number } | undefined => ({
						hash: "hash-in-root",
						changedAtMs: 7,
					}),
				),
			};
			const dead = {
				...makeRenameClient(tmpDir, null),
				isAlive: vi.fn(() => false),
				getSentContent: vi.fn(() => ({ hash: "hash-dead" })),
			};
			const elsewhere = {
				...makeRenameClient(other, null),
				getSentContent: vi.fn(() => ({ hash: "hash-other-root" })),
			};
			addRenameClient(service, "aux-a", tmpDir, untracking);
			addRenameClient(service, "aux-b", tmpDir, tracking);
			addRenameClient(service, "aux-c", tmpDir, dead);
			addRenameClient(service, "aux-d", other, elsewhere);

			expect(service.getTrackedContent(filePath, tmpDir)).toEqual({
				hash: "hash-in-root",
				changedAtMs: 7,
			});
			expect(dead.getSentContent).not.toHaveBeenCalled();
			expect(elsewhere.getSentContent).not.toHaveBeenCalled();

			tracking.getSentContent.mockReturnValue(undefined);
			expect(service.getTrackedContent(filePath, tmpDir)).toBeUndefined();
		} finally {
			removeTempDirSync(tmpDir);
			removeTempDirSync(other);
		}
	});
});
