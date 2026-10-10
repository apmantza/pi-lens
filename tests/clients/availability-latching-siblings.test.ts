/**
 * #1476 — the three availability consumers the #1467 class sweep missed, plus
 * the shared ast-grep memo the #1476 sweep found: biome, `SgRunner`,
 * `isSgAvailableAsync`, and govulncheck's `go install`.
 *
 * Each one latched ANY probe failure — a timeout included — as a permanent
 * "the tool is not installed" verdict, and biome and `SgRunner` ran a full
 * auto-install on the way there.
 *
 * Every describe block pins the two verdicts that must NOT change (a genuine
 * absence, a successful probe) beside the transient case that must. A migration
 * that quietly redefined "missing" for the hot-path formatter would be worse
 * than the bug it fixes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HOST_STALL_COOLDOWN_MS,
	INSTALL_TRANSIENT_BASE_COOLDOWN_MS,
	TRANSIENT_BASE_COOLDOWN_MS,
} from "../../clients/dispatch/runners/utils/availability-policy.js";

/**
 * Reset through the SAME module instance the clients load (the compiled `.js`),
 * not the `.ts` source: the shared ast-grep memo lives in module state, and a
 * reset applied to a second instance of the module silently resets nothing.
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

// Spread the real module: only `logLatency` is intercepted, so the rest of the
// import graph keeps working.
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

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

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
	isCommandAvailableAsync: vi.fn(async () => false),
}));

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	// #1500: the durable-absence arms read the installer's own attempt record, so
	// an attempt that failed is distinguishable from one that never ran.
	getInstallAttempt: vi.fn(() => undefined),
	findManagedToolBinary: vi.fn(async () => undefined),
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

vi.mock("../../clients/project-trust.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/project-trust.js")>()),
	assertInstallAllowed: vi.fn(() => true),
	getProjectTrustState: vi.fn(() => "trusted"),
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

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

beforeEach(async () => {
	vi.resetAllMocks();
	ensureTool.mockResolvedValue(null);
	safeSpawn.mockReturnValue({ stdout: "", stderr: "", status: 1 });
	await resetDispatchAvailabilityState();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
	vi.useRealTimers();
	await resetDispatchAvailabilityState();
});

describe("BiomeClient availability (#1476)", () => {
	it("pins a genuine absence: latched false, and an install IS attempted", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("biome");
		const probesAfterFirst = safeSpawnAsync.mock.calls.length;

		// A durable verdict is remembered for the session: no second probe.
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probesAfterFirst);
	});

	it("pins a successful probe: available, and no install", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("biome 1.9.4"));
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("a timed-out probe neither installs nor latches, and recovers", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();

		expect(await client.ensureAvailable()).toBe(false);
		// Pre-fix, the timeout collapsed to `missing`, which installed biome.
		expect(ensureTool).not.toHaveBeenCalled();

		// Inside the cooldown the verdict holds, so a stalling host cannot be
		// re-probed on every keystroke.
		const probes = safeSpawnAsync.mock.calls.length;
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);

		// After the cooldown the very same client re-probes and biome comes back
		// without a host restart. Pre-fix this stayed false forever.
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("biome 1.9.4"));
		expect(await client.ensureAvailable()).toBe(true);
	});

	it("concurrent first-time callers share one probe (no retry storm)", async () => {
		let release: ((value: unknown) => void) | undefined;
		safeSpawnAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const calls = [
			client.ensureAvailable(),
			client.ensureAvailable(),
			client.ensureAvailable(),
		];
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		release?.(okResult("biome 1.9.4"));
		expect(await Promise.all(calls)).toEqual([true, true, true]);
	});
});

it("shares a toolchain probe across independent Go consumers (#2131)", async () => {
	let release: ((value: unknown) => void) | undefined;
	safeSpawnAsync.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const { createToolchainAvailability } =
		await import("../../clients/dispatch/runners/utils/toolchain-availability.js");
	const config = {
		tool: "go",
		label: "Go",
		windowsPaths: ["go"],
		unixPaths: ["go"],
		probeArgs: ["version"],
		budgetMs: 5000,
		log: () => {},
	};
	const first = createToolchainAvailability(config);
	const second = createToolchainAvailability(config);
	const calls = [first.isAvailable(), second.isAvailable()];
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	release?.({ stdout: "go1.23", stderr: "", status: 0 });
	expect(await Promise.all(calls)).toEqual([true, true]);
});

describe("SgRunner availability (#1476)", () => {
	it("pins a genuine absence: latched false, and an install IS attempted", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("ast-grep");
		const probes = safeSpawnAsync.mock.calls.length;
		expect(await runner.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("pins a successful probe: available, and no install", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("a timed-out sweep neither installs nor latches, and recovers", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		// Pre-fix this ran a full ast-grep auto-install because the host stalled.
		expect(ensureTool).not.toHaveBeenCalled();

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		expect(await runner.ensureAvailable()).toBe(true);
	});
});

describe("shared ast-grep availability (#1476)", () => {
	it("pins a genuine absence: latched false for the session", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);
		const { isSgAvailableAsync } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");

		expect(await isSgAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		expect(probes).toBeGreaterThan(0);
		expect(await isSgAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);
	});

	it("a timed-out sweep expires and re-probes after the cooldown", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { isSgAvailableAsync } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");

		expect(await isSgAvailableAsync()).toBe(false);
		const probes = safeSpawnAsync.mock.calls.length;
		// Held inside the cooldown: no probe storm while the host is still sick.
		expect(await isSgAvailableAsync()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(probes);

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		expect(await isSgAvailableAsync()).toBe(true);
	});
});

describe("govulncheck availability (#1476)", () => {
	/** Route each spawn by command so install order stays readable. */
	function route(handlers: {
		govulncheck?: unknown[];
		go?: unknown[];
		install?: unknown;
	}): void {
		const govulncheckQueue = [...(handlers.govulncheck ?? [])];
		const goQueue = [...(handlers.go ?? [])];
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "govulncheck") {
				return govulncheckQueue.shift() ?? missingResult;
			}
			if (cmd === "go" && args[0] === "install") {
				return handlers.install ?? okResult("");
			}
			return goQueue.shift() ?? okResult("go version go1.23.0");
		});
	}

	it("pins the install path: probe misses, go installs, re-probe succeeds", async () => {
		route({
			govulncheck: [missingResult, okResult("govulncheck v1.1.3")],
			install: okResult(""),
		});
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(true);
	});

	it("pins a failed install (non-zero exit): latched false, no re-install", async () => {
		route({
			govulncheck: [missingResult],
			install: { stdout: "", stderr: "no matching versions", status: 1 },
		});
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(false);
		const spawns = safeSpawnAsync.mock.calls.length;
		expect(await client.ensureAvailable()).toBe(false);
		expect(safeSpawnAsync.mock.calls.length).toBe(spawns);
	});

	it("a timed-out `go install` does not latch, and recovers", async () => {
		route({ govulncheck: [missingResult], install: timeoutResult });
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");
		const client = new GovulncheckClient();

		expect(await client.ensureAvailable()).toBe(false);

		// Pre-#1476, the 60 s network budget expiring once disabled govulncheck
		// for the life of the process. Post-#1497 the retry waits on the
		// install-class schedule (the retried operation is a ≤60s compile, not
		// a cheap probe), so advance past THAT cooldown.
		vi.setSystemTime(
			new Date(Date.now() + INSTALL_TRANSIENT_BASE_COOLDOWN_MS + 1),
		);
		route({ govulncheck: [okResult("govulncheck v1.1.3")] });
		expect(await client.ensureAvailable()).toBe(true);
	});
});

describe("SgRunner: a slow npx must not veto the install (#1489 review)", () => {
	/** Route the sweep per command so each candidate's verdict is explicit. */
	function route(byCommand: Record<string, unknown>, fallback: unknown): void {
		safeSpawnAsync.mockImplementation(async (cmd: string) =>
			cmd in byCommand ? byCommand[cmd] : fallback,
		);
	}

	it("installs when ast-grep is genuinely absent and only npx timed out", async () => {
		// The exact shape of a cold or busy Windows box: the binary is not there,
		// and `npx --no -- ast-grep` cannot answer inside a 5 s budget because it
		// has to start Node first. Gating the install on ANY transient turned this
		// into "never install, re-spawn the slow npx every sweep, forever".
		route(
			{
				"ast-grep": missingResult,
				sg: missingResult,
				npx: timeoutResult,
				"/managed/ast-grep": okResult("ast-grep 0.32.3"),
			},
			missingResult,
		);
		ensureTool.mockResolvedValue("/managed/ast-grep");
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(true);
		expect(ensureTool).toHaveBeenCalledWith("ast-grep");
	});

	it("still refuses to install when a DIRECT candidate timed out", async () => {
		// The #1476 guarantee, unchanged: `ast-grep` itself failing to answer is a
		// statement about the host, not about the tool.
		route(
			{ "ast-grep": timeoutResult, sg: missingResult, npx: missingResult },
			missingResult,
		);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("does not latch 'missing' when the install fails after an npx timeout", async () => {
		route(
			{ "ast-grep": missingResult, sg: missingResult, npx: timeoutResult },
			missingResult,
		);
		ensureTool.mockResolvedValue(null);
		const { SgRunner } = await import("../../clients/sg-runner.js");
		const runner = new SgRunner();

		expect(await runner.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledWith("ast-grep");

		// npx never got a fair hearing, so "ast-grep is not installed" is not a
		// fact yet; the verdict expires and a later sweep finds it.
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("ast-grep 0.32.3"));
		expect(await runner.ensureAvailable()).toBe(true);
	});
});

describe("biome records its retry schedule (#1489 review)", () => {
	it("a transient verdict carries retryAfterMs, not just a latch flag", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { BiomeClient } = await import("../../clients/biome-client.js");

		expect(await new BiomeClient().ensureAvailable()).toBe(false);
		const decisions = decisionsFor("biome");
		const unavailable = decisions.filter(
			(entry) =>
				(entry.metadata as Record<string, unknown>).verdict === "unavailable",
		);
		expect(unavailable).toHaveLength(1);
		const metadata = unavailable[0]?.metadata as Record<string, unknown>;
		expect(metadata.latched).toBe(false);
		// Pre-fix the return of `noteUnavailable` was discarded, so the record said
		// "off" without ever saying "back at".
		expect(metadata.retryAfterMs).toBe(TRANSIENT_BASE_COOLDOWN_MS);
	});
});

describe("govulncheck records a real duration (#1489 review)", () => {
	it("the post-install re-probe reports its own elapsed time and cooldown", async () => {
		// `elapsedMs: 0` was hard-coded here — the #1474 defect verbatim, a
		// duration field that measures nothing. Burn 1234 ms inside the re-probe
		// so a re-hard-coded zero cannot pass.
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "go" && args[0] === "install") return okResult("");
			if (cmd === "go") return okResult("go version go1.23.0");
			if (cmd === "govulncheck" && safeSpawnAsync.mock.calls.length > 1) {
				vi.setSystemTime(new Date(Date.now() + 1234));
				return timeoutResult;
			}
			return missingResult;
		});
		const { GovulncheckClient } =
			await import("../../clients/govulncheck-client.js");

		expect(await new GovulncheckClient().ensureAvailable()).toBe(false);
		const reprobe = decisionsFor("govulncheck").at(-1);
		expect(reprobe?.durationMs).toBe(1234);
		const metadata = reprobe?.metadata as Record<string, unknown>;
		// The 1234 ms burned above is host time, not tool time — and now that the
		// re-probe is sampled, the classifier sees it and says so: a short
		// host-stall cooldown instead of the tool's own escalating one.
		expect(metadata.hostStallMs).toBeGreaterThan(500);
		expect(metadata.cause).toBe("host-stall");
		expect(metadata.retryAfterMs).toBe(HOST_STALL_COOLDOWN_MS);
	});
});

describe("dispatch hasTool availability (#1476)", () => {
	/** The generic seam every CLI runner gates on: `ctx.hasTool(command)`. */
	async function load() {
		const dispatcher = await import("../../clients/dispatch/dispatcher.js");
		const { FactStore } = await import("../../clients/dispatch/fact-store.js");
		return {
			checkToolAvailability: dispatcher.checkToolAvailability,
			facts: new FactStore(),
		};
	}

	it("pins a successful probe: available, and cached for the session", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("pins a genuine absence: latched false for the session", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "",
			status: 1,
			error: undefined,
		});
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("a timed-out probe does not latch, and the tool comes back", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		// Held for the cooldown: a stalling host is not re-probed every dispatch.
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Pre-fix, this false was a session fact and every later dispatch in the
		// session skipped the tool.
		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
	});

	it("the cooldown ESCALATES across repeated transients (#1489 review)", async () => {
		// The attempt count was hard-coded to 1, so the backoff sat flat at 30 s
		// forever. On a permanently sick host that is a re-probe every 30 s per
		// command for the whole session — ten times the storm the policy bounds,
		// at the highest-traffic consumer in the product.
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { checkToolAvailability, facts } = await load();

		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// First cooldown: 30 s. Second verdict is attempt 2, so 60 s.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);

		// 30 s later is still inside the second cooldown: no third probe.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);

		// 60 s after the second verdict, it re-probes and the tool comes back.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(3);
	});

	it("a later success retires the cooldown facts (#1489 review)", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const { checkToolAvailability, facts } = await load();
		expect(await checkToolAvailability("sometool", facts)).toBe(false);
		expect(
			facts.getSessionFact<number>("session.toolCache.sometool.retryAt"),
		).toBeGreaterThan(0);

		advancePastCooldown();
		safeSpawnAsync.mockResolvedValue(okResult("1.2.3"));
		expect(await checkToolAvailability("sometool", facts)).toBe(true);
		expect(
			facts.getSessionFact<number>("session.toolCache.sometool.retryAt"),
		).toBe(0);
		expect(
			facts.getSessionFact<number>(
				"session.toolCache.sometool.transientAttempts",
			),
		).toBe(0);
	});
});
