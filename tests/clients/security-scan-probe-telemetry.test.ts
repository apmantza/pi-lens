/**
 * #1501 — `SecurityScanClient.probeVersion` emitted its availability_decision
 * record before the caller decided the cooldown, so a transient probe verdict
 * carried no `retryAfterMs` while every other field was present.
 *
 * These tests pin the FULL record shape for all four probeVersion consumers
 * (gitleaks, trivy and opengrep through `ensureViaInstaller`; govulncheck
 * directly). Success and durable-missing records must keep their exact
 * metadata key set, and the transient record must gain exactly one field —
 * `retryAfterMs`, decided by the seam at log time. The transient assertions
 * fail on pre-fix code (the field is absent); the pins pass identically
 * before and after.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

const {
	safeSpawnAsync,
	safeSpawn,
	ensureTool,
	getInstallAttempt,
	findManagedToolBinary,
	logLatency,
} = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	safeSpawn: vi.fn(),
	ensureTool: vi.fn(),
	getInstallAttempt: vi.fn(),
	findManagedToolBinary: vi.fn(),
	logLatency: vi.fn(),
}));

// Spread the real module: only `logLatency` is intercepted, so the rest of
// the import graph (including availability-policy's logAvailabilityDecision,
// which funnels through it) keeps working.
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
	isCommandAvailableAsync: vi.fn(async () => false),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	getInstallAttempt,
	findManagedToolBinary,
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({})),
}));

/** A probe the host killed at its budget: says nothing about the tool. */
const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** A probe that proved the tool is not on this machine. */
const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn",
	spawnFailure: { kind: "tool-not-found" },
};

const okResult = (stdout: string) => ({
	stdout,
	stderr: "",
	status: 0,
	error: undefined,
});

interface ScanClient {
	ensureAvailable(): Promise<boolean>;
}

async function makeClient(tool: string): Promise<ScanClient> {
	switch (tool) {
		case "gitleaks":
			return new (
				await import("../../clients/gitleaks-client.js")
			).GitleaksClient();
		case "trivy":
			return new (await import("../../clients/trivy-client.js")).TrivyClient();
		case "opengrep":
			return new (
				await import("../../clients/opengrep-client.js")
			).OpengrepClient();
		case "govulncheck":
			return new (
				await import("../../clients/govulncheck-client.js")
			).GovulncheckClient();
		default:
			throw new Error(`unknown tool ${tool}`);
	}
}

/** Availability decision records emitted for `tool`, oldest first. */
function decisionsFor(tool: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				(entry.metadata as Record<string, unknown> | undefined)?.tool === tool,
		);
}

function metadataOf(record: Record<string, unknown>): Record<string, unknown> {
	return record.metadata as Record<string, unknown>;
}

/**
 * The metadata key set every probe record carries today.
 *
 * `classifiedBy` and `evidence` joined it in #1500: a verdict now says whether a
 * probe derived it or a call site asserted it, and carries the spawn facts it was
 * derived FROM. Both are unconditional on a probe record — a probe always has a
 * result to describe — so they belong in the exact-shape pin rather than behind a
 * `toMatchObject`.
 */
const BASELINE_KEYS = [
	"budgetMs",
	"cause",
	"classifiedBy",
	"evidence",
	"hostStallMs",
	"latched",
	"outcome",
	"producer",
	"tool",
	"verdict",
];

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

beforeEach(async () => {
	(await import("../../clients/project-trust.js")).setProjectTrustState(
		"trusted",
	);
	vi.resetAllMocks();
	ensureTool.mockResolvedValue(null);
	findManagedToolBinary.mockResolvedValue(undefined);
	safeSpawn.mockReturnValue({ stdout: "", stderr: "", status: 1 });
	vi.useFakeTimers({ toFake: ["Date"] });
});

it("uses a present managed binary as the only availability probe (#2140)", async () => {
	findManagedToolBinary.mockResolvedValue("C:/managed/opengrep.exe");
	safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
		if (args[0] === "scan") {
			const reportPath = args[args.indexOf("--json-output") + 1];
			const fs = await import("node:fs/promises");
			await fs.writeFile(reportPath, JSON.stringify({ results: [] }));
		}
		return okResult(cmd === "C:/managed/opengrep.exe" ? "opengrep 1.0.0" : "");
	});
	const client = await makeClient("opengrep");

	expect(await client.ensureAvailable()).toBe(true);
	expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	expect(safeSpawnAsync).toHaveBeenCalledWith(
		"C:/managed/opengrep.exe",
		["--version"],
		expect.any(Object),
	);
	expect(decisionsFor("opengrep")).toHaveLength(1);
	expect(decisionsFor("opengrep")[0].metadata).toMatchObject({
		verdict: "available",
		evidence: { source: "managed-dir", binary: "opengrep.exe" },
	});
	await (client as unknown as { scan(cwd: string): Promise<unknown> }).scan(
		process.cwd(),
	);
	expect(safeSpawnAsync.mock.calls.at(-1)?.[0]).toBe("C:/managed/opengrep.exe");
});

it("shares opengrep availability across independent clients (#2131)", async () => {
	let release: ((value: unknown) => void) | undefined;
	findManagedToolBinary.mockResolvedValue(undefined);
	safeSpawnAsync.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const first = await makeClient("opengrep");
	const second = await makeClient("opengrep");
	const calls = [first.ensureAvailable(), second.ensureAvailable()];
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	release?.(okResult("opengrep 1.0.0"));
	expect(await Promise.all(calls)).toEqual([true, true]);
	expect(
		decisionsFor("opengrep").map((record) => metadataOf(record).classifiedBy),
	).toEqual(["probe", "joined"]);
});

it("package-manager reset does not tear down an airborne security flight", async () => {
	let release: ((value: unknown) => void) | undefined;
	findManagedToolBinary.mockResolvedValue(undefined);
	safeSpawnAsync.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const first = await makeClient("opengrep");
	const second = await makeClient("opengrep");
	const calls = [first.ensureAvailable(), second.ensureAvailable()];
	await new Promise((resolve) => setTimeout(resolve, 0));
	const { _resetPackageManagerCache } =
		await import("../../clients/package-manager.js");
	_resetPackageManagerCache();
	expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	release?.(okResult("opengrep 1.0.0"));
	await expect(Promise.all(calls)).resolves.toEqual([true, true]);
});

afterEach(async () => {
	vi.useRealTimers();
	(await import("../../clients/project-trust.js")).resetProjectTrust();
});

const CONSUMERS = ["gitleaks", "trivy", "opengrep", "govulncheck"] as const;

describe.each(CONSUMERS)("probeVersion telemetry: %s (#1501)", (tool) => {
	it("pins the success record: exact fields, no retryAfterMs", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === tool ? okResult(`${tool} 1.0.0`) : missingResult,
		);
		const client = await makeClient(tool);

		expect(await client.ensureAvailable()).toBe(true);
		const records = decisionsFor(tool);
		expect(records).toHaveLength(1);
		expect(metadataOf(records[0])).toMatchObject({
			tool,
			verdict: "available",
			outcome: "success",
			cause: "ok",
			latched: true,
			budgetMs: 5000,
		});
		expect(Object.keys(metadataOf(records[0])).sort()).toEqual(BASELINE_KEYS);
	});

	it("pins the durable-missing record: exact fields, no retryAfterMs", async () => {
		// Every spawn misses: the version probe, and (for govulncheck) the
		// `go version` preflight of the install path.
		safeSpawnAsync.mockImplementation(async () => missingResult);
		const client = await makeClient(tool);

		expect(await client.ensureAvailable()).toBe(false);
		const records = decisionsFor(tool);
		// TWO rows since #1500: the probe's verdict, then the durable-absence
		// ASSERTION that follows the install path. The second one used to be
		// silent — the tool went quiet for the session with nothing to audit.
		expect(records).toHaveLength(2);
		expect(metadataOf(records[0])).toMatchObject({
			tool,
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			latched: true,
			budgetMs: 5000,
			classifiedBy: "probe",
		});
		expect(Object.keys(metadataOf(records[0])).sort()).toEqual(BASELINE_KEYS);

		// The assertion row has no probe of its own: no budget, no stall, and its
		// evidence describes the install rather than a spawn result.
		expect(metadataOf(records[1])).toMatchObject({
			tool,
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			latched: true,
			classifiedBy: "caller",
		});
		expect(Object.keys(metadataOf(records[1])).sort()).toEqual([
			"cause",
			"classifiedBy",
			"evidence",
			"latched",
			"outcome",
			"producer",
			"tool",
			"verdict",
		]);
	});

	it("a transient verdict carries retryAfterMs at log time", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd === tool ? timeoutResult : missingResult,
		);
		const client = await makeClient(tool);

		expect(await client.ensureAvailable()).toBe(false);
		const records = decisionsFor(tool);
		expect(records).toHaveLength(1);
		expect(metadataOf(records[0])).toMatchObject({
			tool,
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
			budgetMs: 5000,
		});
		// THE #1501 gap: pre-fix this field is absent, so a transient verdict
		// says the tool is off but not when it comes back.
		expect(metadataOf(records[0]).retryAfterMs).toBe(
			TRANSIENT_BASE_COOLDOWN_MS,
		);
	});
});

describe.each(["gitleaks", "trivy", "opengrep"] as const)(
	"ensureViaInstaller compensating row: %s (#1606)",
	(tool) => {
		it("emits a compensating available row when ensureTool recovers a failed probe", async () => {
			// The PATH probe fails (ENOENT) for every consumer; the installer then
			// resolves the managed binary. Pre-fix, this leaves exactly one
			// availability_decision row: the probe's latched `unavailable`. The
			// installer's success is never recorded.
			safeSpawnAsync.mockImplementation(async () => missingResult);
			ensureTool.mockResolvedValue("/managed/bin/" + tool);
			const client = await makeClient(tool);

			expect(await client.ensureAvailable()).toBe(true);
			const records = decisionsFor(tool);
			expect(records).toHaveLength(2);

			expect(metadataOf(records[0])).toMatchObject({
				tool,
				verdict: "unavailable",
				outcome: "missing",
				cause: "not-found",
				classifiedBy: "probe",
			});

			// The compensating row #1606 requires: the installer resolved the
			// tool after the probe latched it absent, so a second row must say so.
			expect(metadataOf(records[1])).toMatchObject({
				tool,
				verdict: "available",
				outcome: "success",
				cause: "ok",
				classifiedBy: "caller",
				evidence: {
					install: "succeeded",
					binary: tool,
					source: "managed-dir",
				},
			});
		});
	},
);

describe.each(["gitleaks", "govulncheck"] as const)(
	"probeVersion telemetry: %s cooldown lifecycle (#1501)",
	(tool) => {
		it("suppresses re-probes during the cooldown, then escalates once", async () => {
			safeSpawnAsync.mockImplementation(async (cmd: string) =>
				cmd === tool ? timeoutResult : missingResult,
			);
			const client = await makeClient(tool);

			expect(await client.ensureAvailable()).toBe(false);
			expect(metadataOf(decisionsFor(tool)[0]).retryAfterMs).toBe(
				TRANSIENT_BASE_COOLDOWN_MS,
			);

			// Inside the cooldown the verdict is served from the latch: no new
			// probe, no new record.
			const spawns = safeSpawnAsync.mock.calls.length;
			expect(await client.ensureAvailable()).toBe(false);
			expect(safeSpawnAsync.mock.calls.length).toBe(spawns);
			expect(decisionsFor(tool)).toHaveLength(1);

			// After the cooldown the seam re-probes, and the second transient
			// verdict escalates the schedule exactly once (base × 2). A caller
			// re-marking the same verdict would double-escalate to base × 4.
			advancePastCooldown();
			expect(await client.ensureAvailable()).toBe(false);
			const records = decisionsFor(tool);
			expect(records).toHaveLength(2);
			expect(metadataOf(records[1]).retryAfterMs).toBe(
				2 * TRANSIENT_BASE_COOLDOWN_MS,
			);
		});
	},
);
