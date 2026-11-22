import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { truncateForLedger } from "../../../clients/ledger-bounds.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { withPlatform } from "../../support/platform-stub.js";
import { removeTempDirSync } from "../test-utils.js";

class MockStream extends EventEmitter {}
class FailingChildProcess extends EventEmitter {
	stdin = new MockStream();
	stdout = new MockStream();
	stderr = new MockStream();
	exitCode: number | null = null;
	killed = false;
	constructor(public pid: number) {
		super();
	}
}

const { spawnCalls } = vi.hoisted(() => ({ spawnCalls: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
		execFileSync: vi.fn(() => ""),
		spawn: vi.fn((command: string) => {
			spawnCalls.push(String(command));
			const proc = new FailingChildProcess(999_999);
			queueMicrotask(() => {
				const err = Object.assign(new Error(`spawn ${command} ENOENT`), {
					code: "ENOENT",
					errno: -2,
					syscall: `spawn ${command}`,
					path: command,
				});
				proc.emit("error", err);
			});
			return proc;
		}),
	};
});

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	isCommandAvailableAsync: async () => false,
	safeSpawnAsync: vi.fn(async () => ({
		code: 1,
		stdout: "",
		stderr: "",
		timedOut: false,
	})),
}));

import {
	cargoBinCandidates,
	goBinCandidates,
	GoServer,
	RustServer,
} from "../../../clients/lsp/server.js";

function trustRefusals(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "trust-refusal")
			?.latestReasons.map((entry) => entry.subject) ?? []
	);
}

function plantDummyExe(binDir: string, fileName: string): string {
	fs.mkdirSync(binDir, { recursive: true });
	const fullPath = path.join(binDir, fileName);
	fs.writeFileSync(fullPath, "stub", "utf8");
	return fullPath;
}

describe("binExeVariants win32 PATHEXT sibling trust refusal (#5715)", () => {
	const originalCwd = process.cwd();
	let tempRoot: string;
	let sessionDir: string;

	beforeEach(() => {
		tempRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5715-")),
		);
		sessionDir = path.join(tempRoot, "project");
		const isolatedEnvRoot = path.join(tempRoot, "isolated");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.mkdirSync(isolatedEnvRoot, { recursive: true });
		process.chdir(sessionDir);
		setProjectTrustState("untrusted");
		resetDegradationLedger();
		spawnCalls.length = 0;
		vi.stubEnv("PATH", isolatedEnvRoot);
		vi.stubEnv("Path", isolatedEnvRoot);
		vi.stubEnv("LOCALAPPDATA", isolatedEnvRoot);
		vi.stubEnv("XDG_DATA_HOME", isolatedEnvRoot);
		vi.stubEnv("USERPROFILE", isolatedEnvRoot);
		vi.stubEnv("HOME", isolatedEnvRoot);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		vi.unstubAllEnvs();
		resetDegradationLedger();
		resetProjectTrust();
		removeTempDirSync(tempRoot);
	});

	it("win32: refuses extensionless sibling when untrusted project $GOPATH/bin/<tool>.exe exists and never reaches spawn", async () => {
		const gopath = path.join(sessionDir, "gopath");
		const exePath = plantDummyExe(path.join(gopath, "bin"), "gopls.exe");
		const extensionless = path.join(gopath, "bin", "gopls");
		vi.stubEnv("GOPATH", gopath);

		const candidates = withPlatform("win32", () => goBinCandidates("gopls"));
		expect(candidates).toEqual(["gopls"]);
		expect(candidates).not.toContain(exePath);
		expect(candidates).not.toContain(extensionless);

		expect(trustRefusals()).toEqual([
			truncateForLedger(`project-command:${exePath}`),
		]);

		await withPlatform("win32", () =>
			GoServer.spawn(sessionDir, { allowInstall: false }),
		);
		for (const spawned of spawnCalls) {
			expect(spawned).not.toContain(extensionless);
			expect(spawned).not.toContain(exePath);
		}
	});

	it("win32: refuses extensionless sibling when untrusted project $CARGO_HOME/bin/<tool>.exe exists and never reaches spawn", async () => {
		const cargoHome = path.join(sessionDir, "cargo");
		const exePath = plantDummyExe(
			path.join(cargoHome, "bin"),
			"rust-analyzer.exe",
		);
		const extensionless = path.join(cargoHome, "bin", "rust-analyzer");
		vi.stubEnv("CARGO_HOME", cargoHome);

		const candidates = withPlatform("win32", () =>
			cargoBinCandidates("rust-analyzer"),
		);
		expect(candidates).toEqual(["rust-analyzer"]);
		expect(candidates).not.toContain(exePath);
		expect(candidates).not.toContain(extensionless);

		await withPlatform("win32", () =>
			RustServer.spawn(sessionDir, { allowInstall: false }),
		);
		for (const spawned of spawnCalls) {
			expect(spawned).not.toContain(extensionless);
			expect(spawned).not.toContain(exePath);
		}
	});

	it("win32: keeps admitting variants when project is trusted or .exe is absent", () => {
		const gopath = path.join(sessionDir, "gopath");
		const exePath = plantDummyExe(path.join(gopath, "bin"), "gopls.exe");
		const extensionless = path.join(gopath, "bin", "gopls");
		vi.stubEnv("GOPATH", gopath);

		setProjectTrustState("trusted");
		const trustedCandidates = withPlatform("win32", () =>
			goBinCandidates("gopls"),
		);
		expect(trustedCandidates).toEqual(["gopls", exePath, extensionless]);

		setProjectTrustState("untrusted");
		const missingDir = path.join(sessionDir, "empty-gopath");
		vi.stubEnv("GOPATH", missingDir);
		const absentCandidates = withPlatform("win32", () =>
			goBinCandidates("gopls"),
		);
		expect(absentCandidates).toEqual([
			"gopls",
			path.join(missingDir, "bin", "gopls.exe"),
			path.join(missingDir, "bin", "gopls"),
		]);
	});

	it("win32: still refuses untrusted extensionless binary when .exe is absent", () => {
		const gopath = path.join(sessionDir, "gopath");
		const barePath = plantDummyExe(path.join(gopath, "bin"), "gopls");
		const exePath = path.join(gopath, "bin", "gopls.exe");
		vi.stubEnv("GOPATH", gopath);

		const candidates = withPlatform("win32", () => goBinCandidates("gopls"));
		expect(candidates).toEqual(["gopls", exePath]);
		expect(candidates).not.toContain(barePath);

		expect(trustRefusals()).toEqual([
			truncateForLedger(`project-command:${barePath}`),
		]);
	});

	it("POSIX: behavior is unchanged when only <tool>.exe exists in untrusted $GOPATH/bin", () => {
		const gopath = path.join(sessionDir, "gopath");
		plantDummyExe(path.join(gopath, "bin"), "gopls.exe");
		const extensionless = path.join(gopath, "bin", "gopls");
		vi.stubEnv("GOPATH", gopath);

		const candidates = withPlatform("linux", () => goBinCandidates("gopls"));
		expect(candidates).toEqual(["gopls", extensionless]);
		expect(trustRefusals()).toEqual([]);
	});
});
