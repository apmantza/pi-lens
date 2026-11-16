/**
 * #5410 D8: the prisma-validate runner resolves its binary through the
 * registry resolver (`resolveToolCommandWithInstallFallback`), so the verdict
 * is held in the shared per-cwd latch instead of being probed on every edit.
 *
 * Driven through the real runner, the real checker, the real trust seam, the
 * real package-manager global-bin lookup and the real installer lookups. Only
 * the child process (`safe-spawn`) is doubled; installs stay off through the
 * suite's `PI_LENS_DISABLE_TOOL_INSTALL` default.
 *
 * Recurrence pinned: `resolveLocalFirstAsync` ended in a bare
 * `prisma --version` probe with no memo, so every edit of a `.prisma` file
 * spent a second prisma process start before the validate run, and a probe
 * that timed out or failed sent every later edit to `npx --no prisma`
 * again, never to the shared cooldown.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { _resetPackageManagerCache } from "../../../../clients/package-manager.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, spawnCalls, shim, npmPrefix } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
	// What a prisma on disk does to `--version`: answer, or exit 127.
	const shim: { mode: "ok" | "exit127" } = { mode: "ok" };
	// The `npm config get prefix` answer, so the global-bin lookup is real.
	const npmPrefix: { dir: string | undefined } = { dir: undefined };
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
			if (cmd === "which" || cmd === "where") {
				const found = onPath(String(args[0]));
				return found
					? { error: null, status: 0, stdout: `${found}\n`, stderr: "" }
					: { error: null, status: 1, stdout: "", stderr: "" };
			}
			if (cmd === "npm" && args[0] === "config") {
				return {
					error: null,
					status: 0,
					stdout: `${npmPrefix.dir ?? ""}\n`,
					stderr: "",
				};
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
			if (args.includes("validate")) {
				return { error: null, status: 0, stdout: "", stderr: "" };
			}
			if (shim.mode === "exit127") {
				return { error: null, status: 127, stdout: "", stderr: "no node" };
			}
			// A real prisma answers `--version` and rejects a flag it does not know,
			// so a registry row with the wrong versionArgs reads as a rejected binary.
			if (args[0] !== "--version") {
				return { error: null, status: 2, stdout: "", stderr: "bad flag" };
			}
			return { error: null, status: 0, stdout: "6.16.2\n", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls, shim, npmPrefix };
});
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

/** Plant an executable file the doubled child process treats as a binary. */
function plant(dir: string, name: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(
		dir,
		process.platform === "win32" ? name + ".cmd" : name,
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

describe("prisma-validate resolves through the registry resolver (#5410 D8)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	let file: string;

	const run = async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/prisma-validate.js")
		).default;
		return runner.run(
			makeRunnerCtx(file, workspace.tmpDir, {
				kind: "prisma",
				pi: { getFlag: () => undefined } as never,
			}),
		);
	};
	const versionProbes = () =>
		spawnCalls.filter(
			(call) => call.args[0] === "--version" && /prisma/.test(call.cmd),
		);
	const validateRuns = () =>
		spawnCalls.filter((call) => call.args.includes("validate"));

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410d8-path-");
		workspace = setupTestEnvironment("pi-lens-5410d8-ws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		_resetPackageManagerCache();
		spawnCalls.length = 0;
		shim.mode = "ok";
		npmPrefix.dir = undefined;
		safeSpawnAsync.mockClear();
		file = path.join(workspace.tmpDir, "schema.prisma");
		fs.writeFileSync(file, "model A { id Int @id }\n");
	});
	afterEach(() => {
		pathEnv.cleanup();
		workspace.cleanup();
		resetProjectTrust();
		resetDispatchAvailabilityState();
		_resetPackageManagerCache();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	// Recurrence: the PATH probe had no memo, so three edits cost three probes.
	it("probes a PATH prisma once for repeated edits", async () => {
		plant(pathEnv.tmpDir, "prisma");
		for (let edit = 0; edit < 3; edit++) {
			expect((await run()).status).toBe("succeeded");
		}
		expect(validateRuns()).toHaveLength(3);
		expect(validateRuns()[0].cmd).toBe("prisma");
		expect(versionProbes()).toHaveLength(1);
	});

	// Recurrence: a PATH shim that failed its version check sent every later edit
	// back through the probe and on to `npx --no prisma`.
	it("probes a PATH prisma that exits 127 once, then falls to npx for every edit", async () => {
		plant(pathEnv.tmpDir, "prisma");
		shim.mode = "exit127";
		// `npx` itself must exist for the fallback spawn to start.
		plant(pathEnv.tmpDir, "npx");
		for (let edit = 0; edit < 2; edit++) {
			expect((await run()).status).toBe("succeeded");
		}
		expect(versionProbes()).toHaveLength(1);
		expect(validateRuns().map((call) => call.cmd)).toEqual(["npx", "npx"]);
		expect(validateRuns()[0].args.slice(0, 2)).toEqual(["--no", "prisma"]);
	});

	// Guard: the project's own copy at exactly cwd outranks PATH, and is trust
	// gated like every other project rung.
	it("refuses node_modules/.bin/prisma while untrusted, then runs it once trusted", async () => {
		plant(pathEnv.tmpDir, "prisma");
		const bin = plant(
			path.join(workspace.tmpDir, "node_modules", ".bin"),
			"prisma",
		);
		setProjectTrustState("untrusted");
		expect((await run()).status).toBe("succeeded");
		expect(validateRuns().map((call) => call.cmd)).toEqual(["prisma"]);

		setProjectTrustState("trusted");
		expect((await run()).status).toBe("succeeded");
		expect(validateRuns().map((call) => call.cmd)).toEqual(["prisma", bin]);
	});

	// Guard: the manager-global rung survives the move. A prisma installed with
	// a global manager and off PATH still runs, by its path.
	it("runs a prisma from a package manager's global bin dir when PATH has none", async () => {
		plant(pathEnv.tmpDir, "npm");
		const prefix = path.join(workspace.tmpDir, "npm-prefix");
		npmPrefix.dir = prefix;
		const globalBin = plant(path.join(prefix, "bin"), "prisma");
		expect((await run()).status).toBe("succeeded");
		expect(validateRuns().map((call) => call.cmd)).toEqual([globalBin]);
	});
	// Pins the order the move changed (review F3): the project's own copy, then
	// PATH, then a package manager's global bin dir. The old code asked the
	// global dir before PATH. Untrusted, the project rung is refused, so PATH must
	// beat the global copy; trusted, the project's own copy wins over both.
	it("prefers the project copy, then PATH, then the manager-global copy", async () => {
		plant(pathEnv.tmpDir, "prisma");
		plant(pathEnv.tmpDir, "npm");
		const prefix = path.join(workspace.tmpDir, "npm-prefix");
		npmPrefix.dir = prefix;
		const globalBin = plant(path.join(prefix, "bin"), "prisma");
		const localBin = plant(
			path.join(workspace.tmpDir, "node_modules", ".bin"),
			"prisma",
		);
		setProjectTrustState("untrusted");
		await run();
		setProjectTrustState("trusted");
		await run();
		expect(validateRuns().map((call) => call.cmd)).toEqual([
			"prisma",
			localBin,
		]);
		expect(validateRuns().map((call) => call.cmd)).not.toContain(globalBin);
	});
});
