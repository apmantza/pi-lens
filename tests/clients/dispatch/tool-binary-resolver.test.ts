/**
 * #5410: one tool-binary resolver. Two audit probes, run through the real
 * dispatch entry (`dispatchForFile`) and the real runners, the real checker,
 * the real trust seam and the real latency sink. Only the child process
 * (`safe-spawn`) and the network installer (`ensureTool`) are doubled: both
 * are host boundaries.
 *
 * Recurrences pinned:
 * - run-e: yamllint asked its checker, then probed again through
 *   `resolveToolCommandWithInstallFallback`, which kept no memo, so three
 *   dispatches of a yamllint whose `--version` exits 1 spawned the probe 4
 *   times behind 1 decision row.
 * - run-b: the checker cached "missing" per cwd and ignored trust, so a
 *   project venv ruff refused while the project was untrusted stayed skipped
 *   for the rest of the session after pi trusted the project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RunnerRegistry,
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	dispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { resetDispatchAvailabilityState } from "../../../clients/dispatch/runners/utils/runner-helpers.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { setupTestEnvironment } from "../test-utils.js";

const { safeSpawnAsync, spawnCalls } = vi.hoisted(() => {
	const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
	const safeSpawnAsync = vi.fn(
		async (cmd: string, args: readonly string[] = []) => {
			spawnCalls.push({ cmd: String(cmd), args });
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
			// A yamllint whose interpreter is broken: present, rejects `--version`.
			if (path.basename(cmd) === "yamllint") {
				return { error: null, status: 1, stdout: "", stderr: "Traceback\n" };
			}
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "ruff 0.6.0\n", stderr: "" };
			}
			return { error: null, status: 0, stdout: "[]", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls };
});
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));
vi.mock("../../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/installer/index.js")
	>()),
	ensureTool: vi.fn(async () => undefined),
}));

function makeCtx(file: string, root: string) {
	return createDispatchContext(
		file,
		root,
		{ getFlag: () => false },
		new FactStore(),
	);
}

async function decisionRows(tool: string) {
	await flushLatencyLog();
	const logPath = getLatencyLogPath();
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter(
			(row) =>
				row.phase === "availability_decision" && row.metadata?.tool === tool,
		);
}

describe("#5410 one tool-binary resolver through the real dispatcher", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let project: ReturnType<typeof setupTestEnvironment>;
	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410-path-");
		project = setupTestEnvironment("pi-lens-5410-app-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		resetDispatchAvailabilityState();
		spawnCalls.length = 0;
		safeSpawnAsync.mockClear();
		clearCoverageNoticeState();
		clearLatencyReports();
	});
	afterEach(() => {
		pathEnv.cleanup();
		project.cleanup();
		resetProjectTrust();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
	});

	// run-e: a present yamllint that rejects its probe is asked once per
	// session, not once per dispatch plus once more through a memo-less path.
	it("probes a rejected yamllint once over three dispatches, behind one decision row", async () => {
		// The latency sink skips its file write in test mode; the row is read
		// back from the real file.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const bin = path.join(pathEnv.tmpDir, "yamllint");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n");
		fs.chmodSync(bin, 0o755);
		const file = path.join(project.tmpDir, "config.yaml");
		fs.writeFileSync(file, "key: value\n");
		const registry = new RunnerRegistry();
		registry.register(
			(await import("../../../clients/dispatch/runners/yamllint.js")).default,
		);
		const rowsBefore = (await decisionRows("yamllint")).length;
		for (let i = 0; i < 3; i++) {
			await dispatchForFile(
				makeCtx(file, project.tmpDir),
				[{ mode: "all", runnerIds: ["yamllint"] }],
				registry,
			);
		}
		const probes = spawnCalls.filter(
			(call) =>
				path.basename(call.cmd) === "yamllint" &&
				call.args.includes("--version"),
		);
		expect(probes).toHaveLength(1);
		const rows = (await decisionRows("yamllint")).slice(rowsBefore);
		expect(rows.map((row) => row.metadata.verdict)).toEqual(["unavailable"]);
	});

	// run-b: trust granted mid-session reaches the checker's next read.
	it("spawns the project venv ruff once pi trusts the project mid-session", async () => {
		const venvBin = path.join(project.tmpDir, ".venv", "bin");
		fs.mkdirSync(venvBin, { recursive: true });
		const venvRuff = path.join(
			venvBin,
			process.platform === "win32" ? "ruff.exe" : "ruff",
		);
		fs.writeFileSync(venvRuff, "#!/bin/sh\n");
		fs.chmodSync(venvRuff, 0o755);
		fs.writeFileSync(
			path.join(project.tmpDir, "pyproject.toml"),
			"[tool.ruff]\n",
		);
		const file = path.join(project.tmpDir, "main.py");
		fs.writeFileSync(file, "x = 1\n");
		const registry = new RunnerRegistry();
		registry.register(
			(await import("../../../clients/dispatch/runners/ruff.js")).default,
		);
		const dispatch = () =>
			dispatchForFile(
				makeCtx(file, project.tmpDir),
				[{ mode: "all", runnerIds: ["ruff-lint"] }],
				registry,
			);

		setProjectTrustState("untrusted");
		await dispatch();
		expect(spawnCalls.some((call) => call.cmd === venvRuff)).toBe(false);

		setProjectTrustState("trusted");
		await dispatch();
		expect(
			spawnCalls.filter((call) => call.cmd === venvRuff).map((c) => c.args[0]),
		).toEqual(["--version", "check"]);
	});
	// The memo-less fallback the double probe used to run looked for an npm
	// tool's shim in the project's own `node_modules/.bin`; the resolver keeps
	// that rung (trusted, exactly the runner cwd) so folding the pair onto one
	// probe does not drop a project-installed stylelint.
	it("runs a trusted project's node_modules stylelint through the one resolver", async () => {
		setProjectTrustState("trusted");
		const shimDir = path.join(project.tmpDir, "node_modules", ".bin");
		fs.mkdirSync(shimDir, { recursive: true });
		const shim = path.join(
			shimDir,
			process.platform === "win32" ? "stylelint.cmd" : "stylelint",
		);
		fs.writeFileSync(shim, "#!/bin/sh\n");
		fs.chmodSync(shim, 0o755);
		const file = path.join(project.tmpDir, "site.css");
		fs.writeFileSync(file, "a { color: red; }\n");
		const registry = new RunnerRegistry();
		registry.register(
			(await import("../../../clients/dispatch/runners/stylelint.js")).default,
		);
		await dispatchForFile(
			makeCtx(file, project.tmpDir),
			[{ mode: "all", runnerIds: ["stylelint"] }],
			registry,
		);
		expect(
			spawnCalls.filter((call) => call.cmd === shim).map((c) => c.args[0]),
		).toEqual(["--version", "--formatter"]);
	});
});
