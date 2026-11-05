// flake-shape: in-process-mock — launching a candidate binary is the process boundary (`safeSpawnAsync` is answered by a recording double); the installer, the candidate directories and the trust judgment run for real over seeded files under a pinned home.
/**
 * The installer's two global-directory rungs (npm global bin dirs, pip user
 * bases) verify their candidates through ONE loop, `firstVerifiedBinary`.
 * Each cell enters through `getToolPath`, the production entry point, and
 * reads the effect from the spawn boundary: which candidate paths were started,
 * in which order, with which argv and budget, and which one answered.
 *
 * Recurrence guarded: the two rungs carried byte-identical copies of the
 * access / untrusted-project / verify loop (jscpd, 29 lines); a fix to one
 * (the #4776 trust refusal landed in both by hand) could miss the other.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalPiLensDir } from "../../../clients/file-utils.js";
import {
	TOOLS,
	type ToolDefinition,
	getToolPath,
	resetProbeCacheStateForTesting,
} from "../../../clients/installer/index.js";
import { setPlatform } from "../../support/platform-stub.js";
import { withEnv } from "../../support/with-env.js";
import { pinFixtureHome } from "../test-utils.js";

vi.unmock("../../../clients/installer/index.js");

interface SpawnCall {
	command: string;
	args: readonly string[];
	timeout: number | undefined;
}
const harness = vi.hoisted(() => ({
	calls: [] as SpawnCall[],
	/** Spawn paths whose `--version` answer is a nonzero exit. */
	failing: new Set<string>(),
	/** Spawn paths that answer; any other command (npm, python) fails fast. */
	answering: new Set<string>(),
}));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../clients/safe-spawn.js")>();
	return {
		...original,
		safeSpawnAsync: async (
			command: string,
			args: readonly string[],
			options?: { timeout?: number },
		) => {
			harness.calls.push({ command, args, timeout: options?.timeout });
			if (harness.answering.has(command) && !harness.failing.has(command)) {
				return { stdout: "1.0.0\n", stderr: "", status: 0 };
			}
			return { stdout: "", stderr: "", status: 1 };
		},
	};
});

let home: string;
let cleanups: Array<() => void> = [];

function seed(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	harness.answering.add(file);
	return file;
}

/** The candidate spawns the cell made: only paths it seeded, in order. */
function started(): string[] {
	return harness.calls
		.map((call) => call.command)
		.filter((command) => harness.answering.has(command));
}

/**
 * Pin the host to POSIX for a case whose candidates are POSIX-shaped. Both
 * platform reads are pinned: the npm rung discovers through `process.platform`,
 * the pip rung through `installerPlatform()` (`PI_LENS_TEST_PLATFORM`), and each
 * verify spawn reads `installerPlatform()`. Recurrence: the `Unit tests Windows`
 * gate runs this file on win32, where an unpinned case searches `APPDATA/npm`
 * and `Scripts` and reds. The explicit Windows cases pin their own platform.
 */
function pinPosixHost(): void {
	const restorePlatform = process.platform;
	setPlatform("linux");
	cleanups.push(() => setPlatform(restorePlatform));
	cleanups.push(withEnv({ PI_LENS_TEST_PLATFORM: "linux" }));
}

beforeEach(() => {
	harness.calls.length = 0;
	harness.failing.clear();
	harness.answering.clear();
	const pinned = pinFixtureHome("global-bin-seam");
	cleanups.push(pinned.restore);
	home = pinned.home;
	// The installer's last-resort rungs must not see the host's own tools.
	cleanups.push(
		withEnv({ PATH: path.join(home, "empty-path"), APPDATA: undefined }),
	);
	resetProbeCacheStateForTesting();
});

afterEach(() => {
	for (const added of addedTools) TOOLS.splice(TOOLS.indexOf(added), 1);
	addedTools.length = 0;
	for (const cleanup of cleanups.reverse()) cleanup();
	cleanups = [];
});

const addedTools: ToolDefinition[] = [];

/**
 * A registry entry whose verification argv and budget differ from every
 * default, so a seam that hard-codes either one is observable: no shipped npm
 * or pip entry pairs a non-default argv with a non-default budget.
 */
function addTool(strategy: "npm" | "pip", id: string): ToolDefinition {
	const tool: ToolDefinition = {
		id,
		name: id,
		checkCommand: id,
		checkArgs: ["--probe-flag", "-"],
		verificationTimeoutMs: 12_345,
		installStrategy: strategy,
		packageName: id,
	};
	TOOLS.push(tool);
	addedTools.push(tool);
	return tool;
}

describe("npm global bin rung through getToolPath", () => {
	it("answers with the verified candidate and starts it with the registry's argv and budget", async () => {
		pinPosixHost();
		const tool = addTool("npm", "pi-lens-seam-npm-tool");
		const candidate = seed(path.join(home, ".npm-global", "bin", tool.id));

		expect(await getToolPath(tool.id)).toBe(candidate);

		const call = harness.calls.find((entry) => entry.command === candidate);
		expect(call?.args).toEqual(["--probe-flag", "-"]);
		expect(call?.timeout).toBe(12_345);
	});

	it("does not answer with a candidate whose verification exits nonzero", async () => {
		pinPosixHost();
		const candidate = seed(path.join(home, ".npm-global", "bin", "stylelint"));
		harness.failing.add(candidate);

		expect(await getToolPath("stylelint")).toBeUndefined();
		expect(started()).toEqual([candidate]);
	});

	it("tries a Windows .cmd shim before the .exe and falls through a broken shim", async () => {
		const bin = path.join(home, "appdata", "npm");
		cleanups.push(withEnv({ APPDATA: path.join(home, "appdata") }));
		const cmd = seed(path.join(bin, "stylelint.cmd"));
		const exe = seed(path.join(bin, "stylelint.exe"));
		harness.failing.add(cmd);
		const restorePlatform = process.platform;
		setPlatform("win32");
		cleanups.push(() => setPlatform(restorePlatform));

		expect(await getToolPath("stylelint")).toBe(exe);
		expect(started()).toEqual([cmd, exe]);
	});
});

describe("pip user-base rung through getToolPath", () => {
	it("answers with the verified candidate and starts it with the registry's argv and budget", async () => {
		pinPosixHost();
		const tool = addTool("pip", "pi-lens-seam-pip-tool");
		const candidate = seed(
			path.join(getGlobalPiLensDir(), "pip-tools", "bin", tool.id),
		);

		expect(await getToolPath(tool.id)).toBe(candidate);

		const call = harness.calls.find((entry) => entry.command === candidate);
		expect(call?.args).toEqual(["--probe-flag", "-"]);
		expect(call?.timeout).toBe(12_345);
	});

	it("falls through a broken first user base to the next one, in order", async () => {
		pinPosixHost();
		const first = seed(
			path.join(getGlobalPiLensDir(), "pip-tools", "bin", "yamllint"),
		);
		const second = seed(
			path.join(getGlobalPiLensDir(), "pip-user", "bin", "yamllint"),
		);
		harness.failing.add(first);

		expect(await getToolPath("yamllint")).toBe(second);
		expect(started()).toEqual([first, second]);
	});

	it("tries the Windows .exe, then the .cmd, then the bare name", async () => {
		cleanups.push(withEnv({ PI_LENS_TEST_PLATFORM: "win32" }));
		const scripts = path.join(getGlobalPiLensDir(), "pip-tools", "Scripts");
		const exe = seed(path.join(scripts, "yamllint.exe"));
		const cmd = seed(path.join(scripts, "yamllint.cmd"));
		harness.failing.add(exe);

		expect(await getToolPath("yamllint")).toBe(cmd);
		expect(started()).toEqual([exe, cmd]);
	});
});
