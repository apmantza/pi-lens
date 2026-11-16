/**
 * #5410 r2 (review F4): the oxlint runner resolves Vite+'s `vp` through the
 * registry resolver (`resolveToolCommandWithInstallFallback`), so the PATH
 * probe is held in the shared per-cwd latch instead of repeating on every edit.
 *
 * Driven through the real runner, the real checker and the real trust seam.
 * Only the child process (`safe-spawn`) is doubled.
 *
 * Recurrence pinned: `resolveVitePlusCommand` ended in a bare `vp --version`
 * with no memo, so three edits of a Vite+ project spent three probes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, spawnCalls, shim } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
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
			const onDisk = path.isAbsolute(cmd)
				? fs.existsSync(cmd)
				: onPath(cmd) !== undefined;
			if (!onDisk) {
				return {
					error: new Error("spawn " + cmd + " ENOENT"),
					status: null,
					stdout: "",
					stderr: "",
					spawnFailure: { kind: "tool-not-found" },
				};
			}
			if (args[0] === "lint" || args.includes("--format")) {
				return { error: null, status: 0, stdout: "", stderr: "" };
			}
			if (shim.mode === "exit127") {
				return { error: null, status: 127, stdout: "", stderr: "no node" };
			}
			// A real vp answers `--version` and rejects a flag it does not know, so a
			// registry row with the wrong versionArgs reads as a rejected binary.
			if (args[0] !== "--version") {
				return { error: null, status: 2, stdout: "", stderr: "bad flag" };
			}
			return { error: null, status: 0, stdout: "vp 0.1.0\n", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls, shim };
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

describe("oxlint resolves vp through the registry resolver (#5410 F4)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	let file: string;

	const run = async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/oxlint.js")
		).default;
		return runner.run(makeRunnerCtx(file, workspace.tmpDir) as never);
	};
	const vpProbes = () =>
		spawnCalls.filter(
			(call) =>
				call.args[0] === "--version" && /(^|[\\/])vp(\.cmd)?$/.test(call.cmd),
		);
	const vpLints = () => spawnCalls.filter((call) => call.args[0] === "lint");

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410f4-path-");
		workspace = setupTestEnvironment("pi-lens-5410f4-ws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		spawnCalls.length = 0;
		shim.mode = "ok";
		safeSpawnAsync.mockClear();
		file = path.join(workspace.tmpDir, "sample.ts");
		fs.writeFileSync(file, "console.log('hi')\n");
		fs.writeFileSync(
			path.join(workspace.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
		);
	});
	afterEach(() => {
		pathEnv.cleanup();
		workspace.cleanup();
		resetProjectTrust();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	// Recurrence: the PATH probe had no memo, so three edits cost three probes.
	it("probes a PATH vp once for repeated edits", async () => {
		plant(pathEnv.tmpDir, "vp");
		for (let edit = 0; edit < 3; edit++) await run();
		expect(vpLints()).toHaveLength(3);
		expect(vpLints()[0].cmd).toBe("vp");
		expect(vpProbes()).toHaveLength(1);
	});

	// Recurrence: a vp that failed its version check was probed again on every edit.
	it("probes a PATH vp that exits 127 once, then lints with oxlint for every edit", async () => {
		plant(pathEnv.tmpDir, "vp");
		plant(pathEnv.tmpDir, "oxlint");
		shim.mode = "exit127";
		for (let edit = 0; edit < 2; edit++) await run();
		expect(vpProbes()).toHaveLength(1);
		expect(vpLints()).toHaveLength(0);
	});

	// Guard: the project's own vp outranks PATH and needs no probe.
	it("runs node_modules/.bin/vp from the package without a probe", async () => {
		plant(pathEnv.tmpDir, "vp");
		const bin = plant(
			path.join(workspace.tmpDir, "node_modules", ".bin"),
			"vp",
		);
		await run();
		expect(vpLints().map((call) => call.cmd)).toEqual([bin]);
		expect(vpProbes()).toHaveLength(0);
	});
});
