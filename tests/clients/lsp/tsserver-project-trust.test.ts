/**
 * #4296: the classic TypeScript wrapper forks the compiler named by
 * `initialization.tsserver.path`, which pi-lens supplies. pi-lens also sets the
 * legacy `TSSERVER_PATH` environment variable, but the installed 5.3.0 wrapper
 * reads only the initialization option. `findTsserverPath` used to prefer the
 * project's own `node_modules/typescript/lib/tsserver.js` under EVERY trust
 * state, so a cloned repository could ship arbitrary code that pi-lens forked
 * under `unknown` trust (the launcher-only #4268 gate classifies the wrapper,
 * never this argument). `TinymistServer` likewise ran a project's Typst
 * `plugin()` wasm under `unknown`.
 *
 * Real seams only: `setProjectTrustState`/`resetProjectTrust` (the host trust
 * seam) and the production `TypeScriptServer.spawn` / `LSPService`. The child
 * launcher (`clients/lsp/launch.js`) is doubled so the selected compiler can be
 * executed as a tiny marker script instead of a real language server — the
 * double reads the launch-time `TSSERVER_PATH` that pi-lens sets to the same
 * admitted path the real wrapper receives as `initialization.tsserver.path`, and
 * nothing here claims the real binaries speak the protocol.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { truncateForLedger } from "../../../clients/ledger-bounds.js";
import { removeTempDirSync } from "../test-utils.js";

const requireFixture = createRequire(import.meta.url);

const launchLSPMock = vi.hoisted(() => vi.fn());
const ensureToolMock = vi.hoisted(() => vi.fn());
const getToolEnvironmentMock = vi.hoisted(() => vi.fn(async () => ({})));
const logExtensionMock = vi.hoisted(() => vi.fn());

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

const dirs: string[] = [];
const originalCwd = process.cwd();

/** A JS one-liner the doubled launcher executes, proving which admitted
 * compiler the production spawn handed to the wrapper. */
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
		path.join(path.dirname(hostileDir), "package.json"),
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
	// Model the classic wrapper's fork: execute the admitted path pi-lens put on
	// the launch environment. The installed 5.3.0 wrapper actually resolves its
	// child from `initialization.tsserver.path`; `tsserverPathOf` asserts that
	// returned option, and production sets both from the same admitted path. The
	// fixture is a CommonJS script, so the double loads it in-process; a real
	// language-server child belongs in the lsp-spawn-heavy lane.
	launchLSPMock.mockImplementation(async (_command, _args, options) => {
		let tsserver = (
			options as { env?: Record<string, string | undefined> } | undefined
		)?.env?.TSSERVER_PATH;
		// #4299 F3: match the real wrapper's workspace fallback when unset.
		if (!tsserver) {
			const workspace = path.join(
				options.cwd,
				"node_modules",
				"typescript",
				"lib",
				"tsserver.js",
			);
			if (fs.existsSync(workspace)) tsserver = workspace;
		}
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
		const { withLspProjectCodePermission } =
			await import("../../../clients/lsp/launch.js");

		// LSPService wraps every spawn in a permission scope; outside one the
		// default denies project code (#4296 R3-F1), so drive the session-root case.
		const spawned = await withLspProjectCodePermission(true, () =>
			TypeScriptServer.spawn(tree.root, { allowInstall: false }),
		);

		expect(tsserverPathOf(spawned)).toBe(tree.hostileTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(true);
	});

	// Guards #4296 R3-F1: the permission store once defaulted to allow outside a
	// spawn scope, so any future spawn path that missed the scope ran project code.
	it("does not run the project's tsserver.js outside a spawn scope, even under trusted trust", async () => {
		const tree = buildTsTree("trusted");
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");

		const spawned = await TypeScriptServer.spawn(tree.root, {
			allowInstall: false,
		});

		expect(tsserverPathOf(spawned)).not.toBe(tree.hostileTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
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

	it("skips malformed project metadata and keeps the managed compiler fallback (#4299)", async () => {
		const tree = buildTsTree("malformed-project");
		fs.writeFileSync(
			path.join(path.dirname(tree.hostileTsserver), "..", "package.json"),
			"{",
		);
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		process.chdir(tree.root);
		expect(
			tsserverPathOf(
				await TypeScriptServer.spawn(tree.root, { allowInstall: false }),
			),
		).toBe(tree.managedTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
		expect(fs.existsSync(tree.managedMarker)).toBe(true);
	});

	it("still uses the managed compiler when the optional session root no longer exists", async () => {
		const tree = buildTsTree("missing-session");
		const { setProjectTrustState } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("unknown");
		const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
		process.chdir(tree.root);
		expect(
			tsserverPathOf(
				await TypeScriptServer.spawn(tree.root, {
					allowInstall: false,
					sessionRoot: path.join(tree.tmp, "retired-session"),
				}),
			),
		).toBe(tree.managedTsserver);
		expect(fs.existsSync(tree.hostileMarker)).toBe(false);
		expect(fs.existsSync(tree.managedMarker)).toBe(true);
	});

	it.for([
		"empty version",
		"numeric version",
		"malformed JSON",
		"missing manifest",
		"directory",
		"renamed target",
	])(
		"refuses a managed compiler with %s before the wrapper can fall through (#4299)",
		async (kind, context) => {
			const tree = buildTsTree("invalid");
			const manifest = path.join(
				path.dirname(tree.managedTsserver),
				"..",
				"package.json",
			);
			if (kind === "missing manifest") fs.unlinkSync(manifest);
			else if (kind === "renamed target") {
				const renamed = path.join(
					path.dirname(tree.managedTsserver),
					"compiler.js",
				);
				fs.renameSync(tree.managedTsserver, renamed);
				try {
					fs.symlinkSync(renamed, tree.managedTsserver);
				} catch (error) {
					context.skip(
						`filesystem cannot create a renamed compiler link: ${String(error)}`,
					);
				}
			} else if (kind === "directory") {
				fs.unlinkSync(tree.managedTsserver);
				fs.mkdirSync(tree.managedTsserver);
			} else
				fs.writeFileSync(
					manifest,
					kind === "malformed JSON"
						? "{"
						: JSON.stringify({ version: kind === "numeric version" ? 5 : "" }),
				);
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("unknown");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");
			process.chdir(tree.root);
			expect(
				await TypeScriptServer.spawn(tree.root, { allowInstall: false }),
			).toBeUndefined();
			expect(launchLSPMock).not.toHaveBeenCalled();
			expect(fs.existsSync(tree.hostileMarker)).toBe(false);
		},
	);

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

		expect(spawned).toBeUndefined();
		expect(launchLSPMock).not.toHaveBeenCalled();
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

/**
 * #4414: `ensureTool("typescript")` returns the bare command name `tsc` for a
 * PATH hit. `findTsserverPath` needs an absolute path to locate
 * `lib/tsserver.js`, so a trusted project with only a PATH compiler never got a
 * TypeScript server, and the miss was logged as "project-local LSP binary
 * refused: mark the project trusted in pi or upgrade pi" while trust was fine.
 *
 * Real seams: `setProjectTrustState` (the host trust seam), the production
 * `TypeScriptServer.spawn`, and the production PATH lookup (`process.env.PATH`
 * pointed at a temp bin dir holding a `tsc` symlink laid out like an
 * npm-global install). Only the child launcher, `ensureTool` (returns the bare
 * string the installer returns for a PATH hit, the contract documented at
 * `typescriptVersionForTsc`) and `logExtension` are doubled.
 */
const originalPath = process.env.PATH;

const TRUST_WORDING = /mark the project trusted/;

interface PathTscTree {
	readonly project: string;
	readonly pathBin: string;
	readonly tsserver: string;
}

/** An npm-global style compiler: `<root>/bin/tsc` symlinks into
 * `<root>/lib/node_modules/typescript/bin/tsc`. `withTsserver: false` models a
 * compiler whose package ships no classic `lib/tsserver.js` (TypeScript 7). */
function buildPathTscTree(
	label: string,
	withTsserver = true,
	version = "5.9.3",
): PathTscTree {
	const tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-bare-tsc-${label}-`),
	);
	dirs.push(tmp);
	const project = path.join(tmp, "project");
	fs.mkdirSync(path.join(project, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(path.join(project, "package.json"), "{}\n");
	fs.writeFileSync(path.join(project, "tsconfig.json"), "{}\n");
	const wrapper = path.join(
		project,
		"node_modules",
		".bin",
		"typescript-language-server",
	);
	fs.writeFileSync(wrapper, "#!/usr/bin/env node\n");

	const globalRoot = path.join(tmp, "global");
	const pkg = path.join(globalRoot, "lib", "node_modules", "typescript");
	fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
	fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
	fs.writeFileSync(
		path.join(pkg, "package.json"),
		`${JSON.stringify({ name: "typescript", version })}\n`,
	);
	fs.writeFileSync(path.join(pkg, "bin", "tsc"), "#!/usr/bin/env node\n");
	// `which` only reports executables, like a real installed compiler.
	fs.chmodSync(path.join(pkg, "bin", "tsc"), 0o755);
	const tsserver = path.join(pkg, "lib", "tsserver.js");
	if (withTsserver) fs.writeFileSync(tsserver, "// tsserver\n");
	const pathBin = path.join(globalRoot, "bin");
	fs.mkdirSync(pathBin, { recursive: true });
	fs.symlinkSync(
		path.join("..", "lib", "node_modules", "typescript", "bin", "tsc"),
		path.join(pathBin, "tsc"),
	);

	ensureToolMock.mockImplementation(async (toolId: string) => {
		if (toolId === "typescript-language-server") return wrapper;
		if (toolId === "typescript") return "tsc";
		return undefined;
	});
	return {
		project,
		pathBin,
		tsserver: path.join(fs.realpathSync(pkg), "lib", "tsserver.js"),
	};
}

function warnMessages(): string[] {
	return logExtensionMock.mock.calls
		.map(([entry]) => entry as { level?: string; message: string })
		.filter((entry) => entry.level === "warn")
		.map((entry) => entry.message);
}

/** A pinned classic compiler the managed repair would install. */
function mockManagedClassicRepair(tree: PathTscTree): { tsserver: string } {
	const managed = path.join(path.dirname(tree.project), "managed");
	const managedPkg = path.join(managed, "node_modules", "typescript");
	fs.mkdirSync(path.join(managedPkg, "lib"), { recursive: true });
	fs.mkdirSync(path.join(managed, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(
		path.join(managedPkg, "package.json"),
		`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
	);
	fs.writeFileSync(path.join(managedPkg, "lib", "tsserver.js"), "// classic\n");
	const managedTsc = path.join(managed, "node_modules", ".bin", "tsc");
	fs.writeFileSync(managedTsc, "#!/usr/bin/env node\n");
	const wrapper = path.join(
		tree.project,
		"node_modules",
		".bin",
		"typescript-language-server",
	);
	ensureToolMock.mockImplementation(
		async (toolId: string, options?: { forceReinstall?: boolean }) => {
			if (toolId === "typescript-language-server") return wrapper;
			if (toolId !== "typescript") return undefined;
			return options?.forceReinstall ? managedTsc : "tsc";
		},
	);
	return {
		tsserver: fs.realpathSync(path.join(managedPkg, "lib", "tsserver.js")),
	};
}

function forceReinstallCalls() {
	return ensureToolMock.mock.calls.filter(
		(call) => call[1]?.forceReinstall === true,
	);
}

async function spawnTrusted(project: string, allowInstall: boolean) {
	const { setProjectTrustState } =
		await import("../../../clients/project-trust.js");
	setProjectTrustState("trusted");
	const { TypeScriptServer } = await import("../../../clients/lsp/server.js");
	return TypeScriptServer.spawn(project, { allowInstall });
}

// POSIX layout: a symlinked `bin/tsc` found by `which`; Windows resolves `.cmd`
// shims through `where`, a different shape this fixture does not model.
describe.skipIf(process.platform === "win32")(
	"bare tsc PATH hit reaches the TypeScript server (#4414)",
	() => {
		beforeEach(async () => {
			const { _resetClassicTsRepairForTests } =
				await import("../../../clients/lsp/server.js");
			_resetClassicTsRepairForTests();
			const ledger = await import("../../../clients/degradation-ledger.js");
			ledger.resetDegradationLedger();
		});
		afterEach(() => {
			process.env.PATH = originalPath;
		});

		it("starts the classic server from the tsserver.js beside a PATH tsc in a trusted project", async () => {
			const tree = buildPathTscTree("trusted");
			process.chdir(tree.project);
			process.env.PATH = `${tree.pathBin}${path.delimiter}${originalPath ?? ""}`;
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});

			expect(tsserverPathOf(spawned)).toBe(tree.tsserver);
			expect(launchLSPMock).toHaveBeenCalledTimes(1);
			expect(warnMessages()).toEqual([]);
		});

		it("names the missing compiler, not trust, when tsc is on no PATH entry", async () => {
			const tree = buildPathTscTree("missing");
			process.chdir(tree.project);
			// tsc stays unresolvable: the fixture bin dir is deliberately not on PATH.
			process.env.PATH = path.join(os.tmpdir(), "pi-lens-no-such-bin");
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const ledger = await import("../../../clients/degradation-ledger.js");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});
			// A spawn for another root in the same generation records its own
			// ledger subject but must not repeat the warn.
			const nested = path.join(tree.project, "sub");
			fs.mkdirSync(nested);
			await TypeScriptServer.spawn(nested, { allowInstall: false });

			expect(spawned).toBeUndefined();
			expect(launchLSPMock).not.toHaveBeenCalled();
			const warns = warnMessages();
			expect(warns).toHaveLength(1);
			expect(warns[0]).toMatch(/no absolute TypeScript compiler/);
			expect(warns[0]).not.toMatch(TRUST_WORDING);
			const rows = ledger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "lsp-registry-decision");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.count).toBe(2);
			expect(rows[0]?.latestReasons[0]?.reason).toMatch(
				/no absolute TypeScript compiler/,
			);
			expect(rows[0]?.latestReasons[0]?.subject).toMatch(
				/^typescript-compiler:/,
			);
		});

		it("names the compiler, not trust, when the PATH tsc ships no tsserver.js", async () => {
			const tree = buildPathTscTree("no-tsserver", false);
			process.chdir(tree.project);
			process.env.PATH = `${tree.pathBin}${path.delimiter}${originalPath ?? ""}`;
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});

			expect(spawned).toBeUndefined();
			const warns = warnMessages();
			expect(warns).toHaveLength(1);
			expect(warns[0]).not.toMatch(TRUST_WORDING);
		});

		// A PATH `tsc` that is TypeScript 7 ships no tsserver.js. Before #4414 the
		// bare name hid its version, so no repair ran and the server never started;
		// it now follows the same repair as an absolute hit.
		it("repairs to the pinned classic compiler when the PATH tsc is TypeScript 7", async () => {
			const tree = buildPathTscTree("ts7", false, "7.0.2");
			process.chdir(tree.project);
			process.env.PATH = `${tree.pathBin}${path.delimiter}${originalPath ?? ""}`;
			const managed = mockManagedClassicRepair(tree);
			const spawned = await spawnTrusted(tree.project, true);

			expect(forceReinstallCalls()).toHaveLength(1);
			expect(tsserverPathOf(spawned)).toBe(managed.tsserver);
		});

		// #4414 F2: volta, asdf, mise and pnpm-global put a shim on PATH, not a
		// symlink into the package. The resolved file has no TypeScript package
		// beside it, which is the same as no compiler: take the managed install.
		it("takes the consent-gated managed install when the PATH tsc is a shim with no package beside it", async () => {
			const tree = buildPathTscTree("shim");
			process.chdir(tree.project);
			const shimBin = path.join(path.dirname(tree.project), "shim-bin");
			fs.mkdirSync(shimBin);
			fs.writeFileSync(path.join(shimBin, "tsc"), "#!/bin/sh\nexit 0\n");
			fs.chmodSync(path.join(shimBin, "tsc"), 0o755);
			process.env.PATH = `${shimBin}${path.delimiter}${originalPath ?? ""}`;
			const managed = mockManagedClassicRepair(tree);
			const spawned = await spawnTrusted(tree.project, true);

			expect(forceReinstallCalls()).toHaveLength(1);
			expect(tsserverPathOf(spawned)).toBe(managed.tsserver);
		});

		it("never installs for a PATH shim when installs are not allowed", async () => {
			const tree = buildPathTscTree("shim-noinstall");
			process.chdir(tree.project);
			const shimBin = path.join(path.dirname(tree.project), "shim-bin");
			fs.mkdirSync(shimBin);
			fs.writeFileSync(path.join(shimBin, "tsc"), "#!/bin/sh\nexit 0\n");
			fs.chmodSync(path.join(shimBin, "tsc"), 0o755);
			process.env.PATH = `${shimBin}${path.delimiter}${originalPath ?? ""}`;
			mockManagedClassicRepair(tree);
			const spawned = await spawnTrusted(tree.project, false);

			expect(spawned).toBeUndefined();
			expect(forceReinstallCalls()).toHaveLength(0);
			expect(warnMessages()).toHaveLength(1);
		});

		// #4390 shape: a TypeScript package whose manifest cannot be read must not
		// trigger a forced reinstall over a healthy global compiler.
		it("never repairs a PATH tsc whose TypeScript package has an unreadable version", async () => {
			const tree = buildPathTscTree("no-manifest", false);
			const pkg = path.join(
				path.dirname(path.dirname(tree.pathBin)),
				"global",
				"lib",
				"node_modules",
				"typescript",
			);
			fs.rmSync(path.join(pkg, "package.json"), { force: true });
			process.chdir(tree.project);
			process.env.PATH = `${tree.pathBin}${path.delimiter}${originalPath ?? ""}`;
			mockManagedClassicRepair(tree);
			const spawned = await spawnTrusted(tree.project, true);

			expect(spawned).toBeUndefined();
			expect(forceReinstallCalls()).toHaveLength(0);
		});

		// #4414 F3: the Windows npm-global layout puts the package under
		// `<prefix>/node_modules/typescript` beside `tsc.cmd`. Driven with an
		// absolute answer so it runs on every OS.
		it("finds tsserver.js in the npm-global layout beside the compiler", async () => {
			const tree = buildPathTscTree("npm-prefix", false);
			process.chdir(tree.project);
			const prefix = path.join(path.dirname(tree.project), "prefix");
			const pkg = path.join(prefix, "node_modules", "typescript");
			fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
			fs.writeFileSync(
				path.join(pkg, "package.json"),
				`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
			);
			fs.writeFileSync(path.join(pkg, "lib", "tsserver.js"), "// classic\n");
			fs.writeFileSync(path.join(prefix, "tsc"), "#!/bin/sh\n");
			const wrapper = path.join(
				tree.project,
				"node_modules",
				".bin",
				"typescript-language-server",
			);
			ensureToolMock.mockImplementation(async (toolId: string) =>
				toolId === "typescript-language-server"
					? wrapper
					: path.join(prefix, "tsc"),
			);
			const spawned = await spawnTrusted(tree.project, false);

			expect(tsserverPathOf(spawned)).toBe(
				fs.realpathSync(path.join(pkg, "lib", "tsserver.js")),
			);
		});

		it("leaves a healthy PATH TypeScript 5 alone when it ships no tsserver.js", async () => {
			const tree = buildPathTscTree("ts5-no-tsserver", false);
			process.chdir(tree.project);
			process.env.PATH = `${tree.pathBin}${path.delimiter}${originalPath ?? ""}`;
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: true,
			});

			expect(spawned).toBeUndefined();
			expect(
				ensureToolMock.mock.calls.filter(
					(call) => call[1]?.forceReinstall === true,
				),
			).toHaveLength(0);
		});

		it("takes an absolute ensureTool answer as is, without a PATH lookup", async () => {
			const tree = buildPathTscTree("absolute");
			process.chdir(tree.project);
			// An unreachable PATH makes any `which` spawn fail: the production
			// (managed, absolute) answer must not depend on one.
			process.env.PATH = path.join(os.tmpdir(), "pi-lens-no-such-bin");
			ensureToolMock.mockImplementation(async (toolId: string) =>
				toolId === "typescript-language-server"
					? path.join(
							tree.project,
							"node_modules",
							".bin",
							"typescript-language-server",
						)
					: path.join(path.dirname(tree.tsserver), "..", "bin", "tsc"),
			);
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});

			expect(tsserverPathOf(spawned)).toBe(tree.tsserver);
		});

		// #4776 review F3: the notice was hidden by ANY trust refusal, so a
		// project scripts dir dropped from the search path (no compiler in it,
		// none anywhere) left the user with no word on why TypeScript is off.
		it("names the missing compiler when the only trust refusal is unrelated to TypeScript (unknown trust)", async () => {
			const tree = buildPathTscTree("unrelated-refusal");
			const scripts = path.join(tree.project, "scripts");
			fs.mkdirSync(scripts);
			fs.writeFileSync(path.join(scripts, "build"), "#!/bin/sh\n");
			fs.chmodSync(path.join(scripts, "build"), 0o755);
			process.chdir(tree.project);
			process.env.PATH = `${scripts}${path.delimiter}${path.join(os.tmpdir(), "pi-lens-no-such-bin")}`;
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("unknown");
			const ledger = await import("../../../clients/degradation-ledger.js");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});

			expect(spawned).toBeUndefined();
			// The ledger RETAINS every identity field through `subjectForLedger` →
			// `truncateForLedger` (#1366), so a TMPDIR long enough to push the PATH
			// entry past `LEDGER_FIELD_MAX` stores the bounded form with an ellipsis,
			// and the assertion compares that same bound (#5246).
			expect(
				ledger
					.getDegradationSummary()
					.find((group) => group.kind === "trust-refusal")
					?.latestReasons.map((entry) => entry.subject),
			).toEqual([
				truncateForLedger(`project-path-entry:${fs.realpathSync(scripts)}`),
			]);
			expect(warnMessages()).toContainEqual(
				expect.stringMatching(/no absolute TypeScript compiler/),
			);
		});

		it("still treats a bare tsc that resolves into the project as project code (unknown trust)", async () => {
			const tree = buildPathTscTree("project-bin");
			// A PATH entry inside the project tree must keep its project provenance
			// after the bare name is resolved. The compiler sits outside the
			// `node_modules/typescript` ancestor walk so only the PATH route finds it.
			const projectPkg = path.join(
				tree.project,
				"tools",
				"node_modules",
				"typescript",
			);
			fs.mkdirSync(path.join(projectPkg, "bin"), { recursive: true });
			fs.mkdirSync(path.join(projectPkg, "lib"), { recursive: true });
			fs.mkdirSync(path.join(tree.project, "tools", "bin"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(projectPkg, "package.json"),
				`${JSON.stringify({ name: "typescript", version: "5.9.3" })}\n`,
			);
			fs.writeFileSync(
				path.join(projectPkg, "bin", "tsc"),
				"#!/usr/bin/env node\n",
			);
			fs.chmodSync(path.join(projectPkg, "bin", "tsc"), 0o755);
			fs.writeFileSync(
				path.join(projectPkg, "lib", "tsserver.js"),
				"// project code\n",
			);
			fs.symlinkSync(
				path.join("..", "node_modules", "typescript", "bin", "tsc"),
				path.join(tree.project, "tools", "bin", "tsc"),
			);
			process.chdir(tree.project);
			process.env.PATH = `${path.join(tree.project, "tools", "bin")}${path.delimiter}${originalPath ?? ""}`;
			const { setProjectTrustState } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState("unknown");
			const { TypeScriptServer } =
				await import("../../../clients/lsp/server.js");

			const spawned = await TypeScriptServer.spawn(tree.project, {
				allowInstall: false,
			});

			expect(spawned).toBeUndefined();
			expect(launchLSPMock).not.toHaveBeenCalled();
			// One notice per generation (#4414 F1): the genuine trust refusal is not
			// followed by the "no compiler resolved" notice, which would blame
			// resolution for a compiler pi found and refused.
			// #4530: the project's PATH entry is dropped from the lookup's search
			// path before any answer exists, so the trust notice names that. The
			// notice is once per ENTRY, and the host PATH can carry its own entry
			// that resolves inside this project (husky's relative
			// `node_modules/.bin` against the project cwd), so the kinds are
			// compared, not the count.
			expect([...new Set(warnMessages())]).toEqual([
				"search-path entry inside the project ignored: mark the project trusted in pi or upgrade pi",
			]);
		});
	},
);
