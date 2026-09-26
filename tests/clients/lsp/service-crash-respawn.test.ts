/**
 * #3501: a touch-debounce entry speaks only for the client it was written to.
 *
 * Recurrence this file prevents: `recentTouches` was keyed by
 * path:scope:serverId with no client identity, so an entry earned by a client
 * that then crashed or was evicted (or written by a client already dead,
 * whose `notify.open` resolves `true`) survived the respawn. The next touch
 * of the same content skipped the write to the replacement, and a
 * silentOnClean server's silence was then confirmed clean for a document it
 * had never been sent (TLA+ `formal/lsp-crash`, `MutNoBindCrashBetweenTouches`
 * and `MutNoBindEvictBetweenTouches`).
 *
 * Production chain: the REAL `LSPService.touchFile` and the REAL
 * `handleNotifyOpen` notify queue per client, over a mock `MessageConnection`
 * (the process boundary). What a client's server holds is read from that
 * real queue's own state (`openDocuments`). The file is dirty: a server that
 * holds it publishes one error, so a "clean" verdict is always false.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const DIRTY = "# broken [link](\n";
const ERROR = {
	severity: 1 as const,
	message: "unclosed link",
	range: {
		start: { line: 0, character: 9 },
		end: { line: 0, character: 16 },
	},
};

function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only client over the real notify queue. Its server publishes the
 * file's error once it holds the document, and is otherwise silent: a wait
 * with nothing held lapses its whole budget on the fake clock.
 */
function makeClient(serverId: string, root: string) {
	const state = createMockState({ root, serverId });
	const holds = (filePath: string) =>
		state.openDocuments.has(normalizeMapKey(filePath));
	const client = {
		serverId,
		root,
		customServer: false,
		state,
		holds,
		// The real client's exit handler: connection closed, process gone.
		kill: () => {
			state.isConnected = false;
			state.isDestroyed = true;
			state.exitedAt ??= Date.now();
		},
		isAlive: () => state.isConnected && !state.isDestroyed,
		wasShutdownIntentional: () => false,
		getExitedAt: () => state.exitedAt,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		notify: {
			open: vi.fn(
				(
					filePath: string,
					content: string,
					languageId: string,
					preserveDiagnostics?: boolean,
					silent?: boolean,
					saved?: boolean,
					readStamp?: number,
				) =>
					clientModule.handleNotifyOpen(
						state,
						filePath,
						content,
						languageId,
						preserveDiagnostics,
						silent,
						saved,
						readStamp,
					),
			),
		},
		getDiagnosticsVersionForPath: (filePath: string) =>
			holds(filePath) ? 1 : 0,
		getDiagnostics: (filePath: string) => (holds(filePath) ? [ERROR] : []),
		getAllDiagnostics: () =>
			new Map(
				[...state.openDocuments].map((key) => [
					key,
					{ diags: [ERROR], ts: Date.now() },
				]),
			),
		getDiagnosticBinding: () => undefined,
		waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
			if (!holds(filePath)) vi.setSystemTime(Date.now() + ms);
		}),
		pingLiveness: vi.fn(async () => client.isAlive()),
	};
	return client;
}

const CLEAN_TS = "const x = 1;\n";

/**
 * A classic typescript-language-server over the same double. Its
 * `typescript.tsserverRequest` sync commands behave as tsserver's do: a dead
 * client does not execute (`runServerCommand`), a tsserver holding no document
 * has no project ("No Project.", the rejection `attemptTsserverSyncDiagnostics`
 * documents), and a loaded project answers for the file's bytes ON DISK, which
 * this fixture only models for the clean sample.
 */
function makeTsClient(root: string) {
	const client = makeClient("typescript", root);
	const syncAsked: boolean[] = [];
	return Object.assign(client, {
		syncAsked,
		getAdvertisedCommands: () => ["typescript.tsserverRequest"],
		executeCommand: vi.fn(async (_command: string, args: unknown[]) => {
			const file = (args[1] as { file: string }).file;
			syncAsked.push(client.holds(file));
			if (!client.isAlive()) {
				return { executed: false, reason: "lsp client not alive" };
			}
			if (client.state.openDocuments.size === 0) {
				throw new Error("No Project.");
			}
			if (fs.readFileSync(file, "utf8") !== CLEAN_TS) {
				return { executed: false, reason: "fixture: dirty disk not modelled" };
			}
			return { executed: true, result: { success: true, body: [] } };
		}),
	});
}

const SYNC = {
	diagnostics: "none" as const,
	clientScope: "primary" as const,
	source: "lsp_sync",
};
const DISPATCH = {
	diagnostics: "document" as const,
	collectDiagnostics: true as const,
	clientScope: "primary" as const,
	source: "dispatch",
};

describe("#3501 — a touch-debounce entry does not outlive its client", () => {
	let tmp: string;
	let filePath: string;
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-crash-respawn-"));
		filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, DIRTY);
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_CLIENT_CEILING;
		removeTempDirSync(tmp);
	});

	/** marksman A serves for over a minute, so its death respawns at once. */
	async function serveMarksman() {
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const A = makeClient("marksman", tmp);
		const B = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		await service.touchFile(path.join(tmp, "warm.md"), "# warm\n", {
			...SYNC,
			source: "warm",
		});
		vi.setSystemTime(Date.now() + 61_000);
		return { service, A, B };
	}

	it.each([
		["after its write landed", "after"],
		["before its write (a dead client's notify resolves true)", "before"],
		["with its write still queued", "queued"],
	] as const)(
		"a server that dies %s between the sync and dispatch touches: the respawned client is sent the document and its error is reported",
		async (_label, when) => {
			const { service, A, B } = await serveMarksman();
			if (when !== "after") {
				const open = A.notify.open.getMockImplementation()!;
				A.notify.open.mockImplementationOnce((...args) => {
					if (when === "before") A.kill();
					const sent = open(...args);
					if (when === "queued") A.kill();
					return sent;
				});
			}

			await service.touchFile(filePath, DIRTY, SYNC);
			if (when === "after") {
				expect(A.holds(filePath)).toBe(true);
				A.kill();
			} else {
				expect(A.holds(filePath)).toBe(false);
			}
			const result = await service.touchFile(filePath, DIRTY, DISPATCH);

			// The pre-#3501 verdict was `confirmed` with no diagnostics: the new
			// server's silence about a document it never received.
			expect({
				confirmation: result?.confirmation,
				diags: result?.diags,
			}).toEqual({
				confirmation: "confirmed",
				diags: [expect.objectContaining({ message: ERROR.message })],
			});
			expect(createLSPClient).toHaveBeenCalledTimes(2);
			expect(B.holds(filePath)).toBe(true);
		},
	);

	it("capacity eviction between the sync and dispatch touches: the replacement client is sent the document", async () => {
		process.env.PI_LENS_LSP_CLIENT_CEILING = "1";
		const marksman = makeServer("marksman", ".md", tmp);
		const lua = makeServer("lua", ".lua", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : fp.endsWith(".lua") ? [lua] : [],
		);
		const A = makeClient("marksman", tmp);
		const L = makeClient("lua", tmp);
		const B = makeClient("marksman", tmp);
		A.shutdown.mockImplementation(async () => A.kill());
		createLSPClient
			.mockResolvedValueOnce(A)
			.mockResolvedValueOnce(L)
			.mockResolvedValueOnce(B);
		const service = new LSPService();

		await service.touchFile(filePath, DIRTY, SYNC);
		await service.touchFile(path.join(tmp, "x.lua"), "local x = 1\n", SYNC);
		const result = await service.touchFile(filePath, DIRTY, DISPATCH);

		expect({
			confirmation: result?.confirmation,
			diags: result?.diags,
		}).toEqual({
			confirmation: "confirmed",
			diags: [expect.objectContaining({ message: ERROR.message })],
		});
		expect(A.shutdown).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(3);
		expect(B.holds(filePath)).toBe(true);
	});

	it("a second non-collecting touch after the crash is not short-circuited: the respawned client is sent the document", async () => {
		const { service, A, B } = await serveMarksman();

		await service.touchFile(filePath, DIRTY, SYNC);
		A.kill();
		await service.touchFile(filePath, DIRTY, SYNC);

		expect(createLSPClient).toHaveBeenCalledTimes(2);
		expect(B.holds(filePath)).toBe(true);
	});

	// The TypeScript sync confirm (#707) asks the registry's client for the
	// file. Before #3501 that was a replacement the debounce never sent the
	// document to; a tsserver holding no document has no project to answer
	// from ("No Project.", the live-verified rejection `attemptTsserverSync
	// Diagnostics` documents), so the touch ended inconclusive.
	it("typescript: the replacement is sent the document before any sync confirm could ask it", async () => {
		const ts = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [ts] : [],
		);
		const tsFile = path.join(tmp, "a.ts");
		const content = "const x: number = 'x';\n";
		fs.writeFileSync(tsFile, content);
		const A = makeTsClient(tmp);
		const B = makeTsClient(tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		await service.touchFile(path.join(tmp, "warm.ts"), "", {
			...SYNC,
			source: "warm",
		});
		vi.setSystemTime(Date.now() + 61_000);

		await service.touchFile(tsFile, content, SYNC);
		A.kill();
		const result = await service.touchFile(tsFile, content, DISPATCH);

		expect({
			inconclusive: result?.inconclusive,
			diags: result?.diags,
		}).toEqual({
			inconclusive: undefined,
			diags: [expect.objectContaining({ message: ERROR.message })],
		});
		expect(B.holds(tsFile)).toBe(true);
		expect(B.syncAsked.every(Boolean)).toBe(true);
	});

	// Review round 1, F1: the sync confirm asked the REGISTRY's client for the
	// file. When the touch's own server died mid-wait and a concurrent touch had
	// already respawned the replacement with its project loaded, the replacement
	// answered for the file's bytes on disk (clean here), never having been sent
	// the touch's content (dirty): a confirmed clean from a client that never saw
	// the document.
	it("typescript: a server that dies mid-wait is not confirmed clean by a replacement answering from disk", async () => {
		const ts = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [ts] : [],
		);
		const tsFile = path.join(tmp, "a.ts");
		fs.writeFileSync(tsFile, CLEAN_TS);
		const dirty = "const x: number = 'x';\n";
		const A = makeTsClient(tmp);
		const B = makeTsClient(tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		await service.touchFile(path.join(tmp, "warm.ts"), "", {
			...SYNC,
			source: "warm",
		});
		vi.setSystemTime(Date.now() + 61_000);
		// A takes the write and dies before publishing; while the touch still
		// waits, a touch of another file respawns B, which loads the project.
		A.getDiagnosticsVersionForPath = () => 0;
		A.getDiagnostics = () => [];
		A.getAllDiagnostics = () => new Map();
		A.waitForDiagnostics.mockImplementationOnce(async (_fp, ms) => {
			A.kill();
			await service.touchFile(path.join(tmp, "b.ts"), "export {};\n", SYNC);
			vi.setSystemTime(Date.now() + ms);
		});

		const result = await service.touchFile(tsFile, dirty, DISPATCH);

		expect(createLSPClient).toHaveBeenCalledTimes(2);
		expect(B.holds(tsFile)).toBe(false);
		expect({
			confirmation: result?.confirmation,
			inconclusive: result?.inconclusive,
			diags: result?.diags,
		}).toEqual({ confirmation: undefined, inconclusive: true, diags: [] });
		expect(B.syncAsked).toEqual([]);
	});

	// The same question from the racing confirm (#707), which asks once the
	// grace lapses while the push wait is still open.
	it("typescript: the racing sync confirm is asked of the touch's own client, not a replacement answering from disk", async () => {
		process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "0";
		try {
			const ts = makeServer("typescript", ".ts", tmp);
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".ts") ? [ts] : [],
			);
			const tsFile = path.join(tmp, "a.ts");
			fs.writeFileSync(tsFile, CLEAN_TS);
			const A = makeTsClient(tmp);
			const B = makeTsClient(tmp);
			createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
			const service = new LSPService();
			await service.touchFile(path.join(tmp, "warm.ts"), "", {
				...SYNC,
				source: "warm",
			});
			vi.setSystemTime(Date.now() + 61_000);
			A.getDiagnosticsVersionForPath = () => 0;
			A.getDiagnostics = () => [];
			A.getAllDiagnostics = () => new Map();
			// A's wait stays open until the racing confirm asks a client, so the
			// race is decided by that answer, whichever client it asks.
			let confirmAsked: () => void = () => {};
			const asked = new Promise<void>((resolve) => {
				confirmAsked = resolve;
			});
			for (const client of [A, B]) {
				const execute = client.executeCommand.getMockImplementation();
				client.executeCommand.mockImplementation(async (command, args) => {
					confirmAsked();
					return execute!(command, args);
				});
			}
			A.waitForDiagnostics.mockImplementationOnce(async (_fp, ms) => {
				A.kill();
				await service.touchFile(path.join(tmp, "b.ts"), "export {};\n", SYNC);
				await asked;
				vi.setSystemTime(Date.now() + ms);
			});

			const result = await service.touchFile(
				tsFile,
				"const x: number = 'x';\n",
				DISPATCH,
			);

			expect({
				confirmation: result?.confirmation,
				inconclusive: result?.inconclusive,
				diags: result?.diags,
			}).toEqual({ confirmation: undefined, inconclusive: true, diags: [] });
			expect(B.syncAsked).toEqual([]);
		} finally {
			delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
		}
	});
});

/**
 * #3502: a crash-respawn retires the dead client's readiness verdicts.
 *
 * Recurrence this file prevents: `ensureClientForServer`'s dead-client
 * branch deleted the client, its spawn stamp, idle timer and broken entry,
 * but not `demonstratedReady` or `demonstratedCold`, which capacity and idle
 * eviction both delete. The cold replacement inherited the dead client's
 * readiness, so `ensureWarmForSweep` skipped its warm-up (TLA+
 * `formal/lsp-crash`, `MutCrashReadyNoClear`), or inherited its cold verdict
 * and was never given a warm-up of its own.
 */
describe("#3502 — a crash-respawn does not inherit readiness", () => {
	let tmp: string;
	let filePath: string;
	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-crash-ready-"));
		filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, DIRTY);
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
		vi.useFakeTimers({ toFake: ["Date"] });
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		removeTempDirSync(tmp);
	});

	/** A dies after a minute of service; a touch of another file respawns B. */
	async function crashAndRespawn(
		service: LSPService,
		A: ReturnType<typeof makeClient>,
	) {
		vi.setSystemTime(Date.now() + 61_000);
		A.kill();
		await service.touchFile(path.join(tmp, "b.md"), "# b\n", SYNC);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
	}

	/** A wedged server: it takes the document but never answers or pings. */
	function wedged(client: ReturnType<typeof makeClient>) {
		client.getDiagnosticsVersionForPath = () => 0;
		client.getDiagnostics = () => [];
		client.getAllDiagnostics = () => new Map();
		client.waitForDiagnostics.mockImplementation(async (_fp, ms) => {
			vi.setSystemTime(Date.now() + ms);
		});
		client.pingLiveness.mockResolvedValue(false);
		return client;
	}

	it("the replacement of a client that demonstrated readiness gets its own warm-up", async () => {
		const A = makeClient("marksman", tmp);
		const B = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		const first = await service.touchFile(filePath, DIRTY, DISPATCH);
		expect(first?.confirmation).toBe("confirmed");
		expect(await service.ensureWarmForSweep(filePath)).toMatchObject({
			performedWarmup: false,
		});

		await crashAndRespawn(service, A);
		const warm = await service.ensureWarmForSweep(filePath);

		expect(warm).toEqual({ performedWarmup: true, failedServerIds: [] });
		expect(B.waitForDiagnostics.mock.calls.map(([fp]) => fp)).toContain(
			filePath,
		);
	});

	it("the replacement of a client that stayed cold gets its own warm-up, not the cached cold verdict", async () => {
		const A = wedged(makeClient("marksman", tmp));
		const B = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		expect(await service.ensureWarmForSweep(filePath)).toEqual({
			performedWarmup: true,
			failedServerIds: ["marksman"],
		});

		await crashAndRespawn(service, A);
		const warm = await service.ensureWarmForSweep(filePath);

		expect(warm).toEqual({ performedWarmup: true, failedServerIds: [] });
	});

	// Review round 1, F2: the ready mark lands after awaits. A client that
	// answered, then died while a concurrent touch respawned its replacement
	// (whose dead-client branch forgets the key), re-marked the key ready for a
	// replacement that had answered nothing.
	it("a client that dies after answering does not mark its concurrent replacement ready", async () => {
		const A = makeClient("marksman", tmp);
		const B = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
		const service = new LSPService();
		A.waitForDiagnostics.mockImplementationOnce(async () => {
			// A holds the file and has published; then it dies after a minute of
			// service, and a touch of another file respawns B.
			vi.setSystemTime(Date.now() + 61_000);
			A.kill();
			await service.touchFile(path.join(tmp, "b.md"), "# b\n", SYNC);
		});

		const first = await service.touchFile(filePath, DIRTY, DISPATCH);
		expect(first?.confirmation).toBe("confirmed");
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		const warm = await service.ensureWarmForSweep(filePath);

		expect(warm).toEqual({ performedWarmup: true, failedServerIds: [] });
		expect(B.waitForDiagnostics.mock.calls.map(([fp]) => fp)).toContain(
			filePath,
		);
	});

	// Review round 1, F3: the notify-stall demotion forgot `demonstratedReady`
	// but kept `demonstratedCold`, so the server that came back after the
	// cooldown was skipped as known cold without a warm-up of its own.
	it("a notify-stall demotion forgets the cached cold verdict: the server back from its cooldown gets its own warm-up", async () => {
		vi.useFakeTimers();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "100";
		try {
			const A = wedged(makeClient("marksman", tmp));
			const B = makeClient("marksman", tmp);
			createLSPClient.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
			const service = new LSPService();
			expect(await service.ensureWarmForSweep(filePath)).toEqual({
				performedWarmup: true,
				failedServerIds: ["marksman"],
			});
			// Three writes that never land demote A (#743).
			A.notify.open.mockImplementation(() => new Promise<boolean>(() => {}));
			for (let i = 0; i < 3; i++) {
				const touch = service.touchFile(filePath, `# ${i}\n`, SYNC);
				await vi.advanceTimersByTimeAsync(120);
				await touch;
			}
			await vi.advanceTimersByTimeAsync(0);
			expect(A.shutdown).toHaveBeenCalled();
			// Past the 15 s broken cooldown.
			await vi.advanceTimersByTimeAsync(16_000);

			const warm = await service.ensureWarmForSweep(filePath);

			expect(warm).toEqual({ performedWarmup: true, failedServerIds: [] });
			expect(createLSPClient).toHaveBeenCalledTimes(2);
		} finally {
			delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		}
	});
});
