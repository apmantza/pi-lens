import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";
import { setPlatform } from "../../support/platform-stub.js";

const { ensureTool, getToolEnvironment, launchLSP, launchViaNode } = vi.hoisted(
	() => ({
		ensureTool: vi.fn(),
		getToolEnvironment: vi.fn(async () => ({ PI_LENS_TEST_TOOLCHAIN: "1" })),
		launchLSP: vi.fn(),
		launchViaNode: vi.fn(),
	}),
);

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	launchViaNode,
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));

import { TypeScriptServer } from "../../../clients/lsp/server.js";

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

/** `<root>/node_modules/@typescript/native` (an `npm:typescript@7` alias). */
function addNativeAlias(
	root: string,
	opts: {
		name?: string;
		version?: string;
		bin?: unknown;
		writeBin?: boolean;
		manifestText?: string;
	} = {},
): string {
	const {
		name = "typescript",
		version = "7.0.2",
		writeBin = true,
		manifestText,
	} = opts;
	// `bin: undefined` omits the key; an absent option takes the real layout.
	const bin = "bin" in opts ? opts.bin : { tsc: "./bin/tsc" };
	const aliasDir = path.join(root, "node_modules", "@typescript", "native");
	fs.mkdirSync(aliasDir, { recursive: true });
	fs.writeFileSync(
		path.join(aliasDir, "package.json"),
		manifestText ?? JSON.stringify({ name, version, bin }),
	);
	const aliasBin = path.join(aliasDir, "bin", "tsc");
	if (writeBin && typeof (bin as { tsc?: unknown })?.tsc === "string") {
		fs.mkdirSync(path.dirname(aliasBin), { recursive: true });
		fs.writeFileSync(aliasBin, "#!/usr/bin/env node\n");
	}
	return aliasBin;
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
		launchViaNode.mockReset();
		launchViaNode.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeTempDirSync(dir);
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

	it("refuses the classic wrapper without a compiler when TypeScript 7 has no local tsc binary", async () => {
		const root = makeProject("7.0.2");
		addClassicWrapper(root);
		const previousCwd = process.cwd();
		process.chdir(root);
		try {
			const result = await TypeScriptServer.spawn(root, {
				allowInstall: false,
			});

			expect(launchLSP).not.toHaveBeenCalled();
			expect(ensureTool).toHaveBeenCalledWith("typescript", {
				allowInstall: false,
			});
			expect(result).toBeUndefined();
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
		addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
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
		addClassicServer(packageRoot);

		const result = await TypeScriptServer.spawn(packageRoot, {
			allowInstall: false,
		});

		// #4299: broken metadata cannot authorize an implicit classic fallback,
		// and the nearer install still shadows the ancestor native compiler.
		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});
});

describe("TypeScript 7 under the @typescript/native alias (#5504)", () => {
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
		launchViaNode.mockReset();
		launchViaNode.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});

	it("launches the alias's own bin/tsc with Node beside a TypeScript 6", async () => {
		const root = makeProject("6.0.3");
		addNativeTsc(root); // the `.bin/tsc` link that may point at TypeScript 6
		const aliasBin = addNativeAlias(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchViaNode).toHaveBeenCalledTimes(1);
		expect(launchViaNode).toHaveBeenCalledWith(aliasBin, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(launchLSP).not.toHaveBeenCalled();
		expect(result).toEqual({
			process: fakeProcess,
			source: "direct",
			launchVariant: "native-ts7",
			initializeFallback: expect.any(Function),
		});
	});

	// RECURRENCE GUARDED: #5522 review F2. An alias that cannot start used to
	// cost the project the classic server master ran. The launcher is doubled
	// here; the real child cells are in effect-tsgo-initialize-fallback-5504.
	it("launches the classic server when the alias launch throws", async () => {
		const root = makeProject("6.0.3");
		const { lspPath } = addClassicServer(root);
		addNativeAlias(root);
		launchViaNode.mockRejectedValue(new Error("alias exited"));

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledTimes(1);
		expect(launchLSP.mock.calls[0]?.[0]).toBe(lspPath);
		expect(result?.launchVariant).toBe("classic");
	});

	it("rethrows the alias launch failure when no classic server exists", async () => {
		const root = makeProject("6.0.3");
		addNativeAlias(root);
		launchViaNode.mockRejectedValue(new Error("alias exited"));

		await expect(
			TypeScriptServer.spawn(root, { allowInstall: false }),
		).rejects.toThrow("alias exited");
		expect(launchLSP).not.toHaveBeenCalled();
	});

	it("hands the registry a classic initialize fallback, or nothing without one", async () => {
		const withClassic = makeProject("6.0.3");
		const { lspPath } = addClassicServer(withClassic);
		addNativeAlias(withClassic);
		const without = makeProject("6.0.3");
		addNativeAlias(without);

		const first = await TypeScriptServer.spawn(withClassic, {
			allowInstall: false,
		});
		const second = await TypeScriptServer.spawn(without, {
			allowInstall: false,
		});

		expect(launchLSP).not.toHaveBeenCalled();
		expect(
			(await first?.initializeFallback?.(new Error("x")))?.launchVariant,
		).toBe("classic");
		expect(launchLSP.mock.calls[0]?.[0]).toBe(lspPath);
		expect(await second?.initializeFallback?.(new Error("x"))).toBeUndefined();
		expect(launchLSP).toHaveBeenCalledTimes(1);
	});

	it("keeps TypeScript 7 at node_modules/typescript ahead of an alias", async () => {
		const root = makeProject("7.0.2");
		const command = addNativeTsc(root);
		addNativeAlias(root, { version: "7.1.0" });

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchLSP).toHaveBeenCalledWith(command, ["--lsp", "--stdio"], {
			cwd: root,
			env: { PI_LENS_TEST_TOOLCHAIN: "1" },
		});
		expect(launchViaNode).not.toHaveBeenCalled();
		expect(result?.launchVariant).toBe("native-ts7");
	});

	it.each(["6.0.3", "7.0.2"])(
		"does not let an ancestor alias shadow a nearer TypeScript 6 (ancestor TypeScript %s)",
		async (ancestorVersion) => {
			const workspaceRoot = makeProject(ancestorVersion);
			addNativeAlias(workspaceRoot);
			if (ancestorVersion === "7.0.2") addNativeTsc(workspaceRoot);
			const { packageRoot } = addWorkspacePackage(workspaceRoot);
			addTypeScriptPackage(packageRoot, "6.0.3");
			addClassicServer(packageRoot);

			const result = await TypeScriptServer.spawn(packageRoot, {
				allowInstall: false,
			});

			expect(launchViaNode).not.toHaveBeenCalled();
			expect(result?.launchVariant).toBe("classic");
		},
	);

	// Every row must end on classic with the alias never launched.
	async function expectClassicDespiteAlias(
		opts: Parameters<typeof addNativeAlias>[1],
	): Promise<void> {
		const root = makeProject("6.0.3");
		addClassicServer(root);
		addNativeAlias(root, opts);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchViaNode).not.toHaveBeenCalled();
		expect(result?.launchVariant).toBe("classic");
	}

	it("stays on classic for an alias named @typescript/native-preview", () =>
		expectClassicDespiteAlias({ name: "@typescript/native-preview" }));

	it("stays on classic for an alias at version 6.0.3", () =>
		expectClassicDespiteAlias({ version: "6.0.3" }));

	it("stays on classic for an alias at version latest", () =>
		expectClassicDespiteAlias({ version: "latest" }));

	it("stays on classic for a string bin", () =>
		expectClassicDespiteAlias({ bin: "./bin/tsc" }));

	it("stays on classic for a bin without tsc", () =>
		expectClassicDespiteAlias({ bin: { tsgo: "./bin/tsgo" } }));

	it("stays on classic for a manifest with no bin", () =>
		expectClassicDespiteAlias({ bin: undefined }));

	it("stays on classic for a null bin", () =>
		expectClassicDespiteAlias({ bin: null }));

	it("stays on classic for a manifest whose bin file is missing", () =>
		expectClassicDespiteAlias({ writeBin: false }));

	// RECURRENCE GUARDED: #5522 Qodo Q1. `access()` accepts a directory, so a
	// manifest whose `bin.tsc` names one launched Node on it and dropped the
	// classic server the project ran before the alias check existed.
	it("stays on classic for a bin.tsc that is a directory", async () => {
		const root = makeProject("6.0.3");
		addClassicServer(root);
		const aliasBin = addNativeAlias(root, { writeBin: false });
		fs.mkdirSync(aliasBin, { recursive: true });

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchViaNode).not.toHaveBeenCalled();
		expect(result?.launchVariant).toBe("classic");
	});

	it("stays on classic for a malformed manifest", () =>
		expectClassicDespiteAlias({ manifestText: "{" }));

	it("stays on classic for a null manifest", () =>
		expectClassicDespiteAlias({ manifestText: "null" }));

	it("stays on classic for an empty bin.tsc", () =>
		expectClassicDespiteAlias({ bin: { tsc: "" } }));

	it("keeps an unparsable TypeScript version on classic", async () => {
		const root = makeProject("latest");
		addNativeTsc(root);
		addNativeAlias(root);
		addClassicServer(root);

		const result = await TypeScriptServer.spawn(root, { allowInstall: false });

		expect(launchViaNode).not.toHaveBeenCalled();
		expect(result?.launchVariant).toBe("classic");
	});

	it("launches the alias with Node on Windows, never the .bin/tsc.cmd shim", async () => {
		const original = process.platform;
		setPlatform("win32");
		try {
			const root = makeProject("6.0.3");
			const binDir = path.join(root, "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(binDir, "tsc.cmd"), "");
			const aliasBin = addNativeAlias(root);

			const result = await TypeScriptServer.spawn(root, {
				allowInstall: false,
			});

			expect(launchViaNode).toHaveBeenCalledWith(
				aliasBin,
				["--lsp", "--stdio"],
				{ cwd: root, env: { PI_LENS_TEST_TOOLCHAIN: "1" } },
			);
			expect(launchLSP).not.toHaveBeenCalled();
			expect(result?.launchVariant).toBe("native-ts7");
		} finally {
			setPlatform(original);
		}
	});
});

describe("TypeScript LSP ancestor walks stop at a linked home (#4911)", () => {
	// RECURRENCE GUARDED: #4911. Both ancestor walks keep the caller's spelling
	// (a returned binary is classified where it is spelled) and compared that
	// spelling with the spelled HOME, so a HOME or a root spelled through a link
	// climbed into the home and launched the home's TypeScript. Both directions,
	// each with a real directory link and the real `os.homedir()` read.
	beforeEach(() => {
		ensureTool.mockReset();
		ensureTool.mockResolvedValue(undefined);
		launchLSP.mockReset();
		launchLSP.mockResolvedValue(fakeProcess);
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	});

	const cells = (["native", "classic"] as const).flatMap((walk) =>
		(["home-link", "root-link"] as const).map((kind) => [walk, kind] as const),
	);

	it.each(cells)(
		"the %s walk does not launch the home's server when the %s spelling names the home",
		async (walk, kind) => {
			const pin = pinFixtureHome("ts-native-4911");
			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4911-"));
			dirs.push(scratch);
			try {
				if (walk === "native") {
					addTypeScriptPackage(pin.home, "7.0.2");
					addNativeTsc(pin.home);
				} else {
					// A TypeScript 6 package beside the wrapper: the native walk reads
					// it and steps aside, so only the classic walk can reach the home.
					addTypeScriptPackage(pin.home, "6.0.3");
					addClassicServer(pin.home);
				}
				fs.mkdirSync(path.join(pin.home, "proj"), { recursive: true });
				const link = path.join(scratch, "link");
				fs.symlinkSync(pin.home, link, "junction");
				if (kind === "home-link") {
					vi.stubEnv("HOME", link);
					vi.stubEnv("USERPROFILE", link);
				}
				const root = path.join(kind === "root-link" ? link : pin.home, "proj");

				await TypeScriptServer.spawn(root, { allowInstall: false });

				expect(launchLSP).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllEnvs();
				pin.restore();
			}
		},
	);
});
