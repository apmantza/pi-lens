/**
 * #1494 — `createCwdCachedProbe` cached a boolean verdict per cwd forever, so
 * one stalled `--version` probe disabled eslint, credo or clippy for that cwd
 * until the host restarted. The three runners it feeds were the last consumers
 * of that shape after #1467/#1476.
 *
 * These tests assert the shared seam AND each of the three runners, because the
 * latch lives in the helper while the user-visible damage lands in the runners.
 * `safeSpawnAsync` is mocked; the probe argv is asserted directly, so the tests
 * do not depend on which function issues the spawn.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../../../clients/dispatch/runners/utils/availability-policy.js";
import {
	createCwdCachedProbe,
	resetDispatchAvailabilityState,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { getDegradationSummary } from "../../../../clients/degradation-ledger.js";

const {
	logLatencySpy,
	safeSpawnAsync,
	tryLazyInstall,
	getLazyInstallAttempt,
	findCargoPathAsync,
} = vi.hoisted(() => ({
	logLatencySpy: vi.fn(),
	safeSpawnAsync: vi.fn(),
	tryLazyInstall: vi.fn(async () => false),
	getLazyInstallAttempt: vi.fn(
		() => undefined as { outcome: string; reason?: string } | undefined,
	),
	findCargoPathAsync: vi.fn(async () => "cargo"),
}));

vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/lazy-installer.js", () => ({
	tryLazyInstall,
	getLazyInstallAttempt,
}));

// #2455 fix round 4, F2: `rust-client.ts` now owns the process's ONE
// RustClient and the runner imports that instance, so the double is the
// INSTANCE, not the class.
vi.mock("../../../../clients/rust-client.js", () => ({
	rustClient: { findCargoPathAsync },
}));

const timeoutResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout" as const,
	spawnFailure: { kind: "timeout" } as never,
});

const notFoundResult = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" } as never,
});

const okResult = (stdout = "1.0.0") => ({ stdout, stderr: "", status: 0 });

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

/** Calls whose argv asks a tool for its version. */
function versionProbeCalls(): unknown[][] {
	return safeSpawnAsync.mock.calls.filter((call) =>
		(call[1] as string[] | undefined)?.includes("--version"),
	);
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeEach(() => {
	logLatencySpy.mockReset();
	safeSpawnAsync.mockReset();
	tryLazyInstall.mockReset();
	tryLazyInstall.mockResolvedValue(false);
	resetDispatchAvailabilityState();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("createCwdCachedProbe latch policy (#1494)", () => {
	it("shares one in-flight probe across two consumers and records the join", async () => {
		let release: ((value: ReturnType<typeof okResult>) => void) | undefined;
		const probe = vi.fn(
			() =>
				new Promise<ReturnType<typeof okResult>>(
					(resolve) => (release = resolve),
				),
		);
		const first = createCwdCachedProbe(probe, { tool: "joined-widget" });
		const second = createCwdCachedProbe(probe, { tool: "joined-widget" });

		const a = first("/tmp/joined-project");
		const b = second("/tmp/joined-project");
		expect(probe).toHaveBeenCalledTimes(1);
		release?.(okResult());
		expect(await Promise.all([a, b])).toEqual([true, true]);
		expect(decisions().map((entry) => entry.metadata.classifiedBy)).toEqual([
			"probe",
			"joined",
		]);
	});

	it("does not join a flight from a consumer with another binary", async () => {
		const releases: Array<(value: ReturnType<typeof okResult>) => void> = [];
		const probe = vi.fn(
			() =>
				new Promise<ReturnType<typeof okResult>>((resolve) => {
					releases.push(resolve);
				}),
		);
		const first = createCwdCachedProbe(probe, {
			tool: "binary-widget",
			flightKeyComponent: "/tools/widget-v1",
		});
		const second = createCwdCachedProbe(probe, {
			tool: "binary-widget",
			flightKeyComponent: "/tools/widget-v2",
		});

		const a = first("/tmp/binary-project");
		const b = second("/tmp/binary-project");
		expect(probe).toHaveBeenCalledTimes(2);
		expect(releases).toHaveLength(2);
		releases[0]?.(okResult());
		releases[1]?.(okResult());
		expect(await Promise.all([a, b])).toEqual([true, true]);
	});

	it("does not let a refreshed probe join the stale flight", async () => {
		let release: ((value: ReturnType<typeof okResult>) => void) | undefined;
		const probe = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<ReturnType<typeof okResult>>((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValueOnce(okResult());
		const preInstall = createCwdCachedProbe(probe, {
			tool: "refresh-widget",
			flightKeyComponent: "/tools/widget",
		});
		const postInstall = createCwdCachedProbe(probe, {
			tool: "refresh-widget",
			flightKeyComponent: "/tools/widget#refresh-1",
		});

		const stale = preInstall("/tmp/refresh-project");
		const refreshed = postInstall("/tmp/refresh-project");
		expect(probe).toHaveBeenCalledTimes(2);
		release?.({
			stdout: "",
			stderr: "",
			status: 1,
		});
		expect(await refreshed).toBe(true);
		release = undefined;
		expect(await stale).toBe(false);
	});

	it("records a bounded degradation when the probe exceeds budgetMs", async () => {
		let release: ((value: ReturnType<typeof okResult>) => void) | undefined;
		const probe = vi.fn(
			() =>
				new Promise<ReturnType<typeof okResult>>(
					(resolve) => (release = resolve),
				),
		);
		const cached = createCwdCachedProbe(probe, {
			tool: "overrun-widget",
			budgetMs: 5,
		});
		const pending = cached("/tmp/overrun-project");
		vi.setSystemTime(new Date(Date.now() + 6));
		release?.(okResult());
		expect(await pending).toBe(true);
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "availability-probe-overrun",
		);
		expect(group?.count).toBeGreaterThanOrEqual(1);
		expect(group?.latestReasons).toContainEqual(
			expect.objectContaining({
				subject: `overrun-widget:${path.resolve("/tmp/overrun-project")}`,
			}),
		);
	});

	it("does not book an overrun for a probe that returned a timeout verdict", async () => {
		const probe = vi.fn().mockResolvedValue(timeoutResult());
		const cached = createCwdCachedProbe(probe, {
			tool: "timeout-widget",
			budgetMs: 5,
		});
		const pending = cached("/tmp/timeout-project");
		vi.setSystemTime(new Date(Date.now() + 6));
		expect(await pending).toBe(false);
		const group = getDegradationSummary().find(
			(entry) => entry.kind === "availability-probe-overrun",
		);
		expect(
			group?.latestReasons.some(
				(entry) =>
					entry.subject ===
					`timeout-widget:${path.resolve("/tmp/timeout-project")}`,
			),
		).toBe(false);
	});

	it("re-probes after a timeout once the cooldown expires", async () => {
		const probe = vi
			.fn()
			.mockResolvedValueOnce(timeoutResult())
			.mockResolvedValueOnce(okResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		expect(await cached("/tmp/project-a")).toBe(false);
		// Inside the cooldown the verdict is reused: no probe storm.
		expect(await cached("/tmp/project-a")).toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);

		advancePastCooldown();
		expect(await cached("/tmp/project-a")).toBe(true);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("latches a genuine absence and never re-probes it", async () => {
		const probe = vi.fn().mockResolvedValue(notFoundResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		expect(await cached("/tmp/project-b")).toBe(false);
		advancePastCooldown();
		advancePastCooldown();
		expect(await cached("/tmp/project-b")).toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(cached.getVerdict("/tmp/project-b")).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
		});
	});

	it("records the cause and the retry window in availability_decision", async () => {
		const probe = vi.fn().mockResolvedValue(timeoutResult());
		const cached = createCwdCachedProbe(probe, {
			tool: "widget",
			budgetMs: 5000,
		});

		await cached("/tmp/project-c");
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0]?.metadata).toMatchObject({
			tool: "widget",
			verdict: "unavailable",
			outcome: "transient",
			cause: "probe-timeout",
			latched: false,
			retryAfterMs: TRANSIENT_BASE_COOLDOWN_MS,
			budgetMs: 5000,
		});
	});

	it("records how each verdict was classified and what the probe returned", async () => {
		// #1500's last leftover: this seam and tryEslintFix landed their rows with
		// no `classifiedBy` and no `evidence`, so a `missing` verdict here could not
		// be audited the way every other consumer's could.
		const probe = vi
			.fn()
			.mockResolvedValueOnce(timeoutResult())
			.mockResolvedValueOnce(okResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		await cached("/tmp/project-evidence");
		expect(decisions()[0]?.metadata).toMatchObject({
			classifiedBy: "probe",
			evidence: {
				command: "widget",
				failure: "timeout",
				spawnFailureKind: "timeout",
			},
		});

		advancePastCooldown();
		await cached("/tmp/project-evidence");
		expect(decisions()[1]?.metadata).toMatchObject({
			verdict: "available",
			classifiedBy: "probe",
			evidence: { command: "widget", status: 0 },
		});
	});

	it("dedupes concurrent first-time callers and scopes the verdict per cwd", async () => {
		let settle: ((value: unknown) => void) | undefined;
		const probe = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						settle = resolve;
					}),
			)
			.mockResolvedValueOnce(notFoundResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		const inFlight = [
			cached("/tmp/project-d"),
			cached("/tmp/project-d"),
			cached("/tmp/project-d"),
		];
		expect(probe).toHaveBeenCalledTimes(1);
		settle?.(okResult());
		expect(await Promise.all(inFlight)).toEqual([true, true, true]);

		expect(await cached("/tmp/project-e")).toBe(false);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("reports latched only for a verdict that is actually held", async () => {
		const probe = vi.fn().mockResolvedValue(timeoutResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		// Never probed: there is nothing latched, and `read()` answers null here
		// exactly as it does for an expired cooldown — which is why the verdict
		// must be derived from the OUTCOME, not from `read()`.
		expect(cached.getVerdict("/tmp/project-verdict")).toMatchObject({
			outcome: null,
			latched: false,
		});

		await cached("/tmp/project-verdict");
		expect(cached.getVerdict("/tmp/project-verdict")).toMatchObject({
			outcome: "transient",
			latched: false,
		});

		// Cooldown expired, verdict not yet replaced: still not latched.
		advancePastCooldown();
		expect(cached.getVerdict("/tmp/project-verdict")).toMatchObject({
			outcome: "transient",
			latched: false,
		});

		probe.mockResolvedValue(okResult());
		await cached("/tmp/project-verdict");
		expect(cached.getVerdict("/tmp/project-verdict")).toMatchObject({
			outcome: "success",
			latched: true,
		});
	});

	it("classifies a thrown probe instead of collapsing it to a latched false", async () => {
		const probe = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("resource temporarily unavailable"), {
					code: "EAGAIN",
				}),
			)
			.mockResolvedValueOnce(okResult());
		const cached = createCwdCachedProbe(probe, { tool: "widget" });

		expect(await cached("/tmp/project-f")).toBe(false);
		expect(cached.getVerdict("/tmp/project-f").outcome).toBe("transient");
		advancePastCooldown();
		expect(await cached("/tmp/project-f")).toBe(true);
	});
});

describe("eslint runner: a stalled probe does not disable the runner (#1494)", () => {
	it("re-probes and lints after the cooldown expires", async () => {
		const cwd = tempDir("pi-lens-eslint-latch-");
		fs.writeFileSync(path.join(cwd, "eslint.config.js"), "export default [];");
		const filePath = path.join(cwd, "a.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? timeoutResult() : okResult("[]"),
		);
		const runner = (
			await import("../../../../clients/dispatch/runners/eslint.js")
		).default;
		const ctx = { cwd, filePath } as never;

		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(versionProbeCalls()).toHaveLength(1);
		// Still inside the cooldown: skipped without a fresh probe.
		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(versionProbeCalls()).toHaveLength(1);

		advancePastCooldown();
		safeSpawnAsync.mockClear();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? okResult() : okResult("[]"),
		);
		expect((await runner.run(ctx)).status).toBe("succeeded");
		expect(versionProbeCalls()).toHaveLength(1);
	});
});

describe("credo runner: a stalled probe does not disable the runner (#1494)", () => {
	it("re-probes and runs credo after the cooldown expires", async () => {
		const cwd = tempDir("pi-lens-credo-latch-");
		fs.writeFileSync(path.join(cwd, "mix.exs"), "defmodule X do end");
		const filePath = path.join(cwd, "a.ex");
		fs.writeFileSync(filePath, "defmodule A do end\n");

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version")
				? timeoutResult()
				: okResult(JSON.stringify({ issues: [] })),
		);
		const runner = (
			await import("../../../../clients/dispatch/runners/credo.js")
		).default;
		const ctx = { cwd, filePath } as never;

		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(versionProbeCalls()).toHaveLength(1);

		advancePastCooldown();
		safeSpawnAsync.mockClear();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version")
				? okResult()
				: okResult(JSON.stringify({ issues: [] })),
		);
		expect((await runner.run(ctx)).status).toBe("succeeded");
		expect(versionProbeCalls()).toHaveLength(1);
	});
});

describe("rust-clippy runner: a stalled probe does not disable the runner (#1494)", () => {
	it("skips without an install attempt, then re-probes after the cooldown", async () => {
		const cwd = tempDir("pi-lens-clippy-latch-");
		fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
		const filePath = path.join(cwd, "a.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? timeoutResult() : okResult(""),
		);
		const runner = (
			await import("../../../../clients/dispatch/runners/rust-clippy.js")
		).default;
		const ctx = { cwd, filePath } as never;

		expect((await runner.run(ctx)).status).toBe("skipped");
		expect(versionProbeCalls()).toHaveLength(1);
		// A timeout is not evidence clippy is missing, so it must not drive an
		// install — and it must not be remembered past its cooldown.
		expect(tryLazyInstall).not.toHaveBeenCalled();

		advancePastCooldown();
		safeSpawnAsync.mockClear();
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? okResult() : okResult(""),
		);
		expect((await runner.run(ctx)).status).toBe("succeeded");
		expect(versionProbeCalls()).toHaveLength(1);
	});

	it("records the failed lazy install beside the verdict it produced (#1537)", async () => {
		// #1537 gave the lazy installers an attempt record; this is the production
		// consumer that makes it observable. Without it, "we ran `rustup component
		// add clippy` and the network failed" and "this machine has no rustup" both
		// look like a silent skip in latency.log.
		const cwd = tempDir("pi-lens-clippy-install-evidence-");
		fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
		const filePath = path.join(cwd, "a.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		// A GENUINE absence, so the runner is allowed to attempt the install.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? notFoundResult() : okResult(""),
		);
		tryLazyInstall.mockResolvedValue(false);
		getLazyInstallAttempt.mockReturnValue({
			outcome: "failed",
			reason: "network is unreachable",
		});

		const runner = (
			await import("../../../../clients/dispatch/runners/rust-clippy.js")
		).default;
		expect((await runner.run({ cwd, filePath } as never)).status).toBe(
			"skipped",
		);
		expect(tryLazyInstall).toHaveBeenCalledWith("rust-clippy", cwd);

		const decision = decisions().find(
			(entry) => entry.metadata?.tool === "rust-clippy",
		);
		expect(decision?.metadata).toMatchObject({
			verdict: "unavailable",
			classifiedBy: "caller",
			evidence: { install: "failed", installReason: "network is unreachable" },
		});
	});

	it("says not-attempted when no install was tried (#1537)", async () => {
		// The other half: an empty attempt record must read as "nothing was tried",
		// not as a fabricated failure.
		const cwd = tempDir("pi-lens-clippy-no-install-");
		fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
		const filePath = path.join(cwd, "a.rs");
		fs.writeFileSync(filePath, "fn main() {}\n");

		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
			args.includes("--version") ? notFoundResult() : okResult(""),
		);
		tryLazyInstall.mockResolvedValue(false);
		getLazyInstallAttempt.mockReturnValue(undefined);

		const runner = (
			await import("../../../../clients/dispatch/runners/rust-clippy.js")
		).default;
		await runner.run({ cwd, filePath } as never);

		expect(
			decisions().find((entry) => entry.metadata?.tool === "rust-clippy")
				?.metadata?.evidence,
		).toMatchObject({ install: "not-attempted" });
	});
});
