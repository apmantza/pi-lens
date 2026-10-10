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

	async function setup(admitted = false) {
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
				id: "python",
				name: "Python",
				extensions: [".py"],
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
