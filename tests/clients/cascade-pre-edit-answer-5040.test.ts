// flake-shape: service-double — #5040: a language server is a spawned process, and this file's subject
// is that it publishes for an importer BEFORE the exporter edit and then stays silent, which no real
// server can be asked to do on demand
// flake-shape: in-process-mock — the client, the graph edges the cascade walks, the logger the cell
// reads back and the quiet-window scheduler stand in; the service, the notify-skip gate, the merge, the
// confirmed-touch read and the run verdict are the real production code
/**
 * #5040: a push-only server's cached importer answer must not read as a
 * confirmed clean after its exporter changed.
 *
 * Recurrence this file prevents: jdtls 1.63.0 publishes for one importer of an
 * edited exporter and never for another (PR #5035's wire capture), so the
 * cascade's touch of the silent importer sent nothing (`shouldSkipNotify` —
 * unchanged content), waited, and read the answer the server had published
 * BEFORE the edit. `isConfirmedTouch` had no age axis, so the run reported
 * `clean` for a dependent no server had re-checked since the exporter changed.
 *
 * Two layers, both through production code:
 *
 *   - `LSPService.touchFile` (the real one) against a fake language-server
 *     client: what the touch reports about the answer it reused, or did not.
 *   - `computeCascadeForFile` (the real one) over the same real service: the
 *     run that read `clean` before this fix, and the run that still reads
 *     `clean` because the server DID answer inside the touch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { diagnosticsPublishedAtForPath } from "../../clients/lsp/client.js";
import type { ReviewGraph } from "../../clients/review-graph/types.js";
import { setupTestEnvironment } from "./test-utils.js";
import { installLspService } from "../support/lsp-service-seam.js";

const mocks = vi.hoisted(() => ({
	createLSPClient: vi.fn(),
	getServersForFileWithConfig: vi.fn(),
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(),
	formatImpactCascade: vi.fn(),
	logCascade: vi.fn(),
}));

vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient: mocks.createLSPClient,
}));

// The review graph is another subsystem: its file-level edges are the fixture
// below, and the cascade's own neighbour walk is what this file proves.
vi.mock("../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/cascade-logger.js", () => ({
	logCascade: mocks.logCascade,
	flushCascadeLog: vi.fn().mockResolvedValue(undefined),
	getCascadeLogPath: vi.fn().mockReturnValue("/tmp/cascade.log"),
}));

// The quiet window owns a scheduler the unit lane must not arm.
vi.mock("../../clients/quiet-window.js", () => ({
	registerQuietWindowTask: vi.fn(),
}));

const NEIGHBOR_CONTENT = "package main\n\nfunc main() {}\n";

/** An error the server publishes for the neighbour after its cache was merged. */
const LATE_ERROR = {
	message: "late error",
	severity: 1,
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 },
	},
};

/**
 * A push-only language server that publishes ONLY when it decides to, like
 * jdtls holding a clean importer: `publish()` is the server's own decision (the
 * fixture asks for it, or the server re-checks on its own during a wait), and
 * `notify.open`/`change` only record that the server was sent the bytes — a
 * real jdtls publishes for an importer when its project model changes, not on
 * every didOpen.
 */
function makePushOnlyServer(options: { serverId?: string; filePath: string }) {
	const key = normalizeMapKey(options.filePath);
	const state = {
		diags: [] as unknown[],
		publishedAt: 0,
		version: 0,
		sentContent: undefined as string | undefined,
		notifies: [] as string[],
		/** How many times a caller read the cached diagnostics (the merge). */
		reads: 0,
		/** The push wait stays open until the case releases it, so only a
		 *  command or the #707 racer can answer. */
		holdWait: false,
		/** The server re-checks the file on its own while a wait is open. */
		publishOnWait: false,
		/** What that re-check publishes (a clean file by default). */
		waitDiags: [] as unknown[],
	};
	const publish = (diags: unknown[], publishedAt: number): void => {
		state.diags = diags;
		state.publishedAt = publishedAt;
		state.version += 1;
	};
	// A released-on-teardown hold: the case owns the settle, so no test leaves a
	// pending wait for the next one and no handle is kept alive.
	let releaseWait: () => void = () => {};
	const heldWait = new Promise<void>((resolve) => {
		releaseWait = resolve;
	});
	const client: Record<string, unknown> = {
		serverId: options.serverId ?? "gopls",
		root: path.dirname(options.filePath),
		customServer: false,
		isAlive: () => true,
		wasShutdownIntentional: () => true,
		getExitedAt: () => undefined,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getSaveOptions: () => ({ includeText: false }),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		get diagnosticsVersion() {
			return state.version;
		},
		getDiagnosticsVersionForPath: () => state.version,
		// #5040: the accessor this fix adds — the publish stamp behind the cached
		// answer, without building the client's whole per-file map.
		getDiagnosticsPublishedAt: () =>
			state.publishedAt > 0 ? state.publishedAt : undefined,
		getDiagnostics: () => {
			state.reads += 1;
			return state.diags;
		},
		getDiagnosticBinding: () => undefined,
		getAllDiagnostics: () =>
			state.publishedAt > 0
				? new Map([[key, { diags: state.diags, ts: state.publishedAt }]])
				: new Map(),
		getTrackedDiagnosticPaths: () =>
			state.publishedAt > 0 ? [options.filePath] : [],
		pruneDiagnostics: () => 0,
		waitForDiagnostics: vi.fn(async () => {
			if (state.publishOnWait) {
				state.publishOnWait = false;
				publish(state.waitDiags, Date.now());
			}
			if (state.holdWait) await heldWait;
		}),
		pingLiveness: async () => true,
		getSentContent: () =>
			state.sentContent === undefined ? undefined : { hash: state.sentContent },
		hasNotifyInFlight: () => false,
		notify: {
			open: vi.fn(async (_filePath: string, content: string) => {
				state.notifies.push("open");
				state.sentContent = hashDiagnosticContent(content);
			}),
			change: vi.fn(async (_filePath: string, content: string) => {
				state.notifies.push("change");
				state.sentContent = hashDiagnosticContent(content);
			}),
			save: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			announceCreated: () => undefined,
		},
	};
	return {
		client,
		state,
		publish,
		releaseWait: () => releaseWait(),
	};
}

/**
 * Arms `hook.current` to publish `diags` once, on the first root resolution
 * AFTER the touch read the cached diagnostics: the merged array is then the
 * pre-publication one and the publication lands in the touch's later await.
 */
function publishAfterMerge(
	hook: { current?: () => void },
	server: ReturnType<typeof makePushOnlyServer>,
	diags: unknown[],
	publishedAt: number,
): void {
	const readsAtArm = server.state.reads;
	hook.current = () => {
		if (server.state.reads === readsAtArm) return;
		hook.current = undefined;
		server.publish(diags, publishedAt);
	};
}

function serverConfig(
	serverId: string,
	root: string,
	extension: string,
	onResolveRoot?: { current?: () => void },
): Record<string, unknown> {
	return {
		id: serverId,
		name: serverId,
		extensions: [extension],
		idleEviction: "resident",
		root: async () => {
			// The touch resolves each server's root AFTER it merged the cache (the
			// readiness mark at the end of `touchFile`), so this is the production
			// await a server's late publication can land in.
			onResolveRoot?.current?.();
			return root;
		},
		spawn: vi.fn(async () => ({
			process: {
				killed: false,
				kill: vi.fn(),
				on: vi.fn(),
				removeListener: vi.fn(),
			},
			source: "test",
		})),
	};
}

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

/** A neighbour edge with no changed symbols, so no `references()` upgrade runs. */
function impact(filePath: string, neighbors: string[]) {
	return {
		filePath,
		changedSymbols: [] as string[],
		directImporters: neighbors,
		directCallers: [] as string[],
		neighborFiles: neighbors,
		riskFlags: [] as string[],
	};
}

const TOUCH_OPTIONS = {
	diagnostics: "document" as const,
	collectDiagnostics: true,
	clientScope: "primary" as const,
	source: "test-5040",
};

/**
 * One fixture for every case: a real `LSPService` over the fake server, the
 * importer's answer published while the exporter is intact, and one touch that
 * taught the server these exact bytes (so the next touch skips its notify,
 * which is the production shape this defect needs).
 */
async function setupServer(options: {
	prefix: string;
	serverId?: string;
	extension?: string;
	publishPreEdit?: boolean;
}) {
	const onResolveRoot: { current?: () => void } = {};
	const env = setupTestEnvironment(options.prefix);
	const serverId = options.serverId ?? "gopls";
	const importer = path.join(env.tmpDir, "C.go");
	fs.writeFileSync(importer, NEIGHBOR_CONTENT);
	const server = makePushOnlyServer({ serverId, filePath: importer });
	if (options.publishPreEdit !== false) {
		// The answer the server computed BEFORE the exporter edit: its own stamp,
		// a minute old, and it never republishes for this importer on its own.
		server.publish([], Date.now() - 60_000);
	}
	mocks.createLSPClient.mockResolvedValue(server.client);
	mocks.getServersForFileWithConfig.mockReturnValue([
		serverConfig(
			serverId,
			env.tmpDir,
			options.extension ?? ".go",
			onResolveRoot,
		),
	]);
	const { LSPService } = await import("../../clients/lsp/index.js");
	const service = new LSPService();
	// The first touch sends the bytes; a later touch of the same content skips.
	await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
	return { env, serverId, importer, server, service, onResolveRoot };
}

beforeEach(async () => {
	vi.resetModules();
	mocks.createLSPClient.mockReset();
	mocks.getServersForFileWithConfig.mockReset();
	mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
	mocks.computeImpactCascade.mockReset();
	mocks.computeTransitiveImpact.mockReset().mockReturnValue({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	});
	mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
	mocks.logCascade.mockReset();
	// #4709: the module setter belongs to one module copy, so it is armed after
	// the reset, for every case.
	(await import("../../clients/lsp/config.js"))._setServersForFileForTests(
		mocks.getServersForFileWithConfig,
	);
});

describe("the per-file publish stamp (#5040)", () => {
	// The one owner of "when were this file's diagnostics last stored": the
	// later of the push and pull stamps, which is exactly the `ts`
	// `getAllDiagnostics()` reports for the path. `touchFile` reads it through
	// the client accessor; `getAllDiagnostics` and `pruneDiagnostics` now read
	// it too, so the two cannot drift.
	function stampOf(state: {
		push?: number;
		pull?: number;
	}): number | undefined {
		return diagnosticsPublishedAtForPath(
			{
				pushDiagnosticTimestamps: new Map(
					state.push === undefined ? [] : [["repo/a.py", state.push]],
				),
				documentPullDiagnosticTimestamps: new Map(
					state.pull === undefined ? [] : [["repo/a.py", state.pull]],
				),
			} as unknown as Parameters<typeof diagnosticsPublishedAtForPath>[0],
			"repo/a.py",
		);
	}

	it("answers the newer of the push and pull stamps", () => {
		expect(stampOf({ push: 1_000, pull: 2_000 })).toBe(2_000);
		expect(stampOf({ push: 2_000, pull: 1_000 })).toBe(2_000);
		expect(stampOf({ push: 1_500 })).toBe(1_500);
	});

	it("answers nothing for a path with no stored publication", () => {
		expect(stampOf({})).toBeUndefined();
	});
});

describe("touchFile reports the cached answer it reused (#5040)", () => {
	it("names the server and the publish stamp of an answer it never refreshed", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-",
		});
		try {
			const preEditPublishedAt = server.state.publishedAt;
			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(result).toBeDefined();
			// Nothing was pushed this time: the server already holds these bytes
			// (`shouldSkipNotify`), so its cache entry is the whole answer.
			expect(server.state.notifies).toEqual(["open"]);
			expect(result?.diags).toEqual([]);
			expect(result?.inconclusive).toBeFalsy();
			expect(result?.confirmation).toBe("confirmed");
			expect(result?.reusedAnswer).toEqual({
				serverId: "gopls",
				publishedAt: preEditPublishedAt,
			});
		} finally {
			env.cleanup();
		}
	});

	it("reports no reused answer when the server published inside the touch", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-publish-",
		});
		try {
			// The server re-checks the importer on its own while the touch waits,
			// so the answer this touch reports is its own.
			server.state.publishOnWait = true;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(server.state.notifies).toEqual(["open"]);
			expect(result?.diags).toEqual([]);
			expect(result?.reusedAnswer).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("reports no reused answer for the #707 sync confirm, which is not a cached observation", async () => {
		process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "25";
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-sync-",
			serverId: "typescript",
		});
		try {
			// The pre-edit cache entry says clean; the sync command answers this
			// touch, and its answer is not a cached observation at all. The push
			// wait is held so only the command can settle it (classic tsserver).
			server.client.getAdvertisedCommands = () => [
				"typescript.tsserverRequest",
			];
			server.client.executeCommand = vi.fn(async () => ({
				executed: true,
				result: { success: true, body: [] },
			}));
			server.state.holdWait = true;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(server.client.executeCommand).toHaveBeenCalled();
			expect(result?.diags).toEqual([]);
			expect(result?.reusedAnswer).toBeUndefined();
		} finally {
			server.releaseWait();
			delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
			env.cleanup();
		}
	});

	// Recurrence (Greptile PRRT_kwDORt8rec6yL28Z on #5046): the merge copies the
	// pre-edit `[]`, then the touch awaits the readiness key, and an ERROR the
	// server publishes in that await moved the per-path version past the
	// pre-notify baseline. The version gate then read the touch as having its own
	// answer, so the stale `[]` returned with no `reusedAnswer` and the cascade
	// took it as a confirmed clean.
	it("names the answer it merged when the server publishes after the merge, before the result is built", async () => {
		const { env, importer, server, service, onResolveRoot } = await setupServer(
			{ prefix: "cascade-reused-answer-late-" },
		);
		try {
			const preEditPublishedAt = server.state.publishedAt;
			publishAfterMerge(onResolveRoot, server, [LATE_ERROR], Date.now());

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			// The array in the result is the one merged BEFORE the publication.
			expect(result?.diags).toEqual([]);
			expect(result?.reusedAnswer).toEqual({
				serverId: "gopls",
				publishedAt: preEditPublishedAt,
			});
		} finally {
			env.cleanup();
		}
	});

	// Recurrence: a file served by two primaries (two servers enabled for one
	// extension) reports the OLDEST cached answer, because a caller's verdict is
	// only as fresh as the stalest contributor. Newest-wins would read a file
	// whose other server never re-checked it as post-edit. Only a
	// `clientScope: "all"` touch spawns both: the cascade's own touch is
	// primary-scoped and spawns one, so this pins the touch contract, not a
	// cascade path.
	it("reports the oldest stamp when two primaries both reused a cached answer", async () => {
		const env = setupTestEnvironment("cascade-reused-answer-two-primaries-");
		const importer = path.join(env.tmpDir, "C.go");
		fs.writeFileSync(importer, NEIGHBOR_CONTENT);
		try {
			const newer = makePushOnlyServer({
				serverId: "gopls-newer",
				filePath: importer,
			});
			const older = makePushOnlyServer({
				serverId: "gopls",
				filePath: importer,
			});
			newer.publish([], Date.now() - 10_000);
			older.publish([], Date.now() - 60_000);
			const byId: Record<string, unknown> = {
				"gopls-newer": newer.client,
				gopls: older.client,
			};
			mocks.createLSPClient.mockImplementation(
				async (options: { serverId: string }) => byId[options.serverId],
			);
			// The NEWER server is listed first, so first-wins and newest-wins both
			// return it.
			mocks.getServersForFileWithConfig.mockReturnValue([
				serverConfig("gopls-newer", env.tmpDir, ".go"),
				serverConfig("gopls", env.tmpDir, ".go"),
			]);
			const { LSPService } = await import("../../clients/lsp/index.js");
			const service = new LSPService();
			await service.touchFile(importer, NEIGHBOR_CONTENT, {
				...TOUCH_OPTIONS,
				clientScope: "all",
			});

			const result = await service.touchFile(importer, NEIGHBOR_CONTENT, {
				...TOUCH_OPTIONS,
				clientScope: "all",
			});

			expect(result?.reusedAnswer).toEqual({
				serverId: "gopls",
				publishedAt: older.state.publishedAt,
			});
			expect(older.state.publishedAt).toBeLessThan(newer.state.publishedAt);
		} finally {
			env.cleanup();
		}
	});

	// The documented fall-through: a client that cannot date its cached answer
	// keeps today's verdict, exactly as a missing `binding` reads "unknown"
	// rather than demoted.
	it("reports no reused answer for a client that cannot date its cache", async () => {
		const { env, importer, server, service } = await setupServer({
			prefix: "cascade-reused-answer-unknown-",
		});
		try {
			delete server.client.getDiagnosticsPublishedAt;

			const result = await service.touchFile(
				importer,
				NEIGHBOR_CONTENT,
				TOUCH_OPTIONS,
			);

			expect(result?.reusedAnswer).toBeUndefined();
			expect(result?.confirmation).toBe("confirmed");
		} finally {
			env.cleanup();
		}
	});
});

describe("the cascade does not read a pre-edit answer as this edit's clean", () => {
	/**
	 * The production sequence: the importer's clean answer is published while the
	 * exporter is intact, the exporter is edited, and the cascade asks the
	 * importer again. The only difference between the cases is whether the server
	 * answers inside the cascade's touch.
	 */
	async function runCascade(options: {
		publishInsideTouch: boolean;
		/** The exporter's language: go (gopls) or java (jdtls, #5040 remainder). */
		lang?: "java";
		/** What the server publishes for the importer inside the touch. */
		insideTouchDiags?: unknown[];
		/** The server publishes after the cascade started and before its touch
		 *  of the neighbour (a stamp after the edit, nothing inside the touch). */
		publishBeforeTouch?: boolean;
		/** The server publishes an ERROR after the touch merged the cache. */
		publishErrorAfterMerge?: boolean;
	}) {
		const env = setupTestEnvironment("cascade-pre-edit-answer-");
		const java = options.lang === "java";
		const [serverId, ext] = java ? ["jdtls", ".java"] : ["gopls", ".go"];
		const exporter = path.join(env.tmpDir, `B${ext}`);
		const importer = path.join(env.tmpDir, `C${ext}`);
		fs.writeFileSync(exporter, "package main\n\nfunc Lib() {}\n");
		fs.writeFileSync(importer, NEIGHBOR_CONTENT);
		mocks.computeImpactCascade.mockReturnValue(impact(exporter, [importer]));

		const server = makePushOnlyServer({ serverId, filePath: importer });
		// The answer a jdtls-class server publishes for the importer BEFORE the
		// edit, and then never republishes for it on its own.
		server.publish([], Date.now() - 60_000);
		mocks.createLSPClient.mockResolvedValue(server.client);
		const onResolveRoot: { current?: () => void } = {};
		mocks.getServersForFileWithConfig.mockReturnValue([
			serverConfig(serverId, env.tmpDir, ext, onResolveRoot),
		]);

		const { LSPService } = await import("../../clients/lsp/index.js");
		const service = new LSPService();
		installLspService(service);
		// The importer was read once before the edit, which is what makes the
		// cascade's touch of it a notify-skipped one.
		await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
		// Armed AFTER the pre-edit read, so it is the cascade's own touch the
		// server answers.
		if (options.publishInsideTouch) {
			server.state.publishOnWait = true;
			server.state.waitDiags = options.insideTouchDiags ?? [];
		}
		if (options.publishBeforeTouch) {
			// The graph build runs after `cascadeStart` and before the neighbour
			// touch, so a stamp from here is a post-edit publication the touch
			// finds already cached. 1 s ahead keeps it past `cascadeStart` on any
			// clock tick.
			mocks.buildOrUpdateGraph.mockImplementationOnce(async () => {
				server.publish([], Date.now() + 1_000);
				return emptyGraph();
			});
		}
		if (options.publishErrorAfterMerge) {
			publishAfterMerge(
				onResolveRoot,
				server,
				[LATE_ERROR],
				Date.now() + 1_000,
			);
		}
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");

		// The exporter edit: the change the importer's answer predates.
		fs.writeFileSync(exporter, "package main\n\nfunc Lib(a string) {}\n");
		const run = await computeCascadeForFile(exporter, env.tmpDir, {
			turnSeq: 1,
			writeSeq: 1,
		});
		return { env, run, importer, server, serverId };
	}

	it("reads a neighbour whose cached answer predates the edit as unconfirmed, never clean", async () => {
		const { env, run, importer, server } = await runCascade({
			publishInsideTouch: false,
		});
		try {
			// The server never answered this edit for the importer.
			expect(server.state.notifies).toEqual(["open"]);
			expect(run.skipReason).toBe("indeterminate");
			expect(run.result).toBeUndefined();
			expect(run.unconfirmed?.servers).toEqual([
				{
					serverId: "gopls",
					reason: "pre-edit-answer",
					waitMs: 0,
					paths: [importer],
				},
			]);
			expect(run.observedNeighborPaths).toBeUndefined();
			// The decision is recorded on cascade.log, not only implied by the run.
			const touchRow = mocks.logCascade.mock.calls
				.map((args) => args[0] as { phase?: string; metadata?: unknown })
				.filter((row) => row?.phase === "neighbor_touch")
				.at(-1);
			expect(touchRow?.metadata).toMatchObject({
				preEditAnswer: true,
				answerServerId: "gopls",
			});
		} finally {
			env.cleanup();
		}
	});

	it("still reads a neighbour clean when the server answered inside the touch", async () => {
		const { env, run, importer } = await runCascade({
			publishInsideTouch: true,
		});
		try {
			expect(run.skipReason).toBe("clean");
			expect(run.unconfirmed).toBeUndefined();
			expect(run.observedNeighborPaths).toEqual([importer]);
		} finally {
			env.cleanup();
		}
	});

	// State-table row 4: push-only, notify SKIPPED, but the entry the touch reuses
	// was published AFTER the edit (jdtls republishing one importer of an edited
	// exporter, #5035's capture). `reusedAnswer` IS set here, which is what makes
	// this a different case from the one above, where the version gate drops it.
	// Recurrence it prevents: an age gate that drops the stamp comparison turns
	// every republished dependent into an unconfirmed line and loses its error.
	it("still reads a neighbour clean when the server republished it after the edit", async () => {
		const { env, run, importer, server } = await runCascade({
			publishInsideTouch: false,
			publishBeforeTouch: true,
		});
		try {
			// Nothing was pushed or awaited inside the touch: the reused entry is
			// the one published after `cascadeStart`.
			expect(server.state.notifies).toEqual(["open"]);
			expect(run.skipReason).toBe("clean");
			expect(run.unconfirmed).toBeUndefined();
			expect(run.observedNeighborPaths).toEqual([importer]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (Greptile PRRT_kwDORt8rec6yL28Z on #5046): an error published
	// between the touch's cache merge and its result assembly read as "the touch
	// has its own answer", so the stale `[]` was a confirmed clean and the new
	// error was lost.
	it("reads a neighbour unconfirmed when its error lands after the touch merged the cache", async () => {
		const { env, run, importer } = await runCascade({
			publishInsideTouch: false,
			publishErrorAfterMerge: true,
		});
		try {
			expect(run.skipReason).toBe("indeterminate");
			expect(run.unconfirmed?.servers).toEqual([
				{
					serverId: "gopls",
					reason: "pre-edit-answer",
					waitMs: 0,
					paths: [importer],
				},
			]);
			expect(run.observedNeighborPaths).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("records the pre-edit answer in the degradation ledger", async () => {
		const { env, run } = await runCascade({ publishInsideTouch: false });
		try {
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			const kinds = getDegradationSummary().map((entry) => entry.kind);
			expect(kinds).toContain("cascade-pre-edit-answer");
			expect(run.skipReason).toBe("indeterminate");
		} finally {
			env.cleanup();
		}
	});

	// #5040 remainder: java joined CASCADE_GRAPH_KINDS once a push-only server's
	// pre-edit answer stopped reading as clean. Recurrence each cell prevents:
	// before the membership, a Java exporter edit ended `skipReason: "non_code"`
	// before any importer was asked (tool-smoke run 41027095385, 30 attempts, no
	// importer touched), whatever jdtls would have said; and with the membership
	// but without the pre-edit refusal, jdtls's silent importer read `clean`
	// (PR #5035's wire capture). One cell per verdict state of the java cascade.
	describe("for a java exporter, jdtls's three answers", () => {
		it("delivers the error jdtls published for the importer inside the touch", async () => {
			const { env, run, importer, serverId } = await runCascade({
				lang: "java",
				publishInsideTouch: true,
				insideTouchDiags: [LATE_ERROR],
			});
			try {
				expect(serverId).toBe("jdtls");
				expect(run.skipReason).toBeUndefined();
				expect(run.unconfirmed).toBeUndefined();
				expect(run.observedNeighborPaths).toEqual([importer]);
				expect(run.result?.formatted).toContain("late error");
			} finally {
				env.cleanup();
			}
		});

		it("confirms a clean importer when jdtls answered inside the touch", async () => {
			const { env, run, importer } = await runCascade({
				lang: "java",
				publishInsideTouch: true,
			});
			try {
				expect(run.skipReason).toBe("clean");
				expect(run.unconfirmed).toBeUndefined();
				expect(run.observedNeighborPaths).toEqual([importer]);
			} finally {
				env.cleanup();
			}
		});

		it("reads an importer jdtls never republished as unconfirmed, never clean", async () => {
			const { env, run, importer } = await runCascade({
				lang: "java",
				publishInsideTouch: false,
			});
			try {
				expect(run.skipReason).toBe("indeterminate");
				expect(run.result).toBeUndefined();
				expect(run.unconfirmed?.servers).toEqual([
					{
						serverId: "jdtls",
						reason: "pre-edit-answer",
						waitMs: 0,
						paths: [importer],
					},
				]);
				expect(run.observedNeighborPaths).toBeUndefined();
			} finally {
				env.cleanup();
			}
		});
	});
});

describe("a fallback's rows beside an unanswered primary follow the touch's freshness (#5034 r7)", () => {
	/** The finding the fallback published for the importer. */
	const FALLBACK_ERROR = { ...LATE_ERROR, message: "fallback finding" };

	/**
	 * The #5014 production shape through the real service: the owner (`gopls`)
	 * resolves a root and fails to start, so its `fallbackFor` alternate
	 * (`gopls-alt`) is acquired and answers the importer. Every touch then
	 * names the owner (`primary-unavailable`) and carries the alternate's rows.
	 * The alternate stores the content binding of the bytes it last answered,
	 * like a version-echoing client.
	 */
	async function runFallbackCascade(options: {
		/** When the alternate's answer for the importer was published:
		 *  before the edit, or after the cascade started (during its graph build). */
		answer: "pre-edit" | "post-edit";
		/** The importer is rewritten on disk after the alternate last saw it,
		 *  with nothing telling the server (a formatter, a checkout). */
		rewriteImporterOutOfBand?: boolean;
	}) {
		const env = setupTestEnvironment("cascade-fallback-freshness-");
		const exporter = path.join(env.tmpDir, "B.go");
		const importer = path.join(env.tmpDir, "C.go");
		fs.writeFileSync(exporter, "package main\n\nfunc Lib() {}\n");
		fs.writeFileSync(importer, NEIGHBOR_CONTENT);
		mocks.computeImpactCascade.mockReturnValue(impact(exporter, [importer]));

		const alternate = makePushOnlyServer({
			serverId: "gopls-alt",
			filePath: importer,
		});
		// The binding of the bytes the alternate's stored answer was computed for.
		let answeredHash: string | undefined;
		alternate.client.getDiagnosticBinding = () =>
			answeredHash === undefined
				? undefined
				: { version: alternate.state.version, contentHash: answeredHash };
		const publishFor = (bytes: string, publishedAt: number) => {
			answeredHash = hashDiagnosticContent(bytes);
			alternate.publish([FALLBACK_ERROR], publishedAt);
		};
		if (options.answer === "pre-edit") {
			publishFor(NEIGHBOR_CONTENT, Date.now() - 60_000);
		}
		mocks.createLSPClient.mockImplementation(
			async (spawnOptions: { serverId: string }) => {
				if (spawnOptions.serverId === "gopls-alt") return alternate.client;
				throw new Error("spawn gopls ENOENT");
			},
		);
		mocks.getServersForFileWithConfig.mockReturnValue([
			serverConfig("gopls", env.tmpDir, ".go"),
			{
				...serverConfig("gopls-alt", env.tmpDir, ".go"),
				fallbackFor: "gopls",
			},
		]);

		const { LSPService } = await import("../../clients/lsp/index.js");
		const service = new LSPService();
		installLspService(service);
		// The importer was read once before the edit: the alternate holds its bytes.
		await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
		if (options.rewriteImporterOutOfBand) {
			fs.writeFileSync(importer, `${NEIGHBOR_CONTENT}\nfunc other() {}\n`);
		}
		if (options.answer === "post-edit") {
			// After `cascadeStart`, before the neighbour touch: the alternate
			// republishes the importer for the bytes it holds.
			mocks.buildOrUpdateGraph.mockImplementationOnce(async () => {
				publishFor(NEIGHBOR_CONTENT, Date.now() + 1_000);
				return emptyGraph();
			});
		}
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");

		fs.writeFileSync(exporter, "package main\n\nfunc Lib(a string) {}\n");
		const run = await computeCascadeForFile(exporter, env.tmpDir, {
			turnSeq: 1,
			writeSeq: 1,
		});
		const touchRow = mocks.logCascade.mock.calls
			.map(
				(args) =>
					args[0] as {
						phase?: string;
						diagnosticCount?: number;
						metadata?: Record<string, unknown>;
					},
			)
			.filter((row) => row?.phase === "neighbor_touch")
			.at(-1);
		return { env, run, importer, alternate, touchRow };
	}

	// Control (state-table row P4): the alternate's reused answer was published
	// after the edit, for the bytes on disk. Its finding is delivered beside
	// the owner's line. Recurrence: a gate that withholds every fallback row
	// (an over-broad freshness check) loses the finding #5014 r2 F2 delivered.
	it("delivers a fallback's post-edit answer for the current bytes beside the line", async () => {
		const { env, run, touchRow } = await runFallbackCascade({
			answer: "post-edit",
		});
		try {
			expect(touchRow?.metadata).toMatchObject({
				inconclusiveReason: "primary-unavailable",
			});
			expect(run.result?.unansweredPrimaries?.notes).toHaveLength(1);
			expect(run.result?.formatted).toContain("fallback finding");
			expect(touchRow?.diagnosticCount).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (CodeRabbit PRRT_kwDORt8rec6yMj20 on #5034, row P3): the
	// alternate's answer predates the edit (notify skipped, nothing published
	// since), and the primary-unavailable branch displayed it before the #5040
	// pre-edit check that guards the confirmed branch below it.
	it("withholds a fallback's pre-edit rows and keeps the owner's line", async () => {
		const { env, run, alternate, touchRow } = await runFallbackCascade({
			answer: "pre-edit",
		});
		try {
			expect(run.result?.formatted).not.toContain("fallback finding");
			expect(run.result?.unansweredPrimaries?.notes).toHaveLength(1);
			// Nothing was sent: the alternate already held these bytes.
			expect(alternate.state.notifies).toEqual(["open"]);
			expect(touchRow?.metadata).toMatchObject({
				inconclusiveReason: "primary-unavailable",
				preEditAnswer: true,
				answerServerId: "gopls-alt",
			});
			expect(touchRow?.diagnosticCount).toBe(0);
			expect(run.observedNeighborPaths).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (CodeRabbit PRRT_kwDORt8rec6yMj20 on #5034, row P5): the
	// alternate republished after the edit, but for bytes the importer no
	// longer holds on disk (`binding.boundToCurrentDisk === false`). The runner
	// withholds such rows on the same touch shape (#5034 r3 F7); the cascade
	// displayed them.
	it("withholds a fallback's rows bound to other bytes than disk and keeps the owner's line", async () => {
		const { env, run, alternate, touchRow } = await runFallbackCascade({
			answer: "post-edit",
			rewriteImporterOutOfBand: true,
		});
		try {
			expect(run.result?.formatted).not.toContain("fallback finding");
			expect(run.result?.unansweredPrimaries?.notes).toHaveLength(1);
			// The touch sent the new bytes; the alternate did not answer them.
			expect(alternate.state.notifies).toHaveLength(2);
			expect(touchRow?.metadata).toMatchObject({
				inconclusiveReason: "primary-unavailable",
				bindingState: "mismatch",
			});
			expect(touchRow?.metadata?.preEditAnswer).toBeUndefined();
			expect(touchRow?.diagnosticCount).toBe(0);
			expect(run.observedNeighborPaths).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("a primary's touch rows follow the answer's content binding (#5051)", () => {
	type Binding = "bound" | "other-bytes" | "unknown" | "absent";

	/**
	 * The production sequence: the importer is read once, the exporter is
	 * edited, and the cascade's own touch of the importer gets an answer with an
	 * ERROR row, published inside the touch (so the #5040 age gate admits it).
	 * The only axis is what the answer's stored content binding says against the
	 * bytes on disk: the same bytes, other bytes, no fingerprint (a version-less
	 * server), or no `binding` on the touch result at all.
	 */
	async function runBoundCascade(binding: Binding) {
		const env = setupTestEnvironment("cascade-bound-false-");
		const exporter = path.join(env.tmpDir, "B.go");
		const importer = path.join(env.tmpDir, "C.go");
		fs.writeFileSync(exporter, "package main\n\nfunc Lib() {}\n");
		fs.writeFileSync(importer, NEIGHBOR_CONTENT);
		mocks.computeImpactCascade.mockReturnValue(impact(exporter, [importer]));

		const server = makePushOnlyServer({ filePath: importer });
		server.publish([], Date.now() - 60_000);
		let answeredHash: string | undefined;
		server.client.getDiagnosticBinding = () =>
			answeredHash === undefined
				? undefined
				: { version: server.state.version, contentHash: answeredHash };
		mocks.createLSPClient.mockResolvedValue(server.client);
		mocks.getServersForFileWithConfig.mockReturnValue([
			serverConfig("gopls", env.tmpDir, ".go"),
		]);
		const { LSPService } = await import("../../clients/lsp/index.js");
		const service = new LSPService();
		installLspService(service);
		await service.touchFile(importer, NEIGHBOR_CONTENT, TOUCH_OPTIONS);
		// The server answers the cascade's touch with an error, computed for the
		// bytes the binding names.
		server.client.waitForDiagnostics = vi.fn(async () => {
			answeredHash =
				binding === "bound"
					? hashDiagnosticContent(NEIGHBOR_CONTENT)
					: binding === "other-bytes"
						? hashDiagnosticContent("package main\n\nfunc other() {}\n")
						: undefined;
			server.publish([LATE_ERROR], Date.now());
		});
		if (binding === "absent") {
			// A touch result that carries no `binding` (a non-collecting or
			// partially-mocked client): the wrapper without the field.
			const touchFile = service.touchFile.bind(service);
			service.touchFile = (async (...args: Parameters<typeof touchFile>) => {
				const touched = await touchFile(...args);
				if (touched === undefined || typeof touched !== "object") {
					return touched;
				}
				const { binding: _binding, ...rest } = touched as {
					binding?: unknown;
				};
				return rest;
			}) as typeof service.touchFile;
		}
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");
		fs.writeFileSync(exporter, "package main\n\nfunc Lib(a string) {}\n");
		const run = await computeCascadeForFile(exporter, env.tmpDir, {
			turnSeq: 1,
			writeSeq: 1,
		});
		const touchRow = mocks.logCascade.mock.calls
			.map(
				(args) =>
					args[0] as {
						phase?: string;
						diagnosticCount?: number;
						metadata?: Record<string, unknown>;
					},
			)
			.filter((row) => row?.phase === "neighbor_touch")
			.at(-1);
		return { env, exporter, importer, run, touchRow };
	}

	// Recurrence (#5051, found by the #5034 r7 verify): the confirmed-touch
	// branch read the binding for confirmation only, so rows computed for bytes
	// the importer no longer holds were displayed as this edit's cascade error
	// while the LSP runner withheld the same rows (#5017 L).
	it("withholds rows bound to other bytes than disk, keeps the line, never reads clean", async () => {
		const { env, run, touchRow } = await runBoundCascade("other-bytes");
		try {
			expect(run.result?.formatted ?? "").not.toContain("late error");
			expect(run.result?.neighbors.flatMap((n) => n.diagnostics) ?? []).toEqual(
				[],
			);
			// The run owes the neighbour its line and does not read clean.
			expect(run.skipReason).not.toBe("clean");
			expect(run.result?.formatted).toContain("inconclusive for 1");
			expect(run.result?.formatted).toContain("C.go");
			expect(run.observedNeighborPaths).toBeUndefined();
			expect(touchRow?.diagnosticCount).toBe(0);
			expect(touchRow?.metadata).toMatchObject({ bindingState: "mismatch" });
		} finally {
			env.cleanup();
		}
	});

	// Control (the pre-#1095 fall-through): a bound, unknown or absent binding
	// still displays its rows. Recurrence: a gate that withholds on anything but
	// an explicit `false` loses every version-less server's findings.
	it.each(["bound", "unknown", "absent"] as const)(
		"still displays the rows of an answer whose binding is %s",
		async (binding) => {
			const { env, run, touchRow } = await runBoundCascade(binding);
			try {
				expect(run.result?.formatted).toContain("late error");
				expect(touchRow?.diagnosticCount).toBe(1);
				expect(touchRow?.metadata?.bindingState).toBeUndefined();
			} finally {
				env.cleanup();
			}
		},
	);

	// Acceptance 4: the withheld rows reach turn_end through the real
	// `handleTurnEnd`. Recurrence: the displayed stale rows were recorded as the
	// neighbour's pending cascade record, replacing the entry an earlier
	// delivered observation left (#4487).
	it("does not record withheld rows as turn_end's observation", async () => {
		const { env, exporter, importer, run } =
			await runBoundCascade("other-bytes");
		try {
			const { CacheManager } = await import("../../clients/cache-manager.js");
			const { RuntimeCoordinator } =
				await import("../../clients/runtime-coordinator.js");
			const { handleTurnEnd } = await import("../../clients/runtime-turn.js");
			const { consumeTurnEndFindings } =
				await import("../../clients/runtime-context.js");
			const format = await import("../../clients/cascade-format.js");
			const seeded = (id: string, line: number) => ({
				id,
				message: `earlier ${id}`,
				filePath: importer,
				line,
				column: 1,
				severity: "error" as const,
				semantic: "blocking" as const,
				tool: "lsp",
				rule: "cascade:test",
			});
			format.resetCascadePendingNeighbors();
			format.recordDeliveredCascadeNeighbor(
				importer,
				[seeded("a", 1), seeded("b", 2)],
				0,
				12345,
			);
			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			cacheManager.addModifiedRange(
				exporter,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);
			runtime.beginTurn();
			runtime.appendCascadeRun(run);
			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => ({
						success: true,
						issues: [],
						unusedExports: [],
						unusedFiles: [],
						unusedDeps: [],
						unlistedDeps: [],
						summary: "skipped",
					}),
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as never);
			const content =
				consumeTurnEndFindings(cacheManager, env.tmpDir)?.messages[0]
					?.content ?? "";
			// Recurrence (#5053 review F1): the absences below also hold when the
			// cascade section is never delivered at all (a dead `blockerParts.push`).
			// The positive pair pins what turn_end DID deliver: the withheld
			// neighbour's inconclusive line.
			expect(content).toContain("inconclusive for 1");
			expect(content).toContain("C.go");
			expect(content).not.toContain("late error");
			expect(content).not.toContain("Cascade errors in");
			expect(format.listCascadePendingNeighbors()).toEqual([
				{ filePath: importer, errorCount: 2, checkedAt: 12345 },
			]);
		} finally {
			env.cleanup();
		}
	});
});
