import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const ensureTool = vi.fn();

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn,
}));
vi.mock("../../clients/installer/index.js", () => ({
	ensureTool,
	// #1500: the durable-absence arm reads the installer's own attempt record to
	// tell an attempt that failed from one that never ran.
	getInstallAttempt: vi.fn(() => undefined),
}));
// #1546: `getBiomeBinary` falls through to `findGlobalBinary` (#375) when no
// local/pi-lens-managed binary exists, and that helper probes every installed
// package manager's global bin dir — each check is its own `safeSpawnAsync`
// call (`where npm`, `npm config get prefix`, etc). Left unmocked, those calls
// share this file's `safeSpawnAsync` mock and silently consume the "one probe"
// budget these tests assert on, which is a false positive on any machine that
// happens to have a local/managed biome binary and a false failure on any
// machine that doesn't (Windows local, #1546). Short-circuiting it here keeps
// these tests scoped to `ensureAvailable`'s own in-flight dedupe (#120) rather
// than incidentally exercising package-manager's spawn count — the same
// isolation `biome-install-evidence.test.ts` already uses.
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findGlobalBinary: vi.fn(async () => undefined),
}));

describe("BiomeClient.ensureAvailable() — in-flight dedupe (#120)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		ensureTool.mockResolvedValue(null);
	});

	it("dedupes concurrent first-time callers to a single probe", async () => {
		let resolveProbe: ((value: unknown) => void) | undefined;
		safeSpawnAsync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const a = client.ensureAvailable();
		const b = client.ensureAvailable();
		const c = client.ensureAvailable();
		// Binary resolution now awaits a global-bin lookup (#375) before the probe
		// spawns, so flush microtasks; the dedupe still means exactly ONE probe.
		await new Promise((r) => setTimeout(r, 0));
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		resolveProbe?.({
			status: 0,
			error: null,
			stdout: "biome 1.9.4",
			stderr: "",
		});
		const results = await Promise.all([a, b, c]);
		expect(results).toEqual([true, true, true]);
		// Cache is now hot — subsequent calls short-circuit before spawning.
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("does not re-probe once a missing verdict latches durably", async () => {
		// A plain non-zero exit (no timeout/abort) classifies as "missing" and
		// latches immediately (`retryAtMs` stays 0), so `ensureAvailable`'s
		// second call short-circuits on `availabilityLatch.read()` alone and
		// never reaches the `ensureInFlight` check below it — this test cannot
		// observe whether that check, or its `finally`-clear, works at all
		// (#1601). See the two tests below for that guard.
		safeSpawnAsync.mockResolvedValueOnce({
			status: 1,
			error: new Error("not found"),
			stdout: "",
			stderr: "",
		});
		const { BiomeClient } = await import("../../clients/biome-client.js");
		const client = new BiomeClient();
		const first = await client.ensureAvailable();
		expect(first).toBe(false);
		await client.ensureAvailable();
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("re-probes once a transient verdict's cooldown expires, rather than returning a leaked settled promise (#1601)", async () => {
		// Unlike the durable "missing" case above, a transient (timeout/abort)
		// verdict's `availabilityLatch.read()` returns null again once its
		// cooldown expires — the ONLY path that reaches `if (this.ensureInFlight)
		// return this.ensureInFlight`. This is the guard the issue describes as
		// vacuous: if `ensureAvailable`'s `finally` stopped clearing the slot,
		// this second call would return the FIRST probe's settled `false`
		// forever instead of re-probing, and `second` would wrongly stay
		// `false` with only one spawn call recorded.
		vi.useFakeTimers();
		try {
			safeSpawnAsync
				.mockResolvedValueOnce({
					status: null,
					error: new Error("probe timed out"),
					failure: "timeout",
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					status: 0,
					error: null,
					stdout: "biome 1.9.4",
					stderr: "",
				});
			const { BiomeClient } = await import("../../clients/biome-client.js");
			const client = new BiomeClient();

			const first = await client.ensureAvailable();
			expect(first).toBe(false);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

			// Base transient cooldown is 30s (TRANSIENT_BASE_COOLDOWN_MS); advance
			// past it so `read()` returns null and the in-flight check is reachable.
			await vi.advanceTimersByTimeAsync(30_000);

			const second = await client.ensureAvailable();
			expect(second).toBe(true);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dedupes callers racing in as a transient cooldown expires, instead of splitting one onto a leaked settled slot (#1601)", async () => {
		// The settled-slot-through-cooldown window named in the issue: two
		// callers arrive together right as the retry window opens. If the
		// first probe's promise had leaked past its `finally`, one of these
		// two could resolve off the stale settled slot while the other
		// triggered a fresh probe — an inconsistent pair of answers to the
		// same question asked in the same tick.
		vi.useFakeTimers();
		try {
			safeSpawnAsync
				.mockResolvedValueOnce({
					status: null,
					error: new Error("probe timed out"),
					failure: "timeout",
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					status: 0,
					error: null,
					stdout: "biome 1.9.4",
					stderr: "",
				});
			const { BiomeClient } = await import("../../clients/biome-client.js");
			const client = new BiomeClient();

			const first = await client.ensureAvailable();
			expect(first).toBe(false);

			await vi.advanceTimersByTimeAsync(30_000);

			const [a, b] = await Promise.all([
				client.ensureAvailable(),
				client.ensureAvailable(),
			]);
			expect(a).toBe(true);
			expect(b).toBe(true);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
