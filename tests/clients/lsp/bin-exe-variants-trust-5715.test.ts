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

const { spawnCalls } = vi.hoisted(() => ({
	spawnCalls: [] as Array<{ command: string; platform: string }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
		execFileSync: vi.fn(() => ""),
		spawn: vi.fn((command: string) => {
			spawnCalls.push({ command: String(command), platform: process.platform });
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
} from "../../../clients/lsp/server.js";

function trustRefusals(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "trust-refusal")
			?.latestReasons.map((entry) => entry.subject) ?? []
	);
}

/**
 * The file a spawn double was asked to start, with the shell wrapper's quotes
 * and arguments removed (a `.cmd` launch spawns `"<file>" --stdio`).
 */
function spawnedTarget(command: string): string {
	return command.replace(/^"([^"]*)".*$/, "$1");
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
		vi.resetModules();
		resetDegradationLedger();
		resetProjectTrust();
		removeTempDirSync(tempRoot);
	});

	/**
	 * Start the server through its production `spawn` (candidate list, then
	 * `resolveAndLaunch`, then `launchLSP`) with the platform held at win32 for
	 * the whole awaited flow and the modules loaded under it: `launch.ts` reads
	 * the platform into a load-time constant, so a module cached from the host
	 * platform would run the POSIX launch path (#5715 F2).
	 */
	async function spawnUnderWin32(which: "go" | "rust"): Promise<void> {
		await withPlatform("win32", async () => {
			vi.resetModules();
			const trust = await import("../../../clients/project-trust.js");
			trust.setProjectTrustState("untrusted");
			const server = await import("../../../clients/lsp/server.js");
			const info = which === "go" ? server.GoServer : server.RustServer;
			await info.spawn(sessionDir, { allowInstall: false });
		});
	}

	/** Every spawn the double saw ran under win32 and none started `forbidden`. */
	function expectLaunchedOnWin32Without(forbidden: string[]): void {
		// The bare PATH candidate always reaches spawn, so an empty list means the
		// launch path never ran and the assertions below would be vacuous.
		expect(spawnCalls.length).toBeGreaterThan(0);
		expect(spawnCalls.map((call) => call.platform)).toEqual(
			spawnCalls.map(() => "win32"),
		);
		const targets = spawnCalls.map((call) => spawnedTarget(call.command));
		for (const file of forbidden) expect(targets).not.toContain(file);
	}

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

		await spawnUnderWin32("go");
		expectLaunchedOnWin32Without([extensionless, exePath]);
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

		await spawnUnderWin32("rust");
		expectLaunchedOnWin32Without([extensionless, exePath]);
	});

	// #5715 F1: cmd.exe completes the extensionless spelling under PATHEXT to
	// any executable sibling, not only `.exe`, and the launcher judges no
	// toolchain dir. The refusal must not depend on which sibling exists.
	it.each([".cmd", ".bat", ".com"])(
		"win32: untrusted $GOPATH/bin/gopls%s sibling never reaches spawn through the extensionless candidate",
		async (ext) => {
			const gopath = path.join(sessionDir, "gopath");
			const sibling = plantDummyExe(path.join(gopath, "bin"), "gopls" + ext);
			const extensionless = path.join(gopath, "bin", "gopls");
			vi.stubEnv("GOPATH", gopath);

			const candidates = withPlatform("win32", () => goBinCandidates("gopls"));
			expect(candidates).not.toContain(extensionless);
			expect(trustRefusals()).toEqual([
				truncateForLedger(`project-command:${sibling}`),
			]);

			await spawnUnderWin32("go");
			expectLaunchedOnWin32Without([extensionless]);
		},
	);

	it.each([".cmd", ".bat", ".com"])(
		"win32: untrusted $CARGO_HOME/bin/rust-analyzer%s sibling never reaches spawn through the extensionless candidate",
		async (ext) => {
			const cargoHome = path.join(sessionDir, "cargo");
			plantDummyExe(path.join(cargoHome, "bin"), "rust-analyzer" + ext);
			const extensionless = path.join(cargoHome, "bin", "rust-analyzer");
			vi.stubEnv("CARGO_HOME", cargoHome);

			await spawnUnderWin32("rust");
			expectLaunchedOnWin32Without([extensionless]);
		},
	);

	it("win32: keeps admitting variants when the project is trusted", () => {
		const gopath = path.join(sessionDir, "gopath");
		const exePath = plantDummyExe(path.join(gopath, "bin"), "gopls.exe");
		plantDummyExe(path.join(gopath, "bin"), "gopls.cmd");
		const extensionless = path.join(gopath, "bin", "gopls");
		vi.stubEnv("GOPATH", gopath);

		setProjectTrustState("trusted");
		const trustedCandidates = withPlatform("win32", () =>
			goBinCandidates("gopls"),
		);
		expect(trustedCandidates).toEqual(["gopls", exePath, extensionless]);
		expect(trustRefusals()).toEqual([]);
	});

	// Fail closed on the directory, not on a sibling that happens to exist now:
	// the extensionless spelling is only ever a PATHEXT completion on win32, so
	// an untrusted project dir never yields it (nothing is refused when nothing
	// is there, so no record).
	it("win32: an untrusted project toolchain dir yields no extensionless candidate even when empty", () => {
		const missingDir = path.join(sessionDir, "empty-gopath");
		vi.stubEnv("GOPATH", missingDir);
		const candidates = withPlatform("win32", () => goBinCandidates("gopls"));
		expect(candidates).toEqual([
			"gopls",
			path.join(missingDir, "bin", "gopls.exe"),
		]);
		expect(trustRefusals()).toEqual([]);
	});

	it("win32: an untrusted toolchain dir outside the project keeps both spellings", () => {
		const outside = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5715-out-")),
		);
		try {
			vi.stubEnv("GOPATH", outside);
			const candidates = withPlatform("win32", () => goBinCandidates("gopls"));
			expect(candidates).toEqual([
				"gopls",
				path.join(outside, "bin", "gopls.exe"),
				path.join(outside, "bin", "gopls"),
			]);
		} finally {
			removeTempDirSync(outside);
		}
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

	// The extensionless spelling is the ONLY launchable one on POSIX, so the
	// win32 rule must not reach it.
	it("POSIX: behavior is unchanged when only <tool>.exe exists in untrusted $GOPATH/bin", () => {
		const gopath = path.join(sessionDir, "gopath");
		plantDummyExe(path.join(gopath, "bin"), "gopls.exe");
		const extensionless = path.join(gopath, "bin", "gopls");
		vi.stubEnv("GOPATH", gopath);

		const candidates = withPlatform("linux", () => goBinCandidates("gopls"));
		expect(candidates).toEqual(["gopls", extensionless]);
		expect(trustRefusals()).toEqual([]);
	});

	it("POSIX: an untrusted project toolchain dir keeps the extensionless candidate when empty", () => {
		const missingDir = path.join(sessionDir, "empty-gopath");
		vi.stubEnv("GOPATH", missingDir);
		const candidates = withPlatform("linux", () => goBinCandidates("gopls"));
		expect(candidates).toEqual([
			"gopls",
			path.join(missingDir, "bin", "gopls"),
		]);
	});
});
