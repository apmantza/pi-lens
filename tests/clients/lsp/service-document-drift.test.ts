/**
 * #1783 — the disk-drift backstop, end to end through LSPService.
 *
 * Reproduces the 2026-08-20 dogfood forensics: a file is opened through the
 * normal sync path, then a bash-tool bulk edit rewrites it on disk. No
 * `didChange` is sent, so the server keeps answering from the pre-edit
 * content. Before the fix nothing ever compared disk against what the server
 * holds, and the stale view survived for the life of the server.
 *
 * The second half of this file covers the coverage contract that the first
 * round got wrong: one record per FILE is a claim about EVERY server holding
 * that file, so it may only be stamped when the sync reached all of them.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

function makeServer(
	root: string,
	id = "typescript",
	role: "primary" | "auxiliary" = "primary",
) {
	return {
		id,
		name: id,
		role,
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A client that remembers the LAST content it was given — the fake stand-in
 * for the language server's in-memory document view.
 */
function makeClient(
	openDocuments: Set<string>,
	behaviour: {
		onOpen?: (filePath: string, content: string) => Promise<void> | void;
	} = {},
) {
	const received: string[] = [];
	return {
		received,
		serverId: "typescript",
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		isDocumentOpen: (filePath: string) =>
			openDocuments.has(path.resolve(filePath)),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none" as const,
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		diagnosticsVersion: 0,
		getDiagnostics: vi.fn(() => []),
		notify: {
			open: vi.fn(async (filePath: string, content: string) => {
				await behaviour.onOpen?.(filePath, content);
				openDocuments.add(path.resolve(filePath));
				received.push(content);
			}),
			change: vi.fn(async () => {}),
			watchedFileChange: vi.fn(),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

const ORIGINAL = "export const answer = 42;\nconst unused = 1;\n";
/** Longer than ORIGINAL: the size half of the drift key moves. */
const BULK_EDITED = "export const answer = 42;\nexport const extra = 7;\n";
/** EXACTLY as long as ORIGINAL: only the mtime half of the key can see it. */
const SAME_LENGTH_EDIT = "export const answer = 41;\nconst unused = 2;\n";

describe("LSPService disk-drift backstop (#1783)", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-drift-"));
		file = path.join(dir, "stdio.ts");
		await fs.writeFile(file, ORIGINAL, "utf-8");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function primeService() {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);
		// The normal sync path: content read from disk, pushed to the server.
		await service.touchFile(file, ORIGINAL, {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
		expect(client.received).toEqual([ORIGINAL]);
		return { service, client, openDocuments };
	}

	/** The untracked bulk edit: content, size and mtime all move on disk. */
	async function bulkEditOnDisk(content = BULK_EDITED) {
		await fs.writeFile(file, content, "utf-8");
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(file, future, future);
	}

	it("resynchronizes a document a bash bulk edit moved behind the server", async () => {
		const { service, client } = await primeService();

		await bulkEditOnDisk();
		// The stale state the forensics captured: the server's view is pre-edit
		// and no notification carried the new bytes.
		expect(client.received).toEqual([ORIGINAL]);

		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.candidates).toBe(1);
		expect(result?.resynced).toBe(1);
		expect(client.received).toEqual([ORIGINAL, BULK_EDITED]);
	});

	it("resynchronizes an open document from the recovered Git-change seam", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);
		await service.touchFile(file, await fs.readFile(file, "utf-8"), {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
		const originalStat = await fs.stat(file);
		await fs.writeFile(file, SAME_LENGTH_EDIT, "utf-8");
		await fs.utimes(file, originalStat.atime, originalStat.mtime);

		await service.resyncGitChangedFiles([file]);

		// This is the recurrence of #2817: the stat-key drift backstop cannot see
		// a same-size, same-mtime Git checkout, but the Git seam has the path set.
		expect(client.received).toEqual([ORIGINAL, SAME_LENGTH_EDIT]);
	});

	it("emits a bounded record naming the file and the drift age", async () => {
		const { service } = await primeService();
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../clients/degradation-ledger.js");
		resetDegradationLedger();

		await bulkEditOnDisk();
		await service.sweepDocumentDrift({ force: true });

		const summary = getDegradationSummary();
		const group = summary.find((entry) => entry.kind === "lsp-document-drift");
		expect(group).toBeDefined();
		expect(
			group?.latestReasons.some((e) => e.subject.endsWith("stdio.ts")),
		).toBe(true);
		expect(
			group?.latestReasons.some((e) => /untracked disk drift/.test(e.reason)),
		).toBe(true);
	});

	it("re-stamps without notifying when the mtime moved but the bytes did not", async () => {
		const { service, client } = await primeService();

		const future = new Date(Date.now() + 5_000);
		await fs.utimes(file, future, future);

		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.candidates).toBe(1);
		expect(result?.unchanged).toBe(1);
		expect(result?.resynced).toBe(0);
		// The distinction the ledger must preserve: touched is not changed.
		expect(client.received).toEqual([ORIGINAL]);
	});

	it("never resyncs a document no live client still holds open", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);
		await service.touchFile(file, ORIGINAL, {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
		// The server closed the document (eviction, shutdown, rename).
		openDocuments.clear();

		await bulkEditOnDisk();
		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.unheld).toBe(1);
		expect(result?.resynced).toBe(0);
		expect(client.received).toEqual([ORIGINAL]);
	});

	it("fires the sweep from touchFile, so no explicit call is needed", async () => {
		const previous = process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
		process.env.PI_LENS_LSP_DRIFT_CHECK_MS = "1";
		try {
			const { service, client } = await primeService();
			await bulkEditOnDisk();
			// A touch of ANOTHER file is enough: the backstop is not keyed to the
			// file being touched.
			const other = path.join(dir, "other.ts");
			await fs.writeFile(other, "export const x = 1;\n", "utf-8");
			await service.touchFile(other, "export const x = 1;\n", {
				diagnostics: "none",
				clientScope: "primary",
				source: "lsp_sync",
			});
			// The sweep is deliberately not awaited by touchFile; drain the
			// microtask/IO turns it needs.
			await vi.waitFor(() => {
				expect(client.received).toContain(BULK_EDITED);
			});
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_LSP_DRIFT_CHECK_MS;
			else process.env.PI_LENS_LSP_DRIFT_CHECK_MS = previous;
		}
	});

	it("records documents opened through openFile, not only touchFile", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const openDocuments = new Set<string>();
		const client = makeClient(openDocuments);
		getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
		createLSPClient.mockResolvedValue(client);

		await service.openFile(file, ORIGINAL);
		expect(client.received).toEqual([ORIGINAL]);

		await bulkEditOnDisk();
		const result = await service.sweepDocumentDrift({ force: true });

		expect(result?.resynced).toBe(1);
		expect(client.received).toEqual([ORIGINAL, BULK_EDITED]);
	});

	it("clears every record when the service resets", async () => {
		const { service } = await primeService();
		expect(service._driftTrackedCountForTests()).toBe(1);

		await service.shutdown();

		expect(service._driftTrackedCountForTests()).toBe(0);
	});

	describe("coverage contract (review round 1, F1/F2)", () => {
		/** Primary + auxiliary, both holding the same document. */
		async function primeTwoServers() {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const primaryOpen = new Set<string>();
			const auxOpen = new Set<string>();
			const primary = makeClient(primaryOpen);
			const aux = makeClient(auxOpen);
			getServersForFileWithConfig.mockReturnValue([
				makeServer(dir, "typescript", "primary"),
				makeServer(dir, "opengrep", "auxiliary"),
			]);
			createLSPClient
				.mockResolvedValueOnce(primary)
				.mockResolvedValueOnce(aux)
				.mockResolvedValue(primary);
			await service.touchFile(file, ORIGINAL, {
				diagnostics: "none",
				clientScope: "all",
				source: "lsp_sync",
			});
			expect(primary.received).toEqual([ORIGINAL]);
			expect(aux.received).toEqual([ORIGINAL]);
			return { service, primary, aux };
		}

		it("resyncs the AUXILIARY view too, not only the primary", async () => {
			const { service, primary, aux } = await primeTwoServers();

			await bulkEditOnDisk();
			const result = await service.sweepDocumentDrift({ force: true });

			expect(result?.resynced).toBe(1);
			expect(primary.received).toEqual([ORIGINAL, BULK_EDITED]);
			// The face the first round got wrong: a primary-scoped resync left this
			// view on the pre-edit content forever while the record read "in sync".
			expect(aux.received).toEqual([ORIGINAL, BULK_EDITED]);
		});

		it("reports the healed file as in sync on the following pass", async () => {
			const { service } = await primeTwoServers();

			// A real bash edit stamps mtime = now, so the heal's own record —
			// stamped after it — settles the file. (The other tests push mtime into
			// the future to isolate the mtime half of the key; that deliberately
			// never settles.)
			await fs.writeFile(file, BULK_EDITED, "utf-8");
			const first = await service.sweepDocumentDrift({ force: true });
			expect(first?.resynced).toBe(1);

			const second = await service.sweepDocumentDrift({ force: true });

			expect(second?.candidates).toBe(0);
			expect(second?.resynced).toBe(0);
		});

		it("does not stamp a record when a server outside the touch holds the document", async () => {
			const { service, primary, aux } = await primeTwoServers();
			const V2 = "export const answer = 43;\nexport const two = 2;\n";
			await fs.writeFile(file, V2, "utf-8");

			// A primary-scoped touch. The auxiliary still holds the document, so
			// this content did NOT reach every view and the record must not claim it.
			await service.touchFile(file, V2, {
				diagnostics: "none",
				clientScope: "primary",
				source: "lsp_sync",
			});
			expect(primary.received).toEqual([ORIGINAL, V2]);
			expect(aux.received).toEqual([ORIGINAL]);

			// The stale ORIGINAL record survives, so the sweep still sees drift and
			// heals the auxiliary at full scope.
			const result = await service.sweepDocumentDrift({ force: true });

			expect(result?.resynced).toBe(1);
			expect(aux.received).toEqual([ORIGINAL, V2]);
		});

		it("does not stamp a record when one server's write fails", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const primaryOpen = new Set<string>();
			const auxOpen = new Set<string>();
			const primary = makeClient(primaryOpen);
			const aux = makeClient(auxOpen);
			aux.notify.open = vi.fn(async () => {
				throw new Error("notify write rejected");
			});
			getServersForFileWithConfig.mockReturnValue([
				makeServer(dir, "typescript", "primary"),
				makeServer(dir, "opengrep", "auxiliary"),
			]);
			createLSPClient
				.mockResolvedValueOnce(primary)
				.mockResolvedValueOnce(aux)
				.mockResolvedValue(primary);

			await service.touchFile(file, ORIGINAL, {
				diagnostics: "none",
				clientScope: "all",
				source: "lsp_sync",
			});

			expect(primary.received).toEqual([ORIGINAL]);
			// One server never got the content, so the file-level record would be a
			// claim about a view that does not hold it.
			expect(service._driftTrackedCountForTests()).toBe(0);
		});

		it("detects an untracked edit made INSIDE the sync window", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const openDocuments = new Set<string>();
			// The bash edit lands while the notify write is still in flight. The
			// edit keeps the byte length identical, so only the mtime half of the
			// key can catch it — and it can only catch it if `syncedAt` is anchored
			// at the START of the sync, not at the moment the write landed.
			const client = makeClient(openDocuments, {
				onOpen: async () => {
					await new Promise((resolve) => setTimeout(resolve, 30));
					await fs.writeFile(file, SAME_LENGTH_EDIT, "utf-8");
					await new Promise((resolve) => setTimeout(resolve, 30));
				},
			});
			getServersForFileWithConfig.mockReturnValue([makeServer(dir)]);
			createLSPClient.mockResolvedValue(client);

			await service.touchFile(file, ORIGINAL, {
				diagnostics: "none",
				clientScope: "primary",
				source: "lsp_sync",
			});
			expect(SAME_LENGTH_EDIT.length).toBe(ORIGINAL.length);

			const result = await service.sweepDocumentDrift({ force: true });

			expect(result?.candidates).toBe(1);
			expect(result?.resynced).toBe(1);
			expect(client.received).toEqual([ORIGINAL, SAME_LENGTH_EDIT]);
		});

		it("does not stamp a record when an auxiliary resync is DEFERRED", async () => {
			// Third face of the coverage defect. The #1459 gate defers an auxiliary
			// whose previous write is still outstanding: that server returns from
			// the write loop EARLY, so it never reaches notifyWriteTimedOutServerIds
			// and a gate reading only that list stamps full coverage for a view that
			// received nothing.
			const previousBudget = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
			try {
				const { LSPService } = await import("../../../clients/lsp/index.js");
				const service = new LSPService();
				const primaryOpen = new Set<string>();
				const auxOpen = new Set<string>();
				const primary = makeClient(primaryOpen);
				let wedged = false;
				const aux = makeClient(auxOpen, {
					onOpen: async () => {
						if (wedged) await new Promise(() => {});
					},
				});
				getServersForFileWithConfig.mockReturnValue([
					makeServer(dir, "typescript", "primary"),
					makeServer(dir, "opengrep", "auxiliary"),
				]);
				createLSPClient
					.mockResolvedValueOnce(primary)
					.mockResolvedValueOnce(aux)
					.mockResolvedValue(primary);

				// C1 lands on both views: a legitimate full-coverage record.
				await service.touchFile(file, ORIGINAL, {
					diagnostics: "none",
					clientScope: "all",
					source: "lsp_sync",
				});
				expect(service._driftTrackedCountForTests()).toBe(1);

				// The auxiliary's next write never settles, so it keeps the #1459
				// resync slot claimed.
				wedged = true;
				const C2 = "export const answer = 2;\n";
				await fs.writeFile(file, C2, "utf-8");
				await service.touchFile(file, C2, {
					diagnostics: "none",
					clientScope: "all",
					source: "lsp_sync",
				});

				// With the slot occupied and no time left to queue, THIS touch's
				// auxiliary write is deferred rather than attempted.
				const C3 = "export const answer = 3;\nexport const three = 3;\n";
				await fs.writeFile(file, C3, "utf-8");
				await service.touchFile(file, C3, {
					diagnostics: "none",
					clientScope: "all",
					source: "lsp_sync",
					maxClientWaitMs: 0,
				});

				// The auxiliary still holds C1, so the record must still describe C1
				// and the sweep must still see this file as drifted.
				expect(aux.received).toEqual([ORIGINAL]);
				const result = await service.sweepDocumentDrift({ force: true });

				expect(result?.candidates).toBe(1);
				// The heal cannot complete while that scanner is wedged, and it says
				// so rather than laundering the record.
				expect(result?.resynced).toBe(0);
				expect(result?.failed).toBe(1);
			} finally {
				if (previousBudget === undefined) {
					delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
				} else {
					process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = previousBudget;
				}
			}
		});

		it("paces a 20-file bulk edit even with the wider two-server scope", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const primaryOpen = new Set<string>();
			const auxOpen = new Set<string>();
			const primary = makeClient(primaryOpen);
			const aux = makeClient(auxOpen);
			getServersForFileWithConfig.mockReturnValue([
				makeServer(dir, "typescript", "primary"),
				makeServer(dir, "opengrep", "auxiliary"),
			]);
			createLSPClient
				.mockResolvedValueOnce(primary)
				.mockResolvedValueOnce(aux)
				.mockResolvedValue(primary);

			const files: string[] = [];
			for (let i = 0; i < 20; i++) {
				const target = path.join(dir, `bulk-${i}.ts`);
				await fs.writeFile(target, `export const v${i} = 0;\n`, "utf-8");
				files.push(target);
				await service.touchFile(target, `export const v${i} = 0;\n`, {
					diagnostics: "none",
					clientScope: "all",
					source: "lsp_sync",
				});
			}
			// One bulk operation across all 20.
			for (const [i, target] of files.entries()) {
				await fs.writeFile(
					target,
					`export const v${i} = 1; // edited\n`,
					"utf-8",
				);
			}

			const before = primary.received.length + aux.received.length;
			const first = await service.sweepDocumentDrift({ force: true });

			// The per-pass cap counts FILES, so the wider scope multiplies writes by
			// the number of held servers, not by the number of files.
			expect(first?.resynced).toBe(4);
			expect(first?.deferred).toBe(16);
			expect(primary.received.length + aux.received.length - before).toBe(8);

			// The remainder heals in later passes, four files at a time.
			let healed = first?.resynced ?? 0;
			let passes = 1;
			while (healed < 20 && passes < 12) {
				healed +=
					(await service.sweepDocumentDrift({ force: true }))?.resynced ?? 0;
				passes += 1;
			}
			expect(healed).toBe(20);
			expect(passes).toBe(5);
		});

		it("reports a failed resync as failed, never as healed", async () => {
			const { service, client } = await primeService();
			const { getDegradationSummary, resetDegradationLedger } =
				await import("../../../clients/degradation-ledger.js");
			resetDegradationLedger();
			client.notify.open = vi.fn(async () => {
				throw new Error("server died");
			});

			await bulkEditOnDisk();
			const result = await service.sweepDocumentDrift({ force: true });

			expect(result?.resynced).toBe(0);
			expect(result?.failed).toBe(1);
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "lsp-document-drift",
			);
			expect(
				group?.latestReasons.some((e) => /resync FAILED/.test(e.reason)),
			).toBe(true);
		});
	});
});
