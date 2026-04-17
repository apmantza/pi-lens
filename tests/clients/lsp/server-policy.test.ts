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
	it("every built-in server has a spawn function", async () => {
		const { LSP_SERVERS } = await import("../../../clients/lsp/server.js");
		const missing = LSP_SERVERS.filter((server) => typeof server.spawn !== "function").map(
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

	it("falls back to file directory when go root markers are missing", async () => {
		const { GoServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-go-fallback-root-"));
		dirs.push(tmp);

		const file = path.join(tmp, "src", "main.go");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "package main\n");

		const root = await GoServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when json root markers are missing", async () => {
		const { JsonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-json-fallback-root-"));
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "config.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{}\n");

		const root = await JsonServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("resolves relative file roots without hanging", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-relative-root-"));
		dirs.push(tmp);

		const prev = process.cwd();
		process.chdir(tmp);
		try {
			const resolver = NearestRoot(["go.mod", "go.sum"]);
			const result = await Promise.race([
				resolver("test_lens_go.go"),
				new Promise<string | undefined>((_, reject) =>
					setTimeout(() => reject(new Error("root resolution timed out")), 500),
				),
			]);
			expect(result).toBeUndefined();
		} finally {
			process.chdir(prev);
		}
	});

	it("does not resolve markers above explicit stop directory", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-boundary-"));
		dirs.push(tmp);

		const parent = path.join(tmp, "workspace");
		const child = path.join(parent, "project", "src");
		const file = path.join(child, "main.ts");

		fs.mkdirSync(parent, { recursive: true });
		fs.mkdirSync(child, { recursive: true });
		fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
		fs.writeFileSync(file, "export const ok = true;\n");

		const prev = process.cwd();
		process.chdir(path.join(parent, "project"));
		try {
			const resolver = NearestRoot([".git"], undefined, process.cwd());
			const result = await resolver(file);
			expect(result).toBeUndefined();
		} finally {
			process.chdir(prev);
		}
	});

	it("matches Dockerfile by basename in configured server lookup", async () => {
		const { getServersForFileWithConfig } = await import(
			"../../../clients/lsp/config.js"
		);
		const servers = getServersForFileWithConfig("infra/Dockerfile").map(
			(server) => server.id,
		);
		expect(servers).toContain("docker");
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

	it("tries local bash-language-server bin candidates before PATH lookup", async () => {
		const { BashServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bash-candidates-"));
		dirs.push(tmp);

		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await BashServer.spawn(tmp, { allowInstall: false });
		expect(spawned).toBeUndefined();
		expect(launchLSP).toHaveBeenCalled();
		const firstCommand = launchLSP.mock.calls[0]?.[0] as string;
		expect(firstCommand).toContain("node_modules");
		expect(firstCommand).toContain("bash-language-server");
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

	it("keeps custom LSP config scoped per workspace", async () => {
		const {
			getServersForFileWithConfig,
			initLSPConfig,
		} = await import("../../../clients/lsp/config.js");

		const workspaceA = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-config-a-"),
		);
		const workspaceB = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-config-b-"),
		);
		dirs.push(workspaceA, workspaceB);

		fs.mkdirSync(path.join(workspaceA, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspaceA, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					workspaceAOnly: {
						name: "Workspace A Only",
						extensions: [".foo"],
						command: "a-lsp",
					},
				},
				disabledServers: ["typescript"],
			}),
		);

		fs.mkdirSync(path.join(workspaceB, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspaceB, ".pi-lens", "lsp.json"),
			JSON.stringify({
				servers: {
					workspaceBOnly: {
						name: "Workspace B Only",
						extensions: [".bar"],
						command: "b-lsp",
					},
				},
			}),
		);

		const fileA = path.join(workspaceA, "src", "index.foo");
		const fileB = path.join(workspaceB, "src", "index.bar");
		fs.mkdirSync(path.dirname(fileA), { recursive: true });
		fs.mkdirSync(path.dirname(fileB), { recursive: true });
		fs.writeFileSync(fileA, "content\n");
		fs.writeFileSync(fileB, "content\n");

		await initLSPConfig(workspaceA);
		await initLSPConfig(workspaceB);

		const serversA = getServersForFileWithConfig(fileA).map((server) => server.id);
		const serversB = getServersForFileWithConfig(fileB).map((server) => server.id);
		const tsFileA = path.join(workspaceA, "src", "index.ts");
		fs.writeFileSync(tsFileA, "export const a = 1;\n");
		const tsServersA = getServersForFileWithConfig(tsFileA).map(
			(server) => server.id,
		);

		expect(serversA).toContain("workspaceAOnly");
		expect(serversA).not.toContain("workspaceBOnly");
		expect(serversB).toContain("workspaceBOnly");
		expect(serversB).not.toContain("workspaceAOnly");
		expect(tsServersA).not.toContain("typescript");
	});
});
