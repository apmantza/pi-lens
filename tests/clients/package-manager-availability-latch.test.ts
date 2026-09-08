/**
 * #1496 — `isAvailable` in `package-manager.ts` memoized a `where`/`which <pm>`
 * probe for the life of the process. A timeout (a 5 s host-side budget, the
 * same shape as #1467/#1476) was remembered as "this manager is not
 * installed", so a declared pnpm/yarn manager would silently fall back to npm
 * for the rest of the session. The affected call sites are internal (installs
 * into pi-lens's managed tools directory, `pilens_rebuild` on a source
 * checkout) — no user-project lockfile was ever at risk.
 *
 * These tests exercise `resolveNodePackageManager`, the public surface every
 * caller (the installer, `pilens_rebuild`) actually uses, rather than the
 * private `isAvailable` memo directly. `safeSpawnAsync` is mocked; the probe
 * command (`where`/`which <pm>`) is asserted on directly so the test does not
 * depend on which implementation function issues it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_BASE_COOLDOWN_MS } from "../../clients/dispatch/runners/utils/availability-policy.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

// `isCommandAvailableAsync` is reimplemented here (not `importOriginal`'d):
// the real function's internal call to `safeSpawnAsync` is bound to its OWN
// module's unmocked binding, not this mock, so importing it would silently
// bypass the mock and hit the real system PATH. Pre-fix `package-manager.ts`
// probes through `isCommandAvailableAsync`; post-fix code calls
// `safeSpawnAsync` directly. Routing both through the same hoisted mock lets
// one test file exercise both at the same boundary.
vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	isCommandAvailableAsync: async (command: string) => {
		const finder = process.platform === "win32" ? "where" : "which";
		const result = await safeSpawnAsync(finder, [command], { timeout: 5000 });
		return result.status === 0 && !result.error;
	},
}));

const timeoutResult = {
	stdout: "",
	stderr: "",
	status: null,
	error: new Error("Process timed out after 5000ms"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

/** A real `where`/`which` that ran fine and found nothing: genuine absence. */
const notFoundResult = { stdout: "", stderr: "", status: 1 };

const okResult = (pm: string) => ({ stdout: `${pm}\n`, stderr: "", status: 0 });

function finder(): string {
	return process.platform === "win32" ? "where" : "which";
}

function advancePastCooldown(): void {
	vi.setSystemTime(new Date(Date.now() + TRANSIENT_BASE_COOLDOWN_MS + 1));
}

/** Empty project: no lockfile, no `packageManager` field — nothing declared. */
async function emptyProjectDir(): Promise<string> {
	const os = await import("node:os");
	const fs = await import("node:fs");
	const path = await import("node:path");
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pm-latch-"));
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	return () => vi.useRealTimers();
});

describe("package-manager availability (#1496)", () => {
	it("pins a successful probe: the declared manager resolves", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm"
				? okResult("pnpm")
				: notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		expect(await resolveNodePackageManager(dir)).toBe("pnpm");
	});

	it("pins a genuine absence: falls back to npm, latched (no re-probe)", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "npm" ? okResult("npm") : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		// pnpm is declared but genuinely absent — falls back through PREFERENCE.
		expect(await resolveNodePackageManager(dir)).toBe("npm");
		const probesBefore = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "pnpm",
		).length;
		expect(probesBefore).toBeGreaterThan(0);

		// A genuine absence latches: a second resolve does not re-probe pnpm.
		expect(await resolveNodePackageManager(dir)).toBe("npm");
		const probesAfter = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "pnpm",
		).length;
		expect(probesAfter).toBe(probesBefore);
	});

	/**
	 * THE regression proof (#1496): a project declares pnpm. The first probe
	 * for pnpm times out — a transient host stall, not a fact about the
	 * machine. Pre-fix, that timeout latched `false` forever and every later
	 * resolve silently used npm. Post-fix, the verdict expires on its cooldown
	 * and a later probe that finds pnpm resolves it correctly — no restart
	 * needed. This must FAIL on pre-fix code (pre-fix: pnpm never comes back).
	 */
	it("a timed-out probe expires: pnpm is found on retry, no permanent npm downgrade", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm" ? timeoutResult : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		// The stalled first probe falls back to npm for THIS call — acceptable,
		// the session still needs an answer right now.
		expect(await resolveNodePackageManager(dir)).toBe("npm");

		// Now pnpm is reachable again (the stall passed) and the cooldown expires.
		advancePastCooldown();
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "pnpm"
				? okResult("pnpm")
				: notFoundResult,
		);

		// Pre-fix: the timeout latched `false` for pnpm for the life of the
		// process, so this still resolves "npm" and the assertion below fails.
		expect(await resolveNodePackageManager(dir)).toBe("pnpm");
	});

	it("concurrent first-time resolves for the same manager share one probe", async () => {
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) =>
			cmd === finder() && args[0] === "npm" ? okResult("npm") : notFoundResult,
		);
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();

		const results = await Promise.all([
			resolveNodePackageManager(dir),
			resolveNodePackageManager(dir),
			resolveNodePackageManager(dir),
		]);
		expect(results).toEqual(["npm", "npm", "npm"]);
		const npmProbes = safeSpawnAsync.mock.calls.filter(
			([cmd, args]) => cmd === finder() && args[0] === "npm",
		).length;
		expect(npmProbes).toBe(1);
	});

	it("dispatch reset does not tear down an airborne package-manager flight", async () => {
		let pnpmCalls = 0;
		let release!: (value: unknown) => void;
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === finder() && args[0] === "pnpm") {
				pnpmCalls++;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			return notFoundResult;
		});
		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		const { resetDispatchAvailabilityState } =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		const first = resolveNodePackageManager(dir);
		await Promise.resolve();
		await Promise.resolve();
		resetDispatchAvailabilityState();
		const second = resolveNodePackageManager(dir);
		expect(pnpmCalls).toBe(1);
		release(notFoundResult);
		await Promise.all([first, second]);
	});

	/**
	 * #1653 review F1 — `isAvailable`'s in-flight probe cleared its map entry
	 * unconditionally: `.finally(() => inFlightProbes.delete(pm))`. A probe
	 * started BEFORE a session reset that settles AFTER the next session's own
	 * probe for the same manager has already started deletes that NEWER probe's
	 * entry by key, not by identity — so a third caller arriving in the gap
	 * finds no in-flight probe and spawns a duplicate. Reachable in production
	 * via quick-mode's ~2s warmup racing a `/new` inside the 5s probe budget.
	 * The fix is the identity guard `dependency-checker.ts`'s `resolveMadge`
	 * already uses for the same race: only delete the entry if it is still the
	 * promise this call created.
	 */
	it("a pre-reset probe settling late must not evict the new session's in-flight probe", async () => {
		let pnpmCalls = 0;
		const releasers: Array<(value: unknown) => void> = [];
		safeSpawnAsync.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd !== finder() || args[0] !== "pnpm") return notFoundResult;
			const idx = pnpmCalls++;
			// The first two pnpm probes (session A's, session B's) are held open
			// under test control; anything past that is the regression itself and
			// must resolve on its own so the test cannot hang either way.
			if (idx < 2) {
				return new Promise((resolve) => {
					releasers[idx] = resolve;
				});
			}
			return notFoundResult;
		});

		const { resolveNodePackageManager, _resetPackageManagerCache } =
			await import("../../clients/package-manager.js");
		_resetPackageManagerCache();
		const dir = await emptyProjectDir();
		const fs = await import("node:fs");
		const path = await import("node:path");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");

		// Session A's probe starts and hangs (call #0).
		const callA = resolveNodePackageManager(dir);
		await Promise.resolve();
		await Promise.resolve();
		expect(releasers[0]).toBeDefined();

		// The session boundary: quick-mode's warmup races a fresh session_start.
		_resetPackageManagerCache();

		// Session B's probe starts fresh (its latch and in-flight map were just
		// cleared) and also hangs (call #1).
		const callB = resolveNodePackageManager(dir);
		await Promise.resolve();
		await Promise.resolve();
		expect(releasers[1]).toBeDefined();

		// Session A's spawn settles first. Flush real macrotasks (fake timers
		// here only fake `Date`, so `setTimeout` still runs) so A's PREFERENCE
		// fallback can reach its second pnpm check BEFORE B's spawn resolves —
		// the exact window the race depends on. If B resolved first, B's own
		// latch would answer A's recheck directly and the in-flight map would
		// never be consulted at all, hiding the bug this test exists to catch.
		releasers[0](notFoundResult);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Now release B. Post-fix, A's recheck already joined B's still-pending
		// probe (awaiting `callA` alone would hang without this); pre-fix, A's
		// recheck already spawned its own third probe and does not need B at
		// all — either way, this unblocks whichever of A/B is still waiting.
		releasers[1](notFoundResult);
		await Promise.all([callA, callB]);

		// Pre-fix: A's unconditional `.finally` deleted B's still-in-flight entry
		// out from under it, so A's own PREFERENCE fallback loop (checking pnpm a
		// second time after the declared manager comes back false) found nothing
		// in-flight and spawned a third probe.
		expect(pnpmCalls).toBe(2);
	});
});
