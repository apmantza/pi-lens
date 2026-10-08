import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suspendAt } from "../interleaving-kit.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

describe("LSPService race hardening", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("deduplicates concurrent spawn for same server/root key", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);

		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 123,
			},
		}));

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const first = service.getClientForFile(file);
		await initialize.admitted;
		const second = service.getClientForFile(file);
		initialize.release();
		const [a, b] = await Promise.all([first, second]);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(a?.client).toBeTruthy();
		expect(b?.client).toBeTruthy();
		initialize.restore();
	});

	it("does not orphan the in-flight client when a waiter times out", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 321,
			},
		}));
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		const timedOut = service.getClientForFile(file, 1);
		await initialize.admitted;
		expect(await timedOut).toBeUndefined();
		const internal = service as unknown as {
			state: { inFlight: Map<string, unknown>; clients: Map<string, unknown> };
			clientLeases: Map<string, number>;
		};
		expect(internal.state.inFlight.size).toBe(1);
		expect(internal.clientLeases.size).toBe(0);

		initialize.release();
		await service.getClientForFile(file);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(service.getAliveClientCount()).toBe(1);
		expect(internal.state.inFlight.size).toBe(0);
		expect(internal.clientLeases.size).toBe(0);
		await service.shutdown();
		expect(client.shutdown).toHaveBeenCalledTimes(1);
		expect(internal.state.clients.size).toBe(0);
		initialize.restore();
	});

	it("distinguishes a warm-touch budget miss while its single spawn remains in flight", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			serverId: "marksman",
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
			getOperationSupport: () => ({}),
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			notify: { open: vi.fn().mockResolvedValue(undefined) },
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1875,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/README.md";
		const firstRead = service.touchFile(file, "# first\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 1,
			source: "tool_call:read",
		});
		await initialize.admitted;
		expect(await firstRead).toBeUndefined();
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "spawn_in_flight_budget_elapsed",
				}),
			}),
		);

		initialize.release();
		await initialize.completed;
		const secondRead = await service.touchFile(file, "# first\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 1,
			source: "tool_call:read",
		});

		expect(secondRead).toEqual({ diags: [] });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(createLSPClient).toHaveBeenCalledTimes(1);
		expect(client.notify.open).toHaveBeenCalledTimes(1);

		logLatency.mockClear();
		getServersForFileWithConfig.mockReturnValue([]);
		expect(
			await service.touchFile("C:/repo/notes.unknown", "none\n", {
				diagnostics: "none",
				clientScope: "primary",
				maxClientWaitMs: 1,
				source: "tool_call:read",
			}),
		).toBeUndefined();
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "no_clients_none_spawning",
				}),
			}),
		);
		initialize.restore();
	});

	it("skips a doomed touch wait when spawn history identifies the in-flight server as slow", async () => {
		vi.useFakeTimers();
		const { recordSuccessfulLspSpawn } =
			await import("../../../clients/lsp/spawn-history.js");
		recordSuccessfulLspSpawn("marksman", 6_000);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			serverId: "marksman",
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
			getOperationSupport: () => ({}),
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			notify: { open: vi.fn().mockResolvedValue(undefined) },
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: vi.fn(async () => ({
					process: {
						process: { killed: false },
						stdin: {} as any,
						stdout: {} as any,
						stderr: {} as any,
						pid: 1884,
					},
				})),
			},
		]);

		const startedAt = Date.now();
		const touch = service.touchFile("C:/repo/README.md", "# slow\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 750,
			source: "tool_call:read",
		});
		await initialize.admitted;
		expect(await touch).toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(10);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "spawn_in_flight_budget_elapsed",
					reason: "budget_skipped_known_slow",
				}),
			}),
		);

		initialize.release();
		await initialize.completed;
		initialize.restore();
	});

	it("returns a client when acquisition completes just before the known-slow shortcut", async () => {
		vi.useFakeTimers();
		const { recordSuccessfulLspSpawn } =
			await import("../../../clients/lsp/spawn-history.js");
		recordSuccessfulLspSpawn("marksman", 1_501);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			serverId: "marksman",
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
			getOperationSupport: () => ({}),
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			notify: { open: vi.fn().mockResolvedValue(undefined) },
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		const internal = service as unknown as {
			state: { clients: Map<string, typeof client> };
		};
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: vi.fn(async () => {
					queueMicrotask(() =>
						internal.state.clients.set("marksman:C:/repo", client),
					);
					return {
						process: {
							process: { killed: false },
							stdin: {} as any,
							stdout: {} as any,
							stderr: {} as any,
							pid: 1887,
						},
					};
				}),
			},
		]);

		const touch = service.touchFile("C:/repo/README.md", "# ready\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 750,
			source: "tool_call:read",
		});
		await initialize.admitted;
		initialize.release();
		await initialize.completed;
		await expect(touch).resolves.toEqual({ diags: [] });
		expect(logLatency).not.toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					reason: "budget_skipped_known_slow",
				}),
			}),
		);
		initialize.restore();
	});

	it.each([
		[800, false],
		[1_501, true],
	])(
		"applies the strict known-slow margin at %ims",
		async (history, skipped) => {
			vi.useFakeTimers();
			const {
				recordSuccessfulLspSpawn,
				_clearSuccessfulLspSpawnHistoryForTests,
			} = await import("../../../clients/lsp/spawn-history.js");
			_clearSuccessfulLspSpawnHistoryForTests();
			recordSuccessfulLspSpawn("marksman", history);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const initialize = suspendAt(createLSPClient, async () => ({
				isAlive: () => true,
				shutdown: async () => {},
			}));
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "marksman",
					name: "Marksman",
					extensions: [".md"],
					idleEviction: "resident",
					root: async () => "C:/repo",
					spawn: vi.fn(async () => ({
						process: {
							process: { killed: false },
							stdin: {} as any,
							stdout: {} as any,
							stderr: {} as any,
							pid: 1888,
						},
					})),
				},
			]);
			const touch = service.touchFile("C:/repo/README.md", "# boundary\n", {
				diagnostics: "none",
				clientScope: "primary",
				maxClientWaitMs: 750,
				source: "tool_call:read",
			});
			await initialize.admitted;
			if (skipped) {
				await expect(touch).resolves.toBeUndefined();
			} else {
				let settled = false;
				void touch.then(() => {
					settled = true;
				});
				await vi.advanceTimersByTimeAsync(749);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				await expect(touch).resolves.toBeUndefined();
			}
			initialize.release();
			await initialize.completed;
			initialize.restore();
		},
	);

	it("keeps the bounded touch wait when the in-flight server has no spawn history", async () => {
		vi.useFakeTimers();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const initialize = suspendAt(createLSPClient, async () => ({
			isAlive: () => true,
			shutdown: async () => {},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: vi.fn(async () => ({
					process: {
						process: { killed: false },
						stdin: {} as any,
						stdout: {} as any,
						stderr: {} as any,
						pid: 1885,
					},
				})),
			},
		]);

		let settled = false;
		const touch = service
			.touchFile("C:/repo/README.md", "# first\n", {
				diagnostics: "none",
				clientScope: "primary",
				maxClientWaitMs: 750,
				source: "tool_call:read",
			})
			.finally(() => {
				settled = true;
			});
		await initialize.admitted;
		await vi.advanceTimersByTimeAsync(749);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await touch).toBeUndefined();
		expect(settled).toBe(true);

		initialize.release();
		await initialize.completed;
		initialize.restore();
	});

	// #1766: a resync caller whose own wait budget expires needs to tell "the
	// server's first spawn is still running" apart from "the server is up and
	// stalled". isSpawnInFlight reads the real state.inFlight map — no
	// separate hand-maintained flag — so it must report true exactly while a
	// spawn for a candidate server of the file is unresolved, and false again
	// once it settles.
	it("isSpawnInFlight reports true only while the server's spawn is unresolved", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		const initialize = suspendAt(createLSPClient, async () => client);
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 456,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "json",
				name: "JSON",
				extensions: [".json"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/new.json";
		const roots = new Map<string, string>();
		expect(service.isSpawnInFlight(file, roots)).toBe(false);

		const pending = service.getClientForFile(file, undefined, undefined, roots);
		await initialize.admitted;
		// The spawn is now parked mid-initialize, exactly the state a resync
		// deadline can expire during (#1766's cold-start-vs-wedged race).
		expect(service.isSpawnInFlight(file, roots)).toBe(true);

		initialize.release();
		await pending;
		expect(service.isSpawnInFlight(file, roots)).toBe(false);
		initialize.restore();
	});

	it("does not classify another workspace's spawn as in-flight", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { inFlight: Map<string, Promise<undefined>> };
		};
		let release!: () => void;
		const pending = new Promise<undefined>((resolve) => {
			release = () => resolve(undefined);
		});
		internal.state.inFlight.set("marksman:C:/repo-a", pending);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "marksman",
				name: "Marksman",
				extensions: [".md"],
				idleEviction: "resident",
				root: async () => "C:/repo-b",
				spawn: vi.fn(async () => undefined),
			},
		]);

		await service.touchFile("C:/repo-b/README.md", "# repo b\n", {
			diagnostics: "none",
			clientScope: "primary",
			maxClientWaitMs: 1,
			source: "tool_call:read",
		});
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "lsp_touch_file",
				metadata: expect.objectContaining({
					failureKind: "no_clients_none_spawning",
				}),
			}),
		);
		release();
	});

	// #3873 O9: B3 logged 9 of 26 pre-edit touches as `no_clients_none_spawning`
	// with no word on which servers were considered or why none counted.
	describe("#3873 the no-client touch row names its candidates", () => {
		const touch = (service: {
			touchFile: (...args: any[]) => Promise<unknown>;
		}) =>
			service.touchFile("C:/repo-b/README.md", "# repo b\n", {
				diagnostics: "none",
				clientScope: "primary",
				maxClientWaitMs: 1,
				source: "tool_call:read",
			});
		const candidatesOfTouch = (): unknown =>
			logLatency.mock.calls
				.map(([entry]) => entry)
				.find(
					(entry) =>
						entry.phase === "lsp_touch_file" &&
						entry.metadata?.failureKind === "no_clients_none_spawning",
				)?.metadata?.candidates;

		it("a server whose root resolved but whose spawn gave no client is rooted with no client", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "marksman",
					name: "Marksman",
					extensions: [".md"],
					idleEviction: "resident",
					root: async () => "C:/repo-b",
					spawn: vi.fn(async () => undefined),
				},
			]);

			await touch(new LSPService());

			expect(candidatesOfTouch()).toEqual([
				{ serverId: "marksman", rooted: true, clientFound: "none" },
			]);
		});

		it("an alive client beside a no-client verdict, and a dead one, are told apart, with their spawn time", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const internal = service as unknown as {
				state: {
					clients: Map<string, { isAlive: () => boolean }>;
					clientSpawnedAt: Map<string, number>;
				};
			};
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "typescript",
					name: "ts",
					extensions: [".ts"],
					root: async () => "C:/a",
				},
				{
					id: "deno",
					name: "deno",
					extensions: [".ts"],
					root: async () => "C:/a",
				},
			]);
			internal.state.clients.set("typescript:C:/a", { isAlive: () => true });
			internal.state.clientSpawnedAt.set("typescript:C:/a", 1234);
			internal.state.clients.set("deno:C:/a", { isAlive: () => false });

			expect(
				service.describeTouchCandidates(
					"C:/a/x.ts",
					new Map([
						["typescript", "C:/a"],
						["deno", "C:/a"],
					]),
				),
			).toEqual([
				{
					serverId: "typescript",
					rooted: true,
					clientFound: "alive",
					generation: 1234,
				},
				{
					serverId: "deno",
					rooted: true,
					clientFound: "dead",
					generation: undefined,
				},
			]);
		});

		// #3873 round 2 (F3): the touch resolves roots for primary servers only,
		// so an auxiliary server read `rooted: false, clientFound: "none"` even
		// with a live client and a resolvable root. Auxiliaries are not listed.
		it("lists primary servers only: an auxiliary server with a live client is not reported as unrooted", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const internal = service as unknown as {
				state: {
					clients: Map<string, { isAlive: () => boolean }>;
					clientSpawnedAt: Map<string, number>;
				};
			};
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "typescript",
					name: "ts",
					extensions: [".ts"],
					root: async () => "C:/a",
				},
				{
					id: "opengrep",
					name: "opengrep",
					role: "auxiliary",
					extensions: [".ts"],
					root: async () => "C:/a",
				},
			]);
			internal.state.clients.set("opengrep:C:/a", { isAlive: () => true });
			internal.state.clientSpawnedAt.set("opengrep:C:/a", 99);

			expect(
				service
					.describeTouchCandidates(
						"C:/a/x.ts",
						new Map([["typescript", "C:/a"]]),
					)
					.map((entry) => entry.serverId),
			).toEqual(["typescript"]);
		});

		for (const scope of ["primary", "with-auxiliary"] as const)
			it(`a ${scope}-scope no-client touch does not list the auxiliary servers configured for the file`, async () => {
				const { LSPService } = await import("../../../clients/lsp/index.js");
				getServersForFileWithConfig.mockReturnValue([
					{
						id: "marksman",
						name: "Marksman",
						extensions: [".md"],
						idleEviction: "resident",
						root: async () => "C:/repo-b",
						spawn: vi.fn(async () => undefined),
					},
					{
						id: "opengrep",
						name: "opengrep",
						role: "auxiliary",
						extensions: [".md"],
						root: async () => "C:/repo-b",
						spawn: vi.fn(async () => undefined),
					},
				]);

				await new LSPService().touchFile("C:/repo-b/README.md", "# b\n", {
					diagnostics: "none",
					clientScope: scope,
					auxiliaryServerIds: ["opengrep"],
					maxClientWaitMs: 1,
					source: "tool_call:read",
				});

				expect(
					(candidatesOfTouch() as Array<{ serverId: string }>).map(
						(entry) => entry.serverId,
					),
				).toEqual(["marksman"]);
			});

		// G1 (round 3). Recurrence: in `clientScope: "all"` the touch acquires
		// auxiliary servers and resolves their roots (`serverCountAttempted` 2),
		// so dropping every auxiliary made the row narrower than the attempt.
		it("an all-scope no-client touch lists an auxiliary server it resolved a root for", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "marksman",
					name: "Marksman",
					extensions: [".md"],
					idleEviction: "resident",
					root: async () => "C:/repo-b",
					spawn: vi.fn(async () => undefined),
				},
				{
					id: "opengrep",
					name: "opengrep",
					role: "auxiliary",
					extensions: [".md"],
					root: async () => "C:/repo-b",
					spawn: vi.fn(async () => undefined),
				},
			]);

			await new LSPService().touchFile("C:/repo-b/README.md", "# b\n", {
				diagnostics: "none",
				clientScope: "all",
				maxClientWaitMs: 1,
				source: "tool_call:read",
			});

			expect(
				(
					candidatesOfTouch() as Array<{ serverId: string; rooted: boolean }>
				).map((entry) => [entry.serverId, entry.rooted]),
			).toEqual([
				["marksman", true],
				["opengrep", true],
			]);
		});

		// The row's bound: a file with more primary candidates than the cap
		// names the first MAX_TOUCH_CANDIDATES (8). Recurrence: unbounded row
		// growth on a repeat decision.
		it("names at most 8 candidates", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			getServersForFileWithConfig.mockReturnValue(
				Array.from({ length: 9 }, (_, i) => ({
					id: `server-${i}`,
					name: `s${i}`,
					extensions: [".md"],
					root: async () => "C:/a",
				})),
			);

			const candidates = new LSPService().describeTouchCandidates(
				"C:/a/x.md",
				new Map(),
			);

			expect(candidates.map((entry) => entry.serverId)).toEqual(
				Array.from({ length: 8 }, (_, i) => `server-${i}`),
			);
		});

		it("a server with no resolvable root is listed as unrooted", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "marksman",
					name: "Marksman",
					extensions: [".md"],
					idleEviction: "resident",
					root: async () => undefined,
					spawn: vi.fn(async () => undefined),
				},
			]);

			await touch(new LSPService());

			expect(candidatesOfTouch()).toEqual([
				{ serverId: "marksman", rooted: false, clientFound: "none" },
			]);
		});
	});

	it("isSpawnInFlight is false for a file type with no configured server", () => {
		getServersForFileWithConfig.mockReturnValue([]);
		return import("../../../clients/lsp/index.js").then(({ LSPService }) => {
			const service = new LSPService();
			expect(service.isSpawnInFlight("C:/repo/unknown.xyz")).toBe(false);
		});
	});

	// #1766 review F1: reviewer's probe — a PRIMARY server already alive with
	// zero pending spawn calls, and only an AUXILIARY server (typos, opengrep,
	// …) parked mid-spawn. Auxiliary spawns are routine and concurrent with an
	// alive primary (dispatch/runners/lsp.ts's with-auxiliary path fires one
	// per edit for most files), so isSpawnInFlight must stay false here — the
	// unfiltered prefix scan previously answered true, which would downgrade a
	// genuinely wedged primary to a benign "spawn-in-flight" verdict, the
	// worse misreport direction.
	it("stays false when only an auxiliary server is mid-spawn and the primary is alive", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		let releaseAux!: () => void;
		const auxGate = new Promise<void>((resolve) => {
			releaseAux = resolve;
		});
		let auxAdmitted!: () => void;
		const auxAdmittedPromise = new Promise<void>((resolve) => {
			auxAdmitted = resolve;
		});
		createLSPClient.mockImplementation(
			async ({ serverId }: { serverId: string }) => {
				if (serverId === "typos") {
					auxAdmitted();
					await auxGate;
				}
				return { isAlive: () => true, shutdown: vi.fn(async () => {}) };
			},
		);

		const primarySpawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 1,
			},
		}));
		const auxSpawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {} as any,
				stdout: {} as any,
				stderr: {} as any,
				pid: 2,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: primarySpawn,
			},
			{
				id: "typos",
				name: "Typos",
				role: "auxiliary",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: auxSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		// Primary spawns and settles fully first: alive, zero pending spawn calls.
		await service.getClientForFile(file);
		expect(primarySpawn).toHaveBeenCalledTimes(1);
		expect(service.isSpawnInFlight(file)).toBe(false);

		// Kick off the auxiliary spawn and let it park mid-initialize.
		const auxPending = service.getAuxiliaryClientsForFile(
			file,
			new Set(["typos"]),
		);
		await auxAdmittedPromise;

		expect(service.isSpawnInFlight(file)).toBe(false);

		releaseAux();
		await auxPending;
	});

	it("retries broken server after cooldown window", async () => {
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => undefined);
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => "C:/repo",
				spawn,
			},
		]);

		const file = "C:/repo/main.py";
		await service.getClientForFile(file);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(1);

		now.mockReturnValue(16_000);
		await service.getClientForFile(file);
		expect(spawn).toHaveBeenCalledTimes(2);
		now.mockRestore();
	}, 15000);

	it("does not permanently disable unavailable servers when install is disabled", async () => {
		const savedDisable = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const now = vi.spyOn(Date, "now");

		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const spawn = vi.fn(async () => undefined);
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "python",
					name: "Python",
					extensions: [".py"],
					root: async () => "C:/repo",
					spawn,
				},
			]);

			const file = "C:/repo/main.py";
			for (let i = 0; i < 6; i++) {
				now.mockReturnValue(i * 16_000);
				await service.getClientForFile(file);
			}

			// A normal unavailable server would be permanently disabled after five
			// misses. With install disabled, misses are policy/unavailable outcomes;
			// keep retrying after cooldown so a newly installed PATH binary can recover
			// without resetting the whole LSP service.
			expect(spawn).toHaveBeenCalledTimes(6);
			expect(createLSPClient).not.toHaveBeenCalled();
		} finally {
			now.mockRestore();
			if (savedDisable === undefined)
				delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedDisable;
		}
	}, 15000);

	it("uses a server-specific wait budget override for slow startup", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const spawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				process: {
					process: { killed: false },
					stdin: {} as any,
					stdout: {} as any,
					stderr: {} as any,
					pid: 456,
				},
			};
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "ruby",
				name: "Ruby LSP",
				extensions: [".rb"],
				root: async () => "C:/repo",
				clientWaitTimeoutMs: 50,
				spawn,
			},
		]);

		const file = "C:/repo/main.rb";
		const result = await service.getClientForFile(file, 1);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(result?.client).toBeTruthy();
	});
});
