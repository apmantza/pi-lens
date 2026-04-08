import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ensureTool = vi.fn();
const getToolEnvironment = vi.fn(async () => ({}));
const launchLSP = vi.fn();
const launchViaPackageManager = vi.fn();

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
}));

vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	launchViaPackageManager,
}));

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	ensureTool.mockReset();
	launchLSP.mockReset();
	launchViaPackageManager.mockReset();
});

describe("lsp server policy", () => {
	it("declares installPolicy for every built-in server", async () => {
		const { LSP_SERVERS } = await import("../../../clients/lsp/server.js");
		const missing = LSP_SERVERS.filter((server) => !server.installPolicy).map(
			(server) => server.id,
		);
		expect(missing).toEqual([]);
	});

	it("prioritizes go.work root over go.mod", async () => {
		const { PriorityRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-go-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const moduleDir = path.join(workspace, "services", "api");
		const file = path.join(moduleDir, "main.go");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(workspace, "go.work"), "go 1.22\n");
		fs.writeFileSync(path.join(moduleDir, "go.mod"), "module example\n");
		fs.writeFileSync(file, "package main\n");

		const root = await PriorityRoot([["go.work"], ["go.mod", "go.sum"]])(file);
		expect(root).toBe(workspace);
	});

	it("uses git root fallback for ruby files without ruby config", async () => {
		const { RubyServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ruby-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const file = path.join(workspace, "scripts", "tool.rb");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
		fs.writeFileSync(file, "puts 'ok'\n");

		const root = await RubyServer.root(file);
		expect(root).toBe(workspace);
	});

	it("skips managed TypeScript install when lsp install is disabled", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-policy-"));
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		ensureTool.mockResolvedValue(undefined);

		const spawned = await TypeScriptServer.spawn(tmp);
		expect(spawned).toBeUndefined();
	});

	it("skips managed TypeScript install when install is disallowed for file", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-install-off-"));
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		ensureTool.mockResolvedValue(undefined);

		const spawned = await TypeScriptServer.spawn(tmp, { allowInstall: false });
		expect(spawned).toBeUndefined();
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("skips package-manager fallback when lsp install is disabled", async () => {
		const { SvelteServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sv-policy-"));
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await SvelteServer.spawn(tmp);
		expect(spawned?.process).toBeUndefined();
		expect(launchViaPackageManager).not.toHaveBeenCalled();
	});

	it("skips package-manager fallback when install is disallowed for file", async () => {
		const { SvelteServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sv-install-off-"));
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await SvelteServer.spawn(tmp, { allowInstall: false });
		expect(spawned?.process).toBeUndefined();
		expect(launchViaPackageManager).not.toHaveBeenCalled();
	});
});
