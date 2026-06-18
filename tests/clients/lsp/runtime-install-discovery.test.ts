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
	RustServer,
} from "../../../clients/lsp/server.ts";

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
		if (isWin) expect(c).toContain(sep("/custom", "gopath", "bin", "gopls.exe"));
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
			tried.some((cmd) => cmd === sep(os.homedir(), ".cargo", "bin", "rust-analyzer")),
		).toBe(true);
	});

	it("FSharpServer is a dotnet-tool runtime-install server (csharp-ls pattern)", async () => {
		// No createInteractiveServer availabilityKey — it resolves via the full
		// resolveAndLaunch chain (candidates → runtimeInstall), like csharp-ls.
		expect(FSharpServer).not.toHaveProperty("availabilityKey");
		await FSharpServer.spawn(sep("/tmp", "proj"), { allowInstall: false });
		const tried = triedCommands();
		// dotnetToolCandidates: managed bin dir, ~/.dotnet/tools, bare command.
		expect(tried.some((cmd) => cmd.endsWith(sep(".dotnet", "tools", "fsautocomplete")))).toBe(
			true,
		);
		expect(tried).toContain("fsautocomplete");
	});
});
