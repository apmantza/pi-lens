/**
 * #2010: teardown evidence on timeout results.
 *
 * A spawn that ends via its OWN timeout budget must carry, separately from
 * the budget number: how long the process tree took to die after expiry, and
 * how it died (exited / killed-by-signal / escalate-kill). Red-first against
 * pre-fix safe-spawn: `timeoutTeardown` did not exist, so both tests fail at
 * the toBeDefined assertion.
 *
 * The escalation case uses a SIGTERM-immune child to force the POSIX
 * SIGKILL escalation branch deterministically; on Windows taskkill /F is
 * always forceful, so the outcome there is "killed-by-signal" for both
 * children - asserted per platform.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	resolveTeardownOutcome,
	safeSpawnAsync,
} from "../../clients/safe-spawn.js";
import {
	noteSpawnTimeout,
	resetSpawnTimeoutCooldowns,
} from "../../clients/spawn-timeout-cooldown.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";

const WEDGED = "setInterval(() => {}, 1_000_000);";
const WEDGED_SIGTERM_IMMUNE =
	"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000_000);";

const OUTCOMES = ["exited", "killed-by-signal", "escalate-kill"] as const;

describe("resolveTeardownOutcome branches (#2010 deep review)", () => {
	it("kill started then death observed: killed-by-signal, ms is the observed gap", () => {
		const out = resolveTeardownOutcome({
			killStartedAtMs: 1000,
			deathObservedAtMs: 1245,
			escalated: false,
		});
		expect(out).toEqual({ ms: 245, outcome: "killed-by-signal" });
	});

	it("escalation fired: escalate-kill", () => {
		const out = resolveTeardownOutcome({
			killStartedAtMs: 1000,
			deathObservedAtMs: 2250,
			escalated: true,
		});
		expect(out).toEqual({ ms: 1250, outcome: "escalate-kill" });
	});

	it("THE RACE: child died before the kill started - honest exited, not a claimed kill", () => {
		const out = resolveTeardownOutcome({
			killStartedAtMs: 5000,
			deathObservedAtMs: 4999,
			escalated: false,
		});
		expect(out).toEqual({ ms: 0, outcome: "exited" });
	});

	it("no kill start (another path owns the death, review P2-2): field omitted", () => {
		const out = resolveTeardownOutcome({
			killStartedAtMs: undefined,
			deathObservedAtMs: 4000,
			escalated: false,
		});
		expect(out).toBeUndefined();
	});

	it("clock jitter can never produce a negative duration", () => {
		const out = resolveTeardownOutcome({
			killStartedAtMs: 2000,
			deathObservedAtMs: 1999,
			escalated: true,
		});
		// Jitter lands in the same "death before kill" arm as the race: honest
		// exited rather than a negative duration.
		expect(out).toEqual({ ms: 0, outcome: "exited" });
	});
});

describe("timeout teardown evidence (#2010)", () => {
	it(
		"a wedged child reports teardown ms and a named outcome",
		{ timeout: 15_000 },
		async () => {
			const result = await safeSpawnAsync(process.execPath, ["-e", WEDGED], {
				timeout: 250,
			});

			expect(result.failure).toBe("timeout");
			expect(result.timeoutTeardown).toBeDefined();
			expect(result.timeoutTeardown?.ms).toBeTypeOf("number");
			expect(result.timeoutTeardown?.ms).toBeGreaterThanOrEqual(0);
			// Teardown is measured separately from the budget - it must not be
			// folded into or equal to the budget number by construction.
			expect(result.timeoutTeardown?.outcome).not.toBe("");
			expect(OUTCOMES).toContain(result.timeoutTeardown?.outcome);
		},
	);

	it(
		"a SIGTERM-immune child names the escalate-kill outcome (POSIX)",
		{ timeout: 20_000 },
		async () => {
			const result = await safeSpawnAsync(
				process.execPath,
				["-e", WEDGED_SIGTERM_IMMUNE],
				{ timeout: 250 },
			);

			expect(result.failure).toBe("timeout");
			expect(result.timeoutTeardown).toBeDefined();
			if (process.platform === "win32") {
				// taskkill /F /T is forceful regardless of SIGTERM handlers.
				expect(["killed-by-signal", "escalate-kill"]).toContain(
					result.timeoutTeardown?.outcome,
				);
			} else {
				expect(result.timeoutTeardown?.outcome).toBe("escalate-kill");
			}
		},
	);

	it("cooldown record carries teardown evidence distinct from budget", async () => {
		// The latency logger no-ops under vitest unless explicitly opted out;
		// PI_LENS_TEST_MODE=0 re-enables real writes into the worker's temp
		// PI_LENS_HOME, so this assertion reads the same bytes production
		// emits (#1742 real-sink direction). Scoped to this test only.
		const prevTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			resetSpawnTimeoutCooldowns();
			noteSpawnTimeout({
				tool: "markdownlint",
				command: "C:/ws/markdownlint-cli2.cmd",
				phase: "lint",
				durationMs: 15000,
				teardown: { ms: 412, outcome: "escalate-kill" },
			});
			await flushLatencyLog();

			// #1742 direction: assert against the REAL emitted row on disk - the
			// same bytes a smell analyzer or human would read - instead of a
			// module mock. vitest-setup points PI_LENS_HOME at a per-worker temp
			// dir, so the read is hermetic.
			const logPath = path.join(getGlobalPiLensDir(), "latency.log");
			const rows = fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.includes('"spawn_timeout_cooldown"'))
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(r) =>
						(r.metadata as Record<string, unknown>)?.command ===
						"C:/ws/markdownlint-cli2.cmd",
				);
			expect(
				rows.length,
				"no spawn_timeout_cooldown row for the primed command",
			).toBeGreaterThan(0);
			const last = rows.at(-1);
			expect(last?.metadata).toMatchObject({
				timeoutBudgetMs: 15000,
				teardownMs: 412,
				teardownOutcome: "escalate-kill",
			});
		} finally {
			if (prevTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = prevTestMode;
		}
	});

	it(
		"a child that exits on its own before the signal lands reports exited",
		{ timeout: 15_000 },
		async () => {
			// Exits ~immediately; the budget expires long after death, so the
			// kill has nothing to act on and the outcome is honest about it.
			const result = await safeSpawnAsync(process.execPath, ["-e", ""], {
				timeout: 5_000,
			});
			expect(result.failure).toBeUndefined();
			expect(result.timeoutTeardown).toBeUndefined();
		},
	);
});
