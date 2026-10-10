/**
 * #4296: the classic TypeScript wrapper forks the file named by `TSSERVER_PATH`
 * and `initialization.tsserver.path`. `findTsserverPath` used to prefer the
 * project's own `node_modules/typescript/lib/tsserver.js` under EVERY trust
 * state, so a cloned repository could ship arbitrary code that pi-lens forked
 * under `unknown` trust (the launcher-only #4268 gate classifies the wrapper,
 * never this argument). `TinymistServer` likewise ran a project's Typst
 * `plugin()` wasm under `unknown`.
 *
 * Real seams only: `setProjectTrustState`/`resetProjectTrust` (the host trust
 * seam) and the production `TypeScriptServer.spawn` / `LSPService`. The child
 * launcher (`clients/lsp/launch.js`) is doubled so the selected `TSSERVER_PATH`
 * can be executed as a tiny marker script instead of a real language server —
 * the double models the wrapper's fork and nothing here claims the real
 * binaries speak the protocol.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const requireFixture = createRequire(import.meta.url);

const launchLSPMock = vi.hoisted(() => vi.fn());
const ensureToolMock = vi.hoisted(() => vi.fn());
const getToolEnvironmentMock = vi.hoisted(() => vi.fn(async () => ({})));
const logExtensionMock = vi.hoisted(() => vi.fn());
const getServersForFileWithConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP: launchLSPMock,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: ensureToolMock,
	getToolEnvironment: getToolEnvironmentMock,
}));
vi.mock("../../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/extension-log.js")
	>()),
	logExtension: logExtensionMock,
}));
vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig: getServersForFileWithConfigMock,
	getServerInitOverride: () => undefined,
}));

const dirs: string[] = [];
const originalCwd = process.cwd();

/** A JS one-liner the doubled launcher executes, proving which
 * `TSSERVER_PATH` the production spawn handed to the wrapper. */
function markerScript(markerPath: string, label: string): string {
	return `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(label)});\n`;
}

interface TsTree {
	readonly tmp: string;
	readonly root: string;
	readonly subdir: string;
	readonly managedWrapper: string;
	readonly managedTsserver: string;
	readonly hostileTsserver: string;
	readonly hostileMarker: string;
	readonly managedMarker: string;
}

/** A project carrying a hostile tsserver.js plus a pi-lens-managed install
 * (the vector-1 shape: no project-local typescript-language-server wrapper). */
function buildTsTree(label: string, hostileInSubdir = false): TsTree {
	const tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-ts-trust-${label}-`),
	);
	dirs.push(tmp);
	const root = path.join(tmp, "project");
	const subdir = path.join(root, "sub");
	fs.mkdirSync(subdir, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

	const hostileMarker = path.join(tmp, `${label}-hostile.marker`);
	const hostileDir = hostileInSubdir
		? path.join(subdir, "node_modules", "typescript", "lib")
		: path.join(root, "node_modules", "typescript", "lib");
	fs.mkdirSync(hostileDir, { recursive: true });
	const hostileTsserver = path.join(hostileDir, "tsserver.js");
	fs.writeFileSync(hostileTsserver, markerScript(hostileMarker, "hostile"));
	fs.writeFileSync(
		path.join(path.dirname(path.dirname(hostileDir)), "package.json"),
		`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
	);

	const managed = path.join(tmp, "managed");
	const binDir = path.join(managed, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const managedWrapper = path.join(binDir, "typescript-language-server");
	fs.writeFileSync(managedWrapper, "#!/usr/bin/env node\n");
	const tsc = path.join(binDir, "tsc");
	fs.writeFileSync(tsc, "#!/usr/bin/env node\n");
	const managedTs = path.join(managed, "node_modules", "typescript");
	fs.mkdirSync(path.join(managedTs, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(managedTs, "package.json"),
		`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
	);
	const managedTsserver = path.join(managedTs, "lib", "tsserver.js");
	const managedMarker = path.join(tmp, `${label}-managed.marker`);
	fs.writeFileSync(managedTsserver, markerScript(managedMarker, "managed"));

	ensureToolMock.mockImplementation(async (toolId: string) => {
		if (toolId === "typescript-language-server") return managedWrapper;
		if (toolId === "typescript") return tsc;
		return undefined;
	});

	return {
		tmp,
		root,
		subdir,
		managedWrapper,
		managedTsserver,
		hostileTsserver,
		hostileMarker,
		managedMarker,
	};
}

function tsserverPathOf(
	spawned: Awaited<
		ReturnType<
			typeof import("../../../clients/lsp/server.js").TypeScriptServer.spawn
		>
	>,
): string | undefined {
	return (
		spawned?.initialization as { tsserver?: { path?: string } } | undefined
	)?.tsserver?.path;
}

beforeEach(() => {
	launchLSPMock.mockReset();
	ensureToolMock.mockReset();
	getToolEnvironmentMock.mockClear();
	logExtensionMock.mockClear();
	getServersForFileWithConfigMock.mockReset();
	// Model the classic wrapper's fork: execute the selected TSSERVER_PATH so the
	// marker file records which file pi-lens handed over. The fixture is a
	// CommonJS script, so the double loads it in-process; a real language-server
	// child belongs in the lsp-spawn-heavy lane.
	launchLSPMock.mockImplementation(async (_command, _args, options) => {
		const tsserver = (
			options as { env?: Record<string, string | undefined> } | undefined
		)?.env?.TSSERVER_PATH;
		if (tsserver) requireFixture(tsserver);
		return {
			process: { killed: false },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 4242,
		} as never;
	});
});

afterEach(async () => {
	process.chdir(originalCwd);
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	const trust = await import("../../../clients/project-trust.js");
	trust.resetProjectTrust();
});

describe("project tsserver.js trust gate (#4296)", () => {
	it("runs pi-lens-managed TypeScript, never the project's tsserver.js, under unknown trust", async () => {
		const tree = buildTsTree("unknown");
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("unknown");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).toBe(tree.managedTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
		expect(fs.existsSync(tree.managedMarker)).toBe(true);
		expect(logExtensionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"project-local LSP binary refused: mark the project trusted in pi or upgrade pi",
			}),
		);
		expect(
			ledger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "lsp-registry-decision"),
		).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("runs the project's tsserver.js under trusted trust", async () => {
		const tree = buildTsTree("trusted");
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).toBe(tree.hostileTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(true);
	});

	it("skips the project's tsserver.js under untrusted trust", async () => {
		const tree = buildTsTree("untrusted");
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("untrusted");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).toBe(tree.managedTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
	});

	it("skips a process.cwd() tsserver.js that lies inside the project under unknown trust", async () => {
		const tree = buildTsTree("cwd", true);
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("unknown");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		// The ancestor walk starts at `root` and never sees `root/sub`; only the
		// process.cwd() candidate can reach the hostile tsserver there.
		process.chdir(tree.subdir);
		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).toBe(tree.managedTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
	});

	it("skips a project-local wrapper's relative tsserver.js when no managed TypeScript is available", async () => {
		const tree = buildTsTree("local-wrapper");
		const binDir = path.join(tree.root, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const localWrapper = path.join(binDir, "typescript-language-server");
		fs.writeFileSync(localWrapper, "#!/usr/bin/env node\n");
		// No discoverable managed compiler: only the wrapper-relative candidate
		// could supply a tsserver.js.
		ensureToolMock.mockImplementation(async (toolId: string) =>
			toolId === "typescript-language-server" ? localWrapper : undefined,
		);
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("unknown");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).toBeUndefined();
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
	});
});

describe("tinymist project-code trust census (#4296)", () => {
	it("refuses the project-code tinymist server under unknown trust", async () => {
		const { TinymistServer } = await import("../../../clients/lsp/server.js");
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-tinymist-trust-"),
		);
		dirs.push(tmp);
		fs.writeFileSync(path.join(tmp, "typst.toml"), '[package]\nname = "x"\n');
		const file = path.join(tmp, "main.typ");
		fs.writeFileSync(file, "#let x = 1\n");

		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("unknown");
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		getServersForFileWithConfigMock.mockReturnValue([TinymistServer]);
		const spawnSpy = vi.spyOn(TinymistServer, "spawn");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const client = await service.getClientForFile(file);

		expect(client).toBeUndefined();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(launchLSPMock).not.toHaveBeenCalled();
		expect(logExtensionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"project-code LSP server refused: mark the project trusted in pi or upgrade pi",
			}),
		);
		expect(
			ledger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "lsp-registry-decision"),
		).toEqual([expect.objectContaining({ count: 1 })]);
		spawnSpy.mockRestore();
	});
});
