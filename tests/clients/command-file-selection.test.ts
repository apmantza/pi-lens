/** #4530 r7: command selection must reject directories before any binary probe.
 * Process results are the external boundary; filesystem selection stays real.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../clients/project-trust.js";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";
import { GovulncheckClient } from "../../clients/govulncheck-client.js";
import { verifyToolBinary } from "../../clients/installer/index.js";
import {
	resolveAdoptedRootCommand,
	_setThisDirForTests,
	isSgAvailableAsync,
	resetDispatchAvailabilityState,
} from "../../clients/dispatch/runners/utils/runner-helpers.js";

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(),
}));

beforeEach(() => {
	setProjectTrustState("trusted");
	resetDispatchAvailabilityState();
	vi.mocked(safeSpawnAsync).mockReset();
});
afterEach(() => {
	_setThisDirForTests(undefined);
	resetDispatchAvailabilityState();
	resetProjectTrust();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("never probes a managed ast-grep directory", async () => {
	const { tmpDir } = setupTestEnvironment("pi-lens-command-file-");
	_setThisDirForTests(tmpDir);
	vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
	const candidate = path.join(
		getGlobalPiLensDir(),
		"tools",
		"node_modules",
		".bin",
		process.platform === "win32" ? "ast-grep.cmd" : "ast-grep",
	);
	fs.mkdirSync(candidate, { recursive: true });
	vi.mocked(safeSpawnAsync).mockResolvedValue({
		stdout: "ast-grep 0.50.0",
		stderr: "",
		status: 0,
	});
	try {
		await isSgAvailableAsync();
		expect(
			vi.mocked(safeSpawnAsync).mock.calls.map(([command]) => command),
		).not.toContain(candidate);
	} finally {
		fs.rmdirSync(candidate);
	}
});

it("does not recover govulncheck availability from a GOBIN directory", async () => {
	const { tmpDir } = setupTestEnvironment("pi-lens-command-file-");
	vi.stubEnv("GOBIN", tmpDir);
	vi.stubEnv("GOPATH", tmpDir);
	const candidate = path.join(
		tmpDir,
		process.platform === "win32" ? "govulncheck.exe" : "govulncheck",
	);
	fs.mkdirSync(candidate);
	vi.mocked(safeSpawnAsync).mockImplementation(async (command) => ({
		stdout: "",
		stderr: "",
		status: command === "go" ? 0 : 1,
	}));
	const client = new GovulncheckClient();
	expect(await client.ensureAvailable()).toBe(false);
});

it("does not substitute a directory for an installer's PS1 command", async () => {
	const { tmpDir } = setupTestEnvironment("pi-lens-command-file-");
	vi.stubEnv("PI_LENS_TEST_PLATFORM", "win32");
	const ps1 = path.join(tmpDir, "fixture.ps1");
	const cmd = path.join(tmpDir, "fixture.cmd");
	fs.writeFileSync(ps1, "fixture");
	fs.mkdirSync(cmd);
	vi.mocked(safeSpawnAsync).mockResolvedValue({
		stdout: "1.0.0",
		stderr: "",
		status: 0,
	});
	await verifyToolBinary(ps1);
	expect(
		vi.mocked(safeSpawnAsync).mock.calls.map(([command]) => command),
	).not.toContain(cmd);
});

// #4530 r7: the adopted-root selector must fall through a managed directory.
it("rejects a managed directory in adopted command resolution", () => {
	const { tmpDir } = setupTestEnvironment("pi-lens-command-file-");
	const session = path.join(tmpDir, "session");
	fs.mkdirSync(session);
	const filePath = path.join(session, "source.py");
	fs.writeFileSync(filePath, "");
	vi.stubEnv("PATH", "");
	const candidate = path.join(
		getGlobalPiLensDir(),
		"tools",
		"node_modules",
		".bin",
		process.platform === "win32" ? "fixture.cmd" : "fixture",
	);
	fs.mkdirSync(candidate, { recursive: true });
	try {
		expect(
			resolveAdoptedRootCommand(
				"fixture",
				{
					cwd: session,
					filePath,
				} as import("../../clients/dispatch/types.js").DispatchContext,
				session,
			),
		).toBeNull();
	} finally {
		fs.rmdirSync(candidate);
	}
});
