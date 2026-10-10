import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const logExtension = vi.fn();
vi.mock("../../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/extension-log.js")
	>()),
	logExtension,
}));
const launchLSP = vi.fn(async () => ({}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));

const dirs: string[] = [];
const originalPiLensHome = process.env.PI_LENS_HOME;

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-registry-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	logExtension.mockReset();
	launchLSP.mockReset();
	launchLSP.mockResolvedValue({});
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	const trust = await import("../../../clients/project-trust.js");
	trust.resetProjectTrust();
	if (originalPiLensHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalPiLensHome;
});

describe("compiled LSP registry trust boundary (#2372)", () => {
	it("admits global executables and refuses project executables when untrusted", async () => {
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					global: { name: "Global", extensions: [".g"], command: "global-lsp" },
				},
			}),
		);
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					servers: {
						project: {
							name: "Project",
							extensions: [".p"],
							command: "project-lsp",
							env: { PLUGIN: "yes" },
						},
					},
				},
			}),
		);

		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);

		expect(registry.customServers.map((server) => server.id)).toEqual([
			"global",
		]);
	});

	it("admits a project server only after pi grants trust", async () => {
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					servers: {
						project: {
							name: "Project",
							extensions: [".p"],
							command: "project-lsp",
						},
					},
				},
			}),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);

		expect(registry.customServers.map((server) => server.id)).toEqual([
			"project",
		]);
	});

	it("allows an untrusted project to narrow the registry by disabling a server", async () => {
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["typescript"] } }),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);

		expect(registry.disabledServerIds.has("typescript")).toBe(true);
	});

	it("fails closed for unknown trust and records the initialization-options decision", async () => {
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						rust: {
							command: "project-rust",
							env: { RUST_LOG: "debug" },
							initializationOptions: { check: { command: "clippy" } },
						},
					},
				},
			}),
		);
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);
		const override = registry.serverOverrides.get("rust");

		expect(override?.command).toBeUndefined();
		expect(override?.env).toBeUndefined();
		expect(override?.initializationOptions).toBeUndefined();
		expect(logExtension).toHaveBeenCalledTimes(1);
		expect(ledger.getDegradationSummary()).toContainEqual(
			expect.objectContaining({ kind: "lsp-registry-decision", count: 3 }),
		);
	});

	it("refuses project env and initialization options while retaining global command", async () => {
		const project = tempDir();
		const globalDir = tempDir();
		process.env.PI_LENS_HOME = globalDir;
		fs.writeFileSync(
			path.join(globalDir, "lsp.json"),
			JSON.stringify({
				servers: {
					shared: {
						name: "Shared",
						extensions: [".shared"],
						command: "global-shared",
					},
				},
			}),
		);
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					servers: {
						shared: {
							name: "Shared project fields",
							extensions: [".shared"],
							env: { PROJECT_ONLY: "1" },
							initializationOptions: { projectOnly: true },
						},
					},
				},
			}),
		);

		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const registry = compileLspRegistry(config, config.__provenance);
		const server = registry.customServers.find(
			(entry) => entry.id === "shared",
		);

		expect(server).toBeDefined();
		const spawn = server?.spawn;
		if (!spawn) throw new Error("global server did not register a spawn seam");
		const launch = await spawn(project);
		if (!launch) throw new Error("global server spawn was not admitted");
		expect(launch.initialization).toBeUndefined();
		expect(launchLSP).toHaveBeenCalledWith(
			"global-shared",
			["--stdio"],
			expect.objectContaining({
				env: expect.not.objectContaining({ PROJECT_ONLY: "1" }),
			}),
		);
	});

	it("retains every project override field after pi grants trust", async () => {
		const project = tempDir();
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						rust: {
							command: "trusted-rust",
							env: { RUST_LOG: "debug" },
							initializationOptions: { check: { command: "clippy" } },
						},
					},
				},
			}),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const override = compileLspRegistry(
			config,
			config.__provenance,
		).serverOverrides.get("rust");

		expect(override).toEqual({
			command: "trusted-rust",
			env: { RUST_LOG: "debug" },
			initializationOptions: { check: { command: "clippy" } },
		});
	});
});
