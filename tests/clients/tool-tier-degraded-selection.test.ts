/**
 * #1568 — `sawTransient` was consulted ONLY on the all-failed arm.
 *
 * Both ast-grep availability sweeps walk an ordered candidate list and stop at
 * the first candidate that answers. A candidate that timed out was recorded in
 * `sawTransient`, but the flag was read only after every candidate had failed.
 * So when a preferred tier merely stalled and a LOWER tier answered, the sweep
 * took the win at face value and latched it: `sgLatch.noteAvailable()` /
 * `availabilityLatch.noteAvailable()` are durable for the session, and nothing
 * expires them. One busy second at warm-up therefore pinned the whole session
 * to `npx --no -- ast-grep` — a Node process per invocation — with a healthy
 * global ast-grep sitting on PATH the entire time.
 *
 * This is #1539's degraded-selection shape in the tool-tier domain, and the fix
 * mirrors #1559's semantics: a selection made while a candidate ahead of the
 * winner was UNREACHABLE (not absent) is PROVISIONAL. It is used for the
 * current call and held only for the stalled tier's cooldown; after that the
 * next caller re-sweeps, and a recovered preferred tier wins back.
 *
 * Two sites, two scenarios. The control cases — a clean win latches, a
 * genuine absence ahead of the winner latches — are pinned beside each one,
 * because "never cache anything" would be worse than the bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

/**
 * Reset through the SAME module instance the clients load (the compiled `.js`):
 * the shared ast-grep memo is module state, and resetting a second instance of
 * the module silently resets nothing.
 */
async function resetDispatchAvailabilityState(): Promise<void> {
	const helpers =
		await import("../../clients/dispatch/runners/utils/runner-helpers.js");
	helpers.resetDispatchAvailabilityState();
}

const { safeSpawnAsync, safeSpawn, ensureTool, logLatency } = vi.hoisted(
	() => ({
		safeSpawnAsync: vi.fn(),
		safeSpawn: vi.fn(),
		ensureTool: vi.fn(),
		logLatency: vi.fn(),
	}),
);

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
	getInstallAttempt: vi.fn(() => undefined),
	isSpawnableCommand: vi.fn(async () => true),
	resetPathWalkMemo: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({})),
}));

vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findGlobalBinary: vi.fn(async () => undefined),
	findNodeToolBinary: vi.fn(async () => undefined),
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

const astGrepOk = () => okResult("ast-grep 0.32.3");

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

function lastAvailableDecision(tool: string): Record<string, unknown> {
	const available = decisionsFor(tool).filter(
		(entry) =>
			(entry.metadata as Record<string, unknown>).verdict === "available",
	);
	return (available.at(-1)?.metadata ?? {}) as Record<string, unknown>;
}

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

/**
 * A provisional verdict escalates on the transient ladder, so the SECOND hop
 * has to clear 60 s, not 30 s.
 */
function advancePastSecondCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS * 2 + 1));
}

/**
 * Route by command so each tier's verdict is explicit. `npx` is matched
 * exactly; everything else (bare `ast-grep`/`sg` and any absolute
 * `node_modules/.bin` path this host happens to have) is the "preferred" tier.
 */
function routeTiers(options: { preferred: unknown; npx: unknown }): void {
	safeSpawnAsync.mockImplementation(async (cmd: string) =>
		cmd === "npx" ? options.npx : options.preferred,
	);
}

beforeEach(async () => {
	(await import("../../clients/project-trust.js")).setProjectTrustState(
		"trusted",
	);
	vi.resetAllMocks();
	ensureTool.mockResolvedValue(null);
	safeSpawn.mockReturnValue({ stdout: "", stderr: "", status: 1 });
	await resetDispatchAvailabilityState();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
	vi.useRealTimers();
	await resetDispatchAvailabilityState();
	(await import("../../clients/project-trust.js")).resetProjectTrust();
});

describe("shared ast-grep memo: a stalled preferred tier is provisional (#1568)", () => {
	async function loadHelpers() {
		return await import("../../clients/dispatch/runners/utils/runner-helpers.js");
	}

	it("uses npx now, then hands the session back to ast-grep after the cooldown", async () => {
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const { isSgAvailableAsync, getSgCommand } = await loadHelpers();

		// The current call is served, as before: npx answers, so ast-grep works.
		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).toBe("npx");
		const probesAfterFirst = safeSpawnAsync.mock.calls.length;

		// Inside the cooldown the provisional pick holds — no re-sweep per call.
		expect(await isSgAvailableAsync()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probesAfterFirst);

		// After the stalled tier's cooldown the sweep runs again, and the
		// recovered preferred tier wins. Pre-fix the npx pick was latched
		// `available` for the life of the process, so no second sweep ever ran.
		advancePastCooldown();
		routeTiers({ preferred: astGrepOk(), npx: astGrepOk() });
		expect(await isSgAvailableAsync()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBeGreaterThan(probesAfterFirst);
		expect(getSgCommand().cmd).not.toBe("npx");
	});

	it("says in the decision record that the win was provisional", async () => {
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const { isSgAvailableAsync } = await loadHelpers();

		expect(await isSgAvailableAsync()).toBe(true);
		const metadata = lastAvailableDecision("ast-grep");
		// Pre-fix an `available` row was always `latched: true` with no retry, so
		// a log reader could not tell a real win from a degraded one.
		expect(metadata.provisional).toBe(true);
		expect(metadata.latched).toBe(false);
		expect(metadata.retryAfterMs).toBe(TRANSIENT_BASE_COOLDOWN_MS);
		expect(metadata.unreachablePreferred).toContain("ast-grep");
	});

	it("control: a clean win still latches for the session", async () => {
		routeTiers({ preferred: astGrepOk(), npx: astGrepOk() });
		const { isSgAvailableAsync } = await loadHelpers();

		expect(await isSgAvailableAsync()).toBe(true);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);
		expect(lastAvailableDecision("ast-grep").provisional).toBeUndefined();

		// No cooldown to expire: the verdict is a durable fact.
		advancePastCooldown();
		expect(await isSgAvailableAsync()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("control: a genuinely ABSENT preferred tier still latches the npx win", async () => {
		// Nothing stalled, so the npx win is on the merits — re-sweeping every
		// 30 s would be the "never cache anything" regression.
		routeTiers({ preferred: missingResult, npx: astGrepOk() });
		const { isSgAvailableAsync } = await loadHelpers();

		expect(await isSgAvailableAsync()).toBe(true);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);

		advancePastCooldown();
		expect(await isSgAvailableAsync()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a still-stalled re-sweep keeps the winner instead of turning ast-grep off", async () => {
		// #1568 review F1. The re-sweep is the point of the provisional state, and
		// on a host that is STILL busy every candidate times out — including the
		// npx that answered 30 s ago. Flipping to `unavailable` there runs #1476's
		// principle backwards: a timeout says nothing about the tool, so it cannot
		// erase a command this very process proved working. `sgCmd` is still in
		// hand; keep serving it and re-arm the cooldown.
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const { isSgAvailableAsync, getSgCommand } = await loadHelpers();

		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).toBe("npx");

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).toBe("npx");

		const metadata = lastAvailableDecision("ast-grep");
		expect(metadata.provisional).toBe(true);
		expect(metadata.retained).toBe(true);
		expect(metadata.latched).toBe(false);
		// Re-armed, and escalated: attempt 2 on the transient ladder.
		expect(metadata.retryAfterMs).toBe(TRANSIENT_BASE_COOLDOWN_MS * 2);

		// Still provisional, so recovery still lands once the host settles.
		advancePastSecondCooldown();
		routeTiers({ preferred: astGrepOk(), npx: astGrepOk() });
		expect(await isSgAvailableAsync()).toBe(true);
		expect(getSgCommand().cmd).not.toBe("npx");
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);
	});

	it("logs candidate NAMES, never absolute local paths (#1568 review F3)", async () => {
		// Tier 1 is `node_modules/.bin/<name>`, an absolute path under the user's
		// home. Every sibling row in latency.log carries a tool name, so writing a
		// filesystem path here both leaks it and breaks the grep.
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const { isSgAvailableAsync } = await loadHelpers();

		expect(await isSgAvailableAsync()).toBe(true);
		const unreachable = lastAvailableDecision("ast-grep")
			.unreachablePreferred as string[];
		expect(unreachable.length).toBeGreaterThan(0);
		for (const name of unreachable) {
			expect(name).not.toMatch(/[\\/]/);
		}
		expect(unreachable).toContain("ast-grep");
	});
});

describe("SgRunner.doEnsureAvailable: a stalled DIRECT tier is provisional (#1568)", () => {
	async function loadRunner() {
		const { SgRunner } = await import("../../clients/sg-runner.js");
		return new SgRunner();
	}

	it("re-sweeps after the cooldown instead of staying on npx all session", async () => {
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		// A stalled DIRECT candidate must still not trigger the install (#1476).
		expect(ensureTool).not.toHaveBeenCalled();
		const probesAfterFirst = safeSpawnAsync.mock.calls.length;

		// Held for the cooldown: one provisional sweep, not one per caller.
		expect(await runner.ensureAvailable()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probesAfterFirst);

		// Pre-fix `noteAvailable()` latched the npx pick permanently, so this
		// second sweep never happened and the recovered binary was never seen.
		advancePastCooldown();
		routeTiers({ preferred: astGrepOk(), npx: astGrepOk() });
		expect(await runner.ensureAvailable()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBeGreaterThan(probesAfterFirst);
		// The re-sweep asked the preferred tier first and it answered, so this
		// win is durable — no further sweep is owed.
		const settled = safeSpawnAsync.mock.calls.length;
		advancePastCooldown();
		expect(await runner.ensureAvailable()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(settled);
	});

	it("says in the decision record that the win was provisional", async () => {
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		const metadata = lastAvailableDecision("ast-grep");
		expect(metadata.provisional).toBe(true);
		expect(metadata.latched).toBe(false);
		expect(metadata.retryAfterMs).toBe(TRANSIENT_BASE_COOLDOWN_MS);
		expect(metadata.unreachablePreferred).toContain("ast-grep");
	});

	it("control: a stalled npx FALLBACK does not make a later real win provisional", async () => {
		// npx is asked before the global-bin / platform-package tiers but is
		// explicitly the fallback, so its stall says nothing about a winner that
		// is a genuine binary. Marking that win provisional would re-sweep the
		// slow npx forever — the regression #1489 already fixed once.
		const { findGlobalBinary } =
			await import("../../clients/package-manager.js");
		vi.mocked(findGlobalBinary).mockResolvedValue(
			"/global/bin/ast-grep" as never,
		);
		safeSpawnAsync.mockImplementation(async (cmd: string) => {
			if (cmd === "npx") return timeoutResult;
			if (cmd === "/global/bin/ast-grep") return astGrepOk();
			return missingResult;
		});
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);
		expect(lastAvailableDecision("ast-grep").provisional).toBeUndefined();
		const probes = safeSpawnAsync.mock.calls.length;

		advancePastCooldown();
		expect(await runner.ensureAvailable()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("control: a genuinely ABSENT direct tier still latches the npx win", async () => {
		routeTiers({ preferred: missingResult, npx: astGrepOk() });
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);

		advancePastCooldown();
		expect(await runner.ensureAvailable()).toBe(true);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a still-stalled re-sweep keeps the winner and does NOT install", async () => {
		// #1568 review F1, plus the second-order case: the re-sweep must not fall
		// through to Step 4. Auto-installing ast-grep because the host was busy is
		// exactly what #1476 removed, and here there is an even stronger reason —
		// the runner is still holding a command it proved working one cooldown ago.
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		expect(await runner.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();

		const metadata = lastAvailableDecision("ast-grep");
		expect(metadata.provisional).toBe(true);
		expect(metadata.retained).toBe(true);
		expect(metadata.latched).toBe(false);
		expect(metadata.retryAfterMs).toBe(TRANSIENT_BASE_COOLDOWN_MS * 2);

		// And it still recovers: the retained state is provisional, not a new latch.
		advancePastSecondCooldown();
		routeTiers({ preferred: astGrepOk(), npx: astGrepOk() });
		expect(await runner.ensureAvailable()).toBe(true);
		expect(lastAvailableDecision("ast-grep").latched).toBe(true);
	});

	it("boundary: only a GENUINE absence on the re-sweep reaches the install", async () => {
		// The other side of the arm above. If the re-sweep finds every candidate
		// genuinely gone — the npx that answered included — then ast-grep really is
		// missing now, and the install is the right move. Retaining the old winner
		// here would serve a command that ENOENTs on the next run.
		routeTiers({ preferred: timeoutResult, npx: astGrepOk() });
		const runner = await loadRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(missingResult);
		expect(await runner.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("ast-grep");
	});
});
