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
		expect(registry.disabledServerIds.has("rust")).toBe(false);
		expect(logExtension).toHaveBeenCalledTimes(1);
		expect(ledger.getDegradationSummary()).toContainEqual(
			expect.objectContaining({ kind: "lsp-registry-decision", count: 3 }),
		);
	});

	// #5147 r2: a refused project env/initializationOptions used to leave the
	// global command running without the user's own env and init options. The
	// merge keeps only the winning tier's value, so the server is not started.
	it("does not register a global server whose env and initialization options a project sets while untrusted", async () => {
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
						env: { GLOBAL_ONLY: "1" },
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

		expect(
			registry.customServers.find((entry) => entry.id === "shared"),
		).toBeUndefined();
		expect(launchLSP).not.toHaveBeenCalled();
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

	// #3952: the compiled list must be the CATALOG ENTRY for every built-in with
	// no command override. The idle-eviction probe arms `idleEviction` on the
	// object `LSP_SERVERS`/`getServerById` exposes and expects the client
	// registry to read it back; while this branch copied every built-in, the arm
	// never reached `scheduleIdleEviction` and no candidate could earn a night
	// (2026-10-10 → 2026-10-19). The other direction matters just as much: an
	// OVERRIDDEN server keeps its own copy, so its `spawn` and `trustAllowed`
	// never land in the shared catalog the probe reads.
	it("compiles the catalog entry itself, and a copy only for a command override", async () => {
		const project = tempDir();
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: { serverOverrides: { rust: { command: "trusted-rust" } } },
			}),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const { getServerById } = await import("../../../clients/lsp/server.js");
		const config = await loadLSPConfig(project);
		const compiled = compileLspRegistry(
			config,
			config.__provenance,
		).registeredServers;
		const byId = new Map(compiled.map((entry) => [entry.id, entry]));

		expect(byId.get("typescript")).toBe(getServerById("typescript"));
		expect(byId.get("rust")).not.toBe(getServerById("rust"));
		expect(byId.get("rust")?.spawn).not.toBe(getServerById("rust")?.spawn);
		// #4758/#4808 F4: the copy keeps the declaration, so a user `command`
		// override still answers rust-analyzer's `rust-analyzer` pull.
		expect(byId.get("rust")?.settingsSection).toBe("rust-analyzer");
	});

	// #4833 (folds #4829 review r1 F3): every measured trait of the catalog
	// binary, `resendRecheck` included, is reset on a command override's copy
	// (the field-level half is tests/clients/lsp/lsp-override-traits.test.ts).
	// What only the spawn can show: a launch from the override reports
	// `launchVariant: "override"`, and the wait policy keyed by the catalog
	// server id (`getStrategy`) resets its optimistic claims (silentOnClean,
	// workspaceIndexing) and keeps its protocol workarounds (reopenOnResync).
	it("starts a command override on the override wait strategy, not the catalog id's row", async () => {
		const { LSP_SERVERS } = await import("../../../clients/lsp/server.js");
		const { getStrategy, SERVER_DIAGNOSTIC_STRATEGIES } =
			await import("../../../clients/lsp/wait-policy/strategies.js");
		const withRow = LSP_SERVERS.filter(
			(server) => SERVER_DIAGNOSTIC_STRATEGIES[server.id],
		);
		expect(withRow.length).toBeGreaterThanOrEqual(10);
		const rows = withRow.map(
			(server) => SERVER_DIAGNOSTIC_STRATEGIES[server.id],
		);
		expect(rows.some((r) => r?.silentOnClean === true)).toBe(true);
		expect(rows.some((r) => r?.emptyFirstPublish === "indexing")).toBe(true);
		expect(rows.some((r) => r?.diagnosticsFence === "reply-first")).toBe(true);
		expect(rows.some((r) => r?.workspaceIndexing === true)).toBe(true);

		const project = tempDir();
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: Object.fromEntries(
						withRow.map((server) => [
							server.id,
							{ command: [`other-${server.id}-lsp`, "--stdio"] },
						]),
					),
				},
			}),
		);
		const trust = await import("../../../clients/project-trust.js");
		trust.setProjectTrustState("trusted");
		const { loadLSPConfig, compileLspRegistry } =
			await import("../../../clients/lsp/config.js");
		const config = await loadLSPConfig(project);
		const compiled = compileLspRegistry(
			config,
			config.__provenance,
		).registeredServers;
		const byId = new Map(compiled.map((entry) => [entry.id, entry]));
		for (const server of withRow) {
			const spawned = await byId.get(server.id)!.spawn(project);
			expect(spawned?.launchVariant, server.id).toBe("override");
			// What `ClientRegistry.spawnClient` hands the client and wait policy.
			const strategy = getStrategy(server.id, spawned?.launchVariant);
			expect(strategy.silentOnClean, `${server.id} silentOnClean`).toBe(
				undefined,
			);
			expect(strategy.workspaceIndexing, `${server.id} workspaceIndexing`).toBe(
				undefined,
			);
		}
		// #4833 review F1: the opengrep override keeps its restrictive
		// workarounds, or an edit after the first touch is never scanned.
		const opengrep = await byId.get("opengrep")!.spawn(project);
		expect(
			getStrategy("opengrep", opengrep?.launchVariant).reopenOnResync,
		).toBe(true);
		// The catalog row itself keeps its measurement.
		expect(getStrategy("typescript", "classic").silentOnClean).toBe(true);
	});
});
