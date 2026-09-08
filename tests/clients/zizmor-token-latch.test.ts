/**
 * #1535 — a stalled `gh auth token` probe used to fold into a memoized
 * `{ value: undefined }` that stuck for the rest of the process (no TTL, no
 * transient split), silently disabling zizmor's GitHub-aware online audits
 * (known-vulnerable-actions, unpinned-uses, impostor-commit) while the scan
 * kept reporting success. The #1467/#1494 permanent-probe-latch class: a
 * spawn-derived verdict memoized in state that outlives the call.
 *
 * These tests pin the fix's three acceptance criteria:
 *  - a timed-out probe is retried after its cooldown, never cached;
 *  - a genuine "not authenticated" answer (gh ran, exit 1) may cache;
 *  - entering offline mode because of a TRANSIENT failure produces a
 *    legible degradation record (#1459's security-silence shape: a
 *    degraded scan must never look identical to a clean one).
 *
 * The timeout/degradation assertions are RED on pre-fix code (the old
 * `cachedGhToken` memo has no cooldown and never calls `recordDegradation`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

const { safeSpawnAsync, logLatency } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatency: vi.fn(),
}));

// Spread the real module: only `logLatency` is intercepted, so
// availability-policy's `logAvailabilityDecision` (which funnels through it)
// keeps working and its records are observable.
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: (...args: unknown[]) => safeSpawnAsync(...args),
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetZizmorTokenCacheForTests,
	resetZizmorTokenAvailability,
	resolveZizmorGitHubToken,
} from "../../clients/zizmor-config.js";

/** A probe the host killed at its timeout budget: says nothing about `gh`. */
const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout" as const,
	spawnFailure: { kind: "timeout" },
};

/** A probe that never even launched (e.g. a locked/AV-held binary). */
const unspawnableResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn gh EACCES"), { code: "EACCES" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "permission-denied" },
};

/** `gh` ran to completion and answered "not authenticated". */
const notAuthenticatedResult = {
	stdout: "",
	stderr: "not logged in\n",
	status: 1,
	error: undefined,
};

/** `gh` genuinely isn't on PATH at all. */
const missingResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" },
};

/** `gh` ran to completion, exit 0, but answered with nothing. */
const emptyTokenResult = {
	stdout: "\n",
	stderr: "",
	status: 0,
	error: undefined,
};

const okResult = (token: string) => ({
	stdout: `${token}\n`,
	stderr: "",
	status: 0,
	error: undefined,
});

/** availability_decision records for the gh-token prober, oldest first. */
function tokenDecisions(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.filter(
			(entry) =>
				entry?.phase === "availability_decision" &&
				(entry.metadata as Record<string, unknown> | undefined)?.tool ===
					"zizmor-gh-token",
		);
}

const ENV_KEYS = [
	"ZIZMOR_OFFLINE",
	"ZIZMOR_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	safeSpawnAsync.mockReset();
	logLatency.mockReset();
	_resetZizmorTokenCacheForTests();
	resetDegradationLedger();
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	vi.useRealTimers();
});

describe("resolveZizmorGitHubToken transient handling (#1535)", () => {
	it("retries a timed-out probe after its cooldown instead of caching undefined forever", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		// A timeout classifies as "transient" straight off classifyProbeFailure
		// — classifyGhTokenFailure passes it through unchanged, so this row is
		// a genuine probe classification (#2226 review F2).
		expect(tokenDecisions()[0]?.metadata).toMatchObject({
			classifiedBy: "probe",
		});

		// Still within the cooldown: served from the latch, no re-spawn — the
		// verdict has NOT been forgotten, it's just not re-probed yet.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Past the cooldown, gh is healthy again: the probe must run again and
		// the token must come back. Pre-fix, the old `cachedGhToken` memo never
		// expires, so this second probe never happens and this assertion fails.
		vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
		safeSpawnAsync.mockResolvedValue(okResult("gho_recovered"));
		expect(await resolveZizmorGitHubToken()).toBe("gho_recovered");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});

	it("does not latch an unspawnable probe (EACCES/spawn-failed) as durable absence", async () => {
		safeSpawnAsync.mockResolvedValue(unspawnableResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		const metadata = records[0].metadata as Record<string, unknown>;
		// The prober never actually ran, so this must NOT read as a genuine
		// "no" — outcome must be transient (latched: false), never `missing`
		// or `non-installable` (both of which latch forever).
		expect(metadata.outcome).toBe("transient");
		expect(metadata.latched).toBe(false);
		// classifyGhTokenFailure OVERRODE classifyProbeFailure's own
		// "non-installable" answer here (permission-denied falls through its
		// unrecognized-failure default) — this call site asserted the
		// outcome, not a probe passthrough (#2226 review F2).
		expect(metadata.classifiedBy).toBe("caller");
	});

	it("caches a genuine 'not authenticated' answer (gh ran and answered)", async () => {
		safeSpawnAsync.mockResolvedValue(notAuthenticatedResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// A second call within what would be a transient cooldown must NOT
		// re-probe: gh answered "not authenticated", and that answer is
		// trustworthy — re-deriving it every call would be wasted work.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toMatchObject({
			outcome: "non-installable",
			cause: "probe-rejected",
			latched: true,
			// A completed run with a real exit code is classifyGhTokenFailure's
			// own rule, not a classifyProbeFailure passthrough (#2226 review F2).
			classifiedBy: "caller",
		});
	});

	it("caches a genuine success and never re-derives it", async () => {
		safeSpawnAsync.mockResolvedValue(okResult("gho_derived"));

		expect(await resolveZizmorGitHubToken()).toBe("gho_derived");
		expect(await resolveZizmorGitHubToken()).toBe("gho_derived");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("offline-mode degradation observability (#1535, #1459)", () => {
	it("records a legible degradation when a transient probe forces zizmor offline", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();

		const summary = getDegradationSummary();
		const zizmorGroup = summary.find((g) => g.kind === "mode-suppression");
		expect(zizmorGroup).toBeDefined();
		expect(zizmorGroup?.latestReasons.at(-1)?.subject).toBe("zizmor");
		expect(zizmorGroup?.latestReasons.at(-1)?.reason).toMatch(
			/probe-timeout|host-stall/,
		);
	});

	it("does NOT record a degradation for a durable 'not authenticated' answer", async () => {
		safeSpawnAsync.mockResolvedValue(notAuthenticatedResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();

		// A user who genuinely never logged in isn't a degradation — nothing
		// unexpected happened, so nothing should be recorded for it.
		const summary = getDegradationSummary();
		expect(summary.find((g) => g.kind === "mode-suppression")).toBeUndefined();
	});

	it("bounds repeated transient degradations to one updated entry (AGENTS.md:144-150)", async () => {
		// The bare `recordDegradation` call the first review round shipped would
		// push a distinct entry every cycle; the shared ledger caps retained
		// entries per kind at 20, so 5 near-identical "gh auth token probe
		// probe-timeout" lines would all survive and clutter the health view.
		// `incrementDegradationCount` keeps exactly one updated entry per
		// subject while still counting every occurrence.
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		for (let i = 0; i < 5; i++) {
			await resolveZizmorGitHubToken();
			// Jump well past the (capped) cooldown so every cycle is a fresh probe.
			vi.setSystemTime(new Date(Date.now() + 130_000));
		}

		const summary = getDegradationSummary();
		const group = summary.find((g) => g.kind === "mode-suppression");
		expect(group).toBeDefined();
		// Every cycle contributed to the count...
		expect(group?.count).toBe(5);
		// ...but only one entry for "zizmor" is retained, not five.
		const zizmorEntries = group?.latestReasons.filter(
			(entry) => entry.subject === "zizmor",
		);
		expect(zizmorEntries).toHaveLength(1);
	});
});

describe("session-boundary reset (#1535 P1)", () => {
	it("forgets a durable verdict at session_start, so a fresh session re-probes", async () => {
		safeSpawnAsync.mockResolvedValue(notAuthenticatedResult);
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Within the same process, the durable "not authenticated" verdict must
		// stay cached — this is the P2 non-installable/probe-rejected contract.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

		// Simulate `session_start` (clients/runtime-session.ts calls this
		// alongside the sibling #1266 resetDispatchAvailabilityState reset): the
		// user ran `gh auth login` in between sessions. Pre-fix, nothing ever
		// called a reset for this latch outside the test hook, so the stale "no
		// token" verdict from the PREVIOUS session would still answer here.
		resetZizmorTokenAvailability();
		safeSpawnAsync.mockResolvedValue(okResult("gho_after_login"));
		expect(await resolveZizmorGitHubToken()).toBe("gho_after_login");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
	});
});

describe("gh answered but had nothing to say (#1535 P2)", () => {
	it("treats exit-0/empty-stdout as a durable 'no token' verdict, never as success", async () => {
		safeSpawnAsync.mockResolvedValue(emptyTokenResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		// The pre-fix branch called noteAvailable()/logged verdict:"available"
		// here regardless of whether stdout was empty — the telemetry claimed
		// the online audits ran while zizmor was actually about to launch
		// offline (the #1535 silence moved into the log instead of being fixed).
		expect(records[0].metadata).toMatchObject({
			verdict: "unavailable",
			outcome: "non-installable",
			cause: "empty-result",
			latched: true,
			// A literal assertion in deriveGhCliToken itself — no classifier
			// ran on this path at all (#2226 review F2).
			classifiedBy: "caller",
		});

		// A durable, well-understood "no token" answer is safe to cache.
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("latches a genuinely-absent gh (tool-not-found) as durable, not transient", async () => {
		safeSpawnAsync.mockResolvedValue(missingResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		const records = tokenDecisions();
		expect(records).toHaveLength(1);
		expect(records[0].metadata).toMatchObject({
			outcome: "missing",
			cause: "not-found",
			latched: true,
			// classifyGhTokenFailure's own tool-not-found rule, not a
			// classifyProbeFailure passthrough (#2226 review F2).
			classifiedBy: "caller",
		});

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});

describe("the silent-cooldown path is now visible (#1535 P2)", () => {
	it("logs and counts a degradation on a cache-served transient verdict, not just on the probe", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);

		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(tokenDecisions()).toHaveLength(1);
		const afterProbe = getDegradationSummary().find(
			(g) => g.kind === "mode-suppression",
		)?.count;
		expect(afterProbe).toBe(1);

		// Still inside the cooldown: served straight from the latch, no new
		// `gh` spawn. Pre-fix this path was completely silent — a zizmor
		// respawn landing here would start offline with nothing in
		// latency.log or the degradation ledger to say so.
		logLatency.mockClear();
		expect(await resolveZizmorGitHubToken()).toBeUndefined();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1); // still no new probe
		const cachedRecords = tokenDecisions();
		expect(cachedRecords).toHaveLength(1);
		expect(cachedRecords[0].metadata).toMatchObject({
			verdict: "unavailable",
			outcome: "transient",
			latched: false,
		});

		const afterCacheHit = getDegradationSummary().find(
			(g) => g.kind === "mode-suppression",
		)?.count;
		expect(afterCacheHit).toBe(2);
	});
});

describe("cooldown ladder stays under zizmor's own respawn cadence (#1535 P2)", () => {
	it("never logs a retryAfterMs at or above the 240s LSP idle-reset cadence", async () => {
		safeSpawnAsync.mockResolvedValue(timeoutResult);
		const seen: number[] = [];
		for (let i = 0; i < 8; i++) {
			await resolveZizmorGitHubToken();
			const last = tokenDecisions().at(-1);
			const retryAfterMs = (last?.metadata as { retryAfterMs?: number })
				?.retryAfterMs;
			if (typeof retryAfterMs === "number") seen.push(retryAfterMs);
			// Jump well past any capped cooldown so the ladder gets to escalate
			// on every iteration instead of stalling on a still-live cache hit.
			vi.setSystemTime(new Date(Date.now() + 130_000));
		}

		expect(seen.length).toBeGreaterThan(0);
		for (const delay of seen) {
			// clients/runtime-turn.ts's default LSP idle reset is 240_000ms — a
			// cooldown at or above that can outlive the respawn that would
			// otherwise clear it.
			expect(delay).toBeLessThan(240_000);
		}
		// The ladder still escalates (it isn't just flatly capped at the base
		// delay from the first attempt).
		expect(Math.max(...seen)).toBeGreaterThan(TRANSIENT_BASE_COOLDOWN_MS);
	});
});
