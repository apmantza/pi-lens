/**
 * #3939 / PR #3966 F1: the workspace sweep's warm-up (`ensureWarmForSweep`)
 * required EVERY non-auxiliary server that matches a file to prove readiness,
 * but `getClientForFile` serves a file from the FIRST server that spawns. A
 * `fallbackFor` pair is one family: a never-spawned alternate (or a cold
 * preferred that lost to its working alternate) stayed "cold" forever, so
 * `failedServerIds` named it and `runWorkspaceDiagnosticsSwept` skipped the
 * whole group as `skippedWarmupFailure` while a server for the language was
 * working. Recurrence this guards: docker-official (new), expert and
 * python-jedi (already shipped, same shape).
 *
 * REAL registry, REAL config, REAL `LSPService`, REAL `runWorkspaceDiagnostics`
 * sweep: only the child launcher (`clients/lsp/launch.js`) and the JSON-RPC
 * transport (`clients/lsp/client.js`) are doubled. Nothing here claims the
 * real binaries speak the protocol.
 *
 * Two independent directions (AGENTS.md shape 54): the family is satisfied by
 * ANY member that answered (no false skip), and a family where no member
 * answered still skips, INCLUDING when the member that failed to answer is the
 * selected fallback (no drop of a genuine failure).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const launchMock = vi.hoisted(() => vi.fn());
const createLSPClientMock = vi.hoisted(() => vi.fn());
const findManagedToolBinaryMock = vi.hoisted(() => vi.fn());
const ensureToolMock = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP: launchMock,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	findManagedToolBinary: findManagedToolBinaryMock,
	ensureTool: ensureToolMock,
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient: createLSPClientMock,
}));

interface Family {
	readonly name: string;
	/** Relative path of the swept file inside the temp project. */
	readonly file: string;
	/** Marker that gives both members a root. */
	readonly marker: string;
	readonly preferredId: string;
	readonly fallbackId: string;
	readonly isPreferredCommand: (command: string) => boolean;
	readonly isFallbackCommand: (command: string) => boolean;
}

const base = (command: string) => path.basename(command);

const FAMILIES: readonly Family[] = [
	{
		name: "docker",
		file: "Dockerfile",
		marker: ".git",
		preferredId: "docker",
		fallbackId: "docker-official",
		isPreferredCommand: (c) => /^docker-langserver/.test(base(c)),
		isFallbackCommand: (c) => /^docker-language-server/.test(base(c)),
	},
	{
		name: "elixir",
		file: "lib/a.ex",
		marker: "mix.exs",
		preferredId: "elixir",
		fallbackId: "expert",
		isPreferredCommand: (c) => /^elixir-ls/.test(base(c)),
		isFallbackCommand: (c) => /^expert/.test(base(c)),
	},
	{
		name: "python",
		file: "a.py",
		marker: "pyproject.toml",
		preferredId: "python",
		fallbackId: "python-jedi",
		isPreferredCommand: (c) => /^pyright/.test(base(c)),
		isFallbackCommand: (c) => /^jedi-language-server/.test(base(c)),
	},
];

function toolNotFound() {
	return Object.assign(new Error("ENOENT: command not found"), {
		kind: "tool-not-found" as const,
	});
}

function fakeProcess() {
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
		pid: 4242,
		command: "test",
		args: [] as string[],
	};
}

/** Servers whose client never answers a diagnostics wait (resolves at its deadline). */
let silentServerIds: ReadonlySet<string> = new Set();

function makeClient(serverId: string, root: string) {
	return {
		serverId,
		root,
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => false),
		wasShutdownIntentional: vi.fn(() => true),
		shutdown: vi.fn(async () => undefined),
		getProcessPid: () => 4242,
		recentStderr: () => "",
		checkAlive: () => undefined,
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getTrackedDiagnosticPaths: vi.fn(() => []),
		pruneDiagnostics: vi.fn(() => 0),
		getDiagnosticBinding: vi.fn(() => undefined),
		diagnosticsVersion: 1,
		getDiagnosticsVersionForPath: vi.fn(() => 1),
		waitForDiagnostics: vi.fn(async (_filePath: string, ms: number) => {
			if (silentServerIds.has(serverId)) {
				// Mirror a real client resolving `undefined` at its own deadline: the
				// touch measures `Date.now()` around this wait, so advancing the
				// faked clock by the budget makes it inconclusive (the server is NOT
				// marked ready) with no raw timer wait.
				vi.setSystemTime(Date.now() + ms);
			}
			return undefined;
		}),
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "unavailable" as const,
		})),
		getOperationSupport: vi.fn(() => ({})),
		getMalformedFileOperationRegistrations: () => new Set(),
	};
}

type Arm = "preferred-only" | "fallback-only" | "both" | "neither";

function armLauncher(family: Family, arm: Arm) {
	const preferredUp = arm === "preferred-only" || arm === "both";
	const fallbackUp = arm === "fallback-only" || arm === "both";
	return async (command: string) => {
		if (family.isPreferredCommand(command) && preferredUp) {
			return fakeProcess();
		}
		if (family.isFallbackCommand(command) && fallbackUp) {
			return fakeProcess();
		}
		throw toolNotFound();
	};
}

describe("sweep warm-up treats a fallbackFor pair as one family (#3939 F1)", () => {
	let root: string;

	beforeEach(async () => {
		const lspServer = await import("../../../clients/lsp/server.js");
		lspServer.resetDirectLspCommandAvailability();
		launchMock.mockReset();
		createLSPClientMock.mockReset();
		findManagedToolBinaryMock.mockReset();
		ensureToolMock.mockReset();
		findManagedToolBinaryMock.mockResolvedValue(undefined);
		ensureToolMock.mockResolvedValue(false);
		createLSPClientMock.mockImplementation(
			async (args: { serverId: string; root?: string }) =>
				makeClient(args.serverId, args.root ?? root),
		);
		silentServerIds = new Set();
		vi.useFakeTimers({ toFake: ["Date"] });
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Tiny per-server budget and no retry backoff so a scripted silent server
		// resolves in ~50ms (same knobs as sweep-warmup.test.ts).
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warmup-family-"));
		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		roots.registerSessionRoot(root);
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		const roots = await import("../../../clients/lsp/session-roots.js");
		roots.resetSessionRootsForTests();
		const trust = await import("../../../clients/project-trust.js");
		trust.resetProjectTrust();
		removeTempDirSync(root);
	});

	function project(family: Family): string {
		const file = path.join(root, family.file);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const marker = path.join(root, family.marker);
		if (family.marker === ".git") fs.mkdirSync(marker, { recursive: true });
		else fs.writeFileSync(marker, "");
		fs.writeFileSync(file, "# fixture\n");
		return file;
	}

	async function sweep(family: Family, arm: Arm) {
		const file = project(family);
		launchMock.mockImplementation(armLauncher(family, arm));
		// Keep the real LSP module graph intact: the direct-command availability
		// latch is process/session state, and resetModules() split the registry's
		// Elixir server objects from the service's server module. This fixture uses
		// the real trust seam after importing the service that consumes it.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		const service = new LSPService();
		try {
			const results = await service.runWorkspaceDiagnostics(root, {
				files: [file],
			});
			return { results, service };
		} catch (error) {
			await service.shutdown();
			throw error;
		}
	}

	for (const family of FAMILIES) {
		describe(family.name, () => {
			it("the family selects both members for the file (premise: the registry pairs them)", async () => {
				const { explainServersForFile, registerLSPConfig } =
					await import("../../../clients/lsp/config.js");
				project(family);
				const selected = explainServersForFile(
					path.join(root, family.file),
					registerLSPConfig({}),
				)
					.filter(
						(entry) => entry.selected && entry.server.role !== "auxiliary",
					)
					.map((entry) => entry.server.id);
				expect(selected).toEqual([family.preferredId, family.fallbackId]);
			});

			for (const arm of ["preferred-only", "fallback-only", "both"] as const) {
				it(`${arm}: the sweep serves the group (a never-spawned or cold-but-shadowed member is not a warm-up failure)`, async () => {
					const { results, service } = await sweep(family, arm);
					expect(results).toHaveLength(1);
					expect(results[0]?.skippedWarmupFailure).toBeUndefined();
					expect(results[0]?.timedOut).toBeFalsy();
					await service.shutdown();
				});
			}

			it("neither: the group is still skipped as a warm-up failure and names both members", async () => {
				const { results, service } = await sweep(family, "neither");
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({
					timedOut: true,
					unconfirmedReason: "inconclusive",
					skippedWarmupFailure: true,
				});
				await service.shutdown();
			});

			it("the warm-up names both members when neither answers, and the selected fallback when it is the one that failed (no-drop)", async () => {
				// The skip alone cannot tell "the preferred failed" from "the preferred
				// and the selected fallback failed": a guard that exempted every
				// `fallbackFor` member from the cold set would still skip through the
				// preferred. The verdict names who failed, so assert the ids.
				const file = project(family);
				launchMock.mockImplementation(armLauncher(family, "fallback-only"));
				silentServerIds = new Set([family.fallbackId]);
				const { LSPService } = await import("../../../clients/lsp/index.js");
				const trust = await import("../../../clients/project-trust.js");
				trust.setProjectTrustState("trusted");
				const service = new LSPService();
				const warmup = await service.ensureWarmForSweep(file);
				expect(warmup.performedWarmup).toBe(true);
				expect(warmup.failedServerIds).toEqual([
					family.preferredId,
					family.fallbackId,
				]);
				await service.shutdown();
			});

			it("the selected fallback fails to answer: its failure still skips the group (no-drop)", async () => {
				// The preferred is unavailable, so the fallback is the one serving the
				// file; it spawns but never answers. A fix that exempted every
				// `fallbackFor` member from the required set would call this clean.
				silentServerIds = new Set([family.fallbackId]);
				const { results, service } = await sweep(family, "fallback-only");
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({
					timedOut: true,
					skippedWarmupFailure: true,
				});
				await service.shutdown();
			});

			it("the preferred spawns but never answers while the fallback was never tried: still skipped", async () => {
				// The preferred won acquisition (first to spawn) and failed its
				// verdict. The alternate was never asked, so it cannot vouch for the
				// family: the sweep must not read the family as ready.
				silentServerIds = new Set([family.preferredId]);
				const { results, service } = await sweep(family, "both");
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({
					timedOut: true,
					skippedWarmupFailure: true,
				});
				await service.shutdown();
			});
		});
	}
});
