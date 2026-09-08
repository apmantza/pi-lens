/**
 * Fidelity tests for the fault-injection kit (#1838).
 *
 * The #1673 lesson: an inert double is worse than none. Each primitive here
 * carries its own fidelity proof — if a refactor silently neuters one (a
 * wedge that fails fast instead of hanging, a delay that resolves early, a
 * reset hook that fires outside the seam, a budget stub that misses the env
 * read), THIS suite goes red, not some future consumer's test.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	delayInside,
	fireResetAt,
	gatedPromise,
	spawnWedgedChild,
	starveBudget,
} from "./fault-injection.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("gatedPromise", () => {
	it("stays unsettled until released, then exposes the value exactly once", async () => {
		const gate = gatedPromise<string>();
		expect(gate.settled()).toBe(false);

		let observed: string | undefined;
		void gate.promise.then((v) => {
			observed = v;
		});
		// Let microtasks drain to prove nothing settles on its own.
		await new Promise((resolve) => setImmediate(resolve));
		expect(gate.settled()).toBe(false);
		expect(observed).toBeUndefined();

		gate.resolve("released");
		expect(await gate.promise).toBe("released");
		expect(observed).toBe("released");
		// Double-resolve must be a no-op, not a second settle.
		gate.resolve("again");
		expect(await gate.promise).toBe("released");
	});

	it("rejects when reject is called first and stays settled after", async () => {
		const gate = gatedPromise<void>();
		gate.reject(new Error("boom"));
		await expect(gate.promise).rejects.toThrow("boom");
		gate.resolve(); // no-op after rejection
		await expect(gate.promise).rejects.toThrow("boom");
	});
});

describe("delayInside", () => {
	it("holds the caller's continuation past ms and preserves the original result", async () => {
		const seam = vi.fn(async () => "payload");
		delayInside(seam, 60);

		let resolved = false;
		const started = Date.now();
		const result = seam().then((v) => {
			resolved = true;
			return v;
		});

		// Early in the window the call has been MADE but not completed — that
		// is what "inside the seam" means. A wrapper that delayed outside the
		// implementation could not produce this observation.
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seam).toHaveBeenCalledTimes(1);
		expect(resolved).toBe(false);

		expect(await result).toBe("payload");
		expect(resolved).toBe(true);
		// The mutation proof lives here: strip the timer from delayInside and
		// this elapsed floor drops to ~5ms, red. Loose upper bound on purpose
		// (#1920): CI workers can stall a real-timer window arbitrarily.
		expect(Date.now() - started).toBeGreaterThanOrEqual(55);
	});
});

describe("fireResetAt", () => {
	it("fires the hook inside the seam before its result is consumed, once, at the chosen call", async () => {
		const order: string[] = [];
		const seam = vi.fn(async () => {
			order.push("impl");
			return "done";
		});
		const hook = vi.fn(() => order.push("hook"));

		fireResetAt(seam, hook, { atCall: 2 });

		expect(await seam()).toBe("done"); // call 1: no hook
		expect(hook).not.toHaveBeenCalled();
		expect(order).toEqual(["impl"]);

		order.length = 0;
		expect(await seam()).toBe("done"); // call 2: hook fires inside
		expect(order).toEqual(["hook", "impl"]);

		order.length = 0;
		await seam(); // call 3: exactly-once — never fires again
		expect(hook).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["impl"]);
	});

	it("preserves arguments passed through to the original implementation", async () => {
		const seam = vi.fn(async (_cmd: string, args: string[]) => args.join("+"));
		fireResetAt(seam, () => {});
		expect(await seam("npm", ["update", "-p"])).toBe("update+-p");
		expect(seam).toHaveBeenCalledWith("npm", ["update", "-p"]);
	});

	it("`when` targets the Nth matching call of a multi-purpose seam (#1838 adoption)", async () => {
		const order: string[] = [];
		// One spawn mock serving version probes AND updates — the
		// managed-tool-refresh shape that motivated the option.
		const seam = vi.fn(async (cmd: string, args: string[]) => {
			order.push(args[0] ?? cmd);
			return "ok";
		});
		const hook = vi.fn(() => order.push("HOOK"));

		fireResetAt(seam, hook, {
			when: (_cmd, args) => args.includes("update"),
		});

		await seam("npm", ["--version"]); // non-matching: no hook
		expect(hook).not.toHaveBeenCalled();

		await seam("npm", ["update"]); // 1st match: fires inside
		await seam("npm", ["update"]); // 2nd match: exactly-once holds
		expect(hook).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["--version", "HOOK", "update", "update"]);

		// Composes with atCall: the 2nd MATCHING call, not the 2nd overall.
		order.length = 0;
		const second = vi.fn(async (_c: string, args: string[]) => args[0]);
		const lateHook = vi.fn();
		fireResetAt(second, lateHook, {
			atCall: 2,
			when: (_cmd, args) => args.includes("update"),
		});
		await second("npm", ["update"]);
		expect(lateHook).not.toHaveBeenCalled();
		await second("npm", ["update"]);
		expect(lateHook).toHaveBeenCalledTimes(1);
	});
});

describe("starveBudget", () => {
	it("sets the env var to the tiny budget and restores via unstubAllEnvs", () => {
		process.env.PI_LENS_FAULT_KIT_PROBE = "9999";
		try {
			starveBudget("PI_LENS_FAULT_KIT_PROBE");
			expect(process.env.PI_LENS_FAULT_KIT_PROBE).toBe("5");
			starveBudget("PI_LENS_FAULT_KIT_PROBE", 1);
			expect(process.env.PI_LENS_FAULT_KIT_PROBE).toBe("1");
		} finally {
			vi.unstubAllEnvs();
		}
		expect(process.env.PI_LENS_FAULT_KIT_PROBE).toBe("9999");
		delete process.env.PI_LENS_FAULT_KIT_PROBE;
	});

	it("composes with gatedPromise into the deterministic starvation repro (#1785 shape)", async () => {
		// The guarded operation never settles; the budget around it is tiny.
		// Whatever races that operation against the budget must pick the
		// budget every time — no wall-clock luck involved.
		starveBudget("PI_LENS_SEQUENCE_READ_BUDGET_MS");
		const gate = gatedPromise<void>();
		const slowRead = vi.fn(() => gate.promise);

		const budgetMs = Number(process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS);
		const outcome = await Promise.race([
			slowRead().then(
				() => "work-won" as const,
				() => "work-won" as const,
			),
			new Promise<"budget-won">((resolve) =>
				setTimeout(() => resolve("budget-won"), budgetMs + 20),
			),
		]);
		gate.resolve();

		expect(outcome).toBe("budget-won");
		expect(slowRead).toHaveBeenCalledTimes(1);
	});
});

describe("spawnWedgedChild", () => {
	// The #1811 lesson, asserted directly: the wedge must make writes HANG,
	// not fail fast. A fixture whose keepalive is missing exits within
	// milliseconds and turns every later write into EPIPE/EOF — which makes
	// consuming tests pass for the wrong reason.
	it(
		"keeps the child alive with an unread pipe, and subsequent writes stop settling",
		{ timeout: 30_000 },
		async () => {
			const wedged = await spawnWedgedChild();
			try {
				expect(wedged.pid).toBeDefined();
				const stdin = wedged.child.stdin;
				expect(stdin).not.toBeNull();

				wedged.padStdin();
				// Give the padding writes a moment to fill the OS buffer, then
				// confirm the child is STILL alive — an exiting-fixture bug
				// shows up right here as exitCode !== null.
				await new Promise((resolve) => setTimeout(resolve, 250));
				expect(wedged.child.exitCode).toBeNull();
				expect(wedged.child.signalCode).toBeNull();

				// The fidelity core: a fresh write's completion callback must
				// NOT fire within a bounded window. If the child had died, this
				// write would fail fast with EPIPE and the callback WOULD fire
				// (with an error) — the exact wrong-reason pass this guards.
				let writeSettled = false;
				stdin!.write("probe", () => {
					writeSettled = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(writeSettled).toBe(false);
				expect(wedged.child.exitCode).toBeNull();
			} finally {
				await wedged.kill();
			}
			expect(
				wedged.child.exitCode !== null || wedged.child.signalCode !== null,
			).toBe(true);
		},
	);

	it(
		"kill() is idempotent and safe to call twice",
		{ timeout: 15_000 },
		async () => {
			const wedged = await spawnWedgedChild();
			await wedged.kill();
			await wedged.kill(); // must not throw or hang
			expect(
				wedged.child.exitCode !== null || wedged.child.signalCode !== null,
			).toBe(true);
		},
	);

	it("fixture file exists next to the kit (catches path drift)", () => {
		const fixture = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../fixtures/wedged-stdin-child.mjs",
		);
		expect(fs.existsSync(fixture)).toBe(true);
	});
});

// #2436 review round 2: pins spawnWedgedChild's onTestFinished backstop kill,
// which previously had zero test coverage — every existing caller above
// happens to call its own `.kill()`, so a refactor that silently dropped the
// registration would go unnoticed. Test A spawns without killing; test B
// (which runs after test A finishes, since vitest runs `it` blocks in a
// `describe` sequentially by default) asserts test A's child is already
// dead — proof the `onTestFinished` hook did the killing, not some
// incidental cleanup. Deliberately no `afterEach` in this describe: one
// would race the very backstop under test and could mask a broken backstop
// by killing the leaked process before test B looks at it. The only cleanup
// is `afterAll`, which runs strictly after test B's assertion.
describe("spawnWedgedChild — onTestFinished backstop (#2436)", () => {
	let leakedPid: number | undefined;

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	afterAll(() => {
		if (leakedPid !== undefined && isAlive(leakedPid)) {
			try {
				process.kill(leakedPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});

	it("spawns the wedged child and deliberately does not kill it", async () => {
		const wedged = await spawnWedgedChild();
		expect(wedged.pid).toBeDefined();
		expect(isAlive(wedged.pid as number)).toBe(true);
		leakedPid = wedged.pid;
		// No wedged.kill() here on purpose — the onTestFinished backstop
		// registered inside spawnWedgedChild is the only thing that should
		// reap this.
	});

	it(
		"the backstop reaped the previous test's process once it finished",
		{ timeout: 15_000 },
		async () => {
			expect(leakedPid).toBeDefined();
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && isAlive(leakedPid as number)) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(isAlive(leakedPid as number)).toBe(false);
		},
	);
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface
