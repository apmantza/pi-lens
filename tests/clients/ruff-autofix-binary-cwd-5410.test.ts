/**
 * #5410: the ruff autofix client resolves its binary at the cwd the lint
 * runner uses, not at `process.cwd()`.
 *
 * Driven through the production entry (`runAutofix`, the real `RuffClient`),
 * the real checker, the real trust seam and the real installer lookups. Only
 * the child process (`safe-spawn`) is doubled; installs stay off through the
 * suite's `PI_LENS_DISABLE_TOOL_INSTALL` default.
 *
 * Recurrences pinned:
 * - `RuffClient.ensureAvailable()` probed `process.cwd()` and kept the answer
 *   in `ruffCommand`, so a package whose own `.venv` carried the only ruff
 *   (the one `ruff-lint` runs, exactly-cwd rule #2544 r4 F2) read "ruff
 *   unavailable" for autofix, and a second package ran the first package's
 *   ruff once any answer was stored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RunnerRegistry,
	createDispatchContext,
	dispatchForFile,
} from "../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { resetDispatchAvailabilityState } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import { runAutofix } from "../../clients/pipeline.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { RuffClient } from "../../clients/ruff-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const { safeSpawnAsync, spawnCalls } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
	const safeSpawnAsync = vi.fn(
		async (
			cmd: string,
			args: readonly string[] = [],
			opts: { cwd?: string } = {},
		) => {
			spawnCalls.push({ cmd: String(cmd), args, cwd: opts.cwd });
			const fs = await import("node:fs");
			const path = await import("node:path");
			const onDisk = path.isAbsolute(cmd)
				? fs.existsSync(cmd)
				: (process.env.PATH ?? "")
						.split(path.delimiter)
						.some((dir) => dir && fs.existsSync(path.join(dir, cmd)));
			if (!onDisk) {
				return {
					error: new Error(`spawn ${cmd} ENOENT`),
					status: null,
					stdout: "",
					stderr: "",
					spawnFailure: { kind: "tool-not-found" },
				};
			}
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "ruff 0.6.0\n", stderr: "" };
			}
			return { error: null, status: 0, stdout: "[]", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls };
});
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

function plantPackage(
	root: string,
	name: string,
): { file: string; ruff: string } {
	const pkg = path.join(root, name);
	const bin = path.join(pkg, ".venv", "bin");
	fs.mkdirSync(bin, { recursive: true });
	const ruff = path.join(
		bin,
		process.platform === "win32" ? "ruff.exe" : "ruff",
	);
	fs.writeFileSync(ruff, "#!/bin/sh\n");
	fs.chmodSync(ruff, 0o755);
	fs.writeFileSync(path.join(pkg, "pyproject.toml"), "[tool.ruff]\n");
	const file = path.join(pkg, "main.py");
	fs.writeFileSync(file, "x = 1\n");
	return { file, ruff };
}

describe("ruff autofix resolves its binary at the runner's cwd (#5410)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410-ruffpath-");
		workspace = setupTestEnvironment("pi-lens-5410-ruffws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		spawnCalls.length = 0;
		dbgLines.length = 0;
		safeSpawnAsync.mockClear();
	});
	afterEach(() => {
		pathEnv.cleanup();
		workspace.cleanup();
		resetProjectTrust();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
	});

	const dbgLines: string[] = [];
	const autofix = (file: string, cwd: string, ruffClient: RuffClient) =>
		runAutofix(
			file,
			cwd,
			() => false,
			(line: string) => dbgLines.push(line),
			{ ruffClient, biomeClient: {} as never, fixedThisTurn: new Set() },
		);

	// The lint runner finds a package's own venv ruff through the exactly-cwd
	// rule; autofix asked `process.cwd()` (the workspace root, no ruff) and
	// skipped the file as "ruff unavailable".
	it("runs the package's own venv ruff although process.cwd() holds none", async () => {
		const pkg = plantPackage(workspace.tmpDir, "pkg-a");
		await autofix(pkg.file, path.dirname(pkg.file), new RuffClient());
		expect(dbgLines.join("\n")).not.toContain("ruff unavailable");
		expect(
			spawnCalls
				.filter((call) => call.cmd === pkg.ruff)
				.map((call) => call.args.slice(0, 2).join(" ")),
		).toContain("check --fix");
	});

	// The dispatch cwd can be the workspace root while resolveToolCwd selects a
	// nested package. The pre-check must use the latter or autofix skips a ruff
	// that the lint runner can execute (review probe A, #5519).
	it("uses the nested package ruff when dispatch starts at the workspace root", async () => {
		fs.writeFileSync(
			path.join(workspace.tmpDir, "pyproject.toml"),
			"[tool.ruff]\n",
		);
		const pkg = plantPackage(workspace.tmpDir, "pkg-a");
		await autofix(pkg.file, workspace.tmpDir, new RuffClient());
		expect(dbgLines.join("\n")).not.toContain("ruff unavailable");
		expect(
			spawnCalls
				.filter((call) => call.cmd === pkg.ruff)
				.map((call) => call.args.slice(0, 2).join(" ")),
		).toContain("check --fix");
		// The fix spawns at the package root resolveToolCwd selects, not at the
		// dispatch cwd it was handed: a fix run at the workspace root reads the
		// root config and `ruffConfigArgs` of the wrong tree (#2894 shape, review
		// V2, #5519 r2). The pre-resolved command path carries the dispatch cwd.
		const fixCwds = spawnCalls
			.filter((call) => call.cmd === pkg.ruff && call.args.includes("--fix"))
			.map((call) => call.cwd);
		expect(fixCwds).toEqual([path.dirname(pkg.file)]);
	});

	// Keep the unavailable branch observable: a missing command must skip the
	// write and report the bounded debug record, not reach the fixer with null.
	it("records and skips when no Ruff command resolves", async () => {
		fs.writeFileSync(
			path.join(workspace.tmpDir, "pyproject.toml"),
			"[tool.ruff]\n",
		);
		const pkg = path.join(workspace.tmpDir, "pkg-a");
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, "pyproject.toml"), "[tool.ruff]\n");
		const file = path.join(pkg, "main.py");
		fs.writeFileSync(file, "x = 1\n");
		await autofix(file, workspace.tmpDir, new RuffClient());
		expect(dbgLines.join("\n")).toContain("ruff unavailable");
		expect(
			spawnCalls.filter((call) => call.args.includes("--fix")),
		).toHaveLength(0);
		expect(
			await new RuffClient().fixFileAsync(file, workspace.tmpDir, null),
		).toMatchObject({ success: false, error: "Ruff not available" });
	});

	// One RuffClient serves every package of a session, and a ruff on PATH is
	// what `process.cwd()` resolves to: it must not stand in for the venv ruff
	// each package's lint runs.
	it("runs each package's own venv ruff through one client, ahead of PATH ruff", async () => {
		const onPath = path.join(pathEnv.tmpDir, "ruff");
		fs.writeFileSync(onPath, "#!/bin/sh\n");
		fs.chmodSync(onPath, 0o755);
		const a = plantPackage(workspace.tmpDir, "pkg-a");
		const b = plantPackage(workspace.tmpDir, "pkg-b");
		const client = new RuffClient();
		await autofix(a.file, path.dirname(a.file), client);
		await autofix(b.file, path.dirname(b.file), client);
		const fixCalls = spawnCalls
			.filter((call) => call.args.includes("--fix"))
			.map((call) => call.cmd);
		expect(fixCalls).toEqual([a.ruff, b.ruff]);
	});

	// The runner and the fix ask one checker, so the venv ruff is probed once
	// per session, not once per consumer.
	it("probes the package's venv ruff once across the lint runner and the fix", async () => {
		const pkg = plantPackage(workspace.tmpDir, "pkg-a");
		const cwd = path.dirname(pkg.file);
		const registry = new RunnerRegistry();
		registry.register(
			(await import("../../clients/dispatch/runners/ruff.js")).default,
		);
		await dispatchForFile(
			createDispatchContext(
				pkg.file,
				cwd,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: ["ruff-lint"] }],
			registry,
		);
		expect(
			spawnCalls.filter(
				(call) => call.cmd === pkg.ruff && call.args.includes("--version"),
			),
		).toHaveLength(1);
		await autofix(pkg.file, cwd, new RuffClient());
		const probes = spawnCalls.filter(
			(call) => call.cmd === pkg.ruff && call.args.includes("--version"),
		);
		expect(probes).toHaveLength(1);
		expect(
			spawnCalls.some(
				(call) => call.cmd === pkg.ruff && call.args.includes("--fix"),
			),
		).toBe(true);
	});
});
