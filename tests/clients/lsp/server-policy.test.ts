import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const toolNotFound = (message = "ENOENT: command not found") =>
	Object.assign(new Error(message), { kind: "tool-not-found" as const });

const observedReadFileSync = vi.hoisted(() => vi.fn());
const logSessionStart = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	observedReadFileSync.mockImplementation(actual.readFileSync);
	return { ...actual, readFileSync: observedReadFileSync };
});

// Set test mode to isolate logging from production logs
process.env.PI_LENS_TEST_MODE = "1";

const ensureTool = vi.fn();
const getToolEnvironment = vi.fn(async () => ({}));
const launchLSP = vi.fn();

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));

vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
}));

// Suppress sync disk I/O from logLatency — prevents timeout under full-suite load
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart,
}));

const dirs: string[] = [];

const IS_WIN = process.platform === "win32";

/**
 * Build a fake managed tools tree for the classic TypeScript fallback (#1436):
 * a project dir, a managed `node_modules/.bin` holding the wrapper and `tsc`,
 * and a TypeScript package whose version and `lib/tsserver.js` the caller
 * controls through `writeCompiler`. Each case then states only its own facts.
 */
function createManagedTypeScriptTree(label: string) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-ts-${label}-`));
	dirs.push(tmp);
	fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

	const binDir = path.join(tmp, "managed", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const lspPath = path.join(
		binDir,
		IS_WIN ? "typescript-language-server.cmd" : "typescript-language-server",
	);
	const tscPath = path.join(binDir, IS_WIN ? "tsc.cmd" : "tsc");
	fs.writeFileSync(lspPath, "#!/usr/bin/env node\n");
	fs.writeFileSync(tscPath, "#!/usr/bin/env node\n");

	const typescriptDir = path.join(tmp, "managed", "node_modules", "typescript");
	const tsserverPath = path.join(typescriptDir, "lib", "tsserver.js");

	const writeCompiler = (version: string, withTsserver = false) => {
		fs.mkdirSync(path.join(typescriptDir, "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(typescriptDir, "package.json"),
			`${JSON.stringify({ name: "typescript", version })}\n`,
		);
		if (withTsserver) {
			fs.writeFileSync(tsserverPath, "// fake tsserver\n");
		} else {
			fs.rmSync(tsserverPath, { force: true });
		}
	};

	/** Resolve `ensureTool` to this tree; `onForceReinstall` models the repair. */
	const mockEnsureTool = (onForceReinstall?: () => void) => {
		ensureTool.mockImplementation(
			async (toolId: string, options?: { forceReinstall?: boolean }) => {
				if (toolId === "typescript-language-server") return lspPath;
				if (toolId !== "typescript") return undefined;
				if (options?.forceReinstall) onForceReinstall?.();
				return tscPath;
			},
		);
	};

	return { tmp, lspPath, tscPath, tsserverPath, writeCompiler, mockEnsureTool };
}

/** Resolve the mocked LSP launch with a stub process. */
function mockLaunchedProcess(pid: number): void {
	launchLSP.mockResolvedValue({
		process: { killed: false } as never,
		stdin: {} as never,
		stdout: {} as never,
		stderr: {} as never,
		pid,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		removeTempDirSync(dir);
	}
	delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	ensureTool.mockReset();
	launchLSP.mockReset();
	observedReadFileSync.mockClear();
	logSessionStart.mockClear();
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

	it("resolves css roots from the fixture marker", async () => {
		const { CssServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-css-fallback-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "cases", "styles.css");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// Pin the nearest marker inside the fixture. Windows test environments may
		// have a package.json in a real user-profile ancestor of os.tmpdir().
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
		fs.writeFileSync(file, "body { color: red; }\n");

		const root = await CssServer.root(file);
		expect(root).toBe(tmp);
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

	it("skips standalone csharp files without a project marker (#201)", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-no-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "Program.cs");
		fs.writeFileSync(file, 'Console.WriteLine("ok");\n');

		const root = await CSharpServer.root(file);
		expect(root).toBeUndefined();
	});

	it("resolves csharp roots from real .csproj/.sln filenames (#201)", async () => {
		const { CSharpServer, OmniSharpServer } =
			await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-csharp-root-"));
		dirs.push(tmp);

		const project = path.join(tmp, "src", "App");
		const file = path.join(project, "Program.cs");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "App.csproj"), "<Project />\n");
		fs.writeFileSync(file, 'Console.WriteLine("ok");\n');

		await expect(CSharpServer.root(file)).resolves.toBe(project);
		await expect(OmniSharpServer.root(file)).resolves.toBe(project);

		const solutionRoot = path.join(tmp, "solution");
		const solutionProject = path.join(solutionRoot, "Nested");
		const solutionFile = path.join(solutionProject, "Program.cs");
		fs.mkdirSync(solutionProject, { recursive: true });
		fs.writeFileSync(path.join(solutionRoot, "Workspace.sln"), "\n");
		fs.writeFileSync(solutionFile, 'Console.WriteLine("ok");\n');
		await expect(CSharpServer.root(solutionFile)).resolves.toBe(solutionRoot);

		const slnxRoot = path.join(tmp, "slnx");
		const slnxProject = path.join(slnxRoot, "Nested");
		const slnxFile = path.join(slnxProject, "Program.cs");
		fs.mkdirSync(slnxProject, { recursive: true });
		fs.writeFileSync(path.join(slnxRoot, "Workspace.slnx"), "\n");
		fs.writeFileSync(slnxFile, 'Console.WriteLine("ok");\n');
		await expect(CSharpServer.root(slnxFile)).resolves.toBe(slnxRoot);
		await expect(OmniSharpServer.root(slnxFile)).resolves.toBe(slnxRoot);
	});

	it("does not treat a directory named like a project marker as a root (#201)", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-dirmarker-"),
		);
		dirs.push(tmp);

		const project = path.join(tmp, "App");
		const file = path.join(project, "Program.cs");
		fs.mkdirSync(project, { recursive: true });
		// A *directory* whose name matches `*.csproj` must not count as a marker.
		fs.mkdirSync(path.join(project, "Fake.csproj"));
		fs.writeFileSync(file, 'Console.WriteLine("ok");\n');

		await expect(CSharpServer.root(file)).resolves.toBeUndefined();
	});

	it("matches csharp project markers case-insensitively on win32 (#201)", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-nocase-"),
		);
		dirs.push(tmp);

		const project = path.join(tmp, "App");
		const file = path.join(project, "Program.cs");
		fs.mkdirSync(project, { recursive: true });
		// Uppercase extension: the marker glob is `*.csproj` (lowercase).
		fs.writeFileSync(path.join(project, "App.CSPROJ"), "<Project />\n");
		fs.writeFileSync(file, 'Console.WriteLine("ok");\n');

		const root = await CSharpServer.root(file);
		if (process.platform === "win32") {
			expect(root).toBe(project); // nocase match
		} else {
			expect(root).toBeUndefined(); // case-sensitive FS → no match
		}
	});

	it("resolves fsharp roots from real .fsproj filenames (#201)", async () => {
		const { FSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fsharp-root-"));
		dirs.push(tmp);

		const project = path.join(tmp, "src", "App");
		const file = path.join(project, "Program.fs");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "App.fsproj"), "<Project />\n");
		fs.writeFileSync(file, 'printfn "ok"\n');

		await expect(FSharpServer.root(file)).resolves.toBe(project);
	});

	it("skips standalone fsharp files without a project marker (#201)", async () => {
		const { FSharpServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-fsharp-no-root-"),
		);
		dirs.push(tmp);

		const file = path.join(tmp, "Program.fs");
		fs.writeFileSync(file, 'printfn "ok"\n');

		await expect(FSharpServer.root(file)).resolves.toBeUndefined();
	});

	it("tries pi-lens managed csharp candidates before legacy global dotnet tools", async () => {
		const { CSharpServer } = await import("../../../clients/lsp/server.js");
		const { getGlobalPiLensDir } =
			await import("../../../clients/file-utils.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-csharp-candidates-"),
		);
		dirs.push(tmp);

		launchLSP.mockRejectedValue(toolNotFound());

		const spawned = await CSharpServer.spawn(tmp, { allowInstall: false });
		expect(spawned).toBeUndefined();
		expect(launchLSP).toHaveBeenCalled();
		const commands = launchLSP.mock.calls.map((call) => String(call[0] ?? ""));
		// Asserts against the actual machine-global root (respects #525's
		// PI_LENS_HOME test override) rather than hardcoding ".pi-lens".
		const managedBinDir = path.join(getGlobalPiLensDir(), "bin", "csharp-ls");
		expect(commands.some((command) => command.includes(managedBinDir))).toBe(
			true,
		);
	});

	it("falls back to file directory for standalone cpp/zig/elixir/gleam files", async () => {
		const { CppServer, ZigServer, ElixirServer, GleamServer } =
			await import("../../../clients/lsp/server.js");
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

	it("attaches fixture files to the outer project instead of fixture manifests (#1325)", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-fixture-root-"));
		dirs.push(tmp);

		const fixture = path.join(tmp, "tests", "fixtures", "nested-project");
		const file = path.join(fixture, "src", "index.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.mkdirSync(path.join(tmp, ".git"));
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
		fs.writeFileSync(path.join(fixture, "package.json"), "{}\n");
		fs.writeFileSync(file, "export const value = 1;\n");

		await expect(NearestRoot(["package.json"])(file)).resolves.toBe(tmp);
	});

	it("does not classify a testdata substring as a fixture segment (#1328)", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-testdata-segment-"),
		);
		dirs.push(tmp);

		const project = path.join(tmp, "testdata-tools");
		const file = path.join(project, "src", "index.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.mkdirSync(path.join(tmp, ".git"));
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		fs.writeFileSync(file, "export const value = 1;\n");

		await expect(NearestRoot(["package.json"])(file)).resolves.toBe(project);
	});

	it("memoizes project ignore globs until .gitignore changes (#1328)", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const { isPathIgnoredByProject } =
			await import("../../../clients/file-utils.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ignore-cache-"));
		dirs.push(tmp);

		fs.mkdirSync(path.join(tmp, ".git"));
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
		const gitignore = path.join(tmp, ".gitignore");
		fs.writeFileSync(gitignore, "generated/\n");
		// Warm the independent authoritative matcher, then count only the cheap
		// positive-glob precheck used by root resolution.
		isPathIgnoredByProject(path.join(tmp, "warmup"), tmp, true);
		observedReadFileSync.mockClear();
		for (const name of ["one", "two", "three"]) {
			const project = path.join(tmp, name);
			const file = path.join(project, "index.ts");
			fs.mkdirSync(project);
			fs.writeFileSync(path.join(project, "package.json"), "{}\n");
			fs.writeFileSync(file, "");
			await NearestRoot(["package.json"])(file);
		}
		const gitignoreReads = () =>
			observedReadFileSync.mock.calls.filter(
				([file]) => path.resolve(String(file)) === gitignore,
			).length;
		expect(gitignoreReads()).toBe(1);

		const touchedAt = new Date(Date.now() + 2_000);
		fs.utimesSync(gitignore, touchedAt, touchedAt);
		const changedProject = path.join(tmp, "four");
		const changedFile = path.join(changedProject, "index.ts");
		fs.mkdirSync(changedProject);
		fs.writeFileSync(path.join(changedProject, "package.json"), "{}\n");
		fs.writeFileSync(changedFile, "");
		await NearestRoot(["package.json"])(changedFile);
		// Both the precheck and the authoritative matcher invalidate. The first
		// post-touch resolution therefore performs one fresh read for each cache.
		expect(gitignoreReads()).toBe(3);
	});

	it("caches empty project ignore globs when .gitignore is absent (#1328)", async () => {
		const { getProjectIgnoreGlobs } =
			await import("../../../clients/file-utils.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-no-gitignore-cache-"),
		);
		dirs.push(tmp);
		const gitignore = path.join(tmp, ".gitignore");

		expect(getProjectIgnoreGlobs(tmp)).toEqual([]);
		expect(getProjectIgnoreGlobs(tmp)).toEqual([]);
		expect(getProjectIgnoreGlobs(tmp)).toEqual([]);
		expect(
			observedReadFileSync.mock.calls.filter(
				([file]) => path.resolve(String(file)) === gitignore,
			),
		).toHaveLength(1);
	});

	it("does not make a gitignored manifest directory an LSP root (#1325)", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ignored-root-"));
		dirs.push(tmp);

		const generated = path.join(tmp, "generated");
		const file = path.join(generated, "index.ts");
		fs.mkdirSync(path.join(tmp, ".git"));
		fs.mkdirSync(generated);
		fs.writeFileSync(path.join(tmp, ".gitignore"), "generated/\n");
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");
		fs.writeFileSync(path.join(generated, "package.json"), "{}\n");
		fs.writeFileSync(file, "export const generated = true;\n");

		await expect(NearestRoot(["package.json"])(file)).resolves.toBe(tmp);
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

	// Misses are deliberately NOT cached: the absent → present transition
	// (agent scaffolds package.json/tsconfig.json mid-session) must be picked
	// up on the next resolution without a process restart. Only hits are
	// process-lifetime memos.
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

		// Marker created AFTER the first miss — the next walk must find it.
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

	it("clamps a marker root above the session cwd and logs once (#1373)", async () => {
		const { NearestRoot } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-root-clamp-"));
		dirs.push(tmp);

		const project = path.join(tmp, "project");
		const file = path.join(project, "nested", "doc.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(tmp, ".marksman.toml"), "[core]\n");
		fs.writeFileSync(file, "# Doc\n");

		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);
		try {
			const resolver = NearestRoot([".marksman.toml"]);
			await expect(resolver(file)).resolves.toBe(project);
			await expect(resolver(file)).resolves.toBe(project);
			expect(logSessionStart).toHaveBeenCalledTimes(1);
			expect(logSessionStart).toHaveBeenCalledWith(
				expect.stringContaining("lsp root clamped to session cwd"),
			);
		} finally {
			cwdSpy.mockRestore();
		}
	});

	it("matches Dockerfile by basename in configured server lookup", async () => {
		const { getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
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

	// #1412 M1: a nested config root (e.g. cypress/tsconfig.json) with
	// node_modules only at the REPO ROOT must still find the classic
	// typescript-language-server wrapper AND tsserver.js by walking up from the
	// LSP root — pre-fix this only checked <root> itself and degraded to
	// managed download/no-LSP.
	it("finds classic TypeScript tooling at an ancestor node_modules for a nested config root", async () => {
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ts-nested-root-"),
		);
		dirs.push(tmp);

		const binDir = path.join(tmp, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const isWin = process.platform === "win32";
		const lspBin = path.join(
			binDir,
			isWin ? "typescript-language-server.cmd" : "typescript-language-server",
		);
		fs.writeFileSync(lspBin, "#!/usr/bin/env node\n");

		const tsserverDir = path.join(tmp, "node_modules", "typescript", "lib");
		fs.mkdirSync(tsserverDir, { recursive: true });
		const tsserverPath = path.join(tsserverDir, "tsserver.js");
		fs.writeFileSync(tsserverPath, "// fake tsserver\n");

		const nestedRoot = path.join(tmp, "cypress");
		fs.mkdirSync(nestedRoot, { recursive: true });
		fs.writeFileSync(path.join(nestedRoot, "tsconfig.json"), "{}\n");

		launchLSP.mockResolvedValue({
			process: { killed: false } as never,
			stdin: {} as never,
			stdout: {} as never,
			stderr: {} as never,
			pid: 2222,
		});

		const spawned = await TypeScriptServer.spawn(nestedRoot);
		expect(spawned).toBeDefined();
		expect(launchLSP).toHaveBeenCalledWith(
			lspBin,
			["--stdio"],
			expect.objectContaining({
				cwd: nestedRoot,
				env: expect.objectContaining({ TSSERVER_PATH: tsserverPath }),
			}),
		);
	});

	it("repairs an incompatible managed TypeScript compiler for the classic fallback", async () => {
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();
		const tree = createManagedTypeScriptTree("managed-repair");
		tree.writeCompiler("7.0.2");
		tree.mockEnsureTool(() => tree.writeCompiler("5.9.3", true));
		mockLaunchedProcess(3333);

		const spawned = await TypeScriptServer.spawn(tree.tmp);

		expect(spawned).toBeDefined();
		expect(ensureTool).toHaveBeenCalledWith("typescript", {
			allowInstall: true,
		});
		expect(ensureTool).toHaveBeenCalledWith("typescript", {
			allowInstall: true,
			forceReinstall: true,
		});
		// A refactor must not double-install: exactly one forced reinstall.
		expect(
			ensureTool.mock.calls.filter(
				(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
			),
		).toHaveLength(1);
		expect(launchLSP).toHaveBeenCalledWith(
			tree.lspPath,
			["--stdio"],
			expect.objectContaining({
				cwd: tree.tmp,
				env: expect.objectContaining({ TSSERVER_PATH: tree.tsserverPath }),
			}),
		);
		expect(logSessionStart).toHaveBeenCalledWith(
			"lsp typescript: managed compiler resolved to TypeScript 7.0.2, which ships no tsserver.js; reinstalling pinned classic fallback",
		);
	});

	// The once-guard: a repair that yields no tsserver.js must not retry on the
	// next spawn. ensureTool caches successful installs, so only the FAILING
	// path can loop — three call sites, each with a 120 s install timeout.
	it("attempts the classic TypeScript repair at most once per process", async () => {
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();
		const tree = createManagedTypeScriptTree("repair-once");
		tree.writeCompiler("7.0.2");
		// The reinstall does not produce a usable compiler (offline, partial).
		tree.mockEnsureTool();
		mockLaunchedProcess(4444);

		const first = await TypeScriptServer.spawn(tree.tmp);
		const second = await TypeScriptServer.spawn(tree.tmp);

		expect(first?.initialization).toBeUndefined();
		expect(second?.initialization).toBeUndefined();
		expect(launchLSP).toHaveBeenCalledWith(
			tree.lspPath,
			["--stdio"],
			expect.objectContaining({
				env: expect.objectContaining({ TSSERVER_PATH: undefined }),
			}),
		);
		expect(
			ensureTool.mock.calls.filter(
				(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
			),
		).toHaveLength(1);
	});

	// AC-5: discovery-only callers never mutate the tools tree, even when a
	// discovered TypeScript 7 compiler is present. This reaches the repair
	// branch's gate rather than short-circuiting on an undefined ensureTool.
	it("never reinstalls the classic TypeScript compiler when install is disabled", async () => {
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();
		const tree = createManagedTypeScriptTree("repair-disabled");
		tree.writeCompiler("7.0.2");
		tree.mockEnsureTool();
		mockLaunchedProcess(5555);
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";

		const spawned = await TypeScriptServer.spawn(tree.tmp);

		expect(spawned?.initialization).toBeUndefined();
		expect(ensureTool).toHaveBeenCalledWith("typescript", {
			allowInstall: false,
		});
		expect(
			ensureTool.mock.calls.filter((call) => call[1]?.forceReinstall === true),
		).toHaveLength(0);
		expect(logSessionStart).not.toHaveBeenCalledWith(
			expect.stringContaining("reinstalling pinned classic fallback"),
		);
	});

	// A bare `tsc` from PATH has no readable version and no adjacent package
	// layout. Repairing there would force-reinstall over a healthy global 5.x.
	it("skips the classic TypeScript repair for a bare PATH compiler", async () => {
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();
		const tree = createManagedTypeScriptTree("repair-path-hit");
		ensureTool.mockImplementation(async (toolId: string) => {
			if (toolId === "typescript-language-server") return tree.lspPath;
			if (toolId === "typescript") return "tsc";
			return undefined;
		});
		mockLaunchedProcess(6666);

		const spawned = await TypeScriptServer.spawn(tree.tmp);

		expect(spawned?.initialization).toBeUndefined();
		expect(
			ensureTool.mock.calls.filter((call) => call[1]?.forceReinstall === true),
		).toHaveLength(0);
	});

	it("skips PowerShell bash-language-server shim candidates on Windows", async () => {
		const { BashServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-bash-candidates-"),
		);
		dirs.push(tmp);

		launchLSP.mockRejectedValue(toolNotFound());

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
		// Discovery is decoupled from install: ensureTool still runs (to probe an
		// existing PATH/npm-global binary) but is told NOT to install. The mock
		// returns undefined (nothing discovered), so spawn yields undefined.
		expect(ensureTool).toHaveBeenCalledWith("typescript-language-server", {
			allowInstall: false,
		});
	});

	it("skips package-manager fallback when lsp install is disabled", async () => {
		const { SvelteServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sv-policy-"));
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		launchLSP.mockRejectedValue(toolNotFound());

		const spawned = await SvelteServer.spawn(tmp);
		expect(spawned?.process).toBeUndefined();
	});

	it("skips package-manager fallback when install is disallowed for file", async () => {
		const { SvelteServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-sv-install-off-"),
		);
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

		launchLSP.mockRejectedValue(toolNotFound());

		const spawned = await SvelteServer.spawn(tmp, { allowInstall: false });
		expect(spawned?.process).toBeUndefined();
	});

	it("keeps custom LSP config scoped per workspace", async () => {
		const { getServersForFileWithConfig, initLSPConfig } =
			await import("../../../clients/lsp/config.js");

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
			throw toolNotFound(`unexpected command: ${command}`);
		});

		const spawned = await PythonServer.spawn(tmp, { allowInstall: true });

		expect(spawned).toBeDefined();
		expect(ensureTool).toHaveBeenCalledWith("pyright", { allowInstall: true });
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

	it("falls back to `ty server` when pyright/basedpyright aren't found locally, without triggering an install", async () => {
		const { PythonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ty-lsp-"));
		dirs.push(tmp);

		launchLSP.mockImplementation(async (command: string, args: string[]) => {
			if (command === "ty" && args?.[0] === "server") {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 5678,
				};
			}
			throw toolNotFound(`unexpected command: ${command}`);
		});

		const spawned = await PythonServer.spawn(tmp, { allowInstall: true });

		expect(spawned).toBeDefined();
		expect(spawned?.source).toBe("direct");
		expect(spawned?.initialization).toBeUndefined();
		// ty remains opt-in and never enters the managed installer tier.
		expect(ensureTool).not.toHaveBeenCalled();
		expect(
			launchLSP.mock.calls.some(
				([command, args]) =>
					command === "ty" && Array.isArray(args) && args[0] === "server",
			),
		).toBe(true);
	});

	it("prefers project-local ty over PATH pyright from an unactivated .venv", async () => {
		const { PythonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ty-venv-"));
		dirs.push(tmp);

		const environmentRoot = path.join(tmp, ".venv");
		const binDir = path.join(
			environmentRoot,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		const tyPath = path.join(
			binDir,
			process.platform === "win32" ? "ty.exe" : "ty",
		);
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");
		fs.writeFileSync(tyPath, "#!/usr/bin/env python\n");

		const originalVenv = process.env.VIRTUAL_ENV;
		const originalConda = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;

		let tyLaunchOptions: { env?: NodeJS.ProcessEnv; cwd?: string } | undefined;
		launchLSP.mockImplementation(
			async (
				command: string,
				args: string[],
				options?: { env?: NodeJS.ProcessEnv; cwd?: string },
			) => {
				if (command === tyPath && args?.[0] === "server") {
					tyLaunchOptions = options;
					return {
						process: { killed: false } as never,
						stdin: {} as never,
						stdout: {} as never,
						stderr: {} as never,
						pid: 5679,
					};
				}
				// Simulate pi-lens's managed Pyright being visible to a bare PATH lookup.
				if (command === "pyright-langserver") {
					return {
						process: { killed: false } as never,
						stdin: {} as never,
						stdout: {} as never,
						stderr: {} as never,
						pid: 5680,
					};
				}
				throw toolNotFound(`unexpected command: ${command}`);
			},
		);

		try {
			const spawned = await PythonServer.spawn(tmp, { allowInstall: true });
			expect(spawned).toBeDefined();
			expect(tyLaunchOptions?.cwd).toBe(tmp);
			expect(tyLaunchOptions?.env?.VIRTUAL_ENV).toBe(environmentRoot);
			expect(tyLaunchOptions?.env?.PATH?.split(path.delimiter)[0]).toBe(binDir);
			expect(process.env.VIRTUAL_ENV).toBeUndefined();
			expect(ensureTool).not.toHaveBeenCalled();
			expect(
				launchLSP.mock.calls.some(
					([command]) => command === "pyright-langserver",
				),
			).toBe(false);
		} finally {
			if (originalVenv === undefined) delete process.env.VIRTUAL_ENV;
			else process.env.VIRTUAL_ENV = originalVenv;
			if (originalConda === undefined) delete process.env.CONDA_PREFIX;
			else process.env.CONDA_PREFIX = originalConda;
		}
	});

	it("prefers project-local basedpyright over PATH pyright", async () => {
		const { PythonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-basedpyright-venv-"),
		);
		dirs.push(tmp);

		const environmentRoot = path.join(tmp, ".venv");
		const binDir = path.join(
			environmentRoot,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		const basedpyrightPath = path.join(
			binDir,
			process.platform === "win32"
				? "basedpyright-langserver.exe"
				: "basedpyright-langserver",
		);
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "#!/usr/bin/env python\n");
		fs.writeFileSync(basedpyrightPath, "#!/usr/bin/env python\n");

		const originalVenv = process.env.VIRTUAL_ENV;
		const originalConda = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;

		launchLSP.mockImplementation(async (command: string) => {
			if (command === basedpyrightPath || command === "pyright-langserver") {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 5681,
				};
			}
			throw toolNotFound(`unexpected command: ${command}`);
		});

		try {
			const spawned = await PythonServer.spawn(tmp, { allowInstall: true });
			expect(spawned).toBeDefined();
			expect(
				launchLSP.mock.calls.some(([command]) => command === basedpyrightPath),
			).toBe(true);
			expect(
				launchLSP.mock.calls.some(
					([command]) => command === "pyright-langserver",
				),
			).toBe(false);
			expect(ensureTool).not.toHaveBeenCalled();
		} finally {
			if (originalVenv === undefined) delete process.env.VIRTUAL_ENV;
			else process.env.VIRTUAL_ENV = originalVenv;
			if (originalConda === undefined) delete process.env.CONDA_PREFIX;
			else process.env.CONDA_PREFIX = originalConda;
		}
	});

	it("prefers a locally-found pyright over ty (opt-in fallback never wins when pyright is available)", async () => {
		const { PythonServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pyright-over-ty-"),
		);
		dirs.push(tmp);

		launchLSP.mockImplementation(async (command: string) => {
			if (command === "pyright-langserver") {
				return {
					process: { killed: false } as never,
					stdin: {} as never,
					stdout: {} as never,
					stderr: {} as never,
					pid: 4321,
				};
			}
			throw toolNotFound(`unexpected command: ${command}`);
		});

		const spawned = await PythonServer.spawn(tmp, { allowInstall: true });

		expect(spawned).toBeDefined();
		expect(ensureTool).not.toHaveBeenCalled();
		expect(launchLSP.mock.calls.some(([command]) => command === "ty")).toBe(
			false,
		);
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
			throw toolNotFound(`unexpected command: ${command}`);
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
			throw toolNotFound(`unexpected command: ${command}`);
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
				throw toolNotFound();
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
			throw toolNotFound(`unexpected command: ${command}`);
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
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");
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
					throw Object.assign(new Error("tool not found"), {
						kind: "tool-not-found",
					});
				}
				if (command === "rust-analyzer") {
					throw Object.assign(new Error("tool not found"), {
						kind: "tool-not-found",
					});
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
				throw toolNotFound(`unexpected: ${command} (call #${calls.length})`);
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
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rust-nomanifest-"),
		);
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
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rust-manifest-"),
		);
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

describe("monorepo root hoisting (#1671)", () => {
	const originalCwd = process.cwd();

	afterEach(() => {
		process.chdir(originalCwd);
	});

	it("RustServer.root hoists every crate in a Cargo workspace to the shared workspace root", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cargo-ws-"));
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["crate-a", "crate-b", "crate-c"]\n',
		);
		const crateFiles: string[] = [];
		for (const crate of ["crate-a", "crate-b", "crate-c"]) {
			const crateDir = path.join(tmp, crate);
			fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(crateDir, "Cargo.toml"),
				`[package]\nname = "${crate}"\n`,
			);
			const file = path.join(crateDir, "src", "lib.rs");
			fs.writeFileSync(file, "pub fn x() {}\n");
			crateFiles.push(file);
		}

		const roots = await Promise.all(crateFiles.map((f) => RustServer.root(f)));
		// N heavy servers where 1 suffices is exactly the memory/process cost #1671
		// is closing: every crate must resolve to the same workspace root.
		expect(new Set(roots).size).toBe(1);
		expect(roots[0]).toBe(tmp);
	});

	it("RustServer.root leaves a crate outside the workspace's members table crate-rooted", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cargo-nonmember-"),
		);
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["crate-a"]\n',
		);
		const memberDir = path.join(tmp, "crate-a");
		fs.mkdirSync(path.join(memberDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(memberDir, "Cargo.toml"),
			'[package]\nname = "crate-a"\n',
		);
		const memberFile = path.join(memberDir, "src", "lib.rs");
		fs.writeFileSync(memberFile, "pub fn x() {}\n");

		// standalone-tool sits next to the workspace but is never listed in
		// `members` — cargo itself does not build it as part of the workspace, so
		// pi-lens must not spawn a shared rust-analyzer root that merges it in.
		const nonMemberDir = path.join(tmp, "standalone-tool");
		fs.mkdirSync(path.join(nonMemberDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(nonMemberDir, "Cargo.toml"),
			'[package]\nname = "standalone-tool"\n',
		);
		const nonMemberFile = path.join(nonMemberDir, "src", "lib.rs");
		fs.writeFileSync(nonMemberFile, "pub fn y() {}\n");

		await expect(RustServer.root(memberFile)).resolves.toBe(tmp);
		await expect(RustServer.root(nonMemberFile)).resolves.toBe(nonMemberDir);
	});

	it("RustServer.root does not hoist a workspace root above the session cwd", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cargo-ceil-"));
		dirs.push(tmp);

		const workspaceDir = path.join(tmp, "workspace");
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(
			path.join(workspaceDir, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/foo"]\n',
		);
		const crateDir = path.join(workspaceDir, "crates", "foo");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "foo"\n',
		);
		const file = path.join(crateDir, "src", "main.rs");
		fs.writeFileSync(file, "fn main() {}\n");

		// Session started narrower than the workspace: cwd IS the crate root, so
		// there is no room to hoist upward without crossing the session boundary.
		process.chdir(crateDir);

		await expect(RustServer.root(file)).resolves.toBe(crateDir);
	});

	it("JavaServer.root hoists declared Maven modules to the parent pom, but leaves an undeclared sibling crate-rooted", async () => {
		const { JavaServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-maven-ws-"));
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "pom.xml"),
			[
				"<project>",
				"  <modules>",
				"    <module>module-a</module>",
				"    <module>module-b</module>",
				"  </modules>",
				"</project>",
			].join("\n"),
		);

		const moduleFiles: string[] = [];
		for (const mod of ["module-a", "module-b"]) {
			const modDir = path.join(tmp, mod, "src", "main", "java");
			fs.mkdirSync(modDir, { recursive: true });
			fs.writeFileSync(
				path.join(tmp, mod, "pom.xml"),
				`<project><parent><artifactId>${mod}</artifactId></parent></project>`,
			);
			const file = path.join(modDir, "Main.java");
			fs.writeFileSync(file, "class Main {}\n");
			moduleFiles.push(file);
		}

		const siblingDir = path.join(tmp, "sibling", "src", "main", "java");
		fs.mkdirSync(siblingDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "sibling", "pom.xml"),
			"<project><artifactId>sibling</artifactId></project>",
		);
		const siblingFile = path.join(siblingDir, "Sibling.java");
		fs.writeFileSync(siblingFile, "class Sibling {}\n");

		const moduleRoots = await Promise.all(
			moduleFiles.map((f) => JavaServer.root(f)),
		);
		expect(new Set(moduleRoots).size).toBe(1);
		expect(moduleRoots[0]).toBe(tmp);

		// The sibling pom is never declared in the parent's <modules>, so it stays
		// its own independent root instead of being swept into the parent's server.
		await expect(JavaServer.root(siblingFile)).resolves.toBe(
			path.join(tmp, "sibling"),
		);
	});

	it("JavaServer.root does not hoist a declared module chain above the session cwd", async () => {
		const { JavaServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-maven-ceil-"));
		dirs.push(tmp);

		const parentDir = path.join(tmp, "parent");
		fs.mkdirSync(parentDir, { recursive: true });
		fs.writeFileSync(
			path.join(parentDir, "pom.xml"),
			"<project><modules><module>module-a</module></modules></project>",
		);
		const moduleDir = path.join(parentDir, "module-a", "src", "main", "java");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(parentDir, "module-a", "pom.xml"),
			"<project><artifactId>module-a</artifactId></project>",
		);
		const file = path.join(moduleDir, "Main.java");
		fs.writeFileSync(file, "class Main {}\n");

		// Session cwd is the module itself: no room to hoist to the parent without
		// crossing the session boundary.
		process.chdir(path.join(parentDir, "module-a"));

		await expect(JavaServer.root(file)).resolves.toBe(
			path.join(parentDir, "module-a"),
		);
	});

	it("RustServer.root hoists a nested crate whose members entry spans a gap directory (exact path)", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cargo-nested-"));
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/foo"]\n',
		);
		// "crates" is a gap directory: it holds no Cargo.toml of its own, so the
		// walk cursor climbs through it before reaching the workspace root. The
		// `members` entry is relative to the WORKSPACE root, not to that gap
		// directory (#1671 F1).
		const crateDir = path.join(tmp, "crates", "foo");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "foo"\n',
		);
		const file = path.join(crateDir, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	it("RustServer.root hoists a nested crate whose members entry spans a gap directory (glob)", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cargo-nested-glob-"),
		);
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/*"]\n',
		);
		const crateDir = path.join(tmp, "crates", "foo");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "foo"\n',
		);
		const file = path.join(crateDir, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	it("RustServer.root treats a bare `*` members entry as claiming every direct workspace subdirectory", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cargo-star-"));
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["*"]\n',
		);
		const crateDir = path.join(tmp, "foo");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "foo"\n',
		);
		const file = path.join(crateDir, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	it("RustServer.root matches a two-segment glob members entry (crates/*/*)", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cargo-deepglob-"),
		);
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			'[workspace]\nmembers = ["crates/*/*"]\n',
		);
		const crateDir = path.join(tmp, "crates", "group-a", "foo");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "foo"\n',
		);
		const file = path.join(crateDir, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	it("RustServer.root does not read a [package] exclude key above [workspace] as workspace membership", async () => {
		const { RustServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-cargo-pkg-exclude-"),
		);
		dirs.push(tmp);

		// The root crate's OWN [package] has a publish-time `exclude` key (a
		// completely different concept from workspace membership) written above
		// [workspace]. A whole-file regex would misread it as the workspace's
		// exclude list and wrongly reject "crate-a" as excluded (#1671 F4).
		fs.writeFileSync(
			path.join(tmp, "Cargo.toml"),
			[
				"[package]",
				'name = "root"',
				'exclude = ["crate-a"]',
				"",
				"[workspace]",
				'members = ["crate-a"]',
			].join("\n"),
		);
		const crateDir = path.join(tmp, "crate-a");
		fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(crateDir, "Cargo.toml"),
			'[package]\nname = "crate-a"\n',
		);
		const file = path.join(crateDir, "src", "lib.rs");
		fs.writeFileSync(file, "pub fn x() {}\n");

		await expect(RustServer.root(file)).resolves.toBe(tmp);
	});

	it("JavaServer.root hoists a module declared with a multi-segment path spanning a gap directory", async () => {
		const { JavaServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-maven-nested-"));
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "pom.xml"),
			"<project><modules><module>sub/dir</module></modules></project>",
		);
		// "sub" is a gap directory with no pom.xml of its own — the declared
		// module path spans it in one hop (#1671 F2).
		const moduleDir = path.join(tmp, "sub", "dir", "src", "main", "java");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "sub", "dir", "pom.xml"),
			"<project><artifactId>dir</artifactId></project>",
		);
		const file = path.join(moduleDir, "Main.java");
		fs.writeFileSync(file, "class Main {}\n");

		await expect(JavaServer.root(file)).resolves.toBe(tmp);
	});

	it("JavaServer.root does not hoist through a commented-out <module> entry", async () => {
		const { JavaServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-maven-commented-"),
		);
		dirs.push(tmp);

		fs.writeFileSync(
			path.join(tmp, "pom.xml"),
			[
				"<project>",
				"  <modules>",
				"    <!-- <module>module-a</module> -->",
				"  </modules>",
				"</project>",
			].join("\n"),
		);
		const moduleDir = path.join(tmp, "module-a", "src", "main", "java");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "module-a", "pom.xml"),
			"<project><artifactId>module-a</artifactId></project>",
		);
		const file = path.join(moduleDir, "Main.java");
		fs.writeFileSync(file, "class Main {}\n");

		// The <module> entry is commented out — cargo/maven itself would not
		// build it as part of the reactor, so pi-lens must not hoist to it
		// either (#1671 F5).
		await expect(JavaServer.root(file)).resolves.toBe(
			path.join(tmp, "module-a"),
		);
	});
});

describe("zizmor LSP candidacy path gate (#636)", () => {
	// zizmor's extension match is "any YAML" — the real filter that keeps it out
	// of the candidate list for a guaranteed-no-op file (measured directly
	// against a real `zizmor --lsp` process: no publishDiagnostics at all for a
	// non-workflow YAML, so `waitForDiagnostics` would otherwise burn its full
	// budget for zero signal) is `getServersForFileWithConfig`'s pathFilter gate.
	it("includes zizmor as a candidate for a real GitHub Actions workflow file", async () => {
		const { getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-zizmor-candidacy-"),
		);
		dirs.push(tmp);
		const file = path.join(tmp, ".github", "workflows", "ci.yml");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "on: push\njobs: {}\n");

		const ids = getServersForFileWithConfig(file).map((s) => s.id);
		expect(ids).toContain("zizmor");
	});

	it("excludes zizmor as a candidate for a plain, non-workflow YAML file", async () => {
		const { getServersForFileWithConfig } =
			await import("../../../clients/lsp/config.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-zizmor-candidacy-"),
		);
		dirs.push(tmp);
		const file = path.join(tmp, "docker-compose.yml");
		fs.writeFileSync(file, "version: '3.8'\nservices: {}\n");

		const ids = getServersForFileWithConfig(file).map((s) => s.id);
		expect(ids).not.toContain("zizmor");
		// The primary yaml language server still attaches — only zizmor (the
		// auxiliary that can never report on this file) is gated out.
		expect(ids).toContain("yaml");
	});
});
