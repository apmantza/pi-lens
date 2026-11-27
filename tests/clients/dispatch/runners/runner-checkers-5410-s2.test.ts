/**
 * #5410 S2: shellcheck, shfmt, tflint, terragrunt, cue-vet and spellcheck
 * resolve their binary through the registry resolver
 * (`resolveToolCommandWithInstallFallback`) and word a skip through
 * `toolAbsentSkip(cwd, { id })`, each with a `TOOL_COMMAND_SPECS` row and no
 * checker or install pair of its own.
 *
 * Driven through each real runner, the real checker, the real trust seam and
 * the real installer lookups. Only the child process (`safe-spawn`) is
 * doubled; installs stay off through the suite's `PI_LENS_DISABLE_TOOL_INSTALL`
 * default, and the worker's pinned `PI_LENS_HOME` holds no managed binary.
 *
 * Which cells are red before the change: only the `node_modules/.bin` cell of
 * shellcheck (the old checkers walked the venv dirs alone). Every other cell
 * is a characterization test that passes on the old code too, and says so.
 *
 * Recurrence pinned: six private checker instances with their own
 * `windowsExt`, argv and install pair, one per module, that drift apart from
 * the registry row and from each other (#5410's stray availability ladders).
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

const { safeSpawnAsync, spawnCalls, shim } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
	// What every binary on disk does: it answers, or it exits 127.
	const shim: {
		mode: "ok" | "exit127";
		versionArgs: readonly string[];
		cleanStdout: string;
	} = { mode: "ok", versionArgs: ["--version"], cleanStdout: "" };
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
					stderr: `${path.basename(cmd)}: not found`,
				};
			}
			// A real tool answers its own version flag and rejects one it does not
			// know, so a registry row with the wrong `versionArgs` reads as a
			// rejected binary.
			if (JSON.stringify(args) === JSON.stringify(shim.versionArgs)) {
				return { error: null, status: 0, stdout: "1.0.0\n", stderr: "" };
			}
			if (args.length === 1 && /^-{0,2}version$/.test(String(args[0]))) {
				return { error: null, status: 2, stdout: "", stderr: "bad flag" };
			}
			return { error: null, status: 0, stdout: shim.cleanStdout, stderr: "" };
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

interface RunnerCell {
	/** The registry spec id and the runner's own tool id. */
	id: string;
	/** The runner module under `clients/dispatch/runners/`. */
	module: string;
	/** The binary's command name. */
	bin: string;
	versionArgs: readonly string[];
	kind: string;
	fileName: string;
	content: string;
	/** What the tool prints on a clean run. */
	cleanStdout: string;
	/**
	 * The skip reason an absent tool reads. The four whose installer entry
	 * opts in (`autoInstall: true`) read `install-disabled` under the suite's
	 * install kill switch; cue and typos have no opt-in, so they read
	 * `not-installed`: the opt-in each had before is unchanged (#5418).
	 */
	absentReason: "install-disabled" | "not-installed";
}

const CELLS: readonly RunnerCell[] = [
	{
		id: "shellcheck",
		module: "shellcheck",
		bin: "shellcheck",
		versionArgs: ["--version"],
		kind: "shell",
		fileName: "run.sh",
		content: "#!/bin/bash\necho ok\n",
		cleanStdout: "",
		absentReason: "install-disabled",
	},
	{
		id: "shfmt",
		module: "shfmt",
		bin: "shfmt",
		versionArgs: ["--version"],
		kind: "shell",
		fileName: "run.sh",
		content: "#!/bin/bash\necho ok\n",
		cleanStdout: "",
		absentReason: "install-disabled",
	},
	{
		id: "tflint",
		module: "tflint",
		bin: "tflint",
		versionArgs: ["--version"],
		kind: "terraform",
		fileName: "main.tf",
		content: 'variable "a" {}\n',
		cleanStdout: '{"issues":[],"errors":[]}',
		absentReason: "install-disabled",
	},
	{
		id: "terragrunt",
		module: "terragrunt",
		bin: "terragrunt",
		versionArgs: ["--version"],
		kind: "terragrunt",
		fileName: "terragrunt.hcl",
		content: "locals {}\n",
		cleanStdout: "",
		absentReason: "install-disabled",
	},
	{
		id: "cue",
		module: "cue-vet",
		bin: "cue",
		// The CUE CLI has no `--version`; the installer entry probes `version`.
		versionArgs: ["version"],
		kind: "cue",
		fileName: "ok.cue",
		content: "package ok\n\na: 1\n",
		cleanStdout: "",
		absentReason: "not-installed",
	},
	{
		id: "typos",
		module: "spellcheck",
		bin: "typos",
		versionArgs: ["--version"],
		kind: "markdown",
		fileName: "README.md",
		content: "# Title\n\nHello world.\n",
		cleanStdout: "",
		absentReason: "not-installed",
	},
];

/**
 * Plant a file the doubled child process treats as a binary. The launcher
 * extension follows the dir on Windows: `.exe` in a venv `Scripts` (pip),
 * `.cmd` in `node_modules/.bin` (npm).
 */
function plant(dir: string, bin: string, ext: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, process.platform === "win32" ? bin + ext : bin);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

const venvBin = (root: string) =>
	path.join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const nodeModulesBin = (root: string) =>
	path.join(root, "node_modules", ".bin");

const asPlatform = async <T>(
	platform: NodeJS.Platform,
	body: () => Promise<T>,
): Promise<T> => {
	const saved = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	try {
		return await body();
	} finally {
		if (saved) Object.defineProperty(process, "platform", saved);
	}
};

describe.each(CELLS)(
	"$id resolves through the registry resolver (#5410 S2)",
	(cell) => {
		let pathEnv: ReturnType<typeof setupTestEnvironment>;
		let workspace: ReturnType<typeof setupTestEnvironment>;
		let file: string;

		const run = async () => {
			const runner = (
				await import(`../../../../clients/dispatch/runners/${cell.module}.js`)
			).default;
			return runner.run(
				makeRunnerCtx(file, workspace.tmpDir, {
					kind: cell.kind as never,
					pi: { getFlag: (name: string) => name === "no-lsp" } as never,
				}),
			);
		};
		/** Spawns of the tool's own binary, by command basename. */
		const toolSpawns = () =>
			spawnCalls.filter((call) =>
				new RegExp(`(^|[\\\\/])${cell.bin}(\\.cmd|\\.exe)?$`).test(call.cmd),
			);
		const probeSpawns = () =>
			toolSpawns().filter(
				(call) =>
					JSON.stringify(call.args) === JSON.stringify(cell.versionArgs),
			);
		const workSpawns = () =>
			toolSpawns().filter(
				(call) =>
					JSON.stringify(call.args) !== JSON.stringify(cell.versionArgs),
			);

		beforeEach(() => {
			pathEnv = setupTestEnvironment("pi-lens-5410s2-path-");
			workspace = setupTestEnvironment("pi-lens-5410s2-ws-");
			vi.stubEnv("PATH", pathEnv.tmpDir);
			setProjectTrustState("trusted");
			resetDispatchAvailabilityState();
			resetProjectLensConfigCache();
			resetWorkspaceTopology();
			spawnCalls.length = 0;
			shim.mode = "ok";
			shim.versionArgs = cell.versionArgs;
			shim.cleanStdout = cell.cleanStdout;
			safeSpawnAsync.mockClear();
			file = path.join(workspace.tmpDir, cell.fileName);
			fs.writeFileSync(file, cell.content);
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

		// Characterization: passes on the old checker too. One version probe, then
		// the run; a second run reads the latch and probes nothing.
		it("probes a PATH binary once, runs it, and does not probe again", async () => {
			plant(pathEnv.tmpDir, cell.bin, ".exe");
			const first = await run();
			expect(first.status).toBe("succeeded");
			expect(probeSpawns()).toHaveLength(1);
			expect(workSpawns()).toHaveLength(1);
			const second = await run();
			expect(second.status).toBe("succeeded");
			expect(probeSpawns()).toHaveLength(1);
			expect(workSpawns()).toHaveLength(2);
		});

		// Characterization. Recurrence: a binary whose version probe fails is
		// skipped with the cause stated, never run.
		it("skips a PATH binary that exits 127 on its probe, after one spawn", async () => {
			plant(pathEnv.tmpDir, cell.bin, ".exe");
			shim.mode = "exit127";
			const result = await run();
			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe("probe-rejected");
			expect(probeSpawns()).toHaveLength(1);
			expect(workSpawns()).toHaveLength(0);
		});

		// Characterization: the old checkers read the same absence the same way.
		// Pins the install opt-in per tool (#5418): which tools the shared ladder
		// would install is the execution-policy row's decision, unchanged here.
		it(`skips an absent binary as ${cell.absentReason}`, async () => {
			const result = await run();
			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe(cell.absentReason);
			// The PATH rung probes and finds nothing (ENOENT); the tool never runs.
			expect(workSpawns()).toHaveLength(0);
		});

		// Characterization: the venv rung was in the old checker too. The project's
		// own copy at the exact cwd is admitted only while pi trusts the project.
		it("refuses .venv's binary while untrusted, then runs it once trusted", async () => {
			const bin = plant(venvBin(workspace.tmpDir), cell.bin, ".exe");
			setProjectTrustState("untrusted");
			const refused = await run();
			expect(refused.status).toBe("skipped");
			expect(refused.skipReason).toBe("trust-refused");
			expect(spawnCalls.filter((call) => call.cmd === bin)).toHaveLength(0);

			setProjectTrustState("trusted");
			const admitted = await run();
			expect(admitted.status).toBe("succeeded");
			expect(workSpawns().map((call) => call.cmd)).toEqual([bin]);
		});

		// The registry row's `windowsExt`, copied from the old checker's `.exe`. A
		// project's `node_modules/.bin` takes its own `.cmd` first and the row's
		// extension second (a bun-style `.exe` shim), so only the row's value
		// finds this file. It is the installer entry's release launcher.
		it("win32 finds a node_modules/.bin <tool>.exe through the row's windowsExt", async () => {
			const dir = nodeModulesBin(workspace.tmpDir);
			fs.mkdirSync(dir, { recursive: true });
			const bin = path.join(dir, `${cell.bin}.exe`);
			fs.writeFileSync(bin, "x");
			const result = await asPlatform("win32", run);
			expect(result.status).toBe("succeeded");
			expect(workSpawns().map((call) => call.cmd)).toEqual([bin]);
		});

		it("win32 finds a venv Scripts <tool>.exe", async () => {
			const dir = path.join(workspace.tmpDir, ".venv", "Scripts");
			fs.mkdirSync(dir, { recursive: true });
			const bin = path.join(dir, `${cell.bin}.exe`);
			fs.writeFileSync(bin, "x");
			const result = await asPlatform("win32", run);
			expect(result.status).toBe("succeeded");
			expect(workSpawns().map((call) => call.cmd)).toEqual([bin]);
		});
	},
);

// The shared ladder walks `node_modules/.bin` at the exact cwd; the old
// checkers walked the venv dirs alone. Of the six tools, npm ships only
// `shellcheck` (the `shellcheck` wrapper package, bin `shellcheck`). `shfmt` on
// npm is an empty 0.0.1 placeholder with no bin, and `tflint`, `terragrunt`,
// `cue` and `typos` publish no package that ships these CLIs: the rung is in
// the ladder for all six, but a project can only populate it for shellcheck.
describe("shellcheck's npm package binary joins the ladder (#5410 S2)", () => {
	const cell = CELLS[0];
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	let file: string;
	const run = async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/shellcheck.js")
		).default;
		return runner.run(
			makeRunnerCtx(file, workspace.tmpDir, {
				kind: "shell",
				pi: { getFlag: (name: string) => name === "no-lsp" } as never,
			}),
		);
	};

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410s2-npm-path-");
		workspace = setupTestEnvironment("pi-lens-5410s2-npm-ws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		spawnCalls.length = 0;
		shim.mode = "ok";
		shim.versionArgs = cell.versionArgs;
		shim.cleanStdout = cell.cleanStdout;
		safeSpawnAsync.mockClear();
		file = path.join(workspace.tmpDir, cell.fileName);
		fs.writeFileSync(file, cell.content);
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

	// RED before the change: the old checker never looked in node_modules/.bin,
	// so an npm-installed project shellcheck was skipped as absent.
	it("resolves node_modules/.bin/shellcheck at the exact cwd once trusted", async () => {
		const bin = plant(nodeModulesBin(workspace.tmpDir), "shellcheck", ".cmd");
		setProjectTrustState("untrusted");
		const refused = await run();
		expect(refused.skipReason).toBe("trust-refused");
		expect(spawnCalls.filter((call) => call.cmd === bin)).toHaveLength(0);

		setProjectTrustState("trusted");
		const result = await run();
		expect(result.status).toBe("succeeded");
		expect(
			spawnCalls
				.filter((call) => call.cmd === bin && call.args[0] !== "--version")
				.map((call) => call.cmd),
		).toEqual([bin]);
	});

	it("win32 finds node_modules/.bin/shellcheck.cmd, the npm launcher", async () => {
		const dir = nodeModulesBin(workspace.tmpDir);
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "shellcheck.cmd");
		fs.writeFileSync(bin, "x");
		const result = await asPlatform("win32", run);
		expect(result.status).toBe("succeeded");
		expect(
			spawnCalls.filter(
				(call) => call.cmd === bin && call.args[0] !== "--version",
			),
		).toHaveLength(1);
	});
});
