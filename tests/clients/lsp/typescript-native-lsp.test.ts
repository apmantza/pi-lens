import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureTool, getToolEnvironment, launchLSP } = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({ PI_LENS_TEST_TOOLCHAIN: "1" })),
	launchLSP: vi.fn(),
}));

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
}));
vi.mock("../../../clients/lsp/launch.js", () => ({ launchLSP }));
vi.mock("../../../clients/latency-logger.js", () => ({ logLatency: vi.fn() }));

import { TypeScriptServer } from "../../../clients/lsp/server.ts";

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

function addTypeScriptPackage(root: string, version: string): void {
	fs.mkdirSync(path.join(root, "node_modules", "typescript"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, "node_modules", "typescript", "package.json"),
		JSON.stringify({ name: "typescript", version }),
	);
}

function makeProject(version: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-native-"));
	dirs.push(root);
	addTypeScriptPackage(root, version);
	return root;
}

function addWorkspacePackage(workspaceRoot: string): {
	packageRoot: string;
	sourceFile: string;
} {
	const packageRoot = path.join(workspaceRoot, "packages", "app");
	const sourceFile = path.join(packageRoot, "src", "index.ts");
	fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), '{"private":true}');
	fs.writeFileSync(sourceFile, "export const value = 1;\n");
	return { packageRoot, sourceFile };
}

function addNativeTsc(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const command = path.join(
		binDir,
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
	fs.writeFileSync(command, "");
	return command;
}

function addClassicWrapper(root: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const lspPath = path.join(binDir, "typescript-language-server");
	fs.writeFileSync(lspPath, "");
	return lspPath;
}

function addClassicServer(root: string) {
	const lspPath = addClassicWrapper(root);
	const tsserverPath = path.join(
		root,
		"node_modules",
		"typescript",
		"lib",
		"tsserver.js",
	);
	fs.mkdirSync(path.dirname(tsserverPath), { recursive: true });
	fs.writeFileSync(tsserverPath, "");
	return { lspPath, tsserverPath };
}

describe("TypeScript native LSP selection", () => {
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		getToolEnvironment.mockClear();
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("launches the project-local TypeScript 7 binary in native LSP mode", async () => {
		const root = makeProject("7.0.2");
		const command = addNativeTsc(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("uses a TypeScript 7 compiler hoisted above the nearest package root", async () => {
		const workspaceRoot = makeProject("7.0.2");
		const command = addNativeTsc(workspaceRoot);
		const { packageRoot, sourceFile } = addWorkspacePackage(workspaceRoot);

		const detectedRoot = await TypeScriptServer.root(sourceFile);
		expect(path.resolve(detectedRoot as string)).toBe(
			path.resolve(packageRoot),
		);

		const result = await TypeScriptServer.spawn(detectedRoot as string, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: packageRoot,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
		});
	});

	it("keeps TypeScript 6 on typescript-language-server and tsserver", async () => {
		const root = makeProject("6.0.3");
		addNativeTsc(root);
		const { lspPath, tsserverPath } = addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath },
		});
		expect(result?.launchVariant).toBe("classic");
	});

	it("does not skip a nearer TypeScript 6 package for an ancestor TypeScript 7 package", async () => {
		const workspaceRoot = makeProject("7.0.2");
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);
		addTypeScriptPackage(packageRoot, "6.0.3");
		addNativeTsc(packageRoot);
		const { lspPath, tsserverPath } = addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: packageRoot,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath },
		});
	});

	it("falls back to the classic server when a TypeScript 7 package has no local tsc binary", async () => {
		const root = makeProject("7.0.2");
		const lspPath = addClassicWrapper(root);
		const previousCwd = process.cwd();
		process.chdir(root);
		try {
			const result = await TypeScriptServer.spawn(root, {
				allowInstall: false,
			});

			expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
				cwd: root,
				env: {
					PI_LENS_TEST_TOOLCHAIN: "1",
					TSSERVER_PATH: undefined,
				},
			});
			expect(ensureTool).toHaveBeenCalledWith("typescript", {
				allowInstall: false,
			});
			expect(result).toBeDefined();
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("falls back safely when the nearest TypeScript package metadata is malformed", async () => {
		const root = makeProject("7.0.2");
		fs.writeFileSync(
			path.join(root, "node_modules", "typescript", "package.json"),
			"{",
		);
		addNativeTsc(root);
		const { lspPath, tsserverPath } = addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: root,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.initialization).toEqual({
			tsserver: { path: tsserverPath },
		});
	});

	// Copilot review (PR #526): a nearer `node_modules/typescript/` directory
	// that exists but has no `package.json` (a broken/partial install) must be
	// treated as malformed AT THAT LEVEL and stop the walk — never silently
	// skipped as "not installed here" in favor of an ancestor TS 7 hoist. That
	// would violate "nearest package shadows ancestors" for exactly the
	// malformed-install case the doc comment already calls out.
	it("does not skip a nearer TypeScript install whose package.json is missing (directory exists) to select an ancestor TS 7 hoist", async () => {
		const workspaceRoot = makeProject("7.0.2"); // ancestor: valid TS 7 install
		addNativeTsc(workspaceRoot);
		const { packageRoot } = addWorkspacePackage(workspaceRoot);

		// Nearer install: the `typescript` directory exists (e.g. a partial /
		// interrupted install) but package.json is missing entirely.
		fs.mkdirSync(path.join(packageRoot, "node_modules", "typescript"), {
			recursive: true,
		});
		const { lspPath, tsserverPath } = addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		// Must fall back to the classic path AT packageRoot, not launch the
		// ancestor's native tsc.
		expect(launchLSP).toHaveBeenCalledWith(lspPath, ["--stdio"], {
			cwd: packageRoot,
			env: {
				PI_LENS_TEST_TOOLCHAIN: "1",
				TSSERVER_PATH: tsserverPath,
			},
		});
		expect(result?.launchVariant).toBe("classic");
	});
});
