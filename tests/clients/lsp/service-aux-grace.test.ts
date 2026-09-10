/**
 * R8 (#714) — per-result early-unblock: slow auxiliary grace tests.
 *
 * Verifies that:
 *  1. Fast primary + slow aux: touchFile completes at ~primary+auxGrace, not at
 *     the aux deadline.
 *  2. Aux answering within grace: its diagnostics are included in the result.
 *  3. Slow primary: full wait as today (aux settling early does not shortcut
 *     primary confirmation).
 *  4. Primary-only path: zero new code path entered (grace timer never fires).
 *  5. getDiagnostics: fast primary + slow aux completes before aux deadline.
 *
 * Also covers the raceToCompletion aux-grace unit-level behaviour via the
 * aggregation.test.ts file; these tests exercise the service-level wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

// importActual spread: the #2776 test loads the REAL tools/lens-diagnostics.js,
// whose config.js import surface grows over time — a closed factory breaks on
// every added export (resolveLspCwdForFile, #2777). The bare spread is also
// the spelling the #2281 detector recognizes as pass-through, so this mock
// needs no baseline admission. The overrides below stay explicit.
vi.mock("../../../clients/lsp/config.js", async (importActual) => ({
	...(await importActual()),
	getServersForFileWithConfig,
	primaryServerId: vi.fn(() => "ts-primary"),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.ts";
const AUX_GRACE_MS = 500; // Default PI_LENS_AUX_GRACE_MS

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

/** A language-primary server (no role, defaults to "language"). */
function makePrimaryServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

/** An auxiliary server (role:"auxiliary"). */
function makeAuxServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		role: "auxiliary" as const,
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeDiagnostic(
	message: string,
): import("../../../clients/lsp/client.js").LSPDiagnostic {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

/**
 * A fake LSP client whose waitForDiagnostics resolves after `delayMs` ms and
 * whose getDiagnostics returns `diags` only AFTER the wait has resolved
 * (simulating real LSP push behaviour: diagnostics land in the client's cache
 * when the server publishes them, which is what waitForDiagnostics waits for).
 */
function makeClient(
	delayMs: number,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	options: {
		serverId?: string;
		/**
		 * #1493: publish on settle even with an EMPTY diagnostics set — a scanner
		 * that ran to budget and found nothing. Production bumps
		 * `diagnosticsVersion` for that publish too (client.ts stores the empty
		 * array like any other), which is what makes "clean" distinguishable from
		 * "never spoke". Default false so the existing probes keep meaning "settled
		 * without publishing".
		 */
		publishesWhenClean?: boolean;
	} = {},
) {
	let waitSettled = false;
	let version = 0;
	// #1531: production stamps the PATH each publication was stored for, and both
	// the wait's freshness gate and the aux evidence check read that stamp. A
	// single-file double can key every stamp off the one file it is touched with;
	// `makePathAwareAuxClient` below models the multi-file case.
	const stampsByPath = new Map<string, number>();
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		// #1458 S6: production always sets `serverId` on the real client
		// (`createLSPClient({ serverId: server.id, ... })` in index.ts) and the
		// per-server budget lookup (`perServerTimeout`) matches entries by
		// `entry.client.serverId`. A double that omits it silently falls
		// through that match to a different branch, so a budgetMs assertion
		// can pass without exercising the real lookup at all. Always pass
		// `options.serverId` matching the server descriptor's id.
		serverId: options.serverId,
		// #1458 S1: a real publish advances `diagnosticsVersion` (client.ts
		// `recordBinding`/push handling). This is a GETTER (not a static
		// field) so the evidence-based aux-outcome check can observe the
		// bump. Spreading this object (`{...makeClient(...)}`) evaluates the
		// getter once and freezes its value — callers that need a live
		// version must construct via `options.serverId` instead of spreading.
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		// Only returns diagnostics after waitForDiagnostics has resolved,
		// matching real client behaviour (server pushes → client caches → wait resolves).
		getDiagnostics: vi.fn(() => (waitSettled ? diags : [])),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string, timeoutMs: number) =>
				new Promise<void>((resolve) =>
					setTimeout(
						() => {
							const fitWithinBudget = delayMs <= timeoutMs;
							if (fitWithinBudget) waitSettled = true;
							// A genuine publish is what advances the version on a real
							// client; a settle with NOTHING published must not, or the
							// evidence-based outcome check below can't tell the two apart.
							// #1493: an empty publish is still a publish — opt into it with
							// `publishesWhenClean` to model a scanner that ran and found
							// nothing.
							if (
								fitWithinBudget &&
								(diags.length > 0 || options.publishesWhenClean)
							) {
								version += 1;
								stampsByPath.set(filePath, version);
							}
							resolve();
						},
						Math.min(delayMs, timeoutMs),
					),
				),
		),
	};
}

function makeLateBoundClient(content: string, serverId = "opengrep") {
	let published = false;
	const diagnostic = makeDiagnostic("late aux finding");
	return {
		...makeClient(2500, [], { serverId }),
		getDiagnostics: vi.fn(() => (published ? [diagnostic] : [])),
		getDiagnosticBinding: vi.fn(() =>
			published ? { contentHash: hashDiagnosticContent(content) } : undefined,
		),
		notify: {
			open: vi.fn(async () => {
				published = false;
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						published = true;
						resolve();
					}, 2500),
				),
		),
	};
}

/**
 * #1531: an auxiliary that models production's version bookkeeping faithfully.
 * A real client keeps a per-client GLOBAL `diagnosticsVersion` that ANY path's
 * publication advances, plus a per-path stamp recording the counter's value at
 * that publication (`bumpDiagnosticsVersion` in client.ts). `publishesFor` is
 * the set of files this scanner actually reports on; a touch of any other file
 * settles its wait having published nothing for that file.
 *
 * The getter and `getDiagnosticsVersionForPath` are declared AFTER the spread on
 * purpose: spreading `makeClient(...)` evaluates its `diagnosticsVersion` getter
 * once and freezes the value, so the live readings must be redefined here.
 */
function makePathAwareAuxClient(
	publishesFor: string[],
	delayMs: number,
	serverId = "opengrep",
) {
	let version = 0;
	const stampsByPath = new Map<string, number>();
	const publishable = new Set(publishesFor);
	return {
		...makeClient(delayMs, [], { serverId }),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						if (publishable.has(filePath)) {
							version += 1;
							stampsByPath.set(filePath, version);
						}
						resolve();
					}, delayMs),
				),
		),
	};
}

/**
 * #1458 S7: a version-less publish (server never reports `publishDiagnostics.
 * version`) makes `client.ts`'s `recordBinding` DELETE any stored binding
 * (`docVersion === undefined` branch) — never resurrect a stale one, never
 * synthesize a contentHash. `getDiagnosticBinding` must therefore keep
 * returning `undefined` even after diagnostics genuinely landed, so the
 * carry-over check (`binding?.contentHash !== touchContentHash`) fails
 * closed instead of replaying an unverifiable late result.
 */
function makeVersionlessLateClient(serverId = "opengrep") {
	let published = false;
	const diagnostic = makeDiagnostic("late aux finding");
	return {
		...makeClient(2500, [], { serverId }),
		getDiagnostics: vi.fn(() => (published ? [diagnostic] : [])),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			open: vi.fn(async () => {
				published = false;
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						published = true;
						resolve();
					}, 2500),
				),
		),
	};
}

describe("R8 — aux grace: touchFile with-auxiliary path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	it("partitions real lens_diagnostics results by delivering server id (#2776)", async () => {
		vi.useRealTimers();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-provenance-"));
		const file = path.join(root, "main.ts");
		fs.writeFileSync(file, "const value = 1;\n");
		try {
			const { createLensDiagnosticsTool } =
				await import("../../../tools/lens-diagnostics.js");
			const primary = makePrimaryServer("ts-primary");
			const auxiliary = makeAuxServer("auxiliary-profile");
			getServersForFileWithConfig.mockReturnValue([primary, auxiliary]);
			const primaryClient = makeClient(
				0,
				[{ ...makeDiagnostic("eslint primary"), source: "eslint" }],
				{ serverId: "ts-primary" },
			);
			const auxiliaryClient = makeClient(
				0,
				[{ ...makeDiagnostic("auxiliary finding"), source: "auxiliary" }],
				{ serverId: "auxiliary-profile" },
			);
			createLSPClient
				.mockResolvedValueOnce(primaryClient)
				.mockResolvedValueOnce(auxiliaryClient);

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const result = await createLensDiagnosticsTool(
				{ readCache: vi.fn() } as never,
				() => root,
				() => service,
			).execute(
				"provenance-2776",
				{ mode: "full", paths: [file], refreshRunners: "none" },
				new AbortController().signal,
				null,
				{ cwd: root },
			);
			const details = result.details as {
				lspPrimaryDiagnosticsCount?: number;
				lspAuxiliaryDiagnosticsCount?: number;
			};
			expect(details.lspPrimaryDiagnosticsCount).toBe(1);
			expect(details.lspAuxiliaryDiagnosticsCount).toBe(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("completes at primary+auxGrace, not at the aux deadline", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles quickly; aux takes 3000ms (well beyond grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(3000, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		// getServersForFileWithConfig drives candidate lookup; both servers
		// must appear so the service considers spawning them.
		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);

		// Primary comes first (getClientForFile), aux second (getAuxiliaryClientsForFile).
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		// Warm both into the cache.
		await service.getClientsForFile(FILE);
		// Re-mock for auxiliary lookup (getAuxiliaryClientsForFile uses a separate call).
		createLSPClient.mockReset();

		// For this touch the service resolves primary via getClientForFile and
		// auxiliary via getAuxiliaryClientsForFile. Since clients are already cached
		// (ensureClientForServer returns from state), no further createLSPClient calls
		// are needed — but we need both clients in the cache first.
		// Simplest approach: warm both clients again via a second getClientsForFile
		// (they deduplicate inside the service state).
		const touchPromise = service.touchFile(FILE, "content", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance to primary settling (100ms).
		await vi.advanceTimersByTimeAsync(100);
		// Advance through aux grace window (500ms). Aux is still at 3000ms.
		await vi.advanceTimersByTimeAsync(AUX_GRACE_MS + 10);

		const result = await touchPromise;
		// Touch resolved before aux deadline (3000ms) — we only waited ~610ms.
		// Primary diagnostics included.
		expect(Array.isArray(result?.diags)).toBe(true);
		// Aux was cut off — its diagnostics may or may not be present depending
		// on whether it resolved before the grace expired. Since aux takes 3000ms
		// and grace is 500ms, aux is NOT included.
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		// Primary must be included (it answered before grace).
		expect(messages).toContain("primary error");
		// Aux must NOT be included (it didn't answer within grace).
		expect(messages).not.toContain("aux finding");
	});

	it("includes aux diagnostics when aux answers within grace", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles at 100ms, aux settles at 400ms (within 500ms grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(400, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content2", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance past primary (100ms) + aux (400ms) — all within grace (500ms).
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		// Both must be present — aux answered within grace.
		expect(messages).toContain("primary error");
		expect(messages).toContain("aux finding");
	});

	it("gives an auxiliary its declared budget up to the global ceiling", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeClient(100, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		// Opengrep's declared 3500ms budget exceeds the 2000ms global aux ceiling,
		// but its measured ~1.3s warm scan must no longer be cut off at 500ms.
		const auxClient = makeClient(1300, [makeDiagnostic("aux finding")], {
			serverId: "opengrep",
		});

		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);
		const touchPromise = service.touchFile(FILE, "content-budget", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		await vi.advanceTimersByTimeAsync(1310);
		const result = await touchPromise;
		expect(result).toBeDefined();
		expect(result?.diags.map((diagnostic) => diagnostic.message)).toContain(
			"aux finding",
		);
	});

	it.each([
		{ observedMs: 1000, expectedFinding: false },
		{ observedMs: 2500, expectedFinding: true },
	])(
		"tracks a cold typos spawn of $observedMs ms instead of using a flat grace",
		async ({ observedMs, expectedFinding }) => {
			const { LSPService, auxWaitBudgetMs } =
				await import("../../../clients/lsp/index.js");
			const {
				recordSuccessfulLspSpawn,
				_clearSuccessfulLspSpawnHistoryForTests,
			} = await import("../../../clients/lsp/spawn-history.js");
			_clearSuccessfulLspSpawnHistoryForTests();
			recordSuccessfulLspSpawn("typos", observedMs);
			expect(auxWaitBudgetMs("typos", true, undefined, 1500)).toBe(
				observedMs === 1000 ? 1500 : 3000,
			);
			const service = new LSPService();
			const auxServer = makeAuxServer("typos");
			auxServer.spawn.mockImplementation(
				async () =>
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ process: makeFakeProcess(), source: "test" }),
							observedMs,
						),
					),
			);
			getServersForFileWithConfig.mockReturnValue([
				makePrimaryServer("ts-primary"),
				auxServer,
			]);
			const auxClient = makeClient(2500, [makeDiagnostic("cold aux finding")], {
				serverId: "typos",
			});
			createLSPClient
				.mockResolvedValueOnce(
					makeClient(100, [makeDiagnostic("primary-only sentinel")], {
						serverId: "ts-primary",
					}),
				)
				.mockResolvedValueOnce(auxClient);

			const touch = service.touchFile(FILE, "cold-adaptive", {
				clientScope: "with-auxiliary",
				auxiliaryServerIds: ["typos"],
				collectDiagnostics: true,
				diagnostics: "document",
			});
			await vi.advanceTimersByTimeAsync(observedMs + 2600);
			const result = await touch;
			expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(
				FILE,
				expectedFinding ? 3000 : 1500,
				expect.objectContaining({ minVersion: 0 }),
			);
			expect(result?.diags.map((diagnostic) => diagnostic.message)).toContain(
				expectedFinding ? "cold aux finding" : "primary-only sentinel",
			);
		},
	);

	it("clamps a cold auxiliary budget at 8000 ms", async () => {
		const { auxWaitBudgetMs } = await import("../../../clients/lsp/index.js");
		const {
			recordSuccessfulLspSpawn,
			_clearSuccessfulLspSpawnHistoryForTests,
		} = await import("../../../clients/lsp/spawn-history.js");
		_clearSuccessfulLspSpawnHistoryForTests();
		recordSuccessfulLspSpawn("typos", 9000);
		expect(auxWaitBudgetMs("typos", true, undefined, 1500)).toBe(8000);
	});

	it("still waits for slow primary even if aux settles early", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Aux settles fast; primary is slow.
		const primaryClient = makeClient(1200, [makeDiagnostic("primary error")], {
			serverId: "ts-primary",
		});
		const auxClient = makeClient(50, [makeDiagnostic("aux finding")], {
			serverId: "opengrep-aux",
		});

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content3", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// At 600ms: aux is done (50ms), grace would have expired, but PRIMARY is
		// still pending (1200ms). The touch must NOT have resolved yet.
		await vi.advanceTimersByTimeAsync(600);
		let resolved = false;
		touchPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance to primary settling.
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result?.diags ?? []).map(
			(d: { message: string }) => d.message,
		);
		expect(messages).toContain("primary error");
	});

	it("carries a late bound auxiliary publication into the next unchanged read", async () => {
		const content = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeLateBoundClient(content));
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await first)?.diags).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect(
			(await next)?.diags.map((diagnostic) => diagnostic.message),
		).toContain("late aux finding");
	});

	it("rejects a late auxiliary publication when the next read changes content", async () => {
		const oldContent = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeLateBoundClient(oldContent));
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, oldContent, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		await first;
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, "const value = 2;", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await next)?.diags).toHaveLength(0);
	});

	it("logs a cut-off auxiliary outcome when the grace timer wins the race", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeClient(3000, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "telemetry", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		await touch;

		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_aux_wait_outcome",
				metadata: expect.objectContaining({
					outcomes: [
						expect.objectContaining({
							serverId: "opengrep",
							// #1458 S1: the grace timer (2000ms) wins over the aux's own
							// 3000ms wait — "cut_off", not "settled"/"answered".
							outcome: "cut_off",
							budgetMs: 2000,
							elapsedSinceNotifyMs: expect.any(Number),
						}),
					],
				}),
			}),
		);
	});

	// #1458 S1: `waitForDiagnostics` RESOLVES on its own timeout and never
	// rejects (client.ts) — so a silent auxiliary's promise settling within
	// budget looks, promise-wise, identical to one that actually answered.
	// The outcome must be decided from EVIDENCE (a `diagnosticsVersion` bump)
	// rather than from whether the raced promise settled before the grace
	// timer. Reproduces the reviewer's repro: primary settles, opengrep
	// settles silently (no publish) well within its budget — must record
	// "silent", never "answered"/"settled".
	it("does not record a silent auxiliary as answered (evidence-based outcome)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		// Primary settles at 800ms. Aux's OWN wait resolves at 900ms (well
		// within its ~2000ms budget) but publishes NOTHING — this is the
		// "silent scanner" case: the promise settles, but no evidence exists
		// that a publication landed.
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(800, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(makeClient(900, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "silent-aux", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(800);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(10);
		await touch;

		const call = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		);
		expect(call).toBeDefined();
		const outcomes = call?.[0]?.metadata?.outcomes as
			| Array<{ serverId: string; outcome: string }>
			| undefined;
		expect(outcomes).toEqual([
			expect.objectContaining({ serverId: "opengrep", outcome: "silent" }),
		]);
		// The mutation this pins against: recording the outcome as "settled"
		// whenever the raced promise resolves (rather than from evidence) would
		// mark this silent scanner "answered"/"settled" — it must not.
		expect(outcomes?.[0]?.outcome).not.toBe("answered");
		expect(outcomes?.[0]?.outcome).not.toBe("settled");
	});

	// #1531: `diagnosticsVersion` is a per-CLIENT counter, so a publication for
	// file A advances it for every file in flight on that client. The evidence
	// check used to read it directly, which handed a concurrent touch of file B an
	// `answered` row for a publication that never mentioned B — a false clean in
	// exactly the field data used to reason about auxiliary health. Two files, one
	// aux client, publication only for A: B's row must read `silent`.
	it("does not read a sibling file's publication as an answer for this file", async () => {
		const FILE_A = "C:/repo/a.ts";
		const FILE_B = "C:/repo/b.ts";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		// One primary and one auxiliary client, shared by both files (same root,
		// same server ids) — which is what makes the counter shared.
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makePathAwareAuxClient([FILE_A], 900));
		await service.getClientsForFile(FILE_A);
		await service.getClientsForFile(FILE_B);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document" as const,
		};
		const touchA = service.touchFile(FILE_A, "a", touchOptions);
		const touchB = service.touchFile(FILE_B, "b", touchOptions);
		await vi.advanceTimersByTimeAsync(2110);
		await Promise.all([touchA, touchB]);

		const rowFor = (suffix: string) => {
			const call = logLatency.mock.calls.find(
				([entry]) =>
					entry.phase === "lsp_aux_wait_outcome" &&
					String(entry.filePath).endsWith(suffix),
			);
			const outcomes = call?.[0]?.metadata?.outcomes as
				| Array<{ serverId: string; outcome: string }>
				| undefined;
			return outcomes?.find((o) => o.serverId === "opengrep");
		};

		// The aux DID publish for A within its grace — A keeps its answer.
		expect(rowFor("a.ts")?.outcome).toBe("answered");
		// B's wait settled inside the grace too, but nothing was published for B.
		// Pre-#1531 this read the global counter (advanced by A) and recorded
		// "answered".
		expect(rowFor("b.ts")?.outcome).not.toBe("answered");
		expect(rowFor("b.ts")?.outcome).toBe("silent");
	});

	it("rejects a version-less late auxiliary publication (recordBinding fails closed, #1458 S7)", async () => {
		const content = "const value = 1;";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeVersionlessLateClient());
		await service.getClientsForFile(FILE);

		const first = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		expect((await first)?.diags).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(400);

		const next = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(2110);
		// The auxiliary DID publish (getDiagnostics now returns a finding), but
		// the publish was version-less, so no binding was ever recorded —
		// carry must fail closed rather than replay an unverifiable result.
		expect((await next)?.diags).toHaveLength(0);
	});
});

describe("R8 — aux grace: getDiagnostics with-auxiliary path (#1458 S2 extend)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	// #1458 S2: the SECOND aux-wait implementation (raceToCompletion, used by
	// LSPService.getDiagnostics — the path actionable-warnings.ts hits on a
	// content-hash cache miss) used to hand every auxiliary a flat 500ms
	// grace regardless of its declared budget, starving the exact same
	// opengrep warm-run figure the touchFile fix (S2 above) was built around.
	// Extending PromiseDescriptor.budgetMs to raceToCompletion closes that
	// second lane with the identical declared-budget-capped-by-ceiling shape.
	it("includes a warm auxiliary (1300ms) that a flat 500ms default would have starved", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(100, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(
				makeClient(1300, [makeDiagnostic("aux finding")], {
					serverId: "opengrep",
				}),
			);
		await service.getClientsForFile(FILE);
		createLSPClient.mockReset();

		// "document" mode → 0ms quality grace, so only the aux-grace ceiling
		// governs (matches touchFile's test scenarios and isolates the aux
		// budget behavior from the unrelated early-unblock quality grace).
		const diagnosticsPromise = service.getDiagnostics(FILE, "document");
		await vi.advanceTimersByTimeAsync(1300);
		await vi.advanceTimersByTimeAsync(10);

		const diags = await diagnosticsPromise;
		const messages = diags.map((d) => d.message);
		expect(messages).toContain("primary error");
		expect(messages).toContain("aux finding");
	});
});

describe("R8 — aux grace: raceToCompletion per-role unit tests", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("completes at primary+auxGrace when primary fast and aux slow", async () => {
		const { raceToCompletion } =
			await import("../../../clients/lsp/aggregation.js");

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const slow = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 3000),
		);

		const resultPromise = raceToCompletion(
			[fast, slow],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No additional quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Primary settles at 100ms; aux grace starts. At 600ms grace expires.
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		// Should have resolved at ~610ms with only primary result (aux at 3000ms).
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});

	it("includes aux result when it answers within auxGrace", async () => {
		const { raceToCompletion } =
			await import("../../../clients/lsp/aggregation.js");

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 2 }), 400),
		);

		const resultPromise = raceToCompletion(
			[fast, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0,
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Advance past aux (400ms). Primary settled at 100ms, aux grace = 500ms.
		// Aux answers at 400ms, which is within grace → both included.
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id).sort()).toEqual(["aux", "primary"]);
	});

	it("primary-only path: aux grace timer never fires", async () => {
		const { raceToCompletion } =
			await import("../../../clients/lsp/aggregation.js");
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

		const p1 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 1 }), 50),
		);
		const p2 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "b", count: 1 }), 80),
		);

		const resultPromise = raceToCompletion(
			[p1, p2],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 1500,
				graceMs: 0,
				// No descriptors with role:"auxiliary" → aux-grace path not entered.
				descriptors: [{ role: "primary" }, { role: "primary" }],
				auxGraceMs: 500,
			},
		);

		const callCountBefore = setTimeoutSpy.mock.calls.length;

		await vi.advanceTimersByTimeAsync(80);
		await vi.advanceTimersByTimeAsync(10);
		await resultPromise;

		// No NEW setTimeout calls beyond the hard-timeout one set up at entry
		// should be for the aux grace (500ms). Verify by checking that no
		// 500ms setTimeout was scheduled.
		const newCalls = setTimeoutSpy.mock.calls.slice(callCountBefore);
		const auxGraceTimers = newCalls.filter(([, ms]) => ms === 500);
		expect(auxGraceTimers).toHaveLength(0);
	});

	it("slow primary: aux settling early does not finalize the race early", async () => {
		const { raceToCompletion } =
			await import("../../../clients/lsp/aggregation.js");

		// Aux resolves fast; primary is slow.
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 0 }), 1200),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 5 }), 50),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			// shouldComplete triggers when any has count > 0 — aux satisfies it at 50ms.
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// At 600ms: aux is done (50ms), aux grace has expired, but PRIMARY is
		// still pending (1200ms). Race must NOT have resolved yet — primary is
		// not settled so aux-grace can't have started.
		let resolved = false;
		resultPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance past primary.
		await vi.advanceTimersByTimeAsync(700);
		await vi.advanceTimersByTimeAsync(10);
		const result = await resultPromise;
		expect(result.find((r) => r.id === "primary")).toBeDefined();
	});
});

/**
 * #1470/#1493 — an auxiliary that never reported must not yield a conclusive
 * touch.
 *
 * The three-way probe the #1458 review used, promoted from telemetry into the
 * touch's own honesty state. What the touch CLAIMS in each case:
 *
 *   - published within grace       → `confirmation: "confirmed"` (#1470)
 *   - hung, grace timer wins       → `confirmation: "partial"` naming it (#1470)
 *   - silent inside its own budget → `confirmation: "partial"` naming it (#1493)
 *
 * The defect #1470 closed: the hung case resolved `confirmation: "confirmed"`
 * with `inconclusive: undefined`, so a hung opengrep read as confirmed-clean on
 * the security lane. #1493 closed the same overclaim on the sibling outcome — a
 * silent scanner carries exactly as little evidence as a hung one, and only its
 * habit of burning the whole touch deadline when it was the ONLY auxiliary kept
 * that honest. A fast sibling let the wait settle early and the silence went
 * unrecorded.
 *
 * Both narrowings run through the one `auxiliaryCoverageGap` policy in
 * `diagnostic-binding.ts`. What keeps the signal alive is that `answered` is
 * decided by a PUBLICATION landing, not by findings existing: a scanner that ran
 * to budget and published an empty set is covered, and its touch stays clean.
 */
describe("#1470 — cut-off auxiliary honesty", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	/**
	 * Drives one touch with a primary that answers at 800ms and a single
	 * auxiliary whose own wait settles at `auxDelayMs`, then returns both the
	 * touch result and the `lsp_aux_wait_outcome` row it produced — so each probe
	 * can assert that the telemetry outcome and the claimed confirmation agree.
	 */
	async function probe(
		auxDelayMs: number,
		auxDiags: ReturnType<typeof makeDiagnostic>[],
	) {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(
				makeClient(auxDelayMs, auxDiags, { serverId: "opengrep" }),
			);
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "probe", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		// 800 (primary) + 2000 (aux ceiling) + slack covers every probe.
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ serverId: string; outcome: string }>
			| undefined;
		return { result, outcome: outcomes?.[0]?.outcome };
	}

	it("a HUNG auxiliary (cut_off) narrows the confirmation and names the server", async () => {
		// Aux wait outlives the 2000ms ceiling → our grace timer wins.
		const { result, outcome } = await probe(3000, [makeDiagnostic("never")]);
		expect(outcome).toBe("cut_off");
		// The defect: this was "confirmed" with no coverage caveat at all.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// NARROWED, not collapsed — the primary answered, so the touch is not
		// inconclusive and its diagnostics are not discarded (#533 cuts both ways).
		expect(result?.inconclusive).toBeUndefined();
	});

	// CLASS SWEEP (#1470's own acceptance criterion). opengrep is the scanner the
	// issue was reported against, and under today's DEFAULTS it is the only
	// auxiliary that can reach the cut-off shape: `budgetMs = Math.min(
	// timeoutFor(id), auxCeilingMs)` (index.ts), and the aux's OWN
	// `waitForDiagnostics` timer is armed when `perServerWaits` is built —
	// strictly before the grace timer, which is armed only after
	// `Promise.all(primaryWaits)`. So when the two budgets are equal the aux's
	// own timer always resolves first and the race reads "answered", never
	// "cut_off". `cut_off` therefore requires the ceiling to be STRICTLY LESS
	// than the declared budget: opengrep (3500) qualifies against the 2000
	// default; zizmor (2000) never can, and ast-grep (1800) and typos (1500)
	// cannot either.
	//
	// What those three do INSTEAD is settle SILENTLY inside their own budget,
	// which #1470 left reading as an unqualified confirmation and #1493 now
	// narrows the same way — see the silent probes below.
	//
	// The cut-off boundary is a property of today's numbers, not of the code:
	// `PI_LENS_AUX_GRACE_MS` moves the ceiling for every auxiliary, and any budget
	// change moves the boundary. So the narrowing is keyed on `role ===
	// "auxiliary"` — the same predicate that builds `auxWaits` — never on a server
	// id. Lowering the ceiling puts each of the four into the cut-off shape and
	// each must narrow identically.
	it.each(["opengrep", "ast-grep", "zizmor", "typos"])(
		"narrows the confirmation for a cut-off %s, not just opengrep",
		async (auxId) => {
			// Ceiling well under every declared budget, so the grace timer wins with
			// the touch's own deadline (the aux's declared budget) still far away.
			process.env.PI_LENS_AUX_GRACE_MS = "300";
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			getServersForFileWithConfig.mockReturnValue([
				makePrimaryServer("ts-primary"),
				makeAuxServer(auxId),
			]);
			createLSPClient
				.mockResolvedValueOnce(makeClient(100, [], { serverId: "ts-primary" }))
				.mockResolvedValueOnce(makeClient(9000, [], { serverId: auxId }));
			await service.getClientsForFile(FILE);

			const touch = service.touchFile(FILE, "sweep", {
				clientScope: "with-auxiliary",
				auxiliaryServerIds: [auxId],
				collectDiagnostics: true,
				diagnostics: "document",
			});
			await vi.advanceTimersByTimeAsync(500);
			const result = await touch;
			expect(result?.confirmation).toBe("partial");
			expect(result?.unconfirmedServerIds).toEqual([auxId]);
		},
	);

	it("#1493: a SILENT auxiliary narrows the confirmation and names the server", async () => {
		// Aux settles at 900ms, inside its own budget, publishing nothing — the
		// same silent-scanner shape #1458's evidence-based outcome test uses.
		//
		// This test was #1470's regression fence, asserting the false clean
		// (`confirmation: "confirmed"`, no `inconclusive`, empty `diags`) so #1493's
		// fix had to come through this file. It now asserts the narrowed verdict: a
		// scanner that said nothing carries exactly as little evidence as a cut-off
		// one, so the touch withdraws its claim of that server's coverage.
		const { result, outcome } = await probe(900, []);
		expect(outcome).toBe("silent");
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// NARROWED, not collapsed — the primary answered at 800ms, so the touch
		// keeps its findings and is not inconclusive (#533 cuts both ways).
		expect(result?.inconclusive).toBeUndefined();
		expect(result?.diags).toEqual([]);
	});

	it("#1493: an auxiliary that ran to budget and published nothing keeps the touch clean", async () => {
		// The overcorrection guard the issue asks for. A scanner that ran and found
		// nothing PUBLISHES an empty set, which advances `diagnosticsVersion` in
		// production exactly like a finding does, so the evidence-based outcome is
		// `answered` and the touch stays an unqualified clean bill of health. This
		// is what keeps the fix above from demoting nearly every result.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(
				makeClient(900, [], {
					serverId: "opengrep",
					publishesWhenClean: true,
				}),
			);
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "clean", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as Array<{ outcome: string }> | undefined;
		expect(outcomes?.[0]?.outcome).toBe("answered");
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
		expect(result?.diags).toEqual([]);
	});

	it("#1493: a silent auxiliary is named even when a sibling answers fast", async () => {
		// The reported shape. opengrep answers at 400ms, typos stays silent through
		// its 1500ms budget. The aux `Promise.all` settles at ~1500ms — inside the
		// 2500ms touch deadline — so `diagnosticsTimedOut` never fires and, before
		// this fix, the fast sibling's answer let the touch resolve
		// `{ confirmation: "confirmed", diags: [], inconclusive: undefined }` while
		// typos had said nothing about the file. Only the silent server is named:
		// the one that answered keeps its coverage.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
			makeAuxServer("typos"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(
				makeClient(400, [makeDiagnostic("opengrep finding")], {
					serverId: "opengrep",
				}),
			)
			.mockResolvedValueOnce(makeClient(1500, [], { serverId: "typos" }));
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, "two-aux", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep", "typos"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ serverId: string; outcome: string }>
			| undefined;
		expect(outcomes).toEqual([
			expect.objectContaining({ serverId: "opengrep", outcome: "answered" }),
			expect.objectContaining({ serverId: "typos", outcome: "silent" }),
		]);
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["typos"]);
		expect(result?.inconclusive).toBeUndefined();
		// The answering sibling's finding still rides along.
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("opengrep finding");
		// Observability contract: the join key is on the touch row.
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					confirmation: "partial",
					auxUnconfirmedServerIds: ["typos"],
				}),
			}),
		);
	});

	it("#1493: a silent auxiliary already bound to this content stays covered", async () => {
		// The second honest case. This auxiliary published nothing during the wait,
		// but a stored publication is bound to EXACTLY the bytes this touch carries
		// — it has reported on this file's current content, so its silence withholds
		// nothing and the touch keeps its unqualified confirmation.
		const content = "already-scanned";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce({
				...makeClient(900, [], { serverId: "opengrep" }),
				getDiagnosticBinding: vi.fn(() => ({
					contentHash: hashDiagnosticContent(content),
				})),
				waitForDiagnostics: vi.fn(
					() => new Promise<void>((resolve) => setTimeout(resolve, 900)),
				),
			});
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ outcome: string; publishedThisContent?: boolean }>
			| undefined;
		expect(outcomes?.[0]?.outcome).toBe("silent");
		expect(outcomes?.[0]?.publishedThisContent).toBe(true);
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
	});

	it("#1493: a CUT-OFF auxiliary already bound to this content stays covered", async () => {
		// The same exemption on the other no-answer shape. This auxiliary's wait
		// outlives the 2000ms ceiling, so the grace timer cuts it off — but a stored
		// publication is bound to EXACTLY the bytes this touch carries, so it has
		// already reported on this content and how the abandoned wait would have
		// ended changes nothing. Exempting the silent shape but not this one would
		// report identical coverage two ways depending on which timer won.
		const content = "already-scanned-then-hung";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce({
				...makeClient(3000, [], { serverId: "opengrep" }),
				getDiagnosticBinding: vi.fn(() => ({
					contentHash: hashDiagnosticContent(content),
				})),
				waitForDiagnostics: vi.fn(
					() => new Promise<void>((resolve) => setTimeout(resolve, 3000)),
				),
			});
		await service.getClientsForFile(FILE);

		const touch = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(4000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ outcome: string; publishedThisContent?: boolean }>
			| undefined;
		expect(outcomes?.[0]?.outcome).toBe("cut_off");
		expect(outcomes?.[0]?.publishedThisContent).toBe(true);
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
		// The cut-off record itself is unchanged — the latency field still reports
		// which auxiliary the timer cut off, whatever the coverage verdict was.
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					auxCutOffServerIds: ["opengrep"],
					confirmation: "confirmed",
				}),
			}),
		);
	});

	it("an auxiliary that PUBLISHES within grace still yields an unqualified confirmation", async () => {
		const { result, outcome } = await probe(900, [
			makeDiagnostic("aux finding"),
		]);
		expect(outcome).toBe("answered");
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("aux finding");
	});

	it("records the narrowed verdict on the same lsp_touch_file row as auxCutOffServerIds", async () => {
		// Observability contract from the issue: a `cut_off` row must coincide
		// with a touch that no longer claims confirmation for that server. Both
		// facts have to be readable from latency.log without a code read.
		await probe(3000, [makeDiagnostic("never")]);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					confirmation: "partial",
					auxCutOffServerIds: ["opengrep"],
					inconclusive: false,
				}),
			}),
		);
	});

	it("does not prime the last-known cache from a partially covered touch", async () => {
		// #570's wipe class re-entering through the cut-off door: the merged array
		// is missing whatever the cut-off scanner would have said, so an empty one
		// must not delete a previously-confirmed record and a non-empty one must
		// not be replayed as an authoritative observation.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(
				makeClient(100, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
			)
			.mockResolvedValueOnce(makeClient(3000, [], { serverId: "opengrep" }));
		await service.getClientsForFile(FILE);

		const content = "cache-probe";
		const touch = service.touchFile(FILE, content, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		const result = await touch;
		expect(result?.confirmation).toBe("partial");
		expect(
			service.getLastKnownDiagnostics(FILE, hashDiagnosticContent(content)),
		).toBeUndefined();
	});
});

/**
 * #1533 — the same honesty on `clientScope: "all"`, the batch/directory scan
 * surface.
 *
 * `"all"` spawns auxiliaries into the client set (#573) but never enters the aux
 * GRACE wait, so before this fix no evidence was derived on that scope: a silent
 * scanner resolved `confirmation: "confirmed"` with no `unconfirmedServerIds`,
 * the exact #1493 false clean surviving one scope over. #1527 fixed only the
 * per-file lane, per its scope.
 *
 * The fix derives the outcomes from POST-WAIT state rather than entering a second
 * wait — every auxiliary is already waited on inside the aggregate
 * `Promise.all`, so the evidence is free and #1459's fan-out saving is untouched.
 * `cut_off` cannot arise here (no ceiling is armed), so the rows carry
 * `waitShape: "aggregate"` and the three remaining shapes.
 *
 * These probes are the regression fence: on pre-fix code every `"partial"`
 * assertion below reads `"confirmed"` and no `lsp_aux_wait_outcome` row exists at
 * all.
 */
describe('#1533 — silent auxiliary honesty on clientScope "all"', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * One `clientScope: "all"` touch over a primary that answers at 100ms and one
	 * auxiliary whose own wait settles at `auxDelayMs`. Returns the touch result
	 * plus the aux-wait row it produced, so each probe can assert the telemetry and
	 * the claimed confirmation agree — the same shape the with-auxiliary `probe`
	 * above uses.
	 */
	async function probeAll(
		auxDelayMs: number,
		auxDiags: ReturnType<typeof makeDiagnostic>[],
		auxOptions: { publishesWhenClean?: boolean } = {},
	) {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep"
					? makeClient(auxDelayMs, auxDiags, {
							serverId: "opengrep",
							...auxOptions,
						})
					: makeClient(100, [makeDiagnostic("primary error")], {
							serverId: "ts-primary",
						}),
		);

		const touch = service.touchFile(FILE, "probe-all", {
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
		});
		// Covers opengrep's full 3500ms declared budget plus slack.
		await vi.advanceTimersByTimeAsync(5000);
		const result = await touch;
		const row = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0];
		const outcomes = row?.metadata?.outcomes as
			| Array<{
					serverId: string;
					outcome: string;
					publishedThisContent?: boolean;
			  }>
			| undefined;
		return { result, row, outcomes, outcome: outcomes?.[0]?.outcome };
	}

	it("a SILENT auxiliary narrows the confirmation and names the server", async () => {
		// The reported defect, verbatim: aux settles at 900ms inside its own budget
		// having published nothing, and the touch used to claim "confirmed" with
		// empty `unconfirmedServerIds`.
		const { result, outcome } = await probeAll(900, []);
		expect(outcome).toBe("silent");
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// NARROWED, not collapsed: the primary answered at 100ms, so its findings
		// stand and the touch is not inconclusive (#533 cuts both ways).
		expect(result?.inconclusive).toBeUndefined();
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("primary error");
	});

	it('emits an lsp_aux_wait_outcome row for the "all" scope, tagged as the aggregate producer', async () => {
		// The issue's observability criterion: the field-data analysis from #1493's
		// review must cover this lane too, and a query must be able to tell the two
		// producers apart.
		const { row, outcomes } = await probeAll(900, []);
		expect(row).toBeDefined();
		expect(row?.metadata).toMatchObject({
			clientScope: "all",
			waitShape: "aggregate",
		});
		expect(outcomes).toEqual([
			expect.objectContaining({
				serverId: "opengrep",
				outcome: "silent",
				publishedThisContent: false,
			}),
		]);
		// No grace ceiling is armed on this path, so the row must never claim one won.
		expect(outcomes?.some((entry) => entry.outcome === "cut_off")).toBe(false);
	});

	it("records the narrowed verdict on the same lsp_touch_file row", async () => {
		await probeAll(900, []);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					clientScope: "all",
					confirmation: "partial",
					auxUnconfirmedServerIds: ["opengrep"],
					inconclusive: false,
				}),
			}),
		);
	});

	it("an auxiliary that ran to budget and published nothing keeps the touch clean", async () => {
		// The overcorrection guard, mirrored from the with-auxiliary lane: an empty
		// PUBLICATION advances `diagnosticsVersion` in production exactly like a
		// finding does, so the scanner is covered and the touch stays unqualified.
		// Without this the fix would demote nearly every clean sweep file.
		const { result, outcome } = await probeAll(900, [], {
			publishesWhenClean: true,
		});
		expect(outcome).toBe("answered");
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
	});

	it("an auxiliary that publishes findings keeps the touch clean and merges them", async () => {
		const { result, outcome } = await probeAll(900, [
			makeDiagnostic("aux finding"),
		]);
		expect(outcome).toBe("answered");
		expect(result?.confirmation).toBe("confirmed");
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("aux finding");
	});

	it("a silent auxiliary already bound to this content stays covered", async () => {
		// #1493's content-hash exemption must apply on this scope for the same
		// reason it applies on the other: a scanner whose stored publication is bound
		// to EXACTLY these bytes has reported, so a wait producing nothing new
		// withholds nothing. Fails closed only against a hash match, never a timer.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const content = "bound-all";
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep"
					? {
							...makeClient(900, [], { serverId: "opengrep" }),
							getDiagnosticBinding: vi.fn(() => ({
								contentHash: hashDiagnosticContent(content),
								boundToCurrentDisk: true,
							})),
						}
					: makeClient(100, [], { serverId: "ts-primary" }),
		);

		const touch = service.touchFile(FILE, content, {
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(5000);
		const result = await touch;
		const outcomes = logLatency.mock.calls.find(
			([entry]) => entry.phase === "lsp_aux_wait_outcome",
		)?.[0]?.metadata?.outcomes as
			| Array<{ outcome: string; publishedThisContent?: boolean }>
			| undefined;
		// Still recorded as silent — the exemption is in the coverage POLICY, not in
		// the outcome, so the row keeps saying what actually happened.
		expect(outcomes?.[0]?.outcome).toBe("silent");
		expect(outcomes?.[0]?.publishedThisContent).toBe(true);
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
	});

	it("does not report an EXCLUDED scanner as a coverage gap", async () => {
		// The #584 workspace-sweep exclusion is a routing decision, not a blackout:
		// opengrep's sweep findings come from its own CLI extractor. An excluded
		// server never reaches `spawned`, so it must not be named here — otherwise
		// every sweep file would report a permanent gap for a scanner nobody asked.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep"
					? makeClient(900, [], { serverId: "opengrep" })
					: makeClient(100, [], { serverId: "ts-primary" }),
		);

		const touch = service.touchFile(FILE, "excluded", {
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
			excludeServerIds: new Set(["opengrep"]),
		});
		await vi.advanceTimersByTimeAsync(5000);
		const result = await touch;
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
		// No auxiliary was spawned, so there is nothing to report an outcome for.
		expect(
			logLatency.mock.calls.some(
				([entry]) => entry.phase === "lsp_aux_wait_outcome",
			),
		).toBe(false);
	});

	it("a DEFERRED auxiliary records `deferred`, never `silent`, on this scope too", async () => {
		// #1459's boundary, pinned on the aggregate producer: `silent` is reserved for
		// a scanner that HAD the content and published nothing. A scanner the resync
		// gate never sent these bytes must not occupy that row — the reviewer verified
		// this behavior by hand, so it gets a test.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "100";
		try {
			// One shared aux client whose write is held far past any budget, so the
			// SECOND concurrent touch can only be deferred behind it.
			const auxClient = {
				...makeClient(9000, [], { serverId: "opengrep" }),
				notify: {
					open: vi.fn(() => new Promise<void>(() => {})),
					change: vi.fn(async () => {}),
					close: vi.fn(async () => {}),
				},
			};
			getServersForFileWithConfig.mockReturnValue([
				makePrimaryServer("ts-primary"),
				makeAuxServer("opengrep"),
			]);
			createLSPClient.mockImplementation(
				async (options: { serverId?: string }) =>
					options?.serverId === "opengrep"
						? auxClient
						: makeClient(100, [], { serverId: "ts-primary" }),
			);

			const touchOptions = {
				clientScope: "all" as const,
				collectDiagnostics: true,
				diagnostics: "document" as const,
			};
			const first = service.touchFile("C:/repo/a.ts", "one", touchOptions);
			await vi.advanceTimersByTimeAsync(1);
			const second = service.touchFile("C:/repo/b.ts", "two", touchOptions);
			await vi.advanceTimersByTimeAsync(20_000);
			await Promise.all([first, second]);

			const outcomes = logLatency.mock.calls
				.map(([entry]) => entry)
				.filter((entry) => entry?.phase === "lsp_aux_wait_outcome")
				.flatMap(
					(entry) =>
						(
							entry.metadata as {
								outcomes?: Array<{ serverId: string; outcome: string }>;
							}
						)?.outcomes ?? [],
				)
				.filter((entry) => entry.serverId === "opengrep")
				.map((entry) => entry.outcome);
			expect(outcomes).toContain("deferred");
			// Every row came from the aggregate producer, and no deferral was laundered
			// into the reserved `silent` row.
			expect(
				logLatency.mock.calls
					.map(([entry]) => entry)
					.filter((entry) => entry?.phase === "lsp_aux_wait_outcome")
					.every(
						(entry) =>
							(entry.metadata as { waitShape?: string })?.waitShape ===
							"aggregate",
					),
			).toBe(true);
		} finally {
			delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		}
	});

	// BLAST-RADIUS PINS (#1533 review). The highest-frequency `"all"` caller is the
	// cascade per-edit neighbour fan-out, which caps the touch at 1000/2000ms and
	// does NOT exclude opengrep. The concern raised was that newly-`silent` verdicts
	// there would block `recentlyCleanNeighborCache` seeding via
	// `isConfirmedTouch`.
	//
	// The answer has TWO cases, and stating only the first would be the same
	// impossibility-proof overreach #1533 was filed about. The dividing question is
	// whether the auxiliary's budget is the MAX over waited servers, because
	// `perServerTimeout` is `min(callerCap, strategyWait)` per server while
	// `timeoutMs` is the max across them:
	//
	//   1. AUX IS THE MAX (this test). opengrep declares 3500, above either per-edit
	//      cap, so `timeoutFor(opengrep) = callerCap = timeoutMs`. An opengrep that
	//      burns its budget therefore trips `diagnosticsTimedOut`, and the touch was
	//      ALREADY `inconclusive` before #1533 — `inconclusive` is decided BEFORE
	//      `coverageGap` in the result branch, so the wrapper those callers read is
	//      byte-identical. Delete the #1533 block and this test still passes; that is
	//      the point. This covers every auxiliary on every current per-edit path,
	//      because opengrep is the only one attached there and its budget always
	//      exceeds the cap.
	//
	//   2. AUX IS NOT THE MAX (the test after this one). A faster auxiliary beside a
	//      slower primary — typos (1500) or ast-grep (1800) next to rust-analyzer
	//      (3000) under a 2000ms cap — settles inside `timeoutMs`, so
	//      `waitedMs + 20 >= timeoutMs` never trips and the touch is NOT
	//      inconclusive. Here #1533 genuinely DOES narrow a result that previously
	//      read `confirmed`. That is the fix working as intended: the scanner said
	//      nothing about these bytes, so the verdict is honest and fail-safe (the
	//      primary's findings still ride along in `.diags`; only the coverage claim
	//      is withdrawn). The cost is a cache seed skipped for that file, bounded by
	//      how often a fast auxiliary is paired with a slower primary on a collecting
	//      `"all"` touch.
	// #1549 UPDATE to case 1's reasoning. The aggregate deadline lapsing is no
	// longer, on its own, what makes this touch inconclusive: the verdict is decided
	// per server, and an auxiliary can never produce it. This touch stays
	// inconclusive because its PRIMARY published nothing either — `makeClient(100,
	// [])` settles its wait without a publication, and `ts-primary` is not classified
	// silent-on-clean, so its silence is genuinely ambiguous. The assertions below
	// now pin that attribution explicitly, which is what keeps the pin honest: the
	// touch reads inconclusive for the primary's account, not opengrep's.
	it("case 1 — a per-edit-shaped touch whose PRIMARY published nothing stays inconclusive, not newly partial", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep"
					? makeClient(5000, [], { serverId: "opengrep" })
					: makeClient(100, [], { serverId: "ts-primary" }),
		);

		const touch = service.touchFile(FILE, "per-edit", {
			// The cascade neighbour fan-out's own shape (integration.ts).
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
			maxClientWaitMs: 1000,
			silent: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(6000);
		const result = await touch;
		// The pre-existing verdict, unchanged.
		expect(result?.inconclusive).toBe(true);
		// #1549: and it is the PRIMARY's silence that produced it — opengrep is named
		// as a coverage gap, never as the cause of an inconclusive touch.
		expect(result?.inconclusiveServerIds).toEqual(["ts-primary"]);
		expect(result?.inconclusiveReason).toBe("diagnostics-wait");
		// And #1533 did not convert it into a confirmation claim of any kind, which is
		// what `isConfirmedTouch` reads.
		expect(result?.confirmation).toBeUndefined();
	});

	it("case 2 — a fast silent aux beside a slower primary narrows to partial, not confirmed", async () => {
		// The counter-case to the test above, and the honest half of the blast radius.
		// rust-analyzer declares 3000 and typos 1500, so under a 2000ms cap:
		//   timeoutFor(rust-analyzer) = min(2000, 3000) = 2000
		//   timeoutFor(typos)         = min(2000, 1500) = 1500
		//   timeoutMs                 = max(2000, 1500) = 2000
		// The primary answers at 800ms and typos settles silently at 1500ms, so the
		// wait ends at 1500 — comfortably inside `timeoutMs`, which is why
		// `diagnosticsTimedOut` does NOT trip and the pre-#1533 result was a clean
		// `confirmed`. Post-#1533 it is `partial` naming typos, because typos published
		// nothing about these bytes.
		//
		// Asserting the budgets alongside the verdict keeps the arithmetic above from
		// silently drifting if a strategy number changes — the whole point of this pin
		// is the INEQUALITY (aux budget < timeoutMs), not the specific milliseconds.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const file = "C:/repo/main.rs";
		const primaryClient = makeClient(800, [makeDiagnostic("borrow error")], {
			serverId: "rust-analyzer",
		});
		const auxClient = makeClient(1500, [], { serverId: "typos" });
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("rust-analyzer", ".rs"),
			makeAuxServer("typos", ".rs"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "typos" ? auxClient : primaryClient,
		);

		const touch = service.touchFile(file, "fn main() {}", {
			// The cascade neighbour fan-out's own shape, non-cold-snapshot lane.
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
			maxClientWaitMs: 2000,
			silent: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(4000);
		const result = await touch;

		// The inequality that puts this touch in case 2 rather than case 1.
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(
			file,
			1500,
			expect.anything(),
		);
		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(
			file,
			2000,
			expect.anything(),
		);
		// NOT inconclusive — this is what makes the narrowing new rather than a
		// relabelling of an already-unconfirmed touch.
		expect(result?.inconclusive).toBeUndefined();
		// The new verdict: honest about typos, and the primary's finding survives.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["typos"]);
		expect(
			(result?.diags ?? []).map((d: { message: string }) => d.message),
		).toContain("borrow error");
	});

	// #1531, now CLOSED and live rather than pending. The client-global
	// `diagnosticsVersion` advances for every file a client publishes, so two
	// CONCURRENT touches sharing one auxiliary client used to cross-satisfy: a
	// publication for a.ts advanced the counter b.ts's baseline was compared against,
	// and b.ts read `answered` on its sibling's evidence. The cascade neighbour
	// fan-out is a `Promise.allSettled`, so that is the common shape, not a corner.
	//
	// #1531 landed the per-path publication stamp on master while #1533 was in
	// review, and the aggregate evidence read uses the same `readPathVersion`
	// accessor, so this is now a live regression fence for BOTH producers on that
	// axis. It was authored as a skipped pin of the desired behavior; it is unskipped
	// because the behavior arrived. If it ever goes red, the aggregate path has
	// drifted back to the global counter.
	it("#1531: a concurrent sibling's publication must not cover a silent touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		// Built from the shape that demonstrably exhibited the gap before #1531 landed
		// (verified by probe: both touches resolved `confirmed`, both rows read
		// `answered`, though only a.ts was ever published for). Deliberately NOT
		// assembled from `makeClient` above — a spread of that double changed the
		// outcome for an unrelated reason and made this pin pass without exercising the
		// counter at all, the vacuous-fixture trap (defect shape 7) this test is about.
		//
		// The double advances BOTH axes on a publication, exactly as `client.ts` does:
		// the global counter (which a.ts's publication bumps for the whole client) and
		// the per-path stamp (recorded for a.ts only). That pairing is what makes the
		// assertion meaningful — a read on the global axis sees a.ts's bump from b.ts
		// and calls it covered; the per-path read does not.
		let version = 0;
		const stampsByPath = new Map<string, number>();
		const shared = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getDiagnostics: vi.fn(() => []),
			notify: {
				open: vi.fn(async () => {}),
				change: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			},
		};
		// ONE aux client shared by both files, publishing for a.ts only.
		const auxClient = {
			...shared,
			serverId: "opengrep",
			get diagnosticsVersion() {
				return version;
			},
			getDiagnosticsVersionForPath: vi.fn(
				(filePath: string) => stampsByPath.get(filePath) ?? 0,
			),
			waitForDiagnostics: vi.fn(
				(filePath: string) =>
					new Promise<void>((resolve) =>
						setTimeout(() => {
							// a.ts publishes: the client-global counter advances (it is
							// client-wide, so b.ts sees this bump too) but only a.ts's path
							// stamp records it. b.ts publishes nothing on either axis.
							if (filePath.endsWith("a.ts")) {
								version += 1;
								stampsByPath.set(filePath, version);
							}
							resolve();
						}, 900),
					),
			),
		};
		const primaryClient = {
			...shared,
			serverId: "ts-primary",
			diagnosticsVersion: 0,
			getDiagnosticsVersionForPath: vi.fn(() => 0),
			waitForDiagnostics: vi.fn(
				() => new Promise<void>((resolve) => setTimeout(resolve, 100)),
			),
		};
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? auxClient : primaryClient,
		);

		const touchOptions = {
			clientScope: "all" as const,
			collectDiagnostics: true,
			diagnostics: "document" as const,
		};
		const a = service.touchFile("C:/repo/a.ts", "one", touchOptions);
		const b = service.touchFile("C:/repo/b.ts", "two", touchOptions);
		await vi.advanceTimersByTimeAsync(5000);
		const [, second] = await Promise.all([a, b]);
		// b.ts got no publication of its own. Post-#1544's per-path counter that is
		// visible; today a.ts's bump satisfies b.ts's baseline and this reads
		// `confirmed` with no named server.
		expect(second?.confirmation).toBe("partial");
		expect(second?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("does not enter a second wait: the touch still completes on the aggregate budget", async () => {
		// The cost guard. #1459's resync gate absorbs the aux fan-out of an
		// "all"-scope sweep; a per-neighbour aux grace here would pay that latency
		// back. The evidence is derived from state the aggregate wait already
		// produced, so a silent aux must not extend the touch beyond its own budget.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("opengrep"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep"
					? makeClient(900, [], { serverId: "opengrep" })
					: makeClient(100, [], { serverId: "ts-primary" }),
		);

		const startedAt = Date.now();
		const touch = service.touchFile(FILE, "cost", {
			clientScope: "all",
			collectDiagnostics: true,
			diagnostics: "document",
		});
		let settledAt: number | undefined;
		void touch.then(() => {
			settledAt = Date.now();
		});
		await vi.advanceTimersByTimeAsync(5000);
		await touch;
		// The aux's own wait settled at 900ms; nothing was armed after it.
		expect((settledAt ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(
			1500,
		);
	});
});

/**
 * #2324 R2-A — the actual production ordering: the ast-grep napi fallback's
 * Gate-B check is a synchronous map lookup, while the aux-grace wait that
 * decides whether to mark a pending late-auxiliary pair runs for up to its
 * own grace budget (here, up to the aux's own wait). By the time this wait
 * is ready to decide, THIS touch's napi run (if any) has already recorded
 * its coverage — the wait consults that record before marking. A clear
 * issued from napi's side (the F3 fix's first attempt) cannot rely on this
 * ordering: the mark it would race has not been written yet.
 */
describe("R8 — aux grace: ast-grep napi/aux-grace mark ordering (#2324 R2-A)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	it("does not mark a pending pair when napi already covered this touch before the wait decides", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		// Dynamically imported AFTER vi.resetModules() so this is the SAME
		// module instance LSPService resolves internally — a static top-level
		// import would bind to a stale pre-reset instance.
		const pendingAux =
			await import("../../../clients/lsp/pending-aux-coverage.js");
		pendingAux.resetPendingAuxiliaryCoverage();
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("ast-grep"),
		]);
		// ast-grep's own wait settles SILENTLY (no publish) well inside its
		// budget — the shape that, absent this fix, marks a pending pair.
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeClient(900, [], { serverId: "ast-grep" }));
		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		// Gate B's napi runner is dispatched CONCURRENTLY with this wait
		// (dispatcher.ts's Promise.all groups) and settles almost immediately
		// — a synchronous map lookup plus a fast rule evaluation. Reproduced
		// here by recording napi's coverage right after the touch starts,
		// well before the aux's own ~900ms wait or the grace ceiling resolve.
		pendingAux.recordNapiFallbackCoverage(FILE);
		await vi.advanceTimersByTimeAsync(3000);
		await touchPromise;

		expect(pendingAux.hasPendingAuxiliaryCoverage(FILE, "ast-grep")).toBe(
			false,
		);
		pendingAux.resetPendingAuxiliaryCoverage();
	});

	// #2324 R3-A: the issue's own 68ms race, reproduced against the SPECIFIC
	// baseline the guard uses. Nothing is pre-warmed — `createLSPClient`
	// itself takes real (fake-timer) time to resolve, modeling the
	// spawn+handshake `getClientForFile`/`getAuxiliaryClientsForFile` do on a
	// COLD touch. `waitStartedAt` (clients/lsp/index.ts) is captured only
	// AFTER that spawn work resolves — well after this touch's own entry —
	// so a napi record landing in that spawn window predates `waitStartedAt`
	// even though it postdates `touchFile`'s own start. Baselining on
	// `startedAt` (stamped at entry, before any spawn) is what lets a
	// same-touch napi record survive that window.
	it("does not mark a pending pair when napi's coverage lands during a COLD spawn's handshake window", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const pendingAux =
			await import("../../../clients/lsp/pending-aux-coverage.js");
		pendingAux.resetPendingAuxiliaryCoverage();
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("ast-grep"),
		]);
		const COLD_SPAWN_HANDSHAKE_MS = 400;
		// No pre-warm call here — this IS the cold spawn. `createLSPClient`
		// itself is delayed, so `waitStartedAt` (captured only after both
		// spawns resolve) lands ~400ms after touchFile's own entry.
		createLSPClient.mockImplementation(
			(options: { serverId?: string }) =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve(
								options?.serverId === "ast-grep"
									? makeClient(900, [], { serverId: "ast-grep" })
									: makeClient(100, [], { serverId: "ts-primary" }),
							),
						COLD_SPAWN_HANDSHAKE_MS,
					),
				),
		);

		const touchPromise = service.touchFile(FILE, "cold-content", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		// Gate B's napi runner is dispatched CONCURRENTLY with the WHOLE
		// touch (dispatcher.ts's Promise.all groups), not just with the LSP
		// wait — it settles almost immediately regardless of how long THIS
		// touch's own client spawn takes. Recording at 10ms lands well
		// inside the 400ms cold-spawn handshake window, before
		// `waitStartedAt` is ever captured, but after `touchFile`'s entry.
		await vi.advanceTimersByTimeAsync(10);
		pendingAux.recordNapiFallbackCoverage(FILE);
		await vi.advanceTimersByTimeAsync(5000);
		await touchPromise;

		expect(pendingAux.hasPendingAuxiliaryCoverage(FILE, "ast-grep")).toBe(
			false,
		);
		pendingAux.resetPendingAuxiliaryCoverage();
	});

	it("still marks the pair when napi's coverage predates this touch (stale record)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const pendingAux =
			await import("../../../clients/lsp/pending-aux-coverage.js");
		pendingAux.resetPendingAuxiliaryCoverage();
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([
			makePrimaryServer("ts-primary"),
			makeAuxServer("ast-grep"),
		]);
		createLSPClient
			.mockResolvedValueOnce(makeClient(800, [], { serverId: "ts-primary" }))
			.mockResolvedValueOnce(makeClient(900, [], { serverId: "ast-grep" }));
		await service.getClientsForFile(FILE);

		// napi covered this file for an EARLIER revision, well before this
		// touch even starts — a stale record must not suppress a mark this
		// touch's silent server genuinely needs delivered later.
		pendingAux.recordNapiFallbackCoverage(FILE);
		await vi.advanceTimersByTimeAsync(5000);

		const touchPromise = service.touchFile(FILE, "content-2", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			collectDiagnostics: true,
			diagnostics: "document",
		});
		await vi.advanceTimersByTimeAsync(3000);
		await touchPromise;

		expect(pendingAux.hasPendingAuxiliaryCoverage(FILE, "ast-grep")).toBe(true);
		pendingAux.resetPendingAuxiliaryCoverage();
	});
});
