import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Set test mode to isolate logging from production logs
process.env.PI_LENS_TEST_MODE = "1";

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

// Suppress sync disk I/O from logLatency — prevents timeout under full-suite load
vi.mock("../../../clients/latency-logger.js", () => ({
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
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
	vi.resetModules();
});

describe("lsp server policy", () => {
	it("every built-in server has a spawn function", async () => {
		const { LSP_SERVERS } = await import("../../../clients/lsp/server.js");
		const missing = LSP_SERVERS.filter(
			(server) => typeof server.spawn !== "function",
		).map((server) => server.id);
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
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-go-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "src", "main.go");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "package main\n");

		const root = await GoServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when json root markers are missing", async () => {
		const { JsonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-json-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "config.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{}\n");

		const root = await JsonServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when html root markers are missing", async () => {
		const { HtmlServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-html-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "index.html");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "<!doctype html><html></html>\n");

		const root = await HtmlServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when css root markers are missing", async () => {
		const { CssServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-css-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "styles.css");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "body { color: red; }\n");

		const root = await CssServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when yaml root markers are missing", async () => {
		const { YamlServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-yaml-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "service.yaml");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "settings:\n  enabled: true\n");

		const root = await YamlServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory when docker root markers are missing", async () => {
		const { DockerServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-docker-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "Dockerfile");
		fs.writeFileSync(file, "FROM alpine:3.20\n");

		const root = await DockerServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("falls back to file directory for standalone csharp files", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "Program.cs");
		fs.writeFileSync(file, 'Console.WriteLine("ok");\n');

		const root = await CSharpServer.root(file);
		expect(root).toBe(path.dirname(file));
	});

	it("tries pi-lens managed csharp candidates before legacy global dotnet tools", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-candidates-"),
		);
		dirs.push(tmp);

		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await CSharpServer.spawn(tmp, { allowInstall: false });
		expect(spawned).toBeUndefined();
		expect(launchLSP).toHaveBeenCalled();
		const commands = launchLSP.mock.calls.map((call) => String(call[0] ?? ""));
		expect(
			commands.some((command) =>
				command.includes(path.join(".pi-lens", "bin", "csharp-ls")),
			),
		).toBe(true);
	});

	it("falls back to file directory for standalone cpp/zig/elixir/gleam files", async () => {
		const { CppServer, ZigServer, ElixirServer, GleamServer } = await import(
			"../../../clients/lsp/server.js"
		);
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-secondary-roots-"),
		);
		dirs.push(tmp);

		const cppFile = path.join(tmp, "src", "main.cpp");
		const zigFile = path.join(tmp, "src", "main.zig");
		const elixirFile = path.join(tmp, "lib", "app.ex");
		const gleamFile = path.join(tmp, "src", "app.gleam");
		fs.mkdirSync(path.dirname(cppFile), { recursive: true });
		fs.mkdirSync(path.dirname(elixirFile), { recursive: true });
		fs.writeFileSync(cppFile, "int main() { return 0; }\n");
		fs.writeFileSync(zigFile, "pub fn main() void {}\n");
		fs.writeFileSync(elixirFile, "defmodule App do end\n");
		fs.writeFileSync(gleamFile, "pub fn main() { Nil }\n");

		await expect(CppServer.root(cppFile)).resolves.toBe(path.dirname(cppFile));
		await expect(ZigServer.root(zigFile)).resolves.toBe(path.dirname(zigFile));
		await expect(ElixirServer.root(elixirFile)).resolves.toBe(
			path.dirname(elixirFile),
		);
		await expect(GleamServer.root(gleamFile)).resolves.toBe(
			path.dirname(gleamFile),
		);
	});

	it("resolves relative file roots without hanging", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-relative-root-"),
		);
		dirs.push(tmp);

		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
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
			cwdSpy.mockRestore();
		}
	});

	it("caches successful root resolution — second call skips stat walk", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-cache-"));
		dirs.push(tmp);

		const src = path.join(tmp, "src");
		const file1 = path.join(src, "a.ts");
		const file2 = path.join(src, "b.ts");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		fs.writeFileSync(file1, "");
		fs.writeFileSync(file2, "");

		const resolver = NearestRoot(["package.json"]);
		const r1 = await resolver(file1);
		expect(r1).toBe(tmp);

		// Delete the marker — a fresh walk would return undefined, but the cache
		// should serve the hit without touching the filesystem.
		fs.unlinkSync(path.join(tmp, "package.json"));
		const r2 = await resolver(file2);
		expect(r2).toBe(tmp);
	});

	it("deduplicates concurrent in-flight walks for the same directory", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-root-inflight-"),
		);
		dirs.push(tmp);

		const src = path.join(tmp, "extractors");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");

		const files = ["a.mjs", "b.mjs", "c.mjs", "d.mjs"].map((f) => {
			const fp = path.join(src, f);
			fs.writeFileSync(fp, "");
			return fp;
		});

		const resolver = NearestRoot(["package.json"]);
		// Fire all four simultaneously — only one stat-walk should run.
		const results = await Promise.all(files.map((f) => resolver(f)));
		expect(results).toEqual([tmp, tmp, tmp, tmp]);
	});

	it("does not cache undefined — re-walks when root marker is later created", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-nocache-"));
		dirs.push(tmp);

		const src = path.join(tmp, "src");
		const file = path.join(src, "a.ts");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(file, "");

		// stopDir = tmp prevents the walk escaping to real parent package.json
		const resolver = NearestRoot(["package.json"], undefined, tmp);
		const r1 = await resolver(file);
		expect(r1).toBeUndefined();

		// Now create the marker — next call must detect it despite no cached entry.
		fs.writeFileSync(path.join(tmp, "package.json"), "{}");
		const r2 = await resolver(file);
		expect(r2).toBe(tmp);
	});

	it("isolates cache per NearestRoot instance — different marker sets are independent", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-isolate-"));
		dirs.push(tmp);

		const src = path.join(tmp, "src");
		const file = path.join(src, "main.go");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(file, "");
		// Only go.mod present — package.json absent.
		fs.writeFileSync(path.join(tmp, "go.mod"), "module example\n");

		// stopDir = tmp prevents walks escaping to real parent dirs with package.json
		const tsResolver = NearestRoot(["package.json"], undefined, tmp);
		const goResolver = NearestRoot(["go.mod", "go.sum"], undefined, tmp);

		const tsRoot = await tsResolver(file);
		const goRoot = await goResolver(file);

		expect(tsRoot).toBeUndefined();
		expect(goRoot).toBe(tmp);
	});

	it("does not resolve markers above explicit stop directory", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-root-boundary-"),
		);
		dirs.push(tmp);

		const parent = path.join(tmp, "workspace");
		const child = path.join(parent, "project", "src");
		const file = path.join(child, "main.ts");

		fs.mkdirSync(parent, { recursive: true });
		fs.mkdirSync(child, { recursive: true });
		fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
		fs.writeFileSync(file, "export const ok = true;\n");

		const stopDir = path.join(parent, "project");
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(stopDir);
		try {
			const resolver = NearestRoot([".git"], undefined, stopDir);
			const result = await resolver(file);
			expect(result).toBeUndefined();
		} finally {
			cwdSpy.mockRestore();
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

	it("falls back to the file directory for standalone ruby files", async () => {
		const { RubyServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ruby-filedir-"));
		dirs.push(tmp);

		const file = path.join(tmp, "scripts", "tool.rb");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "puts 'ok'\n");

		const root = await RubyServer.root(file);
		expect(root).toBe(path.dirname(file));
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

	it("skips PowerShell bash-language-server shim candidates on Windows", async () => {
		const { BashServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-bash-candidates-"),
		);
		dirs.push(tmp);

		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await BashServer.spawn(tmp, { allowInstall: false });
		expect(spawned).toBeUndefined();
		expect(launchLSP).toHaveBeenCalled();
		const commands = launchLSP.mock.calls.map((call) => String(call[0] ?? ""));
		expect(commands.some((command) => command.endsWith(".ps1"))).toBe(false);
	});

	it("skips managed TypeScript install when install is disallowed for file", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ts-install-off-"),
		);
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
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-sv-install-off-"),
		);
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		launchLSP.mockRejectedValue(new Error("ENOENT: command not found"));

		const spawned = await SvelteServer.spawn(tmp, { allowInstall: false });
		expect(spawned?.process).toBeUndefined();
		expect(launchViaPackageManager).not.toHaveBeenCalled();
	});

	it("keeps custom LSP config scoped per workspace", async () => {
		const { getServersForFileWithConfig, initLSPConfig } = await import(
			"../../../clients/lsp/config.js"
		);

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

		const serversA = getServersForFileWithConfig(fileA).map(
			(server) => server.id,
		);
		const serversB = getServersForFileWithConfig(fileB).map(
			(server) => server.id,
		);
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

	it("launches pyright-langserver from managed pyright install", async () => {
		const { PythonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pyright-lsp-"));
		dirs.push(tmp);

		ensureTool.mockResolvedValue(path.join(tmp, "tools", "pyright.cmd"));
		launchLSP.mockImplementation(async (command: string) => {
			if (command.includes(path.join("tools", "pyright-langserver"))) {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 1234,
				};
			}
			throw new Error(`unexpected command: ${command}`);
		});

		const spawned = await PythonServer.spawn(tmp, { allowInstall: true });

		expect(spawned).toBeDefined();
		expect(ensureTool).toHaveBeenCalledWith("pyright");
		expect(
			launchLSP.mock.calls.some(
				([command]) =>
					typeof command === "string" && command.includes("pyright-langserver"),
			),
		).toBe(true);
		expect(
			launchLSP.mock.calls.some(
				([command]) =>
					typeof command === "string" &&
					(command.endsWith("pyright.cmd") || command === "pyright"),
			),
		).toBe(false);
	});

	it("falls back to the file directory for standalone python files", async () => {
		const { PythonJediServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-python-filedir-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "scripts", "tool.py");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "print('ok')\n");

		await expect(PythonJediServer.root(file)).resolves.toBe(path.dirname(file));
	});

	it("launches taplo LSP from managed taplo install", async () => {
		const { TomlServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-taplo-lsp-"));
		dirs.push(tmp);

		ensureTool.mockResolvedValue(path.join(tmp, "bin", "taplo.exe"));
		launchLSP.mockImplementation(async (command: string) => {
			if (command.endsWith(path.join("bin", "taplo.exe"))) {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 4321,
				};
			}
			throw new Error(`unexpected command: ${command}`);
		});

		const spawned = await TomlServer.spawn(tmp, { allowInstall: true });

		expect(spawned).toBeDefined();
		expect(ensureTool).toHaveBeenCalledWith("taplo");
		expect(launchLSP).toHaveBeenCalledWith(
			path.join(tmp, "bin", "taplo.exe"),
			["lsp", "stdio"],
			expect.objectContaining({ cwd: tmp }),
		);
	});

	it("prefers kotlin-lsp before kotlin-language-server", async () => {
		const { KotlinServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-kotlin-cli-"));
		dirs.push(tmp);

		launchLSP.mockImplementation(async (command: string) => {
			if (command === "kotlin-lsp") {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 2468,
				};
			}
			throw new Error(`unexpected command: ${command}`);
		});

		const spawned = await KotlinServer.spawn(tmp, { allowInstall: true });
		expect(spawned).toBeDefined();
		expect(launchLSP.mock.calls[0]?.[0]).toBe("kotlin-lsp");
	});

	it("launches zls from managed install when direct command is unavailable", async () => {
		const { ZigServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-zls-managed-"));
		dirs.push(tmp);

		ensureTool.mockResolvedValue(path.join(tmp, "bin", "zls.exe"));
		launchLSP.mockImplementation(async (command: string) => {
			if (command === "zls") {
				throw new Error("ENOENT: command not found");
			}
			if (command.endsWith(path.join("bin", "zls.exe"))) {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 9753,
				};
			}
			throw new Error(`unexpected command: ${command}`);
		});

		const spawned = await ZigServer.spawn(tmp, { allowInstall: true });
		expect(spawned).toBeDefined();
		expect(ensureTool).toHaveBeenCalledWith("zls");
	});

	// --- Deno / TypeScript disambiguation ---

	it("TypeScript server yields to Deno when deno.json is present", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-deno-ts-"));
		dirs.push(tmp);

		const src = path.join(tmp, "src");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(tmp, "deno.json"), '{"name":"proj"}');
		fs.writeFileSync(path.join(src, "main.ts"), "const x: number = 1;\n");

		const root = await TypeScriptServer.root(path.join(src, "main.ts"));
		expect(root).toBeUndefined();
	});

	it("TypeScript server yields to Deno when deno.jsonc is present", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-deno-jsonc-"));
		dirs.push(tmp);

		fs.writeFileSync(path.join(tmp, "deno.jsonc"), "// deno\n{}");
		fs.writeFileSync(path.join(tmp, "mod.ts"), "export default {};\n");

		const root = await TypeScriptServer.root(path.join(tmp, "mod.ts"));
		expect(root).toBeUndefined();
	});

	it("TypeScript server skips loose pi agent extension files without project markers", async () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-home-"));
		dirs.push(fakeHome);
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		vi.resetModules();
		try {
			const { TypeScriptServer } = await import(
				"../../../clients/lsp/server.js"
			);
			const file = path.join(
				fakeHome,
				".pi",
				"agent",
				"extensions",
				"kitty-keyboard-toggle.ts",
			);
			const root = await TypeScriptServer.root(file);
			expect(root).toBeUndefined();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			vi.resetModules();
		}
	});

	it("TypeScript server still claims TS files with package.json and no deno config", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-no-deno-"));
		dirs.push(tmp);

		const src = path.join(tmp, "src");
		fs.mkdirSync(src, { recursive: true });
		fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"proj"}');
		fs.writeFileSync(path.join(src, "main.ts"), "const x: number = 1;\n");

		const root = await TypeScriptServer.root(path.join(src, "main.ts"));
		expect(root).toBe(tmp);
	});

	// --- Python venv detection ---

	it("detectPythonVenv finds .venv at project root", async () => {
		const { detectPythonVenv } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-venv-dot-"));
		dirs.push(tmp);

		const pythonPath =
			process.platform === "win32"
				? path.join(tmp, ".venv", "Scripts", "python.exe")
				: path.join(tmp, ".venv", "bin", "python");
		fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
		fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");

		const origVENV = process.env.VIRTUAL_ENV;
		const origCONDA = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		try {
			expect(await detectPythonVenv(tmp)).toBe(pythonPath);
		} finally {
			if (origVENV !== undefined) process.env.VIRTUAL_ENV = origVENV;
			if (origCONDA !== undefined) process.env.CONDA_PREFIX = origCONDA;
		}
	});

	it("detectPythonVenv picks up CONDA_PREFIX when VIRTUAL_ENV is absent", async () => {
		const { detectPythonVenv } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-conda-"));
		dirs.push(tmp);

		const condaEnv = path.join(tmp, "conda-env");
		const pythonPath =
			process.platform === "win32"
				? path.join(condaEnv, "Scripts", "python.exe")
				: path.join(condaEnv, "bin", "python");
		fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
		fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");

		const origVENV = process.env.VIRTUAL_ENV;
		const origCONDA = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		process.env.CONDA_PREFIX = condaEnv;
		try {
			expect(await detectPythonVenv(tmp)).toBe(pythonPath);
		} finally {
			if (origVENV !== undefined) process.env.VIRTUAL_ENV = origVENV;
			if (origCONDA !== undefined) process.env.CONDA_PREFIX = origCONDA;
			else delete process.env.CONDA_PREFIX;
		}
	});

	it("detectPythonVenv prefers VIRTUAL_ENV over .venv at project root", async () => {
		const { detectPythonVenv } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-venv-prio-"));
		dirs.push(tmp);

		const externalEnv = path.join(tmp, "external-env");
		const externalPython =
			process.platform === "win32"
				? path.join(externalEnv, "Scripts", "python.exe")
				: path.join(externalEnv, "bin", "python");
		const localPython =
			process.platform === "win32"
				? path.join(tmp, ".venv", "Scripts", "python.exe")
				: path.join(tmp, ".venv", "bin", "python");

		fs.mkdirSync(path.dirname(externalPython), { recursive: true });
		fs.mkdirSync(path.dirname(localPython), { recursive: true });
		fs.writeFileSync(externalPython, "#!/usr/bin/env python\n");
		fs.writeFileSync(localPython, "#!/usr/bin/env python\n");

		const origVENV = process.env.VIRTUAL_ENV;
		const origCONDA = process.env.CONDA_PREFIX;
		process.env.VIRTUAL_ENV = externalEnv;
		delete process.env.CONDA_PREFIX;
		try {
			expect(await detectPythonVenv(tmp)).toBe(externalPython);
		} finally {
			if (origVENV !== undefined) process.env.VIRTUAL_ENV = origVENV;
			else delete process.env.VIRTUAL_ENV;
			if (origCONDA !== undefined) process.env.CONDA_PREFIX = origCONDA;
		}
	});

	it("detectPythonVenv returns undefined when no venv exists", async () => {
		const { detectPythonVenv } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-no-venv-"));
		dirs.push(tmp);

		const origVENV = process.env.VIRTUAL_ENV;
		const origCONDA = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		try {
			expect(await detectPythonVenv(tmp)).toBeUndefined();
		} finally {
			if (origVENV !== undefined) process.env.VIRTUAL_ENV = origVENV;
			if (origCONDA !== undefined) process.env.CONDA_PREFIX = origCONDA;
		}
	});

	it("PythonJediServer passes workspace environmentPath when venv is detected", async () => {
		const { PythonJediServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jedi-venv-"));
		dirs.push(tmp);

		const pythonPath =
			process.platform === "win32"
				? path.join(tmp, ".venv", "Scripts", "python.exe")
				: path.join(tmp, ".venv", "bin", "python");
		fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
		fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");

		const origVENV = process.env.VIRTUAL_ENV;
		const origCONDA = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;

		launchLSP.mockResolvedValue({
			process: { killed: false } as never,
			stdin: {} as never,
			stdout: {} as never,
			stderr: {} as never,
			pid: 1111,
		});

		try {
			const spawned = await PythonJediServer.spawn(tmp);
			expect(spawned).toBeDefined();
			expect(spawned?.initialization).toMatchObject({
				workspace: { environmentPath: pythonPath },
			});
		} finally {
			if (origVENV !== undefined) process.env.VIRTUAL_ENV = origVENV;
			if (origCONDA !== undefined) process.env.CONDA_PREFIX = origCONDA;
		}
	});

	describe("rust-analyzer force-reinstall", () => {
		const MANAGED =
			process.platform === "win32"
				? String.raw`C:\Users\test\.pi-lens\bin\rust-analyzer.exe`
				: "/home/test/.pi-lens/bin/rust-analyzer";

		it("triggers force-reinstall after two PATH-resolved launch failures", async () => {
			const { RustServer } = await import("../../../clients/lsp/server.js");
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rust-force-"));
			dirs.push(tmp);

			const calls: string[] = [];

			launchLSP.mockImplementation(async (command: string) => {
				calls.push(`launch(${command})`);
				if (calls.length <= 2) {
					throw new Error("BROKEN");
				}
				if (command === MANAGED) {
					return {
						process: { killed: false } as never,
						stdin: {} as never,
						stdout: {} as never,
						stderr: {} as never,
						pid: 9999,
					};
				}
				throw new Error(`unexpected: ${command} (call #${calls.length})`);
			});

			ensureTool.mockImplementation(
				async (_id: string, opts?: { forceReinstall?: boolean }) => {
					calls.push(`ensure(${opts?.forceReinstall ? "force" : "normal"})`);
					if (opts?.forceReinstall) return MANAGED;
					return "rust-analyzer";
				},
			);

			try {
				const spawned = await RustServer.spawn(tmp, {
					allowInstall: true,
				});

				expect(spawned).toBeDefined();
				expect(ensureTool).toHaveBeenCalledWith("rust-analyzer", {
					forceReinstall: true,
				});
				expect(launchLSP).toHaveBeenCalledWith(
					MANAGED,
					expect.any(Array),
					expect.objectContaining({ cwd: tmp }),
				);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error("Calls:", JSON.stringify(calls, null, 2));
				throw err;
			}
		});

		it("does not force-reinstall when path is already absolute", async () => {
			const { RustServer } = await import("../../../clients/lsp/server.js");
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-rust-no-force-"),
			);
			dirs.push(tmp);

			// Step 1: PATH candidate fails
			// Step 3: absolute path launch also fails → throws (no force-reinstall)
			launchLSP.mockImplementation(async () => {
				throw new Error("exit code 1");
			});

			// ensureTool returns an absolute path (simulates already-managed binary)
			ensureTool.mockResolvedValue(MANAGED);

			// resolveAndLaunch throws when all methods fail, including absolute-path
			// managed installs. That propagates through RustServer.spawn.
			await expect(
				RustServer.spawn(tmp, { allowInstall: true }),
			).rejects.toThrow("exit code 1");

			// ensureTool should NOT have been called with forceReinstall
			const forceCalls = ensureTool.mock.calls.filter(
				([, opts]) =>
					(opts as { forceReinstall?: boolean } | undefined)?.forceReinstall ===
					true,
			);
			expect(forceCalls).toHaveLength(0);
		});
	});
});

describe("heavy workspace servers do not fall back to per-file dirs (#201)", () => {
	it("RustServer.root → undefined when no Cargo manifest exists", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rust-nomanifest-"));
		dirs.push(tmp);
		const file = path.join(tmp, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "fn main() {}\n");

		// Previously fell back to FileDirRoot (the file's dir) → one rust-analyzer
		// per directory while scaffolding. Now no manifest ⇒ no spawn.
		await expect(RustServer.root(file)).resolves.toBeUndefined();
	});

	it("RustServer.root → the crate root when a Cargo.toml exists", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rust-manifest-"));
		dirs.push(tmp);
		const file = path.join(tmp, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(tmp, "Cargo.toml"), '[package]\nname = "x"\n');
		fs.writeFileSync(file, "fn main() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	// C# is intentionally NOT changed here (#201): its markers are matched by
	// exact filename, so `.csproj` never matches a real `Foo.csproj` and C# still
	// depends on the FileDirRoot fallback. See the standalone-csharp test above.
});
