// flake-shape: in-process-mock — tool availability is stubbed so the argv case
// never probes or installs ruff, and the spawn boundary is doubled to record the
// argv it was given; `resolveToolCwd` and `ruffConfigArgs` run for real.
/**
 * #4638 ticket 02: ruff's fix pre-check and its `--fix` pass must parse at the
 * same syntax level, and neither may override `target-version`: ruff discovers
 * it from the project config, so a flag here is a second owner of a decision
 * the lint runner already makes.
 *
 * The spawn seam is mocked (a documented process boundary), so the assertion is
 * about the real argv the client builds — `resolveToolCwd` and
 * `ruffConfigArgs` run for real over a fixture tree.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
	command: string;
	args: string[];
	options: { cwd?: string };
}

const hoisted = vi.hoisted(() => ({
	calls: [] as SpawnCall[],
}));

// #2281: a whole-module mock must re-export every production export, so the
// actual module is spread in and only the process boundary is replaced.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync: vi.fn(
		async (command: string, args: string[], options: { cwd?: string }) => {
			hoisted.calls.push({ command, args, options });
			return { stdout: "", stderr: "", error: undefined };
		},
	),
}));

const spawnCalls = hoisted.calls;
vi.mock(
	"../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: vi.fn(() => ({
			isAvailableAsync: vi.fn(async () => true),
			getCommand: vi.fn(() => "/fake/ruff"),
		})),
		resolveAvailableOrInstall: vi.fn(async () => "/fake/ruff"),
	}),
);

import { RuffClient } from "../../clients/ruff-client.js";
import { removeTempDirSync } from "../clients/test-utils.js";

let cwd: string;

function write(relativePath: string, content: string): string {
	const target = path.join(cwd, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

const PYPROJECT_312 =
	'[project]\nname = "demo"\nrequires-python = ">=3.12"\n[tool.ruff]\ntarget-version = "py312"\n';

/** The pre-check's config slice: everything between the mode flags and the file. */
function preCheckConfigArgs(call: SpawnCall, filePath: string): string[] {
	const args = [...call.args];
	expect(args.slice(0, 5)).toEqual([
		"check",
		"--no-fix",
		"--no-fix-only",
		"--output-format",
		"json",
	]);
	expect(args.at(-1)).toBe(filePath);
	return args.slice(5, -1);
}

/** The fix pass's config slice: everything between its mode flag and the file. */
function fixConfigArgs(call: SpawnCall, filePath: string): string[] {
	const args = [...call.args];
	expect(args.slice(0, 2)).toEqual(["check", "--fix"]);
	expect(args.at(-1)).toBe(filePath);
	return args.slice(2, -1);
}

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4638-ruff-argv-"));
	spawnCalls.length = 0;
});

afterEach(() => {
	removeTempDirSync(cwd);
});

describe("ruff pre-check and --fix agree on the project's syntax level (#4638)", () => {
	it("passes no target-version override under a py312 project", async () => {
		write("pyproject.toml", PYPROJECT_312);
		const filePath = write("app.py", "import os\n");

		await new RuffClient().fixFileAsync(filePath, cwd);

		expect(spawnCalls).toHaveLength(2);
		const [pre, fix] = spawnCalls as [SpawnCall, SpawnCall];
		for (const call of [pre, fix]) {
			expect(call.args).not.toContain("--target-version");
			expect(call.args).not.toContain("py310");
			expect(call.options.cwd).toBe(cwd);
		}
		expect(preCheckConfigArgs(pre, filePath)).toEqual(
			fixConfigArgs(fix, filePath),
		);
	});

	it("passes no target-version override when the project has no ruff config", async () => {
		const filePath = write("app.py", "import os\n");

		await new RuffClient().fixFileAsync(filePath, cwd);

		expect(spawnCalls).toHaveLength(2);
		const [pre, fix] = spawnCalls as [SpawnCall, SpawnCall];
		expect(pre.args).not.toContain("--target-version");
		expect(fix.args).not.toContain("--target-version");
		expect(preCheckConfigArgs(pre, filePath)).toEqual(
			fixConfigArgs(fix, filePath),
		);
	});

	it("runs both passes in the nested project's own root", async () => {
		write("pyproject.toml", '[project]\nname = "outer"\n');
		const nested = path.join(cwd, "pkg");
		write(
			"pkg/pyproject.toml",
			'[project]\nname = "inner"\n[tool.ruff]\ntarget-version = "py39"\n',
		);
		const filePath = write("pkg/app.py", "import os\n");

		await new RuffClient().fixFileAsync(filePath, cwd);

		expect(spawnCalls).toHaveLength(2);
		const [pre, fix] = spawnCalls as [SpawnCall, SpawnCall];
		for (const call of [pre, fix]) {
			expect(call.options.cwd).toBe(nested);
			expect(call.args).not.toContain("--target-version");
			expect(call.args).not.toContain("py39");
		}
		expect(preCheckConfigArgs(pre, filePath)).toEqual(
			fixConfigArgs(fix, filePath),
		);
	});
});
