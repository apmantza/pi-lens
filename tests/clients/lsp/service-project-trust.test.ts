import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE_ROOT = path.join(process.cwd(), "project-trust-fixture");
const FIXTURE_FILE = path.join(FIXTURE_ROOT, "main.py");

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logExtension = vi.fn();

vi.mock("../../../clients/extension-log.js", () => ({ logExtension }));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

/**
 * #1334 S5 — the LSP service must not launch a server child process for a
 * project the pi host said is NOT trusted. Spy-based: `server.spawn` is the
 * exact seam that would exec a project-resolved binary.
 */
describe("LSPService project-trust gate (#1334 S5)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logExtension.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function setup(
		admitted = false,
		serverId = "python",
		executesProjectCode = false,
	) {
		const trust = await import("../../../clients/project-trust.js");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const spawn = vi.fn(async () => ({
			process: {
				process: { killed: false },
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stdin: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stdout: {} as any,
				// biome-ignore lint/suspicious/noExplicitAny: inert stdio stubs
				stderr: {} as any,
				pid: 4242,
			},
		}));
		getServersForFileWithConfig.mockReturnValue([
			{
				id: serverId,
				name: "Python",
				extensions: [".py"],
				executesProjectCode,
				...(admitted ? { trustAllowed: true } : {}),
				root: async () => FIXTURE_ROOT,
				spawn,
			},
		]);
		return { trust, service: new LSPService(), spawn };
	}

	it("keeps the service backstop for a raw built-in server when trust is denied", async () => {
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("untrusted");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).not.toHaveBeenCalled();
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(client).toBeUndefined();
		trust.resetProjectTrust();
	});

	it("spawns normally when the host granted project trust", async () => {
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("trusted");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(client?.client).toBeTruthy();
		trust.resetProjectTrust();
	});

	it("spawns normally on a host with no trust surface at all", async () => {
		const { trust, service, spawn } = await setup();
		// "unknown" is the default — an older pi that never exposed
		// ctx.isProjectTrusted must behave exactly as before.
		expect(trust.getProjectTrustState()).toBe("unknown");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(client?.client).toBeTruthy();
	});

	it("refuses an unknown-trust project-code server before spawning", async () => {
		const { service, spawn } = await setup(false, "rust", true);

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).not.toHaveBeenCalled();
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(client).toBeUndefined();
		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"project-code LSP server refused: mark the project trusted in pi or upgrade pi",
			}),
		);
	});

	it("refuses five unknown-trust project-code touches with one ledger record and notice", async () => {
		// Recurrence: #4269 review required the real service seam to prove that
		// repeated refused touches do not spawn or emit unbounded trust telemetry.
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const { service, spawn } = await setup(false, "rust", true);

		for (let i = 0; i < 5; i += 1) {
			expect(await service.getClientForFile(FIXTURE_FILE)).toBeUndefined();
		}

		expect(spawn).not.toHaveBeenCalled();
		expect(
			ledger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "lsp-registry-decision"),
		).toEqual([expect.objectContaining({ count: 1 })]);
		expect(
			logExtension.mock.calls.filter(
				([entry]) =>
					entry.message ===
					"project-code LSP server refused: mark the project trusted in pi or upgrade pi",
			),
		).toHaveLength(1);
	});

	it("allows a trusted project-code server", async () => {
		const { trust, service, spawn } = await setup(false, "rust", true);
		trust.setProjectTrustState("trusted");

		const client = await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(client?.client).toBeTruthy();
		trust.resetProjectTrust();
	});

	it("refuses the real LeanServer under unknown trust (lake interprets lakefile.lean)", async () => {
		// #4269 witness: the Lean row's own `executesProjectCode: true` is what
		// routes it through refuseUntrustedLspExecution. No trust mock: the real
		// setProjectTrustState/resetProjectTrust seam is exercised, and the row is
		// the real LeanServer (only its spawn is spied, so the exec seam stays
		// unentered). Pre-fix the field is absent, the service backstop allows
		// unknown trust, and spawn is reached — the red this guards.
		const project = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-trust-"),
		);
		fs.writeFileSync(path.join(project, "lakefile.lean"), "import Lake\n");
		fs.writeFileSync(path.join(project, "Main.lean"), "def main := 1\n");
		const { trust, service, spawn } = await setup();
		const { LeanServer } = await import("../../../clients/lsp/server.js");
		getServersForFileWithConfig.mockReturnValue([{ ...LeanServer, spawn }]);
		expect(trust.getProjectTrustState()).toBe("unknown");

		const client = await service.getClientForFile(
			path.join(project, "Main.lean"),
		);

		expect(spawn).not.toHaveBeenCalled();
		expect(createLSPClient).not.toHaveBeenCalled();
		expect(client).toBeUndefined();
		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"project-code LSP server refused: mark the project trusted in pi or upgrade pi",
			}),
		);
		trust.resetProjectTrust();
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("refuses a project-local LSP binary for an adopted root", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const sessionRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-session-"),
		);
		const project = fs.mkdtempSync(
			path.join(process.cwd(), ".probe-adopted-lsp-"),
		);
		const binDir = path.join(project, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		fs.writeFileSync(
			path.join(binDir, "typescript-language-server"),
			"#!/bin/sh\n",
		);
		fs.chmodSync(path.join(binDir, "typescript-language-server"), 0o755);
		const { trust, spawn } = await setup();
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				root: async () => project,
				command: path.join(binDir, "typescript-language-server"),
				spawn,
			},
		]);
		const adoptedService = new LSPService(undefined, sessionRoot);
		const file = path.join(project, "main.ts");
		expect((adoptedService as any).analysisRootModeForFile(file)).toBe(
			"adopted",
		);
		const client = await adoptedService.getClientForFile(file);
		expect(client).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		trust.resetProjectTrust();
		fs.rmSync(sessionRoot, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("bounds adopted roots and evicts an idle adopted client", async () => {
		// Recurrence: #4257 F4 allowed the adopted LSP population and idle timers
		// to lose their cap without a test observing either guard.
		vi.useFakeTimers();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const raw = service as any;
		raw.analysisRootModeForFile = () => "adopted";
		for (const root of ["/repo/a", "/repo/b", "/repo/c"]) {
			const rootKey = `server:${root}`;
			expect(raw.admitAdoptedRoot(root, "/repo/file.ts")).toBe(true);
			raw.adoptedClientKeys.add(rootKey);
			raw.state.clients.set(rootKey, {
				isAlive: () => true,
				isBusy: () => false,
				shutdown: vi.fn(async () => undefined),
			});
		}
		expect(raw.adoptedRootLastUsedAt.size).toBe(2);

		const client = {
			isAlive: () => true,
			isBusy: () => false,
			shutdown: vi.fn(async () => undefined),
		};
		const key = "server:/repo/a";
		raw.adoptedClientKeys.add(key);
		raw.state.clients.set(key, client);
		raw.clientLastUsedAt.set(key, Date.now());
		raw.scheduleIdleEviction(key, {
			id: "server",
			idleEviction: "unmeasured",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(client.shutdown).toHaveBeenCalledWith({ reason: "idle_eviction" });
		vi.useRealTimers();
	});

	it("refuses an unknown-trust project-local built-in binary through launchLSP", async () => {
		const project = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-project-local-lsp-"),
		);
		const binDir = path.join(project, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const binary = path.join(binDir, "python");
		fs.writeFileSync(binary, "#!/bin/sh\n");
		fs.chmodSync(binary, 0o755);
		const { trust, service, spawn } = await setup();
		const { launchLSP } = await import("../../../clients/lsp/launch.js");
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "python",
				name: "Python",
				extensions: [".py"],
				root: async () => project,
				spawn: async (root: string) => {
					await launchLSP("python", [], {
						cwd: root,
						env: {
							PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
						},
					});
					return undefined;
				},
			},
		]);
		const client = await service.getClientForFile(
			path.join(project, "main.py"),
		);
		expect(client).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		expect(
			logExtension.mock.calls.filter(
				([entry]) =>
					entry.message ===
					"project-local LSP binary refused: mark the project trusted in pi or upgrade pi",
			),
		).toHaveLength(1);
		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"project-local LSP binary refused: mark the project trusted in pi or upgrade pi",
			}),
		);
		trust.resetProjectTrust();
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("forces allowInstall=false for the spawn options under denial", async () => {
		// Trust denial short-circuits before spawn, so the install policy is
		// asserted on the granted path: the gate must not leak into it.
		const { trust, service, spawn } = await setup();
		trust.setProjectTrustState("trusted");

		await service.getClientForFile(FIXTURE_FILE);

		expect(spawn).toHaveBeenCalledWith(
			FIXTURE_ROOT,
			expect.objectContaining({ allowInstall: true }),
		);
		trust.resetProjectTrust();
	});
});
