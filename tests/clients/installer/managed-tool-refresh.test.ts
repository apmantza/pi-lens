/**
 * Periodic refresh of pi-lens's managed npm tools (#1730).
 *
 * `~/.pi-lens/tools/package.json` records `"knip": "^6.4.1"`, which permits
 * 6.32.2, but the lockfile written at first install pinned 6.4.1 and nothing
 * ever re-resolved it. The managed knip produced 62 unused-export findings on a
 * tree its own project's knip reported clean. All 22 managed entries drift the
 * same way.
 *
 * These tests pin the policy, not just the happy path:
 *   - a stale stamp triggers exactly ONE refresh attempt;
 *   - a fresh stamp triggers none;
 *   - a failed refresh degrades once, keeps the installed version serving, and
 *     comes back on the shorter retry cooldown rather than every session;
 *   - the session budget re-arms per session, never per process;
 *   - an UNREADABLE stamp file is not "everything is fresh" and not
 *     "everything is stale" — it refreshes nothing and says so;
 *   - a version that moves emits an old → new row.
 *
 * `safeSpawnAsync` is mocked so spawn ATTEMPTS can be counted exactly; every
 * other seam (the durable-store stamp, the node_modules fixtures, the cadence
 * arithmetic) runs for real against a temp `PI_LENS_HOME`.
 */

import * as fs from "node:fs";

import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { exploreInterleavings } from "../../support/reset-explorer.js";
import { fireResetAt } from "../../support/fault-injection.js";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-1730-"),
	);
	// TOOLS_DIR is a module-level const, so the override must land before the
	// installer module is imported.
	process.env.PI_LENS_HOME = dir;
	return dir;
});

const { spawnMock, sessionLogSpy, shimExitCodes } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	sessionLogSpy: vi.fn(),
	shimExitCodes: new Map<string, number>(),
}));

vi.mock("../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	// #2015: verifyToolBinary probes route through safe-spawn too. Answer
	// --version probes centrally from the fixture exit-code map; everything
	// else delegates to the scenario-controlled spawnMock.
	safeSpawnAsync: async (command: string, args: string[]) => {
		if (args?.includes("--version")) {
			const name = path
				.basename(String(command))
				.replace(/\.(cmd|exe|ps1)$/i, "");
			const code = shimExitCodes.get(name) ?? 0;
			return {
				stdout: code === 0 ? "9.9.9\n" : "",
				stderr: "",
				status: code,
			};
		}
		return spawnMock(command, args);
	},
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLogSpy,
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
	SESSIONSTART_LOG_FILE: "",
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	checkProbeCache,
	getRefreshableManagedNpmTools,
	installTool,
	resetProbeCacheStateForTesting,
	TOOLS,
	updateProbeCache,
} from "../../../clients/installer/index.js";
import {
	getManagedToolRefreshStatePath,
	readManagedToolRefreshState,
	runManagedToolRefresh,
	runManagedToolRefreshForExploration,
	stampManagedToolInstalled,
} from "../../../clients/installer/managed-tool-refresh.js";
import {
	managedToolRefreshesThisSession,
	reserveManagedToolRefreshSlot,
	resetManagedToolRefreshSession,
} from "../../../clients/installer/managed-tool-refresh-session.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const NODE_MODULES = path.join(TOOLS_DIR, "node_modules");
const STATE_PATH = getManagedToolRefreshStatePath();
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const IS_WINDOWS = process.platform === "win32";

/**
 * A real, runnable `node_modules/.bin` shim. `verifyToolBinary` spawns the
 * binary for real (through `node:child_process`, not the mocked safe-spawn
 * seam), so the post-update verification #1746 review F2 asks for can only be
 * exercised against something the OS can actually execute.
 * (#2015: --version probes now route through the safe-spawn mock, which
 * answers them from the hoisted shimExitCodes map above.)
 */

function installBinShim(binaryName: string, exitCode = 0): void {
	const binDir = path.join(NODE_MODULES, ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	shimExitCodes.set(binaryName, exitCode);
	if (IS_WINDOWS) {
		fs.writeFileSync(
			path.join(binDir, `${binaryName}.cmd`),
			`@echo off\r\necho 9.9.9\r\nexit /b ${exitCode}\r\n`,
		);
		return;
	}
	const shimPath = path.join(binDir, binaryName);
	fs.writeFileSync(shimPath, `#!/bin/sh\necho 9.9.9\nexit ${exitCode}\n`);
	fs.chmodSync(shimPath, 0o755);
}

/**
 * Install a fake managed package at `version`, as npm would leave it: the
 * package tree AND a runnable bin shim.
 */
function installFixture(
	packageName: string,
	version: string,
	options: { binaryName?: string; shimExitCode?: number } = {},
): void {
	const dir = path.join(NODE_MODULES, packageName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: packageName, version }),
	);
	installBinShim(options.binaryName ?? packageName, options.shimExitCode ?? 0);
}

function installedVersion(packageName: string): string | undefined {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(NODE_MODULES, packageName, "package.json"),
				"utf-8",
			),
		).version;
	} catch {
		return undefined;
	}
}

function writeState(tools: Record<string, unknown>): void {
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 1, tools }, null, 2));
}

function readState(): Record<
	string,
	{ checkedAt: number; version?: string; failed?: boolean }
> {
	return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).tools;
}

/** Spawn calls that are an actual package-manager update, not a `where` probe. */
function updateCalls(): Array<{ command: string; args: string[] }> {
	return spawnMock.mock.calls
		.map(([command, args]) => ({ command, args: args ?? [] }))
		.filter(
			(call: { command: string; args: string[] }) =>
				call.args.includes("update") || call.args.includes("upgrade"),
		);
}

/**
 * Answer the package-manager availability probe, then answer the update with
 * `outcome`. `bump` is the version the update leaves behind on success.
 */
function stubSpawn(
	outcome: "ok" | "fail",
	bump?: Record<string, string>,
): void {
	spawnMock.mockImplementation(async (_command: string, args: string[]) => {
		if (args.includes("--version")) {
			const name = path
				.basename(String(_command))
				.replace(/\.(cmd|exe|ps1)$/i, "");
			const code = shimExitCodes.get(name) ?? 0;
			return {
				stdout: code === 0 ? "9.9.9" : "",
				stderr: "",
				status: code,
			};
		}
		if (!args.includes("update") && !args.includes("upgrade")) {
			// `where npm` / `which npm`
			return { stdout: "npm", stderr: "", status: 0 };
		}
		if (outcome === "fail") {
			return {
				stdout: "",
				stderr: "npm error network ETIMEDOUT registry.npmjs.org",
				status: 1,
			};
		}
		for (const [pkg, version] of Object.entries(bump ?? {})) {
			installFixture(pkg, version);
		}
		return { stdout: "", stderr: "", status: 0 };
	});
}

function logRows(): string[] {
	return sessionLogSpy.mock.calls.map(([message]) => String(message));
}

function degradationCount(): number {
	return (
		getDegradationSummary().find((g) => g.kind === "managed-tool-refresh")
			?.count ?? 0
	);
}

let restoreDisableToolInstall: () => void;

beforeEach(() => {
	fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
	fs.mkdirSync(NODE_MODULES, { recursive: true });
	shimExitCodes.clear();
	spawnMock.mockReset();
	sessionLogSpy.mockReset();
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	// The probe cache is module state shared with the installer; a leaked entry
	// would let the F2 invalidation test pass on a stale answer.
	resetProbeCacheStateForTesting();
	delete process.env.PI_LENS_DISABLE_TOOL_REFRESH;
	delete process.env.PI_LENS_TOOL_REFRESH_MAX_PER_SESSION;
	delete process.env.PI_LENS_TOOL_REFRESH_INTERVAL_MS;
	delete process.env.PI_LENS_TOOL_REFRESH_RETRY_MS;
	// `vitest.config.*` defaults this to "1" globally so an ordinary test run
	// can never trigger a real install. `refreshNpmOne` now honors that same
	// kill switch through `acquireManagedInstallGate` (#1759 review R2), and
	// this whole file deliberately exercises the npm refresh-and-spawn path
	// against a mocked `safeSpawnAsync` — so it opts back in, the same way
	// `managed-tool-refresh-strategies.test.ts` already does.
	restoreDisableToolInstall = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
});

afterEach(() => {
	restoreDisableToolInstall();
	delete process.env.PI_LENS_INSTALL_LOCK_TIMEOUT_MS;
	resetProjectTrust();
	vi.unstubAllEnvs();
});

afterAll(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("refresh candidate selection", () => {
	it("derives candidates from the tool registry, not a hand-kept list", () => {
		const candidates = getRefreshableManagedNpmTools();
		const ids = candidates.map((c) => c.toolId);
		expect(ids).toContain("knip");
		expect(ids).toContain("pyright");
		// An explicit `pkg@1.2.3` pin is the intended version; #589 already
		// reinstalls a managed copy that drifts off one, so it must not be
		// re-resolved here.
		expect(candidates.every((c) => !/[^@]@\d/.test(c.packageName))).toBe(true);
	});

	it("every refreshable npm tool declares the binary the refresh verifies", () => {
		// A refresh verifies `node_modules/.bin/<binaryName>` after the update, so
		// an npm entry without a `binaryName` cannot be verified and is skipped.
		// No such entry exists today, which is why the skip itself is a type
		// narrowing rather than a live branch. THIS is the guard with teeth: it
		// fails the day someone adds an unverifiable npm tool, instead of that
		// tool silently dropping out of the refresh population.
		const npmEntries = TOOLS.filter(
			(t) => t.installStrategy === "npm" && t.packageName,
		);
		expect(npmEntries.filter((t) => !t.binaryName).map((t) => t.id)).toEqual(
			[],
		);
		expect(
			getRefreshableManagedNpmTools().every((c) => c.binaryName.length > 0),
		).toBe(true);
	});

	it("ignores registry entries that are not installed in the managed tree", async () => {
		stubSpawn("ok");
		// Nothing installed at all.
		const outcome = await runManagedToolRefresh(NOW);
		expect(outcome.skipped).toBe("no-candidates");
		expect(updateCalls()).toHaveLength(0);
	});
});

describe("cadence", () => {
	it("refreshes a tool whose stamp is older than the interval", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
		expect(updateCalls()[0].args).toContain("knip");
		expect(outcome.refreshed).toHaveLength(1);
		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "knip",
			previousVersion: "6.4.1",
			currentVersion: "6.32.2",
			changed: true,
			ok: true,
		});
		expect(readState().knip).toMatchObject({
			checkedAt: NOW,
			version: "6.32.2",
		});
	});

	it("refreshes a tool that has never been stamped", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});

	it("refreshes nothing when every stamp is fresh", async () => {
		installFixture("knip", "6.32.2");
		installFixture("pyright", "1.1.400");
		writeState({
			knip: { checkedAt: NOW - DAY_MS, version: "6.32.2" },
			pyright: { checkedAt: NOW - 2 * DAY_MS, version: "1.1.400" },
		});
		stubSpawn("ok");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(updateCalls()).toHaveLength(0);
	});

	it("spawns at most one update per session even with many stale tools", async () => {
		for (const pkg of ["knip", "pyright", "oxlint", "madge"]) {
			installFixture(pkg, "1.0.0");
		}
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});

	it("takes the oldest stamp first so no tool starves", async () => {
		installFixture("knip", "1.0.0");
		installFixture("pyright", "1.0.0");
		writeState({
			knip: { checkedAt: NOW - 9 * DAY_MS },
			pyright: { checkedAt: NOW - 40 * DAY_MS },
		});
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()[0].args).toContain("pyright");
	});

	it("breaks a stamp tie on tool id so the choice is deterministic", async () => {
		installFixture("knip", "1.0.0");
		installFixture("pyright", "1.0.0");
		writeState({
			knip: { checkedAt: NOW - 9 * DAY_MS },
			pyright: { checkedAt: NOW - 9 * DAY_MS },
		});
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		// Identical stamps: without the tie-break the winner is whatever order
		// the registry happens to list, which changes when a tool is added.
		expect(updateCalls()[0].args).toContain("knip");
	});
});

describe("update command", () => {
	it("skips lifecycle scripts for an ordinary package", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()[0].args).toContain("--ignore-scripts");
	});

	it("keeps lifecycle scripts for a package that needs its postinstall", async () => {
		// biome downloads its native binary in postinstall. Updating it with
		// --ignore-scripts moves the JS launcher and leaves the old binary.
		installFixture("@biomejs/biome", "1.0.0", { binaryName: "biome" });
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		expect(updateCalls()[0].args).toContain("@biomejs/biome");
		expect(updateCalls()[0].args).not.toContain("--ignore-scripts");
	});
});

describe("session budget", () => {
	it("declines a second refresh inside the same session", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);
		const second = await runManagedToolRefresh(NOW);

		expect(second.skipped).toBe("session-budget");
		expect(updateCalls()).toHaveLength(1);
	});

	it("re-arms at the next session instead of latching for the process", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);
		expect(updateCalls()).toHaveLength(1);

		// The seam `handleSessionStart` calls. No process restart.
		resetManagedToolRefreshSession();

		await runManagedToolRefresh(NOW);
		expect(updateCalls()).toHaveLength(2);
	});

	it("keeps the budget reset reachable from handleSessionStart", () => {
		// The re-arm above is only worth anything if session_start actually runs
		// it. `session-state-conformance.test.ts` derives the reachable set from
		// runtime-session.ts and checks the registry entry against it; this
		// assertion is the local, readable half of the same claim.
		const runtimeSession = fs.readFileSync(
			path.join(process.cwd(), "clients", "runtime-session.ts"),
			"utf-8",
		);
		expect(runtimeSession).toContain("resetManagedToolRefreshSession();");
	});
});

describe("failed refresh", () => {
	it("degrades once, keeps serving, and retries on the shorter cooldown", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("fail");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		// The installed copy is untouched — availability never depends on the
		// refresh succeeding.
		expect(installedVersion("knip")).toBe("6.4.1");

		const groups = getDegradationSummary();
		const group = groups.find((g) => g.kind === "managed-tool-refresh");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].subject).toBe("knip");

		const stamp = readState().knip;
		expect(stamp.failed).toBe(true);
		expect(stamp.checkedAt).toBe(NOW);

		// A day later it is due again (retry cooldown), where a success would
		// have held for a week.
		resetDegradationLedger();
		resetManagedToolRefreshSession();
		spawnMock.mockClear();
		stubSpawn("fail");
		await runManagedToolRefresh(NOW + DAY_MS + 1);
		expect(updateCalls()).toHaveLength(1);
	});

	it("does not record the same failing tool twice in one session", async () => {
		installFixture("knip", "6.4.1");
		vi.stubEnv("PI_LENS_TOOL_REFRESH_MAX_PER_SESSION", "2");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);
		resetManagedToolRefreshSession();
		await runManagedToolRefresh(NOW + 2 * DAY_MS);

		const group = getDegradationSummary().find(
			(g) => g.kind === "managed-tool-refresh",
		);
		expect(group?.count).toBe(1);
	});

	it("does not hand a failing tool's budget slot to the next candidate", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});
});

/**
 * #1746 review F1. `remainingSessionBudget()` used to be read BEFORE two
 * `await`s and the attempt counted after them, so two overlapping runs both saw
 * a free slot and both spawned `npm update` for the same package into the same
 * unlocked managed `node_modules`. `scheduleManagedToolRefresh` arms on every
 * `handleSessionStart` and an `npm update` easily outlives a 30s session gap,
 * so the overlap is the ordinary case, not a contrived one.
 */
describe("concurrent runs (review F1)", () => {
	/** Hold the update spawn open until the test lets it finish. */
	function stubSlowSpawn(): { finish: () => void } {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		spawnMock.mockImplementation(async (_command: string, args: string[]) => {
			if (args.includes("--version")) {
				const name = path
					.basename(String(_command))
					.replace(/\.(cmd|exe|ps1)$/i, "");
				const code = shimExitCodes.get(name) ?? 0;
				return {
					stdout: code === 0 ? "9.9.9" : "",
					stderr: "",
					status: code,
				};
			}
			if (!args.includes("update") && !args.includes("upgrade")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			await gate;
			return { stdout: "", stderr: "", status: 0 };
		});
		return { finish: () => release() };
	}

	it("spawns one update when two runs overlap", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		const slow = stubSlowSpawn();

		// Genuinely concurrent: the second call starts while the first is parked
		// inside its spawn, which is exactly the window the old code raced in.
		const first = runManagedToolRefresh(NOW);
		const second = runManagedToolRefresh(NOW);
		slow.finish();
		await Promise.all([first, second]);

		expect(updateCalls()).toHaveLength(1);
	});

	it("gives both overlapping callers the same outcome", async () => {
		installFixture("knip", "6.4.1");
		const slow = stubSlowSpawn();

		const first = runManagedToolRefresh(NOW);
		const second = runManagedToolRefresh(NOW);
		slow.finish();
		const [a, b] = await Promise.all([first, second]);

		expect(b).toBe(a);
	});

	it("starts a fresh run once the previous one has settled", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		vi.stubEnv("PI_LENS_TOOL_REFRESH_MAX_PER_SESSION", "2");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);
		await runManagedToolRefresh(NOW);

		// The in-flight guard must not become a process-lifetime latch.
		expect(updateCalls()).toHaveLength(2);
	});

	it("takes the session slot without a gap between checking and taking", () => {
		// The budget seam itself, independent of the in-flight guard: two
		// reservations against a budget of one cannot both succeed. A
		// read-then-take split is precisely what the F1 race exploited.
		expect(reserveManagedToolRefreshSlot(1)).toBe(true);
		expect(reserveManagedToolRefreshSlot(1)).toBe(false);
		expect(managedToolRefreshesThisSession()).toBe(1);
	});
});

/**
 * #1746 review round 2 (R2-F1). The walk used to re-consult the GLOBAL session
 * counter after each awaited refresh. `handleSessionStart` zeroes that counter,
 * so a session start landing inside a 120s `npm update` re-armed the budget the
 * running loop was still spending — and N session starts during one long update
 * walked the whole 22-tool stale list.
 */
describe("a session start mid-run does not extend the run (review R2-F1)", () => {
	it("still spawns one update when the budget re-arms during the spawn", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		let sawUpdate = 0;
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			sawUpdate += 1;
			return { stdout: "", stderr: "", status: 0 };
		});
		// A `/new` arrives while npm is still running (#1746 R2-F1): the reset
		// fires INSIDE the update spawn via the fault-injection kit, before its
		// result is consumed.
		fireResetAt(spawnMock, resetManagedToolRefreshSession, {
			when: (_c, args) => args.includes("update"),
		});

		await runManagedToolRefresh(NOW);

		expect(sawUpdate).toBe(1);
		expect(updateCalls()).toHaveLength(1);
	});

	it("does not walk the stale list when many session starts land mid-run", async () => {
		for (const pkg of ["knip", "pyright", "oxlint", "madge"]) {
			installFixture(pkg, "1.0.0");
		}
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			return { stdout: "", stderr: "", status: 0 };
		});
		// Three sessions start while this one update runs — modeled as one
		// mid-flight hook firing the reset three times back to-back, which is
		// observationally identical for the budget under test.
		fireResetAt(
			spawnMock,
			() => {
				resetManagedToolRefreshSession();
				resetManagedToolRefreshSession();
				resetManagedToolRefreshSession();
			},
			{ when: (_c, args) => args.includes("update") },
		);

		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(1);
	});

	it("still refreshes the run's own allowance when it is raised", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		installFixture("oxlint", "1.0.0");
		vi.stubEnv("PI_LENS_TOOL_REFRESH_MAX_PER_SESSION", "2");
		stubSpawn("ok", {});

		await runManagedToolRefresh(NOW);

		// The local capture must not become a cap of one: a run reserves the
		// whole allowance up front and is entitled to spend it.
		expect(updateCalls()).toHaveLength(2);
	});

	it("lets the NEXT run use the budget a mid-run session start restored", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			resetManagedToolRefreshSession();
			return { stdout: "", stderr: "", status: 0 };
		});

		await runManagedToolRefresh(NOW);
		// The reset is not swallowed — it restores the SESSION's right to start a
		// fresh run, which is what re-arming is for. It just must not extend the
		// run that was already walking.
		await runManagedToolRefresh(NOW);

		expect(updateCalls()).toHaveLength(2);
	});
});

/**
 * #1746 review F3: the session counter is the seam the "count the ATTEMPT, not
 * the success" claim actually lives on. The earlier tests proved it off a
 * function-local budget variable, which a mutation to the shared counter left
 * green.
 */
describe("the session counter records attempts (review F3)", () => {
	it("keeps the slot spent after a failed update", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);

		expect(managedToolRefreshesThisSession()).toBe(1);
	});

	it("keeps the slot spent after a successful update", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		await runManagedToolRefresh(NOW);

		expect(managedToolRefreshesThisSession()).toBe(1);
	});

	it("hands the slot back when the run finds nothing to refresh", async () => {
		installFixture("knip", "6.32.2");
		writeState({ knip: { checkedAt: NOW - DAY_MS, version: "6.32.2" } });
		stubSpawn("ok");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		// A run that never spawned must not burn the session's only slot.
		expect(managedToolRefreshesThisSession()).toBe(0);
	});

	it("hands the slot back when the state is unreadable", async () => {
		installFixture("knip", "6.4.1");
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(STATE_PATH, "{ not json");
		stubSpawn("ok");

		await runManagedToolRefresh(NOW);

		expect(managedToolRefreshesThisSession()).toBe(0);
	});
});

describe("unreadable state is not fresh and not stale", () => {
	it("refreshes nothing and records the gap", async () => {
		installFixture("knip", "6.4.1");
		installFixture("pyright", "1.0.0");
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(STATE_PATH, "{ this is not json");
		stubSpawn("ok", {});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("state-unreadable");
		expect(updateCalls()).toHaveLength(0);
		const group = getDegradationSummary().find(
			(g) => g.kind === "managed-tool-refresh",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].subject).toBe("refresh-state");
	});

	it("reports a missing file as empty, not unreadable", async () => {
		fs.rmSync(STATE_PATH, { force: true });
		await expect(readManagedToolRefreshState()).resolves.toMatchObject({
			status: "empty",
		});
	});

	it("reports a corrupt file as unreadable, not empty", async () => {
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(STATE_PATH, "[]");
		await expect(readManagedToolRefreshState()).resolves.toMatchObject({
			status: "unreadable",
		});
	});

	it("reports an unreadable path as unreadable, not empty", async () => {
		// ONLY ENOENT means "never refreshed". A directory where the file belongs
		// (EISDIR/EPERM on read) is unknown cadence — treating every read error as
		// "no stamp yet" makes every tool look due, forever.
		fs.rmSync(STATE_PATH, { force: true, recursive: true });
		fs.mkdirSync(STATE_PATH, { recursive: true });
		const read = await readManagedToolRefreshState();
		fs.rmSync(STATE_PATH, { force: true, recursive: true });

		expect(read.status).toBe("unreadable");
	});
});

describe("observability", () => {
	it("records the old → new version when a refresh moves a tool", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		await runManagedToolRefresh(NOW);

		expect(
			logRows().some((row) =>
				/managed-tool-refresh knip: 6\.4\.1 → 6\.32\.2/.test(row),
			),
		).toBe(true);
	});

	it("records an unchanged refresh distinctly from a moved one", async () => {
		installFixture("knip", "6.32.2");
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0].changed).toBe(false);
		expect(
			logRows().some((row) =>
				/managed-tool-refresh knip: unchanged at 6\.32\.2/.test(row),
			),
		).toBe(true);
	});

	it("reports the version actually on disk after a failed update", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("fail");

		await runManagedToolRefresh(NOW);

		// Not "keeping 6.4.1" (review F2): the spawn budget can kill the package
		// manager mid-write, so the only honest claim is what the tree says NOW.
		expect(
			logRows().some(
				(row) =>
					row.includes("managed-tool-refresh knip") &&
					row.includes("on disk now 6.4.1") &&
					row.includes("was 6.4.1"),
			),
		).toBe(true);
	});

	it("reports the new version when a killed update already moved the tree", async () => {
		installFixture("knip", "6.4.1");
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			// npm rewrote the package, then the 120s budget killed it mid-run.
			installFixture("knip", "6.32.2");
			return {
				stdout: "",
				stderr: "",
				status: null,
				error: new Error("Process timed out after 120000ms"),
			};
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			ok: false,
			currentVersion: "6.32.2",
			changed: true,
		});
		expect(logRows().some((row) => row.includes("on disk now 6.32.2"))).toBe(
			true,
		);
	});
});

/**
 * #1746 review F2. The refresh mutates `node_modules`, so it owes the same
 * post-write verification `installNpmTool` treats as mandatory, and it owes the
 * probe cache an invalidation — a 24h cached path would otherwise keep serving
 * a binary the update just replaced or broke.
 */
describe("post-update verification (review F2)", () => {
	it("fails the refresh when the updated binary cannot run", async () => {
		installFixture("knip", "6.4.1");
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			// The update lands a new version whose shim is broken.
			installFixture("knip", "6.32.2", { shimExitCode: 1 });
			return { stdout: "", stderr: "", status: 0 };
		});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			ok: false,
			verified: false,
			currentVersion: "6.32.2",
		});
		const group = getDegradationSummary().find(
			(g) => g.kind === "managed-tool-refresh",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0].reason).toContain("failed verification");
		// Stamped failed, so the shorter retry cooldown brings it back sooner.
		expect(readState().knip.failed).toBe(true);
	});

	it("leaves the package in place when verification fails", async () => {
		installFixture("knip", "6.4.1");
		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			installFixture("knip", "6.32.2", { shimExitCode: 1 });
			return { stdout: "", stderr: "", status: 0 };
		});

		await runManagedToolRefresh(NOW);

		// installNpmTool deletes a fresh install that fails verification; here a
		// working tool existed a moment ago, so deleting it takes the tool offline
		// for certain instead of probably.
		expect(installedVersion("knip")).toBe("6.32.2");
	});

	it("marks a verified refresh as verified", async () => {
		installFixture("knip", "6.4.1");
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: true, verified: true });
		expect(logRows().some((row) => row.includes("verified"))).toBe(true);
	});

	it("clears the cached resolution so the next probe sees the new tree", async () => {
		installFixture("knip", "6.4.1");
		// Cache a path the update does NOT rewrite. Pointing the cache at
		// `package.json` would make this test pass on the mtime check alone —
		// vacuously green with the invalidation deleted. npm frequently leaves the
		// `.bin` shim's mtime untouched while replacing the package, which is the
		// real case the invalidation exists for.
		const stablePath = path.join(NODE_MODULES, "knip", "stable-shim");
		fs.writeFileSync(stablePath, "shim");
		await updateProbeCache("knip", stablePath);
		expect(await checkProbeCache("knip")).toBe(stablePath);

		spawnMock.mockImplementation(async (_c: string, args: string[]) => {
			if (!args.includes("update")) {
				return { stdout: "npm", stderr: "", status: 0 };
			}
			// The package moves; the cached shim path and its mtime do not.
			fs.writeFileSync(
				path.join(NODE_MODULES, "knip", "package.json"),
				JSON.stringify({ name: "knip", version: "6.32.2" }),
			);
			return { stdout: "", stderr: "", status: 0 };
		});
		await runManagedToolRefresh(NOW);

		// A 24h cached path would otherwise keep answering for the tree the
		// update just replaced.
		expect(await checkProbeCache("knip")).toBeUndefined();
	});

	it("clears the cached resolution after a failed update too", async () => {
		installFixture("knip", "6.4.1");
		const stablePath = path.join(NODE_MODULES, "knip", "stable-shim");
		fs.writeFileSync(stablePath, "shim");
		await updateProbeCache("knip", stablePath);
		expect(await checkProbeCache("knip")).toBe(stablePath);

		// A killed package manager can rewrite `.bin` shims without moving the
		// version, so the cached answer is untrustworthy on this path as well.
		stubSpawn("fail");
		await runManagedToolRefresh(NOW);

		expect(await checkProbeCache("knip")).toBeUndefined();
	});
});

/**
 * #1746 review F4. A fresh machine installs its tools today; without a stamp
 * at install time it then spends the following sessions running `npm update`
 * on packages that were resolved against the registry minutes earlier.
 */
describe("install-time stamping (review F4)", () => {
	it("records the installed version as freshly checked", async () => {
		installFixture("knip", "6.32.2");

		await stampManagedToolInstalled("knip", "knip", NOW);

		expect(readState().knip).toMatchObject({
			checkedAt: NOW,
			version: "6.32.2",
		});
	});

	it("leaves a just-installed tool out of the due set", async () => {
		installFixture("knip", "6.32.2");
		stubSpawn("ok", {});

		await stampManagedToolInstalled("knip", "knip", NOW);
		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("nothing-due");
		expect(updateCalls()).toHaveLength(0);
	});

	it("is wired into the npm install path", () => {
		const installer = fs.readFileSync(
			path.join(process.cwd(), "clients", "installer", "index.ts"),
			"utf-8",
		);
		expect(installer).toContain("stampManagedToolInstalled(");
	});

	it("keeps the version-bearing stamp through a real npm install (#1759 review F4)", async () => {
		spawnMock.mockImplementation(async (_command: string, args: string[]) => {
			if ((args ?? []).includes("install")) {
				installFixture("knip", "6.32.2");
				return { stdout: "", stderr: "", status: 0 };
			}
			// package-manager availability probe(s)
			return { stdout: "npm", stderr: "", status: 0 };
		});

		const installed = await installTool("knip");

		expect(installed).toBe(true);
		// `installTool`'s npm case stamps the version directly
		// (`stampManagedToolInstalled`) BEFORE `finishInstallAttempt` runs its
		// universal `stampInstallResolution` funnel for every strategy. That
		// funnel used to re-stamp npm too, with no version (npm never sets
		// `lastInstallResolutionId`), clobbering the version this test checks
		// for milliseconds later. `stampInstallResolution` now skips npm.
		expect(readState().knip).toMatchObject({
			checkedAt: expect.any(Number),
			version: "6.32.2",
		});
	});
});

// --- install kill-switch, trust gate, and install lock (#1759 review R2) --
//
// F2's review round gated the five non-npm strategies through
// `refreshManagedTool`. npm predates that PR and kept spawning `npm update`
// directly, ungated — the reviewer's V4c probe: kill-switch set, expect zero
// npm spawns. These tests prove `refreshNpmOne` now clears the same three
// gates `acquireManagedInstallGate` enforces for every other strategy.

describe("install kill-switch, trust gate, and install lock", () => {
	it("declines and spawns nothing when PI_LENS_DISABLE_TOOL_INSTALL=1 (reviewer V4c)", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(updateCalls()).toHaveLength(0);
		expect(degradationCount()).toBe(0);
		// No stamp write: the tool is retried plainly once the block lifts,
		// rather than throttled by a 24h failure cooldown that has nothing to
		// do with it.
		expect(readState().knip).toEqual({
			checkedAt: NOW - 8 * DAY_MS,
			version: "6.4.1",
		});
		expect(
			logRows().some((row) => row.includes("knip") && row.includes("declined")),
		).toBe(true);
	});

	it("declines and spawns nothing when the host denies project trust", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });
		setProjectTrustState("untrusted");

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: false, changed: false });
		expect(updateCalls()).toHaveLength(0);
		expect(degradationCount()).toBe(0);
	});

	it("proceeds normally on a host with no trust surface (default)", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({ ok: true });
		expect(updateCalls()).toHaveLength(1);
	});

	it("declines rather than racing a concurrent install holding the shared lock", async () => {
		installFixture("knip", "6.4.1");
		writeState({ knip: { checkedAt: NOW - 8 * DAY_MS, version: "6.4.1" } });
		stubSpawn("ok", { knip: "6.32.2" });
		process.env.PI_LENS_INSTALL_LOCK_TIMEOUT_MS = "150";
		const lockPath = path.join(TOOLS_DIR, ".install.lock");
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
		);

		try {
			const outcome = await runManagedToolRefresh(NOW);

			expect(outcome.refreshed[0]).toMatchObject({
				ok: false,
				changed: false,
			});
			expect(updateCalls()).toHaveLength(0);
		} finally {
			fs.rmSync(lockPath, { force: true });
		}
	});
});

describe("opt-out", () => {
	it("spawns nothing when the refresh is disabled", async () => {
		installFixture("knip", "6.4.1");
		vi.stubEnv("PI_LENS_DISABLE_TOOL_REFRESH", "1");
		stubSpawn("ok", {});

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.skipped).toBe("disabled");
		expect(updateCalls()).toHaveLength(0);
	});
});

/**
 * Reference adoption of `tests/support/reset-explorer.ts` (#1840).
 *
 * The "review round 2 (R2-F1)" describe block above pins the bug at the ONE
 * await point a reviewer picked by hand. This block asks the same question
 * exhaustively: fire `resetManagedToolRefreshSession` at EVERY await point
 * `executeManagedToolRefresh` exposes via its `tap` seam
 * (`runManagedToolRefreshForExploration`), one point per run, and check the
 * budget invariant after each. It is exercising the CURRENT, fixed code —
 * see `tests/support/reset-explorer.test.ts`'s "rediscovers a known bug"
 * block for the red-first proof that the explorer catches the pre-fix shape.
 */
describe("reset-interleaving explorer (#1840 adoption)", () => {
	it("holds the session-budget invariant at every await point in the real walk", async () => {
		const resetFixtures = (): void => {
			fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
			fs.mkdirSync(NODE_MODULES, { recursive: true });
			installFixture("knip", "6.4.1");
			installFixture("pyright", "1.0.0");
			installFixture("oxlint", "1.0.0");
			resetManagedToolRefreshSession();
			resetProbeCacheStateForTesting();
			resetDegradationLedger();
			spawnMock.mockClear();
		};
		stubSpawn("ok", {});

		const outcome = await exploreInterleavings({
			run: (tap) => {
				// Every pass needs the SAME starting state, or the walk's tap
				// sequence (and the tools it sees as stale) drifts between passes —
				// the explorer requires a deterministic tap sequence to address
				// "the Nth point" meaningfully. See the file header on reset-explorer.ts.
				resetFixtures();
				return runManagedToolRefreshForExploration(NOW, tap);
			},
			reset: () => resetManagedToolRefreshSession(),
			invariant: () => {
				// The R2-F1 invariant: a mid-run session reset restores the
				// SESSION's right to start a fresh run, but must never let the run
				// already walking spend more than the allowance it reserved.
				expect(updateCalls().length).toBeLessThanOrEqual(1);
			},
		});

		// 3 tap points: after `installedRefreshCandidates`, after
		// `readManagedToolRefreshState`, and after the one tool the local
		// allowance (default `maxPerSession` = 1) permits before it breaks.
		expect(outcome.tapPointCount).toBe(3);
		expect(outcome.executions).toBe(4);
	});
});
