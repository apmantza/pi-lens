/**
 * #1570: the classic-tsserver repair guard (`classicTsRepairAttempted` in
 * clients/lsp/server.ts) is a plain module-level flag with no cooldown. A
 * repair that fails once (a transient registry hiccup, an offline install)
 * latches for the rest of the process — a long-lived extension host would
 * never retry the repair again, even across many later sessions.
 *
 * `resetLSPService({ reason: "session_start" })` already runs on every
 * session_start (clients/runtime-session.ts). This guards that it also
 * re-arms the classic-repair guard, so a new session gets its own attempt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

const ensureTool = vi.fn();
const getToolEnvironment = vi.fn(async () => ({}));
const launchLSP = vi.fn();
const logSessionStart = vi.fn();

vi.mock("../../../clients/installer/index.js", () => ({
	ensureTool,
	getToolEnvironment,
	findManagedToolBinary: vi.fn(async () => undefined),
}));

vi.mock("../../../clients/lsp/launch.js", () => ({
	launchLSP,
	refuseUntrustedLspExecution: vi.fn(),
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart,
}));

const dirs: string[] = [];
const IS_WIN = process.platform === "win32";

/** Same fixture shape as server-policy.test.ts: a managed tools tree whose
 * TypeScript version and tsserver.js presence the caller controls. */
function createManagedTypeScriptTree(label: string) {
	const tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), `pi-lens-ts-rearm-${label}-`),
	);
	dirs.push(tmp);
	fs.writeFileSync(path.join(tmp, "package.json"), "{}\n");

	const binDir = path.join(tmp, "managed", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const lspPath = path.join(
		binDir,
		IS_WIN ? "typescript-language-server.cmd" : "typescript-language-server",
	);
	const tscPath = path.join(binDir, IS_WIN ? "tsc.cmd" : "tsc");
	fs.writeFileSync(lspPath, "#!/usr/bin/env node\n");
	fs.writeFileSync(tscPath, "#!/usr/bin/env node\n");

	const typescriptDir = path.join(tmp, "managed", "node_modules", "typescript");
	const tsserverPath = path.join(typescriptDir, "lib", "tsserver.js");

	const writeCompiler = (version: string, withTsserver = false) => {
		fs.mkdirSync(path.join(typescriptDir, "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(typescriptDir, "package.json"),
			`${JSON.stringify({ name: "typescript", version })}\n`,
		);
		if (withTsserver) {
			fs.writeFileSync(tsserverPath, "// fake tsserver\n");
		} else {
			fs.rmSync(tsserverPath, { force: true });
		}
	};

	/** `succeedsOnAttempt` lets each forceReinstall call have its own outcome,
	 * so the test can model "first repair fails, second repair (after re-arm)
	 * succeeds" without a second tree. */
	const mockEnsureTool = (onForceReinstall?: () => void) => {
		ensureTool.mockImplementation(
			async (toolId: string, options?: { forceReinstall?: boolean }) => {
				if (toolId === "typescript-language-server") return lspPath;
				if (toolId !== "typescript") return undefined;
				if (options?.forceReinstall) onForceReinstall?.();
				return tscPath;
			},
		);
	};

	return { tmp, lspPath, tscPath, tsserverPath, writeCompiler, mockEnsureTool };
}

function mockLaunchedProcess(pid: number): void {
	launchLSP.mockResolvedValue({
		process: { killed: false } as never,
		stdin: {} as never,
		stdout: {} as never,
		stderr: {} as never,
		pid,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
	delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
	ensureTool.mockReset();
	launchLSP.mockReset();
	logSessionStart.mockClear();
	vi.resetModules();
});

describe("classic TypeScript repair guard re-arms at session_start (#1570)", () => {
	it("retries the repair after resetLSPService({reason: 'session_start'}), not just once per process", async () => {
		const { resetLSPService } = await import("../../../clients/lsp/index.js");
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();

		const tree = createManagedTypeScriptTree("rearm");
		tree.writeCompiler("7.0.2");
		// First repair attempt fails to produce a usable compiler (offline,
		// registry hiccup) — the reinstall lands the same broken TS 7 tree.
		tree.mockEnsureTool();
		mockLaunchedProcess(7777);

		const first = await TypeScriptServer.spawn(tree.tmp);
		expect(first?.initialization).toBeUndefined();
		const firstReinstalls = ensureTool.mock.calls.filter(
			(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
		);
		expect(firstReinstalls).toHaveLength(1);

		// Without a session boundary, the pre-existing once-guard is still
		// correct: a second spawn in the SAME session must not retry.
		const stillSameSession = await TypeScriptServer.spawn(tree.tmp);
		expect(stillSameSession?.initialization).toBeUndefined();
		expect(
			ensureTool.mock.calls.filter(
				(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
			),
		).toHaveLength(1);

		// A new session starts. The registry hiccup is now resolved, so this
		// repair attempt succeeds — but only if the guard actually re-armed.
		resetLSPService({ reason: "session_start" });
		tree.mockEnsureTool(() => tree.writeCompiler("5.9.3", true));

		const afterNewSession = await TypeScriptServer.spawn(tree.tmp);

		expect(
			ensureTool.mock.calls.filter(
				(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
			),
		).toHaveLength(2);
		expect(afterNewSession?.initialization).toBeDefined();
		expect(afterNewSession?.launchVariant).toBe("classic");
	});

	it("does not re-arm the repair guard for a non-session_start reset (e.g. pipeline_crash)", async () => {
		const { resetLSPService } = await import("../../../clients/lsp/index.js");
		const { TypeScriptServer, _resetClassicTsRepairForTests } =
			await import("../../../clients/lsp/server.js");
		_resetClassicTsRepairForTests();

		const tree = createManagedTypeScriptTree("no-rearm");
		tree.writeCompiler("7.0.2");
		tree.mockEnsureTool();
		mockLaunchedProcess(8888);

		const first = await TypeScriptServer.spawn(tree.tmp);
		expect(first?.initialization).toBeUndefined();

		resetLSPService({ reason: "pipeline_crash" });
		tree.mockEnsureTool(() => tree.writeCompiler("5.9.3", true));

		const afterCrashReset = await TypeScriptServer.spawn(tree.tmp);

		expect(afterCrashReset?.initialization).toBeUndefined();
		expect(
			ensureTool.mock.calls.filter(
				(call) => call[0] === "typescript" && call[1]?.forceReinstall === true,
			),
		).toHaveLength(1);
	});
});
