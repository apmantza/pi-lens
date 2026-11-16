/**
 * #5410 S1: the pyright runner resolves its binary through the registry
 * resolver (`resolveToolCommandWithInstallFallback`) and words a skip through
 * `toolAbsentSkip(cwd, { id: "pyright" })`, with no ladder of its own.
 *
 * Driven through the real runner, the real checker, the real trust seam and
 * the real installer lookups. Only the child process (`safe-spawn`) is
 * doubled; installs stay off through the suite's `PI_LENS_DISABLE_TOOL_INSTALL`
 * default, and the worker's pinned `PI_LENS_HOME` holds no managed pyright.
 *
 * Recurrence pinned: the runner kept a private checker plus a bare `which
 * pyright` as step 3, which carried no version probe. A PATH shim the checker
 * had just rejected (`probe-rejected`, deliberately not installed over) was
 * found by `which` and run anyway, so the verdict was a failed run with a
 * parse error instead of a skip that names the cause.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { resetProjectLensConfigCache } from "../../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../../clients/workspace-topology.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, findCommandAsync, spawnCalls, shim } = vi.hoisted(
	() => {
		const spawnCalls: Array<{
			cmd: string;
			args: readonly string[];
			cwd: string | undefined;
		}> = [];
		// What every pyright binary on disk does: it answers, or it exits 127.
		const shim: { mode: "ok" | "exit127" } = { mode: "ok" };
		const safeSpawnAsync = vi.fn(
			async (
				cmd: string,
				args: readonly string[] = [],
				opts: { cwd?: string } = {},
			) => {
				spawnCalls.push({ cmd: String(cmd), args, cwd: opts.cwd });
				const fs = await import("node:fs");
				const path = await import("node:path");
				const onPath = (name: string): string | undefined =>
					(process.env.PATH ?? "")
						.split(path.delimiter)
						.filter(Boolean)
						.map((dir) => path.join(dir, name))
						.find((file) => fs.existsSync(file));
				// `which` and `where` answer from the PATH the test planted.
				if (cmd === "which" || cmd === "where") {
					const found = onPath(String(args[0]));
					return found
						? { error: null, status: 0, stdout: `${found}\n`, stderr: "" }
						: { error: null, status: 1, stdout: "", stderr: "" };
				}
				const onDisk = path.isAbsolute(cmd)
					? fs.existsSync(cmd)
					: onPath(cmd) !== undefined;
				if (!onDisk) {
					return {
						error: new Error(`spawn ${cmd} ENOENT`),
						status: null,
						stdout: "",
						stderr: "",
						spawnFailure: { kind: "tool-not-found" },
					};
				}
				if (shim.mode === "exit127") {
					return {
						error: null,
						status: 127,
						stdout: "",
						stderr: "pyright: node: not found",
					};
				}
				if (args.includes("--outputjson")) {
					return {
						error: null,
						status: 0,
						stdout: JSON.stringify({ generalDiagnostics: [] }),
						stderr: "",
					};
				}
				return { error: null, status: 0, stdout: "1.1.400\n", stderr: "" };
			},
		);
		// `findCommandAsync` calls safe-spawn's own binding of `safeSpawnAsync`, which
		// a module mock does not reach: the double routes it through the one above.
		const findCommandAsync = async (name: string): Promise<string | null> => {
			const found = await safeSpawnAsync("which", [name]);
			return found.status === 0 ? found.stdout.trim() : null;
		};
		return { safeSpawnAsync, findCommandAsync, spawnCalls, shim };
	},
);
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
	findCommandAsync,
}));

/** Plant a `pyright` file the doubled child process treats as a binary. */
function plantPyright(dir: string, ext = ""): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		process.platform === "win32" ? "pyright.cmd" : `pyright${ext}`,
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

const venvBin = (root: string) =>
	path.join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const nodeModulesBin = (root: string) =>
	path.join(root, "node_modules", ".bin");

describe("pyright resolves through the registry resolver (#5410 S1)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	let file: string;

	const run = async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/pyright.js")
		).default;
		return runner.run(
			makeRunnerCtx(file, workspace.tmpDir, {
				kind: "python",
				pi: { getFlag: (name: string) => name === "no-lsp" } as never,
			}),
		);
	};
	const pyrightSpawns = () =>
		spawnCalls.filter((call) => /(^|[\\/])pyright(\.cmd)?$/.test(call.cmd));
	const runSpawns = () =>
		spawnCalls.filter((call) => call.args.includes("--outputjson"));

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410s1-path-");
		workspace = setupTestEnvironment("pi-lens-5410s1-ws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		spawnCalls.length = 0;
		shim.mode = "ok";
		safeSpawnAsync.mockClear();
		file = path.join(workspace.tmpDir, "sample.py");
		fs.writeFileSync(file, "x: int = 1\n");
	});
	afterEach(() => {
		pathEnv.cleanup();
		workspace.cleanup();
		resetProjectTrust();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	// Recurrence: step 3's bare `which pyright` ran a PATH shim the checker had
	// rejected, so the file reported `failed` with a parse error.
	it("skips a PATH pyright that exits 127 on --version, after one spawn", async () => {
		plantPyright(pathEnv.tmpDir);
		shim.mode = "exit127";
		const result = await run();
		expect(result.status).toBe("skipped");
		expect(result.skipReason).toBe("probe-rejected");
		expect(pyrightSpawns()).toHaveLength(1);
		expect(pyrightSpawns()[0].args).toEqual(["--version"]);
		expect(runSpawns()).toHaveLength(0);
		expect(spawnCalls.some((call) => call.cmd === "which")).toBe(false);
	});

	it("runs a PATH pyright that answers its version probe", async () => {
		const bin = plantPyright(pathEnv.tmpDir);
		const result = await run();
		expect(result.status).toBe("succeeded");
		expect(pyrightSpawns().map((call) => call.args[0])).toEqual([
			"--version",
			"--outputjson",
		]);
		expect(runSpawns()).toHaveLength(1);
		expect(path.basename(runSpawns()[0].cmd)).toBe(path.basename(bin));
	});

	it("skips when no pyright exists anywhere, without running one", async () => {
		const result = await run();
		expect(result.status).toBe("skipped");
		// The suite exports the install kill switch, so an absent tool reads so.
		expect(result.skipReason).toBe("install-disabled");
		expect(runSpawns()).toHaveLength(0);
	});

	// Pins the trust gate on the project rung: `.venv/bin/pyright` at the exact
	// cwd is the project's own copy, admitted only while pi trusts the project.
	// Characterization: the runner's old checker gated the same rung.
	it("refuses .venv/bin/pyright while untrusted, then runs it once trusted", async () => {
		const bin = plantPyright(venvBin(workspace.tmpDir));
		setProjectTrustState("untrusted");
		const refused = await run();
		expect(refused.status).toBe("skipped");
		expect(refused.skipReason).toBe("trust-refused");
		expect(pyrightSpawns().filter((call) => call.cmd === bin)).toHaveLength(0);

		setProjectTrustState("trusted");
		const admitted = await run();
		expect(admitted.status).toBe("succeeded");
		expect(runSpawns().map((call) => call.cmd)).toEqual([bin]);
		expect(runSpawns()[0].cwd).toBe(workspace.tmpDir);
	});

	// The shared ladder walks `node_modules/.bin` too; the runner's old checker
	// walked the venv dirs only, so an npm-installed project pyright was never
	// selected. Behaviour change named in the PR body.
	it("resolves node_modules/.bin/pyright at the exact cwd once trusted", async () => {
		const bin = plantPyright(nodeModulesBin(workspace.tmpDir));
		setProjectTrustState("untrusted");
		expect((await run()).skipReason).toBe("trust-refused");
		expect(spawnCalls.filter((call) => call.cmd === bin)).toHaveLength(0);

		setProjectTrustState("trusted");
		const result = await run();
		expect(result.status).toBe("succeeded");
		expect(runSpawns().map((call) => call.cmd)).toEqual([bin]);
	});
});
