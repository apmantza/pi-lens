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
});
