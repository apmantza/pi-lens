/**
 * #1500 round 3 — biome's failed-install arm had no test at all.
 *
 * The evidence marker originally sat on biome's `non-installable` arm, which
 * cannot happen: its `acceptInstalled` always accepts. The REACHABLE arm is every
 * `missing` verdict, because `resolveManagedToolClient` only reaches the
 * installer when the probe said missing — and that row shipped bare, which is the
 * exact #1500 blind row. Round 2 moved the marker; nothing pinned it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeSpawnAsync, logLatencySpy, ensureTool, getInstallAttempt } =
	vi.hoisted(() => ({
		safeSpawnAsync: vi.fn(),
		logLatencySpy: vi.fn(),
		ensureTool: vi.fn(),
		getInstallAttempt: vi.fn(),
	}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
}));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	getInstallAttempt,
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({})),
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findGlobalBinary: vi.fn(async () => undefined),
}));

const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn biome ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision")
		.map((entry) => entry.metadata);

async function biome(): Promise<{ ensureAvailable(): Promise<boolean> }> {
	vi.resetModules();
	const { BiomeClient } = await import("../../clients/biome-client.js");
	return new BiomeClient();
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	ensureTool.mockReset();
	getInstallAttempt.mockReset();
	ensureTool.mockResolvedValue(undefined);
});

describe("biome's failed-install row (#1500)", () => {
	it("carries the install evidence and says the verdict came from the probe", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		getInstallAttempt.mockReturnValue({
			outcome: "failed",
			reason: "npm error 404 Not Found",
			at: Date.now(),
		});

		expect(await (await biome()).ensureAvailable()).toBe(false);
		const row = decisions()[decisions().length - 1];
		expect(row).toMatchObject({
			tool: "biome",
			verdict: "unavailable",
			outcome: "missing",
			latched: true,
			classifiedBy: "probe",
			evidence: {
				install: "failed",
				installReason: "npm error 404 Not Found",
				errno: "ENOENT",
			},
		});
	});

	it("says not-attempted when the installer declined", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		getInstallAttempt.mockReturnValue({
			outcome: "declined",
			reason: "installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			at: Date.now(),
		});

		expect(await (await biome()).ensureAvailable()).toBe(false);
		expect(decisions()[decisions().length - 1]?.evidence).toMatchObject({
			install: "not-attempted",
		});
	});

	it("never emits an empty evidence object", async () => {
		// A probe whose result carries nothing quotable plus no install record used
		// to produce `evidence: {}` — a field that says nothing is worse than an
		// absent one, because a reader takes it for a claim.
		safeSpawnAsync.mockResolvedValue({ stdout: "", stderr: "", status: 1 });
		getInstallAttempt.mockReturnValue(undefined);

		expect(await (await biome()).ensureAvailable()).toBe(false);
		const row = decisions()[decisions().length - 1];
		if (row?.evidence !== undefined) {
			expect(Object.keys(row.evidence as object).length).toBeGreaterThan(0);
		}
	});
});
