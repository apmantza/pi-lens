/**
 * #3939: the official Docker Language Server (docker/docker-language-server,
 * `docker-language-server start --stdio`) is a same-language alternate of the
 * legacy rcjsuen npm server (`docker-langserver --stdio`). Its binary name and
 * argv differ, so it cannot ride DockerServer's shared-args candidate chain
 * (#3939); it is registered as a `fallbackFor: "docker"` alternate instead.
 *
 * Upstream provenance of the argv vector asserted below (AGENTS.md shape 16):
 * docker/docker-language-server commit 5187ff578db630f5df5b5922a10d8415a5bb7d32
 * (main, 26 commits after tag v0.20.1 = cb62b8b3710e81988521238c89232e95ef728111).
 * `internal/pkg/cli/start.go` at both commits declares the `start` subcommand
 * and its `--stdio` flag, so `["start", "--stdio"]` is the upstream contract,
 * not a guess from the issue text.
 *
 * This is the REAL registry + REAL config + REAL LSPService acquisition path:
 * only the two external boundaries are doubled — the child launcher
 * (`clients/lsp/launch.js`) and the JSON-RPC transport
 * (`clients/lsp/client.js`). No official (or legacy) binary is installed or
 * spawned here, so nothing here claims the official server speaks the
 * protocol, its publish order, or its idle cost; those stay unmeasured.
 *
 * The matrix has two independent directions (AGENTS.md shape 54):
 *   - safety: the alternate must NOT be acquired while `docker` succeeds (no
 *     duplicate publications);
 *   - no-drop: the alternate MUST be acquired when `docker` declines/throws —
 *     the official-only host the reporter has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const FILE = "/proj/Dockerfile";

function toolNotFound(message = "ENOENT: command not found") {
	return Object.assign(new Error(message), {
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

function makeClient(serverId: string) {
	return {
		serverId,
		root: "/proj",
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
		waitForDiagnostics: vi.fn(async () => undefined),
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "unavailable" as const,
		})),
		getOperationSupport: vi.fn(() => ({})),
		getMalformedFileOperationRegistrations: () => new Set(),
	};
}

type Arm =
	| "legacy-only"
	| "official-only"
	| "both"
	| "failing-legacy"
	| "neither";

const isLegacyCommand = (command: string) =>
	/docker-langserver/.test(command) && !/docker-language-server/.test(command);
const isOfficialCommand = (command: string) =>
	/docker-language-server/.test(command);

/** Launcher double: succeeds for the binaries the arm says are present. */
function armLauncher(arm: Arm) {
	return async (command: string, _args: string[]) => {
		if (isLegacyCommand(command)) {
			if (arm === "legacy-only" || arm === "both") return fakeProcess();
			throw toolNotFound();
		}
		if (isOfficialCommand(command)) {
			if (
				arm === "official-only" ||
				arm === "both" ||
				arm === "failing-legacy"
			) {
				return fakeProcess();
			}
			throw toolNotFound();
		}
		throw toolNotFound();
	};
}

function launchedCommands(): string[] {
	return launchMock.mock.calls.map(([command]) => String(command));
}

beforeEach(() => {
	launchMock.mockReset();
	createLSPClientMock.mockReset();
	findManagedToolBinaryMock.mockReset();
	ensureToolMock.mockReset();
	findManagedToolBinaryMock.mockResolvedValue(undefined);
	ensureToolMock.mockResolvedValue(false);
	createLSPClientMock.mockImplementation(async (args: { serverId: string }) =>
		makeClient(args.serverId),
	);
	// No managed install: the official server has no installer entry, and the
	// legacy npm install must never fire in this mock-only matrix.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
});

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	const { resetSessionRootsForTests } =
		await import("../../../clients/lsp/session-roots.js");
	resetSessionRootsForTests();
});

describe("docker official alternate registry (#3939)", () => {
	it("declares the official binary as a fallback of docker that is not resident", async () => {
		const { DockerOfficialServer, DockerServer, LSP_SERVERS } =
			await import("../../../clients/lsp/server.js");
		expect(DockerOfficialServer.id).toBe("docker-official");
		expect(DockerOfficialServer.fallbackFor).toBe("docker");
		// Introduced unmeasured; the nightly promotion PR (#3989) may later flip it to
		// transparent on evidence, so only `resident` (never evicted) is wrong here.
		// The promoter cannot attribute docker's numbers to docker-official; a bare flip
		// still reds the registry reason and class pins, so this stays relaxed.
		expect(["unmeasured", "transparent"]).toContain(
			DockerOfficialServer.idleEviction,
		);
		expect(DockerOfficialServer.extensions).toEqual(DockerServer.extensions);
		// The legacy server must stay the first candidate for the extension.
		expect(LSP_SERVERS.find((s) => s.id === "docker")).toBe(DockerServer);
		expect(LSP_SERVERS.find((s) => s.id === "docker-official")).toBe(
			DockerOfficialServer,
		);
		expect(LSP_SERVERS.indexOf(DockerOfficialServer)).toBeGreaterThan(
			LSP_SERVERS.indexOf(DockerServer),
		);
	});
});

describe("docker official alternate acquisition (#3939)", () => {
	for (const arm of [
		"legacy-only",
		"official-only",
		"both",
		"failing-legacy",
		"neither",
	] as const) {
		it(`${arm}: acquires exactly the available server with the official argv`, async () => {
			launchMock.mockImplementation(armLauncher(arm));
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const { clients, serverCountAttempted } =
				await service.getClientsForFile(FILE);
			const ids = clients.map((entry) => entry.info.id).sort();

			if (arm === "legacy-only" || arm === "both") {
				expect(ids).toEqual(["docker"]);
				// The alternate is never launched beside a working legacy server.
				expect(launchedCommands().some(isOfficialCommand)).toBe(false);
				const legacyCall = launchMock.mock.calls.find(([command]) =>
					isLegacyCommand(String(command)),
				);
				expect(legacyCall?.[1]).toEqual(["--stdio"]);
			} else if (arm === "official-only" || arm === "failing-legacy") {
				expect(ids).toEqual(["docker-official"]);
				const officialCall = launchMock.mock.calls.find(([command]) =>
					isOfficialCommand(String(command)),
				);
				expect(officialCall, "official launched").toBeDefined();
				// Exact official argv: `start` is required and must not be dropped
				// by reusing the legacy spec's shared args.
				expect(officialCall?.[1]).toEqual(["start", "--stdio"]);
				expect(createLSPClientMock).toHaveBeenCalledTimes(1);
				expect(createLSPClientMock.mock.calls[0][0]).toMatchObject({
					serverId: "docker-official",
				});
			} else {
				// Neither is available: no client, and both were attempted — never
				// a false clean.
				expect(ids).toEqual([]);
				expect(clients).toHaveLength(0);
				expect(serverCountAttempted).toBeGreaterThanOrEqual(2);
				expect(launchedCommands().some(isLegacyCommand)).toBe(true);
				expect(launchedCommands().some(isOfficialCommand)).toBe(true);
				expect(createLSPClientMock).not.toHaveBeenCalled();
			}

			await service.shutdown();
		});
	}

	it("declines the alternate when the operator denies docker-official", async () => {
		launchMock.mockImplementation(armLauncher("official-only"));
		const { registerLSPConfig } =
			await import("../../../clients/lsp/config.js");
		const { setSessionRootConfig } =
			await import("../../../clients/lsp/session-roots.js");
		setSessionRootConfig(
			"/proj",
			registerLSPConfig({ disabledServers: ["docker-official"] }),
		);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const { clients } = await service.getClientsForFile(FILE);
		expect(clients).toHaveLength(0);
		expect(launchedCommands().some(isOfficialCommand)).toBe(false);
		await service.shutdown();
	});
});

describe("docker official config selection intent (#3939)", () => {
	async function selected(): Promise<string[]> {
		const { explainServersForFile, registerLSPConfig } =
			await import("../../../clients/lsp/config.js");
		return explainServersForFile(FILE, registerLSPConfig({}))
			.filter((entry) => entry.selected)
			.map((entry) => entry.server.id);
	}

	it("selects the legacy server first and the fallback alongside it", async () => {
		await expect(selected()).resolves.toEqual(["docker", "docker-official"]);
	});

	it("denies only the named id, preserving the distinct alternate", async () => {
		const { explainServersForFile, registerLSPConfig } =
			await import("../../../clients/lsp/config.js");
		const denied = explainServersForFile(
			FILE,
			registerLSPConfig({ disabledServers: ["docker-official"] }),
		)
			.filter((entry) => entry.selected)
			.map((entry) => entry.server.id);
		expect(denied).toEqual(["docker"]);
	});

	it("keeps a distinct-id custom recipe selected beside the registry entries", async () => {
		const { explainServersForFile, registerLSPConfig } =
			await import("../../../clients/lsp/config.js");
		const config = registerLSPConfig({
			disabledServers: ["docker", "docker-official"],
			servers: {
				"local-docker-official": {
					name: "Docker Language Server (official)",
					extensions: [".dockerfile", "Dockerfile"],
					command: "docker-language-server",
					args: ["start", "--stdio"],
				},
			},
		});
		const ids = explainServersForFile(FILE, config)
			.filter((entry) => entry.selected)
			.map((entry) => entry.server.id);
		expect(ids).toEqual(["local-docker-official"]);
	});

	it("does not count a fallback family as a second workspace server", async () => {
		const { groupFilesByPrimaryServer } =
			await import("../../../clients/lsp/index.js");
		expect(groupFilesByPrimaryServer([FILE])).toEqual([
			{ files: [FILE], multiServer: false },
		]);
	});
});
