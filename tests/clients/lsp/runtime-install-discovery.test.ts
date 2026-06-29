import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Drive the candidate-resolution chain without touching disk/toolchains: mock
// the launch primitive (reject-all → we just capture every candidate tried) and
// the installer. With allowInstall:false, resolveAndLaunch never reaches the
// ensureTool/runtimeInstall steps, so no real `go install` / `dotnet tool
// install` can fire from a unit test — we assert the canonical-bin discovery and
// runtime-install WIRING via the candidate list and server shape (#241).
const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
const { logLatency } = vi.hoisted(() => ({ logLatency: vi.fn() }));
vi.mock("../../../clients/lsp/launch.js", () => ({ launchLSP }));
vi.mock("../../../clients/latency-logger.js", () => ({ logLatency }));
vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(async () => null),
	getToolEnvironment: () => ({}),
}));

import {
	cargoBinCandidates,
	FSharpServer,
	goBinCandidates,
	GoServer,
	JavaServer,
	PythonServer,
	RustServer,
	TypeScriptServer,
} from "../../../clients/lsp/server.ts";
import { ensureTool } from "../../../clients/installer/index.js";

const isWin = process.platform === "win32";
const sep = (...parts: string[]) => path.join(...parts);

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
		launchLSP.mockReset();
		logLatency.mockReset();
		// Reject every candidate so resolveAndLaunch exhausts the list; we only
		// inspect WHICH commands it tried. allowInstall:false keeps installs off.
		launchLSP.mockRejectedValue(new Error("not found"));
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

	it("TypeScriptServer discovers a global typescript-language-server when install is disabled (discovery decoupled from install)", async () => {
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
			expect(triedCommands()).toContain(GLOBAL_TLS);
			expect(res).toBeDefined();
		} finally {
			process.chdir(oldCwd);
			fs.rmSync(tmp, { recursive: true, force: true });
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
			throw new Error(`not found: ${command}`);
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
			const fs = await import("node:fs");
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
