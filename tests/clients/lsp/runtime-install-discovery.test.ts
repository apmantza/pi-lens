import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempDirSync } from "../test-utils.js";

// Drive the candidate-resolution chain without touching disk/toolchains: mock
// the launch primitive (reject-all → we just capture every candidate tried) and
// the installer. With allowInstall:false, resolveAndLaunch never reaches the
// ensureTool/runtimeInstall steps, so no real `go install` / `dotnet tool
// install` can fire from a unit test — we assert the canonical-bin discovery and
// runtime-install WIRING via the candidate list and server shape (#241).
const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
const { getToolPath, onPath } = vi.hoisted(() => ({
	getToolPath: vi.fn(async (): Promise<string | undefined> => undefined),
	onPath: new Set<string>(),
}));
vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	launchViaNode: vi.fn(),
	admitProjectSuppliedTsserver: (tsserverPath: string) => tsserverPath,
}));
// #5410 S5: the PATH answer (`which`, behind clients/safe-spawn) is the process
// boundary; `onPath` stands in for what it reports.
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	isCommandAvailableAsync: async (command: string) => onPath.has(command),
}));
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	// The spread keeps every other installer export real. A host with no java
	// reaches resetPathWalkMemo through toolOnPath's tool-not-found branch, and a
	// partial factory throws on that access (#5595 verify V1).
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: vi.fn(async () => null),
	getToolPath,
	getToolEnvironment: () => ({}),
	findManagedToolBinary: vi.fn(async () => undefined),
}));

import {
	cargoBinCandidates,
	FSharpServer,
	goBinCandidates,
	GoServer,
	JavaServer,
	PowerShellServer,
	PythonServer,
	resolveAndLaunch,
	RustServer,
	TypeScriptServer,
} from "../../../clients/lsp/server.js";
import { ensureTool } from "../../../clients/installer/index.js";

const isWin = process.platform === "win32";
const sep = (...parts: string[]) => path.join(...parts);
const toolNotFound = (message = "not found") =>
	Object.assign(new Error(message), { kind: "tool-not-found" as const });

describe("canonical-bin candidates (#241)", () => {
	const savedGopath = process.env.GOPATH;
	const savedCargo = process.env.CARGO_HOME;
	afterEach(() => {
		if (savedGopath === undefined) delete process.env.GOPATH;
		else process.env.GOPATH = savedGopath;
		if (savedCargo === undefined) delete process.env.CARGO_HOME;
		else process.env.CARGO_HOME = savedCargo;
	});

	it("goBinCandidates: bare command first, then $GOPATH/bin", () => {
		process.env.GOPATH = sep("/custom", "gopath");
		const c = goBinCandidates("gopls");
		expect(c[0]).toBe("gopls"); // PATH stays authoritative
		expect(c).toContain(sep("/custom", "gopath", "bin", "gopls"));
		if (isWin)
			expect(c).toContain(sep("/custom", "gopath", "bin", "gopls.exe"));
	});

	it("goBinCandidates: defaults to ~/go/bin when GOPATH unset", () => {
		delete process.env.GOPATH;
		const c = goBinCandidates("gopls");
		expect(c).toContain(sep(os.homedir(), "go", "bin", "gopls"));
	});

	it("goBinCandidates: uses only the first GOPATH entry", () => {
		process.env.GOPATH = ["/first", "/second"].join(path.delimiter);
		const c = goBinCandidates("gopls");
		expect(c).toContain(sep("/first", "bin", "gopls"));
		expect(c).not.toContain(sep("/second", "bin", "gopls"));
	});

	it("cargoBinCandidates: bare first, then $CARGO_HOME/bin, else ~/.cargo/bin", () => {
		process.env.CARGO_HOME = sep("/custom", "cargo");
		expect(cargoBinCandidates("rust-analyzer")[0]).toBe("rust-analyzer");
		expect(cargoBinCandidates("rust-analyzer")).toContain(
			sep("/custom", "cargo", "bin", "rust-analyzer"),
		);
		delete process.env.CARGO_HOME;
		expect(cargoBinCandidates("rust-analyzer")).toContain(
			sep(os.homedir(), ".cargo", "bin", "rust-analyzer"),
		);
	});
});

describe("runtime-install / discovery server wiring (#241)", () => {
	beforeEach(() => {
		vi.stubEnv("CARGO_HOME", undefined);
		launchLSP.mockReset();
		logLatency.mockReset();
		// Reject every candidate so resolveAndLaunch exhausts the list; we only
		// inspect WHICH commands it tried. allowInstall:false keeps installs off.
		launchLSP.mockRejectedValue(toolNotFound());
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const triedCommands = () => launchLSP.mock.calls.map((c) => String(c[0]));

	it("GoServer spawns trying $GOPATH/bin/gopls (canonical-bin discovery)", async () => {
		process.env.GOPATH = sep("/gp");
		await GoServer.spawn(sep("/tmp", "proj"), { allowInstall: false });
		delete process.env.GOPATH;
		const tried = triedCommands();
		expect(tried).toContain("gopls");
		expect(tried.some((cmd) => cmd === sep("/gp", "bin", "gopls"))).toBe(true);
	});

	it("RustServer spawns trying ~/.cargo/bin/rust-analyzer before the managed download", async () => {
		await RustServer.spawn(sep("/tmp", "proj"), { allowInstall: false });
		const tried = triedCommands();
		expect(tried).toContain("rust-analyzer");
		expect(
			tried.some(
				(cmd) => cmd === sep(os.homedir(), ".cargo", "bin", "rust-analyzer"),
			),
		).toBe(true);
	});

	it("FSharpServer is a dotnet-tool runtime-install server (csharp-ls pattern)", async () => {
		// No createInteractiveServer availabilityKey — it resolves via the full
		// resolveAndLaunch chain (candidates → runtimeInstall), like csharp-ls.
		expect(FSharpServer).not.toHaveProperty("availabilityKey");
		await FSharpServer.spawn(sep("/tmp", "proj"), { allowInstall: false });
		const tried = triedCommands();
		// dotnetToolCandidates: managed bin dir, ~/.dotnet/tools, bare command.
		expect(
			tried.some((cmd) =>
				cmd.endsWith(sep(".dotnet", "tools", "fsautocomplete")),
			),
		).toBe(true);
		expect(tried).toContain("fsautocomplete");
	});

	it("TypeScriptServer discovers a global wrapper with installs disabled but refuses it without a compiler (#4299)", async () => {
		// Regression: with PI_LENS_DISABLE_LSP_INSTALL=1 (allowInstall:false) the old
		// code skipped the ensureTool call entirely, so a globally-installed
		// typescript-language-server (no per-project node_modules) was never found and
		// the server stayed at ready=0/4. ensureTool must still run PATH/npm-global
		// discovery; only the actual download is gated.
		const GLOBAL_TLS = sep("/usr", "bin", "typescript-language-server");
		vi.mocked(ensureTool).mockImplementation(async (id: string) =>
			id === "typescript-language-server" ? GLOBAL_TLS : undefined,
		);
		launchLSP.mockReset();
		launchLSP.mockResolvedValue({ kill: vi.fn() } as never);
		const fs = await import("node:fs");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ts-no-cwd-ts-"));
		const oldCwd = process.cwd();
		process.chdir(tmp);
		try {
			// A root + cwd with no node_modules/.bin/typescript-language-server and no
			// node_modules/typescript, so only ensureTool discovery can resolve either
			// the LSP binary or tsserver.
			const res = await TypeScriptServer.spawn(tmp, { allowInstall: false });
			expect(vi.mocked(ensureTool)).toHaveBeenCalledWith(
				"typescript-language-server",
				{ allowInstall: false },
			);
			expect(vi.mocked(ensureTool)).toHaveBeenCalledWith("typescript", {
				allowInstall: false,
			});
			// #4299: discovery still runs, but an unset compiler hint would let
			// the wrapper execute workspace code. No compiler means no launch.
			expect(launchLSP).not.toHaveBeenCalled();
			expect(res).toBeUndefined();
		} finally {
			process.chdir(oldCwd);
			removeTempDirSync(tmp);
			vi.mocked(ensureTool).mockReset();
			vi.mocked(ensureTool).mockResolvedValue(undefined);
		}
	});

	it("PythonServer discovers global pyright when install is disabled", async () => {
		const globalPyright = sep("/usr", "bin", "pyright");
		const globalPyrightLangserver = sep("/usr", "bin", "pyright-langserver");
		vi.mocked(ensureTool).mockImplementation(async (id: string) =>
			id === "pyright" ? globalPyright : undefined,
		);
		launchLSP.mockReset();
		launchLSP.mockImplementation(async (command: string) => {
			if (command === globalPyrightLangserver) {
				return { kill: vi.fn() } as never;
			}
			throw toolNotFound(`not found: ${command}`);
		});

		try {
			const res = await PythonServer.spawn(
				sep("/tmp", "pi-lens-python-no-venv"),
				{ allowInstall: false },
			);

			expect(vi.mocked(ensureTool)).toHaveBeenCalledWith("pyright", {
				allowInstall: false,
			});
			expect(triedCommands()).toContain(globalPyrightLangserver);
			expect(res).toBeDefined();
		} finally {
			vi.mocked(ensureTool).mockReset();
			vi.mocked(ensureTool).mockResolvedValue(undefined);
		}
	});

	it("JavaServer passes Lombok javaagent through official jdtls --jvm-arg", async () => {
		const tmp = await import("node:fs").then((fs) =>
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jdtls-lombok-")),
		);
		try {
			const fs = await import("node:fs");
			fs.writeFileSync(
				path.join(tmp, "lombok.config"),
				"config.stopBubbling = true\n",
			);
			fs.mkdirSync(path.join(tmp, ".lombok"));
			const jar = path.join(tmp, ".lombok", "lombok.jar");
			fs.writeFileSync(jar, "jar");
			await JavaServer.spawn(tmp, { allowInstall: false });
			expect(launchLSP.mock.calls[0]?.[1]).toContain(
				`--jvm-arg=-javaagent:${jar}`,
			);
		} finally {
			removeTempDirSync(tmp);
		}
	});
});

/**
 * #5410 S5 deleted the `isOnPath` wrapper, so the two LSP launch decisions that
 * asked "is this runtime on PATH" now call `isCommandAvailableAsync` directly:
 * the language-native runtime-install gate in `resolveAndLaunch` and the runtime
 * candidate loop in `resolveAndLaunchBundle`. No test named either decision, so
 * a mutation of either call survived (the S5 r1 mutation `? false` on the gate
 * left 28 tests green).
 *
 * Recurrence guarded: a runtime-install or bundle-launch decision that no longer
 * follows the PATH answer (an install run for a runtime that is absent, or a
 * skip for one that is present) staying green because every existing test
 * stubbed the launch and never gave the gate a PATH answer to read.
 *
 * The PATH answer is the process boundary: `onPath` stands in for what `which`
 * reports, so a developer machine that has `pwsh` or `dotnet` cannot change the
 * verdict. The finder call itself (`which` / `where`) is not exercised here.
 */
describe("PATH gates on the runtime launch decisions (#5410 S5)", () => {
	beforeEach(() => {
		launchLSP.mockReset();
		onPath.clear();
	});

	afterEach(() => {
		onPath.clear();
		getToolPath.mockReset();
		getToolPath.mockResolvedValue(undefined);
	});

	describe("resolveAndLaunch runtime-install gate (#5410 S5)", () => {
		const RUNTIME = "pi-lens-5410-runtime";
		const SERVER = "pi-lens-5410-server";

		function specWith(install: () => Promise<boolean>) {
			return {
				candidates: [SERVER],
				args: ["--stdio"],
				cwd: os.tmpdir(),
				runtimeInstall: { runtimeCommand: RUNTIME, install },
			};
		}

		it("runs the install and retries the candidates when the runtime is on PATH", async () => {
			onPath.add(RUNTIME);
			let installed = false;
			const install = vi.fn(async () => {
				installed = true;
				return true;
			});
			const proc = { kill: vi.fn() } as never;
			// Fails before the install, succeeds after it: the server binary appears.
			launchLSP.mockImplementation(async () => {
				if (!installed) throw toolNotFound();
				return proc;
			});

			const result = await resolveAndLaunch(specWith(install), true);

			expect(install).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ process: proc, source: "managed" });
		});

		it("does not run the install when the runtime is absent from PATH", async () => {
			const install = vi.fn(async () => true);
			launchLSP.mockRejectedValue(toolNotFound());

			const result = await resolveAndLaunch(specWith(install), true);

			expect(install).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});
	});

	describe("resolveAndLaunchBundle runtime candidate loop (#5410 S5)", () => {
		const BUNDLE_DIR = path.join(os.tmpdir(), "pi-lens-5410-bundle");

		beforeEach(() => {
			getToolPath.mockResolvedValue(BUNDLE_DIR);
			launchLSP.mockResolvedValue({ kill: vi.fn() } as never);
		});

		it("skips an absent first candidate and launches the one on PATH", async () => {
			onPath.add("powershell");

			const result = await PowerShellServer.spawn(os.tmpdir(), {
				allowInstall: false,
			});

			expect(result).toBeDefined();
			expect(launchLSP).toHaveBeenCalledTimes(1);
			expect(launchLSP.mock.calls[0]?.[0]).toBe("powershell");
			expect(launchLSP.mock.calls[0]?.[1]).toContain(BUNDLE_DIR);
		});

		it("prefers the first candidate when both are on PATH", async () => {
			onPath.add("pwsh");
			onPath.add("powershell");

			await PowerShellServer.spawn(os.tmpdir(), { allowInstall: false });

			expect(launchLSP).toHaveBeenCalledTimes(1);
			expect(launchLSP.mock.calls[0]?.[0]).toBe("pwsh");
		});

		it("skips gracefully, before any bundle lookup, when no runtime is on PATH", async () => {
			const result = await PowerShellServer.spawn(os.tmpdir(), {
				allowInstall: false,
			});

			expect(result).toBeUndefined();
			expect(getToolPath).not.toHaveBeenCalled();
			expect(launchLSP).not.toHaveBeenCalled();
		});
	});
});
